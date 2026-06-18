/**
 * OpenAI 兼容接口代理到 ChatGPT Codex backend-api
 */
console.log("starting")
const fs = require('node:fs');
const path = require('path');
const { spawn } = require('node:child_process');
const { inspect } = require('node:util');
const { StringDecoder } = require('node:string_decoder');
const zlib = require('zlib');
const express = require('express');
const { createUpstreamRequest, consumeResponseBody, requestBuffered } = require('./app/upstream-request');
const { applyForcedProxyHeaders } = require('./app/proxy-header-overrides');
const { buildIncomingUrl, rewriteProxyUrl } = require('./app/proxy-url-rewrite');
const {
    buildResponsesImageEditBody,
    buildResponsesImageGenerationBody,
    extractImageGenerationResponse,
    parseMultipartFormData,
} = require('./app/image-generations-compat');
const { normalizeResponsesRequestBody, isResponsesPath } = require('./app/responses-defaults');
const { createClaudeMessagesHandler } = require('./app/claude-messages-handler');
const { createAccountManager } = require('./app/account-manager');
const { refreshOpenAIToken } = require('./app/openai-token-refresh');
const {
    applyResponsesFailoverRequestHeaders,
    classifyRetryableResponsesHttpError,
    createResponsesEventStreamInspector,
    drainAbandonedResponse,
    isInspectableResponsesEventStream,
    isSuccessfulResponsesStatus,
    normalizeContentEncoding,
} = require('./app/responses-failover');
const {
    resolveClaudeCodeOptions,
    resolveResponsesOptions,
    createRuntimeConfigs,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring,
    configSupportsCapability,
    getConfigItemType
} = require('./app/openai-config');
const {
    ConfigEditorError,
    addConfigItem,
    buildImportedConfigItem,
    deleteConfigItem,
    deleteConfigItems,
    deleteDisabledConfigItem,
    deleteDisabledConfigItems,
    disableConfigItem,
    disableConfigItems,
    enableConfigItem,
    enableConfigItems,
    moveConfigItem,
    readParsedConfigFile,
    updateConfigSettings,
    writeParsedConfigFile
} = require('./app/config-editor');
const { reconcileRuntimeConfigs } = require('./app/runtime-config-reconciler');
const {
    generateRandomSecret,
    getConfiguredApiKeys,
    getConfiguredAuthToken,
    hasConfiguredApiKeys,
    isAuthorizedAdminRequest,
    isAuthorizedRequest
} = require('./app/request-auth');
// https://chatgpt.com/api/auth/session
// ==================== 配置 ====================
let runtimePort = normalizeRuntimePort(process.env.PORT, 3009);
let CONFIG_FILE_NAME = process.env.CONFIG || 'openai.json';
const CONFIG_FILE = path.join(__dirname, CONFIG_FILE_NAME);
const CONTROL_TOKEN = process.env.AIROUTER_CONTROL_TOKEN || '';
const CONTROL_REQUEST_FILE = process.env.AIROUTER_CONTROL_REQUEST_FILE || '';
const QUOTA_CHECK_PATH = '/backend-api/wham/usage';
const QUOTA_CHECK_INTERVAL_MS = 1 * 60 * 1000;
const ALL_QUOTA_CHECK_INTERVAL_MS = 3 * 60 * 1000;
const ALL_QUOTA_CHECK_DELAY_MS = 1000;
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
const LOCAL_ONLY_AUTH_HEADERS = new Set([
    'authorization',
    'x-api-key',
    'chatgpt-account-id'
]);
const LOCAL_ONLY_HEADER_PREFIXES = [
    'x-airouter-',
    'x-admin-'
];
const SESSION_KEY_HEADERS = [
    'x-airouter-session-id',
    'session-id',
    'session_id',
    'x-client-request-id'
];
const SESSION_KEY_QUERY_FIELDS = [
    'session_id',
    'conversation_id',
    'thread_id',
    'previous_response_id'
];
const SESSION_KEY_BODY_FIELDS = [
    'session_id',
    'conversation_id',
    'thread_id',
    'previous_response_id'
];

function parseTimeoutMs(name, fallbackValue) {
    const rawValue = process.env[name];

    if (typeof rawValue === 'undefined' || rawValue === '') {
        return fallbackValue;
    }

    const parsedValue = Number(rawValue);
    if (!Number.isFinite(parsedValue) || parsedValue < 0) {
        throw new Error(`${name} 必须是非负数字`);
    }

    return Math.floor(parsedValue);
}

const UPSTREAM_REQUEST_TIMEOUT_MS = parseTimeoutMs('UPSTREAM_REQUEST_TIMEOUT_MS', 10 * 60 * 1000);
const QUOTA_CHECK_TIMEOUT_MS = parseTimeoutMs('QUOTA_CHECK_TIMEOUT_MS', 10 * 1000);
const APIKEY_RECOVERY_TIMEOUT_MS = parseTimeoutMs('APIKEY_RECOVERY_TIMEOUT_MS', 10 * 60 * 1000);

function hasCliFlag(flag) {
    return process.argv.includes(flag);
}

const ACCESS_LOG_ENABLED = (
    hasCliFlag('--access-log') ||
    process.env.ACCESS_LOG === '1' ||
    process.env.ACCESS_LOG === 'true'
) && !hasCliFlag('--no-access-log');

function buildLoadedConfig(parsed) {
    return {
        parsed,
        configs: createRuntimeConfigs(parsed),
        claudeCode: resolveClaudeCodeOptions(parsed),
        responses: resolveResponsesOptions(parsed)
    };
}

function getConfigPoolType(configs) {
    const types = new Set((configs || []).map(config => config.type));

    if (types.size === 0) {
        return 'empty';
    }

    if (types.size === 1) {
        return types.values().next().value;
    }

    return 'mixed';
}

function hasQuotaMonitoredConfigs(configs) {
    return (configs || []).some(config => shouldUseQuotaMonitoring(config.type));
}

function hasRecoverableApiKeyConfigs(configs) {
    return (configs || []).some(config => configSupportsCapability(config, 'gpt'));
}

function ensureSecuritySettings(parsed) {
    let nextParsed = parsed;
    let changed = false;

    const normalizedApiKeys = getConfiguredApiKeys(parsed);
    const hasPersistedApiKeys = Array.isArray(parsed.apikeys);
    if (!hasPersistedApiKeys || normalizedApiKeys.length !== parsed.apikeys.length || normalizedApiKeys.some((item, index) => item !== parsed.apikeys[index])) {
        nextParsed = updateConfigSettings(nextParsed, {
            apikeys: normalizedApiKeys
        });
        changed = true;
    }

    const authToken = getConfiguredAuthToken(nextParsed);
    if (!authToken) {
        nextParsed = updateConfigSettings(nextParsed, {
            auth_token: generateRandomSecret('auth_')
        });
        changed = true;
    }

    return {
        parsed: nextParsed,
        changed
    };
}

function loadApiConfigs() {
    const parsed = readParsedConfigFile(CONFIG_FILE);
    const ensured = ensureSecuritySettings(parsed);
    const finalParsed = ensured.changed ? writeParsedConfigFile(CONFIG_FILE, ensured.parsed) : ensured.parsed;
    runtimePort = normalizeRuntimePort(finalParsed.port, runtimePort);
    applyProxyEnvironment(finalParsed.proxy_port);
    return buildLoadedConfig(finalParsed);
}

let currentParsedConfig = null;
let configType = null;
let apiConfigs = [];
let claudeCodeConfig = resolveClaudeCodeOptions({
    configs: [{}]
});
let responsesConfig = resolveResponsesOptions({
    configs: [{}]
});
let accountManager = null;
let handleClaudeMessagesRequest = null;
let handleCpaClaudeMessagesRequest = null;
let server = null;
let shuttingDown = false;
const activeSockets = new Set();

// ==================== 工具函数 ====================
function normalizeRuntimePort(value, fallback = 3009) {
    const normalized = typeof value === 'number' ? String(value) : String(value ?? '').trim();
    if (!/^\d+$/.test(normalized)) {
        return fallback;
    }

    const port = Number.parseInt(normalized, 10);
    return port >= 1 && port <= 65535 ? port : fallback;
}

function applyProxyEnvironment(proxyPort) {
    const port = normalizeRuntimePort(proxyPort, 0);
    const proxyKeys = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];

    if (!port) {
        for (const key of proxyKeys) {
            delete process.env[key];
        }
        return;
    }

    const httpProxy = `http://127.0.0.1:${port}`;
    process.env.http_proxy = httpProxy;
    process.env.https_proxy = httpProxy;
    process.env.HTTP_PROXY = httpProxy;
    process.env.HTTPS_PROXY = httpProxy;
    process.env.all_proxy = `socks5://127.0.0.1:${port}`;
    process.env.ALL_PROXY = `socks5://127.0.0.1:${port}`;
}

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

