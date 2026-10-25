/** Managed free-only catalogs. Catalog/metadata failures never broaden eligibility. */
const fs = require('node:fs');
const crypto = require('node:crypto');
const { requestBuffered } = require('./upstream-request');

const POOL_PRESETS = new Set(['opencode-free', 'openrouter-free']);
const DEFAULTS = { sync_interval_seconds: 900, max_stale_seconds: 3600, max_attempts: 8, strategy: 'quality_first', tiers: {} };
const MODELS_DEV_URL = 'https://models.dev/api.json';
const OPENROUTER_SOURCE = 'https://openrouter.ai/docs/api/api-reference/models/get-models';
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SAMPLES = 32;
const isPool = config => Boolean(config && POOL_PRESETS.has(config.preset));
const isObject = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const clone = value => JSON.parse(JSON.stringify(value));
function strictZero(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)) && Number(value) === 0;
}
function allPricesZero(value) {
  return isObject(value) && Object.keys(value).length > 0 && Object.values(value).every(entry => isObject(entry) ? allPricesZero(entry) : strictZero(entry));
}
function isFreePricing(pricing, input = 'prompt', output = 'completion') {
  return isObject(pricing) && Object.hasOwn(pricing, input) && Object.hasOwn(pricing, output) && allPricesZero(pricing);
}
function activeModel(model, timestamp) {
  if (!model || typeof model.id !== 'string' || !model.id || (model.status != null && !['active', 'available', 'stable', 'preview', 'alpha', 'beta'].includes(model.status)) || model.enabled === false) return false;
  if (model.expiration_date) {
    const expires = Date.parse(model.expiration_date);
    if (!Number.isFinite(expires) || expires <= timestamp) return false;
  }
  return true;
}
function isSpecializedClassifier(model) {
  const description = typeof model.description === 'string' ? model.description.toLowerCase() : '';
  // These are explicit task declarations, not a name-based guess about model quality.
  return /fine[- ]tuned (?:specifically )?for (?:content )?safety classification/.test(description) ||
    /\bis a safety reasoning model\b/.test(description) ||
    /\bis an? [^.]{0,100}\bguardrail model\b/.test(description);
}
function validLimit(value) { return Number.isInteger(value) && value > 0 ? value : null; }
function normalizeOpenRouterCatalog(payload, timestamp = Date.now(), sourceUrl = OPENROUTER_SOURCE) {
  if (!isObject(payload) || !Array.isArray(payload.data)) throw new Error('OpenRouter 模型目录格式不合法');
  const models = [];
  for (const item of payload.data) {
    if (!activeModel(item, timestamp) || isSpecializedClassifier(item) || item.id.startsWith('openrouter/') || !isFreePricing(item.pricing)) continue;
    const input = item.architecture?.input_modalities;
    const output = item.architecture?.output_modalities;
    if (!Array.isArray(input) || !input.includes('text') || !Array.isArray(output) || output.length !== 1 || output[0] !== 'text' || !Array.isArray(item.supported_parameters)) continue;
    const context = validLimit(item.context_length);
    if (!context || !validLimit(item.top_provider?.max_completion_tokens)) continue;
    const params = new Set(item.supported_parameters);
    models.push({
      id: item.id, name: typeof item.name === 'string' ? item.name : item.id, protocols: ['chat_completions'],
      context_window: context, max_output_tokens: validLimit(item.top_provider?.max_completion_tokens),
      capabilities: { tools: params.has('tools'), images: input.includes('image'), files: input.includes('file'), audio: input.includes('audio'), streaming: true,
        reasoning: params.has('reasoning') || params.has('reasoning_effort') || params.has('include_reasoning'), structuredOutput: params.has('response_format') || params.has('structured_outputs'), builtinTools: false },
      free_evidence: { source: sourceUrl, kind: 'explicit_zero_pricing', checked_at: timestamp, pricing: clone(item.pricing), note: '目录所有已列价格为零；转发另强制 provider.max_price=0' },
    });
  }
  return deduplicate(models);
}
function normalizeOpenCodeCatalog(catalog, metadata, providerId, timestamp = Date.now(), sourceUrls = []) {
  if (!isObject(catalog) || !Array.isArray(catalog.data)) throw new Error('OpenCode 模型目录格式不合法');
  if (!isObject(metadata?.[providerId]?.models)) throw new Error('OpenCode 免费价格与能力元数据不可用');
  const models = [];
  for (const listed of catalog.data) {
    const item = metadata[providerId].models[listed.id];
    if (!activeModel(listed, timestamp) || !activeModel(item, timestamp) || isSpecializedClassifier(item) || !isFreePricing(item.cost, 'input', 'output')) continue;
    // Do not infer chat compatibility from a name. OpenCode publishes per-model endpoint metadata.
    const api = item.provider?.api || '';
    const npm = item.provider?.npm || metadata[providerId].npm || '';
    if (!/\/openai\/v1\/?$/.test(api) && !['@ai-sdk/openai-compatible', '@ai-sdk/openai'].includes(npm)) continue;
    const inputs = item.modalities?.input;
    if (!Array.isArray(inputs) || !inputs.includes('text') || !Array.isArray(item.modalities?.output) || item.modalities.output.length !== 1 || item.modalities.output[0] !== 'text' || !validLimit(item.limit?.context) || !validLimit(item.limit?.output)) continue;
    models.push({
      id: listed.id, name: item.name || listed.id, protocols: ['chat_completions'],
      context_window: validLimit(item.limit.context), max_output_tokens: validLimit(item.limit.output),
      capabilities: { tools: item.tool_call === true, images: inputs.includes('image'), files: inputs.includes('pdf') || inputs.includes('file'), audio: inputs.includes('audio'), streaming: true,
        reasoning: item.reasoning === true, structuredOutput: item.structured_output === true, builtinTools: false },
      free_evidence: { source: sourceUrls[1] || MODELS_DEV_URL, catalog_source: sourceUrls[0] || null, provider: providerId, kind: 'explicit_zero_cost_metadata', checked_at: timestamp,
        pricing: clone(item.cost), note: '供应商账号目录与 OpenCode 使用的 models.dev 元数据交集；元数据为社区维护的显式价格，并非实时计费承诺' },
    });
  }
  return deduplicate(models);
}
function deduplicate(models) { return [...new Map(models.map(model => [model.id, model])).values()]; }
function contextDemand(body) {
  // UTF-8 bytes are a deliberately conservative text estimate, not tokenizer-exact tokens.
  const content = { messages: body.messages, input: body.input, system: body.system, tools: body.tools };
  let bytes = Buffer.byteLength(JSON.stringify(content), 'utf8');
  let images = 0;
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!isObject(value)) return;
    if (['image', 'input_image', 'image_url'].includes(value.type) || value.image_url) images++;
    Object.values(value).forEach(visit);
  };
  visit(content);
  // Remote images have unknown dimensions; reserve 32768 tokens each and let the provider enforce its exact limits.
  bytes += images * 32768;
  const output = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? 2048;
  if (!Number.isInteger(output) || output <= 0) return { total: Infinity, output: Infinity };
  return { total: bytes + output + 1024, output };
}
function matchesCapabilities(model, capabilities, body) {
  for (const name of ['tools', 'images', 'files', 'audio', 'streaming', 'structuredOutput', 'builtinTools', 'reasoning']) {
    if (capabilities[name] && model.capabilities?.[name] !== true) return false;
  }
  const demand = contextDemand(body);
  return model.context_window >= demand.total && model.max_output_tokens >= demand.output;
}

