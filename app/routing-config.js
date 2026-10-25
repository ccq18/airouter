const { isFreePool, FREE_MODEL } = require('./free-pool-config');
const crypto = require('node:crypto');
const { getProviderPreset } = require('./provider-presets');

const ROUTING_SCHEMA_VERSION = 2;
const SUPPORTED_ENTRY_PROTOCOLS = ['chat_completions', 'responses', 'messages'];
const DEFAULT_ENTRY_PROTOCOLS = [...SUPPORTED_ENTRY_PROTOCOLS];
const MAX_PUBLIC_MODEL_ID_LENGTH = 200;
const DEFAULT_MAX_ATTEMPTS = 3;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateIdentifier(value, label, options = {}) {
  const raw = typeof value === 'string' ? value : '';
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${label}必须是非空字符串`);
  }

  if (raw !== trimmed && options.rejectOuterWhitespace !== false) {
    throw new Error(`${label}不能包含首尾空格`);
  }

  if (trimmed.length > MAX_PUBLIC_MODEL_ID_LENGTH) {
    throw new Error(`${label}不能超过 ${MAX_PUBLIC_MODEL_ID_LENGTH} 个字符`);
  }

  return trimmed;
}

function normalizeProtocols(value, fallback = []) {
  const source = typeof value === 'undefined' || value === null ? fallback : value;
  if (!Array.isArray(source)) {
    throw new Error('模型协议必须是字符串数组');
  }

  const protocols = [];
  for (const item of source) {
    const protocol = normalizeString(item);
    if (!SUPPORTED_ENTRY_PROTOCOLS.includes(protocol)) {
      throw new Error('模型协议仅支持 chat_completions、responses、messages');
    }
    if (!protocols.includes(protocol)) {
      protocols.push(protocol);
    }
  }

  return protocols;
}

function validatePositiveInteger(value, label) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) {
    throw new Error(`${label} 必须是正整数`);
  }

  return numeric;
}

function validateCapabilities(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (!isPlainObject(value)) {
    throw new Error('模型 capabilities 必须是对象');
  }

  const capabilities = {};
  for (const [name, enabled] of Object.entries(value)) {
    if (typeof enabled !== 'boolean') {
      throw new Error(`模型 capability ${name} 必须是布尔值`);
    }
    capabilities[name] = enabled;
  }

  return capabilities;
}

function validateConfigModels(models, options = {}) {
  if (isFreePool({ preset: options.preset })) {
    if (models !== undefined && models !== null && (!Array.isArray(models) || models.length !== 1 || models[0]?.id !== 'free' || (models[0]?.protocols && (models[0].protocols.length !== 1 || models[0].protocols[0] !== 'chat_completions')))) throw new Error('免费模型池只暴露 free / chat_completions');
    return [{ ...FREE_MODEL, capabilities: {} }];
  }
  if (typeof models === 'undefined' || models === null) {
    return [];
  }

  if (!Array.isArray(models)) {
    throw new Error('configs[].models 必须是数组');
  }

  const preset = getProviderPreset(options.preset) || getProviderPreset('custom');
  const normalized = [];
  const ids = new Set();

  for (const [index, item] of models.entries()) {
    if (!isPlainObject(item)) {
      throw new Error(`configs[].models[${index}] 必须是对象`);
    }

    const id = validateIdentifier(item.id, `configs[].models[${index}] 模型 ID`);
    if (ids.has(id)) {
      throw new Error(`后端模型 ID 重复: ${id}`);
    }
    ids.add(id);

    const protocols = normalizeProtocols(item.protocols, preset.protocols);
    if (protocols.length === 0) {
      throw new Error(`后端模型 ${id} 至少需要一个协议`);
    }

    normalized.push({
      ...item,
      id,
      protocols,
      capabilities: validateCapabilities(item.capabilities),
      context_window: validatePositiveInteger(item.context_window, 'context_window'),
      max_output_tokens: validatePositiveInteger(item.max_output_tokens, 'max_output_tokens'),
    });
  }

  return normalized;
}

function normalizeTarget(target, index, routeId) {
  if (!isPlainObject(target)) {
    throw new Error(`路由 ${routeId} 的第 ${index + 1} 个候选必须是对象`);
  }

  const targetId = normalizeString(target.id) || `target_${index + 1}`;
  const configId = validateIdentifier(target.config_id, `路由 ${routeId} 候选上游账号 ID`);
  const model = validateIdentifier(target.model, `路由 ${routeId} 候选后端模型 ID`);
  // Endpoint selection belongs to the model's supported protocols and request
  // entry. Do not keep an obsolete fixed-protocol preference in runtime routes.
  const { protocol: _obsoleteProtocol, ...fields } = target;

  return {
    ...fields,
    id: targetId,
    config_id: configId,
    model,
  };
}

function parseRoutingConfig(parsed) {
  const routing = parsed && parsed.routing !== undefined ? parsed.routing : { models: [] };
  if (!isPlainObject(routing)) throw new Error('routing 必须是对象');
  if (Object.hasOwn(routing, 'mode')) throw new Error('routing.mode 已移除；只支持统一模型路由');

  const rawModels = routing.models === undefined ? [] : routing.models;
  if (!Array.isArray(rawModels)) {
    throw new Error('routing.models 必须是数组');
  }

  const configById = new Map();
  for (const config of Array.isArray(parsed.configs) ? parsed.configs : []) {
    if (config && typeof config.id === 'string' && config.id) {
      configById.set(config.id, config);
    }
  }

  const models = [];
  const publicIds = new Set();
  for (const [modelIndex, rawModel] of rawModels.entries()) {
    if (!isPlainObject(rawModel)) {
      throw new Error(`routing.models[${modelIndex}] 必须是对象`);
    }

    const id = validateIdentifier(rawModel.id, `routing.models[${modelIndex}] 客户端模型 ID`);
    if (publicIds.has(id)) {
      throw new Error(`客户端模型 ID 重复: ${id}`);
    }
    publicIds.add(id);

    const entryProtocols = normalizeProtocols(rawModel.entry_protocols, DEFAULT_ENTRY_PROTOCOLS);
    if (entryProtocols.length === 0) {
      throw new Error(`客户端模型 ${id} 至少需要一个人口协议`);
    }

    if (!Array.isArray(rawModel.targets) || rawModel.targets.length === 0) {
      throw new Error(`客户端模型 ${id} 至少需要一个路由候选`);
    }

    const targets = [];
    const targetKeys = new Set();
    const reservedTargetIds = new Set(rawModel.targets.map(target => normalizeString(target && target.id)).filter(Boolean));
    const targetIds = new Set();
    for (const [targetIndex, rawTarget] of rawModel.targets.entries()) {
      const target = normalizeTarget(rawTarget, targetIndex, id);
      const explicitTargetId = normalizeString(rawTarget && rawTarget.id);

      if (explicitTargetId && targetIds.has(explicitTargetId)) {
        throw new Error(`客户端模型 ${id} 的路由候选 ID 重复: ${explicitTargetId}`);
      }

      if (!explicitTargetId) {
        let suffix = 1;
        while (targetIds.has(`target_${suffix}`) || reservedTargetIds.has(`target_${suffix}`)) {
          suffix += 1;
        }
        target.id = `target_${suffix}`;
      }
      targetIds.add(target.id);

      const config = configById.get(target.config_id);
      if (!config) {
        throw new Error(`客户端模型 ${id} 引用的上游账号不存在: ${target.config_id}`);
      }

      const configModels = validateConfigModels(config.models, { preset: config.preset });
      const configModel = configModels.find(item => item.id === target.model);
      if (!configModel) {
        throw new Error(`客户端模型 ${id} 引用的后端模型不存在: ${target.model}`);
      }

      const key = `${target.config_id}\u0000${target.model}`;
      if (targetKeys.has(key)) {
        throw new Error(`客户端模型 ${id} 包含重复候选: ${target.config_id}/${target.model}`);
      }
      targetKeys.add(key);

      targets.push(target);
    }

    models.push({
      ...rawModel,
      id,
      enabled: rawModel.enabled !== false,
      entry_protocols: entryProtocols,
      targets,
    });
  }

  const maxAttempts = routing.max_attempts === undefined
    ? DEFAULT_MAX_ATTEMPTS
    : Number(routing.max_attempts);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('routing.max_attempts 必须是正整数');
  }

  return {
    ...routing,
    max_attempts: maxAttempts,
    models,
  };
}

function getPublicModelIds(parsed, options = {}) {
  const routing = parsed && parsed.routing;
  if (!isPlainObject(routing) || !Array.isArray(routing.models)) {
    return [];
  }

  return routing.models
    .filter(model => model && model.enabled !== false)
    .map(model => normalizeString(model.id))
    .filter(Boolean)
    .filter((id, index, list) => list.indexOf(id) === index);
}

function resolveRoute(parsed, publicModel) {
  if (typeof publicModel !== 'string' || !publicModel) {
    return null;
  }

  const routing = parsed && parsed.routing;
  if (!isPlainObject(routing) || !Array.isArray(routing.models)) {
    return null;
  }

  // Exact, case-sensitive match. No global alias or claude_code override applies.
  return routing.models.find(model => model && model.enabled !== false && model.id === publicModel) || null;
}

function findRoutesReferencingModel(parsed, configId, modelId, options = {}) {
  const routing = parsed && parsed.routing;
  if (!isPlainObject(routing) || !Array.isArray(routing.models)) {
    return [];
  }

  const includeDisabled = options.includeDisabled === true;
  const affected = [];
  for (const model of routing.models) {
    if (!model || (!includeDisabled && model.enabled === false) || !Array.isArray(model.targets)) {
      continue;
    }

    if (model.targets.some(target => target.config_id === configId && target.model === modelId)) {
      affected.push(model.id);
    }
  }

  return affected;
}

function getRoutingRevision(parsed) {
  const configs = Array.isArray(parsed && parsed.configs) ? parsed.configs : [];
  const relevant = {
    routing: parsed && parsed.routing ? {
      max_attempts: parsed.routing.max_attempts ?? null,
      models: Array.isArray(parsed.routing.models) ? parsed.routing.models : [],
    } : null,
    configs: configs.map(config => ({
      id: config && config.id,
      preset: config && config.preset,
      type: config && config.type,
      enabled: config && config.enabled !== false,
      base_url: config && config.base_url,
      protocol_paths: config && config.protocol_paths ? config.protocol_paths : null,
      models: Array.isArray(config && config.models) ? config.models : [],
    })),
  };

  return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 16);
}

function createConfigId(existingIds = new Set(), generateId = null) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = generateId
      ? generateId()
      : `cfg_${crypto.randomBytes(8).toString('hex')}`;
    if (typeof candidate === 'string' && candidate && !existingIds.has(candidate)) {
      return candidate;
    }
  }

  throw new Error('无法生成唯一的上游账号 ID');
}

function ensureConfigIds(parsed, options = {}) {
  if (!parsed || !Array.isArray(parsed.configs)) {
    return {
      parsed,
      changed: false,
    };
  }

  const generateId = typeof options.generateId === 'function' ? options.generateId : null;
  const existingIds = new Set();
  let changed = false;

  function processItems(items) {
    const nextItems = [];
    for (const config of items) {
      const item = config && typeof config === 'object' && !Array.isArray(config)
        ? { ...config }
        : config;
      const currentId = item && typeof item.id === 'string' ? item.id.trim() : '';

      if (!currentId || existingIds.has(currentId)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          nextItems.push(item);
          continue;
        }

        item.id = createConfigId(existingIds, generateId);
        changed = true;
      } else if (currentId !== item.id) {
        item.id = currentId;
        changed = true;
      }

      if (item && typeof item.id === 'string') {
        existingIds.add(item.id);
      }
      nextItems.push(item);
    }
    return nextItems;
  }

  const nextConfigs = processItems(parsed.configs);

  return {
    parsed: changed
      ? {
        ...parsed,
        configs: nextConfigs,
      }
      : parsed,
    changed,
  };
}

module.exports = {
  ROUTING_SCHEMA_VERSION,
  SUPPORTED_ENTRY_PROTOCOLS,
  DEFAULT_ENTRY_PROTOCOLS,
  MAX_PUBLIC_MODEL_ID_LENGTH,
  DEFAULT_MAX_ATTEMPTS,
  isPlainObject,
  normalizeString,
  validateIdentifier,
  normalizeProtocols,
  validateConfigModels,
  parseRoutingConfig,
  getPublicModelIds,
  resolveRoute,
  findRoutesReferencingModel,
  getRoutingRevision,
  ensureConfigIds,
  createConfigId,
};
