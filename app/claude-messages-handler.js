const { spawn } = require('child_process');
const {
    transformClaudeMessagesRequest,
    transformResponsesResponseToClaudeMessage,
    createClaudeSseTransformer
} = require('./claude-responses-compat');

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

function writeSseEvent(res, entry) {
    res.write(`event: ${entry.event}\n`);
    res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
}

function buildCurlArgs(method, targetUrl, headers, hasBody, isStream) {
    const args = [
        '--http1.1',
        '--silent',
        '--show-error'
    ];

    if (isStream) {
        args.push('--no-buffer');
    }

    args.push(
        '--include',
        '--suppress-connect-headers',
        '-X',
        method,
        targetUrl
    );

    for (const [name, value] of Object.entries(headers)) {
        if (typeof value === 'undefined') {
            continue;
        }

        if (Array.isArray(value)) {
            for (const item of value) {
                args.push('-H', `${name}: ${item}`);
            }
            continue;
        }

        args.push('-H', `${name}: ${value}`);
    }

    if (hasBody) {
        args.push('--data-binary', '@-');
    }

    return args;
}

function findHeaderTerminator(buffer) {
    const crlfIndex = buffer.indexOf('\r\n\r\n');
    if (crlfIndex !== -1) {
        return { index: crlfIndex, length: 4 };
    }

    const lfIndex = buffer.indexOf('\n\n');
    if (lfIndex !== -1) {
        return { index: lfIndex, length: 2 };
    }

    return null;
}

function parseRawHeaders(rawHeaderBlock) {
    const headerLines = rawHeaderBlock.split(/\r?\n/).filter(Boolean);
    const statusLine = headerLines.shift() || '';
    const match = statusLine.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})\s*(.*)$/i);

    if (!match) {
        throw new Error(`无法解析上游响应头: ${statusLine}`);
    }

    const statusCode = Number(match[1]);
    const headers = {};

    for (const line of headerLines) {
        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) {
            continue;
        }

        const name = line.slice(0, separatorIndex).trim().toLowerCase();
        const value = line.slice(separatorIndex + 1).trim();

        if (HOP_BY_HOP_HEADERS.has(name) || name === 'content-length') {
            continue;
        }

        if (headers[name]) {
            headers[name] = `${headers[name]}, ${value}`;
        } else {
            headers[name] = value;
        }
    }

    return {
        statusCode,
        headers
    };
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

