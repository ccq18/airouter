const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const ADMIN_TOKEN = 'admin-limits-token';
const ENTRY_KEY = 'router-limits-key';
let tempDir; let child; let upstream; let baseUrl; let modelsRequests = 0; let seenAuth = null;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

test.before(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === '/v1/models') {
      modelsRequests++;
      seenAuth = req.headers.authorization || null;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ object: 'list', data: [
        { id: 'deepseek-v4.1-flash', limit: { context: 1000000, output: 384000 } }, // OpenCode Go shape
        { id: 'glm-5.3', object: 'model' }, // Zhipu shape: no limits
        { id: 'manual-model', context_length: 999999 },
        { id: 'mystery-model', object: 'model' },
      ] }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
  const port = await freePort();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-limits-int-'));
  const configPath = path.join(tempDir, 'config.json');
  const model = id => ({ id, protocols: ['chat_completions'] });
  fs.writeFileSync(configPath, JSON.stringify({
    auth_token: ADMIN_TOKEN, apikeys: [ENTRY_KEY], port,
    configs: [{
      id: 'cfg-x', type: 'apikey', preset: 'custom', description: 'fake', base_url: `${upstreamUrl}/v1`,
      models_endpoint: `${upstreamUrl}/v1/models`, apikey: 'sk-limits-fake',
      models: [model('deepseek-v4.1-flash'), model('glm-5.3'), { ...model('manual-model'), context_window: 64000, max_output_tokens: 4096 }, model('mystery-model')],
    }],
    routing: { max_attempts: 2, models: [
      { id: 'auto', entry_protocols: ['chat_completions'], targets: [
        { id: 't1', config_id: 'cfg-x', model: 'glm-5.3', protocol: 'chat_completions' },
        { id: 't2', config_id: 'cfg-x', model: 'deepseek-v4.1-flash', protocol: 'chat_completions' },
        { id: 't3', config_id: 'cfg-x', model: 'manual-model', protocol: 'chat_completions' },
      ] },
      { id: 'flash', entry_protocols: ['chat_completions'], targets: [{ id: 'f1', config_id: 'cfg-x', model: 'deepseek-v4.1-flash', protocol: 'chat_completions' }] },
      { id: 'mystery', entry_protocols: ['chat_completions'], targets: [{ id: 'm1', config_id: 'cfg-x', model: 'mystery-model', protocol: 'chat_completions' }] },
    ] },
  }, null, 2));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(REPO_ROOT, 'openai.js')], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), CONFIG: configPath, ACCESS_LOG: '0', QUOTA_CHECK_TIMEOUT_MS: '3000' },
  });
  child.stdout.resume(); child.stderr.resume();
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try { if ((await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${ENTRY_KEY}` } })).ok && modelsRequests > 0) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await new Promise(resolve => setTimeout(resolve, 200));
});

test.after(async () => {
  if (child) { child.kill('SIGTERM'); await new Promise(resolve => { const timer = setTimeout(resolve, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); }); }
  await new Promise(resolve => upstream.close(resolve));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('/v1/models exposes resolved context limits per route, including auto', async () => {
  assert.equal(modelsRequests >= 1, true, 'upstream /models fetched at startup');
  assert.equal(seenAuth, 'Bearer sk-limits-fake');
  const response = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${ENTRY_KEY}` } });
  assert.equal(response.status, 200);
  const data = Object.fromEntries((await response.json()).data.map(item => [item.id, item]));
  // auto: primary glm-5.3 has no upstream limits -> built-in table; min over targets includes manual 64000.
  assert.equal(data.auto.context_window, 1048576);
  assert.equal(data.auto.context_length, 1048576);
  assert.equal(data.auto.max_output_tokens, 131072);
  assert.equal(data.auto.context_window_source, 'builtin');
  assert.equal(data.auto.context_window_min, 64000);
  assert.equal(data.auto.max_output_tokens_min, 4096);
  assert.equal(data.flash.context_window, 1000000);
  assert.equal(data.flash.max_output_tokens, 384000);
  assert.equal(data.flash.context_window_source, 'upstream');
  assert.equal(data.mystery.context_window, null);
  assert.equal(data.mystery.context_window_min, null);
  assert.equal(JSON.stringify(data).includes('cfg-x'), false, 'public listing does not leak upstream ids');
});

test('admin views show resolved limits and sources without persisting them', async () => {
  const headers = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const upstreams = await (await fetch(`${baseUrl}/admin/api/upstreams?auth_token=${ADMIN_TOKEN}`, { headers })).json();
  const cfg = upstreams.configs.find(item => item.id === 'cfg-x');
  assert.equal(cfg.model_limits['manual-model'].context_window, 64000);
  assert.equal(cfg.model_limits['manual-model'].context_window_source, 'manual');
  assert.equal(cfg.model_limits['deepseek-v4.1-flash'].context_window_source, 'upstream');
  assert.equal(cfg.model_limits['glm-5.3'].context_window_source, 'builtin');
  assert.equal(cfg.model_limits_status.error, null);
  assert.equal(JSON.stringify(upstreams).includes('sk-limits-fake'), false);
  const routes = await (await fetch(`${baseUrl}/admin/api/model-routes?auth_token=${ADMIN_TOKEN}`, { headers })).json();
  assert.equal(routes.route_limits.auto.targets.length, 3);
  assert.equal(routes.route_limits.auto.context_window_min, 64000);
  const saved = JSON.parse(fs.readFileSync(path.join(tempDir, 'config.json'), 'utf8'));
  assert.equal(saved.configs[0].model_limits, undefined);
  const cache = path.join(tempDir, 'config.json.model-limits-cache.json');
  assert.equal(fs.existsSync(cache), true);
  assert.equal(fs.readFileSync(cache, 'utf8').includes('sk-limits-fake'), false, 'cache holds no credentials');
});
