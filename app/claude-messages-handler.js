const { createUpstreamRequest } = require('./upstream-request');
const {
    transformClaudeMessagesRequest,
    transformResponsesResponseToClaudeMessage,
    createClaudeSseTransformer
} = require('./claude-responses-compat');
const {
    classifyRetryableResponsesHttpError,
    classifyRetryableResponsesStreamPayload
} = require('./responses-failover');

const DEFAULT_RESPONSES_API_PATH = '/backend-api/codex/responses';
const HOP_BY_HOP_HEADERS = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
]);

function resolveResponsesApiPath(config) {
    if (config.apiPath) {
        return config.apiPath;
    }

    if (config.apiBasePath) {
        return `${config.apiBasePath.replace(/\/+$/, '')}/responses`;
    }

    return DEFAULT_RESPONSES_API_PATH;
}

function configSupportsClaudeMessages(config) {
    return config &&
        config.type === 'apikey' &&
        Array.isArray(config.support) &&
        config.support.includes('claude');
}

function classifyApiKeyUpstreamStatus(statusCode) {
    const normalizedStatusCode = Number(statusCode);
    if (normalizedStatusCode === 401 || normalizedStatusCode === 403) {
        return {
            reason: 'apikey_auth_failed',
            retryKey: String(normalizedStatusCode),
            retrySource: 'http'
        };
    }

    if (normalizedStatusCode === 429) {
        return {
            reason: 'apikey_rate_limited',
            retryKey: '429',
            retrySource: 'http'
        };
    }

    if (normalizedStatusCode >= 500 && normalizedStatusCode <= 599) {
        return {
            reason: 'apikey_upstream_5xx',
            retryKey: String(normalizedStatusCode),
            retrySource: 'http'
        };
    }

    return null;
}

function buildIncomingUrl(req, proxyPath = '') {
    const combinedUrl = `${req.baseUrl || ''}${req.url || ''}`;
    if (!proxyPath || !combinedUrl.startsWith(proxyPath)) {
        return combinedUrl || '/';
    }

    const strippedUrl = combinedUrl.slice(proxyPath.length);
    return strippedUrl.startsWith('/') ? strippedUrl : `/${strippedUrl}`;
}

function buildUpstreamHeaders(reqHeaders, config, contentLength, isStream, clientVersion) {
    const headers = {
        authorization: `Bearer ${config.access_token}`,
        'chatgpt-account-id': config.account_id,
        'content-type': 'application/json',
        accept: isStream ? 'text/event-stream' : 'application/json',
        version: clientVersion
    };

    if (reqHeaders['accept-language']) {
        headers['accept-language'] = reqHeaders['accept-language'];
    }

    if (typeof contentLength === 'number') {
        headers['content-length'] = String(contentLength);
    }

    return headers;
}

function buildClaudeApiKeyUpstreamHeaders(reqHeaders, config, contentLength, isStream) {
    const headers = {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: isStream ? 'text/event-stream' : 'application/json'
    };

    for (const headerName of ['accept-language', 'anthropic-version', 'anthropic-beta']) {
        if (reqHeaders[headerName]) {
            headers[headerName] = reqHeaders[headerName];
        }
    }

    if (typeof contentLength === 'number') {
        headers['content-length'] = String(contentLength);
    }

    return headers;
}

function readRequestBody(req) {
    return new Promise((resolve, reject) => {
        const bodyChunks = [];

        req.on('data', chunk => {
            bodyChunks.push(chunk);
        });

        req.on('end', () => {
            resolve(Buffer.concat(bodyChunks));
        });

        req.on('error', reject);
    });
}

function sendJsonError(res, status, payload) {
    if (res.headersSent) {
        res.end();
        return;
    }

    res.status(status).json(payload);
}

function sendUpstreamError(res, status, contentType, bodyText) {
    const normalizedContentType = String(contentType || '').toLowerCase();

    if (normalizedContentType.includes('application/json')) {
        try {
            res.status(status).json(JSON.parse(bodyText));
            return;
        } catch (err) {
            // Fall through to plain text.
        }
    }

    res.status(status);
    if (contentType) {
        res.setHeader('content-type', contentType);
    }
    res.send(bodyText);
}

function sendBufferedUpstreamResponse(res, status, contentType, bodyBuffer) {
    const bodyText = bodyBuffer.toString('utf8');
    const normalizedContentType = String(contentType || '').toLowerCase();

    if (normalizedContentType.includes('application/json')) {
        try {
            res.status(status).json(JSON.parse(bodyText));
            return;
        } catch (err) {
            // Fall through to plain text.
        }
    }

    res.status(status);
    if (contentType) {
        res.setHeader('content-type', contentType);
    }
    res.send(bodyText);
}

