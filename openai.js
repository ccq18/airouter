/** Airouter: account model catalogs and ordered, quota-aware model routes. */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { createUpstreamRequest, requestBuffered } = require('./app/upstream-request');
const { readRequestBody } = require('./app/request-body');
const { createRuntimeConfigs } = require('./app/openai-config');
const {
  ConfigEditorError, addConfigItems, buildImportedConfigItem, getConfigById,
  updateConfigItemById, deleteConfigItemById, readParsedConfigFile,
  updateConfigSettings, updateRoutingModels, writeParsedConfigFile,
} = require('./app/config-editor');
const { ensureConfigIds, parseRoutingConfig, getPublicModelIds, getRoutingRevision, validateConfigModels } = require('./app/routing-config');
const { listProviderPresets, getProviderPreset, normalizeSub2ApiBaseUrl, buildDiscoveryRequest, parseModelCatalog, diffModelCatalog } = require('./app/provider-presets');
const { createQuotaEngine } = require('./app/quota-engine');
const { credentialContextInvalidations } = require('./app/credential-context');
const { createModelRouter, createRoutingHealthStore, createRoutingContextStore } = require('./app/model-router');
const { createExplicitRoutingHandler } = require('./app/explicit-routing-handler');
const { createRouteTestHandler } = require('./app/route-testing');
const { createFreePoolEngine } = require('./app/free-pool-engine');
const { isFreePool, normalizePoolOptions, credentialSource, FREE_MODEL } = require('./app/free-pool-config');
const { refreshOpenAIToken } = require('./app/openai-token-refresh');
const { createSub2ApiAgentIdentityManager, isSub2ApiConfig } = require('./app/sub2api-agent-identity');
const { generateRandomSecret, getConfiguredApiKeys, extractRequestApiKey, isAuthorizedRequest, isAuthorizedAdminRequest, sha256Hex } = require('./app/request-auth');

const CONFIG_FILE_NAME = process.env.CONFIG || 'config.json';
const CONFIG_FILE = path.isAbsolute(CONFIG_FILE_NAME) ? CONFIG_FILE_NAME : path.join(__dirname, CONFIG_FILE_NAME);
const BIND_HOST = process.env.AIROUTER_BIND_HOST || undefined;
const QUOTA_TIMEOUT = positiveNumber(process.env.QUOTA_CHECK_TIMEOUT_MS, 10000);
const REQUEST_TIMEOUT = positiveNumber(process.env.UPSTREAM_TOTAL_TIMEOUT_MS, 600000);
const BODY_LIMIT = positiveNumber(process.env.JSON_REQUEST_BODY_LIMIT_BYTES, 16 * 1024 * 1024);
const CONTROL_FILE = process.env.AIROUTER_CONTROL_REQUEST_FILE || '';
const CONTROL_TOKEN = process.env.AIROUTER_CONTROL_TOKEN || '';
const PROXY_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];
const ORIGINAL_PROXY_ENV = Object.fromEntries(PROXY_KEYS.map(key => [key, process.env[key]]));
const PROTOCOLS = ['chat_completions', 'responses', 'messages'];
const app = express();
let parsedConfig = null;
let runtimeConfigs = [];
let modelRouter = null;
let server = null;
let stopping = false;
let mutationQueue = Promise.resolve();
const refreshes = new Map();
const log = (...args) => console.log(...args);
const warn = (...args) => console.warn(...args);
const quotaEngine = createQuotaEngine({ timeoutMs: QUOTA_TIMEOUT, log, warn });
const healthStore = createRoutingHealthStore();
const contextStore = createRoutingContextStore();
const poolEngine = createFreePoolEngine({
  getParsedConfig: () => parsedConfig || { configs: [] }, healthStore,
  cacheFile: `${CONFIG_FILE}.pools-cache.json`,
  modelsDevUrl: process.env.FREE_POOL_MODELS_METADATA_URL,
  timeoutMs: QUOTA_TIMEOUT, warn,
});

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function effectivePort(config) {
  const value = Number(config.port || process.env.PORT || 3009);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new ConfigEditorError('端口必须在 1-65535 之间');
  return value;
}

