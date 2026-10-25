const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// End-to-end contract tests: the real HTTP entry, routing, bridge, and a managed
// free pool run against local deterministic providers. No supplier is contacted.
const TEXT = '中文🙂𠮷';
const REFUSAL = '不能协助🙂';
const ADMIN = 'protocol-http-admin-fixture';
const ENTRY = 'protocol-http-entry-fixture';
const PROTOCOLS = ['chat_completions', 'responses', 'messages'];
const endpoint = p => p === 'chat_completions' ? 'chat/completions' : p;
const usage = {
  chat_completions: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 }, completion_tokens_details: { reasoning_tokens: 1 } },
  responses: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4, cache_write_tokens: 3 }, output_tokens_details: { reasoning_tokens: 1 } },
  messages: { input_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 }, output_tokens: 2 },
};
let server, child, dir, base, childLog = '', serial = 0;
const calls = [];
const listen = srv => new Promise(resolve => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function json(res, status, value) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); }
function frame(event, data) { return `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`; }
function events(text) { return text.split(/\r?\n\r?\n/).flatMap(block => { const line = block.split(/\r?\n/).find(value => value.startsWith('data: ')); if (!line || line === 'data: [DONE]') return []; try { return [JSON.parse(line.slice(6))]; } catch (_) { return []; } }); }
async function splitUnicode(res, wire, cut = false) {
  const bytes = Buffer.from(wire), cuts = new Set([0, bytes.length]);
  // Separate every byte inside all multibyte text occurrences with an actual
  // event-loop delay, so TCP coalescing cannot hide decoder state bugs.
  for (const text of [TEXT, REFUSAL]) {
    const needle = Buffer.from(text); let offset = -1;
    while ((offset = bytes.indexOf(needle, offset + 1)) >= 0) for (let i = 0; i <= needle.length; i++) cuts.add(offset + i);
  }
  const positions = [...cuts].sort((a, b) => a - b);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  res.socket.setNoDelay(true);
  for (let i = 1; i < positions.length; i++) { if (res.destroyed) return; res.write(bytes.subarray(positions[i - 1], positions[i])); await pause(3); }
  if (cut) setTimeout(() => res.destroy(), 20); else res.end();
}
function responseJson(protocol, model, mode, id) {
  const text = mode === 'refusal' ? REFUSAL : TEXT;
  if (protocol === 'chat_completions') return { id: `chatcmpl-${id}`, object: 'chat.completion', model,
    choices: [{ index: 0, message: { role: 'assistant', ...(mode === 'refusal' ? { content: null, refusal: text } : { content: mode === 'filter' ? null : text }) }, finish_reason: mode === 'truncated' ? 'length' : mode === 'filter' ? 'content_filter' : 'stop' }], usage: usage[protocol] };
  if (protocol === 'messages') return { id: `msg_${id}`, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: mode === 'refusal' ? 'refusal' : mode === 'truncated' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: usage[protocol] };
  const nativeDetails = ['force_sse', 'force_json_incomplete'].includes(mode);
  return { id: `resp_${id}`, object: 'response', model, status: ['truncated', 'force_json_incomplete'].includes(mode) ? 'incomplete' : 'completed', store: nativeDetails,
    ...(nativeDetails ? { metadata: { native: 'kept' }, service_tier: 'default', created_at: 12345 } : {}),
    ...(['truncated', 'force_json_incomplete'].includes(mode) ? { incomplete_details: { reason: mode === 'truncated' ? 'max_output_tokens' : 'max_messages' } } : {}),
    output: [{ id: `msg_${id}`, type: 'message', role: 'assistant', status: 'completed', content: mode === 'refusal' ? [{ type: 'refusal', refusal: text }] : [{ type: 'output_text', text, annotations: nativeDetails ? [{ type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.invalid', title: 'fixture' }] : [] }] }], usage: usage[protocol] };
}
function responseStream(protocol, model, mode, id) {
  const payload = responseJson(protocol, model, mode, id);
  if (mode === 'refusal_eof') {
    if (protocol === 'chat_completions') return frame('', { id: `chatcmpl-${id}`, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', refusal: REFUSAL }, finish_reason: null }] });
    if (protocol === 'responses') return frame('response.created', { type: 'response.created', response: { id: `resp_${id}`, model, status: 'in_progress', output: [] } })
      + frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] } })
      + frame('response.refusal.delta', { type: 'response.refusal.delta', item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: REFUSAL });
  }
  if (protocol === 'responses' && ['unknown_empty', 'unknown_content'].includes(mode)) {
    const final = { ...payload, status: 'incomplete', incomplete_details: { reason: 'max_messages' }, output: mode === 'unknown_empty' ? [] : payload.output };
    const start = frame('response.created', { type: 'response.created', response: { id: payload.id, model, status: 'in_progress', output: [] } });
    const content = mode === 'unknown_empty' ? '' : frame('response.output_text.delta', { type: 'response.output_text.delta', item_id: `msg_${id}`, output_index: 0, content_index: 0, delta: TEXT });
    return start + content + frame('response.incomplete', { type: 'response.incomplete', response: final });
  }
  if (protocol === 'responses' && mode === 'badargs') {
    const item = { id: `fc_${id}`, type: 'function_call', call_id: 'call-bad', name: 'alpha', arguments: '{"n":' };
    return frame('response.created', { type: 'response.created', response: { id: payload.id, model, status: 'in_progress', output: [] } })
      + frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } })
      + frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments })
      + frame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments })
      + frame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item })
      + frame('response.completed', { type: 'response.completed', response: { ...payload, output: [item] } });
  }
  const text = mode === 'refusal' ? REFUSAL : TEXT;
  if (protocol === 'chat_completions') return frame('', { id: payload.id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant', ...(mode === 'refusal' ? { refusal: text } : { content: text }) }, finish_reason: null }] }) + (mode === 'cut' ? '' : frame('', { id: payload.id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: payload.choices[0].finish_reason }], usage: usage[protocol] }) + frame('', '[DONE]'));
  if (protocol === 'messages') return frame('message_start', { type: 'message_start', message: { ...payload, content: [], stop_reason: null, usage: { ...usage.messages, output_tokens: 0 } } }) + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) + frame('content_block_stop', { type: 'content_block_stop', index: 0 }) + frame('message_delta', { type: 'message_delta', delta: { stop_reason: payload.stop_reason, stop_sequence: null }, usage: { output_tokens: 2 } }) + frame('message_stop', { type: 'message_stop' });
  return frame('response.created', { type: 'response.created', response: { id: payload.id, model, status: 'in_progress', output: [] } }) + frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }) + frame('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: `msg_${id}`, part: { type: 'output_text', text: '', annotations: [] } }) + frame('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: `msg_${id}`, delta: text }) + frame('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: `msg_${id}`, text }) + frame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: payload.output[0] }) + frame(mode === 'truncated' ? 'response.incomplete' : 'response.completed', { type: mode === 'truncated' ? 'response.incomplete' : 'response.completed', response: payload });
}
async function admin(route, body) {
  const response = await fetch(`${base}/admin/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
function input(protocol, route, mode, stream = false) {
  const common = { model: route, stream };
  if (protocol === 'responses') return { ...common, input: [{ role: 'user', content: `MODE:${mode}` }], store: false };
  return { ...common, messages: [{ role: 'user', content: `MODE:${mode}` }], ...(protocol === 'messages' ? { max_tokens: 128 } : {}) };
}
async function entry(protocol, body) { return fetch(`${base}/v1/${endpoint(protocol)}`, { method: 'POST', headers: { authorization: `Bearer ${ENTRY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }); }
function nativeRoute(protocol) { return `native-${protocol}`; }

