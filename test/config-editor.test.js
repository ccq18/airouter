const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  ConfigEditorError,
  addConfigItem,
  addConfigItems,
  buildImportedConfigItem,
  deleteConfigItems,
  updateConfigItem,
  updateConfigSettings,
  deleteConfigItem,
  readParsedConfigFile,
  writeParsedConfigFile,
} = require('../app/config-editor');

function createTokenConfig(overrides = {}) {
  return {
    proxy_port: 7890,
    port: 3009,
    configs: [
      {
        type: 'token',
        preset: 'chatgpt',
        access_token: 'token-1',
        account_id: 'account-1',
        description: 'primary',
      },
    ],
    ...overrides,
  };
}

function createApiKeyConfig(overrides = {}) {
  return {
    configs: [
      {
        type: 'apikey',
        apikey: 'sk-primary',
        base_url: 'https://api.openai.com/v1',
        description: 'primary key',
      },
    ],
    ...overrides,
  };
}

function createFakeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

test('addConfigItem appends a token config and preserves top-level settings', () => {
  const parsed = createTokenConfig();

  const next = addConfigItem(parsed, {
    type: 'token',
    access_token: 'token-2',
    account_id: 42,
    description: 'backup',
  });

  assert.equal(next.proxy_port, 7890);
  assert.equal(next.port, 3009);
  assert.equal(next.configs.length, 2);
  assert.match(next.configs[1].id, /^cfg_/);
  const { id: generatedId, ...appendedConfig } = next.configs[1];
  assert.ok(generatedId);
  assert.deepEqual(appendedConfig, {
    type: 'token',
    access_token: 'token-2',
    account_id: '42',
    description: 'backup',
  });
});

test('addConfigItems appends multiple configs in one update', () => {
  const parsed = createTokenConfig();

  const next = addConfigItems(parsed, [
    {
      type: 'token',
      access_token: 'token-2',
      account_id: 42,
      description: 'backup',
    },
    {
      type: 'apikey',
      apikey: 'sk-example',
      base_url: 'https://api.example.com/v1/',
      description: 'gpt api',
    },
  ]);

  assert.equal(parsed.configs.length, 1);
  assert.equal(next.proxy_port, 7890);
  assert.equal(next.port, 3009);
  assert.equal(next.configs.length, 3);
  assert.match(next.configs[1].id, /^cfg_/);
  const { id: tokenId, ...tokenConfig } = next.configs[1];
  assert.ok(tokenId);
  assert.deepEqual(tokenConfig, {
    type: 'token',
    access_token: 'token-2',
    account_id: '42',
    description: 'backup',
  });
  assert.match(next.configs[2].id, /^cfg_/);
  const { id: apiKeyId, ...apiKeyConfig } = next.configs[2];
  assert.ok(apiKeyId);
  assert.deepEqual(apiKeyConfig, {
    type: 'apikey',
    apikey: 'sk-example',
    base_url: 'https://api.example.com/v1',
    description: 'gpt api',
  });
});

test('buildImportedConfigItem extracts token fields from auth session JSON', () => {
  const imported = buildImportedConfigItem('token', {
    type: 'codex',
    user: {
      email: 'user@example.com',
    },
    account: {
      id: 'account-from-session',
    },
    accessToken: 'access-token-from-session',
  });

  assert.deepEqual(imported, {
    type: 'token',
    preset: 'chatgpt',
    description: 'user@example.com',
    account_id: 'account-from-session',
    access_token: 'access-token-from-session',
  });
});

test('buildImportedConfigItem preserves refresh_token from auth session JSON', () => {
  const imported = buildImportedConfigItem('token', {
    user: {
      email: 'user@example.com',
    },
    account: {
      id: 'account-from-session',
    },
    accessToken: 'access-token-from-session',
    refresh_token: 'refresh-token-from-session',
  });

  assert.deepEqual(imported, {
    type: 'token',
    preset: 'chatgpt',
    description: 'user@example.com',
    account_id: 'account-from-session',
    access_token: 'access-token-from-session',
    refresh_token: 'refresh-token-from-session',
  });
});

