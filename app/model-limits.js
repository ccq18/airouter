/**
 * Model context window / max output resolution.
 *
 * Order (per field, independently):
 *   1. manual   – admin-configured configs[].models[].context_window / max_output_tokens
 *   2. upstream – limits published by the upstream /models catalog (cached, periodically refreshed)
 *   3. builtin  – curated table below, matched by normalized model id
 *   4. null     – unknown; never guessed
 */
const fs = require('node:fs');

const ZHIPU_GLM_53 = 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3';
const ZHIPU_GLM_51 = 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.1';
const ZHIPU_OVERVIEW = 'https://docs.bigmodel.cn/cn/guide/start/model-overview';
const DEEPSEEK_V41 = 'https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-1-flash';

const GLM_1M = { context_window: 1048576, max_output_tokens: 131072 };
const GLM_200K = { context_window: 200000, max_output_tokens: 131072 };
const DEEPSEEK_1M = { context_window: 1048576, max_output_tokens: 393216 };

// Exact normalized ids only. Free/trial variants (e.g. OpenCode "*-free") are deliberately
// absent: providers serve them with smaller windows (OpenCode Zen lists 200K for them).
const BUILTIN_MODEL_LIMITS = Object.freeze([
  // GLM-5.3: "支持 1M 上下文窗口，最大输出 Tokens 为 128K" — https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3
  { ids: ['glm-5.3'], ...GLM_1M, source: ZHIPU_GLM_53 },
  // GLM-5.3-Flash / -FlashX / GLM-5.2: 1M / 128K — https://docs.bigmodel.cn/cn/guide/start/model-overview
  { ids: ['glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2'], ...GLM_1M, source: ZHIPU_OVERVIEW },
  // GLM-5.1: 上下文窗口 200K，最大输出 128K — https://docs.bigmodel.cn/cn/guide/models/text/glm-5.1
  { ids: ['glm-5.1'], ...GLM_200K, source: ZHIPU_GLM_51 },
  // GLM-5 / GLM-5-Turbo / GLM-5V-Turbo / GLM-4.7(-Flash/-FlashX) / GLM-4.6: 200K / 128K
  // — https://docs.bigmodel.cn/cn/guide/start/model-overview
  { ids: ['glm-5', 'glm-5-turbo', 'glm-5v-turbo', 'glm-4.7', 'glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.6'], ...GLM_200K, source: ZHIPU_OVERVIEW },
  // DeepSeek V4.1 Flash: 1M context, 393216 max output
  // — https://www.alibabacloud.com/help/en/model-studio/deepseek-v4-1-flash
  // DeepSeek's own API serves it as "deepseek-flash" (legacy alias "deepseek-v4-flash")
  // — https://api-docs.deepseek.com/quick_start/pricing
  { ids: ['deepseek-v4.1-flash', 'deepseek-flash', 'deepseek-v4-flash'], ...DEEPSEEK_1M, source: DEEPSEEK_V41 },
]);

const BUILTIN_INDEX = new Map();
for (const entry of BUILTIN_MODEL_LIMITS) {
  for (const id of entry.ids) BUILTIN_INDEX.set(id, entry);
}

// OpenRouter routing variants that serve the same weights/limits. ":free" is NOT included.
const SAME_MODEL_TAGS = new Set(['batch', 'nitro', 'floor', 'exacto', 'thinking']);

function positiveInteger(value) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return Number.isInteger(number) && number > 0 ? number : null;
}

/** Normalize provider prefixes, case, routing tags and snapshot/date suffixes. */
function normalizeModelId(id) {
  if (typeof id !== 'string') return '';
  let value = id.trim().toLowerCase();
  if (!value) return '';
  value = value.slice(value.lastIndexOf('/') + 1);
  const colon = value.indexOf(':');
  if (colon >= 0) {
    const tag = value.slice(colon + 1);
    if (!SAME_MODEL_TAGS.has(tag)) return value; // unknown tag (e.g. ":free"): keep, so it won't match
    value = value.slice(0, colon);
  }
  // Snapshot suffixes: -20261017, -260910, -1017, -2026-10-17, -latest
  value = value.replace(/-(?:latest|\d{4}-\d{2}-\d{2}|\d{8}|\d{6}|\d{4})$/, '');
  return value;
}

