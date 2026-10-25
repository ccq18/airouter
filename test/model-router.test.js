const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createModelRouter,
  createRoutingHealthStore,
  createRoutingContextStore,
  detectRequestCapabilities,
} = require('../app/model-router');

function createParsed() {
  return {
    configs: [
      {
        id: 'cfg-token',
        type: 'token',
        preset: 'chatgpt',
        models: [{ id: 'gpt-backend', protocols: ['responses'] }],
      },
      {
        id: 'cfg-glm',
        type: 'apikey',
        preset: 'glm-cn',
        base_url: 'https://glm.example.com/api/coding/paas/v4',
        apikey: 'sk-example',
        models: [{ id: 'glm-5.3', protocols: ['chat_completions'] }],
      },
      {
        id: 'cfg-go',
        type: 'apikey',
        preset: 'opencode-go',
        base_url: 'https://go.example.com/inference/go',
        apikey: 'sk-example-2',
        models: [{ id: 'go-chat', protocols: ['chat_completions'], capabilities: { images: false } }],
      },
      {
        id: 'cfg-messages',
        type: 'apikey',
        preset: 'openrouter',
        base_url: 'https://openrouter.example.com/api/v1',
        apikey: 'sk-example-3',
        models: [{ id: 'claude/native', protocols: ['messages'] }],
      },
    ],
    routing: {
      mode: 'explicit',
      models: [{
        id: 'public-model',
        entry_protocols: ['chat_completions', 'responses', 'messages'],
        targets: [
          { id: 't-glm', config_id: 'cfg-glm', model: 'glm-5.3', protocol: 'chat_completions' },
          { id: 't-token', config_id: 'cfg-token', model: 'gpt-backend', protocol: 'responses' },
          { id: 't-go', config_id: 'cfg-go', model: 'go-chat', protocol: 'chat_completions' },
          { id: 't-messages', config_id: 'cfg-messages', model: 'claude/native', protocol: 'messages' },
        ],
      }],
    },
  };
}

function createRuntimeConfigs(parsed) {
  return parsed.configs.map((config, index) => {
    if (config.type === 'token') {
      return {
        ...config,
        index,
        enabled: true,
        baseUrl: 'https://chatgpt.com',
        apiBasePath: '/backend-api/codex',
        access_token: 'token-1',
        account_id: 'account-1',
      };
    }

    return {
      ...config,
      index,
      enabled: true,
      baseUrl: config.base_url,
      apiKey: config.apikey,
    };
  });
}

function createEngine(overrides = {}) {
  const states = new Map();
  const idOf = configOrId => typeof configOrId === 'string' ? configOrId : configOrId.id;
  return {
    getDecision(configOrId) {
      return states.get(idOf(configOrId)) || { allowed: true, state: 'available', probe: false };
    },
    isExhausted(configOrId) {
      return this.getDecision(configOrId).state === 'exhausted';
    },
    acquireProbe() {
      return () => {};
    },
    markExhausted(configOrId, details) {
      states.set(idOf(configOrId), { allowed: false, state: 'exhausted', reason: details.reason, probe: false });
    },
    recordProbeSuccess(configOrId) {
      states.set(idOf(configOrId), { allowed: true, state: 'available', probe: false });
    },
    serialize(configOrId) {
      return { config_id: idOf(configOrId), state: this.getDecision(configOrId).state };
    },
    states,
    ...overrides,
  };
}

function createRouter(overrides = {}) {
  const parsed = overrides.parsed || createParsed();
  const runtimeConfigs = overrides.runtimeConfigs || createRuntimeConfigs(parsed);
  const quotaEngine = overrides.quotaEngine || createEngine();
  const healthStore = overrides.healthStore || createRoutingHealthStore({ now: () => 1000000 });
  const now = overrides.now || (() => 1000000);
  return createModelRouter({
    getParsedConfig: () => parsed,
    getRuntimeConfigs: () => runtimeConfigs,
    quotaEngine,
    healthStore,
    now,
    ...overrides,
  });
}

