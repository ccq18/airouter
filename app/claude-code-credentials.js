const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKUP_TYPE = 'airouter-claude-code-credentials-backup';
const BACKUP_VERSION = 1;
const CREDENTIALS_SERVICE_SUFFIX = '-credentials';
const DEFAULT_CLAUDE_CONFIG_DIR_NAME = '.claude';
const SHARED_LOGIN_SCOPES = ['user:inference'];
const SECURITY_STDIN_LINE_LIMIT = 4096 - 64;
const SHARED_LOGIN_SETTINGS_ENV_REMOVALS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];
const SHARED_LOGIN_SETTINGS_REMOVALS = [
  'apiKeyHelper',
];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function normalizeNfc(value) {
  return normalizeString(value).normalize('NFC');
}

function validateLocalClaudeAuthToken(value) {
  const token = normalizeString(value);
  if (!token) {
    throw new Error('Claude Code shared login token 不能为空');
  }

  if (!/^airouter-oauth-[A-Za-z0-9._-]+$/.test(token)) {
    throw new Error('Claude Code shared login token 必须是 airouter-oauth-* 格式');
  }

  return token;
}

function getClaudeConfigHomeDir({ env = process.env, homeDir = os.homedir() } = {}) {
  return normalizeNfc(env.CLAUDE_CONFIG_DIR || path.join(homeDir, DEFAULT_CLAUDE_CONFIG_DIR_NAME));
}

function getOauthFileSuffix(env = process.env) {
  if (env.CLAUDE_CODE_CUSTOM_OAUTH_URL) {
    return '-custom-oauth';
  }

  if (env.USER_TYPE === 'ant') {
    if (isTruthy(env.USE_LOCAL_OAUTH)) {
      return '-local-oauth';
    }
    if (isTruthy(env.USE_STAGING_OAUTH)) {
      return '-staging-oauth';
    }
  }

  return '';
}

