const test = require('node:test');
const assert = require('node:assert/strict');
const { transformRequestForTarget, UnsupportedProtocolFeatureError } = require('../app/protocol-bridge');

const bridge = (from, to, body) => transformRequestForTarget({ entryProtocol: from, targetProtocol: to, body: { model: 'public', ...body }, targetModel: 'backend', stream: false });
const call = (id, args = '{}') => ({ type: 'function_call', call_id: id, name: 'lookup', arguments: args });

test('Responses shorthand and explicit instruction messages retain roles, order, and content in Chat', () => {
  const result = bridge('responses', 'chat_completions', { instructions: 'root', input: [
    { role: 'developer', content: 'dev' }, { role: 'user', content: 'first' },
    { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'later system' }] },
    { type: 'message', role: 'developer', content: 'later dev' },
    { role: 'assistant', content: 'answer' }, { role: 'user', content: 'last' },
  ] });
  assert.deepEqual(result.messages.map(item => [item.role, item.content]), [
    ['system', 'root'], ['developer', 'dev'], ['user', 'first'], ['system', 'later system'], ['developer', 'later dev'], ['assistant', 'answer'], ['user', 'last'],
  ]);
});

test('Chat instruction roles and mid-conversation system messages remain ordered in Responses', () => {
  const result = bridge('chat_completions', 'responses', { messages: [
    { role: 'system', content: 'root' }, { role: 'developer', content: 'dev' }, { role: 'user', content: 'hello' }, { role: 'system', content: 'later' },
  ] });
  assert.deepEqual(result.input.map(item => item.role), ['system', 'developer', 'user', 'system']);
  assert.deepEqual(result.input.map(item => item.content[0].text), ['root', 'dev', 'hello', 'later']);
});

test('Claude cannot silently downgrade developer or relocate a late system instruction', () => {
  for (const from of ['responses', 'chat_completions']) {
    const messages = [{ role: 'user', content: 'hello' }, { role: 'system', content: 'later' }];
    for (const input of [[{ role: 'developer', content: 'dev' }], messages]) {
      assert.throws(() => bridge(from, 'messages', from === 'responses' ? { input } : { messages: input }), UnsupportedProtocolFeatureError);
    }
  }
});

test('parallel Responses calls become one Chat assistant turn and outputs retain pairing and order', () => {
  const result = bridge('responses', 'chat_completions', { parallel_tool_calls: true, input: [
    { role: 'assistant', content: 'checking' }, call('a'), call('b'),
    { type: 'function_call_output', call_id: 'b', output: 'B' }, { type: 'function_call_output', call_id: 'a', output: 'A' },
    { role: 'user', content: 'continue' },
  ] });
  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[0].content, 'checking');
  assert.deepEqual(result.messages[0].tool_calls.map(item => item.id), ['a', 'b']);
  assert.deepEqual(result.messages.slice(1, 3).map(item => [item.role, item.tool_call_id, item.content]), [['tool', 'b', 'B'], ['tool', 'a', 'A']]);
  assert.equal(result.messages[3].content, 'continue');
  assert.equal(result.parallel_tool_calls, true);
});

test('parallel Responses calls and their outputs remain grouped in Messages', () => {
  const result = bridge('responses', 'messages', { parallel_tool_calls: false, tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }], input: [call('a'), call('b'),
    { type: 'function_call_output', call_id: 'b', output: 'B' }, { type: 'function_call_output', call_id: 'a', output: 'A' },
  ] });
  assert.equal(result.messages.length, 2);
  assert.deepEqual(result.messages[0].content.map(item => item.id), ['a', 'b']);
  assert.deepEqual(result.messages[1].content.map(item => item.tool_use_id), ['b', 'a']);
  assert.deepEqual(result.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
});

test('Messages result text stays after tool results and Responses preserves interleaved assistant content', () => {
  const result = bridge('messages', 'chat_completions', { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'lookup', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'A' }, { type: 'text', text: 'after result' }] },
  ] });
  assert.deepEqual(result.messages.slice(1).map(item => [item.role, item.content]), [['tool', 'A'], ['user', 'after result']]);
  const responses = bridge('messages', 'responses', { messages: [{ role: 'assistant', content: [
    { type: 'text', text: 'before' }, { type: 'tool_use', id: 'a', name: 'lookup', input: {} }, { type: 'text', text: 'after' },
  ] }] });
  assert.deepEqual(responses.input.map(item => item.type), ['message', 'function_call', 'message']);
  assert.equal(responses.input[0].content[0].text, 'before');
  assert.equal(responses.input[2].content[0].text, 'after');
});

