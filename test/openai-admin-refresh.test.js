const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EventEmitter } = require('node:events');

const {
  activateConfigAdminResponse,
  openExternalUrl,
  refreshConfigAdminResponse,
  refreshConfigTokenAdminResponse,
  reportBusinessRequestError,
  registerProcessSafetyHandlers,
  selectReloadedActiveConfig,
  serializeAccountStatus,
} = require('../openai');

test('refreshConfigAdminResponse refreshes all quotas before building the admin snapshot in token mode', async () => {
  const calls = [];
  const manager = {
    refreshQuotas: async reason => {
      calls.push(reason);
    },
  };
  const expectedResponse = {
    mode: 'token',
    configs: [],
  };

  const response = await refreshConfigAdminResponse({
    accountManager: manager,
    shouldRefreshQuota: true,
    buildResponse: () => expectedResponse,
  });

  assert.deepEqual(calls, ['admin_refresh']);
  assert.equal(response, expectedResponse);
});

test('refreshConfigAdminResponse skips quota refresh when no token configs exist', async () => {
  let called = false;
  const manager = {
    refreshQuotas: async () => {
      called = true;
    },
  };
  const expectedResponse = {
    mode: 'apikey',
    configs: [],
  };

  const response = await refreshConfigAdminResponse({
    accountManager: manager,
    shouldRefreshQuota: false,
    buildResponse: () => expectedResponse,
  });

  assert.equal(called, false);
  assert.equal(response, expectedResponse);
});

test('serializeAccountStatus includes apikey recovery probe observability', () => {
  assert.deepEqual(
    serializeAccountStatus({
      index: 1,
      description: 'gpt key',
      label: '#2 gpt key',
      available: false,
      remainingPercent: null,
      primaryRemainingPercent: null,
      primaryResetAt: null,
      primaryResetAfterSeconds: null,
      secondaryRemainingPercent: null,
      secondaryResetAt: null,
      secondaryResetAfterSeconds: null,
      lastCheckedAt: 1713337200000,
      reason: 'apikey_rate_limited',
      quotaCheckFailures: null,
      apiKeyRequestWindow: {
        failureCount: 3,
        sampleSize: 5,
        failureThreshold: 3,
        windowSize: 10,
        sampleTtlMs: 1800000,
      },
      apiKeyRecovery: {
        enabled: true,
        pending: true,
        intervalMs: 180000,
        lastCheckedAt: 1713337200000,
        result: 'failed',
        statusCode: 429,
        reason: 'apikey_rate_limited',
        lastError: 'http:429',
        model: 'gpt-5.5',
      },
      inFlight: null,
      dispatchSession: null,
      responseModel: null,
      runtimeSummary: '可用=否 | 状态=API Key 被限流',
      summaryLine: '#2 gpt key | 可用=否 | 状态=API Key 被限流',
    }).api_key_recovery,
    {
      enabled: true,
      pending: true,
      interval_ms: 180000,
      last_checked_at: 1713337200000,
      result: 'failed',
      status_code: 429,
      reason: 'apikey_rate_limited',
      last_error: 'http:429',
      model: 'gpt-5.5',
    },
  );
});

test('activateConfigAdminResponse switches the active runtime config without refreshing quotas', async () => {
  const calls = [];
  const manager = {
    activateConfig: (index, reason) => {
      calls.push(['activate', index, reason]);
    },
    refreshQuotas: async reason => {
      calls.push(['refresh', reason]);
    },
  };
  const expectedResponse = {
    active_config_index: 1,
  };

  const response = await activateConfigAdminResponse(1, {
    accountManager: manager,
    buildResponse: () => expectedResponse,
  });

  assert.deepEqual(calls, [['activate', 1, 'admin_manual_activate']]);
  assert.equal(response, expectedResponse);
});

test('selectReloadedActiveConfig preserves active config during reorder reloads', () => {
  const calls = [];
  const activeConfig = {
    index: 2,
    runtime: {
      available: false,
    },
  };
  const manager = {
    getActiveConfig: () => {
      calls.push('getActiveConfig');
      return activeConfig;
    },
    ensureActiveConfig: reason => {
      calls.push(['ensureActiveConfig', reason]);
      return {
        index: 0,
      };
    },
  };

  const selected = selectReloadedActiveConfig(manager, 'admin_move_config', {
    preserveActiveConfig: true,
  });

  assert.equal(selected, activeConfig);
  assert.deepEqual(calls, ['getActiveConfig']);
});

