const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
let upstream, child, dir, base, quota = 8.75;
const calls = [];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function admin(path, method = 'GET', data) {
  const response = await fetch(base + '/admin/api/' + path, { method, headers: { authorization: 'Bearer relay-admin-fixture', 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: response.status, body: await response.json() };
}
async function entry(endpoint, payload) {
  return fetch(base + '/v1/' + endpoint, { method: 'POST', headers: { authorization: 'Bearer relay-entry-fixture', 'content-type': 'application/json' }, body: JSON.stringify(payload) });
}
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-sub2api-'));
  upstream = http.createServer(async (req, res) => {
    if (req.url === '/relay/v1/models') return json(res, 200, { object: 'list', data: [{ id: 'gpt-relay', owned_by: 'openai', object: 'model' }] });
    if (req.url === '/relay/v1/usage') return json(res, 200, quota < 0 ? { mode: 'quota_limited', isValid: true, quota: { limit: 10, used: 10, remaining: 0, unit: 'USD' }, status: 'active' } : { mode: 'unrestricted', isValid: true, balance: quota, remaining: quota, unit: 'USD' });
    let text = ''; for await (const chunk of req) text += chunk;
    let body; try { body = JSON.parse(text); } catch (_) { return json(res, 404, {}); }
    calls.push({ path: req.url, body, auth: req.headers.authorization });
    if (req.url === '/relay/v1/responses') return json(res, 200, { id: 'relay-response', object: 'response', model: body.model, status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: 'from-relay' }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    if (req.url === '/backup/chat/completions') return json(res, 200, { id: 'backup', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'from-backup' }, finish_reason: 'stop' }] });
    json(res, 404, { error: { message: 'unexpected path' } });
  });
  const port = await listen(upstream); const root = `http://127.0.0.1:${port}`;
  const reservation = http.createServer(); const servicePort = await listen(reservation); await new Promise(resolve => reservation.close(resolve));
  const config = { auth_token: 'relay-admin-fixture', apikeys: ['relay-entry-fixture'], port: servicePort, configs: [
    { id: 'relay', type: 'apikey', preset: 'sub2api', base_url: root + '/relay', apikey: 'relay-upstream-fixture', models: [{ id: 'gpt-relay', protocols: ['responses'] }] },
    { id: 'backup', type: 'apikey', preset: 'custom', base_url: root + '/backup', apikey: 'backup-fixture', models: [{ id: 'fallback', protocols: ['chat_completions'] }] },
  ], routing: { models: [{ id: 'client-relay', entry_protocols: ['chat_completions', 'responses', 'messages'], targets: [{ id: 'primary', config_id: 'relay', model: 'gpt-relay', protocol: 'responses' }, { id: 'secondary', config_id: 'backup', model: 'fallback', protocol: 'chat_completions' }] }] } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  base = `http://127.0.0.1:${servicePort}`;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'openai.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, CONFIG: path.join(dir, 'config.json'), AIROUTER_BIND_HOST: '127.0.0.1', QUOTA_CHECK_TIMEOUT_MS: '1000' }, stdio: ['ignore', 'ignore', 'ignore'] });
  const end = Date.now() + 10000;
  while (Date.now() < end) { try { if ((await admin('upstreams')).status === 200) break; } catch (_) {} await new Promise(resolve => setTimeout(resolve, 30)); }
});
test.after(async () => { if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); } if (upstream) await new Promise(resolve => upstream.close(resolve)); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('Sub2API built-in models and monetary quota use the forwarding key and preserve protocol suggestions', async () => {
  const discovery = await admin('upstreams/relay/models/discover', 'POST', {});
  assert.equal(discovery.status, 200); assert.equal(discovery.body.source_url.endsWith('/relay/v1/models'), true);
  assert.deepEqual(discovery.body.suggested_models[0].protocols, ['responses']);
  const refreshed = await admin('upstreams/relay/quota-refresh', 'POST', {});
  assert.equal(refreshed.status, 200); assert.equal(refreshed.body.quota.state, 'available');
  assert.equal(refreshed.body.quota.metrics[0].unit, 'USD'); assert.equal(refreshed.body.quota.metrics[0].remaining, 8.75);
  assert.equal(refreshed.body.quota.metrics[0].limit, null); assert.equal(refreshed.body.quota.metrics[0].remaining_percent, null);
  assert.doesNotMatch(JSON.stringify(refreshed.body), /relay-upstream-fixture/);
});
test('three client entries bridge to the Sub2API native Responses endpoint with actual model mapping', async () => {
  for (const [endpoint, payload] of [['chat/completions', { messages: [{ role: 'user', content: 'hello' }] }], ['responses', { input: 'hello', stream: false }], ['messages', { messages: [{ role: 'user', content: 'hello' }], max_tokens: 128 }]]) {
    const res = await entry(endpoint, { model: 'client-relay', ...payload }); assert.equal(res.status, 200, endpoint);
    const body = await res.json(); assert.match(JSON.stringify(body), /from-relay/); assert.equal(body.model, 'client-relay');
    assert.equal(calls.at(-1).path, '/relay/v1/responses'); assert.equal(calls.at(-1).body.model, 'gpt-relay'); assert.equal(calls.at(-1).auth, 'Bearer relay-upstream-fixture');
  }
});
test('key budget exhaustion skips relay and positive recovery returns to it', async () => {
  quota = -1; await admin('upstreams/relay/quota-refresh', 'POST', {});
  let response = await entry('chat/completions', { model: 'client-relay', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /from-backup/);
  quota = 5; await admin('upstreams/relay/quota-refresh', 'POST', {});
  response = await entry('chat/completions', { model: 'client-relay', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(response.status, 200); assert.match(JSON.stringify(await response.json()), /from-relay/);
});