function buildLocalBaseUrl() {
    return `http://localhost:${runtimePort}`;
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

const PROCESS_SAFETY_HANDLERS = Symbol.for('airouter.processSafetyHandlers');

function formatProcessCrashReason(reason) {
    if (reason instanceof Error) {
        return reason.stack || reason.message;
    }

    if (typeof reason === 'string') {
        return reason;
    }

    return inspect(reason, { depth: 3, breakLength: 120 });
}

function registerProcessSafetyHandlers(options = {}) {
    const processLike = options.process || process;
    const errorLogger = options.error || error;

    if (processLike[PROCESS_SAFETY_HANDLERS]) {
        return processLike[PROCESS_SAFETY_HANDLERS].unregister;
    }

    const handleUncaughtException = err => {
        errorLogger('业务异常已捕获，服务继续运行:', formatProcessCrashReason(err));
    };
    const handleUnhandledRejection = reason => {
        errorLogger('未处理的 Promise 异常已捕获，服务继续运行:', formatProcessCrashReason(reason));
    };
    const unregister = () => {
        processLike.removeListener('uncaughtException', handleUncaughtException);
        processLike.removeListener('unhandledRejection', handleUnhandledRejection);
        delete processLike[PROCESS_SAFETY_HANDLERS];
    };

    processLike.on('uncaughtException', handleUncaughtException);
    processLike.on('unhandledRejection', handleUnhandledRejection);
    processLike[PROCESS_SAFETY_HANDLERS] = { unregister };

    return unregister;
}

function reportBusinessRequestError(res, err, context = '业务请求处理失败', options = {}) {
    const message = err && err.message ? err.message : String(err || 'unknown error');
    const errorLogger = options.error || error;
    errorLogger(`${context}:`, message);

    if (res.headersSent) {
        if (!res.writableEnded) {
            res.end();
        }
        return;
    }

    res.status(500).json({
        error: 'Internal Server Error',
        message
    });
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

function getGatewayStatusCode(err) {
    return err && err.code === 'ETIMEDOUT' ? 504 : 502;
}

function getHeaderValue(headers, headerName) {
    const normalizedTarget = String(headerName || '').toLowerCase();

    for (const [name, value] of Object.entries(headers || {})) {
        if (String(name).toLowerCase() === normalizedTarget) {
            if (Array.isArray(value)) {
                return value.join(', ');
            }

            return typeof value === 'undefined' ? '' : String(value);
        }
    }

    return '';
}

function normalizeSessionKey(value) {
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function firstNonEmptySessionValue(values) {
    for (const value of values) {
        const normalizedValue = normalizeSessionKey(value);
        if (normalizedValue) {
            return normalizedValue;
        }
    }

    return '';
}

function getSessionKeyFromBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return '';
    }

    return firstNonEmptySessionValue(SESSION_KEY_BODY_FIELDS.map(field => body[field]));
}

function getSessionKeyFromUrl(incomingUrl) {
    try {
        const parsedUrl = new URL(incomingUrl || '/', 'http://localhost');
        return firstNonEmptySessionValue(SESSION_KEY_QUERY_FIELDS.map(field => parsedUrl.searchParams.get(field)));
    } catch (err) {
        return '';
    }
}

function getRequestSessionKey(req, incomingUrl, body = null) {
    return firstNonEmptySessionValue([
        ...SESSION_KEY_HEADERS.map(headerName => getHeaderValue(req.headers, headerName)),
        getSessionKeyFromUrl(incomingUrl),
        getSessionKeyFromBody(body),
    ]);
}

function isOpenAiProxyConfig(item) {
    return item.type === 'token' || configSupportsCapability(item, 'gpt');
}

function isTokenProxyConfig(item) {
    return item.type === 'token';
}

function isGptApiKeyProxyConfig(item) {
    return configSupportsCapability(item, 'gpt');
}

function isRuntimeConfigAvailable(item) {
    return Boolean(item && item.runtime && item.runtime.enabled && item.runtime.available);
}

function isExcludedRuntimeConfig(item, excludedConfigs = []) {
    return excludedConfigs.some(excludedConfig => excludedConfig === item);
}

function createStaticConfigLease(config, sessionKey = '') {
    if (!config) {
        return null;
    }

    return {
        config,
        sessionKey,
        sticky: false,
        fallback: false,
        release() {}
    };
}

function canAttemptResponsesFailover(config, requestUrl) {
    return Boolean(
        accountManager &&
        config &&
        config.type === 'token' &&
        isResponsesPath(requestUrl)
    );
}

function classifyApiKeyUpstreamFailure(config, statusCode) {
    if (!config || config.type !== 'apikey') {
        return null;
    }

    const normalizedStatusCode = Number(statusCode);
    if (normalizedStatusCode === 401 || normalizedStatusCode === 403) {
        return {
            reason: 'apikey_auth_failed',
            retryKey: String(normalizedStatusCode),
            retrySource: 'http',
        };
    }

    if (normalizedStatusCode === 429) {
        return {
            reason: 'apikey_rate_limited',
            retryKey: '429',
            retrySource: 'http',
        };
    }

    if (normalizedStatusCode >= 500 && normalizedStatusCode <= 599) {
        return {
            reason: 'apikey_upstream_5xx',
            retryKey: String(normalizedStatusCode),
            retrySource: 'http',
        };
    }

    if (!isSuccessfulResponsesStatus(normalizedStatusCode)) {
        return {
            reason: 'apikey_upstream_error',
            retryKey: Number.isFinite(normalizedStatusCode) ? String(normalizedStatusCode) : 'invalid_status',
            retrySource: 'http',
        };
    }

    return null;
}

function isResponsesFailoverInspectionCandidate(statusCode, headers) {
    const normalizedStatusCode = Number(statusCode);
    return (Number.isFinite(normalizedStatusCode) && !isSuccessfulResponsesStatus(normalizedStatusCode)) ||
        isInspectableResponsesEventStream(headers);
}

function writeBufferedUpstreamResponse(res, statusCode, rawHeaders, bodyBuffer) {
    const responseMeta = applyResponseHeaders(res, statusCode, rawHeaders);
    res.flushHeaders();

    if (!res.writableEnded) {
        res.end(bodyBuffer);
    }

    return responseMeta;
}

async function inspectResponsesEventStream(response) {
    const inspector = createResponsesEventStreamInspector();
    const bufferedChunks = [];
    const contentEncoding = normalizeContentEncoding(getHeaderValue(response.headers, 'content-encoding'));
    let decoder = null;

    if (contentEncoding === 'br') {
        decoder = zlib.createBrotliDecompress();
    } else if (contentEncoding === 'gzip') {
        decoder = zlib.createGunzip();
    } else if (contentEncoding === 'deflate') {
        decoder = zlib.createInflate();
    }

    return new Promise((resolve, reject) => {
        let settled = false;

        function cleanup() {
            response.removeListener('data', handleData);
            response.removeListener('end', handleEnd);
            response.removeListener('error', handleError);
            response.removeListener('close', handleClose);

            if (decoder) {
                decoder.removeListener('data', handleDecodedData);
                decoder.removeListener('end', handleDecodedEnd);
                decoder.removeListener('error', handleDecodedError);
                decoder.destroy();
                decoder = null;
            }
        }

        function settle(result) {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            response.pause();
            resolve(result);
        }

        function rejectWith(error) {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            reject(error);
        }

        function handleData(chunk) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bufferedChunks.push(buffer);

            if (decoder) {
                decoder.write(buffer);
                return;
            }

            handleDecodedData(buffer);
        }

        function handleEnd() {
            if (decoder) {
                decoder.end();
                return;
            }

            handleDecodedEnd();
        }

        function handleDecodedData(chunk) {
            const decision = inspector.push(chunk);

            if (decision.action === 'pending') {
                return;
            }

            settle({
                decision,
                bufferedChunks,
                ended: false,
            });
        }

        function handleDecodedEnd() {
            settle({
                decision: inspector.finish(),
                bufferedChunks,
                ended: true,
            });
        }

        function handleDecodedError() {
            settle({
                decision: { action: 'pass' },
                bufferedChunks,
                ended: false,
            });
        }

        function handleError(err) {
            rejectWith(err);
        }

        function handleClose() {
            if (!response.complete) {
                rejectWith(response.errored || new Error('response closed before completion'));
            }
        }

        response.pause();
        response.on('data', handleData);
        response.on('end', handleEnd);
        response.on('error', handleError);
        response.on('close', handleClose);

        if (decoder) {
            decoder.on('data', handleDecodedData);
            decoder.on('end', handleDecodedEnd);
            decoder.on('error', handleDecodedError);
        }

        response.resume();
    });
}

async function inspectResponsesUpstreamForFailover(response, statusCode, rawHeaders) {
    if (Number.isFinite(Number(statusCode)) && !isSuccessfulResponsesStatus(statusCode)) {
        const bodyBuffer = await consumeResponseBody(response);
        const bodyText = decodeResponseBody(bodyBuffer, getHeaderValue(rawHeaders, 'content-encoding'));
        const classification = classifyRetryableResponsesHttpError({
            statusCode,
            bodyText,
        });

        if (classification) {
            return {
                action: 'retry',
                classification,
                forwardMode: 'buffered',
                bodyBuffer,
            };
        }

        return {
            action: 'forward-buffered',
            bodyBuffer,
        };
    }

    if (isInspectableResponsesEventStream(rawHeaders)) {
        const streamInspection = await inspectResponsesEventStream(response);

        if (streamInspection.decision.action === 'retry') {
            return {
                action: 'retry',
                classification: streamInspection.decision,
                forwardMode: streamInspection.ended ? 'buffered' : 'stream',
                bodyBuffer: streamInspection.ended ? Buffer.concat(streamInspection.bufferedChunks) : null,
                initialChunks: streamInspection.bufferedChunks,
            };
        }

        if (streamInspection.ended) {
            return {
                action: 'forward-buffered',
                bodyBuffer: Buffer.concat(streamInspection.bufferedChunks),
            };
        }

        return {
            action: 'forward-stream',
            initialChunks: streamInspection.bufferedChunks,
        };
    }

    return {
        action: 'skip',
    };
}

function createClaudeMessagesRequestHandler(options = {}) {
    const cpaStyleCompatibility = options.cpaStyleCompatibility === true;
    function acquireClaudeMessagesConfig(sessionKey, excludedConfigs = [], reason = 'claude_request') {
        const isClaudeApiKeyConfig = item => configSupportsCapability(item, 'claude') && !isExcludedRuntimeConfig(item, excludedConfigs);
        const isGptApiKeyConfig = item => configSupportsCapability(item, 'gpt') && !isExcludedRuntimeConfig(item, excludedConfigs);
        const currentClaudeApiKeyConfig = accountManager.getActiveConfig(isClaudeApiKeyConfig);
        if (currentClaudeApiKeyConfig && isRuntimeConfigAvailable(currentClaudeApiKeyConfig)) {
            return createStaticConfigLease(currentClaudeApiKeyConfig, sessionKey);
        }

        const nextClaudeApiKeyConfig = accountManager.ensureActiveConfig(reason, isClaudeApiKeyConfig);
        if (nextClaudeApiKeyConfig && isRuntimeConfigAvailable(nextClaudeApiKeyConfig)) {
            return createStaticConfigLease(nextClaudeApiKeyConfig, sessionKey);
        }

        const tokenLease = accountManager.acquireConfig(reason, item => item.type === 'token', {
            sessionKey,
            exclude: excludedConfigs,
            allowFallback: false,
        });

        if (tokenLease) {
            return tokenLease;
        }

        const currentGptApiKeyConfig = accountManager.getActiveConfig(isGptApiKeyConfig);
        if (currentGptApiKeyConfig && isRuntimeConfigAvailable(currentGptApiKeyConfig)) {
            return createStaticConfigLease(currentGptApiKeyConfig, sessionKey);
        }

        const nextGptApiKeyConfig = accountManager.ensureActiveConfig(reason, isGptApiKeyConfig);
        if (nextGptApiKeyConfig && isRuntimeConfigAvailable(nextGptApiKeyConfig)) {
            return createStaticConfigLease(nextGptApiKeyConfig, sessionKey);
        }

        return accountManager.acquireConfig(reason, item => item.type === 'token', {
            sessionKey,
            exclude: excludedConfigs,
        });
    }

    return createClaudeMessagesHandler({
        getConfig: (req, context = {}) => {
            const sessionKey = normalizeSessionKey(context.sessionKey);
            const config = acquireClaudeMessagesConfig(sessionKey);

            if (config) {
                return config;
            }

            throw new Error(`当前没有可用 support 包含 claude 的 apikey、token 或 support 包含 gpt 的 apikey 配置，请先访问 ${buildAdminPath()} 添加账号`);
        },
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
        responsesOptions: responsesConfig,
        reasoningEffort: process.env.CLAUDE_PROXY_REASONING_EFFORT || claudeCodeConfig.reasoningEffort,
        clientVersion: process.env.CODEX_CLIENT_VERSION || '1.0.1',
        upstreamRequestTimeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS,
        cpaStyleCompatibility,
        getSessionKey: ({ req, incomingUrl, body }) => getRequestSessionKey(req, incomingUrl, body),
        handleRetryableUpstreamError: (config, classification, context = null) => {
            if (config && config.type === 'apikey') {
                const apiKeyResult = accountManager.recordApiKeyRequestResult(config, {
                    ok: false,
                    reason: classification.reason,
                    lastError: `${classification.retrySource}:${classification.retryKey}`,
                    switchReason: 'apikey_upstream_failover',
                });

                if (apiKeyResult.unavailable) {
                    warn(`claude apikey 上游不可用: #${config.index + 1} ${config.description} (${classification.retrySource}:${classification.retryKey}, 最近 ${apiKeyResult.sampleSize} 次失败 ${apiKeyResult.failureCount} 次)`);
                }

                if (!context) {
                    return null;
                }

                const excludedConfigs = Array.isArray(context.excludedConfigs) && context.excludedConfigs.length > 0
                    ? context.excludedConfigs
                    : [config];

                return acquireClaudeMessagesConfig(context.sessionKey, excludedConfigs, 'claude_apikey_failover');
            }

            warn(`claude responses 自动切号: #${config.index + 1} ${config.description} (${classification.retrySource}:${classification.retryKey})`);
            accountManager.markConfigUnavailable(config, classification.reason, {
                lastError: `${classification.retrySource}:${classification.retryKey}`,
                switchReason: 'claude_responses_failover',
            });

            if (!context) {
                return null;
            }

            const excludedConfigs = Array.isArray(context.excludedConfigs) && context.excludedConfigs.length > 0
                ? context.excludedConfigs
                : [config];

            return acquireClaudeMessagesConfig(context.sessionKey, excludedConfigs, 'claude_responses_failover');
        },
        observeResponseModel: (config, observation) => {
            if (accountManager && typeof accountManager.observeResponseModel === 'function') {
                accountManager.observeResponseModel(config, observation);
            }
        },
        observeApiKeyRequestResult: (config, result) => {
            if (accountManager && typeof accountManager.recordApiKeyRequestResult === 'function') {
                return accountManager.recordApiKeyRequestResult(config, result);
            }

            return null;
        }
    });
}

function applyLoadedConfig(loadedConfig) {
    currentParsedConfig = loadedConfig.parsed;
    apiConfigs = loadedConfig.configs;
    configType = getConfigPoolType(apiConfigs);
    claudeCodeConfig = loadedConfig.claudeCode;
    responsesConfig = loadedConfig.responses;

    if (accountManager) {
        accountManager.stopQuotaMonitor();
    }

    accountManager = createAccountManager({
        configs: apiConfigs,
        configType,
        initialActiveConfigIndex: loadedConfig.initialActiveConfigIndex ?? 0,
        quotaCheckPath: QUOTA_CHECK_PATH,
        quotaCheckTimeoutMs: QUOTA_CHECK_TIMEOUT_MS,
        apiKeyRecoveryTimeoutMs: APIKEY_RECOVERY_TIMEOUT_MS,
        quotaCheckIntervalMs: QUOTA_CHECK_INTERVAL_MS,
        allQuotaCheckIntervalMs: ALL_QUOTA_CHECK_INTERVAL_MS,
        allQuotaCheckDelayMs: ALL_QUOTA_CHECK_DELAY_MS,
        minRemainingPercent: MIN_REMAINING_PERCENT,
        buildAuthHeadersForConfig,
        shouldUseQuotaMonitoring,
        refreshTokenFn: ({ refreshToken, clientId }) => refreshOpenAIToken({
            refreshToken,
            clientId,
            timeoutMs: QUOTA_CHECK_TIMEOUT_MS
        }),
        persistTokenRefreshFn: persistTokenRefreshForConfig,
        log,
        warn,
        now: getCurrentTimestamp
    });
    handleClaudeMessagesRequest = createClaudeMessagesRequestHandler();
    handleCpaClaudeMessagesRequest = createClaudeMessagesRequestHandler({
        cpaStyleCompatibility: true
    });
}

