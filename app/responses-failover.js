const { isResponsesPath } = require('./responses-defaults');
const { StringDecoder } = require('node:string_decoder');

const RETRYABLE_HTTP_ERROR_TYPES = new Map([
  ['usage_limit_reached', { reason: 'responses_usage_limit_reached' }],
  ['usage_not_included', { reason: 'responses_usage_not_included' }],
  ['unauthorized', { reason: 'missing_credentials' }],
  ['token_revoked', { reason: 'missing_credentials' }],
  ['model_at_capacity', { reason: 'responses_model_at_capacity' }],
]);

const RETRYABLE_STREAM_ERROR_CODES = new Map([
  ['insufficient_quota', { reason: 'responses_insufficient_quota' }],
  ['usage_limit_reached', { reason: 'responses_usage_limit_reached' }],
  ['usage_not_included', { reason: 'responses_usage_not_included' }],
  ['model_at_capacity', { reason: 'responses_model_at_capacity' }],
]);
const DOWNGRADED_RESPONSE_MODEL = 'gpt-5.4-mini';

const IGNORABLE_PRELUDE_EVENT_TYPES = new Set([
  'response.created',
  'response.in_progress',
]);

const UNKNOWN_RESPONSES_ERROR = {
  reason: 'responses_unknown_error',
};

function isSuccessfulResponsesStatus(statusCode) {
  return Number(statusCode) === 200;
}

function normalizeErrorText(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeModelName(value) {
  return String(value || '').trim().toLowerCase();
}

function modelNameHasVersionPrefix(model, prefix) {
  const normalizedModel = normalizeModelName(model);
  const normalizedPrefix = normalizeModelName(prefix);
  if (!normalizedModel || !normalizedPrefix) {
    return false;
  }

  if (normalizedModel === normalizedPrefix) {
    return true;
  }

  if (!normalizedModel.startsWith(normalizedPrefix)) {
    return false;
  }

  const suffix = normalizedModel.slice(normalizedPrefix.length);
  return /^-\d{4}-\d{2}-\d{2}(?:$|[-._])/.test(suffix);
}

function areResponseModelsConsistent(requestedModel, responseModel) {
  return modelNameHasVersionPrefix(responseModel, requestedModel) ||
    modelNameHasVersionPrefix(requestedModel, responseModel);
}

function shouldInspectForResponsesModelDowngrade(requestedModel) {
  const normalizedRequestedModel = normalizeModelName(requestedModel);
  return Boolean(
    normalizedRequestedModel &&
    !areResponseModelsConsistent(normalizedRequestedModel, DOWNGRADED_RESPONSE_MODEL)
  );
}

function classifyResponsesModelDowngrade({ requestedModel, responseModel } = {}) {
  const normalizedResponseModel = normalizeModelName(responseModel);
  if (
    !shouldInspectForResponsesModelDowngrade(requestedModel) ||
    !areResponseModelsConsistent(normalizedResponseModel, DOWNGRADED_RESPONSE_MODEL)
  ) {
    return null;
  }

  const normalizedRequestedModel = String(requestedModel || '').trim();
  const normalizedObservedModel = String(responseModel || '').trim();
  return {
    action: 'retry',
    reason: 'responses_model_downgraded',
    retryKey: `${normalizedRequestedModel}->${normalizedObservedModel}`,
    retrySource: 'model',
    requestedModel: normalizedRequestedModel,
    responseModel: normalizedObservedModel,
  };
}

function isResponsesModelDowngradeClassification(classification) {
  return Boolean(classification && classification.reason === 'responses_model_downgraded');
}

function shouldMarkResponsesFailoverUnavailable(classification) {
  return !isResponsesModelDowngradeClassification(classification);
}

function extractResponsesPayloadModel(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return '';
  }

  if (typeof payload.response?.model === 'string' && payload.response.model.trim()) {
    return payload.response.model.trim();
  }

  return typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : '';
}

function getUsageLimitMessageKey(...values) {
  const normalized = values
    .map(normalizeErrorText)
    .filter(Boolean)
    .join('\n');

  if (
    normalized.includes("you've hit your usage limit") ||
    normalized.includes('you have hit your usage limit') ||
    normalized.includes('codex/settings/usage') ||
    normalized.includes('purchase more credits')
  ) {
    return 'usage_limit_reached';
  }

  return '';
}

function getModelCapacityMessageKey(...values) {
  const normalized = values
    .map(normalizeErrorText)
    .filter(Boolean)
    .join('\n');

  return normalized.includes('selected model is at capacity') ? 'model_at_capacity' : '';
}

function parseJsonObject(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    return parsed;
  } catch (err) {
    return null;
  }
}

function getPayloadString(payload, path) {
  let current = payload;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return '';
    }

    current = current[key];
  }

  return typeof current === 'string' ? current : '';
}

