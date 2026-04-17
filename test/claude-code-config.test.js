const test = require('node:test');
const assert = require('node:assert/strict');

const { transformClaudeMessagesRequest } = require('../app/claude-responses-compat');
const { parseOpenAiConfigFile, resolveClaudeCodeOptions } = require('../app/openai-config');

function createBaseConfig(extra = {}) {
  return {
    type: 'token',
    proxy_port: 7890,
    port: 3009,
    configs: [
      {
        access_token: 'token',
        account_id: 'account',
        description: 'primary',
      },
    ],
    ...extra,
  };
}

test('resolveClaudeCodeOptions falls back to gpt-5.4 and high', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(createBaseConfig()));

  assert.deepEqual(resolveClaudeCodeOptions(parsed), {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
  });
});

test('resolveClaudeCodeOptions uses the configured Claude Code overrides', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
    claude_code: {
      model: 'gpt-5-mini',
      reasoning_effort: 'medium',
    },
  })));

  assert.deepEqual(resolveClaudeCodeOptions(parsed), {
    model: 'gpt-5-mini',
    reasoningEffort: 'medium',
  });
});

test('transformClaudeMessagesRequest force overrides client model and reasoning for Claude Code', () => {
  const requestBody = {
    model: 'client-model-should-be-ignored',
    reasoning: {
      effort: 'low',
    },
    system: 'system instruction',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
    stream: true,
  };

  const transformed = transformClaudeMessagesRequest(requestBody, {
    model: 'gpt-5.4',
    reasoningEffort: 'high',
    stream: true,
    includeMaxOutputTokens: false,
  });

  assert.equal(transformed.model, 'gpt-5.4');
  assert.deepEqual(transformed.reasoning, {
    effort: 'high',
  });
  assert.equal(transformed.instructions, 'system instruction');
});