test('tool result errors and custom freeform tools are explicitly rejected when no equivalent exists', () => {
  for (const target of ['responses', 'chat_completions']) {
    assert.throws(() => bridge('messages', target, { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'failed', is_error: true }] }] }), /error|错误/i);
  }
  assert.throws(() => bridge('responses', 'chat_completions', { input: 'hi', tools: [{ type: 'custom', name: 'shell', format: { type: 'text' } }] }), UnsupportedProtocolFeatureError);
});

test('OpenAI argument strings are exact; Messages requires a valid JSON object instead of fabricating {}', () => {
  const argumentsText = '{ "big": 9007199254740993, "n": 1e9 }';
  const result = bridge('responses', 'chat_completions', { input: [call('a', argumentsText)] });
  assert.equal(result.messages[0].tool_calls[0].function.arguments, argumentsText);
  for (const invalid of ['{broken', '[1,2]', 'null', '1']) {
    assert.throws(() => bridge('responses', 'messages', { input: [call('a', invalid)] }), UnsupportedProtocolFeatureError);
  }
  const raw = bridge('responses', 'chat_completions', { input: [call('a', '{broken')] });
  assert.equal(raw.messages[0].tool_calls[0].function.arguments, '{broken');
});

test('Messages argument conversion rejects decimal precision loss instead of changing user parameters', () => {
  assert.throws(() => bridge('responses', 'messages', { input: [call('a', '{"value":0.100000000000000005}')] }), UnsupportedProtocolFeatureError);
  const result = bridge('responses', 'messages', { input: [call('a', '{"value":1e9,"fraction":0.1}')] });
  assert.deepEqual(result.messages[0].content[0].input, { value: 1000000000, fraction: 0.1 });
});

test('tool results cannot mismatch IDs, repeat a result, or resume text before all parallel calls return', () => {
  for (const input of [
    [call('a'), { type: 'function_call_output', call_id: 'other', output: 'wrong' }],
    [call('a'), { type: 'function_call_output', call_id: 'a', output: 'one' }, { type: 'function_call_output', call_id: 'a', output: 'duplicate' }],
    [call('a'), call('b'), { type: 'function_call_output', call_id: 'a', output: 'one' }, { role: 'user', content: 'too early' }],
  ]) assert.throws(() => bridge('responses', 'chat_completions', { input }), UnsupportedProtocolFeatureError);
});

test('cache control field names inside user tool schemas are not mistaken for API cache directives', () => {
  const result = bridge('chat_completions', 'messages', { messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: { cache_control: { type: 'string' } } } } }] });
  assert.deepEqual(result.tools[0].input_schema.properties.cache_control, { type: 'string' });
});

test('multiple text tool-result blocks retain their content and order without inserted separator text', () => {
  const result = bridge('messages', 'responses', { messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'lookup', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }] },
  ] });
  assert.deepEqual(result.input[1].output, [{ type: 'input_text', text: 'one' }, { type: 'input_text', text: 'two' }]);
});

test('tool choice, strict schema and parallel disable flag map between all protocols', () => {
  const source = { messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'lookup', input_schema: { type: 'object' }, strict: true }], tool_choice: { type: 'tool', name: 'lookup', disable_parallel_tool_use: true } };
  for (const target of ['responses', 'chat_completions']) {
    const result = bridge('messages', target, source);
    assert.equal(result.parallel_tool_calls, false);
    assert.equal(target === 'responses' ? result.tools[0].strict : result.tools[0].function.strict, true);
  }
  const claude = bridge('chat_completions', 'messages', { messages: [{ role: 'user', content: 'hi' }], parallel_tool_calls: false, tool_choice: 'required', tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' }, strict: true } }] });
  assert.deepEqual(claude.tool_choice, { type: 'any', disable_parallel_tool_use: true });
  assert.equal(claude.tools[0].strict, true);
});

