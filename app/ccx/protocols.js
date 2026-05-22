const { normalizePromptCacheRetention } = require('./cache');

const VALID_PROTOCOLS = new Set(['responses', 'messages', 'chat']);

const DEFAULT_CCX_OPTIONS = {
  enabled: true,
  upstreamProtocol: 'responses',
  enabledUpstreamProtocols: ['responses'],
  session: {
    maxAgeMs: 24 * 60 * 60 * 1000,
    maxMessages: 100,
    maxTokens: 100000,
    cleanupIntervalMs: 5 * 60 * 1000,
  },
  compact: {
    localFallback: true,
    maxTranscriptChars: 240000,
    maxToolArgChars: 8000,
    maxReasoningChars: 12000,
    defaultMaxOutputTokens: 8192,
  },
  cache: {
    enabled: true,
    promptCacheRetention: null,
  },
};

function normalizeProtocol(value, fallback = null) {
  const protocol = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!protocol) {
    return fallback;
  }
  if (!VALID_PROTOCOLS.has(protocol)) {
    throw new Error(`ccx protocol 仅支持 responses、messages、chat: ${value}`);
  }
  return protocol;
}

function normalizeNumber(value, fallback, fieldName) {
  if (typeof value === 'undefined' || value === null || value === '') {
    return fallback;
  }
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw new Error(`${fieldName} 必须是非负数字`);
  }
  return Math.floor(numberValue);
}

function normalizeProtocolList(value, fallback) {
  if (typeof value === 'undefined' || value === null) {
    return fallback.slice();
  }
  if (!Array.isArray(value)) {
    throw new Error('ccx.enabled_upstream_protocols 必须是数组');
  }
  const protocols = [];
  for (const item of value) {
    const protocol = normalizeProtocol(item);
    if (!protocols.includes(protocol)) {
      protocols.push(protocol);
    }
  }
  if (protocols.length === 0) {
    throw new Error('ccx.enabled_upstream_protocols 不能为空');
  }
  return protocols;
}

function resolveCcxOptions(parsed = {}) {
  const raw = parsed && typeof parsed === 'object' && parsed.ccx && typeof parsed.ccx === 'object'
    ? parsed.ccx
    : parsed && typeof parsed === 'object'
      ? parsed
      : {};
  const session = raw.session && typeof raw.session === 'object' ? raw.session : {};
  const compact = raw.compact && typeof raw.compact === 'object' ? raw.compact : {};
  const cache = raw.cache && typeof raw.cache === 'object' ? raw.cache : {};

  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CCX_OPTIONS.enabled,
    upstreamProtocol: normalizeProtocol(raw.upstream_protocol, DEFAULT_CCX_OPTIONS.upstreamProtocol),
    enabledUpstreamProtocols: normalizeProtocolList(raw.enabled_upstream_protocols, DEFAULT_CCX_OPTIONS.enabledUpstreamProtocols),
    session: {
      maxAgeMs: normalizeNumber(session.max_age_ms, DEFAULT_CCX_OPTIONS.session.maxAgeMs, 'ccx.session.max_age_ms'),
      maxMessages: normalizeNumber(session.max_messages, DEFAULT_CCX_OPTIONS.session.maxMessages, 'ccx.session.max_messages'),
      maxTokens: normalizeNumber(session.max_tokens, DEFAULT_CCX_OPTIONS.session.maxTokens, 'ccx.session.max_tokens'),
      cleanupIntervalMs: normalizeNumber(session.cleanup_interval_ms, DEFAULT_CCX_OPTIONS.session.cleanupIntervalMs, 'ccx.session.cleanup_interval_ms'),
    },
    compact: {
      localFallback: typeof compact.local_fallback === 'boolean' ? compact.local_fallback : DEFAULT_CCX_OPTIONS.compact.localFallback,
      maxTranscriptChars: normalizeNumber(compact.max_transcript_chars, DEFAULT_CCX_OPTIONS.compact.maxTranscriptChars, 'ccx.compact.max_transcript_chars'),
      maxToolArgChars: normalizeNumber(compact.max_tool_arg_chars, DEFAULT_CCX_OPTIONS.compact.maxToolArgChars, 'ccx.compact.max_tool_arg_chars'),
      maxReasoningChars: normalizeNumber(compact.max_reasoning_chars, DEFAULT_CCX_OPTIONS.compact.maxReasoningChars, 'ccx.compact.max_reasoning_chars'),
      defaultMaxOutputTokens: normalizeNumber(compact.default_max_output_tokens, DEFAULT_CCX_OPTIONS.compact.defaultMaxOutputTokens, 'ccx.compact.default_max_output_tokens'),
    },
    cache: {
      enabled: typeof cache.enabled === 'boolean' ? cache.enabled : DEFAULT_CCX_OPTIONS.cache.enabled,
      promptCacheRetention: normalizePromptCacheRetention(cache.prompt_cache_retention),
    },
  };
}

function detectDownstreamProtocol(requestPath) {
  const pathname = new URL(requestPath || '/', 'http://localhost').pathname;
  if (pathname === '/ccx/v1/responses' || pathname === '/ccx/v1/responses/compact') {
    return 'responses';
  }
  if (pathname === '/ccx/v1/messages') {
    return 'messages';
  }
  if (pathname === '/ccx/v1/chat/completions') {
    return 'chat';
  }
  return null;
}

function isCompactPath(requestPath) {
  return new URL(requestPath || '/', 'http://localhost').pathname === '/ccx/v1/responses/compact';
}

function buildUpstreamPath(protocol, config, options = {}) {
  const normalized = normalizeProtocol(protocol);
  const compact = Boolean(options.compact);
  if (normalized === 'responses') {
    const suffix = compact ? '/responses/compact' : '/responses';
    if (config && config.type === 'token') {
      return `${String(config.apiBasePath || '/backend-api/codex').replace(/\/+$/, '')}${suffix}`;
    }
    return `/v1${suffix}`;
  }
  if (normalized === 'chat') {
    if (compact) {
      throw new Error('chat upstream 不支持原生 compact');
    }
    if (config && config.type === 'token') {
      return `${String(config.apiBasePath || '/backend-api/codex').replace(/\/+$/, '')}/chat/completions`;
    }
    return '/v1/chat/completions';
  }
  if (compact) {
    throw new Error('messages upstream 不支持原生 compact');
  }
  return '/v1/messages';
}

function buildTargetUrl(config, upstreamPath) {
  return new URL(upstreamPath, config.baseUrl).toString();
}

function protocolCapability(protocol) {
  if (protocol === 'messages') {
    return 'claude';
  }
  return 'gpt';
}

module.exports = {
  DEFAULT_CCX_OPTIONS,
  VALID_PROTOCOLS,
  buildTargetUrl,
  buildUpstreamPath,
  detectDownstreamProtocol,
  isCompactPath,
  normalizeProtocol,
  protocolCapability,
  resolveCcxOptions,
};
