/**
 * Protocol bridge for explicit model routing.
 *
 * Same-protocol requests stay pass-through (only model/stream fields change).
 * Cross-protocol requests are normalized into a small canonical representation
 * covering text, images, tools, tool results and SSE deltas. Features that
 * cannot be represented faithfully (structured output, built-in tools,
 * encrypted reasoning, files, audio) are rejected explicitly instead of being
 * silently dropped.
 */

const SUPPORTED_PROTOCOLS = ['chat_completions', 'responses', 'messages'];

class UnsupportedProtocolFeatureError extends Error {
  constructor(message, code = 'unsupported_protocol_feature') {
    super(message);
    this.name = 'UnsupportedProtocolFeatureError';
    this.code = code;
  }
}

function normalizeEntryProtocol(pathOrProtocol) {
  if (SUPPORTED_PROTOCOLS.includes(pathOrProtocol)) {
    return pathOrProtocol;
  }

  if (typeof pathOrProtocol !== 'string') {
    return null;
  }

  const path = pathOrProtocol.split('?')[0].replace(/\/+$/, '');
  if (path.endsWith('/chat/completions')) {
    return 'chat_completions';
  }
  if (path.endsWith('/responses')) {
    return 'responses';
  }
  if (path.endsWith('/messages')) {
    return 'messages';
  }
  return null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function normalizeContentArray(content) {
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (Array.isArray(content)) {
    return content;
  }
  if (isPlainObject(content)) {
    return [content];
  }
  return [];
}

function contentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (block && (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
    return texts.join('\n');
  }
  if (isPlainObject(content)) {
    return typeof content.text === 'string' ? content.text : '';
  }
  return '';
}

function toolResultContentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = [];
    for (const block of content) {
      if (block && typeof block === 'object') {
        if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
          texts.push(block.text);
          continue;
        }
        if (block.type === 'image' || block.type === 'input_image' || block.type === 'image_url') {
          throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持工具结果中的图片');
        }
      }
    }
    return texts.join('\n');
  }
  if (isPlainObject(content)) {
    return typeof content.text === 'string' ? content.text : JSON.stringify(content);
  }
  return '';
}

function safeParseJson(text) {
  if (isPlainObject(text)) {
    return text;
  }
  if (typeof text !== 'string' || !text.trim()) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return {};
  }
}

function mapChatStopToCanonical(reason) {
  switch (reason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return reason || 'end_turn';
  }
}

function mapMessagesStopToCanonical(reason) {
  switch (reason) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return reason || 'end_turn';
  }
}

function mapCanonicalStopToChat(reason) {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
    default:
      return 'stop';
  }
}

function mapCanonicalStopToMessages(reason) {
  switch (reason) {
    case 'max_tokens':
      return 'max_tokens';
    case 'tool_use':
      return 'tool_use';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    case 'end_turn':
    default:
      return 'end_turn';
  }
}

function usageFromChat(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const inputTokens = Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputTokens = Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : 0;
  const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function usageFromMessages(usage, previous = null) {
  if (!usage || typeof usage !== 'object') {
    return previous;
  }
  const inputTokens = Number.isFinite(usage.input_tokens)
    ? usage.input_tokens
    : previous ? previous.inputTokens : 0;
  const outputTokens = Number.isFinite(usage.output_tokens)
    ? usage.output_tokens
    : previous ? previous.outputTokens : 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function usageFromResponses(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const inputTokens = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  const outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
  const totalTokens = Number.isFinite(usage.total_tokens) ? usage.total_tokens : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function imagePartFromChat(contentPart) {
  const imageValue = contentPart.image_url;
  const url = typeof imageValue === 'string'
    ? imageValue
    : imageValue && typeof imageValue.url === 'string'
      ? imageValue.url
      : '';
  if (!url) {
    throw new UnsupportedProtocolFeatureError('图片输入缺少 image_url');
  }
  return { type: 'image', url };
}

function imagePartFromMessages(block) {
  const source = block.source;
  if (!source || typeof source !== 'object') {
    throw new UnsupportedProtocolFeatureError('Claude 图片缺少 source');
  }
  if (source.type === 'base64' && source.media_type && source.data) {
    return { type: 'image', mediaType: source.media_type, data: source.data };
  }
  if (source.type === 'url' && source.url) {
    return { type: 'image', url: source.url };
  }
  throw new UnsupportedProtocolFeatureError('不支持的 Claude 图片 source');
}

function filePartFromMessages(block) {
  const source = block.source;
  if (!source || source.type !== 'base64' || !source.data) {
    throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持非 base64 文档');
  }
  return {
    type: 'file',
    filename: block.title || 'document',
    mediaType: source.media_type || 'application/octet-stream',
    data: source.data,
  };
}

function parseChatContent(content, role) {
  const parts = [];
  for (const block of normalizeContentArray(content)) {
    if (!block || typeof block !== 'object') {
      if (typeof block === 'string') {
        parts.push({ type: 'text', text: block });
      }
      continue;
    }
    if ((block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image_url' || Object.prototype.hasOwnProperty.call(block, 'image_url')) {
      parts.push(imagePartFromChat(block));
    } else if (block.type === 'input_image') {
      const url = typeof block.image_url === 'string' ? block.image_url : '';
      if (!url) {
        throw new UnsupportedProtocolFeatureError('图片输入缺少 image_url');
      }
      parts.push({ type: 'image', url });
    } else if (block.type === 'input_file' || block.type === 'file') {
      throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持文件输入');
    } else if (block.type === 'input_audio' || block.type === 'audio') {
      throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持音频输入');
    } else {
      throw new UnsupportedProtocolFeatureError(`跨协议路由无法保留消息内容类型: ${block.type || role}`);
    }
  }
  return parts;
}

function normalizeTools(tools, protocol) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools.map(tool => {
    if (!tool || typeof tool !== 'object') {
      throw new UnsupportedProtocolFeatureError('工具定义必须是对象');
    }

    const type = typeof tool.type === 'string' ? tool.type : '';
    if (type && type !== 'function' && type !== 'custom') {
      throw new UnsupportedProtocolFeatureError(`跨协议路由不支持内置工具: ${type}`);
    }

    if (tool.function && typeof tool.function === 'object') {
      return {
        name: tool.function.name,
        description: tool.function.description || '',
        inputSchema: tool.function.parameters || tool.function.input_schema || { type: 'object', properties: {} },
      };
    }

    if (protocol === 'messages') {
      return {
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.input_schema || { type: 'object', properties: {} },
      };
    }

    return {
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
    };
  });
}

function parseToolChoice(toolChoice) {
  if (!toolChoice) {
    return null;
  }
  if (typeof toolChoice === 'string') {
    return toolChoice === 'any' ? 'required' : toolChoice;
  }
  if (!isPlainObject(toolChoice)) {
    return null;
  }
  if (toolChoice.type === 'auto') {
    return 'auto';
  }
  if (toolChoice.type === 'any') {
    return 'required';
  }
  if (toolChoice.type === 'none') {
    return 'none';
  }
  if (toolChoice.type === 'required') {
    return 'required';
  }
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'tool', name: toolChoice.name };
  }
  if (toolChoice.type === 'function') {
    const name = toolChoice.name || (toolChoice.function && toolChoice.function.name);
    if (name) {
      return { type: 'tool', name };
    }
  }
  return null;
}

function parseChatRequest(body) {
  const canonical = {
    model: body.model,
    system: '',
    messages: [],
    tools: normalizeTools(body.tools, 'chat_completions'),
    toolChoice: parseToolChoice(body.tool_choice),
    maxOutputTokens: Number.isFinite(body.max_completion_tokens) ? body.max_completion_tokens : body.max_tokens,
    stream: body.stream === true,
    params: {},
  };

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') {
      continue;
    }

    if (message.role === 'system' || message.role === 'developer') {
      canonical.system = [canonical.system, contentToText(message.content)].filter(Boolean).join('\n\n');
      continue;
    }

    if (message.role === 'tool') {
      canonical.messages.push({
        role: 'user',
        parts: [{
          type: 'tool_result',
          toolUseId: message.tool_call_id,
          content: toolResultContentToText(message.content),
        }],
      });
      continue;
    }

    const parts = parseChatContent(message.content, message.role);
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      parts.push({
        type: 'tool_use',
        id: call.id,
        name: call.function && call.function.name,
        input: safeParseJson(call.function && call.function.arguments),
      });
    }
    canonical.messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', parts });
  }

  for (const name of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'user', 'stop', 'parallel_tool_calls', 'metadata']) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      canonical.params[name] = body[name];
    }
  }

  return canonical;
}