function hydrateLoadedConfig(loadedConfig, options = {}) {
    const previousActiveConfig = accountManager ? accountManager.getActiveConfig() : null;
    const previousActiveIndex = previousActiveConfig ? previousActiveConfig.index : 0;
    const reconciled = reconcileRuntimeConfigs(apiConfigs, loadedConfig.configs, {
        previousActiveConfig,
        previousActiveIndex,
        runtimeOverrides: options.runtimeOverrides
    });

    return {
        ...loadedConfig,
        configs: reconciled.configs,
        initialActiveConfigIndex: reconciled.initialActiveConfigIndex
    };
}

async function reloadRuntime(loadedConfig, reason, options = {}) {
    applyLoadedConfig(hydrateLoadedConfig(loadedConfig, options));

    if (hasQuotaMonitoredConfigs(apiConfigs) && !options.skipQuotaRefresh) {
        await accountManager.refreshQuotas(reason);
    }

    const currentConfig = selectReloadedActiveConfig(accountManager, reason, options);
    accountManager.startQuotaMonitor();
    return currentConfig;
}

function selectReloadedActiveConfig(manager, reason, options = {}) {
    if (!manager) {
        return null;
    }

    if (options.preserveActiveConfig) {
        return manager.getActiveConfig();
    }

    return manager.ensureActiveConfig(reason);
}

async function persistAndReloadConfig(nextParsed, reason, options = {}) {
    const savedParsed = writeParsedConfigFile(CONFIG_FILE, nextParsed);
    return reloadRuntime(buildLoadedConfig(savedParsed), reason, options);
}

function persistConfigWithoutRuntimeReload(nextParsed) {
    const savedParsed = writeParsedConfigFile(CONFIG_FILE, nextParsed);
    currentParsedConfig = savedParsed;
    return savedParsed;
}

function persistTokenRefreshForConfig(update) {
    const config = update && update.config;
    const accessToken = typeof update?.accessToken === 'string' ? update.accessToken.trim() : '';
    const refreshToken = typeof update?.refreshToken === 'string' ? update.refreshToken.trim() : '';
    const clientId = typeof update?.clientId === 'string' ? update.clientId.trim() : '';

    if (!config || !Number.isInteger(config.index)) {
        throw new ConfigEditorError('刷新 token 的配置项索引不合法');
    }

    if (!accessToken) {
        throw new ConfigEditorError('刷新 token 响应缺少 access_token');
    }

    const parsed = readParsedConfigFile(CONFIG_FILE);
    const targetItem = parsed.configs[config.index];

    if (!targetItem || getConfigItemType(targetItem) !== 'token') {
        throw new ConfigEditorError('刷新 token 的配置项不存在');
    }

    targetItem.access_token = accessToken;
    if (refreshToken) {
        targetItem.refresh_token = refreshToken;
    }
    if (clientId) {
        targetItem.client_id = clientId;
    }

    const savedParsed = persistConfigWithoutRuntimeReload(parsed);
    const savedItem = savedParsed.configs[config.index] || {};
    const runtimeConfig = apiConfigs[config.index];

    if (runtimeConfig) {
        runtimeConfig.access_token = savedItem.access_token || accessToken;
        runtimeConfig.refresh_token = savedItem.refresh_token || refreshToken || runtimeConfig.refresh_token || '';
        runtimeConfig.client_id = savedItem.client_id || clientId || runtimeConfig.client_id || '';
    }

    return savedItem;
}

function triggerServiceCommand(command, options = {}) {
    const spawnImpl = options.spawnImpl || spawn;
    const cwd = options.cwd || __dirname;
    const normalizedCommand = command === 'restart' ? 'restart' : 'start';
    const child = spawnImpl('npm', [normalizedCommand], {
        cwd,
        detached: true,
        stdio: 'ignore',
        env: process.env
    });

    if (child && typeof child.unref === 'function') {
        child.unref();
    }

    return child && child.pid ? child.pid : null;
}

function triggerServiceStart(options = {}) {
    return triggerServiceCommand('start', options);
}

function triggerServiceRestart(options = {}) {
    return triggerServiceCommand('restart', options);
}

function listenOnPort(port) {
    return new Promise((resolve, reject) => {
        server = app.listen(port, () => {
            runtimePort = port;
            log(`端口配置已即时生效: ${buildLocalBaseUrl()}`);
            resolve();
        });

        server.once('error', err => {
            reject(err);
        });

        server.on('connection', socket => {
            activeSockets.add(socket);
            socket.on('close', () => {
                activeSockets.delete(socket);
            });
        });
    });
}

function closeCurrentServer() {
    if (!server) {
        return Promise.resolve();
    }

    const closingServer = server;
    server = null;

    if (typeof closingServer.closeIdleConnections === 'function') {
        closingServer.closeIdleConnections();
    }

    return new Promise((resolve, reject) => {
        closingServer.close(err => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });

        setTimeout(() => {
            for (const socket of activeSockets) {
                socket.destroy();
            }
        }, 1_000).unref();
    });
}

async function applyRuntimeNetworkSettings(nextParsed, previousPort) {
    applyProxyEnvironment(nextParsed.proxy_port);

    const nextPort = normalizeRuntimePort(nextParsed.port, runtimePort);
    if (nextPort === previousPort) {
        return;
    }

    await closeCurrentServer();
    await listenOnPort(nextPort);
}

function scheduleRuntimeNetworkSettings(nextParsed, previousPort) {
    setTimeout(() => {
        applyRuntimeNetworkSettings(nextParsed, previousPort).catch(err => {
            error('端口配置即时生效失败:', err.message);
        });
    }, 120).unref();
}

function serializeAccountStatus(accountStatus) {
    if (!accountStatus) {
        return null;
    }

    return {
        index: accountStatus.index,
        description: accountStatus.description,
        label: accountStatus.label,
        available: accountStatus.available,
        remaining_percent: accountStatus.remainingPercent,
        primary_remaining_percent: accountStatus.primaryRemainingPercent,
        primary_reset_at: accountStatus.primaryResetAt,
        primary_reset_after_seconds: accountStatus.primaryResetAfterSeconds,
        secondary_remaining_percent: accountStatus.secondaryRemainingPercent,
        secondary_reset_at: accountStatus.secondaryResetAt,
        secondary_reset_after_seconds: accountStatus.secondaryResetAfterSeconds,
        last_checked_at: accountStatus.lastCheckedAt,
        reason: accountStatus.reason,
        quota_check_failures: accountStatus.quotaCheckFailures,
        unavailable_until: accountStatus.unavailableUntil,
        api_key_request_window: accountStatus.apiKeyRequestWindow ? {
            failure_count: accountStatus.apiKeyRequestWindow.failureCount,
            sample_size: accountStatus.apiKeyRequestWindow.sampleSize,
            failure_threshold: accountStatus.apiKeyRequestWindow.failureThreshold,
            window_size: accountStatus.apiKeyRequestWindow.windowSize,
            sample_ttl_ms: accountStatus.apiKeyRequestWindow.sampleTtlMs,
        } : null,
        api_key_recovery: accountStatus.apiKeyRecovery ? {
            enabled: accountStatus.apiKeyRecovery.enabled,
            pending: accountStatus.apiKeyRecovery.pending,
            interval_ms: accountStatus.apiKeyRecovery.intervalMs,
            last_checked_at: accountStatus.apiKeyRecovery.lastCheckedAt,
            result: accountStatus.apiKeyRecovery.result,
            status_code: accountStatus.apiKeyRecovery.statusCode,
            reason: accountStatus.apiKeyRecovery.reason,
            last_error: accountStatus.apiKeyRecovery.lastError,
            model: accountStatus.apiKeyRecovery.model,
        } : null,
        in_flight: accountStatus.inFlight,
        dispatch_session: accountStatus.dispatchSession ? {
            session_hash: accountStatus.dispatchSession.sessionHash,
            label: accountStatus.dispatchSession.label,
            has_session_key: accountStatus.dispatchSession.hasSessionKey,
            active: accountStatus.dispatchSession.active,
            sticky: accountStatus.dispatchSession.sticky,
            fallback: accountStatus.dispatchSession.fallback,
            reason: accountStatus.dispatchSession.reason,
            started_at: accountStatus.dispatchSession.startedAt,
            last_seen_at: accountStatus.dispatchSession.lastSeenAt,
        } : null,
        response_model: accountStatus.responseModel ? {
            request_model: accountStatus.responseModel.requestModel,
            response_model: accountStatus.responseModel.responseModel,
            active: accountStatus.responseModel.active,
            source: accountStatus.responseModel.source,
            status_code: accountStatus.responseModel.statusCode,
            observed_at: accountStatus.responseModel.observedAt,
            last_seen_at: accountStatus.responseModel.lastSeenAt,
        } : null,
        runtime_summary: accountStatus.runtimeSummary,
        summary_line: accountStatus.summaryLine,
    };
}

function buildDispatchStatus(activeConfig) {
    if (!activeConfig) {
        return {
            mode: 'empty',
            label: '无可用配置',
            detail: '请先添加 token 或 apikey 配置'
        };
    }

    if (activeConfig.type === 'apikey') {
        return {
            mode: 'apikey_override',
            label: `API Key 覆盖: 配置 #${activeConfig.index + 1}`,
            detail: '支持的流量会优先走当前 apikey'
        };
    }

    return {
        mode: 'token_pool',
        label: `Token 并发池: 锚点配置 #${activeConfig.index + 1}`,
        detail: 'token 请求按会话调度，apikey 仅作 fallback'
    };
}

function buildDispatchObservation(accountStatuses = []) {
    const observations = accountStatuses
        .filter(status => status && status.dispatchSession)
        .map(status => ({
            status,
            session: status.dispatchSession,
        }))
        .sort((left, right) => {
            if (left.session.active !== right.session.active) {
                return left.session.active ? -1 : 1;
            }

            return Number(right.session.lastSeenAt || 0) - Number(left.session.lastSeenAt || 0);
        });

    const selected = observations[0];
    if (!selected) {
        return null;
    }

    return {
        config_index: selected.status.index,
        config_label: selected.status.label,
        session_hash: selected.session.sessionHash,
        label: selected.session.label,
        has_session_key: selected.session.hasSessionKey,
        active: selected.session.active,
        sticky: selected.session.sticky,
        fallback: selected.session.fallback,
        reason: selected.session.reason,
        started_at: selected.session.startedAt,
        last_seen_at: selected.session.lastSeenAt,
    };
}

function getDispatchRole(config, activeConfig) {
    if (!config || !config.runtime || !config.runtime.available) {
        return 'unavailable';
    }

    if (config.type === 'apikey') {
        return activeConfig === config ? 'apikey_override' : 'apikey_fallback';
    }

    return activeConfig === config ? 'token_anchor' : 'token_dispatch';
}

function buildConfigAdminResponse() {
    const activeConfig = accountManager ? accountManager.getActiveConfig() : null;
    const activeAccountStatus = accountManager ? accountManager.getAccountStatus(activeConfig) : null;
    const configuredApiKeys = getConfiguredApiKeys(currentParsedConfig);
    const accountStatuses = currentParsedConfig.configs.map((item, index) => (
        accountManager && apiConfigs[index] ? accountManager.getAccountStatus(apiConfigs[index]) : null
    ));
    const dispatchStatus = buildDispatchStatus(activeConfig);
    const dispatchObservation = activeConfig && activeConfig.type === 'token'
        ? buildDispatchObservation(accountStatuses)
        : null;
    if (dispatchObservation) {
        dispatchStatus.observed_session = dispatchObservation;
    }

    return {
        config_file: CONFIG_FILE_NAME,
        config_path: CONFIG_FILE,
        mode: configType,
        runtime_port: Number(runtimePort),
        file_port: currentParsedConfig.port ?? null,
        proxy_port: currentParsedConfig.proxy_port ?? null,
        apikeys: configuredApiKeys,
        apikey_required: configuredApiKeys.length > 0,
        claude_code: currentParsedConfig.claude_code ?? null,
        responses: currentParsedConfig.responses ?? null,
        dispatch: dispatchStatus,
        active_config_index: activeAccountStatus ? activeAccountStatus.index : null,
        configs: currentParsedConfig.configs.map((item, index) => ({
            index,
            item,
            is_active: activeAccountStatus ? activeAccountStatus.index === index : false,
            dispatch_role: apiConfigs[index] ? getDispatchRole(apiConfigs[index], activeConfig) : 'unavailable',
            runtime: apiConfigs[index] ? serializeAccountStatus(accountStatuses[index]) : null
        })),
        disabled_configs: (Array.isArray(currentParsedConfig.disabled_configs) ? currentParsedConfig.disabled_configs : []).map((item, index) => ({
            index,
            item
        }))
    };
}

