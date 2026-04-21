/**
 * OpenAI 兼容接口代理到 ChatGPT Codex backend-api
 */
console.log("starting")
const fs = require('node:fs');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const { createUpstreamRequest } = require('./app/upstream-request');
const { applyForcedProxyHeaders } = require('./app/proxy-header-overrides');
const { normalizeResponsesRequestBody } = require('./app/responses-defaults');
const { createClaudeMessagesHandler } = require('./app/claude-messages-handler');
const { createAccountManager } = require('./app/account-manager');
const {
    resolveClaudeCodeOptions,
    createRuntimeConfigs,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
} = require('./app/openai-config');
const {
    ConfigEditorError,
    addConfigItem,
    buildImportedConfigItem,
    deleteConfigItem,
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
const PORT = process.env.PORT || 3009;
let CONFIG_FILE_NAME = process.env.CONFIG || 'openai.json';
const CONFIG_FILE = path.join(__dirname, CONFIG_FILE_NAME);
const CONTROL_TOKEN = process.env.AIROUTER_CONTROL_TOKEN || '';
const CONTROL_REQUEST_FILE = process.env.AIROUTER_CONTROL_REQUEST_FILE || '';
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
        type: parsed.type,
        configs: createRuntimeConfigs(parsed),
        claudeCode: resolveClaudeCodeOptions(parsed)
    };
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
    return buildLoadedConfig(finalParsed);
}

let currentParsedConfig = null;
let configType = null;
let apiConfigs = [];
let claudeCodeConfig = resolveClaudeCodeOptions({
    type: 'token',
    configs: [{}]
});
let accountManager = null;
let handleClaudeMessagesRequest = null;
let server = null;
let shuttingDown = false;
const activeSockets = new Set();

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