function applyProxyEnvironment(config) {
  for (const key of PROXY_KEYS) {
    if (ORIGINAL_PROXY_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_PROXY_ENV[key];
  }
  if (!config.proxy_port) return;
  const proxy = `http://127.0.0.1:${config.proxy_port}`;
  for (const key of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY']) process.env[key] = proxy;
}

function applyConfig(config) {
  const runtimes = createRuntimeConfigs(config);
  parseRoutingConfig(config);
  const invalidated = credentialContextInvalidations(parsedConfig?.configs || [], config.configs, quotaEngine.syncConfigs(config.configs));
  parsedConfig = config;
  runtimeConfigs = runtimes;
  for (const id of invalidated) {
    healthStore.forget(id);
    contextStore.forgetConfig(id);
  }
  contextStore.syncRoutes(config);
  applyProxyEnvironment(config);
  poolEngine.syncConfigs();
  if (server) for (const item of config.configs.filter(isFreePool)) {
    if (poolEngine.serialize(item).last_attempt_at == null) void poolEngine.refresh(item.id);
  }
  modelRouter = createModelRouter({
    getParsedConfig: () => parsedConfig, getRuntimeConfigs: () => runtimeConfigs,
    quotaEngine, healthStore, poolEngine,
  });
}

function loadConfig() {
  const config = readParsedConfigFile(CONFIG_FILE);
  const ensured = ensureConfigIds(config);
  const next = ensured.parsed;
  let changed = ensured.changed;
  if (!next.auth_token) { next.auth_token = generateRandomSecret('admin-'); changed = true; }
  if (!Object.hasOwn(next, 'apikeys')) { next.apikeys = [generateRandomSecret('sk-airouter-')]; changed = true; }
  if (!next.routing) { next.routing = { models: [] }; changed = true; }
  if (changed) writeParsedConfigFile(CONFIG_FILE, next);
  applyConfig(next);
}

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const listener = app.listen(port, BIND_HOST, () => { listener.off('error', reject); resolve(listener); });
    listener.once('error', reject);
  });
}

// Serialize all persistent mutations; revision checks therefore happen against
// the state actually being saved, not a stale snapshot before an async wait.
function mutateConfig(mutator) {
  const result = mutationQueue.then(async () => {
    const previous = parsedConfig;
    const next = await mutator(structuredClone(previous));
    createRuntimeConfigs(next);
    parseRoutingConfig(next);
    const nextPort = effectivePort(next);
    let replacement = null;
    if (server && nextPort !== effectivePort(previous)) replacement = await listenOnPort(nextPort);
    try {
      const saved = writeParsedConfigFile(CONFIG_FILE, next);
      applyConfig(saved);
      if (replacement) { const old = server; server = replacement; old.close(); }
      return saved;
    } catch (error) {
      if (replacement) replacement.close();
      throw error;
    }
  });
  mutationQueue = result.catch(() => {});
  return result;
}

const identityManager = createSub2ApiAgentIdentityManager({
  requestBufferedFn: requestBuffered,
  persistTaskFn: async ({ config, taskId, expectedTaskId }) => {
    let persistedTask = taskId;
    await mutateConfig(next => {
      const item = getConfigById(next, config.id);
      if (!item || !isSub2ApiConfig(item) || item.credentials.agent_runtime_id !== config.credentials.agent_runtime_id ||
          item.credentials.chatgpt_account_id !== config.credentials.chatgpt_account_id) throw new ConfigEditorError('账号身份已变化');
      if (item.credentials.task_id && item.credentials.task_id !== expectedTaskId) persistedTask = item.credentials.task_id;
      else item.credentials.task_id = taskId;
      return next;
    });
    return persistedTask;
  },
});

