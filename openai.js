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
const {
    parseOpenAiConfigFile,
    createRuntimeConfigs,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
} = require('./app/openai-config');
// https://chatgpt.com/api/auth/session
// ==================== 配置 ====================
const PORT = process.env.PORT || 3000;
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
        configs: createRuntimeConfigs(parsed)
    };
}

const LOADED_CONFIG = loadApiConfigs();
const CONFIG_TYPE = LOADED_CONFIG.type;
const API_CONFIGS = LOADED_CONFIG.configs;
let activeConfigIndex = 0;
let quotaMonitorRunning = false;
let quotaMonitorTimer = null;

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

function getAccountLabel(config) {
    return `#${config.index + 1} ${config.description}`;
}

function formatQuotaPercent(value) {
    return value === null || typeof value === 'undefined' ? 'unknown' : `${value}%`;
}

function formatQuotaResetTime(epochSeconds) {
    if (epochSeconds === null || typeof epochSeconds === 'undefined') {
        return 'unknown';
    }

    return new Date(epochSeconds * 1000).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
}

function formatBooleanText(value) {
    return value ? '是' : '否';
}

function formatReasonText(reason) {
    const reasonMap = {
        ok: '正常',
        unchecked: '未检查',
        api_key: 'API Key 模式',
        missing_credentials: '缺少凭证',
        rate_limit_not_allowed: '额度不可用',
        rate_limit_reached: '额度已用尽',
        [`remaining_below_${MIN_REMAINING_PERCENT}%`]: `剩余额度低于 ${MIN_REMAINING_PERCENT}%`,
        quota_check_failed: '额度检查失败'
    };

    return reasonMap[reason] || reason || '未知';
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

function formatRuntimeSummary(config) {
    const runtime = config.runtime;
    const parts = [
        `可用=${formatBooleanText(runtime.available)}`,
        `额度=${formatQuotaPercent(runtime.primaryRemainingPercent)}`,
        `刷新时间=${formatQuotaResetTime(runtime.primaryResetAt)}`,
        `周额度=${formatQuotaPercent(runtime.secondaryRemainingPercent)}`,
        `刷新时间=${formatQuotaResetTime(runtime.secondaryResetAt)}`,
        `状态=${formatReasonText(runtime.reason)}`
    ];

    if (runtime.lastError) {
        parts.push(`错误=${runtime.lastError}`);
    }

    return parts.join(' | ');
}

function isQuotaUsagePath(urlValue) {
    const parsedUrl = new URL(urlValue, 'http://localhost');
    return parsedUrl.pathname === QUOTA_CHECK_PATH;
}

function getCurrentTimestamp() {
    return Date.now();
}

function computeRemainingPercent(windowData) {
    if (!windowData || typeof windowData.used_percent !== 'number') {
        return null;
    }

    return Math.max(0, 100 - windowData.used_percent);
}

function evaluateQuotaResponse(payload) {
    const rateLimit = payload && typeof payload === 'object' ? payload.rate_limit || {} : {};
    const primaryRemainingPercent = computeRemainingPercent(rateLimit.primary_window);
    const secondaryRemainingPercent = computeRemainingPercent(rateLimit.secondary_window);
    const remainingValues = [primaryRemainingPercent, secondaryRemainingPercent].filter(value => value !== null);
    const remainingPercent = remainingValues.length > 0 ? Math.min(...remainingValues) : null;

    let available = true;
    let reason = 'ok';

    // 账号是否可用以 wham/usage 为准：
    // 1. allowed=false 或 limit_reached=true 直接视为不可用
    // 2. 剩余额度取主窗口/副窗口中的较小值
    // 3. 小于 3% 时主动切到下一个账号，避免请求打到快耗尽的账号上
    if (rateLimit.allowed === false) {
        available = false;
        reason = 'rate_limit_not_allowed';
    } else if (rateLimit.limit_reached === true) {
        available = false;
        reason = 'rate_limit_reached';
    } else if (remainingPercent !== null && remainingPercent < MIN_REMAINING_PERCENT) {
        available = false;
        reason = `remaining_below_${MIN_REMAINING_PERCENT}%`;
    }

    return {
        available,
        reason,
        remainingPercent,
        primaryRemainingPercent,
        primaryResetAt: rateLimit.primary_window?.reset_at ?? null,
        primaryResetAfterSeconds: rateLimit.primary_window?.reset_after_seconds ?? null,
        secondaryRemainingPercent,
        secondaryResetAt: rateLimit.secondary_window?.reset_at ?? null,
        secondaryResetAfterSeconds: rateLimit.secondary_window?.reset_after_seconds ?? null
    };
}

function applyQuotaState(config, quotaState) {
    config.runtime.available = quotaState.available;
    config.runtime.reason = quotaState.reason;
    config.runtime.lastCheckedAt = getCurrentTimestamp();
    config.runtime.remainingPercent = quotaState.remainingPercent;
    config.runtime.primaryRemainingPercent = quotaState.primaryRemainingPercent;
    config.runtime.primaryResetAt = quotaState.primaryResetAt;
    config.runtime.primaryResetAfterSeconds = quotaState.primaryResetAfterSeconds;
    config.runtime.secondaryRemainingPercent = quotaState.secondaryRemainingPercent;
    config.runtime.secondaryResetAt = quotaState.secondaryResetAt;
    config.runtime.secondaryResetAfterSeconds = quotaState.secondaryResetAfterSeconds;
    config.runtime.lastError = null;
}

function isConfigAvailable(config) {
    return Boolean(config && config.runtime && config.runtime.enabled && config.runtime.available);
}

function findNextAvailableConfigIndex(startIndex) {
    if (API_CONFIGS.length === 0) {
        return -1;
    }

    // 按 openai.json 中的顺序轮询下一个可用账号。
    // 这里不会跳过“后来恢复可用”的旧账号，后续轮询检查到恢复后会重新进入候选。
    for (let offset = 0; offset < API_CONFIGS.length; offset += 1) {
        const index = (startIndex + offset) % API_CONFIGS.length;
        if (isConfigAvailable(API_CONFIGS[index])) {
            return index;
        }
    }

    return -1;
}

function ensureActiveConfig(reason = 'select') {
    const currentConfig = API_CONFIGS[activeConfigIndex];
    if (isConfigAvailable(currentConfig)) {
        return currentConfig;
    }

    // 当前账号不可用时，从当前账号的下一个位置开始找可用账号。
    // 真正的“切号”动作就是把 activeConfigIndex 更新为 fallbackIndex。
    const fallbackIndex = findNextAvailableConfigIndex((activeConfigIndex + 1) % Math.max(API_CONFIGS.length, 1));
    if (fallbackIndex !== -1) {
        const previousConfig = currentConfig;
        activeConfigIndex = fallbackIndex;
        const nextConfig = API_CONFIGS[activeConfigIndex];

        if (previousConfig !== nextConfig) {
            warn(`账号切换: ${previousConfig ? getAccountLabel(previousConfig) : 'none'} -> ${getAccountLabel(nextConfig)} (${reason})`);
        }

        return nextConfig;
    }

    if (currentConfig) {
        // 如果暂时没有任何账号被判定为可用，保留当前账号继续服务。
        // 这样短暂网络抖动不会把整个代理立即打死。
        warn(`没有可用账号，继续使用当前账号 ${getAccountLabel(currentConfig)} (${reason})`);
        return currentConfig;
    }

    throw new Error('没有可用账号配置');
}

function selectConfig() {
    return ensureActiveConfig('request');
}

function buildQuotaCheckHeaders(config) {
    return buildAuthHeadersForConfig(config);
}

function runBufferedCurl(method, targetUrl, headers, body) {
    return new Promise((resolve, reject) => {
        const hasBody = Buffer.isBuffer(body) && body.length > 0;
        const args = [
            '--http1.1',
            '--silent',
            '--show-error',
            '--location',
            '-X',
            method,
            targetUrl,
            '-w',
            '\n__CURL_STATUS__:%{http_code}'
        ];

        for (const [name, value] of Object.entries(headers || {})) {
            if (typeof value === 'undefined') {
                continue;
            }

            args.push('-H', `${name}: ${value}`);
        }

        if (hasBody) {
            args.push('--data-binary', '@-');
        }

        const curl = spawn('curl', args, {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        let stdout = '';
        let stderr = '';

        curl.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
        });

        curl.stderr.on('data', chunk => {
            stderr += chunk.toString('utf8');
        });

        curl.on('error', err => {
            reject(err);
        });

        curl.on('close', code => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `curl exited with code ${code}`));
                return;
            }

            const marker = '\n__CURL_STATUS__:';
            const markerIndex = stdout.lastIndexOf(marker);
            if (markerIndex === -1) {
                reject(new Error('无法解析 curl 返回状态码'));
                return;
            }

            const bodyText = stdout.slice(0, markerIndex);
            const statusCode = Number(stdout.slice(markerIndex + marker.length).trim());
            resolve({
                statusCode,
                bodyText,
                stderr: stderr.trim()
            });
        });

        if (hasBody) {
            curl.stdin.end(body);
        } else {
            curl.stdin.end();
        }
    });
}

