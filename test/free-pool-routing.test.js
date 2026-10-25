const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createModelRouter } = require('../app/model-router');
const { createExplicitRoutingHandler } = require('../app/explicit-routing-handler');
const { createRuntimeConfigs } = require('../app/openai-config');
function fixture() {
  const parsed = { configs: [{ id: 'pool', type: 'apikey', preset: 'openrouter-free', apikey: 'fake-key-routing', pool: { max_attempts: 2 } }], routing: { max_attempts: 1, models: [{ id: 'any', entry_protocols: ['chat_completions'], targets: [{ id: 'outer', config_id: 'pool', model: 'free', protocol: 'chat_completions' }] }] } };
  let models = ['a', 'b', 'c'].map(id => ({ id, protocols: ['chat_completions'], context_window: 32000, capabilities: {}, pool_fingerprint: 'identity' }));
  const engine = { getCandidates: () => models, fingerprint: () => 'identity', isCurrent: () => true, recordAttempt() {}, serialize: () => ({ error: '' }) };
  const router = createModelRouter({ parsed, runtimeConfigs: createRuntimeConfigs(parsed), poolEngine: engine });
  return { router, parsed, engine, setModels(value) { models = value; } };
}
test('one outer pool slot permits bounded internal tries without consuming other outer slots', () => {
  const h = fixture(); const excluded = []; const attempted = new Set();
  const a = h.router.select('any', 'chat_completions', { attemptedTargetIds: attempted, excludeTargetIds: excluded });
  assert.equal(a.lease.target.model, 'a'); attempted.add(a.lease.outerTargetId); excluded.push(a.lease.target.id); a.lease.release();
  const b = h.router.select('any', 'chat_completions', { attemptedTargetIds: attempted, excludeTargetIds: excluded });
  assert.equal(b.lease.target.model, 'b'); excluded.push(b.lease.target.id); b.lease.release();
  assert.equal(h.router.select('any', 'chat_completions', { attemptedTargetIds: attempted, excludeTargetIds: excluded }).lease, null);
});
test('free eligibility revoked during asynchronous preparation prevents a late billed request', async () => {
  const h = fixture(); let started, resume;
  const preparing = new Promise(resolve => { started = resolve; });
  const prepared = new Promise(resolve => { resume = resolve; });
  const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'content-type': 'application/json' } });
  let calls = 0;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200, writableEnded: false, destroyed: false,
    status(code) { this.statusCode = code; return this; }, setHeader() {},
    json(value) { this.payload = value; this.writableEnded = true; return this; },
  });
  const handler = createExplicitRoutingHandler({ getRouter: () => h.router, entryProtocol: 'chat_completions',
    readRequestBody: async () => Buffer.from(JSON.stringify({ model: 'any', messages: [{ role: 'user', content: 'test' }] })),
    prepareUpstreamConfig: async () => { started(); await prepared; },
    createUpstreamRequest: () => { calls++; throw new Error('must not contact revoked model'); },
  });
  handler(req, res); await preparing; h.setModels([]); resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0); assert.equal(res.statusCode, 503);
});