async function refreshUpstreamAuth(config) {
  if (!config || !config.id) return false;
  const refreshKey = `${config.id}:${sha256Hex(JSON.stringify([config.refresh_token || '', config.credentials || null]))}`;
  if (refreshes.has(refreshKey)) return refreshes.get(refreshKey);
  const operation = (async () => {
    if (isSub2ApiConfig(config)) {
      await identityManager.recoverTask(config, config.credentials?.task_id || '');
      return true;
    }
    if (config.type !== 'token' || !config.refresh_token) return false;
    const originalRefresh = config.refresh_token;
    const refreshed = await refreshOpenAIToken({ refreshToken: originalRefresh, clientId: config.client_id, timeoutMs: QUOTA_TIMEOUT });
    await mutateConfig(next => {
      const item = getConfigById(next, config.id);
      if (!item || item.refresh_token !== originalRefresh) throw new ConfigEditorError('账号凭证已变化，请重试');
      item.access_token = refreshed.access_token;
      item.refresh_token = refreshed.refresh_token || originalRefresh;
      return next;
    });
    Object.assign(config, { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token || originalRefresh });
    return true;
  })().finally(() => { if (refreshes.get(refreshKey) === operation) refreshes.delete(refreshKey); });
  refreshes.set(refreshKey, operation);
  return operation;
}

function requireApiKey(req, res, next) {
  if (!isAuthorizedRequest(req.headers, getConfiguredApiKeys(parsedConfig))) {
    res.status(401).json({ error: { code: 'invalid_api_key', message: '入口 API Key 校验失败' } });
    return;
  }
  next();
}

function requireAdmin(req, res, next) {
  const token = typeof req.query.auth_token === 'string' ? req.query.auth_token : extractRequestApiKey(req.headers);
  if (!isAuthorizedAdminRequest(token, parsedConfig?.auth_token)) {
    res.status(401).json({ error: { code: 'unauthorized', message: '管理凭证校验失败' } });
    return;
  }
  next();
}

function api(handler) {
  return (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
}

function reject(status, code, message) {
  const error = new ConfigEditorError(message); error.status = status; error.code = code; throw error;
}

function settingsView() {
  return { apikeys: getConfiguredApiKeys(parsedConfig), port: effectivePort(parsedConfig), proxy_port: parsedConfig.proxy_port || null };
}

function upstreamView(item) {
  return {
    id: item.id, type: item.type, preset: item.preset,
    description: item.description || '', enabled: item.enabled !== false,
    base_url: isFreePool(item) ? runtimeConfigs.find(runtime => runtime.id === item.id)?.baseUrl || '' : item.base_url || '', models: item.models || [], models_endpoint: item.models_endpoint || null,
    protocol_paths: item.protocol_paths || null,
    has_credentials: Boolean(runtimeConfigs.find(runtime => runtime.id === item.id)?.apiKey || item.access_token || item.credentials),
    credential_ref: item.credential_ref || null,
    ...(isFreePool(item) ? { pool: normalizePoolOptions(item.pool), pool_status: poolEngine.serialize(item) } : {}),
    has_refresh_token: Boolean(item.refresh_token), quota: isFreePool(item) ? null : quotaEngine.serialize(item),
    route_references: parseRoutingConfig(parsedConfig).models.filter(route => route.targets.some(target => target.config_id === item.id)).map(route => route.id),
  };
}

function upstreamsView() {
  return { revision: getRoutingRevision(parsedConfig), presets: listProviderPresets(), configs: parsedConfig.configs.map(upstreamView) };
}

function routesView() {
  const routing = parseRoutingConfig(parsedConfig);
  const routeStatus = {};
  for (const model of routing.models) {
    routeStatus[model.id] = Object.fromEntries(PROTOCOLS.map(protocol => [protocol, modelRouter.describeRoute(model, protocol)]));
  }
  return { revision: getRoutingRevision(parsedConfig), max_attempts: routing.max_attempts, models: routing.models,
    route_status: routeStatus, configs: parsedConfig.configs.map(item => ({ id: item.id, description: item.description, enabled: item.enabled !== false, preset: item.preset, models: item.models || [] })),
    presets: listProviderPresets(), public_model_ids: getPublicModelIds(parsedConfig) };
}

function withPreset(item) {
  const preset = getProviderPreset(item.preset);
  if (!preset) throw new ConfigEditorError('请选择有效的平台');
  const result = { ...item, type: preset.default_type, base_url: item.base_url || preset.default_base_url,
    models: validateConfigModels(item.models === undefined ? undefined : item.models, { preset: preset.id }) };
  if (preset.id === 'sub2api') {
    try { result.base_url = normalizeSub2ApiBaseUrl(result.base_url); } catch (error) { throw new ConfigEditorError(error.message); }
  }
  if (isFreePool(result)) {
    result.pool = normalizePoolOptions(item.pool);
    if (result.credential_ref) delete result.apikey;
    for (const key of ['models_endpoint', 'quota_url', 'protocol_paths']) delete result[key];
  } else { delete result.pool; delete result.credential_ref; }
  return result;
}

async function discoverModels(config) {
  if (isFreePool(config)) throw new ConfigEditorError('免费池自动维护内部目录，请在池详情中同步');
  const request = buildDiscoveryRequest(config);
  const result = await requestBuffered({ method: 'GET', targetUrl: request.url, headers: { ...request.headers, accept: 'application/json' }, timeoutMs: QUOTA_TIMEOUT, maxRedirects: 2 });
  if (result.statusCode < 200 || result.statusCode >= 300) throw new ConfigEditorError(`模型列表读取失败: HTTP ${result.statusCode}`);
  const discovered = parseModelCatalog(JSON.parse(result.bodyText), config);
  return { config_id: config.id, source_url: request.url, ...diffModelCatalog(config.models, discovered) };
}

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || 'authorization,content-type,x-api-key,x-opencode-session');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
for (const file of ['config-admin.js', 'config-admin-routing.js']) app.get(`/${file}`, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
app.use('/admin', requireAdmin);
app.use('/admin/api', express.json({ limit: '1mb' }));
app.get(['/admin/configs', '/admin/configs/upstreams', '/admin/configs/routes'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'config-admin.html')));

