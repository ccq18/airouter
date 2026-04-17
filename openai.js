/**
 * OpenAI 兼容接口代理到 ChatGPT Codex backend-api
 */
console.log("starting")
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const zlib = require('zlib');
const express = require('express');
const { applyForcedProxyHeaders } = require('./app/proxy-header-overrides');
const { normalizeResponsesRequestBody } = require('./app/responses-defaults');
const { createClaudeMessagesHandler } = require('./app/claude-messages-handler');
const { createAccountManager } = require('./app/account-manager');
const {
    parseOpenAiConfigFile,
    resolveClaudeCodeOptions,
    createRuntimeConfigs,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
} = require('./app/openai-config');
// https://chatgpt.com/api/auth/session
// ==================== 配置 ====================
const PORT = process.env.PORT || 3009;
let CONFIG_FILE_NAME = process.env.CONFIG || 'openai.json';
const CONFIG_FILE = path.join(__dirname, CONFIG_FILE_NAME);
const QUOTA_CHECK_PATH = '/backend-api/wham/usage';
const QUOTA_CHECK_INTERVAL_MS = 1 * 60 * 1000;
const MIN_REMAINING_PERCENT = 3;
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

function hasCliFlag(flag) {
    return process.argv.includes(flag);
}

const ACCESS_LOG_ENABLED = (
    hasCliFlag('--access-log') ||
    process.env.ACCESS_LOG === '1' ||
    process.env.ACCESS_LOG === 'true'
) && !hasCliFlag('--no-access-log');

function loadApiConfigs() {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = parseOpenAiConfigFile(raw);

    return {
        type: parsed.type,
        configs: createRuntimeConfigs(parsed),
        claudeCode: resolveClaudeCodeOptions(parsed)
    };
}

const LOADED_CONFIG = loadApiConfigs();
const CONFIG_TYPE = LOADED_CONFIG.type;
const API_CONFIGS = LOADED_CONFIG.configs;
const CLAUDE_CODE_CONFIG = LOADED_CONFIG.claudeCode;

// ==================== 工具函数 ====================
function log(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
    console.log(`[${timestamp}]`, ...args);
}

function error(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
    console.error(`[${timestamp}]`, ...args);
}

function formatRequestBody(bodyBuffer, headers) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
        return '';
    }

    const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
    const bodyText = bodyBuffer.toString('utf8');

    if (contentType.includes('application/json')) {
        try {
            return JSON.stringify(JSON.parse(bodyText), null, 2);
        } catch (err) {
            return bodyText;
        }
    }

    return bodyText;
}

function logProxyRequestSnapshot(req, originalUrl, rewrittenUrl, config, headers, bodyBuffer) {
    if (!ACCESS_LOG_ENABLED) {
        return;
    }

    log('='.repeat(70));
    log('完整请求转发日志');
    log(`使用账号: #${config.index + 1} ${config.description}`);
    log(`原始请求: ${req.method} ${originalUrl}`);
    log(`转发目标: ${req.method} ${config.baseUrl}${rewrittenUrl}`);
    log('请求头:');
    console.log(JSON.stringify(headers, null, 2));

    if (Buffer.isBuffer(bodyBuffer) && bodyBuffer.length > 0) {
        log('请求体:');
        console.log(formatRequestBody(bodyBuffer, headers));
    } else {
        log('请求体: <empty>');
    }

    log('='.repeat(70));
}

function warn(...args) {
    const timestamp = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
    console.warn(`[${timestamp}]`, ...args);
}

function decodeResponseBody(bodyBuffer, contentEncoding) {
    if (!Buffer.isBuffer(bodyBuffer) || bodyBuffer.length === 0) {
        return '';
    }

    const encoding = String(contentEncoding || '').toLowerCase();

    if (encoding.includes('br')) {
        return zlib.brotliDecompressSync(bodyBuffer).toString('utf8');
    }

    if (encoding.includes('gzip')) {
        return zlib.gunzipSync(bodyBuffer).toString('utf8');
    }

    if (encoding.includes('deflate')) {
        return zlib.inflateSync(bodyBuffer).toString('utf8');
    }

    return bodyBuffer.toString('utf8');
}

function isQuotaUsagePath(urlValue) {
    const parsedUrl = new URL(urlValue, 'http://localhost');
    return parsedUrl.pathname === QUOTA_CHECK_PATH;
}

function getCurrentTimestamp() {
    return Date.now();
}

