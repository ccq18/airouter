const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  buildProxyHeaders,
  classifyApiKeyUpstreamFailure,
  classifyTokenUpstreamFailure,
  createResponseModelObserver,
  defaultContentTypeForProxyResponse,
  extractResponseModelFromPayload,
  hasRequestFailoverRetriesRemaining,
  isStreamingResponsesRequest,
  isResponsesFailoverInspectionCandidate,
  MAX_REQUEST_FAILOVER_RETRIES,
  normalizeProxyJsonBody,
  shouldForceResponsesStoreFalse,
  createImageGenerationsHandler,
} = require('../openai');
const {
  DEFAULT_MAX_FAILOVER_RETRIES,
  createClaudeMessagesHandler,
  hasFailoverRetriesRemaining,
} = require('../app/claude-messages-handler');

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
    flushHeaders() {
      this.headersSent = true;
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

function createJsonRequest(url, body) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.baseUrl = '';
  req.url = url;
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

test('request failover retry helpers allow only two replays', () => {
  assert.equal(MAX_REQUEST_FAILOVER_RETRIES, 2);
  assert.equal(DEFAULT_MAX_FAILOVER_RETRIES, 2);
  assert.equal(hasRequestFailoverRetriesRemaining(0), true);
  assert.equal(hasRequestFailoverRetriesRemaining(1), true);
  assert.equal(hasRequestFailoverRetriesRemaining(2), false);
  assert.equal(hasFailoverRetriesRemaining(0, DEFAULT_MAX_FAILOVER_RETRIES), true);
  assert.equal(hasFailoverRetriesRemaining(1, DEFAULT_MAX_FAILOVER_RETRIES), true);
  assert.equal(hasFailoverRetriesRemaining(2, DEFAULT_MAX_FAILOVER_RETRIES), false);
});

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

test('isResponsesFailoverInspectionCandidate inspects upstream HTTP errors', () => {
  assert.equal(isResponsesFailoverInspectionCandidate(401, {
    'content-type': 'application/json',
  }), true);
  assert.equal(isResponsesFailoverInspectionCandidate(400, {
    'content-type': 'application/json',
  }), true);
  assert.equal(isResponsesFailoverInspectionCandidate(503, {
    'content-type': 'application/json',
  }), true);
  assert.equal(isResponsesFailoverInspectionCandidate(201, {
    'content-type': 'application/json',
  }), true);
  assert.equal(isResponsesFailoverInspectionCandidate(200, {
    'content-type': 'application/json',
  }), false);
});

test('isResponsesFailoverInspectionCandidate inspects successful JSON when model downgrade is possible', () => {
  assert.equal(isResponsesFailoverInspectionCandidate(200, {
    'content-type': 'application/json',
  }, {
    requestedModel: 'gpt-5.5',
  }), true);
  assert.equal(isResponsesFailoverInspectionCandidate(200, {
    'content-type': 'application/json',
  }, {
    requestedModel: 'gpt-5.4-mini',
  }), false);
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
  assert.deepEqual(classifyApiKeyUpstreamFailure(apiKeyConfig, 400), {
    reason: 'apikey_upstream_error',
    retryKey: '400',
    retrySource: 'http',
  });
  assert.deepEqual(classifyApiKeyUpstreamFailure(apiKeyConfig, 201), {
    reason: 'apikey_upstream_error',
    retryKey: '201',
    retrySource: 'http',
  });
  assert.equal(classifyApiKeyUpstreamFailure({ type: 'token' }, 503), null);
});

test('classifyTokenUpstreamFailure treats any non-success token status as failoverable', () => {
  const tokenConfig = {
    type: 'token',
  };

  assert.equal(classifyTokenUpstreamFailure(tokenConfig, 200), null);
  assert.deepEqual(classifyTokenUpstreamFailure(tokenConfig, 400), {
    reason: 'responses_upstream_error',
    retryKey: '400',
    retrySource: 'http',
  });
  assert.deepEqual(classifyTokenUpstreamFailure(tokenConfig, 503), {
    reason: 'responses_upstream_error',
    retryKey: '503',
    retrySource: 'http',
  });
  assert.equal(classifyTokenUpstreamFailure({ type: 'apikey' }, 503), null);
});

test('normalizeProxyJsonBody adapts OpenAI Responses payloads for token-backed Codex requests', () => {
  const normalized = normalizeProxyJsonBody({
    type: 'token',
  }, '/backend-api/codex/responses', {
    model: 'gpt-5.5',
    input: 'hello',
    max_output_tokens: 128,
    temperature: 0,
    store: true,
  }, {});

  assert.deepEqual(normalized.input, [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'hello',
        },
      ],
    },
  ]);
  assert.equal(normalized.store, false);
  assert.equal(Object.hasOwn(normalized, 'max_output_tokens'), false);
  assert.equal(Object.hasOwn(normalized, 'temperature'), false);
});

test('normalizeProxyJsonBody applies CPA style only when explicitly requested', () => {
  const normalized = normalizeProxyJsonBody({
    type: 'token',
  }, '/backend-api/codex/responses', {
    model: 'gpt-5.5',
    instructions: 'project rules',
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'system rules',
          },
        ],
      },
    ],
    store: true,
  }, {}, {
    cpaStyleCompatibility: true,
  });

  assert.equal(normalized.instructions, '');
  assert.equal(normalized.input[0].role, 'developer');
  assert.equal(normalized.input[0].content[0].text, 'project rules');
  assert.equal(normalized.input[1].role, 'developer');
  assert.equal(normalized.store, false);
});

test('normalizeProxyJsonBody preserves OpenAI Responses parameters for apikey upstreams', () => {
  const normalized = normalizeProxyJsonBody({
    type: 'apikey',
  }, '/v1/responses', {
    model: 'gpt-5.5',
    input: 'hello',
    max_output_tokens: 128,
    temperature: 0,
    store: true,
  }, {});

  assert.equal(normalized.input, 'hello');
  assert.equal(normalized.max_output_tokens, 128);
  assert.equal(normalized.temperature, 0);
  assert.equal(normalized.store, true);
});

test('defaultContentTypeForProxyResponse fills SSE content type for streaming Responses requests', () => {
  assert.equal(
    defaultContentTypeForProxyResponse('/backend-api/codex/responses', Buffer.from(JSON.stringify({ stream: true }))),
    'text/event-stream; charset=utf-8',
  );
  assert.equal(
    defaultContentTypeForProxyResponse('/v1/responses', Buffer.from(JSON.stringify({ input: 'hello' }))),
    'text/event-stream; charset=utf-8',
  );
  assert.equal(
    defaultContentTypeForProxyResponse('/v1/responses', Buffer.from(JSON.stringify({ stream: false }))),
    null,
  );
  assert.equal(defaultContentTypeForProxyResponse('/v1/models', Buffer.from('{}')), null);
});

