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

const { StringDecoder } = require('node:string_decoder');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { mapCrossProtocolControls } = require('./protocol-request-controls');
const { UnsupportedProtocolFeatureError } = require('./protocol-errors');
const { REASONING_TRANSPORT, parseSourceReasoning, renderReasoning, parseClientReasoning, hasBridgeReasoning, restoreReasoning } = require('./reasoning-content');
const SUPPORTED_PROTOCOLS = ['chat_completions', 'responses', 'messages'];

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
      return 'content_filter';
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
    case 'model_context_window_exceeded':
      return 'model_context_window_exceeded';
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
    case 'model_context_window_exceeded':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
    case 'content_filter':
      return 'content_filter';
    case 'end_turn':
    case 'stop_sequence':
    case undefined:
    case null:
      return 'stop';
    default:
      throw new UnsupportedProtocolFeatureError(`无法保真转换为 Chat 终态: ${reason}`);
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
    case 'content_filter':
      return 'refusal';
    case 'end_turn':
      return 'end_turn';
    default:
      return reason || 'end_turn';
  }
}

function usageFromChat(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  return canonicalUsage(usage, 'prompt_tokens', 'completion_tokens', 'prompt_tokens_details', 'completion_tokens_details');
}

function usageFromMessages(usage, previous = null) {
  if (!usage || typeof usage !== 'object') {
    return previous;
  }
  const result = { ...(previous || {}), sourceProtocol: 'messages', rawUsage: { ...(previous?.rawUsage || {}), ...cloneJson(usage) } };
  if (Number.isFinite(usage.cache_read_input_tokens)) result.cacheReadTokens = usage.cache_read_input_tokens;
  if (Number.isFinite(usage.cache_creation_input_tokens)) result.cacheWriteTokens = usage.cache_creation_input_tokens;
  if (usage.cache_creation) result.messagesCacheCreation = cloneJson(usage.cache_creation);
  if (Number.isFinite(usage.input_tokens)) result.uncachedInputTokens = usage.input_tokens;
  if (Number.isFinite(result.uncachedInputTokens) && Number.isFinite(result.cacheReadTokens) && Number.isFinite(result.cacheWriteTokens)) result.inputTokens = result.uncachedInputTokens + result.cacheReadTokens + result.cacheWriteTokens;
  if (Number.isFinite(usage.output_tokens)) result.outputTokens = usage.output_tokens;
  if (Number.isFinite(result.inputTokens) && Number.isFinite(result.outputTokens)) result.totalTokens = result.inputTokens + result.outputTokens;
  return result;
}

function usageFromResponses(usage) {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  return canonicalUsage(usage, 'input_tokens', 'output_tokens', 'input_tokens_details', 'output_tokens_details');
}

// OpenAI input totals already include cached reads/writes. Claude reports its
// non-cached input separately; usageFromMessages adds those buckets once.
function canonicalUsage(usage, input, output, inputDetails, outputDetails) {
  const result = { sourceProtocol: input === 'prompt_tokens' ? 'chat_completions' : 'responses', rawUsage: cloneJson(usage) };
  if (Number.isFinite(usage[input])) result.inputTokens = usage[input];
  if (Number.isFinite(usage[output])) result.outputTokens = usage[output];
  if (Number.isFinite(usage.total_tokens)) result.totalTokens = usage.total_tokens;
  else if (Number.isFinite(result.inputTokens) && Number.isFinite(result.outputTokens)) result.totalTokens = result.inputTokens + result.outputTokens;
  if (isPlainObject(usage[inputDetails])) {
    result.inputDetails = cloneJson(usage[inputDetails]);
    if (Number.isFinite(usage[inputDetails].cached_tokens)) result.cacheReadTokens = usage[inputDetails].cached_tokens;
    if (Number.isFinite(usage[inputDetails].cache_write_tokens)) result.cacheWriteTokens = usage[inputDetails].cache_write_tokens;
  }
  if (isPlainObject(usage[outputDetails])) result.outputDetails = cloneJson(usage[outputDetails]);
  return result;
}

function serializeUsage(usage, protocol) {
  if (!usage) return undefined;
  if (protocol === usage.sourceProtocol && usage.rawUsage) return cloneJson(usage.rawUsage);
  const result = {};
  const inputKey = protocol === 'chat_completions' ? 'prompt_tokens' : 'input_tokens';
  const outputKey = protocol === 'chat_completions' ? 'completion_tokens' : 'output_tokens';
  if (Number.isFinite(usage.inputTokens)) {
    if (protocol !== 'messages') result[inputKey] = usage.inputTokens;
    else if (Number.isFinite(usage.uncachedInputTokens)) result[inputKey] = usage.uncachedInputTokens;
    else if (Number.isFinite(usage.cacheReadTokens) && Number.isFinite(usage.cacheWriteTokens)) {
      const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
      if (uncached >= 0) result[inputKey] = uncached;
    }
  }
  if (Number.isFinite(usage.outputTokens)) result[outputKey] = usage.outputTokens;
  if (protocol === 'messages') {
    if (Number.isFinite(usage.cacheReadTokens)) result.cache_read_input_tokens = usage.cacheReadTokens;
    if (Number.isFinite(usage.cacheWriteTokens)) result.cache_creation_input_tokens = usage.cacheWriteTokens;
    if (usage.messagesCacheCreation) result.cache_creation = cloneJson(usage.messagesCacheCreation);
    if (!Number.isFinite(result.input_tokens) && Number.isFinite(usage.inputTokens)) result.airouter_upstream_usage = { protocol: usage.sourceProtocol, input_tokens: usage.inputTokens };
  } else {
    if (Number.isFinite(usage.totalTokens)) result.total_tokens = usage.totalTokens;
    const details = { ...(usage.inputDetails || {}) };
    if (Number.isFinite(usage.cacheReadTokens)) details.cached_tokens = usage.cacheReadTokens;
    if (Number.isFinite(usage.cacheWriteTokens)) details.cache_write_tokens = usage.cacheWriteTokens;
    if (Object.keys(details).length) result[protocol === 'chat_completions' ? 'prompt_tokens_details' : 'input_tokens_details'] = details;
    if (usage.outputDetails) result[protocol === 'chat_completions' ? 'completion_tokens_details' : 'output_tokens_details'] = cloneJson(usage.outputDetails);
    if (usage.messagesCacheCreation || (usage.sourceProtocol === 'messages' && !Number.isFinite(usage.inputTokens) && Number.isFinite(usage.uncachedInputTokens))) result.airouter_upstream_usage = {
      protocol: 'messages', ...(usage.messagesCacheCreation ? { cache_creation: cloneJson(usage.messagesCacheCreation) } : {}),
      ...(!Number.isFinite(usage.inputTokens) && Number.isFinite(usage.uncachedInputTokens) ? { input_tokens: usage.uncachedInputTokens } : {}),
    };
  }
  return result;
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
      parts.push(requestContentPart(block, { type: 'text', text: block.text }));
    } else if (block.type === 'image_url' || Object.prototype.hasOwnProperty.call(block, 'image_url')) {
      const part = imagePartFromChat(block);
      if (block.image_url && block.image_url.detail) part.detail = block.image_url.detail;
      parts.push(requestContentPart(block, part));
    } else if (block.type === 'input_image') {
      const url = typeof block.image_url === 'string' ? block.image_url : '';
      if (!url) {
        throw new UnsupportedProtocolFeatureError('图片输入缺少 image_url');
      }
      parts.push(requestContentPart(block, { type: 'image', url }));
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
    if (type && type !== 'function' && !(protocol === 'messages' && type === 'custom')) {
      throw new UnsupportedProtocolFeatureError(`跨协议路由不支持内置工具: ${type}`);
    }

    const definition = isPlainObject(tool.function) ? tool.function : tool;
    if (typeof definition.name !== 'string' || !definition.name) throw new UnsupportedProtocolFeatureError('工具定义缺少名称');
    if (definition.strict !== undefined && typeof definition.strict !== 'boolean') throw new UnsupportedProtocolFeatureError('工具 strict 必须为布尔值');
    const strict = definition.strict === undefined ? {} : { strict: definition.strict };

    if (tool.function && typeof tool.function === 'object') {
      return {
        name: tool.function.name,
        description: tool.function.description || '',
        inputSchema: tool.function.parameters || tool.function.input_schema || { type: 'object', properties: {} },
        ...strict,
      };
    }

    if (protocol === 'messages') {
      return {
        name: tool.name,
        description: tool.description || '',
        inputSchema: tool.input_schema || { type: 'object', properties: {} },
        ...strict,
      };
    }

    return {
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.parameters || tool.input_schema || { type: 'object', properties: {} },
      ...strict,
    };
  });
}

function parseToolChoice(toolChoice) {
  if (!toolChoice) {
    return null;
  }
  if (typeof toolChoice === 'string') {
    if (!['auto', 'none', 'required', 'any'].includes(toolChoice)) throw new UnsupportedProtocolFeatureError('无法保留此工具选择策略');
    return toolChoice === 'any' ? 'required' : toolChoice;
  }
  if (!isPlainObject(toolChoice)) {
    throw new UnsupportedProtocolFeatureError('工具选择必须为字符串或对象');
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
  throw new UnsupportedProtocolFeatureError('无法保留此工具选择策略');
}

function requestContentPart(block, part) {
  if (Object.prototype.hasOwnProperty.call(block, 'prompt_cache_breakpoint')) part.prompt_cache_breakpoint = cloneJson(block.prompt_cache_breakpoint);
  return part;
}

function requestToolUse(id, name, argumentsText) {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) throw new UnsupportedProtocolFeatureError('工具调用缺少调用 ID 或名称');
  if (typeof argumentsText !== 'string') throw new UnsupportedProtocolFeatureError('OpenAI 工具参数必须为原始字符串');
  return { type: 'tool_use', id, name, arguments: argumentsText };
}

function requestNumberSignature(literal) {
  const [coefficient, exponent = '0'] = literal.toLowerCase().split('e');
  const negative = coefficient.startsWith('-');
  const [whole, fraction = ''] = (negative ? coefficient.slice(1) : coefficient).split('.');
  let digits = (whole + fraction).replace(/^0+/, '') || '0';
  if (digits === '0') return negative ? '-0' : '0';
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  if (trailing) digits = digits.slice(0, -trailing);
  return `${negative ? '-' : ''}${digits}:${BigInt(exponent) - BigInt(fraction.length) + BigInt(trailing)}`;
}

function requestToolInput(part) {
  if (Object.prototype.hasOwnProperty.call(part, 'arguments')) {
    let parsed;
    try {
      parsed = JSON.parse(part.arguments);
      // Read number lexemes outside strings. This also works on Node versions
      // without JSON.parse reviver context.source, which must not silently
      // disable decimal precision checks.
      const tokens = /"(?:\\.|[^"\\])*"|(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
      for (const token of part.arguments.matchAll(tokens)) {
        if (token[1] === undefined) continue;
        const number = Number(token[1]);
        if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)) || requestNumberSignature(token[1]) !== requestNumberSignature(String(number))) throw new Error('工具数值精度无法无损转换');
      }
    } catch (error) { throw new UnsupportedProtocolFeatureError('Messages 工具参数必须为可无损表示的 JSON 对象，不能修复为 {}'); }
    if (!isPlainObject(parsed)) throw new UnsupportedProtocolFeatureError('Messages 工具参数必须为 JSON 对象');
    return parsed;
  }
  if (!isPlainObject(part.input)) throw new UnsupportedProtocolFeatureError('Messages 工具参数必须为 JSON 对象');
  return cloneJson(part.input);
}

function requestToolArguments(part) {
  return Object.prototype.hasOwnProperty.call(part, 'arguments') ? part.arguments : JSON.stringify(part.input);
}

function collectRequestControls(body, canonical, protocol) {
  for (const name of ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'store']) {
    if (Object.prototype.hasOwnProperty.call(body, name)) canonical.params[name] = cloneJson(body[name]);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'parallel_tool_calls')) {
    if (typeof body.parallel_tool_calls !== 'boolean') throw new UnsupportedProtocolFeatureError('parallel_tool_calls 必须为布尔值');
    canonical.params.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (protocol === 'messages' && body.tool_choice && Object.prototype.hasOwnProperty.call(body.tool_choice, 'disable_parallel_tool_use')) {
    if (typeof body.tool_choice.disable_parallel_tool_use !== 'boolean') throw new UnsupportedProtocolFeatureError('disable_parallel_tool_use 必须为布尔值');
    canonical.params.parallel_tool_calls = !body.tool_choice.disable_parallel_tool_use;
  }
}

function requestToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new UnsupportedProtocolFeatureError('跨协议工具结果必须为文本字符串或文本内容块数组');
  const parts = content.map(block => {
    if (!block || !['text', 'input_text', 'output_text'].includes(block.type) || typeof block.text !== 'string') throw new UnsupportedProtocolFeatureError('跨协议工具结果仅支持文本，不能丢弃图片或其他内容块');
    return requestContentPart(block, { type: 'text', text: block.text });
  });
  return parts.length === 1 && !Object.prototype.hasOwnProperty.call(parts[0], 'prompt_cache_breakpoint') ? parts[0].text : parts;
}

function responseToolResultContent(content) {
  return typeof content === 'string' ? content : content.map(part => requestContentPart(part, { type: 'input_text', text: part.text }));
}

function validateToolRounds(canonical) {
  const pending = new Set();
  let returningResults = false;
  for (const message of canonical.messages) {
    for (const part of message.parts) {
      if (part.type === 'tool_use') {
        if (message.role !== 'assistant' || returningResults || typeof part.id !== 'string' || !part.id || typeof part.name !== 'string' || !part.name || pending.has(part.id)) throw new UnsupportedProtocolFeatureError('工具调用分组、ID 或名称无效');
        pending.add(part.id);
      } else if (part.type === 'tool_result') {
        if (message.role !== 'user' || typeof part.toolUseId !== 'string' || !pending.has(part.toolUseId)) throw new UnsupportedProtocolFeatureError('工具结果没有匹配的未完成调用 ID');
        pending.delete(part.toolUseId);
        returningResults = pending.size > 0;
      } else if (pending.size && (message.role !== 'assistant' || returningResults)) {
        throw new UnsupportedProtocolFeatureError('同轮工具结果未全部返回，不能重排后续消息');
      }
    }
    if (!pending.size) returningResults = false;
  }
}

function parseChatRequest(body, options = {}) {
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

    if (message.role === 'tool') {
      canonical.messages.push({
        role: 'user',
        parts: [{
          type: 'tool_result',
          toolUseId: message.tool_call_id,
          content: requestToolResultContent(message.content),
        }],
      });
      continue;
    }

    const reasoning = parseClientReasoning('chat_completions', message, options.reasoningTransport);
    if (reasoning.length && message.role !== 'assistant') throw new UnsupportedProtocolFeatureError('reasoning 只能附于 assistant 历史');
    const parts = [...reasoning, ...parseChatContent(message.content, message.role)];
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (call.type && call.type !== 'function') throw new UnsupportedProtocolFeatureError('跨协议路由不能将自定义工具调用当作函数');
      parts.push(requestToolUse(call.id, call.function && call.function.name, call.function && call.function.arguments));
    }
    if (message.refusal != null) {
      if (message.role !== 'assistant' || typeof message.refusal !== 'string') throw new UnsupportedProtocolFeatureError('拒绝消息结构无法保真转换');
      parts.push({ type: 'refusal', text: message.refusal });
    }
    if (!['system', 'developer', 'assistant', 'user'].includes(message.role)) throw new UnsupportedProtocolFeatureError(`不支持的消息角色: ${message.role}`);
    canonical.messages.push({ role: message.role, parts });
  }

  for (const name of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'seed', 'user', 'stop', 'parallel_tool_calls', 'metadata']) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      canonical.params[name] = body[name];
    }
  }

  collectRequestControls(body, canonical, 'chat_completions');

  return canonical;
}

function parseMessagesRequest(body, options = {}) {
  const canonical = {
    model: body.model,
    system: typeof body.system === 'string' ? body.system : '',
    messages: [],
    tools: normalizeTools(body.tools, 'messages'),
    toolChoice: parseToolChoice(body.tool_choice),
    maxOutputTokens: Number.isFinite(body.max_tokens) ? body.max_tokens : undefined,
    stream: body.stream === true,
    params: {},
  };

  if (Array.isArray(body.system)) canonical.messages.push({ role: 'system', parts: parseChatContent(body.system, 'system') });

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
        if (!isPlainObject(block.input)) throw new UnsupportedProtocolFeatureError('Messages 工具 input 必须为对象');
        parts.push({ type: 'tool_use', id: block.id, name: block.name, input: cloneJson(block.input) });
      } else if (block.type === 'tool_result') {
        if (block.is_error === true) throw new UnsupportedProtocolFeatureError('跨协议无法准确保留工具结果的 is_error 错误标记');
        parts.push({
          type: 'tool_result',
          toolUseId: block.tool_use_id,
          content: requestToolResultContent(block.content),
        });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        if (message.role !== 'assistant') throw new UnsupportedProtocolFeatureError('thinking 只能附于 assistant 历史');
        parts.push(...parseClientReasoning('messages', block, options.reasoningTransport));
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

  collectRequestControls(body, canonical, 'messages');

  return canonical;
}

function parseResponsesContent(content, role) {
  const parts = [];
  for (const block of normalizeContentArray(content)) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if ((block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') && typeof block.text === 'string') {
      parts.push(requestContentPart(block, { type: 'text', text: block.text }));
    } else if (block.type === 'input_image' || block.type === 'image_url') {
      const url = typeof block.image_url === 'string'
        ? block.image_url
        : block.image_url && typeof block.image_url.url === 'string'
          ? block.image_url.url
          : '';
      if (!url) {
        throw new UnsupportedProtocolFeatureError('图片输入缺少 image_url');
      }
      parts.push(requestContentPart(block, { type: 'image', url, ...(block.detail ? { detail: block.detail } : {}) }));
    } else if (block.type === 'refusal' && typeof block.refusal === 'string' && role === 'assistant') {
      parts.push({ type: 'refusal', text: block.refusal });
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

function parseResponsesRequest(body, options = {}) {
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
      if (item.type === 'message' || (!item.type && typeof item.role === 'string' && Object.prototype.hasOwnProperty.call(item, 'content'))) {
        if (!['system', 'developer', 'assistant', 'user'].includes(item.role)) throw new UnsupportedProtocolFeatureError(`不支持的 Responses 消息角色: ${item.role}`);
        const message = {
          role: item.role,
          parts: parseResponsesContent(item.content, item.role),
        };
        const previous = canonical.messages[canonical.messages.length - 1];
        if (message.role === 'assistant' && previous?.role === 'assistant' && previous.parts.some(part => part.type === 'tool_use' || part.type === 'reasoning')) previous.parts.push(...message.parts);
        else canonical.messages.push(message);
      } else if (item.type === 'function_call') {
        const part = requestToolUse(item.call_id, item.name, item.arguments);
        const previous = canonical.messages[canonical.messages.length - 1];
        if (previous && previous.role === 'assistant') previous.parts.push(part);
        else canonical.messages.push({ role: 'assistant', parts: [part] });
      } else if (item.type === 'function_call_output') {
        const result = {
          role: 'user',
          parts: [{
            type: 'tool_result',
            toolUseId: item.call_id,
            content: requestToolResultContent(item.output),
          }],
        };
        const previous = canonical.messages[canonical.messages.length - 1];
        if (previous && previous.role === 'user' && previous.parts.every(part => part.type === 'tool_result')) previous.parts.push(...result.parts);
        else canonical.messages.push(result);
      } else if (item.type === 'reasoning') {
        const parts = parseClientReasoning('responses', item, options.reasoningTransport);
        const previous = canonical.messages[canonical.messages.length - 1];
        if (previous?.role === 'assistant') previous.parts.push(...parts);
        else canonical.messages.push({ role: 'assistant', parts });
      } else if (item.type === 'item_reference') {
        throw new UnsupportedProtocolFeatureError('跨协议路由无法迁移服务端 item_reference 状态');
      } else {
        throw new UnsupportedProtocolFeatureError(`跨协议路由无法保留 Responses 输入类型: ${item.type}`);
      }
    }
  } else if (input !== undefined && input !== null) {
    throw new UnsupportedProtocolFeatureError('Responses input 必须是字符串或数组');
  }

  for (const name of ['temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'user']) {
    if (Object.prototype.hasOwnProperty.call(body, name)) {
      canonical.params[name] = body[name];
    }
  }

  collectRequestControls(body, canonical, 'responses');

  return canonical;
}

function parseEntryRequest(entryProtocol, body, options = {}) {
  if (entryProtocol === 'chat_completions') {
    return parseChatRequest(body, options);
  }
  if (entryProtocol === 'messages') {
    return parseMessagesRequest(body, options);
  }
  if (entryProtocol === 'responses') {
    return parseResponsesRequest(body, options);
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
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      };
    }
    if (targetProtocol === 'responses') {
      return {
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      };
    }
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
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

function mergeChatReasoning(message, value) {
  for (const [key, field] of Object.entries(value)) {
    if (key === 'reasoning_details') message[key] = [...(message[key] || []), ...cloneJson(field)];
    else if (key === 'airouter_upstream_reasoning') message[key] = message[key] ? [...(Array.isArray(message[key]) ? message[key] : [message[key]]), ...(Array.isArray(field) ? cloneJson(field) : [cloneJson(field)])] : cloneJson(field);
    else if (typeof field === 'string') message[key] = (message[key] || '') + field;
    else throw new UnsupportedProtocolFeatureError(`reasoning: 无法保真合并 ${key}`);
  }
}

function serializeChatRequest(canonical, targetModel, stream) {
  const messages = [];
  if (canonical.system) {
    messages.push({ role: 'system', content: canonical.system });
  }

  for (const message of canonical.messages) {
    const textParts = [];
    const toolCalls = [];
    const reasoningParts = [];
    let refusal;
    function flushMessage() {
      if (!textParts.length && !toolCalls.length && !reasoningParts.length && refusal === undefined) return;
      const onlyText = textParts.length === 1 && textParts[0].type === 'text' && !Object.prototype.hasOwnProperty.call(textParts[0], 'prompt_cache_breakpoint');
      const payload = { role: message.role, content: onlyText ? textParts[0].text : textParts.length ? [...textParts] : null };
      if (toolCalls.length) payload.tool_calls = [...toolCalls];
      if (refusal !== undefined) payload.refusal = refusal;
      for (const part of reasoningParts) mergeChatReasoning(payload, restoreReasoning('chat_completions', part));
      messages.push(payload);
      textParts.length = 0; toolCalls.length = 0; reasoningParts.length = 0; refusal = undefined;
    }
    for (const part of message.parts) {
      if (part.type === 'reasoning') {
        reasoningParts.push(part);
      } else if (part.type === 'text') {
        textParts.push(requestContentPart(part, { type: 'text', text: part.text }));
      } else if (part.type === 'image') {
        textParts.push(requestContentPart(part, { type: 'image_url', image_url: { url: canonicalImageUrl(part), ...(part.detail ? { detail: part.detail } : {}) } }));
      } else if (part.type === 'tool_use') {
        toolCalls.push({
          id: part.id,
          type: 'function',
          function: {
            name: part.name,
            arguments: requestToolArguments(part),
          },
        });
      } else if (part.type === 'tool_result') {
        flushMessage();
        messages.push({
          role: 'tool',
          tool_call_id: part.toolUseId,
          content: part.content ?? '',
        });
      } else if (part.type === 'refusal') {
        refusal = (refusal || '') + part.text;
      } else if (part.type === 'file') {
        throw new UnsupportedProtocolFeatureError('跨协议路由暂不支持文件输入');
      }
    }

    flushMessage();
  }

  const result = {
    model: targetModel,
    messages,
    stream,
  };
  if (canonical.tools.length > 0) {
    result.tools = serializeTools(canonical.tools, 'chat_completions');
  }
  const choice = serializeToolChoice(canonical.toolChoice, 'chat_completions');
  if (choice !== undefined) result.tool_choice = choice;
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
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'stop_sequences')) result.stop = cloneJson(canonical.params.stop_sequences);
  for (const name of ['parallel_tool_calls', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'store']) {
    if (Object.prototype.hasOwnProperty.call(canonical.params, name)) result[name] = cloneJson(canonical.params[name]);
  }
  return result;
}

