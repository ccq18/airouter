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
    quotaCheckIntervalMs: 60 * 1000,
    minRemainingPercent: 3,
    buildAuthHeadersForConfig: config => ({
      authorization: `Bearer ${config.access_token}`,
      'chatgpt-account-id': config.account_id,
    }),
    requestBufferedFn: overrides.requestBufferedFn,
    shouldUseQuotaMonitoring: type => type === 'token',
    refreshTokenFn: overrides.refreshTokenFn,
    persistTokenRefreshFn: overrides.persistTokenRefreshFn,
    log: (...args) => logs.push(args.join(' ')),
    warn: (...args) => warnings.push(args.join(' ')),
    now: () => 1713337200000,
  });

  return { manager, logs, warnings };
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

test('ensureActiveConfig can switch away after a manual activation', () => {
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

  assert.equal(selected, configs[0]);
  assert.equal(manager.getActiveConfig(), configs[0]);
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
  assert.equal(status.summaryLine, `${status.label} | ${status.runtimeSummary}`);
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

test('refreshQuotas logs the active account summary after a poll', async () => {
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
  assert.equal(configs[1].runtime.lastCheckedAt, 1713337200000);
  assert.equal(quotaResponses.getCalls()[0].timeoutMs, 10 * 1000);
  assert.match(logs[0], /轮询额度: #1 account-1 \| 可用=是/);
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

test('refreshQuotas switches away from the active account when the quota check fails', async () => {
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
  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'quota_check_failed');
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.equal(warnings.some(line => /账号不可用: #1 account-1 \(quota_check_failed: network down\)/.test(line)), true);
  assert.equal(warnings.some(line => /账号恢复可用: #2 account-2 \(remaining=75%\)/.test(line)), true);
  assert.equal(warnings.some(line => /账号切换: #1 account-1 -> #2 account-2 \(poll\)/.test(line)), true);
  assert.match(logs[0], /轮询额度: #2 account-2 \| 可用=是/);
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

test('refreshQuotas checks every token account during poll', async () => {
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

  await manager.refreshQuotas('poll');

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

test('ensureActiveConfig prefers an available token config over an available apikey config', () => {
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

  assert.equal(selected.index, 1);
});

test('refreshQuotas switches back from apikey fallback when a token account is available', async () => {
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
  assert.equal(manager.getActiveConfig().index, 0);
});

test('refreshQuotas checks all token accounts and selects the first recovered account', async () => {
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

  await manager.refreshQuotas('poll');

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
  assert.equal(warnings.some(line => /账号切换: #1 account-1 -> #2 account-2 \(poll\)/.test(line)), true);
  assert.match(logs[0], /轮询额度: #2 account-2 \| 可用=是/);
});

test('refreshQuotas keeps using apikey fallback when all token accounts are unavailable', async () => {
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
  ]);
  const { manager, warnings, logs } = createManager(configs, {
    initialActiveConfigIndex: 3,
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('poll');

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

  assert.equal(configs[0].runtime.available, false);
  assert.equal(configs[0].runtime.reason, 'quota_check_failed');
  assert.match(configs[0].runtime.lastError, /quota check timeout after 30ms/);
  assert.equal(calls[0].timeoutMs, 30);

  shouldHang = false;
  await manager.refreshQuotas('poll');

  assert.equal(calls.length, 2);
  assert.equal(configs[0].runtime.reason, 'ok');
  assert.equal(configs[0].runtime.available, true);
});