test('Chat and Messages stop sequences map exactly; Responses rejects unsupported stop semantics', () => {
  const messages = [{ role: 'user', content: 'hello' }];
  assert.deepEqual(bridge('chat_completions', 'messages', { messages, stop: 'END' }).stop_sequences, ['END']);
  assert.deepEqual(bridge('messages', 'chat_completions', { messages, stop_sequences: ['END', '终止'] }).stop, ['END', '终止']);
  assert.throws(() => bridge('chat_completions', 'responses', { messages, stop: 'END' }), UnsupportedProtocolFeatureError);
  assert.throws(() => bridge('messages', 'responses', { messages, stop_sequences: ['END'] }), UnsupportedProtocolFeatureError);
  assert.throws(() => bridge('messages', 'chat_completions', { messages, stop_sequences: ['1', '2', '3', '4', '5'] }), UnsupportedProtocolFeatureError);
});

test('OpenAI shared cache controls and content breakpoints survive Chat/Responses conversion', () => {
  const cache = { prompt_cache_key: 'private-cache-key', prompt_cache_retention: '24h', prompt_cache_options: { mode: 'explicit', ttl: '30m' } };
  const point = { mode: 'explicit', ttl: '30m' };
  const result = bridge('chat_completions', 'responses', { ...cache, messages: [{ role: 'user', content: [{ type: 'text', text: 'cached', prompt_cache_breakpoint: point }] }] });
  for (const [key, value] of Object.entries(cache)) assert.deepEqual(result[key], value);
  assert.deepEqual(result.input[0].content[0].prompt_cache_breakpoint, point);
  const reverse = bridge('responses', 'chat_completions', { ...cache, input: [{ role: 'user', content: [{ type: 'input_text', text: 'cached', prompt_cache_breakpoint: point }] }] });
  assert.deepEqual(reverse.messages[0].content[0].prompt_cache_breakpoint, point);
  assert.deepEqual(reverse.prompt_cache_options, cache.prompt_cache_options);
});

