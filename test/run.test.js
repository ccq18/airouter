const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runScript = path.resolve(__dirname, '..', 'run.sh');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-run-'));
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

function prepareWorkspace(nodeScript, initialLog = '', config = { proxy_port: 7890 }) {
  const cwd = makeTempDir();
  const binDir = path.join(cwd, 'bin');

  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(cwd, 'openai.json'), `${JSON.stringify(config)}\n`);
  fs.writeFileSync(path.join(cwd, 'openai.js'), '// test stub\n');

  if (initialLog) {
    fs.writeFileSync(path.join(cwd, 'openai.log'), initialLog);
  }

  writeExecutable(path.join(binDir, 'node'), nodeScript);

  return { cwd, binDir };
}

function runCommand(args, options) {
  return spawnSync('bash', [runScript, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PATH: `${options.binDir}:${process.env.PATH}`,
      STARTUP_CHECK_DELAY_SECONDS: options.startupCheckDelaySeconds ?? '1',
    },
    encoding: 'utf8',
  });
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFile(filePath, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return true;
    }

    sleepMs(25);
  }

  return fs.existsSync(filePath);
}

test('run.sh defaults to a 10 second startup check delay', () => {
  const script = fs.readFileSync(runScript, 'utf8');

  assert.match(script, /STARTUP_CHECK_DELAY_SECONDS="\$\{STARTUP_CHECK_DELAY_SECONDS:-10\}"/);
});

test('start shows only fresh startup logs when the process stays up', () => {
  const workspace = prepareWorkspace(
    '#!/usr/bin/env bash\n' +
      'echo "fresh ready"\n' +
      'sleep 30\n',
    'old log line\n'
  );

  const startResult = runCommand(['start'], workspace);

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /^starting\nstarted pid=\d+/);
  assert.match(startResult.stdout, /openai proxy: http:\/\/localhost:3000\/v1/);
  assert.match(startResult.stdout, /claude proxy: http:\/\/localhost:3000\/claude/);
  assert.match(startResult.stdout, /fresh ready/);
  assert.doesNotMatch(startResult.stdout, /old log line/);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
  assert.match(stopResult.stdout, /stopped/);
});

test('start passes the configured port from openai.json', () => {
  const workspace = prepareWorkspace(
    '#!/usr/bin/env bash\n' +
      'sleep 30\n',
    '',
    { proxy_port: 7890, port: 3456 }
  );

  const startResult = runCommand(['start'], workspace);

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /^starting\nstarted pid=\d+/);
  assert.match(startResult.stdout, /openai proxy: http:\/\/localhost:3456\/v1/);
  assert.match(startResult.stdout, /claude proxy: http:\/\/localhost:3456\/claude/);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start kills the existing process and launches a replacement', () => {
  const terminatedMarker = path.join(os.tmpdir(), `airouter-run-terminated-${process.pid}-${Date.now()}`);

  const workspace = prepareWorkspace(
    '#!/usr/bin/env bash\n' +
      `trap 'echo terminated > "${terminatedMarker}"; exit 0' TERM\n` +
      'echo "replacement ready"\n' +
      'while :; do :; done\n'
  );

  const firstStartResult = runCommand(['start'], workspace);
  assert.equal(firstStartResult.status, 0, firstStartResult.stderr);

  const firstPid = fs.readFileSync(path.join(workspace.cwd, 'openai.pid'), 'utf8').trim();
  assert.match(firstPid, /^\d+$/);

  const secondStartResult = runCommand(['start'], workspace);
  assert.equal(secondStartResult.status, 0, secondStartResult.stderr);
  assert.match(secondStartResult.stdout, new RegExp(`^stopping existing pid=${firstPid}\\nstarting\\nstarted pid=\\d+`));

  const secondPid = fs.readFileSync(path.join(workspace.cwd, 'openai.pid'), 'utf8').trim();
  assert.notEqual(secondPid, firstPid);
  assert.equal(waitForFile(terminatedMarker), true);
  assert.equal(fs.readFileSync(terminatedMarker, 'utf8').trim(), 'terminated');

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start fails fast and prints fresh startup errors when the process exits', () => {
  const workspace = prepareWorkspace(
    '#!/usr/bin/env bash\n' +
      'echo "startup boom" >&2\n' +
      'exit 1\n',
    'old log line\n'
  );

  const startResult = runCommand(['start'], workspace);

  assert.notEqual(startResult.status, 0);
  assert.match(startResult.stdout, /^starting\nfailed to start/);
  assert.match(startResult.stdout, /startup boom/);
  assert.doesNotMatch(startResult.stdout, /old log line/);
  assert.equal(fs.existsSync(path.join(workspace.cwd, 'openai.pid')), false);
});
