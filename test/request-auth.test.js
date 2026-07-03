const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateRandomSecret,
  getConfiguredApiKeys,
  getConfiguredClaudeTokenRequestAuthTokenHashes,
  getConfiguredClaudeTokenRequestAuthTokens,
  getConfiguredAuthToken,
  extractRequestApiKey,
  isAuthorizedAdminRequest,
  isAuthorizedRequest,
  isAuthorizedRequestWithTokenHashes,
  sha256Hex,
} = require('../app/request-auth');

test('generateRandomSecret prefixes generated values', () => {
  const secret = generateRandomSecret('auth_');

  assert.match(secret, /^auth_[0-9a-f]+$/);
});

test('getConfiguredApiKeys trims and filters configured apikeys', () => {
  assert.deepEqual(getConfiguredApiKeys({
    apikeys: ['  key-1  ', '', 'key-2'],
  }), ['key-1', 'key-2']);
});

test('getConfiguredAuthToken trims the configured auth_token', () => {
  assert.equal(getConfiguredAuthToken({ auth_token: '  auth-secret  ' }), 'auth-secret');
});

test('getConfiguredClaudeTokenRequestAuthTokens returns local and upstream Claude OAuth tokens', () => {
  assert.deepEqual(getConfiguredClaudeTokenRequestAuthTokens({
    configs: [
      {
        type: 'claude_token',
        local_auth_token: '  airouter-oauth-local-token  ',
        access_token: '  real-claude-oauth-token  ',
      },
      {
        type: 'apikey',
        apikey: 'sk-ignored',
      },
      {
        type: 'claude_token',
        local_auth_token: '',
        access_token: 'backup-real-claude-oauth-token',
      },
    ],
    disabled_configs: [
      {
        type: 'claude_token',
        local_auth_token: 'disabled-local-token',
        access_token: 'disabled-real-token',
      },
    ],
  }), [
    'airouter-oauth-local-token',
    'real-claude-oauth-token',
    'backup-real-claude-oauth-token',
  ]);
});

test('getConfiguredClaudeTokenRequestAuthTokenHashes returns configured Claude OAuth request hashes', () => {
  assert.deepEqual(getConfiguredClaudeTokenRequestAuthTokenHashes({
    configs: [
      {
        type: 'claude_token',
        request_auth_token_sha256s: [
          'A'.repeat(64),
          'invalid-hash',
        ],
      },
      {
        type: 'apikey',
        request_auth_token_sha256s: ['b'.repeat(64)],
      },
    ],
  }), ['a'.repeat(64)]);
});

test('extractRequestApiKey prefers x-api-key and also supports bearer authorization', () => {
  assert.equal(extractRequestApiKey({
    'x-api-key': 'router-secret',
  }), 'router-secret');

  assert.equal(extractRequestApiKey({
    authorization: 'Bearer router-secret',
  }), 'router-secret');
});

test('isAuthorizedRequest allows requests when no apikey is configured', () => {
  assert.equal(isAuthorizedRequest({}, []), true);
});

test('isAuthorizedRequest rejects missing or invalid apikey values', () => {
  assert.equal(isAuthorizedRequest({}, ['router-secret']), false);
  assert.equal(isAuthorizedRequest({
    authorization: 'Bearer wrong-secret',
  }, ['router-secret', 'backup-secret']), false);
});

test('isAuthorizedRequest accepts any matching configured apikey', () => {
  assert.equal(isAuthorizedRequest({
    authorization: 'Bearer backup-secret',
  }, ['router-secret', 'backup-secret']), true);

  assert.equal(isAuthorizedRequest({
    'x-api-key': 'router-secret',
  }, ['router-secret', 'backup-secret']), true);
});

test('isAuthorizedRequestWithTokenHashes accepts matching bearer token hashes', () => {
  const keychainToken = 'real-keychain-claude-oauth-token';

  assert.equal(isAuthorizedRequestWithTokenHashes({
    authorization: `Bearer ${keychainToken}`,
  }, ['router-secret'], [sha256Hex(keychainToken)]), true);

  assert.equal(isAuthorizedRequestWithTokenHashes({
    authorization: 'Bearer wrong-secret',
  }, ['router-secret'], [sha256Hex(keychainToken)]), false);
});

test('isAuthorizedAdminRequest requires an exact matching auth_token', () => {
  assert.equal(isAuthorizedAdminRequest('auth-secret', 'auth-secret'), true);
  assert.equal(isAuthorizedAdminRequest('', 'auth-secret'), false);
  assert.equal(isAuthorizedAdminRequest('wrong-secret', 'auth-secret'), false);
});
