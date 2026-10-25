const test = require('node:test');
const assert = require('node:assert/strict');
const { createSseEventParser, createSameProtocolSseRewriter, createProtocolStreamBridge, transformResponseForEntry, parseTargetResponse } = require('../app/protocol-bridge');
const transform = (targetProtocol, entryProtocol, payload) => transformResponseForEntry({ targetProtocol, entryProtocol, payload, publicModel: 'public' });
const chat = (id, extra = {}) => ({ id, model: 'backend', choices: [{ message: { role: 'assistant', content: '中文😀' }, finish_reason: 'stop' }], ...extra });

test('SSE incrementally decodes every UTF-8 byte split and same-protocol rewrite preserves Chinese and emoji', () => {
  for (const protocol of ['chat_completions', 'responses', 'messages']) {
    const payload = { model: 'backend', text: '中文😀𠮷é', nested: { text: '你好' } };
    const bytes = Buffer.from(`event: delta\ndata: ${JSON.stringify(payload)}\n\n`);
    for (let split = 1; split < bytes.length; split++) {
      const parser = createSseEventParser();
      const events = [...parser.push(bytes.subarray(0, split)), ...parser.push(bytes.subarray(split)), ...parser.finish()];
      assert.equal(events.length, 1);
      const rewritten = createSameProtocolSseRewriter(protocol, 'public').accept(events[0].event, events[0].data)[0].data;
      assert.equal(rewritten.text, payload.text, `${protocol}, split ${split}`);
      assert.equal(rewritten.nested.text, '你好');
    }
  }
});
test('SSE finish flushes incremental decoder and a final event without a delimiter', () => {
  const parser = createSseEventParser();
  const bytes = Buffer.from('data: {"text":"文😀"}');
  for (const byte of bytes) assert.deepEqual(parser.push(Buffer.from([byte])), []);
  assert.equal(parser.finish()[0].data.text, '文😀');
  assert.deepEqual(parser.finish(), []);
});
test('different upstream response IDs remain distinct across target protocols and one stream stays stable', () => {
  for (const entry of ['responses', 'messages']) {
    const a = transform('chat_completions', entry, chat('chatcmpl-abc'));
    const b = transform('chat_completions', entry, chat('chatcmpl-def'));
    assert.notEqual(a.id, b.id);
    const bridge = createProtocolStreamBridge({ entryProtocol: entry, targetProtocol: 'chat_completions', publicModel: 'public' });
    const events = [...bridge.accept('', { id: 'chatcmpl-abc', choices: [{ delta: { content: 'hi' } }] }), ...bridge.accept('', { id: 'chatcmpl-abc', choices: [{ delta: {}, finish_reason: 'stop' }] }), ...bridge.finish()];
    const ids = events.map(x => x.data?.response?.id || x.data?.message?.id).filter(Boolean);
    assert.ok(ids.length); assert.equal(new Set(ids).size, 1);
    assert.equal(ids[0], a.id);
  }
});
test('Chat refusal JSON converts to actual Responses refusal and Claude refusal terminal, never empty success', () => {
  const payload = chat('chatcmpl-refusal', { choices: [{ message: { role: 'assistant', content: null, refusal: '无法协助。' }, finish_reason: 'stop' }] });
  const result = transform('chat_completions', 'responses', payload);
  assert.deepEqual(result.output[0].content, [{ type: 'refusal', refusal: '无法协助。' }]);
  const message = transform('chat_completions', 'messages', payload);
  assert.equal(message.stop_reason, 'refusal');
  assert.equal(message.content[0].text, '无法协助。');
});
test('Chat refusal SSE retains refusal deltas and terminal content', () => {
  const bridge = createProtocolStreamBridge({ entryProtocol: 'responses', targetProtocol: 'chat_completions', publicModel: 'public' });
  const events = [...bridge.accept('', { id: 'chatcmpl-r', choices: [{ delta: { refusal: '不能' } }] }), ...bridge.accept('', { id: 'chatcmpl-r', choices: [{ delta: { refusal: '协助' }, finish_reason: 'stop' }] }), ...bridge.finish()];
  assert.equal(events.filter(x => x.event === 'response.refusal.delta').map(x => x.data.delta).join(''), '不能协助');
  assert.equal(events.find(x => x.event === 'response.completed').data.response.output[0].content[0].refusal, '不能协助');
  assert.equal(bridge.getCanonicalResponse().stopReason, 'refusal');
});
test('SSE truncation is incomplete and missing terminal never fabricates completed', () => {
  const bridge = createProtocolStreamBridge({ entryProtocol: 'responses', targetProtocol: 'chat_completions', publicModel: 'public' });
  const events = [...bridge.accept('', { id: 'chatcmpl-l', choices: [{ delta: { content: '部分' }, finish_reason: 'length' }] }), ...bridge.finish()];
  const terminal = events.find(x => x.event === 'response.incomplete');
  assert.equal(terminal.data.response.status, 'incomplete');
  assert.equal(terminal.data.response.incomplete_details.reason, 'max_output_tokens');
  const cut = createProtocolStreamBridge({ entryProtocol: 'responses', targetProtocol: 'messages', publicModel: 'public' });
  cut.accept('message_start', { type: 'message_start', message: { id: 'msg-cut' } });
  cut.accept('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } });
  assert.equal(cut.isComplete(), false);
  const missing = cut.finish();
  assert.ok(missing.some(x => x.data?.error));
  assert.ok(!missing.some(x => x.event === 'response.completed'));
});
test('Responses refusal/content filter and failed JSON preserve terminal meaning', () => {
  const refusal = { id: 'resp-r', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'refused' }] }] };
  const converted = transform('responses', 'chat_completions', refusal);
  assert.equal(converted.choices[0].message.refusal, 'refused');
  assert.equal(converted.choices[0].finish_reason, 'content_filter');
  const filtered = transform('responses', 'chat_completions', { id: 'resp-filter', status: 'incomplete', output: [], incomplete_details: { reason: 'content_filter' } });
  assert.equal(filtered.choices[0].finish_reason, 'content_filter');
  assert.throws(() => parseTargetResponse('responses', { id: 'resp-fail', status: 'failed', error: { code: 'server_error', message: 'failed' }, output: [] }), /failed/);
});
test('cached read/write usage maps without double counting and absent cache counters stay absent', () => {
  const claude = { id: 'msg-cache', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 } };
  const response = transform('messages', 'responses', claude);
  assert.equal(response.usage.input_tokens, 60); assert.equal(response.usage.total_tokens, 65);
  assert.deepEqual(response.usage.input_tokens_details, { cached_tokens: 20, cache_write_tokens: 30 });
  const back = transform('responses', 'messages', response);
  assert.equal(back.usage.input_tokens, 10); assert.equal(back.usage.cache_read_input_tokens, 20); assert.equal(back.usage.cache_creation_input_tokens, 30);
  const absent = transform('chat_completions', 'responses', chat('chatcmpl-unknown'));
  assert.equal(absent.usage, undefined);
  const partial = transform('chat_completions', 'responses', chat('chatcmpl-partial', { usage: { completion_tokens: 7 } }));
  assert.deepEqual(partial.usage, { output_tokens: 7 });
});
test('same protocol JSON and SSE preserve all source cache usage details', () => {
  const source = chat('chatcmpl-same', { usage: { prompt_tokens: 120, completion_tokens: 4, total_tokens: 124, prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 7 }, completion_tokens_details: { reasoning_tokens: 2 } } });
  assert.deepEqual(transform('chat_completions', 'chat_completions', source).usage, source.usage);
  assert.deepEqual(createSameProtocolSseRewriter('chat_completions', 'public').accept('', source)[0].data.usage, source.usage);
});