test('activateConfigAdminResponse activates the first config without rewriting the file', async () => {
  const calls = [];
  const manager = {
    activateConfig: (index, reason) => {
      calls.push(['activate', index, reason]);
    },
  };
  const response = await activateConfigAdminResponse(0, {
    accountManager: manager,
    readParsedConfigFile: () => {
      calls.push('read');
      return { configs: [] };
    },
    persistAndReloadConfig: async () => {
      calls.push('persist');
    },
    buildResponse: () => ({ active_config_index: 0 }),
  });

  assert.deepEqual(calls, [['activate', 0, 'admin_manual_activate']]);
  assert.deepEqual(response, { active_config_index: 0 });
});

test('admin reorder route moves the selected config to the top', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/admin/api/configs/:index/move-up'");
  const routeEnd = source.indexOf("app.post('/admin/api/configs/:index/move-previous'", routeStart);
  const routeSource = routeStart >= 0 && routeEnd > routeStart
    ? source.slice(routeStart, routeEnd)
    : '';

  assert.match(routeSource, /moveConfigItem\(parsed,\s*targetIndex,\s*0\)/);
  assert.match(routeSource, /readParsedConfigFile\(CONFIG_FILE,\s*\{\s*validate:\s*false\s*\}\)/);
  assert.match(routeSource, /persistMovedConfigItem\(/);
  assert.match(routeSource, /moved_from:\s*movedFrom/);
  assert.match(routeSource, /moved_to:\s*0/);
  assert.doesNotMatch(routeSource, /handleConfigMutation/);
  assert.doesNotMatch(routeSource, /persistAndReloadConfig/);
  assert.doesNotMatch(routeSource, /accountManager\.activateConfig\(0,\s*'admin_move_config'\)/);
});

