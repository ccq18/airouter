const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountManager } = require('../app/account-manager');

function createRuntime(overrides = {}) {
  return {
    enabled: true,
    available: true,
    lastCheckedAt: null,
    remainingPercent: null,
    primaryRemainingPercent: null,
    primaryResetAt: null,
    primaryResetAfterSeconds: null,
    secondaryRemainingPercent: null,
    secondaryResetAt: null,
    secondaryResetAfterSeconds: null,
    reason: 'unchecked',
    lastError: null,
    ...overrides,
  };
}

function createConfig(index, runtimeOverrides = {}, configOverrides = {}) {
  return {
    type: 'token',
    index,
    description: `account-${index + 1}`,
    baseUrl: 'https://chatgpt.com',
    apiBasePath: '/backend-api/codex',
    access_token: `token-${index}`,
    account_id: `account-${index}`,
    runtime: createRuntime(runtimeOverrides),
    ...configOverrides,
  };
}

function createBufferedRequestRecorder(bodies) {
  let currentIndex = 0;
  let callCount = 0;
  const calls = [];

  return {
    requestBuffered(requestOptions) {
      if (currentIndex >= bodies.length) {
        throw new Error(`unexpected buffered request call ${currentIndex + 1}`);
      }

      callCount += 1;
      calls.push(requestOptions);
      const payload = bodies[currentIndex];
      currentIndex += 1;

      return Promise.resolve({
        statusCode: 200,
        bodyText: JSON.stringify(payload),
      });
    },
    getCallCount() {
      return callCount;
    },
    getCalls() {
      return calls.slice();
    },
  };
}

function createManager(configs, overrides = {}) {
  const logs = [];
  const warnings = [];

  const manager = createAccountManager({
    configs,
    configType: 'token',
    initialActiveConfigIndex: overrides.initialActiveConfigIndex,
    quotaCheckPath: '/backend-api/wham/usage',
    quotaCheckTimeoutMs: overrides.quotaCheckTimeoutMs ?? 10 * 1000,
    apiKeyRecoveryTimeoutMs: overrides.apiKeyRecoveryTimeoutMs,
    tokenUnavailableCooldownMs: overrides.tokenUnavailableCooldownMs,
    quotaCheckIntervalMs: overrides.quotaCheckIntervalMs ?? 60 * 1000,
    allQuotaCheckIntervalMs: overrides.allQuotaCheckIntervalMs ?? 10 * 60 * 1000,
    allQuotaCheckDelayMs: overrides.allQuotaCheckDelayMs ?? 1000,
    minRemainingPercent: 3,
    buildAuthHeadersForConfig: config => ({
      ...(config.type === 'apikey'
        ? { authorization: `Bearer ${config.apiKey}` }
        : {
          authorization: `Bearer ${config.access_token}`,
          'chatgpt-account-id': config.account_id,
        }),
    }),
    requestBufferedFn: overrides.requestBufferedFn,
    shouldUseQuotaMonitoring: overrides.shouldUseQuotaMonitoring || (type => type === 'token'),
    refreshTokenFn: overrides.refreshTokenFn,
    persistTokenRefreshFn: overrides.persistTokenRefreshFn,
    sleepFn: overrides.sleepFn,
    setIntervalFn: overrides.setIntervalFn,
    clearIntervalFn: overrides.clearIntervalFn,
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => warnings.push(args.join(' ')),
    now: overrides.now || (() => 1713337200000),
  });

  return { manager, logs, warnings };
}

function flushAsyncWork() {
  return new Promise(resolve => setImmediate(resolve));
}

test('createAccountManager honors the initial active config index', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
    createConfig(2, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs, { initialActiveConfigIndex: 2 });

  assert.equal(manager.getActiveConfig(), configs[2]);
});

test('ensureActiveConfig keeps the current account when it is still available', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.ensureActiveConfig('poll');

  assert.equal(selected, configs[0]);
  assert.equal(manager.getActiveConfig(), configs[0]);
  assert.equal(warnings.length, 0);
});

test('ensureActiveConfig uses config order instead of preferring token over apikey', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const selected = manager.ensureActiveConfig('select');

  assert.equal(selected, configs[0]);
  assert.equal(manager.getActiveConfig(), configs[0]);
});

test('ensureActiveConfig keeps the current available account even when an earlier config is available', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs, {
    initialActiveConfigIndex: 1,
  });

  const selected = manager.ensureActiveConfig('admin_move_config');

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(warnings.length, 0);
});

test('ensureActiveConfig returns null when there are no configs', () => {
  const { manager, warnings } = createManager([]);

  const selected = manager.ensureActiveConfig('startup');

  assert.equal(selected, null);
  assert.equal(manager.getActiveConfig(), null);
  assert.equal(warnings.length, 0);
});

test('ensureActiveConfig switches to the next available account when current one becomes unavailable', () => {
  const configs = [
    createConfig(0, { available: false, reason: 'remaining_below_3%' }),
    createConfig(1, { available: true, reason: 'ok' }),
    createConfig(2, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.ensureActiveConfig('poll');

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.match(warnings[0], /账号切换: #1 account-1 -> #2 account-2 \(poll\)/);
});

test('ensureActiveConfig does not log account switches during startup', () => {
  const configs = [
    createConfig(0, { available: false, reason: 'remaining_below_3%' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.ensureActiveConfig('startup');

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(warnings.length, 0);
});

test('getActiveConfig returns the current active account without switching', () => {
  const configs = [
    createConfig(0, { available: false, reason: 'remaining_below_3%' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.getActiveConfig();

  assert.equal(selected, configs[0]);
  assert.equal(manager.getActiveConfig(), configs[0]);
  assert.equal(manager.selectConfig, undefined);
  assert.equal(warnings.length, 0);
});

test('activateConfig switches the active config without changing availability', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: false, reason: 'quota_check_failed' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.activateConfig(1, 'manual');

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(configs[1].runtime.available, false);
  assert.match(warnings[0], /账号切换: #1 account-1 -> #2 account-2 \(manual\)/);
});

test('activateConfig uses a token config as the anonymous dispatch anchor', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  manager.activateConfig(1, 'manual');
  const lease = manager.acquireConfig('proxy_request');

  assert.equal(lease.config, configs[1]);
  lease.release();
});

test('ensureActiveConfig keeps a manually activated config while it remains available', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
    }),
  ];
  const { manager } = createManager(configs);

  manager.activateConfig(1, 'manual');
  const selected = manager.ensureActiveConfig('poll');

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
});

test('ensureActiveConfig can prefer configs matching a route-specific predicate', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://claude.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-claude',
      support: ['claude'],
    }),
  ];
  const { manager } = createManager(configs);

  const selected = manager.ensureActiveConfig('claude_request', config => config.type === 'apikey' && config.support.includes('claude'));

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
});

