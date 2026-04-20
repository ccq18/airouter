#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline/promises');
const { spawn, spawnSync } = require('node:child_process');
const { parseOpenAiConfigFile } = require('./app/openai-config');
const { generateRandomSecret } = require('./app/request-auth');

const PID_FILE = 'openai.pid';
const LOG_FILE = 'openai.log';
const CONFIG_FILE = 'openai.json';
const CONFIG_TEMPLATE_FILE = `${CONFIG_FILE}.example`;

const DEFAULT_PORT = '3009';
const DEFAULT_PROXY_PORT = 7890;
const DEFAULT_STARTUP_CHECK_DELAY_MS = 10_000;
const DEFAULT_POST_START_SETTLE_DELAY_MS = 250;
const DEFAULT_STARTUP_LOG_WAIT_MS = 2_000;
const DEFAULT_STOP_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_FORCE_STOP_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_LOG_TAIL_LINES = 100;

function readIntEnv(name, fallback) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

const STARTUP_CHECK_DELAY_MS = readIntEnv('RUN_STARTUP_CHECK_DELAY_MS', DEFAULT_STARTUP_CHECK_DELAY_MS);
const POST_START_SETTLE_DELAY_MS = readIntEnv('RUN_POST_START_SETTLE_DELAY_MS', DEFAULT_POST_START_SETTLE_DELAY_MS);
const STARTUP_LOG_WAIT_MS = readIntEnv('RUN_STARTUP_LOG_WAIT_MS', DEFAULT_STARTUP_LOG_WAIT_MS);
const STOP_WAIT_TIMEOUT_MS = readIntEnv('RUN_STOP_WAIT_TIMEOUT_MS', DEFAULT_STOP_WAIT_TIMEOUT_MS);
const FORCE_STOP_WAIT_TIMEOUT_MS = readIntEnv('RUN_FORCE_STOP_WAIT_TIMEOUT_MS', DEFAULT_FORCE_STOP_WAIT_TIMEOUT_MS);
const POLL_INTERVAL_MS = readIntEnv('RUN_POLL_INTERVAL_MS', DEFAULT_POLL_INTERVAL_MS);
const LOG_TAIL_LINES = readIntEnv('RUN_LOG_TAIL_LINES', DEFAULT_LOG_TAIL_LINES);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function configExists() {
  return fs.existsSync(CONFIG_FILE);
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
}

function readConfigValue(key, fallback) {
  const config = readConfig();
  const value = config[key];

  if (value === undefined || value === null) {
    return fallback;
  }

  const normalizedValue = String(value).trim();
  return normalizedValue || fallback;
}

function getConfiguredPort() {
  return readConfigValue('port', DEFAULT_PORT);
}

function readTemplateConfig() {
  if (!fs.existsSync(CONFIG_TEMPLATE_FILE)) {
    throw new Error(`${CONFIG_TEMPLATE_FILE} 不存在，无法创建 ${CONFIG_FILE}`);
  }

  const rawTemplate = fs.readFileSync(CONFIG_TEMPLATE_FILE, 'utf8');

  try {
    return parseOpenAiConfigFile(rawTemplate);
  } catch (error) {
    throw new Error(`${CONFIG_TEMPLATE_FILE} 不是合法模板: ${error.message}`);
  }
}

function getForcedInteractiveMode() {
  const forcedValue = process.env.AIROUTER_FORCE_INTERACTIVE;
  if (forcedValue === '1') {
    return true;
  }

  if (forcedValue === '0') {
    return false;
  }

  return null;
}

function canPromptForConfig() {
  const forcedInteractiveMode = getForcedInteractiveMode();
  if (forcedInteractiveMode !== null) {
    return forcedInteractiveMode;
  }

  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function writeJsonFile(filePath, value) {
  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, filePath);
}

