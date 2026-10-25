const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Public HTTP contracts only. Do not import a router, bridge, serializer or
// production SSE parser here. The provider fixtures and expected wire bodies
// describe the contract independently of the implementation under test.
const ROOT = path.join(__dirname, '..');
const KEY = 'boundary-entry-fixture';
const ADMIN = 'boundary-admin-fixture';
const CHAT = 'chat_completions';
const RESPONSES = 'responses';
const protocolPath = p => p === CHAT ? 'chat/completions' : 'responses';
const backendModel = p => p === CHAT ? 'backend-chat' : 'backend-responses';
const nativeRoute = p => p === CHAT ? 'native-chat' : 'native-responses';
const crossRoute = p => p === CHAT ? 'chat-to-responses' : 'responses-to-chat';
const clone = value => JSON.parse(JSON.stringify(value));
const metadata = { tenant: 'fixture', background: 'user data', nested: '{"future_control":true}' };
const schema = {
  type: 'object',
  properties: { future_control: { type: 'string', description: 'An application field, not an API control' } },
  required: ['future_control'], additionalProperties: false,
};
const chatLog = { token: '甲', logprob: -0.25, bytes: [231, 148, 178], top_logprobs: [{ token: '乙', logprob: -1.5, bytes: [228, 185, 153] }] };
const chatUsage = {
  prompt_tokens: 41, completion_tokens: 9, total_tokens: 50,
  prompt_tokens_details: { cached_tokens: 24, audio_tokens: 0, supplier_input_detail: 17 },
  completion_tokens_details: { reasoning_tokens: 4, accepted_prediction_tokens: 2, rejected_prediction_tokens: 1 },
  supplier_billing: { currency: 'USD', amount: '0.000012' },
};
const responsesUsage = {
  input_tokens: 41, output_tokens: 9, total_tokens: 50,
  input_tokens_details: { cached_tokens: 24, supplier_input_detail: 17 },
  output_tokens_details: { reasoning_tokens: 4 },
  supplier_billing: { currency: 'USD', amount: '0.000012' },
};

function chatJson() {
  return {
    id: 'chatcmpl-boundary-fixture', object: 'chat.completion', created: 1700000011, model: 'backend-chat',
    service_tier: 'default', system_fingerprint: 'fp_boundary', provider_detail: { immutable: ['keep', 7] },
    choices: [
      { index: 0, message: { role: 'assistant', content: '甲🙂', annotations: [{ type: 'url_citation', url_citation: { start_index: 0, end_index: 1, url: 'https://example.invalid/a', title: 'fixture' } }], provider_message: { marker: 'choice-zero' } }, logprobs: { content: [chatLog], refusal: null }, finish_reason: 'stop', provider_choice: 'zero' },
      { index: 1, message: { role: 'assistant', content: null, tool_calls: [
        { id: 'call_one', type: 'function', function: { name: 'alpha', arguments: '{"n":1}' } },
        { id: 'call_two', type: 'function', function: { name: 'beta', arguments: '{"n":2}' } },
      ] }, logprobs: null, finish_reason: 'tool_calls', provider_choice: 'one' },
    ], usage: chatUsage,
  };
}

// These chunks intentionally arrive in a different choice/tool order from the
// final JSON. indexes are scoped: tool index 0 is not choice index 0.
function chatEvents() {
  const top = { id: 'chatcmpl-boundary-fixture', object: 'chat.completion.chunk', created: 1700000011, model: 'backend-chat', service_tier: 'default', system_fingerprint: 'fp_boundary', provider_detail: { immutable: ['keep', 7] } };
  return [
    { data: { ...top, choices: [{ index: 1, delta: { role: 'assistant', content: null, tool_calls: [{ index: 1, id: 'call_two', type: 'function', function: { name: 'beta', arguments: '{"n":' } }] }, logprobs: null, finish_reason: null, provider_choice: 'one' }] } },
    { data: { ...top, choices: [{ index: 0, delta: { role: 'assistant', content: '甲', provider_message: { marker: 'choice-zero' } }, logprobs: { content: [chatLog], refusal: null }, finish_reason: null, provider_choice: 'zero' }] } },
    { data: { ...top, choices: [{ index: 1, delta: { tool_calls: [{ index: 0, id: 'call_one', type: 'function', function: { name: 'alpha', arguments: '{"n":' } }] }, finish_reason: null }] } },
    { data: { ...top, choices: [{ index: 0, delta: { content: '🙂', annotations: chatJson().choices[0].message.annotations }, finish_reason: 'stop' }] } },
    { data: { ...top, choices: [{ index: 1, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] }, finish_reason: null }] } },
    { data: { ...top, choices: [{ index: 1, delta: {}, finish_reason: 'tool_calls' }] } },
    { data: { ...top, choices: [], usage: chatUsage } },
    { raw: '[DONE]' },
  ];
}

