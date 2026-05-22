const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  detectDownstreamProtocol,
  resolveCcxOptions,
} = require('../app/ccx/protocols');
const { createCcxHandler } = require('../app/ccx/handler');
const { createCcxSessionStore } = require('../app/ccx/session-store');

function createRequest(path, body, headers = {}) {
  const req = new EventEmitter();
  req.method = 'POST';
  req.baseUrl = '';
  req.url = path;
  req.headers = {
    'content-type': 'application/json',
    authorization: 'Bearer local-key',
    'x-admin-token': 'admin-secret',
    ...headers,
  };

  process.nextTick(() => {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });

  return req;
}

function createResponseRecorder() {
  const res = new EventEmitter();
  return Object.assign(res, {
    statusCode: null,
    headers: {},
    chunks: [],
    headersSent: false,
    writableEnded: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    write(chunk) {
      this.headersSent = true;
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    end(chunk) {
      if (chunk) {
        this.write(chunk);
      }
      this.headersSent = true;
      this.writableEnded = true;
      this.emit('finish');
    },
    json(payload) {
      this.setHeader('content-type', 'application/json; charset=utf-8');
      this.end(JSON.stringify(payload));
      return this;
    },
    send(payload) {
      this.end(Buffer.isBuffer(payload) ? payload : String(payload));
      return this;
    },
    bodyText() {
      return Buffer.concat(this.chunks).toString('utf8');
    },
    bodyJson() {
      return JSON.parse(this.bodyText());
    },
    flushHeaders() {
      this.headersSent = true;
    },
  });
}

function createUpstreamResponse(statusCode, headers, body) {
  const response = new PassThrough();
  response.statusCode = statusCode;
  response.headers = headers;
  process.nextTick(() => response.end(body));
  return response;
}

async function waitForRecorder(res) {
  if (res.writableEnded) {
    return;
  }
  await new Promise(resolve => res.once('finish', resolve));
}

function createHandlerForTest(options = {}) {
  const upstreamRequests = [];
  const upstreamResponses = Array.isArray(options.upstreamResponses)
    ? options.upstreamResponses.slice()
    : [];
  const handler = createCcxHandler({
    getConfig: protocol => {
      if (typeof options.getConfig === 'function') {
        return options.getConfig(protocol);
      }
      if (protocol === 'messages') {
        return {
          type: 'apikey',
          baseUrl: 'https://claude.example.com',
          apiKey: 'claude-key',
          support: ['claude'],
          description: 'claude',
        };
      }
      return {
        type: 'apikey',
        baseUrl: 'https://openai.example.com',
        apiKey: 'openai-key',
        support: ['gpt'],
        description: 'openai',
      };
    },
    ccxOptions: resolveCcxOptions(options.ccx),
    createUpstreamRequest: request => {
      upstreamRequests.push(request);
      const nextResponse = upstreamResponses.shift() || createUpstreamResponse(200, {
        'content-type': 'application/json',
      }, JSON.stringify({
        id: 'resp_1',
        model: 'gpt-test',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }));
      return {
        responsePromise: Promise.resolve(nextResponse),
        abort() {},
      };
    },
    sessionStore: options.sessionStore || createCcxSessionStore({ cleanupIntervalMs: 0 }),
  });
  return { handler, upstreamRequests };
}

test('resolveCcxOptions defaults to enabled responses upstream only', () => {
  const options = resolveCcxOptions({});
  assert.equal(options.enabled, true);
  assert.equal(options.upstreamProtocol, 'responses');
  assert.deepEqual(options.enabledUpstreamProtocols, ['responses']);
});

test('detectDownstreamProtocol recognizes ccx routes', () => {
  assert.equal(detectDownstreamProtocol('/ccx/v1/responses'), 'responses');
  assert.equal(detectDownstreamProtocol('/ccx/v1/messages'), 'messages');
  assert.equal(detectDownstreamProtocol('/ccx/v1/chat/completions'), 'chat');
  assert.equal(detectDownstreamProtocol('/v1/responses'), null);
});

test('ccx responses to responses keeps request body unnormalized for passthrough', async () => {
  const { handler, upstreamRequests } = createHandlerForTest();
  const res = createResponseRecorder();
  const body = {
    model: 'gpt-test',
    input: 'hello',
    store: true,
    stream: false,
  };

  await handler(createRequest('/ccx/v1/responses', body), res);
  await waitForRecorder(res);

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].targetUrl, 'https://openai.example.com/v1/responses');
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer openai-key');
  assert.equal(upstreamRequests[0].headers.accept, 'application/json');
  assert.equal(upstreamRequests[0].headers['x-admin-token'], undefined);
  assert.deepEqual(JSON.parse(upstreamRequests[0].body.toString('utf8')), body);
  assert.equal(res.statusCode, 200);
});