function createFreePoolEngine(options = {}) {
  const now = options.now || (() => Date.now());
  const request = options.requestBufferedFn || requestBuffered;
  const health = options.healthStore || require('./model-router').createRoutingHealthStore({ now });
  const getParsed = options.getParsedConfig || (() => ({ configs: [] }));
  const states = new Map();
  const inFlight = new Map();
  let monitor = null;
  let cache = {};
  if (options.cacheFile) {
    try { const saved = JSON.parse(fs.readFileSync(options.cacheFile, 'utf8')); if (saved.version === 1 && isObject(saved.pools)) cache = saved.pools; } catch (_) { /* No valid cache is an empty pool, never a paid fallback. */ }
  }
  function configFor(id) { return (getParsed().configs || []).find(item => item.id === id); }
  function settings(config) { return { ...DEFAULTS, ...config.pool, tiers: config.pool?.tiers || {} }; }
  function resolve(config) {
    const source = config.credential_ref ? configFor(config.credential_ref) : config;
    const apikey = source?.apikey || '';
    const isGo = source?.preset === 'opencode-go' || (source?.preset !== 'opencode-zen' && !/\/inference\/?$/.test(config.base_url || ''));
    const provider = config.preset === 'openrouter-free' ? 'openrouter' : isGo ? 'opencode-go' : 'opencode';
    const defaultBase = provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : provider === 'opencode-go' ? 'https://opencode.ai/inference/go' : 'https://opencode.ai/inference';
    const configuredBase = (config.base_url || '').replace(/\/+$/, '');
    const codeDefault = ['https://opencode.ai/inference', 'https://opencode.ai/inference/go'].includes(configuredBase);
    const baseUrl = (!configuredBase || (config.credential_ref && config.preset === 'opencode-free' && codeDefault)) ? defaultBase : configuredBase;
    const enabled = config.enabled !== false && source?.enabled !== false && Boolean(apikey);
    return { source, apikey, provider, baseUrl, enabled };
  }
  function fingerprint(config) {
    if (!isPool(config)) return '';
    const source = resolve(config);
    return crypto.createHash('sha256').update(JSON.stringify([config.id, config.preset, config.credential_ref || '', source.source?.id || '', source.apikey, source.enabled, source.baseUrl, source.provider])).digest('hex');
  }
  function current(config, expected) {
    const latest = configFor(config.id);
    return Boolean(latest && isPool(latest) && fingerprint(latest) === expected);
  }
  function persist() {
    if (!options.cacheFile) return;
    const pools = {};
    for (const [id, state] of states) pools[id] = { fingerprint: state.fingerprint, models: state.models, last_sync_at: state.last_sync_at, last_attempt_at: state.last_attempt_at, error: state.error, source_urls: state.source_urls, last_request: state.last_request };
    cache = pools;
    const temp = `${options.cacheFile}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, pools }), { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, options.cacheFile);
    } catch (error) { options.warn?.(`免费池缓存写入失败: ${error.code || 'write_error'}`); }
  }
  function syncConfigs() {
    const ids = new Set();
    for (const config of getParsed().configs || []) {
      if (!isPool(config)) continue;
      ids.add(config.id);
      const identity = fingerprint(config);
      if (states.get(config.id)?.fingerprint === identity) continue;
      health.forget(config.id);
      const saved = cache[config.id]?.fingerprint === identity ? cache[config.id] : null;
      const models = Array.isArray(saved?.models) ? saved.models.filter(item => item && item.protocols?.includes('chat_completions') && item.free_evidence && isFreePricing(item.free_evidence.pricing, config.preset === 'openrouter-free' ? 'prompt' : 'input', config.preset === 'openrouter-free' ? 'completion' : 'output')) : [];
      states.set(config.id, { fingerprint: identity, models, last_sync_at: Number.isFinite(saved?.last_sync_at) ? saved.last_sync_at : null, last_attempt_at: null, error: null, source_urls: saved?.source_urls || [], last_request: saved?.last_request || null, samples: new Map() });
    }
    for (const id of states.keys()) if (!ids.has(id)) { states.delete(id); health.forget(id); }
  }
  function stateFor(config) { syncConfigs(); return states.get(config.id); }
  function sanitizedError(error, secret) { return String(error?.message || error).split(secret || '\0').join('[REDACTED]').slice(0, 300); }
  async function fetchJson(url, apikey) {
    const response = await request({ method: 'GET', targetUrl: url, headers: { accept: 'application/json', ...(apikey ? { authorization: `Bearer ${apikey}` } : {}) }, timeoutMs: options.timeoutMs || 15000, maxRedirects: 0 });
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`模型目录读取失败: HTTP ${response.statusCode}`);
    return JSON.parse(response.bodyText);
  }
  async function refresh(id) {
    const config = typeof id === 'string' ? configFor(id) : id;
    if (!isPool(config)) throw new Error('免费池不存在');
    const state = stateFor(config);
    const identity = state.fingerprint;
    const key = `${config.id}:${identity}`;
    if (inFlight.has(key)) return inFlight.get(key);
    const job = (async () => {
      const connection = resolve(config);
      state.last_attempt_at = now();
      try {
        if (!connection.enabled) throw new Error('免费池凭证缺失或引用账号已停用');
        const catalogUrl = options.catalogUrlFor?.(config, connection) || `${connection.baseUrl}${connection.provider === 'openrouter' ? '/models/user' : '/v1/models'}`;
        const timestamp = now();
        let models;
        let urls;
        if (connection.provider === 'openrouter') {
          urls = [catalogUrl];
          models = normalizeOpenRouterCatalog(await fetchJson(catalogUrl, connection.apikey), timestamp, catalogUrl);
        } else {
          const metadataUrl = options.modelsDevUrl || MODELS_DEV_URL;
          urls = [catalogUrl, metadataUrl];
          const [catalog, metadata] = await Promise.all([fetchJson(catalogUrl, connection.apikey), fetchJson(metadataUrl)]);
          models = normalizeOpenCodeCatalog(catalog, metadata, connection.provider, timestamp, urls);
        }
        if (!current(config, identity) || states.get(config.id) !== state) return serialize(configFor(config.id) || config);
        state.models = models;
        state.last_sync_at = now();
        state.source_urls = urls;
        state.error = null;
        const active = new Set(models.map(item => item.id));
        for (const key of state.samples.keys()) if (!active.has(key)) state.samples.delete(key);
        persist();
      } catch (error) {
        if (current(config, identity) && states.get(config.id) === state) { state.error = sanitizedError(error, connection.apikey); persist(); }
      }
      return serialize(configFor(config.id) || config);
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  }
  function fresh(config, state) {
    const age = state?.last_sync_at == null ? Infinity : now() - state.last_sync_at;
    return age >= 0 && age <= settings(config).max_stale_seconds * 1000;
  }
  function samplesFor(state, modelId) {
    const samples = (state.samples.get(modelId) || []).filter(sample => now() - sample.at <= RECENT_WINDOW_MS);
    state.samples.set(modelId, samples);
    return samples;
  }
  function metrics(state, modelId) {
    const samples = samplesFor(state, modelId);
    const successes = samples.filter(sample => sample.ok);
    return { success_rate: samples.length ? successes.length / samples.length : null, latency_ms: successes.length ? Math.round(successes.reduce((sum, sample) => sum + sample.ms, 0) / successes.length) : null, sample_count: samples.length };
  }
  function accountHealth(config, state) {
    const shared = health.getConfigState(config.id);
    if (shared.status !== 'ok') return shared;
    return state.account_limit?.until > now() ? state.account_limit : shared;
  }
  function modelView(config, state, model) {
    const meta = health.serialize(config.id, `${model.id}\0chat_completions`);
    const account = accountHealth(config, state);
    const cooldown = account.status !== 'ok' ? account : meta.target;
    const explicitTier = settings(config).tiers[model.id];
    return { ...clone(model), ...metrics(state, model.id), quality_tier: Number.isInteger(explicitTier) ? explicitTier : 5,
      quality_source: Number.isInteger(explicitTier) ? '用户配置分级（数字小者优先）' : '未评级：默认同档，不代表自动质量评分',
      status: !fresh(config, state) ? 'stale' : cooldown.status === 'ok' ? 'available' : cooldown.status, until: cooldown.until || null, reason: cooldown.reason || null,
      pool_fingerprint: state.fingerprint };
  }
  function sortCandidates(candidates, strategy) {
    return candidates.sort((a, b) => {
      if (strategy !== 'fastest' && a.quality_tier !== b.quality_tier) return a.quality_tier - b.quality_tier;
      // Unknown models get a neutral prior; failures reduce priority, healthy latency breaks same-tier ties.
      const reliability = (b.success_rate ?? 1) - (a.success_rate ?? 1);
      if (Math.abs(reliability) > 0.1) return reliability;
      const speed = (a.latency_ms ?? Infinity) - (b.latency_ms ?? Infinity);
      return Number.isNaN(speed) || speed === 0 ? a.id.localeCompare(b.id) : speed;
    });
  }
  function getCandidates(config, capabilities = {}, body = {}) {
    const state = stateFor(config);
    if (!state || !resolve(config).enabled || !fresh(config, state)) return [];
    const candidates = state.models.map(model => modelView(config, state, model)).filter(model => model.status === 'available' && matchesCapabilities(model, capabilities, body));
    return sortCandidates(candidates, settings(config).strategy).slice(0, settings(config).max_attempts);
  }
  function serialize(config) {
    const state = stateFor(config);
    if (!state) return null;
    const connection = resolve(config);
    const models = sortCandidates(state.models.map(model => modelView(config, state, model)), settings(config).strategy);
    return { state: !connection.enabled ? 'disabled' : !fresh(config, state) ? (state.last_sync_at == null ? 'unknown' : 'stale') : models.some(model => model.status === 'available') ? 'available' : 'unavailable',
      models, last_sync_at: state.last_sync_at, last_attempt_at: state.last_attempt_at, error: state.error, source_urls: [...state.source_urls], last_request: state.last_request,
      account_health: accountHealth(config, state),
      strategy: settings(config).strategy, quality_basis: '透明配置分级；未配置者同档；同档结合近24小时至多32次调用的成功率与响应延迟',
      max_stale_seconds: settings(config).max_stale_seconds, context_estimate: '文本UTF8字节+输出预算+1024余量；图片额外预留32768，不是精确token计数',
      restrictions: connection.provider === 'opencode' ? 'Zen免费模型可能仅允许OpenCode客户端；本服务不伪装客户端或放宽隐私设置。' : '保留供应商账号限流、权限和隐私限制。' };
  }
  function eventState(config, model, expected) {
    const state = states.get(config.id);
    const identity = expected || (typeof model === 'object' && model.pool_fingerprint) || config.poolFingerprint;
    if (!state || !identity || !current(config, identity) || state.fingerprint !== identity) return null;
    return state;
  }
  function modelId(model) { return typeof model === 'string' ? model : model.id; }
  function recordAttempt(config, model, expected) {
    const state = eventState(config, model, expected);
    if (!state) return;
    state.last_request = { model: modelId(model), started_at: now(), status: 'pending' };
    persist();
  }
  function addSample(state, id, sample) { state.samples.set(id, [...samplesFor(state, id), sample].slice(-MAX_SAMPLES)); }
  function recordSuccess(config, model, elapsedMs, expected) {
    const state = eventState(config, model, expected);
    if (!state) return;
    const id = modelId(model);
    if (accountHealth(config, state).status === 'ok') health.markSuccess(config.id, { targetKey: `${id}\0chat_completions` });
    addSample(state, id, { at: now(), ok: true, ms: Math.max(0, Number(elapsedMs) || 0) });
    state.last_request = { model: id, completed_at: now(), status: 'success', elapsed_ms: Math.max(0, Number(elapsedMs) || 0) };
    persist();
  }
  function recordFailure(config, model, details = {}, expected) {
    const state = eventState(config, model, expected || details.fingerprint);
    if (!state) return;
    const id = modelId(model);
    const status = Number(details.statusCode || 502);
    const scope = String(details.metadata?.scope || details.metadata?.limit_scope || details.metadata?.rate_limit_scope || '').toLowerCase();
    const text = `${details.errorCode || ''} ${details.message || ''}`.toLowerCase();
    const accountWide = ['account', 'api_key', 'key'].includes(scope) || /negative balance|free[-_ ]models[-_ ]per[-_ ]day|daily (?:free )?(?:request|quota|limit)|balance[^.]{0,30}negative|rate[-_ ]?limit[^.]{0,50}(?:for|per) (?:this )?(?:account|api[-_ ]?key|key)|(?:account|api[-_ ]?key|key)[-_ ](?:wide[-_ ])?(?:rate[-_ ]?limit|quota[-_ ]limit|limit exceeded)/.test(text);
    if (status === 401) health.markAuthFailure(config.id, { reason: 'auth_failed', cooldownMs: details.retryAfterMs });
    else if (accountWide) {
      const cooldownMs = Number.isFinite(details.retryAfterMs) && details.retryAfterMs >= 0 ? details.retryAfterMs : 60000;
      state.account_limit = { status: 'cooldown', reason: 'account_free_limit', until: now() + cooldownMs };
      health.markConfigCooldown?.(config.id, { reason: 'account_free_limit', cooldownMs });
    } else health.markCooldown(config.id, { targetKey: `${id}\0chat_completions`, reason: details.reason || `upstream_http_${status}`, cooldownMs: Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : status === 403 || status === 404 || status === 400 ? 60000 : undefined });
    addSample(state, id, { at: now(), ok: false, ms: null });
    state.last_request = { model: id, completed_at: now(), status: 'failed', status_code: status, reason: details.reason || 'upstream_error' };
    persist();
  }
  async function refreshAll() { syncConfigs(); return Promise.all((getParsed().configs || []).filter(isPool).filter(config => config.enabled !== false).map(config => refresh(config.id))); }
  async function tick() {
    syncConfigs();
    const jobs = [];
    for (const config of (getParsed().configs || []).filter(isPool)) {
      if (!resolve(config).enabled) continue;
      const state = states.get(config.id);
      if (state.last_attempt_at == null || now() - state.last_attempt_at >= settings(config).sync_interval_seconds * 1000) jobs.push(refresh(config.id));
    }
    await Promise.allSettled(jobs);
  }
  function startMonitor() {
    if (monitor) return;
    void tick();
    monitor = setInterval(() => { void tick(); }, options.monitorIntervalMs || 30000);
    monitor.unref?.();
  }
  function stopMonitor() { clearInterval(monitor); monitor = null; }
  syncConfigs();
  return { syncConfigs, refresh, refreshAll, startMonitor, stopMonitor, getCandidates, serialize, fingerprint, isCurrent: current, recordAttempt, recordSuccess, recordFailure };
}
module.exports = { createFreePoolEngine, isPool, isFreePricing, normalizeOpenRouterCatalog, normalizeOpenCodeCatalog, matchesCapabilities, contextDemand };