function buildLocalBaseUrl() {
    return `http://localhost:${PORT}`;
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

function getGatewayStatusCode(err) {
    return err && err.code === 'ETIMEDOUT' ? 504 : 502;
}

function createClaudeMessagesRequestHandler() {
    return createClaudeMessagesHandler({
        getConfig: () => {
            const config = accountManager.getActiveConfig();

            if (!config) {
                throw new Error(`当前没有可用配置，请先访问 ${buildAdminPath()} 添加账号`);
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
        upstreamModel: process.env.CLAUDE_PROXY_MODEL || claudeCodeConfig.model,
        reasoningEffort: process.env.CLAUDE_PROXY_REASONING_EFFORT || claudeCodeConfig.reasoningEffort,
        clientVersion: process.env.CODEX_CLIENT_VERSION || '0.0.1',
        upstreamRequestTimeoutMs: UPSTREAM_REQUEST_TIMEOUT_MS
    });
}

function applyLoadedConfig(loadedConfig) {
    currentParsedConfig = loadedConfig.parsed;
    configType = loadedConfig.type;
    apiConfigs = loadedConfig.configs;
    claudeCodeConfig = loadedConfig.claudeCode;

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
        buildAuthHeadersForConfig,
        shouldUseQuotaMonitoring,
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

    if (shouldUseQuotaMonitoring(configType) && !options.skipQuotaRefresh) {
        await accountManager.refreshQuotas(reason);
    }

    const currentConfig = accountManager.ensureActiveConfig(reason);
    accountManager.startQuotaMonitor();
    return currentConfig;
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
        runtime_port: Number(PORT),
        file_port: currentParsedConfig.port ?? null,
        proxy_port: currentParsedConfig.proxy_port ?? null,
        apikeys: configuredApiKeys,
        apikey_required: configuredApiKeys.length > 0,
        claude_code: currentParsedConfig.claude_code ?? null,
        active_config_index: activeAccountStatus ? activeAccountStatus.index : null,
        configs: currentParsedConfig.configs.map((item, index) => ({
            index,
            item,
            is_active: activeAccountStatus ? activeAccountStatus.index === index : false,
            runtime: apiConfigs[index] ? serializeAccountStatus(accountManager.getAccountStatus(apiConfigs[index])) : null
        }))
    };
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
            type,
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

function proxyRequest(req, res, config, body, originalUrl) {
    const hasBufferedBody = Buffer.isBuffer(body);
    const headers = buildProxyHeaders(req.headers, config, hasBufferedBody ? body.length : undefined);
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

    upstream.responsePromise.then(response => {
        upstreamResponse = response;
        const statusCode = Number(response.statusCode || 502);
        const responseMeta = applyResponseHeaders(res, statusCode, response.headers);
        upstreamResponseHeaders = responseMeta.headers;
        headersApplied = true;
        res.flushHeaders();

        response.on('data', chunk => {
            if (shouldLogQuotaUsage) {
                responseBodyChunks.push(chunk);
            }
            res.write(chunk);
        });

        response.on('end', () => {
            responseFinished = true;

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

        response.on('error', err => {
            if (requestClosed) {
                return;
            }

            error('代理请求失败:', err.message);
            if (!res.headersSent) {
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
    }).catch(err => {
        if (requestClosed) {
            return;
        }

        error('代理请求失败:', err.message);
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
        const config = accountManager.getActiveConfig();
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

app.post('/admin/api/configs', async (req, res) => {
    try {
        const parsed = readParsedConfigFile(CONFIG_FILE);
        const rawItem = parseConfigItemJson(req.body && req.body.raw_json);
        const inputItem = buildImportedConfigItem(parsed.type, rawItem);
        const validatedRuntimeConfig = await validateConfigItemBeforeAdd(parsed.type, inputItem);
        const nextParsed = addConfigItem(parsed, inputItem);
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

// Claude Messages 兼容接口
app.post('/claude/v1/messages', requireConfiguredApiKeys, (req, res) => {
    if (!accountManager.getActiveConfig()) {
        return createMissingConfigResponse(res);
    }
    void handleClaudeMessagesRequest(req, res);
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

// ==================== 启动服务器 ====================
async function startServer() {
    const loadedConfig = loadApiConfigs();
    applyLoadedConfig(loadedConfig);

    server = app.listen(PORT, () => {
        const localBaseUrl = buildLocalBaseUrl();

        log('='.repeat(70));
        log('OpenAI 兼容代理服务器已启动');
        log('='.repeat(70));
        log(`配置管理: ${localBaseUrl}${buildAdminPath()}`);
        log(`OpenAI 代理: ${localBaseUrl}/v1`);
        log(`Claude 代理: ${localBaseUrl}/claude`);
        log('='.repeat(70));

        void (async () => {
            const currentConfig = await reloadRuntime(loadedConfig, 'startup');
            const currentAccountStatus = accountManager.getAccountStatus(currentConfig);

            log('');
            log('API 配置:');
            log(`  - 模式: ${configType}`);
            log(`  - 账号数量: ${apiConfigs.length}`);
            log(`  - 当前账号: ${currentAccountStatus ? currentAccountStatus.label : '未配置'}`);
            log(`  - 额度轮询: ${shouldUseQuotaMonitoring(configType) ? `每 ${QUOTA_CHECK_INTERVAL_MS / 60000} 分钟检查一次，剩余低于 ${MIN_REMAINING_PERCENT}% 自动切号` : '关闭（api_key 模式）'}`);
            log(`  - 上游请求超时: ${UPSTREAM_REQUEST_TIMEOUT_MS > 0 ? `${UPSTREAM_REQUEST_TIMEOUT_MS}ms` : '关闭'}`);
            log(`  - quota check 超时: ${shouldUseQuotaMonitoring(configType) ? `${QUOTA_CHECK_TIMEOUT_MS}ms` : '关闭（api_key 模式）'}`);
            log(`  - 入口 apikey 校验: ${hasConfiguredApiKeys(currentParsedConfig) ? `开启（${getConfiguredApiKeys(currentParsedConfig).length} 个）` : '关闭（未配置 apikey）'}`);
            log(`  - 访问日志: ${ACCESS_LOG_ENABLED ? '开启' : '关闭'}${ACCESS_LOG_ENABLED ? '（--access-log）' : '（使用 --access-log 开启）'}`);
            if (shouldUseQuotaMonitoring(configType) && apiConfigs.length > 0) {
                log('  - 初始化账号额度:');
                for (const config of apiConfigs) {
                    log(`    ${accountManager.getAccountStatus(config).summaryLine}`);
                }
            }
            if (apiConfigs.length === 0) {
                log('  - 当前没有配置项，请先访问配置管理页新增账号');
            }
            log('');
            log('路由规则:');
            log(`  - /claude/v1/messages -> ${configType === 'token' ? '/backend-api/codex/responses (Claude compatibility)' : '当前模式不支持，需切换到 token 模式'}`);
            log('  - /v1/responses -> /backend-api/codex/responses');
            log('  - /v1/models -> /backend-api/codex/models');
            log('  - /wham/* -> /backend-api/wham/*');
        })().catch(err => {
            error('初始化账号信息失败:', err.message);
        });
    });

    server.on('connection', socket => {
        activeSockets.add(socket);
        socket.on('close', () => {
            activeSockets.delete(socket);
        });
    });

    startControlWatcher();
}

if (require.main === module) {
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
    deleteHeadersCaseInsensitive,
    deleteLocalOnlyHeaders,
    LOCAL_ONLY_AUTH_HEADERS,
    LOCAL_ONLY_HEADER_PREFIXES,
    getGatewayStatusCode,
    startServer
};
