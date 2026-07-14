const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const {
  createRequestConcurrencyLimiter,
  createRequestConcurrencyMiddleware,
} = require('../app/request-concurrency');

function createMiddlewareContext() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.headers = {};
  res.payload = null;
  res.statusCode = null;
  res.setHeader = (name, value) => {
    res.headers[String(name).toLowerCase()] = value;
  };
  res.status = statusCode => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = payload => {
    res.payload = payload;
    res.writableEnded = true;
    return res;
  };
  return { req, res };
}

test('request concurrency limiter queues requests above the in-flight limit', async () => {
  const limiter = createRequestConcurrencyLimiter({
    maxInFlight: 1,
    maxQueueSize: 2,
    queueTimeoutMs: 100,
  });
  const firstLease = await limiter.acquire();
  let secondResolved = false;
  const secondLeasePromise = limiter.acquire().then(lease => {
    secondResolved = true;
    return lease;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(secondResolved, false);
  assert.deepEqual(limiter.getStatus(), {
    inFlight: 1,
    maxInFlight: 1,
    queued: 1,
    maxQueueSize: 2,
  });

  firstLease.release();
  const secondLease = await secondLeasePromise;
  assert.equal(secondResolved, true);
  secondLease.release();
  assert.equal(limiter.getStatus().inFlight, 0);
});

test('request concurrency limiter rejects when the queue is full', async () => {
  const limiter = createRequestConcurrencyLimiter({
    maxInFlight: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 100,
  });
  const lease = await limiter.acquire();
  const queued = limiter.acquire();

  await assert.rejects(limiter.acquire(), error => {
    assert.equal(error.code, 'QUEUE_FULL');
    return true;
  });

  lease.release();
  const queuedLease = await queued;
  queuedLease.release();
});

test('request concurrency limiter removes timed out queue entries', async () => {
  const limiter = createRequestConcurrencyLimiter({
    maxInFlight: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 20,
  });
  const lease = await limiter.acquire();

  await assert.rejects(limiter.acquire(), error => {
    assert.equal(error.code, 'QUEUE_TIMEOUT');
    return true;
  });
  assert.equal(limiter.getStatus().queued, 0);
  lease.release();
});

test('request concurrency limiter removes aborted queue entries', async () => {
  const limiter = createRequestConcurrencyLimiter({
    maxInFlight: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 100,
  });
  const lease = await limiter.acquire();
  const controller = new AbortController();
  const queued = limiter.acquire({ signal: controller.signal });

  controller.abort();
  await assert.rejects(queued, error => {
    assert.equal(error.code, 'QUEUE_ABORTED');
    return true;
  });
  assert.equal(limiter.getStatus().queued, 0);
  lease.release();
});

test('request concurrency middleware queues work and releases leases on finish', async () => {
  const limiter = createRequestConcurrencyLimiter({
    maxInFlight: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 100,
  });
  const middleware = createRequestConcurrencyMiddleware(limiter);
  const first = createMiddlewareContext();
  const second = createMiddlewareContext();
  let firstStarted = false;
  let secondStarted = false;

  await middleware(first.req, first.res, () => {
    firstStarted = true;
  });
  const secondStart = middleware(second.req, second.res, () => {
    secondStarted = true;
  });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(firstStarted, true);
  assert.equal(secondStarted, false);
  assert.equal(limiter.getStatus().queued, 1);

  first.res.emit('finish');
  await secondStart;
  assert.equal(secondStarted, true);
  second.res.emit('finish');
  assert.equal(limiter.getStatus().inFlight, 0);
});

test('request concurrency middleware returns 503 and Retry-After when the queue is full', async () => {
  const limiter = createRequestConcurrencyLimiter({
    maxInFlight: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 100,
  });
  const middleware = createRequestConcurrencyMiddleware(limiter);
  const first = createMiddlewareContext();
  const queued = createMiddlewareContext();
  const rejected = createMiddlewareContext();

  await middleware(first.req, first.res, () => {});
  const queuedStart = middleware(queued.req, queued.res, () => {});
  await new Promise(resolve => setImmediate(resolve));
  await middleware(rejected.req, rejected.res, () => {
    assert.fail('a request rejected by the limiter must not reach the route');
  });

  assert.equal(rejected.res.statusCode, 503);
  assert.equal(rejected.res.headers['retry-after'], '1');
  assert.equal(rejected.res.payload.error, 'Service Unavailable');

  first.res.emit('finish');
  await queuedStart;
  queued.res.emit('finish');
});
