const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoutingContextStore } = require('../app/model-router');
const { createQuotaEngine } = require('../app/quota-engine');
const { createFreePoolEngine } = require('../app/free-pool-engine');
const { createReasoningSession, nativeKey } = require('../app/reasoning-transport');
const { parseSourceReasoning, renderReasoning } = require('../app/reasoning-content');
const { credentialContextInvalidations } = require('../app/credential-context');
const clone = value => JSON.parse(JSON.stringify(value));

function poolFixture() {
  let parsed = { configs: [{ id: 'source', type: 'apikey', preset: 'openrouter', apikey: 'credential-A' }, { id: 'pool', type: 'apikey', preset: 'openrouter-free', credential_ref: 'source' }], routing: { models: [{ id: 'ordinary-route', targets: [{ id: 'target', config_id: 'pool', model: 'free', protocol: 'chat_completions' }] }] } };
  const store = createRoutingContextStore(), quota = createQuotaEngine(), engine = createFreePoolEngine({ getParsedConfig: () => parsed });
  function apply(change = {}) {
    const previous = parsed.configs;
    parsed = { ...parsed, configs: parsed.configs.map(config => ({ ...config, ...(change[config.id] || {}) })) };
    const changed = credentialContextInvalidations(previous, parsed.configs, quota.syncConfigs(parsed.configs));
    for (const id of changed) store.forgetConfig(id);
    store.syncRoutes(parsed); engine.syncConfigs();
    return changed;
  }
  apply();
  const router = { getConfig: id => parsed.configs.find(config => config.id === id), poolEngine: engine };
  const route = parsed.routing.models[0], config = router.getConfig('pool'), fingerprint = engine.fingerprint(config);
  const initial = { input: [{ role: 'user', content: 'first' }] };
  const args = { store, router, route, entryProtocol: 'responses', authHash: 'caller', publicModel: route.id };
  const session = createReasoningSession({ ...args, body: initial }); session.inspect();
  const transport = session.forLease({ config, target: { ...route.targets[0], model: 'concrete-member' }, outerTargetId: 'target', pool: true, poolFingerprint: fingerprint, isCurrent: () => engine.isCurrent(config, fingerprint) });
  const reasoning = suffix => parseSourceReasoning('chat_completions', { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-' + suffix, format: 'openai-responses-v1' }] })[0];
  return { store, apply, transport, args, reasoning, initial, fingerprint: () => engine.fingerprint(router.getConfig('pool')) };
}

test('credential_ref A-B-A invalidates active and pending pool state and blocks late reactivation', () => {
  const fixture = poolFixture();
  const wire = renderReasoning('responses', fixture.reasoning('active'), fixture.transport); fixture.transport.commit();
  const second = createReasoningSession({ ...fixture.args, body: clone(fixture.initial) }); second.inspect();
  const config = fixture.args.router.getConfig('pool'), fingerprint = fixture.fingerprint();
  const late = second.forLease({ config, target: { ...fixture.args.route.targets[0], model: 'concrete-member' }, outerTargetId: 'target', pool: true, poolFingerprint: fingerprint, isCurrent: () => fixture.fingerprint() === fingerprint });
  const pending = renderReasoning('responses', fixture.reasoning('pending'), late);
  assert.ok(fixture.apply({ source: { apikey: 'credential-B' } }).includes('pool'), 'source credential change invalidates dependent pool epoch');
  fixture.apply({ source: { apikey: 'credential-A' } });
  assert.equal(fixture.fingerprint(), fingerprint, 'snapshot fingerprint alone returns to A');
  const resumed = createReasoningSession({ ...fixture.args, body: { input: [...fixture.initial.input, wire] } });
  assert.throws(() => resumed.inspect(), /未知|过期|来源|归属/);
  late.commit();
  assert.equal(fixture.store.resolveReasoning(pending.encrypted_content), null, 'pending state cannot become active after A-B-A');
  assert.throws(() => renderReasoning('responses', fixture.reasoning('late'), late), /变化|迟到/);
});

test('reference and enable changes invalidate dependencies even when quota identity is unchanged', () => {
  const fixture = poolFixture();
  assert.ok(fixture.apply({ pool: { credential_ref: 'different-source' } }).includes('pool'));
  assert.ok(fixture.apply({ pool: { credential_ref: 'source' } }).includes('pool'));
  assert.ok(fixture.apply({ source: { enabled: false } }).includes('pool'));
  assert.ok(fixture.apply({ source: { enabled: true } }).includes('pool'));
  const before = [{ id: 'source' }, { id: 'pool', credential_ref: 'source' }, { id: 'nested', credential_ref: 'pool' }];
  assert.deepEqual(new Set(credentialContextInvalidations(before, before.slice(1), ['source'])), new Set(['source', 'pool', 'nested']), 'removed credentials invalidate old dependency graph too');
});

test('native reasoning source ambiguity remains rejected after repeated observations from the second account', () => {
  const store = createRoutingContextStore(), configs = [{ id: 'A' }, { id: 'B' }];
  const targets = configs.map(config => ({ id: config.id, config_id: config.id, model: 'backend', protocol: 'responses' }));
  const route = { id: 'ordinary-route', targets }, router = { getConfig: id => configs.find(config => config.id === id) };
  store.syncRoutes({ routing: { models: [route] } });
  const block = { id: 'rs-shared', type: 'reasoning', summary: [], encrypted_content: 'same-provider-state', status: 'completed' };
  const args = { store, router, route, entryProtocol: 'responses', authHash: 'caller', publicModel: route.id };
  for (const id of ['A', 'B', 'B']) {
    const session = createReasoningSession({ ...args, body: { input: 'first' } }); session.inspect();
    const transport = session.forLease({ config: configs.find(config => config.id === id), target: targets.find(target => target.id === id), isCurrent: () => true });
    transport.observe({ id: 'response-' + id, output: [clone(block)] }); transport.commit();
  }
  const binding = store.resolveNativeReasoning(nativeKey('caller', route.id, 'responses', block));
  assert.equal(binding.part._ambiguous, true, 'third observation must not erase the conflicting origin');
  const next = createReasoningSession({ ...args, body: { input: [{ role: 'user', content: 'first' }, block] } });
  assert.throws(() => next.inspect(), /未知|归属|来源/);
});

test('native Chat SSE registers complete opaque details per choice only after successful commit', () => {
  const store = createRoutingContextStore(), config = { id: 'chat' };
  const target = { id: 'target', config_id: 'chat', model: 'backend', protocol: 'chat_completions' };
  const route = { id: 'route', targets: [target] }, router = { getConfig: () => config };
  store.syncRoutes({ routing: { models: [route] } });
  const args = { store, router, route, entryProtocol: 'chat_completions', authHash: 'caller', publicModel: route.id };
  const session = createReasoningSession({ ...args, body: { messages: [{ role: 'user', content: 'first' }] } }); session.inspect();
  const transport = session.forLease({ config, target, isCurrent: () => true });
  const detail = index => ({ index: 0, id: 'state-' + index, type: 'reasoning.encrypted', format: 'openai-responses-v1', data: 'cipher-' + index });
  for (const index of [1, 0]) transport.observe({ choices: [{ index, delta: { reasoning_details: [detail(index)] }, finish_reason: null }] });
  for (const index of [0, 1]) transport.observe({ choices: [{ index, delta: {}, finish_reason: 'stop' }] });
  for (const index of [0, 1]) assert.equal(store.resolveNativeReasoning(nativeKey('caller', 'route', 'chat_completions', { reasoning_details: [detail(index)] })), null);
  transport.commit();
  for (const index of [0, 1]) {
    const block = { reasoning_details: [detail(index)] };
    assert.deepEqual(store.resolveNativeReasoning(nativeKey('caller', 'route', 'chat_completions', block)).part.originBlock, block);
  }
});