function parseMessagesRequest(body) {
  const canonical = {
    model: body.model,
    system: contentToText(body.system),
    messages: [],
    tools: normalizeTools(body.tools, 'messages'),
    toolChoice: parseToolChoice(body.tool_choice),
    maxOutputTokens: Number.isFinite(body.max_tokens) ? body.max_tokens : undefined,
    stream: body.stream === true,
    params: {},
  };

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (!message || typeof message !== 'object') {
      continue;
    }
    const parts = [];
    for (const block of normalizeContentArray(message.content)) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push(imagePartFromMessages(block));
      } else if (block.type === 'document') {
        parts.push(filePartFromMessages(block));
      } else if (block.type === 'tool_use') {
        parts.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input || {} });
      } else if (block.type === 'tool_result') {
        parts.push({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          content: toolResultContentToText(block.content),
        });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        throw new UnsupportedProtocolFeatureError('跨协议路由无法迁移 thinking/encrypted reasoning 内容');
      } else {
        throw new UnsupportedProtocolFeatureError(`跨协议路由无法保留 Claude 内容块: ${block.type}`);
      }
    }
    canonical.messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', parts });
  }

  if (body.thinking && typeof body.thinking === 'object') {
    throw new UnsupportedProtocolFeatureError('跨协议路由无法迁移 thinking 配置');
  }

  for (const name of ['temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata']) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      canonical.params[name] = body[name];
    }
  }

  return canonical;
}

function parseResponsesContent(content, role) {
  const parts = [];
  for (const block of normalizeContentArray(content)) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if ((block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'input_image' || block.type === 'image_url') {
      const url = typeof block.image_url === 'string'
        ? block.image_url
        : block.image_url && typeof block.image_url.url === 'string'
          ? block.image_url.url
          : '';
      if (!url) {
        throw new UnsupportedProtocolFeatureError('图片输入缺少 image_url');
      }
      parts.push({ type: 'image', url });
    } else if (block.type === 'input_file' || block.type === 'file') {
      throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持文件输入');
    } else if (block.type === 'input_audio' || block.type === 'audio') {
      throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持音频输入');
    } else {
      throw new UnsupportedProtocolFeatureError(`跨协议路由无法保留 Responses 内容类型: ${block.type || role}`);
    }
  }
  return parts;
}

function parseResponsesRequest(body) {
  const canonical = {
    model: body.model,
    system: typeof body.instructions === 'string' ? body.instructions : '',
    messages: [],
    tools: normalizeTools(body.tools, 'responses'),
    toolChoice: parseToolChoice(body.tool_choice),
    maxOutputTokens: Number.isFinite(body.max_output_tokens) ? body.max_output_tokens : body.max_tokens,
    stream: body.stream === true,
    params: {},
  };

  const input = body.input;
  if (typeof input === 'string') {
    canonical.messages.push({ role: 'user', parts: [{ type: 'text', text: input }] });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      if (item.type === 'message') {
        canonical.messages.push({
          role: item.role === 'assistant' ? 'assistant' : 'user',
          parts: parseResponsesContent(item.content, item.role),
        });
      } else if (item.type === 'function_call') {
        canonical.messages.push({
          role: 'assistant',
          parts: [{
            type: 'tool_use',
            id: item.call_id || item.id,
            name: item.name,
            input: safeParseJson(item.arguments),
          }],
        });
      } else if (item.type === 'function_call_output') {
        canonical.messages.push({
          role: 'user',
          parts: [{
            type: 'tool_result',
            toolUseId: item.call_id,
            content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
          }],
        });
      } else if (item.type === 'reasoning' || item.type === 'item_reference') {
        throw new UnsupportedProtocolFeatureError('跨协议路由无法迁移服务端 reasoning/item_reference 状态');
      } else {
        throw new UnsupportedProtocolFeatureError(`跨协议路由无法保留 Responses 输入类型: ${item.type}`);
      }
    }
  } else if (input !== undefined && input !== null) {
    throw new UnsupportedProtocolFeatureError('Responses input 必须是字符串或数组');
  }

  if (body.reasoning && typeof body.reasoning === 'object') {
    throw new UnsupportedProtocolFeatureError('跨协议路由无法迁移 reasoning 配置');
  }

  for (const name of ['temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'user']) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      canonical.params[name] = body[name];
    }
  }

  return canonical;
}

function parseEntryRequest(entryProtocol, body) {
  if (entryProtocol === 'chat_completions') {
    return parseChatRequest(body);
  }
  if (entryProtocol === 'messages') {
    return parseMessagesRequest(body);
  }
  if (entryProtocol === 'responses') {
    return parseResponsesRequest(body);
  }
  throw new UnsupportedProtocolFeatureError(`不支持的入口协议: ${entryProtocol}`);
}

function serializeToolChoice(toolChoice, targetProtocol) {
  if (!toolChoice) {
    return undefined;
  }
  if (typeof toolChoice === 'string') {
    if (targetProtocol === 'messages') {
      if (toolChoice === 'required') {
        return { type: 'any' };
      }
      if (toolChoice === 'auto' || toolChoice === 'none') {
        return { type: toolChoice };
      }
    }
    return toolChoice;
  }
  if (toolChoice.type === 'tool') {
    if (targetProtocol === 'messages') {
      return { type: 'tool', name: toolChoice.name };
    }
    if (targetProtocol === 'responses') {
      return { type: 'function', name: toolChoice.name };
    }
    return { type: 'function', function: { name: toolChoice.name } };
  }
  return undefined;
}

