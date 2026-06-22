const { createUpstreamRequest } = require('./upstream-request');
const {
    transformClaudeMessagesRequest,
    transformResponsesResponseToClaudeMessage,
    createClaudeSseTransformer
} = require('./claude-responses-compat');
const {
    classifyRetryableResponsesHttpError,
    classifyRetryableResponsesStreamPayload,
    isSuccessfulResponsesStatus
} = require('./responses-failover');

const DEFAULT_RESPONSES_API_PATH = '/backend-api/codex/responses';
const CLAUDE_RESPONSES_COMPAT_MODEL = 'gpt-5.5';
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
const LOCAL_ONLY_DIRECT_CLAUDE_HEADERS = new Set([
    'authorization',
    'x-api-key',
    'content-length',
    'host'
]);

function resolveResponsesApiPath(config) {
    if (config && config.type === 'apikey') {
        return 'responses';
    }

    if (config && config.apiPath) {
        return config.apiPath;
    }

    if (config && config.apiBasePath) {
        return `${config.apiBasePath.replace(/\/+$/, '')}/responses`;
    }

    return DEFAULT_RESPONSES_API_PATH;
}

function resolveResponsesTarget(config, clientVersion) {
    const responsesApiPath = resolveResponsesApiPath(config);
    const pathWithClientVersion = `${responsesApiPath}?client_version=${encodeURIComponent(clientVersion)}`;
    const baseUrl = config && typeof config.baseUrl === 'string'
        ? config.baseUrl
        : '';

    if (config && config.type === 'apikey') {
        const normalizedBaseUrl = `${baseUrl.replace(/\/+$/, '')}/`;
        const targetUrlObject = new URL(pathWithClientVersion, normalizedBaseUrl);
        return {
            targetUrl: targetUrlObject.toString(),
            rewrittenUrl: `${targetUrlObject.pathname}${targetUrlObject.search}`
        };
    }

    const targetUrlObject = new URL(pathWithClientVersion, baseUrl);
    return {
        targetUrl: targetUrlObject.toString(),
        rewrittenUrl: `${targetUrlObject.pathname}${targetUrlObject.search}`
    };
}

