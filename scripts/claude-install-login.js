#!/usr/bin/env node

const path = require('node:path');
const {
  installSharedClaudeCodeLogin,
  restoreClaudeCodeLogin,
  validateLocalClaudeAuthToken,
} = require('../app/claude-code-credentials');

function parseArgs(argv) {
  const args = {
    token: process.env.AIROUTER_CLAUDE_LOCAL_AUTH_TOKEN ||
      process.env.CLAUDE_CODE_OAUTH_TOKEN ||
      '',
    baseUrl: process.env.ANTHROPIC_BASE_URL || '',
    backupDir: '',
    restorePath: '',
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }

    if (arg === '--token') {
      index += 1;
      if (!argv[index]) {
        throw new Error('--token 需要一个 airouter-oauth-* token');
      }
      args.token = argv[index];
      continue;
    }

    if (arg === '--base-url') {
      index += 1;
      if (!argv[index]) {
        throw new Error('--base-url 需要一个 Airouter 地址');
      }
      args.baseUrl = argv[index];
      continue;
    }

    if (arg === '--backup-dir') {
      index += 1;
      if (!argv[index]) {
        throw new Error('--backup-dir 需要一个目录');
      }
      args.backupDir = argv[index];
      continue;
    }

    if (arg === '--restore') {
      index += 1;
      if (!argv[index]) {
        throw new Error('--restore 需要一个备份文件路径');
      }
      args.restorePath = argv[index];
      continue;
    }

    throw new Error(`未知参数: ${arg}`);
  }

  return args;
}

function printUsage() {
  console.log([
    '用法:',
    '  npm run claude:install-login -- --token airouter-oauth-xxx --base-url http://localhost:3009',
    '  npm run claude:install-login -- --restore ~/.claude/airouter-backups/claude-code-credentials-xxx.json',
    '',
    '说明:',
    '  安装模式会把 Airouter local token 写入 Claude Code 本地登录态。',
    '  macOS 写入 Keychain；其它平台写入 $CLAUDE_CONFIG_DIR/.credentials.json 或 ~/.claude/.credentials.json。',
    '  如果提供 --base-url，会同步写入 Claude Code settings.json 的 env.ANTHROPIC_BASE_URL。',
    '  写入前会自动生成备份文件，恢复时使用 --restore。',
  ].join('\n'));
}

function describeStorage(storage) {
  if (!storage || storage.type !== 'keychain') {
    return storage && storage.path ? storage.path : 'plaintext credentials';
  }

  return `${storage.serviceName} (${storage.accountName})`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return;
  }

  if (args.restorePath) {
    const restored = restoreClaudeCodeLogin({
      backupPath: path.resolve(args.restorePath),
    });
    console.log('已恢复 Claude Code 登录态。');
    console.log(`凭证存储: ${describeStorage(restored.credentials.storage)}`);
    if (restored.settings) {
      console.log(`已恢复设置: ${restored.settings.path}`);
    }
    if (restored.globalConfig) {
      console.log(`已恢复全局配置: ${restored.globalConfig.path}`);
    }
    if (restored.credentials.warning) {
      console.warn(restored.credentials.warning);
    }
    return;
  }

  const token = validateLocalClaudeAuthToken(args.token);
  const installed = installSharedClaudeCodeLogin({
    localAuthToken: token,
    baseUrl: args.baseUrl,
    backupDir: args.backupDir,
  });

  console.log('已安装 Airouter Claude Code 共享登录态。');
  console.log(`凭证存储: ${describeStorage(installed.credentials.storage)}`);
  console.log(`备份文件: ${installed.backupPath}`);
  if (installed.settings) {
    console.log(`已写入 ANTHROPIC_BASE_URL: ${installed.settings.baseUrl}`);
    console.log(`设置文件: ${installed.settings.path}`);
  } else {
    console.log('未写入 ANTHROPIC_BASE_URL；请通过环境变量或 Claude Code settings.json 指向 Airouter。');
  }
  if (installed.globalConfig) {
    console.log(`全局配置: ${installed.globalConfig.path}`);
  }
  if (installed.credentials.warning) {
    console.warn(installed.credentials.warning);
  }
  console.log('');
  console.log('验证建议: 重新打开终端，确保未设置 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 后运行 claude --debug-to-stderr。');
}

main().catch(err => {
  console.error(`Claude Code 共享登录态安装失败: ${err.message}`);
  process.exitCode = 1;
});
