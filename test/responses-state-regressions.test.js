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

function reasoningRoute(model = 'backend-a', entries = ['responses', 'chat_completions', 'messages']) {
  return { routing: { models: [{ id: 'public', enabled: true, entry_protocols: entries,
    targets: [{ id: 'target', config_id: 'account', protocol: 'responses', model }] }] } };
}
function reasoningDetails(store, extra = {}) {
  return { config_id: 'account', target_id: 'target', protocol: 'responses', model: 'backend-a',
    public_model: 'public', entry_protocol: 'messages', auth_hash: 'caller',
    part: { type: 'reasoning', encrypted_content: 'fixture-ciphertext', summary: [] },
    viewHash: 'view-hash', prefixHash: 'prefix-hash', pool_fingerprint: 'pool-identity',
    expected_epoch: store.getEpoch('account', 'public', 'target'), ...extra };
}

test('reasoning transports are random, isolated from response/native namespaces and defensively copied', () => {
  const store = createRoutingContextStore(); store.syncRoutes(reasoningRoute());
  const details = reasoningDetails(store);
  const records = Array.from({ length: 32 }, () => store.issueReasoning(details));
  assert.equal(new Set(records.map(record => record.token)).size, 32);
  for (const record of records) assert.match(record.token, /^airouter-state-v1:[A-Za-z0-9_-]{43}$/);
  const first = records[0]; assert.equal(first.id, first.token);
  assert.equal(store.resolve(first.token), null, 'transport does not claim server response storage');
  assert.equal(store.size, 0, 'transport state must not change server response binding count');
  const nativePart = { type: 'reasoning', encrypted_content: 'different-native-fixture' };
  store.registerNativeReasoning(first.token, reasoningDetails(store, { part: nativePart }));
  assert.deepEqual(store.resolveReasoning(first.token).part, details.part);
  assert.deepEqual(store.resolveNativeReasoning(first.token).part, nativePart);
  assert.equal(store.resolveNativeReasoning('not-issued'), null);
  assert.equal(store.resolveReasoning('airouter-state-v1:not-issued'), null);
  details.part.encrypted_content = 'mutated input'; first.part.encrypted_content = 'mutated return';
  const resolved = store.resolveReasoning(first.token);
  assert.equal(resolved.part.encrypted_content, 'fixture-ciphertext'); resolved.part.encrypted_content = 'mutated resolve';
  assert.equal(store.resolveReasoning(first.token).part.encrypted_content, 'fixture-ciphertext');
  assert.equal(resolved.auth_hash, 'caller'); assert.equal(resolved.public_model, 'public');
  assert.equal(resolved.entry_protocol, 'messages'); assert.equal(resolved.viewHash, 'view-hash');
  assert.equal(resolved.prefixHash, 'prefix-hash'); assert.equal(resolved.pool_fingerprint, 'pool-identity');
});

test('reasoning transports expire and cannot resume after clear or process restart', () => {
  let now = 1000;
  const store = createRoutingContextStore({ now: () => now, ttlMs: 1000 }); store.syncRoutes(reasoningRoute());
  const record = store.issueReasoning(reasoningDetails(store));
  store.registerNativeReasoning('native-fixture', reasoningDetails(store));
  assert.equal(record.created_at, 1000); assert.equal(record.expiresAt, 2000);
  assert.ok(store.resolveReasoning(record.token)); assert.ok(store.resolveNativeReasoning('native-fixture'));
  now = 2000;
  assert.equal(store.resolveReasoning(record.token), null); assert.equal(store.resolveNativeReasoning('native-fixture'), null);
  const fresh = store.issueReasoning(reasoningDetails(store));
  assert.equal(createRoutingContextStore().resolveReasoning(fresh.token), null);
  const oldEpoch = fresh.expected_epoch; store.clear();
  assert.equal(store.resolveReasoning(fresh.token), null);
  assert.equal(store.issueReasoning(reasoningDetails(store, { expected_epoch: oldEpoch })), null);
});