test('isStreamingResponsesRequest treats malformed Responses bodies as stream-compatible', () => {
  assert.equal(isStreamingResponsesRequest('/v1/responses', Buffer.from('{')), true);
  assert.equal(isStreamingResponsesRequest('/v1/responses', Buffer.from(JSON.stringify({ stream: false }))), false);
  assert.equal(isStreamingResponsesRequest('/v1/chat/completions', Buffer.from(JSON.stringify({ stream: true }))), false);
});

test('extractResponseModelFromPayload reads Responses model locations', () => {
  assert.equal(extractResponseModelFromPayload({
    type: 'response.created',
    response: {
      model: 'gpt-5.4-mini',
    },
  }), 'gpt-5.4-mini');
  assert.equal(extractResponseModelFromPayload({
    id: 'resp_1',
    model: 'gpt-5.5',
  }), 'gpt-5.5');
  assert.equal(extractResponseModelFromPayload({
    response: {},
  }), '');
});

test('createResponseModelObserver extracts response models from SSE and JSON bodies', () => {
  const observed = [];
  const sseObserver = createResponseModelObserver({
    contentType: 'text/event-stream; charset=utf-8',
    onModel: model => observed.push(model),
  });
  sseObserver.push(Buffer.from([
    'event: response.created',
    'data: {"type":"response.created","response":{"model":"gpt-5.4-mini"}}',
    '',
  ].join('\n')));
  sseObserver.finish();

  const jsonObserver = createResponseModelObserver({
    contentType: 'application/json',
    onModel: model => observed.push(model),
  });
  jsonObserver.push(Buffer.from(JSON.stringify({
    id: 'resp_1',
    model: 'gpt-5.5',
  })));
  jsonObserver.finish();

  assert.deepEqual(observed, ['gpt-5.4-mini', 'gpt-5.5']);
});

test('server registers Claude messages compatibility on /v1/messages and CPA prefix only', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');

  assert.match(source, /app\.post\('\/v1\/messages'/);
  assert.match(source, /app\.post\('\/cpa\/v1\/messages'/);
  assert.doesNotMatch(source, /app\.post\('\/claude\/v1\/messages'/);
});

test('server registers CPA prefix before the generic v1 proxy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const cpaMessagesRouteIndex = source.indexOf("app.post('/cpa/v1/messages'");
  const cpaProxyIndex = source.indexOf("app.use('/cpa/v1', requireConfiguredApiKeys, createCpaHandler())");
  const genericProxyIndex = source.indexOf("app.use('/v1', requireConfiguredApiKeys, createHandler())");

  assert.ok(cpaMessagesRouteIndex >= 0, 'CPA messages route should be registered');
  assert.ok(cpaProxyIndex >= 0, 'CPA generic proxy should be registered');
  assert.ok(cpaMessagesRouteIndex < cpaProxyIndex, 'CPA messages route should run before CPA generic proxy');
  assert.ok(cpaProxyIndex < genericProxyIndex, 'CPA generic proxy should run before generic v1 proxy');
});

test('server registers token image compatibility before the generic v1 proxy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const generationsRouteIndex = source.indexOf("app.post('/v1/images/generations'");
  const editsRouteIndex = source.indexOf("app.post('/v1/images/edits'");
  const genericProxyIndex = source.indexOf("app.use('/v1', requireConfiguredApiKeys, createHandler())");

  assert.ok(generationsRouteIndex >= 0, 'image generations compatibility route should be registered');
  assert.ok(editsRouteIndex >= 0, 'image edits compatibility route should be registered');
  assert.ok(generationsRouteIndex < genericProxyIndex, 'generations route should run before generic proxy');
  assert.ok(editsRouteIndex < genericProxyIndex, 'edits route should run before generic proxy');
});

test('server accepts configured Claude OAuth tokens only on Claude messages routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');

  assert.match(source, /function getClaudeMessagesConfiguredRequestAuthTokens\(parsedConfig\)/);
  assert.match(source, /if \(configuredApiKeys\.length === 0\)\s*{\s*return \[\];\s*}/);
  assert.match(source, /getConfiguredClaudeTokenRequestAuthTokens\(parsedConfig\)/);
  assert.match(source, /requestPath\.startsWith\('\/v1\/messages\/'\)/);
  assert.match(source, /requestPath\.startsWith\('\/cpa\/v1\/messages\/'\)/);
  assert.match(source, /isClaudeMessagesProxyPath\(req\)\s*\?\s*getClaudeMessagesConfiguredRequestAuthTokens\(currentParsedConfig\)\s*:\s*getConfiguredApiKeys\(currentParsedConfig\)/);
});

test('image generations token business request retries the next config before responding to the client', async () => {
  const configs = [
    {
      type: 'token',
      index: 0,
      description: 'primary token image',
      access_token: 'token-1',
      apiBasePath: '/backend-api/codex',
      baseUrl: 'https://chatgpt-primary.example.com',
      runtime: { available: true },
    },
    {
      type: 'token',
      index: 1,
      description: 'backup token image',
      access_token: 'token-2',
      apiBasePath: '/backend-api/codex',
      baseUrl: 'https://chatgpt-backup.example.com',
      runtime: { available: true },
    },
  ];
  const released = [];
  const unavailable = [];
  const requests = [];
  const accountManager = {
    getActiveConfig() {
      return null;
    },
    ensureActiveConfig() {
      return null;
    },
    acquireConfig(reason, predicate, options = {}) {
      const excluded = Array.isArray(options.exclude) ? options.exclude : [];
      const config = configs.find(item => predicate(item) && !excluded.includes(item));
      if (!config) {
        return null;
      }

      return {
        config,
        sessionKey: options.sessionKey || '',
        release: () => released.push(config.description),
      };
    },
    markConfigUnavailable(config, reason) {
      unavailable.push({ config, reason });
    },
  };
  const successfulImageEvent = [
    'event: response.output_item.done',
    `data: ${JSON.stringify({
      type: 'response.output_item.done',
      item: {
        type: 'image_generation_call',
        status: 'completed',
        result: Buffer.from('image-data').toString('base64'),
      },
    })}`,
    '',
  ].join('\n');
  const handler = createImageGenerationsHandler({
    accountManager,
    requestBuffered: async request => {
      requests.push(request);
      if (requests.length === 1) {
        const bodyText = JSON.stringify({
          error: {
            type: 'usage_limit_reached',
            message: 'primary exhausted',
          },
        });
        return {
          statusCode: 429,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(bodyText),
          bodyText,
        };
      }

      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Buffer.from(successfulImageEvent),
        bodyText: successfulImageEvent,
      };
    },
    now: () => 123000,
  });
  const res = createJsonResponseRecorder();

  await handler(createJsonRequest('/v1/images/generations', {
    prompt: 'draw a small red hat',
  }), res);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(requests.map(request => request.targetUrl), [
    'https://chatgpt-primary.example.com/backend-api/codex/responses',
    'https://chatgpt-backup.example.com/backend-api/codex/responses',
  ]);
  assert.deepEqual(requests.map(request => request.headers.authorization), [
    'Bearer token-1',
    'Bearer token-2',
  ]);
  assert.deepEqual(unavailable, [
    {
      config: configs[0],
      reason: 'responses_usage_limit_reached',
    },
  ]);
  assert.deepEqual(released, [
    'primary token image',
    'backup token image',
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    created: 123,
    data: [
      {
        b64_json: Buffer.from('image-data').toString('base64'),
      },
    ],
  });
});