function getConfigRuntimeSummary(index) {
    if (!accountManager || !apiConfigs[index]) {
        return '';
    }

    const accountStatus = accountManager.getAccountStatus(apiConfigs[index]);
    return accountStatus && typeof accountStatus.runtimeSummary === 'string'
        ? accountStatus.runtimeSummary
        : '';
}

async function refreshConfigAdminResponse(options = {}) {
    const manager = options.accountManager || accountManager;
    const shouldRefreshQuota = Object.prototype.hasOwnProperty.call(options, 'shouldRefreshQuota')
        ? options.shouldRefreshQuota
        : hasQuotaMonitoredConfigs(apiConfigs);
    const buildResponse = options.buildResponse || buildConfigAdminResponse;

    if (manager && shouldRefreshQuota) {
        await manager.refreshQuotas('admin_refresh');
    }

    return buildResponse();
}

async function activateConfigAdminResponse(index, options = {}) {
    const manager = options.accountManager || accountManager;
    const buildResponse = options.buildResponse || buildConfigAdminResponse;

    if (!manager || typeof manager.activateConfig !== 'function') {
        throw new ConfigEditorError('账号管理器未初始化');
    }

    try {
        manager.activateConfig(index, 'admin_manual_activate');
    } catch (err) {
        throw new ConfigEditorError(err.message);
    }

    return buildResponse();
}

async function refreshConfigTokenAdminResponse(index, options = {}) {
    const readParsed = options.readParsedConfigFile || readParsedConfigFile;
    const refreshTokenRequest = options.refreshOpenAIToken || refreshOpenAIToken;
    const persistRefresh = options.persistTokenRefreshForConfig || persistTokenRefreshForConfig;
    const buildResponse = options.buildResponse || buildConfigAdminResponse;
    const configFile = options.configFile || CONFIG_FILE;
    const timeoutMs = Object.prototype.hasOwnProperty.call(options, 'timeoutMs')
        ? options.timeoutMs
        : QUOTA_CHECK_TIMEOUT_MS;

    const parsed = readParsed(configFile);
    const targetItem = parsed.configs[index];

    if (!targetItem) {
        throw new ConfigEditorError('配置项索引不合法');
    }

    if (getConfigItemType(targetItem) !== 'token') {
        throw new ConfigEditorError('只有 token 配置项支持刷新 token');
    }

    const refreshToken = typeof targetItem.refresh_token === 'string' ? targetItem.refresh_token.trim() : '';
    const clientId = typeof targetItem.client_id === 'string' ? targetItem.client_id.trim() : '';

    if (!refreshToken) {
        throw new ConfigEditorError('当前配置项没有 refresh_token');
    }

    const refreshed = await refreshTokenRequest({
        refreshToken,
        clientId,
        timeoutMs,
    });

    persistRefresh({
        config: { index },
        accessToken: refreshed.access_token || refreshed.accessToken,
        refreshToken: refreshed.refresh_token || refreshed.refreshToken || refreshToken,
        clientId: refreshed.client_id || refreshed.clientId || clientId,
    });

    return buildResponse();
}

function parseConfigIndex(value) {
    const index = Number(value);

    if (!Number.isInteger(index) || index < 0) {
        throw new ConfigEditorError('配置项索引不合法');
    }

    return index;
}

function parseBatchIndexes(body, label) {
    const indexes = body && Array.isArray(body.indexes) ? body.indexes : null;
    if (!indexes || indexes.length === 0) {
        throw new ConfigEditorError(`${label}索引不能为空`);
    }

    return indexes.map(value => {
        if (typeof value === 'number') {
            return value;
        }

        if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
            return Number.parseInt(value.trim(), 10);
        }

        throw new ConfigEditorError(`${label}索引不合法`);
    });
}

function deleteApiKeys(parsed, indexes) {
    const apikeys = getConfiguredApiKeys(parsed);
    const targetIndexes = parseBatchIndexes({ indexes }, 'apikey');
    const seen = new Set();

    for (const index of targetIndexes) {
        if (!Number.isInteger(index) || index < 0 || index >= apikeys.length) {
            throw new ConfigEditorError('apikey 索引不合法');
        }

        if (seen.has(index)) {
            throw new ConfigEditorError('apikey 索引重复');
        }

        seen.add(index);
    }

    return updateConfigSettings(parsed, {
        apikeys: apikeys.filter((_, index) => !seen.has(index))
    });
}

function createMissingConfigResponse(res) {
    return res.status(503).json({
        error: 'Service Unavailable',
        message: `当前没有可用配置，请先访问 ${buildAdminPath()} 添加账号`
    });
}

function buildAdminPath() {
    return `/admin/configs?auth_token=${encodeURIComponent(getConfiguredAuthToken(currentParsedConfig))}`;
}

function createProxyUnauthorizedResponse(res) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return res.status(401).json({
        error: 'Unauthorized',
        message: 'apikey 校验失败，请通过 Authorization: Bearer <apikey> 或 x-api-key 传入正确的 apikey'
    });
}

function createAdminUnauthorizedJsonResponse(res) {
    return res.status(401).json({
        error: 'Unauthorized',
        message: `auth_token 校验失败，请通过 ${buildAdminPath()} 访问管理后台`
    });
}

function createAdminUnauthorizedPageResponse(res) {
    return res.status(401).send('auth_token 校验失败');
}

function isAdminApiRequest(req) {
    const requestPath = String(req.path || req.url || '');
    return requestPath === '/api' || requestPath.startsWith('/api/');
}

function requireConfiguredApiKeys(req, res, next) {
    const configuredApiKeys = getConfiguredApiKeys(currentParsedConfig);

    if (configuredApiKeys.length === 0) {
        next();
        return;
    }

    if (!isAuthorizedRequest(req.headers, configuredApiKeys)) {
        createProxyUnauthorizedResponse(res);
        return;
    }

    next();
}

function requireAdminAuthToken(req, res, next) {
    if (!isAuthorizedAdminRequest(req.query && req.query.auth_token, getConfiguredAuthToken(currentParsedConfig))) {
        if (isAdminApiRequest(req)) {
            createAdminUnauthorizedJsonResponse(res);
            return;
        }

        createAdminUnauthorizedPageResponse(res);
        return;
    }

    next();
}

function isAllowedExternalOpenUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || ''));
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (err) {
        return false;
    }
}

function resolveExternalOpener(rawUrl, platform = process.platform) {
    if (platform === 'darwin') {
        return { command: 'open', args: [rawUrl] };
    }

    if (platform === 'win32') {
        return { command: 'cmd', args: ['/c', 'start', '', rawUrl] };
    }

    return { command: 'xdg-open', args: [rawUrl] };
}

function openExternalUrl(rawUrl, options = {}) {
    if (!isAllowedExternalOpenUrl(rawUrl)) {
        throw new ConfigEditorError('只能打开 http/https 链接');
    }

    const opener = resolveExternalOpener(rawUrl, options.platform || process.platform);
    const spawnImpl = options.spawnImpl || spawn;
    const warn = options.warn || error;

    return new Promise((resolve, reject) => {
        let child;

        try {
            child = spawnImpl(opener.command, opener.args, {
                detached: true,
                stdio: 'ignore',
            });
        } catch (err) {
            const message = `打开外部链接失败: ${err.message}`;
            warn(message);
            reject(new ConfigEditorError(message));
            return;
        }

        let settled = false;
        const settle = (callback, value) => {
            if (settled) {
                return;
            }

            settled = true;
            callback(value);
        };

        child.once('error', err => {
            const message = `打开外部链接失败: ${err.message}`;
            warn(message);
            settle(reject, new ConfigEditorError(message));
        });
        child.once('spawn', () => {
            settle(resolve, true);
        });
        child.unref();
    });
}

function parseConfigItemJson(rawJson) {
    if (typeof rawJson !== 'string' || rawJson.trim().length === 0) {
        throw new ConfigEditorError('请先输入配置项 JSON');
    }

    try {
        const parsed = JSON.parse(rawJson);

        if (!parsed || typeof parsed !== 'object') {
            throw new ConfigEditorError('配置项 JSON 必须是对象或对象数组');
        }

        if (Array.isArray(parsed)) {
            if (parsed.length === 0) {
                throw new ConfigEditorError('配置项 JSON 数组不能为空');
            }
            parsed.forEach((item, index) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    throw new ConfigEditorError(`配置项 JSON 数组第 ${index + 1} 项必须是对象`);
                }
            });
        }

        return parsed;
    } catch (err) {
        if (err instanceof ConfigEditorError) {
            throw err;
        }

        throw new ConfigEditorError(`配置项 JSON 解析失败: ${err.message}`);
    }
}

function validateConfigItemBeforeAdd(type, item) {
    try {
        return createRuntimeConfigs({
            configs: [item],
            claude_code: {},
        })[0];
    } catch (err) {
        throw new ConfigEditorError(err.message);
    }
}

function shouldForceResponsesStoreFalse(config, rewrittenUrl) {
    return Boolean(config && config.type === 'token' && isResponsesPath(rewrittenUrl));
}

function shouldUseCodexResponsesCompatibility(config, rewrittenUrl) {
    return Boolean(config && config.type === 'token' && isResponsesPath(rewrittenUrl));
}

function normalizeProxyJsonBody(config, rewrittenUrl, body, responsesOptions, options = {}) {
    return normalizeResponsesRequestBody(rewrittenUrl, body, {
        ...responsesOptions,
        forceStoreFalse: shouldForceResponsesStoreFalse(config, rewrittenUrl),
        codexCompatibility: shouldUseCodexResponsesCompatibility(config, rewrittenUrl),
        cpaStyleCompatibility: options.cpaStyleCompatibility === true,
    });
}

function prepareFailoverRequest(req, nextConfig, body, originalUrl, options = {}) {
    req.url = rewriteProxyUrl(originalUrl, nextConfig);
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!Buffer.isBuffer(body) || !contentType.includes('application/json')) {
        return body;
    }

    try {
        const jsonBody = JSON.parse(body.toString('utf8'));
        return Buffer.from(JSON.stringify(normalizeProxyJsonBody(nextConfig, req.url, jsonBody, responsesConfig, {
            cpaStyleCompatibility: options.cpaStyleCompatibility === true,
        })));
    } catch (err) {
        return body;
    }
}

function deleteHeadersCaseInsensitive(headers, namesToDelete) {
    for (const headerName of Object.keys(headers)) {
        if (namesToDelete.has(String(headerName).toLowerCase())) {
            delete headers[headerName];
        }
    }
}

function deleteLocalOnlyHeaders(headers) {
    for (const headerName of Object.keys(headers)) {
        const normalizedHeaderName = String(headerName).toLowerCase();
        if (
            LOCAL_ONLY_AUTH_HEADERS.has(normalizedHeaderName) ||
            LOCAL_ONLY_HEADER_PREFIXES.some(prefix => normalizedHeaderName.startsWith(prefix))
        ) {
            delete headers[headerName];
        }
    }
}

