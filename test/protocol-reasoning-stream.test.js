const test = require('node:test');
const assert = require('node:assert/strict');
const { createProtocolStreamBridge, responseToEntrySse } = require('../app/protocol-bridge');
const TEXT = '先想中文🙂';
const bridge = (source, entry, transport) => createProtocolStreamBridge({ targetProtocol: source, entryProtocol: entry, publicModel: 'public', reasoningTransport: transport });
const feed = (value, frames) => frames.flatMap(([event, data]) => value.accept(event, data));
const chatFrames = [
  ['', { id: 'chat-think', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先想中文' }, finish_reason: null }] }],
  ['', { id: 'chat-think', choices: [{ index: 0, delta: { reasoning_content: '🙂' }, finish_reason: null }] }],
  ['', { id: 'chat-think', choices: [{ index: 0, delta: { content: '答案2' }, finish_reason: null }] }],
  ['', { id: 'chat-think', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }],
];
for (const entry of ['responses', 'messages']) test(`Chat streamed reasoning reaches ${entry} separately from the final answer`, () => {
  const value = bridge('chat_completions', entry);
  const events = [...feed(value, chatFrames), ...value.finish()];
  assert.ok(!events.some(x => x.data?.error));
  assert.deepEqual(value.getCanonicalResponse().parts.map(x => x.type), ['reasoning', 'text']);
  assert.equal(value.getCanonicalResponse().parts[0].text, TEXT);
  assert.equal(value.getCanonicalResponse().parts[1].text, '答案2');
  if (entry === 'responses') {
    assert.equal(events.filter(x => x.event === 'response.reasoning_text.delta').map(x => x.data.delta).join(''), TEXT);
    assert.equal(events.filter(x => x.event === 'response.output_text.delta').map(x => x.data.delta).join(''), '答案2');
    const final = events.find(x => x.event === 'response.completed').data.response;
    assert.deepEqual(final.output.map(x => x.type), ['reasoning', 'message']);
    assert.deepEqual(final.output[0].content, [{ type: 'reasoning_text', text: TEXT }]);
    assert.equal(events.filter(x => x.event === 'response.reasoning_text.done').length, 1);
  } else {
    assert.equal(events.filter(x => x.data?.delta?.type === 'thinking_delta').map(x => x.data.delta.thinking).join(''), TEXT);
    const signature = events.find(x => x.data?.delta?.type === 'signature_delta').data.delta.signature;
    assert.match(signature, /^airouter-text-v1:/);
    const stopPositions = events.flatMap((x, i) => x.event === 'content_block_stop' ? [i] : []);
    assert.equal(stopPositions.length, 2);
    assert.ok(stopPositions[0] < events.findIndex(x => x.data?.content_block?.type === 'text'));
  }
});

test('Responses encrypted reasoning uses the complete item at done, never the provisional cipher', () => {
  const issued = [];
  const value = bridge('responses', 'chat_completions', { issue(part, view) { issued.push({ part, view }); return 'airouter-state-v1:fixture'; } });
  const start = feed(value, [
    ['response.created', { type: 'response.created', response: { id: 'resp-cipher', status: 'in_progress', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'rs-cipher', type: 'reasoning', summary: [], encrypted_content: 'partial-cipher' } }],
  ]);
  assert.equal(issued.length, 0); assert.ok(!start.some(x => x.data?.choices?.[0]?.delta?.reasoning_details));
  const item = { id: 'rs-cipher', type: 'reasoning', summary: [], encrypted_content: 'complete-cipher' };
  const final = [...feed(value, [
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.output_text.delta', { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: '2' }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp-cipher', status: 'completed', output: [item, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '2' }] }] } }],
  ]), ...value.finish()];
  assert.equal(issued.length, 1); assert.equal(issued[0].part.originBlock.encrypted_content, 'complete-cipher');
  const details = final.flatMap(x => x.data?.choices || []).flatMap(x => x.delta?.reasoning_details || []);
  assert.equal(details.length, 1); assert.equal(details[0].data, 'airouter-state-v1:fixture');
  assert.equal(value.getCanonicalResponse().parts[0].originBlock.encrypted_content, 'complete-cipher');
});

