const crypto = require('node:crypto');
const { responsesUsageFromResponsesUsage } = require('./usage');

function createResponseId() {
  return `resp_${crypto.randomBytes(12).toString('hex')}`;
}

function createMessageId() {
  return `msg_${crypto.randomBytes(12).toString('hex')}`;
}

function safeJsonParse(text, fallback = {}) {
  if (typeof text !== 'string') {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    return fallback;
  }
}

function jsonStringify(value) {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value ?? {});
}

function normalizeContentBlock(block, role = 'user') {
  if (typeof block === 'string') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: block,
    };
  }
  if (!block || typeof block !== 'object') {
    return null;
  }
  if (block.type === 'text') {
    return {
      type: role === 'assistant' ? 'output_text' : 'input_text',
      text: block.text || '',
    };
  }
  if (block.type === 'image_url') {
    const imageUrl = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
    return {
      type: 'input_image',
      image_url: imageUrl || '',
    };
  }
  if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'input_image' || block.type === 'input_file') {
    return { ...block };
  }
  return { ...block };
}

function normalizeMessageContent(content, role = 'user') {
  if (typeof content === 'string') {
    return [normalizeContentBlock(content, role)];
  }
  if (Array.isArray(content)) {
    return content.map(block => normalizeContentBlock(block, role)).filter(Boolean);
  }
  if (content && typeof content === 'object') {
    return [normalizeContentBlock(content, role)].filter(Boolean);
  }
  return [];
}

function normalizeResponsesItem(item) {
  if (typeof item === 'string') {
    return {
      type: 'message',
      role: 'user',
      content: normalizeMessageContent(item, 'user'),
    };
  }
  if (!item || typeof item !== 'object') {
    return null;
  }
  if (!item.type) {
    return {
      type: 'message',
      role: item.role || 'user',
      content: normalizeMessageContent(item.content || item.text || '', item.role || 'user'),
    };
  }
  if (item.type === 'message') {
    return {
      ...item,
      role: item.role || 'user',
      content: normalizeMessageContent(item.content, item.role || 'user'),
    };
  }
  if (item.type === 'text') {
    return {
      type: 'message',
      role: item.role || 'user',
      content: normalizeMessageContent(item.content || item.text || '', item.role || 'user'),
    };
  }
  if (item.type === 'tool_call') {
    return {
      type: 'function_call',
      call_id: item.call_id || item.id,
      name: item.name,
      arguments: jsonStringify(item.input || item.arguments || {}),
    };
  }
  if (item.type === 'tool_result') {
    return {
      type: 'function_call_output',
      call_id: item.tool_use_id || item.call_id || item.id,
      output: typeof item.output === 'undefined' ? item.content : item.output,
    };
  }
  return { ...item };
}

function parseResponsesInput(input) {
  if (typeof input === 'undefined' || input === null || input === '') {
    return [];
  }
  if (typeof input === 'string') {
    return [normalizeResponsesItem(input)];
  }
  if (Array.isArray(input)) {
    return input.map(normalizeResponsesItem).filter(Boolean);
  }
  return [normalizeResponsesItem(input)].filter(Boolean);
}

function normalizeResponsesRequest(body = {}) {
  return {
    ...body,
    input: parseResponsesInput(body.input),
    stream: body.stream === true,
  };
}

function extractTextFromContent(content) {
  const blocks = normalizeMessageContent(content);
  return blocks
    .map(block => {
      if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
        return block.text || '';
      }
      if (block.type === 'input_image') {
        const imageUrl = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
        return imageUrl ? `[Image: ${imageUrl}]` : '[Image]';
      }
      if (block.type === 'input_file') {
        return `[File: ${block.filename || 'file'}]`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function extractOutputText(response) {
  const texts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item.type === 'message') {
      const text = extractTextFromContent(item.content);
      if (text) {
        texts.push(text);
      }
    } else if (item.type === 'text' && typeof item.content === 'string') {
      texts.push(item.content);
    }
  }
  return texts.join('\n');
}

function normalizeResponsesResponse(response = {}, request = {}) {
  return {
    id: response.id || createResponseId(),
    object: response.object || 'response',
    created_at: response.created_at || Math.floor(Date.now() / 1000),
    status: response.status || 'completed',
    model: response.model || request.model,
    output: Array.isArray(response.output) ? response.output.map(normalizeResponsesItem).filter(Boolean) : [],
    usage: responsesUsageFromResponsesUsage(response.usage || {}),
    previous_response_id: response.previous_response_id || request.previous_response_id,
  };
}

function recordConvertedSession(sessionStore, request, response) {
  if (!sessionStore || !request || request.store === false) {
    return null;
  }
  const session = sessionStore.getOrCreateSession(request.previous_response_id || '');
  for (const item of parseResponsesInput(request.input)) {
    sessionStore.appendMessage(session.id, item, 0);
  }
  const tokensUsed = Number(response?.usage?.total_tokens || response?.usage?.input_tokens || 0);
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    sessionStore.appendMessage(session.id, item, tokensUsed);
  }
  if (response?.id) {
    sessionStore.recordResponseMapping(response.id, session.id);
  }
  return session;
}

function buildTranscript(items, options = {}) {
  const maxTranscriptChars = options.maxTranscriptChars ?? 240000;
  const parts = [];
  for (const item of Array.isArray(items) ? items : []) {
    const normalized = normalizeResponsesItem(item);
    if (!normalized) {
      continue;
    }
    if (normalized.type === 'message') {
      const role = normalized.role === 'assistant' ? 'Assistant' : 'User';
      const text = extractTextFromContent(normalized.content);
      if (text) {
        parts.push(`[${role}]\n${text}`);
      }
      continue;
    }
    if (normalized.type === 'function_call') {
      parts.push(`[Tool Call]\n${normalized.name || ''}(${normalized.arguments || ''})`);
      continue;
    }
    if (normalized.type === 'reasoning') {
      const text = extractTextFromContent(normalized.content) || JSON.stringify(normalized.summary || '');
      if (text) {
        parts.push(`[Reasoning]\n${text}`);
      }
    }
  }
  const transcript = parts.join('\n\n---\n\n');
  if (transcript.length <= maxTranscriptChars) {
    return transcript;
  }
  const headSize = Math.floor(maxTranscriptChars * 0.2);
  const tailSize = Math.floor(maxTranscriptChars * 0.75);
  return `${transcript.slice(0, headSize)}\n\n[... omitted ${transcript.length - headSize - tailSize} characters during local compact ...]\n\n${transcript.slice(-tailSize)}`;
}

module.exports = {
  buildTranscript,
  createMessageId,
  createResponseId,
  extractOutputText,
  extractTextFromContent,
  jsonStringify,
  normalizeContentBlock,
  normalizeMessageContent,
  normalizeResponsesItem,
  normalizeResponsesRequest,
  normalizeResponsesResponse,
  parseResponsesInput,
  recordConvertedSession,
  safeJsonParse,
};
