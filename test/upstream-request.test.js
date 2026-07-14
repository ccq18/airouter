const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createUpstreamRequest, requestBuffered } = require('../app/upstream-request');

function createMockResponse({ statusCode = 200, headers = {} } = {}) {
  const response = new PassThrough();
  const originalEnd = response.end.bind(response);
  let timeoutHandle = null;

  response.statusCode = statusCode;
  response.headers = headers;
  response.complete = false;
  response.end = (...args) => {
    response.complete = true;
    return originalEnd(...args);
  };
  response.setTimeout = (timeoutMs, callback) => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    if (timeoutMs > 0) {
      timeoutHandle = setTimeout(callback, timeoutMs);
    }
    return response;
  };
  response.once('close', () => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  });

  return response;
}

function createMockRequest(onEnd) {
  const request = new EventEmitter();

  request.destroyed = false;
  request.end = body => {
    onEnd(body, request);
  };
  request.destroy = error => {
    if (request.destroyed) {
      return request;
    }

    request.destroyed = true;
    if (request.response && !request.response.destroyed) {
      request.response.destroy(error);
    }
    request.emit('error', error);
    request.emit('close');
    return request;
  };

  return request;
}

function withStubbedHttpRequest(t, handler) {
  const originalRequest = http.request;
  http.request = handler;
  t.after(() => {
    http.request = originalRequest;
  });
}

function readResponseBody(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    response.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', reject);
  });
}

test('createUpstreamRequest aborts a hanging response body after timeout', async t => {
  withStubbedHttpRequest(t, (_options, callback) => {
    return createMockRequest((_body, request) => {
      const response = createMockResponse();
      request.response = response;

      setImmediate(() => {
        callback(response);
        response.write('partial');
      });
    });
  });

  const upstream = createUpstreamRequest({
    method: 'GET',
    targetUrl: 'http://example.test/stall',
    timeoutMs: 80,
  });
  const response = await upstream.responsePromise;

  await assert.rejects(
    readResponseBody(response),
    error => {
      assert.equal(error.code, 'ETIMEDOUT');
      return true;
    }
  );
});

test('createUpstreamRequest aborts when a connection does not become ready', async t => {
  withStubbedHttpRequest(t, () => createMockRequest(() => {}));

  const upstream = createUpstreamRequest({
    method: 'GET',
    targetUrl: 'http://example.test/connect',
    connectTimeoutMs: 20,
    timeoutMs: 200,
  });

  await assert.rejects(upstream.responsePromise, error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.timeoutPhase, 'connect');
    return true;
  });
});

test('createUpstreamRequest aborts when the first response does not arrive', async t => {
  withStubbedHttpRequest(t, () => {
    const request = createMockRequest(() => {});
    process.nextTick(() => {
      request.emit('socket', { connecting: false });
    });
    return request;
  });

  const upstream = createUpstreamRequest({
    method: 'GET',
    targetUrl: 'http://example.test/first-response',
    connectTimeoutMs: 10,
    firstResponseTimeoutMs: 25,
    timeoutMs: 200,
  });

  await assert.rejects(upstream.responsePromise, error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.timeoutPhase, 'first_response');
    return true;
  });
});

test('createUpstreamRequest aborts an idle response stream', async t => {
  withStubbedHttpRequest(t, (_options, callback) => {
    return createMockRequest((_body, request) => {
      const response = createMockResponse();
      request.response = response;

      setImmediate(() => {
        callback(response);
        response.write('partial');
      });
    });
  });

  const upstream = createUpstreamRequest({
    method: 'GET',
    targetUrl: 'http://example.test/idle',
    idleTimeoutMs: 25,
    timeoutMs: 200,
  });
  const response = await upstream.responsePromise;

  await assert.rejects(readResponseBody(response), error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.timeoutPhase, 'idle');
    return true;
  });
});

test('createUpstreamRequest completes safely after Node clears the response socket', async t => {
  withStubbedHttpRequest(t, (_options, callback) => {
    return createMockRequest((_body, request) => {
      const response = createMockResponse();
      response.socket = {
        setTimeout() {},
      };
      request.response = response;

      setImmediate(() => {
        callback(response);
        response.socket = null;
        response.emit('close');
      });
    });
  });

  const upstream = createUpstreamRequest({
    method: 'GET',
    targetUrl: 'http://example.test/socket-cleared-before-close',
    idleTimeoutMs: 25,
    timeoutMs: 200,
  });

  await upstream.responsePromise;
  await new Promise(resolve => setImmediate(resolve));
});

test('createUpstreamRequest respects a shared absolute deadline', async t => {
  withStubbedHttpRequest(t, () => createMockRequest(() => {}));

  const startedAt = Date.now();
  const upstream = createUpstreamRequest({
    method: 'GET',
    targetUrl: 'http://example.test/deadline',
    deadlineAt: Date.now() + 35,
    timeoutMs: 200,
  });

  await assert.rejects(upstream.responsePromise, error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.timeoutPhase, 'total');
    return true;
  });
  assert.ok(Date.now() - startedAt < 100);
});

test('createUpstreamRequest reports the total deadline before a longer connect timeout', async t => {
  withStubbedHttpRequest(t, () => createMockRequest(() => {}));

  const upstream = createUpstreamRequest({
    method: 'GET',
    targetUrl: 'http://example.test/deadline-before-connect',
    connectTimeoutMs: 200,
    deadlineAt: Date.now() + 25,
    timeoutMs: 500,
  });

  await assert.rejects(upstream.responsePromise, error => {
    assert.equal(error.code, 'ETIMEDOUT');
    assert.equal(error.timeoutPhase, 'total');
    return true;
  });
});

test('requestBuffered keeps one timeout budget across redirects', async t => {
  let callCount = 0;

  withStubbedHttpRequest(t, (_options, callback) => {
    callCount += 1;

    return createMockRequest(() => {
      if (callCount === 1) {
        const response = createMockResponse({
          statusCode: 302,
          headers: {
            location: '/hang',
          },
        });

        setTimeout(() => {
          callback(response);
          response.end();
        }, 120);
        return;
      }

      const response = createMockResponse();

      setImmediate(() => {
        callback(response);
        response.write('partial');
      });
    });
  });

  const startedAt = Date.now();

  await assert.rejects(
    requestBuffered({
      method: 'GET',
      targetUrl: 'http://example.test/redirect',
      maxRedirects: 1,
      timeoutMs: 200,
    }),
    error => {
      assert.equal(error.code, 'ETIMEDOUT');
      return true;
    }
  );

  const elapsedMs = Date.now() - startedAt;
  assert.equal(callCount, 2);
  assert.ok(elapsedMs < 300, `expected redirect chain to share one timeout budget, got ${elapsedMs}ms`);
});