test('account manager does not expose internal helper methods', () => {
  const { manager } = createManager([createConfig(0)]);

  assert.equal(manager.selectConfig, undefined);
  assert.equal(manager.findNextAvailableConfig, undefined);
  assert.equal(manager.getRuntimeSummary, undefined);
  assert.equal(manager.evaluateQuotaPayload, undefined);
  assert.equal(manager.applyQuotaState, undefined);
  assert.equal(manager.getAccountLabel, undefined);
});

test('acquireConfig keeps the same session on the same available account', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
    createConfig(2, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const firstLease = manager.acquireConfig('proxy_request', () => true, {
    sessionKey: 'session-1',
  });
  const firstConfig = firstLease.config;
  const activeStatus = manager.getAccountStatus(firstConfig);
  assert.equal(firstConfig.runtime.inFlight, 1);
  assert.match(activeStatus.dispatchSession.label, /^#[0-9a-f]{12}$/);
  assert.equal(activeStatus.dispatchSession.active, true);
  assert.equal(activeStatus.dispatchSession.sticky, true);
  assert.equal(activeStatus.dispatchSession.fallback, false);
  assert.equal(activeStatus.dispatchSession.reason, 'proxy_request');
  assert.equal(activeStatus.dispatchSession.startedAt, 1713337200000);
  assert.equal(activeStatus.dispatchSession.lastSeenAt, 1713337200000);
  assert.equal(activeStatus.dispatchSession.label.includes('session-1'), false);

  firstLease.release();
  firstLease.release();
  const releasedStatus = manager.getAccountStatus(firstConfig);
  assert.equal(firstConfig.runtime.inFlight, 0);
  assert.equal(releasedStatus.dispatchSession.label, activeStatus.dispatchSession.label);
  assert.equal(releasedStatus.dispatchSession.active, false);
  assert.equal(releasedStatus.dispatchSession.sticky, true);
  assert.equal(releasedStatus.dispatchSession.lastSeenAt, 1713337200000);

  const secondLease = manager.acquireConfig('proxy_request', () => true, {
    sessionKey: 'session-1',
  });

  assert.equal(secondLease.config, firstConfig);
  secondLease.release();
});

test('acquireConfig distributes sticky sessions across candidates with rendezvous hashing', () => {
  const configs = Array.from({ length: 7 }, (_, index) => createConfig(index, {
    available: true,
    reason: 'ok',
  }));
  const { manager } = createManager(configs);
  const counts = new Map(configs.map(config => [config.index, 0]));

  for (let index = 0; index < 1400; index += 1) {
    const lease = manager.acquireConfig('proxy_request', () => true, {
      sessionKey: `session-${index}`,
    });
    counts.set(lease.config.index, counts.get(lease.config.index) + 1);
    lease.release();
  }

  const values = [...counts.values()];
  assert.equal(values.length, 7);
  assert.ok(values.every(value => value > 0));
  assert.ok(Math.min(...values) >= 140);
  assert.ok(Math.max(...values) <= 260);
});

test('acquireConfig moves a sticky session when the hashed account is unavailable', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
    createConfig(2, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const firstLease = manager.acquireConfig('proxy_request', () => true, {
    sessionKey: 'session-2',
  });
  const failedConfig = firstLease.config;
  firstLease.release();

  manager.markConfigUnavailable(failedConfig, 'responses_usage_limit_reached', {
    allowSwitch: false,
  });

  const nextLease = manager.acquireConfig('proxy_request', () => true, {
    sessionKey: 'session-2',
  });

  assert.notEqual(nextLease.config, failedConfig);
  assert.equal(nextLease.config.runtime.available, true);
  nextLease.release();
});

test('acquireConfig excludes the failed config during request failover', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
    createConfig(2, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const firstLease = manager.acquireConfig('proxy_request', () => true, {
    sessionKey: 'session-3',
  });
  const failedConfig = firstLease.config;
  firstLease.release();

  const retryLease = manager.acquireConfig('responses_failover', () => true, {
    sessionKey: 'session-3',
    exclude: [failedConfig],
  });

  assert.notEqual(retryLease.config, failedConfig);
  retryLease.release();
});

test('acquireConfig can disable unavailable fallback for failover selection', () => {
  const configs = [
    createConfig(0, { available: false, reason: 'responses_usage_limit_reached' }),
  ];
  const { manager } = createManager(configs);

  const lease = manager.acquireConfig('responses_failover', () => true, {
    sessionKey: 'session-4',
    allowFallback: false,
  });

  assert.equal(lease, null);
});

test('acquireConfig skips a token that is still cooling down after a responses failure', () => {
  let nowMs = 1713337200000;
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs, {
    now: () => nowMs,
    tokenUnavailableCooldownMs: 60 * 1000,
  });

  const selected = manager.markConfigUnavailable(configs[0], 'responses_usage_limit_reached', {
    allowSwitch: false,
    lastError: 'stream:usage_limit_reached',
  });

  assert.equal(selected, configs[0]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.unavailableUntil, 1713337260000);
  assert.equal(manager.getAccountStatus(configs[0]).unavailableUntil, 1713337260000);

  const coolingLease = manager.acquireConfig('proxy_request', () => true, {
    sessionKey: 'cooldown-session',
  });

  assert.equal(coolingLease.config, configs[1]);
  coolingLease.release();

  nowMs = 1713337260000;
  const retryLease = manager.acquireConfig('proxy_request', config => config.index === 0, {
    sessionKey: 'cooldown-session',
  });

  assert.equal(retryLease.config, configs[0]);
  assert.equal(retryLease.fallback, true);
  retryLease.release();
});

test('applyQuotaPayload clears token cooldown when quota check recovers the account', () => {
  const configs = [
    createConfig(0, {
      available: false,
      reason: 'responses_usage_limit_reached',
      unavailableUntil: 1713337260000,
    }),
  ];
  const { manager } = createManager(configs);

  manager.applyQuotaPayload(configs[0], {
    plan_type: 'plus',
    rate_limit: {
      primary_window: {
        used_percent: 5,
        reset_at: 1713340000,
      },
      secondary_window: {
        used_percent: 10,
        reset_at: 1713940000,
      },
    },
  }, {
    allowSwitch: false,
  });

  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.unavailableUntil, null);
});

test('acquireConfig ignores apikey configs because concurrent dispatch is token-only', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
  ];
  const { manager } = createManager(configs);

  const lease = manager.acquireConfig('proxy_request', () => true, {
    sessionKey: 'session-apikey',
  });

  assert.equal(lease, null);
  assert.equal(configs[0].runtime.inFlight, undefined);
  assert.equal(manager.getAccountStatus(configs[0]).dispatchSession, null);
});

test('acquireConfig balances anonymous requests by in-flight count', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const firstLease = manager.acquireConfig('proxy_request');
  const secondLease = manager.acquireConfig('proxy_request');

  assert.notEqual(secondLease.config, firstLease.config);
  assert.equal(firstLease.config.runtime.inFlight, 1);
  assert.equal(secondLease.config.runtime.inFlight, 1);

  firstLease.release();
  secondLease.release();
  assert.equal(configs[0].runtime.inFlight, 0);
  assert.equal(configs[1].runtime.inFlight, 0);
});

