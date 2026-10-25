const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const shapes = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/supplier-response-shapes.json')));
const ROOT = path.join(__dirname, '..'), KEY = 'reasoning-entry-fixture', ADMIN = 'reasoning-admin-fixture';
const protocols = ['chat_completions', 'responses', 'messages'];
const endpoint = p => p === 'chat_completions' ? 'chat/completions' : p;
const clone = x => JSON.parse(JSON.stringify(x));
const frame = (event, data) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
let upstream, child, directory, base, wire = 'json', source = 'chat_completions', toolRound = false, outage = false;
let holdReasoning = false, releaseReasoning = null;
const calls = [];
const signed = { id: 'msg_signed', type: 'message', role: 'assistant', model: 'backend-messages', content: [{ type: 'thinking', thinking: '公开摘要🙂', signature: 'fixture-provider-signature' }, { type: 'text', text: '中文🙂' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
function response(protocol) {
  const payload = clone(protocol === 'chat_completions' ? shapes.go_deepseek_chat : protocol === 'responses' ? shapes.go_native_responses : signed);
  if (!toolRound) return payload;
  if (protocol === 'chat_completions') { payload.choices[0].message.content = null; payload.choices[0].message.tool_calls = [{ id: 'call-reasoning', type: 'function', function: { name: 'alpha', arguments: '{"n":1}' } }]; payload.choices[0].finish_reason = 'tool_calls'; }
  else if (protocol === 'responses') payload.output = [payload.output[0], { type: 'function_call', id: 'fc-fixture', call_id: 'call-reasoning', name: 'alpha', arguments: '{"n":1}', status: 'completed' }];
  else { payload.content[1] = { type: 'tool_use', id: 'call-reasoning', name: 'alpha', input: { n: 1 } }; payload.stop_reason = 'tool_use'; }
  return payload;
}
function stream(protocol, payload) {
  if (protocol === 'chat_completions') {
    const message = payload.choices[0].message, reason = message.reasoning_content;
    return frame('', { id: payload.id, model: payload.model, choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: reason.slice(0, 17) }, finish_reason: null }] })
      + frame('', { id: payload.id, model: payload.model, choices: [{ index: 0, delta: { reasoning_content: reason.slice(17) }, finish_reason: null }] })
      + frame('', { id: payload.id, model: payload.model, choices: [{ index: 0, delta: { content: message.content, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) }, finish_reason: null }] })
      + frame('', { id: payload.id, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: payload.choices[0].finish_reason }], usage: payload.usage }) + 'data: [DONE]\n\n';
  }
  if (protocol === 'responses') {
    const item = payload.output[0];
    return frame('response.created', { type: 'response.created', response: { ...payload, status: 'in_progress', output: [] } })
      + frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, encrypted_content: 'INCOMPLETE-NOT-REPLAYABLE' } })
      + frame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
      + frame('response.completed', { type: 'response.completed', response: payload });
  }
  return frame('message_start', { type: 'message_start', message: { ...payload, content: [], stop_reason: null } })
    + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
    + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '公开摘要🙂' } })
    + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'fixture-provider-signature' } })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + (toolRound ? frame('content_block_start', { type: 'content_block_start', index: 1, content_block: payload.content[1] }) + frame('content_block_stop', { type: 'content_block_stop', index: 1 }) : frame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }) + frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '中文🙂' } }) + frame('content_block_stop', { type: 'content_block_stop', index: 1 }))
    + frame('message_delta', { type: 'message_delta', delta: { stop_reason: payload.stop_reason }, usage: payload.usage }) + frame('message_stop', { type: 'message_stop' });
}
function input(protocol, model, extra = {}) { return { model, stream: false, ...(protocol === 'responses' ? { input: [{ role: 'user', content: 'first' }] } : { messages: [{ role: 'user', content: 'first' }], ...(protocol === 'messages' ? { max_tokens: 128 } : {}) }), ...extra }; }
async function entry(protocol, body, key = KEY) { const r = await fetch(base + '/v1/' + endpoint(protocol), { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: JSON.stringify(body) }); const text = await r.text(); let payload; try { payload = JSON.parse(text); } catch (_) { payload = null; } return { status: r.status, text, payload }; }
async function admin(route, body, method = 'PUT') { const r = await fetch(base + '/admin/api/' + route, { method, headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, payload: await r.json() }; }
function collect(text) { return text.split('\n').filter(x => x.startsWith('data: ')).flatMap(x => { try { return [JSON.parse(x.slice(6))]; } catch (_) { return []; } }); }
function final(protocol, result) { if (result.payload) return result.payload; const events = collect(result.text); if (protocol === 'responses') return events.findLast(x => ['response.completed', 'response.incomplete'].includes(x.type))?.response; if (protocol === 'messages') { const message = clone(events.find(x => x.type === 'message_start').message); message.content = events.filter(x => x.type === 'content_block_start').map(x => ({ ...x.content_block })); for (const event of events.filter(x => x.type === 'content_block_delta')) { const block = message.content[event.index], delta = event.delta; if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking; if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature; if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text; } return message; } return { choices: [{ message: { role: 'assistant', reasoning_content: events.flatMap(x => x.choices || []).map(x => x.delta?.reasoning_content || '').join(''), content: events.flatMap(x => x.choices || []).map(x => x.delta?.content || '').join(''), reasoning_details: events.flatMap(x => x.choices || []).flatMap(x => x.delta?.reasoning_details || []) } }] }; }
function follow(protocol, model, output, withTools = false) {
  if (protocol === 'responses') return input(protocol, model, { input: [{ role: 'user', content: 'first' }, ...output.output, ...(withTools ? [{ type: 'function_call_output', call_id: 'call-reasoning', output: '10' }] : [{ role: 'user', content: 'next' }])] });
  const assistant = protocol === 'messages' ? { role: 'assistant', content: output.content } : output.choices[0].message;
  return input(protocol, model, { messages: [{ role: 'user', content: 'first' }, assistant, ...(withTools ? protocol === 'messages' ? [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-reasoning', content: '10' }] }] : [{ role: 'tool', tool_call_id: 'call-reasoning', content: '10' }] : [{ role: 'user', content: 'next' }])] });
}
test.before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-reasoning-http-'));
  upstream = http.createServer(async (req, res) => { let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw || '{}'); const protocol = req.url.endsWith('/chat/completions') ? 'chat_completions' : req.url.endsWith('/responses') ? 'responses' : 'messages'; calls.push({ protocol, path: req.url, body, auth: req.headers.authorization }); if (outage && req.url.startsWith('/public-a')) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'temporarily limited' } })); return; } const payload = response(protocol); if (wire === 'sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); const frames = stream(protocol, payload).split('\n\n'); if (holdReasoning) { const count = protocol === 'chat_completions' ? 2 : 3; res.write(frames.splice(0, count).join('\n\n') + '\n\n'); await new Promise(resolve => { releaseReasoning = resolve; }); } const bytes = Buffer.from(frames.join('\n\n')); for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7)); res.end(); } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); } });
  const port = await listen(upstream), reserve = http.createServer(), appPort = await listen(reserve); await new Promise(r => reserve.close(r));
  const configs = protocols.map(protocol => ({ id: protocol, type: 'apikey', preset: 'custom', apikey: 'provider-' + protocol, base_url: `http://127.0.0.1:${port}/` + protocol, models: [{ id: 'backend-' + protocol, protocols: [protocol] }] }));
  configs.push(...['public-a', 'public-b'].map(id => ({ id, type: 'apikey', preset: 'custom', apikey: 'provider-' + id, base_url: `http://127.0.0.1:${port}/` + id, models: [{ id, protocols: ['chat_completions'] }] })));
  const models = protocols.map(protocol => ({ id: protocol, entry_protocols: protocols, targets: [{ id: 'origin', config_id: protocol, model: 'backend-' + protocol, protocol }, { id: 'backup', config_id: 'public-b', model: 'public-b', protocol: 'chat_completions' }] }));
  models.push({ id: 'public', entry_protocols: protocols, targets: ['public-a', 'public-b'].map(id => ({ id, config_id: id, model: id, protocol: 'chat_completions' })) });
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ port: appPort, auth_token: ADMIN, apikeys: [KEY, 'other-caller'], configs, routing: { models } })); base = `http://127.0.0.1:${appPort}`;
  child = spawn(process.execPath, [path.join(ROOT, 'openai.js')], { cwd: ROOT, env: { ...process.env, CONFIG: path.join(directory, 'config.json'), AIROUTER_BIND_HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let i = 0; i < 200; i++) { try { if ((await admin('upstreams', null, 'GET')).status === 200) return; } catch (_) {} await new Promise(r => setTimeout(r, 20)); } throw Error('fixture gateway did not start');
});
test.after(async () => { if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await done; } if (upstream) { upstream.closeAllConnections(); await new Promise(r => upstream.close(r)); } if (directory) fs.rmSync(directory, { recursive: true, force: true }); });
for (const backend of protocols) for (const client of protocols) for (const providerWire of ['json', 'sse']) for (const clientStream of [false, true]) {
  if (backend === client && providerWire === (clientStream ? 'sse' : 'json')) continue;
  test(`reasoning HTTP ${client} <- ${backend} ${providerWire} -> ${clientStream ? 'sse' : 'json'}`, async () => {
    wire = providerWire; source = backend; toolRound = false; const before = calls.length;
    const result = await entry(client, input(client, backend, { stream: clientStream }));
    assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1, 'no fallback around reasoning'); assert.equal(calls.at(-1).protocol, backend);
    const payload = final(client, result); assert.ok(payload, result.text);
    if (client === 'responses') {
      assert.equal(payload.output[0].type, 'reasoning'); assert.equal(payload.output[1].type, 'message'); assert.equal(payload.output[1].content[0].text, '中文🙂');
      if (backend === 'chat_completions') assert.equal(payload.output[0].content[0].text, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
      else if (backend !== client) assert.match(payload.output[0].encrypted_content, /^airouter-state-v1:/);
    } else if (client === 'messages') {
      assert.equal(payload.content[0].type, 'thinking'); assert.equal(payload.content[1].text, '中文🙂');
      if (backend === 'chat_completions') { assert.equal(payload.content[0].thinking, shapes.go_deepseek_chat.choices[0].message.reasoning_content); assert.match(payload.content[0].signature, /^airouter-text-v1:/); }
      else if (backend !== client) assert.match(payload.content[0].signature, /^airouter-state-v1:/);
    } else {
      assert.equal(payload.choices[0].message.content, '中文🙂');
      if (backend !== client) assert.match(payload.choices[0].message.reasoning_details.find(x => x.type === 'reasoning.encrypted').data, /^airouter-state-v1:/);
      else assert.equal(payload.choices[0].message.reasoning_content, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
    }
  });
}
for (const client of ['responses', 'messages']) test(`public reasoning tool result roundtrip survives ${client}`, async () => {
  wire = 'json'; toolRound = true; const first = await entry(client, input(client, 'chat_completions'));
  assert.equal(first.status, 200, first.text); toolRound = false;
  const second = await entry(client, follow(client, 'chat_completions', first.payload, true));
  assert.equal(second.status, 200, second.text);
  const sent = calls.at(-1).body.messages;
  assert.equal(sent.find(x => x.role === 'assistant').reasoning_content, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
  assert.equal(sent.find(x => x.role === 'tool').tool_call_id, 'call-reasoning'); assert.equal(sent.find(x => x.role === 'tool').content, '10');
});
for (const backend of ['responses', 'messages']) for (const client of protocols.filter(p => p !== backend)) test(`opaque state ${backend} roundtrips through ${client} to its exact origin`, async () => {
  wire = 'json'; toolRound = true; const first = await entry(client, input(client, backend)); assert.equal(first.status, 200, first.text); toolRound = false;
  const body = follow(client, backend, first.payload, true), before = calls.length;
  const second = await entry(client, body); assert.equal(second.status, 200, second.text); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).protocol, backend);
  if (backend === 'responses') assert.deepEqual(calls.at(-1).body.input.find(x => x.type === 'reasoning'), shapes.go_native_responses.output[0]);
  else assert.deepEqual(calls.at(-1).body.messages.find(x => x.role === 'assistant').content[0], signed.content[0]);
  assert.doesNotMatch(JSON.stringify(calls.at(-1).body), /airouter-(?:state|text)-v1:/, 'gateway handles never reach the supplier');
  const otherBefore = calls.length, other = await entry(client, body, 'other-caller'); assert.equal(other.status, 409); assert.equal(calls.length, otherBefore);
});
test('public reasoning history does not pin an exhausted higher-priority account', async () => {
  wire = 'json'; toolRound = false; outage = false;
  const first = await entry('messages', input('messages', 'public')); assert.equal(first.status, 200, first.text); const body = follow('messages', 'public', first.payload);
  outage = true; const before = calls.length, second = await entry('messages', body); outage = false;
  assert.equal(second.status, 200, second.text); assert.deepEqual(calls.slice(before).map(x => x.path.split('/')[1]), ['public-a', 'public-b']);
  assert.equal(calls.at(-1).body.messages.find(x => x.role === 'assistant').reasoning_content, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
});

test('native store:false encrypted reasoning can return with complete history but never grants previous_response_id', async () => {
  wire = 'json'; toolRound = false;
  const first = await entry('responses', input('responses', 'responses', { store: false })); assert.equal(first.status, 200, first.text); assert.equal(first.payload.store, false);
  const next = await entry('responses', { ...follow('responses', 'responses', first.payload), store: false });
  assert.equal(next.status, 200, next.text); assert.deepEqual(calls.at(-1).body.input.find(item => item.type === 'reasoning'), shapes.go_native_responses.output[0]);
  const before = calls.length, resume = await entry('responses', input('responses', 'responses', { previous_response_id: first.payload.id }));
  assert.equal(resume.status, 409); assert.equal(calls.length, before, 'transported client state is not a stored server response');
});

test('opaque transport rejects changed visible content, prefix, tools, caller and public route before any upstream call', async () => {
  wire = 'json'; toolRound = false;
  const first = await entry('messages', input('messages', 'responses')); assert.equal(first.status, 200, first.text);
  const valid = follow('messages', 'responses', first.payload);
  for (const change of [body => { body.messages[1].content[0].thinking = 'tampered'; }, body => { body.messages[0].content = 'different prefix'; }, body => { body.tools = [{ name: 'changed', input_schema: {} }]; }, body => { body.model = 'chat_completions'; }]) {
    const body = clone(valid); change(body); const before = calls.length, rejected = await entry('messages', body);
    assert.equal(rejected.status, 409, rejected.text); assert.equal(calls.length, before);
  }
  const before = calls.length, wrongCaller = await entry('messages', valid, 'other-caller'); assert.equal(wrongCaller.status, 409); assert.equal(calls.length, before);
  const correct = await entry('messages', valid); assert.equal(correct.status, 200, correct.text); assert.equal(calls.at(-1).protocol, 'responses');
});

test('replacing an account A-B-A cannot revive a transported opaque block', async () => {
  wire = 'json'; toolRound = false; const first = await entry('messages', input('messages', 'responses')); assert.equal(first.status, 200, first.text);
  assert.equal((await admin('upstreams/responses', { apikey: 'replacement-key' })).status, 200);
  assert.equal((await admin('upstreams/responses', { apikey: 'provider-responses' })).status, 200);
  const before = calls.length, next = await entry('messages', follow('messages', 'responses', first.payload));
  assert.equal(next.status, 409, next.text); assert.equal(calls.length, before);
});

for (const [client, backend] of [['responses', 'chat_completions'], ['chat_completions', 'responses'], ['messages', 'responses']]) test(`streamed reasoning is delivered before the provider's final answer ${client} <- ${backend}`, async () => {
  wire = 'sse'; toolRound = false; holdReasoning = true; releaseReasoning = null;
  try {
    const response = await fetch(base + '/v1/' + endpoint(client), { method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' }, body: JSON.stringify(input(client, backend, { stream: true })), signal: AbortSignal.timeout(1500) });
    assert.equal(response.status, 200); const reader = response.body.getReader(); let received = '';
    while (!received.includes(client === 'responses' ? 'response.reasoning_text.delta' : 'airouter-state-v1:')) {
      const next = await reader.read(); assert.equal(next.done, false); received += Buffer.from(next.value).toString();
    }
    assert.ok(releaseReasoning, 'provider is still held before the final answer');
    if (client === 'messages') {
      const token = received.match(/airouter-state-v1:[A-Za-z0-9_-]+/)[0]; const before = calls.length;
      const attempt = await entry(client, input(client, backend, { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: token }] }, { role: 'user', content: 'next' }] }));
      assert.equal(attempt.status, 409, 'pending state must not be usable before a valid response terminal'); assert.equal(calls.length, before);
    }
    holdReasoning = false; releaseReasoning(); releaseReasoning = null;
    while (!(await reader.read()).done) { /* finish normally */ }
  } finally { holdReasoning = false; releaseReasoning?.(); releaseReasoning = null; }
});