function buildProxyHeaders(reqHeaders, config, contentLength) {
    const headers = { ...reqHeaders };

    deleteHeadersCaseInsensitive(headers, HOP_BY_HOP_HEADERS);
    deleteLocalOnlyHeaders(headers);
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

function normalizeUpstreamResponseHeaders(rawHeaders) {
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

function applyResponseHeaders(res, statusCode, rawHeaders, options = {}) {
    const headers = normalizeUpstreamResponseHeaders(rawHeaders);
    if (!headers['content-type'] && options.defaultContentType) {
        headers['content-type'] = options.defaultContentType;
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

function isStreamingResponsesRequest(requestPath, body) {
    if (!isResponsesPath(requestPath)) {
        return false;
    }

    if (!Buffer.isBuffer(body) || body.length === 0) {
        return true;
    }

    try {
        const payload = JSON.parse(body.toString('utf8'));
        return payload && payload.stream !== false;
    } catch (err) {
        return true;
    }
}

function defaultContentTypeForProxyResponse(requestPath, body) {
    return isStreamingResponsesRequest(requestPath, body)
        ? 'text/event-stream; charset=utf-8'
        : null;
}

function normalizeObservedModel(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function extractResponseModelFromPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return '';
    }

    return normalizeObservedModel(payload.response?.model) || normalizeObservedModel(payload.model);
}

function extractRequestModelFromBody(body) {
    if (!Buffer.isBuffer(body) || body.length === 0) {
        return '';
    }

    try {
        const payload = JSON.parse(body.toString('utf8'));
        return normalizeObservedModel(payload && payload.model);
    } catch (err) {
        return '';
    }
}

function createResponseModelObserver(options = {}) {
    const {
        contentType = '',
        contentEncoding = '',
        maxBufferBytes = 64 * 1024,
        onModel = () => {},
    } = options;
    const normalizedContentType = String(contentType || '').toLowerCase();
    const normalizedEncoding = normalizeContentEncoding(contentEncoding);
    const isEventStream = normalizedContentType.includes('text/event-stream');
    const isJson = normalizedContentType.includes('json') || normalizedContentType.includes('application/problem+json');
    const decoder = new StringDecoder('utf8');
    let bufferedText = '';
    let bufferedBytes = 0;
    let lastModel = '';

    function notify(model) {
        const normalizedModel = normalizeObservedModel(model);
        if (!normalizedModel || normalizedModel === lastModel) {
            return;
        }

        lastModel = normalizedModel;
        onModel(normalizedModel);
    }

    function inspectEventBlock(eventBlock) {
        const dataLines = String(eventBlock || '')
            .split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^ /, ''));
        if (dataLines.length === 0) {
            return;
        }

        const payloadText = dataLines.join('\n');
        if (!payloadText || payloadText === '[DONE]') {
            return;
        }

        try {
            notify(extractResponseModelFromPayload(JSON.parse(payloadText)));
        } catch (err) {
            // Ignore partial or non-JSON SSE payloads; the response still passes through unchanged.
        }
    }

    function inspectBufferedEvents() {
        while (true) {
            const match = /\r?\n\r?\n/.exec(bufferedText);
            if (!match) {
                return;
            }

            const eventBlock = bufferedText.slice(0, match.index);
            bufferedText = bufferedText.slice(match.index + match[0].length);
            inspectEventBlock(eventBlock);
        }
    }

    function inspectJsonBuffer() {
        if (!bufferedText.trim()) {
            return;
        }

        try {
            notify(extractResponseModelFromPayload(JSON.parse(bufferedText)));
        } catch (err) {
            // Keep observation best-effort; malformed/non-JSON bodies are still forwarded normally.
        }
    }

    function inspectJsonPrefix() {
        const match = bufferedText.match(/"model"\s*:\s*"((?:\\.|[^"\\]){1,200})"/);
        if (!match) {
            return;
        }

        try {
            notify(JSON.parse(`"${match[1]}"`));
        } catch (err) {
            notify(match[1]);
        }
    }

    return {
        push(chunk) {
            if (normalizedEncoding || (!isEventStream && !isJson)) {
                return;
            }

            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bufferedBytes += buffer.length;
            if (bufferedBytes > maxBufferBytes) {
                return;
            }

            bufferedText += decoder.write(buffer);
            if (isEventStream) {
                inspectBufferedEvents();
            } else {
                inspectJsonPrefix();
            }
        },
        finish() {
            if (normalizedEncoding || (!isEventStream && !isJson) || bufferedBytes > maxBufferBytes) {
                return lastModel;
            }

            bufferedText += decoder.end();
            if (isEventStream) {
                inspectEventBlock(bufferedText);
                bufferedText = '';
            } else {
                inspectJsonBuffer();
            }

            return lastModel;
        },
    };
}

function proxyRequest(req, res, config, body, originalUrl, options = {}) {
    const hasBufferedBody = Buffer.isBuffer(body);
    const failoverAttempt = Number(options.failoverAttempt || 0);
    const cpaStyleCompatibility = options.cpaStyleCompatibility === true;
    const requestSessionKey = normalizeSessionKey(options.sessionKey);
    const requestPredicate = typeof options.predicate === 'function' ? options.predicate : () => true;
    const excludedConfigs = Array.isArray(options.excludedConfigs) ? options.excludedConfigs : [];
    const retrySelector = typeof options.retrySelector === 'function' ? options.retrySelector : null;
    let currentLease = options.lease || null;
    let leaseReleased = false;
    const shouldObserveResponseModel = isResponsesPath(req.url);
    const requestedResponseModel = shouldObserveResponseModel ? extractRequestModelFromBody(body) : '';
    const headers = applyResponsesFailoverRequestHeaders(
        buildProxyHeaders(req.headers, config, hasBufferedBody ? body.length : undefined),
        req.url
    );
    logProxyRequestSnapshot(req, originalUrl, req.url, config, headers, hasBufferedBody ? body : Buffer.alloc(0));
    req.headers = headers;
    const targetUrl = new URL(req.url, config.baseUrl).toString();
    const upstream = createUpstreamRequest({
        method: req.method,
        targetUrl,
        headers,
        body: hasBufferedBody ? body : undefined,
        timeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS
    });

    let headersApplied = false;
    let responseFinished = false;
    let requestClosed = false;
    let apiKeyRequestResultRecorded = false;
    const shouldLogQuotaUsage = req.method === 'GET' && isQuotaUsagePath(req.url);
    const responseBodyChunks = [];
    let upstreamResponseHeaders = {};
    let upstreamResponse = null;

    function observeCurrentResponseModel(observation = {}) {
        if (!shouldObserveResponseModel || !accountManager || typeof accountManager.observeResponseModel !== 'function') {
            return;
        }

        accountManager.observeResponseModel(config, {
            requestModel: requestedResponseModel,
            source: 'proxy_request',
            ...observation,
        });
    }

    observeCurrentResponseModel({ active: true });

    function releaseCurrentLease() {
        if (leaseReleased) {
            return;
        }

        leaseReleased = true;
        observeCurrentResponseModel({ active: false });
        if (currentLease && typeof currentLease.release === 'function') {
            currentLease.release();
        }
    }

    function recordCurrentApiKeyRequestResult(result) {
        if (!config || config.type !== 'apikey' || apiKeyRequestResultRecorded) {
            return null;
        }

        apiKeyRequestResultRecorded = true;
        return accountManager.recordApiKeyRequestResult(config, result);
    }

    function acquireFailoverLease(reason) {
        if (retrySelector) {
            return retrySelector(reason, requestSessionKey, [...excludedConfigs, config]);
        }

        if (!accountManager || typeof accountManager.acquireConfig !== 'function') {
            return null;
        }

        return accountManager.acquireConfig(reason, requestPredicate, {
            sessionKey: requestSessionKey,
            exclude: [...excludedConfigs, config],
            allowFallback: false,
        });
    }

    function handleQuotaUsageResponseComplete() {
        if (!shouldLogQuotaUsage) {
            return;
        }

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

    function startForwardingResponse(response, statusCode, rawHeaders, initialChunks = []) {
        const responseMeta = applyResponseHeaders(res, statusCode, rawHeaders, {
            defaultContentType: defaultContentTypeForProxyResponse(req.url, body),
        });
        upstreamResponseHeaders = responseMeta.headers;
        headersApplied = true;
        res.flushHeaders();
        recordCurrentApiKeyRequestResult({ ok: true });
        observeCurrentResponseModel({
            active: true,
            statusCode,
        });
        const responseModelObserver = createResponseModelObserver({
            contentType: getHeaderValue(responseMeta.headers, 'content-type'),
            contentEncoding: getHeaderValue(responseMeta.headers, 'content-encoding'),
            onModel: responseModel => {
                observeCurrentResponseModel({
                    active: true,
                    responseModel,
                    statusCode,
                });
            },
        });

        const writeChunk = chunk => {
            responseModelObserver.push(chunk);
            if (shouldLogQuotaUsage) {
                responseBodyChunks.push(chunk);
            }
            res.write(chunk);
        };

        for (const chunk of initialChunks) {
            writeChunk(chunk);
        }

        response.on('data', writeChunk);

        response.on('end', () => {
            responseFinished = true;
            responseModelObserver.finish();
            handleQuotaUsageResponseComplete();
            releaseCurrentLease();

            if (!res.writableEnded) {
                res.end();
            }
        });

        response.on('error', err => {
            if (requestClosed) {
                return;
            }

            error('代理请求失败:', err.message);
            if (!res.headersSent) {
                recordCurrentApiKeyRequestResult({
                    ok: false,
                    reason: 'apikey_upstream_error',
                    lastError: err.message,
                    switchReason: 'apikey_upstream_failover',
                });
                const gatewayStatusCode = getGatewayStatusCode(err);
                releaseCurrentLease();
                res.status(gatewayStatusCode).json({
                    error: gatewayStatusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
                    message: err.message
                });
                return;
            }

            if (!res.writableEnded) {
                releaseCurrentLease();
                res.end();
            }
        });

        response.resume();
    }

    function observeBufferedResponseModel(statusCode, rawHeaders, bodyBuffer) {
        const responseModelObserver = createResponseModelObserver({
            contentType: getHeaderValue(rawHeaders, 'content-type'),
            contentEncoding: getHeaderValue(rawHeaders, 'content-encoding'),
            onModel: responseModel => {
                observeCurrentResponseModel({
                    active: true,
                    responseModel,
                    statusCode,
                });
            },
        });
        responseModelObserver.push(bodyBuffer || Buffer.alloc(0));
        responseModelObserver.finish();
    }

    upstream.responsePromise.then(async response => {
        upstreamResponse = response;
        const statusCode = Number(response.statusCode || 502);
        const apiKeyFailure = classifyApiKeyUpstreamFailure(config, statusCode);
        if (apiKeyFailure) {
            const apiKeyResult = recordCurrentApiKeyRequestResult({
                ok: false,
                reason: apiKeyFailure.reason,
                lastError: `${apiKeyFailure.retrySource}:${apiKeyFailure.retryKey}`,
                switchReason: 'apikey_upstream_failover',
            });

            if (apiKeyResult.unavailable) {
                warn(`apikey 上游不可用: #${config.index + 1} ${config.description} (${apiKeyFailure.retrySource}:${apiKeyFailure.retryKey}, 最近 ${apiKeyResult.sampleSize} 次失败 ${apiKeyResult.failureCount} 次)`);
            }

            const nextLease = acquireFailoverLease('apikey_upstream_failover');
            const nextConfig = nextLease ? nextLease.config : null;

            if (!requestClosed && nextConfig && nextConfig !== config) {
                responseFinished = true;
                void drainAbandonedResponse(response);
                const nextBody = prepareFailoverRequest(req, nextConfig, body, originalUrl, {
                    cpaStyleCompatibility,
                });
                releaseCurrentLease();
                proxyRequest(req, res, nextConfig, nextBody, originalUrl, {
                    failoverAttempt: failoverAttempt + 1,
                    lease: nextLease,
                    sessionKey: requestSessionKey,
                    predicate: requestPredicate,
                    excludedConfigs: [...excludedConfigs, config],
                    retrySelector,
                    cpaStyleCompatibility,
                });
                return;
            }

            if (nextLease) {
                nextLease.release();
            }
        }

        const shouldInspectResponses = canAttemptResponsesFailover(config, req.url)
            && isResponsesFailoverInspectionCandidate(statusCode, response.headers);

        if (shouldInspectResponses) {
            const inspection = await inspectResponsesUpstreamForFailover(response, statusCode, response.headers);

            if (inspection.action === 'retry') {
                warn(`responses 自动切号: #${config.index + 1} ${config.description} (${inspection.classification.retrySource}:${inspection.classification.retryKey})`);
                accountManager.markConfigUnavailable(config, inspection.classification.reason, {
                    lastError: `${inspection.classification.retrySource}:${inspection.classification.retryKey}`,
                    switchReason: 'responses_failover',
                });
                const nextLease = acquireFailoverLease('responses_failover');
                const nextConfig = nextLease ? nextLease.config : null;

                if (!requestClosed && nextConfig && nextConfig !== config) {
                    responseFinished = true;
                    void drainAbandonedResponse(response);
                    const nextBody = prepareFailoverRequest(req, nextConfig, body, originalUrl, {
                        cpaStyleCompatibility,
                    });
                    releaseCurrentLease();
                    proxyRequest(req, res, nextConfig, nextBody, originalUrl, {
                        failoverAttempt: failoverAttempt + 1,
                        lease: nextLease,
                        sessionKey: requestSessionKey,
                        predicate: requestPredicate,
                        excludedConfigs: [...excludedConfigs, config],
                        retrySelector,
                        cpaStyleCompatibility,
                    });
                    return;
                }

                if (nextLease) {
                    nextLease.release();
                }

                if (inspection.forwardMode === 'buffered') {
                    observeBufferedResponseModel(statusCode, response.headers, inspection.bodyBuffer || Buffer.alloc(0));
                    upstreamResponseHeaders = writeBufferedUpstreamResponse(
                        res,
                        statusCode,
                        response.headers,
                        inspection.bodyBuffer || Buffer.alloc(0)
                    ).headers;
                    headersApplied = true;
                    responseFinished = true;
                    releaseCurrentLease();
                    return;
                }

                startForwardingResponse(response, statusCode, response.headers, inspection.initialChunks || []);
                return;
            }

            if (inspection.action === 'forward-buffered') {
                observeBufferedResponseModel(statusCode, response.headers, inspection.bodyBuffer || Buffer.alloc(0));
                upstreamResponseHeaders = writeBufferedUpstreamResponse(
                    res,
                    statusCode,
                    response.headers,
                    inspection.bodyBuffer || Buffer.alloc(0)
                ).headers;
                headersApplied = true;
                responseFinished = true;
                releaseCurrentLease();
                return;
            }

            if (inspection.action === 'forward-stream') {
                startForwardingResponse(response, statusCode, response.headers, inspection.initialChunks || []);
                return;
            }
        }

        startForwardingResponse(response, statusCode, response.headers);
    }).catch(err => {
        if (requestClosed) {
            return;
        }

        error('代理请求失败:', err.message);
        if (config && config.type === 'apikey') {
            const apiKeyResult = recordCurrentApiKeyRequestResult({
                ok: false,
                reason: 'apikey_upstream_error',
                lastError: err.message,
                switchReason: 'apikey_upstream_failover',
            });

            if (apiKeyResult.unavailable) {
                warn(`apikey 上游请求失败并标记不可用: #${config.index + 1} ${config.description} (${err.message}, 最近 ${apiKeyResult.sampleSize} 次失败 ${apiKeyResult.failureCount} 次)`);
            }

            const nextLease = acquireFailoverLease('apikey_upstream_failover');
            const nextConfig = nextLease ? nextLease.config : null;

            if (!headersApplied && !res.headersSent && nextConfig && nextConfig !== config) {
                const nextBody = prepareFailoverRequest(req, nextConfig, body, originalUrl, {
                    cpaStyleCompatibility,
                });
                releaseCurrentLease();
                proxyRequest(req, res, nextConfig, nextBody, originalUrl, {
                    failoverAttempt: failoverAttempt + 1,
                    lease: nextLease,
                    sessionKey: requestSessionKey,
                    predicate: requestPredicate,
                    excludedConfigs: [...excludedConfigs, config],
                    retrySelector,
                    cpaStyleCompatibility,
                });
                return;
            }

            if (nextLease) {
                nextLease.release();
            }
        }

        if (!headersApplied && !res.headersSent) {
            const statusCode = getGatewayStatusCode(err);
            releaseCurrentLease();
            res.status(statusCode).json({
                error: statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
                message: err.message
            });
            return;
        }

        if (!res.writableEnded) {
            releaseCurrentLease();
            res.end();
        }
    });

    const closeUpstream = () => {
        requestClosed = true;
        releaseCurrentLease();
        if (!responseFinished) {
            upstream.abort(new Error('client closed request'));
        }
    };

    req.on('aborted', closeUpstream);
    res.on('close', closeUpstream);
}

function createHandler(proxyPath = '', options = {}) {
    const cpaStyleCompatibility = options.cpaStyleCompatibility === true;
    return function handler(req, res) {
        const incomingUrl = buildIncomingUrl(req, proxyPath);

        function acquireProxyLease(sessionKey, excludedConfigs = []) {
            const activeApiKeyConfig = accountManager.getActiveConfig(item => isGptApiKeyProxyConfig(item) && !isExcludedRuntimeConfig(item, excludedConfigs));
            if (activeApiKeyConfig && isRuntimeConfigAvailable(activeApiKeyConfig)) {
                return createStaticConfigLease(activeApiKeyConfig, sessionKey);
            }

            const tokenLease = accountManager.acquireConfig('proxy_request', isTokenProxyConfig, {
                sessionKey,
                exclude: excludedConfigs,
                allowFallback: false,
            });
            if (tokenLease) {
                return tokenLease;
            }

            const isAllowedGptApiKeyProxyConfig = item => isGptApiKeyProxyConfig(item) && !isExcludedRuntimeConfig(item, excludedConfigs);
            const nextApiKeyConfig = accountManager.ensureActiveConfig('proxy_request', isAllowedGptApiKeyProxyConfig);
            if (nextApiKeyConfig && isRuntimeConfigAvailable(nextApiKeyConfig)) {
                return createStaticConfigLease(nextApiKeyConfig, sessionKey);
            }

            return accountManager.acquireConfig('proxy_request', isTokenProxyConfig, {
                sessionKey,
                exclude: excludedConfigs,
            });
        }

        function forwardWithConfig(lease, body, jsonBody = null) {
            if (!lease || !lease.config) {
                return createMissingConfigResponse(res);
            }

            const config = lease.config;
            const rewrittenUrl = rewriteProxyUrl(incomingUrl, config);
            req.url = rewrittenUrl;
            if (ACCESS_LOG_ENABLED) {
                log(`请求路径重写: ${incomingUrl} -> ${rewrittenUrl}`);
            }

            let nextBody = body;
            if (Buffer.isBuffer(nextBody) && jsonBody) {
                try {
                    nextBody = Buffer.from(JSON.stringify(normalizeProxyJsonBody(config, req.url, jsonBody, responsesConfig, {
                        cpaStyleCompatibility,
                    })));
                } catch (err) {
                    lease.release();
                    error('处理请求体时出错:', err.message);
                    res.status(400).json({
                        error: '请求体处理失败',
                        details: err.message
                    });
                    return;
                }
            }

            proxyRequest(req, res, config, nextBody, incomingUrl, {
                lease,
                sessionKey: lease.sessionKey,
                predicate: config.type === 'token' ? isTokenProxyConfig : isGptApiKeyProxyConfig,
                retrySelector: (reason, retrySessionKey, excludedConfigs) => acquireProxyLease(retrySessionKey, excludedConfigs),
                cpaStyleCompatibility,
            });
        }

        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            const bodyChunks = [];
            req.on('data', chunk => {
                bodyChunks.push(chunk);
            });

            req.on('end', () => {
                const body = Buffer.concat(bodyChunks);
                const contentType = String(req.headers['content-type'] || '').toLowerCase();
                let jsonBody = null;

                if (body.length > 0 && contentType.includes('application/json')) {
                    try {
                        jsonBody = JSON.parse(body.toString('utf8'));
                    } catch (err) {
                        error('处理请求体时出错:', err.message);
                        res.status(400).json({
                            error: '请求体处理失败',
                            details: err.message
                        });
                        return;
                    }
                }

                const sessionKey = getRequestSessionKey(req, incomingUrl, jsonBody);
                forwardWithConfig(acquireProxyLease(sessionKey), body, jsonBody);
            });
        } else {
            const sessionKey = getRequestSessionKey(req, incomingUrl);
            forwardWithConfig(acquireProxyLease(sessionKey), undefined);
        }
    };
}

