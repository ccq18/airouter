const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runScript = path.resolve(__dirname, '..', 'run.js');
const openaiScript = path.resolve(__dirname, '..', 'openai.js');
const exampleConfigFile = path.resolve(__dirname, '..', 'openai.json.example');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-run-'));
}

function prepareWorkspace(appScript, initialLog = '', config = { proxy_port: 7890 }) {
  const cwd = makeTempDir();

  fs.writeFileSync(path.join(cwd, 'openai.json'), `${JSON.stringify(config)}\n`);
  fs.writeFileSync(path.join(cwd, 'openai.js'), appScript);

  if (initialLog) {
    fs.writeFileSync(path.join(cwd, 'openai.log'), initialLog);
  }

  return { cwd };
}

function prepareWorkspaceWithoutConfig(appScript, initialLog = '') {
  const cwd = makeTempDir();

  fs.writeFileSync(path.join(cwd, 'openai.js'), appScript);
  fs.copyFileSync(exampleConfigFile, path.join(cwd, 'openai.json.example'));

  if (initialLog) {
    fs.writeFileSync(path.join(cwd, 'openai.log'), initialLog);
  }

  return { cwd };
}

function runCommand(args, options) {
  return spawnSync(process.execPath, [runScript, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PATH: options.systemPath ?? process.env.PATH,
      RUN_STARTUP_CHECK_DELAY_MS: '0',
      RUN_POST_START_SETTLE_DELAY_MS: '250',
      RUN_POLL_INTERVAL_MS: '25',
      ...options.extraEnv,
    },
    encoding: 'utf8',
    input: options.input,
  });
}

