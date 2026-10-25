const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoutingContextStore } = require('../app/model-router');
const { createQuotaEngine } = require('../app/quota-engine');
const { createFreePoolEngine } = require('../app/free-pool-engine');
const { createReasoningSession, nativeKey } = require('../app/reasoning-transport');
const { parseSourceReasoning, renderReasoning } = require('../app/reasoning-content');
const { credentialContextInvalidations } = require('../app/credential-context');
const clone = value => JSON.parse(JSON.stringify(value));
const observe = (transport, payload) => transport.observe(payload, JSON.stringify(payload));

function poolFixture() {
  let parsed = { configs: [{ id: 'source', type: 'apikey', preset: 'openrouter', apikey: 'credential-A' }, { id: 'pool', type: 'apikey', preset: 'openrouter-free', credential_ref: 'source', models: [{ id: 'free', protocols: ['chat_completions'] }] }], routing: { models: [{ id: 'ordinary-route', targets: [{ id: 'target', config_id: 'pool', model: 'free' }] }] } };
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
  const initial = { messages: [{ role: 'user', content: 'first' }] };
  const args = { store, router, route, entryProtocol: 'chat_completions', authHash: 'caller', publicModel: route.id };
  const session = createReasoningSession({ ...args, body: initial }); session.inspect();
  const transport = session.forLease({ config, target: { ...route.targets[0], model: 'concrete-member', protocol: 'chat_completions' }, outerTargetId: 'target', pool: true, poolFingerprint: fingerprint, isCurrent: () => engine.isCurrent(config, fingerprint) });
  const reasoning = suffix => parseSourceReasoning('chat_completions', { reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-' + suffix, format: 'openai-responses-v1' }] })[0];
  return { store, apply, transport, args, reasoning, initial, fingerprint: () => engine.fingerprint(router.getConfig('pool')) };
}

test('credential_ref A-B-A invalidates active and pending native pool state and blocks late registration', () => {
  const fixture = poolFixture();
  const wire = { reasoning_details: [{ type: 'reasoning.encrypted', data: 'native-active-pool-state' }] };
  observe(fixture.transport, { choices: [{ message: wire }] }); fixture.transport.commit();
  assert.equal(createReasoningSession({ ...fixture.args, body: { messages: [...fixture.initial.messages, { role: 'assistant', ...wire }] } }).inspect().configId, 'pool');
  const second = createReasoningSession({ ...fixture.args, body: clone(fixture.initial) }); second.inspect();
  const config = fixture.args.router.getConfig('pool'), fingerprint = fixture.fingerprint();
  const late = second.forLease({ config, target: { ...fixture.args.route.targets[0], model: 'concrete-member', protocol: 'chat_completions' }, outerTargetId: 'target', pool: true, poolFingerprint: fingerprint, isCurrent: () => fixture.fingerprint() === fingerprint });
  const pending = { reasoning_details: [{ type: 'reasoning.encrypted', data: 'native-pending-pool-state' }] };
  observe(late, { choices: [{ message: pending }] });
  assert.ok(fixture.apply({ source: { apikey: 'credential-B' } }).includes('pool'), 'source credential change invalidates dependent pool epoch');
  fixture.apply({ source: { apikey: 'credential-A' } });
  assert.equal(fixture.fingerprint(), fingerprint, 'snapshot fingerprint alone returns to A');
  const resumed = createReasoningSession({ ...fixture.args, body: { messages: [...fixture.initial.messages, { role: 'assistant', ...wire }] } });
  assert.throws(() => resumed.inspect(), /未知|过期|来源|归属/);
  late.commit();
  assert.equal(fixture.store.resolveNativeReasoning(nativeKey('caller', fixture.args.publicModel, 'chat_completions', pending)), null, 'pending native state cannot become active after A-B-A');
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
  const store = createRoutingContextStore(), configs = ['A', 'B'].map(id => ({ id, models: [{ id: 'backend', protocols: ['responses'] }] }));
  const targets = configs.map(config => ({ id: config.id, config_id: config.id, model: 'backend', protocol: 'responses' }));
  const route = { id: 'ordinary-route', targets }, router = { getConfig: id => configs.find(config => config.id === id) };
  store.syncRoutes({ routing: { models: [route] } });
  const block = { id: 'rs-shared', type: 'reasoning', summary: [], encrypted_content: 'same-provider-state', status: 'completed' };
  const args = { store, router, route, entryProtocol: 'responses', authHash: 'caller', publicModel: route.id };
  for (const id of ['A', 'B', 'B']) {
    const session = createReasoningSession({ ...args, body: { input: 'first' } }); session.inspect();
    const transport = session.forLease({ config: configs.find(config => config.id === id), target: targets.find(target => target.id === id), isCurrent: () => true });
    observe(transport, { id: 'response-' + id, output: [clone(block)] }); transport.commit();
  }
  const binding = store.resolveNativeReasoning(nativeKey('caller', route.id, 'responses', block));
  assert.equal(binding.part._ambiguous, true, 'third observation must not erase the conflicting origin');
  const next = createReasoningSession({ ...args, body: { input: [{ role: 'user', content: 'first' }, block] } });
  assert.throws(() => next.inspect(), /未知|归属|来源/);
});

test('native Chat SSE registers complete opaque details per choice only after successful commit', () => {
  const store = createRoutingContextStore(), config = { id: 'chat', models: [{ id: 'backend', protocols: ['chat_completions'] }] };
  const target = { id: 'target', config_id: 'chat', model: 'backend', protocol: 'chat_completions' };
  const route = { id: 'route', targets: [target] }, router = { getConfig: () => config };
  store.syncRoutes({ routing: { models: [route] } });
  const args = { store, router, route, entryProtocol: 'chat_completions', authHash: 'caller', publicModel: route.id };
  const session = createReasoningSession({ ...args, body: { messages: [{ role: 'user', content: 'first' }] } }); session.inspect();
  const transport = session.forLease({ config, target, isCurrent: () => true });
  const detail = index => ({ index: 0, id: 'state-' + index, type: 'reasoning.encrypted', format: 'openai-responses-v1', data: 'cipher-' + index });
  for (const index of [1, 0]) observe(transport, { choices: [{ index, delta: { reasoning_details: [detail(index)] }, finish_reason: null }] });
  for (const index of [0, 1]) observe(transport, { choices: [{ index, delta: {}, finish_reason: 'stop' }] });
  for (const index of [0, 1]) assert.equal(store.resolveNativeReasoning(nativeKey('caller', 'route', 'chat_completions', { reasoning_details: [detail(index)] })), null);
  transport.commit();
  for (const index of [0, 1]) {
    const block = { reasoning_details: [detail(index)] };
    assert.deepEqual(store.resolveNativeReasoning(nativeKey('caller', 'route', 'chat_completions', block)).part.originBlock, block);
  }
});

function nativeFixture(protocol, extra = {}) {
  const store = createRoutingContextStore();
  const config = { id: 'account', models: [{ id: 'backend', protocols: [protocol] }] };
  // The retained legacy field is deliberately different: protocol now belongs
  // to each request and the account's model catalog, not the route candidate.
  const target = { id: 'target', config_id: config.id, model: 'backend', protocol: 'obsolete-fixed-protocol' };
  const route = { id: 'native-route', entry_protocols: [protocol], targets: [target] };
  const router = { getConfig: id => id === config.id ? config : null };
  store.syncRoutes({ routing: { models: [route] } });
  const input = protocol === 'responses' ? { input: [{ role: 'user', content: 'first' }] } : { messages: [{ role: 'user', content: 'first' }] };
  const args = { store, router, route, entryProtocol: protocol, authHash: 'caller', publicModel: route.id, ...extra };
  const session = createReasoningSession({ ...args, body: clone(input) }); session.inspect();
  const transport = session.forLease({ config, target: { ...target, protocol }, isCurrent: () => true });
  const replay = block => {
    const body = protocol === 'responses' ? { input: [...input.input, block] } : { messages: [...input.messages, protocol === 'messages' ? { role: 'assistant', content: [block] } : { role: 'assistant', content: 'answer', ...block }] };
    return createReasoningSession({ ...args, body });
  };
  return { store, config, target, route, args, input, transport, replay };
}

test('native opaque authorization follows current account model protocols, ignoring obsolete candidate protocol', () => {
  const fixture = nativeFixture('responses');
  const block = { type: 'reasoning', id: 'rs-native-contract', summary: [], encrypted_content: 'native-cipher' };
  observe(fixture.transport, { output: [block] }); fixture.transport.commit();
  assert.deepEqual(fixture.replay(block).inspect(), { targetId: 'target', configId: 'account', model: 'backend', protocol: 'responses' });
  delete fixture.target.protocol;
  assert.equal(fixture.replay(block).inspect().protocol, 'responses');
  fixture.config.models[0].protocols = ['chat_completions'];
  assert.throws(() => fixture.replay(block).inspect(), /协议|来源|模型/);
  fixture.config.models[0].protocols = ['responses']; fixture.config.enabled = false;
  assert.throws(() => fixture.replay(block).inspect(), /账号|来源|禁用/);
});

test('unknown native Chat reasoning is tracked without canonical interpretation and cannot be invented or altered', () => {
  for (const block of [{ reasoning: { vendor_state: { signature: 'opaque-object', sequence: 7 } } }, { reasoning_details: [{ type: 'vendor.private-v2', payload: { signature: 'opaque-detail' } }] }]) {
    const fixture = nativeFixture('chat_completions');
    assert.throws(() => fixture.replay(block).inspect(), /未知|归属|验证/);
    observe(fixture.transport, { choices: [{ index: 0, message: { role: 'assistant', content: 'answer', ...block }, finish_reason: 'stop' }] });
    assert.throws(() => fixture.replay(block).inspect(), /未知|归属|验证/, 'uncommitted output cannot acquire ownership');
    fixture.transport.commit();
    assert.equal(fixture.replay(block).inspect().configId, 'account');
    const changed = clone(block); changed.vendor_new_state = 'unrelated';
    // A change to the actual opaque block must change its binding key.
    if (changed.reasoning) changed.reasoning.vendor_state.sequence++;
    else changed.reasoning_details[0].payload.signature = 'forged';
    assert.throws(() => fixture.replay(changed).inspect(), /未知|归属|验证/);
    assert.equal(fixture.store.size, 0, 'native client-carried state does not assert Responses server persistence');
  }
});

test('native Responses and Messages vendor reasoning blocks survive tracking without a canonical schema', () => {
  for (const [protocol, block] of [
    ['responses', { type: 'reasoning', id: 'rs-vendor', summary: [{ type: 'vendor-summary', value: 5 }], encrypted_content: 'cipher', vendor: { opaque: true } }],
    ['messages', { type: 'thinking', thinking: { vendor_text: 'custom-native-shape' }, signature: 'signature', vendor: { opaque: true } }],
  ]) {
    const fixture = nativeFixture(protocol);
    observe(fixture.transport, protocol === 'responses' ? { output: [block] } : { content: [block] }); fixture.transport.commit();
    assert.equal(fixture.replay(block).inspect().protocol, protocol);
    const saved = fixture.store.resolveNativeReasoning(nativeKey('caller', fixture.route.id, protocol, block));
    assert.deepEqual(saved.part.originBlock, block);
  }
});

test('unknown native Chat object state from a complete SSE delta is bound only after successful completion', () => {
  for (const block of [{ reasoning: { vendor_signature: 'opaque-stream-state' } }, { reasoning_details: { vendor_signature: 'opaque-native-detail-object' } }]) {
    const fixture = nativeFixture('chat_completions');
    observe(fixture.transport, { choices: [{ index: 0, delta: block, finish_reason: null }] });
    observe(fixture.transport, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    fixture.transport.commit();
    assert.equal(fixture.replay(block).inspect().protocol, 'chat_completions');
  }
});

test('native state still enforces caller, history, enabled candidate, actual model and entry scope', () => {
  const fixture = nativeFixture('chat_completions');
  const block = { reasoning: { vendor_signature: 'opaque-scope' } };
  observe(fixture.transport, { choices: [{ message: block }] }); fixture.transport.commit();
  assert.equal(fixture.replay(block).inspect().model, 'backend');
  const body = { messages: [...fixture.input.messages, { role: 'assistant', ...block }] };
  assert.throws(() => createReasoningSession({ ...fixture.args, authHash: 'other-caller', body }).inspect(), /未知|调用者|归属/);
  assert.throws(() => createReasoningSession({ ...fixture.args, body: { messages: [{ role: 'user', content: 'changed history' }, body.messages[1]] } }).inspect(), /前置消息|变化/);
  fixture.target.enabled = false;
  assert.throws(() => fixture.replay(block).inspect(), /来源|账号|模型/);
  fixture.target.enabled = true; fixture.target.model = 'other-model';
  assert.throws(() => fixture.replay(block).inspect(), /来源|账号|模型/);
  fixture.target.model = 'backend'; fixture.route.entry_protocols = ['responses'];
  assert.throws(() => fixture.replay(block).inspect(), /来源|协议/);
});

test('known public Chat reasoning and unrelated vendor extensions require no account binding', () => {
  const fixture = nativeFixture('chat_completions');
  const block = { reasoning_content: 'public thought', unknown_vendor_extension: { detail: true } };
  assert.equal(fixture.replay(block).inspect(), null);
  fixture.config.enabled = false;
  assert.equal(fixture.replay(block).inspect(), null, 'public text cannot pin an unavailable account');
});

test('native authorization uses normalized router models and the same preset fallback for test stubs', () => {
  const fixture = nativeFixture('chat_completions'), block = { reasoning: { signature: 'normalized-model-fixture' } };
  observe(fixture.transport, { choices: [{ message: block }] }); fixture.transport.commit();
  fixture.config.preset = 'openrouter'; delete fixture.config.models[0].protocols;
  assert.equal(fixture.replay(block).inspect().protocol, 'chat_completions', 'stub fallback must normalize preset defaults');
  const router = fixture.args.router;
  let calls = 0;
  router.getModel = (configId, modelId) => { calls++; assert.equal(configId, 'account'); assert.equal(modelId, 'backend'); return { id: 'backend', protocols: ['chat_completions'] }; };
  fixture.config.models[0].protocols = ['messages'];
  assert.equal(fixture.replay(block).inspect().protocol, 'chat_completions'); assert.equal(calls, 1);
  router.getModel = () => null;
  assert.throws(() => fixture.replay(block).inspect(), /来源|模型|协议/, 'a removed normalized model cannot fall back to stale raw config');
});
