const {
  createClaudeSseTransformer,
  transformClaudeMessagesRequest,
  transformResponsesResponseToClaudeMessage,
} = require('../claude-responses-compat');
const {
  extractTextFromContent,
  jsonStringify,
  normalizeResponsesResponse,
  parseResponsesInput,
  safeJsonParse,
} = require('./canonical-responses');
const { responsesUsageFromMessagesUsage } = require('./usage');

function messagesRequestToResponses(body, options = {}) {
  return transformClaudeMessagesRequest(body, {
    includeMaxOutputTokens: true,
    responsesOptions: options.responsesOptions,
  });
}

function mapResponsesToolToClaude(tool) {
  if (!tool || tool.type !== 'function') {
    return null;
  }
  return {
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.parameters || {
      type: 'object',
      properties: {},
    },
  };
}

function mapResponsesToolChoiceToClaude(toolChoice) {
  if (!toolChoice || toolChoice === 'auto') {
    return { type: 'auto' };
  }
  if (toolChoice === 'required') {
    return { type: 'any' };
  }
  if (toolChoice === 'none') {
    return { type: 'none' };
  }
  if (toolChoice.type === 'function' && toolChoice.name) {
    return {
      type: 'tool',
      name: toolChoice.name,
    };
  }
  return toolChoice;
}

function contentBlocksToClaude(content, role) {
  const blocks = [];
  for (const block of Array.isArray(content) ? content : []) {
    if (block.type === 'input_text' || block.type === 'output_text' || block.type === 'text') {
      blocks.push({
        type: 'text',
        text: block.text || '',
      });
      continue;
    }
    if (block.type === 'input_image') {
      const imageUrl = typeof block.image_url === 'string' ? block.image_url : block.image_url?.url;
      if (typeof imageUrl === 'string' && imageUrl.startsWith('data:')) {
        const match = imageUrl.match(/^data:([^;]+);base64,(.*)$/);
        if (match) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: match[1],
              data: match[2],
            },
          });
        }
      } else if (imageUrl) {
        blocks.push({
          type: 'image',
          source: {
            type: 'url',
            url: imageUrl,
          },
        });
      }
      continue;
    }
    if (block.type === 'input_file') {
      blocks.push({
        type: 'document',
        title: block.filename || 'document',
        source: block.file_data
          ? {
              type: 'base64',
              media_type: String(block.file_data).match(/^data:([^;]+);base64,/)?.[1] || 'application/octet-stream',
              data: String(block.file_data).replace(/^data:[^;]+;base64,/, ''),
            }
          : {
              type: 'text',
              media_type: 'text/plain',
              data: block.text || '',
            },
      });
    }
  }
  if (blocks.length === 0 && role !== 'assistant') {
    return '';
  }
  return blocks;
}

function itemToClaudeMessage(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  if (item.type === 'message') {
    const role = item.role === 'assistant' ? 'assistant' : 'user';
    const content = contentBlocksToClaude(item.content, role);
    if (Array.isArray(content) && content.length === 0) {
      return null;
    }
    return { role, content };
  }
  if (item.type === 'function_call') {
    return {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: item.call_id || item.id,
        name: item.name,
        input: safeJsonParse(item.arguments, {}),
      }],
    };
  }
  if (item.type === 'function_call_output') {
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: item.call_id || item.id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      }],
    };
  }
  if (item.type === 'reasoning') {
    const thinking = extractTextFromContent(item.content) || JSON.stringify(item.summary || '');
    return thinking
      ? {
          role: 'assistant',
          content: [{ type: 'thinking', thinking }],
        }
      : null;
  }
  return null;
}

function responsesRequestToMessages(body, session = null) {
  const items = [
    ...Array.isArray(session?.messages) ? session.messages : [],
    ...parseResponsesInput(body.input),
  ];
  const messages = items.map(itemToClaudeMessage).filter(Boolean);
  const request = {
    model: body.model,
    max_tokens: body.max_output_tokens || body.max_tokens || 4096,
    messages,
    stream: body.stream === true,
  };
  if (body.instructions) {
    request.system = body.instructions;
  }
  if (Array.isArray(body.tools)) {
    const tools = body.tools.map(mapResponsesToolToClaude).filter(Boolean);
    if (tools.length > 0) {
      request.tools = tools;
    }
  }
  if (body.tool_choice) {
    request.tool_choice = mapResponsesToolChoiceToClaude(body.tool_choice);
  }
  if (typeof body.temperature === 'number') {
    request.temperature = body.temperature;
  }
  if (typeof body.top_p === 'number') {
    request.top_p = body.top_p;
  }
  return request;
}

function messagesResponseToResponses(response, request = {}) {
  const output = [];
  for (const block of Array.isArray(response?.content) ? response.content : []) {
    if (block.type === 'text') {
      output.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: block.text || '' }],
      });
      continue;
    }
    if (block.type === 'thinking') {
      output.push({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: block.thinking || '' }],
      });
      continue;
    }
    if (block.type === 'tool_use') {
      output.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: jsonStringify(block.input || {}),
      });
    }
  }
  return normalizeResponsesResponse({
    id: response?.id && String(response.id).startsWith('resp_') ? response.id : undefined,
    model: response?.model || request.model,
    output,
    usage: responsesUsageFromMessagesUsage(response?.usage || {}),
  }, request);
}

function responsesResponseToMessages(response) {
  return transformResponsesResponseToClaudeMessage(response);
}

function createResponsesToMessagesSseTransformer() {
  return createClaudeSseTransformer();
}

module.exports = {
  createResponsesToMessagesSseTransformer,
  messagesRequestToResponses,
  messagesResponseToResponses,
  responsesRequestToMessages,
  responsesResponseToMessages,
};