app.get('/admin/api/settings', (req, res) => res.json(settingsView()));
app.post('/admin/api/settings', api(async (req, res) => {
  const body = req.body || {};
  if (Object.keys(body).some(key => !['port', 'proxy_port'].includes(key))) throw new ConfigEditorError('设置仅支持 port 和 proxy_port');
  await mutateConfig(next => updateConfigSettings(next, body));
  res.json(settingsView());
}));
app.post('/admin/api/apikeys', api(async (req, res) => {
  await mutateConfig(next => ({ ...next, apikeys: [...getConfiguredApiKeys(next), generateRandomSecret('sk-airouter-')] }));
  res.status(201).json(settingsView());
}));
app.delete('/admin/api/apikeys/:index', api(async (req, res) => {
  await mutateConfig(next => {
    const index = Number(req.params.index);
    if (!Number.isInteger(index) || index < 0 || index >= next.apikeys.length) throw new ConfigEditorError('入口密钥不存在');
    next.apikeys.splice(index, 1); return next;
  });
  res.json(settingsView());
}));

app.get('/admin/api/upstreams', (req, res) => res.json(upstreamsView()));
app.post('/admin/api/upstreams', api(async (req, res) => {
  let addedId;
  await mutateConfig(next => { const updated = addConfigItems(next, [withPreset(req.body || {})]); addedId = updated.configs.at(-1).id; return updated; });
  res.status(201).json({ ...upstreamsView(), added_id: addedId });
}));
app.post('/admin/api/upstreams/import', api(async (req, res) => {
  const raw = JSON.parse(req.body?.raw_json || '{}');
  const entries = Array.isArray(raw) ? raw : [raw];
  if (!entries.length) throw new ConfigEditorError('请选择至少一个登录态');
  const imported = entries.map(item => ({ ...buildImportedConfigItem('token', item), preset: 'chatgpt', models: [] }));
  let addedIds;
  await mutateConfig(next => { const updated = addConfigItems(next, imported); addedIds = updated.configs.slice(-imported.length).map(item => item.id); return updated; });
  res.status(201).json({ ...upstreamsView(), added_ids: addedIds });
}));
app.put('/admin/api/upstreams/:id', api(async (req, res) => {
  await mutateConfig(next => {
    const existing = getConfigById(next, req.params.id);
    if (!existing) reject(404, 'upstream_not_found', '上游账号不存在');
    const patch = { ...(req.body || {}) };
    for (const field of ['apikey', 'access_token', 'refresh_token']) if (!patch[field]) delete patch[field];
    const merged = withPreset({ ...existing, ...patch, id: existing.id });
    for (const route of parseRoutingConfig(next).models) {
      if (route.targets.some(target => target.config_id === existing.id &&
          !merged.models.some(model => model.id === target.model))) {
        reject(400, 'model_referenced', `模型仍被路由 ${route.id} 引用`);
      }
    }
    return updateConfigItemById(next, existing.id, merged);
  });
  res.json(upstreamsView());
}));
app.delete('/admin/api/upstreams/:id', api(async (req, res) => {
  await mutateConfig(next => {
    if (!getConfigById(next, req.params.id)) reject(404, 'upstream_not_found', '上游账号不存在');
    if (parseRoutingConfig(next).models.some(model => model.targets.some(target => target.config_id === req.params.id))) reject(409, 'upstream_referenced', '账号仍被模型路由引用');
    return deleteConfigItemById(next, req.params.id);
  });
  res.json(upstreamsView());
}));
app.post('/admin/api/upstreams/models/discover', api(async (req, res) => {
  const body = req.body || {};
  const saved = body.config_id ? getConfigById(parsedConfig, body.config_id) : null;
  if (body.config_id && !saved) reject(404, 'upstream_not_found', '上游账号不存在');
  const draft = withPreset({ ...saved, ...body });
  if (!body.apikey && saved) draft.apikey = saved.apikey;
  if (!saved && !draft.apikey) throw new ConfigEditorError('同步前请填写转发凭证');
  res.json(await discoverModels(draft));
}));
app.post('/admin/api/upstreams/:id/models/discover', api(async (req, res) => {
  const item = getConfigById(parsedConfig, req.params.id);
  if (!item) reject(404, 'upstream_not_found', '上游账号不存在');
  res.json(await discoverModels(item));
}));
app.post('/admin/api/upstreams/:id/pool-refresh', api(async (req, res) => {
  const item = getConfigById(parsedConfig, req.params.id);
  if (!item) reject(404, 'upstream_not_found', '上游账号不存在');
  if (!isFreePool(item)) reject(400, 'not_a_pool', '该账号不是免费池');
  await poolEngine.refresh(item.id);
  const current = getConfigById(parsedConfig, req.params.id);
  if (!current) reject(404, 'upstream_not_found', '上游账号已删除');
  res.json({ pool_status: poolEngine.serialize(current), upstream: upstreamView(current) });
}));
app.post('/admin/api/upstreams/:id/quota-refresh', api(async (req, res) => {
  const item = getConfigById(parsedConfig, req.params.id);
  if (!item) reject(404, 'upstream_not_found', '上游账号不存在');
  await quotaEngine.refresh(item, { force: true });
  const current = getConfigById(parsedConfig, req.params.id);
  if (!current) reject(404, 'upstream_not_found', '上游账号已删除');
  res.json({ config_id: current.id, quota: quotaEngine.serialize(current), upstream: upstreamView(current) });
}));
app.get('/admin/api/model-routes', (req, res) => res.json(routesView()));
app.put('/admin/api/model-routes', api(async (req, res) => {
  const body = req.body || {};
  await mutateConfig(next => {
    if (body.revision && body.revision !== getRoutingRevision(next)) reject(409, 'revision_conflict', '模型路由已修改，请刷新后重试');
    return updateRoutingModels(next, body.models, { maxAttempts: body.max_attempts });
  });
  res.json(routesView());
}));