function responsesJson() {
  return {
    id: 'resp_boundary_fixture', object: 'response', created_at: 1700000011, completed_at: 1700000012,
    model: 'backend-responses', status: 'completed', error: null, incomplete_details: null, store: false,
    service_tier: 'default', metadata: { tenant: 'fixture' }, provider_detail: { immutable: ['keep', 7] },
    output: [
      { id: 'rs_fixture', type: 'reasoning', summary: [{ type: 'summary_text', text: '公开摘要' }], encrypted_content: 'opaque-fixture-only' },
      { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [
        { type: 'output_text', text: '甲🙂', annotations: [{ type: 'url_citation', start_index: 0, end_index: 1, url: 'https://example.invalid/a', title: 'fixture' }], logprobs: [chatLog], provider_part: 'keep-part' },
      ] },
      { id: 'fc_fixture', type: 'function_call', call_id: 'call_one', name: 'alpha', arguments: '{"n":1}', status: 'completed' },
    ], usage: responsesUsage,
  };
}

function responsesEvents() {
  const final = responsesJson();
  return [
    { event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: { ...final, output: [], status: 'in_progress', usage: null } } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: final.output[0] } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: 2, output_index: 0, item: final.output[0] } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 3, output_index: 1, item: { ...final.output[1], content: [], status: 'in_progress' } } },
    { event: 'response.content_part.added', data: { type: 'response.content_part.added', sequence_number: 4, item_id: 'msg_fixture', output_index: 1, content_index: 0, part: { ...final.output[1].content[0], text: '', logprobs: [] } } },
    { event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: 5, item_id: 'msg_fixture', output_index: 1, content_index: 0, delta: '甲🙂', logprobs: [chatLog] } },
    { event: 'response.content_part.done', data: { type: 'response.content_part.done', sequence_number: 6, item_id: 'msg_fixture', output_index: 1, content_index: 0, part: final.output[1].content[0] } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: 7, output_index: 1, item: final.output[1] } },
    { event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: 8, output_index: 2, item: { ...final.output[2], arguments: '', status: 'in_progress' } } },
    { event: 'response.function_call_arguments.delta', data: { type: 'response.function_call_arguments.delta', sequence_number: 9, item_id: 'fc_fixture', output_index: 2, delta: '{"n":1}' } },
    { event: 'response.output_item.done', data: { type: 'response.output_item.done', sequence_number: 10, output_index: 2, item: final.output[2] } },
    { event: 'response.completed', data: { type: 'response.completed', sequence_number: 11, response: final } },
  ];
}

function responsesConvertibleJson() {
  // Text and function calls have a standard streaming representation. Private
  // reasoning lifecycle support is a separate contract, never an assumption.
  const payload = responsesJson();
  payload.output = payload.output.slice(1);
  return payload;
}