test('buildImportedConfigItem supports direct credential JSON with email and JWT client_id', () => {
  const imported = buildImportedConfigItem('token', {
    access_token: createFakeJwt({
      client_id: 'app-from-access-token',
    }),
    account_id: 'account-from-direct-json',
    email: 'user@example.com',
    refresh_token: 'refresh-token-from-direct-json',
  });

  assert.equal(imported.description, 'user@example.com');
  assert.equal(imported.account_id, 'account-from-direct-json');
  assert.equal(imported.refresh_token, 'refresh-token-from-direct-json');
  assert.equal(imported.client_id, 'app-from-access-token');
});

test('buildImportedConfigItem supports oauth export credential JSON', () => {
  const imported = buildImportedConfigItem('token', {
    name: 'exported-account',
    platform: 'openai',
    type: 'oauth',
    credentials: {
      access_token: 'access-token-from-export',
      refresh_token: 'refresh-token-from-export',
      email: 'export@example.com',
      chatgpt_account_id: 'account-from-credentials',
      client_id: 'client-from-credentials',
    },
    extra: {
      email: 'extra@example.com',
      chatgpt_account_id: 'account-from-extra',
    },
  });

  assert.deepEqual(imported, {
    type: 'token',
    preset: 'chatgpt',
    description: 'export@example.com',
    account_id: 'account-from-credentials',
    access_token: 'access-token-from-export',
    refresh_token: 'refresh-token-from-export',
    client_id: 'client-from-credentials',
  });
});

test('buildImportedConfigItem converts Sub2API Agent Identity exports to token subtype configs', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const agentPrivateKey = privateKey.export({
    format: 'der',
    type: 'pkcs8',
  }).toString('base64');
  const imported = buildImportedConfigItem('token', {
    name: 'sub2api-export',
    platform: 'openai',
    type: 'oauth',
    credentials: {
      auth_mode: 'agentIdentity',
      agent_runtime_id: 'agent-runtime-example',
      agent_private_key: agentPrivateKey,
      task_id: 'task-example',
      chatgpt_account_id: 'account-example',
      chatgpt_user_id: 'user-example',
      chatgpt_account_is_fedramp: false,
      email: 'agent@example.com',
      plan_type: 'team',
    },
    concurrency: 10,
    priority: 1,
    rate_multiplier: 1,
    auto_pause_on_expired: true,
  });

  assert.deepEqual(imported, {
    type: 'token',
    preset: 'chatgpt',
    subtype: 'sub2api',
    description: 'agent@example.com',
    credentials: {
      auth_mode: 'agentIdentity',
      agent_runtime_id: 'agent-runtime-example',
      agent_private_key: agentPrivateKey,
      task_id: 'task-example',
      chatgpt_account_id: 'account-example',
      chatgpt_user_id: 'user-example',
      chatgpt_account_is_fedramp: false,
      email: 'agent@example.com',
      plan_type: 'team',
    },
    concurrency: 10,
    priority: 1,
    rate_multiplier: 1,
    auto_pause_on_expired: true,
  });
});

test('buildImportedConfigItem accepts Sub2API Agent Identity without task_id', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const imported = buildImportedConfigItem('token', {
    platform: 'openai',
    type: 'oauth',
    credentials: {
      auth_mode: 'agentIdentity',
      agent_runtime_id: 'agent-runtime-example',
      agent_private_key: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      chatgpt_account_id: 'account-example',
      chatgpt_user_id: 'user-example',
    },
  });

  assert.equal(imported.subtype, 'sub2api');
  assert.equal(imported.credentials.task_id, undefined);
});

test('buildImportedConfigItem rejects malformed Sub2API private keys without exposing them', () => {
  assert.throws(() => buildImportedConfigItem('token', {
    platform: 'openai',
    type: 'oauth',
    credentials: {
      auth_mode: 'agentIdentity',
      agent_runtime_id: 'agent-runtime-example',
      agent_private_key: 'not-a-private-key',
      chatgpt_account_id: 'account-example',
      chatgpt_user_id: 'user-example',
    },
  }), err => {
    assert.equal(err instanceof ConfigEditorError, true);
    assert.match(err.message, /agent_private_key/);
    assert.doesNotMatch(err.message, /not-a-private-key/);
    return true;
  });
});

