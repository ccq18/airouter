const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLAUDE_OAUTH_CLIENT_ID,
  buildClaudeAuthorizeUrl,
  buildClaudeTokenConfig,
  appendClaudeTokenConfig,
  parseClaudeOAuthCallbackCode,
} = require('../app/claude-oauth');

test('buildClaudeAuthorizeUrl creates a Claude Code OAuth PKCE authorization URL', () => {
  const url = new URL(buildClaudeAuthorizeUrl({
    codeChallenge: 'challenge-example',
    state: 'state-example',
    port: 48321,
  }));

  assert.equal(url.origin + url.pathname, 'https://claude.com/cai/oauth/authorize');
  assert.equal(url.searchParams.get('code'), 'true');
  assert.equal(url.searchParams.get('client_id'), CLAUDE_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:48321/callback');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-example');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-example');
  assert.match(url.searchParams.get('scope'), /user:inference/);
  assert.match(url.searchParams.get('scope'), /user:profile/);
});

test('parseClaudeOAuthCallbackCode accepts pasted callback URL variants', () => {
  const state = 'state-example';

  assert.equal(
    parseClaudeOAuthCallbackCode('http://localhost:48321/callback?code=code-example&state=state-example', { state }),
    'code-example',
  );
  assert.equal(
    parseClaudeOAuthCallbackCode('/callback?code=code-example&state=state-example', { state }),
    'code-example',
  );
  assert.equal(
    parseClaudeOAuthCallbackCode('?code=code-example&state=state-example', { state }),
    'code-example',
  );
  assert.equal(
    parseClaudeOAuthCallbackCode('code=code-example&state=state-example', { state }),
    'code-example',
  );
  assert.equal(
    parseClaudeOAuthCallbackCode('localhost:48321/callback?code=code-example&state=state-example', { state }),
    'code-example',
  );
});

test('parseClaudeOAuthCallbackCode rejects invalid pasted callback input', () => {
  assert.throws(
    () => parseClaudeOAuthCallbackCode('/callback?code=code-example&state=wrong-state', { state: 'state-example' }),
    /OAuth state mismatch/,
  );
  assert.throws(
    () => parseClaudeOAuthCallbackCode('/callback?state=state-example', { state: 'state-example' }),
    /Missing OAuth code/,
  );
  assert.throws(
    () => parseClaudeOAuthCallbackCode('/not-callback?code=code-example&state=state-example', { state: 'state-example' }),
    /OAuth callback path must be \/callback/,
  );
});

test('buildClaudeTokenConfig converts OAuth tokens into a claude_token config item', () => {
  const localAuthToken = 'airouter-oauth-local-token';
  const config = buildClaudeTokenConfig({
    tokenResponse: {
      access_token: 'real-access-token',
      refresh_token: 'real-refresh-token',
      request_auth_token_sha256s: ['A'.repeat(64), 'invalid-hash'],
      expires_in: 3600,
    },
    profile: {
      account: {
        uuid: 'account-uuid-example',
        email_address: 'user@example.com',
      },
      organization: {
        uuid: 'org-uuid-example',
        name: 'Example Org',
      },
    },
    localAuthToken,
    now: () => 1700000000000,
  });

  assert.deepEqual(config, {
    type: 'claude_token',
    access_token: 'real-access-token',
    refresh_token: 'real-refresh-token',
    expires_at: 1700003600000,
    account_uuid: 'account-uuid-example',
    organization_uuid: 'org-uuid-example',
    local_auth_token: localAuthToken,
    request_auth_token_sha256s: ['a'.repeat(64)],
    description: 'user@example.com · Example Org',
  });
});

test('appendClaudeTokenConfig adds local auth token to apikeys without duplicating it', () => {
  const localAuthToken = 'airouter-oauth-local-token';
  const parsed = {
    apikeys: [localAuthToken],
    configs: [],
    disabled_configs: [],
  };

  const next = appendClaudeTokenConfig(parsed, {
    tokenResponse: {
      access_token: 'real-access-token',
      refresh_token: 'real-refresh-token',
      expires_in: 3600,
    },
    localAuthToken,
    now: () => 1700000000000,
  });

  assert.notEqual(next, parsed);
  assert.deepEqual(next.apikeys, [localAuthToken]);
  assert.equal(next.configs.length, 1);
  assert.equal(next.configs[0].type, 'claude_token');
  assert.equal(next.configs[0].local_auth_token, localAuthToken);
  assert.equal(parsed.configs.length, 0);
});