test('getDispatchIdentity keeps token routing stable across access token refreshes', () => {
  const config = createConfig(0, { available: true, reason: 'ok' }, {
    access_token: 'old-access-token',
  });
  const { manager } = createManager([config]);

  const previousIdentity = manager.getDispatchIdentity(config);
  config.access_token = 'new-access-token';

  assert.equal(manager.getDispatchIdentity(config), previousIdentity);
});

test('observeResponseModel records requested and upstream response models', () => {
  const config = createConfig(0, { available: true, reason: 'ok' });
  const { manager } = createManager([config]);

  manager.observeResponseModel(config, {
    requestModel: 'gpt-5.5',
    active: true,
    source: 'proxy_request',
  });

  let status = manager.getAccountStatus(config);
  assert.deepEqual(status.responseModel, {
    requestModel: 'gpt-5.5',
    responseModel: null,
    active: true,
    source: 'proxy_request',
    statusCode: null,
    observedAt: null,
    lastSeenAt: 1713337200000,
  });

  manager.observeResponseModel(config, {
    responseModel: 'gpt-5.4-mini',
    statusCode: 200,
  });
  manager.observeResponseModel(config, {
    active: false,
  });

  status = manager.getAccountStatus(config);
  assert.deepEqual(status.responseModel, {
    requestModel: 'gpt-5.5',
    responseModel: 'gpt-5.4-mini',
    active: false,
    source: 'proxy_request',
    statusCode: 200,
    observedAt: 1713337200000,
    lastSeenAt: 1713337200000,
  });
});

test('getAccountStatus returns the view model used by callers', () => {
  const config = createConfig(0, {
    available: false,
    remainingPercent: 2,
    primaryRemainingPercent: 2,
    primaryResetAt: 1713350000,
    primaryResetAfterSeconds: 120,
    secondaryRemainingPercent: 10,
    secondaryResetAt: 1713360000,
    secondaryResetAfterSeconds: 3600,
    lastCheckedAt: 1713337200000,
    reason: 'remaining_below_3%',
  });
  const { manager } = createManager([config]);

  const status = manager.getAccountStatus(config);

  assert.deepEqual({
    index: 0,
    description: 'account-1',
    label: '#1 account-1',
    available: false,
    remainingPercent: 2,
    primaryRemainingPercent: 2,
    primaryResetAt: 1713350000,
    primaryResetAfterSeconds: 120,
    secondaryRemainingPercent: 10,
    secondaryResetAt: 1713360000,
    secondaryResetAfterSeconds: 3600,
    lastCheckedAt: 1713337200000,
    reason: 'remaining_below_3%',
  }, {
    index: status.index,
    description: status.description,
    label: status.label,
    available: status.available,
    remainingPercent: status.remainingPercent,
    primaryRemainingPercent: status.primaryRemainingPercent,
    primaryResetAt: status.primaryResetAt,
    primaryResetAfterSeconds: status.primaryResetAfterSeconds,
    secondaryRemainingPercent: status.secondaryRemainingPercent,
    secondaryResetAt: status.secondaryResetAt,
    secondaryResetAfterSeconds: status.secondaryResetAfterSeconds,
    lastCheckedAt: status.lastCheckedAt,
    reason: status.reason,
  });
  assert.match(status.runtimeSummary, /可用=否 \| 额度=2%/);
  assert.match(status.runtimeSummary, /状态=剩余额度低于 3%/);
  assert.equal(status.inFlight, 0);
  assert.equal(status.dispatchSession, null);
  assert.equal(status.responseModel, null);
  assert.equal(status.summaryLine, `${status.label} | ${status.runtimeSummary}`);
});

test('getAccountStatus exposes token quota failure and apikey request window summaries', () => {
  const tokenConfig = createConfig(0, {
    quotaCheckFailures: 2,
  });
  const apiKeyConfig = createConfig(1, {
    reason: 'apikey',
    apiKeyRequestResults: [
      { ok: false, at: 1713337200000, reason: 'apikey_rate_limited', lastError: 'http:429' },
      { ok: true, at: 1713337200000 },
    ],
  }, {
    type: 'apikey',
    baseUrl: 'https://api.example.com/v1',
    apiBasePath: '',
    apiKey: 'sk-1',
    support: ['gpt'],
  });
  const { manager } = createManager([tokenConfig, apiKeyConfig]);

  assert.equal(manager.getAccountStatus(tokenConfig).quotaCheckFailures, 2);
  assert.deepEqual(manager.getAccountStatus(apiKeyConfig).apiKeyRequestWindow, {
    failureCount: 1,
    sampleSize: 2,
    failureThreshold: 3,
    windowSize: 10,
    sampleTtlMs: 30 * 60 * 1000,
  });
  assert.deepEqual(manager.getAccountStatus(apiKeyConfig).apiKeyRecovery, {
    enabled: true,
    pending: false,
    intervalMs: 10 * 60 * 1000,
    lastCheckedAt: null,
    result: 'never',
    statusCode: null,
    reason: null,
    lastError: null,
    model: 'gpt-5.5',
  });
});

test('ensureActiveConfig keeps the current account when no account is marked available', () => {
  const configs = [
    createConfig(0, { available: false, reason: 'quota_check_failed' }),
    createConfig(1, { available: false, reason: 'remaining_below_3%' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.ensureActiveConfig('poll');

  assert.equal(selected, configs[0]);
  assert.equal(manager.getActiveConfig(), configs[0]);
  assert.match(warnings[0], /没有可用账号，继续使用当前账号 #1 account-1 \(poll\)/);
});

test('applyQuotaPayload marks allowed=false as unavailable', () => {
  const configs = [createConfig(0), createConfig(1)];
  const { manager } = createManager(configs);

  manager.applyQuotaPayload(configs[1], {
    rate_limit: {
      allowed: false,
      primary_window: { used_percent: 10, reset_at: 1713350000 },
      secondary_window: { used_percent: 20, reset_at: 1713360000 },
    },
  });

  assert.equal(configs[1].runtime.available, false);
  assert.equal(configs[1].runtime.reason, 'rate_limit_not_allowed');
  assert.equal(manager.getActiveConfig(), configs[0]);
});

test('applyQuotaPayload marks limit_reached=true as unavailable', () => {
  const configs = [createConfig(0), createConfig(1)];
  const { manager } = createManager(configs);

  manager.applyQuotaPayload(configs[1], {
    rate_limit: {
      allowed: true,
      limit_reached: true,
      primary_window: { used_percent: 10, reset_at: 1713350000 },
      secondary_window: { used_percent: 20, reset_at: 1713360000 },
    },
  });

  assert.equal(configs[1].runtime.available, false);
  assert.equal(configs[1].runtime.reason, 'rate_limit_reached');
  assert.equal(manager.getActiveConfig(), configs[0]);
});

test('applyQuotaPayload marks unauthorized detail payloads as missing credentials', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs, { initialActiveConfigIndex: 0 });

  const selected = manager.applyQuotaPayload(configs[0], {
    detail: 'Unauthorized',
  });

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'missing_credentials');
});

test('applyQuotaPayload marks token_revoked payloads as missing credentials', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs, { initialActiveConfigIndex: 0 });

  const selected = manager.applyQuotaPayload(configs[0], {
    detail: 'Encountered invalidated oauth token for user',
    error: {
      code: 'token_revoked',
    },
  });

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'missing_credentials');
});

