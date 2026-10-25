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
const MESSAGES = 'messages';
const supplierShapes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'supplier-response-shapes.json'), 'utf8'));
const protocolPath = p => p === CHAT ? 'chat/completions' : p;
const backendModel = p => p === CHAT ? 'backend-chat' : p === RESPONSES ? 'backend-responses' : 'backend-messages';
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
  if (protocol === MESSAGES) return { model: route, stream, max_tokens: 128, messages: [{ role: 'user', content: '边界🙂' }] };
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
async function call(protocol, body, options = {}) {
  const response = await fetch(`${base}/v1/${protocolPath(protocol)}`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', ...options.headers },
    body: options.rawBody || JSON.stringify(body), signal: options.signal || AbortSignal.timeout(10000),
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
      const protocol = req.url.endsWith('/responses') ? RESPONSES : req.url.endsWith('/messages') ? MESSAGES : CHAT;
      const body = JSON.parse(raw);
      const record = { protocol, path: req.url, body, authorization: req.headers.authorization, closedBeforeEnd: false };
      calls.push(record);
      res.once('close', () => { record.closedBeforeEnd = !res.writableEnded; });
      const fixture = plan?.steps ? plan.steps.shift() : plan || { wire: 'json', payload: basicPayload(protocol) };
      if (!fixture) throw new Error('unexpected extra provider call: supplier fixture sequence exhausted');
      if (fixture.wire === 'json') {
        res.writeHead(fixture.status || 200, { 'content-type': 'application/json', ...fixture.headers }); res.end(fixture.rawJson || JSON.stringify(fixture.payload));
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
        if (fixture.abrupt) { await new Promise(resolve => setTimeout(resolve, 20)); res.destroy(); }
        else if (fixture.hold) await new Promise(resolve => {
          const timer = setTimeout(() => { res.end(); resolve(); }, 3000);
          res.once('close', () => { clearTimeout(timer); resolve(); });
        });
        else res.end();
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error.message } }));
    }
  });
  const providerPort = await listen(provider);
  const reserved = http.createServer(), port = await listen(reserved);
  await new Promise(resolve => reserved.close(resolve));
  const configs = [CHAT, RESPONSES, MESSAGES].map(protocol => ({ id: `provider-${protocol}`, type: 'apikey', preset: 'custom',
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
    { id: 'daily-go', entry_protocols: [CHAT, RESPONSES, MESSAGES], targets: [target(CHAT)] },
    { id: 'daily-responses', entry_protocols: [CHAT, RESPONSES, MESSAGES], targets: [target(RESPONSES)] },
    { id: 'daily-messages', entry_protocols: [CHAT, RESPONSES, MESSAGES], targets: [target(MESSAGES)] },
  ];
  // Fault scenarios have independent account identities: a deliberate 429 in
  // one test must not cool a provider used by a different matrix cell.
  for (const source of [CHAT, RESPONSES, MESSAGES]) for (const backend of [CHAT, RESPONSES, MESSAGES]) for (const fault of ['rate', 'policy', 'error-payload', 'late-error', 'eof', 'abrupt', 'cancel']) {
    const id = `fault-${source}-${backend}-${fault}`;
    const pair = ['primary', 'backup'].map(suffix => {
      const account = `${id}-${suffix}`;
      configs.push({ id: account, type: 'apikey', preset: 'custom', base_url: `http://127.0.0.1:${providerPort}/${account}`, apikey: 'boundary-provider-fixture', models: [{ id: backendModel(backend), protocols: [backend], capabilities: { tools: true } }] });
      return { id: suffix, config_id: account, model: backendModel(backend), protocol: backend };
    });
    models.push({ id, entry_protocols: [source], targets: pair });
  }
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

// Product acceptance is deliberately distinct from rejection contracts below.
// A published ordinary-chat route is not usable merely because it returns a
// well-formed 502. These samples reproduce shapes observed at real suppliers;
// their synthetic reasoning/ciphertext must never be confused with live data.
function supplierRequest(protocol, route, stream) {
  const body = request(protocol, route, stream);
  if (protocol === CHAT && stream) body.stream_options = { include_usage: true };
  return body;
}

function supplierChatEvents(payload) {
  const { choices, usage, ...source } = clone(payload);
  const top = { ...source, object: 'chat.completion.chunk' };
  const message = choices[0].message;
  const reasoning = message.reasoning_content;
  const result = [{ data: { ...top, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null, ...(Object.hasOwn(choices[0], 'logprobs') ? { logprobs: null } : {}) }] } }];
  if (typeof reasoning === 'string' && reasoning.length) {
    const split = Math.floor(reasoning.length / 2);
    result.push(...[reasoning.slice(0, split), reasoning.slice(split)].map(part => ({ data: { ...top, choices: [{ index: 0, delta: { reasoning_content: part }, finish_reason: null }] } })));
  } else if (Object.hasOwn(message, 'reasoning_content')) {
    result.push({ data: { ...top, choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] } });
  }
  if (message.content) result.push({ data: { ...top, choices: [{ index: 0, delta: { content: message.content }, finish_reason: null }] } });
  if (message.refusal) result.push({ data: { ...top, choices: [{ index: 0, delta: { refusal: message.refusal }, finish_reason: null }] } });
  if (message.tool_calls) {
    result.push({ data: { ...top, choices: [{ index: 0, delta: { tool_calls: message.tool_calls.map((tool, index) => ({ ...tool, index, function: { ...tool.function, arguments: tool.function.arguments.slice(0, 4) } })) }, finish_reason: null }] } });
    result.push({ data: { ...top, choices: [{ index: 0, delta: { tool_calls: [...message.tool_calls.entries()].reverse().map(([index, tool]) => ({ index, function: { arguments: tool.function.arguments.slice(4) } })) }, finish_reason: null }] } });
  }
  result.push({ data: { ...top, choices: [{ index: 0, delta: {}, finish_reason: choices[0].finish_reason }] } }, { data: { ...top, choices: [], usage } }, { raw: '[DONE]' });
  return result;
}

function supplierResponsesEvents(payload) {
  const response = clone(payload), result = [];
  const emit = (type, fields) => result.push({ event: type, data: { type, sequence_number: result.length, ...fields } });
  emit('response.created', { response: { ...response, output: [], status: 'in_progress', usage: null } });
  for (const [output_index, item] of response.output.entries()) {
    emit('response.output_item.added', { output_index, item: item.type === 'message' ? { ...item, content: [], status: 'in_progress' } : item });
    if (item.type === 'message') for (const [content_index, part] of item.content.entries()) {
      const ids = { output_index, content_index, item_id: item.id };
      emit('response.content_part.added', { ...ids, part: { ...part, text: '' } });
      emit('response.output_text.delta', { ...ids, delta: part.text });
      emit('response.output_text.done', { ...ids, text: part.text });
      emit('response.content_part.done', { ...ids, part });
    }
    emit('response.output_item.done', { output_index, item });
  }
  emit('response.completed', { response });
  return result;
}

function supplierFixture(protocol, wire, payload) {
  return wire === 'json' ? { wire, payload: clone(payload) } : { wire, events: protocol === CHAT ? supplierChatEvents(payload) : protocol === RESPONSES ? supplierResponsesEvents(payload) : supplierMessagesEvents(payload) };
}

function supplierMessagesEvents(payload) {
  const message = clone(payload);
  const events = [{ event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null, stop_sequence: null, usage: { ...message.usage, output_tokens: 0 } } } }];
  for (const [index, block] of message.content.entries()) {
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block.type === 'thinking' ? { type: 'thinking', thinking: '' } : { type: 'text', text: '' } } });
    if (block.type === 'thinking') events.push(
      { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: block.thinking } } },
      { event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } } },
    );
    else events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  }
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: { output_tokens: message.usage.output_tokens } } }, { event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

function replyView(protocol, result, stream) {
  assert.equal(result.status, 200, `ordinary published route must succeed; an explicit error is not product acceptance: ${result.text}`);
  const events = stream ? readEvents(result.text) : [];
  assert.ok(!events.some(entry => entry.event === 'error' || entry.data?.error), `a 200 stream containing error is also a failure: ${result.text}`);
  let payload, text, tools = [], usage;
  if (!stream) {
    payload = JSON.parse(result.text);
    if (protocol === CHAT) {
      text = payload.choices[0].message.content || '';
      tools = payload.choices[0].message.tool_calls || [];
    } else if (protocol === RESPONSES) {
      assert.equal(payload.status, 'completed');
      text = payload.output.flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('');
      tools = payload.output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }));
    } else {
      text = payload.content.filter(part => part.type === 'text').map(part => part.text).join('');
      tools = payload.content.filter(part => part.type === 'tool_use').map(part => ({ id: part.id, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } }));
    }
    usage = payload.usage;
  } else if (protocol === CHAT) {
    assert.equal(events.at(-1).raw, '[DONE]', 'successful Chat stream needs its real terminal');
    const chunks = events.flatMap(entry => entry.data?.choices || []);
    text = chunks.map(choice => choice.delta?.content || '').join('');
    const byIndex = new Map();
    for (const choice of chunks) for (const call of choice.delta?.tool_calls || []) {
      const previous = byIndex.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      previous.id += call.id || ''; previous.function.name += call.function?.name || ''; previous.function.arguments += call.function?.arguments || '';
      byIndex.set(call.index, previous);
    }
    tools = [...byIndex.entries()].sort(([a], [b]) => a - b).map(([, tool]) => tool);
    usage = events.find(entry => entry.data?.usage)?.data.usage;
    payload = events;
  } else if (protocol === RESPONSES) {
    const final = events.filter(entry => entry.data?.type === 'response.completed');
    assert.equal(final.length, 1, 'Responses success terminal must appear exactly once');
    payload = final[0].data.response;
    text = events.filter(entry => entry.data?.type === 'response.output_text.delta').map(entry => entry.data.delta).join('');
    assert.equal(text, payload.output.flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join(''), 'streaming consumers must receive the answer as deltas exactly once');
    tools = payload.output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }));
    for (const tool of tools) assert.equal(events.filter(entry => entry.data?.type === 'response.output_item.done' && entry.data.item?.call_id === tool.id).length, 1);
    usage = payload.usage;
  } else {
    assert.equal(events.at(-1).data.type, 'message_stop');
    text = events.filter(entry => entry.data?.delta?.type === 'text_delta').map(entry => entry.data.delta.text).join('');
    for (const start of events.filter(entry => entry.data?.type === 'content_block_start' && entry.data.content_block?.type === 'tool_use')) {
      const block = start.data.content_block;
      const argumentsText = events.filter(entry => entry.data?.type === 'content_block_delta' && entry.data.index === start.data.index && entry.data.delta?.type === 'input_json_delta').map(entry => entry.data.delta.partial_json).join('');
      assert.equal(events.filter(entry => entry.data?.type === 'content_block_stop' && entry.data.index === start.data.index).length, 1);
      tools.push({ id: block.id, type: 'function', function: { name: block.name, arguments: argumentsText || JSON.stringify(block.input) } });
    }
    const startUsage = events.find(entry => entry.data?.type === 'message_start')?.data.message.usage || {};
    const endUsage = events.findLast(entry => entry.data?.type === 'message_delta')?.data.usage || {};
    usage = { ...startUsage, ...endUsage }; payload = events;
  }
  return { text, tools, usage, payload, events };
}