test('image generations token business request retries malformed successful responses bodies', async () => {
  const configs = [
    {
      type: 'token',
      index: 0,
      description: 'primary token image',
      access_token: 'token-1',
      apiBasePath: '/backend-api/codex',
      baseUrl: 'https://chatgpt-primary.example.com',
      runtime: { available: true },
    },
    {
      type: 'token',
      index: 1,
      description: 'backup token image',
      access_token: 'token-2',
      apiBasePath: '/backend-api/codex',
      baseUrl: 'https://chatgpt-backup.example.com',
      runtime: { available: true },
    },
  ];
  const requests = [];
  const unavailable = [];
  const accountManager = {
    getActiveConfig() {
      return null;
    },
    ensureActiveConfig() {
      return null;
    },
    acquireConfig(reason, predicate, options = {}) {
      const excluded = Array.isArray(options.exclude) ? options.exclude : [];
      const config = configs.find(item => predicate(item) && !excluded.includes(item));
      return config
        ? {
          config,
          sessionKey: options.sessionKey || '',
          release() {},
        }
        : null;
    },
    markConfigUnavailable(config, reason, details) {
      unavailable.push({ config, reason, details });
    },
  };
  const successfulImageEvent = [
    'event: response.output_item.done',
    `data: ${JSON.stringify({
      type: 'response.output_item.done',
      item: {
        type: 'image_generation_call',
        status: 'completed',
        result: Buffer.from('image-data').toString('base64'),
      },
    })}`,
    '',
  ].join('\n');
  const handler = createImageGenerationsHandler({
    accountManager,
    requestBuffered: async request => {
      requests.push(request);
      if (requests.length === 1) {
        const bodyText = [
          'event: response.failed',
          'data: {"response":{"error":{"code":"server_is_overloaded","message":"server overloaded"}}}',
          '',
        ].join('\n');
        return {
          statusCode: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: Buffer.from(bodyText),
          bodyText,
        };
      }

      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Buffer.from(successfulImageEvent),
        bodyText: successfulImageEvent,
      };
    },
    now: () => 123000,
  });
  const res = createJsonResponseRecorder();

  await handler(createJsonRequest('/v1/images/generations', {
    prompt: 'draw a small red hat',
  }), res);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(requests.map(request => request.headers.authorization), [
    'Bearer token-1',
    'Bearer token-2',
  ]);
  assert.deepEqual(unavailable.map(item => ({
    config: item.config.description,
    reason: item.reason,
    lastError: item.details.lastError,
  })), [
    {
      config: 'primary token image',
      reason: 'responses_upstream_error',
      lastError: 'body:Responses 返回中没有 image_generation_call 结果',
    },
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, {
    created: 123,
    data: [
      {
        b64_json: Buffer.from('image-data').toString('base64'),
      },
    ],
  });
});

test('image generations token business request stops after two replay attempts', async () => {
  const configs = [0, 1, 2, 3].map(index => ({
    type: 'token',
    index,
    description: `token image ${index + 1}`,
    access_token: `token-${index + 1}`,
    apiBasePath: '/backend-api/codex',
    baseUrl: `https://chatgpt-${index + 1}.example.com`,
    runtime: { available: true },
  }));
  const requests = [];
  const released = [];
  const unavailable = [];
  const accountManager = {
    getActiveConfig() {
      return null;
    },
    ensureActiveConfig() {
      return null;
    },
    acquireConfig(reason, predicate, options = {}) {
      const excluded = Array.isArray(options.exclude) ? options.exclude : [];
      const config = configs.find(item => predicate(item) && !excluded.includes(item));
      return config
        ? {
          config,
          sessionKey: options.sessionKey || '',
          release: () => released.push(config.description),
        }
        : null;
    },
    markConfigUnavailable(config, reason) {
      unavailable.push({ config, reason });
    },
  };
  const bodyText = JSON.stringify({
    error: {
      type: 'usage_limit_reached',
      message: 'still exhausted',
    },
  });
  const handler = createImageGenerationsHandler({
    accountManager,
    requestBuffered: async request => {
      requests.push(request);
      return {
        statusCode: 429,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(bodyText),
        bodyText,
      };
    },
  });
  const res = createJsonResponseRecorder();

  await handler(createJsonRequest('/v1/images/generations', {
    prompt: 'draw a small red hat',
  }), res);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(requests.map(request => request.headers.authorization), [
    'Bearer token-1',
    'Bearer token-2',
    'Bearer token-3',
  ]);
  assert.equal(requests.some(request => request.headers.authorization === 'Bearer token-4'), false);
  assert.deepEqual(unavailable.map(item => ({
    config: item.config.description,
    reason: item.reason,
  })), [
    {
      config: 'token image 1',
      reason: 'responses_usage_limit_reached',
    },
    {
      config: 'token image 2',
      reason: 'responses_usage_limit_reached',
    },
    {
      config: 'token image 3',
      reason: 'responses_usage_limit_reached',
    },
  ]);
  assert.deepEqual(released, [
    'token image 1',
    'token image 2',
    'token image 3',
  ]);
  assert.equal(res.statusCode, 429);
  assert.equal(res.writableEnded, true);
});