function serializeTools(tools, targetProtocol) {
  return tools.map(tool => {
    if (targetProtocol === 'messages') {
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema,
      };
    }
    if (targetProtocol === 'responses') {
      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema,
        strict: false,
      };
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema,
      },
    };
  });
}

function canonicalImageUrl(part) {
  if (part.url) {
    return part.url;
  }
  if (part.data && part.mediaType) {
    return `data:${part.mediaType};base64,${part.data}`;
  }
  throw new UnsupportedProtocolFeatureError('图片缺少可序列化的 URL 或 base64 数据');
}

function serializeChatRequest(canonical, targetModel, stream) {
  const messages = [];
  if (canonical.system) {
    messages.push({ role: 'system', content: canonical.system });
  }

  for (const message of canonical.messages) {
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        textParts.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        textParts.push({ type: 'image_url', image_url: { url: canonicalImageUrl(part) } });
      } else if (part.type === 'tool_use') {
        toolCalls.push({
          id: part.id,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input || {}),
          },
        });
      } else if (part.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: part.toolUseId,
          content: part.content || '',
        });
      } else if (part.type === 'file') {
        throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持文件输入');
      }
    }

    const onlyText = textParts.length === 1 && textParts[0].type === 'text';
    if (textParts.length > 0 || toolCalls.length > 0) {
      const payload = {
        role: message.role,
        content: onlyText ? textParts[0].text : textParts,
      };
      if (toolCalls.length > 0) {
        payload.tool_calls = toolCalls;
        if (onlyText && !textParts[0].text) {
          payload.content = null;
        }
      }
      messages.push(payload);
    }
    messages.push(...toolResults);
  }

  const result = {
    model: targetModel,
    messages,
    stream,
  };
  if (canonical.tools.length > 0) {
    result.tools = serializeTools(canonical.tools, 'chat_completions');
    const choice = serializeToolChoice(canonical.toolChoice, 'chat_completions');
    if (choice !== undefined) {
      result.tool_choice = choice;
    }
  }
  if (Number.isFinite(canonical.maxOutputTokens)) {
    result.max_tokens = canonical.maxOutputTokens;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'temperature')) {
    result.temperature = canonical.params.temperature;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'top_p')) {
    result.top_p = canonical.params.top_p;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'presence_penalty')) {
    result.presence_penalty = canonical.params.presence_penalty;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'frequency_penalty')) {
    result.frequency_penalty = canonical.params.frequency_penalty;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'seed')) {
    result.seed = canonical.params.seed;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'user')) {
    result.user = canonical.params.user;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'stop')) {
    result.stop = canonical.params.stop;
  }
  return result;
}

function serializeMessagesRequest(canonical, targetModel, stream) {
  const messages = [];
  for (const message of canonical.messages) {
    const content = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        if (part.data && part.mediaType) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: part.mediaType, data: part.data },
          });
        } else {
          content.push({ type: 'image', source: { type: 'url', url: part.url } });
        }
      } else if (part.type === 'file') {
        content.push({
          type: 'document',
          title: part.filename,
          source: { type: 'base64', media_type: part.mediaType, data: part.data },
        });
      } else if (part.type === 'tool_use') {
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input || {} });
      } else if (part.type === 'tool_result') {
        content.push({ type: 'tool_result', tool_use_id: part.toolUseId, content: part.content || '' });
      }
    }
    messages.push({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content,
    });
  }

  const result = {
    model: targetModel,
    system: canonical.system || undefined,
    messages,
    max_tokens: Number.isFinite(canonical.maxOutputTokens) ? canonical.maxOutputTokens : 4096,
    stream,
  };
  if (!result.system) {
    delete result.system;
  }
  if (canonical.tools.length > 0) {
    result.tools = serializeTools(canonical.tools, 'messages');
    const choice = serializeToolChoice(canonical.toolChoice, 'messages');
    if (choice !== undefined) {
      result.tool_choice = choice;
    }
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'temperature')) {
    result.temperature = canonical.params.temperature;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'top_p')) {
    result.top_p = canonical.params.top_p;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'top_k')) {
    result.top_k = canonical.params.top_k;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'stop_sequences')) {
    result.stop_sequences = canonical.params.stop_sequences;
  }
  return result;
}

function serializeResponsesRequest(canonical, targetModel, stream) {
  const input = [];
  for (const message of canonical.messages) {
    const content = [];
    for (const part of message.parts) {
      if (part.type === 'text') {
        content.push({
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: part.text,
        });
      } else if (part.type === 'image') {
        content.push({ type: 'input_image', image_url: canonicalImageUrl(part) });
      } else if (part.type === 'file') {
        content.push({
          type: 'input_file',
          filename: part.filename,
          file_data: `data:${part.mediaType};base64,${part.data}`,
        });
      } else if (part.type === 'tool_use') {
        input.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: JSON.stringify(part.input || {}),
        });
      } else if (part.type === 'tool_result') {
        input.push({
          type: 'function_call_output',
          call_id: part.toolUseId,
          output: part.content || '',
        });
      }
    }
    if (content.length > 0) {
      input.push({
        type: 'message',
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content,
      });
    }
  }

  const result = {
    model: targetModel,
    instructions: canonical.system || '',
    input,
    tools: serializeTools(canonical.tools, 'responses'),
    tool_choice: serializeToolChoice(canonical.toolChoice, 'responses') || 'auto',
    parallel_tool_calls: canonical.params.parallel_tool_calls === true,
    store: false,
    stream,
    include: [],
  };
  if (Number.isFinite(canonical.maxOutputTokens)) {
    result.max_output_tokens = canonical.maxOutputTokens;
  }
  if (!result.tools.length) {
    delete result.tools;
    delete result.tool_choice;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'temperature')) {
    result.temperature = canonical.params.temperature;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'top_p')) {
    result.top_p = canonical.params.top_p;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'metadata')) {
    result.metadata = canonical.params.metadata;
  }
  return result;
}

function hasStructuredOutput(body) {
  return Boolean(
    body &&
    (body.response_format ||
      (body.text && typeof body.text === 'object' && body.text.format) ||
      body.output_format ||
      (body.output_config && typeof body.output_config === 'object' && body.output_config.format)),
  );
}

function hasBuiltinTools(body) {
  return Boolean(body && Array.isArray(body.tools) && body.tools.some(tool => {
    const type = tool && typeof tool.type === 'string' ? tool.type : '';
    return type && type !== 'function' && type !== 'custom';
  }));
}

function hasReasoningState(body) {
  return Boolean(body && ((body.reasoning && typeof body.reasoning === 'object') || (body.thinking && typeof body.thinking === 'object')));
}