function runLogsCommand(options) {
  return spawnSync(process.execPath, [runScript, 'logs'], {
    cwd: options.cwd,
    env: {
      ...process.env,
      PATH: options.systemPath ?? process.env.PATH,
      RUN_POLL_INTERVAL_MS: '25',
    },
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 500,
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

function buildManagedAppScript({
  startupLog = 'fresh ready',
  delayedStartupLog = null,
  delayedStartupLogMs = 0,
  shutdownDelayMs = 0,
  shutdownMarker = null,
  lockFile = null,
  failOnExistingLock = false,
  extraStartupCode = '',
}) {
  const startupStatements = [];

  if (failOnExistingLock && lockFile) {
    startupStatements.push(
      `if (fs.existsSync(${JSON.stringify(lockFile)})) {`,
      '  console.error("resource busy");',
      '  process.exit(1);',
      '}'
    );
  }

  if (lockFile) {
    startupStatements.push(`fs.writeFileSync(${JSON.stringify(lockFile)}, String(process.pid));`);
  }

  if (startupLog) {
    startupStatements.push(`console.log(${JSON.stringify(startupLog)});`);
  }

  if (delayedStartupLog) {
    startupStatements.push(`setTimeout(() => console.log(${JSON.stringify(delayedStartupLog)}), ${delayedStartupLogMs});`);
  }

  if (extraStartupCode) {
    startupStatements.push(extraStartupCode);
  }

  const shutdownStatements = [];

  if (lockFile) {
    shutdownStatements.push(
      `if (fs.existsSync(${JSON.stringify(lockFile)})) {`,
      `  fs.unlinkSync(${JSON.stringify(lockFile)});`,
      '}'
    );
  }

  if (shutdownMarker) {
    shutdownStatements.push(`fs.writeFileSync(${JSON.stringify(shutdownMarker)}, "terminated");`);
  }

  shutdownStatements.push('process.exit(0);');

  const shutdownBody = shutdownDelayMs > 0
    ? `setTimeout(() => {\n${shutdownStatements.map(line => `      ${line}`).join('\n')}\n    }, ${shutdownDelayMs});`
    : shutdownStatements.join('\n    ');

  return [
    'const fs = require("node:fs");',
    'let shuttingDown = false;',
    'function beginShutdown() {',
    '  if (shuttingDown) {',
    '    return;',
    '  }',
    '  shuttingDown = true;',
    `  ${shutdownBody}`,
    '}',
    ...startupStatements,
    'process.on("SIGTERM", beginShutdown);',
    'process.on("SIGINT", beginShutdown);',
    'setInterval(() => {}, 1000);',
  ].join('\n');
}

test('run.js keeps the 10 second default startup delay and does not depend on lsof or control files', () => {
  const script = fs.readFileSync(runScript, 'utf8');

  assert.match(script, /const DEFAULT_STARTUP_CHECK_DELAY_MS = 10_000;/);
  assert.match(script, /const DEFAULT_LOG_TAIL_LINES = 100;/);
  assert.match(script, /port=\$\{port\} is already in use by another process/);
  assert.doesNotMatch(script, /\blsof\b/);
  assert.doesNotMatch(script, /openai\.control/);
  assert.doesNotMatch(script, /AIROUTER_CONTROL_/);
  assert.doesNotMatch(script, /STARTUP_CHECK_DELAY_SECONDS=/);
});

test('openai.js startup logs do not print local or LAN access hints', () => {
  const script = fs.readFileSync(openaiScript, 'utf8');

  assert.doesNotMatch(script, /本机访问:/);
  assert.doesNotMatch(script, /局域网\/外网访问:/);
});

test('start shows only fresh startup logs when the process stays up', () => {
  const workspace = prepareWorkspace(
    buildManagedAppScript({ startupLog: 'fresh ready' }),
    'old log line\n'
  );

  const startResult = runCommand(['start'], workspace);

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /^starting\nstarted pid=\d+/);
  assert.match(startResult.stdout, /fresh ready/);
  assert.doesNotMatch(startResult.stdout, /old log line/);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
  assert.match(stopResult.stdout, /stopped/);
});

test('start waits briefly for startup links when logs arrive late', () => {
  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: null,
      delayedStartupLog: '配置管理: http://localhost:3009/admin/configs',
      delayedStartupLogMs: 600,
    }),
    'old log line\n'
  );

  const startResult = runCommand(['start'], workspace);

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /配置管理: http:\/\/localhost:3009\/admin\/configs/);
  assert.doesNotMatch(startResult.stdout, /old log line/);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start shows all fresh startup logs instead of truncating to the last 20 lines', () => {
  const freshLines = Array.from({ length: 30 }, (_, index) => `fresh-line-${index + 1}`).join('\n');
  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: null,
      extraStartupCode: `${JSON.stringify(freshLines)}.split("\\n").forEach(line => console.log(line));`,
    }),
    'old log line\n'
  );

  const startResult = runCommand(['start'], workspace);

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /fresh-line-1/);
  assert.match(startResult.stdout, /fresh-line-30/);
  assert.doesNotMatch(startResult.stdout, /old log line/);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start passes the configured port from openai.json without creating control files', () => {
  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: null,
      extraStartupCode: 'console.log(`port=${process.env.PORT}`);',
    }),
    '',
    { proxy_port: 7890, port: 3456 }
  );

  const startResult = runCommand(['start'], workspace);

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /^starting\nstarted pid=\d+/);
  assert.match(startResult.stdout, /port=3456/);
  assert.equal(fs.existsSync(path.join(workspace.cwd, 'openai.control.json')), false);
  assert.equal(fs.existsSync(path.join(workspace.cwd, 'openai.control.request.json')), false);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start works with a minimal PATH and without Unix helper tools', () => {
  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: null,
      extraStartupCode: 'console.log(`port=${process.env.PORT} proxy=${process.env.https_proxy}`);',
    }),
    '',
    { proxy_port: 6789, port: 3456 }
  );

  const startResult = runCommand(['start'], {
    ...workspace,
    systemPath: path.dirname(process.execPath),
  });

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /port=3456 proxy=http:\/\/127\.0\.0\.1:6789/);

  const stopResult = runCommand(['stop'], {
    ...workspace,
    systemPath: path.dirname(process.execPath),
  });
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start works without proxy_port and preserves inherited proxy env', () => {
  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: null,
      extraStartupCode: 'console.log(`https=${process.env.https_proxy} http=${process.env.http_proxy} all=${process.env.all_proxy}`);',
    }),
    '',
    { port: 3456 }
  );

  const inheritedProxyEnv = {
    https_proxy: 'http://proxy.example.internal:8080',
    http_proxy: 'http://proxy.example.internal:8080',
    all_proxy: 'socks5://proxy.example.internal:1080',
  };

  const startResult = runCommand(['start'], {
    ...workspace,
    extraEnv: inheritedProxyEnv,
  });

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /https=http:\/\/proxy\.example\.internal:8080/);
  assert.match(startResult.stdout, /http=http:\/\/proxy\.example\.internal:8080/);
  assert.match(startResult.stdout, /all=socks5:\/\/proxy\.example\.internal:1080/);

  const stopResult = runCommand(['stop'], {
    ...workspace,
    extraEnv: inheritedProxyEnv,
  });
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start creates openai.json from the example template and continues startup with a custom proxy port', () => {
  const workspace = prepareWorkspaceWithoutConfig(
    buildManagedAppScript({
      startupLog: null,
      extraStartupCode: 'console.log(`port=${process.env.PORT} proxy=${process.env.https_proxy}`);',
    })
  );

  const startResult = runCommand(['start'], {
    ...workspace,
    input: 'y\n8899\ny\n',
    extraEnv: {
      AIROUTER_FORCE_INTERACTIVE: '1',
    },
  });

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /starting/);
  assert.match(startResult.stdout, /proxy=http:\/\/127\.0\.0\.1:8899/);

  const savedConfig = JSON.parse(fs.readFileSync(path.join(workspace.cwd, 'openai.json'), 'utf8'));
  assert.equal(savedConfig.proxy_port, 8899);
  assert.equal(savedConfig.apikeys.length, 1);
  assert.match(savedConfig.apikeys[0], /^sk-airouter-/);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start enables the proxy by default and uses the default proxy port when the first two wizard answers are blank', () => {
  const workspace = prepareWorkspaceWithoutConfig(
    buildManagedAppScript({
      startupLog: null,
      extraStartupCode: 'console.log(`proxy=${process.env.https_proxy}`);',
    })
  );

  const startResult = runCommand(['start'], {
    ...workspace,
    input: '\n\nn\n',
    extraEnv: {
      AIROUTER_FORCE_INTERACTIVE: '1',
    },
  });

  assert.equal(startResult.status, 0, startResult.stderr);
  assert.match(startResult.stdout, /proxy=http:\/\/127\.0\.0\.1:7890/);

  const savedConfig = JSON.parse(fs.readFileSync(path.join(workspace.cwd, 'openai.json'), 'utf8'));
  assert.equal(savedConfig.proxy_port, 7890);
  assert.deepEqual(savedConfig.apikeys, []);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
});