function fieldValues(value, key) {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(item => fieldValues(item, key));
  return [...(Object.hasOwn(value, key) ? [value[key]] : []), ...Object.values(value).flatMap(item => fieldValues(item, key))];
}

function assertNoOptInReasoning(body) {
  for (const key of ['reasoning', 'reasoning_effort', 'thinking', 'previous_response_id', 'conversation']) assert.ok(!Object.hasOwn(body, key), `fixture must remain a normal request without ${key}`);
}

function assertSeparateDetail(view, key, expected) {
  // The source-named detail may be native or inside a provenance extension.
  // Do not bless an invented standard semantic mapping or a silent drop, and
  // never allow the detail to be prepended to the user's final answer.
  const data = view.events.length ? view.events.map(entry => entry.data) : view.payload;
  const values = fieldValues(data, key);
  assert.ok(values.includes(expected) || values.filter(value => typeof value === 'string').join('') === expected, `${key} must remain separately available as source data, not be discarded`);
  assert.ok(!view.text.includes(expected), 'reasoning or ciphertext must not be mixed into the final answer');
}

// 1. Supplier-shaped native responses: all ordinary Chat wire paths must work.
for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PRODUCT acceptance supplier DeepSeek native Chat ${wire} -> ${stream ? 'sse' : 'json'} retains default reasoning and the answer`, async () => {
    const sample = clone(supplierShapes.go_deepseek_chat);
    plan = supplierFixture(CHAT, wire, sample);
    const body = supplierRequest(CHAT, 'daily-go', stream), before = calls.length;
    assertNoOptInReasoning(body);
    const result = await call(CHAT, body);
    assert.equal(calls.length, before + 1);
    assert.deepEqual(calls.at(-1).body, { ...body, model: 'backend-chat' });
    const view = replyView(CHAT, result, stream);
    assert.equal(view.text, '中文🙂'); assertSeparateDetail(view, 'reasoning_content', sample.choices[0].message.reasoning_content);
    assert.deepEqual(view.usage, sample.usage);
    if (!stream) assert.deepEqual(view.payload, { ...sample, model: 'daily-go' });
  });
}

// 2. Crucial product regressions: a common default provider response cannot be
// considered compatible just because the gateway rejects it cleanly.
for (const source of [RESPONSES, MESSAGES]) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PRODUCT acceptance ordinary ${source} via DeepSeek Chat ${wire} -> ${stream ? 'sse' : 'json'} succeeds with default reasoning`, async () => {
    const sample = clone(supplierShapes.go_deepseek_chat);
    plan = supplierFixture(CHAT, wire, sample);
    const body = supplierRequest(source, 'daily-go', stream), before = calls.length;
    assertNoOptInReasoning(body);
    const result = await call(source, body);
    assert.equal(calls.length, before + 1, 'one ordinary request, no concealed retries');
    assert.equal(calls.at(-1).protocol, CHAT);
    const view = replyView(source, result, stream);
    assert.equal(view.text, '中文🙂');
    assertSeparateDetail(view, 'reasoning_content', sample.choices[0].message.reasoning_content);
    assert.ok(view.usage, 'the successful answer must retain real usage');
  });
}

for (const source of [CHAT, MESSAGES]) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PRODUCT acceptance ordinary ${source} via default Responses reasoning ${wire} -> ${stream ? 'sse' : 'json'} remains usable without dropping opaque output`, async () => {
    const sample = clone(supplierShapes.go_native_responses);
    plan = supplierFixture(RESPONSES, wire, sample);
    const body = supplierRequest(source, 'daily-responses', stream), before = calls.length;
    assertNoOptInReasoning(body);
    const result = await call(source, body);
    assert.equal(calls.length, before + 1);
    const view = replyView(source, result, stream);
    assert.equal(view.text, '中文🙂');
    assertSeparateDetail(view, 'encrypted_content', 'FIXTURE_CIPHERTEXT_NOT_REAL_STATE');
    // Keeping opaque source data is not granting Chat server-side continuation.
    assert.ok(!Object.hasOwn(view.payload, 'previous_response_id'));
  });
}

for (const source of [CHAT, RESPONSES, MESSAGES]) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PRODUCT acceptance ${source} via ordinary Claude Messages ${wire} -> ${stream ? 'sse' : 'json'} preserves answer and cache arithmetic`, async () => {
    const sample = clone(supplierShapes.claude_messages);
    plan = supplierFixture(MESSAGES, wire, sample);
    const body = supplierRequest(source, 'daily-messages', stream), before = calls.length;
    assertNoOptInReasoning(body);
    const view = replyView(source, await call(source, body), stream);
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).protocol, MESSAGES);
    assert.equal(view.text, '中文🙂');
    if (source === CHAT) {
      assert.equal(view.usage.prompt_tokens, 9052); assert.equal(view.usage.prompt_tokens_details.cached_tokens, 9039);
      assert.equal(view.usage.completion_tokens, 3); assert.equal(view.usage.total_tokens, 9055);
    } else if (source === RESPONSES) {
      assert.equal(view.usage.input_tokens, 9052); assert.equal(view.usage.input_tokens_details.cached_tokens, 9039);
      assert.equal(view.usage.output_tokens, 3); assert.equal(view.usage.total_tokens, 9055);
    } else {
      assert.deepEqual(view.usage, sample.usage);
      if (!stream) assert.deepEqual(view.payload, { ...sample, model: 'daily-messages' });
    }
  });
}

for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PRODUCT acceptance native Responses ${wire} -> ${stream ? 'sse' : 'json'} retains the full supplier reasoning item`, async () => {
    const sample = clone(supplierShapes.go_native_responses);
    plan = supplierFixture(RESPONSES, wire, sample);
    const before = calls.length;
    const result = await call(RESPONSES, supplierRequest(RESPONSES, 'daily-responses', stream));
    assert.equal(calls.length, before + 1, 'format conversion must not replay the generation');
    const view = replyView(RESPONSES, result, stream);
    assert.equal(view.text, '中文🙂'); assert.deepEqual(view.usage, sample.usage);
    assert.deepEqual(view.payload, { ...sample, model: 'daily-responses' });
    if (stream && wire === 'sse') assert.deepEqual(view.events, publicEvents(supplierResponsesEvents(sample), 'daily-responses'));
    if (stream && wire === 'json') {
      assert.deepEqual(view.events.filter(entry => entry.data?.type === 'response.output_item.done').map(entry => entry.data.item), sample.output);
      assert.deepEqual(view.events.map(entry => entry.data.sequence_number), view.events.map((_, index) => index));
      const reasoning = sample.output.find(item => item.type === 'reasoning');
      const lifecycle = view.events.filter(entry => entry.data?.output_index === 0);
      assert.deepEqual(lifecycle.map(entry => entry.event), [
        'response.output_item.added', 'response.output_item.done',
      ]);
      assert.equal(lifecycle[0].data.item.encrypted_content, null, 'unfinished state is not exposed as a replayable final value');
      assert.deepEqual(lifecycle[1].data.item, reasoning, 'final encrypted state is retained byte for byte');
      assert.equal(view.events[0].event, 'response.created');
      assert.equal(view.events.at(-1).event, 'response.completed');
    }
  });
}

// Empty optional extensions are a separate control: no content exists to lose.
for (const value of ['', null]) for (const wire of ['json', 'sse']) {
  test(`PRODUCT acceptance Responses via Chat tolerates ${value === null ? 'null' : 'empty'} default reasoning_content (${wire})`, async () => {
    const sample = clone(supplierShapes.go_deepseek_chat);
    sample.choices[0].message.reasoning_content = value;
    plan = supplierFixture(CHAT, wire, sample);
    const view = replyView(RESPONSES, await call(RESPONSES, supplierRequest(RESPONSES, 'daily-go', false)), false);
    assert.equal(view.text, '中文🙂');
  });
}

const supplierTools = [
  { id: 'call_one', type: 'function', function: { name: 'alpha', arguments: '{"n":1}' } },
  { id: 'call_two', type: 'function', function: { name: 'beta', arguments: '{"n":2}' } },
];
function toolRequest(source, stream) {
  const body = supplierRequest(source, 'daily-go', stream);
  const definitions = ['alpha', 'beta'].map(name => ({ name, description: 'Return the supplied integer multiplied by 10', parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false } }));
  body.tools = source === CHAT ? definitions.map(fn => ({ type: 'function', function: fn }))
    : source === RESPONSES ? definitions.map(fn => ({ type: 'function', ...fn }))
      : definitions.map(fn => ({ name: fn.name, description: fn.description, input_schema: fn.parameters }));
  return body;
}

function withToolResults(source, body) {
  const next = clone(body);
  if (source === CHAT) next.messages.push({ role: 'assistant', content: null, tool_calls: supplierTools },
    { role: 'tool', tool_call_id: 'call_two', content: '20' }, { role: 'tool', tool_call_id: 'call_one', content: '10' });
  else if (source === RESPONSES) next.input.push(...supplierTools.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })),
    { type: 'function_call_output', call_id: 'call_two', output: '20' }, { type: 'function_call_output', call_id: 'call_one', output: '10' });
  else next.messages.push({ role: 'assistant', content: supplierTools.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })) },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_two', content: '20' }, { type: 'tool_result', tool_use_id: 'call_one', content: '10' }] });
  return next;
}

for (const source of [CHAT, RESPONSES, MESSAGES]) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PRODUCT acceptance ${source} two-round parallel tools with default supplier reasoning (${wire} -> ${stream ? 'sse' : 'json'})`, async () => {
    const first = clone(supplierShapes.go_deepseek_chat), second = clone(supplierShapes.go_deepseek_chat);
    first.choices[0].message.content = null; first.choices[0].message.tool_calls = clone(supplierTools); first.choices[0].finish_reason = 'tool_calls';
    second.id = 'chatcmpl-supplier-second-round'; second.choices[0].message.content = '30';
    plan = { steps: [supplierFixture(CHAT, wire, first), supplierFixture(CHAT, wire, second)] };
    const body = toolRequest(source, stream), before = calls.length;
    assertNoOptInReasoning(body);
    const firstView = replyView(source, await call(source, body), stream);
    assert.deepEqual(firstView.tools, supplierTools, 'all parallel call IDs, names, and raw parameters must survive');
    assert.equal(firstView.text, ''); assertSeparateDetail(firstView, 'reasoning_content', first.choices[0].message.reasoning_content);
    const secondView = replyView(source, await call(source, withToolResults(source, body)), stream);
    assert.equal(secondView.text, '30');
    assert.equal(calls.length, before + 2, 'exactly two rounds, no replay or hidden extra generation');
    const sent = calls.at(-1).body.messages;
    assert.deepEqual(sent.filter(message => message.tool_calls?.length).map(message => message.tool_calls), [supplierTools]);
    assert.deepEqual(sent.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]), [['call_two', '20'], ['call_one', '10']]);
    assertNoOptInReasoning(calls.at(-1).body);
  });
}