test('content filtering without refusal text remains an explicit incomplete terminal', () => {
  const payload = chat('chatcmpl-filter', { choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }] });
  const result = transform('chat_completions', 'responses', payload);
  assert.equal(result.status, 'incomplete'); assert.equal(result.incomplete_details.reason, 'content_filter');
  const bridge = createProtocolStreamBridge({ entryProtocol: 'responses', targetProtocol: 'chat_completions', publicModel: 'public' });
  const events = [...bridge.accept('', { id: 'chatcmpl-filter', choices: [{ delta: {}, finish_reason: 'content_filter' }] }), ...bridge.finish()];
  assert.equal(events.find(x => x.event === 'response.incomplete').data.response.incomplete_details.reason, 'content_filter');
  assert.ok(!events.some(x => x.event === 'response.completed'));
});
test('Claude late streaming refusal adds an explicit terminal refusal without retracting already emitted text', () => {
  const bridge = createProtocolStreamBridge({ entryProtocol: 'responses', targetProtocol: 'messages', publicModel: 'public' });
  const events = [
    ...bridge.accept('message_start', { type: 'message_start', message: { id: 'msg-refused' } }),
    ...bridge.accept('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: '不能提供该帮助。' } }),
    ...bridge.accept('message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal' } }),
    ...bridge.accept('message_stop', { type: 'message_stop' }), ...bridge.finish(),
  ];
  assert.ok(events.some(x => x.event === 'response.output_text.delta'));
  const final = events.find(x => x.event === 'response.completed').data.response;
  assert.ok(final.output.some(item => item.content?.some(block => block.type === 'refusal' && block.refusal === '不能提供该帮助。')));
  assert.deepEqual(bridge.getCanonicalResponse().parts, [{ type: 'refusal', text: '不能提供该帮助。' }]);
});
test('Claude cache TTL breakdown is explicitly attributed and native stream usage remains raw', () => {
  const usage = { input_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 4 }, output_tokens: 7 };
  const result = transform('messages', 'responses', { id: 'msg-cache-detail', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage });
  assert.equal(result.usage.input_tokens, 10); assert.equal(result.usage.total_tokens, 17);
  assert.deepEqual(result.usage.airouter_upstream_usage, { protocol: 'messages', cache_creation: usage.cache_creation });
  const bridge = createProtocolStreamBridge({ entryProtocol: 'messages', targetProtocol: 'messages', publicModel: 'public' });
  bridge.accept('message_start', { type: 'message_start', message: { id: 'msg-cache-detail', usage: { ...usage, output_tokens: 0 } } });
  bridge.accept('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } });
  const canonical = bridge.getCanonicalResponse();
  const { serializeCanonicalResponse } = require('../app/protocol-bridge');
  assert.deepEqual(serializeCanonicalResponse('messages', canonical, 'public').usage, usage);
});
test('unknown cache buckets never become fabricated zero when input bases differ', () => {
  const message = transform('responses', 'messages', { id: 'resp-unknown-cache', output: [], status: 'completed', usage: { input_tokens: 100, output_tokens: 2, input_tokens_details: { cached_tokens: 30 } } });
  assert.equal(message.usage.input_tokens, undefined); assert.equal(message.usage.cache_read_input_tokens, 30); assert.equal(message.usage.cache_creation_input_tokens, undefined);
  assert.deepEqual(message.usage.airouter_upstream_usage, { protocol: 'responses', input_tokens: 100 });
  const response = transform('messages', 'responses', { id: 'msg-unknown-cache', content: [], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 } });
  assert.equal(response.usage.input_tokens, undefined); assert.equal(response.usage.total_tokens, undefined);
  assert.deepEqual(response.usage.airouter_upstream_usage, { protocol: 'messages', input_tokens: 4 });
});
test('unsupported incomplete/async terminals cannot become completed cross-protocol answers', () => {
  for (const reason of ['steered', 'max_messages', 'unknown']) assert.throws(() => transform('responses', 'chat_completions', { id: 'resp-unknown', status: 'incomplete', incomplete_details: { reason }, output: [] }), /无法准确映射/);
  assert.throws(() => transform('messages', 'responses', { id: 'msg-paused', content: [], stop_reason: 'pause_turn' }), /pause_turn/);
  for (const status of ['queued', 'in_progress']) assert.throws(() => transform('responses', 'chat_completions', { id: 'resp-async', status, output: [] }), /尚未完成/);
});
test('parallel streamed tool argument strings survive Responses completion-only output and Chat roundtrip', () => {
  const bridge = createProtocolStreamBridge({ entryProtocol: 'chat_completions', targetProtocol: 'responses', publicModel: 'public' });
  const calls = [{ type: 'function_call', id: 'fc-a', call_id: 'call-a', name: 'a', arguments: '{"n":9007199254740993}' }, { type: 'function_call', id: 'fc-b', call_id: 'call-b', name: 'b', arguments: '{"x":2}' }];
  const events = bridge.accept('response.completed', { type: 'response.completed', response: { id: 'resp-tools', status: 'completed', output: calls } });
  assert.equal(bridge.getCanonicalResponse().parts.length, 2);
  const args = events.filter(x => x.data?.choices?.[0]?.delta?.tool_calls).flatMap(x => x.data.choices[0].delta.tool_calls).map(x => x.function.arguments).filter(Boolean);
  assert.deepEqual(args, calls.map(x => x.arguments));
});

