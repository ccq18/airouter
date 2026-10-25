const test = require('node:test');
const assert = require('node:assert/strict');

const {
  UnsupportedProtocolFeatureError,
  normalizeEntryProtocol,
  transformRequestForTarget,
  transformResponseForEntry,
  createSseEventParser,
  createSameProtocolSseRewriter,
  createProtocolStreamBridge,
  responseToEntrySse,
  collectCanonicalEvents,
} = require('../app/protocol-bridge');

test('entry protocol detection is path based and rejects non-dialogue endpoints', () => {
  assert.equal(normalizeEntryProtocol('/v1/chat/completions'), 'chat_completions');
  assert.equal(normalizeEntryProtocol('/v1/responses'), 'responses');
  assert.equal(normalizeEntryProtocol('/v1/messages'), 'messages');
  assert.equal(normalizeEntryProtocol('/v1/images/generations'), null);
});

test('chat entry to responses target preserves text, tools, tool results and model mapping', () => {
  const body = {
    model: 'public-model',
    messages: [
      { role: 'system', content: 'be concise' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"temp":20}' },
    ],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }],
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
    max_tokens: 256,
    stream: true,
  };

  const transformed = transformRequestForTarget({
    entryProtocol: 'chat_completions',
    targetProtocol: 'responses',
    body,
    targetModel: 'gpt-backend',
    stream: true,
  });

  assert.equal(transformed.model, 'gpt-backend');
  assert.equal(transformed.instructions, 'be concise');
  assert.equal(transformed.max_output_tokens, 256);
  assert.equal(transformed.stream, true);
  assert.equal(transformed.tools[0].name, 'get_weather');
  assert.deepEqual(transformed.tool_choice, { type: 'function', name: 'get_weather' });
  assert.ok(transformed.input.some(item => item.type === 'function_call' && item.call_id === 'call_1'));
  assert.ok(transformed.input.some(item => item.type === 'function_call_output' && item.call_id === 'call_1'));
  assert.ok(transformed.input.some(item => item.type === 'message' && item.role === 'user'));
});

test('messages entry to chat target preserves tools and tool round trips', () => {
  const body = {
    model: 'public-model',
    max_tokens: 512,
    system: [{ type: 'text', text: 'system prompt' }],
    messages: [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'toolu_1',
          name: 'lookup',
          input: { id: 1 },
        }],
      },
      {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'result text' }],
        }],
      },
    ],
    tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'any' },
    stream: false,
  };

  const transformed = transformRequestForTarget({
    entryProtocol: 'messages',
    targetProtocol: 'chat_completions',
    body,
    targetModel: 'glm-5.3',
    stream: false,
  });

  assert.equal(transformed.model, 'glm-5.3');
  assert.equal(transformed.messages[0].role, 'system');
  assert.equal(transformed.messages[0].content, 'system prompt');
  const assistant = transformed.messages.find(message => message.role === 'assistant');
  assert.equal(assistant.tool_calls[0].id, 'toolu_1');
  assert.equal(assistant.tool_calls[0].function.name, 'lookup');
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { id: 1 });
  const toolMessage = transformed.messages.find(message => message.role === 'tool');
  assert.equal(toolMessage.tool_call_id, 'toolu_1');
  assert.equal(toolMessage.content, 'result text');
  assert.equal(transformed.tools[0].function.name, 'lookup');
  assert.equal(transformed.tool_choice, 'required');
  assert.equal(transformed.max_tokens, 512);
});

test('responses entry to messages target preserves instructions and output limits', () => {
  const transformed = transformRequestForTarget({
    entryProtocol: 'responses',
    targetProtocol: 'messages',
    body: {
      model: 'public-model',
      instructions: 'system',
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      }],
      max_output_tokens: 128,
      stream: true,
    },
    targetModel: 'claude/native',
    stream: true,
  });

  assert.equal(transformed.model, 'claude/native');
  assert.equal(transformed.system, 'system');
  assert.equal(transformed.max_tokens, 128);
  assert.deepEqual(transformed.messages[0].content, [{ type: 'text', text: 'hello' }]);
  assert.equal(transformed.stream, true);
});

test('same-protocol requests only change model and stream settings', () => {
  const body = {
    model: 'public-model',
    messages: [{ role: 'user', content: 'hi' }],
    temperature: 0.2,
    response_format: { type: 'json_object' },
    stream: false,
  };
  const transformed = transformRequestForTarget({
    entryProtocol: 'chat_completions',
    targetProtocol: 'chat_completions',
    body,
    targetModel: 'glm-5.3',
    stream: false,
  });

  assert.deepEqual(transformed, {
    ...body,
    model: 'glm-5.3',
  });
});