function createCpaHandler() {
    return createHandler('/cpa', {
        cpaStyleCompatibility: true,
    });
}

function forwardCpaClaudeMessagesRequest(req, res) {
    const originalUrl = req.url;
    req.url = buildIncomingUrl(req, '/cpa');
    void handleCpaClaudeMessagesRequest(req, res).finally(() => {
        req.url = originalUrl;
    }).catch(err => {
        reportBusinessRequestError(res, err, 'Claude Messages 请求处理失败');
    });
}

function readBufferedRequestBody(req, limitBytes = 1024 * 1024) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let totalBytes = 0;

        req.on('data', chunk => {
            totalBytes += chunk.length;
            if (totalBytes > limitBytes) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {
            resolve(Buffer.concat(chunks));
        });

        req.on('error', reject);
    });
}

function acquireImageBusinessLease(manager, sessionKey, excludedConfigs = []) {
    const activeApiKeyConfig = manager.getActiveConfig(item => isGptApiKeyProxyConfig(item) && !isExcludedRuntimeConfig(item, excludedConfigs));
    if (activeApiKeyConfig && isRuntimeConfigAvailable(activeApiKeyConfig)) {
        return createStaticConfigLease(activeApiKeyConfig, sessionKey);
    }

    const tokenLease = manager.acquireConfig('image_request', isTokenProxyConfig, {
        sessionKey,
        exclude: excludedConfigs,
        allowFallback: false,
    });
    if (tokenLease) {
        return tokenLease;
    }

    const nextApiKeyConfig = manager.ensureActiveConfig(
        'image_request',
        item => isGptApiKeyProxyConfig(item) && !isExcludedRuntimeConfig(item, excludedConfigs)
    );
    if (nextApiKeyConfig && isRuntimeConfigAvailable(nextApiKeyConfig)) {
        return createStaticConfigLease(nextApiKeyConfig, sessionKey);
    }

    return manager.acquireConfig('image_request', isTokenProxyConfig, {
        sessionKey,
        exclude: excludedConfigs,
    });
}

function buildTokenImageUpstreamRequest(req, config, responsesPayload) {
    const upstreamPath = `${config.apiBasePath}/responses`;
    const normalizedPayload = normalizeProxyJsonBody(config, upstreamPath, responsesPayload, responsesConfig);
    const upstreamBody = Buffer.from(JSON.stringify(normalizedPayload));
    const requestHeaders = {
        ...req.headers,
        accept: 'text/event-stream, application/json',
        'content-type': 'application/json',
    };
    const headers = applyResponsesFailoverRequestHeaders(
        buildProxyHeaders(requestHeaders, config, upstreamBody.length),
        upstreamPath
    );
    const targetUrl = new URL(upstreamPath, config.baseUrl).toString();

    return {
        method: 'POST',
        targetUrl,
        headers,
        body: upstreamBody,
        timeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS,
    };
}

function buildNativeImageUpstreamRequest(req, incomingUrl, config, body) {
    const rewrittenUrl = rewriteProxyUrl(incomingUrl, config);
    const headers = buildProxyHeaders(req.headers, config, body.length);
    return {
        method: req.method,
        targetUrl: new URL(rewrittenUrl, config.baseUrl).toString(),
        headers,
        body,
        timeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS,
    };
}

function createTokenImageGenerationPayloadFactory(body, options = {}) {
    let prepared = false;
    let result = null;

    return function getTokenImageGenerationPayload() {
        if (prepared) {
            return result;
        }

        prepared = true;
        try {
            const payload = JSON.parse(body.toString('utf8'));
            result = {
                ok: true,
                payload: buildResponsesImageGenerationBody(payload, {
                    // token 模式真正使用的是 Responses 模型，不是客户端传来的
                    // gpt-image-* 图片模型名。Codex 源码的模型目录在
                    // codex-rs/models-manager/models.json，当前列出：
                    // gpt-5.5、gpt-5.4、gpt-5.4-mini、gpt-5.3-codex、
                    // gpt-5.2、codex-auto-review。某个模型是否开启
                    // image_generation 工具，以当前账号后端运行时为准。
                    model: options.responsesModel || process.env.AIROUTER_IMAGE_GENERATION_RESPONSES_MODEL || 'gpt-5.5',
                }),
            };
        } catch (err) {
            result = {
                ok: false,
                statusCode: 400,
                payload: {
                    error: '请求体处理失败',
                    details: err instanceof SyntaxError
                        ? `图片生成请求必须是 JSON: ${err.message}`
                        : err.message,
                },
            };
        }

        return result;
    };
}

function createTokenImageEditPayloadFactory(req, body, options = {}) {
    let prepared = false;
    let result = null;

    return function getTokenImageEditPayload() {
        if (prepared) {
            return result;
        }

        prepared = true;
        try {
            const form = parseMultipartFormData(body, req.headers['content-type']);
            result = {
                ok: true,
                payload: buildResponsesImageEditBody(form, {
                    // token 模式的模型支持规则见图片生成处理逻辑。apikey 配置
                    // 不走这里，而是直接由上游 Images API 决定支持哪些图片模型。
                    model: options.responsesModel || process.env.AIROUTER_IMAGE_GENERATION_RESPONSES_MODEL || 'gpt-5.5',
                }),
            };
        } catch (err) {
            result = {
                ok: false,
                statusCode: 400,
                payload: {
                    error: '请求体处理失败',
                    details: err.message,
                },
            };
        }

        return result;
    };
}

async function executeImageBusinessAttempt({
    req,
    incomingUrl,
    config,
    body,
    getTokenResponsesPayload,
    requestBufferedImpl
}) {
    if (config.type !== 'token') {
        const result = await requestBufferedImpl(buildNativeImageUpstreamRequest(req, incomingUrl, config, body));
        if (isSuccessfulResponsesStatus(result.statusCode)) {
            return {
                type: 'native_success',
                result,
            };
        }

        return {
            type: 'retryable_failure',
            result,
            classification: classifyApiKeyUpstreamFailure(config, result.statusCode) || {
                reason: 'apikey_upstream_error',
                retryKey: String(result.statusCode || 'invalid_status'),
                retrySource: 'http',
            },
        };
    }

    const responsesPayload = getTokenResponsesPayload();
    if (!responsesPayload.ok) {
        return {
            type: 'client_error',
            statusCode: responsesPayload.statusCode,
            payload: responsesPayload.payload,
        };
    }

    const result = await requestBufferedImpl(buildTokenImageUpstreamRequest(req, config, responsesPayload.payload));

    if (!isSuccessfulResponsesStatus(result.statusCode)) {
        return {
            type: 'retryable_failure',
            result,
            classification: classifyRetryableResponsesHttpError({
                statusCode: result.statusCode,
                bodyText: result.bodyText,
            }),
        };
    }

    return {
        type: 'token_success',
        result,
    };
}

