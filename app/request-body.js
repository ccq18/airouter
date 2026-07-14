const DEFAULT_REQUEST_BODY_LIMIT_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS = 30 * 1000;

class RequestBodyError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'RequestBodyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeLimit(value, fallback) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }

  return Math.floor(normalized);
}

function getContentLength(headers) {
  const rawValue = headers && (headers['content-length'] || headers['Content-Length']);
  if (Array.isArray(rawValue)) {
    return Number(rawValue[0]);
  }

  return Number(rawValue);
}

function drainRequest(req) {
  if (req && typeof req.resume === 'function' && !req.readableEnded) {
    req.resume();
  }
}

function readRequestBody(req, options = {}) {
  const limitBytes = normalizeLimit(options.limitBytes, DEFAULT_REQUEST_BODY_LIMIT_BYTES);
  const idleTimeoutMs = normalizeLimit(options.idleTimeoutMs, DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS);
  const contentLength = getContentLength(req && req.headers);

  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    drainRequest(req);
    return Promise.reject(new RequestBodyError('请求体过大', 'PAYLOAD_TOO_LARGE', 413));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let idleTimer = null;
    let settled = false;
    let totalBytes = 0;

    function clearIdleTimer() {
      if (!idleTimer) {
        return;
      }

      clearTimeout(idleTimer);
      idleTimer = null;
    }

    function cleanup() {
      clearIdleTimer();
      req.removeListener('data', handleData);
      req.removeListener('end', handleEnd);
      req.removeListener('error', handleError);
      req.removeListener('aborted', handleAborted);
    }

    function settleWithError(error) {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      drainRequest(req);
      reject(error);
    }

    function resetIdleTimer() {
      clearIdleTimer();
      idleTimer = setTimeout(() => {
        settleWithError(new RequestBodyError('读取请求体超时', 'REQUEST_BODY_TIMEOUT', 408));
      }, idleTimeoutMs);
    }

    function handleData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > limitBytes) {
        settleWithError(new RequestBodyError('请求体过大', 'PAYLOAD_TOO_LARGE', 413));
        return;
      }

      chunks.push(buffer);
      resetIdleTimer();
    }

    function handleEnd() {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, totalBytes));
    }

    function handleError(error) {
      settleWithError(error);
    }

    function handleAborted() {
      settleWithError(new RequestBodyError('客户端已中断请求', 'REQUEST_BODY_ABORTED', 400));
    }

    req.on('data', handleData);
    req.on('end', handleEnd);
    req.on('error', handleError);
    req.on('aborted', handleAborted);
    resetIdleTimer();
  });
}

module.exports = {
  DEFAULT_REQUEST_BODY_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_BODY_LIMIT_BYTES,
  RequestBodyError,
  readRequestBody,
};