test('cross-protocol structured output and files fail clearly instead of being dropped', () => {
  assert.throws(() => transformRequestForTarget({
    entryProtocol: 'chat_completions',
    targetProtocol: 'responses',
    body: {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hi' }],
      response_format: { type: 'json_object' },
    },
    targetModel: 'gpt-backend',
    stream: false,
  }), error => error instanceof UnsupportedProtocolFeatureError && /结构化输出/.test(error.message));

  assert.throws(() => transformRequestForTarget({
    entryProtocol: 'messages',
    targetProtocol: 'chat_completions',
    body: {
      model: 'public-model',
      max_tokens: 10,
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'AAAA' },
        }],
      }],
    },
    targetModel: 'glm-5.3',
    stream: false,
  }), error => error instanceof UnsupportedProtocolFeatureError && /文件/.test(error.message));
});

test('responses target JSON can be rendered as a Claude Messages response with tools', () => {
  const result = transformResponseForEntry({
    entryProtocol: 'messages',
    targetProtocol: 'responses',
    publicModel: 'public-model',
    payload: {
      id: 'resp_1',
      model: 'gpt-backend',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'hello' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'lookup',
          arguments: '{"id":1}',
        },
      ],
      usage: { input_tokens: 4, output_tokens: 2 },
    },
  });

  assert.equal(result.type, 'message');
  assert.equal(result.model, 'public-model');
  assert.equal(result.content[0].type, 'text');
  assert.equal(result.content[1].type, 'tool_use');
  assert.equal(result.content[1].id, 'call_1');
  assert.deepEqual(result.content[1].input, { id: 1 });
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2 });
});

test('chat target JSON can be rendered as a Responses response with tool calls', () => {
  const result = transformResponseForEntry({
    entryProtocol: 'responses',
    targetProtocol: 'chat_completions',
    publicModel: 'public-model',
    payload: {
      id: 'chatcmpl-1',
      model: 'glm-5.3',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'hello',
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"id":2}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
  });

  assert.equal(result.object, 'response');
  assert.equal(result.model, 'public-model');
  assert.equal(result.output_text, 'hello');
  assert.ok(result.output.some(item => item.type === 'message' && item.content[0].text === 'hello'));
  const call = result.output.find(item => item.type === 'function_call');
  assert.equal(call.call_id, 'call_1');
  assert.equal(call.name, 'lookup');
  assert.deepEqual(result.usage, { input_tokens: 3, output_tokens: 2, total_tokens: 5 });
});

test('SSE parser handles split chunks and CRLF framing', () => {
  const parser = createSseEventParser();
  const first = parser.push(Buffer.from('event: message_start\r\ndata: {"type":"message_start",'));
  assert.equal(first.length, 0);
  const second = parser.push(Buffer.from('"message":{"id":"msg_1","model":"m"}}\r\n\r\n'));
  assert.equal(second.length, 1);
  assert.equal(second[0].event, 'message_start');
  assert.equal(second[0].data.message.id, 'msg_1');
  assert.equal(parser.finish().length, 0);
});

test('same-protocol SSE rewrite keeps events intact and only replaces model identity', () => {
  const rewriter = createSameProtocolSseRewriter('responses', 'public-model');
  const entries = rewriter.accept('response.output_text.delta', {
    type: 'response.output_text.delta',
    delta: 'hello',
    model: 'backend-model',
    response: { model: 'backend-model' },
  });

  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, 'response.output_text.delta');
  assert.equal(entries[0].data.delta, 'hello');
  assert.equal(entries[0].data.model, 'public-model');
  assert.equal(entries[0].data.response.model, 'public-model');
});

test('responses SSE converts to chat completion chunks including tool args and DONE', () => {
  const bridge = createProtocolStreamBridge({
    entryProtocol: 'chat_completions',
    targetProtocol: 'responses',
    publicModel: 'public-model',
  });

  const emitted = [];
  function feed(event, payload) {
    emitted.push(...bridge.accept(event, payload));
  }

  feed('response.created', { type: 'response.created', response: { id: 'resp_1', model: 'gpt-backend' } });
  feed('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '' },
  });
  feed('response.function_call_arguments.delta', {
    type: 'response.function_call_arguments.delta',
    item_id: 'fc_1',
    output_index: 0,
    delta: '{"id":1}',
  });
  feed('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' },
  });
  feed('response.completed', {
    type: 'response.completed',
    response: {
      id: 'resp_1',
      model: 'gpt-backend',
      status: 'completed',
      output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup', arguments: '{"id":1}' }],
      usage: { input_tokens: 3, output_tokens: 2 },
    },
  });
  emitted.push(...bridge.finish());

  const chatChunks = emitted.filter(entry => entry.event === null && entry.raw !== '[DONE]');
  assert.ok(chatChunks.some(entry => entry.data.choices[0].delta.tool_calls));
  assert.ok(chatChunks.every(entry => entry.data.model === 'public-model'));
  assert.equal(emitted[emitted.length - 1].raw, '[DONE]');
  assert.ok(chatChunks.some(entry => entry.data.choices[0].finish_reason === 'tool_calls'));
});

