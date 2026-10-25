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
// Native reasoning remains provider data. No bridge marker is issued and no
// cross-protocol history reconstruction is part of the public HTTP contract.
for (const protocol of protocols) for (const providerWire of ['json', 'sse']) for (const clientStream of [false, true]) {
  test(`native reasoning HTTP ${protocol} ${providerWire} -> ${clientStream ? 'sse' : 'json'} retains source fields and answer separately`, async () => {
    wire = providerWire; toolRound = false; const before = calls.length;
    const body = input(protocol, protocol, { stream: clientStream });
    const result = await entry(protocol, body);
    assert.equal(result.status, 200, result.text); assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).protocol, protocol);
    assert.deepEqual(calls.at(-1).body, { ...body, model: 'backend-' + protocol });
    const payload = final(protocol, result); assert.ok(payload, result.text);
    if (protocol === 'responses') {
      assert.deepEqual(payload.output, shapes.go_native_responses.output);
      assert.deepEqual(payload.usage, shapes.go_native_responses.usage);
    } else if (protocol === 'messages') {
      assert.deepEqual(payload.content, signed.content);
    } else {
      assert.equal(payload.choices[0].message.content, '中文🙂');
      assert.equal(payload.choices[0].message.reasoning_content, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
    }
    assert.doesNotMatch(result.text, /airouter-(?:state|text)-v1:/, 'native output must not introduce gateway reasoning handles');
  });
}
for (const protocol of protocols) test(`native reasoning tool history roundtrip preserves exact ${protocol} fields and pairing`, async () => {
  wire = 'json'; toolRound = true;
  const before = calls.length, first = await entry(protocol, input(protocol, protocol));
  assert.equal(first.status, 200, first.text); toolRound = false;
  const body = follow(protocol, protocol, first.payload, true);
  const second = await entry(protocol, body);
  assert.equal(second.status, 200, second.text); assert.equal(calls.length, before + 2);
  assert.deepEqual(calls.at(-1).body, { ...body, model: 'backend-' + protocol });
  if (protocol === 'responses') {
    assert.deepEqual(calls.at(-1).body.input.find(item => item.type === 'reasoning'), shapes.go_native_responses.output[0]);
    assert.deepEqual(calls.at(-1).body.input.find(item => item.type === 'function_call_output'), { type: 'function_call_output', call_id: 'call-reasoning', output: '10' });
  } else if (protocol === 'messages') {
    assert.deepEqual(calls.at(-1).body.messages[1].content[0], signed.content[0]);
    assert.deepEqual(calls.at(-1).body.messages[2].content[0], { type: 'tool_result', tool_use_id: 'call-reasoning', content: '10' });
  } else {
    assert.equal(calls.at(-1).body.messages[1].reasoning_content, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
    assert.deepEqual(calls.at(-1).body.messages[2], { role: 'tool', tool_call_id: 'call-reasoning', content: '10' });
  }
});
test('public native reasoning history does not pin an exhausted higher-priority account', async () => {
  wire = 'json'; toolRound = false; outage = false;
  const first = await entry('chat_completions', input('chat_completions', 'public')); assert.equal(first.status, 200, first.text);
  const body = follow('chat_completions', 'public', first.payload); outage = true;
  try {
    const before = calls.length, second = await entry('chat_completions', body);
    assert.equal(second.status, 200, second.text);
    assert.deepEqual(calls.slice(before).map(x => x.path.split('/')[1]), ['public-a', 'public-b']);
    assert.equal(calls.at(-1).body.messages[1].reasoning_content, shapes.go_deepseek_chat.choices[0].message.reasoning_content);
  } finally { outage = false; }
});
test('native store:false encrypted reasoning can return with complete history but never grants previous_response_id', async () => {
  wire = 'json'; toolRound = false;
  const first = await entry('responses', input('responses', 'responses', { store: false })); assert.equal(first.status, 200, first.text); assert.equal(first.payload.store, false);
  const next = await entry('responses', { ...follow('responses', 'responses', first.payload), store: false });
  assert.equal(next.status, 200, next.text); assert.deepEqual(calls.at(-1).body.input.find(item => item.type === 'reasoning'), shapes.go_native_responses.output[0]);
  const before = calls.length, resume = await entry('responses', input('responses', 'responses', { previous_response_id: first.payload.id }));
  assert.equal(resume.status, 409); assert.equal(calls.length, before, 'client-supplied history is not a stored server response');
});
test('native opaque history rejects changed prefix, tools and caller before any upstream call', async () => {
  wire = 'json'; toolRound = false;
  const first = await entry('responses', input('responses', 'responses')); assert.equal(first.status, 200, first.text);
  const valid = follow('responses', 'responses', first.payload);
  for (const change of [body => { body.input[0].content = 'different prefix'; }, body => { body.tools = [{ type: 'function', name: 'changed', parameters: {} }]; }]) {
    const body = clone(valid); change(body); const before = calls.length, rejected = await entry('responses', body);
    assert.equal(rejected.status, 409, rejected.text); assert.equal(calls.length, before);
  }
  const before = calls.length, wrongCaller = await entry('responses', valid, 'other-caller');
  assert.equal(wrongCaller.status, 409); assert.equal(calls.length, before);
  const correct = await entry('responses', valid); assert.equal(correct.status, 200, correct.text);
  assert.equal(calls.at(-1).protocol, 'responses');
});
test('replacing an account A-B-A cannot revive native opaque history', async () => {
  wire = 'json'; toolRound = false;
  const first = await entry('responses', input('responses', 'responses')); assert.equal(first.status, 200, first.text);
  const replace = await admin('upstreams/responses', { apikey: 'replacement-key' });
  assert.equal(replace.status, 200, JSON.stringify(replace.payload));
  const restore = await admin('upstreams/responses', { apikey: 'provider-responses' });
  assert.equal(restore.status, 200, JSON.stringify(restore.payload));
  const before = calls.length, next = await entry('responses', follow('responses', 'responses', first.payload));
  assert.equal(next.status, 409, next.text); assert.equal(calls.length, before);
});
for (const protocol of protocols) test(`native ${protocol} streams reasoning before the provider's final answer`, async () => {
  wire = 'sse'; toolRound = false; holdReasoning = true; releaseReasoning = null;
  try {
    const response = await fetch(base + '/v1/' + endpoint(protocol), { method: 'POST', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' }, body: JSON.stringify(input(protocol, protocol, { stream: true })), signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200); const reader = response.body.getReader(); let received = '';
    const expected = protocol === 'chat_completions' ? 'reasoning_content' : protocol === 'responses' ? 'response.output_item.done' : 'thinking_delta';
    while (!received.includes(expected)) { const next = await reader.read(); assert.equal(next.done, false); received += Buffer.from(next.value).toString(); }
    assert.ok(releaseReasoning, 'provider is held before the final answer');
    assert.doesNotMatch(received, /airouter-(?:state|text)-v1:/);
    holdReasoning = false; releaseReasoning(); releaseReasoning = null;
    while (!(await reader.read()).done) { /* finish normally */ }
  } finally { holdReasoning = false; releaseReasoning?.(); releaseReasoning = null; }
});
