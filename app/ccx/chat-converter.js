const {
  createMessageId,
  createResponseId,
  extractOutputText,
  extractTextFromContent,
  jsonStringify,
  normalizeResponsesResponse,
  parseResponsesInput,
  safeJsonParse,
} = require('./canonical-responses');
const {
  chatUsageFromResponsesUsage,
  responsesUsageFromChatUsage,
} = require('./usage');

function normalizeChatContentToResponses(content, role) {
  if (typeof content === 'string') {
    return [{
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: content,
    }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map(part => {
    if (!part || typeof part !== 'object') {
      return null;
    }
    if (part.type === 'text') {
      return {
        type: role === 'assistant' ? 'output_text' : 'input_text',
        text: part.text || '',
      };
    }
    if (part.type === 'image_url') {
      return {
        type: 'input_image',
        image_url: typeof part.image_url === 'string' ? part.image_url : part.image_url?.url,
      };
    }
    return null;
  }).filter(Boolean);
}

function chatRequestToResponses(body) {
  const instructions = [];
  const input = [];
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = typeof message.content === 'string' ? message.content : extractTextFromContent(normalizeChatContentToResponses(message.content, message.role));
      if (text) {
        instructions.push(text);
      }
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      });
      continue;
    }
    const content = normalizeChatContentToResponses(message.content, message.role);
    if (content.length > 0) {
      input.push({
        type: 'message',
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content,
      });
    }
    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (toolCall.type === 'function' || toolCall.function) {
        input.push({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments || '{}',
        });
      }
    }
  }
  const responses = {
    model: body.model,
    instructions: instructions.join('\n\n'),
    input,
    stream: body.stream === true,
  };
  if (typeof body.max_tokens === 'number') {
    responses.max_output_tokens = body.max_tokens;
  }
  for (const field of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'user', 'stream_options']) {
    if (typeof body[field] !== 'undefined') {
      responses[field] = body[field];
    }
  }
  if (Array.isArray(body.tools)) {
    responses.tools = body.tools.map(tool => {
      if (tool.type !== 'function') {
        return null;
      }
      return {
        type: 'function',
        name: tool.function?.name,
        description: tool.function?.description || '',
        parameters: tool.function?.parameters || { type: 'object', properties: {} },
      };
    }).filter(Boolean);
  }
  if (body.tool_choice) {
    responses.tool_choice = body.tool_choice;
  }
  return responses;
}

function responsesContentToChatContent(content) {
  return extractTextFromContent(content);
}

function itemToChatMessages(item) {
  if (!item || typeof item !== 'object') {
    return [];
  }
  if (item.type === 'message') {
    return [{
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: responsesContentToChatContent(item.content),
    }];
  }
  if (item.type === 'function_call') {
    return [{
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: item.call_id || item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments || '{}',
        },
      }],
    }];
  }
  if (item.type === 'function_call_output') {
    return [{
      role: 'tool',
      tool_call_id: item.call_id || item.id,
      content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
    }];
  }
  if (item.type === 'reasoning') {
    const text = extractTextFromContent(item.content) || JSON.stringify(item.summary || '');
    return text ? [{ role: 'assistant', content: text }] : [];
  }
  return [];
}

function responsesRequestToChat(body, session = null) {
  const messages = [];
  if (body.instructions) {
    messages.push({
      role: 'system',
      content: body.instructions,
    });
  }
  const items = [
    ...(Array.isArray(session?.messages) ? session.messages : []),
    ...parseResponsesInput(body.input),
  ];
  for (const item of items) {
    messages.push(...itemToChatMessages(item));
  }
  const request = {
    model: body.model,
    messages,
    stream: body.stream === true,
  };
  if (typeof body.max_output_tokens === 'number') {
    request.max_tokens = body.max_output_tokens;
  }
  for (const field of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'user', 'stream_options']) {
    if (typeof body[field] !== 'undefined') {
      request[field] = body[field];
    }
  }
  if (Array.isArray(body.tools)) {
    request.tools = body.tools.map(tool => {
      if (!tool || tool.type !== 'function') {
        return null;
      }
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} },
        },
      };
    }).filter(Boolean);
  }
  if (body.tool_choice) {
    request.tool_choice = body.tool_choice;
  }
  return request;
}

function chatResponseToResponses(response, request = {}) {
  const output = [];
  const choice = Array.isArray(response?.choices) ? response.choices[0] : null;
  const message = choice?.message || {};
  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content }],
    });
  }
  for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    output.push({
      type: 'function_call',
      call_id: toolCall.id,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments || '{}',
    });
  }
  return normalizeResponsesResponse({
    id: response?.id && String(response.id).startsWith('resp_') ? response.id : undefined,
    model: response?.model || request.model,
    output,
    usage: responsesUsageFromChatUsage(response?.usage || {}),
  }, request);
}

function responsesResponseToChat(response, request = {}) {
  const normalized = normalizeResponsesResponse(response, request);
  const message = {
    role: 'assistant',
    content: extractOutputText(normalized) || null,
  };
  const toolCalls = [];
  for (const item of normalized.output) {
    if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id || item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: item.arguments || '{}',
        },
      });
    }
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  return {
    id: normalized.id.replace(/^resp_/, 'chatcmpl_'),
    object: 'chat.completion',
    created: normalized.created_at || Math.floor(Date.now() / 1000),
    model: normalized.model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: chatUsageFromResponsesUsage(normalized.usage || {}),
  };
}

function createResponsesToChatSseTransformer(request = {}) {
  const state = {
    id: null,
    model: request.model,
    started: false,
    toolCallIndexes: new Map(),
  };

  function chunk(delta, finishReason = null) {
    const payload = {
      id: (state.id || createResponseId()).replace(/^resp_/, 'chatcmpl_'),
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: state.model,
      choices: [{
        index: 0,
        delta,
        finish_reason: finishReason,
      }],
    };
    return {
      event: null,
      data: payload,
    };
  }

  return {
    accept(eventName, payload) {
      const emitted = [];
      if (eventName === 'response.created') {
        state.id = payload?.response?.id || state.id;
        state.model = payload?.response?.model || state.model;
        return emitted;
      }
      if (!state.started && (eventName === 'response.output_item.added' || eventName === 'response.content_part.added')) {
        state.started = true;
        emitted.push(chunk({ role: 'assistant' }));
      }
      if (eventName === 'response.output_text.delta') {
        emitted.push(chunk({ content: payload?.delta || '' }));
      }
      if (eventName === 'response.output_item.added' && payload?.item?.type === 'function_call') {
        const item = payload.item;
        const index = state.toolCallIndexes.size;
        state.toolCallIndexes.set(item.id || item.call_id, index);
        emitted.push(chunk({
          tool_calls: [{
            index,
            id: item.call_id || item.id,
            type: 'function',
            function: { name: item.name, arguments: '' },
          }],
        }));
      }
      if (eventName === 'response.function_call_arguments.delta') {
        emitted.push(chunk({
          tool_calls: [{
            index: state.toolCallIndexes.get(payload.item_id) || 0,
            function: { arguments: payload.delta || '' },
          }],
        }));
      }
      if (eventName === 'response.completed') {
        emitted.push(chunk({}, 'stop'));
      }
      return emitted;
    },
  };
}

module.exports = {
  chatRequestToResponses,
  chatResponseToResponses,
  createResponsesToChatSseTransformer,
  responsesRequestToChat,
  responsesResponseToChat,
};