test('applyQuotaPayload marks remaining below threshold as unavailable', () => {
  const configs = [createConfig(0), createConfig(1)];
  const { manager } = createManager(configs);

  manager.applyQuotaPayload(configs[1], {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 98, reset_at: 1713350000 },
      secondary_window: { used_percent: 10, reset_at: 1713360000 },
    },
  });

  assert.equal(configs[1].runtime.available, false);
  assert.equal(configs[1].runtime.reason, 'remaining_below_3%');
  assert.equal(configs[1].runtime.remainingPercent, 2);
  assert.equal(manager.getActiveConfig(), configs[0]);
});

test('applyQuotaPayload keeps the account available when weekly quota remains above 1%', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  manager.applyQuotaPayload(configs[0], {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 50, reset_at: 1713350000 },
      secondary_window: { used_percent: 98, reset_at: 1713360000 },
    },
  });

  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.remainingPercent, 50);
  assert.equal(configs[0].runtime.primaryRemainingPercent, 50);
  assert.equal(configs[0].runtime.secondaryRemainingPercent, 2);
  assert.equal(manager.getActiveConfig(), configs[0]);
});

test('applyQuotaPayload marks the account unavailable when weekly quota is not above 1%', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const selected = manager.applyQuotaPayload(configs[0], {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 50, reset_at: 1713350000 },
      secondary_window: { used_percent: 99, reset_at: 1713360000 },
    },
  });

  assert.equal(selected, configs[1]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'secondary_remaining_not_above_1%');
  assert.equal(configs[0].runtime.remainingPercent, 50);
  assert.equal(configs[0].runtime.primaryRemainingPercent, 50);
  assert.equal(configs[0].runtime.secondaryRemainingPercent, 1);
  assert.equal(manager.getActiveConfig(), configs[1]);
});

test('applyQuotaPayload marks an explicit free plan as membership expired', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const selected = manager.applyQuotaPayload(configs[0], {
    plan_type: 'free',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 3, reset_at: 1779413261 },
      secondary_window: { used_percent: 10, reset_at: 1779416861 },
    },
  });

  assert.equal(selected, configs[1]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'membership_expired');
  assert.equal(configs[0].runtime.primaryRemainingPercent, 97);
  assert.equal(configs[0].runtime.secondaryRemainingPercent, 90);
  assert.equal(manager.getActiveConfig(), configs[1]);
});

test('applyQuotaPayload marks missing weekly quota on a token account as membership expired', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  const selected = manager.applyQuotaPayload(configs[0], {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 3, reset_at: 1779413261 },
    },
  });

  assert.equal(selected, configs[1]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'membership_expired');
  assert.equal(configs[0].runtime.remainingPercent, 97);
  assert.equal(configs[0].runtime.primaryRemainingPercent, 97);
  assert.equal(configs[0].runtime.secondaryRemainingPercent, null);
  assert.equal(configs[0].runtime.secondaryResetAt, null);
  assert.equal(manager.getActiveConfig(), configs[1]);
});

test('applyQuotaPayload switches away from the active account when it becomes unavailable', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  manager.applyQuotaPayload(configs[0], {
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 98, reset_at: 1713350000 },
      secondary_window: { used_percent: 20, reset_at: 1713360000 },
    },
  });

  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.match(warnings[0], /账号切换: #1 account-1 -> #2 account-2 \(quota_update\)/);
});

test('markConfigUnavailable switches away from the active account', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.markConfigUnavailable(configs[0], 'responses_usage_limit_reached', {
    lastError: 'usage_limit_reached',
    switchReason: 'responses_failover',
  });

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'responses_usage_limit_reached');
  assert.equal(configs[0].runtime.lastError, 'usage_limit_reached');
  assert.equal(configs[0].runtime.lastCheckedAt, 1713337200000);
  assert.match(warnings[0], /账号切换: #1 account-1 -> #2 account-2 \(responses_failover\)/);
});

test('markConfigUnavailable keeps the current account when no alternative is available', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  const selected = manager.markConfigUnavailable(configs[0], 'responses_insufficient_quota', {
    lastError: 'insufficient_quota',
    switchReason: 'responses_failover',
  });

  assert.equal(selected, configs[0]);
  assert.equal(manager.getActiveConfig(), configs[0]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'responses_insufficient_quota');
  assert.equal(configs[0].runtime.lastError, 'insufficient_quota');
  assert.equal(configs[0].runtime.lastCheckedAt, 1713337200000);
  assert.match(warnings[0], /没有可用账号，继续使用当前账号 #1 account-1 \(responses_failover\)/);
});

test('recordApiKeyRequestResult marks apikey unavailable when recent failures reach three in a ten-request window', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager, warnings } = createManager(configs);

  for (let index = 0; index < 2; index += 1) {
    manager.recordApiKeyRequestResult(configs[0], {
      ok: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
      switchReason: 'apikey_upstream_failover',
    });
  }
  for (let index = 0; index < 6; index += 1) {
    manager.recordApiKeyRequestResult(configs[0], {
      ok: true,
    });
  }

  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'apikey');
  assert.equal(manager.getActiveConfig(), configs[0]);

  const result = manager.recordApiKeyRequestResult(configs[0], {
    ok: false,
    reason: 'apikey_rate_limited',
    lastError: 'http:429',
    switchReason: 'apikey_upstream_failover',
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.failureCount, 3);
  assert.equal(result.sampleSize, 9);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'apikey_rate_limited');
  assert.equal(configs[0].runtime.lastError, 'http:429');
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(warnings.some(line => /账号切换: #1 account-1 -> #2 account-2 \(apikey_upstream_failover\)/.test(line)), true);
});

test('recordApiKeyRequestResult marks apikey unavailable after three consecutive failed requests even before the window is full', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const { manager } = createManager(configs);

  manager.recordApiKeyRequestResult(configs[0], {
    ok: false,
    reason: 'apikey_upstream_5xx',
    lastError: 'http:500',
    switchReason: 'apikey_upstream_failover',
  });
  manager.recordApiKeyRequestResult(configs[0], {
    ok: false,
    reason: 'apikey_upstream_5xx',
    lastError: 'http:500',
    switchReason: 'apikey_upstream_failover',
  });

  assert.equal(configs[0].runtime.available, true);
  assert.equal(manager.getActiveConfig(), configs[0]);

  const result = manager.recordApiKeyRequestResult(configs[0], {
    ok: false,
    reason: 'apikey_upstream_5xx',
    lastError: 'http:500',
    switchReason: 'apikey_upstream_failover',
  });

  assert.equal(result.unavailable, true);
  assert.equal(result.failureCount, 3);
  assert.equal(result.sampleSize, 3);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'apikey_upstream_5xx');
  assert.equal(manager.getActiveConfig(), configs[1]);
});

