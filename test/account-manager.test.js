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

function createConfig(index, runtimeOverrides = {}) {
  return {
    type: 'token',
    index,
    description: `account-${index + 1}`,
    baseUrl: 'https://chatgpt.com',
    apiBasePath: '/backend-api/codex',
    access_token: `token-${index}`,
    account_id: `account-${index}`,
    runtime: createRuntime(runtimeOverrides),
  };
}

function createBufferedRequestRecorder(bodies) {
  let currentIndex = 0;
  let callCount = 0;

  return {
    requestBuffered() {
      if (currentIndex >= bodies.length) {
        throw new Error(`unexpected buffered request call ${currentIndex + 1}`);
      }

      callCount += 1;
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
    quotaCheckIntervalMs: 60 * 1000,
    minRemainingPercent: 3,
    buildAuthHeadersForConfig: config => ({
      authorization: `Bearer ${config.access_token}`,
      'chatgpt-account-id': config.account_id,
    }),
    requestBufferedFn: overrides.requestBufferedFn,
    shouldUseQuotaMonitoring: type => type === 'token',
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

test('account manager does not expose internal helper methods', () => {
  const { manager } = createManager([createConfig(0)]);

  assert.equal(manager.selectConfig, undefined);
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
  ]);
  const { manager, logs } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('poll');

  assert.equal(quotaResponses.getCallCount(), 1);
  assert.equal(configs[1].runtime.lastCheckedAt, null);
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
  ]);
  const { manager, warnings, logs } = createManager(configs, {
    requestBufferedFn: quotaResponses.requestBuffered,
  });

  await manager.refreshQuotas('poll');

  assert.equal(quotaResponses.getCallCount(), 1);
  assert.equal(manager.getActiveConfig(), configs[1]);
  assert.match(warnings[0], /账号不可用: #1 account-1 \(remaining_below_3%\)/);
  assert.match(warnings[1], /账号切换: #1 account-1 -> #2 account-2 \(poll\)/);
  assert.match(logs[0], /轮询额度: #2 account-2 \| 可用=是/);
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
