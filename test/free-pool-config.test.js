const test = require('node:test');
const assert = require('node:assert/strict');
const { parseOpenAiConfigFile, createRuntimeConfigs } = require('../app/openai-config');
const { updateConfigItemById, deleteConfigItemById } = require('../app/config-editor');
const { normalizePoolOptions } = require('../app/free-pool-config');
function fixture() { return { configs: [{ id: 'go', type: 'apikey', preset: 'opencode-go', apikey: 'fixture-secret', base_url: 'https://opencode.ai/inference/go', models: [] }, { id: 'pool', type: 'apikey', preset: 'opencode-free', credential_ref: 'go' }], routing: { models: [{ id: 'arbitrary', targets: [{ config_id: 'pool', model: 'free', protocol: 'chat_completions' }] }] } }; }
const parse = value => parseOpenAiConfigFile(JSON.stringify(value));
test('pool config materializes exactly free and runtime reuses source secret without copying it', () => {
  const parsed = parse(fixture()); const runtime = createRuntimeConfigs(parsed)[1];
  assert.deepEqual(parsed.configs[1].models, [{ id: 'free', protocols: ['chat_completions'] }]);
  assert.equal(parsed.configs[1].apikey, undefined); assert.equal(runtime.apiKey, 'fixture-secret');
  parsed.configs[0].enabled = false; assert.equal(createRuntimeConfigs(parsed)[1].enabled, false);
});
test('invalid references, cycles, incompatible platforms and edits of fixed free are rejected', () => {
  for (const patch of [{ credential_ref: 'missing' }, { credential_ref: 'pool' }, { apikey: 'duplicate' }, { models: [] }, { models: [{ id: 'beam', protocols: ['chat_completions'] }] }]) {
    const value = fixture(); Object.assign(value.configs[1], patch); assert.throws(() => parse(value));
  }
  const value = fixture(); value.configs[0].preset = 'openrouter'; assert.throws(() => parse(value), /对应平台/);
  assert.throws(() => deleteConfigItemById(parse(fixture()), 'go'), /凭证/);
});
test('source credential updates take effect and Go to Zen switches the effective built-in endpoint', () => {
  let value = parse(fixture());
  value = updateConfigItemById(value, 'go', { apikey: 'rotated-fixture', preset: 'opencode-zen' });
  assert.equal(createRuntimeConfigs(value)[1].apiKey, 'rotated-fixture');
  assert.equal(createRuntimeConfigs(value)[1].baseUrl, 'https://opencode.ai/inference');
});
test('advanced pool settings are bounded with explicit quality tiers', () => {
  assert.equal(normalizePoolOptions().strategy, 'quality_first');
  for (const value of [{ max_attempts: 33 }, { sync_interval_seconds: 0 }, { max_stale_seconds: 50 }, { tiers: { m: 0 } }, { tiers: [] }, { strategy: 'random' }, { max_stale_seconds: 100, sync_interval_seconds: 900 }]) assert.throws(() => normalizePoolOptions(value));
});


test('independent API keys are accepted for pools without a credential reference', () => {
  for (const preset of ['opencode-free', 'openrouter-free']) {
    const parsed = parse({ configs: [{ id: 'pool', type: 'apikey', preset, apikey: 'own-fixture-key' }] });
    assert.equal(createRuntimeConfigs(parsed)[0].apiKey, 'own-fixture-key');
  }
});