test('ccx same-protocol stream passthrough keeps event-stream accept header', async () => {
  const { handler, upstreamRequests } = createHandlerForTest({
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'text/event-stream' }, 'data: [DONE]\n\n'),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses', {
    model: 'gpt-test',
    input: 'hello',
    stream: true,
  }), res);
  await waitForRecorder(res);

  assert.equal(upstreamRequests[0].headers.accept, 'text/event-stream');
  assert.equal(res.bodyText(), 'data: [DONE]\n\n');
});

test('ccx messages downstream converts to responses upstream and maps response back', async () => {
  const { handler, upstreamRequests } = createHandlerForTest();
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'claude-sonnet-4-5',
    system: 'You are terse.',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].targetUrl, 'https://openai.example.com/v1/responses');
  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamRequests[0].headers.accept, 'text/event-stream');
  assert.equal(upstreamBody.stream, true);
  assert.equal(upstreamBody.instructions, 'You are terse.');
  assert.equal(upstreamBody.max_output_tokens, 64);
  assert.deepEqual(upstreamBody.input, [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hello' }],
  }]);
  assert.equal(res.bodyJson().type, 'message');
  assert.deepEqual(res.bodyJson().content, [{ type: 'text', text: 'hello' }]);
});

test('ccx messages to responses maps session header to prompt_cache_key', async () => {
  const { handler, upstreamRequests } = createHandlerForTest();
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'claude-sonnet-4-5',
    metadata: { user_id: 'metadata-user' },
    messages: [{ role: 'user', content: 'hello' }],
  }, {
    'x-claude-code-session-id': 'session-from-header',
  }), res);
  await waitForRecorder(res);

  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.prompt_cache_key, 'session-from-header');
  assert.equal(upstreamBody.user, undefined);
  assert.equal(upstreamBody.metadata, undefined);
});

test('ccx messages to responses falls back to metadata user_id for prompt_cache_key', async () => {
  const { handler, upstreamRequests } = createHandlerForTest();
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'claude-sonnet-4-5',
    metadata: {
      user_id: {
        device_id: 'dev1',
        account_uuid: 'acc1',
        session_id: 'sess1',
      },
    },
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.prompt_cache_key, 'user_dev1_account_acc1_session_sess1');
  assert.equal(upstreamBody.user, undefined);
  assert.equal(upstreamBody.metadata, undefined);
});

test('ccx configured prompt_cache_retention is only injected for apikey responses upstream', async () => {
  const apikey = createHandlerForTest({
    ccx: {
      cache: { prompt_cache_retention: '24h' },
    },
  });
  const apikeyRes = createResponseRecorder();

  await apikey.handler(createRequest('/ccx/v1/messages', {
    model: 'claude-sonnet-4-5',
    messages: [{ role: 'user', content: 'hello' }],
  }, {
    'x-client-request-id': 'cache-session',
  }), apikeyRes);
  await waitForRecorder(apikeyRes);

  const apikeyBody = JSON.parse(apikey.upstreamRequests[0].body.toString('utf8'));
  assert.equal(apikeyBody.prompt_cache_key, 'cache-session');
  assert.equal(apikeyBody.prompt_cache_retention, '24h');

  const token = createHandlerForTest({
    ccx: {
      cache: { prompt_cache_retention: '24h' },
    },
    getConfig: () => ({
      type: 'token',
      baseUrl: 'https://chatgpt.example.com',
      apiBasePath: '/backend-api/codex',
      access_token: 'token',
      account_id: 'account',
      description: 'token',
    }),
  });
  const tokenRes = createResponseRecorder();

  await token.handler(createRequest('/ccx/v1/messages', {
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  }, {
    'x-client-request-id': 'cache-session',
  }), tokenRes);
  await waitForRecorder(tokenRes);

  const tokenBody = JSON.parse(token.upstreamRequests[0].body.toString('utf8'));
  assert.equal(tokenBody.prompt_cache_key, 'cache-session');
  assert.equal(tokenBody.prompt_cache_retention, undefined);
});

