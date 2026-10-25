const { isFreePool, normalizePoolOptions } = require('./free-pool-config');
const {
  parseRoutingConfig,
  resolveRoute,
  validateConfigModels,
} = require('./routing-config');
const { buildUpstreamUrl } = require('./provider-presets');

const DEFAULT_COOLDOWN_BASE_MS = 30 * 1000;
const DEFAULT_COOLDOWN_MAX_MS = 5 * 60 * 1000;
const DEFAULT_AUTH_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getConfigId(config) {
  return config && typeof config.id === 'string' ? config.id : '';
}

function buildTargetKey(target) {
  if (!target) {
    return '';
  }

  return `${target.model}\u0000${target.protocol}`;
}

function createRoutingHealthStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const baseCooldownMs = Number.isFinite(options.baseCooldownMs)
    ? options.baseCooldownMs
    : DEFAULT_COOLDOWN_BASE_MS;
  const maxCooldownMs = Number.isFinite(options.maxCooldownMs)
    ? options.maxCooldownMs
    : DEFAULT_COOLDOWN_MAX_MS;
  const authCooldownMs = Number.isFinite(options.authCooldownMs)
    ? options.authCooldownMs
    : DEFAULT_AUTH_COOLDOWN_MS;
  const configStates = new Map();
  const targetStates = new Map();

  function configKey(configId) {
    return configId;
  }

  function targetStateKey(configId, targetKey) {
    return `${configId}\u0000${targetKey}`;
  }

  function prune(entry, timestamp) {
    if (entry && Number.isFinite(entry.until) && entry.until <= timestamp) {
      return null;
    }
    return entry || null;
  }

  function getConfigState(configId) {
    const key = configKey(configId);
    const state = prune(configStates.get(key), now());
    if (!state) {
      configStates.delete(key);
      return { status: 'ok', reason: '', until: null };
    }
    return state;
  }

  function getTargetState(configId, targetKey) {
    const state = prune(targetStates.get(targetStateKey(configId, targetKey)), now());
    if (!state) {
      return { status: 'ok', reason: '', until: null };
    }
    return state;
  }

  function isAvailable(configId, targetKey) {
    return getConfigState(configId).status === 'ok' && getTargetState(configId, targetKey).status === 'ok';
  }

  function markAuthFailure(configId, details = {}) {
    configStates.set(configKey(configId), {
      status: 'auth_failed',
      reason: normalizeString(details.reason) || 'auth_failed',
      until: now() + (Number.isFinite(details.cooldownMs) ? details.cooldownMs : authCooldownMs),
      updatedAt: now(),
    });
  }

  function markConfigCooldown(configId, details = {}) {
    configStates.set(configKey(configId), {
      status: 'cooldown', reason: normalizeString(details.reason) || 'account_rate_limited',
      until: now() + Math.min(maxCooldownMs, Number.isFinite(details.cooldownMs) ? Math.max(0, details.cooldownMs) : baseCooldownMs),
      updatedAt: now(),
    });
  }

  function markCooldown(configId, details = {}) {
    const targetKey = normalizeString(details.targetKey);
    if (!targetKey) {
      return null;
    }

    const key = targetStateKey(configId, targetKey);
    const previous = targetStates.get(key);
    const failures = (previous && Number.isFinite(previous.failures) ? previous.failures : 0) + 1;
    const exponential = Math.min(maxCooldownMs, baseCooldownMs * (2 ** (failures - 1)));
    const cooldownMs = Number.isFinite(details.cooldownMs) && details.cooldownMs >= 0
      ? Math.min(maxCooldownMs, details.cooldownMs)
      : exponential;
    const state = {
      status: 'cooldown',
      reason: normalizeString(details.reason) || 'upstream_error',
      until: now() + cooldownMs,
      updatedAt: now(),
      failures,
    };
    targetStates.set(key, state);
    return state;
  }

  function markSuccess(configId, details = {}) {
    configStates.delete(configKey(configId));
    const targetKey = normalizeString(details.targetKey);
    if (targetKey) {
      targetStates.delete(targetStateKey(configId, targetKey));
    }
  }

  function forget(configId) {
    configStates.delete(configId);
    for (const key of targetStates.keys()) {
      if (key.startsWith(`${configId}\u0000`)) targetStates.delete(key);
    }
  }

  function serialize(configId, targetKey) {
    const configState = getConfigState(configId);
    const targetState = targetKey ? getTargetState(configId, targetKey) : { status: 'ok', reason: '', until: null };
    return {
      config: configState,
      target: targetState,
    };
  }

  return {
    forget,
    getConfigState,
    getTargetState,
    isAvailable,
    markAuthFailure,
    markConfigCooldown,
    markCooldown,
    markSuccess,
    serialize,
  };
}