for (const source of [CHAT, RESPONSES, MESSAGES]) for (const wire of ['json', 'sse']) {
  test(`PRODUCT acceptance ${source} reports repeated-cache usage with supplier default reasoning (${wire}) without double counting`, async () => {
    const sample = clone(supplierShapes.go_deepseek_chat);
    sample.usage = clone(supplierShapes.repeated_cache_usage);
    plan = supplierFixture(CHAT, wire, sample);
    const stream = wire === 'sse';
    const view = replyView(source, await call(source, supplierRequest(source, 'daily-go', stream)), stream);
    assert.equal(view.text, '中文🙂');
    if (source === CHAT) assert.deepEqual(view.usage, supplierShapes.repeated_cache_usage);
    else if (source === RESPONSES) {
      assert.equal(view.usage.input_tokens, 4368); assert.equal(view.usage.input_tokens_details.cached_tokens, 4352);
      assert.equal(view.usage.output_tokens, 65); assert.equal(view.usage.output_tokens_details.reasoning_tokens, 63);
      assert.equal(view.usage.total_tokens, 4433);
    } else {
      assert.equal(view.usage.input_tokens, 16); assert.equal(view.usage.cache_read_input_tokens, 4352);
      assert.equal(view.usage.cache_creation_input_tokens, 0); assert.equal(view.usage.output_tokens, 65);
      assert.equal(view.usage.input_tokens + view.usage.cache_read_input_tokens + view.usage.cache_creation_input_tokens + view.usage.output_tokens, 4433);
    }
  });
}

for (const [name, control] of [
  ['unowned encrypted history', { input: [supplierShapes.go_native_responses.output[0], { role: 'user', content: 'next' }] }],
  ['unknown previous response', { previous_response_id: 'resp_not_bound_to_this_caller' }],
  ['unowned conversation', { conversation: { id: 'conv_unowned_fixture' } }],
]) {
  test(`REJECTION contract ${name} is rejected locally; preserving supplier output must not grant continuation`, async () => {
    const before = calls.length;
    const result = await call(RESPONSES, { ...supplierRequest(RESPONSES, 'daily-responses', false), ...clone(control) });
    assert.equal(result.status, 409, result.text);
    assert.equal(calls.length, before, 'unowned state must never be sent to a supplier');
    assert.equal(JSON.parse(result.text).error.code, 'upstream_context_unavailable');
  });
}

test('NATIVE Responses JSON -> SSE emits complete reasoning summary/text lifecycle and final ciphertext without replay', async () => {
  const sample = clone(supplierShapes.go_native_responses);
  const item = sample.output[0];
  item.summary = [{ type: 'summary_text', text: '公开摘要🙂' }];
  item.content = [{ type: 'reasoning_text', text: '独立思考文本𠮷' }];
  item.status = 'completed';
  plan = supplierFixture(RESPONSES, 'json', sample);
  const before = calls.length;
  const result = await call(RESPONSES, supplierRequest(RESPONSES, 'daily-responses', true));
  const view = replyView(RESPONSES, result, true);
  assert.equal(calls.length, before + 1);
  assert.deepEqual(view.payload, { ...sample, model: 'daily-responses' });
  assert.equal(view.text, '中文🙂');
  const lifecycle = view.events.filter(entry => entry.data?.output_index === 0);
  assert.deepEqual(lifecycle.map(entry => entry.event), [
    'response.output_item.added', 'response.reasoning_summary_part.added',
    'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
    'response.reasoning_summary_part.done', 'response.reasoning_text.delta',
    'response.reasoning_text.done', 'response.output_item.done',
  ]);
  assert.deepEqual(lifecycle[0].data.item, { ...item, status: 'in_progress', summary: [], content: [], encrypted_content: null });
  assert.deepEqual(lifecycle[1].data.part, { type: 'summary_text', text: '' });
  assert.equal(lifecycle[2].data.delta, '公开摘要🙂');
  assert.equal(lifecycle[3].data.text, '公开摘要🙂');
  assert.deepEqual(lifecycle[4].data.part, item.summary[0]);
  assert.equal(lifecycle[5].data.delta, '独立思考文本𠮷');
  assert.equal(lifecycle[6].data.text, '独立思考文本𠮷');
  assert.deepEqual(lifecycle[7].data.item, item);
  for (const entry of lifecycle.slice(1, -1)) { assert.equal(entry.data.item_id, item.id); assert.equal(entry.data.output_index, 0); }
  assert.deepEqual(view.events.map(entry => entry.data.sequence_number), view.events.map((_, index) => index));
});

test('REJECTION contract unknown native Responses JSON -> SSE item cannot invent a lifecycle or fake success', async () => {
  const sample = clone(supplierShapes.go_native_responses);
  sample.output.unshift({ id: 'future_item_fixture', type: 'fixture_future_output', opaque_state: 'uninterpreted-fixture-state' });
  plan = supplierFixture(RESPONSES, 'json', sample);
  const before = calls.length;
  const result = await call(RESPONSES, supplierRequest(RESPONSES, 'daily-responses', true));
  assert.equal(result.status, 502, result.text);
  assert.equal(calls.length, before + 1);
  assert.equal(JSON.parse(result.text).error.code, 'upstream_response_not_representable');
  assert.ok(!result.text.includes('response.completed'));
});

// Complete finite matrix for the three conversation interfaces implemented by
// this project. Unsupported features get rejection tests, not missing cells.
// The audit at the bottom catches accidentally omitted direction/wire cases.
const INTERFACES = [CHAT, RESPONSES, MESSAGES];
const matrixCoverage = new Set();
const routeFor = backend => backend === CHAT ? 'daily-go' : backend === RESPONSES ? 'daily-responses' : 'daily-messages';
function matrixCase(feature, source, backend, wire, stream, run) {
  const key = [feature, source, backend, wire, stream].join('|');
  assert.ok(!matrixCoverage.has(key), `duplicate contract cell: ${key}`);
  matrixCoverage.add(key);
  test(`MATRIX ${feature}: ${source} -> ${backend}; ${wire} -> ${stream ? 'sse' : 'json'}`, run);
}

function contractPayload(protocol, variant = 'text') {
  const text = variant === 'truncation' ? '未完成🙂' : variant === 'refusal' ? 'FIXTURE_REFUSAL: 不能协助。' : '契约答案🙂';
  let result;
  if (protocol === CHAT) result = {
    id: 'chatcmpl-matrix', object: 'chat.completion', created: 1700000021, model: 'backend-chat',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 15, completion_tokens: 2, total_tokens: 17, prompt_tokens_details: { cached_tokens: 6, cache_write_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 1 } },
  };
  else if (protocol === RESPONSES) result = {
    id: 'resp_matrix', object: 'response', created_at: 1700000021, model: 'backend-responses', status: 'completed', store: false,
    output: [{ id: 'msg_matrix', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 15, output_tokens: 2, total_tokens: 17, input_tokens_details: { cached_tokens: 6, cache_write_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } },
  };
  else result = {
    id: 'msg_matrix', type: 'message', role: 'assistant', model: 'backend-messages', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 6, cache_creation_input_tokens: 4, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 } },
  };
  if (variant === 'refusal') {
    if (protocol === CHAT) result.choices[0].message = { role: 'assistant', content: null, refusal: text };
    else if (protocol === RESPONSES) result.output[0].content = [{ type: 'refusal', refusal: text }];
    else result.stop_reason = 'refusal';
  } else if (variant === 'truncation') {
    if (protocol === CHAT) result.choices[0].finish_reason = 'length';
    else if (protocol === RESPONSES) { result.status = 'incomplete'; result.incomplete_details = { reason: 'max_output_tokens' }; }
    else result.stop_reason = 'max_tokens';
  } else if (variant === 'usage-absent') delete result.usage;
  else if (variant === 'usage-partial') result.usage = protocol === CHAT ? { completion_tokens: 2 } : { output_tokens: 2 };
  else if (variant === 'tools') {
    if (protocol === CHAT) { result.choices[0].message = { role: 'assistant', content: null, tool_calls: clone(supplierTools) }; result.choices[0].finish_reason = 'tool_calls'; }
    else if (protocol === RESPONSES) result.output = supplierTools.map((call, i) => ({ id: `fc_matrix_${i}`, type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' }));
    else { result.content = supplierTools.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })); result.stop_reason = 'tool_use'; }
  }
  return result;
}

