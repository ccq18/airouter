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

function prepareWorkspace(appScript, initialLog = '', config = { proxy_port: 7890 }) {
  const cwd = makeTempDir();
  const binDir = path.join(cwd, 'bin');

  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(cwd, 'openai.json'), `${JSON.stringify(config)}\n`);
  fs.writeFileSync(path.join(cwd, 'openai.js'), appScript);

  if (initialLog) {
    fs.writeFileSync(path.join(cwd, 'openai.log'), initialLog);
  }

  writeExecutable(path.join(binDir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');

  return { cwd, binDir };
}

function runCommand(args, options) {
  return spawnSync('bash', [runScript, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PATH: `${options.binDir}:${options.systemPath ?? process.env.PATH}`,
    },
    encoding: 'utf8',
  });
}

function runLogsCommand(options) {
  return spawnSync('bash', [runScript, 'logs'], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PATH: `${options.binDir}:${options.systemPath ?? process.env.PATH}`,
    },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 500,
    killSignal: 'SIGTERM',
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

  assert.doesNotMatch(script, /STARTUP_CHECK_DELAY_SECONDS=/);
  assert.doesNotMatch(script, /STARTUP_LOG_LINES=/);
  assert.doesNotMatch(script, /LOG_TAIL_LINES=/);
  assert.doesNotMatch(script, /CONFIG_NODE_BIN=/);
  assert.match(script, /node -e/);
  assert.match(script, /sleep 10/);
  assert.match(script, /tail -n 20 "\$LOG_FILE"/);
  assert.match(script, /tail -n 100 -f "\$LOG_FILE"/);
});

test('start shows only fresh startup logs when the process stays up', () => {
  const workspace = prepareWorkspace(
    'console.log("fresh ready"); setTimeout(() => {}, 30000);\n',
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
    'setTimeout(() => {}, 30000);\n',
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

test('start reads config without jq in PATH', () => {
  const workspace = prepareWorkspace(
    'console.log(`port=${process.env.PORT} proxy=${process.env.https_proxy}`); setTimeout(() => {}, 30000);\n',
    '',
    { proxy_port: 6789, port: 3456 }
  );

  const startResult = runCommand(['start'], {
    ...workspace,
    systemPath: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  });

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /openai proxy: http:\/\/localhost:3456\/v1/);
  assert.match(startResult.stdout, /port=3456 proxy=http:\/\/127\.0\.0\.1:6789/);

  const stopResult = runCommand(['stop'], {
    ...workspace,
    systemPath: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
  });
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('logs prints the latest 100 lines before following new output', () => {
  const workspace = prepareWorkspace('setTimeout(() => {}, 30000);\n');
  const lines = Array.from({ length: 120 }, (_, index) => `line-${index + 1}`).join('\n');

  fs.writeFileSync(path.join(workspace.cwd, 'openai.log'), `${lines}\n`);

  const logsResult = runLogsCommand(workspace);

  assert.equal(logsResult.signal, 'SIGTERM');
  assert.doesNotMatch(logsResult.stdout, /line-1\n/);
  assert.match(logsResult.stdout, /^line-21$/m);
  assert.match(logsResult.stdout, /^line-120$/m);
});

test('logs follows an empty log file when it does not exist yet', () => {
  const workspace = prepareWorkspace('setTimeout(() => {}, 30000);\n');

  const logsResult = runLogsCommand(workspace);

  assert.equal(logsResult.signal, 'SIGTERM');
  assert.equal(logsResult.stdout, '');
});

test('start kills the existing process and launches a replacement', () => {
  const terminatedMarker = path.join(os.tmpdir(), `airouter-run-terminated-${process.pid}-${Date.now()}`);

  const workspace = prepareWorkspace(
    'const fs = require("fs");\n' +
      `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(terminatedMarker)}, "terminated"); process.exit(0); });\n` +
      'console.log("replacement ready");\n' +
      'setInterval(() => {}, 1000);\n'
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
    'console.error("startup boom"); process.exit(1);\n',
    'old log line\n'
  );

  const startResult = runCommand(['start'], workspace);

  assert.notEqual(startResult.status, 0);
  assert.match(startResult.stdout, /^starting\nfailed to start/);
  assert.match(startResult.stdout, /startup boom/);
  assert.doesNotMatch(startResult.stdout, /old log line/);
  assert.equal(fs.existsSync(path.join(workspace.cwd, 'openai.pid')), false);
});