function getAuthFailureKey(payload, bodyText) {
  const candidates = [
    getPayloadString(payload, ['detail']),
    getPayloadString(payload, ['message']),
    getPayloadString(payload, ['code']),
    getPayloadString(payload, ['error', 'code']),
    getPayloadString(payload, ['error', 'type']),
    getPayloadString(payload, ['error', 'message']),
    bodyText,
  ];

  if (candidates.some(value => typeof value === 'string' && value.trim().toLowerCase() === 'unauthorized')) {
    return 'unauthorized';
  }

  const normalized = candidates
    .filter(value => typeof value === 'string' && value.trim())
    .join('\n')
    .toLowerCase();

  if (normalized.includes('token_revoked') || normalized.includes('invalidated oauth token')) {
    return 'token_revoked';
  }

  return '';
}

function classifyRetryableResponsesHttpError({ statusCode, bodyText }) {
  const normalizedStatusCode = Number(statusCode);
  if (!Number.isFinite(normalizedStatusCode) || isSuccessfulResponsesStatus(normalizedStatusCode)) {
    return null;
  }

  const payload = parseJsonObject(bodyText);
  if (normalizedStatusCode === 401 || normalizedStatusCode === 403) {
    const authFailureKey = getAuthFailureKey(payload, bodyText);
    const metadata = RETRYABLE_HTTP_ERROR_TYPES.get(authFailureKey);

    if (metadata) {
      return {
        reason: metadata.reason,
        retryKey: authFailureKey,
        retrySource: 'http',
      };
    }

    return {
      reason: UNKNOWN_RESPONSES_ERROR.reason,
      retryKey: String(normalizedStatusCode),
      retrySource: 'http',
    };
  }

  const errorType = payload && payload.error && typeof payload.error.type === 'string'
    ? payload.error.type
    : '';
  const errorCode = payload && payload.error && typeof payload.error.code === 'string'
    ? payload.error.code
    : '';
  const topLevelType = payload && typeof payload.type === 'string'
    ? payload.type
    : '';
  const topLevelCode = payload && typeof payload.code === 'string'
    ? payload.code
    : '';
  const messageKey = getUsageLimitMessageKey(
    getPayloadString(payload, ['error', 'message']),
    getPayloadString(payload, ['message']),
    bodyText,
  );
  const capacityKey = getModelCapacityMessageKey(
    getPayloadString(payload, ['error', 'message']),
    getPayloadString(payload, ['message']),
    bodyText,
  );
  const typedRetryKey = RETRYABLE_HTTP_ERROR_TYPES.has(errorType) ? errorType : '';
  const codedRetryKey = RETRYABLE_HTTP_ERROR_TYPES.has(errorCode) ? errorCode : '';
  const retryKey = typedRetryKey || codedRetryKey || messageKey || capacityKey;
  const metadata = RETRYABLE_HTTP_ERROR_TYPES.get(retryKey);

  if (!metadata) {
    return {
      reason: UNKNOWN_RESPONSES_ERROR.reason,
      retryKey: errorType || errorCode || topLevelType || topLevelCode || `http_${normalizedStatusCode}`,
      retrySource: 'http',
    };
  }

  return {
    reason: metadata.reason,
    retryKey,
    retrySource: 'http',
  };
}

function classifyRetryableResponsesStreamPayload(payload, options = {}) {
  const modelDowngrade = classifyResponsesModelDowngrade({
    requestedModel: options.requestedModel,
    responseModel: extractResponsesPayloadModel(payload),
  });
  if (modelDowngrade) {
    return modelDowngrade;
  }

  const eventType = typeof payload?.type === 'string' && payload.type
    ? payload.type
    : typeof options.eventType === 'string'
      ? options.eventType
      : '';
  const responseError = payload && payload.response && payload.response.error &&
    typeof payload.response.error === 'object' && !Array.isArray(payload.response.error)
    ? payload.response.error
    : null;
  const payloadError = payload && payload.error &&
    typeof payload.error === 'object' && !Array.isArray(payload.error)
    ? payload.error
    : null;
  const errorPayload = responseError || payloadError;
  const errorCode = errorPayload && typeof errorPayload.code === 'string'
    ? errorPayload.code
    : '';
  const errorMessage = errorPayload && typeof errorPayload.message === 'string'
    ? errorPayload.message
    : '';
  const messageKey = getUsageLimitMessageKey(errorMessage);
  const capacityKey = getModelCapacityMessageKey(errorMessage);
  const retryKey = RETRYABLE_STREAM_ERROR_CODES.has(errorCode) ? errorCode : messageKey || capacityKey;
  const normalizedEventType = normalizeErrorText(eventType);
  const isFailureEvent = normalizedEventType === 'response.failed' ||
    normalizedEventType === 'error' ||
    normalizedEventType.endsWith('.failed') ||
    normalizedEventType.endsWith('.error') ||
    Boolean(errorPayload);
  const metadata = isFailureEvent
    ? RETRYABLE_STREAM_ERROR_CODES.get(retryKey)
    : null;

  if (!isFailureEvent) {
    return null;
  }

  return {
    action: 'retry',
    reason: metadata ? metadata.reason : UNKNOWN_RESPONSES_ERROR.reason,
    retryKey: retryKey || errorCode || normalizedEventType || 'unknown_error',
    retrySource: 'stream',
  };
}