function serializeMessagesRequest(canonical, targetModel, stream) {
  const messages = [];
  const systemParts = canonical.system ? [{ type: 'text', text: canonical.system }] : [];
  let dialogueStarted = false;
  for (const message of canonical.messages) {
    if (message.role === 'developer') throw new UnsupportedProtocolFeatureError('Messages 无法保留 developer 与 system 的指令层级区别');
    if (message.role === 'system') {
      if (dialogueStarted) throw new UnsupportedProtocolFeatureError('Messages 无法保留对话中途的 system 指令位置');
      if (message.parts.some(part => part.type !== 'text')) throw new UnsupportedProtocolFeatureError('Messages system 只能保留文本指令');
      systemParts.push(...message.parts.map(part => ({ type: 'text', text: part.text })));
      continue;
    }
    dialogueStarted = true;
    const content = [];
    for (const part of message.parts) {
      if (part.type === 'reasoning') {
        content.push(restoreReasoning('messages', part));
      } else if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image') {
        if (part.data && part.mediaType) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: part.mediaType, data: part.data },
          });
        } else if (/^data:/i.test(part.url || '')) {
          const embedded = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(part.url);
          if (!embedded) throw new UnsupportedProtocolFeatureError('Messages 图片 data URL 必须使用明确 media_type 的 base64 编码');
          content.push({ type: 'image', source: { type: 'base64', media_type: embedded[1], data: embedded[2] } });
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
        content.push({ type: 'tool_use', id: part.id, name: part.name, input: requestToolInput(part) });
      } else if (part.type === 'tool_result') {
        content.push({ type: 'tool_result', tool_use_id: part.toolUseId, content: part.content ?? '' });
      } else if (part.type === 'refusal') {
        throw new UnsupportedProtocolFeatureError('Messages 输入无法保留 OpenAI refusal 机器可读标记');
      }
    }
    const previous = messages[messages.length - 1];
    if (message.role === 'user' && previous && previous.role === 'user' && previous.content.every(part => part.type === 'tool_result')) previous.content.push(...content);
    else messages.push({ role: message.role, content });
  }

  const result = {
    model: targetModel,
    system: systemParts.length === 1 ? systemParts[0].text : systemParts.length ? systemParts : undefined,
    messages,
    max_tokens: Number.isFinite(canonical.maxOutputTokens) ? canonical.maxOutputTokens : 4096,
    stream,
  };
  if (!result.system) {
    delete result.system;
  }
  if (canonical.tools.length > 0) {
    result.tools = serializeTools(canonical.tools, 'messages');
  }
  const choice = serializeToolChoice(canonical.toolChoice, 'messages');
  if (choice !== undefined) result.tool_choice = choice;
  if (canonical.tools.length && Object.prototype.hasOwnProperty.call(canonical.params, 'parallel_tool_calls') && result.tool_choice?.type !== 'none') {
    result.tool_choice = { ...(result.tool_choice || { type: 'auto' }), disable_parallel_tool_use: !canonical.params.parallel_tool_calls };
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
  if (canonical.params.stop != null) result.stop_sequences = Array.isArray(canonical.params.stop) ? cloneJson(canonical.params.stop) : [canonical.params.stop];
  return result;
}

function serializeResponsesRequest(canonical, targetModel, stream) {
  const input = [];
  for (const message of canonical.messages) {
    const content = [];
    function flushContent() {
      if (!content.length) return;
      input.push({ type: 'message', role: message.role, content: [...content] });
      content.length = 0;
    }
    for (const part of message.parts) {
      if (part.type === 'reasoning') {
        flushContent();
        input.push(restoreReasoning('responses', part));
      } else if (part.type === 'text') {
        content.push(requestContentPart(part, {
          type: message.role === 'assistant' ? 'output_text' : 'input_text',
          text: part.text,
        }));
      } else if (part.type === 'image') {
        content.push(requestContentPart(part, { type: 'input_image', image_url: canonicalImageUrl(part), ...(part.detail ? { detail: part.detail } : {}) }));
      } else if (part.type === 'file') {
        content.push({
          type: 'input_file',
          filename: part.filename,
          file_data: `data:${part.mediaType};base64,${part.data}`,
        });
      } else if (part.type === 'tool_use') {
        flushContent();
        input.push({
          type: 'function_call',
          call_id: part.id,
          name: part.name,
          arguments: requestToolArguments(part),
        });
      } else if (part.type === 'tool_result') {
        flushContent();
        input.push({
          type: 'function_call_output',
          call_id: part.toolUseId,
          output: responseToolResultContent(part.content),
        });
      } else if (part.type === 'refusal') {
        content.push({ type: 'refusal', refusal: part.text });
      }
    }
    flushContent();
  }

  const result = {
    model: targetModel,
    instructions: canonical.system || '',
    input,
    tools: serializeTools(canonical.tools, 'responses'),
    stream,
  };
  if (Number.isFinite(canonical.maxOutputTokens)) {
    result.max_output_tokens = canonical.maxOutputTokens;
  }
  if (!result.tools.length) {
    delete result.tools;
  }
  const choice = serializeToolChoice(canonical.toolChoice, 'responses');
  if (choice !== undefined) result.tool_choice = choice;
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'temperature')) {
    result.temperature = canonical.params.temperature;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'top_p')) {
    result.top_p = canonical.params.top_p;
  }
  if (Object.prototype.hasOwnProperty.call(canonical.params, 'metadata')) {
    result.metadata = canonical.params.metadata;
  }
  for (const name of ['parallel_tool_calls', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'store']) {
    if (Object.prototype.hasOwnProperty.call(canonical.params, name)) result[name] = cloneJson(canonical.params[name]);
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

function assertCrossProtocolSupported(entryProtocol, targetProtocol, body) {
  if (entryProtocol === targetProtocol) {
    return;
  }

  const controls = mapCrossProtocolControls({ entryProtocol, targetProtocol, body,
    fail: message => new UnsupportedProtocolFeatureError(message) });
  if (hasStructuredOutput(body) && (entryProtocol === 'messages' || targetProtocol === 'messages')) {
    const path = body.response_format ? 'response_format' : body.text?.format ? 'text.format' : body.output_config?.format ? 'output_config.format' : 'output_format';
    throw new UnsupportedProtocolFeatureError(`${path}: 跨 Messages 协议无法保留该结构化输出控制，请改用同协议候选`);
  }
  if (hasBuiltinTools(body)) {
    throw new UnsupportedProtocolFeatureError('跨协议路由不支持内置服务端工具，请改用同协议候选');
  }
  const crossesMessages = entryProtocol === 'messages' || targetProtocol === 'messages';
  function checkCache(value) {
    if (Array.isArray(value)) return value.forEach(checkCache);
    if (!isPlainObject(value)) return;
    if (Object.prototype.hasOwnProperty.call(value, 'cache_control')) throw new UnsupportedProtocolFeatureError('Claude cache_control 与 OpenAI prompt 缓存控制没有等价跨协议映射');
    if (crossesMessages && Object.prototype.hasOwnProperty.call(value, 'prompt_cache_breakpoint')) throw new UnsupportedProtocolFeatureError('Messages 无法保留 OpenAI prompt_cache_breakpoint 缓存边界');
    for (const [name, nested] of Object.entries(value)) {
      // Application metadata and tool schemas/arguments are user data, not API controls.
      if (['metadata', 'parameters', 'input_schema', 'schema', 'airouter_upstream_reasoning'].includes(name) || (value.type === 'tool_use' && name === 'input')) continue;
      checkCache(nested);
    }
  }
  checkCache(body);
  const cacheKeys = ['prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options'];
  if (crossesMessages && cacheKeys.some(name => Object.prototype.hasOwnProperty.call(body, name))) throw new UnsupportedProtocolFeatureError(`${cacheKeys.filter(name => Object.prototype.hasOwnProperty.call(body, name)).join(', ')}: OpenAI prompt 缓存控制无法准确映射到 Claude cache_control`);
  if (body.prompt_cache_options && Object.keys(body.prompt_cache_options).some(name => !['mode', 'ttl'].includes(name))) throw new UnsupportedProtocolFeatureError('跨 Chat/Responses 只支持共有的 prompt_cache_options mode/ttl，不迁移预热或比较响应 ID');
  if (Object.prototype.hasOwnProperty.call(body, 'store')) {
    if (typeof body.store !== 'boolean' || body.store || crossesMessages) throw new UnsupportedProtocolFeatureError('store: 跨协议无法保留请求的服务端保存/续接语义');
  }
  const stop = entryProtocol === 'messages' ? body.stop_sequences : body.stop;
  if (stop != null) {
    if (entryProtocol === 'responses') throw new UnsupportedProtocolFeatureError('Responses 不支持 stop 停止条件');
    const values = typeof stop === 'string' && entryProtocol === 'chat_completions' ? [stop] : stop;
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new UnsupportedProtocolFeatureError('停止条件必须为字符串或字符串数组');
    if (targetProtocol === 'responses' && values.length) throw new UnsupportedProtocolFeatureError('Responses 无法等价表达 stop / stop_sequences 停止条件');
    if (targetProtocol === 'chat_completions' && values.length > 4) throw new UnsupportedProtocolFeatureError('Chat 最多支持四个停止序列');
  }
  return controls;
}

function transformRequestForTarget({ entryProtocol, targetProtocol, body, targetModel, stream, reasoningTransport = body?.[REASONING_TRANSPORT] }) {
  if (!SUPPORTED_PROTOCOLS.includes(entryProtocol) || !SUPPORTED_PROTOCOLS.includes(targetProtocol)) {
    throw new UnsupportedProtocolFeatureError('不支持的协议转换');
  }

  const nativeBridgeHistory = entryProtocol === targetProtocol && hasBridgeReasoning(body);
  if (entryProtocol === targetProtocol && !nativeBridgeHistory) {
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

  const controls = nativeBridgeHistory ? {} : assertCrossProtocolSupported(entryProtocol, targetProtocol, body);
  const canonical = parseEntryRequest(entryProtocol, body, { reasoningTransport });
  validateToolRounds(canonical);
  const result = targetProtocol === 'chat_completions'
    ? serializeChatRequest(canonical, targetModel, stream)
    : targetProtocol === 'messages'
      ? serializeMessagesRequest(canonical, targetModel, stream)
      : serializeResponsesRequest(canonical, targetModel, stream);
  if (nativeBridgeHistory) {
    // Restoring gateway history must not discard native request controls.
    const historyField = targetProtocol === 'responses' ? 'input' : 'messages';
    return { ...cloneJson(body), model: targetModel, stream, [historyField]: result[historyField] };
  }
  if (entryProtocol === 'responses' && targetProtocol === 'chat_completions' && Object.prototype.hasOwnProperty.call(controls, 'max_completion_tokens')) delete result.max_tokens;
  return Object.assign(result, controls);
}

// Native payloads retain provider state verbatim. Cross-protocol reasoning needs
// an explicit transport; unknown provider structures remain unsupported.
function assertResponseContentSupported(protocol, payload) {
  if (protocol === 'chat_completions') {
    for (const [index, choice] of (payload?.choices || []).entries()) {
      const kind = choice.message ? 'message' : 'delta';
      const message = choice[kind] || {};
      for (const field of ['audio', 'function_call']) {
        if (message[field] !== undefined && message[field] !== null && message[field] !== '') throw new UnsupportedProtocolFeatureError(`choices[${index}].${kind}.${field}: 私有或未实现的 Chat 输出没有无损跨协议映射，请使用同协议候选`);
      }
      try { parseSourceReasoning('chat_completions', message); }
      catch (error) {
        if (!(error instanceof UnsupportedProtocolFeatureError)) throw error;
        throw new UnsupportedProtocolFeatureError(`choices[${index}].${kind}.${error.message}`);
      }
    }
  } else if (protocol === 'messages') {
    for (const block of payload?.content || []) {
      if (block && !['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block.type)) throw new UnsupportedProtocolFeatureError(`无法保真转换 Messages 内容块 ${block.type}`);
    }
  } else if (protocol === 'responses') {
    for (const item of payload?.output || []) {
      if (item && !['message', 'function_call', 'reasoning'].includes(item.type)) throw new UnsupportedProtocolFeatureError(`无法保真转换 Responses 内容项 ${item.type}`);
      if (item?.type === 'message') for (const block of item.content || []) {
        if (block && !['output_text', 'refusal'].includes(block.type)) throw new UnsupportedProtocolFeatureError(`无法保真转换 Responses 内容块 ${block.type}`);
      }
    }
  }
}

function parseChatResponse(payload) {
  assertResponseContentSupported('chat_completions', payload);
  if (Array.isArray(payload?.choices) && payload.choices.length > 1) throw new UnsupportedProtocolFeatureError('choices: 多个 Chat 候选无法无损转换为单次跨协议响应');
  const choice = payload && Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (!choice) {
    throw new UnsupportedProtocolFeatureError('上游 chat.completions 响应缺少 choices');
  }
  const message = choice.message || {};
  const parts = parseSourceReasoning('chat_completions', message);
  const text = contentToText(message.content);
  if (text) {
    parts.push({ type: 'text', text, ...(Array.isArray(choice.logprobs?.content) ? { logprobs: cloneJson(choice.logprobs.content) } : {}) });
  }
  if (typeof message.refusal === 'string' && message.refusal) parts.push({ type: 'refusal', text: message.refusal });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    parts.push({
      type: 'tool_use',
      id: call.id,
      name: call.function && call.function.name,
      arguments: call.function && call.function.arguments,
    });
  }
  return {
    sourceProtocol: 'chat_completions',
    id: payload.id || '',
    model: payload.model || '',
    createdAt: Number.isFinite(payload.created) ? payload.created : Math.floor(Date.now() / 1000),
    parts,
    ...(Object.prototype.hasOwnProperty.call(payload, 'service_tier') ? { serviceTier: cloneJson(payload.service_tier) } : {}),
    ...(Object.prototype.hasOwnProperty.call(choice, 'logprobs') ? { logprobs: cloneJson(choice.logprobs) } : {}),
    stopReason: choice.finish_reason === 'content_filter' ? 'content_filter' : message.refusal ? 'refusal' : mapChatStopToCanonical(choice.finish_reason),
    usage: usageFromChat(payload.usage),
  };
}

function parseMessagesResponse(payload) {
  assertResponseContentSupported('messages', payload);
  if (payload?.error) throw new UnsupportedProtocolFeatureError(payload.error.message || '上游 Messages 响应失败');
  if (payload?.stop_reason === 'pause_turn') throw new UnsupportedProtocolFeatureError('Messages pause_turn 不能转换成已完成的跨协议响应');
  const parts = [];
  for (const block of Array.isArray(payload && payload.content) ? payload.content : []) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: payload.stop_reason === 'refusal' ? 'refusal' : 'text', text: block.text });
    } else if (block.type === 'tool_use') {
      parts.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input || {} });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      parts.push(...parseSourceReasoning('messages', block));
    }
  }
  return {
    sourceProtocol: 'messages',
    id: payload.id || '',
    model: payload.model || '',
    parts,
    stopReason: mapMessagesStopToCanonical(payload.stop_reason),
    ...(Object.prototype.hasOwnProperty.call(payload, 'stop_sequence') ? { stopSequence: payload.stop_sequence } : {}),
    usage: usageFromMessages(payload.usage),
  };
}