function isTruthy(value) {
  if (!value) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function getUsername({ env = process.env, userInfo = os.userInfo } = {}) {
  if (env.USER) {
    return env.USER;
  }

  try {
    return userInfo().username;
  } catch (err) {
    return 'claude-code-user';
  }
}

function getClaudeCodeKeychainServiceName({ env = process.env, homeDir = os.homedir() } = {}) {
  const configDir = getClaudeConfigHomeDir({ env, homeDir });
  const isDefaultDir = !env.CLAUDE_CONFIG_DIR;
  const dirHash = isDefaultDir
    ? ''
    : `-${crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;

  return `Claude Code${getOauthFileSuffix(env)}${CREDENTIALS_SERVICE_SUFFIX}${dirHash}`;
}

function getPlaintextCredentialsPath({ env = process.env, homeDir = os.homedir() } = {}) {
  return path.join(getClaudeConfigHomeDir({ env, homeDir }), '.credentials.json');
}

function getSettingsPath({ env = process.env, homeDir = os.homedir() } = {}) {
  return path.join(getClaudeConfigHomeDir({ env, homeDir }), 'settings.json');
}

function getGlobalClaudeConfigPath({ env = process.env, homeDir = os.homedir() } = {}) {
  const configDir = getClaudeConfigHomeDir({ env, homeDir });
  const legacyPath = path.join(configDir, '.config.json');
  if (fs.existsSync(legacyPath)) {
    return legacyPath;
  }

  return path.join(env.CLAUDE_CONFIG_DIR || homeDir, `.claude${getOauthFileSuffix(env)}.json`);
}

function getCredentialsStorageInfo({
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
} = {}) {
  if (platform === 'darwin') {
    return {
      type: 'keychain',
      accountName: getUsername({ env }),
      serviceName: getClaudeCodeKeychainServiceName({ env, homeDir }),
      fallbackPath: getPlaintextCredentialsPath({ env, homeDir }),
    };
  }

  return {
    type: 'plaintext',
    path: getPlaintextCredentialsPath({ env, homeDir }),
  };
}

function buildSharedClaudeCodeOAuthCredentials(localAuthToken) {
  return {
    accessToken: validateLocalClaudeAuthToken(localAuthToken),
    refreshToken: null,
    expiresAt: null,
    scopes: [...SHARED_LOGIN_SCOPES],
    subscriptionType: null,
    rateLimitTier: null,
  };
}

function buildSharedClaudeCodeCredentialsData(existingData, localAuthToken) {
  const base = existingData && typeof existingData === 'object' && !Array.isArray(existingData)
    ? { ...existingData }
    : {};

  base.claudeAiOauth = buildSharedClaudeCodeOAuthCredentials(localAuthToken);
  return base;
}

function readCredentialsStorageData(storageInfo, options = {}) {
  if (storageInfo.type === 'keychain') {
    return readKeychainCredentials(storageInfo, options) ||
      readPlaintextCredentials(storageInfo.fallbackPath);
  }

  return readPlaintextCredentials(storageInfo.path);
}

function writeCredentialsStorageData(storageInfo, data, options = {}) {
  if (data === null) {
    return deleteCredentialsStorageData(storageInfo, options);
  }

  if (storageInfo.type === 'keychain') {
    return writeKeychainCredentialsWithFallback(storageInfo, data, options);
  }

  return writePlaintextCredentials(storageInfo.path, data);
}

function deleteCredentialsStorageData(storageInfo, options = {}) {
  if (storageInfo.type === 'keychain') {
    const keychainResult = deleteKeychainCredentials(storageInfo, options);
    const plaintextResult = storageInfo.fallbackPath
      ? deletePlaintextCredentials(storageInfo.fallbackPath)
      : { success: true };
    return {
      success: keychainResult.success || plaintextResult.success,
      warning: [keychainResult.warning, plaintextResult.warning].filter(Boolean).join('; '),
    };
  }

  return deletePlaintextCredentials(storageInfo.path);
}

function deletePlaintextCredentials(credentialsPath) {
  try {
    fs.unlinkSync(credentialsPath);
    return { success: true };
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { success: true };
    }
    return { success: false, warning: err.message };
  }
}

function readKeychainCredentials(storageInfo, { spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl('security', [
    'find-generic-password',
    '-a',
    storageInfo.accountName,
    '-w',
    '-s',
    storageInfo.serviceName,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  return parseJsonOrNull(result.stdout);
}

function writeKeychainCredentials(storageInfo, data, { spawnSyncImpl = spawnSync } = {}) {
  const jsonString = JSON.stringify(data);
  const hexValue = Buffer.from(jsonString, 'utf8').toString('hex');
  const stdinCommand = [
    'add-generic-password',
    '-U',
    '-a',
    quoteSecurityCliValue(storageInfo.accountName),
    '-s',
    quoteSecurityCliValue(storageInfo.serviceName),
    '-X',
    quoteSecurityCliValue(hexValue),
  ].join(' ') + '\n';
  const result = stdinCommand.length <= SECURITY_STDIN_LINE_LIMIT
    ? spawnSyncImpl('security', ['-i'], {
        input: stdinCommand,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    : spawnSyncImpl('security', [
        'add-generic-password',
        '-U',
        '-a',
        storageInfo.accountName,
        '-s',
        storageInfo.serviceName,
        '-X',
        hexValue,
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

  if (result.status !== 0) {
    return {
      success: false,
      warning: normalizeString(result.stderr) || '写入 macOS Keychain 失败',
    };
  }

  return { success: true };
}

function writeKeychainCredentialsWithFallback(storageInfo, data, options = {}) {
  const keychainResult = writeKeychainCredentials(storageInfo, data, options);
  if (keychainResult.success) {
    return keychainResult;
  }

  if (!storageInfo.fallbackPath) {
    return keychainResult;
  }

  const plaintextResult = writePlaintextCredentials(storageInfo.fallbackPath, data);
  if (!plaintextResult.success) {
    return {
      success: false,
      warning: keychainResult.warning || plaintextResult.warning,
    };
  }

  return {
    success: true,
    warning: [
      keychainResult.warning || '写入 macOS Keychain 失败',
      '已按 Claude Code fallback 写入 .credentials.json 明文文件',
    ].join('；'),
  };
}

function quoteSecurityCliValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function deleteKeychainCredentials(storageInfo, { spawnSyncImpl = spawnSync } = {}) {
  const result = spawnSyncImpl('security', [
    'delete-generic-password',
    '-a',
    storageInfo.accountName,
    '-s',
    storageInfo.serviceName,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    const warning = normalizeString(result.stderr);
    return {
      success: warning.includes('could not be found') || warning.includes('not be found'),
      warning: warning || undefined,
    };
  }

  return { success: true };
}

function readPlaintextCredentials(credentialsPath) {
  try {
    return parseJsonOrNull(fs.readFileSync(credentialsPath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writePlaintextCredentials(credentialsPath, data) {
  try {
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.chmodSync(credentialsPath, 0o600);
    return {
      success: true,
      warning: '当前平台没有 Keychain 支持，凭证已写入 .credentials.json 明文文件',
    };
  } catch (err) {
    return { success: false, warning: err.message };
  }
}

function parseJsonOrNull(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch (err) {
    return null;
  }
}

function readJsonFileOrNull(filePath) {
  try {
    return parseJsonOrNull(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function updateSettingsEnv(settings, envPatch, envRemovals = []) {
  const next = settings && typeof settings === 'object' && !Array.isArray(settings)
    ? { ...settings }
    : {};
  const existingEnv = next.env && typeof next.env === 'object' && !Array.isArray(next.env)
    ? next.env
    : {};

  const nextEnv = { ...existingEnv };
  for (const key of envRemovals) {
    delete nextEnv[key];
  }

  next.env = { ...nextEnv, ...envPatch };
  return next;
}

function updateSettingsForSharedClaudeCodeLogin(settings, baseUrl) {
  const next = updateSettingsEnv(settings, {
    ANTHROPIC_BASE_URL: normalizeString(baseUrl),
  }, SHARED_LOGIN_SETTINGS_ENV_REMOVALS);

  for (const key of SHARED_LOGIN_SETTINGS_REMOVALS) {
    delete next[key];
  }

  return next;
}

function updateGlobalConfigForSharedClaudeCodeLogin(globalConfig) {
  const next = globalConfig && typeof globalConfig === 'object' && !Array.isArray(globalConfig)
    ? { ...globalConfig }
    : {};

  next.hasCompletedOnboarding = true;
  if (!normalizeString(next.theme)) {
    next.theme = 'dark';
  }

  return next;
}

function createBackupPayload({
  storageInfo,
  credentialsData,
  settingsPath,
  settingsData,
  globalConfigPath,
  globalConfigData,
  createdAt = new Date(),
}) {
  return {
    type: BACKUP_TYPE,
    version: BACKUP_VERSION,
    created_at: createdAt.toISOString(),
    credentials: {
      storage: storageInfo,
      data: credentialsData,
    },
    settings: settingsPath
      ? {
          path: settingsPath,
          data: settingsData,
        }
      : null,
    global_config: globalConfigPath
      ? {
          path: globalConfigPath,
          data: globalConfigData,
        }
      : null,
  };
}

function writeBackupFile(backupDir, payload) {
  fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = payload.created_at.replace(/[^0-9A-Za-z]+/g, '').replace(/Z$/, '');
  const backupPath = path.join(backupDir, `claude-code-credentials-${timestamp}.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.chmodSync(backupPath, 0o600);
  return backupPath;
}

function installSharedClaudeCodeLogin({
  localAuthToken,
  baseUrl = '',
  backupDir = '',
  env = process.env,
  homeDir = os.homedir(),
  platform = process.platform,
  now = () => new Date(),
  spawnSyncImpl = spawnSync,
} = {}) {
  const token = validateLocalClaudeAuthToken(localAuthToken);
  const storageInfo = getCredentialsStorageInfo({ env, homeDir, platform });
  const currentCredentials = readCredentialsStorageData(storageInfo, { spawnSyncImpl });
  const nextCredentials = buildSharedClaudeCodeCredentialsData(currentCredentials, token);
  const configDir = getClaudeConfigHomeDir({ env, homeDir });
  const settingsPath = baseUrl ? getSettingsPath({ env, homeDir }) : '';
  const currentSettings = settingsPath ? readJsonFileOrNull(settingsPath) : null;
  const globalConfigPath = getGlobalClaudeConfigPath({ env, homeDir });
  const currentGlobalConfig = readJsonFileOrNull(globalConfigPath);
  const backupPayload = createBackupPayload({
    storageInfo,
    credentialsData: currentCredentials,
    settingsPath,
    settingsData: currentSettings,
    globalConfigPath,
    globalConfigData: currentGlobalConfig,
    createdAt: now(),
  });
  const resolvedBackupDir = backupDir || path.join(configDir, 'airouter-backups');
  const backupPath = writeBackupFile(resolvedBackupDir, backupPayload);
  const credentialsWrite = writeCredentialsStorageData(storageInfo, nextCredentials, { spawnSyncImpl });

  if (!credentialsWrite.success) {
    throw new Error(credentialsWrite.warning || '写入 Claude Code 登录态失败');
  }

  let settingsWrite = null;
  const normalizedBaseUrl = normalizeString(baseUrl);
  if (normalizedBaseUrl) {
    const nextSettings = updateSettingsForSharedClaudeCodeLogin(currentSettings, normalizedBaseUrl);
    writeJsonFile(settingsPath, nextSettings);
    settingsWrite = {
      path: settingsPath,
      baseUrl: normalizedBaseUrl,
    };
  }

  const nextGlobalConfig = updateGlobalConfigForSharedClaudeCodeLogin(currentGlobalConfig);
  writeJsonFile(globalConfigPath, nextGlobalConfig);

  return {
    backupPath,
    credentials: {
      storage: storageInfo,
      warning: credentialsWrite.warning || '',
    },
    settings: settingsWrite,
    globalConfig: {
      path: globalConfigPath,
    },
  };
}

function restoreClaudeCodeLogin({
  backupPath,
  spawnSyncImpl = spawnSync,
} = {}) {
  const backup = readBackupPayload(backupPath);
  const credentialsRestore = writeCredentialsStorageData(
    backup.credentials.storage,
    backup.credentials.data,
    { spawnSyncImpl }
  );

  if (!credentialsRestore.success) {
    throw new Error(credentialsRestore.warning || '恢复 Claude Code 登录态失败');
  }

  let settingsRestore = null;
  if (backup.settings && backup.settings.path) {
    if (backup.settings.data === null) {
      try {
        fs.unlinkSync(backup.settings.path);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') {
          throw err;
        }
      }
    } else {
      writeJsonFile(backup.settings.path, backup.settings.data);
    }
    settingsRestore = {
      path: backup.settings.path,
    };
  }

  let globalConfigRestore = null;
  if (backup.global_config && backup.global_config.path) {
    if (backup.global_config.data === null) {
      try {
        fs.unlinkSync(backup.global_config.path);
      } catch (err) {
        if (!err || err.code !== 'ENOENT') {
          throw err;
        }
      }
    } else {
      writeJsonFile(backup.global_config.path, backup.global_config.data);
    }
    globalConfigRestore = {
      path: backup.global_config.path,
    };
  }

  return {
    credentials: {
      storage: backup.credentials.storage,
      warning: credentialsRestore.warning || '',
    },
    settings: settingsRestore,
    globalConfig: globalConfigRestore,
  };
}