function basicPayload(protocol) {
  if (protocol === CHAT) return { id: 'chatcmpl-basic', object: 'chat.completion', created: 1700000011, model: 'backend-chat', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
  return { id: 'resp_basic', object: 'response', created_at: 1700000011, model: 'backend-responses', status: 'completed', store: false, output: [{ id: 'msg_basic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }] };
}

function request(protocol, route, stream = false) {
  return protocol === CHAT ? { model: route, stream, messages: [{ role: 'user', content: '边界🙂' }] }
    : { model: route, stream, input: [{ role: 'user', content: '边界🙂' }] };
}

function richNativeRequest(protocol, stream) {
  const body = request(protocol, nativeRoute(protocol), stream);
  Object.assign(body, { service_tier: 'default', safety_identifier: 'user-fixture', user: 'legacy-fixture', metadata,
    prompt_cache_key: 'prefix-fixture', prompt_cache_retention: '24h', future_control: { nested: ['opaque', 1] } });
  if (protocol === CHAT) Object.assign(body, { n: 2, seed: 19, logprobs: true, top_logprobs: 1,
    presence_penalty: 0.25, frequency_penalty: 0.5, max_completion_tokens: 91,
    response_format: { type: 'json_schema', json_schema: { name: 'fixture', strict: true, schema } },
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
  else Object.assign(body, { store: false, max_output_tokens: 91, text: { verbosity: 'low', format: { type: 'json_schema', name: 'fixture', strict: true, schema } }, include: ['message.output_text.logprobs'], top_logprobs: 1 });
  return body;
}

// Test-local SSE reader: no production parser imports or serializer-generated
// expectations. The same-protocol stream test compares every event payload.
function readEvents(wire) {
  assert.doesNotMatch(wire, /\uFFFD/, 'valid UTF-8 must survive all HTTP boundaries');
  return wire.replace(/\r\n/g, '\n').split('\n\n').filter(block => block.trim()).flatMap(block => {
    const lines = block.split('\n');
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return [];
    if (data === '[DONE]') return [{ raw: data }];
    const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
    return [{ ...(event ? { event } : {}), data: JSON.parse(data) }];
  });
}

function publicPayload(value, model) { return { ...clone(value), model }; }
function publicEvents(values, model) {
  return clone(values).map(entry => {
    if (entry.data && Object.hasOwn(entry.data, 'model')) entry.data.model = model;
    if (entry.data?.response && Object.hasOwn(entry.data.response, 'model')) entry.data.response.model = model;
    return entry;
  });
}

let provider, child, directory, base, plan, childLog = '';
const calls = [];
const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(server.address().port); });
});
async function call(protocol, body) {
  const response = await fetch(`${base}/v1/${protocolPath(protocol)}`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  return { status: response.status, contentType: response.headers.get('content-type'), text };
}

test.before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-boundary-contract-'));
  provider = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
      const protocol = req.url.endsWith('/responses') ? RESPONSES : CHAT;
      const body = JSON.parse(raw);
      calls.push({ protocol, path: req.url, body, authorization: req.headers.authorization });
      const fixture = plan || { wire: 'json', payload: basicPayload(protocol) };
      if (fixture.wire === 'json') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fixture.payload));
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        const wire = fixture.events.map(entry => `${entry.event ? `event: ${entry.event}\r\n` : ''}data: ${entry.raw || JSON.stringify(entry.data)}\r\n\r\n`).join('');
        const bytes = Buffer.from(wire);
        // Small deterministic writes cross Chinese/emoji and JSON boundaries.
        for (let offset = 0; offset < bytes.length; offset += 17) {
          if (res.destroyed) break;
          res.write(bytes.subarray(offset, offset + 17));
          await new Promise(resolve => setImmediate(resolve));
        }
        res.end();
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const providerPort = await listen(provider);
  const reserved = http.createServer(), port = await listen(reserved);
  await new Promise(resolve => reserved.close(resolve));
  const configs = [CHAT, RESPONSES].map(protocol => ({ id: `provider-${protocol}`, type: 'apikey', preset: 'custom',
    base_url: `http://127.0.0.1:${providerPort}/${protocol}`, apikey: 'boundary-provider-fixture',
    models: [{ id: backendModel(protocol), protocols: [protocol], capabilities: { tools: true, images: true, reasoning: true, structuredOutput: true } }],
  }));
  const target = protocol => ({ id: `target-${protocol}`, config_id: `provider-${protocol}`, model: backendModel(protocol), protocol });
  const models = [
    { id: 'native-chat', entry_protocols: [CHAT], targets: [target(CHAT)] },
    { id: 'native-responses', entry_protocols: [RESPONSES], targets: [target(RESPONSES)] },
    { id: 'chat-to-responses', entry_protocols: [CHAT], targets: [target(RESPONSES)] },
    { id: 'responses-to-chat', entry_protocols: [RESPONSES], targets: [target(CHAT)] },
    { id: 'fallback-chat', entry_protocols: [CHAT], targets: [target(RESPONSES), target(CHAT)] },
    { id: 'fallback-responses', entry_protocols: [RESPONSES], targets: [target(CHAT), target(RESPONSES)] },
  ];
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ port, auth_token: ADMIN, apikeys: [KEY], configs, routing: { max_attempts: 2, models } }));
  child = spawn(process.execPath, [path.join(ROOT, 'openai.js')], { cwd: ROOT, env: { ...process.env, CONFIG: path.join(directory, 'config.json'), AIROUTER_BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { childLog = (childLog + chunk).slice(-16000); });
  child.stderr.on('data', chunk => { childLog = (childLog + chunk).slice(-16000); });
  base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`test server exited: ${childLog}`);
    try { if ((await fetch(`${base}/admin/api/upstreams`, { headers: { authorization: `Bearer ${ADMIN}` }, signal: AbortSignal.timeout(500) })).status === 200) return; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`test server did not become ready: ${childLog}`);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
    await exited; clearTimeout(timer);
  }
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