function contractEvents(protocol, payload) {
  if (protocol === CHAT) {
    const { usage, ...value } = clone(payload), result = supplierChatEvents(payload);
    const textChunk = result.find(entry => entry.data?.choices?.some(choice => choice.delta?.content));
    if (textChunk && payload.choices[0].logprobs) textChunk.data.choices[0].logprobs = clone(payload.choices[0].logprobs);
    // The supplier-shaped builder has no logprobs and emits a valid terminal.
    // Omitted usage remains omitted; do not synthesize an empty/zero report.
    if (!Object.hasOwn(value, 'usage') && usage === undefined) result.splice(result.length - 2, 1);
    return result;
  }
  if (protocol === RESPONSES) {
    const result = [], response = clone(payload);
    const emit = (type, fields) => result.push({ event: type, data: { type, sequence_number: result.length, ...fields } });
    emit('response.created', { response: { ...response, status: 'in_progress', output: [], usage: null } });
    for (const [output_index, item] of response.output.entries()) {
      emit('response.output_item.added', { output_index, item: { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } });
      if (item.type === 'message') for (const [content_index, part] of item.content.entries()) {
        const ids = { item_id: item.id, output_index, content_index }, refusal = part.type === 'refusal';
        const kind = refusal ? 'refusal' : 'output_text';
        emit('response.content_part.added', { ...ids, part: refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] } });
        emit(`response.${kind}.delta`, { ...ids, delta: refusal ? part.refusal : part.text, ...(Object.hasOwn(part, 'logprobs') ? { logprobs: part.logprobs } : {}) });
        emit(`response.${kind}.done`, { ...ids, ...(refusal ? { refusal: part.refusal } : { text: part.text }), ...(Object.hasOwn(part, 'logprobs') ? { logprobs: part.logprobs } : {}) });
        emit('response.content_part.done', { ...ids, part });
      }
      else {
        emit('response.function_call_arguments.delta', { item_id: item.id, output_index, delta: item.arguments });
        emit('response.function_call_arguments.done', { item_id: item.id, output_index, arguments: item.arguments });
      }
      emit('response.output_item.done', { output_index, item });
    }
    const type = response.status === 'incomplete' ? 'response.incomplete' : 'response.completed';
    emit(type, { response }); return result;
  }
  const message = clone(payload);
  const result = [{ event: 'message_start', data: { type: 'message_start', message: { ...message, content: [], stop_reason: null, ...(message.usage ? { usage: { ...message.usage, output_tokens: 0 } } : {}) } } }];
  for (const [index, block] of message.content.entries()) {
    result.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } } });
    result.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } } });
    result.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  }
  result.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, ...(message.usage ? { usage: { output_tokens: message.usage.output_tokens } } : {}) } }, { event: 'message_stop', data: { type: 'message_stop' } });
  return result;
}

function contractFixture(protocol, wire, payload) {
  return wire === 'json' ? { wire, payload: clone(payload) } : { wire, events: contractEvents(protocol, payload) };
}

function inspectTerminal(source, result, stream) {
  assert.equal(result.status, 200, result.text);
  const events = stream ? readEvents(result.text) : [];
  assert.ok(!events.some(entry => entry.event === 'error' || entry.data?.error), result.text);
  if (!stream) {
    const body = JSON.parse(result.text);
    if (source === CHAT) return { text: body.choices[0].message.content || '', refusal: body.choices[0].message.refusal, terminal: body.choices[0].finish_reason, usage: body.usage };
    if (source === RESPONSES) return { text: body.output.flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join(''), refusal: body.output.flatMap(item => item.content || []).filter(part => part.type === 'refusal').map(part => part.refusal).join(''), terminal: body.status, reason: body.incomplete_details?.reason, usage: body.usage };
    return { text: body.content.filter(part => part.type === 'text').map(part => part.text).join(''), refusal: body.stop_reason === 'refusal' ? body.content.map(part => part.text || '').join('') : '', terminal: body.stop_reason, usage: body.usage };
  }
  if (source === CHAT) {
    assert.equal(events.at(-1).raw, '[DONE]');
    const choices = events.flatMap(entry => entry.data?.choices || []);
    const endings = choices.filter(choice => choice.finish_reason != null); assert.equal(endings.length, 1);
    return { text: choices.map(choice => choice.delta?.content || '').join(''), refusal: choices.map(choice => choice.delta?.refusal || '').join(''), terminal: endings[0].finish_reason, usage: events.findLast(entry => entry.data?.usage)?.data.usage };
  }
  if (source === RESPONSES) {
    const finals = events.filter(entry => ['response.completed', 'response.incomplete'].includes(entry.data?.type)); assert.equal(finals.length, 1);
    return { text: events.filter(entry => entry.data?.type === 'response.output_text.delta').map(entry => entry.data.delta).join(''), refusal: events.filter(entry => entry.data?.type === 'response.refusal.delta').map(entry => entry.data.delta).join(''), terminal: finals[0].data.response.status, reason: finals[0].data.response.incomplete_details?.reason, usage: finals[0].data.response.usage };
  }
  assert.equal(events.at(-1).data.type, 'message_stop');
  const terminal = events.findLast(entry => entry.data?.type === 'message_delta')?.data.delta?.stop_reason;
  const text = events.filter(entry => entry.data?.delta?.type === 'text_delta').map(entry => entry.data.delta.text).join('');
  return { text, refusal: terminal === 'refusal' ? text : '', terminal, usage: { ...events.find(entry => entry.data?.type === 'message_start')?.data.message?.usage, ...events.findLast(entry => entry.data?.type === 'message_delta')?.data.usage } };
}

function assertMappedUsage(source, usage, variant) {
  if (variant === 'usage-absent' || variant === 'usage-partial') {
    if (variant === 'usage-partial') assert.equal(usage?.[source === CHAT ? 'completion_tokens' : 'output_tokens'], 2);
    if (!usage) return;
    for (const key of source === CHAT ? ['prompt_tokens', 'total_tokens'] : ['input_tokens', 'total_tokens']) assert.ok(!Object.hasOwn(usage, key), `unknown ${key} must be omitted, never invented as ${usage[key]}`);
    for (const key of ['cache_read_input_tokens', 'cache_creation_input_tokens']) assert.ok(!Object.hasOwn(usage, key), `unknown ${key} cannot be zero-filled`);
    return;
  }
  assert.ok(usage);
  if (source === CHAT) {
    assert.equal(usage.prompt_tokens, 15); assert.equal(usage.completion_tokens, 2); assert.equal(usage.total_tokens, 17);
    assert.equal(usage.prompt_tokens_details.cached_tokens, 6); assert.equal(usage.prompt_tokens_details.cache_write_tokens, 4);
  } else if (source === RESPONSES) {
    assert.equal(usage.input_tokens, 15); assert.equal(usage.output_tokens, 2); assert.equal(usage.total_tokens, 17);
    assert.equal(usage.input_tokens_details.cached_tokens, 6); assert.equal(usage.input_tokens_details.cache_write_tokens, 4);
  } else {
    assert.equal(usage.input_tokens, 5); assert.equal(usage.output_tokens, 2);
    assert.equal(usage.cache_read_input_tokens, 6); assert.equal(usage.cache_creation_input_tokens, 4);
  }
}