function normalizeYesNoAnswer(answer, defaultValue = false) {
  const normalizedAnswer = String(answer || '').trim().toLowerCase();
  if (!normalizedAnswer) {
    return defaultValue;
  }

  if (['y', 'yes', '1', 'true', '是'].includes(normalizedAnswer)) {
    return true;
  }

  if (['n', 'no', '0', 'false', '否'].includes(normalizedAnswer)) {
    return false;
  }

  return null;
}

async function promptYesNo(rl, message, defaultValue = false) {
  const hint = defaultValue ? 'Y/n' : 'y/N';

  while (true) {
    const answer = await rl.ask(`${message} (${hint}) `);
    const normalized = normalizeYesNoAnswer(answer, defaultValue);
    if (normalized !== null) {
      return normalized;
    }

    console.log('请输入 y 或 n');
  }
}

function normalizeProxyPortInput(value, fallback = DEFAULT_PROXY_PORT) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return fallback;
  }

  if (!/^\d+$/.test(normalizedValue)) {
    return null;
  }

  const parsedPort = Number.parseInt(normalizedValue, 10);
  if (parsedPort < 1 || parsedPort > 65535) {
    return null;
  }

  return parsedPort;
}

async function promptProxyPort(rl, fallback = DEFAULT_PROXY_PORT) {
  while (true) {
    const answer = await rl.ask(`请输入本地代理端口（默认 ${fallback}） `);
    const port = normalizeProxyPortInput(answer, fallback);
    if (port !== null) {
      return port;
    }

    console.log('请输入 1-65535 之间的端口号');
  }
}

function createPromptSession() {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    return {
      ask(message) {
        return rl.question(message);
      },
      close() {
        rl.close();
      },
    };
  }

  const scriptedAnswers = fs.readFileSync(0, 'utf8').split(/\r?\n/);
  let answerIndex = 0;

  return {
    async ask(message) {
      process.stdout.write(`${message}\n`);
      const answer = scriptedAnswers[answerIndex];
      answerIndex += 1;
      return answer === undefined ? '' : answer;
    },
    close() {},
  };
}

async function runConfigWizard() {
  const templateConfig = readTemplateConfig();
  const defaultProxyPort = normalizeProxyPortInput(templateConfig.proxy_port, DEFAULT_PROXY_PORT) ?? DEFAULT_PROXY_PORT;
  const rl = createPromptSession();

  try {
    console.log(`检测到 ${CONFIG_FILE} 不存在，进入创建配置文件引导。`);

    const shouldEnableProxy = await promptYesNo(rl, '是否启用本地代理端口？', true);
    const proxyPort = shouldEnableProxy ? await promptProxyPort(rl, defaultProxyPort) : null;
    const enableApiKey = await promptYesNo(rl, '是否启用入口 apikey 校验？', false);

    const nextConfig = {
      ...templateConfig,
      apikeys: enableApiKey ? [generateRandomSecret('sk-airouter-')] : [],
    };

    if (proxyPort === null) {
      delete nextConfig.proxy_port;
    } else {
      nextConfig.proxy_port = proxyPort;
    }

    writeJsonFile(CONFIG_FILE, nextConfig);
    console.log(`已创建 ${CONFIG_FILE}`);
    if (enableApiKey) {
      console.log(`已生成入口 apikey: ${nextConfig.apikeys[0]}`);
    }
  } finally {
    rl.close();
  }
}

async function ensureConfigExists() {
  if (configExists()) {
    return;
  }

  if (!canPromptForConfig()) {
    throw new Error(
      `${CONFIG_FILE} 不存在，当前不是交互终端，无法进入创建配置文件引导。请在交互终端执行 npm start，或先手工创建 ${CONFIG_FILE}。`
    );
  }

  await runConfigWizard();
}

function removeRunStateFiles() {
  fs.rmSync(PID_FILE, { force: true });
}

function currentPid() {
  return fs.readFileSync(PID_FILE, 'utf8').trim();
}