function parseResponsesResponse(payload) {
  assertResponseContentSupported('responses', payload);
  if (payload?.error || ['failed', 'cancelled'].includes(payload?.status)) throw new UnsupportedProtocolFeatureError(payload.error?.message || `上游 Responses 响应 ${payload.status}`);
  if (['queued', 'in_progress'].includes(payload?.status)) throw new UnsupportedProtocolFeatureError(`上游 Responses 响应尚未完成: ${payload.status}`);
  if (payload?.status === 'incomplete' && !['max_output_tokens', 'content_filter'].includes(payload.incomplete_details?.reason)) throw new UnsupportedProtocolFeatureError(`无法准确映射 Responses incomplete 原因: ${payload.incomplete_details?.reason || 'unknown'}`);
  const parts = [];
  let logprobs;
  for (const item of Array.isArray(payload && payload.output) ? payload.output : []) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    if (item.type === 'reasoning') {
      parts.push(...parseSourceReasoning('responses', item));
    } else if (item.type === 'message') {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (block?.type === 'output_text') {
          if (block.text) parts.push({ type: 'text', text: block.text, ...(Array.isArray(block.logprobs) ? { logprobs: cloneJson(block.logprobs) } : {}) });
          if (Object.prototype.hasOwnProperty.call(block, 'logprobs')) {
            if (!Array.isArray(block.logprobs)) throw new UnsupportedProtocolFeatureError('output[].content[].logprobs 必须为数组');
            if (!logprobs) logprobs = { content: [], refusal: null };
            logprobs.content.push(...cloneJson(block.logprobs));
          }
        }
        if (block?.type === 'refusal') parts.push({ type: 'refusal', text: block.refusal || '' });
      }
    } else if (item.type === 'function_call') {
      parts.push({
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        arguments: item.arguments,
      });
    }
  }
  if (parts.length === 0 && typeof payload.output_text === 'string' && payload.output_text) {
    parts.push({ type: 'text', text: payload.output_text });
  }
  const stopReason = payload.incomplete_details?.reason === 'content_filter' ? 'content_filter' : parts.some(part => part.type === 'refusal')
    ? 'refusal'
    : payload.incomplete_details && payload.incomplete_details.reason === 'max_output_tokens'
      ? 'max_tokens'
      : parts.some(part => part.type === 'tool_use') ? 'tool_use' : 'end_turn';
  return {
    sourceProtocol: 'responses',
    id: payload.id || '',
    model: payload.model || '',
    createdAt: Number.isFinite(payload.created_at) ? payload.created_at : Math.floor(Date.now() / 1000),
    parts,
    stopReason,
    ...(Object.prototype.hasOwnProperty.call(payload, 'service_tier') ? { serviceTier: cloneJson(payload.service_tier) } : {}),
    ...(logprobs ? { logprobs } : {}),
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

function responseIdFor(entryProtocol, upstreamId, sourceProtocol) {
  const id = typeof upstreamId === 'string' && upstreamId ? upstreamId : `airouter-${randomUUID()}`;
  // Prefix-looking source IDs are still arbitrary source data when bridging.
  // Keeping them unchanged creates collisions with encoded non-prefix IDs.
  if (sourceProtocol === entryProtocol && typeof upstreamId === 'string' && upstreamId) return upstreamId;
  const prefix = entryProtocol === 'responses' ? 'resp_' : entryProtocol === 'messages' ? 'msg_' : 'chatcmpl-';
  const source = SUPPORTED_PROTOCOLS.includes(sourceProtocol) ? sourceProtocol : 'unknown';
  return `${prefix}airouter_${source}_${Buffer.from(id).toString('hex')}`;
}

function chatToolCalls(parts) {
  return parts
    .filter(part => part.type === 'tool_use')
    .map(part => ({
      id: part.id,
      type: 'function',
      function: {
        name: part.name,
        arguments: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.input || {}),
      },
    }));
}

function serializeChatResponse(entryProtocol, canonical, publicModel, reasoningTransport) {
  const text = canonical.parts.filter(part => part.type === 'text').map(part => part.text).join('');
  const toolCalls = chatToolCalls(canonical.parts);
  const message = { role: 'assistant', content: text || null };
  const refusal = canonical.parts.filter(part => part.type === 'refusal').map(part => part.text).join('');
  if (refusal) message.refusal = refusal;
  for (const part of canonical.parts.filter(part => part.type === 'reasoning')) mergeChatReasoning(message, renderReasoning('chat_completions', part, reasoningTransport));
  if (toolCalls.length) {
    message.tool_calls = toolCalls;
  }
  return {
    id: responseIdFor('chat_completions', canonical.id, canonical.sourceProtocol),
    object: 'chat.completion',
    created: canonical.createdAt || Math.floor(Date.now() / 1000),
    model: publicModel,
    ...(Object.prototype.hasOwnProperty.call(canonical, 'serviceTier') ? { service_tier: cloneJson(canonical.serviceTier) } : {}),
    choices: [{
      index: 0,
      message,
      ...(Object.prototype.hasOwnProperty.call(canonical, 'logprobs') ? { logprobs: cloneJson(canonical.logprobs) } : {}),
      finish_reason: mapCanonicalStopToChat(canonical.stopReason),
    }],
    ...(canonical.usage ? { usage: serializeUsage(canonical.usage, 'chat_completions') } : {}),
  };
}

function serializeMessagesResponse(entryProtocol, canonical, publicModel, reasoningTransport) {
  if (canonical.logprobs?.content?.length || canonical.logprobs?.refusal?.length) throw new UnsupportedProtocolFeatureError('logprobs: Messages 无等价的 token 概率字段');
  const content = canonical.parts.map(part => {
    if (part.type === 'reasoning') return renderReasoning('messages', part, reasoningTransport);
    if (part.type === 'text' || part.type === 'refusal') {
      return { type: 'text', text: part.text };
    }
    return { type: 'tool_use', id: part.id, name: part.name, input: responseToolInput(part) };
  });
  return {
    id: responseIdFor('messages', canonical.id, canonical.sourceProtocol),
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content,
    stop_reason: mapCanonicalStopToMessages(canonical.stopReason),
    ...(Object.prototype.hasOwnProperty.call(canonical, 'stopSequence') ? { stop_sequence: canonical.stopSequence } : {}),
    ...(canonical.usage ? { usage: serializeUsage(canonical.usage, 'messages') } : {}),
  };
}

function serializeResponsesResponse(entryProtocol, canonical, publicModel, reasoningTransport) {
  if (canonical.logprobs?.refusal?.length) throw new UnsupportedProtocolFeatureError('logprobs.refusal: Responses refusal 没有等价概率字段，不能静默丢弃');
  if (!['end_turn', 'stop_sequence', 'max_tokens', 'tool_use', 'refusal', 'content_filter', undefined, null].includes(canonical.stopReason)) throw new UnsupportedProtocolFeatureError(`无法保真转换为 Responses 终态: ${canonical.stopReason}`);
  const output = [];
  const text = canonical.parts.filter(part => part.type === 'text').map(part => part.text).join('');
  let content = [], messageIndex = 0;
  function flushContent() {
    if (!content.length) return;
    const base = `msg_${responseIdFor('responses', canonical.id, canonical.sourceProtocol).replace(/^resp_/, '')}`;
    output.push({ id: messageIndex ? `${base}_${messageIndex}` : base, type: 'message', status: 'completed', role: 'assistant', content });
    messageIndex++; content = [];
  }
  for (const part of canonical.parts) {
    if (part.type === 'text') content.push({ type: 'output_text', text: part.text, annotations: [], ...(Array.isArray(part.logprobs) ? { logprobs: cloneJson(part.logprobs) } : Array.isArray(canonical.logprobs?.content) && canonical.parts.filter(value => value.type === 'text').length === 1 ? { logprobs: cloneJson(canonical.logprobs.content) } : {}) });
    else if (part.type === 'refusal') content.push({ type: 'refusal', refusal: part.text });
    else if (part.type === 'reasoning') { flushContent(); output.push(renderReasoning('responses', part, reasoningTransport)); }
    else if (part.type === 'tool_use') {
      flushContent();
      output.push({ id: part.id, type: 'function_call', status: 'completed', call_id: part.id, name: part.name,
        arguments: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.input || {}) });
    }
  }
  flushContent();
  return {
    id: responseIdFor('responses', canonical.id, canonical.sourceProtocol),
    object: 'response',
    created_at: canonical.createdAt || Math.floor(Date.now() / 1000),
    status: ['max_tokens', 'content_filter'].includes(canonical.stopReason) ? 'incomplete' : 'completed',
    ...(['max_tokens', 'content_filter'].includes(canonical.stopReason)
      ? { incomplete_details: { reason: canonical.stopReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } }
      : {}),
    model: publicModel,
    ...(Object.prototype.hasOwnProperty.call(canonical, 'serviceTier') ? { service_tier: cloneJson(canonical.serviceTier) } : {}),
    output,
    output_text: text,
    ...(canonical.usage ? { usage: serializeUsage(canonical.usage, 'responses') } : {}),
  };
}

function responseToolInput(part) {
  // Use the same lossless object conversion as request history. OpenAI's raw
  // argument string may contain numbers a JavaScript object cannot represent.
  return requestToolInput(part);
}

function transformResponseForEntry({ entryProtocol, targetProtocol, payload, publicModel, reasoningTransport }) {
  if (entryProtocol === targetProtocol) {
    const result = cloneJson(payload);
    rewriteModelInPayload(entryProtocol, result, publicModel);
    return result;
  }

  const canonical = parseTargetResponse(targetProtocol, payload);
  return serializeCanonicalResponse(entryProtocol, canonical, publicModel, { reasoningTransport });
}

