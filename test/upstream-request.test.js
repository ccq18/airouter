const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const { createUpstreamRequest, requestBuffered } = require('../app/upstream-request');

function createMockResponse({ statusCode = 200, headers = {} } = {}) {
  const response = new PassThrough();
  const originalEnd = response.end.bind(response);

  response.statusCode = statusCode;
  response.headers = headers;
  response.complete = false;
  response.end = (...args) => {
    response.complete = true;
    return originalEnd(...args);
  };

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
