const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BUILTIN_MODEL_LIMITS, normalizeModelId, lookupBuiltinLimits, extractUpstreamLimits,
  resolveModelLimits, createModelLimitsStore, summarizeRouteLimits,
} = require('../app/model-limits');
const { parseModelCatalog, getProviderPreset } = require('../app/provider-presets');

test('normalizeModelId strips provider prefix, case, routing tags and snapshot suffixes', () => {
  assert.equal(normalizeModelId('GLM-5.3'), 'glm-5.3');
  assert.equal(normalizeModelId('z-ai/glm-5.3'), 'glm-5.3');
  assert.equal(normalizeModelId('deepseek/deepseek-v4.1-flash'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModelId('z-ai/glm-5.3:batch'), 'glm-5.3');
  assert.equal(normalizeModelId('deepseek/deepseek-v4.1-flash-1017'), 'deepseek-v4.1-flash');
  assert.equal(normalizeModelId('glm-5.1-20260401'), 'glm-5.1');
  assert.equal(normalizeModelId('glm-5.1-2026-04-01'), 'glm-5.1');
  assert.equal(normalizeModelId('glm-4.7-latest'), 'glm-4.7');
  assert.equal(normalizeModelId('  '), '');
  assert.equal(normalizeModelId(null), '');
});

test('free variants are never matched to the paid model limits', () => {
  assert.equal(lookupBuiltinLimits('deepseek-v4.1-flash-free'), null);
  assert.equal(lookupBuiltinLimits('glm-5.3-flash-free'), null);
  assert.equal(lookupBuiltinLimits('z-ai/glm-5.3:free'), null);
});

test('built-in table carries the documented values and a source URL for every entry', () => {
  assert.deepEqual(lookupBuiltinLimits('glm-5.3').context_window, 1048576);
  assert.deepEqual(lookupBuiltinLimits('glm-5.3').max_output_tokens, 131072);
  assert.equal(lookupBuiltinLimits('GLM-5.2').context_window, 1048576);
  for (const id of ['glm-5.1', 'glm-5', 'glm-4.7', 'glm-4.6']) assert.equal(lookupBuiltinLimits(id).context_window, 200000, id);
  assert.equal(lookupBuiltinLimits('deepseek/deepseek-v4.1-flash').context_window, 1048576);
  assert.equal(lookupBuiltinLimits('some-unknown-model'), null);
  for (const entry of BUILTIN_MODEL_LIMITS) assert.match(entry.source, /^https:\/\//);
});

test('extractUpstreamLimits reads OpenAI-style, OpenRouter and OpenCode shapes', () => {
  assert.deepEqual(extractUpstreamLimits({ id: 'x', context_window: 128000, max_output_tokens: 8192 }), { context_window: 128000, max_output_tokens: 8192 });
  // OpenRouter: the provider limit can be smaller than the nominal model length.
  assert.deepEqual(extractUpstreamLimits({ id: 'z-ai/glm-5.1', context_length: 204800, top_provider: { context_length: 202752, max_completion_tokens: 131072 } }),
    { context_window: 202752, max_output_tokens: 131072 });
  // OpenCode Go / Zen
  assert.deepEqual(extractUpstreamLimits({ id: 'glm-5.3', limit: { context: 1000000, output: 131072 } }), { context_window: 1000000, max_output_tokens: 131072 });
  // Zhipu /models: only id + object
  assert.deepEqual(extractUpstreamLimits({ id: 'glm-5.3', object: 'model' }), { context_window: null, max_output_tokens: null });
  assert.deepEqual(extractUpstreamLimits(null), { context_window: null, max_output_tokens: null });
  assert.deepEqual(extractUpstreamLimits({ context_window: -1, max_output_tokens: 'abc' }), { context_window: null, max_output_tokens: null });
});

test('parseModelCatalog keeps OpenCode limit.* and OpenRouter top_provider.* values', () => {
  const go = parseModelCatalog({ data: [{ id: 'glm-5.3', limit: { context: 1000000, output: 131072 } }] }, getProviderPreset('opencode-go'));
  assert.equal(go[0].context_window, 1000000);
  assert.equal(go[0].max_output_tokens, 131072);
  const openrouter = parseModelCatalog({ data: [{ id: 'z-ai/glm-5.3', context_length: 1048576, top_provider: { context_length: 1048576, max_completion_tokens: 943718 } }] }, getProviderPreset('openrouter'));
  assert.equal(openrouter[0].context_window, 1048576);
  assert.equal(openrouter[0].max_output_tokens, 943718);
});

test('resolution order is manual > upstream > builtin > null, per field', () => {
  assert.deepEqual(resolveModelLimits('glm-5.3', {}), {
    context_window: 1048576, context_window_source: 'builtin', max_output_tokens: 131072, max_output_tokens_source: 'builtin',
    builtin_source_url: 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
  });
  const upstream = resolveModelLimits('glm-5.3', { upstream: { context_window: 1000000, max_output_tokens: null } });
  assert.equal(upstream.context_window, 1000000);
  assert.equal(upstream.context_window_source, 'upstream');
  assert.equal(upstream.max_output_tokens, 131072);
  assert.equal(upstream.max_output_tokens_source, 'builtin');
  const manual = resolveModelLimits('glm-5.3', { manual: { context_window: 500000 }, upstream: { context_window: 1000000, max_output_tokens: 64000 } });
  assert.equal(manual.context_window, 500000);
  assert.equal(manual.context_window_source, 'manual');
  assert.equal(manual.max_output_tokens, 64000);
  assert.equal(manual.max_output_tokens_source, 'upstream');
  assert.equal(manual.builtin_source_url, undefined);
  assert.deepEqual(resolveModelLimits('mystery-model', {}), { context_window: null, context_window_source: null, max_output_tokens: null, max_output_tokens_source: null });
});

test('summarizeRouteLimits uses the primary target and a conservative minimum', () => {
  const summary = summarizeRouteLimits([
    { context_window: 1048576, max_output_tokens: 131072, context_window_source: 'builtin' },
    { context_window: 200000, max_output_tokens: 32000, context_window_source: 'pool' },
  ]);
  assert.deepEqual(summary, { context_window: 1048576, max_output_tokens: 131072, context_window_source: 'builtin', context_window_min: 200000, max_output_tokens_min: 32000 });
  const unknown = summarizeRouteLimits([{ context_window: 1048576, max_output_tokens: 131072 }, { context_window: null, max_output_tokens: null }]);
  assert.equal(unknown.context_window, 1048576);
  assert.equal(unknown.context_window_min, null, 'an unknown fallback makes the minimum unknown');
  assert.deepEqual(summarizeRouteLimits([]), { context_window: null, max_output_tokens: null, context_window_source: null, context_window_min: null, max_output_tokens_min: null });
});

test('store caches upstream limits, keeps them on failure, persists 0600 and honours the refresh interval', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-limits-'));
  const cacheFile = path.join(dir, 'config.json.model-limits-cache.json');
  let clock = 1000;
  let calls = 0;
  let fail = false;
  const config = { id: 'cfg-1', enabled: true, models: [{ id: 'glm-5.3' }, { id: 'manual-model', context_window: 64000 }] };
  const options = {
    now: () => clock, refreshMs: 10000, retryMs: 5000, cacheFile,
    getParsedConfig: () => ({ configs: [config] }),
    fetchCatalog: async () => { calls++; if (fail) throw new Error('HTTP 503'); return [{ id: 'glm-5.3', context_window: 1000000, max_output_tokens: 131072 }, { id: 'no-limits' }]; },
  };
  const store = createModelLimitsStore(options);
  await store.tick();
  assert.equal(calls, 1);
  assert.equal(store.resolve(config, 'glm-5.3').context_window, 1000000);
  assert.equal(store.resolve(config, 'glm-5.3').context_window_source, 'upstream');
  assert.equal(store.resolve(config, 'manual-model').context_window_source, 'manual');
  assert.equal(store.status('cfg-1').model_count, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);

  await store.tick();
  assert.equal(calls, 1, 'not due yet');
  clock += 10000;
  fail = true;
  await store.tick();
  assert.equal(calls, 2);
  assert.equal(store.status('cfg-1').error, 'HTTP 503');
  assert.equal(store.resolve(config, 'glm-5.3').context_window, 1000000, 'previous values survive a failed refresh');
  clock += 1000;
  await store.tick();
  assert.equal(calls, 2, 'retry waits retryMs');
  clock += 5000;
  fail = false;
  await store.tick();
  assert.equal(calls, 3);
  assert.equal(store.status('cfg-1').error, null);

  // A new process reads the cache before its first fetch.
  const reloaded = createModelLimitsStore({ ...options, fetchCatalog: undefined });
  assert.equal(reloaded.resolve(config, 'glm-5.3').context_window, 1000000);
  assert.equal(reloaded.resolve({ ...config, id: 'other' }, 'glm-5.3').context_window_source, 'builtin');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('store skips ineligible and disabled configs and forgets removed ones', async () => {
  let configs = [{ id: 'a', enabled: true }, { id: 'b', enabled: false }, { id: 'pool', enabled: true, pool: true }];
  const seen = [];
  const store = createModelLimitsStore({
    getParsedConfig: () => ({ configs }), isEligible: config => !config.pool,
    fetchCatalog: async config => { seen.push(config.id); return [{ id: 'm', context_window: 1 }]; },
  });
  await store.tick();
  assert.deepEqual(seen, ['a']);
  configs = [];
  store.forgetMissing();
  assert.equal(store.status('a'), null);
});