// A complete parallel round with reversed result order proves pairing by ID,
// rather than positional zipping, and keeps text before/after in its own place.
function toolHistory(protocol, route) {
  const definitions = ['alpha', 'beta'].map(name => ({ name, parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }));
  const user = 'MODE:tools';
  if (protocol === 'chat_completions') return { model: route, stream: false, parallel_tool_calls: false, tool_choice: 'auto', tools: definitions.map(fn => ({ type: 'function', function: fn })), messages: [
    { role: 'user', content: user }, { role: 'assistant', content: 'plan', tool_calls: definitions.map((fn, i) => ({ id: `call_${i}`, type: 'function', function: { name: fn.name, arguments: JSON.stringify({ n: i + 1 }) } })) },
    { role: 'tool', tool_call_id: 'call_1', content: 'result-beta' }, { role: 'tool', tool_call_id: 'call_0', content: 'result-alpha' }, { role: 'user', content: 'after-results' },
  ] };
  if (protocol === 'responses') return { model: route, stream: false, parallel_tool_calls: false, tool_choice: 'auto', tools: definitions.map(fn => ({ type: 'function', ...fn })), input: [
    { role: 'user', content: user }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'plan' }] },
    ...definitions.map((fn, i) => ({ type: 'function_call', call_id: `call_${i}`, name: fn.name, arguments: JSON.stringify({ n: i + 1 }) })),
    { type: 'function_call_output', call_id: 'call_1', output: 'result-beta' }, { type: 'function_call_output', call_id: 'call_0', output: 'result-alpha' }, { role: 'user', content: 'after-results' },
  ] };
  return { model: route, stream: false, max_tokens: 128, tool_choice: { type: 'auto', disable_parallel_tool_use: true }, tools: definitions.map(fn => ({ name: fn.name, input_schema: fn.parameters })), messages: [
    { role: 'user', content: user }, { role: 'assistant', content: [{ type: 'text', text: 'plan' }, ...definitions.map((fn, i) => ({ type: 'tool_use', id: `call_${i}`, name: fn.name, input: { n: i + 1 } }))] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result-beta' }, { type: 'tool_result', tool_use_id: 'call_0', content: 'result-alpha' }, { type: 'text', text: 'after-results' }] },
  ] };
}
function assertToolHistory(protocol, body) {
  if (protocol === 'chat_completions') {
    const assistant = body.messages.filter(x => x.tool_calls?.length);
    assert.equal(assistant.length, 1); assert.equal(assistant[0].content, 'plan');
    assert.deepEqual(assistant[0].tool_calls.map(x => [x.id, x.function.name, JSON.parse(x.function.arguments)]), [['call_0', 'alpha', { n: 1 }], ['call_1', 'beta', { n: 2 }]]);
    assert.deepEqual(body.messages.filter(x => x.role === 'tool').map(x => [x.tool_call_id, x.content]), [['call_1', 'result-beta'], ['call_0', 'result-alpha']]);
    assert.equal(body.parallel_tool_calls, false); assert.equal(body.messages.at(-1).content, 'after-results');
  } else if (protocol === 'responses') {
    assert.deepEqual(body.input.filter(x => x.type === 'function_call').map(x => [x.call_id, x.name, JSON.parse(x.arguments)]), [['call_0', 'alpha', { n: 1 }], ['call_1', 'beta', { n: 2 }]]);
    assert.deepEqual(body.input.filter(x => x.type === 'function_call_output').map(x => [x.call_id, typeof x.output === 'string' ? x.output : x.output[0].text]), [['call_1', 'result-beta'], ['call_0', 'result-alpha']]);
    const plan = body.input.findIndex(x => x.type === 'message' && JSON.stringify(x.content).includes('plan'));
    assert.ok(plan >= 0 && plan < body.input.findIndex(x => x.type === 'function_call'));
    assert.equal(body.parallel_tool_calls, false); assert.match(JSON.stringify(body.input.at(-1)), /after-results/);
  } else {
    const assistant = body.messages.filter(x => x.role === 'assistant'); assert.equal(assistant.length, 1);
    assert.deepEqual(assistant[0].content.filter(x => x.type === 'tool_use').map(x => [x.id, x.name, x.input]), [['call_0', 'alpha', { n: 1 }], ['call_1', 'beta', { n: 2 }]]);
    assert.equal(assistant[0].content[0].text, 'plan');
    const results = body.messages.find(x => x.content.some(part => part.type === 'tool_result'));
    assert.deepEqual(results.content.filter(x => x.type === 'tool_result').map(x => [x.tool_use_id, typeof x.content === 'string' ? x.content : x.content[0].text]), [['call_1', 'result-beta'], ['call_0', 'result-alpha']]);
    assert.equal(body.tool_choice.disable_parallel_tool_use, true); assert.match(JSON.stringify(body.messages.at(-1)), /after-results/);
  }
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-protocol-http-'));
  server = http.createServer(async (req, res) => {
    if (req.url === '/or/models/user') return json(res, 200, { data: ['vendor/pool-a', 'vendor/pool-b'].map(id => ({ id, pricing: { prompt: '0', completion: '0' }, context_length: 64000, top_provider: { max_completion_tokens: 4096 }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] })) });
    if (req.url === '/or/key') return json(res, 200, { data: { limit: null, limit_remaining: null } });
    if (req.url === '/or/credits') return json(res, 200, { data: { total_credits: 10, total_usage: 1 } });
    let raw = ''; for await (const chunk of req) raw += chunk;
    let body; try { body = JSON.parse(raw); } catch (_) { return json(res, 404, {}); }
    const protocol = req.url.endsWith('/chat/completions') ? 'chat_completions' : req.url.endsWith('/responses') ? 'responses' : req.url.endsWith('/messages') ? 'messages' : null;
    if (!protocol) return json(res, 404, {});
    const mode = JSON.stringify(body).match(/MODE:(\w+)/)?.[1] || 'ok';
    calls.push({ protocol, path: req.url, body, mode }); serial++;
    if (mode === 'filter403') return json(res, 403, { error: { code: 'content_policy_violation', message: 'provider refused this content' } });
    if (mode === 'filter200') return json(res, 200, { error: { code: 'content_policy_violation', message: 'provider refused this content' } });
    if (mode === 'poolfail' && body.model === 'vendor/pool-a') return json(res, 429, { error: { code: 'rate_limit_exceeded', message: 'temporarily rate limited' } });
    if (mode === 'force_json_incomplete') return json(res, 200, responseJson(protocol, body.model, mode, serial));
    if (body.stream || mode === 'force_sse' || mode === 'refusal_eof' || mode.startsWith('unknown_')) return splitUnicode(res, responseStream(protocol, body.model, mode, serial), mode === 'cut');
    json(res, 200, responseJson(protocol, body.model, mode, serial));
  });
  const upstreamPort = await listen(server), root = `http://127.0.0.1:${upstreamPort}`;
  const reserve = http.createServer(), port = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  const configs = PROTOCOLS.map(protocol => ({ id: protocol, type: 'apikey', preset: 'custom', base_url: root + '/' + protocol, apikey: 'protocol-upstream-fixture', models: [{ id: 'backend-' + protocol, protocols: [protocol], capabilities: { tools: true } }] }));
  configs.push({ id: 'backup', type: 'apikey', preset: 'custom', base_url: root + '/backup', apikey: 'backup-upstream-fixture', models: [{ id: 'backup', protocols: ['chat_completions'] }] }, { id: 'or-source', type: 'apikey', preset: 'openrouter', base_url: root + '/or', quota_url: root + '/or/key', apikey: 'or-upstream-fixture', models: [] }, { id: 'pool', type: 'apikey', preset: 'openrouter-free', base_url: root + '/or', credential_ref: 'or-source', pool: { max_attempts: 2 }, models: [{ id: 'free', protocols: ['chat_completions'] }] });
  const eofRoutes = [];
  for (const protocol of ['chat_completions', 'responses']) for (const stream of [false, true]) {
    const id = `eof-${protocol}-${stream ? 'stream' : 'json'}`;
    configs.push({ id, type: 'apikey', preset: 'custom', base_url: root + '/' + id, apikey: 'eof-upstream-fixture', models: [{ id: 'backend-' + id, protocols: [protocol] }] });
    eofRoutes.push({ id, entry_protocols: PROTOCOLS, targets: [{ id: 'eof-primary', config_id: id, model: 'backend-' + id, protocol }, { id: 'backup', config_id: 'backup', model: 'backup', protocol: 'chat_completions' }] });
  }
  configs.push({ id: 'pool-eof', type: 'apikey', preset: 'openrouter-free', base_url: root + '/or', credential_ref: 'or-source', pool: { max_attempts: 2 }, models: [{ id: 'free', protocols: ['chat_completions'] }] });
  eofRoutes.push({ id: 'pool-eof-route', entry_protocols: PROTOCOLS, targets: [{ id: 'eof-pool', config_id: 'pool-eof', model: 'free', protocol: 'chat_completions' }, { id: 'backup', config_id: 'backup', model: 'backup', protocol: 'chat_completions' }] });
  const backup = { id: 'backup', config_id: 'backup', model: 'backup', protocol: 'chat_completions' };
  const config = { auth_token: ADMIN, apikeys: [ENTRY], port, configs, routing: { max_attempts: 2, models: [...eofRoutes, ...PROTOCOLS.flatMap(protocol => [{ id: nativeRoute(protocol), entry_protocols: PROTOCOLS, targets: [{ id: 'primary', config_id: protocol, model: 'backend-' + protocol, protocol }, backup] }, { id: 'only-' + protocol, entry_protocols: PROTOCOLS, targets: [{ id: 'primary', config_id: protocol, model: 'backend-' + protocol, protocol }] }]), { id: 'pool-route', entry_protocols: PROTOCOLS, targets: [{ id: 'pool-target', config_id: 'pool', model: 'free', protocol: 'chat_completions' }, backup] }] } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config)); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'openai.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, CONFIG: path.join(dir, 'config.json'), AIROUTER_BIND_HOST: '127.0.0.1', QUOTA_CHECK_TIMEOUT_MS: '1000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => { childLog += chunk; }); child.stderr.on('data', chunk => { childLog += chunk; });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { try { if ((await admin('upstreams')).status === 200) break; } catch (_) {} await pause(30); }
  for (const id of ['pool', 'pool-eof']) assert.equal((await admin(`upstreams/${id}/pool-refresh`, {})).status, 200, childLog);
});
test.after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('same-protocol HTTP SSE preserves split UTF-8 text, emoji, cache fields and raw usage', async () => {
  for (const protocol of PROTOCOLS) {
    const body = input(protocol, nativeRoute(protocol), 'ok', true);
    if (protocol === 'messages') { body.cache_control = { type: 'ephemeral' }; body.messages[0].content = [{ type: 'text', text: 'MODE:ok', cache_control: { type: 'ephemeral', ttl: '1h' } }]; }
    else { body.prompt_cache_key = 'cache-group-fixture'; body.prompt_cache_retention = '24h'; body.prompt_cache_options = { mode: 'explicit', ttl: '30m' }; }
    const response = await entry(protocol, body); assert.equal(response.status, 200, protocol);
    const text = await response.text(); assert.ok(text.includes(TEXT), protocol); assert.doesNotMatch(text, /�/);
    const received = calls.at(-1).body;
    if (protocol === 'messages') { assert.deepEqual(received.cache_control, body.cache_control); assert.deepEqual(received.messages, body.messages); }
    else { for (const key of ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options']) assert.deepEqual(received[key], body[key]); }
    const parsed = events(text);
    const rawUsage = protocol === 'chat_completions' ? parsed.find(x => x.usage)?.usage : protocol === 'responses' ? parsed.find(x => x.type === 'response.completed')?.response.usage : parsed.find(x => x.type === 'message_start')?.message.usage;
    if (protocol === 'messages') assert.deepEqual(rawUsage, { ...usage.messages, output_tokens: 0 }); else assert.deepEqual(rawUsage, usage[protocol]);
  }
});

test('same-protocol JSON retains usage details without changing caller cache controls', async () => {
  for (const protocol of PROTOCOLS) {
    const body = input(protocol, nativeRoute(protocol), 'ok');
    if (protocol === 'messages') body.cache_control = { type: 'ephemeral' }; else body.prompt_cache_key = 'same-json-key';
    const response = await entry(protocol, body); assert.equal(response.status, 200);
    const payload = await response.json(); assert.deepEqual(payload.usage, usage[protocol]);
    assert.equal(payload.model, nativeRoute(protocol));
    if (protocol === 'messages') assert.deepEqual(calls.at(-1).body.cache_control, body.cache_control); else assert.equal(calls.at(-1).body.prompt_cache_key, body.prompt_cache_key);
  }
});

test('all six cross-protocol HTTP paths preserve one parallel tool round and ID-paired results', async () => {
  for (const source of PROTOCOLS) for (const target of PROTOCOLS) {
    if (source === target) continue;
    const before = calls.length;
    const response = await entry(source, toolHistory(source, nativeRoute(target)));
    const payload = await response.json(); assert.equal(response.status, 200, `${source} -> ${target}: ${JSON.stringify(payload)}`);
    assert.equal(calls.length, before + 1, 'must not silently fall back');
    assert.equal(calls.at(-1).protocol, target); assertToolHistory(target, calls.at(-1).body);
  }
});

test('cross-protocol stop sequences map between Chat and Messages and reject unsupported Responses', async () => {
  let body = input('chat_completions', nativeRoute('messages'), 'ok'); body.stop = ['END'];
  let response = await entry('chat_completions', body); assert.equal(response.status, 200); await response.json(); assert.deepEqual(calls.at(-1).body.stop_sequences, ['END']);
  body = input('messages', nativeRoute('chat_completions'), 'ok'); body.stop_sequences = ['END', 'STOP'];
  response = await entry('messages', body); assert.equal(response.status, 200); await response.json(); assert.deepEqual(calls.at(-1).body.stop, ['END', 'STOP']);
  for (const source of ['chat_completions', 'messages']) {
    body = input(source, 'only-responses', 'ok'); body[source === 'messages' ? 'stop_sequences' : 'stop'] = ['END']; const before = calls.length;
    response = await entry(source, body); assert.equal(response.status, 400); await response.json(); assert.equal(calls.length, before);
  }
});

test('non-equivalent Claude cache controls and failed tool markers reject before contacting a backend', async () => {
  for (const target of ['chat_completions', 'responses']) {
    let body = input('messages', nativeRoute(target), 'ok'); body.cache_control = { type: 'ephemeral' }; let before = calls.length;
    let response = await entry('messages', body); assert.equal(response.status, 400); await response.json(); assert.equal(calls.length, before);
    body = toolHistory('messages', nativeRoute(target)); body.messages[2].content[0].is_error = true; before = calls.length;
    response = await entry('messages', body); assert.equal(response.status, 400); await response.json(); assert.equal(calls.length, before);
  }
});

test('explicit OpenAI storage controls do not silently disappear across Messages', async () => {
  for (const source of ['chat_completions', 'responses']) {
    const body = input(source, 'only-messages', 'ok'); body.store = false;
    const before = calls.length; const response = await entry(source, body);
    assert.equal(response.status, 400); await response.json(); assert.equal(calls.length, before);
  }
});

test('native Responses SSE aggregated to JSON keeps final store, annotations and exact usage details', async () => {
  const body = input('responses', nativeRoute('responses'), 'force_sse', false); body.store = true;
  const response = await entry('responses', body); assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.store, true); assert.deepEqual(payload.metadata, { native: 'kept' });
  assert.equal(payload.service_tier, 'default'); assert.equal(payload.created_at, 12345);
  assert.deepEqual(payload.usage, usage.responses);
  assert.deepEqual(payload.output[0].content[0].annotations, [{ type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.invalid', title: 'fixture' }]);
  assert.equal(payload.model, nativeRoute('responses'));
});

test('Chat refusal JSON and SSE preserve content and cannot trigger a backup', async () => {
  for (const protocol of ['responses', 'messages']) for (const stream of [false, true]) {
    const before = calls.length;
    const response = await entry(protocol, input(protocol, nativeRoute('chat_completions'), 'refusal', stream)); assert.equal(response.status, 200);
    const text = await response.text(); assert.ok(text.includes(REFUSAL), `${protocol}, stream=${stream}`); assert.doesNotMatch(text, /�/);
    assert.equal(calls.length, before + 1); assert.ok(!calls.at(-1).path.startsWith('/backup'));
    if (!stream) { const payload = JSON.parse(text); if (protocol === 'responses') assert.equal(payload.output[0].content[0].type, 'refusal'); else assert.equal(payload.stop_reason, 'refusal'); }
    else if (protocol === 'responses') assert.ok(events(text).some(x => x.type === 'response.refusal.delta'));
  }
});

test('policy refusal HTTP 403 and JSON 200 error do not rotate to another upstream', async () => {
  for (const mode of ['filter403', 'filter200']) {
    const before = calls.length;
    const response = await entry('responses', input('responses', nativeRoute('chat_completions'), mode));
    assert.ok(response.status >= 400 && response.status < 500, `${mode} must remain a client/policy rejection`); await response.text();
    assert.equal(calls.length, before + 1, `${mode} must not fall back`);
    assert.ok(!calls.at(-1).path.startsWith('/backup'));
  }
});

test('truncation/content-filter JSON and SSE retain incomplete terminal states', async () => {
  for (const stream of [false, true]) {
    const response = await entry('responses', input('responses', nativeRoute('chat_completions'), 'truncated', stream)); assert.equal(response.status, 200);
    const text = await response.text(); const payload = stream ? events(text).find(x => x.type === 'response.incomplete')?.response : JSON.parse(text);
    assert.ok(payload, 'must emit incomplete rather than completed'); assert.equal(payload.status, 'incomplete'); assert.equal(payload.incomplete_details.reason, 'max_output_tokens');
  }
  const before = calls.length; const response = await entry('responses', input('responses', nativeRoute('chat_completions'), 'filter'));
  const filtered = await response.json(); assert.equal(response.status, 200); assert.equal(filtered.status, 'incomplete'); assert.equal(filtered.incomplete_details.reason, 'content_filter'); assert.equal(calls.length, before + 1);
});

test('managed pool retries transient model failure but never replays refusal or an emitted stream', async () => {
  let before = calls.length;
  let response = await entry('chat_completions', input('chat_completions', 'pool-route', 'poolfail')); assert.equal(response.status, 200); await response.json();
  assert.deepEqual(calls.slice(before).map(x => x.body.model), ['vendor/pool-a', 'vendor/pool-b']);
  before = calls.length; response = await entry('responses', input('responses', 'pool-route', 'refusal')); assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /不能协助/); assert.equal(calls.length, before + 1);
  before = calls.length; response = await entry('responses', input('responses', 'pool-route', 'cut', true)); assert.equal(response.status, 200);
  const { text } = await streamText(response);
  assert.ok(text.includes('中文')); assert.equal(calls.length, before + 1); assert.ok(!events(text).some(x => x.type === 'response.completed'));
});


async function assertServiceAlive() {
  const response = await fetch(base + '/health', { headers: { authorization: `Bearer ${ENTRY}` }, signal: AbortSignal.timeout(1000) });
  assert.equal(response.status, 200, 'malformed provider events must not terminate the service');
}
async function streamText(response) {
  let text = '', interrupted = false; const decoder = new TextDecoder();
  try { for await (const chunk of response.body) text += decoder.decode(chunk, { stream: true }); } catch (_) { interrupted = true; }
  text += decoder.decode();
  return { text, interrupted };
}

test('unsupported Responses SSE terminal reasons fail clearly before or after output and keep server alive', async () => {
  let before = calls.length;
  let response = await entry('chat_completions', input('chat_completions', 'only-responses', 'unknown_empty', true));
  const emptyText = await response.text();
  await assertServiceAlive();
  assert.equal(response.status, 502, `unknown terminal meaning cannot become an empty successful completion: ${emptyText}`);
  assert.match(emptyText, /represent|保真|unsupported|error/i);
  assert.equal(calls.length, before + 1); await assertServiceAlive();
});

test('unsupported Responses terminal after text ends with an error without replay or server termination', async () => {
  const before = calls.length;
  const response = await entry('chat_completions', input('chat_completions', 'only-responses', 'unknown_content', true));
  assert.equal(response.status, 200, 'the text preceding the terminal has already been emitted');
  const received = await streamText(response);
  assert.ok(received.text.includes(TEXT));
  assert.ok(received.interrupted || /represent|保真|unsupported|error/i.test(received.text));
  assert.ok(!events(received.text).some(event => event.choices?.some(choice => choice.finish_reason === 'stop')));
  assert.equal(calls.length, before + 1); await assertServiceAlive();
});

test('native Responses SSE to JSON preserves unknown incomplete reasons instead of canonicalizing them', async () => {
  const before = calls.length;
  const response = await entry('responses', input('responses', 'only-responses', 'unknown_empty', false));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 'incomplete'); assert.deepEqual(payload.incomplete_details, { reason: 'max_messages' }); assert.deepEqual(payload.output, []);
  assert.equal(payload.model, 'only-responses'); assert.deepEqual(payload.usage, usage.responses);
  assert.equal(calls.length, before + 1); await assertServiceAlive();
});

test('malformed streamed tool arguments cannot crash the server or become a successful Messages tool turn', async () => {
  const before = calls.length;
  const body = input('messages', 'only-responses', 'badargs', true);
  body.tools = [{ name: 'alpha', input_schema: { type: 'object', properties: { n: { type: 'integer' } } } }];
  const response = await entry('messages', body);
  assert.ok(response.status === 200 || response.status === 502);
  const received = await streamText(response);
  assert.ok(received.interrupted || /represent|保真|unsupported|error|JSON/i.test(received.text));
  assert.ok(!events(received.text).some(event => event.type === 'message_delta' && event.delta?.stop_reason === 'tool_use'));
  assert.equal(calls.length, before + 1); await assertServiceAlive();
});


for (const source of ['chat_completions', 'responses', 'pool']) for (const stream of [false, true]) {
  test(`refusal followed by clean EOF never replays ${source} for a ${stream ? 'streaming' : 'JSON'} client`, async () => {
    const route = source === 'pool' ? 'pool-eof-route' : `eof-${source}-${stream ? 'stream' : 'json'}`;
    const before = calls.length;
    const response = await entry('messages', input('messages', route, 'refusal_eof', stream));
    const received = await streamText(response);
    assert.equal(calls.length - before, 1, `refusal delta must not be replayed to another model/account: ${calls.slice(before).map(call => call.body.model).join(' -> ')}`);
    if (stream) {
      assert.equal(response.status, 200);
      assert.ok(received.text.includes(REFUSAL));
      assert.ok(received.interrupted || /error|incomplete|中断|完整/i.test(received.text), `clean EOF must end with an explicit error or interrupted stream: ${received.text}`);
      assert.ok(!events(received.text).some(event => event.type === 'message_delta' && event.delta?.stop_reason === 'end_turn'));
    } else {
      assert.equal(response.status, 502, `truncated refusal must report an error: ${received.text}`);
      assert.ok(JSON.parse(received.text).error);
    }
    await assertServiceAlive();
  });
}


test('provider JSON with an unknown Responses incomplete reason rejects a streaming cross-protocol client without fallback or native cooldown', async () => {
  let before = calls.length;
  let response = await entry('chat_completions', input('chat_completions', nativeRoute('responses'), 'force_json_incomplete', true));
  const text = await response.text();
  assert.equal(response.status, 502, text);
  assert.match(text, /represent|保真|unsupported|error/i);
  assert.equal(calls.length, before + 1, 'a conversion error must not replay the request');
  assert.equal(calls.at(-1).protocol, 'responses');
  before = calls.length;
  response = await entry('responses', input('responses', nativeRoute('responses'), 'ok', false));
  assert.equal(response.status, 200, 'gateway conversion failure must not cool the native model');
  assert.equal((await response.json()).model, nativeRoute('responses'));
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).protocol, 'responses');
  await assertServiceAlive();
});