function createClaudeMessagesHandler({
    getConfig,
    accessLogEnabled = false,
    log = () => {},
    error = () => {},
    logRequestSnapshot = null,
    upstreamModel = 'gpt-5.4',
    clientVersion = '0.0.1'
}) {
    return async function handleMessagesRequest(req, res) {
        const incomingUrl = buildIncomingUrl(req, '/claude');

        if (req.method !== 'POST') {
            return sendJsonError(res, 405, {
                error: 'Method Not Allowed',
                message: 'Only POST is supported for /claude/v1/messages'
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

        const responsesApiPath = resolveResponsesApiPath(config);

        let claudeRequest;
        let responsesRequest;
        let isClientStream = false;

        try {
            const rawBody = await readRequestBody(req);
            claudeRequest = JSON.parse(rawBody.toString('utf8'));
            isClientStream = claudeRequest.stream === true;
            responsesRequest = transformClaudeMessagesRequest(claudeRequest, {
                model: upstreamModel,
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
        const upstreamHeaders = buildUpstreamHeaders(req.headers, config, upstreamBody.length, true, clientVersion);

        if (accessLogEnabled && typeof logRequestSnapshot === 'function') {
            logRequestSnapshot({
                method: req.method,
                originalUrl: incomingUrl,
                rewrittenUrl: responsesApiPath,
                config: {
                    index: config.index,
                    description: `#${config.index + 1} ${config.description}`,
                    baseUrl: config.baseUrl
                },
                headers: upstreamHeaders,
                bodyBuffer: upstreamBody
            });
        }

        const sessionId = createSessionId();
        upstreamHeaders.session_id = sessionId;
        upstreamHeaders['x-client-request-id'] = sessionId;
        const targetUrl = new URL(`${responsesApiPath}?client_version=${encodeURIComponent(clientVersion)}`, config.baseUrl).toString();
        const curlArgs = buildCurlArgs('POST', targetUrl, upstreamHeaders, true, true);
        const curl = spawn('curl', curlArgs, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stderr = '';
        let headerBuffer = Buffer.alloc(0);
        let headersParsed = false;
        let responseFinished = false;
        let upstreamMeta = null;
        let streamInitialized = false;
        const responseBodyChunks = [];
        const transformer = createClaudeSseTransformer();
        const collector = createClaudeMessageCollector();
        const sseState = { buffer: '' };

        function handleUpstreamSseEvent(upstreamEventName, payload) {
            const entries = transformer.accept(upstreamEventName, payload);
            for (const entry of entries) {
                collector.accept(entry);
                if (isClientStream) {
                    writeSseEvent(res, entry);
                }
            }
        }

        curl.stdout.on('data', (chunk) => {
            if (headersParsed) {
                if (upstreamMeta.statusCode >= 200 && upstreamMeta.statusCode < 300) {
                    if (isClientStream && !streamInitialized) {
                        res.status(upstreamMeta.statusCode);
                        res.setHeader('content-type', 'text/event-stream; charset=utf-8');
                        res.setHeader('cache-control', 'no-cache');
                        res.setHeader('connection', 'keep-alive');
                        res.setHeader('x-accel-buffering', 'no');
                        streamInitialized = true;
                    }

                    processResponsesSseText(
                        sseState,
                        chunk.toString('utf8'),
                        handleUpstreamSseEvent,
                        message => error(message)
                    );
                } else {
                    responseBodyChunks.push(chunk);
                }
                return;
            }

            headerBuffer = Buffer.concat([headerBuffer, chunk]);

            while (!headersParsed) {
                const terminator = findHeaderTerminator(headerBuffer);
                if (!terminator) {
                    return;
                }

                const rawHeaderBlock = headerBuffer.slice(0, terminator.index).toString('utf8');
                const remaining = headerBuffer.slice(terminator.index + terminator.length);
                const statusMatch = rawHeaderBlock.match(/^HTTP\/\d+(?:\.\d+)?\s+(\d{3})/i);
                const statusCode = statusMatch ? Number(statusMatch[1]) : 0;

                if (statusCode >= 100 && statusCode < 200) {
                    headerBuffer = remaining;
                    continue;
                }

                try {
                    upstreamMeta = parseRawHeaders(rawHeaderBlock);
                } catch (err) {
                    error(`解析上游响应头失败: ${err.message}`);
                    sendJsonError(res, 502, {
                        error: 'Bad Gateway',
                        message: err.message
                    });
                    curl.kill('SIGTERM');
                    return;
                }

                headersParsed = true;

                if (remaining.length > 0) {
                    if (upstreamMeta.statusCode >= 200 && upstreamMeta.statusCode < 300) {
                        if (isClientStream && !streamInitialized) {
                            res.status(upstreamMeta.statusCode);
                            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
                            res.setHeader('cache-control', 'no-cache');
                            res.setHeader('connection', 'keep-alive');
                            res.setHeader('x-accel-buffering', 'no');
                            streamInitialized = true;
                        }

                        processResponsesSseText(
                            sseState,
                            remaining.toString('utf8'),
                            handleUpstreamSseEvent,
                            message => error(message)
                        );
                    } else {
                        responseBodyChunks.push(remaining);
                    }
                }
            }
        });

        curl.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
        });

        curl.on('error', (err) => {
            error(`curl 启动失败: ${err.message}`);
            sendJsonError(res, 502, {
                error: 'Bad Gateway',
                message: err.message
            });
        });

        curl.on('close', () => {
            responseFinished = true;

            if (!headersParsed) {
                const message = stderr.trim() || 'curl exited before response headers were received';
                error(`代理请求失败: ${message}`);
                sendJsonError(res, 502, {
                    error: 'Bad Gateway',
                    message
                });
                return;
            }

            if (upstreamMeta.statusCode >= 200 && upstreamMeta.statusCode < 300) {
                processResponsesSseText(
                    sseState,
                    '',
                    handleUpstreamSseEvent,
                    message => error(message),
                    true
                );

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
            sendUpstreamError(res, upstreamMeta.statusCode, upstreamContentType, responseText);
        });

        const closeCurl = () => {
            if (!responseFinished && !curl.killed) {
                curl.kill('SIGTERM');
            }
        };

        req.on('aborted', closeCurl);
        res.on('close', closeCurl);
        curl.stdin.end(upstreamBody);
    };
}

module.exports = {
    createClaudeMessagesHandler,
    resolveResponsesApiPath
};
