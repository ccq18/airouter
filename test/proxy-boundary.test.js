const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  buildProxyHeaders,
  classifyApiKeyUpstreamFailure,
  isResponsesFailoverInspectionCandidate,
  normalizeProxyJsonBody,
  shouldForceResponsesStoreFalse,
} = require('../openai');
const { createClaudeMessagesHandler } = require('../app/claude-messages-handler');

function createJsonResponseRecorder() {
  const res = new EventEmitter();
  return Object.assign(res, {
    headersSent: false,
    writableEnded: false,
    statusCode: null,
    headers: {},
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    write() {
      this.headersSent = true;
    },
    end() {
      this.writableEnded = true;
      this.headersSent = true;
    },
    send(body) {
      this.headersSent = true;
      this.writableEnded = true;
      this.payload = body;
      return this;
    },
    json(body) {
      this.headersSent = true;
      this.writableEnded = true;
      this.payload = body;
      return this;
    },
  });
}

function createClaudeRequest(body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.baseUrl = '';
  req.url = '/v1/messages';
  req.headers = {
    'content-type': 'application/json',
  };

  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });

  return req;
}

function createUpstreamResponse(statusCode, headers, body) {
  const response = new PassThrough();
  response.statusCode = statusCode;
  response.headers = headers;
  process.nextTick(() => {
    response.end(body);
  });
  return response;
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
    type: 'apikey',
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

test('isResponsesFailoverInspectionCandidate inspects upstream auth failures', () => {
  assert.equal(isResponsesFailoverInspectionCandidate(401, {
    'content-type': 'application/json',
  }), true);
});

test('shouldForceResponsesStoreFalse only adapts token-backed Codex responses requests', () => {
  assert.equal(shouldForceResponsesStoreFalse({
    type: 'token',
  }, '/backend-api/codex/responses'), true);
  assert.equal(shouldForceResponsesStoreFalse({
    type: 'apikey',
  }, '/v1/responses'), false);
  assert.equal(shouldForceResponsesStoreFalse({
    type: 'token',
  }, '/backend-api/codex/chat/completions'), false);
});

test('classifyApiKeyUpstreamFailure marks auth, rate limit, and server failures only for apikey configs', () => {
  const apiKeyConfig = {
    type: 'apikey',
  };

  assert.deepEqual(classifyApiKeyUpstreamFailure(apiKeyConfig, 401), {
    reason: 'apikey_auth_failed',
    retryKey: '401',
    retrySource: 'http',
  });
  assert.deepEqual(classifyApiKeyUpstreamFailure(apiKeyConfig, 429), {
    reason: 'apikey_rate_limited',
    retryKey: '429',
    retrySource: 'http',
  });
  assert.deepEqual(classifyApiKeyUpstreamFailure(apiKeyConfig, 503), {
    reason: 'apikey_upstream_5xx',
    retryKey: '503',
    retrySource: 'http',
  });
  assert.equal(classifyApiKeyUpstreamFailure(apiKeyConfig, 400), null);
  assert.equal(classifyApiKeyUpstreamFailure({ type: 'token' }, 503), null);
});

test('normalizeProxyJsonBody adapts store true for token-backed Codex responses requests', () => {
  const normalized = normalizeProxyJsonBody({
    type: 'token',
  }, '/backend-api/codex/responses', {
    model: 'gpt-5.5',
    input: 'hello',
    store: true,
  }, {});

  assert.equal(normalized.store, false);
});

test('server registers Claude messages compatibility on /v1/messages only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');

  assert.match(source, /app\.post\('\/v1\/messages'/);
  assert.doesNotMatch(source, /app\.post\('\/claude\/v1\/messages'/);
});

test('createClaudeMessagesHandler rejects apikey configs with a clear error before contacting upstream', async () => {
  let upstreamCalled = false;
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'apikey',
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
  req.baseUrl = '';
  req.url = '/v1/messages';
  req.headers = {
    'content-type': 'application/json',
  };

  const res = createJsonResponseRecorder();

  await handler(req, res);

  assert.equal(upstreamCalled, false);
  assert.equal(res.statusCode, 400);
  assert.match(res.payload.error, /Unsupported Mode/);
  assert.match(res.payload.message, /\/v1\/messages/);
  assert.doesNotMatch(res.payload.message, /\/claude\/v1\/messages/);
  assert.match(res.payload.message, /apikey/);
  assert.match(res.payload.message, /token/);
});

test('createClaudeMessagesHandler forwards apikey configs with claude support without responses conversion', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'apikey',
      index: 0,
      description: 'Claude API config',
      apiKey: 'upstream-claude-key',
      baseUrl: 'https://claude.example.com/v1',
      support: ['claude'],
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      return {
        responsePromise: Promise.resolve(createUpstreamResponse(200, {
          'content-type': 'application/json',
        }, JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: 'hello',
            },
          ],
        }))),
        abort() {},
      };
    },
  });

  const res = createJsonResponseRecorder();
  const body = {
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  };

  await handler(createClaudeRequest(body), res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].targetUrl, 'https://claude.example.com/v1/messages?client_version=1');
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer upstream-claude-key');
  assert.equal(upstreamRequests[0].headers['chatgpt-account-id'], undefined);
  assert.deepEqual(JSON.parse(upstreamRequests[0].body.toString('utf8')), body);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
});

