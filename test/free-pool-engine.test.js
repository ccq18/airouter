const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createFreePoolEngine, isFreePricing, normalizeOpenRouterCatalog, normalizeOpenCodeCatalog, matchesCapabilities } = require('../app/free-pool-engine');

function routerModel(id, patch = {}) {
  return { id, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'], context_length: 32000, top_provider: { max_completion_tokens: 8192 }, ...patch };
}
function codeModel(id, patch = {}) {
  return { id, cost: { input: 0, output: 0, cache_read: 0 }, modalities: { input: ['text'], output: ['text'] }, provider: { api: 'https://opencode.ai/inference/go/openai/v1' }, tool_call: true, limit: { context: 32000, output: 8192 }, ...patch };
}
function harness(options = {}) {
  let time = 1000000;
  const pool = { id: 'pool', type: 'apikey', preset: 'openrouter-free', credential_ref: 'source', pool: { sync_interval_seconds: 60, max_stale_seconds: 120, max_attempts: 8 }, ...options.pool };
  let parsed = { configs: [{ id: 'source', type: 'apikey', preset: 'openrouter', apikey: 'fake-private-key' }, pool] };
  let catalog = { data: [routerModel('a'), routerModel('b')] };
  const requests = [];
  let fail = false;
  let blocker = null;
  const engine = createFreePoolEngine({
    getParsedConfig: () => parsed, now: () => time, cacheFile: options.cacheFile,
    monitorIntervalMs: 10,
    requestBufferedFn: async request => {
      requests.push(request);
      if (blocker) await blocker;
      if (fail) throw new Error('catalog down fake-private-key');
      return { statusCode: 200, bodyText: JSON.stringify(catalog) };
    }, ...options.engine,
  });
  return { engine, pool, requests, setCatalog: value => { catalog = value; }, setFail: value => { fail = value; }, setBlock: value => { blocker = value; }, setParsed: value => { parsed = value; }, getParsed: () => parsed, advance: ms => { time += ms; } };
}

test('free eligibility requires explicit zero prices in every supplied price dimension', () => {
  assert.equal(isFreePricing({ prompt: '0', completion: 0 }), true);
  assert.equal(isFreePricing({ prompt: 0, completion: '0', request: '0', nested: { image: '0' } }), true);
  for (const pricing of [null, {}, { prompt: 0 }, { prompt: null, completion: 0 }, { prompt: '', completion: 0 }, { prompt: false, completion: 0 }, { prompt: 0, completion: -1 }, { prompt: 0, completion: 0, image: '0.1' }, { prompt: 0, completion: 0, unknown: [] }, { prompt: 0, completion: 0, future: 'free' }]) assert.equal(isFreePricing(pricing), false, JSON.stringify(pricing));
});

test('OpenRouter excludes charged, ambiguous, retired and random-router models while keeping concrete zero-priced models', () => {
  const models = normalizeOpenRouterCatalog({ data: [
    routerModel('concrete-zero'), routerModel('paid-free-name', { pricing: { prompt: '0', completion: '1' } }),
    routerModel('unknown-free', { pricing: { prompt: '0' } }), routerModel('retired', { status: 'deprecated' }),
    routerModel('expired', { expiration_date: '1970-01-01' }), routerModel('openrouter/free'), routerModel('openrouter/auto'),
    routerModel('image-only', { architecture: { input_modalities: ['image'], output_modalities: ['image'] } }),
    routerModel('zero-token-music', { architecture: { input_modalities: ['text'], output_modalities: ['text', 'audio'] } }),
    routerModel('unknown-output', { top_provider: {} }),
    routerModel('classifier-a', { description: 'A model fine-tuned for content safety classification.' }),
    routerModel('classifier-b', { description: 'This is a safety reasoning model for safety tasks like content classification.' }),
    routerModel('classifier-c', { description: 'This is a compact 4B-parameter multimodal guardrail model for input and output moderation.' }),
  ] }, 10000);
  assert.deepEqual(models.map(model => model.id), ['concrete-zero']);
  assert.equal(models[0].free_evidence.kind, 'explicit_zero_pricing');
  assert.equal(models[0].capabilities.tools, true);
});

test('OpenCode intersects live account directory with explicit metadata costs and verified chat endpoint', () => {
  const catalog = { data: ['good', 'paid-free', 'missing', 'retired', 'wrong-protocol'].map(id => ({ id })) };
  const metadata = { 'opencode-go': { models: {
    good: codeModel('good'), 'paid-free': codeModel('paid-free', { cost: { input: 0.1, output: 0 } }),
    retired: codeModel('retired', { status: 'deprecated' }), 'wrong-protocol': codeModel('wrong-protocol', { provider: { api: 'https://opencode.ai/anthropic' } }),
    'not-in-live-catalog': codeModel('not-in-live-catalog'),
  } } };
  const models = normalizeOpenCodeCatalog(catalog, metadata, 'opencode-go', 1);
  assert.deepEqual(models.map(model => model.id), ['good']);
  assert.throws(() => normalizeOpenCodeCatalog(catalog, {}, 'opencode-go'), /元数据不可用/);
});

test('sync automatically adds and removes members and never persists or exposes credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-pool-'));
  try {
    const cacheFile = path.join(dir, 'pool-cache.json');
    const h = harness({ cacheFile });
    await h.engine.refresh('pool');
    assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['a', 'b']);
    assert.equal(h.requests[0].targetUrl, 'https://openrouter.ai/api/v1/models/user');
    assert.equal(h.requests[0].headers.authorization, 'Bearer fake-private-key');
    h.setCatalog({ data: [routerModel('b'), routerModel('new')] });
    await h.engine.refresh('pool');
    assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['b', 'new']);
    const saved = fs.readFileSync(cacheFile, 'utf8');
    assert.doesNotMatch(saved, /fake-private-key/);
    assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
    const restored = harness({ cacheFile });
    assert.deepEqual(restored.engine.getCandidates(restored.pool).map(x => x.id), ['b', 'new']);
    assert.doesNotMatch(JSON.stringify(restored.engine.serialize(restored.pool)), /fake-private-key/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('failed sync retains previous valid catalog, reports sanitized error, and expires scheduling eligibility', async () => {
  const h = harness();
  await h.engine.refresh('pool');
  h.setFail(true);
  h.advance(61000);
  await h.engine.refresh('pool');
  const retained = h.engine.serialize(h.pool);
  assert.equal(retained.models.length, 2);
  assert.equal(retained.last_sync_at, 1000000);
  assert.equal(retained.last_attempt_at, 1061000);
  assert.match(retained.error, /catalog down/);
  assert.doesNotMatch(retained.error, /fake-private-key/);
  assert.equal(h.engine.getCandidates(h.pool).length, 2);
  h.advance(61000);
  assert.equal(h.engine.getCandidates(h.pool).length, 0);
  assert.equal(h.engine.serialize(h.pool).state, 'stale');
  assert.equal(h.engine.serialize(h.pool).models.length, 2);
});

test('a successful empty or now-paid directory immediately removes old candidates', async () => {
  const h = harness();
  await h.engine.refresh('pool');
  h.setCatalog({ data: [routerModel('a', { pricing: { prompt: '0.1', completion: '0' } })] });
  await h.engine.refresh('pool');
  assert.equal(h.engine.getCandidates(h.pool).length, 0);
  assert.equal(h.engine.serialize(h.pool).error, null);
});

test('capabilities and conservative context budget are checked before selection', () => {
  const [plain] = normalizeOpenRouterCatalog({ data: [routerModel('plain')] });
  assert.equal(matchesCapabilities(plain, { tools: true }, { messages: [{ role: 'user', content: 'short' }] }), true);
  for (const required of ['images', 'files', 'audio', 'reasoning', 'structuredOutput', 'builtinTools']) assert.equal(matchesCapabilities(plain, { [required]: true }, {}), false, required);
  assert.equal(matchesCapabilities(plain, {}, { max_tokens: 9000 }), false);
  assert.equal(matchesCapabilities(plain, {}, { messages: [{ role: 'user', content: '文'.repeat(11000) }] }), false);
  assert.equal(matchesCapabilities(plain, {}, { max_tokens: '1000' }), false);
});

test('explicit quality tiers precede recent latency and same-tier failures lower priority', async () => {
  const h = harness({ pool: { pool: { tiers: { b: 1 }, strategy: 'quality_first', max_attempts: 8, max_stale_seconds: 120 } } });
  await h.engine.refresh('pool');
  let candidates = h.engine.getCandidates(h.pool);
  assert.equal(candidates[0].id, 'b');
  h.engine.recordSuccess(h.pool, candidates.find(x => x.id === 'a'), 10);
  h.engine.recordSuccess(h.pool, candidates.find(x => x.id === 'b'), 1000);
  assert.equal(h.engine.getCandidates(h.pool)[0].id, 'b');
  h.pool.pool.tiers = {};
  candidates = h.engine.getCandidates(h.pool);
  assert.equal(candidates[0].id, 'a');
  assert.match(candidates[0].quality_source, /未评级/);
  h.engine.recordFailure(h.pool, candidates[0], { statusCode: 429, retryAfterMs: 100 });
  assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['b']);
  h.advance(101);
  assert.equal(h.engine.getCandidates(h.pool)[0].id, 'b');
  assert.equal(h.engine.getCandidates(h.pool).length, 2);
});