function getHeaderValue(headers, headerName) {
  const normalizedTarget = String(headerName || '').toLowerCase();

  for (const [name, value] of Object.entries(headers || {})) {
    if (String(name).toLowerCase() === normalizedTarget) {
      if (Array.isArray(value)) {
        return value.join(', ');
      }

      return typeof value === 'undefined' ? '' : String(value);
    }
  }

  return '';
}

function normalizeContentEncoding(value) {
  const normalizedValue = String(value || '').toLowerCase();

  if (normalizedValue.includes('br')) {
    return 'br';
  }

  if (normalizedValue.includes('gzip')) {
    return 'gzip';
  }

  if (normalizedValue.includes('deflate')) {
    return 'deflate';
  }

  return normalizedValue.trim();
}

function isInspectableResponsesEventStream(headers) {
  const contentType = getHeaderValue(headers, 'content-type').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    return false;
  }

  const contentEncoding = normalizeContentEncoding(getHeaderValue(headers, 'content-encoding'));
  return contentEncoding === '' || contentEncoding === 'gzip' || contentEncoding === 'br' || contentEncoding === 'deflate';
}

function applyResponsesFailoverRequestHeaders(headers, requestPath) {
  const nextHeaders = { ...headers };

  if (isResponsesPath(requestPath)) {
    nextHeaders['accept-encoding'] = 'identity';
  }

  return nextHeaders;
}

function drainAbandonedResponse(response) {
  return new Promise(resolve => {
    let settled = false;

    function cleanup() {
      if (settled) {
        return;
      }

      settled = true;
      response.removeListener('error', swallowError);
      response.removeListener('end', handleDone);
      response.removeListener('close', handleDone);
      resolve();
    }

    function swallowError() {}

    function handleDone() {
      cleanup();
    }

    response.on('error', swallowError);
    response.on('end', handleDone);
    response.on('close', handleDone);
    response.resume();

    if (response.readableEnded || response.complete) {
      cleanup();
    }
  });
}

function createResponsesEventStreamInspector(options = {}) {
  const {
    maxBufferBytes = 64 * 1024,
    requestedModel = '',
  } = options;

  const decoder = new StringDecoder('utf8');
  let bufferedText = '';
  let bufferedBytes = 0;

  function inspectBufferedEvents() {
    while (true) {
      const match = /\r?\n\r?\n/.exec(bufferedText);
      if (!match) {
        return { action: 'pending' };
      }

      const eventBlock = bufferedText.slice(0, match.index);
      bufferedText = bufferedText.slice(match.index + match[0].length);

      const eventResult = inspectEventBlock(eventBlock);
      if (eventResult.action !== 'pending') {
        return eventResult;
      }
    }
  }

  function inspectEventBlock(eventBlock) {
    if (typeof eventBlock !== 'string' || eventBlock.length === 0) {
      return { action: 'pending' };
    }

    const dataLines = eventBlock
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, ''));

    if (dataLines.length === 0) {
      return { action: 'pending' };
    }

    const payloadText = dataLines.join('\n');
    if (payloadText === '[DONE]') {
      return { action: 'pass' };
    }

    const payload = parseJsonObject(payloadText);
    if (!payload) {
      return {
        action: 'retry',
        reason: UNKNOWN_RESPONSES_ERROR.reason,
        retryKey: getSseEventType(eventBlock) || 'malformed_event',
        retrySource: 'stream',
      };
    }

    const eventType = typeof payload.type === 'string' ? payload.type : getSseEventType(eventBlock);
    const classification = classifyRetryableResponsesStreamPayload(payload, {
      requestedModel,
      eventType,
    });

    if (classification) {
      return classification;
    }

    if (IGNORABLE_PRELUDE_EVENT_TYPES.has(eventType)) {
      return { action: 'pending' };
    }

    return { action: 'pass' };
  }

  return {
    push(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bufferedBytes += buffer.length;
      if (bufferedBytes > maxBufferBytes) {
        return { action: 'pass' };
      }

      bufferedText += decoder.write(buffer);
      return inspectBufferedEvents();
    },
    finish() {
      bufferedText += decoder.end();
      const result = inspectBufferedEvents();
      return result.action === 'pending' ? { action: 'pass' } : result;
    },
  };
}

function getSseEventType(eventBlock) {
  const eventLine = String(eventBlock || '')
    .split(/\r?\n/)
    .find(line => line.startsWith('event:'));
  return eventLine ? eventLine.slice(6).trim() : '';
}

module.exports = {
  applyResponsesFailoverRequestHeaders,
  classifyResponsesModelDowngrade,
  classifyRetryableResponsesHttpError,
  classifyRetryableResponsesStreamPayload,
  createResponsesEventStreamInspector,
  drainAbandonedResponse,
  getHeaderValue,
  isInspectableResponsesEventStream,
  isSuccessfulResponsesStatus,
  isResponsesModelDowngradeClassification,
  normalizeContentEncoding,
  shouldMarkResponsesFailoverUnavailable,
  shouldInspectForResponsesModelDowngrade,
};