test('ccx token responses upstream omits max_output_tokens for converted requests', async () => {
  const { handler, upstreamRequests } = createHandlerForTest({
    getConfig: () => ({
      type: 'token',
      baseUrl: 'https://chatgpt.example.com',
      apiBasePath: '/backend-api/codex',
      access_token: 'token',
      account_id: 'account',
      description: 'token',
    }),
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'gpt-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamRequests[0].targetUrl, 'https://chatgpt.example.com/backend-api/codex/responses');
  assert.equal(upstreamBody.stream, true);
  assert.equal(upstreamBody.store, false);
  assert.equal(upstreamBody.max_output_tokens, undefined);
});

test('ccx converted non-stream requests surface upstream responses SSE failures', async () => {
  const events = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_failed","model":"gpt-test","status":"in_progress","output":[]}}',
    '',
    'event: response.failed',
    'data: {"type":"response.failed","response":{"id":"resp_failed","model":"gpt-test","status":"failed","error":{"message":"upstream exploded"},"output":[]}}',
    '',
  ].join('\n');
  const { handler } = createHandlerForTest({
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'text/event-stream' }, events),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'gpt-test',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  assert.equal(res.statusCode, 502);
  assert.match(res.bodyJson().message, /upstream exploded/);
});

test('ccx chat downstream converts to responses upstream and maps response back', async () => {
  const { handler, upstreamRequests } = createHandlerForTest({
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'application/json' }, JSON.stringify({
        id: 'resp_1',
        model: 'gpt-test',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        }],
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 6 },
          output_tokens: 2,
          total_tokens: 12,
        },
      })),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/chat/completions', {
    model: 'gpt-test',
    stream: false,
    messages: [
      { role: 'system', content: 'Be direct.' },
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ],
  }), res);
  await waitForRecorder(res);

  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.instructions, 'Be direct.');
  assert.deepEqual(upstreamBody.input, [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'hello' }],
  }]);
  const payload = res.bodyJson();
  assert.equal(payload.object, 'chat.completion');
  assert.equal(payload.choices[0].message.content, 'hello');
  assert.equal(payload.usage.prompt_tokens_details.cached_tokens, 6);
});

test('ccx chat upstream cached_tokens are preserved in responses usage', async () => {
  const { handler } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'chat',
      enabled_upstream_protocols: ['chat'],
    },
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'application/json' }, JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 10,
          prompt_tokens_details: { cached_tokens: 7 },
          completion_tokens: 2,
          total_tokens: 12,
        },
      })),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses', {
    model: 'gpt-test',
    input: 'hello',
  }), res);
  await waitForRecorder(res);

  const payload = res.bodyJson();
  assert.equal(payload.object, 'response');
  assert.equal(payload.usage.input_tokens_details.cached_tokens, 7);
});

test('ccx messages upstream cache_read_input_tokens are preserved as responses cached_tokens', async () => {
  const { handler } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'messages',
      enabled_upstream_protocols: ['messages'],
    },
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'application/json' }, JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'hello' }],
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_read_input_tokens: 8,
        },
      })),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses', {
    model: 'gpt-test',
    input: 'hello',
  }), res);
  await waitForRecorder(res);

  const payload = res.bodyJson();
  assert.equal(payload.object, 'response');
  assert.equal(payload.usage.input_tokens_details.cached_tokens, 8);
});

test('ccx messages downstream preserves rich blocks, tools, and tool results in responses shape', async () => {
  const { handler, upstreamRequests } = createHandlerForTest();
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'claude-sonnet-4-5',
    system: [{ type: 'text', text: 'Use tools carefully.' }],
    max_tokens: 128,
    tools: [{
      name: 'lookup_order',
      description: 'Look up an order',
      input_schema: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
        },
      },
    }],
    tool_choice: { type: 'tool', name: 'lookup_order' },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'inspect this' },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'document', title: 'note.txt', source: { type: 'base64', media_type: 'text/plain', data: 'aGVsbG8=' } },
      ],
    }, {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'call_1',
        name: 'lookup_order',
        input: { order_id: 'A-1' },
      }],
    }, {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'shipped',
      }],
    }],
  }), res);
  await waitForRecorder(res);

  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.instructions, 'Use tools carefully.');
  assert.equal(upstreamBody.tools[0].name, 'lookup_order');
  assert.deepEqual(upstreamBody.tool_choice, { type: 'function', name: 'lookup_order' });
  assert.deepEqual(upstreamBody.input[0].content, [
    { type: 'input_text', text: 'inspect this' },
    { type: 'input_image', image_url: 'https://example.com/a.png' },
    { type: 'input_file', filename: 'note.txt', file_data: 'data:text/plain;base64,aGVsbG8=' },
  ]);
  assert.deepEqual(upstreamBody.input.slice(1), [
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'lookup_order',
      arguments: '{"order_id":"A-1"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'shipped',
    },
  ]);
});

