const test = require('node:test');
const assert = require('node:assert/strict');
const { transformRequestForTarget: request, transformResponseForEntry: response } = require('../app/protocol-bridge');
const chat = { id: 'chatcmpl-r', choices: [{ index: 0, message: { role: 'assistant', reasoning_content: '思考🙂', content: '答案', tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'f', arguments: '{"n":1}' } }] }, finish_reason: 'tool_calls' }] };
const encrypted = { id: 'resp-native', status: 'completed', output: [{ id: 'rs-native', type: 'reasoning', summary: [{ type: 'summary_text', text: '公开摘要' }], encrypted_content: 'cipher-native', status: 'completed' }, { id: 'm', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '答案', annotations: [] }] }] };
function transport() {
  const values = new Map(); let sequence = 0;
  return {
    issue(part, view) { const id = 'airouter-state-v1:' + ++sequence; values.set(id, { part: JSON.parse(JSON.stringify(part)), view }); return id; },
    resolve(id, view) { const value = values.get(id); assert.ok(value, 'known opaque token'); assert.deepEqual(view, value.view, 'same stable view'); return value.part; },
  };
}
const convert = (from, to, payload, reasoningTransport) => response({ targetProtocol: from, entryProtocol: to, payload, publicModel: 'public', reasoningTransport });
const forward = (from, to, body, reasoningTransport) => request({ entryProtocol: from, targetProtocol: to, body: { model: 'public', ...body }, targetModel: 'backend', stream: false, reasoningTransport });

test('DeepSeek public thinking maps to standard Responses full reasoning text before tool and answer', () => {
  const actual = convert('chat_completions', 'responses', chat);
  assert.deepEqual(actual.output.map(x => x.type), ['reasoning', 'message', 'function_call']);
  assert.deepEqual(actual.output[0].content, [{ type: 'reasoning_text', text: '思考🙂' }]);
  assert.deepEqual(actual.output[0].summary, []); assert.equal(actual.output[1].content[0].text, '答案');
  const history = forward('responses', 'chat_completions', { input: actual.output });
  assert.equal(history.messages.length, 1); assert.equal(history.messages[0].reasoning_content, '思考🙂');
  assert.equal(history.messages[0].tool_calls[0].id, 'call-a');
});
test('public Messages thinking uses an explicit portable gateway marker and round-trips to Chat', () => {
  const actual = convert('chat_completions', 'messages', chat);
  assert.deepEqual(actual.content.map(x => x.type), ['thinking', 'text', 'tool_use']);
  assert.equal(actual.content[0].thinking, '思考🙂'); assert.match(actual.content[0].signature, /^airouter-text-v1:/);
  const body = forward('messages', 'chat_completions', { messages: [{ role: 'assistant', content: actual.content }] });
  assert.equal(body.messages[0].reasoning_content, '思考🙂'); assert.equal(body.messages[0].content, '答案');
  assert.equal(body.messages[0].tool_calls[0].id, 'call-a');
  assert.throws(() => forward('messages', 'messages', { messages: [{ role: 'assistant', content: actual.content }] }), /signature|签名|原生/);
  const edited = structuredClone(actual.content); edited[0].thinking = 'changed';
  assert.throws(() => forward('messages', 'chat_completions', { messages: [{ role: 'assistant', content: edited }] }), /thinking|思考|匹配|篡改/);
});
test('opaque Responses state crosses Chat as gateway vendor transport and returns exact source item', () => {
  const session = transport(), actual = convert('responses', 'chat_completions', encrypted, session);
  const message = actual.choices[0].message;
  assert.equal(message.content, '答案'); assert.equal(message.reasoning_details[0].format, 'airouter-bridge-v1');
  assert.match(message.reasoning_details[0].data, /^airouter-state-v1:/);
  assert.notEqual(message.reasoning_details[0].data, 'cipher-native');
  const body = forward('chat_completions', 'responses', { messages: [message] }, session);
  assert.deepEqual(body.input[0], encrypted.output[0]); assert.equal(body.input[1].content[0].text, '答案');
  assert.throws(() => forward('chat_completions', 'chat_completions', { messages: [message] }, session), /来源|origin|原/);
});
test('opaque Responses state crosses Messages using a gateway token, never a made-up Claude signature', () => {
  const session = transport(), actual = convert('responses', 'messages', encrypted, session);
  assert.equal(actual.content[0].type, 'thinking'); assert.equal(actual.content[0].thinking, '公开摘要');
  assert.match(actual.content[0].signature, /^airouter-state-v1:/);
  const body = forward('messages', 'responses', { messages: [{ role: 'assistant', content: actual.content }] }, session);
  assert.deepEqual(body.input[0], encrypted.output[0]);
});
test('signed Claude thinking and redacted blocks preserve source text and opaque bytes through Responses', () => {
  const payload = { id: 'msg-r', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'native-signature' }, { type: 'redacted_thinking', data: 'native-redacted' }, { type: 'text', text: '答案' }], stop_reason: 'end_turn' };
  const session = transport(), actual = convert('messages', 'responses', payload, session);
  assert.deepEqual(actual.output.map(x => x.type), ['reasoning', 'reasoning', 'message']);
  assert.match(actual.output[0].encrypted_content, /^airouter-state-v1:/);
  const body = forward('responses', 'messages', { input: actual.output }, session);
  assert.deepEqual(body.messages[0].content, payload.content);
});
test('unowned opaque input is rejected and ordinary native requests remain unchanged', () => {
  assert.throws(() => forward('responses', 'chat_completions', { input: encrypted.output }), /归属|来源|上下文|opaque/);
  const native = { input: encrypted.output, store: false };
  assert.deepEqual(forward('responses', 'responses', native), { model: 'backend', stream: false, ...native });
});

