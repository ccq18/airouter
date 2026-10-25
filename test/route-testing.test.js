const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTestBody, redactTestResponse } = require('../app/route-testing');

test('diagnostic responses redact current and rotated credentials even when JSON escaped', () => {
  const old = 'old-secret-123';
  const current = 'new-secret-"\\123';
  const input = { error: { message: `upstream echoed ${old} and ${current}` }, content: 'ordinary answer', status: 401 };
  const result = redactTestResponse(input, [{ configs: [{ apikey: old }] }, { configs: [{ access_token: current }] }]);
  assert.deepEqual(result, { error: { message: 'upstream echoed [REDACTED] and [REDACTED]' }, content: 'ordinary answer', status: 401 });
  assert.equal(input.error.message.includes(old), true);
});

test('diagnostic payloads preserve custom input and bound generated output for each entry protocol', () => {
  for (const protocol of ['chat_completions', 'responses', 'messages']) {
    const input = '  中文\nline2  ';
    const body = buildTestBody('arbitrary-id', input, protocol);
    assert.equal(body.model, 'arbitrary-id');
    assert.equal(body.stream, false);
    assert.equal(protocol === 'responses' ? body.input : body.messages[0].content, input);
    assert.equal(protocol === 'responses' ? body.max_output_tokens : body.max_tokens, 2048);
  }
});

const { EventEmitter } = require('node:events');
const { createRouteTestHandler } = require('../app/route-testing');
const { createModelRouter } = require('../app/model-router');
const { createRuntimeConfigs } = require('../app/openai-config');

test('cancelled or timed-out diagnostics cannot start a late request after credential preparation', async () => {
  for (const action of ['cancel', 'timeout']) {
    const parsed = { configs: [{ id: 'a', type: 'apikey', preset: 'glm-cn', base_url: 'https://fixture.invalid/v1', apikey: 'fake-secret', models: [{ id: 'glm-5.3', protocols: ['chat_completions'] }] }], routing: { models: [{ id: 'test', entry_protocols: ['chat_completions'], targets: [{ id: 't', config_id: 'a', model: 'glm-5.3', protocol: 'chat_completions' }] }] } };
    const runtime = createRuntimeConfigs(parsed);
    let started, resume;
    const preparing = new Promise(resolve => { started = resolve; });
    const prepared = new Promise(resolve => { resume = resolve; });
    let calls = 0;
    const req = Object.assign(new EventEmitter(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: { model: 'test', input: 'hello', mode: 'candidate', target_id: 't' } });
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, writableEnded: false, destroyed: false,
      status(value) { this.statusCode = value; return this; },
      json(value) { this.payload = value; this.writableEnded = true; this.emit('finish'); return this; },
    });
    const handler = createRouteTestHandler({
      getParsedConfig: () => parsed, getRuntimeConfigs: () => runtime,
      getRouter: () => createModelRouter({ parsed, runtimeConfigs: runtime }), timeoutMs: 100,
      getForwardingOptions: () => ({
        prepareUpstreamConfig: async () => { started(); await prepared; },
        createUpstreamRequest: () => { calls++; throw new Error('must not start after cancellation'); },
      }),
    });
    const pending = handler(req, res);
    await preparing;
    if (action === 'cancel') { res.destroyed = true; res.emit('close'); }
    else { await new Promise(resolve => setTimeout(resolve, 130)); assert.equal(res.statusCode, 504); }
    resume();
    await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0, action);
  }
});