function createRoutingContextStore(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_CONTEXT_TTL_MS;
  const bindings = new Map();
  const accounts = new Map();
  let lifecycle = 0;
  const targetEpochs = new Map();
  let targets = new Map();
  const targetKey = (publicModel, targetId) => JSON.stringify([publicModel, targetId]);
  const epoch = (configId, publicModel, targetId) => `${lifecycle}:${accounts.get(configId) || 0}:${targetEpochs.get(targetKey(publicModel, targetId)) || 0}`;
  function prune() {
    for (const [id, binding] of bindings) if (binding.expiresAt <= now()) bindings.delete(id);
  }
  return {
    getEpoch: epoch,
    forgetResponse(responseId) { bindings.delete(normalizeString(responseId)); },
    // Keep monotonic tombstones: switching an account or target A -> B -> A
    // must not make a request from the first A current again.
    syncRoutes(parsed) {
      const next = new Map();
      for (const route of parsed.routing?.models || []) {
        for (const target of route.targets || []) next.set(targetKey(route.id, target.id), JSON.stringify([
          route.enabled !== false, (route.entry_protocols || ['responses', 'chat_completions', 'messages']).includes('responses'),
          target.config_id, target.model, target.protocol,
        ]));
      }
      for (const key of new Set([...targets.keys(), ...next.keys()])) {
        if (targets.get(key) === next.get(key)) continue;
        targetEpochs.set(key, (targetEpochs.get(key) || 0) + 1);
        for (const [id, binding] of bindings) if (targetKey(binding.public_model, binding.target_id) === key) bindings.delete(id);
      }
      targets = next;
    },
    bind(responseId, details) {
      const id = normalizeString(responseId);
      if (!id) return null;
      if (details.expected_epoch !== undefined && details.expected_epoch !== epoch(details.config_id, details.public_model, details.target_id)) return null;
      prune();
      const timestamp = now();
      const binding = { id, config_id: normalizeString(details.config_id), target_id: normalizeString(details.target_id),
        model: normalizeString(details.model), protocol: normalizeString(details.protocol), public_model: normalizeString(details.public_model),
        auth_hash: normalizeString(details.auth_hash), created_at: timestamp, expiresAt: timestamp + ttlMs };
      bindings.set(id, binding); return binding;
    },
    resolve(responseId) { prune(); return bindings.get(normalizeString(responseId)) || null; },
    forgetConfig(configId) {
      accounts.set(configId, (accounts.get(configId) || 0) + 1);
      for (const [id, binding] of bindings) if (binding.config_id === configId) bindings.delete(id);
    },
    clear() {
      lifecycle += 1;
      for (const key of new Set([...targets.keys(), ...targetEpochs.keys()])) targetEpochs.set(key, (targetEpochs.get(key) || 0) + 1);
      bindings.clear();
    },
    get size() { prune(); return bindings.size; },
  };
}

function collectCapabilities(value, found) {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCapabilities(item, found);
    }
    return;
  }

  if (!value || typeof value !== 'object') {
    return;
  }

  if (value.type === 'image' || value.type === 'input_image' || value.type === 'image_url') {
    found.images = true;
  }
  if (value.type === 'input_file' || value.type === 'file' || value.type === 'document') {
    found.files = true;
  }
  if (value.type === 'input_audio' || value.type === 'audio') {
    found.audio = true;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'image_url')) {
    found.images = true;
  }

  for (const nested of Object.values(value)) {
    collectCapabilities(nested, found);
  }
}

