const VALID_PROMPT_CACHE_RETENTIONS = new Set(['in_memory', '24h']);

function getHeader(headers = {}, name) {
  const target = String(name).toLowerCase();
  for (const [headerName, value] of Object.entries(headers || {})) {
    if (String(headerName).toLowerCase() === target && typeof value !== 'undefined') {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return '';
}

function flattenMetadataUserId(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return '';
  }

  const parts = [];
  if (typeof raw.device_id === 'string' && raw.device_id) {
    parts.push(`user_${raw.device_id}`);
    if (typeof raw.account_uuid === 'string' && raw.account_uuid) {
      parts.push(`account_${raw.account_uuid}`);
    }
    if (typeof raw.session_id === 'string' && raw.session_id) {
      parts.push(`session_${raw.session_id}`);
    }
    return parts.join('_');
  }

  return Object.keys(raw)
    .sort()
    .map(key => (typeof raw[key] === 'string' && raw[key] ? `${key}_${raw[key]}` : ''))
    .filter(Boolean)
    .join('_');
}

function extractMetadataUserId(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return '';
  }
  const raw = metadata.user_id;
  if (typeof raw === 'string' && raw) {
    return raw;
  }
  return flattenMetadataUserId(raw);
}

function extractUnifiedSessionId(req, body = {}) {
  const headers = req?.headers || {};
  for (const headerName of [
    'conversation_id',
    'session_id',
    'x-claude-code-session-id',
    'x-client-request-id',
    'x-gemini-api-privileged-user-id',
  ]) {
    const value = String(getHeader(headers, headerName) || '').trim();
    if (value) {
      return value;
    }
  }

  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (typeof body.user === 'string' && body.user) {
      return body.user;
    }
    if (typeof body.prompt_cache_key === 'string' && body.prompt_cache_key) {
      return body.prompt_cache_key;
    }
    const metadataUserId = extractMetadataUserId(body.metadata);
    if (metadataUserId) {
      return metadataUserId;
    }
  }

  return '';
}

function normalizePromptCacheRetention(value) {
  if (typeof value === 'undefined' || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !VALID_PROMPT_CACHE_RETENTIONS.has(value)) {
    throw new Error('ccx.cache.prompt_cache_retention 仅支持 in_memory 或 24h');
  }
  return value;
}

function applyPromptCacheHints({ upstreamProtocol, upstreamBody, req, downstreamBody, config, ccxOptions }) {
  if (!upstreamBody || typeof upstreamBody !== 'object' || Array.isArray(upstreamBody)) {
    return upstreamBody;
  }
  if (!ccxOptions?.cache?.enabled) {
    return upstreamBody;
  }
  if (upstreamProtocol !== 'responses' && upstreamProtocol !== 'chat') {
    return upstreamBody;
  }

  const nextBody = { ...upstreamBody };
  if (!nextBody.prompt_cache_key) {
    const sessionId = extractUnifiedSessionId(req, downstreamBody);
    if (sessionId) {
      nextBody.prompt_cache_key = sessionId;
    }
  }

  const retention = ccxOptions.cache.promptCacheRetention;
  if (
    retention &&
    config?.type === 'apikey' &&
    !nextBody.prompt_cache_retention
  ) {
    nextBody.prompt_cache_retention = retention;
  }

  return nextBody;
}

module.exports = {
  applyPromptCacheHints,
  extractUnifiedSessionId,
  normalizePromptCacheRetention,
};