for (const protocol of [CHAT, RESPONSES]) for (const providerWire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`HTTP boundary native ${protocol}: ${providerWire} -> ${stream ? 'sse' : 'json'} preserves the complete request and response`, async () => {
    const expectedJson = protocol === CHAT ? chatJson() : providerWire === 'json' && stream ? responsesConvertibleJson() : responsesJson();
    const expectedEvents = protocol === CHAT ? chatEvents() : responsesEvents();
    plan = providerWire === 'json' ? { wire: 'json', payload: expectedJson } : { wire: 'sse', events: expectedEvents };
    const body = richNativeRequest(protocol, stream), before = calls.length;
    const result = await call(protocol, body);
    assert.equal(calls.length, before + 1, 'native request must reach exactly one provider');
    assert.equal(calls.at(-1).authorization, 'Bearer boundary-provider-fixture', 'entry credentials must be replaced at the provider boundary');
    assert.deepEqual(calls.at(-1).body, { ...body, model: backendModel(protocol) }, 'only the explicitly configured model substitution is allowed');
    assert.equal(result.status, 200, result.text);
    if (!stream) {
      assert.match(result.contentType, /application\/json/);
      assert.deepEqual(JSON.parse(result.text), publicPayload(expectedJson, nativeRoute(protocol)), 'all choices, parts, usage and extensions must survive');
    } else {
      assert.match(result.contentType, /text\/event-stream/);
      const received = readEvents(result.text);
      if (providerWire === 'sse') assert.deepEqual(received, publicEvents(expectedEvents, nativeRoute(protocol)), 'every provider event and extension must survive');
      else if (protocol === RESPONSES) {
        assert.deepEqual(received.at(-1), { event: 'response.completed', data: { ...received.at(-1).data, type: 'response.completed', response: publicPayload(expectedJson, nativeRoute(protocol)) } });
        assert.deepEqual(received.filter(entry => entry.event === 'response.output_item.done').map(entry => entry.data.item), expectedJson.output, 'items must also be emitted to streaming clients, not only hidden in the final response');
      } else {
        assert.equal(received.at(-1).raw, '[DONE]');
        assert.deepEqual(received.filter(entry => entry.data?.choices?.length).flatMap(entry => entry.data.choices).filter(choice => choice.finish_reason != null).map(choice => [choice.index, choice.finish_reason]), [[0, 'stop'], [1, 'tool_calls']]);
        const initial = received.filter(entry => entry.data?.choices?.length).flatMap(entry => entry.data.choices).filter(choice => choice.delta?.role);
        assert.deepEqual(initial.map(choice => [choice.index, choice.delta.role, choice.delta.content, choice.logprobs ?? null, choice.provider_choice]), [
          [0, 'assistant', '甲🙂', { content: [chatLog], refusal: null }, 'zero'], [1, 'assistant', null, null, 'one'],
        ]);
        assert.deepEqual(initial[0].delta.annotations, expectedJson.choices[0].message.annotations);
        assert.deepEqual(initial[0].delta.provider_message, { marker: 'choice-zero' });
        assert.deepEqual(initial[1].delta.tool_calls, expectedJson.choices[1].message.tool_calls.map((tool, index) => ({ ...tool, index })));
        assert.deepEqual(received.filter(entry => entry.data?.usage).map(entry => entry.data.usage), [chatUsage], 'usage must be emitted exactly once');
        for (const entry of received.filter(entry => entry.data)) {
          assert.equal(entry.data.id, expectedJson.id); assert.equal(entry.data.model, nativeRoute(protocol));
          assert.equal(entry.data.service_tier, 'default'); assert.equal(entry.data.system_fingerprint, 'fp_boundary');
          assert.deepEqual(entry.data.provider_detail, { immutable: ['keep', 7] });
        }
      }
    }
  });
}