function recordImageBusinessFailure(manager, config, classification, resultOrError) {
    if (config.type === 'token') {
        manager.markConfigUnavailable(config, classification.reason, {
            lastError: `${classification.retrySource || 'upstream'}:${classification.retryKey || 'error'}`,
            switchReason: 'image_responses_failover',
        });
        warn(`图片 responses 自动切号: #${config.index + 1} ${config.description} (${classification.retrySource || 'upstream'}:${classification.retryKey || 'error'})`);
        return;
    }

    const apiKeyResult = manager.recordApiKeyRequestResult(config, {
        ok: false,
        reason: classification.reason,
        lastError: resultOrError instanceof Error
            ? resultOrError.message
            : `${classification.retrySource || 'upstream'}:${classification.retryKey || 'error'}`,
        switchReason: 'apikey_upstream_failover',
    });

    if (apiKeyResult && apiKeyResult.unavailable) {
        warn(`apikey 图片上游不可用: #${config.index + 1} ${config.description} (${classification.retrySource || 'upstream'}:${classification.retryKey || 'error'}, 最近 ${apiKeyResult.sampleSize} 次失败 ${apiKeyResult.failureCount} 次)`);
    }
}

function recordImageBusinessSuccess(manager, config) {
    if (
        config.type === 'apikey' &&
        manager &&
        typeof manager.recordApiKeyRequestResult === 'function'
    ) {
        manager.recordApiKeyRequestResult(config, { ok: true });
    }
}

function writeImageBusinessSuccess(res, attempt, now) {
    if (attempt.type === 'native_success') {
        writeBufferedUpstreamResponse(res, attempt.result.statusCode, attempt.result.headers, attempt.result.body);
        return;
    }

    const imageResponse = extractImageGenerationResponse(attempt.result.bodyText, {
        created: Math.floor(now() / 1000),
    });
    res.status(200).json(imageResponse);
}

function writeImageBusinessFailure(res, failure) {
    if (failure && failure.result) {
        writeBufferedUpstreamResponse(res, failure.result.statusCode, failure.result.headers, failure.result.body);
        return;
    }

    const statusCode = getGatewayStatusCode(failure && failure.error);
    res.status(statusCode).json({
        error: statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
        message: failure && failure.error ? failure.error.message : '当前没有可用配置',
    });
}

async function handleImageBusinessRequest(req, res, options = {}) {
    const manager = options.accountManager || accountManager;
    const requestBufferedImpl = options.requestBuffered || requestBuffered;
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const incomingUrl = buildIncomingUrl(req);
    const body = await readBufferedRequestBody(req, options.bodyLimitBytes || 1024 * 1024);
    const sessionKey = getRequestSessionKey(req, incomingUrl);
    const getTokenResponsesPayload = options.createTokenPayloadFactory(req, body, options);
    const failedConfigs = [];
    let currentLease = acquireImageBusinessLease(manager, sessionKey);
    let lastFailure = null;

    while (currentLease && currentLease.config) {
        const config = currentLease.config;
        let attempt;

        try {
            attempt = await executeImageBusinessAttempt({
                req,
                incomingUrl,
                config,
                body,
                getTokenResponsesPayload,
                requestBufferedImpl,
            });
        } catch (err) {
            attempt = {
                type: 'retryable_failure',
                error: err,
                classification: {
                    reason: config.type === 'token' ? 'responses_upstream_error' : 'apikey_upstream_error',
                    retryKey: err.message || 'request_error',
                    retrySource: 'request',
                },
            };
        }

        if (attempt.type === 'client_error') {
            currentLease.release();
            res.status(attempt.statusCode).json(attempt.payload);
            return;
        }

        if (attempt.type === 'token_success' || attempt.type === 'native_success') {
            currentLease.release();
            recordImageBusinessSuccess(manager, config);
            writeImageBusinessSuccess(res, attempt, now);
            return;
        }

        recordImageBusinessFailure(manager, config, attempt.classification, attempt.error || attempt.result);
        lastFailure = attempt;
        failedConfigs.push(config);
        currentLease.release();
        currentLease = acquireImageBusinessLease(manager, sessionKey, failedConfigs);
    }

    writeImageBusinessFailure(res, lastFailure);
}

function createImageGenerationsHandler(options = {}) {
    return function imageGenerationsHandler(req, res) {
        return handleImageBusinessRequest(req, res, {
            ...options,
            bodyLimitBytes: 1024 * 1024,
            createTokenPayloadFactory: (_req, body, handlerOptions) => createTokenImageGenerationPayloadFactory(body, handlerOptions),
        }).catch(err => {
            reportBusinessRequestError(res, err, '图片生成请求处理失败');
        });
    };
}

function createImageEditsHandler(options = {}) {
    return function imageEditsHandler(req, res) {
        return handleImageBusinessRequest(req, res, {
            ...options,
            bodyLimitBytes: 32 * 1024 * 1024,
            createTokenPayloadFactory: createTokenImageEditPayloadFactory,
        }).catch(err => {
            reportBusinessRequestError(res, err, '图片编辑请求处理失败');
        });
    };
}

async function handleConfigMutation(res, mutate, reason, successStatus = 200, persistOptions = {}) {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const nextParsed = mutate(parsed);
        await persistAndReloadConfig(nextParsed, reason, persistOptions);
        res.status(successStatus).json({
            ...buildConfigAdminResponse(),
            ...(persistOptions.responseExtras || {})
        });
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? '配置校验失败' : '配置更新失败',
            details: err.message
        });
    }
}

function shutdownServer(reason) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    log(`${reason}，正在关闭服务器...`);
    stopControlWatcher();

    if (accountManager) {
        accountManager.stopQuotaMonitor();
    }

    if (!server) {
        process.exit(0);
        return;
    }

    server.close(closeError => {
        if (closeError) {
            error('关闭服务器失败:', closeError.message);
            process.exit(1);
            return;
        }

        process.exit(0);
    });

    setTimeout(() => {
        for (const socket of activeSockets) {
            socket.destroy();
        }
    }, 5_000).unref();
}

function handleControlFileChange() {
    if (!CONTROL_REQUEST_FILE || !CONTROL_TOKEN || shuttingDown) {
        return;
    }

    let payload;
    try {
        payload = JSON.parse(fs.readFileSync(CONTROL_REQUEST_FILE, 'utf8'));
    } catch (error) {
        return;
    }

    if (!payload || payload.action !== 'stop' || payload.token !== CONTROL_TOKEN) {
        return;
    }

    fs.rmSync(CONTROL_REQUEST_FILE, { force: true });
    shutdownServer('收到本地停止请求');
}

function startControlWatcher() {
    if (!CONTROL_REQUEST_FILE || !CONTROL_TOKEN) {
        return;
    }

    fs.watchFile(CONTROL_REQUEST_FILE, { interval: 250 }, handleControlFileChange);
    handleControlFileChange();
}

function stopControlWatcher() {
    if (!CONTROL_REQUEST_FILE) {
        return;
    }

    fs.unwatchFile(CONTROL_REQUEST_FILE, handleControlFileChange);
}

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

app.get('/config-admin.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'config-admin.js'));
});

app.use('/admin', requireAdminAuthToken);
app.use('/admin/api', express.json({ limit: '1mb' }));

app.get('/admin/configs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'config-admin.html'));
});

app.get('/admin/api/configs', (req, res) => {
    try {
        res.json(buildConfigAdminResponse());
    } catch (err) {
        res.status(500).json({
            error: '读取配置失败',
            details: err.message
        });
    }
});

app.post('/admin/api/configs/refresh', async (req, res) => {
    try {
        res.json(await refreshConfigAdminResponse());
    } catch (err) {
        res.status(500).json({
            error: '刷新额度失败',
            details: err.message
        });
    }
});

app.post('/admin/api/openai/refresh-token', async (req, res) => {
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const refreshToken = typeof body.refresh_token === 'string' && body.refresh_token.trim()
            ? body.refresh_token.trim()
            : typeof body.rt === 'string' ? body.rt.trim() : '';
        const clientId = typeof body.client_id === 'string' ? body.client_id.trim() : '';

        if (!refreshToken) {
            throw new ConfigEditorError('refresh_token is required');
        }

        res.json(await refreshOpenAIToken({
            refreshToken,
            clientId,
            timeoutMs: QUOTA_CHECK_TIMEOUT_MS
        }));
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 502;
        res.status(statusCode).json({
            error: statusCode === 400 ? '参数错误' : 'OpenAI token 刷新失败',
            details: err.message
        });
    }
});

app.post('/admin/api/configs/:index/activate', async (req, res) => {
    try {
        const targetIndex = parseConfigIndex(req.params.index);
        res.json(await activateConfigAdminResponse(targetIndex));
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? '账号切换失败' : '配置更新失败',
            details: err.message
        });
    }
});

app.post('/admin/api/configs/:index/move-up', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => {
            const targetIndex = parseConfigIndex(req.params.index);
            if (targetIndex === 0) {
                throw new ConfigEditorError('第一个配置项已经在最前');
            }

            return moveConfigItem(parsed, targetIndex, 0);
        },
        'admin_move_config',
        200,
        {
            preserveActiveConfig: true,
            skipQuotaRefresh: true
        }
    );
});

app.post('/admin/api/configs/:index/disable', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => {
            const targetIndex = parseConfigIndex(req.params.index);
            return disableConfigItem(parsed, targetIndex, {
                disabledStatus: getConfigRuntimeSummary(targetIndex)
            });
        },
        'admin_disable_config',
        200,
        {
            skipQuotaRefresh: true
        }
    );
});

app.post('/admin/api/configs/batch-disable', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => {
            const indexes = parseBatchIndexes(req.body, '配置项');
            const disabledStatuses = {};

            for (const index of indexes) {
                disabledStatuses[index] = getConfigRuntimeSummary(index);
            }

            return disableConfigItems(parsed, indexes, {
                disabledStatuses
            });
        },
        'admin_batch_disable_config',
        200,
        {
            skipQuotaRefresh: true,
            responseExtras: {
                moved_count: Array.isArray(req.body && req.body.indexes) ? req.body.indexes.length : 0
            }
        }
    );
});

app.post('/admin/api/disabled-configs/:index/enable', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => enableConfigItem(parsed, parseConfigIndex(req.params.index)),
        'admin_enable_config',
        200,
        {
            skipQuotaRefresh: true
        }
    );
});

app.post('/admin/api/disabled-configs/batch-enable', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => enableConfigItems(parsed, parseBatchIndexes(req.body, '停用配置项')),
        'admin_batch_enable_config',
        200,
        {
            skipQuotaRefresh: true,
            responseExtras: {
                moved_count: Array.isArray(req.body && req.body.indexes) ? req.body.indexes.length : 0
            }
        }
    );
});

app.post('/admin/api/configs/:index/refresh-token', async (req, res) => {
    try {
        const targetIndex = parseConfigIndex(req.params.index);
        res.json(await refreshConfigTokenAdminResponse(targetIndex));
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 502;
        res.status(statusCode).json({
            error: statusCode === 400 ? '刷新 token 失败' : 'OpenAI token 刷新失败',
            details: err.message
        });
    }
});

app.post('/admin/api/configs', async (req, res) => {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const rawInput = parseConfigItemJson(req.body && req.body.raw_json);
        const configType = req.body && typeof req.body.config_type === 'string'
            ? req.body.config_type.trim()
            : '';
        const rawItems = Array.isArray(rawInput) ? rawInput : [rawInput];
        if (Array.isArray(rawInput) && configType !== 'token') {
            throw new ConfigEditorError('批量新增只支持 token 模式');
        }

        const now = new Date().toISOString();
        const itemsWithCreatedAt = rawItems.map((rawItem, index) => {
            try {
                const inputItem = configType
                    ? buildImportedConfigItem(configType, rawItem)
                    : buildImportedConfigItem(rawItem);
                return {
                    ...inputItem,
                    created_at: inputItem.created_at || now
                };
            } catch (err) {
                if (rawItems.length > 1) {
                    throw new ConfigEditorError(`第 ${index + 1} 个配置项无效: ${err.message}`);
                }
                throw err;
            }
        });
        const validatedRuntimeConfigs = itemsWithCreatedAt.map((item, index) => {
            try {
                return validateConfigItemBeforeAdd(null, item);
            } catch (err) {
                if (itemsWithCreatedAt.length > 1) {
                    throw new ConfigEditorError(`第 ${index + 1} 个配置项无效: ${err.message}`);
                }
                throw err;
            }
        });
        const nextParsed = itemsWithCreatedAt.reduce(
            (next, item) => addConfigItem(next, item),
            parsed
        );
        await persistAndReloadConfig(nextParsed, 'admin_create', {
            runtimeOverrides: validatedRuntimeConfigs,
            skipQuotaRefresh: true
        });
        res.status(201).json({
            ...buildConfigAdminResponse(),
            added_count: itemsWithCreatedAt.length
        });
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? '配置新增失败' : '配置更新失败',
            details: err.message
        });
    }
});