function lookupBuiltinLimits(modelId) {
  const entry = BUILTIN_INDEX.get(normalizeModelId(modelId));
  if (!entry) return null;
  return { context_window: entry.context_window, max_output_tokens: entry.max_output_tokens, source_url: entry.source };
}

function minKnown(values) {
  const known = values.map(positiveInteger).filter(value => value !== null);
  return known.length ? Math.min(...known) : null;
}

/**
 * Extract limits from one upstream /models item. Handles OpenAI-style extensions
 * (context_window/context_length/max_context_length, max_output_tokens/max_completion_tokens),
 * OpenRouter (context_length + top_provider.{context_length,max_completion_tokens}) and
 * OpenCode / models.dev (limit.{context,output}). When several context fields are present the
 * smallest is used (OpenRouter's top_provider can be below the model's nominal length).
 */
function extractUpstreamLimits(item) {
  if (!item || typeof item !== 'object') return { context_window: null, max_output_tokens: null };
  const limit = item.limit && typeof item.limit === 'object' ? item.limit : {};
  const top = item.top_provider && typeof item.top_provider === 'object' ? item.top_provider : {};
  return {
    context_window: minKnown([item.context_window, item.context_length, item.max_context_length, limit.context, top.context_length]),
    max_output_tokens: minKnown([item.max_output_tokens, item.max_completion_tokens, limit.output, top.max_completion_tokens]),
  };
}

/** Resolve both fields for one configured model. `upstream` is the cached catalog entry, if any. */
function resolveModelLimits(modelId, { manual, upstream } = {}) {
  const builtin = lookupBuiltinLimits(modelId);
  const result = {};
  for (const field of ['context_window', 'max_output_tokens']) {
    const candidates = [
      ['manual', positiveInteger(manual?.[field])],
      ['upstream', positiveInteger(upstream?.[field])],
      ['builtin', positiveInteger(builtin?.[field])],
    ];
    const hit = candidates.find(([, value]) => value !== null);
    result[field] = hit ? hit[1] : null;
    result[`${field}_source`] = hit ? hit[0] : null;
  }
  if (builtin && (result.context_window_source === 'builtin' || result.max_output_tokens_source === 'builtin')) result.builtin_source_url = builtin.source_url;
  return result;
}

/**
 * Upstream catalog limits cache. Fetching uses the same discovery request as the admin
 * "sync models" button (no tokens are consumed). Failures keep the previous entries.
 */