test('image generations apikey business request keeps native Images forwarding', async () => {
  const config = {
    type: 'apikey',
    index: 0,
    description: 'native image apikey',
    apiKey: 'native-image-key',
    baseUrl: 'https://images.example.com/v1',
    support: ['gpt'],
    runtime: { enabled: true, available: true },
  };
  const requests = [];
  const observations = [];
  const acquiredReasons = [];
  const accountManager = {
    getActiveConfig(predicate) {
      return predicate(config) ? config : null;
    },
    acquireConfig(reason, predicate, options) {
      acquiredReasons.push({ reason, allowFallback: options && options.allowFallback });
      assert.equal(predicate({ type: 'token' }), true);
      return null;
    },
    ensureActiveConfig() {
      return null;
    },
    recordApiKeyRequestResult(observedConfig, result) {
      observations.push({ observedConfig, result });
      return { unavailable: false, sampleSize: 1, failureCount: 0 };
    },
  };
  const bodyText = JSON.stringify({
    created: 123,
    data: [
      {
        b64_json: 'bmF0aXZlLWltYWdl',
      },
    ],
  });
  const handler = createImageGenerationsHandler({
    accountManager,
    requestBuffered: async request => {
      requests.push(request);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(bodyText),
        bodyText,
      };
    },
  });
  const res = createJsonResponseRecorder();

  await handler(createJsonRequest('/v1/images/generations', {
    prompt: 'draw a small red hat',
    n: 2,
  }), res);
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(acquiredReasons, [
    {
      reason: 'image_request',
      allowFallback: false,
    },
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].targetUrl, 'https://images.example.com/v1/images/generations?client_version=1');
  assert.equal(requests[0].headers.authorization, 'Bearer native-image-key');
  assert.deepEqual(observations, [
    {
      observedConfig: config,
      result: { ok: true },
    },
  ]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.writableEnded, true);
});

test('server defaults upstream requests to the official SDK timeout window', () => {
  const openaiSource = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const upstreamSource = fs.readFileSync(path.join(__dirname, '..', 'app/upstream-request.js'), 'utf8');

  assert.match(openaiSource, /UPSTREAM_REQUEST_TIMEOUT_MS', 10 \* 60 \* 1000/);
  assert.match(openaiSource, /APIKEY_RECOVERY_TIMEOUT_MS', 10 \* 60 \* 1000/);
  assert.match(openaiSource, /ALL_QUOTA_CHECK_INTERVAL_MS = 3 \* 60 \* 1000/);
  assert.match(upstreamSource, /DEFAULT_UPSTREAM_REQUEST_TIMEOUT_MS = 10 \* 60 \* 1000/);
});

test('generic apikey proxy records success after committing the upstream response to the client', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const startForwardingIndex = source.indexOf('function startForwardingResponse');
  const flushHeadersIndex = source.indexOf('res.flushHeaders();', startForwardingIndex);
  const successRecordIndex = source.indexOf('recordCurrentApiKeyRequestResult({ ok: true })', flushHeadersIndex);
  const responseEndIndex = source.indexOf("response.on('end'", startForwardingIndex);
  const responseErrorIndex = source.indexOf("response.on('error'", startForwardingIndex);
  const responseResumeIndex = source.indexOf('response.resume();', responseErrorIndex);
  const responseErrorBlock = source.slice(responseErrorIndex, responseResumeIndex);

  assert.notEqual(startForwardingIndex, -1);
  assert.notEqual(flushHeadersIndex, -1);
  assert.notEqual(successRecordIndex, -1);
  assert.notEqual(responseEndIndex, -1);
  assert.notEqual(responseErrorIndex, -1);
  assert.ok(successRecordIndex < responseEndIndex);
  assert.match(responseErrorBlock, /if \(!res\.headersSent\) \{\n\s+recordCurrentApiKeyRequestResult\(\{\n\s+ok: false/);
  assert.equal(source.includes('accountManager.recordApiKeyRequestResult(config, { ok: true })'), false);
});

test('generic OpenAI proxy tries token configs before GPT apikey fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const createHandlerIndex = source.indexOf("function createHandler(proxyPath = '', options = {})");
  const acquireProxyLeaseIndex = source.indexOf('function acquireProxyLease(sessionKey, excludedConfigs = [])', createHandlerIndex);
  const acquireProxyLeaseEnd = source.indexOf('function forwardWithConfig', acquireProxyLeaseIndex);
  const acquireProxyLeaseBody = source.slice(acquireProxyLeaseIndex, acquireProxyLeaseEnd);

  assert.notEqual(createHandlerIndex, -1);
  assert.notEqual(acquireProxyLeaseIndex, -1);
  assert.match(acquireProxyLeaseBody, /return acquireTokenThenGptApiKeyLease\(accountManager, 'proxy_request', sessionKey, excludedConfigs\)/);
  assert.doesNotMatch(acquireProxyLeaseBody, /getActiveConfig\(item => isGptApiKeyProxyConfig/);
});

test('createClaudeMessagesHandler converts apikey configs without claude support through responses compatibility', async () => {
  const upstreamRequests = [];
  const apiKeyResults = [];
  const handler = createClaudeMessagesHandler({
    upstreamModel: 'configured-model-should-not-be-used',
    getConfig: () => ({
      type: 'apikey',
      index: 0,
      description: 'OpenAI compatible config',
      apiKey: 'upstream-api-key',
      baseUrl: 'https://api.example.com/v1',
      support: ['gpt'],
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
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
    observeApiKeyRequestResult: (config, result) => {
      apiKeyResults.push({ config, result });
    },
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

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].targetUrl, 'https://api.example.com/v1/responses?client_version=1.0.1');
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer upstream-api-key');
  assert.equal(upstreamRequests[0].headers['chatgpt-account-id'], undefined);
  assert.equal(upstreamRequests[0].headers.version, undefined);
  assert.equal(upstreamRequests[0].headers.accept, 'text/event-stream');
  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.model, 'gpt-5.5');
  assert.deepEqual(upstreamBody.input, [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'hello',
        },
      ],
    },
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
  assert.equal(apiKeyResults.length, 1);
  assert.equal(apiKeyResults[0].config.description, 'OpenAI compatible config');
  assert.deepEqual(apiKeyResults[0].result, { ok: true });
});

test('createClaudeMessagesHandler normalizes MCP tool schemas for token-backed responses compatibility', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'token',
      index: 0,
      description: 'token config',
      access_token: 'token-1',
      account_id: 'account-1',
      baseUrl: 'https://chatgpt.com',
      apiBasePath: '/backend-api/codex',
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      const events = [
        'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.5"}}',
        '',
        'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.5","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}',
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
    model: 'claude-sonnet-4',
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
    tools: [
      {
        name: 'mcp__chrome-devtools__click',
        description: 'Clicks on the provided element',
        input_schema: {
          type: 'object',
          properties: {
            uid: {
              type: 'string',
            },
            options: {
              type: 'object',
              properties: {
                button: {
                  type: 'string',
                },
              },
              additionalProperties: true,
            },
          },
          required: ['uid'],
          additionalProperties: true,
        },
      },
    ],
  }), res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].targetUrl, 'https://chatgpt.com/backend-api/codex/responses?client_version=1.0.1');
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer token-1');
  assert.equal(upstreamRequests[0].headers['chatgpt-account-id'], 'account-1');
  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  const clickParameters = upstreamBody.tools[0].parameters;
  assert.equal(upstreamBody.tools[0].name, 'mcp__chrome-devtools__click');
  assert.equal(clickParameters.additionalProperties, false);
  assert.equal(clickParameters.properties.options.additionalProperties, false);
});

