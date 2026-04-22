const { isResponsesPath } = require('./responses-defaults');
const { StringDecoder } = require('node:string_decoder');

const RETRYABLE_HTTP_ERROR_TYPES = new Map([
  ['usage_limit_reached', { reason: 'responses_usage_limit_reached' }],
  ['usage_not_included', { reason: 'responses_usage_not_included' }],
]);

const RETRYABLE_STREAM_ERROR_CODES = new Map([
  ['insufficient_quota', { reason: 'responses_insufficient_quota' }],
  ['usage_not_included', { reason: 'responses_usage_not_included' }],
]);

const IGNORABLE_PRELUDE_EVENT_TYPES = new Set([
  'response.created',
  'response.in_progress',
]);

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

function classifyRetryableResponsesHttpError({ statusCode, bodyText }) {
  if (Number(statusCode) !== 429) {
    return null;
  }

  const payload = parseJsonObject(bodyText);
  const errorType = payload && payload.error && typeof payload.error.type === 'string'
    ? payload.error.type
    : '';
  const metadata = RETRYABLE_HTTP_ERROR_TYPES.get(errorType);

  if (!metadata) {
    return null;
  }

  return {
    reason: metadata.reason,
    retryKey: errorType,
    retrySource: 'http',
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
      return { action: 'pass' };
    }

    const eventType = typeof payload.type === 'string' ? payload.type : '';
    const errorCode = payload && payload.response && payload.response.error && typeof payload.response.error.code === 'string'
      ? payload.response.error.code
      : '';
    const metadata = eventType === 'response.failed'
      ? RETRYABLE_STREAM_ERROR_CODES.get(errorCode)
      : null;

    if (metadata) {
      return {
        action: 'retry',
        reason: metadata.reason,
        retryKey: errorCode,
        retrySource: 'stream',
      };
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

module.exports = {
  applyResponsesFailoverRequestHeaders,
  classifyRetryableResponsesHttpError,
  createResponsesEventStreamInspector,
  drainAbandonedResponse,
  getHeaderValue,
  isInspectableResponsesEventStream,
  normalizeContentEncoding,
};
