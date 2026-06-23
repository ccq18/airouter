const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  buildSharedClaudeCodeOAuthCredentials,
  getClaudeCodeKeychainServiceName,
  installSharedClaudeCodeLogin,
  restoreClaudeCodeLogin,
  updateSettingsForSharedClaudeCodeLogin,
  validateLocalClaudeAuthToken,
} = require('../app/claude-code-credentials');

function withTempDir(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-claude-creds-'));
  try {
    return fn(tempDir);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('buildSharedClaudeCodeOAuthCredentials creates inference-only Claude Code credentials', () => {
  assert.deepEqual(buildSharedClaudeCodeOAuthCredentials(' airouter-oauth-local-token '), {
    accessToken: 'airouter-oauth-local-token',
    refreshToken: null,
    expiresAt: null,
    scopes: ['user:inference'],
    subscriptionType: null,
    rateLimitTier: null,
  });
});

test('validateLocalClaudeAuthToken only accepts Airouter local Claude auth tokens', () => {
  assert.equal(validateLocalClaudeAuthToken(' airouter-oauth-token_123 '), 'airouter-oauth-token_123');
  assert.throws(() => validateLocalClaudeAuthToken(''), /不能为空/);
  assert.throws(() => validateLocalClaudeAuthToken('sk-ant-oat-real-token'), /airouter-oauth-\*/);
});

test('getClaudeCodeKeychainServiceName follows Claude Code service naming', () => {
  assert.equal(
    getClaudeCodeKeychainServiceName({
      env: {},
      homeDir: '/Users/example',
    }),
    'Claude Code-credentials'
  );

  assert.equal(
    getClaudeCodeKeychainServiceName({
      env: {
        USER_TYPE: 'ant',
        USE_STAGING_OAUTH: 'true',
      },
      homeDir: '/Users/example',
    }),
    'Claude Code-staging-oauth-credentials'
  );

  assert.match(
    getClaudeCodeKeychainServiceName({
      env: {
        CLAUDE_CONFIG_DIR: '/tmp/claude-alt',
      },
      homeDir: '/Users/example',
    }),
    /^Claude Code-credentials-[0-9a-f]{8}$/
  );
});

test('installSharedClaudeCodeLogin writes plaintext fallback credentials and restores backups', () => withTempDir(tempDir => {
  const env = {
    CLAUDE_CONFIG_DIR: tempDir,
  };
  const credentialsPath = path.join(tempDir, '.credentials.json');
  const settingsPath = path.join(tempDir, 'settings.json');
  const existingCredentials = {
    mcpOAuth: {
      example: {
        accessToken: 'mcp-token',
      },
    },
    claudeAiOauth: {
      accessToken: 'old-token',
      refreshToken: 'old-refresh',
      expiresAt: 1700000000000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'pro',
      rateLimitTier: 'default',
    },
  };
  const existingSettings = {
    apiKeyHelper: 'security find-generic-password -w -s old-helper',
    env: {
      EXISTING: '1',
      ANTHROPIC_API_KEY: 'sk-old',
      ANTHROPIC_AUTH_TOKEN: 'auth-old',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: 'true',
      CLAUDE_CODE_USE_FOUNDRY: 'yes',
    },
  };
  fs.writeFileSync(credentialsPath, JSON.stringify(existingCredentials));
  fs.writeFileSync(settingsPath, JSON.stringify(existingSettings));

  const installed = installSharedClaudeCodeLogin({
    localAuthToken: 'airouter-oauth-shared-token',
    baseUrl: 'http://router.example:3009',
    env,
    platform: 'linux',
    now: () => new Date('2026-06-22T00:00:00.000Z'),
  });

  assert.equal(installed.credentials.storage.type, 'plaintext');
  assert.equal(installed.settings.path, settingsPath);
  assert.ok(fs.existsSync(installed.backupPath));

  const nextCredentials = readJson(credentialsPath);
  assert.deepEqual(nextCredentials.mcpOAuth, existingCredentials.mcpOAuth);
  assert.deepEqual(nextCredentials.claudeAiOauth, {
    accessToken: 'airouter-oauth-shared-token',
    refreshToken: null,
    expiresAt: null,
    scopes: ['user:inference'],
    subscriptionType: null,
    rateLimitTier: null,
  });

  const nextSettings = readJson(settingsPath);
  assert.equal(nextSettings.apiKeyHelper, undefined);
  assert.deepEqual(nextSettings.env, {
    EXISTING: '1',
    ANTHROPIC_BASE_URL: 'http://router.example:3009',
  });

  const backup = readJson(installed.backupPath);
  assert.equal(backup.type, 'airouter-claude-code-credentials-backup');
  assert.deepEqual(backup.credentials.data, existingCredentials);
  assert.deepEqual(backup.settings.data, existingSettings);

  restoreClaudeCodeLogin({
    backupPath: installed.backupPath,
  });

  assert.deepEqual(readJson(credentialsPath), existingCredentials);
  assert.deepEqual(readJson(settingsPath), existingSettings);
}));

test('updateSettingsForSharedClaudeCodeLogin removes settings that disable Claude OAuth', () => {
  assert.deepEqual(updateSettingsForSharedClaudeCodeLogin({
    apiKeyHelper: 'echo sk-old',
    cleanupPeriodDays: 30,
    env: {
      KEEP: 'yes',
      ANTHROPIC_API_KEY: 'sk-old',
      ANTHROPIC_AUTH_TOKEN: 'auth-old',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_USE_VERTEX: '1',
      CLAUDE_CODE_USE_FOUNDRY: '1',
    },
  }, ' http://router.example:3009 '), {
    cleanupPeriodDays: 30,
    env: {
      KEEP: 'yes',
      ANTHROPIC_BASE_URL: 'http://router.example:3009',
    },
  });
});

test('installSharedClaudeCodeLogin can write macOS Keychain payloads through security', () => {
  const calls = [];
  const spawnSyncImpl = (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (args.includes('find-generic-password')) {
      return {
        status: 0,
        stdout: JSON.stringify({
          otherSecret: {
            value: 'keep-me',
          },
        }),
        stderr: '',
      };
    }
    return {
      status: 0,
      stdout: '',
      stderr: '',
    };
  };

  const installed = installSharedClaudeCodeLogin({
    localAuthToken: 'airouter-oauth-keychain-token',
    env: {
      USER: 'alice',
    },
    homeDir: '/Users/alice',
    platform: 'darwin',
    now: () => new Date('2026-06-22T00:00:00.000Z'),
    backupDir: fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-keychain-backup-')),
    spawnSyncImpl,
  });

  try {
    assert.equal(installed.credentials.storage.type, 'keychain');
    assert.equal(installed.credentials.storage.serviceName, 'Claude Code-credentials');

    const writeCall = calls.find(call => call.args.includes('-i'));
    assert.ok(writeCall);
    assert.equal(writeCall.command, 'security');
    assert.equal(writeCall.options.stdio[0], 'pipe');
    assert.match(writeCall.options.input, /add-generic-password -U -a "alice" -s "Claude Code-credentials" -X "[0-9a-f]+"/);

    const hexPayload = writeCall.options.input.match(/-X "([0-9a-f]+)"/)[1];
    const payload = JSON.parse(Buffer.from(hexPayload, 'hex').toString('utf8'));
    assert.equal(payload.otherSecret.value, 'keep-me');
    assert.deepEqual(payload.claudeAiOauth, {
      accessToken: 'airouter-oauth-keychain-token',
      refreshToken: null,
      expiresAt: null,
      scopes: ['user:inference'],
      subscriptionType: null,
      rateLimitTier: null,
    });
  } finally {
    fs.rmSync(path.dirname(installed.backupPath), { recursive: true, force: true });
  }
});

test('installSharedClaudeCodeLogin falls back to plaintext when macOS Keychain write fails', () => withTempDir(tempDir => {
  const env = {
    CLAUDE_CONFIG_DIR: tempDir,
    USER: 'alice',
  };
  const spawnSyncImpl = (command, args) => {
    if (args.includes('find-generic-password')) {
      return {
        status: 1,
        stdout: '',
        stderr: '',
      };
    }

    return {
      status: 1,
      stdout: '',
      stderr: 'User interaction is not allowed.',
    };
  };

  const installed = installSharedClaudeCodeLogin({
    localAuthToken: 'airouter-oauth-keychain-fallback-token',
    baseUrl: 'http://router.example:3009',
    env,
    homeDir: '/Users/alice',
    platform: 'darwin',
    now: () => new Date('2026-06-22T00:00:00.000Z'),
    spawnSyncImpl,
  });

  assert.equal(installed.credentials.storage.type, 'keychain');
  assert.match(installed.credentials.warning, /\.credentials\.json/);

  const credentialsPath = path.join(tempDir, '.credentials.json');
  assert.deepEqual(readJson(credentialsPath).claudeAiOauth, {
    accessToken: 'airouter-oauth-keychain-fallback-token',
    refreshToken: null,
    expiresAt: null,
    scopes: ['user:inference'],
    subscriptionType: null,
    rateLimitTier: null,
  });
}));