test('ccx chat downstream preserves tool schemas, tool calls, and tool outputs in responses shape', async () => {
  const { handler, upstreamRequests } = createHandlerForTest();
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/chat/completions', {
    model: 'gpt-test',
    stream: false,
    tools: [{
      type: 'function',
      function: {
        name: 'lookup_weather',
        description: 'Look up weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
        },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'lookup_weather' } },
    messages: [{
      role: 'system',
      content: 'Be factual.',
    }, {
      role: 'user',
      content: [{ type: 'text', text: 'weather?' }, { type: 'image_url', image_url: { url: 'https://example.com/sky.png' } }],
    }, {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_weather',
        type: 'function',
        function: { name: 'lookup_weather', arguments: '{"city":"Shanghai"}' },
      }],
    }, {
      role: 'tool',
      tool_call_id: 'call_weather',
      content: '{"temp":24}',
    }],
  }), res);
  await waitForRecorder(res);

  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.instructions, 'Be factual.');
  assert.deepEqual(upstreamBody.tools, [{
    type: 'function',
    name: 'lookup_weather',
    description: 'Look up weather',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string' } },
    },
  }]);
  assert.deepEqual(upstreamBody.tool_choice, { type: 'function', function: { name: 'lookup_weather' } });
  assert.deepEqual(upstreamBody.input, [{
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'weather?' },
      { type: 'input_image', image_url: 'https://example.com/sky.png' },
    ],
  }, {
    type: 'function_call',
    call_id: 'call_weather',
    name: 'lookup_weather',
    arguments: '{"city":"Shanghai"}',
  }, {
    type: 'function_call_output',
    call_id: 'call_weather',
    output: '{"temp":24}',
  }]);
});

test('ccx responses to chat expands local previous_response_id history', async () => {
  const sessionStore = createCcxSessionStore({ cleanupIntervalMs: 0 });
  const responseId = sessionStore.createCompactedSession('resp_prev', [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'old question' }],
  }, {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'old answer' }],
  }], 3);
  assert.equal(responseId, 'resp_prev');

  const { handler, upstreamRequests } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'chat',
      enabled_upstream_protocols: ['chat'],
    },
    sessionStore,
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses', {
    model: 'gpt-test',
    previous_response_id: 'resp_prev',
    input: 'new question',
    stream: false,
  }), res);
  await waitForRecorder(res);

  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamRequests[0].targetUrl, 'https://openai.example.com/v1/chat/completions');
  assert.deepEqual(upstreamBody.messages.map(message => message.content), [
    'old question',
    'old answer',
    'new question',
  ]);
});

test('ccx responses conversion rejects unknown previous_response_id', async () => {
  const { handler } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'chat',
      enabled_upstream_protocols: ['chat'],
    },
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses', {
    model: 'gpt-test',
    previous_response_id: 'missing',
    input: 'hello',
  }), res);
  await waitForRecorder(res);

  assert.equal(res.statusCode, 400);
  assert.match(res.bodyJson().message, /previous_response_id/);
});

test('ccx responses downstream converts through messages upstream', async () => {
  const { handler, upstreamRequests } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'messages',
      enabled_upstream_protocols: ['messages'],
    },
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'application/json' }, JSON.stringify({
        id: 'msg_upstream',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'from claude' }],
        usage: { input_tokens: 3, output_tokens: 2 },
      })),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses', {
    model: 'claude-sonnet-4-5',
    instructions: 'Be helpful.',
    input: 'hello',
    stream: false,
  }), res);
  await waitForRecorder(res);

  assert.equal(upstreamRequests[0].targetUrl, 'https://claude.example.com/v1/messages');
  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.system, 'Be helpful.');
  assert.equal(upstreamBody.messages[0].content[0].text, 'hello');
  assert.equal(res.bodyJson().output[0].content[0].text, 'from claude');
});

test('ccx messages downstream converts through chat upstream', async () => {
  const { handler, upstreamRequests } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'chat',
      enabled_upstream_protocols: ['chat'],
    },
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'application/json' }, JSON.stringify({
        id: 'chatcmpl_1',
        object: 'chat.completion',
        model: 'gpt-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'from chat' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      })),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'claude-sonnet-4-5',
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  assert.equal(upstreamRequests[0].targetUrl, 'https://openai.example.com/v1/chat/completions');
  const upstreamBody = JSON.parse(upstreamRequests[0].body.toString('utf8'));
  assert.equal(upstreamBody.messages[0].content, 'hello');
  assert.deepEqual(res.bodyJson().content, [{ type: 'text', text: 'from chat' }]);
});