async function checkSingleAccountQuota(config) {
    if (!shouldUseQuotaMonitoring(config.type)) {
        return config.runtime;
    }

    if (!config.runtime.enabled) {
        config.runtime.available = false;
        config.runtime.reason = 'missing_credentials';
        return config.runtime;
    }

    const targetUrl = new URL(QUOTA_CHECK_PATH, config.baseUrl).toString();

    try {
        const result = await runBufferedCurl('GET', targetUrl, buildQuotaCheckHeaders(config));
        if (result.statusCode < 200 || result.statusCode >= 300) {
            throw new Error(`quota check status ${result.statusCode}`);
        }

        const payload = JSON.parse(result.bodyText);
        const quotaState = evaluateQuotaResponse(payload);
        applyQuotaState(config, quotaState);
    } catch (err) {
        // 配额检查失败时保留上一次 available 状态，只记录错误。
        // 否则一次瞬时网络错误就可能把账号误判为不可用并触发切号。
        config.runtime.available = Boolean(config.runtime.available);
        config.runtime.reason = 'quota_check_failed';
        config.runtime.lastCheckedAt = getCurrentTimestamp();
        config.runtime.lastError = err.message;
    }

    return config.runtime;
}

async function refreshAllAccountQuotas(reason = 'poll') {
    if (!shouldUseQuotaMonitoring(CONFIG_TYPE)) {
        return;
    }

    if (quotaMonitorRunning) {
        return;
    }

    // 串行检查所有账号的 /wham/usage，更新各自 runtime 状态。
    // 检查完成后再统一调用 ensureActiveConfig，避免在检查过程中反复来回切号。
    quotaMonitorRunning = true;
    const previousActiveIndex = activeConfigIndex;

    try {
        for (const config of API_CONFIGS) {
            const previousAvailability = config.runtime.available;
            const previousReason = config.runtime.reason;

            await checkSingleAccountQuota(config);

            const availabilityChanged = previousAvailability !== config.runtime.available || previousReason !== config.runtime.reason;
            if (availabilityChanged && !config.runtime.available && reason !== 'startup') {
                warn(`账号不可用: ${getAccountLabel(config)} (${config.runtime.reason}${config.runtime.lastError ? `: ${config.runtime.lastError}` : ''})`);
            } else if (availabilityChanged && config.runtime.available && previousAvailability === false && reason !== 'startup') {
                warn(`账号恢复可用: ${getAccountLabel(config)} (remaining=${config.runtime.remainingPercent ?? 'unknown'}%)`);
            }
        }

        const currentConfig = ensureActiveConfig(reason);

        if (previousActiveIndex !== activeConfigIndex) {
            warn(`当前活动账号: ${getAccountLabel(currentConfig)}`);
        }

        if (reason === 'poll') {
            log(`轮询额度: ${getAccountLabel(currentConfig)} | ${formatRuntimeSummary(currentConfig)}`);
        }
    } finally {
        quotaMonitorRunning = false;
    }
}