function serializeCanonicalResponse(entryProtocol, canonical, publicModel, { reasoningTransport } = {}) {
  if (entryProtocol === 'chat_completions') {
    return serializeChatResponse(entryProtocol, canonical, publicModel, reasoningTransport);
  }
  if (entryProtocol === 'messages') {
    return serializeMessagesResponse(entryProtocol, canonical, publicModel, reasoningTransport);
  }
  return serializeResponsesResponse(entryProtocol, canonical, publicModel, reasoningTransport);
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
  const decoder = new StringDecoder('utf8');

  function parseBlock(block) {
    const lines = block.split('\n');
    let eventName = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
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
      buffer += Buffer.isBuffer(chunk) || chunk instanceof Uint8Array ? decoder.write(Buffer.from(chunk)) : decoder.end() + String(chunk || '');
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
      buffer += decoder.end();
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

// Native Messages must keep signed thinking and unknown complete block fields;
// the cross-protocol canonical representation intentionally cannot carry them.
function nativeMessagesToSse(payload, publicModel) {
  const message = rewriteModelInPayload('messages', cloneJson(payload), publicModel);
  if (!message || message.type !== 'message' || !Array.isArray(message.content) || !message.stop_reason) throw new UnsupportedProtocolFeatureError('原生 Messages JSON 缺少完整终态，不能合成为成功的流');
  const start = { ...message, content: [], stop_reason: null, stop_sequence: null };
  if (message.usage) start.usage = { ...message.usage, ...(Number.isFinite(message.usage.output_tokens) ? { output_tokens: 0 } : {}) };
  const events = [{ event: 'message_start', data: { type: 'message_start', message: start } }];
  for (const [index, block] of message.content.entries()) {
    if (!isPlainObject(block) || typeof block.type !== 'string') throw new UnsupportedProtocolFeatureError('原生 Messages 内容块无效');
    const initial = cloneJson(block), deltas = [];
    if (block.type === 'text') {
      initial.text = '';
      deltas.push({ type: 'text_delta', text: block.text });
    } else if (block.type === 'thinking') {
      initial.thinking = ''; delete initial.signature;
      deltas.push({ type: 'thinking_delta', thinking: block.thinking });
      if (Object.prototype.hasOwnProperty.call(block, 'signature')) deltas.push({ type: 'signature_delta', signature: block.signature });
    } else if (['tool_use', 'server_tool_use'].includes(block.type)) {
      initial.input = {};
      deltas.push({ type: 'input_json_delta', partial_json: JSON.stringify(block.input) });
    }
    events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: initial } });
    for (const delta of deltas) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  }
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: message.stop_reason, ...(Object.prototype.hasOwnProperty.call(message, 'stop_sequence') ? { stop_sequence: message.stop_sequence } : {}) }, ...(message.usage ? { usage: message.usage } : {}) } });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

function createNativeMessagesAccumulator(publicModel) {
  let message = null, complete = false;
  const blocks = new Map(), open = new Set(), argumentsByIndex = new Map();
  return {
    accept(eventName, payload) {
      const type = payload.type || eventName;
      if (complete) throw new UnsupportedProtocolFeatureError('原生 Messages 终态后仍有内容事件');
      if (type === 'ping') return;
      if (type === 'message_start') {
        if (message || !isPlainObject(payload.message) || !Array.isArray(payload.message.content) || payload.message.content.length) throw new UnsupportedProtocolFeatureError('原生 Messages message_start 结构或顺序无效');
        message = cloneJson(payload.message); return;
      }
      if (!message) throw new UnsupportedProtocolFeatureError('原生 Messages 流缺少 message_start');
      if (type === 'content_block_start') {
        if (!Number.isInteger(payload.index) || payload.index < 0 || blocks.has(payload.index) || !isPlainObject(payload.content_block)) throw new UnsupportedProtocolFeatureError('原生 Messages 内容块索引或起始结构无效');
        blocks.set(payload.index, cloneJson(payload.content_block)); open.add(payload.index); return;
      }
      if (type === 'content_block_delta') {
        const block = blocks.get(payload.index), delta = payload.delta || {};
        if (!block || !open.has(payload.index)) throw new UnsupportedProtocolFeatureError('原生 Messages delta 没有对应的活动内容块');
        const key = { text_delta: 'text', thinking_delta: 'thinking', signature_delta: 'signature' }[delta.type];
        if (key && typeof delta[key] === 'string') block[key] = (block[key] || '') + delta[key];
        else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') argumentsByIndex.set(payload.index, (argumentsByIndex.get(payload.index) || '') + delta.partial_json);
        else if (delta.type === 'citations_delta' && isPlainObject(delta.citation)) (block.citations || (block.citations = [])).push(cloneJson(delta.citation));
        else throw new UnsupportedProtocolFeatureError(`无法保真聚合原生 Messages delta ${delta.type}`);
        return;
      }
      if (type === 'content_block_stop') {
        if (!open.delete(payload.index)) throw new UnsupportedProtocolFeatureError('原生 Messages 内容块重复或无对应结束事件');
        if (argumentsByIndex.has(payload.index)) blocks.get(payload.index).input = responseToolInput({ arguments: argumentsByIndex.get(payload.index) });
        return;
      }
      if (type === 'message_delta') {
        Object.assign(message, cloneJson(payload.delta || {}));
        if (payload.usage) message.usage = { ...(message.usage || {}), ...cloneJson(payload.usage) };
        return;
      }
      if (type === 'message_stop') {
        if (open.size || !message.stop_reason) throw new UnsupportedProtocolFeatureError('原生 Messages 流缺少内容块结束或有效 stop_reason');
        message.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block);
        complete = true; return;
      }
      throw new UnsupportedProtocolFeatureError(`无法保真聚合原生 Messages 事件 ${type}`);
    },
    isComplete() { return complete; },
    build() { return rewriteModelInPayload('messages', cloneJson(message), publicModel); },
  };
}

function canonicalEventStart(accumulator, payload, fallbackModel = '') {
  if (accumulator.id) {
    return [];
  }
  accumulator.id = payload.id || payload.response?.id || `airouter-${randomUUID()}`;
  accumulator.createdAt = payload.created || payload.created_at || Math.floor(Date.now() / 1000);
  accumulator.model = payload.model || payload.response?.model || fallbackModel;
  return [{
    type: 'start',
    id: accumulator.id,
    model: accumulator.model,
    createdAt: accumulator.createdAt,
    ...(Object.prototype.hasOwnProperty.call(payload, 'service_tier') ? { serviceTier: cloneJson(payload.service_tier) } : {}),
  }];
}

function accumulateCanonicalEvent(accumulator, event) {
  if (!event) {
    return;
  }
  if (Object.prototype.hasOwnProperty.call(event, 'serviceTier')) accumulator.serviceTier = cloneJson(event.serviceTier);
  if (Object.prototype.hasOwnProperty.call(event, 'logprobs')) {
    if (!Array.isArray(event.logprobs)) throw new UnsupportedProtocolFeatureError('logprobs: 流 token 概率必须为数组');
    if (!accumulator.logprobs) accumulator.logprobs = { content: null, refusal: null };
    const key = event.type === 'refusal_delta' ? 'refusal' : 'content';
    if (!Array.isArray(accumulator.logprobs[key])) accumulator.logprobs[key] = [];
    accumulator.logprobs[key].push(...cloneJson(event.logprobs));
  }
  if (event.type === 'start') {
    accumulator.id = event.id || accumulator.id;
    accumulator.createdAt = event.createdAt || accumulator.createdAt;
    accumulator.model = event.model || accumulator.model;
  } else if (event.type === 'text_delta') {
    accumulator.text += event.text || '';
    const previous = accumulator.orderedParts?.at(-1);
    if (previous?.type === 'text') previous.text += event.text || '';
    else accumulator.orderedParts?.push({ type: 'text', text: event.text || '' });
  } else if (event.type === 'refusal_delta') {
    accumulator.refusal += event.text || '';
    const previous = accumulator.orderedParts?.at(-1);
    if (previous?.type === 'refusal') previous.text += event.text || '';
    else accumulator.orderedParts?.push({ type: 'refusal', text: event.text || '' });
  } else if (event.type === 'reasoning_start') {
    if (!accumulator.reasoning.has(event.index)) {
      const part = cloneJson(event.part);
      accumulator.reasoning.set(event.index, part);
      accumulator.orderedParts.push(part);
    }
  } else if (event.type === 'reasoning_delta') {
    const part = accumulator.reasoning.get(event.index);
    if (part) {
      if (event.kind === 'summary') {
        const index = event.summaryIndex || 0;
        if (!part.summary[index]) part.summary[index] = { type: 'summary_text', text: '' };
        part.summary[index].text += event.text || '';
      } else part.text += event.text || '';
    }
  } else if (event.type === 'reasoning_end') {
    const part = accumulator.reasoning.get(event.index);
    if (part) Object.assign(part, cloneJson(event.part));
  } else if (event.type === 'tool_start') {
    const index = Number(event.index);
    if (!accumulator.tools.has(index)) {
      accumulator.toolOrder.push(index);
    }
    const previous = accumulator.tools.get(index);
    const tool = previous || { type: 'tool_use', id: event.id, name: event.name, arguments: '' };
    tool.id = event.id || tool.id; tool.name = event.name || tool.name;
    accumulator.tools.set(index, tool);
    if (!previous) accumulator.orderedParts?.push(tool);
  } else if (event.type === 'tool_args_delta') {
    const tool = accumulator.tools.get(Number(event.index));
    if (tool) {
      tool.arguments += event.partial || '';
    }
  } else if (event.type === 'finish') {
    accumulator.stopReason = event.stopReason === 'content_filter' ? 'content_filter' : accumulator.refusal ? 'refusal' : event.stopReason || accumulator.stopReason;
    accumulator.usage = event.usage || accumulator.usage;
    if (Object.prototype.hasOwnProperty.call(event, 'stopSequence')) accumulator.stopSequence = event.stopSequence;
    accumulator.finished = true;
  } else if (event.type === 'error') {
    accumulator.error = { message: event.message, code: event.code };
  }
}

