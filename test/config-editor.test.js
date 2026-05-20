const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ConfigEditorError,
  addConfigItem,
  buildImportedConfigItem,
  moveConfigItem,
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
    claude_code: {
      model: 'gpt-5.4',
      reasoning_effort: 'high',
    },
    configs: [
      {
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
    access_token: 'token-2',
    account_id: 42,
    description: 'backup',
  });

  assert.equal(next.proxy_port, 7890);
  assert.equal(next.port, 3009);
  assert.equal(next.claude_code.model, 'gpt-5.4');
  assert.equal(next.configs.length, 2);
  assert.deepEqual(next.configs[1], {
    access_token: 'token-2',
    account_id: '42',
    description: 'backup',
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
    support: [' gpt ', 'claude', 'gpt'],
  });

  assert.deepEqual(imported, {
    type: 'apikey',
    apikey: 'sk-third-party',
    base_url: 'https://api.example.com/v1',
    description: 'third party',
    support: ['gpt', 'claude'],
  });
});

test('updateConfigItem overwrites editable fields but keeps unknown keys on the item', () => {
  const parsed = createTokenConfig({
    configs: [
      {
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
    access_token: 'token-9',
    account_id: 'account-9',
    description: 'rotated',
    custom_note: 'keep-me',
  });
});

test('deleteConfigItem allows removing the last remaining config', () => {
  const next = deleteConfigItem(createTokenConfig(), 0);

  assert.deepEqual(next.configs, []);
});

test('moveConfigItem moves a config earlier while preserving top-level settings', () => {
  const parsed = createTokenConfig({
    configs: [
      {
        access_token: 'token-1',
        account_id: 'account-1',
        description: 'first',
      },
      {
        type: 'apikey',
        apikey: 'sk-backup',
        base_url: 'https://api.example.com/v1',
        description: 'second',
      },
    ],
  });

  const next = moveConfigItem(parsed, 1, 0);

  assert.equal(next.port, 3009);
  assert.equal(next.proxy_port, 7890);
  assert.deepEqual(next.configs.map(item => item.description), ['second', 'first']);
  assert.equal(parsed.configs[0].description, 'first');
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

test('updateConfigSettings normalizes responses.model_aliases and preserves other settings', () => {
  const next = updateConfigSettings(createTokenConfig(), {
    responses: {
      model_aliases: {
        '  GPT-5.2  ': '  gpt-5.5  ',
        'o3-mini': ' gpt-5.4 ',
      },
    },
  });

  assert.deepEqual(next.responses, {
    model_aliases: {
      'GPT-5.2': 'gpt-5.5',
      'o3-mini': 'gpt-5.4',
    },
  });
  assert.equal(next.claude_code.model, 'gpt-5.4');
  assert.equal(next.configs.length, 1);
});

test('updateConfigSettings rejects non-object responses.model_aliases', () => {
  assert.throws(() => {
    updateConfigSettings(createTokenConfig(), {
      responses: {
        model_aliases: 'gpt-5.2=gpt-5.5',
      },
    });
  }, err => {
    assert.equal(err instanceof ConfigEditorError, true);
    assert.match(err.message, /responses\.model_aliases 必须是对象/);
    return true;
  });
});

test('writeParsedConfigFile persists a validated config file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-config-editor-'));
  const configPath = path.join(tempDir, 'openai.json');
  const parsed = addConfigItem(createTokenConfig(), {
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
  const configPath = path.join(tempDir, 'openai.json');

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