function startQuotaMonitor() {
    if (!shouldUseQuotaMonitoring(CONFIG_TYPE)) {
        return;
    }

    if (quotaMonitorTimer) {
        clearInterval(quotaMonitorTimer);
    }

    // 隐藏轮询：每 5 分钟检查一次账号额度。
    // ChatGPT 配额窗口约 5 小时刷新一次，所以被用尽的账号后续有机会恢复可用。
    quotaMonitorTimer = setInterval(() => {
        void refreshAllAccountQuotas('poll');
    }, QUOTA_CHECK_INTERVAL_MS);
}

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
                const quotaState = evaluateQuotaResponse(payload);
                applyQuotaState(config, quotaState);
                log(`额度信息: ${getAccountLabel(config)} | ${formatRuntimeSummary(config)}`);
            } catch (err) {
                warn(`额度信息解析失败: ${getAccountLabel(config)} (${err.message})`);
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
        const config = selectConfig();
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
    getConfig: () => selectConfig(),
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
    upstreamModel: process.env.CLAUDE_PROXY_MODEL || 'gpt-5.4',
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
    const currentConfig = API_CONFIGS[activeConfigIndex];
    res.json({
        status: 'ok',
        mode: CONFIG_TYPE,
        timestamp: new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false
        }),
        active_account: currentConfig ? {
            index: currentConfig.index,
            description: currentConfig.description,
            available: currentConfig.runtime.available,
            remaining_percent: currentConfig.runtime.remainingPercent,
            primary_remaining_percent: currentConfig.runtime.primaryRemainingPercent,
            primary_reset_at: currentConfig.runtime.primaryResetAt,
            primary_reset_after_seconds: currentConfig.runtime.primaryResetAfterSeconds,
            secondary_remaining_percent: currentConfig.runtime.secondaryRemainingPercent,
            secondary_reset_at: currentConfig.runtime.secondaryResetAt,
            secondary_reset_after_seconds: currentConfig.runtime.secondaryResetAfterSeconds,
            last_checked_at: currentConfig.runtime.lastCheckedAt,
            reason: currentConfig.runtime.reason
        } : null,
        configs: {
            total: API_CONFIGS.length,
            default: currentConfig ? currentConfig.description : null
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
        await refreshAllAccountQuotas('startup');
    }
    const currentConfig = ensureActiveConfig('startup');
    startQuotaMonitor();

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
        log(`  - 当前账号: ${getAccountLabel(currentConfig)}`);
        log(`  - 目标主机: ${currentConfig.baseUrl}`);
        log(`  - 目标前缀: ${currentConfig.apiBasePath || '(直连兼容接口)'}`);
        log(`  - 额度轮询: ${shouldUseQuotaMonitoring(CONFIG_TYPE) ? `每 ${QUOTA_CHECK_INTERVAL_MS / 60000} 分钟检查一次，剩余低于 ${MIN_REMAINING_PERCENT}% 自动切号` : '关闭（api_key 模式）'}`);
        log(`  - 访问日志: ${ACCESS_LOG_ENABLED ? '开启' : '关闭'}${ACCESS_LOG_ENABLED ? '（--access-log）' : '（使用 --access-log 开启）'}`);
        log(`  - 当前额度: ${formatRuntimeSummary(currentConfig)}`);
        if (shouldUseQuotaMonitoring(CONFIG_TYPE)) {
            log('  - 初始化账号额度:');
            for (const config of API_CONFIGS) {
                log(`    ${getAccountLabel(config)} | ${formatRuntimeSummary(config)}`);
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
