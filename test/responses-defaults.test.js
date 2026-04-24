const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeResponsesRequestBody } = require('../app/responses-defaults');

test('normalizeResponsesRequestBody upgrades responses models using configured aliases case-insensitively', () => {
  const normalized = normalizeResponsesRequestBody('/v1/responses', {
    model: 'GPT-5.4-MINI',
    input: 'hello',
  }, {
    modelAliases: {
      'gpt-5.4-mini': 'gpt-5.5',
    },
  });

  assert.equal(normalized.model, 'gpt-5.5');
});

test('normalizeResponsesRequestBody leaves the model unchanged when no configured alias matches', () => {
  const normalized = normalizeResponsesRequestBody('/v1/responses', {
    model: 'gpt-5.4-mini',
    input: 'hello',
  }, {
    modelAliases: {
      'gpt-5-mini': 'gpt-5.5',
    },
  });

  assert.equal(normalized.model, 'gpt-5.4-mini');
});

test('normalizeResponsesRequestBody leaves the model unchanged outside responses paths', () => {
  const normalized = normalizeResponsesRequestBody('/v1/chat/completions', {
    model: 'gpt-5.4-mini',
    input: 'hello',
  }, {
    modelAliases: {
      'gpt-5.4-mini': 'gpt-5.5',
    },
  });

  assert.equal(normalized.model, 'gpt-5.4-mini');
});