test('Claude summary and late signature keep order around tools and never become full reasoning text', () => {
  const issued = [];
  const value = bridge('messages', 'responses', { issue(part) { issued.push(part); return 'airouter-state-v1:claude'; } });
  const frames = [
    ['message_start', { type: 'message_start', message: { id: 'msg-think' } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '摘要🙂' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'provider-signature' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-a', name: 'lookup', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"n":1}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: '再想' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'signature_delta', signature: 'provider-signature-2' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['content_block_start', { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: '2' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 3 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }], ['message_stop', { type: 'message_stop' }],
  ];
  const events = [...feed(value, frames), ...value.finish()];
  assert.deepEqual(value.getCanonicalResponse().parts.map(x => x.type), ['reasoning', 'tool_use', 'reasoning', 'text']);
  assert.equal(issued[0].originBlock.signature, 'provider-signature');
  assert.equal(events.filter(x => x.event === 'response.reasoning_summary_text.delta').map(x => x.data.delta).join(''), '摘要🙂再想');
  assert.equal(events.filter(x => x.event === 'response.reasoning_text.delta').length, 0);
  assert.deepEqual(events.find(x => x.event === 'response.completed').data.response.output.map(x => x.type), ['reasoning', 'function_call', 'reasoning', 'message']);
});

test('JSON reasoning parts synthesize complete SSE and missing source terminal stays an error', () => {
  const part = { type: 'reasoning', text: TEXT, summary: [], originProtocol: 'chat_completions', originBlock: { reasoning_content: TEXT }, opaque: false };
  const events = responseToEntrySse('responses', { id: 'chat-json', sourceProtocol: 'chat_completions', parts: [part, { type: 'text', text: '2' }], stopReason: 'end_turn' }, 'public');
  assert.equal(events.find(x => x.event === 'response.reasoning_text.done').data.text, TEXT);
  assert.deepEqual(events.find(x => x.event === 'response.completed').data.response.output.map(x => x.type), ['reasoning', 'message']);
  const cut = bridge('chat_completions', 'responses');
  const output = [...feed(cut, chatFrames.slice(0, 2)), ...cut.finish()];
  assert.ok(output.some(x => x.data?.error)); assert.ok(!output.some(x => x.event === 'response.completed'));
});

for (const entry of ['chat_completions', 'messages']) test(`Responses full reasoning text and summary stay distinct when streamed to ${entry}`, () => {
  const item = { id: 'rs-public', type: 'reasoning', content: [{ type: 'reasoning_text', text: '完整🙂' }], summary: [{ type: 'summary_text', text: '摘要' }] };
  const value = bridge('responses', entry);
  const events = [...feed(value, [
    ['response.created', { type: 'response.created', response: { id: 'resp-public', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: item.id, type: 'reasoning', summary: [] } }],
    ['response.reasoning_text.delta', { type: 'response.reasoning_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: '完整' }],
    ['response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: item.id, output_index: 0, summary_index: 0, delta: '摘要' }],
    ['response.reasoning_text.delta', { type: 'response.reasoning_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: '🙂' }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: '答案' }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp-public', status: 'completed', output: [item, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案' }] }] } }],
  ]), ...value.finish()];
  const part = value.getCanonicalResponse().parts[0]; assert.equal(part.text, '完整🙂'); assert.deepEqual(part.summary, [{ type: 'summary_text', text: '摘要' }]);
  if (entry === 'chat_completions') {
    const choices = events.flatMap(x => x.data?.choices || []);
    assert.equal(choices.map(x => x.delta?.reasoning_content || '').join(''), '完整🙂');
    assert.equal(choices.flatMap(x => x.delta?.reasoning_details || []).find(x => x.type === 'reasoning.summary').summary, '摘要');
    assert.equal(choices.map(x => x.delta?.content || '').join(''), '答案');
  } else {
    assert.equal(events.filter(x => x.data?.delta?.type === 'thinking_delta').map(x => x.data.delta.thinking).join(''), '完整🙂');
    const marker = events.find(x => x.data?.delta?.type === 'signature_delta').data.delta.signature;
    const decoded = JSON.parse(Buffer.from(marker.slice('airouter-text-v1:'.length), 'base64url').toString());
    assert.equal(decoded.text, '完整🙂'); assert.deepEqual(decoded.summary, [{ type: 'summary_text', text: '摘要' }]);
  }
});

test('cipher-only reasoning can stream to Messages without fabricating a Claude provider signature', () => {
  const issued = [];
  const value = bridge('responses', 'messages', { issue(part, view) { issued.push({ part, view }); return 'airouter-state-v1:cipher-only'; } });
  const item = { id: 'rs-empty', type: 'reasoning', summary: [], encrypted_content: 'provider-cipher' };
  const events = [...feed(value, [
    ['response.created', { type: 'response.created', response: { id: 'resp-empty', output: [] } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, encrypted_content: 'partial' } }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response: { id: 'resp-empty', status: 'completed', output: [item] } }],
  ]), ...value.finish()];
  assert.equal(issued.length, 1); assert.equal(issued[0].part.originBlock.encrypted_content, 'provider-cipher');
  const signatures = events.filter(x => x.data?.delta?.type === 'signature_delta').map(x => x.data.delta.signature);
  assert.deepEqual(signatures, ['airouter-state-v1:cipher-only']);
  assert.equal(events.find(x => x.data?.content_block?.type === 'thinking').data.content_block.thinking, '');
  assert.equal(events.at(-1).data.type, 'message_stop');
});

test('incomplete Claude thinking blocks never issue an opaque ticket or finish successfully', () => {
  let issued = 0;
  const value = bridge('messages', 'chat_completions', { issue() { issued++; return 'airouter-state-v1:must-not-issue'; } });
  const events = [...feed(value, [
    ['message_start', { type: 'message_start', message: { id: 'msg-cut-thinking' } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'partial' } }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
    ['message_stop', { type: 'message_stop' }],
  ]), ...value.finish()];
  assert.equal(issued, 0); assert.ok(events.some(x => x.data?.error));
  assert.ok(!events.some(x => x.data?.choices?.some(c => c.finish_reason === 'stop')));
});

test('vendor reasoning detail text fragments concatenate once even when a text alias mirrors them', () => {
  const value = bridge('chat_completions', 'responses');
  const output = [...feed(value, [
    ['', { id: 'chat-details', choices: [{ index: 0, delta: { reasoning_content: '先想', reasoning_details: [{ type: 'reasoning.text', index: 0, format: 'openai-responses-v1', text: '先想' }] } }] }],
    ['', { id: 'chat-details', choices: [{ index: 0, delta: { reasoning_content: '🙂', reasoning_details: [{ type: 'reasoning.text', index: 0, format: 'openai-responses-v1', text: '🙂' }] } }] }],
    ['', { id: 'chat-details', choices: [{ index: 0, delta: { content: '2' }, finish_reason: 'stop' }] }],
  ]), ...value.finish()];
  assert.deepEqual(value.getCanonicalResponse().parts.map(x => [x.type, x.text]), [['reasoning', '先想🙂'], ['text', '2']]);
  assert.equal(output.filter(x => x.event === 'response.reasoning_text.delta').map(x => x.data.delta).join(''), '先想🙂');
});

test('ambiguous vendor encrypted detail updates reject instead of silently overwriting an earlier cipher', () => {
  const value = bridge('chat_completions', 'responses', { issue() { return 'airouter-state-v1:unsafe'; } });
  value.accept('', { id: 'chat-conflict', choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'cipher-a' }] } }] });
  assert.throws(() => value.accept('', { id: 'chat-conflict', choices: [{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.encrypted', index: 0, data: 'cipher-b' }] }, finish_reason: 'stop' }] }), /reasoning_details.*data|密文/);
});

test('completion-only Responses frames preserve reasoning/tool/reasoning/text item order', () => {
  let issued = 0;
  const value = bridge('responses', 'responses', { issue() { return 'airouter-state-v1:terminal-' + ++issued; } });
  const output = [
    { id: 'rs-one', type: 'reasoning', content: [{ type: 'reasoning_text', text: '一' }], summary: [] },
    { id: 'fc-one', type: 'function_call', call_id: 'call-one', name: 'lookup', arguments: '{"n":1}' },
    { id: 'rs-two', type: 'reasoning', content: [{ type: 'reasoning_text', text: '二' }], summary: [] },
    { id: 'msg-one', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations: [] }] },
  ];
  const events = [...value.accept('response.completed', { type: 'response.completed', response: { id: 'resp-only-final', status: 'completed', output } }), ...value.finish()];
  assert.deepEqual(value.getCanonicalResponse().parts.map(x => x.type), ['reasoning', 'tool_use', 'reasoning', 'text']);
  assert.deepEqual(events.find(x => x.event === 'response.completed').data.response.output.map(x => x.type), ['reasoning', 'function_call', 'reasoning', 'message']);
});

test('completed reasoning events preserve readable source-named provenance without provisional opaque data', () => {
  const scenarios = [
    { source: 'chat_completions', entry: 'messages', origin: { reasoning_content: '原文思考🙂' }, frames: [
      ['', { id: 'source-chat', choices: [{ index: 0, delta: { reasoning_content: '原文思考🙂' }, finish_reason: 'stop' }] }],
    ] },
    { source: 'responses', entry: 'messages', origin: { id: 'rs-source', type: 'reasoning', summary: [], encrypted_content: 'final-source-cipher' }, frames: [
      ['response.created', { type: 'response.created', response: { id: 'source-response', output: [] } }],
      ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { id: 'rs-source', type: 'reasoning', summary: [], encrypted_content: 'partial-source-cipher' } }],
      ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: { id: 'rs-source', type: 'reasoning', summary: [], encrypted_content: 'final-source-cipher' } }],
      ['response.completed', { type: 'response.completed', response: { id: 'source-response', status: 'completed', output: [{ id: 'rs-source', type: 'reasoning', summary: [], encrypted_content: 'final-source-cipher' }] } }],
    ] },
    { source: 'messages', entry: 'chat_completions', origin: { type: 'thinking', thinking: '源摘要', signature: 'final-source-signature' }, frames: [
      ['message_start', { type: 'message_start', message: { id: 'source-message' } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '源摘要' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'final-source-signature' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }], ['message_stop', { type: 'message_stop' }],
    ] },
  ];
  for (const scenario of scenarios) {
    const value = bridge(scenario.source, scenario.entry, { issue() { return 'airouter-state-v1:source-provenance'; } });
    const output = [...feed(value, scenario.frames), ...value.finish()];
    const event = scenario.entry === 'messages'
      ? output.find(x => x.event === 'content_block_stop' && x.data.airouter_upstream_reasoning)
      : output.find(x => x.data?.choices?.some(choice => choice.delta?.airouter_upstream_reasoning));
    const provenance = scenario.entry === 'messages' ? event?.data.airouter_upstream_reasoning : event?.data.choices[0].delta.airouter_upstream_reasoning;
    assert.deepEqual(provenance, { protocol: scenario.source, ...scenario.origin });
    assert.ok(!JSON.stringify(output).includes('partial-source-cipher'));
    assert.ok(!output.flatMap(x => x.data?.choices || []).some(choice => choice.delta?.content));
  }
});
