const test = require('node:test');
const assert = require('node:assert/strict');

const { createQuotaEngine } = require('../app/quota-engine');

function createGlmConfig(id = 'cfg-a') {
  return {
    id,
    preset: 'glm-cn',
    type: 'apikey',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'sk-example-secret',
  };
}

function glmPayload(percentage) {
  return {
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TIME_LIMIT', percentage: 100 },
        { type: 'TOKENS_LIMIT', percentage, nextResetTime: 2000000000000 },
      ],
    },
  };
}

function createEngine(options = {}) {
  return createQuotaEngine({
    now: () => 1000000,
    ttlMs: 60_000,
    timeoutMs: 1000,
    requestBufferedFn: async () => ({
      statusCode: 200,
      body: glmPayload(50),
    }),
    log: () => {},
    warn: () => {},
    ...options,
  });
}

test('quota starts unknown and unknown is not exhausted', () => {
  const engine = createEngine();
  const config = createGlmConfig();

  assert.equal(engine.getSnapshot('cfg-a'), null);
  assert.deepEqual(engine.getDecision(config), {
    allowed: true,
    state: 'unknown',
    reason: 'quota_unknown',
    probe: true,
  });
  assert.equal(engine.isExhausted(config), false);
});

test('quota refresh normalizes provider payloads and caches fresh results', async () => {
  let calls = 0;
  const engine = createEngine({
    requestBufferedFn: async () => {
      calls += 1;
      return { statusCode: 200, body: glmPayload(25) };
    },
  });
  const config = createGlmConfig();

  const snapshot = await engine.refresh(config);
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.metrics[0].remainingPercent, 75);
  assert.equal(calls, 1);

  await engine.refresh(config);
  assert.equal(calls, 1);

  await engine.refresh(config, { force: true });
  assert.equal(calls, 2);
});

test('known exhausted survives fetch failure instead of pretending recovery', async () => {
  const engine = createEngine();
  const config = createGlmConfig();

  engine.markExhausted(config, { reason: 'upstream_quota_exhausted' });
  assert.equal(engine.isExhausted(config), true);

  engine.setRequestBufferedFnForTests(async () => {
    throw new Error('network down');
  });
  const snapshot = await engine.refresh(config, { force: true });

  assert.equal(snapshot.state, 'exhausted');
  assert.match(snapshot.error, /network down/);
  assert.equal(engine.getDecision(config).allowed, false);
});

test('refresh failure after available evidence becomes unknown, never exhausted', async () => {
  const engine = createEngine();
  const config = createGlmConfig();
  await engine.refresh(config, { force: true });

  engine.setRequestBufferedFnForTests(async () => {
    throw new Error('timeout');
  });
  const snapshot = await engine.refresh(config, { force: true });

  assert.equal(snapshot.state, 'unknown');
  assert.equal(engine.isExhausted(config), false);
  assert.match(snapshot.error, /timeout/);
});

test('malformed or forbidden quota responses stay unknown and do not fabricate zero', async () => {
  let statusCode = 403;
  let body = { error: { message: 'forbidden' } };
  const engine = createEngine({
    requestBufferedFn: async () => ({ statusCode, body }),
  });
  const config = createGlmConfig();

  let snapshot = await engine.refresh(config, { force: true });
  assert.equal(snapshot.state, 'unknown');
  assert.match(snapshot.error, /HTTP 403/);
  assert.equal(snapshot.metrics.length, 0);

  statusCode = 200;
  body = { code: 200, success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 'oops' }] } };
  snapshot = await engine.refresh(config, { force: true });
  assert.equal(snapshot.state, 'unknown');
  assert.equal(snapshot.metrics[0].remainingPercent, null);

  statusCode = 200;
  body = 'not json';
  snapshot = await engine.refresh(config, { force: true });
  assert.equal(snapshot.state, 'unknown');
});

test('unsupported quota providers stay unknown without sending a request', async () => {
  let calls = 0;
  const engine = createEngine({
    requestBufferedFn: async () => {
      calls += 1;
      return { statusCode: 200, body: {} };
    },
  });
  const config = {
    id: 'cfg-zen',
    preset: 'opencode-zen',
    type: 'apikey',
    base_url: 'https://opencode.ai/inference',
    apikey: 'sk-example',
  };

  const snapshot = await engine.refresh(config);
  assert.equal(snapshot.state, 'unknown');
  assert.match(snapshot.error, /尚未核实/);
  assert.equal(calls, 0);
});

test('reset time triggers a refresh even when the cached snapshot is otherwise fresh', async () => {
  let currentNow = 1760000000000;
  let calls = 0;
  const engine = createEngine({
    now: () => currentNow,
    requestBufferedFn: async () => {
      calls += 1;
      return {
        statusCode: 200,
        body: {
          code: 200,
          success: true,
          data: {
            limits: [{ type: 'TOKENS_LIMIT', percentage: calls === 1 ? 100 : 20, nextResetTime: 1760000001000 }],
          },
        },
      };
    },
  });
  const config = createGlmConfig();

  let snapshot = await engine.refresh(config, { force: true });
  assert.equal(snapshot.state, 'exhausted');

  currentNow = 1760000002000;
  snapshot = await engine.ensureFresh(config);
  assert.equal(calls, 2);
  assert.equal(snapshot.state, 'available');
});

test('probe locks allow only one unknown-quota recovery probe per account', () => {
  const engine = createEngine();
  const config = createGlmConfig();

  const release = engine.acquireProbe(config);
  assert.equal(typeof release, 'function');
  assert.equal(engine.acquireProbe(config), null);
  release();
  const second = engine.acquireProbe(config);
  assert.equal(typeof second, 'function');
  second();
});