const MATRIX_FEATURES = ['text-cache', 'refusal', 'truncation', 'usage-absent', 'usage-partial', 'parallel-tools-two-rounds'];
for (const source of INTERFACES) for (const backend of INTERFACES) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  for (const feature of MATRIX_FEATURES.filter(value => value !== 'parallel-tools-two-rounds')) {
    matrixCase(feature, source, backend, wire, stream, async () => {
      const variant = feature === 'text-cache' ? 'text' : feature;
      plan = contractFixture(backend, wire, contractPayload(backend, variant));
      const body = supplierRequest(source, routeFor(backend), stream), before = calls.length;
      const result = await call(source, body);
      assert.equal(calls.length, before + 1, 'one request, no concealed replay');
      const view = inspectTerminal(source, result, stream);
      if (feature === 'refusal') {
        assert.equal(view.refusal, 'FIXTURE_REFUSAL: 不能协助。');
        // Claude only declares refusal in message_delta at the end. Text that
        // already reached a streaming client cannot be retracted; the explicit
        // refusal terminal must still be present and the text must not repeat.
        if (source !== MESSAGES && !(backend === MESSAGES && wire === 'sse' && stream)) assert.equal(view.text, '', 'refusal must not become ordinary answer text');
        else assert.equal(view.text, 'FIXTURE_REFUSAL: 不能协助。');
      } else {
        assert.equal(view.text, feature === 'truncation' ? '未完成🙂' : '契约答案🙂');
        assert.equal(view.terminal, feature === 'truncation' ? source === CHAT ? 'length' : source === RESPONSES ? 'incomplete' : 'max_tokens' : source === CHAT ? 'stop' : source === RESPONSES ? 'completed' : 'end_turn');
        if (feature === 'truncation' && source === RESPONSES) assert.equal(view.reason, 'max_output_tokens');
      }
      assertMappedUsage(source, view.usage, feature);
      if (backend === MESSAGES && !['usage-absent', 'usage-partial'].includes(feature)) {
        assert.ok(fieldValues(view.usage, 'cache_creation').some(value => value?.ephemeral_5m_input_tokens === 1 && value?.ephemeral_1h_input_tokens === 3), 'cache write TTL breakdown must survive natively or as source-qualified usage detail');
      }
    });
  }
  matrixCase('parallel-tools-two-rounds', source, backend, wire, stream, async () => {
    const first = contractPayload(backend, 'tools'), second = contractPayload(backend);
    plan = { steps: [contractFixture(backend, wire, first), contractFixture(backend, wire, second)] };
    const body = { ...toolRequest(source, stream), model: routeFor(backend) }, before = calls.length;
    const view = replyView(source, await call(source, body), stream);
    assert.equal(view.text, ''); assert.deepEqual(view.tools, supplierTools);
    const final = replyView(source, await call(source, withToolResults(source, body)), stream);
    assert.equal(final.text, '契约答案🙂'); assert.equal(calls.length, before + 2);
    const sent = calls.at(-1).body;
    if (backend === CHAT) {
      assert.deepEqual(sent.messages.filter(message => message.tool_calls?.length).map(message => message.tool_calls), [supplierTools]);
      assert.deepEqual(sent.messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]), [['call_two', '20'], ['call_one', '10']]);
    } else if (backend === RESPONSES) {
      assert.deepEqual(sent.input.filter(item => item.type === 'function_call').map(item => [item.call_id, item.name, item.arguments]), [['call_one', 'alpha', '{"n":1}'], ['call_two', 'beta', '{"n":2}']]);
      assert.deepEqual(sent.input.filter(item => item.type === 'function_call_output').map(item => [item.call_id, typeof item.output === 'string' ? item.output : item.output.map(part => part.text).join('')]), [['call_two', '20'], ['call_one', '10']]);
    } else {
      const assistant = sent.messages.filter(message => message.role === 'assistant'); assert.equal(assistant.length, 1);
      assert.deepEqual(assistant[0].content.filter(part => part.type === 'tool_use').map(part => [part.id, part.name, part.input]), [['call_one', 'alpha', { n: 1 }], ['call_two', 'beta', { n: 2 }]]);
      assert.deepEqual(sent.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result').map(part => [part.tool_use_id, typeof part.content === 'string' ? part.content : part.content.map(value => value.text).join('')]), [['call_two', '20'], ['call_one', '10']]);
    }
    assertMappedUsage(source, final.usage, 'text-cache');
  });
}

test('MATRIX coverage audit includes nine protocol pairs, four wire paths and six semantic contracts with no blank cells', () => {
  for (const feature of MATRIX_FEATURES) for (const source of INTERFACES) for (const backend of INTERFACES) for (const wire of ['json', 'sse']) for (const stream of [false, true]) assert.ok(matrixCoverage.has([feature, source, backend, wire, stream].join('|')));
  assert.equal(matrixCoverage.size, 216);
});