function isPidRunning(pid) {
  const numericPid = Number.parseInt(String(pid), 10);
  if (!Number.isInteger(numericPid) || numericPid <= 0) {
    return false;
  }

  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

async function waitForPidExit(pid, timeoutMs = STOP_WAIT_TIMEOUT_MS) {
  let waitedMs = 0;

  while (isPidRunning(pid)) {
    if (waitedMs >= timeoutMs) {
      return false;
    }

    await sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
  }

  return true;
}

function forceTerminateWindowsPid(pid) {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    encoding: 'utf8',
  });

  if (result.error && result.error.code === 'ENOENT') {
    return false;
  }

  return result.status === 0;
}

async function terminatePid(pid) {
  if (!isPidRunning(pid)) {
    return true;
  }

  try {
    process.kill(Number.parseInt(String(pid), 10));
  } catch (error) {
    // Ignore races where the process exits between checks.
  }

  if (await waitForPidExit(pid, STOP_WAIT_TIMEOUT_MS)) {
    return true;
  }

  if (process.platform === 'win32') {
    forceTerminateWindowsPid(pid);
    return waitForPidExit(pid, FORCE_STOP_WAIT_TIMEOUT_MS);
  }

  try {
    process.kill(Number.parseInt(String(pid), 10), 'SIGKILL');
  } catch (error) {
    // Ignore races where the process exits between checks.
  }

  return waitForPidExit(pid, FORCE_STOP_WAIT_TIMEOUT_MS);
}

async function isPortAvailable(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    let settled = false;

    const finish = value => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    };

    server.once('error', error => {
      finish(error.code !== 'EADDRINUSE');
    });

    server.listen(Number(port), '127.0.0.1', () => {
      server.close(() => finish(true));
    });
  });
}

async function waitForPortAvailable(port, timeoutMs = STOP_WAIT_TIMEOUT_MS) {
  let waitedMs = 0;

  while (waitedMs < timeoutMs) {
    if (await isPortAvailable(port)) {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
  }

  return isPortAvailable(port);
}

function showStartupLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log('no log output captured');
    return;
  }

  const newLogs = fs.readFileSync(LOG_FILE, 'utf8');
  if (!newLogs) {
    return;
  }

  console.log('recent logs:');
  process.stdout.write(newLogs);
  if (!newLogs.endsWith('\n')) {
    process.stdout.write('\n');
  }
}

function hasStartupLinkLogs(port) {
  if (!fs.existsSync(LOG_FILE)) {
    return false;
  }

  return fs.readFileSync(LOG_FILE, 'utf8').includes(`http://localhost:${port}/admin/configs`);
}

function hasStartupLogOutput() {
  if (!fs.existsSync(LOG_FILE)) {
    return false;
  }

  return fs.statSync(LOG_FILE).size > 0;
}

async function waitForStartupLogs(port, timeoutMs = STARTUP_LOG_WAIT_MS) {
  let waitedMs = 0;

  while (waitedMs < timeoutMs) {
    if (hasStartupLogOutput() || hasStartupLinkLogs(port)) {
      return true;
    }

    await sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
  }

  return false;
}

function buildChildEnv() {
  const proxyPort = readConfigValue('proxy_port', '');
  const port = getConfiguredPort();
  const childEnv = {
    ...process.env,
    CONFIG: CONFIG_FILE,
    PORT: port,
  };

  if (!proxyPort) {
    return childEnv;
  }

  const proxyBase = `127.0.0.1:${proxyPort}`;

  return {
    ...childEnv,
    https_proxy: `http://${proxyBase}`,
    http_proxy: `http://${proxyBase}`,
    all_proxy: `socks5://${proxyBase}`,
  };
}

