const test = require('node:test');
const assert = require('node:assert/strict');

const { transformClaudeMessagesRequest } = require('../app/claude-responses-compat');
const {
  parseOpenAiConfigFile,
  resolveClaudeCodeOptions,
  resolveResponsesOptions,
  createRuntimeConfigs,
} = require('../app/openai-config');

function createBaseConfig(extra = {}) {
  return {
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

test('resolveClaudeCodeOptions falls back to gpt-5.5 and high', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(createBaseConfig()));

  assert.deepEqual(resolveClaudeCodeOptions(parsed), {
    model: 'gpt-5.5',
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

test('resolveResponsesOptions normalizes configured model aliases for case-insensitive lookup', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
    responses: {
      model_aliases: {
        'GPT-5.4-MINI': 'gpt-5.5',
        '  O3-MINI  ': 'gpt-5.4',
      },
    },
  })));

  assert.deepEqual(resolveResponsesOptions(parsed), {
    modelAliases: {
      'gpt-5.4-mini': 'gpt-5.5',
      'o3-mini': 'gpt-5.4',
    },
  });
});

test('parseOpenAiConfigFile rejects a non-object responses.model_aliases field', () => {
  assert.throws(() => {
    parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
      responses: {
        model_aliases: 'gpt-5.4-mini=gpt-5.5',
      },
    })));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /responses\.model_aliases 必须是对象/);
    return true;
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
  assert.equal(transformed.parallel_tool_calls, false);
  assert.deepEqual(transformed.include, []);
  assert.deepEqual(transformed.input[0], {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'hello',
      },
    ],
  });
});

test('transformClaudeMessagesRequest uses CPA style system and parallel tool conversion', () => {
  const requestBody = {
    model: 'claude-sonnet-4',
    system: [
      {
        type: 'text',
        text: 'x-anthropic-billing-header: tenant-123',
      },
      {
        type: 'text',
        text: 'project instruction',
      },
    ],
    tool_choice: {
      type: 'auto',
      disable_parallel_tool_use: true,
    },
    messages: [
      {
        role: 'system',
        content: 'message system instruction',
      },
      {
        role: 'user',
        content: 'hello',
      },
    ],
    stream: true,
  };

  const transformed = transformClaudeMessagesRequest(requestBody, {
    model: 'gpt-5.5',
    stream: true,
    includeMaxOutputTokens: false,
    cpaStyleCompatibility: true,
  });

  assert.equal(transformed.instructions, '');
  assert.equal(transformed.parallel_tool_calls, false);
  assert.deepEqual(transformed.include, ['reasoning.encrypted_content']);
  assert.deepEqual(transformed.input.slice(0, 3), [
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'project instruction',
        },
      ],
    },
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'message system instruction',
        },
      ],
    },
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'hello',
        },
      ],
    },
  ]);
});

test('transformClaudeMessagesRequest fills missing nested tool schema types', () => {
  const transformed = transformClaudeMessagesRequest({
    model: 'claude-sonnet-4',
    messages: [
      {
        role: 'user',
        content: 'hello',
      },
    ],
    tools: [
      {
        name: 'Workflow',
        description: 'Run a workflow',
        input_schema: {
          type: 'object',
          properties: {
            args: {
              description: 'Workflow arguments',
            },
          },
        },
      },
    ],
  }, {
    model: 'gpt-5.5',
    stream: true,
    includeMaxOutputTokens: false,
  });

  assert.equal(transformed.tools[0].parameters.properties.args.type, 'object');
});

test('createRuntimeConfigs defaults config items to token type', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    configs: [
      {
        access_token: 'token',
        account_id: 'account',
        refresh_token: 'refresh-token',
        description: 'primary token',
      },
    ],
  }));

  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.equal(runtimeConfigs.length, 1);
  assert.equal(runtimeConfigs[0].type, 'token');
  assert.equal(runtimeConfigs[0].description, 'primary token');
  assert.equal(runtimeConfigs[0].baseUrl, 'https://chatgpt.com');
  assert.equal(runtimeConfigs[0].refresh_token, 'refresh-token');
});

test('createRuntimeConfigs supports item-level apikey configs', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    configs: [
      {
        type: 'apikey',
        base_url: 'https://api.example.com/v1/',
        apikey: 'sk-1',
        description: 'primary',
      },
      {
        type: 'apikey',
        base_url: 'https://api.backup.example/v1',
        apikey: 'sk-2',
        description: 'backup',
        support: ['gpt', 'claude'],
      },
    ],
  }));

  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.equal(runtimeConfigs.length, 2);
  assert.equal(runtimeConfigs[0].type, 'apikey');
  assert.equal(runtimeConfigs[0].baseUrl, 'https://api.example.com/v1');
  assert.equal(runtimeConfigs[0].apiKey, 'sk-1');
  assert.deepEqual(runtimeConfigs[0].support, ['gpt']);
  assert.equal(runtimeConfigs[1].type, 'apikey');
  assert.equal(runtimeConfigs[1].baseUrl, 'https://api.backup.example/v1');
  assert.equal(runtimeConfigs[1].apiKey, 'sk-2');
  assert.deepEqual(runtimeConfigs[1].support, ['gpt', 'claude']);
});

test('createRuntimeConfigs preserves configured GPT apikey health model', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    configs: [
      {
        type: 'apikey',
        base_url: 'https://api.example.com/v1',
        apikey: 'sk-1',
        support: ['gpt'],
        health: {
          model: '  gpt-4.1-mini  ',
        },
      },
    ],
  }));

  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.deepEqual(runtimeConfigs[0].health, {
    model: 'gpt-4.1-mini',
  });
});