test('recordApiKeyRequestResult only counts failures in the latest ten apikey requests', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
  ];
  const { manager } = createManager(configs);

  for (let index = 0; index < 2; index += 1) {
    manager.recordApiKeyRequestResult(configs[0], {
      ok: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
      switchReason: 'apikey_upstream_failover',
    });
  }
  for (let index = 0; index < 9; index += 1) {
    manager.recordApiKeyRequestResult(configs[0], {
      ok: true,
    });
  }

  const result = manager.recordApiKeyRequestResult(configs[0], {
    ok: false,
    reason: 'apikey_rate_limited',
    lastError: 'http:429',
    switchReason: 'apikey_upstream_failover',
  });

  assert.equal(result.unavailable, false);
  assert.equal(result.failureCount, 1);
  assert.equal(result.sampleSize, 10);
  assert.equal(configs[0].runtime.available, true);
});

test('recordApiKeyRequestResult expires old apikey failures outside the TTL window', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  let currentTime = 1713337200000;
  const { manager } = createManager(configs, {
    now: () => currentTime,
  });

  for (let index = 0; index < 2; index += 1) {
    manager.recordApiKeyRequestResult(configs[0], {
      ok: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
      switchReason: 'apikey_upstream_failover',
    });
  }

  currentTime += 31 * 60 * 1000;
  const result = manager.recordApiKeyRequestResult(configs[0], {
    ok: false,
    reason: 'apikey_rate_limited',
    lastError: 'http:429',
    switchReason: 'apikey_upstream_failover',
  });

  assert.equal(result.unavailable, false);
  assert.equal(result.failureCount, 1);
  assert.equal(result.sampleSize, 1);
  assert.equal(configs[0].runtime.available, true);
});

test('activateConfig restores an unavailable apikey config before switching to it', () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, {
      available: false,
      reason: 'apikey_auth_failed',
      lastError: 'http:401',
      lastCheckedAt: 1713337100000,
    }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
      support: ['gpt'],
    }),
  ];
  const { manager } = createManager(configs);

  const selected = manager.activateConfig(1, 'admin_manual_activate');

  assert.equal(selected, configs[1]);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(configs[1].runtime.available, true);
  assert.equal(configs[1].runtime.reason, 'apikey');
  assert.equal(configs[1].runtime.lastError, null);
});

test('refreshQuotas refreshes every token account during a minute poll', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 25, reset_at: 1713350000 },
        secondary_window: { used_percent: 40, reset_at: 1713360000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 30, reset_at: 1713351000 },
        secondary_window: { used_percent: 45, reset_at: 1713361000 },
      },
    },
  ]);
  const { manager, logs } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('poll');

  assert.equal(quotaResponses.getCallCount(), 2);
  assert.equal(configs[0].runtime.lastCheckedAt, 1713337200000);
  assert.equal(configs[1].runtime.lastCheckedAt, 1713337200000);
  assert.equal(quotaResponses.getCalls()[0].timeoutMs, 10 * 1000);
  assert.match(logs[0], /轮询额度: #1 account-1 \| 可用=是/);
});

test('refreshQuotas marks token unavailable only after three consecutive quota check failures', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  let callCount = 0;
  const { manager } = createManager(configs, {
    requestBufferedFn: async () => {
      callCount += 1;
      if (callCount <= 3) {
        throw new Error('temporary network failure');
      }

      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 20, reset_at: 1713350000 },
            secondary_window: { used_percent: 30, reset_at: 1713360000 },
          },
        }),
      };
    },
  });

  await manager.refreshQuotas('poll', { refreshAll: false });
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.quotaCheckFailures, 1);

  await manager.refreshQuotas('poll', { refreshAll: false });
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.quotaCheckFailures, 2);

  await manager.refreshQuotas('poll', { refreshAll: false });
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'quota_check_failed');
  assert.equal(configs[0].runtime.quotaCheckFailures, 3);
  assert.equal(manager.getActiveConfig(), configs[1]);

  manager.activateConfig(0, 'admin_manual_activate');
  await manager.refreshQuotas('poll', { refreshAll: false });
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.quotaCheckFailures, 0);
});

test('startQuotaMonitor schedules minute and ten-minute spaced all-account polls', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const intervalCallbacks = [];
  const intervalMs = [];
  const clearedTimers = [];
  const delayCalls = [];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 25, reset_at: 1713350000 },
        secondary_window: { used_percent: 40, reset_at: 1713360000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 30, reset_at: 1713351000 },
        secondary_window: { used_percent: 45, reset_at: 1713361000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 35, reset_at: 1713352000 },
        secondary_window: { used_percent: 50, reset_at: 1713362000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 40, reset_at: 1713353000 },
        secondary_window: { used_percent: 55, reset_at: 1713363000 },
      },
    },
  ]);
  const { manager } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
    quotaCheckIntervalMs: 60 * 1000,
    allQuotaCheckIntervalMs: 10 * 60 * 1000,
    allQuotaCheckDelayMs: 1000,
    sleepFn: async ms => {
      delayCalls.push(ms);
    },
    setIntervalFn: (callback, ms) => {
      intervalCallbacks.push(callback);
      intervalMs.push(ms);
      return `timer-${intervalCallbacks.length}`;
    },
    clearIntervalFn: timer => {
      clearedTimers.push(timer);
    },
  });

  manager.startQuotaMonitor();

  assert.deepEqual(intervalMs, [60 * 1000, 10 * 60 * 1000]);

  intervalCallbacks[0]();
  await flushAsyncWork();

  assert.deepEqual(
    quotaResponses.getCalls().map(call => call.headers['chatgpt-account-id']),
    ['account-0', 'account-1'],
  );
  assert.deepEqual(delayCalls, [1000]);

  intervalCallbacks[1]();
  await flushAsyncWork();

  assert.deepEqual(
    quotaResponses.getCalls().map(call => call.headers['chatgpt-account-id']),
    ['account-0', 'account-1', 'account-0', 'account-1'],
  );
  assert.deepEqual(delayCalls, [1000, 1000]);

  manager.stopQuotaMonitor();

  assert.deepEqual(clearedTimers, ['timer-1', 'timer-2']);
});

