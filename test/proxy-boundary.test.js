const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { buildProxyHeaders } = require('../openai');
const { createClaudeMessagesHandler } = require('../app/claude-messages-handler');

function createJsonResponseRecorder() {
  return {
    headersSent: false,
    statusCode: null,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.headersSent = true;
      this.payload = body;
      return this;
    },
  };
}

test('buildProxyHeaders strips local-only auth headers before forwarding upstream', () => {
  const headers = buildProxyHeaders({
    authorization: 'Bearer local-router-secret',
    'X-API-Key': 'local-router-secret',
    'chatgpt-account-id': 'local-account-id',
    'x-admin-token': 'admin-secret',
    'x-airouter-trace': 'trace-id',
    'accept-language': 'zh-CN',
    host: 'localhost:3009',
    connection: 'keep-alive',
  }, {
    type: 'api_key',
    apiKey: 'upstream-api-key',
  }, 27);

  assert.equal(headers.authorization, 'Bearer upstream-api-key');
  assert.equal(headers['X-API-Key'], undefined);
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['chatgpt-account-id'], undefined);
  assert.equal(headers['x-admin-token'], undefined);
  assert.equal(headers['x-airouter-trace'], undefined);
  assert.equal(headers.host, undefined);
  assert.equal(headers.connection, undefined);
  assert.equal(headers['accept-language'], 'zh-CN');
  assert.equal(headers['content-length'], '27');
});

test('createClaudeMessagesHandler rejects api_key mode with a clear error before contacting upstream', async () => {
  let upstreamCalled = false;
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'api_key',
      index: 0,
      description: 'APIKey config',
      apiKey: 'upstream-api-key',
      baseUrl: 'https://example.com',
    }),
    createUpstreamRequest: () => {
      upstreamCalled = true;
      throw new Error('should not be called');
    },
  });

  const req = new EventEmitter();
  req.method = 'POST';
  req.baseUrl = '/claude';
  req.url = '/v1/messages';
  req.headers = {
    'content-type': 'application/json',
  };

  const res = createJsonResponseRecorder();

  await handler(req, res);

  assert.equal(upstreamCalled, false);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /Unsupported Mode/);
  assert.match(res.payload.message, /\/claude\/v1\/messages/);
  assert.match(res.payload.message, /api_key/);
  assert.match(res.payload.message, /token/);
});