function getGatewayStatusCode(err) {
    return err && err.code === 'ETIMEDOUT' ? 504 : 502;
}

function writeSseEvent(res, entry) {
    res.write(`event: ${entry.event}\n`);
    res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
}

function normalizeUpstreamHeaders(rawHeaders) {
    const headers = {};

    for (const [name, value] of Object.entries(rawHeaders || {})) {
        const normalizedName = String(name).toLowerCase();

        if (HOP_BY_HOP_HEADERS.has(normalizedName) || normalizedName === 'content-length' || typeof value === 'undefined') {
            continue;
        }

        headers[normalizedName] = value;
    }

    return headers;
}

function parseSseChunk(rawEvent) {
    const lines = rawEvent.split('\n');
    let eventName = '';
    const dataLines = [];

    for (const line of lines) {
        if (line.startsWith('event:')) {
            eventName = line.slice('event:'.length).trim();
            continue;
        }

        if (line.startsWith('data:')) {
            dataLines.push(line.slice('data:'.length).trimStart());
        }
    }

    return {
        eventName,
        dataText: dataLines.join('\n')
    };
}

function createSessionId() {
    return `claude-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function safeParseJson(text) {
    if (typeof text !== 'string' || text.length === 0) {
        return {};
    }

    try {
        return JSON.parse(text);
    } catch (err) {
        return {};
    }
}

function createClaudeMessageCollector() {
    const state = {
        message: null,
        blocks: new Map()
    };

    return {
        accept(entry) {
            if (entry.event === 'message_start') {
                state.message = {
                    ...entry.data.message,
                    content: []
                };
                return;
            }

            if (entry.event === 'content_block_start') {
                const block = entry.data.content_block;
                if (block.type === 'tool_use') {
                    state.blocks.set(entry.data.index, {
                        type: 'tool_use',
                        id: block.id,
                        name: block.name,
                        input: block.input || {},
                        partialJson: ''
                    });
                    return;
                }

                state.blocks.set(entry.data.index, {
                    type: 'text',
                    text: block.text || ''
                });
                return;
            }

            if (entry.event === 'content_block_delta') {
                const block = state.blocks.get(entry.data.index);
                if (!block) {
                    return;
                }

                if (entry.data.delta.type === 'text_delta') {
                    block.text = `${block.text || ''}${entry.data.delta.text || ''}`;
                    return;
                }

                if (entry.data.delta.type === 'input_json_delta') {
                    block.partialJson = `${block.partialJson || ''}${entry.data.delta.partial_json || ''}`;
                }
                return;
            }

            if (entry.event === 'content_block_stop') {
                const block = state.blocks.get(entry.data.index);
                if (block && block.type === 'tool_use' && block.partialJson) {
                    block.input = safeParseJson(block.partialJson);
                }
                return;
            }

            if (entry.event === 'message_delta' && state.message) {
                state.message.stop_reason = entry.data.delta.stop_reason;
                state.message.stop_sequence = entry.data.delta.stop_sequence;
                state.message.usage = entry.data.usage;
            }
        },
        build() {
            if (!state.message) {
                return null;
            }

            const content = Array.from(state.blocks.entries())
                .sort((left, right) => left[0] - right[0])
                .map(([, block]) => {
                    if (block.type === 'tool_use') {
                        return {
                            type: 'tool_use',
                            id: block.id,
                            name: block.name,
                            input: block.input
                        };
                    }

                    return {
                        type: 'text',
                        text: block.text || ''
                    };
                });

            return {
                ...state.message,
                content
            };
        }
    };
}

function processResponsesSseText(state, text, onPayload, onError, isFinal = false) {
    state.buffer += text.replace(/\r\n/g, '\n');

    while (state.buffer.includes('\n\n')) {
        const separatorIndex = state.buffer.indexOf('\n\n');
        const rawEvent = state.buffer.slice(0, separatorIndex);
        state.buffer = state.buffer.slice(separatorIndex + 2);

        if (!rawEvent.trim()) {
            continue;
        }

        const parsed = parseSseChunk(rawEvent);
        if (!parsed.dataText || parsed.dataText === '[DONE]') {
            continue;
        }

        try {
            const payload = JSON.parse(parsed.dataText);
            const upstreamEventName = payload.type || parsed.eventName;
            onPayload(upstreamEventName, payload);
        } catch (err) {
            onError(`解析上游 SSE 事件失败: ${err.message}`);
        }
    }

    if (!isFinal || !state.buffer.trim()) {
        return;
    }

    const parsed = parseSseChunk(state.buffer.trim());
    state.buffer = '';
    if (!parsed.dataText || parsed.dataText === '[DONE]') {
        return;
    }

    try {
        const payload = JSON.parse(parsed.dataText);
        const upstreamEventName = payload.type || parsed.eventName;
        onPayload(upstreamEventName, payload);
    } catch (err) {
        onError(`解析尾部 SSE 事件失败: ${err.message}`);
    }
}

function forwardClaudeApiKeyMessagesRequest({
    req,
    res,
    config,
    incomingUrl,
    rawBody,
    isClientStream,
    accessLogEnabled,
    logRequestSnapshot,
    createUpstreamRequestImpl,
    upstreamRequestTimeoutMs,
    handleRetryableUpstreamError,
    error
}) {
    const upstreamHeaders = buildClaudeApiKeyUpstreamHeaders(req.headers, config, rawBody.length, isClientStream);
    const targetUrlObject = new URL(incomingUrl, config.baseUrl);
    if (!targetUrlObject.searchParams.has('client_version')) {
        targetUrlObject.searchParams.set('client_version', '1');
    }
    const targetUrl = targetUrlObject.toString();

    if (accessLogEnabled && typeof logRequestSnapshot === 'function') {
        logRequestSnapshot({
            method: req.method,
            originalUrl: incomingUrl,
            rewrittenUrl: incomingUrl,
            config: {
                index: config.index,
                description: `#${config.index + 1} ${config.description}`,
                baseUrl: config.baseUrl
            },
            headers: upstreamHeaders,
            bodyBuffer: rawBody
        });
    }

    const upstream = createUpstreamRequestImpl({
        method: 'POST',
        targetUrl,
        headers: upstreamHeaders,
        body: rawBody,
        timeoutMs: upstreamRequestTimeoutMs
    });
    let responseFinished = false;
    let requestClosed = false;

    upstream.responsePromise.then(response => {
        const statusCode = Number(response.statusCode || 502);
        const upstreamHeaders = normalizeUpstreamHeaders(response.headers);
        const contentType = upstreamHeaders['content-type'] || '';
        const apiKeyFailure = classifyApiKeyUpstreamStatus(statusCode);
        if (apiKeyFailure && typeof handleRetryableUpstreamError === 'function') {
            handleRetryableUpstreamError(config, apiKeyFailure);
        }

        if (isClientStream) {
            res.status(statusCode);
            for (const [name, value] of Object.entries(upstreamHeaders)) {
                res.setHeader(name, value);
            }

            response.on('data', chunk => {
                res.write(chunk);
            });
            response.on('end', () => {
                responseFinished = true;
                if (!res.writableEnded) {
                    res.end();
                }
            });
            response.on('error', err => {
                if (requestClosed) {
                    return;
                }

                error(`代理请求失败: ${err.message}`);
                if (!res.headersSent) {
                    sendJsonError(res, getGatewayStatusCode(err), {
                        error: 'Bad Gateway',
                        message: err.message
                    });
                } else if (!res.writableEnded) {
                    res.end();
                }
            });
            return;
        }

        const responseBodyChunks = [];
        response.on('data', chunk => {
            responseBodyChunks.push(chunk);
        });
        response.on('end', () => {
            responseFinished = true;
            const bodyBuffer = Buffer.concat(responseBodyChunks);

            if (statusCode >= 200 && statusCode < 300) {
                sendBufferedUpstreamResponse(res, statusCode, contentType, bodyBuffer);
                return;
            }

            sendUpstreamError(res, statusCode, contentType, bodyBuffer.toString('utf8'));
        });
        response.on('error', err => {
            if (requestClosed) {
                return;
            }

            error(`代理请求失败: ${err.message}`);
            sendJsonError(res, getGatewayStatusCode(err), {
                error: 'Bad Gateway',
                message: err.message
            });
        });
    }).catch(err => {
        if (requestClosed) {
            return;
        }

        const message = err.message || 'upstream request failed';
        error(`代理请求失败: ${message}`);
        sendJsonError(res, getGatewayStatusCode(err), {
            error: 'Bad Gateway',
            message
        });
    });

    const closeUpstream = () => {
        requestClosed = true;
        if (!responseFinished) {
            upstream.abort(new Error('client closed request'));
        }
    };

    req.on('aborted', closeUpstream);
    res.on('close', closeUpstream);
}