test('createClaudeMessagesHandler forwards apikey configs with claude support without responses conversion', async () => {
  const upstreamRequests = [];
  const apiKeyResults = [];
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
    observeApiKeyRequestResult: (config, result) => {
      apiKeyResults.push({ config, result });
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
  assert.equal(apiKeyResults.length, 1);
  assert.equal(apiKeyResults[0].config.description, 'Claude API config');
  assert.deepEqual(apiKeyResults[0].result, { ok: true });
});

test('createClaudeMessagesHandler forwards claude_token configs by replacing auth only', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'claude_token',
      index: 0,
      description: 'Claude OAuth config',
      access_token: 'real-claude-oauth-token',
      baseUrl: 'https://api.anthropic.com/v1',
      runtime: { enabled: true, available: true },
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
              text: 'hello from oauth',
            },
          ],
        }))),
        abort() {},
      };
    },
  });

  const req = createClaudeRequest({
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  });
  req.headers.authorization = 'Bearer local-airouter-oauth-token';
  req.headers['x-api-key'] = 'local-airouter-api-key';
  req.headers['anthropic-version'] = '2023-06-01';
  req.headers['anthropic-beta'] = 'oauth-2025-04-20,claude-code-20250219';
  req.headers['user-agent'] = 'claude-code/2.0.0';
  req.headers['x-app'] = 'cli';
  req.headers['x-claude-code-session-id'] = 'session-example';
  req.headers['x-client-request-id'] = 'client-request-example';
  req.headers['x-stainless-package-version'] = '0.68.0';
  req.headers['x-stainless-runtime'] = 'node';
  req.headers['anthropic-dangerous-direct-browser-access'] = 'true';
  req.headers.host = 'localhost:3009';
  req.headers.connection = 'keep-alive';

  const res = createJsonResponseRecorder();

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].targetUrl, 'https://api.anthropic.com/v1/messages');
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer real-claude-oauth-token');
  assert.equal(upstreamRequests[0].headers['x-api-key'], undefined);
  assert.equal(upstreamRequests[0].headers.host, undefined);
  assert.equal(upstreamRequests[0].headers.connection, undefined);
  assert.equal(upstreamRequests[0].headers['anthropic-version'], '2023-06-01');
  assert.equal(upstreamRequests[0].headers['anthropic-beta'], 'oauth-2025-04-20,claude-code-20250219');
  assert.equal(upstreamRequests[0].headers['user-agent'], 'claude-code/2.0.0');
  assert.equal(upstreamRequests[0].headers['x-app'], 'cli');
  assert.equal(upstreamRequests[0].headers['x-claude-code-session-id'], 'session-example');
  assert.equal(upstreamRequests[0].headers['x-client-request-id'], 'client-request-example');
  assert.equal(upstreamRequests[0].headers['x-stainless-package-version'], '0.68.0');
  assert.equal(upstreamRequests[0].headers['x-stainless-runtime'], 'node');
  assert.equal(upstreamRequests[0].headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.deepEqual(JSON.parse(upstreamRequests[0].body.toString('utf8')), {
    model: 'claude-sonnet-4-5',
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.content[0].text, 'hello from oauth');
});

test('createClaudeMessagesHandler handles Claude Code quota check locally', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'claude_token',
      index: 0,
      description: 'Claude OAuth config',
      access_token: 'real-claude-oauth-token',
      baseUrl: 'https://api.anthropic.com/v1',
      runtime: { enabled: true, available: true },
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      return {
        responsePromise: Promise.resolve(createUpstreamResponse(500, {
          'content-type': 'application/json',
        }, '{}')),
        abort() {},
      };
    },
  });

  const req = createClaudeRequest({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [
      {
        role: 'user',
        content: 'quota',
      },
    ],
    metadata: {
      user_id: '{"session_id":"session-example"}',
    },
  });
  req.headers.authorization = 'Bearer local-airouter-oauth-token';
  req.headers['x-app'] = 'cli';
  req.headers['user-agent'] = 'claude-code/2.1.185';
  req.headers['x-claude-code-session-id'] = 'session-example';
  req.headers['anthropic-version'] = '2023-06-01';

  const res = createJsonResponseRecorder();

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 0);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.type, 'message');
  assert.equal(res.payload.role, 'assistant');
  assert.equal(res.payload.model, 'claude-haiku-4-5-20251001');
  assert.equal(res.payload.content[0].type, 'text');
  assert.equal(res.payload.stop_reason, 'end_turn');
  assert.equal(res.payload.usage.output_tokens, 1);
});

test('createClaudeMessagesHandler handles Claude Code quota check without session header', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'claude_token',
      index: 0,
      description: 'Claude OAuth config',
      access_token: 'real-claude-oauth-token',
      baseUrl: 'https://api.anthropic.com/v1',
      runtime: { enabled: true, available: true },
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      return {
        responsePromise: Promise.resolve(createUpstreamResponse(500, {
          'content-type': 'application/json',
        }, '{}')),
        abort() {},
      };
    },
  });

  const req = createClaudeRequest({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'quota',
          },
        ],
      },
    ],
  });
  req.headers.authorization = 'Bearer local-airouter-oauth-token';
  req.headers['x-app'] = 'cli';
  req.headers['user-agent'] = 'claude-code/2.1.185';
  req.headers['anthropic-version'] = '2023-06-01';

  const res = createJsonResponseRecorder();

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 0);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.type, 'message');
  assert.equal(res.payload.content[0].text, 'ok');
});

test('createClaudeMessagesHandler forwards quota-shaped requests from non-Claude clients', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'claude_token',
      index: 0,
      description: 'Claude OAuth config',
      access_token: 'real-claude-oauth-token',
      baseUrl: 'https://api.anthropic.com/v1',
      runtime: { enabled: true, available: true },
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      return {
        responsePromise: Promise.resolve(createUpstreamResponse(200, {
          'content-type': 'application/json',
        }, JSON.stringify({
          id: 'msg_upstream',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [
            {
              type: 'text',
              text: 'upstream',
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        }))),
        abort() {},
      };
    },
  });

  const req = createClaudeRequest({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1,
    messages: [
      {
        role: 'user',
        content: 'quota',
      },
    ],
  });
  req.headers.authorization = 'Bearer local-airouter-oauth-token';
  req.headers['anthropic-version'] = '2023-06-01';

  const res = createJsonResponseRecorder();

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.content[0].text, 'upstream');
});

