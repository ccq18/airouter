const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateRandomSecret,
  getConfiguredApiKeys,
  getConfiguredAuthToken,
  extractRequestApiKey,
  isAuthorizedAdminRequest,
  isAuthorizedRequest,
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

test('isAuthorizedAdminRequest requires an exact matching auth_token', () => {
  assert.equal(isAuthorizedAdminRequest('auth-secret', 'auth-secret'), true);
  assert.equal(isAuthorizedAdminRequest('', 'auth-secret'), false);
  assert.equal(isAuthorizedAdminRequest('wrong-secret', 'auth-secret'), false);
});