function createClaudeMessagesHandler({
    getConfig,
    accessLogEnabled = false,
    log = () => {},
    error = () => {},
    logRequestSnapshot = null,
    responsesOptions = { modelAliases: {} },
    upstreamModel = 'gpt-5.4',
    reasoningEffort = 'high',
    clientVersion = '0.0.1',
    upstreamRequestTimeoutMs = 0,
    createUpstreamRequest: createUpstreamRequestImpl = createUpstreamRequest,
    handleRetryableUpstreamError = null
}) {
    return async function handleMessagesRequest(req, res) {
        const incomingUrl = buildIncomingUrl(req);

        if (req.method !== 'POST') {
            return sendJsonError(res, 405, {
                error: 'Method Not Allowed',
                message: 'Only POST is supported for /v1/messages'
            });
        }

        const contentType = String(req.headers['content-type'] || '').toLowerCase();
        if (!contentType.includes('application/json')) {
            return sendJsonError(res, 415, {
                error: 'Unsupported Media Type',
                message: 'Content-Type must be application/json'
            });
        }

        let config;
        try {
            config = getConfig(req);
        } catch (err) {
            return sendJsonError(res, 502, {
                error: 'Bad Gateway',
                message: err.message
            });
        }

        if (config.type === 'apikey' && !configSupportsClaudeMessages(config)) {
            return sendJsonError(res, 400, {
                error: 'Unsupported Mode',
                message: '/v1/messages 仅支持 token 或 support 包含 claude 的 apikey 配置项，当前 apikey 配置项请改用 /v1/responses 或添加 support:["claude"]'
            });
        }

        const responsesApiPath = resolveResponsesApiPath(config);

        let claudeRequest;
        let responsesRequest;
        let isClientStream = false;
        let rawBody;

        try {
            rawBody = await readRequestBody(req);
            claudeRequest = JSON.parse(rawBody.toString('utf8'));
            isClientStream = claudeRequest.stream === true;
            if (configSupportsClaudeMessages(config)) {
                forwardClaudeApiKeyMessagesRequest({
                    req,
                    res,
                    config,
                    incomingUrl,
                    rawBody,
                    isClientStream,
                    accessLogEnabled,
                    logRequestSnapshot,
                    createUpstreamRequestImpl,
                    upstreamRequestTimeoutMs,
                    handleRetryableUpstreamError,
                    error
                });
                return;
            }

            responsesRequest = transformClaudeMessagesRequest(claudeRequest, {
                model: upstreamModel,
                reasoningEffort,
                responsesOptions,
                stream: true,
                includeMaxOutputTokens: false
            });
        } catch (err) {
            return sendJsonError(res, 400, {
                error: '请求体处理失败',
                details: err.message
            });
        }

        const upstreamBody = Buffer.from(JSON.stringify(responsesRequest));
        let responseFinished = false;
        let requestClosed = false;
        let currentUpstream = null;
        let streamInitialized = false;

        function getRetryConfig(activeConfig, classification, failoverAttempt) {
            if (
                failoverAttempt >= 1 ||
                typeof handleRetryableUpstreamError !== 'function' ||
                res.headersSent ||
                requestClosed
            ) {
                return null;
            }

            const nextConfig = handleRetryableUpstreamError(activeConfig, classification);
            return nextConfig && nextConfig !== activeConfig ? nextConfig : null;
        }

        function startUpstreamAttempt(activeConfig, failoverAttempt = 0) {
            const attemptResponsesApiPath = resolveResponsesApiPath(activeConfig);
            const upstreamHeaders = buildUpstreamHeaders(req.headers, activeConfig, upstreamBody.length, true, clientVersion);

            if (accessLogEnabled && typeof logRequestSnapshot === 'function') {
                logRequestSnapshot({
                    method: req.method,
                    originalUrl: incomingUrl,
                    rewrittenUrl: attemptResponsesApiPath,
                    config: {
                        index: activeConfig.index,
                        description: `#${activeConfig.index + 1} ${activeConfig.description}`,
                        baseUrl: activeConfig.baseUrl
                    },
                    headers: upstreamHeaders,
                    bodyBuffer: upstreamBody
                });
            }

            const sessionId = createSessionId();
            upstreamHeaders.session_id = sessionId;
            upstreamHeaders['x-client-request-id'] = sessionId;
            const targetUrl = new URL(`${attemptResponsesApiPath}?client_version=${encodeURIComponent(clientVersion)}`, activeConfig.baseUrl).toString();
            const upstream = createUpstreamRequestImpl({
                method: 'POST',
                targetUrl,
                headers: upstreamHeaders,
                body: upstreamBody,
                timeoutMs: upstreamRequestTimeoutMs
            });
            currentUpstream = upstream;

            const transformer = createClaudeSseTransformer();
            const collector = createClaudeMessageCollector();
            const sseState = { buffer: '' };
            const responseBodyChunks = [];
            let upstreamMeta = null;
            let retryClassification = null;

            function ensureClientStreamHeaders() {
                if (!isClientStream || streamInitialized) {
                    return;
                }

                res.status(upstreamMeta.statusCode);
                res.setHeader('content-type', 'text/event-stream; charset=utf-8');
                res.setHeader('cache-control', 'no-cache');
                res.setHeader('connection', 'keep-alive');
                res.setHeader('x-accel-buffering', 'no');
                streamInitialized = true;
            }

            function handleUpstreamSseEvent(upstreamEventName, payload) {
                const classification = classifyRetryableResponsesStreamPayload(payload);
                if (classification && !streamInitialized && !collector.build()) {
                    retryClassification = classification;
                    return;
                }

                const entries = transformer.accept(upstreamEventName, payload);
                for (const entry of entries) {
                    collector.accept(entry);
                    if (isClientStream) {
                        ensureClientStreamHeaders();
                        writeSseEvent(res, entry);
                    }
                }
            }

            upstream.responsePromise.then(response => {
                upstreamMeta = {
                    statusCode: Number(response.statusCode || 502),
                    headers: normalizeUpstreamHeaders(response.headers)
                };

                response.on('data', chunk => {
                    if (upstreamMeta.statusCode >= 200 && upstreamMeta.statusCode < 300) {
                        processResponsesSseText(
                            sseState,
                            chunk.toString('utf8'),
                            handleUpstreamSseEvent,
                            message => error(message)
                        );
                    } else {
                        responseBodyChunks.push(chunk);
                    }
                });

                response.on('end', () => {
                    responseFinished = true;

                    if (upstreamMeta.statusCode >= 200 && upstreamMeta.statusCode < 300) {
                        processResponsesSseText(
                            sseState,
                            '',
                            handleUpstreamSseEvent,
                            message => error(message),
                            true
                        );

                        if (retryClassification) {
                            const nextConfig = getRetryConfig(activeConfig, retryClassification, failoverAttempt);
                            if (nextConfig) {
                                responseFinished = false;
                                startUpstreamAttempt(nextConfig, failoverAttempt + 1);
                                return;
                            }
                        }

                        if (isClientStream) {
                            if (!res.writableEnded) {
                                res.end();
                            }
                            return;
                        }

                        const mappedResponse = collector.build();
                        if (!mappedResponse) {
                            sendJsonError(res, 502, {
                                error: 'Bad Gateway',
                                message: 'Upstream stream completed without enough Claude response events'
                            });
                            return;
                        }

                        res.status(upstreamMeta.statusCode).json(mappedResponse);
                        return;
                    }

                    const responseText = Buffer.concat(responseBodyChunks).toString('utf8');
                    const upstreamContentType = upstreamMeta.headers['content-type'] || '';
                    const classification = classifyRetryableResponsesHttpError({
                        statusCode: upstreamMeta.statusCode,
                        bodyText: responseText
                    });
                    const nextConfig = classification ? getRetryConfig(activeConfig, classification, failoverAttempt) : null;
                    if (nextConfig) {
                        responseFinished = false;
                        startUpstreamAttempt(nextConfig, failoverAttempt + 1);
                        return;
                    }

                    sendUpstreamError(res, upstreamMeta.statusCode, upstreamContentType, responseText);
                });

                response.on('error', err => {
                    if (requestClosed) {
                        return;
                    }

                    error(`代理请求失败: ${err.message}`);
                    const statusCode = getGatewayStatusCode(err);
                    sendJsonError(res, statusCode, {
                        error: statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
                        message: err.message
                    });
                });
            }).catch(err => {
                if (requestClosed) {
                    return;
                }

                const message = err.message || 'upstream request failed';
                error(`代理请求失败: ${message}`);
                const statusCode = getGatewayStatusCode(err);
                sendJsonError(res, statusCode, {
                    error: statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
                    message
                });
            });
        }

        startUpstreamAttempt(config);

        const closeUpstream = () => {
            requestClosed = true;
            if (!responseFinished && currentUpstream) {
                currentUpstream.abort(new Error('client closed request'));
            }
        };

        req.on('aborted', closeUpstream);
        res.on('close', closeUpstream);
    };
}

module.exports = {
    createClaudeMessagesHandler,
    resolveResponsesApiPath
};