function readBackupPayload(backupPath) {
  const payload = readJsonFileOrNull(backupPath);
  if (!payload || payload.type !== BACKUP_TYPE || payload.version !== BACKUP_VERSION) {
    throw new Error('备份文件格式无效');
  }

  if (!payload.credentials || !payload.credentials.storage) {
    throw new Error('备份文件缺少 credentials 数据');
  }

  return payload;
}

module.exports = {
  BACKUP_TYPE,
  BACKUP_VERSION,
  SECURITY_STDIN_LINE_LIMIT,
  SHARED_LOGIN_SETTINGS_ENV_REMOVALS,
  SHARED_LOGIN_SETTINGS_REMOVALS,
  SHARED_LOGIN_SCOPES,
  buildSharedClaudeCodeCredentialsData,
  buildSharedClaudeCodeOAuthCredentials,
  createBackupPayload,
  getClaudeCodeKeychainServiceName,
  getGlobalClaudeConfigPath,
  getClaudeConfigHomeDir,
  getCredentialsStorageInfo,
  getPlaintextCredentialsPath,
  getSettingsPath,
  installSharedClaudeCodeLogin,
  readBackupPayload,
  restoreClaudeCodeLogin,
  updateGlobalConfigForSharedClaudeCodeLogin,
  updateSettingsForSharedClaudeCodeLogin,
  updateSettingsEnv,
  validateLocalClaudeAuthToken,
};