function assertCrossProtocolSupported(entryProtocol, targetProtocol, body) {
  if (entryProtocol === targetProtocol) {
    return;
  }

  if (hasStructuredOutput(body)) {
    throw new UnsupportedProtocolFeatureError('跨协议路由不支持结构化输出，请改用同协议候选');
  }
  if (hasBuiltinTools(body)) {
    throw new UnsupportedProtocolFeatureError('跨协议路由不支持内置服务端工具，请改用同协议候选');
  }
  if (hasReasoningState(body)) {
    throw new UnsupportedProtocolFeatureError('跨协议路由无法迁移 reasoning/thinking 状态');
  }
}

function transformRequestForTarget({ entryProtocol, targetProtocol, body, targetModel, stream }) {
  if (!SUPPORTED_PROTOCOLS.includes(entryProtocol) || !SUPPORTED_PROTOCOLS.includes(targetProtocol)) {
    throw new UnsupportedProtocolFeatureError('不支持的协议转换');
  }

  if (entryProtocol === targetProtocol) {
    const result = cloneJson(body);
    result.model = targetModel;
    if (targetProtocol !== 'messages' && !Object.prototype.hasOwnProperty.call(result, 'stream')) {
      result.stream = stream;
    } else if (targetProtocol === 'messages') {
      result.stream = stream;
    } else {
      result.stream = stream;
    }
    return result;
  }

  assertCrossProtocolSupported(entryProtocol, targetProtocol, body);
  const canonical = parseEntryRequest(entryProtocol, body);
  const result = targetProtocol === 'chat_completions'
    ? serializeChatRequest(canonical, targetModel, stream)
    : targetProtocol === 'messages'
      ? serializeMessagesRequest(canonical, targetModel, stream)
      : serializeResponsesRequest(canonical, targetModel, stream);
  return result;
}

function parseChatResponse(payload) {
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice) {
    throw new UnsupportedProtocolFeatureError('上游 chat.completions 响应缺少 choices');
  }
  const parts = [];
  const message = choice.message || {};
  const text = contentToText(message.content);
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    parts.push({
      type: 'tool_use',
      id: call.id,
      name: call.function && call.function.name,
      input: safeParseJson(call.function && call.function.arguments),
    });
  }
  return {
    id: payload.id || '',
    model: payload.model || '',
    createdAt: Number.isFinite(payload.created) ? payload.created : Math.floor(Date.now() / 1000),
    parts,
    stopReason: mapChatStopToCanonical(choice.finish_reason),
    usage: usageFromChat(payload.usage),
  };
}

function parseMessagesResponse(payload) {
  const parts = [];
  for (const block of Array.isArray(payload && payload.content) ? payload.content : []) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      parts.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input || {} });
    }
  }
  return {
    id: payload.id || '',
    model: payload.model || '',
    parts,
    stopReason: mapMessagesStopToCanonical(payload.stop_reason),
    usage: usageFromMessages(payload.usage),
  };
}

function parseResponsesResponse(payload) {
  const parts = [];
  for (const item of Array.isArray(payload && payload.output) ? payload.output : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if (item.type === 'message') {
      const text = contentToText(item.content);
      if (text) {
        parts.push({ type: 'text', text });
      }
    } else if (item.type === 'function_call') {
      parts.push({
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input: safeParseJson(item.arguments),
      });
    }
  }
  if (parts.length === 0 && typeof payload.output_text === 'string' && payload.output_text) {
    parts.push({ type: 'text', text: payload.output_text });
  }
  const stopReason = parts.some(part => part.type === 'tool_use')
    ? 'tool_use'
    : payload.incomplete_details && payload.incomplete_details.reason === 'max_output_tokens'
      ? 'max_tokens'
      : 'end_turn';
  return {
    id: payload.id || '',
    model: payload.model || '',
    createdAt: Number.isFinite(payload.created_at) ? payload.created_at : Math.floor(Date.now() / 1000),
    parts,
    stopReason,
    usage: usageFromResponses(payload.usage),
  };
}

function parseTargetResponse(targetProtocol, payload) {
  if (targetProtocol === 'chat_completions') {
    return parseChatResponse(payload);
  }
  if (targetProtocol === 'messages') {
    return parseMessagesResponse(payload);
  }
  if (targetProtocol === 'responses') {
    return parseResponsesResponse(payload);
  }
  throw new UnsupportedProtocolFeatureError(`不支持的响应协议: ${targetProtocol}`);
}

function responseIdFor(entryProtocol, upstreamId) {
  const id = typeof upstreamId === 'string' && upstreamId ? upstreamId : `airouter-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  if (entryProtocol === 'responses') {
    return id.startsWith('resp_') ? id : `resp_${id.replace(/^[^_]+[_-]?/, '')}`;
  }
  if (entryProtocol === 'messages') {
    return id.startsWith('msg_') ? id : `msg_${id.replace(/^[^_]+[_-]?/, '')}`;
  }
  return id.startsWith('chatcmpl-') ? id : `chatcmpl-${id}`;
}

function chatToolCalls(parts) {
  return parts
    .filter(part => part.type === 'tool_use')
    .map(part => ({
      id: part.id,
      type: 'function',
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input || {}),
      },
    }));
}

function serializeChatResponse(entryProtocol, canonical, publicModel) {
  const text = canonical.parts.filter(part => part.type === 'text').map(part => part.text).join('');
  const toolCalls = chatToolCalls(canonical.parts);
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }
  return {
    id: responseIdFor('chat_completions', canonical.id),
    object: 'chat.completion',
    created: canonical.createdAt || Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [{
      index: 0,
      message,
      finish_reason: mapCanonicalStopToChat(canonical.stopReason),
    }],
    usage: {
      prompt_tokens: canonical.usage ? canonical.usage.inputTokens : 0,
      completion_tokens: canonical.usage ? canonical.usage.outputTokens : 0,
      total_tokens: canonical.usage ? canonical.usage.totalTokens : 0,
    },
  };
}

function serializeMessagesResponse(entryProtocol, canonical, publicModel) {
  const content = canonical.parts.map(part => {
    if (part.type === 'text') {
      return { type: 'text', text: part.text };
    }
    return { type: 'tool_use', id: part.id, name: part.name, input: part.input || {} };
  });
  return {
    id: responseIdFor('messages', canonical.id),
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content,
    stop_reason: mapCanonicalStopToMessages(canonical.stopReason),
    stop_sequence: null,
    usage: {
      input_tokens: canonical.usage ? canonical.usage.inputTokens : 0,
      output_tokens: canonical.usage ? canonical.usage.outputTokens : 0,
    },
  };
}

function serializeResponsesResponse(entryProtocol, canonical, publicModel) {
  const output = [];
  const text = canonical.parts.filter(part => part.type === 'text').map(part => part.text).join('');
  if (text) {
    output.push({
      id: `msg_${responseIdFor('responses', canonical.id).replace(/^resp_/, '')}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    });
  }
  for (const part of canonical.parts.filter(item => item.type === 'tool_use')) {
    output.push({
      id: part.id,
      type: 'function_call',
      status: 'completed',
      call_id: part.id,
      name: part.name,
      arguments: JSON.stringify(part.input || {}),
    });
  }
  return {
    id: responseIdFor('responses', canonical.id),
    object: 'response',
    created_at: canonical.createdAt || Math.floor(Date.now() / 1000),
    status: canonical.stopReason === 'max_tokens' ? 'incomplete' : 'completed',
    ...(canonical.stopReason === 'max_tokens'
      ? { incomplete_details: { reason: 'max_output_tokens' } }
      : {}),
    model: publicModel,
    output,
    output_text: text,
    usage: {
      input_tokens: canonical.usage ? canonical.usage.inputTokens : 0,
      output_tokens: canonical.usage ? canonical.usage.outputTokens : 0,
      total_tokens: canonical.usage ? canonical.usage.totalTokens : 0,
    },
  };
}

