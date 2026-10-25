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
  let frameEnd = -1;
  while ((frameEnd = bytes.indexOf('\n\n', frameEnd + 1)) >= 0) cuts.add(frameEnd + 2);
  const positions = [...cuts].sort((a, b) => a - b);
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
  res.socket.setNoDelay(true);
  for (let i = 1; i < positions.length; i++) { if (res.destroyed) return; res.write(bytes.subarray(positions[i - 1], positions[i])); await pause(3); }
  if (cut) setTimeout(() => res.destroy(), 20); else res.end();
}
const MATRIX_CALLS = [
  { id: 'call-alpha', name: 'alpha', arguments: '{"city":"中文🙂","n":1}' },
  { id: 'call-beta', name: 'beta', arguments: '{"enabled":true,"n":2}' },
];
function matrixJson(protocol, model, id) {
  // Supplier fixtures and expected client assertions are independent of the bridge.
  if (protocol === 'chat_completions') return { id: `chatcmpl-${id}`, object: 'chat.completion', created: 12345, model,
    choices: [{ index: 0, message: { role: 'assistant', content: TEXT, tool_calls: MATRIX_CALLS.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }, finish_reason: 'tool_calls' }], usage: usage.chat_completions };
  if (protocol === 'responses') return { id: `resp_${id}`, object: 'response', created_at: 12345, model, status: 'completed', store: false,
    output: [{ type: 'message', id: `msg_${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: TEXT, annotations: [] }] },
      ...MATRIX_CALLS.map((call, i) => ({ type: 'function_call', id: `fc_${i}`, call_id: call.id, name: call.name, arguments: call.arguments, status: 'completed' }))], usage: usage.responses };
  return { id: `msg_${id}`, type: 'message', role: 'assistant', model,
    content: [{ type: 'text', text: TEXT }, ...MATRIX_CALLS.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }))],
    stop_reason: 'tool_use', stop_sequence: null, usage: usage.messages };
}
function matrixStream(protocol, model, id) {
  const payload = matrixJson(protocol, model, id);
  if (protocol === 'chat_completions') return frame('', { id: payload.id, model, choices: [{ index: 0, delta: { role: 'assistant', content: TEXT }, finish_reason: null }] })
    + frame('', { id: payload.id, model, choices: [{ index: 0, delta: { tool_calls: MATRIX_CALLS.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments.slice(0, 4) } })) }, finish_reason: null }] })
    + frame('', { id: payload.id, model, choices: [{ index: 0, delta: { tool_calls: [1, 0].map(index => ({ index, function: { arguments: MATRIX_CALLS[index].arguments.slice(4) } })) }, finish_reason: null }] })
    + frame('', { id: payload.id, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: payload.usage }) + frame('', '[DONE]');
  if (protocol === 'responses') return frame('response.created', { type: 'response.created', response: { ...payload, output: [], status: 'in_progress' } })
    + frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...payload.output[0], content: [], status: 'in_progress' } })
    + frame('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: `msg_${id}`, part: { type: 'output_text', text: '', annotations: [] } })
    + frame('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: `msg_${id}`, delta: TEXT })
    + frame('response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: `msg_${id}`, text: TEXT })
    + frame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: payload.output[0] })
    + MATRIX_CALLS.map((call, i) => frame('response.output_item.added', { type: 'response.output_item.added', output_index: i + 1, item: { ...payload.output[i + 1], arguments: '', status: 'in_progress' } })).join('')
    + [1, 0].map(i => frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: i + 1, item_id: `fc_${i}`, delta: MATRIX_CALLS[i].arguments })).join('')
    + MATRIX_CALLS.map((call, i) => frame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: i + 1, item_id: `fc_${i}`, arguments: call.arguments }) + frame('response.output_item.done', { type: 'response.output_item.done', output_index: i + 1, item: payload.output[i + 1] })).join('')
    + frame('response.completed', { type: 'response.completed', response: payload });
  return frame('message_start', { type: 'message_start', message: { ...payload, content: [], stop_reason: null, usage: { ...usage.messages, output_tokens: 0 } } })
    + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } })
    + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
    + MATRIX_CALLS.map((call, i) => frame('content_block_start', { type: 'content_block_start', index: i + 1, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } })
      + frame('content_block_delta', { type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: call.arguments.slice(0, 4) } })
      + frame('content_block_delta', { type: 'content_block_delta', index: i + 1, delta: { type: 'input_json_delta', partial_json: call.arguments.slice(4) } })
      + frame('content_block_stop', { type: 'content_block_stop', index: i + 1 })).join('')
    + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } }) + frame('message_stop', { type: 'message_stop' });
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
  return frame('response.created', { type: 'response.created', response: { id: payload.id, model, status: 'in_progress', output: [] } }) + frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: `msg_${id}`, type: 'message', role: 'assistant', status: 'in_progress', content: [] } }) + frame('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: `msg_${id}`, part: mode === 'refusal' ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] } }) + frame(mode === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta', { type: mode === 'refusal' ? 'response.refusal.delta' : 'response.output_text.delta', output_index: 0, content_index: 0, item_id: `msg_${id}`, delta: text }) + frame(mode === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', { type: mode === 'refusal' ? 'response.refusal.done' : 'response.output_text.done', output_index: 0, content_index: 0, item_id: `msg_${id}`, ...(mode === 'refusal' ? { refusal: text } : { text }) }) + frame('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: payload.output[0] }) + frame(mode === 'truncated' ? 'response.incomplete' : 'response.completed', { type: mode === 'truncated' ? 'response.incomplete' : 'response.completed', response: payload });
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
    const results = body.messages.find(x => Array.isArray(x.content) && x.content.some(part => part.type === 'tool_result'));
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
    if (mode.startsWith('no_terminal_')) {
      const wire = protocol === 'chat_completions'
        ? frame('', { id: 'chatcmpl-cut', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: TEXT }, finish_reason: null }] })
        : protocol === 'responses' ? frame('response.created', { type: 'response.created', response: { id: 'resp_cut', model: body.model, status: 'in_progress', output: [] } })
          + frame('response.output_text.delta', { type: 'response.output_text.delta', delta: TEXT })
        : frame('message_start', { type: 'message_start', message: { id: 'msg_cut', model: body.model, content: [] } })
          + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
          + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } });
      return splitUnicode(res, wire, mode === 'no_terminal_abrupt');
    }
    if (mode === 'native_private_json' || mode === 'native_private_sse') {
      const payload = { id: 'msg-native-private', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'thinking', thinking: '推理🙂', signature: 'signed-state' },
          { type: 'redacted_thinking', data: 'redacted-state' }, { type: 'text', text: TEXT },
          { type: 'tool_use', id: 'call-native', name: 'alpha', input: { n: 1, city: '中文🙂' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: usage.messages, native_extension: { kept: true } };
      if (mode === 'native_private_json') return json(res, 200, payload);
      const wire = frame('message_start', { type: 'message_start', message: { ...payload, content: [], stop_reason: null, usage: { ...usage.messages, output_tokens: 0 } } })
        + frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
        + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理🙂' } })
        + frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-state' } })
        + frame('content_block_stop', { type: 'content_block_stop', index: 0 })
        + frame('content_block_start', { type: 'content_block_start', index: 1, content_block: payload.content[1] })
        + frame('content_block_stop', { type: 'content_block_stop', index: 1 })
        + frame('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } })
        + frame('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: TEXT } })
        + frame('content_block_stop', { type: 'content_block_stop', index: 2 })
        + frame('content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'call-native', name: 'alpha', input: {} } })
        + frame('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"n":1,' } })
        + frame('content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '"city":"中文🙂"}' } })
        + frame('content_block_stop', { type: 'content_block_stop', index: 3 })
        + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 2 } })
        + frame('message_stop', { type: 'message_stop' });
      return splitUnicode(res, wire);
    }
    if (mode === 'private' || mode === 'private_late') {
      const payload = responseJson(protocol, body.model, 'ok', serial);
      const block = protocol === 'responses' ? { id: 'rs-private', type: 'reasoning', encrypted_content: 'encrypted-state', summary: [] }
        : { type: 'thinking', thinking: 'private reasoning', signature: 'signed-state' };
      if (protocol === 'responses') payload.output.unshift(block); else payload.content.unshift(block);
      if (!body.stream) return json(res, 200, payload);
      const privateEvents = protocol === 'responses'
        ? frame('response.created', { type: 'response.created', response: { ...payload, output: [], status: 'in_progress' } })
          + frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: block })
          + frame('response.completed', { type: 'response.completed', response: payload })
        : frame('message_start', { type: 'message_start', message: { ...payload, content: [], stop_reason: null } })
          + (mode === 'private_late' ? frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TEXT } }) : '')
          + frame('content_block_start', { type: 'content_block_start', index: 1, content_block: block })
          + frame('content_block_stop', { type: 'content_block_stop', index: 1 })
          + frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage.messages }) + frame('message_stop', { type: 'message_stop' });
      return splitUnicode(res, privateEvents);
    }
    if (mode === 'matrix_json') return json(res, 200, matrixJson(protocol, body.model, serial));
    if (mode === 'matrix_sse') return splitUnicode(res, matrixStream(protocol, body.model, serial));
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
  for (const protocol of PROTOCOLS) for (const ending of ['clean', 'abrupt']) {
    const id = `cut-${protocol}-${ending}`;
    configs.push({ id, type: 'apikey', preset: 'custom', base_url: root + '/' + id, apikey: 'cut-upstream-fixture', models: [{ id, protocols: [protocol] }] });
    eofRoutes.push({ id, entry_protocols: [protocol], targets: [{ id: 'cut', config_id: id, model: id, protocol }, { id: 'backup', config_id: 'backup', model: 'backup', protocol: 'chat_completions' }] });
  }
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


// Nine entry/backend pairs x four wire paths. Each case observes the real HTTP
// body/headers, and compares client semantics to literal independent expectations.
function assertMatrixUsage(entryProtocol, backendProtocol, value) {
  assert.ok(value, 'usage must be present');
  if (entryProtocol === backendProtocol) return assert.deepEqual(value, usage[backendProtocol]);
  if (entryProtocol === 'messages') {
    assert.equal(value.input_tokens, 3); assert.equal(value.output_tokens, 2);
    assert.equal(value.cache_read_input_tokens, 4); assert.equal(value.cache_creation_input_tokens, 3);
  } else {
    const inputKey = entryProtocol === 'responses' ? 'input_tokens' : 'prompt_tokens';
    const outputKey = entryProtocol === 'responses' ? 'output_tokens' : 'completion_tokens';
    assert.equal(value[inputKey], 10); assert.equal(value[outputKey], 2); assert.equal(value.total_tokens, 12);
    assert.deepEqual(value[inputKey === 'input_tokens' ? 'input_tokens_details' : 'prompt_tokens_details'], { cached_tokens: 4, cache_write_tokens: 3 });
  }
}
function assertMatrixJson(protocol, value, route, backend) {
  assert.equal(value.model, route); assert.ok(value.id);
  if (protocol === 'chat_completions') {
    assert.equal(value.choices.length, 1); assert.equal(value.choices[0].message.role, 'assistant');
    assert.equal(value.choices[0].message.content, TEXT); assert.equal(value.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(value.choices[0].message.tool_calls.map(call => [call.id, call.function.name, call.function.arguments]), [
      ['call-alpha', 'alpha', '{"city":"中文🙂","n":1}'], ['call-beta', 'beta', '{"enabled":true,"n":2}'],
    ]);
  } else if (protocol === 'responses') {
    assert.equal(value.status, 'completed'); assert.deepEqual(value.output.map(item => item.type), ['message', 'function_call', 'function_call']);
    assert.deepEqual(value.output[0].content, [{ type: 'output_text', text: TEXT, annotations: [] }]);
    assert.deepEqual(value.output.slice(1).map(call => [call.call_id, call.name, call.arguments]), [
      ['call-alpha', 'alpha', '{"city":"中文🙂","n":1}'], ['call-beta', 'beta', '{"enabled":true,"n":2}'],
    ]);
  } else {
    assert.equal(value.role, 'assistant'); assert.equal(value.stop_reason, 'tool_use');
    if (backend === 'messages') assert.equal(value.stop_sequence, null);
    else assert.equal(Object.hasOwn(value, 'stop_sequence'), false, 'OpenAI did not report a matched stop sequence');
    assert.deepEqual(value.content, [{ type: 'text', text: TEXT },
      { type: 'tool_use', id: 'call-alpha', name: 'alpha', input: { city: '中文🙂', n: 1 } },
      { type: 'tool_use', id: 'call-beta', name: 'beta', input: { enabled: true, n: 2 } }]);
  }
  assertMatrixUsage(protocol, backend, value.usage);
}
function assertMatrixSse(protocol, wire, route, backend) {
  const parsed = events(wire); assert.ok(parsed.length); assert.doesNotMatch(wire, /�/);
  const ids = parsed.map(value => value.response?.id || value.message?.id || value.id).filter(Boolean);
  assert.equal(new Set(ids).size, 1, 'one response ID throughout the stream');
  assert.ok(ids.length); assert.ok(!parsed.some(value => value.error));
  let text = '', reportedUsage;
  if (protocol === 'chat_completions') {
    assert.equal(parsed[0].choices[0].delta.role, 'assistant');
    const callsByIndex = new Map();
    for (const value of parsed) {
      assert.equal(value.model, route);
      for (const choice of value.choices || []) {
        text += choice.delta?.content || '';
        for (const call of choice.delta?.tool_calls || []) {
          const previous = callsByIndex.get(call.index) || { id: '', name: '', arguments: '' };
          previous.id += call.id || ''; previous.name += call.function?.name || ''; previous.arguments += call.function?.arguments || '';
          callsByIndex.set(call.index, previous);
        }
      }
      if (value.usage) reportedUsage = value.usage;
    }
    assert.deepEqual([...callsByIndex.values()], [
      { id: 'call-alpha', name: 'alpha', arguments: '{"city":"中文🙂","n":1}' },
      { id: 'call-beta', name: 'beta', arguments: '{"enabled":true,"n":2}' },
    ]);
    assert.deepEqual(parsed.flatMap(value => value.choices || []).map(choice => choice.finish_reason).filter(Boolean), ['tool_calls']);
    assert.match(wire, /data: \[DONE\]\n\n$/);
  } else if (protocol === 'responses') {
    assert.equal(parsed[0].type, 'response.created'); assert.equal(parsed.at(-1).type, 'response.completed');
    text = parsed.filter(value => value.type === 'response.output_text.delta').map(value => value.delta).join('');
    for (const callId of ['call-alpha', 'call-beta']) {
      const start = parsed.findIndex(value => value.type === 'response.output_item.added' && value.item?.call_id === callId);
      assert.ok(start >= 0); const itemId = parsed[start].item.id;
      const delta = parsed.findIndex(value => value.type === 'response.function_call_arguments.delta' && value.item_id === itemId);
      const done = parsed.findIndex(value => value.type === 'response.output_item.done' && value.item?.id === itemId);
      assert.equal(parsed.filter(value => value.type === 'response.output_item.done' && value.item?.id === itemId).length, 1, callId + ' ends exactly once');
      assert.ok(start < delta && delta < done && done < parsed.length - 1, callId + ' event order');
    }
    assertMatrixJson(protocol, parsed.at(-1).response, route, backend);
    reportedUsage = parsed.at(-1).response.usage;
  } else {
    assert.equal(parsed[0].type, 'message_start'); assert.equal(parsed[0].message.model, route); assert.equal(parsed.at(-1).type, 'message_stop');
    const toolBlocks = [];
    for (const [position, value] of parsed.entries()) {
      if (value.type === 'content_block_delta' && value.delta.type === 'text_delta') text += value.delta.text;
      if (value.type === 'content_block_start' && value.content_block.type === 'tool_use') {
        const deltas = parsed.filter(x => x.type === 'content_block_delta' && x.index === value.index);
        const stop = parsed.findIndex(x => x.type === 'content_block_stop' && x.index === value.index);
        assert.equal(parsed.filter(x => x.type === 'content_block_stop' && x.index === value.index).length, 1, 'each tool block ends exactly once');
        assert.ok(stop > position && stop < parsed.length - 2);
        assert.ok(deltas.every(x => parsed.indexOf(x) > position && parsed.indexOf(x) < stop));
        toolBlocks.push([value.content_block.id, value.content_block.name, JSON.parse(deltas.map(x => x.delta.partial_json).join(''))]);
      }
    }
    assert.deepEqual(toolBlocks, [['call-alpha', 'alpha', { city: '中文🙂', n: 1 }], ['call-beta', 'beta', { enabled: true, n: 2 }]]);
    assert.equal(parsed.at(-2).type, 'message_delta'); assert.equal(parsed.at(-2).delta.stop_reason, 'tool_use');
    reportedUsage = { ...parsed[0].message.usage, ...parsed.at(-2).usage };
  }
  assert.equal(text, TEXT); assertMatrixUsage(protocol, backend, reportedUsage);
}
for (const entryProtocol of PROTOCOLS) for (const backendProtocol of PROTOCOLS) {
  for (const upstreamSse of [false, true]) for (const clientSse of [false, true]) {
    test(`wire matrix ${entryProtocol} <- ${backendProtocol}: ${upstreamSse ? 'SSE' : 'JSON'} -> ${clientSse ? 'SSE' : 'JSON'}`, async () => {
      const route = nativeRoute(backendProtocol), mode = upstreamSse ? 'matrix_sse' : 'matrix_json';
      const body = toolHistory(entryProtocol, route); body.stream = clientSse;
      const messages = entryProtocol === 'responses' ? body.input : body.messages;
      messages[0].content = `MODE:${mode}`;
      const before = calls.length; const response = await entry(entryProtocol, body);
      const wire = await response.text(); assert.equal(response.status, 200, wire);
      assert.match(response.headers.get('content-type'), clientSse ? /text\/event-stream/ : /application\/json/);
      if (clientSse) { assert.equal(response.headers.get('cache-control'), 'no-cache'); assert.equal(response.headers.get('x-accel-buffering'), 'no'); }
      assert.equal(calls.length, before + 1, 'no hidden fallback');
      assert.equal(calls.at(-1).protocol, backendProtocol); assert.equal(calls.at(-1).body.model, 'backend-' + backendProtocol);
      assertToolHistory(backendProtocol, calls.at(-1).body);
      assert.equal(calls.at(-1).body.stream, clientSse);
      if (clientSse) assertMatrixSse(entryProtocol, wire, route, backendProtocol);
      else assertMatrixJson(entryProtocol, JSON.parse(wire), route, backendProtocol);
    });
  }
}


for (const backend of ['messages', 'responses']) {
  test(`opaque ${backend} state preserves native wires and rejects cross conversion without fallback or cooldown`, async () => {
    for (const stream of [false, true]) {
      const native = input(backend, nativeRoute(backend), 'private', stream);
      const before = calls.length; const response = await entry(backend, native); const wire = await response.text();
      assert.equal(response.status, 200); assert.equal(calls.length, before + 1);
      assert.match(wire, backend === 'messages' ? /signed-state/ : /encrypted-state/);
      for (const client of PROTOCOLS.filter(value => value !== backend)) {
        const body = input(client, nativeRoute(backend), 'private', stream); delete body.store;
        const before = calls.length; const rejected = await entry(client, body); const payload = await rejected.json();
        assert.equal(rejected.status, 502, JSON.stringify(payload)); assert.equal(calls.length, before + 1, 'no retry to bypass unsupported state');
        assert.equal(payload.error.code || payload.error.type, 'upstream_response_not_representable');
        assert.match(payload.error.message, /reasoning|thinking|signature|推理|思考|内容块/);
        assert.equal(calls.at(-1).protocol, backend);
      }
      const healthy = await entry(backend, native); assert.equal(healthy.status, 200, 'gateway conversion rejection must not cool native support'); await healthy.text();
      assert.equal(calls.at(-1).protocol, backend);
    }
  });
}
test('unsupported private state discovered after text emits an error and never replays or completes', async () => {
  const before = calls.length;
  const response = await entry('chat_completions', input('chat_completions', nativeRoute('messages'), 'private_late', true));
  assert.equal(response.status, 200); const received = await streamText(response);
  assert.match(received.text, /中文/); assert.match(received.text, /thinking|signature|内容块/);
  assert.ok(!events(received.text).some(value => value.choices?.some(choice => choice.finish_reason === 'stop')));
  assert.equal(calls.length, before + 1); await assertServiceAlive();
});

test('native Messages forced SSE aggregates private blocks, raw usage and extra message fields into JSON', async () => {
  const before = calls.length;
  const response = await entry('messages', input('messages', nativeRoute('messages'), 'native_private_sse', false));
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload)); assert.equal(calls.length, before + 1);
  assert.match(response.headers.get('content-type'), /application\/json/);
  assert.deepEqual(payload, { id: 'msg-native-private', type: 'message', role: 'assistant', model: nativeRoute('messages'),
    content: [{ type: 'thinking', thinking: '推理🙂', signature: 'signed-state' },
      { type: 'redacted_thinking', data: 'redacted-state' }, { type: 'text', text: TEXT },
      { type: 'tool_use', id: 'call-native', name: 'alpha', input: { n: 1, city: '中文🙂' } }],
    stop_reason: 'tool_use', stop_sequence: null, usage: usage.messages, native_extension: { kept: true } });
});

test('native Messages forced JSON synthesizes private SSE blocks without dropping signatures or raw usage', async () => {
  const before = calls.length;
  const response = await entry('messages', input('messages', nativeRoute('messages'), 'native_private_json', true));
  const wire = await response.text();
  assert.equal(response.status, 200, wire); assert.equal(calls.length, before + 1);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const parsed = events(wire);
  assert.equal(parsed[0].type, 'message_start'); assert.equal(parsed[0].message.id, 'msg-native-private');
  assert.equal(parsed[0].message.model, nativeRoute('messages')); assert.deepEqual(parsed[0].message.native_extension, { kept: true });
  assert.deepEqual(parsed.filter(value => value.type === 'content_block_start').map(value => value.content_block.type), ['thinking', 'redacted_thinking', 'text', 'tool_use']);
  assert.equal(parsed.filter(value => value.delta?.type === 'thinking_delta').map(value => value.delta.thinking).join(''), '推理🙂');
  assert.equal(parsed.filter(value => value.delta?.type === 'signature_delta').map(value => value.delta.signature).join(''), 'signed-state');
  assert.deepEqual(parsed.find(value => value.content_block?.type === 'redacted_thinking').content_block, { type: 'redacted_thinking', data: 'redacted-state' });
  assert.equal(parsed.filter(value => value.delta?.type === 'text_delta').map(value => value.delta.text).join(''), TEXT);
  assert.deepEqual(JSON.parse(parsed.filter(value => value.delta?.type === 'input_json_delta').map(value => value.delta.partial_json).join('')), { n: 1, city: '中文🙂' });
  for (const index of [0, 1, 2, 3]) assert.equal(parsed.filter(value => value.type === 'content_block_stop' && value.index === index).length, 1);
  assert.equal(parsed.at(-2).type, 'message_delta'); assert.deepEqual(parsed.at(-2).delta, { stop_reason: 'tool_use', stop_sequence: null });
  assert.deepEqual({ ...parsed[0].message.usage, ...parsed.at(-2).usage }, usage.messages);
  assert.equal(parsed.at(-1).type, 'message_stop'); assert.ok(!parsed.some(value => value.error));
});

for (const client of PROTOCOLS) for (const backend of PROTOCOLS) {
  if (client === backend) continue;
  test(`terminal matrix ${client} <- ${backend}: refusal and truncation JSON/SSE keep meaning and one attempt`, async () => {
    for (const mode of ['refusal', 'truncated']) for (const stream of [false, true]) {
      const body = input(client, nativeRoute(backend), mode, stream); delete body.store;
      const before = calls.length; const response = await entry(client, body); const wire = await response.text();
      assert.equal(response.status, 200, wire); assert.equal(calls.length, before + 1);
      const parsed = stream ? events(wire) : null;
      const payload = !stream ? JSON.parse(wire) : client === 'responses' ? parsed.at(-1).response : null;
      if (client === 'responses') {
        assert.equal(payload.status, mode === 'refusal' ? 'completed' : 'incomplete');
        if (mode === 'refusal') assert.ok(payload.output.some(item => item.content?.some(part => part.type === 'refusal' && part.refusal === REFUSAL)));
        else { assert.deepEqual(payload.incomplete_details, { reason: 'max_output_tokens' }); assert.equal(payload.output[0].content[0].text, TEXT); }
      } else if (client === 'chat_completions') {
        const choices = stream ? parsed.flatMap(x => x.choices || []) : payload.choices;
        assert.deepEqual(choices.map(x => x.finish_reason).filter(Boolean), [mode === 'refusal' ? 'content_filter' : 'length']);
        const refusal = stream ? choices.map(x => x.delta?.refusal || '').join('') : choices[0].message.refusal;
        if (mode === 'refusal') assert.equal(refusal, REFUSAL);
        else assert.equal(stream ? choices.map(x => x.delta?.content || '').join('') : choices[0].message.content, TEXT);
      } else {
        const terminal = stream ? parsed.find(x => x.type === 'message_delta').delta : payload;
        assert.equal(terminal.stop_reason, mode === 'refusal' ? 'refusal' : 'max_tokens');
        const text = stream ? parsed.filter(x => x.type === 'content_block_delta' && x.delta.type === 'text_delta').map(x => x.delta.text).join('') : payload.content.map(x => x.text).join('');
        assert.equal(text, mode === 'refusal' ? REFUSAL : TEXT);
      }
    }
  });
}


for (const protocol of PROTOCOLS) for (const ending of ['clean', 'abrupt']) {
  test(`native ${protocol} missing terminal (${ending}) preserves text and explicitly fails without replay`, async () => {
    const before = calls.length;
    const response = await entry(protocol, input(protocol, `cut-${protocol}-${ending}`, `no_terminal_${ending}`, true));
    assert.equal(response.status, 200); const received = await streamText(response);
    assert.match(received.text, /中文🙂𠮷/); assert.doesNotMatch(received.text, /�/);
    assert.ok(received.interrupted || events(received.text).some(value => value.error?.code === 'upstream_stream_error' || value.error?.code === 'incomplete_upstream_stream'), 'must signal error or transport interruption, not a clean empty-success EOF');
    assert.ok(!events(received.text).some(value => value.type === 'response.completed' || value.type === 'message_stop' || value.choices?.some(choice => choice.finish_reason)));
    assert.doesNotMatch(received.text, /data: \[DONE\]/); assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1).protocol, protocol); await assertServiceAlive();
  });
}
