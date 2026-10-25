const { parseSub2ApiUsage } = require('./sub2api-quota');
/**
 * Built-in upstream provider presets.
 *
 * The preset data is intentionally data-only: it describes default addresses,
 * model discovery and quota endpoints, but never decides routing priority.
 * Routing priority always comes from the explicit model route target order.
 */

const PROTOCOL_NAMES = ['chat_completions', 'responses', 'messages'];

const PROVIDER_PRESETS = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT / Codex',
    credential: 'token',
    default_type: 'token',
    default_base_url: 'https://chatgpt.com',
    protocols: ['responses'],
    protocolPaths: {
      chat_completions: null,
      responses: '/backend-api/codex/responses',
      messages: null,
    },
    discovery: {
      supported: true,
      path: '/backend-api/codex/models',
      auth: 'token',
      parser: 'openai-models',
      headers: {
        version: '0.0.1',
        originator: 'codex_cli_rs',
      },
    },
    quota: {
      url: 'https://chatgpt.com/backend-api/wham/usage',
      auth: 'token',
      parser: 'chatgpt',
    },
    notes: 'ChatGPT/Codex 登录态只提供原生 Responses 链路，其他入口会跳过此上游。',
  },
  'opencode-go': {
    id: 'opencode-go',
    label: 'OpenCode Go',
    credential: 'apikey',
    default_type: 'apikey',
    default_base_url: 'https://opencode.ai/inference/go',
    protocols: [...PROTOCOL_NAMES],
    protocolPaths: {
      chat_completions: '/openai/v1/chat/completions',
      responses: '/openai/v1/responses',
      messages: '/anthropic/v1/messages',
    },
    discovery: {
      supported: true,
      path: '/v1/models',
      auth: 'bearer',
      parser: 'openai-models',
    },
    quota: {
      url: 'https://opencode.ai/zen/go/v1/usage',
      auth: 'bearer',
      parser: 'opencode-go',
    },
    notes: '模型发现必须使用 Go 专用 /inference/go/v1/models，不能使用通用 /inference/v1/models。',
  },
  'opencode-zen': {
    id: 'opencode-zen',
    label: 'OpenCode Zen',
    credential: 'apikey',
    default_type: 'apikey',
    default_base_url: 'https://opencode.ai/inference',
    protocols: [...PROTOCOL_NAMES],
    protocolPaths: {
      chat_completions: '/openai/v1/chat/completions',
      responses: '/openai/v1/responses',
      messages: '/anthropic/v1/messages',
    },
    discovery: {
      supported: true,
      path: '/v1/models',
      auth: 'bearer',
      parser: 'openai-models',
    },
    quota: {
      supported: false,
      reason: 'OpenCode Zen 的普通推理 Key 余额查询端点尚未核实；额度状态保持未知，不会伪造为 0。',
    },
    notes: 'Zen 不使用 /go 路径段。',
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    credential: 'apikey',
    default_type: 'apikey',
    default_base_url: 'https://openrouter.ai/api/v1',
    protocols: ['chat_completions'],
    protocolPaths: {
      chat_completions: '/chat/completions',
      responses: '/responses',
      messages: null,
    },
    discovery: {
      supported: true,
      path: '/models',
      auth: 'bearer',
      parser: 'openai-models',
    },
    quota: {
      url: 'https://openrouter.ai/api/v1/key',
      auth: 'bearer',
      parser: 'openrouter-key',
    },
    notes: '模型列表无需鉴权即可读取，因此列表成功不能证明 Key 有效；额度只读取当前 Key 限额，不要求管理 Key。',
  },
  'glm-cn': {
    id: 'glm-cn',
    label: 'GLM Coding Plan 中国',
    credential: 'apikey',
    default_type: 'apikey',
    default_base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    protocols: ['chat_completions', 'messages'],
    // https://docs.bigmodel.cn/cn/coding-plan/tool/claude
    protocolBaseUrls: { messages: 'https://open.bigmodel.cn/api/anthropic' },
    protocolPaths: {
      chat_completions: '/chat/completions',
      responses: null,
      messages: '/v1/messages',
    },
    discovery: {
      supported: true,
      path: '/models',
      auth: 'bearer',
      parser: 'openai-models',
    },
    quota: {
      url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
      auth: 'raw',
      parser: 'glm',
    },
    notes: 'TIME_LIMIT 是 MCP 月度工具额度，不作为模型推理额度；TOKENS_LIMIT 才是模型 5 小时窗口。',
  },
  'glm-global': {
    id: 'glm-global',
    label: 'GLM Coding Plan 国际',
    credential: 'apikey',
    default_type: 'apikey',
    default_base_url: 'https://api.z.ai/api/coding/paas/v4',
    protocols: ['chat_completions', 'messages'],
    // https://docs.z.ai/devpack/tool/claude
    protocolBaseUrls: { messages: 'https://api.z.ai/api/anthropic' },
    protocolPaths: {
      chat_completions: '/chat/completions',
      responses: null,
      messages: '/v1/messages',
    },
    discovery: {
      supported: true,
      path: '/models',
      auth: 'bearer',
      parser: 'openai-models',
    },
    quota: {
      url: 'https://api.z.ai/api/monitor/usage/quota/limit',
      auth: 'raw',
      parser: 'glm',
    },
    notes: 'Z.ai 国际站额度地址与 Coding Plan 模型地址不同，分别使用 api.z.ai 的 monitor 与 coding 路径。',
  },
  claude: {
    id: 'claude',
    label: 'Claude OAuth',
    credential: 'token',
    default_type: 'claude_token',
    default_base_url: 'https://api.anthropic.com',
    protocols: ['messages'],
    protocolPaths: {
      chat_completions: null,
      responses: null,
      messages: '/v1/messages',
    },
    discovery: {
      supported: true,
      path: '/v1/models',
      auth: 'token',
      parser: 'openai-models',
      headers: {
        'anthropic-version': '2023-06-01',
      },
    },
    quota: {
      supported: false,
      reason: 'Claude OAuth 余额端点不在本期统一额度范围内；额度保持未知。',
    },
    notes: 'Claude OAuth 使用原生 Messages 链路。',
  },
  custom: {
    id: 'custom',
    label: '自定义接口',
    credential: 'apikey',
    default_type: 'apikey',
    default_base_url: '',
    protocols: ['chat_completions'],
    protocolPaths: {
      chat_completions: '/chat/completions',
      responses: '/responses',
      messages: '/messages',
    },
    discovery: {
      supported: true,
      custom: true,
      auth: 'bearer',
      parser: 'openai-models',
    },
    quota: {
      supported: false,
      reason: '自定义接口未配置额度查询能力；额度保持未知，不会伪造为 0。',
    },
    notes: '只有自定义接口需要填写模型列表地址；其它内置平台由系统内置地址和鉴权。',
  },
};