function transformResponseForEntry({ entryProtocol, targetProtocol, payload, publicModel }) {
  if (entryProtocol === targetProtocol) {
    const result = cloneJson(payload);
    rewriteModelInPayload(entryProtocol, result, publicModel);
    return result;
  }

  const canonical = parseTargetResponse(targetProtocol, payload);
  return serializeCanonicalResponse(entryProtocol, canonical, publicModel);
}

function serializeCanonicalResponse(entryProtocol, canonical, publicModel) {
  if (entryProtocol === 'chat_completions') {
    return serializeChatResponse(entryProtocol, canonical, publicModel);
  }
  if (entryProtocol === 'messages') {
    return serializeMessagesResponse(entryProtocol, canonical, publicModel);
  }
  return serializeResponsesResponse(entryProtocol, canonical, publicModel);
}

function rewriteModelInPayload(protocol, payload, publicModel) {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'model')) {
    payload.model = publicModel;
  }
  if (payload.message && typeof payload.message === 'object' && Object.prototype.hasOwnProperty.call(payload.message, 'model')) {
    payload.message.model = publicModel;
  }
  if (payload.response && typeof payload.response === 'object' && Object.prototype.hasOwnProperty.call(payload.response, 'model')) {
    payload.response.model = publicModel;
  }
  return payload;
}

function createSseEventParser() {
  let buffer = '';
  let lastEventName = '';

  function parseBlock(block) {
    const lines = block.split('\n');
    let eventName = lastEventName;
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
        lastEventName = eventName;
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const dataText = dataLines.join('\n');
    if (!dataText) {
      return null;
    }
    let data = null;
    let raw = null;
    if (dataText === '[DONE]') {
      raw = '[DONE]';
    } else {
      try {
        data = JSON.parse(dataText);
      } catch (err) {
        data = null;
      }
    }
    return {
      event: eventName || '',
      data,
      dataText,
      raw,
    };
  }

  return {
    push(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const events = [];
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match) {
          break;
        }
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (!block.trim()) {
          continue;
        }
        const parsed = parseBlock(block);
        if (parsed) {
          events.push(parsed);
        }
      }
      return events;
    },
    finish() {
      if (!buffer.trim()) {
        buffer = '';
        return [];
      }
      const block = buffer.trim();
      buffer = '';
      const parsed = parseBlock(block);
      return parsed ? [parsed] : [];
    },
  };
}

function createSameProtocolSseRewriter(protocol, publicModel) {
  return {
    accept(eventName, payload) {
      const data = rewriteModelInPayload(protocol, cloneJson(payload), publicModel);
      return [{ event: eventName || null, data }];
    },
    finish() {
      return [];
    },
  };
}

function canonicalEventStart(accumulator, payload, fallbackModel = '') {
  if (accumulator.id) {
    return [];
  }
  accumulator.id = payload.id || payload.response?.id || '';
  accumulator.createdAt = payload.created || payload.created_at || Math.floor(Date.now() / 1000);
  accumulator.model = payload.model || payload.response?.model || fallbackModel;
  return [{
    type: 'start',
    id: accumulator.id,
    model: accumulator.model,
    createdAt: accumulator.createdAt,
  }];
}

function accumulateCanonicalEvent(accumulator, event) {
  if (!event) {
    return;
  }
  if (event.type === 'start') {
    accumulator.id = event.id || accumulator.id;
    accumulator.createdAt = event.createdAt || accumulator.createdAt;
    accumulator.model = event.model || accumulator.model;
  } else if (event.type === 'text_delta') {
    accumulator.text += event.text || '';
  } else if (event.type === 'tool_start') {
    const index = Number(event.index);
    if (!accumulator.tools.has(index)) {
      accumulator.toolOrder.push(index);
    }
    accumulator.tools.set(index, {
      id: event.id,
      name: event.name,
      arguments: '',
    });
  } else if (event.type === 'tool_args_delta') {
    const tool = accumulator.tools.get(Number(event.index));
    if (tool) {
      tool.arguments += event.partial || '';
    }
  } else if (event.type === 'finish') {
    accumulator.stopReason = event.stopReason || accumulator.stopReason;
    accumulator.usage = event.usage || accumulator.usage;
    accumulator.finished = true;
  }
}

function createCanonicalAccumulator(publicModel) {
  const accumulator = {
    id: '',
    model: publicModel || '',
    createdAt: Math.floor(Date.now() / 1000),
    text: '',
    tools: new Map(),
    toolOrder: [],
    stopReason: 'end_turn',
    usage: null,
    finished: false,
  };

  return {
    accumulator,
    accept(event) {
      if (accumulator.finished && event && event.type !== 'finish') {
        return;
      }
      accumulateCanonicalEvent(accumulator, event);
    },
    build() {
      const parts = [];
      if (accumulator.text) {
        parts.push({ type: 'text', text: accumulator.text });
      }
      for (const index of accumulator.toolOrder) {
        const tool = accumulator.tools.get(index);
        if (tool) {
          parts.push({
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: safeParseJson(tool.arguments),
          });
        }
      }
      const stopReason = accumulator.stopReason === 'end_turn' && accumulator.toolOrder.length
        ? 'tool_use'
        : accumulator.stopReason;
      return {
        id: accumulator.id,
        model: publicModel || accumulator.model,
        createdAt: accumulator.createdAt,
        parts,
        stopReason,
        usage: accumulator.usage,
      };
    },
  };
}

function collectCanonicalEvents(events, publicModel = '') {
  const accumulator = createCanonicalAccumulator(publicModel);
  for (const event of events) {
    accumulator.accept(event);
  }
  return accumulator.build();
}