test('free model cooldowns and account authentication restrictions recover without paid-quota state', async () => {
  const h = harness();
  await h.engine.refresh('pool');
  const [a, b] = h.engine.getCandidates(h.pool);
  h.engine.recordFailure(h.pool, a, { statusCode: 402, retryAfterMs: 100 });
  assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['b']);
  h.advance(101);
  assert.equal(h.engine.getCandidates(h.pool).length, 2);
  h.engine.recordFailure(h.pool, b, { statusCode: 401, retryAfterMs: 100 });
  assert.equal(h.engine.getCandidates(h.pool).length, 0);
  h.advance(101);
  assert.equal(h.engine.getCandidates(h.pool).length, 2);
  const snapshot = h.engine.serialize(h.pool);
  assert.equal(snapshot.last_request.model, 'b');
  assert.equal(snapshot.last_request.status_code, 401);
});

test('credential changes invalidate caches and ignore late catalog or request results', async () => {
  const h = harness();
  await h.engine.refresh('pool');
  const [oldModel] = h.engine.getCandidates(h.pool);
  let unblock;
  h.setBlock(new Promise(resolve => { unblock = resolve; }));
  const pending = h.engine.refresh('pool');
  h.getParsed().configs[0].apikey = 'rotated-key';
  h.engine.syncConfigs();
  unblock();
  await pending;
  h.engine.recordSuccess(h.pool, oldModel, 1);
  assert.equal(h.engine.serialize(h.pool).last_sync_at, null);
  assert.equal(h.engine.serialize(h.pool).last_request, null);
  assert.equal(h.engine.getCandidates(h.pool).length, 0);
  h.setBlock(null);
  await h.engine.refresh('pool');
  assert.equal(h.engine.getCandidates(h.pool).length, 2);
  h.getParsed().configs[0].enabled = false;
  h.engine.syncConfigs();
  assert.equal(h.engine.getCandidates(h.pool).length, 0);
  assert.equal(h.engine.serialize(h.pool).state, 'disabled');
});

