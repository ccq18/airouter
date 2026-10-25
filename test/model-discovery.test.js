const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseModelCatalog,
  diffModelCatalog,
} = require('../app/provider-presets');

test('OpenCode Go discovery respects per-model native protocol metadata', () => {
  const config = {
    id: 'cfg-go',
    preset: 'opencode-go',
    base_url: 'https://opencode.ai/inference/go',
    apikey: 'unit-test-key',
  };
  const catalog = parseModelCatalog({
    object: 'list',
    data: [
      { id: 'go-chat-only', protocols: ['chat_completions'] },
      { id: 'go-messages-only', protocols: ['messages'] },
      { id: 'go-responses-only', supported_endpoints: ['responses'] },
      { id: 'go-openai-native', api: 'openai' },
      { id: 'go-anthropic-native', api: 'anthropic' },
      { id: 'go-no-metadata' },
      { id: 'claude-sonnet-4-5' },
      { id: 'gpt-5.2' },
      { id: 'deepseek-chat' },
      { id: 'go-camel', supported_endpoints: ['/v1/chat/completions', '/v1/responses'] },
      { id: 'go-context', context_window: 200000, max_output_tokens: 8192 },
    ],
  }, config);

  const byId = new Map(catalog.map(model => [model.id, model]));
  assert.deepEqual(byId.get('go-chat-only').protocols, ['chat_completions']);
  assert.deepEqual(byId.get('go-messages-only').protocols, ['messages']);
  assert.deepEqual(byId.get('go-responses-only').protocols, ['responses']);
  assert.deepEqual(byId.get('go-openai-native').protocols, ['chat_completions']);
  assert.deepEqual(byId.get('go-anthropic-native').protocols, ['messages']);
  // No metadata is not proof that a Go model supports every endpoint.
  assert.deepEqual(byId.get('go-no-metadata').protocols, ['chat_completions']);
  assert.deepEqual(byId.get('claude-sonnet-4-5').protocols, ['messages']);
  assert.deepEqual(byId.get('gpt-5.2').protocols, ['responses']);
  assert.deepEqual(byId.get('deepseek-chat').protocols, ['chat_completions']);
  assert.deepEqual(byId.get('go-camel').protocols, ['chat_completions', 'responses']);
  assert.equal(byId.get('go-context').context_window, 200000);
  assert.equal(byId.get('go-context').max_output_tokens, 8192);
});

test('non-Go providers fall back to preset protocols when discovery has no metadata', () => {
  const glmCatalog = parseModelCatalog({
    data: [{ id: 'glm-5.3' }],
  }, {
    id: 'cfg-glm',
    preset: 'glm-cn',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'unit-test-key',
  });
  assert.deepEqual(glmCatalog[0].protocols, ['chat_completions']);

  const openrouterCatalog = parseModelCatalog({
    data: [{ id: 'openai/gpt-5.2' }],
  }, {
    id: 'cfg-or',
    preset: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    apikey: 'unit-test-key',
  });
  assert.deepEqual(openrouterCatalog[0].protocols, ['chat_completions']);
});

test('discovery diff keeps manual model edits and merges new models without overwriting', () => {
  const existing = [
    {
      id: 'glm-5.3',
      protocols: ['chat_completions'],
      context_window: 200000,
      capabilities: { images: true },
    },
    { id: 'manual-only', protocols: ['chat_completions'] },
  ];
  const discovered = [
    { id: 'glm-5.3', protocols: ['chat_completions', 'responses'] },
    { id: 'glm-new', protocols: ['chat_completions'] },
  ];

  const diff = diffModelCatalog(existing, discovered);
  assert.deepEqual(diff.added.map(model => model.id), ['glm-new']);
  assert.deepEqual(diff.removed, ['manual-only']);
  assert.deepEqual(diff.kept, ['glm-5.3']);
  assert.equal(diff.suggested_models[0].context_window, 200000);
  assert.deepEqual(diff.suggested_models[0].capabilities, { images: true });
  assert.deepEqual(diff.suggested_models.map(model => model.id), ['glm-5.3', 'manual-only', 'glm-new']);
  assert.deepEqual(diff.protocol_changes, [{
    id: 'glm-5.3',
    local_protocols: ['chat_completions'],
    discovered_protocols: ['chat_completions', 'responses'],
  }]);
});