app.post('/admin/api/apikeys', async (req, res) => {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const generatedApiKey = generateRandomSecret('sk-airouter-');
        const nextParsed = updateConfigSettings(parsed, {
            apikeys: [...getConfiguredApiKeys(parsed), generatedApiKey]
        });

        persistConfigWithoutRuntimeReload(nextParsed);
        res.status(201).json({
            ...buildConfigAdminResponse(),
            generated_apikey: generatedApiKey
        });
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? 'apikey 新增失败' : '配置更新失败',
            details: err.message
        });
    }
});

app.delete('/admin/api/apikeys/batch-delete', async (req, res) => {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const indexes = parseBatchIndexes(req.body, 'apikey');
        const nextParsed = deleteApiKeys(parsed, indexes);

        persistConfigWithoutRuntimeReload(nextParsed);
        res.status(200).json({
            ...buildConfigAdminResponse(),
            deleted_count: indexes.length
        });
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? 'apikey 删除失败' : '配置更新失败',
            details: err.message
        });
    }
});

app.delete('/admin/api/apikeys/:index', async (req, res) => {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const apikeys = getConfiguredApiKeys(parsed);
        const targetIndex = parseConfigIndex(req.params.index);

        if (targetIndex >= apikeys.length) {
            throw new ConfigEditorError('apikey 索引不合法');
        }

        persistConfigWithoutRuntimeReload(updateConfigSettings(parsed, {
            apikeys: apikeys.filter((_, index) => index !== targetIndex)
        }));
        res.status(200).json(buildConfigAdminResponse());
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? 'apikey 删除失败' : '配置更新失败',
            details: err.message
        });
    }
});

app.post('/admin/api/settings', async (req, res) => {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const previousPort = runtimePort;
        const settings = {};
        const body = req.body && typeof req.body === 'object' ? req.body : {};

        for (const field of ['port', 'proxy_port', 'responses']) {
            if (Object.prototype.hasOwnProperty.call(body, field)) {
                settings[field] = body[field];
            }
        }

        const nextParsed = updateConfigSettings(parsed, settings);

        await persistAndReloadConfig(nextParsed, 'admin_update_settings', {
            skipQuotaRefresh: true
        });

        const nextPort = normalizeRuntimePort(nextParsed.port, runtimePort);
        if (nextPort === previousPort) {
            applyProxyEnvironment(nextParsed.proxy_port);
        }

        const responseBody = {
            ...buildConfigAdminResponse(),
            network_settings: {
                applied_immediately: true,
                previous_port: previousPort,
                next_port: nextPort,
                port_changed: nextPort !== previousPort,
                proxy_port: nextParsed.proxy_port ?? null
            }
        };

        res.status(200).json(responseBody);
        if (nextPort !== previousPort) {
            scheduleRuntimeNetworkSettings(nextParsed, previousPort);
        }
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? '配置设置更新失败' : '配置更新失败',
            details: err.message
        });
    }
});

app.post('/admin/api/open-external', async (req, res) => {
    try {
        const url = req.body && req.body.url;
        await openExternalUrl(url);
        res.status(204).end();
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? '链接打开失败' : '系统打开链接失败',
            details: err.message
        });
    }
});

app.post('/admin/api/start-service', (req, res) => {
    try {
        const pid = triggerServiceStart();
        res.status(202).json({
            ok: true,
            pid,
            command: 'npm start'
        });
    } catch (err) {
        res.status(500).json({
            error: '启动服务失败',
            details: err.message
        });
    }
});

app.post('/admin/api/restart-service', (req, res) => {
    try {
        const pid = triggerServiceRestart();
        res.status(202).json({
            ok: true,
            pid,
            command: 'npm restart'
        });
    } catch (err) {
        res.status(500).json({
            error: '重启服务失败',
            details: err.message
        });
    }
});

app.delete('/admin/api/configs/batch-delete', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => deleteConfigItems(parsed, parseBatchIndexes(req.body, '配置项')),
        'admin_batch_delete',
        200,
        {
            skipQuotaRefresh: true,
            responseExtras: {
                deleted_count: Array.isArray(req.body && req.body.indexes) ? req.body.indexes.length : 0
            }
        }
    );
});

app.delete('/admin/api/configs/:index', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => deleteConfigItem(parsed, parseConfigIndex(req.params.index)),
        'admin_delete',
        200,
        {
            skipQuotaRefresh: true
        }
    );
});

app.delete('/admin/api/disabled-configs/batch-delete', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => deleteDisabledConfigItems(parsed, parseBatchIndexes(req.body, '停用配置项')),
        'admin_batch_delete_disabled_config',
        200,
        {
            skipQuotaRefresh: true,
            responseExtras: {
                deleted_count: Array.isArray(req.body && req.body.indexes) ? req.body.indexes.length : 0
            }
        }
    );
});

app.delete('/admin/api/disabled-configs/:index', async (req, res) => {
    await handleConfigMutation(
        res,
        parsed => deleteDisabledConfigItem(parsed, parseConfigIndex(req.params.index)),
        'admin_delete_disabled_config',
        200,
        {
            skipQuotaRefresh: true
        }
    );
});

// 健康检查
app.get('/health', requireConfiguredApiKeys, (req, res) => {
    const currentConfig = accountManager.getActiveConfig();
    const currentAccountStatus = accountManager.getAccountStatus(currentConfig);
    res.json({
        status: 'ok',
        mode: configType,
        timestamp: new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false
        }),
        active_account: serializeAccountStatus(currentAccountStatus),
        configs: {
            total: apiConfigs.length,
            default: currentAccountStatus ? currentAccountStatus.description : null
        }
    });
});

app.post('/v1/messages', requireConfiguredApiKeys, (req, res) => {
    if (!accountManager.getActiveConfig()) {
        return createMissingConfigResponse(res);
    }
    void handleClaudeMessagesRequest(req, res).catch(err => {
        reportBusinessRequestError(res, err, 'Claude Messages 请求处理失败');
    });
});

app.post('/v1/images/generations', requireConfiguredApiKeys, createImageGenerationsHandler());
app.post('/v1/images/edits', requireConfiguredApiKeys, createImageEditsHandler());

// CLIProxyAPI 风格前缀入口
app.post('/cpa/v1/messages', requireConfiguredApiKeys, (req, res) => {
    if (!accountManager.getActiveConfig()) {
        return createMissingConfigResponse(res);
    }
    return forwardCpaClaudeMessagesRequest(req, res);
});
app.use('/cpa/v1', requireConfiguredApiKeys, createCpaHandler());

// 兼容 OpenAI 风格接口
app.use('/v1', requireConfiguredApiKeys, createHandler());

// 兼容 wham 接口
app.use('/wham', requireConfiguredApiKeys, createHandler());

// 404 处理
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        path: req.url
    });
});

app.use((err, req, res, next) => {
    reportBusinessRequestError(res, err);
});

// ==================== 启动服务器 ====================
async function startServer() {
    const loadedConfig = loadApiConfigs();
    applyLoadedConfig(loadedConfig);

    await listenOnPort(runtimePort);
    {
        const localBaseUrl = buildLocalBaseUrl();

        log('='.repeat(70));
        log('OpenAI 兼容代理服务器已启动');
        log('='.repeat(70));
        log(`配置管理: ${localBaseUrl}${buildAdminPath()}`);
        log(`OpenAI 代理: ${localBaseUrl}/v1`);
        log(`Claude Messages 代理: ${localBaseUrl}/v1/messages`);
        log('='.repeat(70));

        void (async () => {
            const currentConfig = await reloadRuntime(loadedConfig, 'startup');
            const currentAccountStatus = accountManager.getAccountStatus(currentConfig);

            log('');
            log('API 配置:');
            log(`  - 模式: ${configType}`);
            log(`  - 账号数量: ${apiConfigs.length}`);
            log(`  - 当前账号: ${currentAccountStatus ? currentAccountStatus.label : '未配置'}`);
            log(`  - 额度轮询: ${hasQuotaMonitoredConfigs(apiConfigs) ? `每 ${QUOTA_CHECK_INTERVAL_MS / 60000} 分钟检查所有 token 账号，每 ${ALL_QUOTA_CHECK_INTERVAL_MS / 60000} 分钟额外全量校正（账号间隔 ${ALL_QUOTA_CHECK_DELAY_MS / 1000} 秒），主额度低于 ${MIN_REMAINING_PERCENT}% 自动标记不可用` : '关闭（无 token 配置项）'}`);
            log(`  - 上游请求超时: ${UPSTREAM_REQUEST_TIMEOUT_MS > 0 ? `${UPSTREAM_REQUEST_TIMEOUT_MS}ms` : '关闭'}`);
            log(`  - quota check 超时: ${hasQuotaMonitoredConfigs(apiConfigs) ? `${QUOTA_CHECK_TIMEOUT_MS}ms` : '关闭（无 token 配置项）'}`);
            log(`  - apikey 恢复探测超时: ${hasRecoverableApiKeyConfigs(apiConfigs) ? `${APIKEY_RECOVERY_TIMEOUT_MS}ms` : '关闭（无 GPT apikey 配置项）'}`);
            log(`  - 入口 apikey 校验: ${hasConfiguredApiKeys(currentParsedConfig) ? `开启（${getConfiguredApiKeys(currentParsedConfig).length} 个）` : '关闭（未配置 apikey）'}`);
            log(`  - 访问日志: ${ACCESS_LOG_ENABLED ? '开启' : '关闭'}${ACCESS_LOG_ENABLED ? '（--access-log）' : '（使用 --access-log 开启）'}`);
            if (hasQuotaMonitoredConfigs(apiConfigs) && apiConfigs.length > 0) {
                log('  - 初始化账号额度:');
                for (const config of apiConfigs) {
                    if (shouldUseQuotaMonitoring(config.type)) {
                        log(`    ${accountManager.getAccountStatus(config).summaryLine}`);
                    }
                }
            }
            if (apiConfigs.length === 0) {
                log('  - 当前没有配置项，请先访问配置管理页新增账号');
            }
            log('');
            log('路由规则:');
            log('  - token 请求按会话 key 使用一致性 hash ring 调度；无会话 key 时按 in-flight 分摊；apikey 不参与并发调度');
            log('  - /v1/messages -> 优先使用 support 包含 claude 的 apikey 原样转发；无可用 claude apikey 时使用 token 或 support 包含 gpt 的 apikey 走 Responses 转换');
            log('  - /v1/images/generations 与 /v1/images/edits -> token 配置项会通过 /backend-api/codex/responses 的 image_generation 工具返回 OpenAI Images JSON');
            log('  - /v1/* -> token 配置项会重写到 /backend-api/codex/*；support 包含 gpt 的 apikey 配置项会直连对应 base_url，并自动补 client_version=1');
            log('  - /wham/* -> token 配置项会重写到 /backend-api/wham/*；apikey 配置项会直连对应 base_url');
        })().catch(err => {
            error('初始化账号信息失败:', err.message);
        });
    }

    startControlWatcher();
}

if (require.main === module) {
    registerProcessSafetyHandlers();

    startServer().catch(err => {
        error('启动失败:', err.message);
        process.exit(1);
    });

    // 优雅关闭
    process.on('SIGINT', () => {
        shutdownServer('收到 SIGINT 信号');
    });

    process.on('SIGTERM', () => {
        shutdownServer('收到 SIGTERM 信号');
    });
}

module.exports = {
    buildProxyHeaders,
    classifyApiKeyUpstreamFailure,
    deleteHeadersCaseInsensitive,
    deleteLocalOnlyHeaders,
    LOCAL_ONLY_AUTH_HEADERS,
    LOCAL_ONLY_HEADER_PREFIXES,
    getGatewayStatusCode,
    createResponseModelObserver,
    defaultContentTypeForProxyResponse,
    extractResponseModelFromPayload,
    isStreamingResponsesRequest,
    isResponsesFailoverInspectionCandidate,
    normalizeProxyJsonBody,
    shouldForceResponsesStoreFalse,
    createImageGenerationsHandler,
    createImageEditsHandler,
    activateConfigAdminResponse,
    openExternalUrl,
    reportBusinessRequestError,
    registerProcessSafetyHandlers,
    refreshConfigAdminResponse,
    serializeAccountStatus,
    selectReloadedActiveConfig,
    refreshConfigTokenAdminResponse,
    startServer,
    triggerServiceCommand,
    triggerServiceRestart,
    triggerServiceStart
};
