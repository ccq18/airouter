const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ensureConfigIds,
  getRoutingRevision,
  parseRoutingConfig,
  getPublicModelIds,
  resolveRoute,
  validateConfigModels,
  findRoutesReferencingModel,
} = require('../app/routing-config');
const { parseOpenAiConfigFile } = require('../app/openai-config');

function baseParsed(overrides = {}) {
  return {
    configs: [
      {
        id: 'cfg-glm',
        type: 'apikey',
        preset: 'glm-cn',
        base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
        apikey: 'sk-example',
        models: [
          { id: 'glm-5.3', protocols: ['chat_completions'] },
          { id: 'glm-4.7', protocols: ['chat_completions'] },
        ],
      },
      {
        id: 'cfg-or',
        type: 'apikey',
        preset: 'openrouter',
        base_url: 'https://openrouter.ai/api/v1',
        apikey: 'sk-example-2',
        models: [
          { id: 'deepseek/deepseek-chat', protocols: ['chat_completions'] },
        ],
      },
    ],
    routing: {
      models: [
        {
          id: 'deepseek',
          enabled: true,
          entry_protocols: ['chat_completions', 'responses', 'messages'],
          targets: [
            { config_id: 'cfg-glm', model: 'glm-5.3', protocol: 'chat_completions' },
            { config_id: 'cfg-or', model: 'deepseek/deepseek-chat', protocol: 'chat_completions' },
          ],
        },
      ],
    },
    ...overrides,
  };
}

test('routing is the only dispatch contract and mode flags are rejected', () => {
  const parsed = parseOpenAiConfigFile(JSON.stringify(baseParsed()));
  assert.deepEqual(getPublicModelIds(parsed), ['deepseek']);
  assert.deepEqual(parseRoutingConfig({ configs: [] }).models, []);
  assert.throws(() => parseRoutingConfig({ routing: { mode: 'legacy' } }), /mode.*移除/);
  assert.throws(() => parseRoutingConfig({ routing: { mode: 'explicit' } }), /mode.*移除/);
});

test('config model lists and targets preserve arbitrary backend model IDs and case', () => {
  const parsed = baseParsed();
  parsed.configs[0].models.push({ id: 'GLM-5.3-Experimental', protocols: ['chat_completions'] });
  parsed.routing.models[0].targets.push({
    config_id: 'cfg-glm',
    model: 'GLM-5.3-Experimental',
    protocol: 'chat_completions',
  });

  const routing = parseRoutingConfig(parsed);
  assert.equal(routing.models[0].targets[2].model, 'GLM-5.3-Experimental');
  assert.equal(routing.models[0].targets[2].id, 'target_3');
  assert.deepEqual(getPublicModelIds(parsed), ['deepseek']);
  assert.equal(resolveRoute(parsed, 'deepseek').id, 'deepseek');
  assert.equal(resolveRoute(parsed, 'DeepSeek'), null);
});

test('public route IDs are exact, case-sensitive, non-empty and at most 200 characters', () => {
  const duplicated = baseParsed();
  duplicated.routing.models.push({ ...duplicated.routing.models[0] });
  assert.throws(() => parseRoutingConfig(duplicated), /重复/);

  const caseVariants = baseParsed();
  caseVariants.routing.models.push({
    id: 'DeepSeek',
    targets: [{ config_id: 'cfg-glm', model: 'glm-5.3', protocol: 'chat_completions' }],
  });
  assert.deepEqual(getPublicModelIds(caseVariants), ['deepseek', 'DeepSeek']);

  for (const invalid of ['', ' deepseek', 'deepseek ', 'x'.repeat(201)]) {
    const parsed = baseParsed();
    parsed.routing.models[0].id = invalid;
    assert.throws(() => parseRoutingConfig(parsed), /模型 ID|200/);
  }
});

test('duplicate target IDs are rejected and auto IDs stay unique after reordering', () => {
  const duplicated = baseParsed();
  duplicated.routing.models[0].targets[0].id = 'same';
  duplicated.routing.models[0].targets[1].id = 'same';
  assert.throws(() => parseRoutingConfig(duplicated), /候选 ID 重复/);

  const explicitMixed = baseParsed();
  explicitMixed.routing.models[0].targets[0].id = 'target_2';
  explicitMixed.routing.models[0].targets[1].id = undefined;
  const normalized = parseRoutingConfig(explicitMixed);
  assert.deepEqual(normalized.models[0].targets.map(target => target.id), ['target_2', 'target_1']);
});