test('native Responses JSON synthesized as SSE preserves the incomplete final payload and response details', async () => {
  const before = calls.length;
  const body = input('responses', nativeRoute('responses'), 'force_json_incomplete', true); body.store = true;
  const response = await entry('responses', body);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const parsed = events(await response.text());
  assert.ok(!parsed.some(event => event.type === 'response.completed'), 'incomplete source must not be synthesized as completed');
  const payload = parsed.find(event => event.type === 'response.incomplete')?.response;
  assert.ok(payload, 'must emit the original incomplete terminal');
  assert.equal(payload.status, 'incomplete'); assert.deepEqual(payload.incomplete_details, { reason: 'max_messages' });
  assert.equal(payload.store, true); assert.deepEqual(payload.metadata, { native: 'kept' });
  assert.equal(payload.service_tier, 'default'); assert.equal(payload.created_at, 12345);
  assert.deepEqual(payload.usage, usage.responses);
  assert.deepEqual(payload.output[0].content[0].annotations, [{ type: 'url_citation', start_index: 0, end_index: 2, url: 'https://example.invalid', title: 'fixture' }]);
  assert.equal(payload.output[0].content[0].text, TEXT); assert.equal(payload.model, nativeRoute('responses'));
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).body.store, true);
  await assertServiceAlive();
});
