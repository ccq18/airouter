const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeResponsesRequestBody } = require('../app/responses-defaults');

test('normalizeResponsesRequestBody upgrades gpt-5.4-mini responses requests to gpt-5.5', () => {
  const normalized = normalizeResponsesRequestBody('/v1/responses', {
    model: 'gpt-5.4-mini',
    input: 'hello',
  });

  assert.equal(normalized.model, 'gpt-5.5');
});

test('normalizeResponsesRequestBody leaves gpt-5.4-mini unchanged outside responses paths', () => {
  const normalized = normalizeResponsesRequestBody('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    input: 'hello',
  });

  assert.equal(normalized.model, 'gpt-5.4-mini');
});
