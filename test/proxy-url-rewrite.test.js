const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildIncomingUrl,
  rewriteProxyUrl,
} = require('../app/proxy-url-rewrite');

test('rewriteProxyUrl maps token image edits route to ChatGPT Codex backend path', () => {
  const rewritten = rewriteProxyUrl('/v1/images/edits?user=abc', {
    type: 'token',
    apiBasePath: '/backend-api/codex',
  });

  assert.equal(rewritten, '/backend-api/codex/images/edits?user=abc');
});

test('rewriteProxyUrl maps token image generations route to ChatGPT Codex backend path', () => {
  const rewritten = rewriteProxyUrl('/v1/images/generations?user=abc', {
    type: 'token',
    apiBasePath: '/backend-api/codex',
  });

  assert.equal(rewritten, '/backend-api/codex/images/generations?user=abc');
});

test('rewriteProxyUrl keeps apikey image edits route OpenAI-compatible', () => {
  const rewritten = rewriteProxyUrl('/v1/images/edits', {
    type: 'apikey',
  });

  assert.equal(rewritten, '/v1/images/edits?client_version=1');
});

test('rewriteProxyUrl keeps apikey image generations route OpenAI-compatible', () => {
  const rewritten = rewriteProxyUrl('/v1/images/generations', {
    type: 'apikey',
  });

  assert.equal(rewritten, '/v1/images/generations?client_version=1');
});

test('buildIncomingUrl reconstructs mounted /v1 image edits requests', () => {
  assert.equal(buildIncomingUrl({
    baseUrl: '/v1',
    url: '/images/edits',
  }), '/v1/images/edits');
});

test('buildIncomingUrl reconstructs mounted /v1 image generations requests', () => {
  assert.equal(buildIncomingUrl({
    baseUrl: '/v1',
    url: '/images/generations',
  }), '/v1/images/generations');
});