test('ccx responses compact falls back to local compact when native compact is unsupported', async () => {
  const sessionStore = createCcxSessionStore({ cleanupIntervalMs: 0 });
  sessionStore.createCompactedSession('resp_prev', [{
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'important context' }],
  }], 1);
  const { handler, upstreamRequests } = createHandlerForTest({
    sessionStore,
    upstreamResponses: [
      createUpstreamResponse(404, { 'content-type': 'application/json' }, '{"error":"not found"}'),
      createUpstreamResponse(200, { 'content-type': 'application/json' }, JSON.stringify({
        id: 'resp_compact_upstream',
        model: 'gpt-test',
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'summary text' }],
        }],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      })),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses/compact', {
    model: 'gpt-test',
    previous_response_id: 'resp_prev',
    input: 'latest instruction',
    stream: false,
  }), res);
  await waitForRecorder(res);

  assert.equal(upstreamRequests.length, 2);
  assert.equal(upstreamRequests[0].targetUrl, 'https://openai.example.com/v1/responses/compact');
  assert.equal(upstreamRequests[1].targetUrl, 'https://openai.example.com/v1/responses');
  const localCompactBody = JSON.parse(upstreamRequests[1].body.toString('utf8'));
  assert.match(JSON.stringify(localCompactBody.input), /important context/);
  assert.match(JSON.stringify(localCompactBody.input), /latest instruction/);
  assert.equal(res.bodyJson().output[0].content[0].text, 'summary text');
});

test('ccx messages downstream converts responses SSE back to Claude SSE', async () => {
  const events = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_stream","model":"gpt-test"}}',
    '',
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"id":"msg_stream","type":"message","role":"assistant"}}',
    '',
    'event: response.content_part.added',
    'data: {"type":"response.content_part.added","item_id":"msg_stream","content_index":0,"part":{"type":"output_text"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"msg_stream","content_index":0,"delta":"hel"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"msg_stream","content_index":0,"delta":"lo"}',
    '',
    'event: response.content_part.done',
    'data: {"type":"response.content_part.done","item_id":"msg_stream","content_index":0}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_stream","model":"gpt-test","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    '',
  ].join('\n');
  const { handler } = createHandlerForTest({
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'text/event-stream' }, events),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/messages', {
    model: 'claude-sonnet-4-5',
    stream: true,
    max_tokens: 64,
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  const text = res.bodyText();
  assert.match(text, /event: message_start/);
  assert.match(text, /event: content_block_delta/);
  assert.match(text, /"text":"hel"/);
  assert.match(text, /event: message_stop/);
});

test('ccx chat downstream converts responses SSE back to chat chunks', async () => {
  const events = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_stream","model":"gpt-test"}}',
    '',
    'event: response.output_item.added',
    'data: {"type":"response.output_item.added","item":{"id":"msg_stream","type":"message","role":"assistant"}}',
    '',
    'event: response.content_part.added',
    'data: {"type":"response.content_part.added","item_id":"msg_stream","content_index":0,"part":{"type":"output_text"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","item_id":"msg_stream","content_index":0,"delta":"hello"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_stream","model":"gpt-test","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}',
    '',
  ].join('\n');
  const { handler } = createHandlerForTest({
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'text/event-stream' }, events),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/chat/completions', {
    model: 'gpt-test',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  const text = res.bodyText();
  assert.match(text, /"object":"chat.completion.chunk"/);
  assert.match(text, /"content":"hello"/);
  assert.match(text, /data: \[DONE\]/);
});

test('ccx responses downstream converts chat SSE upstream to responses SSE', async () => {
  const events = [
    'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const { handler } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'chat',
      enabled_upstream_protocols: ['chat'],
    },
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'text/event-stream' }, events),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/responses', {
    model: 'gpt-test',
    stream: true,
    input: 'hello',
  }), res);
  await waitForRecorder(res);

  const text = res.bodyText();
  assert.match(text, /event: response.output_text.delta/);
  assert.match(text, /"delta":"hello"/);
  assert.match(text, /event: response.completed/);
});

test('ccx chat downstream converts messages SSE upstream through responses canonical', async () => {
  const events = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":1}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const { handler } = createHandlerForTest({
    ccx: {
      upstream_protocol: 'messages',
      enabled_upstream_protocols: ['messages'],
    },
    upstreamResponses: [
      createUpstreamResponse(200, { 'content-type': 'text/event-stream' }, events),
    ],
  });
  const res = createResponseRecorder();

  await handler(createRequest('/ccx/v1/chat/completions', {
    model: 'gpt-test',
    stream: true,
    messages: [{ role: 'user', content: 'hello' }],
  }), res);
  await waitForRecorder(res);

  const text = res.bodyText();
  assert.match(text, /"object":"chat.completion.chunk"/);
  assert.match(text, /"content":"hello"/);
  assert.match(text, /data: \[DONE\]/);
});