test('Chat public reasoning_text alias maps explicitly and conflicts among all aliases reject', () => {
  const aliases = ['reasoning_content', 'reasoning', 'reasoning_text'];
  for (const alias of aliases) {
    const payload = { id: 'chat-alias', choices: [{ index: 0, message: { role: 'assistant', [alias]: '同一思考🙂', content: '答案' }, finish_reason: 'stop' }] };
    const actual = convert('chat_completions', 'responses', payload);
    assert.equal(actual.output[0].type, 'reasoning', alias);
    assert.deepEqual(actual.output[0].content, [{ type: 'reasoning_text', text: '同一思考🙂' }]);
  }
  for (let left = 0; left < aliases.length; left++) for (let right = left + 1; right < aliases.length; right++) {
    const payload = { id: 'chat-conflict', choices: [{ index: 0, message: { role: 'assistant', [aliases[left]]: 'first', [aliases[right]]: 'different', content: '答案' }, finish_reason: 'stop' }] };
    assert.throws(() => convert('chat_completions', 'responses', payload), /reasoning.*冲突/);
  }
});

test('cross-protocol reasoning exposes exact source-named provenance without mixing answer text', () => {
  for (const target of ['responses', 'messages']) {
    const actual = convert('chat_completions', target, chat);
    const block = target === 'responses' ? actual.output[0] : actual.content[0];
    assert.deepEqual(block.airouter_upstream_reasoning, { protocol: 'chat_completions', reasoning_content: '思考🙂' });
  }
  const session = transport();
  const actual = convert('responses', 'chat_completions', encrypted, session);
  assert.deepEqual(actual.choices[0].message.airouter_upstream_reasoning, { protocol: 'responses', ...encrypted.output[0] });
  const claude = { id: 'msg-source', content: [{ type: 'thinking', thinking: '摘要', signature: 'native-signed' }, { type: 'text', text: '回答' }], stop_reason: 'end_turn' };
  const converted = convert('messages', 'responses', claude, session);
  assert.equal(converted.output[0].airouter_upstream_reasoning.signature, 'native-signed');
  assert.equal(converted.output[1].content[0].text, '回答');
});

test('reasoning provenance is optional for return transport but supplied tampering rejects', () => {
  const session = transport();
  for (const target of ['responses', 'messages', 'chat_completions']) {
    const source = target === 'responses' ? chat : encrypted;
    const from = target === 'responses' ? 'chat_completions' : 'responses';
    const actual = convert(from, target, source, session);
    const block = target === 'responses' ? actual.output[0] : target === 'messages' ? actual.content[0] : actual.choices[0].message;
    assert.ok(block.airouter_upstream_reasoning);
    const body = () => target === 'responses' ? { input: actual.output } : { messages: [{ role: 'assistant', ...(target === 'messages' ? { content: actual.content } : block) }] };
    const provenance = structuredClone(block.airouter_upstream_reasoning);
    delete block.airouter_upstream_reasoning;
    const forwarded = forward(target, from, body(), session);
    assert.equal(JSON.stringify(forwarded).includes('airouter_upstream_reasoning'), false);
    block.airouter_upstream_reasoning = provenance;
    if (from === 'responses') block.airouter_upstream_reasoning.encrypted_content = 'edited-cipher';
    else block.airouter_upstream_reasoning.reasoning_content = 'edited-thinking';
    assert.throws(() => forward(target, from, body(), session), /provenance|来源|篡改|匹配/);
  }
});

test('public marker return validates exact original source fields when provenance is supplied', () => {
  const actual = convert('chat_completions', 'messages', chat);
  const block = actual.content[0];
  delete block.airouter_upstream_reasoning.reasoning_content;
  block.airouter_upstream_reasoning.reasoning_text = '思考🙂';
  assert.throws(() => forward('messages', 'chat_completions', { messages: [{ role: 'assistant', content: actual.content }] }), /provenance|来源|篡改|匹配/);
});
