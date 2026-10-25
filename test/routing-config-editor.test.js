const test = require('node:test');
const assert = require('node:assert/strict');

const {
  addConfigItems,
  updateConfigItemById,
  deleteConfigItemById,
  updateRoutingModels,
  updateConfigSettings,
} = require('../app/config-editor');
const { parseOpenAiConfigFile } = require('../app/openai-config');

function baseParsed() {
  return {
    configs: [{
      id: 'cfg-a',
      type: 'apikey',
      preset: 'glm-cn',
      base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
      apikey: 'sk-example',
      models: [{ id: 'glm-5.3', protocols: ['chat_completions'] }],
    }],
  };
}

test('new upstream accounts receive a stable id and preserve model lists', () => {
  const next = addConfigItems(baseParsed(), [{
    type: 'apikey',
    preset: 'opencode-go',
    base_url: 'https://opencode.ai/inference/go',
    apikey: 'sk-example-2',
    models: [{ id: 'go-chat', protocols: ['chat_completions'] }],
  }]);

  assert.match(next.configs[1].id, /^cfg_/);
  assert.deepEqual(next.configs[1].models, [{ id: 'go-chat', protocols: ['chat_completions'] }]);
  assert.equal(next.configs[1].preset, 'opencode-go');
});

test('updating an upstream by stable id replaces models and keeps its id', () => {
  const updated = updateConfigItemById(baseParsed(), 'cfg-a', {
    description: 'GLM account',
    models: [
      { id: 'glm-5.3', protocols: ['chat_completions'] },
      { id: 'glm-4.7', protocols: ['chat_completions'] },
    ],
  });

  assert.equal(updated.configs[0].id, 'cfg-a');
  assert.equal(updated.configs[0].description, 'GLM account');
  assert.equal(updated.configs[0].models.length, 2);
  assert.deepEqual(parseOpenAiConfigFile(JSON.stringify(updated)).configs[0].models[1], {
    id: 'glm-4.7',
    protocols: ['chat_completions'],
    capabilities: {},
    context_window: null,
    max_output_tokens: null,
  });
});

test('deleting an upstream by stable id does not use array indexes', () => {
  const parsed = baseParsed();
  parsed.configs.push({
    id: 'cfg-b',
    type: 'apikey',
    preset: 'custom',
    base_url: 'https://example.com/v1',
    apikey: 'sk-example-2',
    models: [{ id: 'x', protocols: ['chat_completions'] }],
  });

  const next = deleteConfigItemById(parsed, 'cfg-a');
  assert.deepEqual(next.configs.map(item => item.id), ['cfg-b']);
  assert.throws(() => deleteConfigItemById(parsed, 'cfg-missing'), /不存在/);
});

test('routing models are saved atomically with explicit mode and validation', () => {
  const next = updateRoutingModels(baseParsed(), [{
    id: 'public-model',
    entry_protocols: ['chat_completions'],
    targets: [{ config_id: 'cfg-a', model: 'glm-5.3', protocol: 'chat_completions' }],
  }], { maxAttempts: 2 });

  assert.equal(next.routing.mode, 'explicit');
  assert.equal(next.routing.max_attempts, 2);
  assert.equal(next.routing.models[0].targets[0].id, 'target_1');

  assert.throws(() => updateRoutingModels(baseParsed(), [{
    id: 'public-model',
    targets: [{ config_id: 'cfg-missing', model: 'glm-5.3', protocol: 'chat_completions' }],
  }]), /不存在/);
});

test('routing can be enabled and disabled through settings without touching credentials', () => {
  const enabled = updateConfigSettings(baseParsed(), {
    routing: {
      mode: 'explicit',
      models: [{
        id: 'public-model',
        targets: [{ config_id: 'cfg-a', model: 'glm-5.3', protocol: 'chat_completions' }],
      }],
    },
  });
  assert.equal(enabled.routing.mode, 'explicit');
  assert.equal(enabled.configs[0].apikey, 'sk-example');

  const disabled = updateConfigSettings(enabled, { routing: { mode: 'legacy' } });
  assert.equal(disabled.routing.mode, 'legacy');
});
