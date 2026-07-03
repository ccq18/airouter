#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const {
  appendClaudeTokenConfig,
  buildClaudeAuthorizeUrl,
  exchangeCodeForTokens,
  fetchClaudeOAuthProfile,
  generateCodeChallenge,
  generateCodeVerifier,
  generateLocalClaudeAuthToken,
  generateState,
  parseClaudeOAuthCallbackCode,
  sha256Hex,
  startOAuthCallbackServer,
} = require('../app/claude-oauth');
const {
  readParsedConfigFile,
  writeParsedConfigFile,
} = require('../app/config-editor');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_FILE = 'openai.json';
const DEFAULT_CONFIG_TEMPLATE_FILE = 'openai.json.example';

function parseArgs(argv) {
  const args = {
    configFile: process.env.CONFIG || DEFAULT_CONFIG_FILE,
    openBrowser: process.env.CLAUDE_AUTH_OPEN === '1',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    if (arg === '--open') {
      args.openBrowser = true;
      continue;
    }

    if (arg === '--config') {
      index += 1;
      if (!argv[index]) {
        throw new Error('--config 需要一个文件路径');
      }
      args.configFile = argv[index];
      continue;
    }

    throw new Error(`未知参数: ${arg}`);
  }

  return args;
}

function resolveConfigFile(configFile) {
  return path.isAbsolute(configFile)
    ? configFile
    : path.resolve(PROJECT_ROOT, configFile);
}

function readConfigForAppend(configFile) {
  if (fs.existsSync(configFile)) {
    return readParsedConfigFile(configFile, { validate: false });
  }

  const templateFile = path.resolve(path.dirname(configFile), DEFAULT_CONFIG_TEMPLATE_FILE);
  if (fs.existsSync(templateFile)) {
    return readParsedConfigFile(templateFile, { validate: false });
  }

  return {
    apikeys: [],
    auth_token: '',
    port: 3009,
    configs: [],
    disabled_configs: [],
  };
}

function printUsage() {
  console.log([
    '用法: npm run claude:login -- [--config openai.json] [--open]',
    '',
    '完成 Claude OAuth 授权后，脚本会把 claude_token 配置追加到 openai.json，',
    '并生成一个本地 fake auth token 写入 apikeys。',
    '共享 Claude Code 登录态时，在客户端运行 npm run claude:install-login 安装这枚 token。',
  ].join('\n'));
}

function tryOpenBrowser(url) {
  if (process.platform !== 'darwin') {
    return false;
  }

  const child = spawn('open', [url], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return true;
}

function readClaudeCodeKeychainOAuthAccessToken() {
  if (process.platform !== 'darwin') {
    return '';
  }

  const result = spawnSync('security', [
    'find-generic-password',
    '-s',
    'Claude Code-credentials',
    '-a',
    process.env.USER || '',
    '-w',
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || !result.stdout) {
    return '';
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return parsed && parsed.claudeAiOauth && typeof parsed.claudeAiOauth.accessToken === 'string'
      ? parsed.claudeAiOauth.accessToken
      : '';
  } catch (err) {
    return '';
  }
}

function waitForPastedOAuthCallbackCode({ state }) {
  if (!process.stdin.isTTY) {
    return null;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const promise = new Promise((resolve, reject) => {
    rl.on('line', line => {
      try {
        resolve(parseClaudeOAuthCallbackCode(line, { state }));
      } catch (err) {
        console.warn(`无法解析回调地址: ${err.message}`);
        console.log('请重新粘贴浏览器地址栏里的 /callback?... 或完整 http://localhost:端口/callback?... 后回车。');
      }
    });
    rl.on('error', reject);
  });

  return {
    promise,
    close: () => rl.close(),
  };
}

async function waitForOAuthCode({ callbackServer, state }) {
  const pastedCallback = waitForPastedOAuthCallbackCode({ state });
  const waiters = [callbackServer.waitForCode()];
  if (pastedCallback) {
    waiters.push(pastedCallback.promise);
  }

  try {
    return await Promise.race(waiters);
  } finally {
    if (pastedCallback) {
      pastedCallback.close();
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  const configFile = resolveConfigFile(args.configFile);
  const parsed = readConfigForAppend(configFile);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const callbackServer = await startOAuthCallbackServer({ state });
  const authorizeUrl = buildClaudeAuthorizeUrl({
    codeChallenge,
    state,
    port: callbackServer.port,
  });

  console.log('请在浏览器打开下面的 Claude 授权链接：');
  console.log(authorizeUrl);
  if (args.openBrowser && tryOpenBrowser(authorizeUrl)) {
    console.log('已尝试自动打开浏览器。');
  }
  console.log('等待授权回调...');
  console.log('如果脚本运行在远程服务器，本地浏览器打开 localhost 回调失败时，直接把地址栏里的 /callback?... 或完整回调 URL 粘贴到这里并回车。');

  try {
    const code = await waitForOAuthCode({ callbackServer, state });
    console.log('已收到授权码，正在换取 Claude OAuth token...');
    const tokenResponse = await exchangeCodeForTokens({
      code,
      state,
      codeVerifier,
      port: callbackServer.port,
    });

    let profile = null;
    try {
      profile = await fetchClaudeOAuthProfile(tokenResponse.access_token);
    } catch (err) {
      console.warn(`获取 Claude OAuth profile 失败，将继续写入 token: ${err.message}`);
    }

    const localAuthToken = generateLocalClaudeAuthToken();
    const requestAuthTokenSha256s = [];
    const keychainAccessToken = readClaudeCodeKeychainOAuthAccessToken();
    const keychainAccessTokenSha256 = sha256Hex(keychainAccessToken);
    const tokenResponseAccessTokenSha256 = sha256Hex(tokenResponse.access_token);
    if (keychainAccessTokenSha256 && keychainAccessTokenSha256 !== tokenResponseAccessTokenSha256) {
      requestAuthTokenSha256s.push(keychainAccessTokenSha256);
    }

    const nextParsed = appendClaudeTokenConfig(parsed, {
      tokenResponse: {
        ...tokenResponse,
        request_auth_token_sha256s: requestAuthTokenSha256s,
      },
      profile,
      localAuthToken,
    });

    writeParsedConfigFile(configFile, nextParsed, { validate: false });

    console.log(`已写入配置: ${configFile}`);
    console.log('');
    console.log('Claude Code 使用示例：');
    console.log(`export ANTHROPIC_BASE_URL=http://localhost:${nextParsed.port || 3009}`);
    console.log(`export CLAUDE_CODE_OAUTH_TOKEN=${localAuthToken}`);
    console.log('unset ANTHROPIC_API_KEY');
    console.log('unset ANTHROPIC_AUTH_TOKEN');
    console.log('');
    console.log('共享登录态安装示例（写入 Claude Code 本地凭证，交互模式无需再运行 /login）：');
    console.log(`npm run claude:install-login -- --token ${localAuthToken} --base-url http://localhost:${nextParsed.port || 3009}`);
    if (requestAuthTokenSha256s.length > 0) {
      console.log('');
      console.log('已记录本机 Claude Code Keychain OAuth token 的 SHA256，用于兼容交互式主请求。');
    }
  } finally {
    await callbackServer.close();
  }
}

main().catch(err => {
  console.error(`Claude auth 登录失败: ${err.message}`);
  process.exitCode = 1;
});
