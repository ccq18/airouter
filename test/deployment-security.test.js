const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

test('deployed admin authentication never discloses the configured secret', { timeout: 15000 }, async () => {
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-admin-security-'));
  const adminSecret = 'fixture-admin-not-for-disclosure';
  const entrySecret = 'fixture-entry-not-for-disclosure';
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ port, auth_token: adminSecret, apikeys: [entrySecret], configs: [] }), { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(root, 'openai.js')], {
    cwd: dir,
    env: { ...process.env, CONFIG: config, PORT: String(port), AIROUTER_BIND_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) throw new Error(`Service exited before ready (${child.exitCode})`);
      try {
        const response = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${entrySecret}` } });
        await response.text();
        if (response.ok) { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(ready, true, 'service must start using the isolated config');
    const unauthorized = await fetch(`${base}/admin/api/configs?auth_token=incorrect`);
    assert.equal(unauthorized.status, 401);
    const denialBody = await unauthorized.text();
    assert.equal(denialBody.includes(adminSecret), false, '401 response must not reveal admin secret');
    const valid = await fetch(`${base}/admin/api/upstreams?auth_token=${adminSecret}`);
    assert.equal(valid.status, 200);
    await valid.text();
    assert.equal(output.includes(adminSecret), false, 'startup output must not contain admin secret');
    assert.equal(output.includes(entrySecret), false, 'startup output must not contain ingress secret');
    const address = child.pid;
    assert.ok(address > 0);
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