function select(router, options = {}) {
  return router.select('public-model', 'chat_completions', {
    capabilities: detectRequestCapabilities('chat_completions', {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
    ...options,
  });
}

test('explicit routing always uses the first available target, not token priority', () => {
  const router = createRouter();
  const first = select(router);
  assert.equal(first.lease.target.config_id, 'cfg-glm');
  first.lease.release();

  const second = select(router);
  assert.equal(second.lease.target.config_id, 'cfg-glm');
  second.lease.release();
});

test('reordering targets makes an apikey or token take priority equally', () => {
  const parsed = createParsed();
  parsed.routing.models[0].targets = [
    parsed.routing.models[0].targets[1],
    parsed.routing.models[0].targets[0],
  ];
  const router = createRouter({
    parsed,
    runtimeConfigs: createRuntimeConfigs(parsed),
  });

  const selection = select(router);
  assert.equal(selection.lease.target.config_id, 'cfg-token');
  assert.equal(selection.lease.target.protocol, 'responses');
  selection.lease.release();
});

test('exhausted quota skips the higher-priority target; recovery prefers it again', () => {
  const quotaEngine = createEngine();
  const parsed = createParsed();
  const router = createRouter({
    parsed,
    runtimeConfigs: createRuntimeConfigs(parsed),
    quotaEngine,
  });

  quotaEngine.states.set('cfg-glm', {
    allowed: false,
    state: 'exhausted',
    reason: 'quota_exhausted',
    probe: false,
  });

  let selection = select(router);
  assert.equal(selection.lease.target.config_id, 'cfg-token');
  selection.lease.release();

  quotaEngine.states.delete('cfg-glm');
  selection = select(router);
  assert.equal(selection.lease.target.config_id, 'cfg-glm');
  selection.lease.release();
});

test('unknown quota is allowed but only one probe per account runs concurrently', () => {
  let releaseProbe = null;
  let acquired = 0;
  const quotaEngine = createEngine({
    getDecision(configOrId) {
      const id = typeof configOrId === 'string' ? configOrId : configOrId.id;
      if (id === 'cfg-glm') {
        return { allowed: true, state: 'unknown', probe: true, reason: 'quota_unknown' };
      }
      return { allowed: true, state: 'available', probe: false };
    },
    acquireProbe() {
      if (releaseProbe) {
        return null;
      }
      acquired += 1;
      releaseProbe = () => {
        releaseProbe = null;
      };
      return releaseProbe;
    },
  });
  const parsed = createParsed();
  const router = createRouter({
    parsed,
    runtimeConfigs: createRuntimeConfigs(parsed),
    quotaEngine,
  });

  const first = select(router);
  assert.equal(first.lease.target.config_id, 'cfg-glm');
  assert.equal(first.lease.probe, true);

  const second = select(router);
  assert.equal(second.lease.target.config_id, 'cfg-token');
  assert.equal(acquired, 1);

  first.lease.release();
  const third = select(router);
  assert.equal(third.lease.target.config_id, 'cfg-glm');
  third.lease.release();
});

test('auth health and cooldowns are separate from quota exhaustion', () => {
  let now = 1000000;
  const quotaEngine = createEngine();
  const healthStore = createRoutingHealthStore({ now: () => now, baseCooldownMs: 1000 });
  const parsed = createParsed();
  const router = createRouter({
    parsed,
    runtimeConfigs: createRuntimeConfigs(parsed),
    quotaEngine,
    healthStore,
    now: () => now,
  });

  const lease = select(router).lease;
  router.markFailure(lease, { statusCode: 401 });
  lease.release();

  assert.equal(quotaEngine.isExhausted('cfg-glm'), false);
  assert.equal(healthStore.getConfigState('cfg-glm').status, 'auth_failed');

  let selection = select(router);
  assert.equal(selection.lease.target.config_id, 'cfg-token');
  selection.lease.release();

  now += 5 * 60 * 1000 + 1;
  selection = select(router);
  assert.equal(selection.lease.target.config_id, 'cfg-glm');
  selection.lease.release();
});

test('bounded attempts and explicit target exclusion avoid reusing a failed candidate', () => {
  const router = createRouter();
  const first = select(router);
  assert.equal(first.lease.target.id, 't-glm');
  first.lease.release();

  const second = select(router, { excludeTargetIds: ['t-glm'] });
  assert.equal(second.lease.target.id, 't-token');
  second.lease.release();

  assert.equal(router.getMaxAttempts(router.resolve('public-model')), 3);
});

test('capability-incompatible targets are skipped with clear reasons', () => {
  const parsed = createParsed();
  // Put an image-incompatible target first; an image request must skip it.
  parsed.routing.models[0].targets = [
    { id: 't-go', config_id: 'cfg-go', model: 'go-chat', protocol: 'chat_completions' },
    { id: 't-glm', config_id: 'cfg-glm', model: 'glm-5.3', protocol: 'chat_completions' },
  ];
  const router = createRouter({ parsed, runtimeConfigs: createRuntimeConfigs(parsed) });
  const selection = router.select('public-model', 'chat_completions', {
    capabilities: detectRequestCapabilities('chat_completions', {
      model: 'public-model',
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      }],
    }),
  });

  assert.equal(selection.lease.target.config_id, 'cfg-glm');
  assert.equal(selection.skipped[0].reason, 'capability_images_unsupported');
  selection.lease.release();
});

