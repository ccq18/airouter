const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const ADMIN = 'pool-admin-fixture';
const ENTRY = 'pool-entry-fixture';
let fake, child, base, dir, log = '';
let quota = 10, broken = false, phase = 'ok';
let goModels = ['beam', 'iceman', 'paid-free-name'];
const calls = [];
const metadata = { 'opencode-go': { npm: '@ai-sdk/openai-compatible', models: Object.fromEntries(['beam', 'iceman', 'paid-free-name', 'new-model'].map(id => [id, { id, cost: { input: id === 'paid-free-name' ? 1 : 0, output: 0 }, tool_call: true, modalities: { input: ['text'], output: ['text'] }, limit: { context: 64000, output: 4096 }, provider: { npm: '@ai-sdk/openai-compatible' } }])) } };
const orModel = (id, price = '0') => ({ id, context_length: 128000, pricing: { prompt: price, completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'response_format'], top_provider: { max_completion_tokens: 4096 } });
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
async function body(req) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text || '{}'); }
async function admin(route, data) {
  const response = await fetch(`${base}/admin/api/${route}`, { method: data === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { status: response.status, body: await response.json() };
}
async function call(input = {}) {
  const response = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${ENTRY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'any-client-id', messages: [{ role: 'user', content: 'hello' }], ...input }) });
  return response;
}
const paidRoute = { id: 'p', config_id: 'paid', model: 'paid', protocol: 'chat_completions' };
const goRoute = { id: 'g', config_id: 'go-pool', model: 'free', protocol: 'chat_completions' };
const orRoute = { id: 'o', config_id: 'or-pool', model: 'free', protocol: 'chat_completions' };

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-pools-'));
  fake = http.createServer(async (req, res) => {
    if (req.url === '/metadata') return json(res, 200, metadata);
    if (req.url === '/quota') return json(res, 200, { success: true, code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: quota, nextResetTime: Date.now() + 3600000 }] } });
    if (req.url === '/go/v1/models') return json(res, broken ? 503 : 200, broken ? { error: 'temporary failure' } : { data: goModels.map(id => ({ id })) });
    if (req.url === '/or/models/user') return json(res, 200, { data: [orModel('vendor/fast'), orModel('vendor/paid:free', '0.1'), orModel('openrouter/free')] });
    if (req.url.endsWith('/chat/completions')) {
      const value = await body(req); calls.push({ path: req.url, body: value, auth: req.headers.authorization });
      if (req.url.startsWith('/paid') && phase === 'paid-fail') return json(res, 402, { error: { code: 'quota_exhausted', message: 'paid exhausted' } });
      if (req.url.startsWith('/go') && phase === 'all-fail') return json(res, value.model === 'beam' ? 429 : 400, { error: { message: value.model === 'beam' ? 'rate limited' : 'privacy training permission required' } });
      if (req.url.startsWith('/go') && phase === 'stream-fail') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ id: 'chunk', choices: [{ index: 0, delta: { content: 'started' } }] }) + '\n\n');
        setTimeout(() => res.destroy(), 20); return;
      }
      return json(res, 200, { id: 'answer', object: 'chat.completion', model: value.model, choices: [{ index: 0, message: { role: 'assistant', content: 'from-' + value.model }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
    json(res, 404, { error: { message: req.url } });
  });
  const port = await listen(fake); const upstream = `http://127.0.0.1:${port}`;
  const reserve = http.createServer(); const servicePort = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  const config = { auth_token: ADMIN, apikeys: [ENTRY], port: servicePort, configs: [
    { id: 'paid', type: 'apikey', preset: 'glm-cn', base_url: upstream + '/paid', apikey: 'paid-key-fixture', quota_url: upstream + '/quota', models: [{ id: 'paid', protocols: ['chat_completions'] }] },
    { id: 'go-source', type: 'apikey', preset: 'opencode-go', base_url: upstream + '/go', apikey: 'go-key-fixture', quota_url: upstream + '/quota', models: [] },
    { id: 'or-source', type: 'apikey', preset: 'openrouter', base_url: upstream + '/or', apikey: 'or-key-fixture', models: [] },
    { id: 'go-pool', type: 'apikey', preset: 'opencode-free', base_url: upstream + '/go', credential_ref: 'go-source', models: [{ id: 'free', protocols: ['chat_completions'] }], pool: { tiers: { beam: 1, iceman: 2 } } },
    { id: 'or-pool', type: 'apikey', preset: 'openrouter-free', base_url: upstream + '/or', credential_ref: 'or-source', models: [{ id: 'free', protocols: ['chat_completions'] }] },
  ], routing: { max_attempts: 3, models: [
    { id: 'any-client-id', entry_protocols: ['chat_completions', 'responses', 'messages'], targets: [paidRoute, goRoute, orRoute] },
    { id: 'auto', entry_protocols: ['chat_completions', 'responses', 'messages'], targets: [paidRoute, goRoute, orRoute] },
    { id: 'go-only', max_attempts: 1, entry_protocols: ['chat_completions'], targets: [goRoute] },
    { id: 'or-only', entry_protocols: ['chat_completions'], targets: [orRoute] },
  ] } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config));
  base = `http://127.0.0.1:${servicePort}`;
  child = spawn(process.execPath, [path.join(ROOT, 'openai.js')], { cwd: ROOT, env: { ...process.env, CONFIG: path.join(dir, 'config.json'), FREE_POOL_MODELS_METADATA_URL: upstream + '/metadata', QUOTA_CHECK_TIMEOUT_MS: '1000', AIROUTER_BIND_HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', value => { log += value; }); child.stderr.on('data', value => { log += value; });
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try { const result = await admin('upstreams'); if (result.status === 200) break; } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  for (const id of ['go-pool', 'or-pool']) assert.equal((await admin(`upstreams/${id}/pool-refresh`, {})).status, 200, log);
});

test.after(async () => {
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  if (fake) await new Promise(resolve => fake.close(resolve));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('pools expose stable free ID, reference credentials, and filter paid and random model names', async () => {
  const result = await admin('upstreams'); assert.equal(result.status, 200);
  const go = result.body.configs.find(item => item.id === 'go-pool'); const or = result.body.configs.find(item => item.id === 'or-pool');
  assert.deepEqual(go.models.map(item => item.id), ['free']);
  assert.equal(go.has_credentials, true); assert.equal(go.credential_ref, 'go-source'); assert.equal(go.quota, null);
  assert.deepEqual(go.pool_status.models.map(item => item.id).sort(), ['beam', 'iceman']);
  assert.deepEqual(or.pool_status.models.map(item => item.id), ['vendor/fast']);
  assert.doesNotMatch(JSON.stringify(result.body), /go-key-fixture|or-key-fixture/);
});

test('automatic catalog changes preserve fixed routing and failed sync retains last valid cache', async () => {
  const configBefore = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
  goModels = ['new-model', 'paid-free-name'];
  let result = await admin('upstreams/go-pool/pool-refresh', {});
  assert.deepEqual(result.body.pool_status.models.map(item => item.id), ['new-model']);
  broken = true;
  result = await admin('upstreams/go-pool/pool-refresh', {});
  assert.deepEqual(result.body.pool_status.models.map(item => item.id), ['new-model']);
  assert.ok(result.body.pool_status.error); assert.ok(result.body.pool_status.last_sync_at);
  assert.equal(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), configBefore);
  broken = false; goModels = ['beam', 'iceman', 'paid-free-name'];
  await admin('upstreams/go-pool/pool-refresh', {});
});

test('paid exhaustion and source Go exhaustion allow free pool; recovery returns to higher priority', async () => {
  quota = 100;
  for (const id of ['paid', 'go-source']) await admin(`upstreams/${id}/quota-refresh`, {});
  for (const model of ['any-client-id', 'auto']) {
    const before = calls.length; const response = await call({ model });
    assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'from-beam');
    assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).auth, 'Bearer go-key-fixture');
  }
  quota = 10; await admin('upstreams/paid/quota-refresh', {});
  for (const model of ['any-client-id', 'auto']) {
    const before = calls.length; const response = await call({ model });
    assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, 'from-paid');
    assert.equal(calls.length, before + 1);
  }
});