for (const source of INTERFACES) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PRODUCT acceptance signed Claude output ${source} -> messages; ${wire} -> ${stream ? 'sse' : 'json'} retains answer and separate source details`, async () => {
    const sample = clone(supplierShapes.claude_signed_messages);
    plan = supplierFixture(MESSAGES, wire, sample);
    const before = calls.length, result = await call(source, supplierRequest(source, 'daily-messages', stream));
    assert.equal(calls.length, before + 1);
    const view = replyView(source, result, stream);
    assert.equal(view.text, '中文🙂');
    assertSeparateDetail(view, 'thinking', sample.content[0].thinking);
    assertSeparateDetail(view, 'signature', 'FIXTURE_SIGNATURE_NOT_REAL_STATE');
    if (source === MESSAGES && !stream) assert.deepEqual(view.payload, { ...sample, model: 'daily-messages' });
  });
}

for (const backend of INTERFACES) {
  test(`STATE history Chat reasoning_content -> ${backend} is native or explicitly rejected, never silently removed`, async () => {
    const body = { model: routeFor(backend), stream: false, messages: [{ role: 'assistant', content: 'prior answer', reasoning_content: 'FIXTURE_PRIOR_REASONING' }, { role: 'user', content: 'next' }] };
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(CHAT, body);
    if (backend === CHAT) { assert.equal(result.status, 200, result.text); assert.deepEqual(calls.at(-1).body, { ...body, model: 'backend-chat' }); }
    else if (result.status === 200) {
      assert.equal(calls.length, before + 1);
      const sent = calls.at(-1).body;
      const sourceDetail = fieldValues(sent, 'reasoning_content').includes('FIXTURE_PRIOR_REASONING');
      const explicitReasoning = backend === RESPONSES && Array.isArray(sent.input) && sent.input.some(item => item.type === 'reasoning' && [...(item.content || []), ...(item.summary || [])].some(part => part.text === 'FIXTURE_PRIOR_REASONING'));
      assert.ok(sourceDetail || explicitReasoning, `accepting the request requires retaining reasoning separately: ${JSON.stringify(sent)}`);
      assert.ok(!(sent.messages || sent.input || []).some(message => message.role === 'user' && JSON.stringify(message.content).includes('FIXTURE_PRIOR_REASONING')), 'reasoning cannot be promoted into a user instruction');
    } else { assert.ok([400, 409].includes(result.status), result.text); assert.equal(calls.length, before); assert.ok(JSON.parse(result.text).error); }
  });
  test(`STATE history signed Messages -> ${backend} is native or explicitly rejected, never silently removed`, async () => {
    let body = { model: routeFor(backend), stream: false, max_tokens: 128, messages: [{ role: 'assistant', content: supplierShapes.claude_signed_messages.content }, { role: 'user', content: 'next' }] };
    if (backend === MESSAGES) {
      // Obtain this signature through the same public route and preserve its
      // exact preceding transcript. A manufactured/unowned signature is not a
      // valid positive continuation test, even for the native protocol.
      const sample = clone(supplierShapes.claude_signed_messages);
      sample.content[0].signature = 'FIXTURE_SIGNATURE_OWNED_NATIVE_ROUNDTRIP';
      const initial = supplierRequest(MESSAGES, 'daily-messages', false);
      plan = supplierFixture(MESSAGES, 'json', sample);
      const first = await call(MESSAGES, initial);
      assert.equal(first.status, 200, first.text);
      body = { ...initial, messages: [...initial.messages, { role: 'assistant', content: JSON.parse(first.text).content }, { role: 'user', content: 'next' }] };
    }
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(MESSAGES, body);
    if (backend === MESSAGES) { assert.equal(result.status, 200, result.text); assert.deepEqual(calls.at(-1).body, { ...body, model: 'backend-messages' }); }
    else { assert.ok([400, 409].includes(result.status), result.text); assert.equal(calls.length, before); }
  });
  for (const item of [supplierShapes.go_native_responses.output[0], { type: 'item_reference', id: 'item_unowned_fixture' }]) {
    test(`STATE history unowned Responses ${item.type} -> ${backend} is rejected before any call`, async () => {
      const before = calls.length;
      const result = await call(RESPONSES, { model: routeFor(backend), stream: false, input: [clone(item), { role: 'user', content: 'next' }] });
      assert.equal(result.status, 409, result.text); assert.equal(calls.length, before);
      assert.equal(JSON.parse(result.text).error.code, 'upstream_context_unavailable');
    });
  }
}

function assertPreflightRejection(result, before, field) {
  assert.equal(result.status, 400, `unrepresentable ${field} must not be forwarded or classified as an outage: ${result.text}`);
  assert.equal(calls.length, before, `${field} must be rejected before a billable call`);
  assert.ok(JSON.parse(result.text).error);
  assert.ok(result.text.includes(field), `error must name ${field}: ${result.text}`);
}

// Request controls are checked at the actual provider boundary, independently
// of which response wire format happens to be used for this request.
for (const source of INTERFACES) for (const backend of INTERFACES) {
  for (const feature of ['sampling', 'budget', 'metadata', 'cache', 'structured-output', 'reasoning-control', 'stop', 'unknown-control', 'defaults']) {
    if (feature === 'stop' && source === RESPONSES) continue; // No such public request field; not a passing placeholder.
    test(`REQUEST contract ${feature}: ${source} -> ${backend}`, async () => {
      let body = supplierRequest(source, routeFor(backend), false);
      let supported = source === backend, field;
      if (feature === 'sampling') { Object.assign(body, { temperature: 0.25, top_p: 0.9 }); supported = true; }
      if (feature === 'budget') { body[source === CHAT ? 'max_completion_tokens' : source === RESPONSES ? 'max_output_tokens' : 'max_tokens'] = 91; supported = true; }
      if (feature === 'metadata') { body.metadata = source === MESSAGES ? { user_id: 'fixture-user' } : clone(metadata); supported ||= source !== MESSAGES && backend !== MESSAGES; field = 'metadata'; }
      if (feature === 'cache') {
        if (source === MESSAGES) body.cache_control = { type: 'ephemeral', ttl: '1h' };
        else Object.assign(body, { prompt_cache_key: 'fixture-prefix', prompt_cache_retention: '24h' });
        supported ||= source !== MESSAGES && backend !== MESSAGES; field = source === MESSAGES ? 'cache_control' : 'prompt_cache';
      }
      if (feature === 'structured-output') {
        if (source === CHAT) body.response_format = { type: 'json_schema', json_schema: { name: 'fixture', strict: true, schema } };
        else if (source === RESPONSES) body.text = { format: { type: 'json_schema', name: 'fixture', strict: true, schema } };
        else body.output_config = { format: { type: 'json_schema', schema } };
        supported ||= source !== MESSAGES && backend !== MESSAGES; field = source === CHAT ? 'response_format' : source === RESPONSES ? 'text' : 'output_config';
      }
      if (feature === 'reasoning-control') {
        if (source === CHAT) body.reasoning_effort = 'high';
        else if (source === RESPONSES) body.reasoning = { effort: 'high', summary: 'auto' };
        else { body.thinking = { type: 'enabled', budget_tokens: 1024 }; body.max_tokens = 2048; }
        field = source === CHAT ? 'reasoning' : source === RESPONSES ? 'reasoning' : 'thinking';
        // Rich reasoning/summary/budget semantics have no implemented full
        // cross-protocol lifecycle. Do not bless silently reduced controls.
      }
      if (feature === 'stop') {
        body[source === CHAT ? 'stop' : 'stop_sequences'] = ['END', 'STOP'];
        supported = backend !== RESPONSES; field = 'stop';
      }
      if (feature === 'unknown-control') { body.fixture_future_control = { nested: ['keep', 1] }; field = 'fixture_future_control'; }
      if (feature === 'defaults') supported = true;
      plan = contractFixture(backend, 'json', contractPayload(backend));
      const before = calls.length, result = await call(source, body);
      if (!supported) return assertPreflightRejection(result, before, field);
      assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
      const sent = calls.at(-1).body;
      if (source === backend) return assert.deepEqual(sent, { ...body, model: backendModel(backend) }, 'native controls must remain identical');
      if (feature === 'sampling') { assert.equal(sent.temperature, 0.25); assert.equal(sent.top_p, 0.9); }
      if (feature === 'budget') {
        const names = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].filter(key => Object.hasOwn(sent, key));
        assert.equal(names.length, 1, 'exactly one output budget, no conflicting defaults'); assert.equal(sent[names[0]], 91);
      }
      if (feature === 'metadata') assert.deepEqual(sent.metadata, metadata);
      if (feature === 'cache') { assert.equal(sent.prompt_cache_key, 'fixture-prefix'); assert.equal(sent.prompt_cache_retention, '24h'); }
      if (feature === 'structured-output') assert.deepEqual(backend === CHAT ? sent.response_format : sent.text.format, backend === CHAT ? { type: 'json_schema', json_schema: { name: 'fixture', strict: true, schema } } : { type: 'json_schema', name: 'fixture', strict: true, schema });
      if (feature === 'stop') assert.deepEqual(sent[backend === CHAT ? 'stop' : 'stop_sequences'], ['END', 'STOP']);
      if (feature === 'defaults') for (const key of ['store', 'parallel_tool_calls', 'include', 'prompt_cache_key', 'prompt_cache_retention']) assert.ok(!Object.hasOwn(sent, key), `must not inject ${key}`);
    });
  }
  for (const mode of ['auto', 'none', 'required-parallel', 'required-serial', 'forced']) {
    test(`REQUEST tool choice ${mode}: ${source} -> ${backend}`, async () => {
      const body = { ...toolRequest(source, false), model: routeFor(backend) };
      const parallel = mode === 'auto' || mode === 'required-parallel';
      for (const tool of body.tools) (source === CHAT ? tool.function : tool).strict = true;
      if (source === CHAT || source === RESPONSES) {
        body.tool_choice = mode === 'forced' ? source === CHAT ? { type: 'function', function: { name: 'alpha' } } : { type: 'function', name: 'alpha' }
          : mode.startsWith('required') ? 'required' : mode;
        if (mode !== 'none') body.parallel_tool_calls = parallel;
      } else body.tool_choice = mode === 'forced' ? { type: 'tool', name: 'alpha', disable_parallel_tool_use: true }
        : { type: mode.startsWith('required') ? 'any' : mode, ...(mode !== 'none' ? { disable_parallel_tool_use: !parallel } : {}) };
      const payload = contractPayload(backend, mode === 'forced' || mode.startsWith('required') ? 'tools' : 'text');
      if (mode === 'forced' || mode === 'required-serial') {
        if (backend === CHAT) payload.choices[0].message.tool_calls = payload.choices[0].message.tool_calls.slice(0, 1);
        else if (backend === RESPONSES) payload.output = payload.output.slice(0, 1);
        else payload.content = payload.content.slice(0, 1);
      }
      plan = contractFixture(backend, 'json', payload);
      const before = calls.length, result = await call(source, body);
      assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
      const sent = calls.at(-1).body;
      if (source === backend) assert.deepEqual(sent, { ...body, model: backendModel(backend) });
      if (backend === MESSAGES) {
        assert.equal(sent.tool_choice.type, mode === 'forced' ? 'tool' : mode.startsWith('required') ? 'any' : mode);
        if (mode === 'forced') assert.equal(sent.tool_choice.name, 'alpha');
        if (mode !== 'none') assert.equal(sent.tool_choice.disable_parallel_tool_use, !parallel);
      } else {
        if (mode === 'forced') assert.deepEqual(sent.tool_choice, backend === CHAT ? { type: 'function', function: { name: 'alpha' } } : { type: 'function', name: 'alpha' });
        else assert.equal(sent.tool_choice, mode.startsWith('required') ? 'required' : mode);
        if (mode !== 'none') assert.equal(sent.parallel_tool_calls, parallel);
      }
      for (const tool of sent.tools) {
        const definition = backend === CHAT ? tool.function : tool;
        assert.equal(definition.strict, true);
        assert.deepEqual(backend === MESSAGES ? definition.input_schema : definition.parameters, { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false });
      }
    });
  }
}

// A real one-pixel PNG, not arbitrary bytes labelled as an image. Claude's
// embedded-image contract uses base64 + media_type, distinct from an HTTP URL.
// https://platform.claude.com/docs/en/build-with-claude/vision
const IMAGE_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
function imageRequest(source, route) {
  const text = '看图🙂', url = `data:image/png;base64,${IMAGE_DATA}`;
  if (source === CHAT) return { model: route, stream: false, messages: [{ role: 'system', content: '系统指令🙂' }, { role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url } }] }] };
  if (source === RESPONSES) return { model: route, stream: false, instructions: '系统指令🙂', input: [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: url }] }] };
  return { model: route, stream: false, max_tokens: 128, system: '系统指令🙂', messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA } }] }] };
}

for (const source of INTERFACES) for (const backend of INTERFACES) {
  test(`REQUEST text/image order and system instructions: ${source} -> ${backend}`, async () => {
    const body = imageRequest(source, routeFor(backend));
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(source, body);
    assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
    const sent = calls.at(-1).body;
    if (source === backend) return assert.deepEqual(sent, { ...body, model: backendModel(backend) });
    const messages = backend === RESPONSES ? sent.input : sent.messages;
    const system = backend === MESSAGES ? sent.system : backend === RESPONSES && sent.instructions ? sent.instructions : messages.find(message => message.role === 'system')?.content;
    assert.equal(typeof system === 'string' ? system : system.map(part => part.text).join(''), '系统指令🙂');
    const user = messages.find(message => message.role === 'user');
    assert.deepEqual(user.content, backend === CHAT ? [{ type: 'text', text: '看图🙂' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_DATA}` } }]
      : backend === RESPONSES ? [{ type: 'input_text', text: '看图🙂' }, { type: 'input_image', image_url: `data:image/png;base64,${IMAGE_DATA}` }]
        : [{ type: 'text', text: '看图🙂' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: IMAGE_DATA } }]);
  });
  for (const kind of ['audio', 'file']) {
    test(`REQUEST ${kind} stays native or is explicitly rejected: ${source} -> ${backend}`, async () => {
      const body = supplierRequest(source, routeFor(backend), false);
      const block = source === CHAT ? kind === 'audio' ? { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } } : { type: 'file', file: { filename: 'fixture.pdf', file_data: 'data:application/pdf;base64,AA==' } }
        : source === RESPONSES ? kind === 'audio' ? { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } } : { type: 'input_file', filename: 'fixture.pdf', file_data: 'data:application/pdf;base64,AA==' }
          : kind === 'audio' ? { type: 'audio', source: { type: 'base64', media_type: 'audio/wav', data: 'AA==' } } : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'AA==' } };
      (source === RESPONSES ? body.input : body.messages)[0].content = [block];
      plan = contractFixture(backend, 'json', contractPayload(backend));
      const before = calls.length, result = await call(source, body);
      if (source !== backend) {
        assert.equal(result.status, 400, result.text); assert.equal(calls.length, before);
      } else {
        assert.equal(result.status, 200, result.text); assert.deepEqual(calls.at(-1).body, { ...body, model: backendModel(backend) });
      }
    });
  }
}

for (const source of [CHAT, RESPONSES]) for (const backend of INTERFACES) for (const placement of ['developer', 'late-system']) {
  test(`REQUEST ${placement} instruction order: ${source} -> ${backend}`, async () => {
    const history = [{ role: 'user', content: 'first' }, { role: placement === 'developer' ? 'developer' : 'system', content: 'priority instruction' }, { role: 'user', content: 'last' }];
    const body = source === CHAT ? { model: routeFor(backend), stream: false, messages: history } : { model: routeFor(backend), stream: false, input: history };
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(source, body);
    if (backend === MESSAGES) { assert.equal(result.status, 400, result.text); return assert.equal(calls.length, before); }
    assert.equal(result.status, 200, result.text);
    const sent = calls.at(-1).body, messages = backend === CHAT ? sent.messages : sent.input;
    assert.deepEqual(messages.map(message => [message.role, typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join('')]), [['user', 'first'], [placement === 'developer' ? 'developer' : 'system', 'priority instruction'], ['user', 'last']]);
  });
}