test('startQuotaMonitor schedules ten-minute apikey recovery when no token configs exist', async () => {
  const configs = [
    createConfig(0, {
      available: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
    }, {
      type: 'apikey',
      baseUrl: 'https://recover.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-recover',
      support: ['gpt'],
    }),
  ];
  const intervalCallbacks = [];
  const intervalMs = [];
  const calls = [];
  const { manager } = createManager(configs, {
    requestBufferedFn: async requestOptions => {
      calls.push(requestOptions);
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ id: 'resp_1' }),
      };
    },
    setIntervalFn: (callback, ms) => {
      intervalCallbacks.push(callback);
      intervalMs.push(ms);
      return `timer-${intervalCallbacks.length}`;
    },
  });

  manager.startQuotaMonitor();

  assert.deepEqual(intervalMs, [60 * 1000, 10 * 60 * 1000]);

  intervalCallbacks[0]();
  await flushAsyncWork();

  assert.equal(calls.length, 0);
  assert.equal(configs[0].runtime.available, false);

  intervalCallbacks[1]();
  await flushAsyncWork();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].targetUrl, 'https://recover.example.com/v1/responses');
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'apikey');
});

test('refreshQuotas uses configured apikey health model during GPT recovery probes', async () => {
  const configs = [
    createConfig(0, {
      available: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
    }, {
      type: 'apikey',
      baseUrl: 'https://recover.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-recover',
      support: ['gpt'],
      health: {
        model: 'gpt-4.1-mini',
      },
    }),
  ];
  const calls = [];
  const { manager } = createManager(configs, {
    requestBufferedFn: async requestOptions => {
      calls.push(requestOptions);
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ id: 'resp_1' }),
      };
    },
  });

  await manager.refreshQuotas('all_poll');

  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body.toString('utf8')), {
    model: 'gpt-4.1-mini',
    input: 'hello',
    stream: false,
  });
  assert.equal(configs[0].runtime.available, true);
});

test('refreshQuotas gives apikey recovery probes an AI request timeout', async () => {
  const configs = [
    createConfig(0, {
      available: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
    }, {
      type: 'apikey',
      baseUrl: 'https://recover.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-recover',
      support: ['gpt'],
    }),
  ];
  const calls = [];
  const { manager } = createManager(configs, {
    quotaCheckTimeoutMs: 10 * 1000,
    requestBufferedFn: async requestOptions => {
      calls.push(requestOptions);
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ id: 'resp_1' }),
      };
    },
  });

  await manager.refreshQuotas('all_poll');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 10 * 60 * 1000);
});

test('refreshQuotas treats non-200 apikey recovery statuses as failed', async () => {
  const configs = [
    createConfig(0, {
      available: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
    }, {
      type: 'apikey',
      baseUrl: 'https://recover.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-recover',
      support: ['gpt'],
    }),
  ];
  const { manager } = createManager(configs, {
    requestBufferedFn: async () => ({
      statusCode: 201,
      bodyText: JSON.stringify({ id: 'resp_created' }),
    }),
  });

  await manager.refreshQuotas('all_poll');

  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'apikey_upstream_error');
  assert.equal(configs[0].runtime.lastError, 'http:201');
  assert.deepEqual(configs[0].runtime.apiKeyRecovery, {
    lastCheckedAt: 1713337200000,
    result: 'failed',
    statusCode: 201,
    reason: 'apikey_upstream_error',
    lastError: 'http:201',
    model: 'gpt-5.5',
  });
});

test('refreshQuotas switches to the next available account when the polled account becomes unavailable', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok', remainingPercent: 70 }),
    createConfig(2, { available: false, reason: 'quota_check_failed' }),
  ];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 98, reset_at: 1713350000 },
        secondary_window: { used_percent: 20, reset_at: 1713360000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 30, reset_at: 1713351000 },
        secondary_window: { used_percent: 35, reset_at: 1713361000 },
      },
    },
  ]);
  const { manager, warnings, logs } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('poll');

  assert.equal(quotaResponses.getCallCount(), 2);
  assert.deepEqual(
    quotaResponses.getCalls().map(call => call.headers['chatgpt-account-id']),
    ['account-0', 'account-1'],
  );
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.match(warnings[0], /账号不可用: #1 account-1 \(remaining_below_3%\)/);
  assert.match(warnings[1], /账号切换: #1 account-1 -> #2 account-2 \(poll\)/);
  assert.match(logs[0], /轮询额度: #2 account-2 \| 可用=是/);
});

test('refreshQuotas refreshes and can recover non-active accounts during a minute poll', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: false, reason: 'quota_check_failed' }),
  ];
  const calls = [];
  let requestIndex = 0;
  const requestBufferedFn = requestOptions => {
    calls.push(requestOptions);

    if (requestIndex === 0) {
      requestIndex += 1;
      return Promise.reject(new Error('network down'));
    }

    requestIndex += 1;
    return Promise.resolve({
      statusCode: 200,
      bodyText: JSON.stringify({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 25, reset_at: 1713351000 },
          secondary_window: { used_percent: 30, reset_at: 1713361000 },
        },
      }),
    });
  };
  const { manager, warnings, logs } = createManager(configs, {
    requestBufferedFn,
  });

  await manager.refreshQuotas('poll');

  assert.deepEqual(
    calls.map(call => call.headers['chatgpt-account-id']),
    ['account-0', 'account-1'],
  );
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.quotaCheckFailures, 1);
  assert.equal(configs[1].runtime.available, true);
  assert.equal(configs[1].runtime.reason, 'ok');
  assert.equal(manager.getActiveConfig(), configs[0]);
  assert.equal(warnings.some(line => /账号不可用: #1 account-1 \(quota_check_failed: network down\)/.test(line)), false);
  assert.equal(warnings.some(line => /账号恢复可用: #2 account-2/.test(line)), true);
  assert.equal(warnings.some(line => /账号切换: #1 account-1 -> #2 account-2 \(poll\)/.test(line)), false);
  assert.match(logs[0], /轮询额度: #1 account-1 \| 可用=是/);
});

test('refreshQuotas refreshes an expired token with refresh_token and retries quota check', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }, {
      access_token: 'old-access-token',
      refresh_token: 'old-refresh-token',
    }),
  ];
  const requestCalls = [];
  const persisted = [];
  let quotaCallIndex = 0;
  const { manager } = createManager(configs, {
    requestBufferedFn: async requestOptions => {
      requestCalls.push(requestOptions);
      quotaCallIndex += 1;

      if (quotaCallIndex === 1) {
        return {
          statusCode: 401,
          bodyText: JSON.stringify({
            detail: 'Unauthorized',
          }),
        };
      }

      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 25, reset_at: 1713350000 },
            secondary_window: { used_percent: 40, reset_at: 1713360000 },
          },
        }),
      };
    },
    refreshTokenFn: async payload => {
      assert.equal(payload.refreshToken, 'old-refresh-token');
      assert.equal(payload.config, configs[0]);
      return {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      };
    },
    persistTokenRefreshFn: async payload => {
      persisted.push(payload);
    },
  });

  await manager.refreshQuotas('poll');

  assert.equal(requestCalls.length, 2);
  assert.equal(requestCalls[0].headers.authorization, 'Bearer old-access-token');
  assert.equal(requestCalls[1].headers.authorization, 'Bearer new-access-token');
  assert.equal(configs[0].access_token, 'new-access-token');
  assert.equal(configs[0].refresh_token, 'new-refresh-token');
  assert.deepEqual(persisted, [{
    config: configs[0],
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
  }]);
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.remainingPercent, 75);
});