test('same-pool concurrent syncs coalesce and monitor periodically refreshes changed directories', async () => {
  const h = harness();
  let unblock;
  h.setBlock(new Promise(resolve => { unblock = resolve; }));
  const pending = [h.engine.refresh('pool'), h.engine.refresh('pool')];
  unblock(); await Promise.all(pending);
  assert.equal(h.requests.length, 1);
  h.setBlock(null);
  h.setCatalog({ data: [routerModel('next')] });
  h.advance(61000);
  h.engine.startMonitor();
  try {
    const deadline = Date.now() + 1000;
    while (h.engine.getCandidates(h.pool)[0]?.id !== 'next' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['next']);
  } finally { h.engine.stopMonitor(); }
});

test('OpenCode metadata requests never receive supplier credentials and Go/Zen use corresponding metadata', async () => {
  const seen = [];
  const h = harness({ pool: { preset: 'opencode-free' }, engine: {
    modelsDevUrl: 'https://metadata.invalid/api.json',
    requestBufferedFn: async request => {
      seen.push(request);
      const payload = request.targetUrl.includes('metadata.invalid') ? { 'opencode-go': { models: { valid: codeModel('valid') } } } : { data: [{ id: 'valid' }] };
      return { statusCode: 200, bodyText: JSON.stringify(payload) };
    },
  } });
  h.getParsed().configs[0].preset = 'opencode-go';
  await h.engine.refresh('pool');
  assert.equal(h.engine.getCandidates(h.pool).length, 1);
  assert.ok(seen.find(x => x.targetUrl.endsWith('/inference/go/v1/models')));
  assert.equal(seen.find(x => x.targetUrl.includes('metadata.invalid')).headers.authorization, undefined);
});


