const {
  buildTranscript,
  parseResponsesInput,
} = require('./canonical-responses');

const LOCAL_COMPACT_SYSTEM_PROMPT = `You are a conversation compressor. Create a concise handover document that captures the essential context of the conversation below.

Include:
1. Task Context: What the user is working on (project, files, goals)
2. Key Decisions: Important decisions made during the conversation
3. Current State: What's done, what's pending
4. Important Details: File paths, code patterns, configuration values, error messages needed to continue
5. Next Steps: What was about to happen or was requested

Rules:
- Preserve EXACT technical terms, file paths, function names, code snippets
- Include FULL context: paths, versions, configurations
- Omit verbose tool output details unless they contain critical information
- Be concise but preserve all information needed to continue the conversation
- Use markdown code blocks for code snippets with language tags
- NO assumptions, NO vague summaries - only document what was explicitly discussed`;

function isNativeCompactUnsupported(statusCode) {
  return [404, 405, 501].includes(Number(statusCode));
}

function buildLocalCompactRequest(originalBody, sessionStore, options = {}) {
  const allItems = [];
  if (originalBody.previous_response_id) {
    const session = sessionStore.getSessionByResponseId(originalBody.previous_response_id);
    allItems.push(...session.messages);
  }
  allItems.push(...parseResponsesInput(originalBody.input));
  if (allItems.length === 0) {
    throw new Error(originalBody.previous_response_id
      ? '无法本地 compact: previous_response_id 未命中且 input 为空'
      : '无法本地 compact: input 为空');
  }
  const transcript = buildTranscript(allItems, {
    maxTranscriptChars: options.maxTranscriptChars,
  });
  return {
    model: originalBody.model,
    instructions: LOCAL_COMPACT_SYSTEM_PROMPT,
    input: [{
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: transcript }],
    }],
    stream: originalBody.stream === true,
    max_output_tokens: Math.min(
      Number(originalBody.max_output_tokens || originalBody.max_tokens || options.defaultMaxOutputTokens || 8192),
      Number(options.defaultMaxOutputTokens || 8192)
    ),
  };
}

module.exports = {
  buildLocalCompactRequest,
  isNativeCompactUnsupported,
};
