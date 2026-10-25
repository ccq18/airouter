const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeResponsesRequestBody } = require('../app/responses-defaults');
const { createRoutingContextStore } = require('../app/model-router');

test('ordinary Responses preserves omitted storage and parallel defaults instead of injecting token-specific values', () => {
  const input = { model: 'native', input: [{ role: 'user', content: 'hello' }], prompt_cache_key: 'private-cache-scope', prompt_cache_retention: '24h' };
  const body = normalizeResponsesRequestBody('/v1/responses', input);
  assert.deepEqual(body, input);
  assert.equal(normalizeResponsesRequestBody('/v1/responses', input, { forceStoreFalse: true }).store, false);
});

test('context generations prevent late account and A-to-B-to-A target bindings from reviving', () => {
  const store = createRoutingContextStore();
  const details = { config_id: 'account', target_id: 'target', protocol: 'responses', public_model: 'public', model: 'backend-a', auth_hash: 'caller' };
  const parsed = model => ({ routing: { models: [{ id: 'public', enabled: true, entry_protocols: ['responses'], targets: [{ id: 'target', config_id: 'account', protocol: 'responses', model }] }] } });
  store.syncRoutes(parsed('backend-a'));
  const initial = store.getEpoch(details.config_id, details.public_model, details.target_id);
  store.bind('resp_old', { ...details, expected_epoch: initial });
  store.forgetConfig('account');
  store.bind('resp_late', { ...details, expected_epoch: initial });
  assert.equal(store.resolve('resp_late'), null);
  const afterAccount = store.getEpoch(details.config_id, details.public_model, details.target_id);
  store.syncRoutes(parsed('backend-b')); store.syncRoutes(parsed('backend-a'));
  store.bind('resp_late_target', { ...details, expected_epoch: afterAccount });
  assert.equal(store.resolve('resp_late_target'), null);
  assert.equal(store.resolve('resp_old'), null);
  store.bind('resp_new', { ...details, expected_epoch: store.getEpoch(details.config_id, details.public_model, details.target_id) });
  assert.equal(store.resolve('resp_new').model, 'backend-a');
});