test('chat SSE converts to Messages SSE with tool_use blocks and message_stop', () => {
  const bridge = createProtocolStreamBridge({
    entryProtocol: 'messages',
    targetProtocol: 'chat_completions',
    publicModel: 'public-model',
  });
  const emitted = [];

  emitted.push(...bridge.accept('', {
    id: 'chatcmpl-1',
    model: 'glm-5.3',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '' },
        }],
      },
    }],
  }));
  emitted.push(...bridge.accept('', {
    id: 'chatcmpl-1',
    model: 'glm-5.3',
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '{"id":1}' } }] },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  }));
  emitted.push(...bridge.finish());

  assert.equal(emitted[0].event, 'message_start');
  assert.equal(emitted[0].data.message.model, 'public-model');
  assert.ok(emitted.some(entry => entry.event === 'content_block_start' && entry.data.content_block.type === 'tool_use'));
  assert.ok(emitted.some(entry => entry.event === 'content_block_delta' && entry.data.delta.type === 'input_json_delta'));
  assert.ok(emitted.some(entry => entry.event === 'message_delta' && entry.data.delta.stop_reason === 'tool_use'));
  assert.equal(emitted[emitted.length - 1].event, 'message_stop');
});

test('messages SSE converts to Responses SSE and preserves public model identity', () => {
  const bridge = createProtocolStreamBridge({
    entryProtocol: 'responses',
    targetProtocol: 'messages',
    publicModel: 'public-model',
  });
  const emitted = [];

  emitted.push(...bridge.accept('message_start', {
    type: 'message_start',
    message: { id: 'msg_1', model: 'claude/native', usage: { input_tokens: 2 }, content: [] },
  }));
  emitted.push(...bridge.accept('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }));
  emitted.push(...bridge.accept('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hello' },
  }));
  emitted.push(...bridge.accept('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 1 },
  }));
  emitted.push(...bridge.accept('message_stop', { type: 'message_stop' }));
  emitted.push(...bridge.finish());

  const created = emitted.find(entry => entry.event === 'response.created');
  assert.equal(created.data.response.model, 'public-model');
  assert.ok(emitted.some(entry => entry.event === 'response.output_text.delta' && entry.data.delta === 'hello'));
  const completed = emitted.find(entry => entry.event === 'response.completed');
  assert.equal(completed.data.response.model, 'public-model');
  assert.equal(completed.data.response.output_text, 'hello');
});

test('streamed events can be collected into a non-stream response for non-stream clients', () => {
  const bridge = createProtocolStreamBridge({
    entryProtocol: 'responses',
    targetProtocol: 'chat_completions',
    publicModel: 'public-model',
  });
  bridge.accept('', {
    id: 'chatcmpl-1',
    model: 'glm-5.3',
    choices: [{ index: 0, delta: { content: 'hello' } }],
  });
  bridge.accept('', {
    id: 'chatcmpl-1',
    model: 'glm-5.3',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });

  const canonical = bridge.getCanonicalResponse();
  assert.equal(canonical.id, 'chatcmpl-1');
  assert.equal(canonical.parts[0].text, 'hello');
  assert.equal(canonical.stopReason, 'end_turn');
});

test('a non-stream target response can be rendered as entry SSE events', () => {
  const events = responseToEntrySse('chat_completions', {
    id: 'msg_1',
    model: 'claude/native',
    parts: [{ type: 'text', text: 'hello' }],
    stopReason: 'end_turn',
    usage: { inputTokens: 2, outputTokens: 1 },
  }, 'public-model');

  assert.ok(events.some(entry => entry.data && entry.data.choices && entry.data.choices[0].delta.content === 'hello'));
  assert.equal(events[events.length - 1].raw, '[DONE]');
});

test('collectCanonicalEvents handles deltas after a completed marker safely', () => {
  const state = collectCanonicalEvents([
    { type: 'start', id: 'x', model: 'm' },
    { type: 'text_delta', text: 'a' },
    { type: 'finish', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'text_delta', text: 'ignored' },
  ]);

  assert.equal(state.parts[0].text, 'a');
});