test('reasoning account, target and all entry-protocol generations reject old and late A-B-A state', () => {
  const store = createRoutingContextStore(); store.syncRoutes(reasoningRoute());
  const initial = reasoningDetails(store), old = store.issueReasoning(initial);
  store.registerNativeReasoning('native-old', initial);
  store.forgetConfig('account');
  assert.equal(store.resolveReasoning(old.token), null); assert.equal(store.resolveNativeReasoning('native-old'), null);
  assert.equal(store.issueReasoning(initial), null); assert.equal(store.registerNativeReasoning('late-account', initial), null);
  const beforeRoute = reasoningDetails(store), routeRecord = store.issueReasoning(beforeRoute);
  store.syncRoutes(reasoningRoute('backend-b')); store.syncRoutes(reasoningRoute());
  assert.equal(store.resolveReasoning(routeRecord.token), null);
  assert.equal(store.issueReasoning(beforeRoute), null); assert.equal(store.registerNativeReasoning('late-route', beforeRoute), null);
  const beforeEntry = reasoningDetails(store), entryRecord = store.issueReasoning(beforeEntry);
  store.syncRoutes(reasoningRoute('backend-a', ['responses', 'chat_completions']));
  store.syncRoutes(reasoningRoute());
  assert.equal(store.resolveReasoning(entryRecord.token), null);
  assert.equal(store.issueReasoning(beforeEntry), null);
  const current = store.issueReasoning(reasoningDetails(store));
  store.syncRoutes(reasoningRoute('backend-a', ['messages', 'responses', 'chat_completions']));
  assert.ok(store.resolveReasoning(current.token), 'entry order alone does not change the accepted protocol set');
});

test('reasoning storage is bounded across native and issued tokens without changing server bindings', () => {
  const store = createRoutingContextStore({ reasoningMaxEntries: 2, reasoningMaxBytes: 8000 }); store.syncRoutes(reasoningRoute());
  store.bind('resp-server', { config_id: 'account', target_id: 'target', model: 'backend-a', protocol: 'responses', public_model: 'public' });
  const first = store.issueReasoning(reasoningDetails(store));
  store.registerNativeReasoning('native-second', reasoningDetails(store));
  const third = store.issueReasoning(reasoningDetails(store));
  assert.equal(store.resolveReasoning(first.token), null, 'oldest transport is evicted at the shared entry bound');
  assert.ok(store.resolveNativeReasoning('native-second')); assert.ok(store.resolveReasoning(third.token));
  assert.equal(store.issueReasoning(reasoningDetails(store, { part: { encrypted_content: '🙂'.repeat(4000) } })), null);
  assert.ok(store.resolveNativeReasoning('native-second'), 'oversized new records do not evict valid records');
  assert.ok(store.resolveReasoning(third.token)); assert.equal(store.size, 1); assert.ok(store.resolve('resp-server'));
});

test('pending reasoning tokens remain unusable until a valid current completion activates them', () => {
  const store = createRoutingContextStore(); store.syncRoutes(reasoningRoute());
  const details = reasoningDetails(store, { pending: true });
  const pending = store.issueReasoning(details);
  assert.match(pending.token, /^airouter-state-v1:/); assert.equal(store.resolveReasoning(pending.token), null);
  const active = store.activateReasoning(pending.token); assert.ok(active); assert.equal(active.pending, false);
  assert.equal(store.resolveReasoning(pending.token).part.encrypted_content, 'fixture-ciphertext');
  assert.deepEqual(store.activateReasoning(pending.token), active, 'activation does not reset TTL or duplicate records');
  const late = store.issueReasoning(reasoningDetails(store, { pending: true }));
  store.forgetConfig('account');
  assert.equal(store.activateReasoning(late.token), null); assert.equal(store.resolveReasoning(late.token), null);
  assert.equal(store.activateReasoning('airouter-state-v1:not-issued'), null); assert.equal(store.size, 0);
});