// Pools are upstreams with one stable model. Concrete models are maintained by
// free-pool-engine; these presets do not impose outer routing priority.
for (const [id, parent, label] of [
  ['opencode-free', 'opencode-go', 'OpenCode 免费模型池'],
  ['openrouter-free', 'openrouter', 'OpenRouter 免费模型池'],
]) {
  const source = PROVIDER_PRESETS[parent];
  PROVIDER_PRESETS[id] = {
    ...source, id, label, pool: true, protocols: ['chat_completions'],
    quota: { supported: false, reason: '免费池按具体模型权限和免费限流判断，不使用付费套餐额度。' },
    notes: '固定模型 ID free；内部目录自动维护，质量使用透明分级与近期成功率、速度。',
  };
}

PROVIDER_PRESETS.sub2api = {
  id: 'sub2api', label: 'Sub2API 中转站', credential: 'apikey', default_type: 'apikey',
  default_base_url: '', protocols: [...PROTOCOL_NAMES],
  protocolPaths: { chat_completions: '/chat/completions', responses: '/responses', messages: '/messages' },
  discovery: { supported: true, path: '/models', auth: 'bearer', parser: 'openai-models' },
  quota: { path: '/usage', auth: 'bearer', parser: 'sub2api' },
  notes: '填站点根网址或 /v1；同一 Key 同步模型和读取钱包/订阅/Key 金额。协议取决于站点分组。',
};