const accountManager = createAccountManager({
    configs: API_CONFIGS,
    configType: CONFIG_TYPE,
    quotaCheckPath: QUOTA_CHECK_PATH,
    quotaCheckIntervalMs: QUOTA_CHECK_INTERVAL_MS,
    minRemainingPercent: MIN_REMAINING_PERCENT,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring,
    spawn,
    log,
    warn,
    now: getCurrentTimestamp
});

function buildIncomingUrl(req, proxyPath = '') {
    const combinedUrl = `${req.baseUrl || ''}${req.url || ''}`;
    if (!proxyPath || !combinedUrl.startsWith(proxyPath)) {
        return combinedUrl || '/';
    }

    const strippedUrl = combinedUrl.slice(proxyPath.length);
    return strippedUrl.startsWith('/') ? strippedUrl : `/${strippedUrl}`;
}

function rewriteProxyUrl(incomingUrl, config) {
    const parsedUrl = new URL(incomingUrl, 'http://localhost');
    if (config.type === 'api_key') {
        return `${parsedUrl.pathname}${parsedUrl.search}`;
    }

    const incomingPath = parsedUrl.pathname || '/';
    let upstreamPath;

    if (incomingPath === '/v1' || incomingPath.startsWith('/v1/')) {
        const suffix = incomingPath === '/v1' ? '' : incomingPath.slice('/v1'.length);
        upstreamPath = `${config.apiBasePath}${suffix}`;
    } else if (incomingPath === '/wham' || incomingPath.startsWith('/wham/')) {
        const suffix = incomingPath === '/wham' ? '' : incomingPath.slice('/wham'.length);
        upstreamPath = `/backend-api/wham${suffix}`;
    } else {
        upstreamPath = `${config.apiBasePath}${incomingPath === '/' ? '' : incomingPath}`;
    }

    parsedUrl.pathname = upstreamPath;
    return `${parsedUrl.pathname}${parsedUrl.search}`;
}

function buildProxyHeaders(reqHeaders, config, contentLength) {
    const headers = { ...reqHeaders };

    for (const headerName of HOP_BY_HOP_HEADERS) {
        delete headers[headerName];
    }

    delete headers.authorization;
    delete headers['chatgpt-account-id'];
    const authHeaders = buildAuthHeadersForConfig(config);
    for (const [name, value] of Object.entries(authHeaders)) {
        if (typeof value !== 'undefined') {
            headers[name] = value;
        }
    }

    if (typeof contentLength === 'number') {
        headers['content-length'] = String(contentLength);
        delete headers['transfer-encoding'];
    } else {
        delete headers['content-length'];
    }

    return applyForcedProxyHeaders(headers);
}

function buildCurlArgs(method, targetUrl, headers, hasBody) {
    const args = [
        '--http1.1',
        '--silent',
        '--show-error',
        '--no-buffer',
        '--include',
        '--suppress-connect-headers',
        '-X',
        method,
        targetUrl
    ];

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

function applyResponseHeaders(res, rawHeaderBlock) {
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

    res.status(statusCode);
    for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
    }

    return {
        statusCode,
        headers
    };
}