test('changing a reference from Go to Zen corrects a built-in default catalog URL', async () => {
  const requests = [];
  const h = harness({ pool: { preset: 'opencode-free', base_url: 'https://opencode.ai/inference/go' }, engine: {
    requestBufferedFn: async request => {
      requests.push(request);
      const payload = request.targetUrl === 'https://models.dev/api.json' ? { opencode: { models: { zen: codeModel('zen') } } } : { data: [{ id: 'zen' }] };
      return { statusCode: 200, bodyText: JSON.stringify(payload) };
    },
  } });
  h.getParsed().configs[0].preset = 'opencode-zen';
  await h.engine.refresh('pool');
  assert.ok(requests.find(x => x.targetUrl === 'https://opencode.ai/inference/v1/models'));
  assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['zen']);
  assert.match(h.engine.serialize(h.pool).restrictions, /不伪装/);
});


test('generic chat models mentioning safety are not mistaken for dedicated classifiers', () => {
  const models = normalizeOpenRouterCatalog({ data: [routerModel('chat', { description: 'A general chat model with safety improvements and reliable instruction following.' })] });
  assert.deepEqual(models.map(x => x.id), ['chat']);
});


test('explicit account-wide free limits stop the entire pool while ordinary model limits remain local', async () => {
  const h = harness();
  await h.engine.refresh('pool');
  let [a, b] = h.engine.getCandidates(h.pool);
  h.engine.recordFailure(h.pool, a, { statusCode: 429, message: 'daily free request limit exceeded', retryAfterMs: 100 });
  assert.equal(h.engine.getCandidates(h.pool).length, 0);
  assert.equal(h.engine.serialize(h.pool).account_health.reason, 'account_free_limit');
  h.engine.recordSuccess(h.pool, b, 10);
  assert.equal(h.engine.getCandidates(h.pool).length, 0, 'a concurrent prior request success cannot erase the explicit account-wide limit');
  h.advance(101);
  assert.equal(h.engine.getCandidates(h.pool).length, 2);
  [a] = h.engine.getCandidates(h.pool);
  h.engine.recordFailure(h.pool, a, { statusCode: 402, message: 'quota exhausted for this model', retryAfterMs: 100 });
  assert.equal(h.engine.getCandidates(h.pool).length, 1);
});


test('revoked model eligibility cannot revive from startup cache after pool disable and enable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-pool-revoked-'));
  try {
    const cacheFile = path.join(dir, 'cache.json');
    const initial = harness({ cacheFile });
    await initial.engine.refresh('pool');
    const restored = harness({ cacheFile });
    restored.setCatalog({ data: [routerModel('a', { pricing: { prompt: '1', completion: '1' } })] });
    await restored.engine.refresh('pool');
    assert.deepEqual(restored.engine.getCandidates(restored.pool), []);
    restored.pool.enabled = false;
    restored.engine.syncConfigs();
    restored.pool.enabled = true;
    restored.engine.syncConfigs();
    assert.deepEqual(restored.engine.getCandidates(restored.pool), []);
    assert.deepEqual(restored.engine.serialize(restored.pool).models, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('pool detail order follows scheduling strategy without hiding cooled or incompatible models', async () => {
  const h = harness({ pool: { pool: { tiers: { b: 1 }, strategy: 'quality_first', max_attempts: 1, max_stale_seconds: 120 } } });
  await h.engine.refresh('pool');
  let displayed = h.engine.serialize(h.pool).models;
  assert.deepEqual(displayed.map(x => x.id), ['b', 'a']);
  assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['b']);
  h.engine.recordSuccess(h.pool, displayed.find(x => x.id === 'a'), 10);
  h.engine.recordSuccess(h.pool, displayed.find(x => x.id === 'b'), 1000);
  assert.equal(h.engine.serialize(h.pool).models[0].id, 'b');
  h.pool.pool.strategy = 'fastest';
  displayed = h.engine.serialize(h.pool).models;
  assert.deepEqual(displayed.map(x => x.id), ['a', 'b']);
  assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['a']);
  h.engine.recordFailure(h.pool, displayed[0], { statusCode: 429, retryAfterMs: 100 });
  displayed = h.engine.serialize(h.pool).models;
  assert.equal(displayed.length, 2);
  assert.equal(displayed.find(x => x.id === 'a').status, 'cooldown');
  assert.deepEqual(h.engine.getCandidates(h.pool).map(x => x.id), ['b']);
  assert.deepEqual(h.engine.getCandidates(h.pool, { images: true }), []);
  assert.equal(h.engine.serialize(h.pool).models.length, 2);
});