test('refreshQuotas refreshes token on quota check 401 even when payload is not recognized', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }, {
      access_token: 'bad-access-token',
      refresh_token: 'refresh-token',
    }),
  ];
  const requestCalls = [];
  let quotaCallIndex = 0;
  const { manager } = createManager(configs, {
    requestBufferedFn: async requestOptions => {
      requestCalls.push(requestOptions);
      quotaCallIndex += 1;

      if (quotaCallIndex === 1) {
        return {
          statusCode: 401,
          bodyText: JSON.stringify({
            error: {
              message: 'Unauthorized',
            },
          }),
        };
      }

      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 15, reset_at: 1713350000 },
            secondary_window: { used_percent: 20, reset_at: 1713360000 },
          },
        }),
      };
    },
    refreshTokenFn: async payload => {
      assert.equal(payload.refreshToken, 'refresh-token');
      return {
        access_token: 'fresh-access-token',
      };
    },
  });

  await manager.refreshQuotas('poll');

  assert.equal(requestCalls.length, 2);
  assert.equal(requestCalls[0].headers.authorization, 'Bearer bad-access-token');
  assert.equal(requestCalls[1].headers.authorization, 'Bearer fresh-access-token');
  assert.equal(configs[0].access_token, 'fresh-access-token');
  assert.equal(configs[0].refresh_token, 'refresh-token');
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.remainingPercent, 85);
});

test('refreshQuotas keeps missing_credentials when refresh_token is unavailable', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
  ];
  let refreshCalled = false;
  const { manager } = createManager(configs, {
    requestBufferedFn: async () => ({
      statusCode: 401,
      bodyText: JSON.stringify({
        detail: 'Unauthorized',
      }),
    }),
    refreshTokenFn: async () => {
      refreshCalled = true;
      return {};
    },
  });

  await manager.refreshQuotas('poll');

  assert.equal(refreshCalled, false);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'missing_credentials');
});

test('refreshQuotas still checks all accounts during startup', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: true, reason: 'ok' }),
  ];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 25, reset_at: 1713350000 },
        secondary_window: { used_percent: 40, reset_at: 1713360000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 30, reset_at: 1713351000 },
        secondary_window: { used_percent: 35, reset_at: 1713361000 },
      },
    },
  ]);
  const { manager } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('startup');

  assert.equal(quotaResponses.getCallCount(), 2);
  assert.equal(configs[0].runtime.lastCheckedAt, 1713337200000);
  assert.equal(configs[1].runtime.lastCheckedAt, 1713337200000);
});

test('refreshQuotas checks every token account during an all-account poll', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: false, reason: 'quota_check_failed' }),
    createConfig(2, { available: false, reason: 'quota_check_failed' }),
  ];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 25, reset_at: 1713350000 },
        secondary_window: { used_percent: 40, reset_at: 1713360000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 35, reset_at: 1713351000 },
        secondary_window: { used_percent: 45, reset_at: 1713361000 },
      },
    },
    {
      rate_limit: {
        allowed: false,
        limit_reached: false,
        primary_window: { used_percent: 50, reset_at: 1713352000 },
        secondary_window: { used_percent: 55, reset_at: 1713362000 },
      },
    },
  ]);
  const { manager, warnings, logs } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('all_poll');

  assert.equal(quotaResponses.getCallCount(), 3);
  assert.deepEqual(
    quotaResponses.getCalls().map(call => call.headers['chatgpt-account-id']),
    ['account-0', 'account-1', 'account-2'],
  );
  assert.equal(configs[1].runtime.available, true);
  assert.equal(configs[1].runtime.reason, 'ok');
  assert.equal(configs[1].runtime.lastCheckedAt, 1713337200000);
  assert.equal(configs[2].runtime.available, false);
  assert.equal(configs[2].runtime.reason, 'rate_limit_not_allowed');
  assert.equal(configs[2].runtime.lastCheckedAt, 1713337200000);
  assert.match(logs[0], /轮询额度: #1 account-1 \| 可用=是/);
});

test('refreshQuotas skips apikey configs during poll', async () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
    }),
  ];
  const calls = [];
  const { manager } = createManager(configs, {
    requestBufferedFn: async () => {
      calls.push('called');
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ object: 'list', data: [] }),
      };
    },
  });

  await manager.refreshQuotas('poll');

  assert.deepEqual(calls, []);
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'apikey');
  assert.equal(configs[0].runtime.lastCheckedAt, null);
});

test('refreshQuotas recovers unavailable apikey configs during an all-account poll', async () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://ready.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-ready',
      support: ['gpt'],
    }),
    createConfig(1, {
      available: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
    }, {
      type: 'apikey',
      baseUrl: 'https://recover.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-recover',
      support: ['gpt'],
    }),
    createConfig(2, {
      available: false,
      reason: 'apikey_auth_failed',
      lastError: 'http:401',
    }, {
      type: 'apikey',
      baseUrl: 'https://blocked.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-blocked',
      support: ['gpt'],
    }),
    createConfig(3, {
      available: false,
      reason: 'apikey_rate_limited',
      lastError: 'http:429',
    }, {
      type: 'apikey',
      baseUrl: 'https://claude.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-claude',
      support: ['claude'],
    }),
  ];
  const calls = [];
  const { manager, warnings } = createManager(configs, {
    requestBufferedFn: async requestOptions => {
      calls.push(requestOptions);
      return {
        statusCode: calls.length === 1 ? 200 : 429,
        bodyText: JSON.stringify({ id: 'resp_1', output_text: 'hello' }),
      };
    },
  });

  await manager.refreshQuotas('all_poll');

  assert.deepEqual(
    calls.map(call => call.targetUrl),
    [
      'https://recover.example.com/v1/responses',
      'https://blocked.example.com/v1/responses',
    ],
  );
  assert.deepEqual(
    calls.map(call => call.headers.authorization),
    ['Bearer sk-recover', 'Bearer sk-blocked'],
  );
  assert.deepEqual(
    calls.map(call => JSON.parse(call.body.toString('utf8'))),
    [
      { model: 'gpt-5.5', input: 'hello', stream: false },
      { model: 'gpt-5.5', input: 'hello', stream: false },
    ],
  );
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.lastCheckedAt, null);
  assert.equal(configs[1].runtime.available, true);
  assert.equal(configs[1].runtime.reason, 'apikey');
  assert.equal(configs[1].runtime.lastError, null);
  assert.equal(configs[1].runtime.lastCheckedAt, 1713337200000);
  assert.deepEqual(manager.getAccountStatus(configs[1]).apiKeyRecovery, {
    enabled: true,
    pending: false,
    intervalMs: 10 * 60 * 1000,
    lastCheckedAt: 1713337200000,
    result: 'success',
    statusCode: 200,
    reason: 'apikey',
    lastError: null,
    model: 'gpt-5.5',
  });
  assert.equal(configs[2].runtime.available, false);
  assert.equal(configs[2].runtime.reason, 'apikey_rate_limited');
  assert.equal(configs[2].runtime.lastError, 'http:429');
  assert.equal(configs[2].runtime.lastCheckedAt, 1713337200000);
  assert.deepEqual(manager.getAccountStatus(configs[2]).apiKeyRecovery, {
    enabled: true,
    pending: true,
    intervalMs: 10 * 60 * 1000,
    lastCheckedAt: 1713337200000,
    result: 'failed',
    statusCode: 429,
    reason: 'apikey_rate_limited',
    lastError: 'http:429',
    model: 'gpt-5.5',
  });
  assert.equal(configs[3].runtime.available, false);
  assert.equal(configs[3].runtime.lastCheckedAt, null);
  assert.equal(manager.getAccountStatus(configs[3]).apiKeyRecovery.enabled, false);
  assert.equal(warnings.some(line => /API Key 恢复可用: #2 account-2/.test(line)), true);
});

