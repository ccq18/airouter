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

test('activateConfigAdminResponse promotes the selected config before activating it', async () => {
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
    active_config_index: 0,
  };

  const response = await activateConfigAdminResponse(1, {
    accountManager: manager,
    configFile: '/tmp/openai.json',
    readParsedConfigFile: configFile => {
      calls.push(['read', configFile]);
      return {
        configs: [
          { account_id: 'account-0', access_token: 'token-0' },
          { account_id: 'account-1', access_token: 'token-1' },
        ],
      };
    },
    moveConfigItem: (parsed, fromIndex, toIndex) => {
      calls.push(['move', fromIndex, toIndex]);
      return {
        ...parsed,
        configs: [parsed.configs[1], parsed.configs[0]],
      };
    },
    persistAndReloadConfig: async (nextParsed, reason, options) => {
      calls.push(['persist', nextParsed.configs[0].account_id, reason, options]);
    },
    buildResponse: () => expectedResponse,
  });

  assert.deepEqual(calls, [
    ['activate', 1, 'admin_manual_activate'],
    ['read', '/tmp/openai.json'],
    ['move', 1, 0],
    ['persist', 'account-1', 'admin_manual_activate', { skipQuotaRefresh: true, preserveActiveConfig: true }],
  ]);
  assert.equal(response, expectedResponse);
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
  const routeEnd = source.indexOf("app.post('/admin/api/configs/:index/refresh-token'", routeStart);
  const routeSource = routeStart >= 0 && routeEnd > routeStart
    ? source.slice(routeStart, routeEnd)
    : '';

  assert.match(routeSource, /moveConfigItem\(parsed,\s*targetIndex,\s*0\)/);
  assert.match(routeSource, /accountManager\.activateConfig\(0,\s*'admin_move_config'\)/);
  assert.doesNotMatch(routeSource, /preserveActiveConfig:\s*true/);
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