test('start fails with a clear message when config is missing in non-interactive mode', () => {
  const workspace = prepareWorkspaceWithoutConfig(
    buildManagedAppScript({ startupLog: 'should not start' })
  );

  const startResult = runCommand(['start'], {
    ...workspace,
    extraEnv: {
      AIROUTER_FORCE_INTERACTIVE: '0',
    },
  });

  assert.notEqual(startResult.status, 0);
  assert.match(startResult.stdout, /openai\.json 不存在/);
  assert.match(startResult.stdout, /交互终端/);
  assert.equal(fs.existsSync(path.join(workspace.cwd, 'openai.json')), false);
});

test('logs prints the latest 100 lines before following new output', () => {
  const workspace = prepareWorkspace(buildManagedAppScript({ startupLog: null }));
  const lines = Array.from({ length: 120 }, (_, index) => `line-${index + 1}`).join('\n');

  fs.writeFileSync(path.join(workspace.cwd, 'openai.log'), `${lines}\n`);

  const logsResult = runLogsCommand(workspace);

  assert.equal(logsResult.status, null);
  assert.doesNotMatch(logsResult.stdout, /line-1\n/);
  assert.match(logsResult.stdout, /^line-21$/m);
  assert.match(logsResult.stdout, /^line-120$/m);
});

test('logs follows an empty log file when it does not exist yet', () => {
  const workspace = prepareWorkspace(buildManagedAppScript({ startupLog: null }));

  const logsResult = runLogsCommand(workspace);

  assert.equal(logsResult.status, null);
  assert.equal(logsResult.stdout, '');
});

test('start stops the existing managed process and launches a replacement', () => {
  const terminatedMarker = path.join(os.tmpdir(), `airouter-run-terminated-${process.pid}-${Date.now()}`);

  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: 'replacement ready',
      shutdownMarker: terminatedMarker,
    })
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

test('stop waits for the process to finish shutting down before returning', () => {
  const terminatedMarker = path.join(os.tmpdir(), `airouter-run-stop-${process.pid}-${Date.now()}`);
  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: 'running',
      shutdownDelayMs: 200,
      shutdownMarker: terminatedMarker,
    })
  );

  const startResult = runCommand(['start'], workspace);
  assert.equal(startResult.status, 0, startResult.stderr);

  const stopResult = runCommand(['stop'], workspace);
  assert.equal(stopResult.status, 0, stopResult.stderr);
  assert.match(stopResult.stdout, /stopped/);
  assert.equal(fs.existsSync(terminatedMarker), true);
});

test('start waits for the previous instance to release its exclusive resource before relaunching', () => {
  const terminatedMarker = path.join(os.tmpdir(), `airouter-run-lock-terminated-${process.pid}-${Date.now()}`);
  const lockFile = path.join(os.tmpdir(), `airouter-run-lock-${process.pid}-${Date.now()}`);
  const workspace = prepareWorkspace(
    buildManagedAppScript({
      startupLog: 'locked',
      lockFile,
      failOnExistingLock: true,
      shutdownDelayMs: 200,
      shutdownMarker: terminatedMarker,
    })
  );

  const firstStartResult = runCommand(['start'], workspace);
  assert.equal(firstStartResult.status, 0, firstStartResult.stderr);

  const secondStartResult = runCommand(['start'], workspace);
  assert.equal(secondStartResult.status, 0, secondStartResult.stderr);
  assert.match(secondStartResult.stdout, /stopping existing pid=\d+/);
  assert.match(secondStartResult.stdout, /started pid=\d+/);
  assert.equal(waitForFile(terminatedMarker), true);

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