test('serialized quota snapshots never include credentials or raw bodies', async () => {
  const engine = createEngine();
  const config = createGlmConfig();
  await engine.refresh(config, { force: true });

  const serialized = JSON.stringify(engine.serialize(config));
  assert.doesNotMatch(serialized, /sk-example-secret/);
  assert.doesNotMatch(serialized, /limits/);
  assert.match(serialized, /available/);
});

test('marking a quota probe success recovers an exhausted candidate', () => {
  const engine = createEngine();
  const config = createGlmConfig();
  engine.markExhausted(config, { reason: 'upstream_quota_exhausted' });

  engine.recordProbeSuccess(config);
  assert.equal(engine.isExhausted(config), false);
  assert.equal(engine.getDecision(config).allowed, true);
});


test('credential replacement discards old exhausted state and late old queries', async () => {
  let finishOld;
  const oldConfig = createGlmConfig();
  const replacement = { ...oldConfig, apikey: 'sk-replacement-fixture' };
  const engine = createEngine({ requestBufferedFn: ({ headers }) => headers.authorization === oldConfig.apikey
    ? new Promise(resolve => { finishOld = resolve; })
    : Promise.resolve({ statusCode: 200, body: glmPayload(10) }) });
  const pending = engine.refresh(oldConfig);
  engine.syncConfigs([replacement]);
  assert.equal(engine.getDecision(replacement).state, 'unknown');
  await engine.refresh(replacement);
  finishOld({ statusCode: 200, body: glmPayload(100) });
  await pending;
  assert.equal(engine.getSnapshot(replacement).state, 'available');
  assert.equal(engine.getSnapshot(replacement).metrics[0].remainingPercent, 90);
});

test('OpenRouter combines account credits and key limits using the same credential', async () => {
  let credits = 5;
  let creditsStatus = 200;
  let keyRemaining = null;
  const seen = [];
  const config = { id: 'or-fixture', preset: 'openrouter', type: 'apikey', apikey: 'sk-fixture' };
  const engine = createEngine({ requestBufferedFn: async request => {
    seen.push(request);
    if (request.targetUrl.endsWith('/credits')) return { statusCode: creditsStatus, body: { data: { total_credits: 10, total_usage: 10 - credits } } };
    return { statusCode: 200, body: { data: { limit: keyRemaining === null ? null : 10, limit_remaining: keyRemaining, usage: 0, budgets: [] } } };
  }});
  let snapshot = await engine.refresh(config, { force: true });
  assert.equal(snapshot.state, 'available');
  assert.equal(snapshot.metrics.find(m => m.id === 'credits:account_balance').remaining, 5);
  assert.ok(seen.every(request => request.headers.authorization === 'Bearer sk-fixture'));
  credits = 0;
  assert.equal((await engine.refresh(config, { force: true })).state, 'exhausted');
  creditsStatus = 403; keyRemaining = 10;
  assert.equal((await engine.refresh(config, { force: true })).state, 'exhausted');
  creditsStatus = 200; credits = 5;
  assert.equal((await engine.refresh(config, { force: true })).state, 'available');
  keyRemaining = 0;
  assert.equal((await engine.refresh(config, { force: true })).state, 'exhausted');
  const fresh = createEngine({ requestBufferedFn: async request => request.targetUrl.endsWith('/credits')
    ? { statusCode: 403, body: {} } : { statusCode: 200, body: { data: { limit: 10, limit_remaining: 5 } } } });
  assert.equal((await fresh.refresh(config)).state, 'available');
});


test('repeated partial OpenRouter reads cannot erase business exhaustion', async () => {
  const config = { id: 'or-fixture', preset: 'openrouter', type: 'apikey', apikey: 'sk-fixture' };
  const engine = createEngine({ requestBufferedFn: async request => request.targetUrl.endsWith('/credits')
    ? { statusCode: 403, body: {} } : { statusCode: 200, body: { data: { limit: 10, limit_remaining: 5 } } } });
  engine.markExhausted(config);
  for (let i = 0; i < 3; i++) assert.equal((await engine.refresh(config, { force: true })).state, 'exhausted');
});

test('unsupported quota cannot clear exhaustion and allows one delayed recovery probe', async () => {
  let timestamp = 1000000;
  const engine = createEngine({ now: () => timestamp });
  const config = { id: 'zen', preset: 'opencode-zen', type: 'apikey', apikey: 'sk-fixture' };
  engine.markExhausted(config);
  assert.equal((await engine.refresh(config, { force: true })).state, 'exhausted');
  assert.equal(engine.getDecision(config).allowed, false);
  timestamp += 300001;
  assert.equal(engine.getDecision(config).probe, true);
  const release = engine.acquireProbe(config);
  assert.equal(engine.acquireProbe(config), null);
  engine.recordProbeSuccess(config);
  release();
  assert.equal(engine.getDecision(config).state, 'available');
});


test('stale readers and queued monitor work never roll a replaced credential back', async () => {
  const oldConfig = createGlmConfig();
  const current = { ...oldConfig, apikey: 'new-fixture-key' };
  let calls = 0;
  const engine = createEngine({ requestBufferedFn: async () => { calls++; return { statusCode: 200, body: glmPayload(5) }; } });
  engine.syncConfigs([oldConfig]);
  await engine.refresh(oldConfig);
  engine.syncConfigs([current]);
  await engine.refresh(current);
  engine.serialize(oldConfig);
  await engine.refresh(oldConfig, { force: true });
  await engine.ensureFresh(oldConfig, { force: true });
  assert.equal(calls, 2);
  assert.equal(engine.getSnapshot(current).state, 'available');
  assert.equal(engine.getSnapshot(current).metrics[0].remainingPercent, 95);
});