test('capability matching skips text-only pool for images and enforces concrete zero-price requests', async () => {
  const response = await call({ model: 'or-only', provider: { max_price: { prompt: 9 }, data_collection: 'allow' }, models: ['paid-model'], tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] });
  assert.equal(response.status, 200);
  const sent = calls.at(-1).body;
  assert.equal(sent.model, 'vendor/fast'); assert.equal(sent.models, undefined); assert.equal(sent.plugins, undefined);
  assert.deepEqual(sent.provider.max_price, { prompt: 0, completion: 0, request: 0, image: 0 });
  assert.equal(sent.provider.require_parameters, true); assert.notEqual(sent.provider.data_collection, 'allow');
  const privateCall = await call({ model: 'or-only', provider: { data_collection: 'deny', zdr: true } });
  assert.equal(privateCall.status, 200); await privateCall.json();
  assert.equal(calls.at(-1).body.provider.data_collection, 'deny'); assert.equal(calls.at(-1).body.provider.zdr, true);
  const noPaidTools = calls.length;
  const blocked = await call({ model: 'or-only', plugins: [{ id: 'web' }] });
  assert.equal(blocked.status, 503); assert.equal(calls.length, noPaidTools);
  quota = 100; await admin('upstreams/paid/quota-refresh', {});
  const before = calls.length;
  const image = await call({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/image.png' } }] }] });
  assert.equal(image.status, 200); await image.json();
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).body.model, 'vendor/fast');
});