function configSupportsClaudeMessages(config) {
    if (!config) {
        return false;
    }

    if (config.type === 'claude_token') {
        return true;
    }

    return config.type === 'apikey' &&
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

    if (!isSuccessfulResponsesStatus(normalizedStatusCode)) {
        return {
            reason: 'apikey_upstream_error',
            retryKey: Number.isFinite(normalizedStatusCode) ? String(normalizedStatusCode) : 'invalid_status',
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
        'content-type': 'application/json',
        accept: isStream ? 'text/event-stream' : 'application/json'
    };

    if (config.type === 'apikey') {
        headers.authorization = `Bearer ${config.apiKey}`;
    } else {
        headers.authorization = `Bearer ${config.access_token}`;
        headers['chatgpt-account-id'] = config.account_id;
        headers.version = clientVersion;
    }

    if (reqHeaders['accept-language']) {
        headers['accept-language'] = reqHeaders['accept-language'];
    }

    if (typeof contentLength === 'number') {
        headers['content-length'] = String(contentLength);
    }

    return headers;
}

function getDirectClaudeAuthorization(config) {
    if (config.type === 'claude_token') {
        return `Bearer ${config.access_token}`;
    }

    return `Bearer ${config.apiKey}`;
}

function buildDirectClaudeUpstreamHeaders(reqHeaders, config, contentLength, isStream) {
    const headers = {
        authorization: getDirectClaudeAuthorization(config),
        'content-type': 'application/json',
        accept: isStream ? 'text/event-stream' : 'application/json'
    };

    for (const [name, value] of Object.entries(reqHeaders || {})) {
        const headerName = String(name).toLowerCase();
        if (
            HOP_BY_HOP_HEADERS.has(headerName) ||
            LOCAL_ONLY_DIRECT_CLAUDE_HEADERS.has(headerName)
        ) {
            continue;
        }

        if (Array.isArray(value)) {
            headers[headerName] = value.join(', ');
        } else if (typeof value !== 'undefined') {
            headers[headerName] = String(value);
        }
    }

    headers.authorization = getDirectClaudeAuthorization(config);
    headers['content-type'] = headers['content-type'] || 'application/json';
    headers.accept = isStream ? 'text/event-stream' : (headers.accept || 'application/json');

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

function isClaudeCodeQuotaCheckRequest(req, body) {
    if (!body || typeof body !== 'object' || body.stream === true) {
        return false;
    }

    const userAgent = String(req.headers['user-agent'] || '').toLowerCase();
    const appName = String(req.headers['x-app'] || '').toLowerCase();
    const isClaudeCodeClient = appName === 'cli' || userAgent.includes('claude-code');
    if (!isClaudeCodeClient) {
        return false;
    }

    if (Number(body.max_tokens) !== 1) {
        return false;
    }

    if (!Array.isArray(body.messages) || body.messages.length !== 1) {
        return false;
    }

    const [message] = body.messages;
    const content = message && message.content;

    return message &&
        message.role === 'user' &&
        isClaudeCodeQuotaContent(content);
}

function isClaudeCodeQuotaContent(content) {
    if (content === 'quota') {
        return true;
    }

    if (!Array.isArray(content) || content.length !== 1) {
        return false;
    }

    const [block] = content;
    return block &&
        block.type === 'text' &&
        block.text === 'quota';
}

function sendClaudeCodeQuotaCheckResponse(res, body) {
    res.status(200).json({
        id: `msg_airouter_quota_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: body.model || 'claude-haiku-4-5',
        content: [
            {
                type: 'text',
                text: 'ok'
            }
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
            input_tokens: 1,
            output_tokens: 1
        }
    });
}

function normalizeConfigSelection(selection) {
    if (selection && selection.config) {
        return {
            config: selection.config,
            release: typeof selection.release === 'function' ? selection.release : null
        };
    }

    return {
        config: selection || null,
        release: null
    };
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

function forwardDirectClaudeMessagesRequest({
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
    observeApiKeyRequestResult = null,
    getRetryConfig = null,
    retryWithSelection = null,
    releaseConfig = null,
    error
}) {
    const upstreamHeaders = buildDirectClaudeUpstreamHeaders(req.headers, config, rawBody.length, isClientStream);
    const targetUrlObject = new URL(incomingUrl, config.baseUrl);
    if (config.type === 'apikey' && !targetUrlObject.searchParams.has('client_version')) {
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
    let released = false;
    let apiKeyRequestResultRecorded = false;
    let successfulClientResponseCommitted = false;

    function releaseCurrentConfig() {
        if (released) {
            return;
        }

        released = true;
        if (typeof releaseConfig === 'function') {
            releaseConfig();
        }
    }

    function observeDirectApiKeyResult(result) {
        if (
            apiKeyRequestResultRecorded ||
            config.type !== 'apikey' ||
            typeof observeApiKeyRequestResult !== 'function'
        ) {
            return null;
        }

        apiKeyRequestResultRecorded = true;
        return observeApiKeyRequestResult(config, result);
    }

    function observeSuccessfulClientCommit(statusCode) {
        if (!isSuccessfulResponsesStatus(statusCode)) {
            return null;
        }

        successfulClientResponseCommitted = true;
        return observeDirectApiKeyResult({ ok: true });
    }

    function tryRetryWithNextConfig(classification, response = null) {
        const result = {
            handled: false,
            retried: false
        };

        if (
            typeof getRetryConfig !== 'function' ||
            typeof retryWithSelection !== 'function' ||
            requestClosed ||
            res.headersSent
        ) {
            return result;
        }

        result.handled = true;
        const nextSelection = getRetryConfig(config, classification);
        if (!nextSelection || !nextSelection.config || nextSelection.config === config) {
            if (nextSelection && typeof nextSelection.release === 'function') {
                nextSelection.release();
            }
            return result;
        }

        responseFinished = true;
        if (response && typeof response.resume === 'function') {
            response.resume();
        }
        releaseCurrentConfig();
        retryWithSelection(nextSelection);
        result.retried = true;
        return result;
    }

    upstream.responsePromise.then(response => {
        const statusCode = Number(response.statusCode || 502);
        const upstreamHeaders = normalizeUpstreamHeaders(response.headers);
        const contentType = upstreamHeaders['content-type'] || '';
        const apiKeyFailure = classifyApiKeyUpstreamStatus(statusCode);
        if (apiKeyFailure) {
            const retryResult = tryRetryWithNextConfig(apiKeyFailure, response);
            if (retryResult.retried) {
                return;
            }

            if (!retryResult.handled && typeof handleRetryableUpstreamError === 'function') {
                handleRetryableUpstreamError(config, apiKeyFailure);
            } else if (!retryResult.handled) {
                observeDirectApiKeyResult({
                    ok: false,
                    reason: apiKeyFailure.reason,
                    lastError: `${apiKeyFailure.retrySource}:${apiKeyFailure.retryKey}`,
                    switchReason: 'apikey_upstream_failover'
                });
            }
        }

        if (isClientStream) {
            res.status(statusCode);
            for (const [name, value] of Object.entries(upstreamHeaders)) {
                res.setHeader(name, value);
            }

            response.on('data', chunk => {
                observeSuccessfulClientCommit(statusCode);
                res.write(chunk);
            });
            response.on('end', () => {
                responseFinished = true;
                releaseCurrentConfig();
                if (!res.writableEnded) {
                    observeSuccessfulClientCommit(statusCode);
                    res.end();
                }
            });
            response.on('error', err => {
                if (requestClosed) {
                    return;
                }

                error(`代理请求失败: ${err.message}`);
                if (successfulClientResponseCommitted || res.headersSent) {
                    releaseCurrentConfig();
                    if (!res.writableEnded) {
                        res.end();
                    }
                    return;
                }

                const retryResult = tryRetryWithNextConfig({
                    reason: 'apikey_upstream_error',
                    retryKey: err.message || 'response_error',
                    retrySource: 'stream'
                });
                if (retryResult.retried) {
                    return;
                }
                if (!retryResult.handled) {
                    observeDirectApiKeyResult({
                        ok: false,
                        reason: 'apikey_upstream_error',
                        lastError: err.message,
                        switchReason: 'apikey_upstream_failover'
                    });
                }
                releaseCurrentConfig();
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
            releaseCurrentConfig();

            if (isSuccessfulResponsesStatus(statusCode)) {
                observeSuccessfulClientCommit(statusCode);
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
            const retryResult = tryRetryWithNextConfig({
                reason: 'apikey_upstream_error',
                retryKey: err.message || 'response_error',
                retrySource: 'stream'
            });
            if (retryResult.retried) {
                return;
            }
            if (!retryResult.handled) {
                observeDirectApiKeyResult({
                    ok: false,
                    reason: 'apikey_upstream_error',
                    lastError: err.message,
                    switchReason: 'apikey_upstream_failover'
                });
            }
            releaseCurrentConfig();
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
        const retryResult = tryRetryWithNextConfig({
            reason: 'apikey_upstream_error',
            retryKey: message,
            retrySource: 'request'
        });
        if (retryResult.retried) {
            return;
        }
        if (!retryResult.handled) {
            observeDirectApiKeyResult({
                ok: false,
                reason: 'apikey_upstream_error',
                lastError: message,
                switchReason: 'apikey_upstream_failover'
            });
        }
        releaseCurrentConfig();
        sendJsonError(res, getGatewayStatusCode(err), {
            error: 'Bad Gateway',
            message
        });
    });

    const closeUpstream = () => {
        requestClosed = true;
        releaseCurrentConfig();
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
    reasoningEffort = 'high',
    clientVersion = '1.0.1',
    upstreamRequestTimeoutMs = 0,
    createUpstreamRequest: createUpstreamRequestImpl = createUpstreamRequest,
    handleRetryableUpstreamError = null,
    getSessionKey = () => '',
    observeResponseModel = null,
    observeApiKeyRequestResult = null,
    cpaStyleCompatibility = false
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

        let claudeRequest;
        let responsesRequest;
        let isClientStream = false;
        let rawBody;
        let sessionKey = '';
        let configSelection = null;
        let config = null;

        try {
            rawBody = await readRequestBody(req);
            claudeRequest = JSON.parse(rawBody.toString('utf8'));
            isClientStream = claudeRequest.stream === true;
            sessionKey = getSessionKey({
                req,
                incomingUrl,
                body: claudeRequest,
                rawBody
            });
        } catch (err) {
            return sendJsonError(res, 400, {
                error: '请求体处理失败',
                details: err.message
            });
        }

        if (isClaudeCodeQuotaCheckRequest(req, claudeRequest)) {
            return sendClaudeCodeQuotaCheckResponse(res, claudeRequest);
        }

        try {
            configSelection = normalizeConfigSelection(getConfig(req, {
                incomingUrl,
                body: claudeRequest,
                rawBody,
                sessionKey
            }));
            config = configSelection.config;
        } catch (err) {
            return sendJsonError(res, 502, {
                error: 'Bad Gateway',
                message: err.message
            });
        }

        if (!config) {
            if (typeof configSelection.release === 'function') {
                configSelection.release();
            }
            return sendJsonError(res, 502, {
                error: 'Bad Gateway',
                message: '当前没有可用配置'
            });
        }

        let upstreamBody = null;
        let responseFinished = false;
        let requestClosed = false;
        let currentUpstream = null;
        let streamInitialized = false;
        let currentConfigSelection = null;
        let currentConfigReleased = false;
        const failedConfigs = [];

        function getRetryConfig(activeConfig, classification, failoverAttempt) {
            if (
                typeof handleRetryableUpstreamError !== 'function' ||
                res.headersSent ||
                requestClosed
            ) {
                return null;
            }

            if (!failedConfigs.includes(activeConfig)) {
                failedConfigs.push(activeConfig);
            }

            const nextSelection = normalizeConfigSelection(handleRetryableUpstreamError(activeConfig, classification, {
                sessionKey,
                failoverAttempt,
                failedConfigs: [...failedConfigs],
                excludedConfigs: [...failedConfigs]
            }));
            if (nextSelection.config && nextSelection.config !== activeConfig && !failedConfigs.includes(nextSelection.config)) {
                return nextSelection;
            }

            if (typeof nextSelection.release === 'function') {
                nextSelection.release();
            }

            return null;
        }

        function ensureResponsesRequest(activeSelection) {
            if (responsesRequest && upstreamBody) {
                return true;
            }

            try {
                responsesRequest = transformClaudeMessagesRequest(claudeRequest, {
                    model: CLAUDE_RESPONSES_COMPAT_MODEL,
                    reasoningEffort,
                    responsesOptions,
                    stream: true,
                    includeMaxOutputTokens: false,
                    cpaStyleCompatibility
                });
                upstreamBody = Buffer.from(JSON.stringify(responsesRequest));
                return true;
            } catch (err) {
                if (activeSelection && typeof activeSelection.release === 'function') {
                    activeSelection.release();
                }
                sendJsonError(res, 400, {
                    error: '请求体处理失败',
                    details: err.message
                });
                return false;
            }
        }

        function setCurrentConfigSelection(selection) {
            currentConfigSelection = normalizeConfigSelection(selection);
            currentConfigReleased = false;
            return currentConfigSelection;
        }

        function observeActiveResponseModel(activeConfig, observation = {}) {
            if (typeof observeResponseModel !== 'function' || !activeConfig) {
                return;
            }

            observeResponseModel(activeConfig, {
                requestModel: responsesRequest && responsesRequest.model,
                source: 'claude_messages',
                ...observation
            });
        }

        function releaseCurrentConfigSelection() {
            if (currentConfigReleased) {
                return;
            }

            currentConfigReleased = true;
            observeActiveResponseModel(currentConfigSelection && currentConfigSelection.config, {
                active: false
            });
            if (currentConfigSelection && typeof currentConfigSelection.release === 'function') {
                currentConfigSelection.release();
            }
        }

        function startAttempt(activeSelection, failoverAttempt = 0) {
            const normalizedSelection = normalizeConfigSelection(activeSelection);
            const activeConfig = normalizedSelection.config;
            if (!activeConfig) {
                if (typeof normalizedSelection.release === 'function') {
                    normalizedSelection.release();
                }
                sendJsonError(res, 502, {
                    error: 'Bad Gateway',
                    message: '当前没有可用配置'
                });
                return;
            }

            if (configSupportsClaudeMessages(activeConfig)) {
                forwardDirectClaudeMessagesRequest({
                    req,
                    res,
                    config: activeConfig,
                    incomingUrl,
                    rawBody,
                    isClientStream,
                    accessLogEnabled,
                    logRequestSnapshot,
                    createUpstreamRequestImpl,
                    upstreamRequestTimeoutMs,
                    handleRetryableUpstreamError,
                    observeApiKeyRequestResult,
                    getRetryConfig: typeof handleRetryableUpstreamError === 'function'
                        ? (failedConfig, classification) => getRetryConfig(failedConfig, classification, failoverAttempt)
                        : null,
                    retryWithSelection: nextSelection => startAttempt(nextSelection, failoverAttempt + 1),
                    releaseConfig: normalizedSelection.release,
                    error
                });
                return;
            }

            if (!ensureResponsesRequest(normalizedSelection)) {
                return;
            }

            startUpstreamAttempt(normalizedSelection, failoverAttempt);
        }

        function startUpstreamAttempt(activeSelection, failoverAttempt = 0) {
            const normalizedSelection = setCurrentConfigSelection(activeSelection);
            const activeConfig = normalizedSelection.config;
            const attemptTarget = resolveResponsesTarget(activeConfig, clientVersion);
            const upstreamHeaders = buildUpstreamHeaders(req.headers, activeConfig, upstreamBody.length, true, clientVersion);
            observeActiveResponseModel(activeConfig, {
                active: true
            });

            if (accessLogEnabled && typeof logRequestSnapshot === 'function') {
                logRequestSnapshot({
                    method: req.method,
                    originalUrl: incomingUrl,
                    rewrittenUrl: attemptTarget.rewrittenUrl,
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
            const upstream = createUpstreamRequestImpl({
                method: 'POST',
                targetUrl: attemptTarget.targetUrl,
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
            let convertedApiKeyResultRecorded = false;

            function observeConvertedApiKeyResult(result) {
                if (
                    convertedApiKeyResultRecorded ||
                    activeConfig.type !== 'apikey' ||
                    typeof observeApiKeyRequestResult !== 'function'
                ) {
                    return null;
                }

                convertedApiKeyResultRecorded = true;
                return observeApiKeyRequestResult(activeConfig, result);
            }

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
                if (retryClassification) {
                    return;
                }

                const responseModel = typeof payload?.response?.model === 'string' && payload.response.model.trim()
                    ? payload.response.model.trim()
                    : '';
                if (responseModel) {
                    observeActiveResponseModel(activeConfig, {
                        active: true,
                        responseModel,
                        statusCode: upstreamMeta ? upstreamMeta.statusCode : null
                    });
                }

                const classification = classifyRetryableResponsesStreamPayload(payload, {
                    requestedModel: responsesRequest && responsesRequest.model,
                });
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
                    if (isSuccessfulResponsesStatus(upstreamMeta.statusCode)) {
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

                    if (isSuccessfulResponsesStatus(upstreamMeta.statusCode)) {
                        processResponsesSseText(
                            sseState,
                            '',
                            handleUpstreamSseEvent,
                            message => error(message),
                            true
                        );

                        if (retryClassification) {
                            const nextSelection = getRetryConfig(activeConfig, retryClassification, failoverAttempt);
                            if (nextSelection) {
                                responseFinished = false;
                                releaseCurrentConfigSelection();
                                startAttempt(nextSelection, failoverAttempt + 1);
                                return;
                            }
                        }

                        if (isClientStream) {
                            observeConvertedApiKeyResult({ ok: true });
                            releaseCurrentConfigSelection();
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
                            releaseCurrentConfigSelection();
                            return;
                        }

                        observeConvertedApiKeyResult({ ok: true });
                        releaseCurrentConfigSelection();
                        res.status(upstreamMeta.statusCode).json(mappedResponse);
                        return;
                    }

                    const responseText = Buffer.concat(responseBodyChunks).toString('utf8');
                    const upstreamContentType = upstreamMeta.headers['content-type'] || '';
                    const classification = classifyRetryableResponsesHttpError({
                        statusCode: upstreamMeta.statusCode,
                        bodyText: responseText
                    });
                    const nextSelection = classification ? getRetryConfig(activeConfig, classification, failoverAttempt) : null;
                    if (nextSelection) {
                        responseFinished = false;
                        releaseCurrentConfigSelection();
                        startAttempt(nextSelection, failoverAttempt + 1);
                        return;
                    }

                    releaseCurrentConfigSelection();
                    sendUpstreamError(res, upstreamMeta.statusCode, upstreamContentType, responseText);
                });

                response.on('error', err => {
                    if (requestClosed) {
                        return;
                    }

                    error(`代理请求失败: ${err.message}`);
                    const statusCode = getGatewayStatusCode(err);
                    observeConvertedApiKeyResult({
                        ok: false,
                        reason: 'apikey_upstream_error',
                        lastError: err.message,
                        switchReason: 'apikey_upstream_failover'
                    });
                    releaseCurrentConfigSelection();
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
                observeConvertedApiKeyResult({
                    ok: false,
                    reason: 'apikey_upstream_error',
                    lastError: message,
                    switchReason: 'apikey_upstream_failover'
                });
                releaseCurrentConfigSelection();
                sendJsonError(res, statusCode, {
                    error: statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
                    message
                });
            });
        }

        startAttempt(configSelection);

        const closeUpstream = () => {
            requestClosed = true;
            releaseCurrentConfigSelection();
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