test('createRuntimeConfigs ignores disabled_configs', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    configs: [
      {
        access_token: 'token-active',
        account_id: 'account-active',
        description: 'active token',
      },
    ],
    disabled_configs: [
      {
        type: 'apikey',
        base_url: 'https://api.disabled.example/v1',
        apikey: 'sk-disabled',
        description: 'disabled key',
      },
    ],
  }));

  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.equal(runtimeConfigs.length, 1);
  assert.equal(runtimeConfigs[0].description, 'active token');
  assert.equal(parsed.disabled_configs[0].description, 'disabled key');
});

test('parseOpenAiConfigFile rejects invalid disabled_configs entries', () => {
  assert.throws(() => {
    parseOpenAiConfigFile(JSON.stringify({
      configs: [],
      disabled_configs: [
        {
          type: 'apikey',
          support: ['chat'],
        },
      ],
    }));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /disabled_configs\[0\]/);
    return true;
  });
});

test('createRuntimeConfigs supports apikey configs that only support Claude messages', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    configs: [
      {
        type: 'apikey',
        base_url: 'https://claude.example.com/v1/',
        apikey: 'sk-claude',
        description: 'claude provider',
        support: ['claude'],
      },
    ],
  }));

  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.equal(runtimeConfigs.length, 1);
  assert.equal(runtimeConfigs[0].type, 'apikey');
  assert.equal(runtimeConfigs[0].baseUrl, 'https://claude.example.com/v1');
  assert.equal(runtimeConfigs[0].apiKey, 'sk-claude');
  assert.equal(runtimeConfigs[0].description, 'claude provider');
  assert.deepEqual(runtimeConfigs[0].support, ['claude']);
  assert.equal(runtimeConfigs[0].runtime.reason, 'apikey');
});

test('createRuntimeConfigs supports claude_token configs for Claude OAuth passthrough', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    configs: [
      {
        type: 'claude_token',
        access_token: 'claude-access-token',
        refresh_token: 'claude-refresh-token',
        request_auth_token_sha256s: ['A'.repeat(64), 'invalid-hash'],
        expires_at: 1893456000000,
        account_uuid: 'account-uuid-example',
        description: 'Claude OAuth account',
      },
    ],
  }));

  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.equal(runtimeConfigs.length, 1);
  assert.equal(runtimeConfigs[0].type, 'claude_token');
  assert.equal(runtimeConfigs[0].baseUrl, 'https://api.anthropic.com');
  assert.equal(runtimeConfigs[0].access_token, 'claude-access-token');
  assert.equal(runtimeConfigs[0].refresh_token, 'claude-refresh-token');
  assert.deepEqual(runtimeConfigs[0].request_auth_token_sha256s, ['a'.repeat(64)]);
  assert.equal(runtimeConfigs[0].expires_at, 1893456000000);
  assert.equal(runtimeConfigs[0].account_uuid, 'account-uuid-example');
  assert.equal(runtimeConfigs[0].description, 'Claude OAuth account');
  assert.equal(runtimeConfigs[0].runtime.reason, 'claude_token');
});

test('parseOpenAiConfigFile rejects unsupported apikey support values', () => {
  assert.throws(() => {
    parseOpenAiConfigFile(JSON.stringify({
      configs: [
        {
          type: 'apikey',
          base_url: 'https://api.example.com/v1',
          apikey: 'sk-1',
          support: ['gpt', 'chat'],
        },
      ],
    }));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /support 仅支持 gpt 或 claude/);
    return true;
  });
});

test('parseOpenAiConfigFile rejects invalid apikey health model values', () => {
  assert.throws(() => {
    parseOpenAiConfigFile(JSON.stringify({
      configs: [
        {
          type: 'apikey',
          base_url: 'https://api.example.com/v1',
          apikey: 'sk-1',
          health: {
            model: '',
          },
        },
      ],
    }));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /health\.model 必须是非空字符串/);
    return true;
  });
});

test('parseOpenAiConfigFile ignores deprecated top-level type', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    type: 'api_key',
    configs: [
      {
        access_token: 'token',
        account_id: 'account',
      },
    ],
  }));
  const runtimeConfigs = createRuntimeConfigs(parsed);

  assert.equal(parsed.type, 'api_key');
  assert.equal(runtimeConfigs[0].type, 'token');
  assert.equal(runtimeConfigs[0].access_token, 'token');
});

test('createRuntimeConfigs rejects apikey configs without item-level base_url', () => {
  assert.throws(() => {
    const parsed = parseOpenAiConfigFile(JSON.stringify({
      configs: [
        {
          type: 'apikey',
          apikey: 'sk-1',
          description: 'primary',
        },
      ],
    }));

    createRuntimeConfigs(parsed);
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /apikey 配置至少需要 apikey 和 base_url/);
    return true;
  });
});

test('parseOpenAiConfigFile accepts empty configs array', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({
    configs: [],
  }));

  assert.deepEqual(parsed.configs, []);
  assert.deepEqual(createRuntimeConfigs(parsed), []);
});

test('parseOpenAiConfigFile accepts optional top-level apikeys and auth_token fields', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
    apikeys: ['router-secret', 'backup-secret'],
    auth_token: 'admin-token',
    port: '3010',
    proxy_port: 7890,
  })));

  assert.deepEqual(parsed.apikeys, ['router-secret', 'backup-secret']);
  assert.equal(parsed.auth_token, 'admin-token');
  assert.equal(parsed.port, '3010');
  assert.equal(parsed.proxy_port, 7890);
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

test('parseOpenAiConfigFile rejects invalid port fields', () => {
  assert.throws(() => {
    parseOpenAiConfigFile(JSON.stringify(createBaseConfig({
      proxy_port: 70000,
    })));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /proxy_port 必须是 1-65535/);
    return true;
  });
});