test('Responses fields use the same pool capability and preflight rules as ordinary routes', async () => {
  quota = 100; await admin('upstreams/paid/quota-refresh', {});
  const send = controls => fetch(base + '/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${ENTRY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'any-client-id', stream: false, input: [{ role: 'user', content: 'hello' }], ...controls }) });
  let before = calls.length;
  let response = await send({ text: { format: { type: 'text' }, verbosity: 'low' }, service_tier: 'default', safety_identifier: 'pool-caller', max_output_tokens: 128 });
  assert.equal(response.status, 200); await response.json();
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).body.model, 'beam', 'plain text does not require structured-output capability');
  assert.deepEqual(calls.at(-1).body.response_format, { type: 'text' }); assert.equal(calls.at(-1).body.verbosity, 'low'); assert.equal(calls.at(-1).body.max_completion_tokens, 128);
  assert.equal(calls.at(-1).body.safety_identifier, 'pool-caller');
  before = calls.length; response = await send({ text: { format: { type: 'json_object' } } });
  assert.equal(response.status, 200); await response.json(); assert.equal(calls.length, before + 1);
  assert.equal(calls.at(-1).body.model, 'vendor/fast', 'structured output skips a known text-only member');
  assert.deepEqual(calls.at(-1).body.response_format, { type: 'json_object' });
  before = calls.length; response = await send({ include: ['future.output'] });
  const rejected = await response.json(); assert.equal(response.status, 400); assert.match(JSON.stringify(rejected), /include\[0\]/); assert.equal(calls.length, before, 'no pool attempt for an unrepresentable control');
});

test('pool failures exhaust only inner candidates and then use next pool with diagnostic actual model trace', async () => {
  phase = 'all-fail';
  const result = await admin('model-routes/test', { model: 'any-client-id', input: 'test the pool', mode: 'route' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.response.choices[0].message.content, 'from-vendor/fast');
  assert.deepEqual(result.body.attempts.map(x => x.model), ['beam', 'iceman', 'vendor/fast']);
  assert.equal(result.body.attempts.at(-1).model, 'vendor/fast');
  assert.equal(result.body.attempts.at(-1).pool_target_id, 'o');
  const before = calls.length;
  const response = await call({ model: 'go-only' });
  assert.equal(response.status, 503); assert.equal(calls.length, before);
  phase = 'ok';
});

test('committed pool stream never retries another model or outer upstream', async () => {
  goModels = ['new-model']; await admin('upstreams/go-pool/pool-refresh', {});
  phase = 'stream-fail'; const before = calls.length;
  const response = await call({ model: 'go-only', stream: true });
  assert.equal(response.status, 200);
  let text = ''; try { for await (const chunk of response.body) text += Buffer.from(chunk).toString(); } catch (_) {}
  assert.match(text, /started/); assert.equal(calls.length, before + 1);
  phase = 'ok';
});