test('admin adjacent reorder routes swap configs with neighbors', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/admin/api/configs/:index/move-previous'");
  const routeEnd = source.indexOf("app.post('/admin/api/configs/:index/disable'", routeStart);
  const routeSource = routeStart >= 0 && routeEnd > routeStart
    ? source.slice(routeStart, routeEnd)
    : '';

  assert.match(routeSource, /app\.post\('\/admin\/api\/configs\/:index\/move-previous'/);
  assert.match(routeSource, /app\.post\('\/admin\/api\/configs\/:index\/move-next'/);
  assert.match(routeSource, /moveConfigItem\(parsed,\s*targetIndex,\s*targetIndex - 1\)/);
  assert.match(routeSource, /moveConfigItem\(parsed,\s*targetIndex,\s*targetIndex \+ 1\)/);
  assert.match(routeSource, /persistMovedConfigItem\(/);
  assert.match(routeSource, /readParsedConfigFile\(CONFIG_FILE,\s*\{\s*validate:\s*false\s*\}\)/);
  assert.doesNotMatch(routeSource, /persistAndReloadConfig/);
});

test('admin create route appends configs without pre-validating runtime configs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');
  const routeStart = source.indexOf("app.post('/admin/api/configs',");
  const routeEnd = source.indexOf("app.post('/admin/api/apikeys'", routeStart);
  const routeSource = routeStart >= 0 && routeEnd > routeStart
    ? source.slice(routeStart, routeEnd)
    : '';

  assert.match(routeSource, /readParsedConfigFile\(CONFIG_FILE,\s*\{\s*validate:\s*false\s*\}\)/);
  assert.match(routeSource, /persistAppendedConfigItems\(/);
  assert.doesNotMatch(routeSource, /validateConfigItemBeforeAdd/);
  assert.doesNotMatch(routeSource, /persistAndReloadConfig/);
});

test('admin exposes batch delete routes for configs, disabled configs, and apikeys', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');

  assert.match(source, /app\.delete\('\/admin\/api\/configs\/batch-delete'/);
  assert.match(source, /app\.delete\('\/admin\/api\/disabled-configs\/batch-delete'/);
  assert.match(source, /app\.delete\('\/admin\/api\/apikeys\/batch-delete'/);
  assert.match(source, /deleteConfigItems\(/);
  assert.match(source, /deleteDisabledConfigItems\(/);
  assert.match(source, /function deleteApiKeys\(parsed, indexes\)/);
});

test('admin exposes batch enable and disable routes for configs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');

  assert.match(source, /app\.post\('\/admin\/api\/configs\/batch-disable'/);
  assert.match(source, /app\.post\('\/admin\/api\/disabled-configs\/batch-enable'/);
  assert.match(source, /disableConfigItems\(/);
  assert.match(source, /enableConfigItems\(/);
  assert.match(source, /moved_count:\s*Array\.isArray\(req\.body && req\.body\.indexes\)\s*\?\s*req\.body\.indexes\.length\s*:\s*0/);
});

test('admin batch delete routes respond with deleted counts on success', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'openai.js'), 'utf8');

  assert.match(source, /deleted_count:\s*Array\.isArray\(req\.body && req\.body\.indexes\)\s*\?\s*req\.body\.indexes\.length\s*:\s*0/);
  assert.match(source, /responseExtras:\s*\{\s*deleted_count:/);
});

test('refreshConfigTokenAdminResponse refreshes and persists a token config', async () => {
  const persisted = [];
  const response = await refreshConfigTokenAdminResponse(0, {
    configFile: '/tmp/openai.json',
    readParsedConfigFile: () => ({
      configs: [{
        access_token: 'old-access',
        refresh_token: 'old-refresh',
        client_id: 'old-client',
      }],
    }),
    refreshOpenAIToken: async payload => {
      assert.equal(payload.refreshToken, 'old-refresh');
      assert.equal(payload.clientId, 'old-client');
      return {
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        client_id: 'new-client',
      };
    },
    persistTokenRefreshForConfig: payload => {
      persisted.push(payload);
    },
    buildResponse: () => ({ ok: true }),
    timeoutMs: 1234,
  });

  assert.deepEqual(persisted, [{
    config: { index: 0 },
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    clientId: 'new-client',
  }]);
  assert.deepEqual(response, { ok: true });
});

test('refreshConfigTokenAdminResponse rejects configs without refresh_token', async () => {
  await assert.rejects(
    () => refreshConfigTokenAdminResponse(0, {
      configFile: '/tmp/openai.json',
      readParsedConfigFile: () => ({
        configs: [{
          access_token: 'old-access',
          account_id: 'account-1',
        }],
      }),
    }),
    /当前配置项没有 refresh_token/
  );
});

test('openExternalUrl reports opener spawn errors without leaving an unhandled child error', async () => {
  const child = new EventEmitter();
  const warnings = [];
  child.unref = () => {};

  await assert.rejects(
    async () => {
      const opened = openExternalUrl('https://chatgpt.com/api/auth/session', {
        platform: 'linux',
        spawnImpl: () => child,
        warn: (...args) => warnings.push(args.join(' ')),
      });

      child.emit('error', Object.assign(new Error('spawn xdg-open ENOENT'), {
        code: 'ENOENT',
        path: 'xdg-open',
      }));

      await opened;
    },
    /打开外部链接失败: spawn xdg-open ENOENT/
  );

  assert.deepEqual(warnings, ['打开外部链接失败: spawn xdg-open ENOENT']);
  assert.equal(child.listenerCount('error'), 0);
});

test('registerProcessSafetyHandlers logs business crashes without marking the process for exit', () => {
  const processLike = new EventEmitter();
  const errors = [];
  processLike.exitCode = undefined;

  const unregister = registerProcessSafetyHandlers({
    process: processLike,
    error: (...args) => errors.push(args.join(' ')),
  });

  processLike.emit('uncaughtException', new Error('route exploded'), 'uncaughtException');
  processLike.emit('unhandledRejection', new Error('async job exploded'), Promise.resolve());

  assert.equal(processLike.exitCode, undefined);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /业务异常已捕获，服务继续运行/);
  assert.match(errors[0], /route exploded/);
  assert.match(errors[1], /未处理的 Promise 异常已捕获，服务继续运行/);
  assert.match(errors[1], /async job exploded/);

  unregister();
  assert.equal(processLike.listenerCount('uncaughtException'), 0);
  assert.equal(processLike.listenerCount('unhandledRejection'), 0);
});

test('reportBusinessRequestError returns a controlled 500 response for unexpected business errors', () => {
  const responses = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      responses.push(payload);
      this.writableEnded = true;
      return this;
    },
  };

  reportBusinessRequestError(res, new Error('handler failed'), '测试业务请求失败', {
    error: () => {},
  });

  assert.equal(res.statusCode, 500);
  assert.deepEqual(responses, [{
    error: 'Internal Server Error',
    message: 'handler failed',
  }]);
});
