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

test('normalizeResponsesRequestBody adapts OpenAI Responses fields for CPA Codex upstream compatibility', () => {
  const normalized = normalizeResponsesRequestBody('/backend-api/codex/responses', {
    model: 'gpt-5.5',
    instructions: 'follow project rules',
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'answer in project style',
          },
        ],
      },
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
    ],
    max_output_tokens: 128,
    max_completion_tokens: 256,
    temperature: 0,
    top_p: 0.8,
    truncation: 'auto',
    context_management: {
      compaction: true,
    },
    user: 'local-user',
    service_tier: 'default',
    store: true,
  }, {
    codexCompatibility: true,
    cpaStyleCompatibility: true,
    forceStoreFalse: true,
  });

  assert.deepEqual(normalized.input, [
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'follow project rules',
        },
      ],
    },
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: 'answer in project style',
        },
      ],
    },
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
  assert.equal(normalized.instructions, '');
  assert.equal(Object.hasOwn(normalized, 'max_output_tokens'), false);
  assert.equal(Object.hasOwn(normalized, 'max_completion_tokens'), false);
  assert.equal(Object.hasOwn(normalized, 'temperature'), false);
  assert.equal(Object.hasOwn(normalized, 'top_p'), false);
  assert.equal(Object.hasOwn(normalized, 'truncation'), false);
  assert.equal(Object.hasOwn(normalized, 'context_management'), false);
  assert.equal(Object.hasOwn(normalized, 'user'), false);
  assert.equal(Object.hasOwn(normalized, 'service_tier'), false);
  assert.equal(normalized.stream, true);
  assert.equal(normalized.parallel_tool_calls, true);
  assert.deepEqual(normalized.include, ['reasoning.encrypted_content']);
});

test('normalizeResponsesRequestBody keeps empty instructions for Codex upstream compatibility', () => {
  const normalized = normalizeResponsesRequestBody('/backend-api/codex/responses', {
    model: 'gpt-5.5',
    instructions: '',
    input: [
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
    ],
    store: true,
  }, {
    codexCompatibility: true,
    forceStoreFalse: true,
  });

  assert.equal(normalized.instructions, '');
  assert.equal(normalized.store, false);
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
});

test('normalizeResponsesRequestBody preserves Codex priority service tier', () => {
  const normalized = normalizeResponsesRequestBody('/backend-api/codex/responses', {
    model: 'gpt-5.5',
    input: 'hello',
    service_tier: 'priority',
  }, {
    codexCompatibility: true,
    cpaStyleCompatibility: true,
  });

  assert.equal(normalized.service_tier, 'priority');
});

test('normalizeResponsesRequestBody normalizes Codex builtin tool aliases', () => {
  const normalized = normalizeResponsesRequestBody('/backend-api/codex/responses', {
    model: 'gpt-5.5',
    input: 'hello',
    tools: [
      {
        type: 'web_search_preview',
      },
    ],
    tool_choice: {
      type: 'web_search_preview_2025_03_11',
    },
  }, {
    codexCompatibility: true,
    cpaStyleCompatibility: true,
  });

  assert.equal(normalized.tools[0].type, 'web_search');
  assert.equal(normalized.tool_choice.type, 'web_search');
});

test('normalizeResponsesRequestBody keeps non-CPA Codex compatibility scoped to legacy fields', () => {
  const normalized = normalizeResponsesRequestBody('/backend-api/codex/responses', {
    model: 'gpt-5.5',
    instructions: 'keep me on the normal path',
    input: [
      {
        type: 'message',
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: 'normal path system',
          },
        ],
      },
    ],
    top_p: 0.8,
    service_tier: 'default',
    tools: [
      {
        type: 'web_search_preview',
      },
    ],
    store: true,
  }, {
    codexCompatibility: true,
    forceStoreFalse: true,
  });

  assert.equal(normalized.instructions, 'keep me on the normal path');
  assert.equal(normalized.input[0].role, 'system');
  assert.equal(normalized.top_p, 0.8);
  assert.equal(normalized.service_tier, 'default');
  assert.equal(normalized.tools[0].type, 'web_search_preview');
  assert.equal(normalized.store, false);
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