function proxyRequest(req, res, config, body, originalUrl) {
    const hasBufferedBody = Buffer.isBuffer(body);
    const headers = buildProxyHeaders(req.headers, config, hasBufferedBody ? body.length : undefined);
    logProxyRequestSnapshot(req, originalUrl, req.url, config, headers, hasBufferedBody ? body : Buffer.alloc(0));
    req.headers = headers;
    const targetUrl = new URL(req.url, config.baseUrl).toString();
    const curlArgs = buildCurlArgs(req.method, targetUrl, headers, hasBufferedBody);
    const curl = spawn('curl', curlArgs, {
        stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    let headerBuffer = Buffer.alloc(0);
    let headersParsed = false;
    let responseFinished = false;
    const shouldLogQuotaUsage = req.method === 'GET' && isQuotaUsagePath(req.url);
    const responseBodyChunks = [];
    let upstreamResponseHeaders = {};

    curl.stdout.on('data', (chunk) => {
        if (headersParsed) {
            if (shouldLogQuotaUsage) {
                responseBodyChunks.push(chunk);
            }
            res.write(chunk);
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

            // Ignore interim responses and keep parsing until the final header block.
            if (statusCode >= 100 && statusCode < 200) {
                headerBuffer = remaining;
                continue;
            }

            const responseMeta = applyResponseHeaders(res, rawHeaderBlock);
            upstreamResponseHeaders = responseMeta.headers;
            res.flushHeaders();
            headersParsed = true;

            if (remaining.length > 0) {
                if (shouldLogQuotaUsage) {
                    responseBodyChunks.push(remaining);
                }
                res.write(remaining);
            }
        }
    });

    curl.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
    });

    curl.on('error', (err) => {
        error('curl 启动失败:', err.message);
        if (!res.headersSent) {
            res.status(502).json({
                error: 'Bad Gateway',
                message: err.message
            });
        }
    });

    curl.on('close', (code) => {
        responseFinished = true;

        if (!headersParsed) {
            const message = stderr.trim() || `curl exited with code ${code}`;
            error('代理请求失败:', message);
            if (!res.headersSent) {
                res.status(502).json({
                    error: 'Bad Gateway',
                    message
                });
            } else {
                res.end();
            }
            return;
        }

        if (shouldLogQuotaUsage) {
            try {
                const payloadText = decodeResponseBody(
                    Buffer.concat(responseBodyChunks),
                    upstreamResponseHeaders['content-encoding']
                );
                const payload = JSON.parse(payloadText);
                accountManager.applyQuotaPayload(config, payload);
                log(`额度信息: ${accountManager.getAccountStatus(config).summaryLine}`);
            } catch (err) {
                warn(`额度信息解析失败: ${accountManager.getAccountStatus(config).label} (${err.message})`);
            }
        }

        if (!res.writableEnded) {
            res.end();
        }
    });

    const closeCurl = () => {
        if (!responseFinished && !curl.killed) {
            curl.kill('SIGTERM');
        }
    };

    req.on('aborted', closeCurl);
    res.on('close', closeCurl);

    if (hasBufferedBody) {
        curl.stdin.end(body);
    } else {
        curl.stdin.end();
    }
}

function createHandler(proxyPath = '') {
    return function handler(req, res) {
        const config = accountManager.getActiveConfig();
        const incomingUrl = buildIncomingUrl(req, proxyPath);
        const rewrittenUrl = rewriteProxyUrl(incomingUrl, config);

        req.url = rewrittenUrl;
        if (ACCESS_LOG_ENABLED) {
            log(`请求路径重写: ${incomingUrl} -> ${rewrittenUrl}`);
        }

        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            const bodyChunks = [];
            req.on('data', chunk => {
                bodyChunks.push(chunk);
            });

            req.on('end', () => {
                let body = Buffer.concat(bodyChunks);
                const contentType = String(req.headers['content-type'] || '').toLowerCase();

                if (body.length > 0 && contentType.includes('application/json')) {
                    try {
                        const jsonBody = JSON.parse(body.toString('utf8'));
                        const normalizedBody = normalizeResponsesRequestBody(req.url, jsonBody);
                        body = Buffer.from(JSON.stringify(normalizedBody));
                    } catch (err) {
                        error('处理请求体时出错:', err.message);
                        res.status(400).json({
                            error: '请求体处理失败',
                            details: err.message
                        });
                        return;
                    }
                }

                proxyRequest(req, res, config, body, incomingUrl);
            });
        } else {
            proxyRequest(req, res, config, undefined, incomingUrl);
        }
    };
}

const handleClaudeMessagesRequest = createClaudeMessagesHandler({
    getConfig: () => accountManager.getActiveConfig(),
    accessLogEnabled: ACCESS_LOG_ENABLED,
    log,
    error,
    logRequestSnapshot: payload => {
        logProxyRequestSnapshot(
            { method: payload.method, url: payload.rewrittenUrl },
            payload.originalUrl,
            payload.rewrittenUrl,
            {
                ...payload.config,
                description: payload.config.description
            },
            payload.headers,
            payload.bodyBuffer
        );
    },
    upstreamModel: process.env.CLAUDE_PROXY_MODEL || CLAUDE_CODE_CONFIG.model,
    reasoningEffort: process.env.CLAUDE_PROXY_REASONING_EFFORT || CLAUDE_CODE_CONFIG.reasoningEffort,
    clientVersion: process.env.CODEX_CLIENT_VERSION || '0.0.1'
});

// ==================== 初始化 ====================
const app = express();

// ==================== 路由配置 ====================

// CORS 处理
app.use((req, res, next) => {
    const requestedHeaders = req.headers['access-control-request-headers'];
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.header('Access-Control-Allow-Headers', requestedHeaders || '*');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Access-Control-Request-Headers');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }
    next();
});