function createModelLimitsStore(options = {}) {
  const now = options.now || (() => Date.now());
  const refreshMs = Number.isFinite(options.refreshMs) ? options.refreshMs : 6 * 60 * 60 * 1000;
  const retryMs = Number.isFinite(options.retryMs) ? options.retryMs : 15 * 60 * 1000;
  const getParsed = options.getParsedConfig || (() => ({ configs: [] }));
  const isEligible = options.isEligible || (() => true);
  const fetchCatalog = options.fetchCatalog; // async (config) => [{ id, context_window, max_output_tokens }]
  const entries = new Map(); // config_id -> { models: Map(id -> limits), last_sync_at, last_attempt_at, error }
  const inFlight = new Map();
  let monitor = null;

  if (options.cacheFile) {
    try {
      const saved = JSON.parse(fs.readFileSync(options.cacheFile, 'utf8'));
      if (saved && saved.version === 1 && saved.configs && typeof saved.configs === 'object') {
        for (const [id, value] of Object.entries(saved.configs)) {
          entries.set(id, { models: new Map(Object.entries(value.models || {})), last_sync_at: value.last_sync_at ?? null, last_attempt_at: null, error: null });
        }
      }
    } catch (_) { /* no cache: start empty */ }
  }

  function persist() {
    if (!options.cacheFile) return;
    const configs = {};
    for (const [id, entry] of entries) configs[id] = { models: Object.fromEntries(entry.models), last_sync_at: entry.last_sync_at };
    const temp = `${options.cacheFile}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, configs }), { mode: 0o600 });
      fs.renameSync(temp, options.cacheFile);
    } catch (error) { options.warn?.(`模型上下文缓存写入失败: ${error.code || 'write_error'}`); }
  }

  function eligibleConfigs() {
    return (getParsed().configs || []).filter(config => config && config.id && config.enabled !== false && isEligible(config));
  }

  async function refresh(config) {
    if (!fetchCatalog) return null;
    const key = config.id;
    if (inFlight.has(key)) return inFlight.get(key);
    const entry = entries.get(key) || { models: new Map(), last_sync_at: null, last_attempt_at: null, error: null };
    entries.set(key, entry);
    entry.last_attempt_at = now();
    const job = (async () => {
      try {
        const models = await fetchCatalog(config);
        const next = new Map();
        for (const item of Array.isArray(models) ? models : []) {
          if (!item || typeof item.id !== 'string') continue;
          const limits = { context_window: positiveInteger(item.context_window), max_output_tokens: positiveInteger(item.max_output_tokens) };
          if (limits.context_window || limits.max_output_tokens) next.set(item.id, limits);
        }
        entry.models = next;
        entry.last_sync_at = now();
        entry.error = null;
        persist();
      } catch (error) {
        entry.error = String(error?.message || error).slice(0, 200);
      }
      return entry;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return job;
  }

  async function tick() {
    const live = new Set();
    const jobs = [];
    for (const config of eligibleConfigs()) {
      live.add(config.id);
      const entry = entries.get(config.id);
      const due = !entry || entry.last_attempt_at == null
        || now() - (entry.error ? entry.last_attempt_at : entry.last_sync_at ?? 0) >= (entry.error ? retryMs : refreshMs);
      if (due) jobs.push(refresh(config));
    }
    await Promise.allSettled(jobs);
    return live;
  }

  function forgetMissing() {
    const ids = new Set((getParsed().configs || []).map(config => config && config.id));
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
  }

  function getUpstream(configId, modelId) {
    const models = entries.get(configId)?.models;
    if (!models) return null;
    if (models.has(modelId)) return models.get(modelId);
    // Case-insensitive fallback only (no family guessing for upstream data).
    const lower = String(modelId).toLowerCase();
    for (const [id, limits] of models) if (id.toLowerCase() === lower) return limits;
    return null;
  }

  function resolve(config, modelId) {
    const manual = (Array.isArray(config?.models) ? config.models : []).find(model => model && model.id === modelId);
    return resolveModelLimits(modelId, { manual, upstream: config ? getUpstream(config.id, modelId) : null });
  }

  function status(configId) {
    const entry = entries.get(configId);
    return entry ? { last_sync_at: entry.last_sync_at, last_attempt_at: entry.last_attempt_at, error: entry.error, model_count: entry.models.size } : null;
  }

  function startMonitor(intervalMs = 60000) {
    if (monitor || refreshMs <= 0) return;
    void tick();
    monitor = setInterval(() => { forgetMissing(); void tick(); }, intervalMs);
    monitor.unref?.();
  }
  function stopMonitor() { clearInterval(monitor); monitor = null; }

  return { refresh, tick, resolve, getUpstream, status, startMonitor, stopMonitor, forgetMissing };
}

/**
 * Route-level limits for /v1/models. `targetLimits` is the ordered list of per-target
 * { context_window, max_output_tokens, context_window_source }.
 */
function summarizeRouteLimits(targetLimits) {
  const list = Array.isArray(targetLimits) ? targetLimits : [];
  const primary = list[0] || {};
  const min = field => {
    const values = list.map(item => positiveInteger(item?.[field]));
    return values.length && values.every(value => value !== null) ? Math.min(...values) : null;
  };
  return {
    context_window: positiveInteger(primary.context_window),
    max_output_tokens: positiveInteger(primary.max_output_tokens),
    context_window_source: primary.context_window_source || null,
    // Conservative bound across every fallback target. null if any target is unknown.
    context_window_min: min('context_window'),
    max_output_tokens_min: min('max_output_tokens'),
  };
}

module.exports = {
  BUILTIN_MODEL_LIMITS,
  normalizeModelId,
  lookupBuiltinLimits,
  extractUpstreamLimits,
  resolveModelLimits,
  createModelLimitsStore,
  summarizeRouteLimits,
};
