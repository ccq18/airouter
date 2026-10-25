const { createHash } = require('node:crypto');
const { requestBuffered } = require('./upstream-request');
const { buildQuotaRequest, parseQuotaPayload, parseOpenRouterCreditsPayload, resolvePresetForConfig } = require('./provider-presets');

const DEFAULT_REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_TTL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8 * 1000;
const DEFAULT_MAX_PARALLEL = 2;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function withTimeout(promise, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }

  let timer = null;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

function createQuotaSnapshot(configId) {
  return {
    configId,
    state: 'unknown',
    metrics: [],
    reason: 'quota_unknown',
    error: null,
    checkedAt: null,
    lastSuccessAt: null,
    resetAt: null,
    source: 'none',
  };
}

function createQuotaEngine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const refreshIntervalMs = Number.isFinite(options.refreshIntervalMs)
    ? options.refreshIntervalMs
    : DEFAULT_REFRESH_INTERVAL_MS;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxParallel = Number.isInteger(options.maxParallel) && options.maxParallel > 0
    ? options.maxParallel
    : DEFAULT_MAX_PARALLEL;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const warn = typeof options.warn === 'function' ? options.warn : () => {};
  const setIntervalFn = typeof options.setIntervalFn === 'function' ? options.setIntervalFn : setInterval;
  const clearIntervalFn = typeof options.clearIntervalFn === 'function' ? options.clearIntervalFn : clearInterval;

  let requestBufferedFn = typeof options.requestBufferedFn === 'function'
    ? options.requestBufferedFn
    : requestBuffered;
  const snapshots = new Map();
  const inFlight = new Map();
  const probeLocks = new Map();
  const configVersions = new Map();
  let managedConfigs = false;
  let monitorTimer = null;

  function getConfigId(config) {
    if (typeof config === 'string') {
      return config;
    }

    return config && typeof config.id === 'string' ? config.id : '';
  }

  function configVersion(config) {
    return createHash('sha256').update(JSON.stringify([
      config.preset || '', config.type || 'token', config.subtype || '',
      config.base_url || '', config.quota_url || '', config.apikey || '',
      config.access_token || '', config.account_id || '', config.credentials || null,
    ])).digest('hex');
  }

  function ensureVersion(config) {
    if (!config || typeof config !== 'object' || !config.id) return;
    const version = configVersion(config);
    const previous = configVersions.get(config.id);
    if (previous && previous !== version) {
      snapshots.delete(config.id);
      inFlight.delete(config.id);
      probeLocks.delete(config.id);
    }
    configVersions.set(config.id, version);
  }

  function isCurrentConfig(config) {
    return configVersions.has(config.id) ? configVersions.get(config.id) === configVersion(config) : !managedConfigs;
  }

  function syncConfigs(configs) {
    managedConfigs = true;
    const ids = new Set(configs.map(config => config.id));
    const changed = [];
    for (const config of configs) {
      if (!isCurrentConfig(config)) changed.push(config.id);
      ensureVersion(config);
    }
    for (const id of configVersions.keys()) {
      if (!ids.has(id)) {
        changed.push(id);
        configVersions.delete(id); snapshots.delete(id); inFlight.delete(id); probeLocks.delete(id);
      }
    }
    return changed;
  }

  function getSnapshot(configOrId) {
    const configId = getConfigId(configOrId);
    if (typeof configOrId === 'object' && !isCurrentConfig(configOrId)) return null;
    return snapshots.get(configId) || null;
  }

  function getOrCreateSnapshot(configOrId) {
    const configId = getConfigId(configOrId);
    if (!snapshots.has(configId)) {
      snapshots.set(configId, createQuotaSnapshot(configId));
    }
    return snapshots.get(configId);
  }

  function setRequestBufferedFnForTests(fn) {
    requestBufferedFn = fn;
  }

  function freshness(snapshot) {
    if (!snapshot || snapshot.checkedAt === null) {
      return 'never';
    }

    return now() - snapshot.checkedAt < ttlMs ? 'fresh' : 'stale';
  }

  function isExhausted(configOrId) {
    const snapshot = getSnapshot(configOrId);
    return Boolean(snapshot && snapshot.state === 'exhausted');
  }

  function getDecision(configOrId) {
    const snapshot = getSnapshot(configOrId);
    if (!snapshot || snapshot.state === 'unknown') {
      return {
        allowed: true,
        state: 'unknown',
        reason: 'quota_unknown',
        probe: true,
      };
    }

    if (snapshot.state === 'exhausted') {
      if (snapshot.unsupported && snapshot.retryProbeAt <= now()) {
        return { allowed: true, state: 'exhausted', reason: 'recovery_probe', probe: true };
      }
      return {
        allowed: false,
        state: 'exhausted',
        reason: snapshot.reason || 'quota_exhausted',
        probe: false,
        resetAt: snapshot.resetAt,
      };
    }

    return {
      allowed: true,
      state: 'available',
      reason: 'quota_available',
      probe: false,
    };
  }

  function markExhausted(configOrId, details = {}) {
    const snapshot = getOrCreateSnapshot(configOrId);
    snapshot.state = 'exhausted';
    snapshot.businessExhausted = true;
    snapshot.retryProbeAt = Number.isFinite(details.resetAt) ? details.resetAt : now() + 5 * 60 * 1000;
    snapshot.reason = normalizeString(details.reason) || 'quota_exhausted';
    snapshot.error = null;
    snapshot.checkedAt = now();
    snapshot.resetAt = Number.isFinite(details.resetAt) ? details.resetAt : snapshot.resetAt;
    snapshot.source = normalizeString(details.source) || 'business_error';
    if (Array.isArray(details.metrics)) {
      snapshot.metrics = details.metrics;
    }
    return snapshot;
  }

  function recordProbeSuccess(configOrId, details = {}) {
    const snapshot = getOrCreateSnapshot(configOrId);
    snapshot.state = 'available';
    snapshot.businessExhausted = false;
    snapshot.reason = normalizeString(details.reason) || 'probe_success';
    snapshot.error = null;
    snapshot.checkedAt = now();
    snapshot.lastSuccessAt = now();
    snapshot.source = 'probe';
    return snapshot;
  }

  function acquireProbe(configOrId) {
    const configId = getConfigId(configOrId);
    if (probeLocks.has(configId)) {
      return null;
    }

    const token = Symbol(configId);
    probeLocks.set(configId, token);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (probeLocks.get(configId) === token) probeLocks.delete(configId);
    };
  }

  function applyFailure(snapshot, error, details) {
    const previousState = snapshot.state;
    const message = error instanceof Error ? error.message : String(error || 'unknown');
    snapshot.checkedAt = now();

    if (previousState === 'exhausted') {
      // A failed refresh is not evidence of recovery. Keep blocking until new
      // positive evidence arrives.
      snapshot.state = 'exhausted';
      snapshot.reason = details.reason || snapshot.reason || 'quota_exhausted';
      snapshot.error = message;
      snapshot.source = details.source || 'refresh_error';
      return snapshot;
    }

    snapshot.state = 'unknown';
    snapshot.reason = details.reason || 'quota_check_failed';
    snapshot.error = message;
    snapshot.source = details.source || 'refresh_error';
    return snapshot;
  }

  async function performRefresh(config) {
    const configId = getConfigId(config);
    const snapshot = getOrCreateSnapshot(configId);
    let request;

    try {
      request = buildQuotaRequest(config);
    } catch (err) {
      snapshot.unsupported = true;
      return applyFailure(snapshot, err, { reason: 'quota_unsupported', source: 'unsupported' });
    }
    snapshot.unsupported = false;

    async function readSource(sourceRequest, parser) {
      try {
        const result = await withTimeout(requestBufferedFn({
          method: 'GET', targetUrl: sourceRequest.url, headers: sourceRequest.headers,
          timeoutMs, maxRedirects: 2,
        }), timeoutMs, '额度查询');
        return parser(result);
      } catch (err) {
        return { state: 'unknown', metrics: [], reason: err.message };
      }
    }

    let parsed;
    if (resolvePresetForConfig(config).id === 'openrouter') {
      const creditsUrl = new URL(request.url);
      creditsUrl.pathname = creditsUrl.pathname.replace(/\/key\/?$/, '/credits');
      const sources = await Promise.all([
        readSource(request, result => parseQuotaPayload(result, config)),
        readSource({ ...request, url: creditsUrl.toString() }, parseOpenRouterCreditsPayload),
      ]);
      const metrics = [];
      const errors = [];
      sources.forEach((source, index) => {
        const prefix = index === 0 ? 'key:' : 'credits:';
        if (source.state === 'unknown' && !source.unrestricted) {
          errors.push(source.reason || '额度读取失败');
          metrics.push(...snapshot.metrics.filter(metric => metric.id.startsWith(prefix) && metric.state === 'exhausted'));
        } else {
          metrics.push(...(source.metrics || []).map(metric => ({ ...metric, id: prefix + metric.id })));
        }
      });
      let state = metrics.some(metric => metric.state === 'exhausted') ? 'exhausted'
        : metrics.some(metric => metric.state === 'available') ? 'available' : 'unknown';
      if (snapshot.state === 'exhausted' && snapshot.businessExhausted && errors.length) state = 'exhausted';
      parsed = { state, metrics, reason: errors.join('; '), partialError: errors.join('; ') || null };
    } else {
      parsed = await readSource(request, result => parseQuotaPayload(result, config));
    }
    snapshot.checkedAt = now();
    snapshot.source = 'quota_api';

    if (parsed.state === 'unknown') {
      if (snapshot.state === 'exhausted') {
        snapshot.state = 'exhausted';
        snapshot.reason = snapshot.reason || 'quota_exhausted';
      } else {
        snapshot.state = 'unknown';
        snapshot.reason = 'quota_unknown';
      }
      snapshot.metrics = Array.isArray(parsed.metrics) ? parsed.metrics : [];
      snapshot.resetAt = parsed.resetAt ?? snapshot.resetAt;
      snapshot.error = parsed.reason || '额度响应无法解释';
      return snapshot;
    }

    snapshot.state = parsed.state;
    if (parsed.state === 'available') snapshot.businessExhausted = false;
    snapshot.reason = parsed.state === 'exhausted' ? 'quota_exhausted' : 'quota_available';
    snapshot.metrics = Array.isArray(parsed.metrics) ? parsed.metrics : [];
    snapshot.resetAt = parsed.resetAt ?? null;
    snapshot.error = parsed.partialError || null;
    snapshot.lastSuccessAt = now();
    return snapshot;
  }

  async function refresh(config, options = {}) {
    if (managedConfigs && !isCurrentConfig(config)) return getSnapshot(config.id) || createQuotaSnapshot(config.id);
    ensureVersion(config);
    const configId = getConfigId(config);
    if (!configId) {
      throw new Error('额度刷新需要稳定的上游账号 ID');
    }

    const existing = inFlight.get(configId);
    if (existing) {
      return existing;
    }

    const snapshot = getSnapshot(configId);
    if (!options.force && snapshot && freshness(snapshot) === 'fresh') {
      return snapshot;
    }

    const promise = performRefresh(config).finally(() => {
      if (inFlight.get(configId) === promise) inFlight.delete(configId);
    });
    inFlight.set(configId, promise);
    return promise;
  }

  async function ensureFresh(config, options = {}) {
    if (managedConfigs && !isCurrentConfig(config)) return getSnapshot(config.id) || createQuotaSnapshot(config.id);
    ensureVersion(config);
    const configId = getConfigId(config);
    if (!configId) {
      return createQuotaSnapshot('');
    }

    const snapshot = getSnapshot(configId);
    const decision = getDecision(configId);
    let force = options.force === true;

    if (!force && snapshot && snapshot.state === 'exhausted' && snapshot.resetAt !== null && snapshot.resetAt <= now()) {
      // A passed reset time is a reason to re-read, not a reason to assume
      // recovery. Only a successful read or probe may clear exhaustion.
      force = true;
    }

    if (!force && snapshot && freshness(snapshot) === 'fresh') {
      return snapshot;
    }

    return refresh(config, { force });
  }

  async function refreshAll(configs, options = {}) {
    const targets = (Array.isArray(configs) ? configs : []).filter(Boolean);
    const results = new Map();
    let cursor = 0;

    async function worker() {
      while (cursor < targets.length) {
        const index = cursor;
        cursor += 1;
        const config = targets[index];
        try {
          results.set(getConfigId(config), await refresh(config, options));
        } catch (err) {
          warn(`额度刷新失败: ${getConfigId(config)} (${err.message})`);
        }
      }
    }

    const workers = [];
    for (let index = 0; index < Math.min(maxParallel, targets.length); index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }

  function serialize(configOrId) {
    const configId = getConfigId(configOrId);
    const snapshot = getSnapshot(configOrId) || createQuotaSnapshot(configId);
    return {
      config_id: configId,
      state: snapshot.state,
      reason: snapshot.reason,
      error: snapshot.error,
      checked_at: snapshot.checkedAt,
      last_success_at: snapshot.lastSuccessAt,
      reset_at: snapshot.resetAt,
      freshness: freshness(snapshot),
      source: snapshot.source,
      metrics: snapshot.metrics.map(metric => ({
        id: metric.id,
        scope: metric.scope,
        scope_key: metric.scope_key,
        kind: metric.kind,
        unit: metric.unit,
        remaining: metric.remaining,
        used: metric.used,
        limit: metric.limit,
        remaining_percent: metric.remainingPercent,
        reset_at: metric.resetAt,
        state: metric.state,
        blocking: metric.blocking,
      })),
    };
  }

  function startMonitor(getConfigs) {
    if (monitorTimer || !Number.isFinite(refreshIntervalMs) || refreshIntervalMs <= 0) {
      return;
    }

    monitorTimer = setIntervalFn(() => {
      const configs = typeof getConfigs === 'function' ? getConfigs() : [];
      void refreshAll(configs).catch(err => warn(`额度轮询失败: ${err.message}`));
    }, refreshIntervalMs);
    if (typeof monitorTimer.unref === 'function') {
      monitorTimer.unref();
    }
    log('统一额度轮询已启动');
  }

  function stopMonitor() {
    if (!monitorTimer) {
      return;
    }

    clearIntervalFn(monitorTimer);
    monitorTimer = null;
  }

  return {
    syncConfigs,
    isCurrentConfig,
    getSnapshot,
    getDecision,
    isExhausted,
    markExhausted,
    recordProbeSuccess,
    acquireProbe,
    refresh,
    ensureFresh,
    refreshAll,
    serialize,
    startMonitor,
    stopMonitor,
    setRequestBufferedFnForTests,
  };
}

module.exports = {
  createQuotaEngine,
};