test('non-equivalent cache controls are explicitly rejected cross-protocol and preserved same-protocol', () => {
  const body = { system: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral', ttl: '1h' } }], messages: [{ role: 'user', content: 'hi' }] };
  for (const target of ['responses', 'chat_completions']) assert.throws(() => bridge('messages', target, body), /cache|缓存/i);
  for (const source of ['responses', 'chat_completions']) assert.throws(() => bridge(source, 'messages', { prompt_cache_key: 'key', ...(source === 'responses' ? { input: 'hi' } : { messages: body.messages }) }), /cache|缓存/i);
  assert.throws(() => bridge('responses', 'chat_completions', { input: 'hi', prompt_cache_options: { prewarm: true } }), /cache|缓存/i);
  const same = bridge('messages', 'messages', body);
  assert.deepEqual(same.system, body.system);
});

test('cross Responses does not invent storage or parallel defaults and explicitly stored state cannot become Chat', () => {
  const result = bridge('chat_completions', 'responses', { messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(Object.hasOwn(result, 'store'), false);
  assert.equal(Object.hasOwn(result, 'parallel_tool_calls'), false);
  assert.throws(() => bridge('responses', 'chat_completions', { input: 'hello', store: true }), UnsupportedProtocolFeatureError);
});

test('all same-protocol requests preserve cache, stop, storage and tool-error controls unchanged', () => {
  const controls = { prompt_cache_key: 'key', prompt_cache_retention: '24h', prompt_cache_options: { mode: 'explicit', ttl: '30m' } };
  const cases = [
    ['chat_completions', { ...controls, stream: false, stop: ['END'], parallel_tool_calls: false, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', prompt_cache_breakpoint: { mode: 'explicit' } }] }] }],
    ['responses', { ...controls, stream: false, store: true, input: [{ role: 'developer', content: 'dev' }, { role: 'user', content: 'hi' }] }],
    ['messages', { stream: false, cache_control: { type: 'ephemeral' }, stop_sequences: ['END'], tools: [{ name: 'lookup', input_schema: { type: 'object' }, strict: true, cache_control: { type: 'ephemeral' } }], tool_choice: { type: 'auto', disable_parallel_tool_use: true }, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'failure', is_error: true }] }] }],
  ];
  for (const [protocol, body] of cases) assert.deepEqual(bridge(protocol, protocol, body), { model: 'backend', ...body });
});

test('two rounds of parallel calls retain turn boundaries and each round result pairing', () => {
  const input = [
    { role: 'user', content: 'round one' }, call('a'), call('b'),
    { type: 'function_call_output', call_id: 'b', output: 'B1' }, { type: 'function_call_output', call_id: 'a', output: 'A1' },
    { role: 'assistant', content: 'done one' }, { role: 'user', content: 'round two' }, call('c'), call('d'),
    { type: 'function_call_output', call_id: 'c', output: 'C2' }, { type: 'function_call_output', call_id: 'd', output: 'D2' },
  ];
  const result = bridge('responses', 'chat_completions', { input });
  assert.deepEqual(result.messages.filter(item => item.tool_calls).map(item => item.tool_calls.map(call => call.id)), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(result.messages.filter(item => item.role === 'tool').map(item => [item.tool_call_id, item.content]), [['b', 'B1'], ['a', 'A1'], ['c', 'C2'], ['d', 'D2']]);
  assert.deepEqual(result.messages.filter(item => item.role === 'user').map(item => item.content), ['round one', 'round two']);
});

const PROTOCOLS = ['chat_completions', 'responses', 'messages'];
for (const from of PROTOCOLS) for (const to of PROTOCOLS) {
  if (from === to) continue;
  test(`six-direction forced/required/none/auto tool choices preserve mode, name and parallel flag: ${from} -> ${to}`, () => {
    const functions = [{ name: 'lookup', description: 'lookup a record', parameters: { type: 'object' }, strict: true }];
    for (const mode of ['forced', 'required', 'none', 'auto']) for (const parallel of mode === 'none' ? [undefined] : [false, true]) {
      const base = from === 'responses' ? { input: 'hello' } : { messages: [{ role: 'user', content: 'hello' }] };
      base.tools = from === 'messages' ? [{ name: 'lookup', description: 'lookup a record', input_schema: { type: 'object' }, strict: true }]
        : from === 'responses' ? [{ type: 'function', ...functions[0] }] : [{ type: 'function', function: functions[0] }];
      base.tool_choice = from === 'messages' ? { type: mode === 'forced' ? 'tool' : mode === 'required' ? 'any' : mode, ...(mode === 'forced' ? { name: 'lookup' } : {}), ...(mode === 'none' ? {} : { disable_parallel_tool_use: !parallel }) }
        : mode === 'forced' ? from === 'responses' ? { type: 'function', name: 'lookup' } : { type: 'function', function: { name: 'lookup' } } : mode;
      if (from !== 'messages' && parallel !== undefined) base.parallel_tool_calls = parallel;
      const result = bridge(from, to, base);
      const expectedChoice = to === 'messages' ? { type: mode === 'forced' ? 'tool' : mode === 'required' ? 'any' : mode, ...(mode === 'forced' ? { name: 'lookup' } : {}), ...(mode === 'none' ? {} : { disable_parallel_tool_use: !parallel }) }
        : mode === 'forced' ? to === 'responses' ? { type: 'function', name: 'lookup' } : { type: 'function', function: { name: 'lookup' } } : mode;
      assert.deepEqual(result.tool_choice, expectedChoice, `${mode}, parallel=${parallel}`);
      if (to !== 'messages') assert.equal(result.parallel_tool_calls, parallel);
      assert.deepEqual(result.tools, to === 'messages' ? [{ name: 'lookup', description: 'lookup a record', input_schema: { type: 'object' }, strict: true }]
        : to === 'responses' ? [{ type: 'function', name: 'lookup', description: 'lookup a record', parameters: { type: 'object' }, strict: true }] : [{ type: 'function', function: { name: 'lookup', description: 'lookup a record', parameters: { type: 'object' }, strict: true } }]);
    }
  });
  test(`six-direction two parallel rounds preserve turn/result order: ${from} -> ${to}`, () => {
    const history = [];
    for (const round of [1, 2]) {
      const ids = [`a${round}`, `b${round}`];
      if (from === 'responses') history.push({ role: 'user', content: 'round' + round },
        ...ids.map((id, i) => ({ type: 'function_call', call_id: id, name: 'lookup', arguments: JSON.stringify({ n: round * 10 + i }) })),
        { type: 'function_call_output', call_id: ids[1], output: 'B' + round }, { type: 'function_call_output', call_id: ids[0], output: 'A' + round });
      else if (from === 'chat_completions') history.push({ role: 'user', content: 'round' + round },
        { role: 'assistant', content: null, tool_calls: ids.map((id, i) => ({ id, type: 'function', function: { name: 'lookup', arguments: JSON.stringify({ n: round * 10 + i }) } })) },
        { role: 'tool', tool_call_id: ids[1], content: 'B' + round }, { role: 'tool', tool_call_id: ids[0], content: 'A' + round });
      else history.push({ role: 'user', content: 'round' + round },
        { role: 'assistant', content: ids.map((id, i) => ({ type: 'tool_use', id, name: 'lookup', input: { n: round * 10 + i } })) },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: ids[1], content: 'B' + round }, { type: 'tool_result', tool_use_id: ids[0], content: 'A' + round }] });
    }
    const result = bridge(from, to, from === 'responses' ? { input: history } : { messages: history });
    // Literal expected turns and ID/value pairs; no reverse conversion as oracle.
    if (to === 'chat_completions') {
      assert.deepEqual(result.messages.map(item => item.role), ['user', 'assistant', 'tool', 'tool', 'user', 'assistant', 'tool', 'tool']);
      assert.deepEqual(result.messages.filter(x => x.tool_calls).map(x => x.tool_calls.map(c => [c.id, c.function.name, c.function.arguments])), [
        [['a1', 'lookup', '{"n":10}'], ['b1', 'lookup', '{"n":11}']], [['a2', 'lookup', '{"n":20}'], ['b2', 'lookup', '{"n":21}']],
      ]);
      assert.deepEqual(result.messages.filter(x => x.role === 'tool').map(x => [x.tool_call_id, x.content]), [['b1', 'B1'], ['a1', 'A1'], ['b2', 'B2'], ['a2', 'A2']]);
      assert.deepEqual(result.messages.filter(x => x.role === 'user').map(x => x.content), ['round1', 'round2']);
    } else if (to === 'responses') {
      assert.deepEqual(result.input.map(x => x.type), ['message', 'function_call', 'function_call', 'function_call_output', 'function_call_output', 'message', 'function_call', 'function_call', 'function_call_output', 'function_call_output']);
      assert.deepEqual(result.input.filter(x => x.type === 'function_call').map(x => [x.call_id, x.name, x.arguments]), [['a1', 'lookup', '{"n":10}'], ['b1', 'lookup', '{"n":11}'], ['a2', 'lookup', '{"n":20}'], ['b2', 'lookup', '{"n":21}']]);
      assert.deepEqual(result.input.filter(x => x.type === 'function_call_output').map(x => [x.call_id, typeof x.output === 'string' ? x.output : x.output[0].text]), [['b1', 'B1'], ['a1', 'A1'], ['b2', 'B2'], ['a2', 'A2']]);
      assert.deepEqual(result.input.filter(x => x.type === 'message').map(x => x.content[0].text), ['round1', 'round2']);
    } else {
      assert.deepEqual(result.messages.map(x => x.role), ['user', 'assistant', 'user', 'assistant', 'user']);
      assert.deepEqual(result.messages.filter(x => x.role === 'assistant').map(x => x.content.map(c => [c.id, c.name, c.input])), [
        [['a1', 'lookup', { n: 10 }], ['b1', 'lookup', { n: 11 }]], [['a2', 'lookup', { n: 20 }], ['b2', 'lookup', { n: 21 }]],
      ]);
      assert.deepEqual(result.messages.flatMap(x => x.content).filter(x => x.type === 'tool_result').map(x => [x.tool_use_id, typeof x.content === 'string' ? x.content : x.content[0].text]), [['b1', 'B1'], ['a1', 'A1'], ['b2', 'B2'], ['a2', 'A2']]);
      assert.deepEqual(result.messages.flatMap(x => x.content).filter(x => x.type === 'text').map(x => x.text), ['round1', 'round2']);
    }
  });
}

test('standalone effort keeps each official value and null exactly; unsupported subfields never disappear', () => {
  for (const effort of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', null]) {
    assert.deepEqual(bridge('chat_completions', 'responses', { messages: [], reasoning_effort: effort }).reasoning, { effort });
    const sent = bridge('responses', 'chat_completions', { input: [], reasoning: { effort } });
    assert.equal(sent.reasoning_effort, effort); assert.ok(!Object.hasOwn(sent, 'reasoning'));
  }
  for (const effort of ['automatic', 1, true, {}, []]) {
    assert.throws(() => bridge('chat_completions', 'responses', { messages: [], reasoning_effort: effort }), /reasoning_effort/);
    assert.throws(() => bridge('responses', 'chat_completions', { input: [], reasoning: { effort } }), /reasoning.effort/);
  }
  for (const field of ['summary', 'encrypted_content', 'generate_summary', 'context', 'future_control']) {
    assert.throws(() => bridge('responses', 'chat_completions', { input: [], reasoning: { effort: 'low', [field]: null } }), new RegExp('reasoning.' + field));
  }
});
