const DEFAULT_MAX_IN_FLIGHT = 32;
const DEFAULT_MAX_QUEUE_SIZE = 64;
const DEFAULT_QUEUE_TIMEOUT_MS = 10 * 1000;

class RequestConcurrencyError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RequestConcurrencyError';
    this.code = code;
  }
}

function normalizePositiveInteger(value, fallback) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback;
  }

  return Math.floor(normalized);
}

function createRequestConcurrencyLimiter(options = {}) {
  const maxInFlight = normalizePositiveInteger(options.maxInFlight, DEFAULT_MAX_IN_FLIGHT);
  const maxQueueSize = normalizePositiveInteger(options.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE);
  const queueTimeoutMs = normalizePositiveInteger(options.queueTimeoutMs, DEFAULT_QUEUE_TIMEOUT_MS);
  const queue = [];
  let inFlight = 0;

  function getStatus() {
    return {
      inFlight,
      maxInFlight,
      queued: queue.length,
      maxQueueSize,
    };
  }

  function createLease() {
    let released = false;
    inFlight += 1;

    return {
      release() {
        if (released) {
          return;
        }

        released = true;
        inFlight = Math.max(0, inFlight - 1);
        dispatchNext();
      },
    };
  }

  function removeQueuedEntry(entry) {
    const index = queue.indexOf(entry);
    if (index !== -1) {
      queue.splice(index, 1);
    }
  }

  function cleanupEntry(entry) {
    if (entry.timeoutHandle) {
      clearTimeout(entry.timeoutHandle);
      entry.timeoutHandle = null;
    }
    if (entry.signal && entry.abortHandler) {
      entry.signal.removeEventListener('abort', entry.abortHandler);
    }
  }

  function rejectEntry(entry, error) {
    if (entry.settled) {
      return;
    }

    entry.settled = true;
    removeQueuedEntry(entry);
    cleanupEntry(entry);
    entry.reject(error);
  }

  function dispatchNext() {
    while (inFlight < maxInFlight && queue.length > 0) {
      const entry = queue.shift();
      if (entry.settled || (entry.signal && entry.signal.aborted)) {
        cleanupEntry(entry);
        continue;
      }

      entry.settled = true;
      cleanupEntry(entry);
      entry.resolve(createLease());
    }
  }

  function acquire(options = {}) {
    const signal = options.signal || null;
    if (signal && signal.aborted) {
      return Promise.reject(new RequestConcurrencyError('请求已取消', 'QUEUE_ABORTED'));
    }

    if (inFlight < maxInFlight) {
      return Promise.resolve(createLease());
    }

    if (queue.length >= maxQueueSize) {
      return Promise.reject(new RequestConcurrencyError('请求队列已满', 'QUEUE_FULL'));
    }

    return new Promise((resolve, reject) => {
      const entry = {
        abortHandler: null,
        reject,
        resolve,
        settled: false,
        signal,
        timeoutHandle: null,
      };

      entry.abortHandler = () => {
        rejectEntry(entry, new RequestConcurrencyError('请求已取消', 'QUEUE_ABORTED'));
      };
      if (signal) {
        signal.addEventListener('abort', entry.abortHandler, { once: true });
      }

      entry.timeoutHandle = setTimeout(() => {
        rejectEntry(entry, new RequestConcurrencyError('请求排队超时', 'QUEUE_TIMEOUT'));
      }, queueTimeoutMs);

      queue.push(entry);
    });
  }

  return {
    acquire,
    getStatus,
  };
}

function createRequestConcurrencyMiddleware(limiter) {
  if (!limiter || typeof limiter.acquire !== 'function') {
    throw new TypeError('limiter.acquire must be a function');
  }

  return async function limitRequestConcurrency(req, res, next) {
    const abortController = new AbortController();
    const abortQueuedRequest = () => abortController.abort();
    req.once('aborted', abortQueuedRequest);
    res.once('close', abortQueuedRequest);

    let lease;
    try {
      lease = await limiter.acquire({ signal: abortController.signal });
    } catch (error) {
      req.removeListener('aborted', abortQueuedRequest);
      res.removeListener('close', abortQueuedRequest);
      if (error.code === 'QUEUE_ABORTED' || res.destroyed || res.writableEnded) {
        return;
      }

      res.setHeader('retry-after', '1');
      res.status(503).json({
        error: 'Service Unavailable',
        message: error.message,
      });
      return;
    }

    req.removeListener('aborted', abortQueuedRequest);
    res.removeListener('close', abortQueuedRequest);
    let released = false;
    const releaseLease = () => {
      if (released) {
        return;
      }

      released = true;
      lease.release();
    };
    res.once('finish', releaseLease);
    res.once('close', releaseLease);
    next();
  };
}

module.exports = {
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_MAX_QUEUE_SIZE,
  DEFAULT_QUEUE_TIMEOUT_MS,
  RequestConcurrencyError,
  createRequestConcurrencyLimiter,
  createRequestConcurrencyMiddleware,
};