test('structured output is never silently dropped by a cross-protocol bridge', () => {
  const router = createRouter();
  const selection = router.select('public-model', 'chat_completions', {
    capabilities: detectRequestCapabilities('chat_completions', {
      model: 'public-model',
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { type: 'object' } } },
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  // GLM chat target is same-protocol so it is eligible.
  assert.equal(selection.lease.target.config_id, 'cfg-glm');
  selection.lease.release();

  const parsed = createParsed();
  parsed.routing.models[0].targets = [
    { id: 't-token', config_id: 'cfg-token', model: 'gpt-backend', protocol: 'responses' },
  ];
  const router2 = createRouter({ parsed, runtimeConfigs: createRuntimeConfigs(parsed) });
  const result = router2.select('public-model', 'chat_completions', {
    capabilities: detectRequestCapabilities('chat_completions', {
      model: 'public-model',
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  assert.equal(result.lease, null);
  assert.equal(result.skipped[0].reason, 'capability_structured_output_requires_same_protocol');
});

test('reasoning/thinking state is never silently dropped by a cross-protocol bridge', () => {
  const parsed = createParsed();
  parsed.routing.models[0].targets = [
    { id: 't-token', config_id: 'cfg-token', model: 'gpt-backend', protocol: 'responses' },
  ];
  const router = createRouter({ parsed, runtimeConfigs: createRuntimeConfigs(parsed) });
  const result = router.select('public-model', 'chat_completions', {
    capabilities: detectRequestCapabilities('chat_completions', {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    }),
  });

  assert.equal(result.lease, null);
  assert.equal(result.skipped[0].reason, 'capability_reasoning_requires_same_protocol');
});

test('targets with empty token credentials are unavailable and never routed', () => {
  const parsed = createParsed();
  parsed.routing.models[0].targets = [
    { id: 't-token', config_id: 'cfg-token', model: 'gpt-backend', protocol: 'responses' },
  ];
  const runtimeConfigs = createRuntimeConfigs(parsed);
  const tokenRuntime = runtimeConfigs.find(config => config.id === 'cfg-token');
  tokenRuntime.access_token = '';
  tokenRuntime.account_id = '';
  const router = createRouter({ parsed, runtimeConfigs });
  const result = router.select('public-model', 'chat_completions', {
    capabilities: detectRequestCapabilities('chat_completions', {
      model: 'public-model',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  assert.equal(result.lease, null);
  assert.equal(result.skipped[0].reason, 'credentials_missing');
});

test('unknown public model and disabled routes do not fall through to random accounts', () => {
  const router = createRouter();
  assert.equal(router.resolve('Public-Model'), null);
  assert.equal(router.resolve('missing'), null);

  const parsed = createParsed();
  parsed.routing.models[0].enabled = false;
  const disabledRouter = createRouter({ parsed, runtimeConfigs: createRuntimeConfigs(parsed) });
  assert.equal(disabledRouter.resolve('public-model'), null);
});

test('unavailable account health is shown with skip reasons for the admin UI', () => {
  let now = 1000000;
  const healthStore = createRoutingHealthStore({ now: () => now, baseCooldownMs: 1000 });
  healthStore.markCooldown('cfg-glm', { reason: 'upstream_5xx', targetKey: 'glm-5.3\u0000chat_completions' });
  const router = createRouter({ healthStore });
  const route = router.resolve('public-model');
  const status = router.describeRoute(route, 'chat_completions');

  assert.equal(status.targets[0].available, false);
  assert.equal(status.targets[0].reason, 'health_cooldown');
  assert.equal(status.targets[0].selected, false);
});

test('failure classification keeps client rejections healthy and treats in-flight budget as transient', () => {
  let now = 1000000;
  const quotaEngine = createEngine();
  const healthStore = createRoutingHealthStore({ now: () => now, baseCooldownMs: 1000 });
  const parsed = createParsed();
  const router = createRouter({ parsed, runtimeConfigs: createRuntimeConfigs(parsed), quotaEngine, healthStore, now: () => now });

  let lease = select(router).lease;
  router.markFailure(lease, { statusCode: 400, errorCode: 'invalid_request_error', message: 'bad arguments' });
  lease.release();
  assert.equal(quotaEngine.isExhausted('cfg-glm'), false);
  assert.equal(healthStore.getConfigState('cfg-glm').status, 'ok');
  assert.equal(healthStore.getTargetState('cfg-glm', 'glm-5.3\u0000chat_completions').status, 'ok');

  lease = select(router).lease;
  router.markFailure(lease, {
    statusCode: 402,
    errorCode: 'budget_exceeded',
    message: 'in-flight budget exceeded',
    metadata: { limit_source: 'openrouter_in_flight_budget' },
  });
  lease.release();
  assert.equal(quotaEngine.isExhausted('cfg-glm'), false);
  assert.equal(healthStore.getTargetState('cfg-glm', 'glm-5.3\u0000chat_completions').status, 'cooldown');

  healthStore.markSuccess('cfg-glm', { targetKey: 'glm-5.3\u0000chat_completions' });
  lease = select(router).lease;
  assert.equal(lease.target.config_id, 'cfg-glm');
  router.markFailure(lease, { statusCode: 402, errorCode: 'insufficient_quota', message: 'quota exhausted' });
  lease.release();
  assert.equal(quotaEngine.isExhausted('cfg-glm'), true);
});

test('routing context bindings are opaque, expiring and cannot be guessed after restart', () => {
  let now = 1000000;
  const store = createRoutingContextStore({ now: () => now, ttlMs: 1000 });
  store.bind('resp_123', {
    config_id: 'cfg-glm',
    target_id: 't-glm',
    model: 'glm-5.3',
    protocol: 'chat_completions',
    public_model: 'public-model',
  });

  assert.equal(store.resolve('resp_123').config_id, 'cfg-glm');
  assert.equal(store.resolve('resp_missing'), null);

  now += 1001;
  assert.equal(store.resolve('resp_123'), null);
  assert.equal(createRoutingContextStore({ now: () => now }).resolve('resp_123'), null);
});


test('account identity replacement invalidates private response bindings', () => {
  const contexts = createRoutingContextStore();
  contexts.bind('resp-fixture', { config_id: 'old-account', target_id: 'target', model: 'model', protocol: 'responses', public_model: 'public', auth_hash: 'caller' });
  contexts.forgetConfig('old-account');
  assert.equal(contexts.resolve('resp-fixture', 'caller'), null);
});