const INPUT_FORMS = [
  [CHAT, 'string', { messages: [{ role: 'user', content: 'AB' }] }],
  [CHAT, 'text blocks', { messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }] }],
  [RESPONSES, 'string', { input: 'AB' }],
  [RESPONSES, 'shorthand message', { input: [{ role: 'user', content: 'AB' }] }],
  [RESPONSES, 'explicit message', { input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'A' }, { type: 'input_text', text: 'B' }] }] }],
  [MESSAGES, 'string', { messages: [{ role: 'user', content: 'AB' }] }],
  [MESSAGES, 'text blocks', { messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }] }],
];
for (const [source, name, input] of INPUT_FORMS) for (const backend of INTERFACES) {
  test(`INPUT form ${source} ${name} -> ${backend} retains all text without adding separators`, async () => {
    const body = { ...supplierRequest(source, routeFor(backend), false), ...clone(input) };
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(source, body);
    assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
    const sent = calls.at(-1).body;
    if (source === backend) return assert.deepEqual(sent, { ...body, model: backendModel(backend) });
    const messages = backend === RESPONSES ? sent.input : sent.messages;
    assert.equal(messages.length, 1); assert.equal(messages[0].role, 'user');
    assert.equal(typeof messages[0].content === 'string' ? messages[0].content : messages[0].content.map(part => part.text).join(''), 'AB');
  });
}

for (const source of [CHAT, RESPONSES]) for (const backend of INTERFACES) for (const store of [false, true]) {
  test(`STATE control ${source} store=${store} -> ${backend} is never silently changed`, async () => {
    const body = { ...supplierRequest(source, routeFor(backend), false), store };
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(source, body);
    if (source === backend || (!store && backend !== MESSAGES)) {
      assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
      assert.equal(calls.at(-1).body.store, store);
    } else {
      assert.equal(result.status, 400, result.text); assert.equal(calls.length, before);
      assert.ok(JSON.parse(result.text).error);
    }
  });
}

for (const source of [CHAT, RESPONSES]) for (const backend of [CHAT, RESPONSES]) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`PROBABILITY contract ${source} -> ${backend}; ${wire} -> ${stream ? 'sse' : 'json'} preserves complete token probabilities exactly once`, async () => {
    const payload = contractPayload(backend);
    if (backend === CHAT) { payload.choices[0].message.content = '甲'; payload.choices[0].logprobs = { content: [chatLog], refusal: null }; }
    else { payload.output[0].content[0].text = '甲'; payload.output[0].content[0].logprobs = [chatLog]; }
    plan = contractFixture(backend, wire, payload);
    const body = supplierRequest(source, routeFor(backend), stream);
    if (source === CHAT) Object.assign(body, { logprobs: true, top_logprobs: 1 });
    else Object.assign(body, { include: ['message.output_text.logprobs'], top_logprobs: 1 });
    const before = calls.length, result = await call(source, body), view = replyView(source, result, stream);
    assert.equal(calls.length, before + 1); assert.equal(view.text, '甲');
    const sent = calls.at(-1).body;
    assert.equal(sent.top_logprobs, 1);
    if (backend === CHAT) assert.equal(sent.logprobs, true);
    else assert.deepEqual(sent.include, ['message.output_text.logprobs']);
    if (!stream) assert.deepEqual(source === CHAT ? view.payload.choices[0].logprobs.content : view.payload.output[0].content[0].logprobs, [chatLog]);
    else {
      const probabilities = source === CHAT ? view.events.flatMap(entry => (entry.data?.choices || []).flatMap(choice => choice.logprobs?.content || []))
        : view.events.filter(entry => entry.data?.type === 'response.output_text.delta').flatMap(entry => entry.data.logprobs || []);
      assert.deepEqual(probabilities, [chatLog]);
      if (source === RESPONSES) assert.deepEqual(view.payload.output[0].content[0].logprobs, [chatLog]);
    }
  });
}

for (const source of [CHAT, RESPONSES]) {
  test(`PROBABILITY contract ${source} -> messages rejects unavailable requested token probabilities before calling`, async () => {
    const body = supplierRequest(source, 'daily-messages', false);
    if (source === CHAT) Object.assign(body, { logprobs: true, top_logprobs: 1 });
    else Object.assign(body, { include: ['message.output_text.logprobs'], top_logprobs: 1 });
    const before = calls.length, result = await call(source, body);
    assert.equal(result.status, 400, result.text); assert.equal(calls.length, before);
    assert.ok(['logprobs', 'include', 'top_logprobs'].some(field => result.text.includes(field)), 'error must identify an offending probability control');
  });
}

function hasSuccessTerminal(source, events) {
  return events.some(entry => source === CHAT ? entry.raw === '[DONE]' || entry.data?.choices?.some(choice => choice.finish_reason != null)
    : source === RESPONSES ? ['response.completed', 'response.incomplete'].includes(entry.data?.type)
      : entry.data?.type === 'message_stop');
}