test('createClaudeMessagesHandler forwards normal Claude Code quota text requests', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'claude_token',
      index: 0,
      description: 'Claude OAuth config',
      access_token: 'real-claude-oauth-token',
      baseUrl: 'https://api.anthropic.com/v1',
      runtime: { enabled: true, available: true },
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      return {
        responsePromise: Promise.resolve(createUpstreamResponse(200, {
          'content-type': 'application/json',
        }, JSON.stringify({
          id: 'msg_upstream',
          type: 'message',
          role: 'assistant',
          model: 'claude-haiku-4-5-20251001',
          content: [
            {
              type: 'text',
              text: 'upstream',
            },
          ],
          stop_reason: 'end_turn',
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
        }))),
        abort() {},
      };
    },
  });

  const req = createClaudeRequest({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2,
    messages: [
      {
        role: 'user',
        content: 'quota',
      },
    ],
  });
  req.headers.authorization = 'Bearer local-airouter-oauth-token';
  req.headers['x-app'] = 'cli';
  req.headers['user-agent'] = 'claude-code/2.1.185';
  req.headers['anthropic-version'] = '2023-06-01';

  const res = createJsonResponseRecorder();

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.content[0].text, 'upstream');
});

test('createClaudeMessagesHandler forwards Claude count_tokens subpath with claude_token auth', async () => {
  const upstreamRequests = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => ({
      type: 'claude_token',
      index: 0,
      description: 'Claude OAuth config',
      access_token: 'real-claude-oauth-token',
      baseUrl: 'https://api.anthropic.com/v1',
      runtime: { enabled: true, available: true },
    }),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      return {
        responsePromise: Promise.resolve(createUpstreamResponse(200, {
          'content-type': 'application/json',
        }, JSON.stringify({
          input_tokens: 8,
        }))),
        abort() {},
      };
    },
  });

  const req = createClaudeRequest({
    model: 'claude-sonnet-4-5',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  });
  req.url = '/v1/messages/count_tokens';
  req.headers.authorization = 'Bearer local-airouter-oauth-token';
  req.headers['anthropic-version'] = '2023-06-01';
  req.headers['anthropic-beta'] = 'oauth-2025-04-20,claude-code-20250219';

  const res = createJsonResponseRecorder();

  await handler(req, res);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].targetUrl, 'https://api.anthropic.com/v1/messages/count_tokens');
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer real-claude-oauth-token');
  assert.equal(upstreamRequests[0].headers['anthropic-beta'], 'oauth-2025-04-20,claude-code-20250219');
  assert.deepEqual(JSON.parse(upstreamRequests[0].body.toString('utf8')), {
    model: 'claude-sonnet-4-5',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.input_tokens, 8);
});

test('server does not mark claude_token unavailable after upstream failures', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const claudeTokenBranchIndex = source.indexOf("warn(`claude token 上游返回错误:");
  assert.ok(claudeTokenBranchIndex >= 0, 'claude_token upstream error log should exist');

  const directBranchStart = source.lastIndexOf('if (config && isDirectClaudeProxyConfig(config))', claudeTokenBranchIndex);
  const directBranchEnd = source.indexOf("if (config.type === 'claude_token')", claudeTokenBranchIndex);
  const directBranch = source.slice(directBranchStart, directBranchEnd);

  assert.doesNotMatch(directBranch, /markConfigUnavailable\(config/);
  assert.doesNotMatch(directBranch, /claude_token_upstream_failover/);
});

test('server does not fallback to OpenAI configs for unbound local claude auth tokens', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  assert.match(source, /LOCAL_CLAUDE_AUTH_TOKEN_PREFIX\s*=\s*'airouter-oauth-'/);
  assert.match(source, /const matchedClaudeTokenConfig = accountManager\.findConfig\(item => isMatchingClaudeTokenConfig\(item\) && isRuntimeConfigAvailable\(item\)\)/);
  assert.doesNotMatch(source, /isRuntimeConfigEnabled\(boundClaudeTokenConfig\)/);
  assert.match(source, /item\.access_token === localAuthToken/);

  const boundGuardIndex = source.indexOf('if (boundClaudeTokenConfig)');
  const localTokenGuardIndex = source.indexOf('if (isLocalClaudeAuthToken(localAuthToken))');
  const tokenFallbackIndex = source.indexOf('return acquireTokenThenGptApiKeyLease(accountManager, reason, sessionKey, excludedConfigs)');

  assert.ok(boundGuardIndex >= 0, 'bound claude token guard should exist');
  assert.ok(localTokenGuardIndex > boundGuardIndex, 'unbound local token guard should run after bound token lookup');
  assert.ok(tokenFallbackIndex > localTokenGuardIndex, 'OpenAI/token fallback should run after local token guard');
});

test('server keeps OpenAI and Claude apikey fallback focus separate', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');

  assert.match(source, /OPENAI_APIKEY_STATIC_POOL\s*=\s*'openai_apikey'/);
  assert.match(source, /CLAUDE_APIKEY_STATIC_POOL\s*=\s*'claude_apikey'/);
  assert.match(
    source,
    /acquireAvailableStaticConfigLease\(\s*manager,\s*reason,\s*isGptApiKeyProxyConfig,\s*sessionKey,\s*excludedConfigs,\s*OPENAI_APIKEY_STATIC_POOL\s*\)/,
  );
  assert.match(
    source,
    /acquireAvailableStaticConfigLease\(\s*accountManager,\s*reason,\s*isClaudeApiKeyConfig,\s*sessionKey,\s*excludedConfigs,\s*CLAUDE_APIKEY_STATIC_POOL\s*\)/,
  );
});

test('server selects claude_token configs by availability without moving the shared active config', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const acquireStart = source.indexOf('function acquireClaudeMessagesConfig(');
  const acquireEnd = source.indexOf('return createClaudeMessagesHandler({', acquireStart);
  const acquireBody = source.slice(acquireStart, acquireEnd);

  assert.match(
    acquireBody,
    /accountManager\.findConfig\(item => isMatchingClaudeTokenConfig\(item\) && isRuntimeConfigAvailable\(item\)\)/,
  );
  assert.match(
    acquireBody,
    /const claudeTokenLease = acquireFirstAvailableStaticConfigLease\(accountManager, isClaudeTokenConfig, sessionKey, excludedConfigs\)/,
  );
  assert.doesNotMatch(
    acquireBody,
    /acquireAvailableStaticConfigLease\(accountManager,\s*reason,\s*isClaudeTokenConfig/,
  );
});