test('ensureActiveConfig keeps an earlier apikey ahead of a later token config', () => {
  const configs = [
    createConfig(0, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
    }),
    createConfig(1),
  ];
  const { manager } = createManager(configs, {
    initialActiveConfigIndex: 0,
  });

  const selected = manager.ensureActiveConfig('select');

  assert.equal(selected.index, 0);
  assert.equal(manager.getActiveConfig().index, 0);
});

test('refreshQuotas checks token configs during a minute poll when the current config is apikey', async () => {
  const configs = [
    createConfig(0, { available: false, reason: 'quota_check_failed' }),
    createConfig(1, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-1',
    }),
  ];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 10, reset_at: 1713350000 },
        secondary_window: { used_percent: 20, reset_at: 1713360000 },
      },
    },
  ]);
  const { manager } = createManager(configs, {
    initialActiveConfigIndex: 1,
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('poll');

  assert.equal(quotaResponses.getCallCount(), 1);
  assert.equal(manager.getActiveConfig().index, 1);
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[1].runtime.available, true);
});

test('refreshQuotas checks all token accounts and selects the first recovered account during an all-account poll', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: false, reason: 'quota_check_failed' }),
    createConfig(2, { available: false, reason: 'quota_check_failed' }),
  ];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 98, reset_at: 1713350000 },
        secondary_window: { used_percent: 40, reset_at: 1713360000 },
      },
    },
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 20, reset_at: 1713351000 },
        secondary_window: { used_percent: 30, reset_at: 1713361000 },
      },
    },
    {
      rate_limit: {
        allowed: false,
        limit_reached: false,
        primary_window: { used_percent: 85, reset_at: 1713352000 },
        secondary_window: { used_percent: 35, reset_at: 1713362000 },
      },
    },
  ]);
  const { manager, warnings, logs } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('all_poll');

  assert.equal(quotaResponses.getCallCount(), 3);
  assert.deepEqual(
    quotaResponses.getCalls().map(call => call.headers['chatgpt-account-id']),
    ['account-0', 'account-1', 'account-2'],
  );
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'remaining_below_3%');
  assert.equal(configs[1].runtime.available, true);
  assert.equal(configs[1].runtime.reason, 'ok');
  assert.equal(configs[2].runtime.available, false);
  assert.equal(configs[2].runtime.reason, 'rate_limit_not_allowed');
  assert.equal(warnings.some(line => /账号不可用: #1 account-1 \(remaining_below_3%\)/.test(line)), true);
  assert.equal(warnings.some(line => /账号恢复可用: #2 account-2 \(remaining=80%\)/.test(line)), true);
  assert.equal(warnings.some(line => /账号切换: #1 account-1 -> #2 account-2 \(all_poll\)/.test(line)), true);
  assert.match(logs[0], /轮询额度: #2 account-2 \| 可用=是/);
});

test('refreshQuotas keeps using apikey fallback when all token accounts are unavailable during an all-account poll', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
    createConfig(1, { available: false, reason: 'quota_check_failed' }),
    createConfig(2, { available: false, reason: 'quota_check_failed' }),
    createConfig(3, { reason: 'apikey' }, {
      type: 'apikey',
      baseUrl: 'https://api.example.com/v1',
      apiBasePath: '',
      apiKey: 'sk-3',
    }),
  ];
  const quotaResponses = createBufferedRequestRecorder([
    {
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 98, reset_at: 1713350000 },
        secondary_window: { used_percent: 40, reset_at: 1713360000 },
      },
    },
    {
      rate_limit: {
        allowed: false,
        limit_reached: false,
        primary_window: { used_percent: 20, reset_at: 1713351000 },
        secondary_window: { used_percent: 30, reset_at: 1713361000 },
      },
    },
    {
      rate_limit: {
        allowed: false,
        limit_reached: false,
        primary_window: { used_percent: 25, reset_at: 1713352000 },
        secondary_window: { used_percent: 35, reset_at: 1713362000 },
      },
    },
    {
      object: 'list',
      data: [],
    },
  ]);
  const { manager, warnings, logs } = createManager(configs, {
    initialActiveConfigIndex: 3,
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('all_poll');

  assert.equal(quotaResponses.getCallCount(), 3);
  assert.deepEqual(
    quotaResponses.getCalls().map(call => call.headers['chatgpt-account-id']),
    ['account-0', 'account-1', 'account-2'],
  );
  assert.equal(manager.getActiveConfig(), configs[3]);
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[1].runtime.available, false);
  assert.equal(configs[2].runtime.available, false);
  assert.equal(configs[3].runtime.available, true);
  assert.equal(warnings.some(line => /账号不可用: #1 account-1 \(remaining_below_3%\)/.test(line)), true);
  assert.equal(warnings.some(line => /没有可用账号/.test(line)), false);
  assert.match(logs[0], /轮询额度: #4 account-4 \| 可用=是/);
});

test('refreshQuotas releases the monitor lock after a quota timeout', async () => {
  const configs = [
    createConfig(0, { available: true, reason: 'ok' }),
  ];
  let shouldHang = true;
  const calls = [];
  const requestBufferedFn = requestOptions => {
    calls.push(requestOptions);

    if (shouldHang) {
      return new Promise(() => {});
    }

    return Promise.resolve({
      statusCode: 200,
      bodyText: JSON.stringify({
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: { used_percent: 20, reset_at: 1713350000 },
          secondary_window: { used_percent: 30, reset_at: 1713360000 },
        },
      }),
    });
  };
  const { manager } = createManager(configs, {
    quotaCheckTimeoutMs: 30,
    requestBufferedFn,
  });

  await manager.refreshQuotas('poll');

  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.quotaCheckFailures, 1);
  assert.match(configs[0].runtime.lastError, /quota check timeout after 30ms/);
  assert.equal(calls[0].timeoutMs, 30);

  shouldHang = false;
  await manager.refreshQuotas('poll');

  assert.equal(calls.length, 2);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.available, true);
  assert.equal(configs[0].runtime.quotaCheckFailures, 0);
});