for (const source of INTERFACES) for (const backend of INTERFACES) {
  for (const fault of ['rate', 'policy', 'error-payload']) {
    test(`FAULT contract ${fault}: ${source} -> ${backend} checks status, attempts and actual fallback`, async () => {
      const rate = fault === 'rate', policy = { error: { code: rate ? 'rate_limit_exceeded' : 'content_policy_violation', message: rate ? 'fixture rate limited' : 'fixture refused this content' } };
      plan = { steps: [{ wire: 'json', status: fault === 'error-payload' ? 200 : rate ? 429 : 403, payload: policy, headers: rate ? { 'retry-after': '1' } : {} }, contractFixture(backend, 'json', contractPayload(backend))] };
      const before = calls.length, result = await call(source, supplierRequest(source, `fault-${source}-${backend}-${fault}`, false));
      if (rate) {
        const view = replyView(source, result, false); assert.equal(view.text, '契约答案🙂');
        assert.equal(calls.length, before + 2); assert.match(calls.at(-1).path, /-backup\//, 'must actually use the next configured account');
      } else {
        if (fault === 'policy') assert.equal(result.status, 403, result.text);
        else assert.ok(result.status >= 400 && result.status < 500, `an error inside HTTP 200 must become an explicit client error: ${result.text}`);
        assert.equal(calls.length, before + 1, 'policy rejection cannot be bypassed using a fallback');
        assert.ok(result.text.includes('content_policy_violation') || result.text.includes('refused'), result.text);
      }
    });
  }
  for (const fault of ['late-error', 'eof', 'abrupt']) {
    test(`FAULT contract ${fault} after visible output: ${source} -> ${backend} cannot replay or fake a success terminal`, async () => {
      const events = contractEvents(backend, contractPayload(backend));
      const firstText = events.findIndex(entry => entry.data?.choices?.some(choice => choice.delta?.content)
        || entry.data?.type === 'response.output_text.delta' || entry.data?.delta?.type === 'text_delta');
      assert.ok(firstText >= 0, 'supplier fixture must really emit visible content');
      const prefix = events.slice(0, firstText + 1);
      if (fault === 'late-error') prefix.push({ event: 'error', data: { type: 'error', error: { code: 'fixture_stream_error', message: 'fixture failed after text' } } });
      plan = { steps: [{ wire: 'sse', events: prefix, abrupt: fault === 'abrupt' }, contractFixture(backend, 'json', contractPayload(backend))] };
      const before = calls.length, result = await call(source, supplierRequest(source, `fault-${source}-${backend}-${fault}`, true));
      assert.equal(result.status, 200, 'HTTP response was already committed by visible text');
      assert.ok(result.text.includes('契约答案🙂'), 'must retain the bytes already emitted');
      const received = readEvents(result.text);
      assert.equal(calls.length, before + 1, 'no replay even though a healthy fallback exists');
      assert.ok(received.some(entry => entry.event === 'error' || entry.data?.error), 'must explicitly terminate as a failed stream');
      assert.equal(hasSuccessTerminal(source, received), false, 'no DONE/completed/message_stop after failure');
    });
  }
}

for (const protocol of INTERFACES) {
  for (const wire of ['json', 'sse']) test(`NATIVE precision contract ${protocol} rejects lossy ${wire} format conversion explicitly`, async () => {
    const payload = contractPayload(protocol), fixture = contractFixture(protocol, wire, payload);
    if (wire === 'json') fixture.rawJson = JSON.stringify({ ...payload, provider_precision: 'RAW_NUMBER' }).replace('"RAW_NUMBER"', '9007199254740993');
    else fixture.events[0].raw = JSON.stringify({ ...fixture.events[0].data, provider_precision: 'RAW_NUMBER' }).replace('"RAW_NUMBER"', '9007199254740993');
    plan = fixture;
    const before = calls.length;
    const result = await call(protocol, supplierRequest(protocol, routeFor(protocol), wire === 'json'));
    assert.equal(result.status, 502, result.text);
    assert.equal(calls.length, before + 1, 'format incompatibility must not replay the generation');
    const error = JSON.parse(result.text).error;
    assert.equal(error.code || error.type, 'upstream_response_not_representable');
    assert.match(error.message, /数字|number|精度/);
  });

  test(`NATIVE precision contract ${protocol} preserves a large integer in a raw SSE extension`, async () => {
    const fixture = contractFixture(protocol, 'sse', contractPayload(protocol));
    fixture.events[0].raw = JSON.stringify({ ...fixture.events[0].data, provider_precision: 'RAW_NUMBER' }).replace('"RAW_NUMBER"', '9007199254740993');
    plan = fixture;
    const before = calls.length;
    const result = await call(protocol, supplierRequest(protocol, routeFor(protocol), true));
    assert.equal(result.status, 200, result.text);
    assert.equal(calls.length, before + 1);
    assert.match(result.text, /"provider_precision":9007199254740993/);
    assert.doesNotMatch(result.text, /"provider_precision":9007199254740992/);
    assert.equal(hasSuccessTerminal(protocol, readEvents(result.text)), true);
  });
}

for (const source of INTERFACES) {
  test(`AUTH contract ${source} rejects an invalid entry key before any provider call`, async () => {
    const before = calls.length;
    const result = await call(source, supplierRequest(source, routeFor(source), false), { headers: { authorization: 'Bearer invalid-fixture-key' } });
    assert.ok([401, 403].includes(result.status), result.text); assert.equal(calls.length, before);
    assert.ok(!result.text.includes('boundary-provider-fixture'), 'never expose the provider credential');
  });
}

for (const protocol of INTERFACES) {
  test(`NATIVE precision contract ${protocol} preserves a large integer in an opaque JSON response extension`, async () => {
    const payload = contractPayload(protocol);
    const rawJson = JSON.stringify({ ...payload, provider_extension: { request_serial: 'REPLACE_LARGE_INTEGER' } }).replace('"REPLACE_LARGE_INTEGER"', '9007199254740993');
    plan = { wire: 'json', rawJson };
    const result = await call(protocol, supplierRequest(protocol, routeFor(protocol), false));
    assert.equal(result.status, 200, result.text);
    assert.match(result.text, /"request_serial"\s*:\s*9007199254740993\b/, 'native rewrite must not round a mathematically distinct JSON value');
  });
}

const EXTRA_CONTROLS = [
  [CHAT, 'seed', 17, false], [CHAT, 'presence_penalty', 0.25, false], [CHAT, 'frequency_penalty', 0.25, false],
  [CHAT, 'n', 2, false], [CHAT, 'logit_bias', { 123: -1 }, false],
  [CHAT, 'prediction', { type: 'content', content: 'fixture' }, false],
  [CHAT, 'modalities', ['text', 'audio'], false],
  [CHAT, 'audio', { voice: 'alloy', format: 'wav' }, false],
  [RESPONSES, 'background', true, false], [RESPONSES, 'truncation', 'auto', false],
  [RESPONSES, 'include', ['fixture.future_output'], false],
  [MESSAGES, 'top_k', 7, false],
  ...[CHAT, RESPONSES].flatMap(source => [
    [source, 'service_tier', 'default', true], [source, 'safety_identifier', 'fixture-user', true], [source, 'user', 'fixture-user', true],
    [source, 'prompt_cache_options', { mode: 'explicit', ttl: '30m' }, true],
  ]),
];
for (const [source, field, value, openAiEquivalent] of EXTRA_CONTROLS) for (const backend of INTERFACES) {
  test(`FIELD contract ${source}.${field} -> ${backend} is preserved, mapped, or rejected before forwarding`, async () => {
    const body = { ...supplierRequest(source, routeFor(backend), false), [field]: clone(value) };
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(source, body);
    if (source === backend || (openAiEquivalent && backend !== MESSAGES)) {
      assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
      assert.deepEqual(calls.at(-1).body[field], value);
      if (source === backend) assert.deepEqual(calls.at(-1).body, { ...body, model: backendModel(backend) });
    } else assertPreflightRejection(result, before, field);
  });
}

for (const source of INTERFACES) for (const backend of INTERFACES) {
  test(`FIELD contract tool schema application keys are not API controls: ${source} -> ${backend}`, async () => {
    const body = { ...toolRequest(source, false), model: routeFor(backend) };
    const expectedSchema = { type: 'object', properties: { cache_control: { type: 'string' }, reasoning: { type: 'string' }, future_control: { type: 'string' } }, additionalProperties: false };
    for (const tool of body.tools) {
      const definition = source === CHAT ? tool.function : tool;
      definition[source === MESSAGES ? 'input_schema' : 'parameters'] = clone(expectedSchema);
    }
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(source, body);
    assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
    for (const tool of calls.at(-1).body.tools) {
      const definition = backend === CHAT ? tool.function : tool;
      assert.deepEqual(definition[backend === MESSAGES ? 'input_schema' : 'parameters'], expectedSchema);
    }
  });
}

for (const source of INTERFACES) for (const backend of INTERFACES) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`ID contract ${source} -> ${backend}; ${wire} -> ${stream ? 'sse' : 'json'} has no collisions and is stable throughout each stream`, async () => {
    const seen = new Set();
    for (const id of ['chatcmpl-abc', 'chatcmpl-def', 'resp_same-looking', 'msg_same-looking', 'a/b', 'a?b', '中文🙂']) {
      const payload = contractPayload(backend); payload.id = id;
      plan = contractFixture(backend, wire, payload);
      const before = calls.length, result = await call(source, supplierRequest(source, routeFor(backend), stream));
      assert.equal(calls.length, before + 1);
      const view = replyView(source, result, stream);
      const ids = stream ? view.events.flatMap(entry => {
        const value = source === CHAT ? entry.data?.id : source === RESPONSES ? entry.data?.response?.id : entry.data?.message?.id;
        return value ? [value] : [];
      }) : [view.payload.id];
      assert.ok(ids.length); assert.equal(new Set(ids).size, 1, 'one response must have one identity');
      assert.equal(typeof ids[0], 'string'); assert.ok(ids[0].length > 0);
      assert.ok(!seen.has(ids[0]), `distinct provider ID ${id} must not collapse to ${ids[0]}`);
      if (source === backend) assert.equal(ids[0], id, 'native identity must not be replaced');
      seen.add(ids[0]);
    }
    assert.equal(seen.size, 7);
  });
}

for (const source of INTERFACES) {
  test(`INPUT contract ${source} rejects malformed JSON without calling a provider`, async () => {
    const before = calls.length;
    const result = await call(source, {}, { rawBody: '{"model":' });
    assert.equal(result.status, 400, result.text); assert.match(result.contentType, /application\/json/);
    assert.ok(JSON.parse(result.text).error); assert.equal(calls.length, before);
  });
  test(`INPUT contract ${source} rejects an unknown public model without calling a provider`, async () => {
    const before = calls.length;
    const result = await call(source, supplierRequest(source, 'fixture-missing-route', false));
    assert.ok([400, 404].includes(result.status), result.text); assert.match(result.contentType, /application\/json/);
    assert.ok(JSON.parse(result.text).error); assert.equal(calls.length, before);
  });
}

for (const backend of [CHAT, RESPONSES]) for (const source of INTERFACES) for (const rawArguments of ['{malformed', '{"n":9007199254740993}']) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
  test(`TOOL arguments ${rawArguments.startsWith('{malformed') ? 'invalid JSON' : 'unsafe integer'}: ${source} -> ${backend}; ${wire} -> ${stream ? 'sse' : 'json'}`, async () => {
    const payload = contractPayload(backend, 'tools');
    if (backend === CHAT) payload.choices[0].message.tool_calls[0].function.arguments = rawArguments;
    else payload.output[0].arguments = rawArguments;
    plan = contractFixture(backend, wire, payload);
    const before = calls.length;
    const result = await call(source, { ...toolRequest(source, stream), model: routeFor(backend) });
    assert.equal(calls.length, before + 1, 'argument conversion cannot replay the generation');
    if (source === MESSAGES) {
      if (result.status === 200 && stream) {
        const received = readEvents(result.text);
        assert.ok(received.some(entry => entry.event === 'error' || entry.data?.error));
        assert.equal(hasSuccessTerminal(source, received), false);
      } else assert.equal(result.status, 502, result.text);
    } else {
      const view = replyView(source, result, stream);
      assert.equal(view.tools[0].function.arguments, rawArguments, 'OpenAI argument strings remain exact; no fabricated object or numeric rounding');
    }
  });
}

for (const backend of INTERFACES) {
  test(`TOOL result error marker is preserved or explicitly rejected: messages -> ${backend}`, async () => {
    const body = withToolResults(MESSAGES, { ...toolRequest(MESSAGES, false), model: routeFor(backend) });
    body.messages.at(-1).content[0].is_error = true;
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const before = calls.length, result = await call(MESSAGES, body);
    if (backend === MESSAGES) {
      assert.equal(result.status, 200, result.text); assert.deepEqual(calls.at(-1).body, { ...body, model: backendModel(backend) });
    } else { assert.equal(result.status, 400, result.text); assert.equal(calls.length, before); assert.ok(result.text.includes('is_error')); }
  });
}

for (const source of INTERFACES) for (const backend of INTERFACES) {
  test(`CANCEL contract ${source} -> ${backend} aborts the real provider connection and does not cool the account`, async () => {
    const events = contractEvents(backend, contractPayload(backend));
    const firstText = events.findIndex(entry => entry.data?.choices?.some(choice => choice.delta?.content) || entry.data?.type === 'response.output_text.delta' || entry.data?.delta?.type === 'text_delta');
    assert.ok(firstText >= 0);
    plan = { wire: 'sse', events: events.slice(0, firstText + 1), hold: true };
    const route = `fault-${source}-${backend}-cancel`, before = calls.length;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000); timer.unref();
    try {
      const response = await fetch(`${base}/v1/${protocolPath(source)}`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(supplierRequest(source, route, true)), signal: controller.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader(), decoder = new TextDecoder(); let text = '';
      while (!text.includes('契约答案🙂')) {
        const item = await reader.read(); assert.equal(item.done, false, 'supplier must stay open until cancellation');
        text += decoder.decode(item.value, { stream: true });
      }
      controller.abort();
      await reader.read().catch(() => undefined);
    } finally { clearTimeout(timer); controller.abort(); }
    const deadline = Date.now() + 2000;
    while (!calls[before]?.closedBeforeEnd && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls.length, before + 1, 'cancelled request must not fall back');
    assert.equal(calls[before].closedBeforeEnd, true, 'the actual provider stream must be aborted, not only ignored downstream');
    plan = contractFixture(backend, 'json', contractPayload(backend));
    const next = await call(source, supplierRequest(source, route, false));
    assert.equal(next.status, 200, next.text); assert.equal(calls.length, before + 2);
    assert.match(calls.at(-1).path, /-primary\//, 'cancellation must not cool the healthy primary');
  });
}
