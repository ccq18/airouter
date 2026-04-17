const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ConfigEditorError,
  addConfigItem,
  buildImportedConfigItem,
  updateConfigItem,
  updateConfigSettings,
  deleteConfigItem,
  readParsedConfigFile,
  writeParsedConfigFile,
} = require('../app/config-editor');

function createTokenConfig(overrides = {}) {
  return {
    type: 'token',
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
    type: 'api_key',
    configs: [
      {
        api_key: 'sk-primary',
        base_url: 'https://api.openai.com/v1',
        description: 'primary key',
      },
    ],
    ...overrides,
  };
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

test('buildImportedConfigItem keeps explicit token config fields when provided', () => {
  const imported = buildImportedConfigItem('token', {
    description: 'manual description',
    account_id: 'manual-account',
    access_token: 'manual-token',
    accessToken: 'ignored-session-token',
  });

  assert.deepEqual(imported, {
    description: 'manual description',
    account_id: 'manual-account',
    access_token: 'manual-token',
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

test('writeParsedConfigFile rejects invalid api_key entries', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-config-editor-'));
  const configPath = path.join(tempDir, 'openai.json');

  assert.throws(() => {
    writeParsedConfigFile(configPath, createApiKeyConfig({
      configs: [
        {
          api_key: '',
          base_url: '',
          description: 'broken',
        },
      ],
    }));
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /api_key 配置至少需要 api_key 和 base_url/);
    return true;
  });
});