test('createClaudeMessagesHandler reports direct claude apikey retryable upstream failures', async () => {
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

test('createClaudeMessagesHandler retries direct claude apikey failures with the next config immediately', async () => {
  const configs = [
    {
      type: 'apikey',
      index: 0,
      description: 'primary claude upstream',
      apiKey: 'upstream-claude-key-1',
      baseUrl: 'https://claude-primary.example.com/v1',
      support: ['claude'],
    },
    {
      type: 'apikey',
      index: 1,
      description: 'backup claude upstream',
      apiKey: 'upstream-claude-key-2',
      baseUrl: 'https://claude-backup.example.com/v1',
      support: ['claude'],
    },
  ];
  const upstreamRequests = [];
  const classifications = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => configs[0],
    handleRetryableUpstreamError: (failedConfig, classification, context) => {
      classifications.push({ failedConfig, classification, context });
      return configs[1];
    },
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      if (upstreamRequests.length === 1) {
        return {
          responsePromise: Promise.resolve(createUpstreamResponse(429, {
            'content-type': 'application/json',
          }, JSON.stringify({
            error: {
              message: 'rate limited',
            },
          }))),
          abort() {},
        };
      }

      return {
        responsePromise: Promise.resolve(createUpstreamResponse(200, {
          'content-type': 'application/json',
        }, JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4',
          stop_reason: 'end_turn',
          content: [
            {
              type: 'text',
              text: 'hello from backup',
            },
          ],
        }))),
        abort() {},
      };
    },
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
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(upstreamRequests.map(request => request.targetUrl), [
    'https://claude-primary.example.com/v1/messages?client_version=1',
    'https://claude-backup.example.com/v1/messages?client_version=1',
  ]);
  assert.deepEqual(upstreamRequests.map(request => request.headers.authorization), [
    'Bearer upstream-claude-key-1',
    'Bearer upstream-claude-key-2',
  ]);
  assert.equal(classifications.length, 1);
  assert.equal(classifications[0].failedConfig, configs[0]);
  assert.equal(classifications[0].classification.reason, 'apikey_rate_limited');
  assert.deepEqual(classifications[0].context.excludedConfigs.map(config => config.description), [
    'primary claude upstream',
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello from backup',
    },
  ]);
});

test('createClaudeMessagesHandler treats direct claude apikey stream errors after client commit as success', async () => {
  const config = {
    type: 'apikey',
    index: 0,
    description: 'streaming claude upstream',
    apiKey: 'upstream-claude-key',
    baseUrl: 'https://claude-stream.example.com/v1',
    support: ['claude'],
  };
  const upstreamResponse = new PassThrough();
  upstreamResponse.statusCode = 200;
  upstreamResponse.headers = {
    'content-type': 'text/event-stream',
  };
  const observations = [];
  let retryAttempts = 0;
  const handler = createClaudeMessagesHandler({
    getConfig: () => config,
    handleRetryableUpstreamError: () => {
      retryAttempts += 1;
      return null;
    },
    observeApiKeyRequestResult: (observedConfig, result) => {
      observations.push({ observedConfig, result });
      return { unavailable: false, sampleSize: 1, failureCount: 0 };
    },
    createUpstreamRequest: () => ({
      responsePromise: Promise.resolve(upstreamResponse),
      abort() {},
    }),
  });
  const res = createJsonResponseRecorder();

  await handler(createClaudeRequest({
    model: 'claude-sonnet-4',
    stream: true,
    max_tokens: 32,
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
  }), res);
  await new Promise(resolve => setImmediate(resolve));

  upstreamResponse.write('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n');
  await new Promise(resolve => setImmediate(resolve));
  upstreamResponse.destroy(new Error('late stream disconnect'));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(retryAttempts, 0);
  assert.equal(res.headersSent, true);
  assert.equal(res.writableEnded, true);
  assert.deepEqual(observations, [
    {
      observedConfig: config,
      result: { ok: true },
    },
  ]);
});

