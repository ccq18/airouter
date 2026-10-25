const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpenAiConfigFile, createRuntimeConfigs } = require('../app/openai-config');

function config(extra = {}) {
  return { configs: [{ id: 'glm', type: 'apikey', preset: 'glm-cn', base_url: 'https://example.com/v1', apikey: 'sk-fixture', models: [{ id: 'glm-model', protocols: ['chat_completions'] }] }], ...extra };
}

test('new configuration accepts only account and model route semantics', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(config({ routing: { models: [{ id: 'my-model', targets: [{ config_id: 'glm', model: 'glm-model', protocol: 'chat_completions' }] }] } })));
  const runtime = createRuntimeConfigs(parsed);
  assert.equal(runtime[0].type, 'apikey');
  assert.equal(runtime[0].models[0].id, 'glm-model');
  assert.equal(Object.hasOwn(runtime[0], 'support'), false);
  assert.equal(Object.hasOwn(runtime[0], 'health'), false);
});

test('old global mode, model aliases, fixed Claude model and archived configs are rejected', () => {
  for (const field of ['type', 'responses', 'claude_code', 'disabled_configs']) {
    assert.throws(() => parseOpenAiConfigFile(JSON.stringify(config({ [field]: {} }))), new RegExp(field));
  }
});

test('stored accounts require an explicit credential category and canonical field names', () => {
  const missingType = config();
  delete missingType.configs[0].type;
  assert.throws(() => parseOpenAiConfigFile(JSON.stringify(missingType)), /type/);
  for (const field of ['support', 'health', 'apiKey', 'api_key', 'baseUrl', 'baseURL']) {
    const value = config();
    value.configs[0][field] = 'removed';
    assert.throws(() => parseOpenAiConfigFile(JSON.stringify(value)), new RegExp(field));
  }
});

test('new credential categories preserve models and enabled state without fallback priority', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify({ configs: [
    { type: 'token', preset: 'chatgpt', access_token: 'token-fixture', account_id: 'account-fixture', models: [{ id: 'gpt-backend', protocols: ['responses'] }] },
    { type: 'claude_token', preset: 'claude', access_token: 'claude-fixture', enabled: false, models: [{ id: 'claude-backend', protocols: ['messages'] }] },
  ] }));
  const runtime = createRuntimeConfigs(parsed);
  assert.equal(runtime[0].models[0].id, 'gpt-backend');
  assert.equal(runtime[1].enabled, false);
  assert.equal(runtime[1].models[0].id, 'claude-backend');
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
  const parsed = parseOpenAiConfigFile(JSON.stringify(config({
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
    parseOpenAiConfigFile(JSON.stringify(config({
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
    parseOpenAiConfigFile(JSON.stringify(config({
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
    parseOpenAiConfigFile(JSON.stringify(config({
      proxy_port: 70000,
    })));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /proxy_port 必须是 1-65535/);
    return true;
  });
});