test('buildImportedConfigItem falls back to oauth export extra fields and account name', () => {
  const imported = buildImportedConfigItem('token', {
    name: 'exported-account',
    platform: 'openai',
    type: 'oauth',
    credentials: {
      access_token: 'access-token-from-export',
      refresh_token: 'refresh-token-from-export',
    },
    extra: {
      chatgpt_account_id: 'account-from-extra',
    },
  });

  assert.deepEqual(imported, {
    type: 'token',
    preset: 'chatgpt',
    description: 'exported-account',
    account_id: 'account-from-extra',
    access_token: 'access-token-from-export',
    refresh_token: 'refresh-token-from-export',
  });
});

test('buildImportedConfigItem accepts camelCase and nested token refresh fields', () => {
  const camelCaseImported = buildImportedConfigItem('token', {
    account: {
      id: 'account-from-session',
    },
    accessToken: 'access-token-from-session',
    refreshToken: 'refresh-token-camel',
  });
  const nestedImported = buildImportedConfigItem('token', {
    account: {
      id: 'account-from-session',
    },
    accessToken: 'access-token-from-session',
    tokens: {
      refresh_token: 'refresh-token-nested',
    },
  });

  assert.equal(camelCaseImported.refresh_token, 'refresh-token-camel');
  assert.equal(nestedImported.refresh_token, 'refresh-token-nested');
});

test('buildImportedConfigItem keeps explicit token config fields when provided', () => {
  const imported = buildImportedConfigItem('token', {
    description: 'manual description',
    account_id: 'manual-account',
    access_token: 'manual-token',
    refresh_token: 'manual-refresh-token',
    accessToken: 'ignored-session-token',
  });

  assert.deepEqual(imported, {
    type: 'token',
    preset: 'chatgpt',
    description: 'manual description',
    account_id: 'manual-account',
    access_token: 'manual-token',
    refresh_token: 'manual-refresh-token',
  });
});

test('buildImportedConfigItem rejects token input without required session fields', () => {
  assert.throws(() => {
    buildImportedConfigItem('token', {
      user: {
        email: 'user@example.com',
      },
    });
  }, err => {
    assert.equal(err instanceof ConfigEditorError, true);
    assert.match(err.message, /AuthSession JSON/);
    return true;
  });
});

test('buildImportedConfigItem keeps item-level apikey credentials', () => {
  const imported = buildImportedConfigItem({
    type: 'apikey',
    apikey: '  sk-third-party  ',
    base_url: ' https://api.example.com/v1/ ',
    description: ' third party ',
  });

  assert.deepEqual(imported, {
    type: 'apikey',
    apikey: 'sk-third-party',
    base_url: 'https://api.example.com/v1',
    description: 'third party',
  });
});

test('updateConfigItem overwrites editable fields but keeps unknown keys on the item', () => {
  const parsed = createTokenConfig({
    configs: [
      {
        type: 'token',
        access_token: 'token-1',
        account_id: 'account-1',
        description: 'primary',
        custom_note: 'keep-me',
      },
    ],
  });

  const next = updateConfigItem(parsed, 0, {
    access_token: 'token-9',
    account_id: 'account-9',
    description: 'rotated',
  });

  assert.deepEqual(next.configs[0], {
    type: 'token',
    access_token: 'token-9',
    account_id: 'account-9',
    description: 'rotated',
    custom_note: 'keep-me',
  });
});

test('deleteConfigItem allows removing the last remaining config', () => {
  const next = deleteConfigItem(createTokenConfig(), 0);

  assert.deepEqual(next.configs, []);
  assert.equal(next.disabled_configs, undefined);
});

test('deleteConfigItems removes multiple enabled configs by original index order', () => {
  const next = deleteConfigItems(createTokenConfig({
    configs: [
      {
        type: 'token',
        access_token: 'token-1',
        account_id: 'account-1',
        description: 'first',
      },
      {
        type: 'token',
      access_token: 'token-2',
        account_id: 'account-2',
        description: 'second',
      },
      {
        type: 'token',
      access_token: 'token-3',
        account_id: 'account-3',
        description: 'third',
      },
      {
        type: 'apikey',
        apikey: 'sk-fourth',
        base_url: 'https://api.example.com/v1',
        description: 'fourth',
      },
    ],
  }), [2, 0]);

  assert.deepEqual(next.configs.map(item => item.description), ['second', 'fourth']);
});