test('createClaudeMessagesHandler reports direct claude apikey non-200 statuses as failures', async () => {
  const config = {
    type: 'apikey',
    index: 0,
    description: 'claude upstream',
    apiKey: 'upstream-claude-key',
    baseUrl: 'https://claude.example.com',
    support: ['claude'],
  };
  const apiKeyResults = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => config,
    createUpstreamRequest: () => ({
      responsePromise: Promise.resolve(createUpstreamResponse(400, {
        'content-type': 'application/json',
      }, JSON.stringify({
        error: {
          message: 'bad request',
        },
      }))),
      abort() {},
    }),
    observeApiKeyRequestResult: (failedConfig, result) => {
      apiKeyResults.push({ failedConfig, result });
    },
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

  assert.equal(res.statusCode, 400);
  assert.equal(apiKeyResults.length, 1);
  assert.equal(apiKeyResults[0].failedConfig, config);
  assert.deepEqual(apiKeyResults[0].result, {
    ok: false,
    reason: 'apikey_upstream_error',
    lastError: 'http:400',
    switchReason: 'apikey_upstream_failover',
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
  const upstreamRequests = [];
  const classifications = [];
  const modelObservations = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => configs[0],
    handleRetryableUpstreamError: (config, classification) => {
      classifications.push({ config, classification });
      return configs[1];
    },
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
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
    observeResponseModel: (config, observation) => {
      modelObservations.push({
        config,
        observation,
      });
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
  assert.deepEqual(upstreamRequests.map(request => request.headers.version), ['1.0.1', '1.0.1']);
  assert.deepEqual(upstreamRequests.map(request => request.targetUrl), [
    'https://chatgpt.com/backend-api/codex/responses?client_version=1.0.1',
    'https://chatgpt.com/backend-api/codex/responses?client_version=1.0.1',
  ]);
  assert.equal(classifications[0].classification.reason, 'responses_usage_limit_reached');
  assert.ok(modelObservations.some(item => (
    item.config === configs[1] &&
    item.observation.requestModel === 'gpt-5.5' &&
    item.observation.responseModel === 'gpt-5.4'
  )));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
});

test('createClaudeMessagesHandler retries response.failed event names without payload type', async () => {
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
        const events = [
          'event: response.failed',
          'data: {"response":{"error":{"code":"server_is_overloaded","message":"server overloaded"}}}',
          '',
        ].join('\n');

        return {
          responsePromise: Promise.resolve(createUpstreamResponse(200, {
            'content-type': 'text/event-stream',
          }, events)),
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
  assert.equal(classifications.length, 1);
  assert.equal(classifications[0].config, configs[0]);
  assert.deepEqual(classifications[0].classification, {
    action: 'retry',
    reason: 'responses_unknown_error',
    retryKey: 'server_is_overloaded',
    retrySource: 'stream',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
});

test('createClaudeMessagesHandler retries converted responses stream errors before client commit', async () => {
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
        const response = new PassThrough();
        response.statusCode = 200;
        response.headers = {
          'content-type': 'text/event-stream',
        };
        process.nextTick(() => {
          response.destroy(new Error('upstream stream closed'));
        });

        return {
          responsePromise: Promise.resolve(response),
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
  assert.equal(classifications.length, 1);
  assert.equal(classifications[0].config, configs[0]);
  assert.deepEqual(classifications[0].classification, {
    reason: 'responses_upstream_error',
    retryKey: 'upstream stream closed',
    retrySource: 'stream',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
});

test('createClaudeMessagesHandler retries downgraded gpt-5.4-mini responses with the next config', async () => {
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
  const createEvents = (model, text) => [
    `data: {"type":"response.created","response":{"id":"resp_1","model":"${model}"}}`,
    '',
    'data: {"type":"response.output_item.added","item":{"id":"msg_1","type":"message"}}',
    '',
    'data: {"type":"response.content_part.added","item_id":"msg_1","content_index":0,"part":{"type":"output_text"}}',
    '',
    `data: {"type":"response.output_text.delta","item_id":"msg_1","content_index":0,"delta":"${text}"}`,
    '',
    'data: {"type":"response.content_part.done","item_id":"msg_1","content_index":0}',
    '',
    `data: {"type":"response.completed","response":{"id":"resp_1","model":"${model}","status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}`,
    '',
  ].join('\n');
  const handler = createClaudeMessagesHandler({
    getConfig: () => configs[0],
    handleRetryableUpstreamError: (config, classification) => {
      classifications.push({ config, classification });
      return configs[1];
    },
    createUpstreamRequest: request => {
      upstreamAccountIds.push(request.headers['chatgpt-account-id']);
      const events = upstreamAccountIds.length === 1
        ? createEvents('gpt-5.4-mini', 'primary')
        : createEvents('gpt-5.5', 'backup');

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
  assert.equal(classifications.length, 1);
  assert.equal(classifications[0].config, configs[0]);
  assert.deepEqual(classifications[0].classification, {
    action: 'retry',
    reason: 'responses_model_downgraded',
    retryKey: 'gpt-5.5->gpt-5.4-mini',
    retrySource: 'model',
    requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.4-mini',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'backup',
    },
  ]);
});

test('createClaudeMessagesHandler keeps retrying usage-limit errors until a config succeeds', async () => {
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
    {
      type: 'token',
      index: 2,
      description: 'third',
      access_token: 'token-3',
      account_id: 'account-3',
      baseUrl: 'https://chatgpt.com',
      apiBasePath: '/backend-api/codex',
    },
  ];
  const upstreamAccountIds = [];
  const classifications = [];
  const retryContexts = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => configs[0],
    handleRetryableUpstreamError: (config, classification, context) => {
      classifications.push({ config, classification });
      retryContexts.push(context);
      return configs[classifications.length] || null;
    },
    createUpstreamRequest: request => {
      upstreamAccountIds.push(request.headers['chatgpt-account-id']);
      if (upstreamAccountIds.length <= 2) {
        return {
          responsePromise: Promise.resolve(createUpstreamResponse(429, {
            'content-type': 'application/json',
          }, JSON.stringify({
            error: {
              type: 'usage_limit_reached',
              message: "You've hit your usage limit.",
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
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(upstreamAccountIds, ['account-1', 'account-2', 'account-3']);
  assert.deepEqual(classifications.map(item => ({
    config: item.config.description,
    reason: item.classification.reason,
    lastError: `${item.classification.retrySource}:${item.classification.retryKey}`,
  })), [
    {
      config: 'primary',
      reason: 'responses_usage_limit_reached',
      lastError: 'http:usage_limit_reached',
    },
    {
      config: 'backup',
      reason: 'responses_usage_limit_reached',
      lastError: 'http:usage_limit_reached',
    },
  ]);
  assert.deepEqual(retryContexts.map(context => context.excludedConfigs.map(config => config.description)), [
    ['primary'],
    ['primary', 'backup'],
  ]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
});

test('createClaudeMessagesHandler stops after two replay attempts', async () => {
  const configs = [0, 1, 2, 3].map(index => ({
    type: 'token',
    index,
    description: `token ${index + 1}`,
    access_token: `token-${index + 1}`,
    account_id: `account-${index + 1}`,
    baseUrl: 'https://chatgpt.com',
    apiBasePath: '/backend-api/codex',
  }));
  const upstreamAccountIds = [];
  const retryContexts = [];
  const classifications = [];
  const handler = createClaudeMessagesHandler({
    getConfig: () => configs[0],
    handleRetryableUpstreamError: (config, classification, context) => {
      classifications.push({ config, classification });
      retryContexts.push(context);
      return configs[classifications.length] || null;
    },
    createUpstreamRequest: request => {
      upstreamAccountIds.push(request.headers['chatgpt-account-id']);
      return {
        responsePromise: Promise.resolve(createUpstreamResponse(429, {
          'content-type': 'application/json',
        }, JSON.stringify({
          error: {
            type: 'usage_limit_reached',
            message: "You've hit your usage limit.",
          },
        }))),
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
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(upstreamAccountIds, ['account-1', 'account-2', 'account-3']);
  assert.equal(upstreamAccountIds.includes('account-4'), false);
  assert.deepEqual(classifications.map(item => item.config.description), [
    'token 1',
    'token 2',
    'token 3',
  ]);
  assert.deepEqual(retryContexts.map(context => ({
    failoverAttempt: context.failoverAttempt,
    retryAllowed: context.retryAllowed,
    excludedConfigs: context.excludedConfigs.map(config => config.description),
  })), [
    {
      failoverAttempt: 0,
      retryAllowed: true,
      excludedConfigs: ['token 1'],
    },
    {
      failoverAttempt: 1,
      retryAllowed: true,
      excludedConfigs: ['token 1', 'token 2'],
    },
    {
      failoverAttempt: 2,
      retryAllowed: false,
      excludedConfigs: ['token 1', 'token 2', 'token 3'],
    },
  ]);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.payload, {
    error: {
      type: 'usage_limit_reached',
      message: "You've hit your usage limit.",
    },
  });
});

test('createClaudeMessagesHandler retries non-200 responses statuses with the next config', async () => {
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
          responsePromise: Promise.resolve(createUpstreamResponse(204, {
            'content-type': 'application/json',
          }, '')),
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
  assert.equal(classifications.length, 1);
  assert.deepEqual(classifications[0].classification, {
    reason: 'responses_unknown_error',
    retryKey: 'http_204',
    retrySource: 'http',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.content, [
    {
      type: 'text',
      text: 'hello',
    },
  ]);
});
