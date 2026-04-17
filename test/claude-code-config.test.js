const test = require('node:test');
const assert = require('node:assert/strict');

const { transformClaudeMessagesRequest } = require('../app/claude-responses-compat');
const { parseOpenAiConfigFile, resolveClaudeCodeOptions, createRuntimeConfigs } = require('../app/openai-config');

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
      reasoning_effort: 'xhigh',
    },
  })));

  assert.deepEqual(resolveClaudeCodeOptions(parsed), {
    model: 'gpt-5-mini',
    reasoningEffort: 'xhigh',
  });
});

test('parseOpenAiConfigFile accepts none and minimal reasoning_effort values', () => {
  const parsedWithNone = parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
    claude_code: {
      reasoning_effort: 'none',
    },
  })));
  const parsedWithMinimal = parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
    claude_code: {
      reasoning_effort: 'minimal',
    },
  })));

  assert.equal(resolveClaudeCodeOptions(parsedWithNone).reasoningEffort, 'none');
  assert.equal(resolveClaudeCodeOptions(parsedWithMinimal).reasoningEffort, 'minimal');
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

test('createRuntimeConfigs keeps every api_key config entry', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    type: 'api_key',
    configs: [
      {
        api_key: 'sk-1',
        base_url: 'https://api.openai.com/v1',
        description: 'primary',
      },
      {
        api_key: 'sk-2',
        base_url: 'https://example.com/v1',
        description: 'backup',
      },
    ],
  }));

  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.equal(runtimeConfigs.length, 2);
  assert.equal(runtimeConfigs[0].description, 'primary');
  assert.equal(runtimeConfigs[1].description, 'backup');
});

test('parseOpenAiConfigFile accepts empty configs array', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    type: 'token',
    configs: [],
  }));

  assert.deepEqual(parsed.configs, []);
  assert.deepEqual(createRuntimeConfigs(parsed), []);
});

test('parseOpenAiConfigFile accepts optional top-level apikeys and auth_token fields', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
    apikeys: ['router-secret', 'backup-secret'],
    auth_token: 'admin-token',
  })));

  assert.deepEqual(parsed.apikeys, ['router-secret', 'backup-secret']);
  assert.equal(parsed.auth_token, 'admin-token');
});

test('parseOpenAiConfigFile rejects a non-array apikeys field', () => {
  assert.throws(() => {
    parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
      apikeys: 'router-secret',
    })));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /apikeys 必须是字符串数组/);
    return true;
  });
});

test('parseOpenAiConfigFile rejects a non-string auth_token field', () => {
  assert.throws(() => {
    parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
      auth_token: 12345,
    })));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /auth_token 必须是字符串/);
    return true;
  });
});
