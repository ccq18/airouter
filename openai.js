/**
 * OpenAI 兼容接口代理到 ChatGPT Codex backend-api
 */
console.log("starting")
const fs = require('node:fs');
const path = require('path');
const { spawn } = require('node:child_process');
const { inspect } = require('node:util');
const zlib = require('zlib');
const express = require('express');
const { createUpstreamRequest, consumeResponseBody } = require('./app/upstream-request');
const { applyForcedProxyHeaders } = require('./app/proxy-header-overrides');
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
const MIN_REMAINING_PERCENT = 3;
const MIN_WEEKLY_REMAINING_PERCENT = 1;
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

const UPSTREAM_REQUEST_TIMEOUT_MS = parseTimeoutMs('UPSTREAM_REQUEST_TIMEOUT_MS', 5 * 60 * 1000);
const QUOTA_CHECK_TIMEOUT_MS = parseTimeoutMs('QUOTA_CHECK_TIMEOUT_MS', 10 * 1000);

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

function canAttemptResponsesFailover(config, requestUrl, attempt) {
    return Boolean(
        accountManager &&
        config &&
        config.type === 'token' &&
        Number(attempt || 0) < 1 &&
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

    return null;
}

function isResponsesFailoverInspectionCandidate(statusCode, headers) {
    const normalizedStatusCode = Number(statusCode);
    return normalizedStatusCode === 429 ||
        normalizedStatusCode === 401 ||
        normalizedStatusCode === 403 ||
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
    if ([429, 401, 403].includes(Number(statusCode))) {
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

function createClaudeMessagesRequestHandler() {
    return createClaudeMessagesHandler({
        getConfig: () => {
            const config = accountManager.ensureActiveConfig('claude_request', item => configSupportsCapability(item, 'claude')) ||
                accountManager.ensureActiveConfig('claude_request', item => item.type === 'token');

            if (!config) {
                throw new Error(`当前没有可用 support 包含 claude 的 apikey 或 token 配置，请先访问 ${buildAdminPath()} 添加账号`);
            }

            return config;
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
        upstreamModel: process.env.CLAUDE_PROXY_MODEL || claudeCodeConfig.model,
        reasoningEffort: process.env.CLAUDE_PROXY_REASONING_EFFORT || claudeCodeConfig.reasoningEffort,
        clientVersion: process.env.CODEX_CLIENT_VERSION || '0.0.1',
        upstreamRequestTimeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS,
        handleRetryableUpstreamError: (config, classification) => {
            warn(`claude responses 自动切号: #${config.index + 1} ${config.description} (${classification.retrySource}:${classification.retryKey})`);
            return accountManager.markConfigUnavailable(config, classification.reason, {
                lastError: `${classification.retrySource}:${classification.retryKey}`,
                switchReason: 'claude_responses_failover',
            });
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
        quotaCheckIntervalMs: QUOTA_CHECK_INTERVAL_MS,
        minRemainingPercent: MIN_REMAINING_PERCENT,
        minWeeklyRemainingPercent: MIN_WEEKLY_REMAINING_PERCENT,
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
        runtime_summary: accountStatus.runtimeSummary,
        summary_line: accountStatus.summaryLine,
    };
}

function buildConfigAdminResponse() {
    const activeConfig = accountManager ? accountManager.getActiveConfig() : null;
    const activeAccountStatus = accountManager ? accountManager.getAccountStatus(activeConfig) : null;
    const configuredApiKeys = getConfiguredApiKeys(currentParsedConfig);

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
        active_config_index: activeAccountStatus ? activeAccountStatus.index : null,
        configs: currentParsedConfig.configs.map((item, index) => ({
            index,
            item,
            is_active: activeAccountStatus ? activeAccountStatus.index === index : false,
            runtime: apiConfigs[index] ? serializeAccountStatus(accountManager.getAccountStatus(apiConfigs[index])) : null
        }))
    };
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
    let manager = options.accountManager || accountManager;
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

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new ConfigEditorError('配置项 JSON 必须是对象');
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
    if (config.type === 'apikey') {
        if (!parsedUrl.searchParams.has('client_version')) {
            parsedUrl.searchParams.set('client_version', '1');
        }
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

function shouldForceResponsesStoreFalse(config, rewrittenUrl) {
    return Boolean(config && config.type === 'token' && isResponsesPath(rewrittenUrl));
}

function normalizeProxyJsonBody(config, rewrittenUrl, body, responsesOptions) {
    return normalizeResponsesRequestBody(rewrittenUrl, body, {
        ...responsesOptions,
        forceStoreFalse: shouldForceResponsesStoreFalse(config, rewrittenUrl),
    });
}

function prepareFailoverRequest(req, nextConfig, body, originalUrl) {
    req.url = rewriteProxyUrl(originalUrl, nextConfig);
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!Buffer.isBuffer(body) || !contentType.includes('application/json')) {
        return body;
    }

    try {
        const jsonBody = JSON.parse(body.toString('utf8'));
        return Buffer.from(JSON.stringify(normalizeProxyJsonBody(nextConfig, req.url, jsonBody, responsesConfig)));
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

function applyResponseHeaders(res, statusCode, rawHeaders) {
    const headers = normalizeUpstreamResponseHeaders(rawHeaders);

    res.status(statusCode);
    for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
    }

    return {
        statusCode,
        headers
    };
}

function proxyRequest(req, res, config, body, originalUrl, options = {}) {
    const hasBufferedBody = Buffer.isBuffer(body);
    const failoverAttempt = Number(options.failoverAttempt || 0);
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
    const shouldLogQuotaUsage = req.method === 'GET' && isQuotaUsagePath(req.url);
    const responseBodyChunks = [];
    let upstreamResponseHeaders = {};
    let upstreamResponse = null;

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
        const responseMeta = applyResponseHeaders(res, statusCode, rawHeaders);
        upstreamResponseHeaders = responseMeta.headers;
        headersApplied = true;
        res.flushHeaders();

        const writeChunk = chunk => {
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
            handleQuotaUsageResponseComplete();

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
                const gatewayStatusCode = getGatewayStatusCode(err);
                res.status(gatewayStatusCode).json({
                    error: gatewayStatusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
                    message: err.message
                });
                return;
            }

            if (!res.writableEnded) {
                res.end();
            }
        });

        response.resume();
    }

    upstream.responsePromise.then(async response => {
        upstreamResponse = response;
        const statusCode = Number(response.statusCode || 502);
        const apiKeyFailure = classifyApiKeyUpstreamFailure(config, statusCode);
        if (apiKeyFailure) {
            warn(`apikey 上游不可用: #${config.index + 1} ${config.description} (${apiKeyFailure.retrySource}:${apiKeyFailure.retryKey})`);
            const nextConfig = accountManager.markConfigUnavailable(config, apiKeyFailure.reason, {
                lastError: `${apiKeyFailure.retrySource}:${apiKeyFailure.retryKey}`,
                switchReason: 'apikey_upstream_failover',
            });

            if (!requestClosed && Number(failoverAttempt || 0) < 1 && nextConfig && nextConfig !== config) {
                responseFinished = true;
                void drainAbandonedResponse(response);
                const nextBody = prepareFailoverRequest(req, nextConfig, body, originalUrl);
                proxyRequest(req, res, nextConfig, nextBody, originalUrl, {
                    failoverAttempt: failoverAttempt + 1,
                });
                return;
            }
        }

        const shouldInspectResponses = canAttemptResponsesFailover(config, req.url, failoverAttempt)
            && isResponsesFailoverInspectionCandidate(statusCode, response.headers);

        if (shouldInspectResponses) {
            const inspection = await inspectResponsesUpstreamForFailover(response, statusCode, response.headers);

            if (inspection.action === 'retry') {
                warn(`responses 自动切号: #${config.index + 1} ${config.description} (${inspection.classification.retrySource}:${inspection.classification.retryKey})`);
                const nextConfig = accountManager.markConfigUnavailable(config, inspection.classification.reason, {
                    lastError: `${inspection.classification.retrySource}:${inspection.classification.retryKey}`,
                    switchReason: 'responses_failover',
                });

                if (!requestClosed && nextConfig && nextConfig !== config) {
                    responseFinished = true;
                    void drainAbandonedResponse(response);
                    const nextBody = prepareFailoverRequest(req, nextConfig, body, originalUrl);
                    proxyRequest(req, res, nextConfig, nextBody, originalUrl, {
                        failoverAttempt: failoverAttempt + 1,
                    });
                    return;
                }

                if (inspection.forwardMode === 'buffered') {
                    upstreamResponseHeaders = writeBufferedUpstreamResponse(
                        res,
                        statusCode,
                        response.headers,
                        inspection.bodyBuffer || Buffer.alloc(0)
                    ).headers;
                    headersApplied = true;
                    responseFinished = true;
                    return;
                }

                startForwardingResponse(response, statusCode, response.headers, inspection.initialChunks || []);
                return;
            }

            if (inspection.action === 'forward-buffered') {
                upstreamResponseHeaders = writeBufferedUpstreamResponse(
                    res,
                    statusCode,
                    response.headers,
                    inspection.bodyBuffer || Buffer.alloc(0)
                ).headers;
                headersApplied = true;
                responseFinished = true;
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
            warn(`apikey 上游请求失败: #${config.index + 1} ${config.description} (${err.message})`);
            const nextConfig = accountManager.markConfigUnavailable(config, 'apikey_upstream_error', {
                lastError: err.message,
                switchReason: 'apikey_upstream_failover',
            });

            if (!headersApplied && !res.headersSent && Number(failoverAttempt || 0) < 1 && nextConfig && nextConfig !== config) {
                const nextBody = prepareFailoverRequest(req, nextConfig, body, originalUrl);
                proxyRequest(req, res, nextConfig, nextBody, originalUrl, {
                    failoverAttempt: failoverAttempt + 1,
                });
                return;
            }
        }

        if (!headersApplied && !res.headersSent) {
            const statusCode = getGatewayStatusCode(err);
            res.status(statusCode).json({
                error: statusCode === 504 ? 'Gateway Timeout' : 'Bad Gateway',
                message: err.message
            });
            return;
        }

        if (!res.writableEnded) {
            res.end();
        }
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

function createHandler(proxyPath = '') {
    return function handler(req, res) {
        const isOpenAiConfig = item => item.type === 'token' || configSupportsCapability(item, 'gpt');
        const config = accountManager.getActiveConfig(isOpenAiConfig) ||
            accountManager.ensureActiveConfig('proxy_request', isOpenAiConfig);
        if (!config) {
            return createMissingConfigResponse(res);
        }
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
                        const normalizedBody = normalizeProxyJsonBody(config, req.url, jsonBody, responsesConfig);
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

async function handleConfigMutation(res, mutate, reason, successStatus = 200, persistOptions = {}) {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const nextParsed = mutate(parsed);
        await persistAndReloadConfig(nextParsed, reason, persistOptions);
        res.status(successStatus).json(buildConfigAdminResponse());
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
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const targetIndex = parseConfigIndex(req.params.index);
        if (targetIndex === 0) {
            throw new ConfigEditorError('第一个配置项已经在最前');
        }

        const nextParsed = moveConfigItem(parsed, targetIndex, 0);
        await persistAndReloadConfig(nextParsed, 'admin_move_config', {
            skipQuotaRefresh: true
        });
        accountManager.activateConfig(0, 'admin_move_config');
        res.status(200).json(buildConfigAdminResponse());
    } catch (err) {
        const statusCode = err instanceof ConfigEditorError ? 400 : 500;
        res.status(statusCode).json({
            error: statusCode === 400 ? '配置置顶失败' : '配置更新失败',
            details: err.message
        });
    }
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
        const rawItem = parseConfigItemJson(req.body && req.body.raw_json);
        const configType = req.body && typeof req.body.config_type === 'string'
            ? req.body.config_type.trim()
            : '';
        const inputItem = configType
            ? buildImportedConfigItem(configType, rawItem)
            : buildImportedConfigItem(rawItem);
        const itemWithCreatedAt = {
            ...inputItem,
            created_at: inputItem.created_at || new Date().toISOString()
        };
        const validatedRuntimeConfig = await validateConfigItemBeforeAdd(null, itemWithCreatedAt);
        const nextParsed = addConfigItem(parsed, itemWithCreatedAt);
        await persistAndReloadConfig(nextParsed, 'admin_create', {
            runtimeOverrides: [validatedRuntimeConfig],
            skipQuotaRefresh: true
        });
        res.status(201).json(buildConfigAdminResponse());
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
            log(`  - 额度轮询: ${hasQuotaMonitoredConfigs(apiConfigs) ? `每 ${QUOTA_CHECK_INTERVAL_MS / 60000} 分钟检查所有 token 账号，主额度低于 ${MIN_REMAINING_PERCENT}% 或周额度不高于 ${MIN_WEEKLY_REMAINING_PERCENT}% 自动标记不可用` : '关闭（无 token 配置项）'}`);
            log(`  - 上游请求超时: ${UPSTREAM_REQUEST_TIMEOUT_MS > 0 ? `${UPSTREAM_REQUEST_TIMEOUT_MS}ms` : '关闭'}`);
            log(`  - quota check 超时: ${hasQuotaMonitoredConfigs(apiConfigs) ? `${QUOTA_CHECK_TIMEOUT_MS}ms` : '关闭（无 token 配置项）'}`);
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
            log('  - 可用配置按管理页顺序选择；可通过置顶调整优先级');
            log('  - /v1/messages -> 优先使用 support 包含 claude 的 apikey 原样转发；无可用 claude apikey 时使用 token -> /backend-api/codex/responses (Claude compatibility)');
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
    isResponsesFailoverInspectionCandidate,
    normalizeProxyJsonBody,
    shouldForceResponsesStoreFalse,
    activateConfigAdminResponse,
    openExternalUrl,
    reportBusinessRequestError,
    registerProcessSafetyHandlers,
    refreshConfigAdminResponse,
    selectReloadedActiveConfig,
    refreshConfigTokenAdminResponse,
    startServer,
    triggerServiceCommand,
    triggerServiceRestart,
    triggerServiceStart
};