function spawnApp() {
  const logFd = fs.openSync(LOG_FILE, 'w');
  const child = spawn(process.execPath, ['openai.js'], {
    cwd: process.cwd(),
    detached: true,
    env: buildChildEnv(),
    stdio: ['ignore', logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);
  return child.pid;
}

async function stopTrackedProcess(pid) {
  if (!isPidRunning(pid)) {
    return true;
  }

  return terminatePid(pid);
}

async function stopExistingTrackedProcess() {
  if (!fs.existsSync(PID_FILE)) {
    return false;
  }

  const existingPid = currentPid();

  if (isPidRunning(existingPid)) {
    console.log(`stopping existing pid=${existingPid}`);
    if (!await stopTrackedProcess(existingPid)) {
      console.log(`failed to stop existing pid=${existingPid}`);
      return false;
    }
  }

  removeRunStateFiles();
  return true;
}

async function start() {
  try {
    await ensureConfigExists();
  } catch (error) {
    console.log(error.message);
    return 1;
  }

  const stoppedExisting = await stopExistingTrackedProcess();
  if (fs.existsSync(PID_FILE)) {
    return 1;
  }

  const port = getConfiguredPort();
  if (stoppedExisting && !(await waitForPortAvailable(port, STOP_WAIT_TIMEOUT_MS))) {
    console.log(`port=${port} is still in use`);
    return 1;
  }

  if (!(await isPortAvailable(port))) {
    console.log(`port=${port} is already in use by another process`);
    return 1;
  }

  console.log('starting');
  const pid = spawnApp();
  fs.writeFileSync(PID_FILE, `${pid}\n`);

  await sleep(STARTUP_CHECK_DELAY_MS);
  await sleep(POST_START_SETTLE_DELAY_MS);

  if (!isPidRunning(currentPid())) {
    console.log('failed to start');
    showStartupLogs();
    removeRunStateFiles();
    return 1;
  }

  await waitForStartupLogs(port, STARTUP_LOG_WAIT_MS);

  console.log(`started pid=${currentPid()}`);
  showStartupLogs();
  return 0;
}

function printTail(content, lineCount) {
  if (!content) {
    return;
  }

  const trimmedContent = content.endsWith('\n') ? content.slice(0, -1) : content;
  if (!trimmedContent) {
    return;
  }

  const lines = trimmedContent.split('\n');
  const recentLines = lines.slice(-lineCount);
  process.stdout.write(`${recentLines.join('\n')}\n`);
}

function readFileSlice(filePath, start, end) {
  const fd = fs.openSync(filePath, 'r');

  try {
    const length = Math.max(0, end - start);
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function logs() {
  fs.closeSync(fs.openSync(LOG_FILE, 'a'));

  let offset = 0;
  try {
    const content = fs.readFileSync(LOG_FILE, 'utf8');
    printTail(content, LOG_TAIL_LINES);
    offset = fs.statSync(LOG_FILE).size;
  } catch (error) {
    offset = 0;
  }

  setInterval(() => {
    try {
      const stats = fs.statSync(LOG_FILE);
      if (stats.size < offset) {
        offset = 0;
      }

      if (stats.size === offset) {
        return;
      }

      const chunk = readFileSlice(LOG_FILE, offset, stats.size);
      offset = stats.size;

      if (chunk) {
        process.stdout.write(chunk);
      }
    } catch (error) {
      // Keep following if the file is recreated while the command is running.
    }
  }, POLL_INTERVAL_MS);
}

async function stop() {
  let stoppedAny = false;

  if (fs.existsSync(PID_FILE)) {
    const existingPid = currentPid();

    if (isPidRunning(existingPid)) {
      if (!await stopTrackedProcess(existingPid)) {
        console.log(`failed to stop pid=${existingPid}`);
        return 1;
      }

      stoppedAny = true;
    }

    removeRunStateFiles();
  }

  console.log(stoppedAny ? 'stopped' : 'not running');
  return 0;
}

async function restart() {
  const stopCode = await stop();
  if (stopCode !== 0) {
    return stopCode;
  }

  return start();
}

async function main() {
  const command = process.argv[2] || 'start';

  switch (command) {
    case 'logs':
      logs();
      return;
    case 'stop':
      process.exitCode = await stop();
      return;
    case 'restart':
      process.exitCode = await restart();
      return;
    case 'start':
      process.exitCode = await start();
      return;
    default:
      console.log('usage: node run.js [start|stop|restart|logs]');
  }
}

main().catch(error => {
  console.error(error.stack || String(error));
  process.exitCode = 1;
});
