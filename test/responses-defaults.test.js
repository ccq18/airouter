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

test('normalizeResponsesRequestBody preserves client-provided store true for responses compatibility', () => {
  const normalized = normalizeResponsesRequestBody('/v1/responses', {
    model: 'gpt-5.4-mini',
    input: 'hello',
    store: true,
  });

  assert.equal(normalized.store, true);
});

test('normalizeResponsesRequestBody forces store false when the upstream requires it', () => {
  const normalized = normalizeResponsesRequestBody('/v1/responses', {
    model: 'gpt-5.4-mini',
    input: 'hello',
    store: true,
  }, {
    forceStoreFalse: true,
  });

  assert.equal(normalized.store, false);
});

test('normalizeResponsesRequestBody adapts OpenAI Responses fields for Codex upstream compatibility', () => {
  const normalized = normalizeResponsesRequestBody('/backend-api/codex/responses', {
    model: 'gpt-5.5',
    input: 'hello',
    max_output_tokens: 128,
    temperature: 0,
    store: true,
  }, {
    codexCompatibility: true,
    forceStoreFalse: true,
  });

  assert.deepEqual(normalized.input, [
    {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'hello',
        },
      ],
    },
  ]);
  assert.equal(normalized.store, false);
  assert.equal(Object.hasOwn(normalized, 'max_output_tokens'), false);
  assert.equal(Object.hasOwn(normalized, 'temperature'), false);
});

test('normalizeResponsesRequestBody preserves OpenAI Responses fields unless Codex compatibility is requested', () => {
  const normalized = normalizeResponsesRequestBody('/v1/responses', {
    model: 'gpt-5.5',
    input: 'hello',
    max_output_tokens: 128,
    temperature: 0,
  });

  assert.equal(normalized.input, 'hello');
  assert.equal(normalized.max_output_tokens, 128);
  assert.equal(normalized.temperature, 0);
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