for (const format of ['json_object', 'json_schema']) for (const source of [CHAT, RESPONSES]) {
  test(`HTTP boundary ${source} maps complete ${format} controls and application data`, async () => {
    const target = source === CHAT ? RESPONSES : CHAT;
    plan = { wire: 'json', payload: basicPayload(target) };
    const body = { ...request(source, crossRoute(source)), service_tier: 'default', safety_identifier: 'user-fixture', user: 'legacy-fixture', metadata,
      temperature: 0.25, top_p: 0.9, prompt_cache_key: 'prefix-fixture', prompt_cache_retention: '24h', store: false };
    const chatFormat = format === 'json_object' ? { type: 'json_object' } : { type: 'json_schema', json_schema: { name: 'fixture', description: 'fixture contract', strict: true, schema } };
    const responsesFormat = format === 'json_object' ? { type: 'json_object' } : { type: 'json_schema', name: 'fixture', description: 'fixture contract', strict: true, schema };
    if (source === CHAT) Object.assign(body, { max_completion_tokens: 91, verbosity: 'low', response_format: chatFormat });
    else Object.assign(body, { max_output_tokens: 91, text: { verbosity: 'low', format: responsesFormat } });
    const expected = target === RESPONSES ? {
      model: 'backend-responses', stream: false, instructions: '', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '边界🙂' }] }],
      service_tier: 'default', safety_identifier: 'user-fixture', user: 'legacy-fixture', metadata,
      temperature: 0.25, top_p: 0.9, prompt_cache_key: 'prefix-fixture', prompt_cache_retention: '24h', store: false,
      max_output_tokens: 91, text: { verbosity: 'low', format: responsesFormat },
    } : {
      model: 'backend-chat', stream: false, messages: [{ role: 'user', content: '边界🙂' }],
      service_tier: 'default', safety_identifier: 'user-fixture', user: 'legacy-fixture', metadata,
      temperature: 0.25, top_p: 0.9, prompt_cache_key: 'prefix-fixture', prompt_cache_retention: '24h', store: false,
      max_completion_tokens: 91, verbosity: 'low', response_format: chatFormat,
    };
    const before = calls.length, result = await call(source, body);
    assert.equal(result.status, 200, result.text);
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).protocol, target);
    assert.deepEqual(calls.at(-1).body, expected, 'complete provider body must equal the independent contract');
  });
}