for (const backend of ['chat_completions', 'responses']) {
  const client = backend === 'responses' ? 'chat_completions' : 'responses';
  const effort = client === 'responses' ? { reasoning: { effort: 'low' } } : { reasoning_effort: 'low' };
  function assertEffort(sent) {
    if (backend === 'responses') { assert.deepEqual(sent.reasoning, { effort: 'low' }); assert.ok(!Object.hasOwn(sent, 'reasoning_effort')); }
    else { assert.equal(sent.reasoning_effort, 'low'); assert.ok(!Object.hasOwn(sent, 'reasoning')); }
  }
  for (const providerWire of ['json', 'sse']) for (const stream of [false, true]) {
    test(`effort with real reasoning shape ${client} -> ${backend} ${providerWire} -> ${stream ? 'sse' : 'json'}`, async () => {
      wire = providerWire; toolRound = false;
      const before = calls.length, result = await entry(client, input(client, backend, { ...effort, stream }));
      assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).protocol, backend);
      assertEffort(calls.at(-1).body);
      const payload = final(client, result);
      if (client === 'responses') {
        assert.deepEqual(payload.output.map(x => x.type), ['reasoning', 'message']);
        assert.deepEqual(payload.output[0].content, [{ type: 'reasoning_text', text: shapes.go_deepseek_chat.choices[0].message.reasoning_content }]);
        assert.equal(payload.output[1].content[0].text, '中文🙂');
      } else {
        assert.equal(payload.choices[0].message.content, '中文🙂');
        const detail = payload.choices[0].message.reasoning_details.find(x => x.format === 'airouter-bridge-v1');
        assert.match(detail.data, /^airouter-state-v1:/);
        assert.match(result.text, /FIXTURE_CIPHERTEXT_NOT_REAL_STATE/);
      }
      if (stream) {
        const events = collect(result.text); assert.ok(!events.some(x => x.error));
        if (client === 'responses') assert.equal(events.at(-1).type, 'response.completed');
        else { assert.match(result.text, /data: \[DONE\]/); assert.equal(events.flatMap(x => x.choices || []).filter(x => x.finish_reason === 'stop').length, 1); }
      }
    });
  }
  for (const providerWire of ['json', 'sse']) {
    test(`effort tool roundtrip ${client} -> ${backend} with ${providerWire} reasoning restores exact source and pairing`, async () => {
      wire = providerWire; toolRound = true;
      const definition = { name: 'alpha', parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } };
      const tools = [{ type: 'function', ...(client === 'responses' ? definition : { function: definition }) }];
      const before = calls.length;
      const first = await entry(client, input(client, backend, { ...effort, tools, parallel_tool_calls: false }));
      assert.equal(first.status, 200, first.text); assert.equal(calls.length, before + 1); assertEffort(calls.at(-1).body);
      assert.equal(calls.at(-1).body.parallel_tool_calls, false);
      assert.equal((backend === 'responses' ? calls.at(-1).body.tools[0] : calls.at(-1).body.tools[0].function).name, 'alpha');
      const call = client === 'responses' ? first.payload.output.find(x => x.type === 'function_call') : first.payload.choices[0].message.tool_calls[0];
      assert.equal(client === 'responses' ? call.call_id : call.id, 'call-reasoning');
      assert.equal(client === 'responses' ? call.arguments : call.function.arguments, '{"n":1}');
      toolRound = false;
      const body = { ...follow(client, backend, first.payload, true), ...effort, tools, parallel_tool_calls: false };
      const second = await entry(client, body);
      assert.equal(second.status, 200, second.text); assert.equal(calls.length, before + 2); assertEffort(calls.at(-1).body);
      if (backend === 'responses') {
        assert.deepEqual(calls.at(-1).body.input.find(x => x.type === 'reasoning'), shapes.go_native_responses.output[0]);
        const result = calls.at(-1).body.input.find(x => x.type === 'function_call_output'); assert.equal(result.call_id, 'call-reasoning'); assert.equal(result.output, '10');
        assert.equal(second.payload.choices[0].message.content, '中文🙂');
      } else {
        const sent = calls.at(-1).body.messages;
        assert.equal(sent.find(x => x.role === 'assistant').reasoning_content, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
        assert.equal(sent.find(x => x.role === 'tool').tool_call_id, 'call-reasoning'); assert.equal(sent.find(x => x.role === 'tool').content, '10');
        assert.equal(second.payload.output.find(x => x.type === 'message').content[0].text, '中文🙂');
      }
    });
  }
}