test('targets reference existing account/model and ignore obsolete fixed protocol', () => {
  const missingConfig = baseParsed();
  missingConfig.routing.models[0].targets[0].config_id = 'cfg-missing';
  assert.throws(() => parseRoutingConfig(missingConfig), /不存在/);

  const missingModel = baseParsed();
  missingModel.routing.models[0].targets[0].model = 'glm-missing';
  assert.throws(() => parseRoutingConfig(missingModel), /模型/);

  const wrongProtocol = baseParsed();
  wrongProtocol.routing.models[0].targets[0].protocol = 'messages';
  assert.ok(!Object.hasOwn(parseRoutingConfig(wrongProtocol).models[0].targets[0], 'protocol'));

  const duplicateTarget = baseParsed();
  duplicateTarget.routing.models[0].targets.push({
    config_id: 'cfg-glm',
    model: 'glm-5.3',
    protocol: 'chat_completions',
  });
  assert.throws(() => parseRoutingConfig(duplicateTarget), /重复/);
});

test('custom providers may only configure model discovery themselves', () => {
  const custom = parseOpenAiConfigFile(JSON.stringify({
    configs: [{
      id: 'cfg-custom',
      type: 'apikey',
      preset: 'custom',
      base_url: 'http://127.0.0.1:9000/v1',
      apikey: 'sk-example',
      models_endpoint: '/models',
      models: [{ id: 'my-model', protocols: ['chat_completions'] }],
    }],
    routing: {
      models: [{
        id: 'public',
        targets: [{ config_id: 'cfg-custom', model: 'my-model', protocol: 'chat_completions' }],
      }],
    },
  }));

  assert.deepEqual(custom.configs[0].models, [{ id: 'my-model', protocols: ['chat_completions'] }]);
  assert.equal(custom.configs[0].models_endpoint, '/models');
});

test('config model validation rejects malformed protocol and capability entries', () => {
  assert.throws(
    () => validateConfigModels([{ id: '', protocols: ['chat_completions'] }]),
    /模型 ID/,
  );
  assert.throws(
    () => validateConfigModels([{ id: 'x', protocols: ['grpc'] }]),
    /协议/,
  );
  assert.throws(
    () => validateConfigModels([{ id: 'x', protocols: ['chat_completions'], context_window: -1 }]),
    /context_window/,
  );
  assert.doesNotThrow(() => validateConfigModels([
    {
      id: 'x',
      protocols: ['chat_completions', 'messages'],
      capabilities: { tools: true, images: false },
      context_window: 128000,
      max_output_tokens: 8192,
    },
  ]));
});

test('stable config ids are assigned without reordering or rewriting credentials', () => {
  const parsed = {
    configs: [
      { type: 'token', access_token: 'token-1', account_id: 'account-1' },
      { id: 'cfg-keep', type: 'apikey', base_url: 'https://example.com/v1', apikey: 'sk-example' },
    ],

  };
  let counter = 0;
  const ensured = ensureConfigIds(parsed, {
    generateId: () => `cfg_generated_${++counter}`,
  });

  assert.equal(ensured.changed, true);
  assert.equal(ensured.parsed.configs[0].id, 'cfg_generated_1');
  assert.equal(ensured.parsed.configs[1].id, 'cfg-keep');
  assert.equal(ensured.parsed.configs[0].access_token, 'token-1');
  assert.equal(ensured.parsed.configs[0].account_id, 'account-1');

  const again = ensureConfigIds(ensured.parsed, { generateId: () => 'cfg-unused' });
  assert.equal(again.changed, false);
});

test('routing revision changes only with routing-relevant configuration', () => {
  const first = getRoutingRevision(baseParsed());
  const second = getRoutingRevision(baseParsed());
  assert.equal(first, second);

  const reordered = baseParsed();
  reordered.routing.models[0].targets.reverse();
  assert.notEqual(getRoutingRevision(reordered), first);

  const credentialChange = baseParsed();
  credentialChange.configs[0].apikey = 'sk-changed-example';
  assert.equal(getRoutingRevision(credentialChange), first);
});

test('referenced model changes list affected public routes', () => {
  assert.deepEqual(findRoutesReferencingModel(baseParsed(), 'cfg-glm', 'glm-5.3'), ['deepseek']);
  assert.deepEqual(findRoutesReferencingModel(baseParsed(), 'cfg-glm', 'glm-4.7'), []);
});


test('new candidate placed before an existing target preserves unique stable IDs', () => {
  const parsed = baseParsed();
  const route = parsed.routing.models[0];
  const existing = { ...route.targets[0], id: 'target_1' };
  const added = { ...route.targets[1] };
  delete added.id;
  route.targets = [added, existing];
  const normalized = parseRoutingConfig(parsed);
  const ids = normalized.models[0].targets.map(target => target.id);
  assert.equal(new Set(ids).size, 2);
  assert.equal(ids[1], 'target_1');
  assert.doesNotThrow(() => parseRoutingConfig({ ...parsed, routing: normalized }));
});