function createTargetEventParser(targetProtocol, publicModel) {
  const accumulator = createCanonicalAccumulator(publicModel);
  const toolIndexes = new Map();
  let nextToolIndex = 0;
  let sawFinish = false;
  let pendingChatFinish = null;

  function emit(events) {
    for (const event of events) {
      accumulator.accept(event);
    }
    return events;
  }

  function resolveToolIndex(indexValue) {
    const key = String(indexValue ?? `next_${nextToolIndex}`);
    if (!toolIndexes.has(key)) {
      toolIndexes.set(key, nextToolIndex);
      nextToolIndex += 1;
    }
    return toolIndexes.get(key);
  }

  function parse(eventName, payload) {
    if (!payload || typeof payload !== 'object') {
      return [];
    }

    if (payload.error) {
      return emit([{
        type: 'error',
        message: payload.error.message || String(payload.error),
        code: payload.error.code || 'upstream_error',
      }]);
    }

    if (targetProtocol === 'chat_completions') {
      const events = [];
      if (!accumulator.accumulator.id) {
        events.push(...canonicalEventStart(accumulator.accumulator, payload));
      }
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (choice) {
        const delta = choice.delta || choice.message || {};
        const text = contentToText(delta.content);
        if (text) {
          events.push({ type: 'text_delta', text });
        }
        for (const [callIndex, call] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
          const index = resolveToolIndex(call.index ?? callIndex);
          if (call.id || call.function?.name) {
            events.push({
              type: 'tool_start',
              index,
              id: call.id || `call_${index + 1}`,
              name: call.function?.name || 'tool',
            });
          }
          if (typeof call.function?.arguments === 'string' && call.function.arguments) {
            events.push({ type: 'tool_args_delta', index, partial: call.function.arguments });
          }
        }
        if (choice.finish_reason) {
          pendingChatFinish = {
            stopReason: mapChatStopToCanonical(choice.finish_reason),
          };
          if (payload.usage) {
            sawFinish = true;
            events.push({
              type: 'finish',
              stopReason: pendingChatFinish.stopReason,
              usage: usageFromChat(payload.usage),
            });
            pendingChatFinish = null;
          }
        }
      }
      if (payload.usage) {
        accumulator.accumulator.usage = usageFromChat(payload.usage) || accumulator.accumulator.usage;
        if (pendingChatFinish) {
          sawFinish = true;
          events.push({
            type: 'finish',
            stopReason: pendingChatFinish.stopReason,
            usage: accumulator.accumulator.usage,
          });
          pendingChatFinish = null;
        }
      }
      return emit(events);
    }

    if (targetProtocol === 'responses') {
      const events = [];
      const type = payload.type || eventName;
      if (type === 'response.created' || type === 'response.in_progress') {
        events.push(...canonicalEventStart(accumulator.accumulator, payload.response || payload));
      } else if (type === 'response.output_item.added') {
        if (!accumulator.accumulator.id) {
          events.push(...canonicalEventStart(accumulator.accumulator, payload.response || {}));
        }
        const item = payload.item || {};
        if (item.type === 'function_call') {
          events.push({
            type: 'tool_start',
            index: resolveToolIndex(item.id || item.call_id || payload.output_index),
            id: item.call_id || item.id,
            name: item.name,
          });
        }
      } else if (type === 'response.output_text.delta') {
        events.push({ type: 'text_delta', text: payload.delta || '' });
      } else if (type === 'response.output_text.done' && !accumulator.accumulator.text && payload.text) {
        events.push({ type: 'text_delta', text: payload.text });
      } else if (type === 'response.function_call_arguments.delta') {
        events.push({
          type: 'tool_args_delta',
          index: resolveToolIndex(payload.item_id),
          partial: payload.delta || '',
        });
      } else if (type === 'response.output_item.done') {
        const item = payload.item || {};
        if (item.type === 'function_call') {
          const index = resolveToolIndex(item.id || item.call_id || payload.output_index);
          if (!accumulator.accumulator.tools.get(index)?.arguments && item.arguments) {
            events.push({ type: 'tool_args_delta', index, partial: item.arguments });
          }
          events.push({ type: 'tool_end', index });
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const response = payload.response || {};
        if (!accumulator.accumulator.text) {
          const responseText = typeof response.output_text === 'string' && response.output_text
            ? response.output_text
            : contentToText(
              Array.isArray(response.output)
                ? response.output.flatMap(item => (item && item.type === 'message' && Array.isArray(item.content) ? item.content : []))
                : [],
            );
          if (responseText) {
            events.push({ type: 'text_delta', text: responseText });
          }
        }
        const usage = usageFromResponses(response.usage) || accumulator.accumulator.usage;
        const hasTool = Array.isArray(response.output) && response.output.some(item => item.type === 'function_call');
        const stopReason = hasTool
          ? 'tool_use'
          : response.incomplete_details && response.incomplete_details.reason === 'max_output_tokens'
            ? 'max_tokens'
            : 'end_turn';
        events.push({ type: 'finish', stopReason, usage });
      } else if (type === 'response.failed') {
        events.push({
          type: 'error',
          message: payload.response?.error?.message || '上游 Responses 响应失败',
          code: payload.response?.error?.code || 'upstream_error',
        });
      } else if (type === 'response.output_text.done' && !accumulator.accumulator.text && payload.text) {
        events.push({ type: 'text_delta', text: payload.text });
      }
      return emit(events);
    }

    const type = payload.type || eventName;
    const events = [];
    if (type === 'message_start') {
      events.push(...canonicalEventStart(accumulator.accumulator, payload.message || {}));
      if (payload.message?.usage) {
        accumulator.accumulator.usage = usageFromMessages(payload.message.usage);
      }
    } else if (type === 'content_block_start') {
      if (!accumulator.accumulator.id) {
        events.push(...canonicalEventStart(accumulator.accumulator, {}));
      }
      const block = payload.content_block || {};
      if (block.type === 'tool_use') {
        events.push({
          type: 'tool_start',
          index: resolveToolIndex(payload.index),
          id: block.id,
          name: block.name,
        });
      } else if (block.type === 'text' && block.text) {
        events.push({ type: 'text_delta', text: block.text });
      }
    } else if (type === 'content_block_delta') {
      const delta = payload.delta || {};
      if (delta.type === 'text_delta') {
        events.push({ type: 'text_delta', text: delta.text || '' });
      } else if (delta.type === 'input_json_delta') {
        events.push({
          type: 'tool_args_delta',
          index: resolveToolIndex(payload.index),
          partial: delta.partial_json || '',
        });
      }
    } else if (type === 'content_block_stop') {
      const index = toolIndexes.get(String(payload.index));
      if (typeof index === 'number') {
        events.push({ type: 'tool_end', index });
      }
    } else if (type === 'message_delta') {
      accumulator.accumulator.usage = usageFromMessages(payload.usage, accumulator.accumulator.usage);
      events.push({
        type: 'finish',
        stopReason: mapMessagesStopToCanonical(payload.delta?.stop_reason),
        usage: accumulator.accumulator.usage,
      });
    } else if (type === 'message_stop') {
      if (!sawFinish) {
        events.push({
          type: 'finish',
          stopReason: accumulator.accumulator.toolOrder.length ? 'tool_use' : 'end_turn',
          usage: accumulator.accumulator.usage,
        });
      }
    } else if (type === 'error') {
      events.push({
        type: 'error',
        message: payload.error?.message || '上游 Messages 响应失败',
        code: payload.error?.type || 'upstream_error',
      });
    }

    if (type === 'message_delta') {
      sawFinish = true;
    }
    return emit(events);
  }

  return {
    accept(eventName, payload) {
      return parse(eventName, payload);
    },
    finish() {
      if (sawFinish) {
        return [];
      }
      if (pendingChatFinish) {
        sawFinish = true;
        const finish = {
          type: 'finish',
          stopReason: pendingChatFinish.stopReason,
          usage: accumulator.accumulator.usage,
        };
        pendingChatFinish = null;
        return emit([finish]);
      }
      sawFinish = true;
      return emit([{
        type: 'finish',
        stopReason: accumulator.accumulator.toolOrder.length ? 'tool_use' : 'end_turn',
        usage: accumulator.accumulator.usage,
      }]);
    },
    build() {
      return accumulator.build();
    },
    isComplete() {
      return accumulator.accumulator.finished;
    },
  };
}

function createEntryEventSerializer(entryProtocol, publicModel) {
  const state = {
    started: false,
    finished: false,
    responseId: responseIdFor(entryProtocol, undefined),
    createdAt: Math.floor(Date.now() / 1000),
    text: '',
    tools: new Map(),
    toolOrder: [],
    openTextBlock: false,
    nextBlockIndex: 0,
    textBlockIndex: null,
    toolBlockIndexes: new Map(),
    responseOutputItems: new Map(),
    nextOutputIndex: 0,
    textOutputIndex: null,
    textItemId: null,
    usage: null,
    stopReason: 'end_turn',
  };

  function ensureStarted(canonicalEvent = {}) {
    const events = [];
    if (state.started) {
      return events;
    }
    state.started = true;
    if (canonicalEvent.id) {
      state.responseId = responseIdFor(entryProtocol, canonicalEvent.id);
    }
    if (canonicalEvent.createdAt) {
      state.createdAt = canonicalEvent.createdAt;
    }

    if (entryProtocol === 'chat_completions') {
      events.push({
        event: null,
        data: {
          id: state.responseId,
          object: 'chat.completion.chunk',
          created: state.createdAt,
          model: publicModel,
          choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
        },
      });
    } else if (entryProtocol === 'messages') {
      events.push({
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: state.responseId,
            type: 'message',
            role: 'assistant',
            model: publicModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: state.usage ? state.usage.inputTokens : 0, output_tokens: 0 },
          },
        },
      });
    } else {
      events.push({
        event: 'response.created',
        data: {
          type: 'response.created',
          response: {
            id: state.responseId,
            object: 'response',
            created_at: state.createdAt,
            status: 'in_progress',
            model: publicModel,
            output: [],
            usage: null,
          },
        },
      });
    }
    return events;
  }

  function allocateTextBlock() {
    if (state.textBlockIndex !== null) {
      return state.textBlockIndex;
    }
    state.textBlockIndex = state.nextBlockIndex++;
    state.openTextBlock = true;
    return state.textBlockIndex;
  }

  function handleText(text) {
    const events = ensureStarted();
    state.text += text;
    if (entryProtocol === 'chat_completions') {
      events.push({
        event: null,
        data: {
          id: state.responseId,
          object: 'chat.completion.chunk',
          created: state.createdAt,
          model: publicModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        },
      });
    } else if (entryProtocol === 'messages') {
      const index = allocateTextBlock();
      if (state.openTextBlock) {
        events.push({
          event: 'content_block_start',
          data: { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        });
        state.openTextBlock = false;
      }
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text },
        },
      });
    } else {
      if (state.textOutputIndex === null) {
        state.textOutputIndex = state.nextOutputIndex++;
        state.textItemId = `msg_${state.responseId.replace(/^resp_/, '')}`;
        events.push({
          event: 'response.output_item.added',
          data: {
            type: 'response.output_item.added',
            output_index: state.textOutputIndex,
            item: {
              id: state.textItemId,
              type: 'message',
              status: 'in_progress',
              role: 'assistant',
              content: [],
            },
          },
        });
        events.push({
          event: 'response.content_part.added',
          data: {
            type: 'response.content_part.added',
            item_id: state.textItemId,
            output_index: state.textOutputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
        });
      }
      events.push({
        event: 'response.output_text.delta',
        data: {
          type: 'response.output_text.delta',
          item_id: state.textItemId,
          output_index: state.textOutputIndex,
          content_index: 0,
          delta: text,
        },
      });
    }
    return events;
  }

  function handleToolStart(event) {
    const events = ensureStarted();
    const tool = {
      id: event.id,
      name: event.name,
      args: '',
      outputIndex: null,
    };
    state.tools.set(event.index, tool);
    state.toolOrder.push(event.index);

    if (entryProtocol === 'chat_completions') {
      events.push({
        event: null,
        data: {
          id: state.responseId,
          object: 'chat.completion.chunk',
          created: state.createdAt,
          model: publicModel,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: event.index,
                id: event.id,
                type: 'function',
                function: { name: event.name, arguments: '' },
              }],
            },
            finish_reason: null,
          }],
        },
      });
    } else if (entryProtocol === 'messages') {
      const blockIndex = state.nextBlockIndex++;
      state.toolBlockIndexes.set(event.index, blockIndex);
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: blockIndex,
          content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
        },
      });
    } else {
      const outputIndex = state.nextOutputIndex++;
      tool.outputIndex = outputIndex;
      events.push({
        event: 'response.output_item.added',
        data: {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: {
            id: event.id,
            type: 'function_call',
            status: 'in_progress',
            call_id: event.id,
            name: event.name,
            arguments: '',
          },
        },
      });
    }
    return events;
  }

  function handleToolArgs(event) {
    const tool = state.tools.get(event.index);
    if (!tool) {
      return [];
    }
    tool.args += event.partial || '';
    const events = [];
    if (entryProtocol === 'chat_completions') {
      events.push({
        event: null,
        data: {
          id: state.responseId,
          object: 'chat.completion.chunk',
          created: state.createdAt,
          model: publicModel,
          choices: [{
            index: 0,
            delta: { tool_calls: [{ index: event.index, function: { arguments: event.partial || '' } }] },
            finish_reason: null,
          }],
        },
      });
    } else if (entryProtocol === 'messages') {
      const blockIndex = state.toolBlockIndexes.get(event.index);
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: event.partial || '' },
        },
      });
    } else {
      events.push({
        event: 'response.function_call_arguments.delta',
        data: {
          type: 'response.function_call_arguments.delta',
          item_id: tool.id,
          output_index: tool.outputIndex,
          delta: event.partial || '',
        },
      });
    }
    return events;
  }

  function handleToolEnd(event) {
    const tool = state.tools.get(event.index);
    if (!tool) {
      return [];
    }
    const events = [];
    if (entryProtocol === 'messages') {
      const blockIndex = state.toolBlockIndexes.get(event.index);
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: blockIndex },
      });
    } else if (entryProtocol === 'responses') {
      events.push({
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: tool.outputIndex,
          item: {
            id: tool.id,
            type: 'function_call',
            status: 'completed',
            call_id: tool.id,
            name: tool.name,
            arguments: tool.args,
          },
        },
      });
    }
    return events;
  }

  function handleFinish(event) {
    if (state.finished) {
      return [];
    }
    state.finished = true;
    state.usage = event.usage || state.usage;
    state.stopReason = event.stopReason || state.stopReason;
    const events = ensureStarted();
    const text = state.text;

    if (entryProtocol === 'chat_completions') {
      events.push({
        event: null,
        data: {
          id: state.responseId,
          object: 'chat.completion.chunk',
          created: state.createdAt,
          model: publicModel,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: mapCanonicalStopToChat(state.stopReason),
          }],
          usage: state.usage ? {
            prompt_tokens: state.usage.inputTokens,
            completion_tokens: state.usage.outputTokens,
            total_tokens: state.usage.totalTokens,
          } : undefined,
        },
      });
      events.push({ event: null, raw: '[DONE]' });
      return events;
    }

    if (entryProtocol === 'messages') {
      if (state.textBlockIndex !== null) {
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: state.textBlockIndex },
        });
      }
      events.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: {
            stop_reason: mapCanonicalStopToMessages(state.stopReason),
            stop_sequence: null,
          },
          usage: {
            input_tokens: state.usage ? state.usage.inputTokens : 0,
            output_tokens: state.usage ? state.usage.outputTokens : 0,
          },
        },
      });
      events.push({ event: 'message_stop', data: { type: 'message_stop' } });
      return events;
    }

    if (state.textOutputIndex !== null) {
      events.push({
        event: 'response.output_text.done',
        data: {
          type: 'response.output_text.done',
          item_id: state.textItemId,
          output_index: state.textOutputIndex,
          content_index: 0,
          text,
        },
      });
      events.push({
        event: 'response.content_part.done',
        data: {
          type: 'response.content_part.done',
          item_id: state.textItemId,
          output_index: state.textOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        },
      });
      events.push({
        event: 'response.output_item.done',
        data: {
          type: 'response.output_item.done',
          output_index: state.textOutputIndex,
          item: {
            id: state.textItemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        },
      });
    }

    const output = [];
    if (state.textOutputIndex !== null) {
      output.push({
        id: state.textItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    for (const index of state.toolOrder) {
      const tool = state.tools.get(index);
      if (tool) {
        output.push({
          id: tool.id,
          type: 'function_call',
          status: 'completed',
          call_id: tool.id,
          name: tool.name,
          arguments: tool.args,
        });
      }
    }
    events.push({
      event: 'response.completed',
      data: {
        type: 'response.completed',
        response: {
          id: state.responseId,
          object: 'response',
          created_at: state.createdAt,
          status: 'completed',
          model: publicModel,
          output,
          output_text: text,
          usage: {
            input_tokens: state.usage ? state.usage.inputTokens : 0,
            output_tokens: state.usage ? state.usage.outputTokens : 0,
            total_tokens: state.usage ? state.usage.totalTokens : 0,
          },
        },
      },
    });
    return events;
  }

  return {
    handle(event) {
      if (!event || state.finished) {
        return [];
      }
      if (event.type === 'start') {
        return ensureStarted(event);
      }
      if (event.type === 'text_delta') {
        return handleText(event.text || '');
      }
      if (event.type === 'tool_start') {
        return handleToolStart(event);
      }
      if (event.type === 'tool_args_delta') {
        return handleToolArgs(event);
      }
      if (event.type === 'tool_end') {
        return handleToolEnd(event);
      }
      if (event.type === 'finish') {
        return handleFinish(event);
      }
      if (event.type === 'error') {
        state.finished = true;
        return [{ event: 'error', data: { type: 'error', error: { type: 'upstream_error', message: event.message, code: event.code } } }];
      }
      return [];
    },
    finish() {
      return handleFinish({ stopReason: state.toolOrder.length ? 'tool_use' : 'end_turn', usage: state.usage });
    },
  };
}

function createProtocolStreamBridge({ entryProtocol, targetProtocol, publicModel }) {
  const targetParser = createTargetEventParser(targetProtocol, publicModel);
  const entrySerializer = createEntryEventSerializer(entryProtocol, publicModel);
  let finished = false;

  return {
    accept(eventName, payload) {
      if (finished) {
        return [];
      }
      const canonicalEvents = targetParser.accept(eventName, payload);
      const output = [];
      for (const event of canonicalEvents) {
        output.push(...entrySerializer.handle(event));
      }
      return output;
    },
    finish() {
      if (finished) {
        return [];
      }
      finished = true;
      const output = [];
      for (const event of targetParser.finish()) {
        output.push(...entrySerializer.handle(event));
      }
      output.push(...entrySerializer.finish());
      return output;
    },
    getCanonicalResponse() {
      return targetParser.build();
    },
    isComplete() {
      return targetParser.isComplete();
    },
  };
}

const CANONICAL_RESPONSE_EVENTS = [
  { type: 'start' },
  { type: 'text_delta' },
  { type: 'tool_start' },
  { type: 'tool_args_delta' },
  { type: 'tool_end' },
  { type: 'finish' },
];

function responseToEntrySse(entryProtocol, canonicalResponse, publicModel) {
  const serializer = createEntryEventSerializer(entryProtocol, publicModel);
  const events = [];
  events.push(...serializer.handle({
    type: 'start',
    id: canonicalResponse.id,
    model: publicModel,
    createdAt: canonicalResponse.createdAt,
  }));

  let toolIndex = 0;
  for (const part of canonicalResponse.parts || []) {
    if (part.type === 'text') {
      events.push(...serializer.handle({ type: 'text_delta', text: part.text }));
    } else if (part.type === 'tool_use') {
      const index = toolIndex;
      toolIndex += 1;
      events.push(...serializer.handle({
        type: 'tool_start',
        index,
        id: part.id,
        name: part.name,
      }));
      events.push(...serializer.handle({
        type: 'tool_args_delta',
        index,
        partial: JSON.stringify(part.input || {}),
      }));
      events.push(...serializer.handle({ type: 'tool_end', index }));
    }
  }

  events.push(...serializer.handle({
    type: 'finish',
    stopReason: canonicalResponse.stopReason,
    usage: canonicalResponse.usage,
  }));
  events.push(...serializer.finish());
  return events;
}

module.exports = {
  SUPPORTED_PROTOCOLS,
  UnsupportedProtocolFeatureError,
  normalizeEntryProtocol,
  transformRequestForTarget,
  transformResponseForEntry,
  serializeCanonicalResponse,
  parseTargetResponse,
  rewriteModelInPayload,
  createSseEventParser,
  createSameProtocolSseRewriter,
  createProtocolStreamBridge,
  responseToEntrySse,
  collectCanonicalEvents,
};
