const test = require('node:test');
const assert = require('node:assert/strict');

const { refreshConfigAdminResponse } = require('../openai');

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
    configType: 'token',
    buildResponse: () => expectedResponse,
  });

  assert.deepEqual(calls, ['admin_refresh']);
  assert.equal(response, expectedResponse);
});

test('refreshConfigAdminResponse skips quota refresh in api_key mode', async () => {
  let called = false;
  const manager = {
    refreshQuotas: async () => {
      called = true;
    },
  };
  const expectedResponse = {
    mode: 'api_key',
    configs: [],
  };

  const response = await refreshConfigAdminResponse({
    accountManager: manager,
    configType: 'api_key',
    buildResponse: () => expectedResponse,
  });

  assert.equal(called, false);
  assert.equal(response, expectedResponse);
});
