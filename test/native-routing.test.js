const test = require('node:test'), assert = require('node:assert/strict');
const { createModelRouter, createRoutingHealthStore, createRoutingContextStore } = require('../app/model-router');
const { parseRoutingConfig } = require('../app/routing-config');
const protocols = ['chat_completions', 'responses', 'messages'];
function fixture() {
  const parsed = { configs: [{ id: 'upstream', type: 'apikey', preset: 'custom', base_url: 'https://upstream.invalid', apikey: 'fixture', models: [{ id: 'chat-only', protocols: ['chat_completions'] }, { id: 'multi', protocols }] }], routing: { models: [{ id: 'ordinary', entry_protocols: protocols, targets: [{ id: 'first', config_id: 'upstream', model: 'chat-only', protocol: 'chat_completions' }, { id: 'second', config_id: 'upstream', model: 'multi', protocol: 'chat_completions' }] }] } };
  const healthStore = createRoutingHealthStore();
  const router = createModelRouter({ parsed, runtimeConfigs: [{ ...parsed.configs[0], apiKey: 'fixture', baseUrl: 'https://upstream.invalid' }], healthStore });
  return { parsed, router, healthStore };
}
test('native route candidates require account/model and no fixed protocol', () => {
  const { parsed } = fixture(); for (const target of parsed.routing.models[0].targets) delete target.protocol;
  const result = parseRoutingConfig(parsed); assert.equal(result.models[0].targets.length, 2);
  assert.ok(result.models[0].targets.every(target => !Object.hasOwn(target, 'protocol')));
});
test('native candidate matching skips unsupported entries and derives actual protocol per request', () => {
  const { router } = fixture();
  const chat = router.select('ordinary', 'chat_completions'); assert.equal(chat.lease.target.id, 'first'); assert.equal(chat.lease.target.protocol, 'chat_completions'); chat.lease.release();
  for (const protocol of ['responses', 'messages']) { const selected = router.select('ordinary', protocol); assert.equal(selected.lease.target.id, 'second'); assert.equal(selected.lease.target.protocol, protocol); assert.equal(selected.skipped[0].reason, 'native_protocol_unsupported'); selected.lease.release(); }
});
test('one native account/model candidate cannot be duplicated by obsolete protocol choices', () => {
  const { parsed } = fixture(); parsed.routing.models[0].targets = [{ id: 'a', config_id: 'upstream', model: 'multi', protocol: 'chat_completions' }, { id: 'b', config_id: 'upstream', model: 'multi', protocol: 'messages' }];
  assert.throws(() => parseRoutingConfig(parsed), /重复候选/);
});
test('changing the supported protocol set invalidates native contexts monotonically', () => {
  const { parsed } = fixture(), store = createRoutingContextStore(); store.syncRoutes(parsed);
  const old = store.getEpoch('upstream', 'ordinary', 'second');
  parsed.configs[0].models[1].protocols = ['chat_completions']; store.syncRoutes(parsed);
  const removed = store.getEpoch('upstream', 'ordinary', 'second'); assert.notEqual(old, removed);
  parsed.configs[0].models[1].protocols = [...protocols]; store.syncRoutes(parsed); assert.notEqual(store.getEpoch('upstream', 'ordinary', 'second'), old);
});