function normalizeSub2ApiBaseUrl(value) {
  const url = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Sub2API 地址须为不含凭证、查询参数的 HTTP(S) 站点或 /v1 地址');
  const root = url.pathname.replace(/\/+$/, '');
  url.pathname = root.endsWith('/v1') ? root : `${root}/v1`;
  return url.toString().replace(/\/+$/, '');
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getProviderPreset(id) {
  const normalized = normalizeString(id) || 'custom';
  return PROVIDER_PRESETS[normalized] || null;
}

function listProviderPresets() {
  return Object.values(PROVIDER_PRESETS).map(preset => ({
    id: preset.id,
    pool: Boolean(preset.pool),
    label: preset.label,
    credential: preset.credential,
    default_type: preset.default_type,
    default_base_url: preset.default_base_url,
    protocols: [...preset.protocols],
    discovery_supported: Boolean(preset.discovery && preset.discovery.supported),
    quota_supported: Boolean(preset.quota && preset.quota.supported !== false),
    notes: preset.notes,
  }));
}

function resolvePresetForConfig(config) {
  return getProviderPreset(config && config.preset) || PROVIDER_PRESETS.custom;
}

function trimTrailingSlashes(value) {
  return String(value || '').replace(/\/+$/, '');
}

function joinUrl(baseUrl, path) {
  const base = trimTrailingSlashes(baseUrl);
  const suffix = normalizeString(path);
  if (!suffix) {
    return base;
  }

  if (/^https?:\/\//i.test(suffix)) {
    return suffix;
  }

  return `${base}${suffix.startsWith('/') ? '' : '/'}${suffix}`;
}

function getProtocolPath(config, protocol) {
  if (!PROTOCOL_NAMES.includes(protocol)) {
    return null;
  }

  const explicitPaths = config && config.protocol_paths && typeof config.protocol_paths === 'object'
    ? config.protocol_paths
    : null;
  if (explicitPaths && Object.prototype.hasOwnProperty.call(explicitPaths, protocol)) {
    const explicitPath = normalizeString(explicitPaths[protocol]);
    return explicitPath || null;
  }

  if (config && config.type === 'claude_token') {
    return protocol === 'messages' ? '/v1/messages' : null;
  }

  const preset = resolvePresetForConfig(config);
  if (preset.id === 'custom' && explicitPaths && Object.keys(explicitPaths).length > 0) {
    // Custom providers are explicit-only: do not silently invent an endpoint
    // that the operator did not configure.
    return null;
  }
  const path = preset.protocolPaths[protocol];

  if (protocol === 'messages' && config && config.type === 'apikey' && config.support && Array.isArray(config.support) && !config.support.includes('claude')) {
    // Legacy apikey support does not gate explicit routing; explicit target
    // protocol is authoritative. Keep this branch for clarity only.
  }

  return path || null;
}

function buildUpstreamUrl(config, protocol, options = {}) {
  const preset = resolvePresetForConfig(config);
  const rawBase = options.baseUrl || (config && config.base_url) || preset.default_base_url;
  let baseUrl = config?.preset === 'sub2api' ? normalizeSub2ApiBaseUrl(rawBase) : normalizeString(rawBase);
  const explicitPath = config?.protocol_paths && Object.prototype.hasOwnProperty.call(config.protocol_paths, protocol);
  // Alternate built-in bases only apply to an unchanged official default.
  // A relay/custom base or explicit endpoint always stays under user control.
  if (!explicitPath && trimTrailingSlashes(baseUrl) === trimTrailingSlashes(preset.default_base_url) && preset.protocolBaseUrls?.[protocol]) baseUrl = preset.protocolBaseUrls[protocol];
  const path = getProtocolPath(config, protocol);
  if (!baseUrl || !path) {
    return null;
  }

  return joinUrl(baseUrl, path);
}

function buildAuthHeaderShape(config, preset) {
  if (!config) {
    return {};
  }

  if (config.type === 'token' || preset.credential === 'token') {
    return {
      authorization: `Bearer ${normalizeString(config.access_token)}`,
      'chatgpt-account-id': normalizeString(config.account_id),
    };
  }

  return {
    authorization: `Bearer ${normalizeString(config.apikey)}`,
  };
}

function buildUpstreamAuthHeaders(config, options = {}) {
  const preset = resolvePresetForConfig(config);
  const headers = buildAuthHeaderShape(config, preset);
  headers['content-type'] = 'application/json';
  headers.accept = options.stream ? 'text/event-stream' : 'application/json';

  if (config && config.type === 'token') {
    headers.version = normalizeString(options.clientVersion) || '0.0.1';
    headers.originator = 'codex_cli_rs';
  }

  for (const [name, value] of Object.entries(headers)) {
    if (!value) {
      delete headers[name];
    }
  }

  return headers;
}

function buildDiscoveryRequest(config) {
  const preset = resolvePresetForConfig(config);
  let url = '';

  if (preset.discovery && preset.discovery.custom) {
    const endpoint = normalizeString(config && config.models_endpoint);
    if (!endpoint) {
      throw new Error('自定义上游需要配置模型列表地址');
    }
    url = joinUrl(config.base_url, endpoint);
  } else if (preset.discovery && preset.discovery.supported) {
    url = joinUrl(preset.default_base_url || config.base_url, preset.discovery.path);
    // Preserve a user-provided regional/custom base URL for the same preset.
    if (normalizeString(config.base_url)) {
      url = joinUrl(preset.id === 'sub2api' ? normalizeSub2ApiBaseUrl(config.base_url) : config.base_url, preset.discovery.path);
    }
  } else {
    throw new Error(preset.discovery && preset.discovery.reason
      ? preset.discovery.reason
      : '当前供应商不支持模型列表同步');
  }

  if (!/^https?:\/\//i.test(url)) {
    throw new Error('上游模型列表地址无效');
  }

  const auth = preset.discovery && preset.discovery.auth === 'none'
    ? {}
    : buildAuthHeaderShape(config, preset);
  const usesTokenCredential = Boolean(
    config && (config.type === 'token' || config.type === 'claude_token' || preset.credential === 'token'),
  );
  if (usesTokenCredential && !normalizeString(config && config.access_token)) {
    throw new Error('token 配置缺少 access_token');
  }
  if (!usesTokenCredential && !normalizeString(config && config.apikey)) {
    throw new Error('apikey 配置缺少 API Key');
  }

  const headers = {
    ...auth,
    ...(preset.discovery && preset.discovery.headers ? preset.discovery.headers : {}),
  };
  for (const [name, value] of Object.entries(headers)) {
    if (!value) {
      delete headers[name];
    }
  }

  return {
    url,
    headers,
  };
}

function parseModelsResponse(payload) {
  return parseModelCatalog(payload, { preset: 'custom' }).map(model => model.id);
}

function protocolFromValue(value) {
  const text = normalizeString(value).toLowerCase();
  if (PROTOCOL_NAMES.includes(text)) {
    return text;
  }
  if (text.endsWith('/chat/completions') || text === 'chat' || text === 'openai' || text === 'openai-completions') {
    return 'chat_completions';
  }
  if (text.endsWith('/responses') || text === 'openai-responses' || text === 'responses-api') {
    return 'responses';
  }
  if (text.endsWith('/messages') || text === 'anthropic' || text === 'claude' || text === 'anthropic-messages') {
    return 'messages';
  }
  return null;
}

function defaultProtocolsForModelId(id) {
  const normalized = normalizeString(id).toLowerCase();
  if (!normalized) {
    return ['chat_completions'];
  }

  if (/^(claude|anthropic)[/-]/.test(normalized)) {
    return ['messages'];
  }

  if (/^(gpt-|o[1-9](-|$)|codex-|openai\/)/.test(normalized)) {
    return ['responses'];
  }

  // GLM, DeepSeek, Qwen, Kimi, Grok and most OpenAI-compatible catalogs use
  // the Chat Completions native path.
  return ['chat_completions'];
}

function deriveProtocols(item, preset) {
  const metadata = [];
  const sources = [
    item.protocols,
    item.protocol,
    item.supported_endpoints,
    item.supportedEndpoints,
    item.native_protocol,
    item.api_protocol,
    item.api,
  ];

  for (const source of sources) {
    if (Array.isArray(source)) {
      for (const value of source) {
        const protocol = protocolFromValue(value);
        if (protocol && !metadata.includes(protocol)) {
          metadata.push(protocol);
        }
      }
    } else if (source !== undefined && source !== null) {
      const protocol = protocolFromValue(source);
      if (protocol && !metadata.includes(protocol)) {
        metadata.push(protocol);
      }
    }
  }

  if (!metadata.length && item.endpoints && typeof item.endpoints === 'object' && !Array.isArray(item.endpoints)) {
    for (const key of Object.keys(item.endpoints)) {
      const protocol = protocolFromValue(key);
      if (protocol && !metadata.includes(protocol)) {
        metadata.push(protocol);
      }
    }
  }

  const allowed = (preset && Array.isArray(preset.protocols) ? preset.protocols : PROTOCOL_NAMES);
  const filtered = metadata.filter(protocol => allowed.includes(protocol));
  if (metadata.length) {
    return filtered;
  }

  if (preset?.id === 'sub2api') {
    // A key's group controls supported protocols. These are conservative native
    // suggestions when the station catalog has no explicit endpoint metadata.
    const owner = normalizeString(item.owned_by).toLowerCase();
    if (owner === 'anthropic' || /^claude/i.test(item.id || '')) return ['messages'];
    if (owner === 'openai' || /^(gpt|codex)/i.test(item.id || '')) return ['responses'];
    return ['chat_completions'];
  }
  if (preset && (preset.id === 'opencode-go' || preset.id === 'opencode-zen')) {
    // The live Go catalog currently only returns id/object/created/owned_by.
    // Derive a safe default from well-known model families instead of
    // pretending every Go model supports every endpoint.
    return defaultProtocolsForModelId(item.id).filter(protocol => allowed.includes(protocol));
  }

  if (preset && ['glm-cn', 'glm-global'].includes(preset.id)) {
    // Only the models explicitly documented for both Coding Plan interfaces
    // get this default. Unknown catalog entries remain conservative.
    // https://docs.bigmodel.cn/cn/coding-plan/latest-model
    // https://docs.z.ai/devpack/latest-model
    return /^glm-5\.3(?:-flash)?(?:\[1m\])?$/i.test(normalizeString(item.id)) ? ['chat_completions', 'messages'] : ['chat_completions'];
  }

  return [...allowed];
}

function deriveCapabilities(item) {
  const capabilities = {};
  if (item.capabilities && typeof item.capabilities === 'object' && !Array.isArray(item.capabilities)) {
    for (const [name, value] of Object.entries(item.capabilities)) {
      if (typeof value === 'boolean') {
        capabilities[name] = value;
      }
    }
  }

  if (typeof item.supports_vision === 'boolean') {
    capabilities.images = item.supports_vision;
  }
  if (Array.isArray(item.input_modalities)) {
    if (item.input_modalities.includes('image')) {
      capabilities.images = true;
    }
  }
  if (typeof item.supports_tools === 'boolean') {
    capabilities.tools = item.supports_tools;
  }
  return capabilities;
}

function parseModelCatalog(payload, configOrPreset) {
  const source = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? (Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null)
      : null;

  if (!source) {
    throw new Error('上游模型列表响应缺少 data 数组');
  }

  const preset = configOrPreset && configOrPreset.protocolPaths
    ? configOrPreset
    : resolvePresetForConfig(configOrPreset);
  const models = [];
  const ids = new Set();

  for (const item of source) {
    const id = typeof item === 'string'
      ? item.trim()
      : item && typeof item === 'object' && typeof item.id === 'string'
        ? item.id.trim()
        : '';
    if (!id || ids.has(id)) {
      continue;
    }
    ids.add(id);

    const entry = {
      id,
      protocols: typeof item === 'string' ? deriveProtocols({ id }, preset) : deriveProtocols(item, preset),
    };

    if (item && typeof item === 'object') {
      const capabilities = deriveCapabilities(item);
      if (Object.keys(capabilities).length) {
        entry.capabilities = capabilities;
      }

      const contextWindow = parseNumeric(item.context_window ?? item.context_length ?? item.max_context_length);
      if (contextWindow !== null) {
        entry.context_window = contextWindow;
      }

      const maxOutputTokens = parseNumeric(item.max_output_tokens ?? item.max_completion_tokens);
      if (maxOutputTokens !== null) {
        entry.max_output_tokens = maxOutputTokens;
      }
    }

    models.push(entry);
  }

  return models;
}

function normalizeExistingModels(models) {
  return (Array.isArray(models) ? models : [])
    .map(model => {
      if (typeof model === 'string') {
        return { id: model.trim(), protocols: [] };
      }
      if (!model || typeof model !== 'object' || typeof model.id !== 'string') {
        return null;
      }
      return {
        ...model,
        id: model.id,
        protocols: Array.isArray(model.protocols) ? [...model.protocols] : [],
      };
    })
    .filter(Boolean);
}

function diffModelCatalog(existingModels, discoveredModels) {
  const existing = normalizeExistingModels(existingModels);
  const discovered = (Array.isArray(discoveredModels) ? discoveredModels : [])
    .map(model => typeof model === 'string' ? { id: model, protocols: [] } : model)
    .filter(model => model && typeof model.id === 'string' && model.id);
  const existingIds = new Set(existing.map(model => model.id));
  const discoveredIds = new Set(discovered.map(model => model.id));

  const added = discovered.filter(model => !existingIds.has(model.id));
  const removed = existing.filter(model => !discoveredIds.has(model.id)).map(model => model.id);
  const kept = existing.filter(model => discoveredIds.has(model.id)).map(model => model.id);
  const protocolChanges = [];

  for (const local of existing) {
    const remote = discovered.find(model => model.id === local.id);
    if (!remote) {
      continue;
    }
    const localProtocols = [...local.protocols].sort();
    const remoteProtocols = [...(remote.protocols || [])].sort();
    if (JSON.stringify(localProtocols) !== JSON.stringify(remoteProtocols)) {
      protocolChanges.push({
        id: local.id,
        local_protocols: local.protocols,
        discovered_protocols: remote.protocols || [],
      });
    }
  }

  return {
    discovered,
    added,
    removed,
    kept,
    protocol_changes: protocolChanges,
    suggested_models: [...existing, ...added],
  };
}

function buildQuotaRequest(config) {
  const preset = resolvePresetForConfig(config);
  const quota = preset.quota || {};

  if (quota.supported === false || (!quota.url && !quota.path)) {
    throw new Error(quota.reason || '当前上游未配置额度查询能力');
  }

  const url = normalizeString(config && config.quota_url) || (quota.path ? joinUrl(normalizeSub2ApiBaseUrl(config.base_url), quota.path) : quota.url);
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('额度查询地址无效');
  }

  if (quota.auth === 'raw') {
    return {
      url,
      headers: {
        authorization: normalizeString(config && config.apikey),
      },
    };
  }

  if (quota.auth === 'token') {
    return {
      url,
      headers: buildAuthHeaderShape(config, preset),
    };
  }

  return {
    url,
    headers: {
      authorization: `Bearer ${normalizeString(config && config.apikey)}`,
    },
  };
}

