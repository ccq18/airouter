const { requestBuffered } = require('./upstream-request');

const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_OAUTH_REFRESH_SCOPE = 'openid profile email';
const OPENAI_OAUTH_USER_AGENT = 'codex-cli/0.91.0';
const OPENAI_OAUTH_REFRESH_TIMEOUT_MS = 10 * 1000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function buildOpenAITokenRefreshRequest(options = {}) {
  const refreshToken = normalizeString(options.refreshToken);
  const clientId = normalizeString(options.clientId) || OPENAI_OAUTH_CLIENT_ID;

  if (!refreshToken) {
    throw new Error('refresh_token is required');
  }

  const form = new URLSearchParams();
  form.set('grant_type', 'refresh_token');
  form.set('client_id', clientId);
  form.set('refresh_token', refreshToken);
  form.set('scope', OPENAI_OAUTH_REFRESH_SCOPE);

  return {
    method: 'POST',
    targetUrl: OPENAI_OAUTH_TOKEN_URL,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': OPENAI_OAUTH_USER_AGENT,
    },
    body: Buffer.from(form.toString()),
    timeoutMs: options.timeoutMs ?? OPENAI_OAUTH_REFRESH_TIMEOUT_MS,
    maxRedirects: 3,
  };
}

function parseJsonResponse(text, context) {
  try {
    return JSON.parse(String(text || '{}'));
  } catch (err) {
    throw new Error(`${context}: invalid JSON response`);
  }
}

function formatOAuthErrorValue(value) {
  if (value && typeof value === 'object') {
    const code = normalizeString(value.code || value.error || value.type);
    const message = normalizeString(value.message || value.description || value.error_description || value.details);

    if (code && message) {
      return `${code}: ${message}`;
    }

    if (code) {
      return code;
    }

    if (message) {
      return message;
    }

    return '';
  }

  return normalizeString(value);
}

function formatOAuthError(payload, fallback) {
  if (payload && typeof payload === 'object') {
    const error = formatOAuthErrorValue(payload.error);
    const description = formatOAuthErrorValue(payload.error_description || payload.message || payload.details);

    if (error && description) {
      return `${error}: ${description}`;
    }

    if (error) {
      return error;
    }

    if (description) {
      return description;
    }
  }

  return fallback;
}

async function refreshOpenAIToken(options = {}) {
  const requestBufferedFn = options.requestBufferedFn || requestBuffered;
  const requestOptions = buildOpenAITokenRefreshRequest(options);
  const result = await requestBufferedFn(requestOptions);
  const payload = parseJsonResponse(result.bodyText, 'OpenAI token refresh failed');

  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(`OpenAI token refresh failed: ${formatOAuthError(payload, `status ${result.statusCode}`)}`);
  }

  if (!normalizeString(payload.access_token)) {
    throw new Error('OpenAI token refresh failed: missing access_token');
  }

  return payload;
}

module.exports = {
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_TOKEN_URL,
  OPENAI_OAUTH_REFRESH_SCOPE,
  OPENAI_OAUTH_USER_AGENT,
  buildOpenAITokenRefreshRequest,
  refreshOpenAIToken,
};