app.get('/health', requireApiKey, (req, res) => res.json({ status: 'ok', configs: { total: runtimeConfigs.length }, models: getPublicModelIds(parsedConfig) }));
app.get('/v1/models', requireApiKey, (req, res) => res.json({ object: 'list', data: getPublicModelIds(parsedConfig).map(id => ({ id, object: 'model', created: 0, owned_by: 'airouter' })) }));
function forwardingOptions() {
  return {
    getRouter: () => modelRouter, getQuotaEngine: () => quotaEngine,
    getContextStore: () => contextStore, readRequestBody, createUpstreamRequest,
    upstreamTimeoutMs: REQUEST_TIMEOUT, bodyLimitBytes: BODY_LIMIT,
    idleTimeoutMs: positiveNumber(process.env.REQUEST_BODY_IDLE_TIMEOUT_MS, 30000),
    clientVersion: process.env.CODEX_CLIENT_VERSION || '0.0.1',
    prepareUpstreamConfig: config => identityManager.ensureTask(config), refreshUpstreamAuth,
    getAuthIdentityHash: req => sha256Hex(extractRequestApiKey(req.headers) || ''),
    getSessionKey: (req, body) => req.headers['x-opencode-session'] || req.headers['x-airouter-session-id'] || req.headers.session_id || body.session_id || body.prompt_cache_key || '',
    log, error: warn,
  };
}
app.post('/admin/api/model-routes/test', api(createRouteTestHandler({
  getParsedConfig: () => parsedConfig, getRuntimeConfigs: () => runtimeConfigs,
  getRouter: () => modelRouter, getForwardingOptions: forwardingOptions, getPoolEngine: () => poolEngine,
  timeoutMs: positiveNumber(process.env.ROUTE_TEST_TIMEOUT_MS, 60000),
})));
for (const [endpoint, protocol] of [['chat/completions', 'chat_completions'], ['responses', 'responses'], ['messages', 'messages']]) {
  app.post(`/v1/${endpoint}`, requireApiKey, createExplicitRoutingHandler({ ...forwardingOptions(), entryProtocol: protocol }));
}
app.use((req, res) => res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } }));
app.use((error, req, res, next) => {
  if (res.headersSent) { res.destroy(); return; }
  const status = error.status || (error instanceof ConfigEditorError || error instanceof SyntaxError ? 400 : 500);
  res.status(status).json({ error: { code: error.code || (status < 500 ? 'invalid_request' : 'internal_error'), message: status < 500 ? error.message : '请求处理失败' } });
});