test('deleteConfigItems rejects duplicate indexes without mutating input', () => {
  const parsed = createTokenConfig({
    configs: [
      {
        type: 'token',
        access_token: 'token-1',
        account_id: 'account-1',
        description: 'first',
      },
      {
        type: 'token',
      access_token: 'token-2',
        account_id: 'account-2',
        description: 'second',
      },
    ],
  });

  assert.throws(() => {
    deleteConfigItems(parsed, [1, 1]);
  }, /配置项索引重复/);
  assert.deepEqual(parsed.configs.map(item => item.description), ['first', 'second']);
});

test('updateConfigSettings normalizes top-level apikeys and auth_token', () => {
  const withSecuritySettings = updateConfigSettings(createTokenConfig(), {
    apikeys: ['  router-secret  ', '', 'backup-secret'],
    auth_token: '  admin-secret  ',
  });

  assert.deepEqual(withSecuritySettings.apikeys, ['router-secret', 'backup-secret']);
  assert.equal(withSecuritySettings.auth_token, 'admin-secret');

  const cleared = updateConfigSettings(withSecuritySettings, {
    apikeys: [],
    auth_token: '   ',
  });

  assert.deepEqual(cleared.apikeys, []);
  assert.equal(cleared.auth_token, '');
  assert.equal(cleared.configs.length, 1);
  assert.equal(cleared.configs[0].description, 'primary');
});

test('updateConfigSettings normalizes service port and proxy port settings', () => {
  const next = updateConfigSettings(createTokenConfig(), {
    port: ' 3010 ',
    proxy_port: ' 7890 ',
  });

  assert.equal(next.port, 3010);
  assert.equal(next.proxy_port, 7890);

  const clearedProxy = updateConfigSettings(next, {
    proxy_port: '',
  });

  assert.equal(clearedProxy.port, 3010);
  assert.equal(clearedProxy.proxy_port, undefined);
});

test('updateConfigSettings rejects invalid port settings', () => {
  assert.throws(() => {
    updateConfigSettings(createTokenConfig(), {
      port: '70000',
    });
  }, err => {
    assert.equal(err instanceof ConfigEditorError, true);
    assert.match(err.message, /port 必须是 1-65535/);
    return true;
  });
});

test('writeParsedConfigFile persists a validated config file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-config-editor-'));
  const configPath = path.join(tempDir, 'config.json');
  const parsed = addConfigItem(createTokenConfig(), {
    type: 'token',
    access_token: 'token-2',
    account_id: 'account-2',
    description: 'secondary',
  });

  writeParsedConfigFile(configPath, parsed);
  const loaded = readParsedConfigFile(configPath);

  assert.equal(loaded.configs.length, 2);
  assert.equal(loaded.configs[1].description, 'secondary');
});

test('writeParsedConfigFile rejects invalid apikey entries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-config-editor-'));
  const configPath = path.join(tempDir, 'config.json');

  assert.throws(() => {
    writeParsedConfigFile(configPath, createApiKeyConfig({
      configs: [
        {
          type: 'apikey',
          apikey: '',
          base_url: '',
          description: 'broken',
        },
      ],
    }));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /apikey 配置至少需要 apikey 和 base_url/);
    return true;
  });
});


test('account enabled state stays in configs and never creates a disabled archive', () => {
  const parsed = createTokenConfig();
  parsed.configs[0].id = 'cfg-token';
  const { updateConfigItemById } = require('../app/config-editor');
  const next = updateConfigItemById(parsed, 'cfg-token', { enabled: false });
  assert.equal(next.configs[0].enabled, false);
  assert.equal(next.configs[0].access_token, 'token-1');
  assert.equal(Object.hasOwn(next, 'disabled_configs'), false);
});

test('settings rejects removed compatibility fields', () => {
  for (const field of ['responses', 'claude_code', 'disabled_configs', 'type']) {
    assert.throws(() => updateConfigSettings(createTokenConfig(), { [field]: {} }), /不支持/);
  }
});