function createCanonicalAccumulator(publicModel, sourceProtocol) {
  const accumulator = {
    sourceProtocol,
    id: '',
    model: publicModel || '',
    createdAt: Math.floor(Date.now() / 1000),
    text: '',
    refusal: '',
    tools: new Map(),
    toolOrder: [],
    reasoning: new Map(),
    orderedParts: [],
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
      const parts = accumulator.orderedParts.filter(part => part.type !== 'text' || part.text).map(part => {
        const value = cloneJson(part);
        if (value.type === 'text' && accumulator.stopReason === 'refusal') value.type = 'refusal';
        return value;
      });
      const stopReason = accumulator.stopReason === 'end_turn' && accumulator.toolOrder.length
        ? 'tool_use'
        : accumulator.stopReason;
      return {
        sourceProtocol: accumulator.sourceProtocol,
        id: accumulator.id,
        model: publicModel || accumulator.model,
        createdAt: accumulator.createdAt,
        parts,
        stopReason,
        ...(Object.prototype.hasOwnProperty.call(accumulator, 'serviceTier') ? { serviceTier: cloneJson(accumulator.serviceTier) } : {}),
        ...(accumulator.logprobs ? { logprobs: cloneJson(accumulator.logprobs) } : {}),
        ...(Object.prototype.hasOwnProperty.call(accumulator, 'stopSequence') ? { stopSequence: accumulator.stopSequence } : {}),
        usage: accumulator.usage,
        ...(accumulator.error ? { error: accumulator.error } : {}),
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
  const accumulator = createCanonicalAccumulator(publicModel, targetProtocol);
  const toolIndexes = new Map();
  let nextToolIndex = 0;
  let sawFinish = false;
  let pendingChatFinish = null;
  let chatReasoningSegment = 0;
  let activeChatReasoning = null;
  let chatChoiceIndex;
  const responseLogprobs = new Map();
  const reasoning = new Map();
  let nextReasoningIndex = 0;
  function reasoningStart(events, key, raw) {
    key = String(key);
    if (reasoning.has(key)) return reasoning.get(key);
    const source = require('./reasoning-content').parseSourceReasoning(targetProtocol, raw)[0]
      || { type: 'reasoning', text: '', summary: [], originProtocol: targetProtocol, originBlock: cloneJson(raw), opaque: false };
    const part = { ...source, text: '', summary: (source.summary || []).map(value => ({ ...value, text: '' })) };
    const state = { index: nextReasoningIndex++, raw: cloneJson(raw), text: '', summary: [], ended: false };
    reasoning.set(key, state); events.push({ type: 'reasoning_start', index: state.index, part }); return state;
  }
  function reasoningDelta(events, state, text, kind = 'text', summaryIndex = 0) {
    if (typeof text !== 'string' || !text) return;
    if (state.ended) throw new UnsupportedProtocolFeatureError('reasoning: 已结束的思考块不能继续追加');
    if (kind === 'summary') state.summary[summaryIndex] = (state.summary[summaryIndex] || '') + text;
    else state.text += text;
    events.push({ type: 'reasoning_delta', index: state.index, text, kind, summaryIndex });
  }
  function reasoningEnd(events, state, raw = state.raw) {
    const part = require('./reasoning-content').parseSourceReasoning(targetProtocol, raw)[0];
    if (!part) return;
    if (state.ended) return;
    if (!part.text.startsWith(state.text)) throw new UnsupportedProtocolFeatureError('reasoning: 完成文本与已输出思考分片不一致');
    reasoningDelta(events, state, part.text.slice(state.text.length));
    for (const [index, summary] of (part.summary || []).entries()) {
      const previous = state.summary[index] || '';
      if (!summary.text.startsWith(previous)) throw new UnsupportedProtocolFeatureError('reasoning.summary: 完成摘要与已输出分片不一致');
      reasoningDelta(events, state, summary.text.slice(previous.length), 'summary', index);
    }
    state.raw = cloneJson(raw); state.ended = true;
    events.push({ type: 'reasoning_end', index: state.index, part });
  }
  function responseProbabilityEvents(events, payload, snapshot = false) {
    if (!Object.prototype.hasOwnProperty.call(payload, 'logprobs')) return;
    if (!Array.isArray(payload.logprobs)) throw new UnsupportedProtocolFeatureError('logprobs: Responses 流 token 概率必须为数组');
    const key = `${payload.output_index ?? 0}:${payload.content_index ?? 0}`;
    const hadPrevious = responseLogprobs.has(key);
    const previous = responseLogprobs.get(key) || [];
    let delta = payload.logprobs;
    if (snapshot) {
      if (!isDeepStrictEqual(payload.logprobs.slice(0, previous.length), previous)) throw new UnsupportedProtocolFeatureError('logprobs: Responses 终态与已输出概率不一致');
      delta = payload.logprobs.slice(previous.length);
    }
    responseLogprobs.set(key, [...previous, ...cloneJson(delta)]);
    if (delta.length || !hadPrevious) {
      const textEvent = events.findLast(event => event.type === 'text_delta' && !Object.prototype.hasOwnProperty.call(event, 'logprobs'));
      if (textEvent) textEvent.logprobs = cloneJson(delta);
      else events.push({ type: 'text_delta', text: '', logprobs: cloneJson(delta) });
    }
  }

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
      sawFinish = true;
      return emit([{
        type: 'error',
        message: payload.error.message || String(payload.error),
        code: payload.error.code || 'upstream_error',
      }]);
    }

    if (targetProtocol === 'chat_completions') {
      const events = [];
      assertResponseContentSupported('chat_completions', payload);
      if (payload.choices?.length > 1) throw new UnsupportedProtocolFeatureError('choices: 多个 Chat 候选无法无损转换为单次跨协议响应');
      if (Object.prototype.hasOwnProperty.call(payload, 'service_tier')) events.push({ type: 'metadata', serviceTier: cloneJson(payload.service_tier) });
      if (!accumulator.accumulator.id) {
        events.push(...canonicalEventStart(accumulator.accumulator, payload));
      }
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
      if (choice) {
        const sourceIndex = choice.index ?? 0;
        if (chatChoiceIndex !== undefined && chatChoiceIndex !== sourceIndex) throw new UnsupportedProtocolFeatureError('choices: 多个 Chat choice.index 不能合并为单次跨协议响应');
        chatChoiceIndex = sourceIndex;
        const delta = choice.delta || choice.message || {};
        const thought = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
        const mirroredDetailText = Array.isArray(delta.reasoning_details) && delta.reasoning_details.filter(item => item?.type === 'reasoning.text').map(item => item.text || '').join('');
        if (thought && mirroredDetailText !== thought) {
          if (!activeChatReasoning || activeChatReasoning.ended) activeChatReasoning = reasoningStart(events, `chat-text:${chatReasoningSegment++}`, { reasoning_content: '' });
          const state = activeChatReasoning;
          reasoningDelta(events, state, thought);
          state.raw.reasoning_content = state.text;
        }
        if ((delta.content || delta.refusal || delta.tool_calls?.length || choice.finish_reason) && activeChatReasoning && !activeChatReasoning.ended) reasoningEnd(events, activeChatReasoning);
        if (Array.isArray(delta.reasoning_details)) {
          for (const [detailIndex, detail] of delta.reasoning_details.entries()) {
            const key = `chat-detail:${detail.index ?? detailIndex}`;
            const empty = { ...detail, ...(detail.type === 'reasoning.text' ? { text: '' } : {}), ...(detail.type === 'reasoning.summary' ? { summary: '' } : {}) };
            const state = reasoningStart(events, key, { reasoning_details: [empty] });
            const previous = state.raw.reasoning_details[0];
            for (const [name, value] of Object.entries(detail)) {
              if (name === 'text' && detail.type === 'reasoning.text') {
                previous.text = (previous.text || '') + value;
                reasoningDelta(events, state, value);
              } else if (name === 'summary' && detail.type === 'reasoning.summary') {
                previous.summary = (previous.summary || '') + value;
                reasoningDelta(events, state, value, 'summary');
              } else {
                if (Object.prototype.hasOwnProperty.call(previous, name) && !isDeepStrictEqual(previous[name], value)) throw new UnsupportedProtocolFeatureError(`reasoning_details.${name}: 没有已核实的不透明分片合并规则，不能覆盖或猜测拼接`);
                previous[name] = cloneJson(value);
              }
            }
            if (choice.finish_reason) reasoningEnd(events, state);
          }
        }
        const text = contentToText(delta.content);
        if (text || Array.isArray(choice.logprobs?.content)) {
          events.push({ type: 'text_delta', text, ...(Array.isArray(choice.logprobs?.content) ? { logprobs: cloneJson(choice.logprobs.content) } : {}) });
        }
        if (typeof delta.refusal === 'string' && delta.refusal || Array.isArray(choice.logprobs?.refusal) && choice.logprobs.refusal.length) events.push({ type: 'refusal_delta', text: delta.refusal || '', ...(Array.isArray(choice.logprobs?.refusal) ? { logprobs: cloneJson(choice.logprobs.refusal) } : {}) });
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
          for (const state of reasoning.values()) if (!state.ended) reasoningEnd(events, state);
          pendingChatFinish = {
            stopReason: choice.finish_reason === 'content_filter' ? 'content_filter' : delta.refusal || accumulator.accumulator.refusal ? 'refusal' : mapChatStopToCanonical(choice.finish_reason),
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
      if (payload.response && Object.prototype.hasOwnProperty.call(payload.response, 'service_tier')) events.push({ type: 'metadata', serviceTier: cloneJson(payload.response.service_tier) });
      if (payload.response) assertResponseContentSupported('responses', payload.response);
      if (payload.item) assertResponseContentSupported('responses', { output: [payload.item] });
      if (type === 'response.created' || type === 'response.in_progress') {
        events.push(...canonicalEventStart(accumulator.accumulator, payload.response || payload));
      } else if (type === 'response.output_item.added') {
        if (!accumulator.accumulator.id) {
          events.push(...canonicalEventStart(accumulator.accumulator, payload.response || {}));
        }
        const item = payload.item || {};
        if (item.type === 'reasoning') {
          reasoningStart(events, item.id || payload.output_index, item);
        } else if (item.type === 'function_call') {
          events.push({
            type: 'tool_start',
            index: resolveToolIndex(item.id || item.call_id || payload.output_index),
            id: item.call_id || item.id,
            name: item.name,
          });
        }
      } else if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
        const key = payload.item_id || payload.output_index;
        const state = reasoning.get(String(key)) || reasoningStart(events, key, { id: payload.item_id, type: 'reasoning', summary: [] });
        reasoningDelta(events, state, payload.delta || '', type.includes('summary') ? 'summary' : 'text', payload.summary_index || 0);
      } else if (type === 'response.output_text.delta') {
        events.push({ type: 'text_delta', text: payload.delta || '' });
        responseProbabilityEvents(events, payload);
      } else if (type === 'response.refusal.delta') {
        events.push({ type: 'refusal_delta', text: payload.delta || '' });
      } else if (type === 'response.refusal.done' && !accumulator.accumulator.refusal && payload.refusal) {
        events.push({ type: 'refusal_delta', text: payload.refusal });
      } else if (type === 'response.output_text.done' && !accumulator.accumulator.text && payload.text) {
        events.push({ type: 'text_delta', text: payload.text });
        responseProbabilityEvents(events, payload, true);
      } else if (type === 'response.output_text.done') {
        responseProbabilityEvents(events, payload, true);
      } else if (type === 'response.function_call_arguments.delta') {
        events.push({
          type: 'tool_args_delta',
          index: resolveToolIndex(payload.item_id),
          partial: payload.delta || '',
        });
      } else if (type === 'response.output_item.done') {
        const item = payload.item || {};
        if (item.type === 'reasoning') {
          const state = reasoning.get(String(item.id || payload.output_index)) || reasoningStart(events, item.id || payload.output_index, item);
          reasoningEnd(events, state, item);
        } else if (item.type === 'function_call') {
          const index = resolveToolIndex(item.id || item.call_id || payload.output_index);
          if (!accumulator.accumulator.tools.get(index)?.arguments && item.arguments) {
            events.push({ type: 'tool_args_delta', index, partial: item.arguments });
          }
          events.push({ type: 'tool_end', index });
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        const response = payload.response || {};
        if (!accumulator.accumulator.orderedParts.length && response.output?.some(item => item?.type === 'reasoning')) {
          // Some compatible endpoints send only a complete terminal snapshot.
          // Replay its logical items in source order, never in type buckets.
          const canonical = parseResponsesResponse(response);
          if (!accumulator.accumulator.id) events.push(...canonicalEventStart(accumulator.accumulator, response));
          for (const [partIndex, part] of canonical.parts.entries()) {
            if (part.type === 'reasoning') {
              const key = part.originBlock.id || `terminal:${partIndex}`;
              const state = reasoningStart(events, key, part.originBlock);
              reasoningEnd(events, state, part.originBlock);
            } else if (part.type === 'text') events.push({ type: 'text_delta', text: part.text, ...(Object.prototype.hasOwnProperty.call(part, 'logprobs') ? { logprobs: cloneJson(part.logprobs) } : {}) });
            else if (part.type === 'refusal') events.push({ type: 'refusal_delta', text: part.text });
            else if (part.type === 'tool_use') {
              const index = resolveToolIndex(part.id);
              events.push({ type: 'tool_start', index, id: part.id, name: part.name }, { type: 'tool_args_delta', index, partial: part.arguments }, { type: 'tool_end', index });
            }
          }
          sawFinish = true;
          events.push({ type: 'finish', stopReason: canonical.stopReason, usage: canonical.usage });
          return emit(events);
        }
        for (const [outputIndex, item] of (response.output || []).entries()) if (item?.type === 'reasoning') {
          const key = item.id || outputIndex;
          const state = reasoning.get(String(key)) || reasoningStart(events, key, item);
          reasoningEnd(events, state, item);
        }
        for (const [output_index, item] of (response.output || []).entries()) for (const [content_index, block] of (item.content || []).entries()) {
          if (block.type === 'output_text') responseProbabilityEvents(events, { ...block, output_index, content_index }, true);
        }
        if (!accumulator.accumulator.id) events.push(...canonicalEventStart(accumulator.accumulator, response));
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
        if (!accumulator.accumulator.refusal) {
          const refusal = (response.output || []).flatMap(item => item?.content || []).filter(block => block?.type === 'refusal').map(block => block.refusal || '').join('');
          if (refusal) events.push({ type: 'refusal_delta', text: refusal });
        }
        const hasTool = Array.isArray(response.output) && response.output.some(item => item.type === 'function_call');
        for (const item of Array.isArray(response.output) ? response.output : []) {
          if (item?.type !== 'function_call') continue;
          const index = resolveToolIndex(item.id || item.call_id);
          const existing = accumulator.accumulator.tools.get(index);
          if (!existing) events.push({ type: 'tool_start', index, id: item.call_id || item.id, name: item.name });
          if (!existing?.arguments && typeof item.arguments === 'string' && item.arguments) events.push({ type: 'tool_args_delta', index, partial: item.arguments });
        }
        if (type === 'response.incomplete' && !['max_output_tokens', 'content_filter'].includes(response.incomplete_details?.reason)) {
          sawFinish = true;
          events.push({ type: 'error', code: 'unsupported_protocol_feature', message: `无法准确映射 Responses incomplete 原因: ${response.incomplete_details?.reason || 'unknown'}` });
          return emit(events);
        }
        const stopReason = response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : accumulator.accumulator.refusal || events.some(event => event.type === 'refusal_delta')
          ? 'refusal'
          : response.incomplete_details && response.incomplete_details.reason === 'max_output_tokens'
            ? 'max_tokens'
            : hasTool ? 'tool_use' : 'end_turn';
        events.push({ type: 'finish', stopReason, usage });
        sawFinish = true;
      } else if (type === 'response.failed') {
        sawFinish = true;
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
      assertResponseContentSupported('messages', { content: [block] });
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        reasoningStart(events, payload.index, block);
      } else if (block.type === 'tool_use') {
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
      if (['thinking_delta', 'signature_delta'].includes(delta.type)) {
        const state = reasoning.get(String(payload.index));
        if (!state || state.ended) throw new UnsupportedProtocolFeatureError('thinking/signature 分片没有对应活动思考块');
        if (delta.type === 'thinking_delta') {
          state.raw.thinking = (state.raw.thinking || '') + (delta.thinking || '');
          reasoningDelta(events, state, delta.thinking || '', 'summary');
        } else state.raw.signature = (state.raw.signature || '') + (delta.signature || '');
      } else if (delta.type === 'text_delta') {
        events.push({ type: 'text_delta', text: delta.text || '' });
      } else if (delta.type === 'input_json_delta') {
        events.push({
          type: 'tool_args_delta',
          index: resolveToolIndex(payload.index),
          partial: delta.partial_json || '',
        });
      }
    } else if (type === 'content_block_stop') {
      const thought = reasoning.get(String(payload.index));
      if (thought) reasoningEnd(events, thought);
      const index = toolIndexes.get(String(payload.index));
      if (typeof index === 'number') {
        events.push({ type: 'tool_end', index });
      }
    } else if (type === 'message_delta') {
      if (payload.delta?.stop_reason && [...reasoning.values()].some(state => !state.ended)) {
        sawFinish = true;
        return emit([{ type: 'error', code: 'incomplete_upstream_stream', message: 'Messages 思考块在终态前缺少完整结束事件' }]);
      }
      accumulator.accumulator.usage = usageFromMessages(payload.usage, accumulator.accumulator.usage);
      if (payload.delta?.stop_reason) events.push({
        type: 'finish',
        stopReason: mapMessagesStopToCanonical(payload.delta?.stop_reason),
        ...(Object.prototype.hasOwnProperty.call(payload.delta, 'stop_sequence') ? { stopSequence: payload.delta.stop_sequence } : {}),
        usage: accumulator.accumulator.usage,
      });
    } else if (type === 'message_stop') {
      if (!sawFinish) {
        events.push({
          type: 'error', code: 'incomplete_upstream_stream', message: 'Messages 流缺少有效 stop_reason',
        });
      }
      sawFinish = true;
    } else if (type === 'error') {
      events.push({
        type: 'error',
        message: payload.error?.message || '上游 Messages 响应失败',
        code: payload.error?.type || 'upstream_error',
      });
    }

    if (type === 'message_delta' && payload.delta?.stop_reason) {
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
        const events = [];
        for (const state of reasoning.values()) if (!state.ended) reasoningEnd(events, state);
        return emit([...events, finish]);
      }
      sawFinish = true;
      return emit([{ type: 'error', code: 'incomplete_upstream_stream', message: '上游流在有效终态前结束' }]);
    },
    build() {
      return accumulator.build();
    },
    isComplete() {
      return accumulator.accumulator.finished;
    },
  };
}

function createEntryEventSerializer(entryProtocol, publicModel, sourceProtocol, options = {}) {
  const state = {
    started: false,
    finished: false,
    responseId: responseIdFor(entryProtocol, undefined, sourceProtocol),
    createdAt: Math.floor(Date.now() / 1000),
    text: '',
    refusal: '',
    refusalOutputIndex: null,
    refusalItemId: null,
    tools: new Map(),
    toolOrder: [],
    openTextBlock: false,
    nextBlockIndex: 0,
    textBlockIndex: null,
    toolBlockIndexes: new Map(),
    responseOutputItems: new Map(),
    reasoning: new Map(),
    segmentText: '',
    textItemCount: 0,
    nextOutputIndex: 0,
    textOutputIndex: null,
    textItemId: null,
    usage: null,
    stopReason: 'end_turn',
    nextSequence: 0,
  };

  function decorate(entries, canonicalEvent = {}) {
    for (const entry of entries) {
      if (entryProtocol === 'chat_completions' && entry.data?.choices) {
        if (Object.prototype.hasOwnProperty.call(state, 'serviceTier')) entry.data.service_tier = cloneJson(state.serviceTier);
        if (options.includeUsage === true && entry.data.choices.length) entry.data.usage = null;
        else if (options.includeUsage === false) delete entry.data.usage;
        if (canonicalEvent.type === 'text_delta' && Object.prototype.hasOwnProperty.call(canonicalEvent, 'logprobs')) {
          for (const choice of entry.data.choices) if (choice.delta && Object.prototype.hasOwnProperty.call(choice.delta, 'content')) choice.logprobs = { content: cloneJson(canonicalEvent.logprobs), refusal: null };
        }
      } else if (entryProtocol === 'responses') {
        if (entry.data && typeof entry.data === 'object' && entry.event) entry.data.sequence_number = state.nextSequence++;
        if (entry.data?.response && Object.prototype.hasOwnProperty.call(state, 'serviceTier')) entry.data.response.service_tier = cloneJson(state.serviceTier);
        if (entry.event === 'response.output_text.delta' && Object.prototype.hasOwnProperty.call(canonicalEvent, 'logprobs')) entry.data.logprobs = cloneJson(canonicalEvent.logprobs);
      }
    }
    return entries;
  }

  function ensureStarted(canonicalEvent = {}) {
    const events = [];
    if (state.started) {
      return events;
    }
    state.started = true;
    if (canonicalEvent.id) {
      state.responseId = responseIdFor(entryProtocol, canonicalEvent.id, sourceProtocol);
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
            usage: serializeUsage(state.usage, 'messages') || {},
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

  function closeText() {
    const events = [];
    if (entryProtocol === 'messages' && state.textBlockIndex !== null) {
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: state.textBlockIndex } });
      state.textBlockIndex = null;
    } else if (entryProtocol === 'responses' && state.textOutputIndex !== null) {
      const common = { item_id: state.textItemId, output_index: state.textOutputIndex, content_index: 0 };
      const part = { type: 'output_text', text: state.segmentText, annotations: [] };
      const item = { id: state.textItemId, type: 'message', status: 'completed', role: 'assistant', content: [part] };
      events.push({ event: 'response.output_text.done', data: { type: 'response.output_text.done', ...common, text: part.text } });
      events.push({ event: 'response.content_part.done', data: { type: 'response.content_part.done', ...common, part } });
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: common.output_index, item } });
      state.responseOutputItems.set(common.output_index, item);
      state.textOutputIndex = null;
    }
    state.segmentText = '';
    return events;
  }

  function handleReasoningStart(event) {
    if (state.reasoning.has(event.index)) return [];
    const events = [...ensureStarted(), ...closeText()];
    const block = { part: cloneJson(event.part), ended: false, summaryStarted: new Set(), text: '', emittedText: '', summaries: [] };
    state.reasoning.set(event.index, block);
    if (entryProtocol === 'responses') {
      block.outputIndex = state.nextOutputIndex++;
      block.itemId = block.part.originProtocol === 'responses' && entryProtocol === sourceProtocol && block.part.originBlock?.id
        || `rs_${state.responseId.replace(/^resp_/, '')}_${block.outputIndex}`;
      events.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: block.outputIndex,
        item: { id: block.itemId, type: 'reasoning', status: 'in_progress', summary: [], content: [] } } });
    } else if (entryProtocol === 'messages') {
      block.blockIndex = state.nextBlockIndex++;
      if (block.part.originBlock?.type !== 'redacted_thinking') events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: block.blockIndex, content_block: { type: 'thinking', thinking: '' } } });
    }
    return events;
  }

  function handleReasoningDelta(event) {
    const block = state.reasoning.get(event.index);
    if (!block || block.ended) throw new UnsupportedProtocolFeatureError('reasoning: 分片没有对应活动块');
    const text = event.text || '';
    if (event.kind === 'summary') block.summaries[event.summaryIndex || 0] = (block.summaries[event.summaryIndex || 0] || '') + text;
    else block.text += text;
    if (entryProtocol === 'chat_completions') {
      // Opaque text and summaries are emitted together with their origin ticket
      // at block completion. Plain DeepSeek text can stream immediately.
      if (event.kind === 'summary' || block.part.opaque) return [];
      block.emittedText += text;
      return [{ event: null, data: { id: state.responseId, object: 'chat.completion.chunk', created: state.createdAt, model: publicModel,
        choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] } }];
    }
    if (entryProtocol === 'messages') return [];
    const common = { item_id: block.itemId, output_index: block.outputIndex };
    if (event.kind === 'summary') {
      const index = event.summaryIndex || 0, events = [];
      if (!block.summaryStarted.has(index)) {
        block.summaryStarted.add(index);
        events.push({ event: 'response.reasoning_summary_part.added', data: { type: 'response.reasoning_summary_part.added', ...common, summary_index: index, part: { type: 'summary_text', text: '' } } });
      }
      events.push({ event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', ...common, summary_index: index, delta: text } });
      return events;
    }
    return [{ event: 'response.reasoning_text.delta', data: { type: 'response.reasoning_text.delta', ...common, content_index: 0, delta: text } }];
  }

  function handleReasoningEnd(event) {
    const block = state.reasoning.get(event.index);
    if (!block || block.ended) return [];
    block.ended = true;
    block.part = cloneJson(event.part);
    const wire = require('./reasoning-content').renderReasoning(entryProtocol, block.part, options.reasoningTransport);
    // Preserve readable source names separately from the answer and the opaque
    // transport ticket. Only completed blocks reach this point.
    const upstreamReasoning = wire.airouter_upstream_reasoning || { ...cloneJson(block.part.originBlock), protocol: block.part.originProtocol };
    wire.airouter_upstream_reasoning = upstreamReasoning;
    const events = [];
    if (entryProtocol === 'chat_completions') {
      const delta = { ...wire };
      if (!block.part.opaque && typeof delta.reasoning_content === 'string') {
        if (!delta.reasoning_content.startsWith(block.emittedText)) throw new UnsupportedProtocolFeatureError('reasoning: 完成文本与已输出分片不一致');
        delta.reasoning_content = delta.reasoning_content.slice(block.emittedText.length);
        if (!delta.reasoning_content) delete delta.reasoning_content;
      }
      if (Object.keys(delta).length) events.push({ event: null, data: { id: state.responseId, object: 'chat.completion.chunk', created: state.createdAt, model: publicModel,
        choices: [{ index: 0, delta, finish_reason: null }] } });
    } else if (entryProtocol === 'messages') {
      if (wire.type === 'redacted_thinking') events.push({ event: 'content_block_start', data: { type: 'content_block_start', index: block.blockIndex, content_block: wire } });
      else {
        events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: block.blockIndex, delta: { type: 'thinking_delta', thinking: wire.thinking } } });
        if (typeof wire.signature === 'string') events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index: block.blockIndex, delta: { type: 'signature_delta', signature: wire.signature } } });
      }
      events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: block.blockIndex, airouter_upstream_reasoning: upstreamReasoning } });
    } else {
      wire.id = block.itemId;
      wire.status = 'completed';
      const common = { item_id: block.itemId, output_index: block.outputIndex };
      if (block.part.text) events.push({ event: 'response.reasoning_text.done', data: { type: 'response.reasoning_text.done', ...common, content_index: 0, text: block.part.text } });
      for (const [index, part] of (wire.summary || []).entries()) {
        if (!block.summaryStarted.has(index)) events.push({ event: 'response.reasoning_summary_part.added', data: { type: 'response.reasoning_summary_part.added', ...common, summary_index: index, part: { type: 'summary_text', text: '' } } });
        events.push({ event: 'response.reasoning_summary_text.done', data: { type: 'response.reasoning_summary_text.done', ...common, summary_index: index, text: part.text } });
        events.push({ event: 'response.reasoning_summary_part.done', data: { type: 'response.reasoning_summary_part.done', ...common, summary_index: index, part } });
      }
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: block.outputIndex, item: wire } });
      state.responseOutputItems.set(block.outputIndex, wire);
    }
    return events;
  }

  function handleText(text) {
    const events = ensureStarted();
    state.text += text;
    state.segmentText += text;
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
        state.textItemId = `msg_${state.responseId.replace(/^resp_/, '')}${state.textItemCount++ ? `_${state.textOutputIndex}` : ''}`;
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
    const events = [...ensureStarted(), ...closeText()];
    if (state.tools.has(event.index)) {
      const existing = state.tools.get(event.index);
      existing.id = event.id || existing.id;
      existing.name = event.name || existing.name;
      return events;
    }
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

  function handleRefusal(text) {
    const events = ensureStarted();
    state.refusal += text;
    state.stopReason = 'refusal';
    if (entryProtocol === 'messages') return [...events, ...handleText(text)];
    if (entryProtocol === 'chat_completions') {
      events.push({ event: null, data: { id: state.responseId, object: 'chat.completion.chunk', created: state.createdAt, model: publicModel,
        choices: [{ index: 0, delta: { refusal: text }, finish_reason: null }] } });
      return events;
    }
    if (state.refusalOutputIndex === null) {
      state.refusalOutputIndex = state.nextOutputIndex++;
      state.refusalItemId = `msg_${state.responseId.replace(/^resp_/, '')}_refusal`;
      events.push({ event: 'response.output_item.added', data: { type: 'response.output_item.added', output_index: state.refusalOutputIndex,
        item: { id: state.refusalItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } } });
      events.push({ event: 'response.content_part.added', data: { type: 'response.content_part.added', item_id: state.refusalItemId,
        output_index: state.refusalOutputIndex, content_index: 0, part: { type: 'refusal', refusal: '' } } });
    }
    events.push({ event: 'response.refusal.delta', data: { type: 'response.refusal.delta', item_id: state.refusalItemId,
      output_index: state.refusalOutputIndex, content_index: 0, delta: text } });
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
    if (!tool || tool.ended) {
      return [];
    }
    tool.ended = true;
    const events = [];
    if (entryProtocol === 'messages') {
      const blockIndex = state.toolBlockIndexes.get(event.index);
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: blockIndex },
      });
    } else if (entryProtocol === 'responses') {
      const item = { id: tool.id, type: 'function_call', status: 'completed', call_id: tool.id, name: tool.name, arguments: tool.args };
      state.responseOutputItems.set(tool.outputIndex, item);
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
    if ([...state.reasoning.values()].some(block => !block.ended)) {
      state.finished = true;
      return [{ event: 'error', data: { type: 'error', error: { code: 'incomplete_upstream_stream', message: '思考块缺少完整终态，不能伪造成功响应' } } }];
    }
    if (entryProtocol !== 'messages' && !['end_turn', 'stop_sequence', 'max_tokens', 'tool_use', 'refusal', 'content_filter', ...(entryProtocol === 'chat_completions' ? ['model_context_window_exceeded'] : [])].includes(event.stopReason || 'end_turn')) {
      state.finished = true;
      return [{ event: 'error', data: { type: 'error', error: { code: 'unsupported_protocol_feature', message: `无法保真转换上游终态 ${event.stopReason}` } } }];
    }
    let terminalRefusal = [];
    if (event.stopReason === 'refusal' && !state.refusal && state.text && entryProtocol !== 'messages') terminalRefusal = handleRefusal(state.text);
    if (entryProtocol === 'messages' && !['max_tokens', 'refusal', 'content_filter'].includes(event.stopReason)) {
      try { for (const tool of state.tools.values()) responseToolInput({ arguments: tool.args }); }
      catch (error) {
        state.finished = true;
        return [{ event: 'error', data: { type: 'error', error: { code: error.code, message: error.message } } }];
      }
    }
    state.finished = true;
    state.usage = event.usage || state.usage;
    if (Object.prototype.hasOwnProperty.call(event, 'stopSequence')) state.stopSequence = event.stopSequence;
    state.stopReason = event.stopReason === 'content_filter' ? 'content_filter' : state.refusal ? 'refusal' : event.stopReason || state.stopReason;
    const events = [...terminalRefusal, ...ensureStarted()];
    // Chat has no per-call end event; close each still-open tool exactly once
    // before the response terminal (also covers Responses completion-only tools).
    for (const index of state.toolOrder) events.push(...handleToolEnd({ index }));
    const text = state.segmentText;

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
          usage: serializeUsage(state.usage, 'chat_completions'),
        },
      });
      if (options.includeUsage === true) events.push({ event: null, data: { id: state.responseId, object: 'chat.completion.chunk', created: state.createdAt, model: publicModel, choices: [], usage: serializeUsage(state.usage, 'chat_completions') || null } });
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
            ...(Object.prototype.hasOwnProperty.call(state, 'stopSequence') ? { stop_sequence: state.stopSequence } : {}),
          },
          usage: serializeUsage(state.usage, 'messages') || {},
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
          ...(Array.isArray(state.logprobs?.content) ? { logprobs: cloneJson(state.logprobs.content) } : {}),
        },
      });
      events.push({
        event: 'response.content_part.done',
        data: {
          type: 'response.content_part.done',
          item_id: state.textItemId,
          output_index: state.textOutputIndex,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [], ...(Array.isArray(state.logprobs?.content) ? { logprobs: cloneJson(state.logprobs.content) } : {}) },
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
            content: [{ type: 'output_text', text, annotations: [], ...(Array.isArray(state.logprobs?.content) ? { logprobs: cloneJson(state.logprobs.content) } : {}) }],
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
        content: [{ type: 'output_text', text, annotations: [], ...(Array.isArray(state.logprobs?.content) ? { logprobs: cloneJson(state.logprobs.content) } : {}) }],
      });
      state.responseOutputItems.set(state.textOutputIndex, output.at(-1));
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
        state.responseOutputItems.set(tool.outputIndex, output.at(-1));
      }
    }
    if (state.refusalOutputIndex !== null) {
      const content = { type: 'refusal', refusal: state.refusal };
      const item = { id: state.refusalItemId, type: 'message', status: 'completed', role: 'assistant', content: [content] };
      const position = { item_id: state.refusalItemId, output_index: state.refusalOutputIndex, content_index: 0 };
      events.push({ event: 'response.refusal.done', data: { type: 'response.refusal.done', ...position, refusal: state.refusal } });
      events.push({ event: 'response.content_part.done', data: { type: 'response.content_part.done', ...position, part: content } });
      events.push({ event: 'response.output_item.done', data: { type: 'response.output_item.done', output_index: state.refusalOutputIndex, item } });
      output.push(item);
      state.responseOutputItems.set(state.refusalOutputIndex, item);
    }
    const incomplete = ['max_tokens', 'content_filter'].includes(state.stopReason);
    events.push({
      event: incomplete ? 'response.incomplete' : 'response.completed',
      data: {
        type: incomplete ? 'response.incomplete' : 'response.completed',
        response: {
          id: state.responseId,
          object: 'response',
          created_at: state.createdAt,
          status: incomplete ? 'incomplete' : 'completed',
          ...(incomplete ? { incomplete_details: { reason: state.stopReason === 'content_filter' ? 'content_filter' : 'max_output_tokens' } } : {}),
          model: publicModel,
          output: [...state.responseOutputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
          output_text: state.text,
          ...(state.usage ? { usage: serializeUsage(state.usage, 'responses') } : {}),
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
      if (Object.prototype.hasOwnProperty.call(event, 'serviceTier')) state.serviceTier = cloneJson(event.serviceTier);
      if (Object.prototype.hasOwnProperty.call(event, 'logprobs')) {
        if (!Array.isArray(event.logprobs)) throw new UnsupportedProtocolFeatureError('logprobs: 流 token 概率必须为数组');
        if (entryProtocol === 'messages' && event.logprobs.length) throw new UnsupportedProtocolFeatureError('logprobs: Messages 无等价的 token 概率字段');
        if (entryProtocol === 'responses' && event.type === 'refusal_delta' && event.logprobs.length) throw new UnsupportedProtocolFeatureError('logprobs.refusal: Responses refusal 没有等价概率字段');
        if (!state.logprobs) state.logprobs = { content: null, refusal: null };
        const key = event.type === 'refusal_delta' ? 'refusal' : 'content';
        if (!Array.isArray(state.logprobs[key])) state.logprobs[key] = [];
        state.logprobs[key].push(...cloneJson(event.logprobs));
      }
      if (event.type === 'start') {
        return decorate(ensureStarted(event), event);
      }
      if (event.type === 'reasoning_start') return decorate(handleReasoningStart(event), event);
      if (event.type === 'reasoning_delta') return decorate(handleReasoningDelta(event), event);
      if (event.type === 'reasoning_end') return decorate(handleReasoningEnd(event), event);
      if (event.type === 'text_delta') {
        return decorate(handleText(event.text || ''), event);
      }
      if (event.type === 'refusal_delta') return decorate(handleRefusal(event.text || ''), event);
      if (event.type === 'tool_start') {
        return decorate(handleToolStart(event), event);
      }
      if (event.type === 'tool_args_delta') {
        return decorate(handleToolArgs(event), event);
      }
      if (event.type === 'tool_end') {
        return decorate(handleToolEnd(event), event);
      }
      if (event.type === 'finish') {
        return decorate(handleFinish(event), event);
      }
      if (event.type === 'error') {
        state.finished = true;
        return decorate([{ event: 'error', data: { type: 'error', error: { type: 'upstream_error', message: event.message, code: event.code } } }]);
      }
      return [];
    },
    finish() {
      if (state.finished) return [];
      state.finished = true;
      return decorate([{ event: 'error', data: { type: 'error', error: { code: 'incomplete_upstream_stream', message: '上游流在有效终态前结束' } } }]);
    },
  };
}

function createProtocolStreamBridge({ entryProtocol, targetProtocol, publicModel, includeUsage, reasoningTransport }) {
  const targetParser = createTargetEventParser(targetProtocol, publicModel);
  const entrySerializer = createEntryEventSerializer(entryProtocol, publicModel, targetProtocol, { includeUsage, reasoningTransport });
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

function responseToEntrySse(entryProtocol, canonicalResponse, publicModel, options = {}) {
  if (entryProtocol === 'responses' && canonicalResponse.logprobs?.refusal?.length) throw new UnsupportedProtocolFeatureError('logprobs.refusal: Responses refusal 没有等价概率字段');
  const serializer = createEntryEventSerializer(entryProtocol, publicModel, canonicalResponse.sourceProtocol, options);
  const events = [];
  events.push(...serializer.handle({
    type: 'start',
    id: canonicalResponse.id,
    model: publicModel,
    createdAt: canonicalResponse.createdAt,
    ...(Object.prototype.hasOwnProperty.call(canonicalResponse, 'serviceTier') ? { serviceTier: cloneJson(canonicalResponse.serviceTier) } : {}),
  }));

  let toolIndex = 0;
  let reasoningIndex = 0;
  for (const part of canonicalResponse.parts || []) {
    if (part.type === 'reasoning') {
      const index = reasoningIndex++;
      events.push(...serializer.handle({ type: 'reasoning_start', index, part }));
      if (part.text) events.push(...serializer.handle({ type: 'reasoning_delta', index, text: part.text }));
      for (const [summaryIndex, summary] of (part.summary || []).entries()) events.push(...serializer.handle({ type: 'reasoning_delta', index, text: summary.text, kind: 'summary', summaryIndex }));
      events.push(...serializer.handle({ type: 'reasoning_end', index, part }));
    } else if (part.type === 'text') {
      events.push(...serializer.handle({ type: 'text_delta', text: part.text, ...(Object.prototype.hasOwnProperty.call(part, 'logprobs') ? { logprobs: cloneJson(part.logprobs) } : {}) }));
    } else if (part.type === 'refusal') {
      events.push(...serializer.handle({ type: 'refusal_delta', text: part.text }));
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
        partial: typeof part.arguments === 'string' ? part.arguments : JSON.stringify(part.input || {}),
      }));
      events.push(...serializer.handle({ type: 'tool_end', index }));
    }
  }

  events.push(...serializer.handle({
    type: 'finish',
    stopReason: canonicalResponse.stopReason,
    ...(Object.prototype.hasOwnProperty.call(canonicalResponse, 'stopSequence') ? { stopSequence: canonicalResponse.stopSequence } : {}),
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
  nativeMessagesToSse,
  createNativeMessagesAccumulator,
  createProtocolStreamBridge,
  responseToEntrySse,
  collectCanonicalEvents,
};