test('effort does not authorize foreign opaque history or rich reasoning controls and rejected requests keep the target healthy', async () => {
  wire = 'json'; toolRound = false;
  for (const reasoning of [{ effort: 'low', summary: 'auto' }, { effort: 'low', encrypted_content: 'foreign' }, { effort: 'low', generate_summary: 'detailed' }, { effort: 'low', context: 'all_turns' }, { effort: 'unknown' }, {}]) {
    const before = calls.length, rejected = await entry('responses', input('responses', 'chat_completions', { reasoning }));
    assert.equal(rejected.status, 400, rejected.text); assert.equal(calls.length, before); assert.match(rejected.text, /reasoning/);
  }
  const before = calls.length;
  const foreign = await entry('responses', { ...input('responses', 'chat_completions', { reasoning: { effort: 'low' } }), input: [{ role: 'user', content: 'first' }, shapes.go_native_responses.output[0], { role: 'user', content: 'next' }] });
  assert.equal(foreign.status, 409, foreign.text); assert.equal(calls.length, before);
  const healthy = await entry('responses', input('responses', 'chat_completions', { reasoning: { effort: 'low' } }));
  assert.equal(healthy.status, 200, healthy.text); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).protocol, 'chat_completions');
});

test('Messages consumes only explicit synchronous/no-truncation defaults and retains the full ordered transcript', async () => {
  wire = 'json'; toolRound = false;
  const history = [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'prior' }, { role: 'user', content: 'last' }];
  for (const control of [{ background: true }, { truncation: 'auto' }, { background: false, truncation: 'auto' }, { background: true, truncation: 'disabled' }]) {
    const before = calls.length, rejected = await entry('responses', { model: 'messages', stream: false, input: history, ...control });
    assert.equal(rejected.status, 400, rejected.text); assert.equal(calls.length, before);
  }
  const before = calls.length, response = await entry('responses', { model: 'messages', stream: false, background: false, truncation: 'disabled', input: history });
  assert.equal(response.status, 200, response.text); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).protocol, 'messages');
  const sent = calls.at(-1).body;
  assert.ok(!Object.hasOwn(sent, 'background')); assert.ok(!Object.hasOwn(sent, 'truncation'));
  assert.deepEqual(sent.messages.map(message => [message.role, message.content.map(part => part.text).join('')]), [['user', 'first'], ['assistant', 'prior'], ['user', 'last']]);
});

for (const protocol of ['chat_completions', 'responses']) test(`native ${protocol} keeps effort controls while restoring a public reasoning marker in history`, async () => {
  wire = 'json'; toolRound = false;
  const thought = shapes.go_deepseek_chat.choices[0].message.reasoning_content;
  const provenance = { protocol: 'chat_completions', reasoning_content: thought };
  const history = protocol === 'chat_completions'
    ? { messages: [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'prior', reasoning_content: thought, airouter_upstream_reasoning: provenance }, { role: 'user', content: 'next' }], reasoning_effort: 'low' }
    : { input: [{ role: 'user', content: 'first' }, { type: 'reasoning', content: [{ type: 'reasoning_text', text: thought }], summary: [], airouter_upstream_reasoning: provenance }, { role: 'user', content: 'next' }], reasoning: { effort: 'low' } };
  const before = calls.length, result = await entry(protocol, input(protocol, protocol, history));
  assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
  const sent = calls.at(-1).body;
  if (protocol === 'chat_completions') assert.equal(sent.reasoning_effort, 'low');
  else assert.deepEqual(sent.reasoning, { effort: 'low' });
  assert.doesNotMatch(JSON.stringify(sent), /airouter_upstream_reasoning|airouter-(?:state|text)-v1:/);
});
