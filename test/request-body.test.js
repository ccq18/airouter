const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { RequestBodyError, readRequestBody } = require('../app/request-body');

function createRequest(headers = {}) {
  const req = new EventEmitter();
  req.headers = headers;
  req.readableEnded = false;
  req.resumeCalls = 0;
  req.resume = () => {
    req.resumeCalls += 1;
  };
  return req;
}

test('readRequestBody collects a request within the configured limit', async () => {
  const req = createRequest({ 'content-length': '6' });
  const bodyPromise = readRequestBody(req, {
    limitBytes: 8,
    idleTimeoutMs: 100,
  });

  req.emit('data', Buffer.from('abc'));
  req.emit('data', Buffer.from('def'));
  req.readableEnded = true;
  req.emit('end');

  assert.equal((await bodyPromise).toString('utf8'), 'abcdef');
});

test('readRequestBody rejects an oversized declared content length before buffering', async () => {
  const req = createRequest({ 'content-length': '9' });

  await assert.rejects(
    readRequestBody(req, {
      limitBytes: 8,
      idleTimeoutMs: 100,
    }),
    error => {
      assert.ok(error instanceof RequestBodyError);
      assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
      assert.equal(error.statusCode, 413);
      return true;
    }
  );
  assert.equal(req.resumeCalls, 1);
});

test('readRequestBody rejects a chunked body once the configured limit is exceeded', async () => {
  const req = createRequest();
  const bodyPromise = readRequestBody(req, {
    limitBytes: 5,
    idleTimeoutMs: 100,
  });

  req.emit('data', Buffer.from('abc'));
  req.emit('data', Buffer.from('def'));

  await assert.rejects(bodyPromise, error => {
    assert.equal(error.code, 'PAYLOAD_TOO_LARGE');
    return true;
  });
  assert.equal(req.resumeCalls, 1);
});

test('readRequestBody rejects an idle upload', async () => {
  const req = createRequest();

  await assert.rejects(
    readRequestBody(req, {
      limitBytes: 8,
      idleTimeoutMs: 20,
    }),
    error => {
      assert.equal(error.code, 'REQUEST_BODY_TIMEOUT');
      assert.equal(error.statusCode, 408);
      return true;
    }
  );
});
