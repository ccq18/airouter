const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_TOKEN_URL,
  refreshOpenAIToken,
} = require('../app/openai-token-refresh');

test('refreshOpenAIToken posts the ChatGPT OAuth refresh form', async () => {
  const calls = [];
  const tokenInfo = await refreshOpenAIToken({
    refreshToken: 'old-refresh-token',
    requestBufferedFn: async requestOptions => {
      calls.push(requestOptions);
      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          access_token: 'new-access-token',
          id_token: 'new-id-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'new-refresh-token',
          scope: 'openid profile email',
        }),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].targetUrl, OPENAI_OAUTH_TOKEN_URL);
  assert.equal(calls[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(calls[0].headers['user-agent'], 'codex-cli/0.91.0');
  assert.equal(calls[0].timeoutMs, 10 * 1000);

  const form = new URLSearchParams(calls[0].body.toString('utf8'));
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'old-refresh-token');
  assert.equal(form.get('client_id'), OPENAI_OAUTH_CLIENT_ID);
  assert.equal(form.get('scope'), 'openid profile email');
  assert.equal(tokenInfo.access_token, 'new-access-token');
  assert.equal(tokenInfo.refresh_token, 'new-refresh-token');
  assert.equal(tokenInfo.expires_in, 3600);
});

test('refreshOpenAIToken rejects non-2xx OAuth responses', async () => {
  await assert.rejects(
    () => refreshOpenAIToken({
      refreshToken: 'old-refresh-token',
      requestBufferedFn: async () => ({
        statusCode: 400,
        bodyText: JSON.stringify({
          error: 'invalid_grant',
          error_description: 'refresh token expired',
        }),
      }),
    }),
    /OpenAI token refresh failed: invalid_grant: refresh token expired/
  );
});

test('refreshOpenAIToken formats structured OAuth error payloads', async () => {
  await assert.rejects(
    () => refreshOpenAIToken({
      refreshToken: 'old-refresh-token',
      requestBufferedFn: async () => ({
        statusCode: 400,
        bodyText: JSON.stringify({
          error: {
            code: 'invalid_grant',
            message: 'refresh token expired',
          },
        }),
      }),
    }),
    /OpenAI token refresh failed: invalid_grant: refresh token expired/
  );
});