function detectRequestCapabilities(entryProtocol, body) {
  const payload = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const capabilities = {
    tools: false,
    images: false,
    files: false,
    audio: false,
    reasoning: false,
    structuredOutput: false,
    builtinTools: false,
    streaming: entryProtocol === 'responses' ? payload.stream !== false : payload.stream === true,
  };

  capabilities.reasoning = Boolean(
    payload.reasoning ||
    payload.thinking ||
    payload.reasoning_effort ||
    (Array.isArray(payload.include) && payload.include.some(value => String(value).includes('reasoning'))),
  );

  capabilities.storedResponse = entryProtocol === 'responses' && payload.store === true;

  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  capabilities.tools = tools.length > 0;
  capabilities.builtinTools = Boolean(payload.web_search_options || (Array.isArray(payload.plugins) && payload.plugins.some(plugin => plugin?.enabled !== false))) || tools.some(tool => {
    if (!tool || typeof tool !== 'object') {
      return false;
    }
    const type = normalizeString(tool.type);
    return Boolean(type && type !== 'function' && type !== 'custom');
  });

  if (entryProtocol === 'chat_completions') {
    capabilities.structuredOutput = Boolean(payload.response_format);
    collectCapabilities(payload.messages, capabilities);
  } else if (entryProtocol === 'responses') {
    capabilities.structuredOutput = Boolean(payload.response_format || (payload.text && payload.text.format));
    collectCapabilities(payload.input, capabilities);
  } else if (entryProtocol === 'messages') {
    capabilities.structuredOutput = Boolean(payload.output_format || (payload.output_config && payload.output_config.format));
    collectCapabilities(payload.messages, capabilities);
    collectCapabilities(payload.system, capabilities);
  }

  return capabilities;
}

function getRuntimeConfigForId(runtimeConfigs, configId) {
  if (!Array.isArray(runtimeConfigs)) {
    return null;
  }

  return runtimeConfigs.find(config => config && config.id === configId) || null;
}

function runtimeHasCredentials(runtime) {
  if (!runtime || runtime.enabled === false) {
    return false;
  }

  if (runtime.type === 'token') {
    if (runtime.credentials && typeof runtime.credentials === 'object') {
      return Boolean(runtime.credentials.agent_runtime_id || runtime.credentials.agent_private_key);
    }
    return Boolean(runtime.access_token && runtime.account_id);
  }

  if (runtime.type === 'claude_token') {
    return Boolean(runtime.access_token);
  }

  return Boolean(runtime.apiKey);
}

function getCapabilityValue(capabilities, name) {
  return capabilities && Object.prototype.hasOwnProperty.call(capabilities, name)
    ? capabilities[name]
    : undefined;
}

function checkTargetCompatibility(config, configModel, target, entryProtocol, requestCapabilities, requestBody) {
  if (!configModel.protocols.includes(target.protocol)) {
    return 'protocol_unsupported';
  }

  if (!buildUpstreamUrl(config, target.protocol)) {
    return 'protocol_endpoint_unsupported';
  }

  if (requestCapabilities.storedResponse && (target.protocol !== 'responses' || config.type !== 'apikey')) return 'capability_persistent_responses_unsupported';

  const modelCapabilities = configModel.capabilities || {};
  if (requestCapabilities.images && getCapabilityValue(modelCapabilities, 'images') === false) {
    return 'capability_images_unsupported';
  }
  if (requestCapabilities.files && getCapabilityValue(modelCapabilities, 'files') === false) {
    return 'capability_files_unsupported';
  }
  if (requestCapabilities.audio && getCapabilityValue(modelCapabilities, 'audio') === false) {
    return 'capability_audio_unsupported';
  }
  if (requestCapabilities.tools && getCapabilityValue(modelCapabilities, 'tools') === false) {
    return 'capability_tools_unsupported';
  }
  if (requestCapabilities.streaming && getCapabilityValue(modelCapabilities, 'streaming') === false) {
    return 'capability_streaming_unsupported';
  }

  if (target.protocol !== entryProtocol) {
    if (requestCapabilities.reasoning) {
      return 'capability_reasoning_requires_same_protocol';
    }
    if (requestCapabilities.structuredOutput) {
      return 'capability_structured_output_requires_same_protocol';
    }
    if (requestCapabilities.builtinTools) {
      return 'capability_builtin_tools_requires_same_protocol';
    }
    if (requestCapabilities.audio) {
      return 'capability_audio_requires_same_protocol';
    }
    if (requestCapabilities.files) {
      return 'capability_files_requires_same_protocol';
    }
  }

  if (requestBody && target.protocol !== entryProtocol) {
    try {
      require('./protocol-bridge').transformRequestForTarget({ entryProtocol, targetProtocol: target.protocol,
        body: requestBody, targetModel: target.model, stream: Boolean(requestCapabilities.streaming) });
    } catch (error) {
      if (error.name === 'UnsupportedProtocolFeatureError') return { reason: 'protocol_feature_unsupported', detail: error.message };
      throw error;
    }
  }
  return null;
}