test('createClaudeMessagesHandler marks direct claude apikey upstream failures unavailable', async () => {
  const config = {
    type: 'apikey',
    index: 0,
    description: 'claude upstream',
    apiKey: 'upstream-claude-key',
    baseUrl: 'https://claude.example.com',
    support: ['claude'],
  };
  const classifications = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => config,
    handleRetryableUpstreamError: (failedConfig, classification) => {
      classifications.push({ failedConfig, classification });
      return null;
    },
    createUpstreamRequest: () => ({
      responsePromise: Promise.resolve(createUpstreamResponse(429, {
        'content-type': 'application/json',
      }, JSON.stringify({
        error: {
          message: 'rate limited',
        },
      }))),
      abort() {},
    }),
  });
  const res = createJsonResponseRecorder();

  await handler(createClaudeRequest({
    model: 'claude-sonnet-4',
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  }), res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(res.statusCode, 429);
  assert.equal(classifications.length, 1);
  assert.equal(classifications[0].failedConfig, config);
  assert.deepEqual(classifications[0].classification, {
    reason: 'apikey_rate_limited',
    retryKey: '429',
    retrySource: 'http',
  });
});

test('createClaudeMessagesHandler retries retryable upstream usage-limit errors with the next config', async () => {
  const configs = [
    {
      type: 'token',
      index: 0,
      description: 'primary',
      access_token: 'token-1',
      account_id: 'account-1',
      baseUrl: 'https://chatgpt.com',
      apiBasePath: '/backend-api/codex',
    },
    {
      type: 'token',
      index: 1,
      description: 'backup',
      access_token: 'token-2',
      account_id: 'account-2',
      baseUrl: 'https://chatgpt.com',
      apiBasePath: '/backend-api/codex',
    },
  ];
  const upstreamAccountIds = [];
  const classifications = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => configs[0],
    handleRetryableUpstreamError: (config, classification) => {
      classifications.push({ config, classification });
      return configs[1];
    },
    createUpstreamRequest: request => {
      upstreamAccountIds.push(request.headers['chatgpt-account-id']);
      if (upstreamAccountIds.length === 1) {
        return {
          responsePromise: Promise.resolve(createUpstreamResponse(429, {
            'content-type': 'application/json',
          }, JSON.stringify({
            error: {
              type: 'usage_limit_reached',
            },
          }))),
          abort() {},
        };
      }

      const events = [
        'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}',
        '',
        'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message"}}',
        '',
        'data: {"type":"response.content_part.added","item_id":"msg_1","content_index":0,"part":{"type":"output_text"}}',
        '',
        'data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"hello"}',
        '',
        'data: {"type":"response.content_part.done","item_id":"msg_1","content_index":0}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
        '',
      ].join('\n');

      return {
        responsePromise: Promise.resolve(createUpstreamResponse(200, {
          'content-type': 'text/event-stream',
        }, events)),
        abort() {},
      };
    },
  });

  const res = createJsonResponseRecorder();
  await handler(createClaudeRequest({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  }), res);

  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(upstreamAccountIds, ['account-1', 'account-2']);
  assert.equal(classifications[0].classification.reason, 'responses_usage_limit_reached');
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
});