// 健康检查
app.get('/health', (req, res) => {
    const currentConfig = accountManager.getActiveConfig();
    const currentAccountStatus = accountManager.getAccountStatus(currentConfig);
    res.json({
        status: 'ok',
        mode: CONFIG_TYPE,
        timestamp: new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false
        }),
        active_account: currentAccountStatus ? {
            index: currentAccountStatus.index,
            description: currentAccountStatus.description,
            available: currentAccountStatus.available,
            remaining_percent: currentAccountStatus.remainingPercent,
            primary_remaining_percent: currentAccountStatus.primaryRemainingPercent,
            primary_reset_at: currentAccountStatus.primaryResetAt,
            primary_reset_after_seconds: currentAccountStatus.primaryResetAfterSeconds,
            secondary_remaining_percent: currentAccountStatus.secondaryRemainingPercent,
            secondary_reset_at: currentAccountStatus.secondaryResetAt,
            secondary_reset_after_seconds: currentAccountStatus.secondaryResetAfterSeconds,
            last_checked_at: currentAccountStatus.lastCheckedAt,
            reason: currentAccountStatus.reason
        } : null,
        configs: {
            total: API_CONFIGS.length,
            default: currentAccountStatus ? currentAccountStatus.description : null
        }
    });
});

// Claude Messages 兼容接口
app.post('/claude/v1/messages', (req, res) => {
    void handleClaudeMessagesRequest(req, res);
});

// 兼容 OpenAI 风格接口
app.use('/v1', createHandler());

// 兼容 wham 接口
app.use('/wham', createHandler());

// 404 处理
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        path: req.url
    });
});

// ==================== 启动服务器 ====================
async function startServer() {
    if (shouldUseQuotaMonitoring(CONFIG_TYPE)) {
        await accountManager.refreshQuotas('startup');
    }
    const currentConfig = accountManager.ensureActiveConfig('startup');
    const currentAccountStatus = accountManager.getAccountStatus(currentConfig);
    accountManager.startQuotaMonitor();

    app.listen(PORT, () => {
        log('='.repeat(70));
        log('OpenAI 兼容代理服务器已启动');
        log('='.repeat(70));
        log(`监听端口: ${PORT}`);
        log('代理路径: /v1/*, /wham/*');
        log('');
        log('API 配置:');
        log(`  - 配置文件: ${CONFIG_FILE}`);
        log(`  - 模式: ${CONFIG_TYPE}`);
        log(`  - 账号数量: ${API_CONFIGS.length}`);
        log(`  - 当前账号: ${currentAccountStatus.label}`);
        log(`  - 目标主机: ${currentConfig.baseUrl}`);
        log(`  - 目标前缀: ${currentConfig.apiBasePath || '(直连兼容接口)'}`);
        log(`  - 额度轮询: ${shouldUseQuotaMonitoring(CONFIG_TYPE) ? `每 ${QUOTA_CHECK_INTERVAL_MS / 60000} 分钟检查一次，剩余低于 ${MIN_REMAINING_PERCENT}% 自动切号` : '关闭（api_key 模式）'}`);
        log(`  - 访问日志: ${ACCESS_LOG_ENABLED ? '开启' : '关闭'}${ACCESS_LOG_ENABLED ? '（--access-log）' : '（使用 --access-log 开启）'}`);
        log(`  - 当前额度: ${currentAccountStatus.runtimeSummary}`);
        if (shouldUseQuotaMonitoring(CONFIG_TYPE)) {
            log('  - 初始化账号额度:');
            for (const config of API_CONFIGS) {
                log(`    ${accountManager.getAccountStatus(config).summaryLine}`);
            }
        }
        log('');
        log('路由规则:');
        log('  - /claude/v1/messages -> /backend-api/codex/responses (Claude compatibility)');
        log('  - /v1/responses -> /backend-api/codex/responses');
        log('  - /v1/models -> /backend-api/codex/models');
        log('  - /wham/* -> /backend-api/wham/*');
        log('');
        log(`健康检查: http://localhost:${PORT}/health`);
        log('='.repeat(70));
    });
}

startServer().catch(err => {
    error('启动失败:', err.message);
    process.exit(1);
});

// 优雅关闭
process.on('SIGINT', () => {
    log('收到 SIGINT 信号，正在关闭服务器...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    log('收到 SIGTERM 信号，正在关闭服务器...');
    process.exit(0);
});