function getEffectiveConfig(config, runtime) {
  if (!config) {
    return config;
  }

  return {
    ...config,
    type: runtime && runtime.type ? runtime.type : config.type,
    base_url: config.base_url || (runtime && runtime.baseUrl) || '',
  };
}

function createModelRouter(options = {}) {
  const getParsedConfig = typeof options.getParsedConfig === 'function'
    ? options.getParsedConfig
    : () => options.parsed || { configs: [] };
  const getRuntimeConfigs = typeof options.getRuntimeConfigs === 'function'
    ? options.getRuntimeConfigs
    : () => options.runtimeConfigs || [];
  const quotaEngine = options.quotaEngine;
  const poolEngine = options.poolEngine;
  const healthStore = options.healthStore || createRoutingHealthStore({ now: options.now });
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  let cachedParsed = null;
  let cachedRouting = null;

  function getRouting() {
    const parsed = getParsedConfig();
    if (parsed !== cachedParsed) {
      cachedParsed = parsed;
      cachedRouting = parseRoutingConfig(parsed);
    }
    return cachedRouting;
  }

  function resolve(publicModel) {
    const routing = getRouting();
    return resolveRoute({ routing }, publicModel);
  }

  function getConfigById(configId) {
    const parsed = getParsedConfig();
    return (Array.isArray(parsed.configs) ? parsed.configs : []).find(config => config.id === configId) || null;
  }

  function getConfigModel(config, modelId) {
    try {
      return validateConfigModels(config.models, { preset: config.preset }).find(model => model.id === modelId) || null;
    } catch (err) {
      return null;
    }
  }

  function getAvailability(target, entryProtocol, requestCapabilities, details = {}) {
    const config = getConfigById(target.config_id);
    if (!config) {
      return { available: false, reason: 'account_missing' };
    }
    if (config.enabled === false) {
      return { available: false, reason: 'account_disabled' };
    }

    const runtime = getRuntimeConfigForId(getRuntimeConfigs(), config.id);
    if (!runtime) {
      return { available: false, reason: 'account_runtime_missing' };
    }
    if (!runtimeHasCredentials(runtime)) {
      return { available: false, reason: 'credentials_missing' };
    }

    if (isFreePool(config) && !details.poolModel) {
      const candidates = poolEngine?.getCandidates(config, requestCapabilities || {}, details.body || {} ) || [];
      return candidates.length ? { available: true, reason: 'pool_available', probe: false }
        : { available: false, reason: 'pool_unavailable', detail: poolEngine?.serialize(config)?.error || '没有符合免费资格、能力和健康条件的模型' };
    }
    const configModel = details.poolModel || getConfigModel(config, target.model);
    if (!configModel) {
      return { available: false, reason: 'model_not_configured' };
    }

    const compatibility = checkTargetCompatibility(
      getEffectiveConfig(isFreePool(config) ? { ...config, preset: runtime.poolSourcePreset } : config, runtime),
      configModel,
      target,
      entryProtocol,
      requestCapabilities || detectRequestCapabilities(entryProtocol, {}),
      details.body,
    );
    if (compatibility) {
      return { available: false, ...(typeof compatibility === 'string' ? { reason: compatibility } : compatibility) };
    }

    if (isFreePool(config)) return { available: true, reason: 'pool_available', probe: false };

    const targetKey = buildTargetKey(target);
    const configHealth = healthStore.getConfigState(config.id);
    if (configHealth.status !== 'ok') {
      return { available: false, reason: configHealth.reason || configHealth.status, until: configHealth.until };
    }
    const targetHealth = healthStore.getTargetState(config.id, targetKey);
    if (targetHealth.status !== 'ok') {
      return { available: false, reason: 'health_cooldown', detail: targetHealth.reason, until: targetHealth.until };
    }

    if (quotaEngine) {
      const decision = quotaEngine.getDecision(config);
      if (!decision.allowed) {
        return {
          available: false,
          reason: 'quota_exhausted',
          detail: decision.reason,
          resetAt: decision.resetAt ?? null,
        };
      }
      if (decision.probe && details.skipProbe) {
        return { available: true, reason: 'quota_unknown', probe: false };
      }
      return {
        available: true,
        reason: decision.probe ? 'quota_unknown_probe' : 'ok',
        probe: Boolean(decision.probe),
      };
    }

    return { available: true, reason: 'ok', probe: false };
  }

  function select(publicModel, entryProtocol, selectionOptions = {}) {
    const route = resolve(publicModel);
    if (!route) return { lease: null, skipped: [], route: null, error: { code: 'model_not_found' } };
    if (!route.entry_protocols.includes(entryProtocol)) return { lease: null, skipped: [], route, error: { code: 'entry_protocol_not_supported' } };
    const excluded = new Set(selectionOptions.excludeTargetIds || []);
    const onlyTargetId = selectionOptions.onlyTargetId || '';
    const requestCapabilities = selectionOptions.capabilities || detectRequestCapabilities(entryProtocol, selectionOptions.body || {});
    const attempted = selectionOptions.attemptedTargetIds;
    const skipped = [];
    for (const outer of route.targets) {
      const config = getConfigById(outer.config_id);
      const pool = isFreePool(config);
      if (onlyTargetId && outer.id !== onlyTargetId) {
        skipped.push({ target_id: outer.id, reason: 'context_bound_to_other_target' }); continue;
      }
      // An outer pool consumes one normal route attempt. Its bounded concrete
      // candidates may retry inside that slot; no later outer slot is unlocked.
      if (attempted && attempted.size >= getMaxAttempts(route) && !(pool && attempted.has(outer.id))) continue;
      if (excluded.has(outer.id)) continue;
      const poolUsed = pool ? [...excluded].filter(id => {
        try { const value = JSON.parse(id); return Array.isArray(value) && value[0] === outer.id; } catch (_) { return false; }
      }).length : 0;
      const models = pool ? (poolEngine?.getCandidates(config, requestCapabilities, selectionOptions.body || {}) || []).filter(model => !excluded.has(JSON.stringify([outer.id, model.id]))).slice(0, Math.max(0, normalizePoolOptions(config.pool).max_attempts - poolUsed)) : [null];
      if (!models.length) skipped.push({ target_id: outer.id, config_id: outer.config_id, model: outer.model, protocol: outer.protocol, reason: 'pool_unavailable' });
      for (const model of models) {
        const target = model ? { ...outer, id: JSON.stringify([outer.id, model.id]), model: model.id, pool_target_id: outer.id } : outer;
        if (excluded.has(target.id)) continue;
        const availability = getAvailability(target, entryProtocol, requestCapabilities, { poolModel: model, body: selectionOptions.body });
        if (!availability.available) {
          skipped.push({ target_id: outer.id, config_id: outer.config_id, model: target.model, protocol: target.protocol,
            reason: availability.reason, detail: availability.detail || null, until: availability.until ?? null }); continue;
        }
        let releaseProbe = null;
        if (availability.probe && quotaEngine) {
          releaseProbe = quotaEngine.acquireProbe(outer.config_id);
          if (!releaseProbe) { skipped.push({ target_id: outer.id, config_id: outer.config_id, model: outer.model, protocol: outer.protocol, reason: 'quota_probe_in_flight' }); continue; }
        }
        const runtime = getRuntimeConfigForId(getRuntimeConfigs(), outer.config_id);
        let released = false;
        const started = now();
        const fingerprint = pool ? poolEngine.fingerprint?.(config) : null;
        const lease = {
          route, target, config, runtime, poolModel: model, pool: pool,
          outerTargetId: outer.id, startedAt: started, poolFingerprint: fingerprint,
          probe: Boolean(availability.probe),
          isCurrent: () => pool ? (!poolEngine.isCurrent || poolEngine.isCurrent(config, fingerprint))
            : (!quotaEngine?.isCurrentConfig || quotaEngine.isCurrentConfig(config)),
          release() { if (released) return; released = true; if (releaseProbe) { releaseProbe(); releaseProbe = null; } },
        };
        return { lease, skipped, route, error: null };
      }
    }
    return { lease: null, skipped, route, error: { code: 'no_available_upstream' } };
  }

  function markSuccess(lease) {
    if (!lease || !lease.config) {
      return;
    }
    if (lease.pool) { if (lease.isCurrent()) poolEngine.recordSuccess(lease.config, lease.poolModel, now() - lease.startedAt); return; }
    if (quotaEngine && quotaEngine.isCurrentConfig && !quotaEngine.isCurrentConfig(lease.config)) return;
    healthStore.markSuccess(lease.config.id, { targetKey: buildTargetKey(lease.target) });
    if (lease.probe && quotaEngine && typeof quotaEngine.recordProbeSuccess === 'function') {
      quotaEngine.recordProbeSuccess(lease.config.id, { reason: 'probe_success' });
    }
  }

  function markFailure(lease, details = {}) {
    if (['unsupported_protocol_feature', 'upstream_response_not_representable'].includes(details.errorCode || details.code || details.reason)) return;
    if (!lease || !lease.config) {
      return;
    }

    const config = lease.config;
    if (lease.pool) { if (lease.isCurrent()) poolEngine.recordFailure(config, lease.poolModel, details); return; }
    if (quotaEngine && quotaEngine.isCurrentConfig && !quotaEngine.isCurrentConfig(config)) return;
    const target = lease.target;
    const targetKey = buildTargetKey(target);
    const statusCode = Number(details.statusCode);
    const errorCode = normalizeString(details.errorCode).toLowerCase();
    const errorText = normalizeString(details.message).toLowerCase();
    const metadata = details.metadata && typeof details.metadata === 'object' ? details.metadata : {};
    const limitSource = normalizeString(metadata.limit_source || metadata.limitSource).toLowerCase();
    const isInFlightBudget = limitSource === 'openrouter_in_flight_budget' ||
      /openrouter_in_flight_budget|in.?flight.?budget/.test(`${errorCode} ${errorText}`);
    const isClientRejection = statusCode === 400 || statusCode === 413 || statusCode === 422 || statusCode === 405 ||
      /invalid_request|invalid_argument|invalid_prompt|content_policy|policy_violation|context_length|string_too_long/.test(`${errorCode} ${errorText}`);

    if (isClientRejection) {
      // A bad request or policy rejection says nothing about account health or
      // quota; do not cool down or disable a healthy upstream.
      return;
    }

    if (isInFlightBudget) {
      healthStore.markCooldown(config.id, {
        targetKey,
        reason: 'openrouter_in_flight_budget',
        cooldownMs: Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : undefined,
      });
      return;
    }

    const quotaFailure = statusCode === 402 ||
      /insufficient_quota|quota_exceeded|quota_exhausted|insufficient_balance|billing|usage_limit_reached|usage_not_included/.test(`${errorCode} ${errorText}`);

    if (quotaFailure && quotaEngine) {
      const retryAfterMs = Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : undefined;
      quotaEngine.markExhausted(config.id, {
        reason: details.reason || 'upstream_quota_exhausted',
        resetAt: retryAfterMs ? now() + retryAfterMs : undefined,
        source: 'business_error',
      });
      return;
    }

    if (statusCode === 401 || /auth|unauthorized|invalid.?key|invalid_token/.test(`${errorCode} ${errorText}`)) {
      healthStore.markAuthFailure(config.id, {
        reason: details.reason || 'auth_failed',
        cooldownMs: details.authCooldownMs,
      });
      return;
    }

    if (statusCode === 403) {
      healthStore.markCooldown(config.id, {
        targetKey,
        reason: 'permission_denied',
        cooldownMs: Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : 60 * 1000,
      });
      return;
    }

    if (statusCode === 404) {
      healthStore.markCooldown(config.id, {
        targetKey,
        reason: 'model_unavailable',
        cooldownMs: 10 * 60 * 1000,
      });
      return;
    }

    if (statusCode === 429 || /rate.?limit|too.?many.?requests/.test(`${errorCode} ${errorText}`)) {
      healthStore.markCooldown(config.id, {
        targetKey,
        reason: 'rate_limited',
        cooldownMs: Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : undefined,
      });
      return;
    }

    healthStore.markCooldown(config.id, {
      targetKey,
      reason: details.reason || (statusCode >= 500 ? 'upstream_5xx' : 'upstream_error'),
      cooldownMs: Number.isFinite(details.retryAfterMs) ? details.retryAfterMs : undefined,
    });
  }

  function getMaxAttempts(route) {
    if (!route || !Array.isArray(route.targets) || route.targets.length === 0) {
      return 0;
    }

    const routing = getRouting();
    const configured = Number.isInteger(route.max_attempts)
      ? route.max_attempts
      : Number.isInteger(routing && routing.max_attempts)
        ? routing.max_attempts
        : 3;
    return Math.max(1, Math.min(configured, route.targets.length));
  }

  function describeRoute(route, entryProtocol) {
    if (!route) {
      return null;
    }

    let selected = false;
    const targets = route.targets.map(target => {
      const availability = route.entry_protocols.includes(entryProtocol)
        ? getAvailability(target, entryProtocol, detectRequestCapabilities(entryProtocol, {}), { skipProbe: true })
        : { available: false, reason: 'entry_protocol_not_supported' };
      const isSelected = !selected && availability.available;
      if (isSelected) {
        selected = true;
      }
      const config = getConfigById(target.config_id);
      const runtime = getRuntimeConfigForId(getRuntimeConfigs(), target.config_id);
      return {
        target_id: target.id,
        config_id: target.config_id,
        account_label: config ? config.description || config.id : null,
        account_preset: config ? config.preset || null : null,
        model: target.model,
        protocol: target.protocol,
        available: availability.available,
        selected: isSelected,
        reason: availability.reason,
        detail: availability.detail || null,
        until: availability.until ?? null,
        quota: quotaEngine && config ? quotaEngine.serialize(config) : null,
        health: healthStore.serialize(target.config_id, buildTargetKey(target)),
        runtime_model_count: runtime && Array.isArray(runtime.models) ? runtime.models.length : 0,
      };
    });

    return {
      id: route.id,
      enabled: route.enabled !== false,
      entry_protocols: [...route.entry_protocols],
      targets,
    };
  }

  return {
    resolve,
    poolEngine,
    getConfig: getConfigById,
    select,
    markSuccess,
    markFailure,
    getMaxAttempts,
    describeRoute,
    getAvailability,
    healthStore,
  };
}

module.exports = {
  DEFAULT_COOLDOWN_BASE_MS,
  DEFAULT_COOLDOWN_MAX_MS,
  DEFAULT_AUTH_COOLDOWN_MS,
  DEFAULT_CONTEXT_TTL_MS,
  createRoutingHealthStore,
  createRoutingContextStore,
  detectRequestCapabilities,
  createModelRouter,
  buildTargetKey,
  runtimeHasCredentials,
};