test('tool argument conversion never silently repairs malformed JSON or loses numeric precision', () => {
  for (const argumentsText of ['{bad', '[]', '{"n":9007199254740993}', '{"n":0.100000000000000005}']) {
    const payload = chat('chatcmpl-bad-args', { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call', function: { name: 'f', arguments: argumentsText } }] }, finish_reason: 'tool_calls' }] });
    assert.equal(transform('chat_completions', 'responses', payload).output[0].arguments, argumentsText);
    assert.throws(() => transform('chat_completions', 'messages', payload), /JSON|无损/);
  }
});
test('length remains truncation even when partial tool calls are present', () => {
  const result = transform('responses', 'chat_completions', { id: 'resp-incomplete-tool', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', id: 'fc', call_id: 'call', name: 'f', arguments: '{"unfinished":' }] });
  assert.equal(result.choices[0].finish_reason, 'length'); assert.equal(result.choices[0].message.tool_calls[0].function.arguments, '{"unfinished":');
});
test('UTF-8 decoder flush exposes an invalid final byte instead of losing it silently', () => {
  const parser = createSseEventParser();
  parser.push(Buffer.concat([Buffer.from('data: '), Buffer.from([0xe4])]));
  const event = parser.finish()[0];
  assert.equal(event.dataText, '�'); assert.equal(event.data, null);
});

test('native Messages pause_turn is retained but cross-protocol cannot pretend the turn completed', () => {
  for (const entry of ['messages', 'responses', 'chat_completions']) {
    const bridge = createProtocolStreamBridge({ entryProtocol: entry, targetProtocol: 'messages', publicModel: 'public' });
    const events = [...bridge.accept('message_start', { type: 'message_start', message: { id: 'msg-paused' } }), ...bridge.accept('message_delta', { type: 'message_delta', delta: { stop_reason: 'pause_turn' } }), ...bridge.accept('message_stop', { type: 'message_stop' }), ...bridge.finish()];
    if (entry === 'messages') assert.equal(events.find(x => x.event === 'message_delta').data.delta.stop_reason, 'pause_turn');
    else { assert.ok(events.some(x => x.data?.error)); assert.ok(!events.some(x => x.event === 'response.completed')); }
  }
});

test('context-window exhaustion cannot be relabeled as an output-token limit', () => {
  const payload = { id: 'msg-context-full', content: [{ type: 'text', text: 'partial' }], stop_reason: 'model_context_window_exceeded' };
  assert.equal(transform('messages', 'chat_completions', payload).choices[0].finish_reason, 'length');
  assert.throws(() => transform('messages', 'responses', payload), /model_context_window_exceeded/);
});

test('SSE event fields are scoped to one frame and never inherited by subsequent data-only frames', () => {
  const parser = createSseEventParser();
  const first = parser.push(Buffer.from('event: response.created\ndata: {"type":"response.created","response":{"id":"resp-mixed"}}\n\n'));
  const second = parser.push(Buffer.from('data: {"type":"response.output_text.delta","delta":"中文"}\n\n'));
  const last = [...parser.push(Buffer.from('event: response.completed\ndata: {"type":"response.completed"}\n\n')), ...parser.push(Buffer.from('data: {"type":"trailer"}')), ...parser.finish()];
  assert.equal(first[0].event, 'response.created');
  assert.equal(second[0].event, '');
  const rewritten = createSameProtocolSseRewriter('responses', 'public').accept(second[0].event, second[0].data);
  assert.equal(rewritten[0].event, null);
  assert.equal(rewritten[0].data.type, 'response.output_text.delta');
  assert.equal(last[0].event, 'response.completed');
  assert.equal(last[1].event, '');
});

test('cross-protocol IDs encode the entire source ID even when it looks like a native target ID', () => {
  for (const entry of ['responses', 'messages', 'chat_completions']) {
    const target = entry === 'chat_completions' ? 'responses' : 'chat_completions';
    const sourcePayload = id => target === 'responses'
      ? { id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }
      : chat(id);
    const one = transform(target, entry, sourcePayload('a/b'));
    const two = transform(target, entry, sourcePayload(one.id));
    assert.notEqual(one.id, two.id, `${target} -> ${entry}`);
    assert.match(one.id, /airouter/);
    assert.equal(transform(target, target, sourcePayload('a/b')).id, 'a/b');
  }
});

test('native IDs survive SSE aggregation and bridged JSON/SSE use the same collision-safe ID', () => {
  const { responseToEntrySse, serializeCanonicalResponse } = require('../app/protocol-bridge');
  for (const [target, entry] of [['chat_completions', 'responses'], ['chat_completions', 'messages'], ['responses', 'chat_completions'], ['responses', 'responses'], ['messages', 'messages']]) {
    const bridge = createProtocolStreamBridge({ entryProtocol: entry, targetProtocol: target, publicModel: 'public' });
    let events;
    if (target === 'chat_completions') events = [...bridge.accept('', { id: 'resp_612f62', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }), ...bridge.finish()];
    else if (target === 'responses') events = [...bridge.accept('response.created', { type: 'response.created', response: { id: 'resp_612f62' } }), ...bridge.accept('response.output_text.delta', { type: 'response.output_text.delta', delta: 'ok' }), ...bridge.accept('response.completed', { type: 'response.completed', response: { id: 'resp_612f62', status: 'completed', output: [] } }), ...bridge.finish()];
    else events = [...bridge.accept('message_start', { type: 'message_start', message: { id: 'msg_612f62' } }), ...bridge.accept('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }), ...bridge.accept('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }), ...bridge.accept('message_stop', { type: 'message_stop' }), ...bridge.finish()];
    const canonical = bridge.getCanonicalResponse();
    const json = serializeCanonicalResponse(entry, canonical, 'public');
    const streamedIds = events.map(x => x.data?.response?.id || x.data?.message?.id || (x.data?.object === 'chat.completion.chunk' ? x.data.id : null)).filter(Boolean);
    assert.ok(streamedIds.length); assert.deepEqual([...new Set(streamedIds)], [json.id], `${target} -> ${entry}`);
    const renderedIds = responseToEntrySse(entry, canonical, 'public').map(x => x.data?.response?.id || x.data?.message?.id || (x.data?.object === 'chat.completion.chunk' ? x.data.id : null)).filter(Boolean);
    assert.deepEqual([...new Set(renderedIds)], [json.id]);
    if (entry === target) assert.equal(json.id, canonical.id);
  }
});

test('native Messages aggregation retains the actual matched stop sequence without guessing one for OpenAI sources', () => {
  const { serializeCanonicalResponse, responseToEntrySse } = require('../app/protocol-bridge');
  const payload = { id: 'msg-stopped', content: [{ type: 'text', text: 'answer' }], stop_reason: 'stop_sequence', stop_sequence: '\nEND\n' };
  const parsed = parseTargetResponse('messages', payload);
  assert.equal(serializeCanonicalResponse('messages', parsed, 'public').stop_sequence, '\nEND\n');
  const asSse = responseToEntrySse('messages', parsed, 'public');
  assert.equal(asSse.find(x => x.event === 'message_delta').data.delta.stop_sequence, '\nEND\n');
  const bridge = createProtocolStreamBridge({ entryProtocol: 'messages', targetProtocol: 'messages', publicModel: 'public' });
  bridge.accept('message_start', { type: 'message_start', message: { id: 'msg-stopped' } });
  bridge.accept('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } });
  const events = bridge.accept('message_delta', { type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: '\nEND\n' } });
  bridge.accept('message_stop', { type: 'message_stop' });
  assert.equal(events.find(x => x.event === 'message_delta').data.delta.stop_sequence, '\nEND\n');
  assert.equal(serializeCanonicalResponse('messages', bridge.getCanonicalResponse(), 'public').stop_sequence, '\nEND\n');
  const openai = transform('chat_completions', 'messages', chat('chatcmpl-stopped'));
  assert.equal(openai.stop_sequence, undefined);
});