const unsupportedControls = [
  [CHAT, { n: 2 }, 'n'],
  [CHAT, { seed: 19 }, 'seed'],
  [CHAT, { presence_penalty: 0.25 }, 'presence_penalty'],
  [CHAT, { frequency_penalty: 0.5 }, 'frequency_penalty'],
  [CHAT, { logit_bias: { 123: -1 } }, 'logit_bias'],
  [CHAT, { prediction: { type: 'content', content: 'fixture' } }, 'prediction'],
  [CHAT, { messages: [{ role: 'user', name: 'speaker', content: 'hi' }] }, 'messages[0].name'],
  [RESPONSES, { background: true }, 'background'],
  [RESPONSES, { truncation: 'auto' }, 'truncation'],
  [RESPONSES, { include: ['message.output_text.logprobs', 'fixture.future_output'] }, 'include'],
  [RESPONSES, { text: { verbosity: 'low', fixture_future_control: true } }, 'text.fixture_future_control'],
  [CHAT, { stream_options: { fixture_future_control: true } }, 'stream_options.fixture_future_control'],
  [RESPONSES, { stream_options: { fixture_future_control: true } }, 'stream_options.fixture_future_control'],
  [CHAT, { fixture_future_control: { mode: 'opaque' } }, 'fixture_future_control'],
  [RESPONSES, { fixture_future_control: { mode: 'opaque' } }, 'fixture_future_control'],
];
for (const [source, fields, fieldPath] of unsupportedControls) {
  test(`HTTP boundary ${source} rejects ${fieldPath} before any provider call without poisoning later requests`, async () => {
    const target = source === CHAT ? RESPONSES : CHAT;
    plan = { wire: 'json', payload: basicPayload(target) };
    const before = calls.length;
    const result = await call(source, { ...request(source, crossRoute(source)), ...fields });
    assert.equal(result.status, 400, `unsupported controls must not be accepted or reported as a transient outage: ${result.text}`);
    assert.equal(calls.length, before, 'unsupported request must never reach or charge a provider');
    assert.ok(JSON.parse(result.text).error, 'must return a structured error');
    const pathTokens = fieldPath.match(/[A-Za-z_]+/g);
    assert.ok(pathTokens.every(token => result.text.includes(token)), `error must locate ${fieldPath}: ${result.text}`);
    const plain = await call(source, request(source, crossRoute(source)));
    assert.equal(plain.status, 200, `incompatibility must not cool the provider: ${plain.text}`);
    assert.equal(calls.length, before + 1);
  });
}

for (const source of [CHAT, RESPONSES]) {
  test(`HTTP boundary ${source} skips an incompatible candidate and preserves opaque controls on the native fallback`, async () => {
    plan = { wire: 'json', payload: basicPayload(source) };
    const route = source === CHAT ? 'fallback-chat' : 'fallback-responses';
    const body = { ...request(source, route), fixture_future_control: { nested: { value: 'must survive' } } };
    const before = calls.length, result = await call(source, body);
    assert.equal(result.status, 200, result.text);
    assert.equal(calls.length, before + 1, 'preflight skip must not make a paid probe request');
    assert.equal(calls.at(-1).protocol, source, 'native fallback must receive the request');
    assert.deepEqual(calls.at(-1).body, { ...body, model: backendModel(source) });
  });
}

test('HTTP boundary native Responses JSON -> SSE emits logprobs in text delta and done events, not only the final payload', async () => {
  plan = { wire: 'json', payload: responsesConvertibleJson() };
  const result = await call(RESPONSES, richNativeRequest(RESPONSES, true));
  assert.equal(result.status, 200, result.text);
  const events = readEvents(result.text);
  for (const type of ['response.output_text.delta', 'response.output_text.done']) {
    const matching = events.filter(event => event.data?.type === type);
    assert.equal(matching.length, 1, `${type} must be emitted exactly once`);
    assert.deepEqual(matching[0].data.logprobs, [chatLog], `${type} must carry the requested probabilities`);
  }
});

test('HTTP boundary native Responses JSON -> SSE supplies consecutive sequence numbers on every generated event', async () => {
  plan = { wire: 'json', payload: responsesConvertibleJson() };
  const result = await call(RESPONSES, richNativeRequest(RESPONSES, true));
  assert.equal(result.status, 200, result.text);
  const events = readEvents(result.text);
  assert.ok(events.length > 3);
  assert.deepEqual(events.map(entry => entry.data.sequence_number), events.map((_, index) => index));
  for (const entry of events) assert.equal(entry.event, entry.data.type);
});