function parseNumeric(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizePercentage(value) {
  const parsed = parseNumeric(value);
  if (parsed === null || parsed < 0 || parsed > 100) {
    return null;
  }

  return parsed;
}

function parseTimestamp(value) {
  const numeric = parseNumeric(value);
  if (numeric !== null) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function makeWindowMetric(id, options = {}) {
  const remainingPercent = options.remainingPercent === null ? null : options.remainingPercent;
  let state = options.state || 'unknown';
  if (state === 'unknown' && remainingPercent !== null) {
    state = remainingPercent <= 0 ? 'exhausted' : 'available';
  }
  const hasExplicitLimit = Object.prototype.hasOwnProperty.call(options, 'limit');
  const limit = hasExplicitLimit
    ? options.limit
    : (options.unit === 'percent' || !options.unit ? 100 : null);

  return {
    id,
    scope: 'account',
    scope_key: null,
    kind: options.kind || 'window',
    unit: options.unit || 'percent',
    remaining: options.remaining ?? remainingPercent,
    used: options.used ?? null,
    limit,
    remainingPercent,
    resetAt: options.resetAt ?? null,
    state,
    blocking: options.blocking !== false,
    evidence: options.evidence || {},
  };
}

function combineMetrics(metrics) {
  const blocking = metrics.filter(metric => metric.blocking);
  if (blocking.some(metric => metric.state === 'exhausted')) {
    return 'exhausted';
  }

  if (blocking.some(metric => metric.state === 'available')) {
    return 'available';
  }

  return 'unknown';
}

function firstResetAt(metrics) {
  const values = metrics
    .map(metric => metric.resetAt)
    .filter(value => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

function parseGlmQuota(payload) {
  if (!payload || typeof payload !== 'object') {
    return { state: 'unknown', metrics: [], reason: '额度响应不是对象' };
  }

  if (payload.success === false) {
    return { state: 'unknown', metrics: [], reason: '额度接口返回失败' };
  }

  const limits = payload.data && Array.isArray(payload.data.limits) ? payload.data.limits : null;
  if (!limits) {
    return { state: 'unknown', metrics: [], reason: '额度响应缺少 limits' };
  }

  const metrics = [];
  for (const limit of limits) {
    if (!limit || typeof limit !== 'object') {
      continue;
    }

    const type = normalizeString(limit.type).toUpperCase();
    if (type === 'TIME_LIMIT') {
      // MCP monthly tool quota, not model inference quota.
      continue;
    }

    const percentage = normalizePercentage(limit.percentage);
    const resetAt = parseTimestamp(limit.nextResetTime);
    const id = type ? type.toLowerCase() : 'unknown_limit';

    if (type === 'TOKENS_LIMIT' || (percentage !== null && type.endsWith('_LIMIT') && type !== 'CREDIT_LIMIT')) {
      metrics.push(makeWindowMetric(id, {
        kind: 'window',
        unit: 'percent',
        remainingPercent: percentage === null ? null : Math.max(0, 100 - percentage),
        used: percentage,
        limit: 100,
        resetAt,
        state: percentage === null ? 'unknown' : percentage >= 100 ? 'exhausted' : 'available',
        evidence: { type, percentage: limit.percentage },
      }));
      continue;
    }

    const remaining = parseNumeric(limit.remaining);
    const used = parseNumeric(limit.currentValue ?? limit.used ?? limit.usage);
    const limitValue = parseNumeric(limit.limit ?? limit.total ?? limit.max);
    const computedRemaining = remaining !== null
      ? remaining
      : used !== null && limitValue !== null
        ? Math.max(0, limitValue - used)
        : null;
    const percent = percentage !== null ? percentage : null;
    const remainingPercent = percent !== null
      ? Math.max(0, 100 - percent)
      : computedRemaining !== null && limitValue !== null && limitValue > 0
        ? Math.max(0, (computedRemaining / limitValue) * 100)
        : null;

    metrics.push(makeWindowMetric(id, {
      kind: type === 'CREDIT_LIMIT' ? 'credits' : 'window',
      unit: type === 'CREDIT_LIMIT' ? 'credits' : 'percent',
      remaining: computedRemaining,
      used,
      limit: limitValue,
      remainingPercent,
      resetAt,
      state: percent !== null
        ? (percent >= 100 ? 'exhausted' : 'available')
        : computedRemaining !== null
          ? (computedRemaining <= 0 ? 'exhausted' : 'available')
          : 'unknown',
      evidence: { type },
    }));
  }

  const state = combineMetrics(metrics);
  return {
    state,
    metrics,
    resetAt: firstResetAt(metrics),
    reason: state === 'unknown' ? '额度响应缺少可解释的模型额度字段' : '',
  };
}

function parseOpenCodeGoQuota(payload) {
  const usage = payload && payload.usage && typeof payload.usage === 'object' ? payload.usage : null;
  if (!usage) {
    return { state: 'unknown', metrics: [], reason: '额度响应缺少 usage' };
  }

  const metrics = [];
  for (const id of ['rolling', 'weekly', 'monthly']) {
    const window = usage[id];
    if (!window || typeof window !== 'object') {
      continue;
    }

    const percent = normalizePercentage(window.percent);
    const status = normalizeString(window.status).toLowerCase();
    const resetAt = parseTimestamp(window.resetsAt ?? window.resets_at);
    const rateLimited = /rate.?limit|exhaust|quota|blocked|limit_reached/.test(status);
    let state = 'unknown';

    if (rateLimited) {
      state = 'exhausted';
    } else if (percent !== null && percent >= 100) {
      state = 'exhausted';
    } else if (percent !== null && (status === '' || status === 'ok' || status === 'active' || status === 'available')) {
      state = 'available';
    }

    metrics.push(makeWindowMetric(id, {
      kind: 'window',
      unit: 'percent',
      remainingPercent: percent === null ? null : Math.max(0, 100 - percent),
      used: percent,
      limit: 100,
      resetAt,
      state,
      evidence: { status, percent: window.percent },
    }));
  }

  const state = combineMetrics(metrics);
  return {
    state,
    metrics,
    resetAt: firstResetAt(metrics),
    reason: state === 'unknown' ? '额度响应缺少可解释的窗口状态' : '',
  };
}

function parseBudgetMetric(id, budget, defaults = {}) {
  const effective = budget && budget.effective_budget && typeof budget.effective_budget === 'object'
    ? { ...budget, ...budget.effective_budget }
    : budget;
  const limit = parseNumeric(effective && (effective.limit_usd ?? effective.limit ?? effective.total ?? effective.max));
  const usage = parseNumeric(effective && (effective.spend_usd ?? effective.usage ?? effective.used ?? effective.currentValue));
  const providedRemaining = parseNumeric(effective && (
    effective.remaining_usd ??
    effective.limit_remaining ??
    effective.remaining ??
    effective.remaining_amount
  ));
  const remaining = providedRemaining !== null
    ? providedRemaining
    : limit !== null && usage !== null
      ? Math.max(0, limit - usage)
      : null;
  const resetAt = parseTimestamp(
    effective && (
      effective.reset_at ??
      effective.resets_at ??
      effective.resetAt ??
      effective.resetsAt ??
      effective.reset_time ??
      effective.expires_at ??
      effective.expiresAt
    )
  );
  const remainingPercent = remaining !== null && limit !== null && limit > 0
    ? Math.max(0, Math.min(100, (remaining / limit) * 100))
    : null;
  const state = remaining !== null
    ? (remaining <= 0 ? 'exhausted' : 'available')
    : 'unknown';

  return makeWindowMetric(id, {
    kind: defaults.kind || 'budget',
    unit: defaults.unit || 'USD',
    remaining,
    used: usage,
    limit,
    remainingPercent,
    resetAt,
    state,
    evidence: {
      label: effective && effective.label ? effective.label : '',
      budget_id: effective && effective.id ? effective.id : null,
      reset: effective && effective.reset ? effective.reset : null,
    },
  });
}

function parseOpenRouterKeyQuota(payload) {
  const data = payload && payload.data && typeof payload.data === 'object'
    ? payload.data
    : payload && typeof payload === 'object' ? payload : null;
  if (!data) {
    return { state: 'unknown', metrics: [], reason: 'Key 限额响应缺少 data' };
  }

  const metrics = [];
  const budgets = Array.isArray(data.budgets) ? data.budgets : [];
  const seenBudgetMetrics = new Set();

  for (const [index, budget] of budgets.entries()) {
    if (!budget || typeof budget !== 'object') {
      continue;
    }

    if (budget.is_active === false || budget.active === false || budget.enabled === false || budget.expired === true) {
      continue;
    }

    const metric = parseBudgetMetric(`budget:${budget.id || index + 1}`, budget);
    const key = `${metric.id}\u0000${metric.remaining}\u0000${metric.limit}`;
    if (seenBudgetMetrics.has(key)) {
      continue;
    }
    seenBudgetMetrics.add(key);
    metrics.push(metric);
  }

  if (data.effective_budget && typeof data.effective_budget === 'object') {
    const metric = parseBudgetMetric('effective_budget', data.effective_budget);
    metrics.push(metric);
  }

  const limit = parseNumeric(data.limit);
  const usage = parseNumeric(data.usage);
  const providedRemaining = parseNumeric(data.limit_remaining);

  if (limit !== null || providedRemaining !== null) {
    const remaining = providedRemaining !== null
      ? providedRemaining
      : limit !== null && usage !== null
        ? Math.max(0, limit - usage)
        : null;
    const resetAt = parseTimestamp(data.reset_at ?? data.resets_at ?? data.expires_at);
    const remainingPercent = remaining !== null && limit !== null && limit > 0
      ? Math.max(0, Math.min(100, (remaining / limit) * 100))
      : null;

    metrics.push(makeWindowMetric('key_limit', {
      kind: 'budget',
      unit: 'USD',
      remaining,
      used: usage,
      limit,
      remainingPercent,
      resetAt,
      state: remaining === null ? 'unknown' : remaining <= 0 ? 'exhausted' : 'available',
      evidence: {
        label: data.label || '',
        limit_reset: data.limit_reset || null,
      },
    }));
  }

  if (metrics.length === 0) {
    return {
      state: 'unknown',
      metrics: [],
      reason: '当前 Key 未设置限额；不把未设置限额解释为无限余额',
      unrestricted: Object.hasOwn(data, 'limit') && data.limit === null && budgets.length === 0 && !data.effective_budget,
    };
  }

  const state = combineMetrics(metrics);
  return {
    state,
    metrics,
    resetAt: firstResetAt(metrics),
    reason: state === 'unknown' ? 'Key 限额缺少剩余额度字段' : '',
  };
}

function parseChatGptQuota(payload) {
  const rateLimit = payload && payload.rate_limit && typeof payload.rate_limit === 'object'
    ? payload.rate_limit
    : payload && payload.rateLimits && typeof payload.rateLimits === 'object'
      ? payload.rateLimits
      : null;

  if (!rateLimit) {
    return { state: 'unknown', metrics: [], reason: '额度响应缺少 rate_limit' };
  }

  const metrics = [];
  const exhaustedByFlag = rateLimit.allowed === false || rateLimit.limit_reached === true;
  for (const [id, key] of [['primary', 'primary_window'], ['secondary', 'secondary_window']]) {
    const window = rateLimit[key];
    if (!window || typeof window !== 'object') {
      continue;
    }

    const usedPercent = normalizePercentage(window.used_percent);
    const resetAt = parseTimestamp(window.reset_at);
    metrics.push(makeWindowMetric(id, {
      kind: 'window',
      unit: 'percent',
      remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
      used: usedPercent,
      limit: 100,
      resetAt,
      state: usedPercent === null
        ? 'unknown'
        : exhaustedByFlag || usedPercent >= 100
          ? 'exhausted'
          : 'available',
      evidence: { used_percent: window.used_percent },
    }));
  }

  if (exhaustedByFlag) {
    // Some backends report the blocking flags without exposing the windows.
    // The flags are authoritative; missing window fields are not proof of
    // available quota.
    metrics.push(makeWindowMetric('account_limit', {
      kind: 'window',
      unit: 'percent',
      remainingPercent: 0,
      used: 100,
      limit: 100,
      resetAt: firstResetAt(metrics),
      state: 'exhausted',
      evidence: {
        allowed: rateLimit.allowed,
        limit_reached: rateLimit.limit_reached,
      },
    }));
  }

  const state = combineMetrics(metrics);
  return {
    state,
    metrics,
    resetAt: firstResetAt(metrics),
    reason: state === 'unknown' ? '额度响应缺少可解释的窗口' : '',
  };
}

function parseQuotaBody(config, body) {
  const preset = resolvePresetForConfig(config);
  const parser = preset.quota && preset.quota.parser;

  if (parser === 'glm') {
    return parseGlmQuota(body);
  }

  if (parser === 'opencode-go') {
    return parseOpenCodeGoQuota(body);
  }

  if (parser === 'openrouter-key') {
    return parseOpenRouterKeyQuota(body);
  }

  if (parser === 'sub2api') return parseSub2ApiUsage(body);

  if (parser === 'chatgpt') {
    return parseChatGptQuota(body);
  }

  return {
    state: 'unknown',
    metrics: [],
    reason: (preset.quota && preset.quota.reason) || '当前上游没有额度解释规则',
  };
}

function parseQuotaPayload(result, config, parserOverride) {
  const statusCode = Number(result && result.statusCode);
  if (!Number.isInteger(statusCode) || statusCode < 200 || statusCode >= 300) {
    return {
      state: 'unknown',
      metrics: [],
      reason: `额度接口返回 HTTP ${statusCode || 'unknown'}`,
      statusCode: statusCode || null,
    };
  }

  let body = result.body;
  if (Buffer.isBuffer(body)) {
    body = body.toString('utf8');
  }
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return {
        state: 'unknown',
        metrics: [],
        reason: `额度响应不是合法 JSON: ${err.message}`,
        statusCode,
      };
    }
  }

  const parsed = parserOverride ? parserOverride(body) : parseQuotaBody(config, body);
  return {
    ...parsed,
    statusCode,
  };
}

function parseOpenRouterCreditsPayload(result) {
  return parseQuotaPayload(result, null, payload => {
    const total = parseNumeric(payload && payload.data && payload.data.total_credits);
    const used = parseNumeric(payload && payload.data && payload.data.total_usage);
    if (total === null || used === null) {
      return { state: 'unknown', metrics: [], reason: '账户余额响应缺少金额' };
    }
    const remaining = Math.max(0, total - used);
    const state = remaining > 0 ? 'available' : 'exhausted';
    return { state, metrics: [makeWindowMetric('account_balance', {
      kind: 'budget', unit: 'USD', remaining, used, limit: total,
      remainingPercent: total > 0 ? remaining / total * 100 : 0, state,
    })] };
  });
}

module.exports = {
  PROTOCOL_NAMES,
  PROVIDER_PRESETS,
  getProviderPreset,
  normalizeSub2ApiBaseUrl,
  listProviderPresets,
  resolvePresetForConfig,
  getProtocolPath,
  buildUpstreamUrl,
  buildDiscoveryRequest,
  parseModelsResponse,
  parseModelCatalog,
  diffModelCatalog,
  buildQuotaRequest,
  parseQuotaBody,
  parseQuotaPayload,
  parseOpenRouterCreditsPayload,
  buildUpstreamAuthHeaders,
};