function handleControlFileChange() {
  try {
    const message = JSON.parse(fs.readFileSync(CONTROL_FILE, 'utf8'));
    if (message.action === 'stop' && message.token === CONTROL_TOKEN) { fs.rmSync(CONTROL_FILE, { force: true }); shutdownServer(); }
  } catch {}
}

function shutdownServer() {
  if (stopping) return;
  stopping = true;
  quotaEngine.stopMonitor();
  poolEngine.stopMonitor();
  if (CONTROL_FILE) fs.unwatchFile(CONTROL_FILE, handleControlFileChange);
  if (!server) return;
  const timer = setTimeout(() => process.exit(0), 5000); timer.unref();
  server.close(() => { clearTimeout(timer); process.exit(0); });
  server.closeIdleConnections?.();
}

async function startServer() {
  loadConfig();
  server = await listenOnPort(effectivePort(parsedConfig));
  quotaEngine.startMonitor(() => parsedConfig.configs);
  void quotaEngine.refreshAll(parsedConfig.configs);
  poolEngine.startMonitor();
  void poolEngine.refreshAll();
  if (CONTROL_FILE && CONTROL_TOKEN) {
    fs.watchFile(CONTROL_FILE, { interval: 250 }, handleControlFileChange);
    handleControlFileChange();
  }
  log(`Airouter 已启动，端口 ${effectivePort(parsedConfig)}；账号 ${runtimeConfigs.length}，模型路由 ${getPublicModelIds(parsedConfig).length}`);
  log('配置文件: config.json；所有对话请求仅按模型路由的候选顺序选择上游。');
  return server;
}

if (require.main === module) {
  startServer().catch(error => { console.error('启动失败:', error.message); process.exit(1); });
  process.on('SIGINT', shutdownServer);
  process.on('SIGTERM', shutdownServer);
}

module.exports = { startServer };
