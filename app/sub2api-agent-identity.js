const crypto = require('node:crypto');
const nacl = require('tweetnacl');
const { blake2b } = require('blakejs');
const { requestBuffered } = require('./upstream-request');

const SUB2API_SUBTYPE = 'sub2api';
const AGENT_IDENTITY_AUTH_MODE = 'agentIdentity';
const AGENT_TASK_AUTH_BASE_URL = 'https://auth.openai.com/api/accounts';
const DEFAULT_TASK_REGISTRATION_TIMEOUT_MS = 30 * 1000;
const MAX_TASK_REGISTRATION_RESPONSE_BYTES = 64 * 1024;
const TASK_INVALID_STATUS_CODE = 401;
const TASK_INVALID_COMPACT_MARKERS = [
  '"code":"invalid_task_id"',
  '"code":"task_not_found"',
  '"code":"task_expired"',
  '"error":"invalid_task_id"',
];
const TASK_INVALID_TEXT_MARKERS = [
  'invalid task_id',
  'invalid task id',
  'task_id is invalid',
  'task id is invalid',
  'task not found',
  'task expired',
  'unknown task_id',
  'unknown task id',
];

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSub2ApiConfig(config) {
  return Boolean(
    config &&
    normalizeString(config.type || 'token').toLowerCase() === 'token' &&
    normalizeString(config.subtype).toLowerCase() === SUB2API_SUBTYPE
  );
}

function isSub2ApiExportItem(item) {
  if (!isPlainObject(item)) {
    return false;
  }

  if (isSub2ApiConfig(item)) {
    return isPlainObject(item.credentials);
  }

  const credentials = isPlainObject(item.credentials) ? item.credentials : {};
  return normalizeString(item.platform).toLowerCase() === 'openai' &&
    normalizeString(item.type).toLowerCase() === 'oauth' &&
    normalizeString(credentials.auth_mode).toLowerCase() === AGENT_IDENTITY_AUTH_MODE.toLowerCase();
}

function parseAgentPrivateKey(encodedPrivateKey) {
  const normalized = normalizeString(encodedPrivateKey);
  if (!normalized) {
    throw new Error('Sub2API Agent Identity 缺少 agent_private_key');
  }

  let privateKeyDer;
  try {
    privateKeyDer = Buffer.from(normalized, 'base64');
  } catch (err) {
    throw new Error('Sub2API Agent Identity agent_private_key 不是合法 Base64');
  }

  if (!privateKeyDer.length || privateKeyDer.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')) {
    throw new Error('Sub2API Agent Identity agent_private_key 不是合法 Base64');
  }

  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8',
    });
  } catch (err) {
    throw new Error('Sub2API Agent Identity agent_private_key 不是合法 PKCS#8 私钥');
  }

  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Sub2API Agent Identity agent_private_key 必须是 Ed25519 私钥');
  }

  return privateKey;
}

function normalizeSub2ApiCredentials(value, options = {}) {
  if (!isPlainObject(value)) {
    throw new Error('Sub2API Agent Identity credentials 必须是对象');
  }

  const credentials = {
    auth_mode: AGENT_IDENTITY_AUTH_MODE,
    agent_runtime_id: normalizeString(value.agent_runtime_id),
    agent_private_key: normalizeString(value.agent_private_key),
    task_id: normalizeString(value.task_id),
    chatgpt_account_id: normalizeString(value.chatgpt_account_id || value.account_id),
    chatgpt_user_id: normalizeString(value.chatgpt_user_id),
    chatgpt_account_is_fedramp: value.chatgpt_account_is_fedramp === true,
    email: normalizeString(value.email),
    plan_type: normalizeString(value.plan_type),
  };

  const missingFields = [
    'agent_runtime_id',
    'agent_private_key',
    'chatgpt_account_id',
    'chatgpt_user_id',
  ].filter(field => !credentials[field]);
  if (missingFields.length > 0) {
    throw new Error(`Sub2API Agent Identity 缺少必填字段: ${missingFields.join(', ')}`);
  }

  if (normalizeString(value.auth_mode).toLowerCase() !== AGENT_IDENTITY_AUTH_MODE.toLowerCase()) {
    throw new Error('Sub2API Agent Identity credentials.auth_mode 必须是 agentIdentity');
  }

  if (options.validatePrivateKey !== false) {
    parseAgentPrivateKey(credentials.agent_private_key);
  }

  for (const field of ['task_id', 'email', 'plan_type']) {
    if (!credentials[field]) {
      delete credentials[field];
    }
  }

  return credentials;
}

function getSub2ApiCredentials(config) {
  if (!isSub2ApiConfig(config)) {
    throw new Error('配置项不是 Sub2API Agent Identity');
  }

  return normalizeSub2ApiCredentials(config.credentials);
}

function formatRfc3339Utc(now) {
  const value = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(value.getTime())) {
    throw new Error('Agent Identity 签名时间不合法');
  }

  return value.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function buildAgentAssertion(config, options = {}) {
  const credentials = getSub2ApiCredentials(config);
  if (!credentials.task_id) {
    throw new Error('Sub2API Agent Identity 缺少 task_id');
  }

  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const timestamp = formatRfc3339Utc(now);
  const payload = `${credentials.agent_runtime_id}:${credentials.task_id}:${timestamp}`;
  const privateKey = parseAgentPrivateKey(credentials.agent_private_key);
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
  const envelope = {
    agent_runtime_id: credentials.agent_runtime_id,
    task_id: credentials.task_id,
    timestamp,
    signature,
  };

  return `AgentAssertion ${encodeBase64Url(JSON.stringify(envelope))}`;
}

function buildSub2ApiAuthHeaders(config, options = {}) {
  const purpose = normalizeString(options.purpose).toLowerCase() || 'responses';
  const credentials = getSub2ApiCredentials(config);
  const headers = {
    authorization: buildAgentAssertion(config, options),
    'chatgpt-account-id': credentials.chatgpt_account_id,
  };

  if (purpose === 'quota') {
    Object.assign(headers, {
      'openai-beta': 'codex-1',
      'oai-language': 'zh-CN',
      originator: 'Codex Desktop',
      accept: 'application/json',
      'sec-fetch-site': 'none',
      'sec-fetch-mode': 'no-cors',
      'sec-fetch-dest': 'empty',
      priority: 'u=4, i',
    });
  } else {
    Object.assign(headers, {
      'openai-beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      'user-agent': 'codex_cli_rs/0.144.1 (Ubuntu 22.4.0; x86_64) xterm-256color',
      version: '0.144.1',
    });
  }

  if (credentials.chatgpt_account_is_fedramp) {
    headers['x-openai-fedramp'] = 'true';
  }

  return headers;
}

function isSub2ApiTaskInvalidResponse(statusCode, body) {
  if (Number(statusCode) !== TASK_INVALID_STATUS_CODE) {
    return false;
  }

  const lower = Buffer.isBuffer(body)
    ? body.toString('utf8').toLowerCase()
    : String(body || '').toLowerCase();
  const compact = lower.replace(/[\s\r\n\t]+/g, '');

  return TASK_INVALID_COMPACT_MARKERS.some(marker => compact.includes(marker)) ||
    TASK_INVALID_TEXT_MARKERS.some(marker => lower.includes(marker));
}

function getAgentTaskIdentity(config) {
  if (!isSub2ApiConfig(config)) {
    return '';
  }

  const credentials = isPlainObject(config.credentials) ? config.credentials : {};
  return [
    SUB2API_SUBTYPE,
    normalizeString(credentials.chatgpt_account_id || config.account_id),
    normalizeString(credentials.agent_runtime_id),
  ].join(':');
}

function buildTaskRegistrationRequest(config, options = {}) {
  const credentials = getSub2ApiCredentials(config);
  const now = typeof options.now === 'function' ? options.now() : options.now ?? Date.now();
  const timestamp = formatRfc3339Utc(now);
  const payload = `${credentials.agent_runtime_id}:${timestamp}`;
  const privateKey = parseAgentPrivateKey(credentials.agent_private_key);
  const signature = crypto.sign(null, Buffer.from(payload), privateKey).toString('base64');
  const baseUrl = normalizeString(options.authBaseUrl) || AGENT_TASK_AUTH_BASE_URL;
  const targetUrl = `${baseUrl.replace(/\/+$/, '')}/v1/agent/${encodeURIComponent(credentials.agent_runtime_id)}/task/register`;
  const body = Buffer.from(JSON.stringify({ timestamp, signature }));

  return {
    method: 'POST',
    targetUrl,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
    body,
    timeoutMs: options.timeoutMs ?? DEFAULT_TASK_REGISTRATION_TIMEOUT_MS,
    maxResponseBytes: MAX_TASK_REGISTRATION_RESPONSE_BYTES,
  };
}

function decodePrivateKeySeed(privateKey) {
  const jwk = privateKey.export({ format: 'jwk' });
  if (!jwk || typeof jwk.d !== 'string') {
    throw new Error('无法读取 Agent Identity Ed25519 私钥种子');
  }

  const seed = Buffer.from(jwk.d, 'base64url');
  if (seed.length !== 32) {
    throw new Error('Agent Identity Ed25519 私钥种子长度不合法');
  }

  return seed;
}

function decryptAgentTaskId(config, encodedCiphertext) {
  let sealed;
  try {
    sealed = Buffer.from(normalizeString(encodedCiphertext), 'base64');
  } catch (err) {
    throw new Error('Agent Identity encrypted_task_id 不是合法 Base64');
  }

  if (sealed.length <= nacl.box.publicKeyLength + nacl.box.overheadLength) {
    throw new Error('Agent Identity encrypted_task_id 长度不合法');
  }

  const credentials = getSub2ApiCredentials(config);
  const privateKey = parseAgentPrivateKey(credentials.agent_private_key);
  const seed = decodePrivateKeySeed(privateKey);
  const digest = crypto.createHash('sha512').update(seed).digest();
  const curvePrivateKey = new Uint8Array(digest.subarray(0, nacl.box.secretKeyLength));
  curvePrivateKey[0] &= 248;
  curvePrivateKey[31] &= 127;
  curvePrivateKey[31] |= 64;
  const curvePublicKey = nacl.scalarMult.base(curvePrivateKey);
  const ephemeralPublicKey = new Uint8Array(sealed.subarray(0, nacl.box.publicKeyLength));
  const encryptedPayload = new Uint8Array(sealed.subarray(nacl.box.publicKeyLength));
  const nonceInput = new Uint8Array(ephemeralPublicKey.length + curvePublicKey.length);
  nonceInput.set(ephemeralPublicKey, 0);
  nonceInput.set(curvePublicKey, ephemeralPublicKey.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);
  const plaintext = nacl.box.open(encryptedPayload, nonce, ephemeralPublicKey, curvePrivateKey);
  if (!plaintext) {
    throw new Error('Agent Identity encrypted_task_id 解密失败');
  }

  const taskId = Buffer.from(plaintext).toString('utf8').trim();
  if (!taskId) {
    throw new Error('Agent Identity encrypted_task_id 解密结果为空');
  }

  return taskId;
}

function parseTaskRegistrationResponse(config, result) {
  if (!result || Number(result.statusCode) < 200 || Number(result.statusCode) >= 300) {
    throw new Error(`Agent Identity task 注册返回 HTTP ${Number(result && result.statusCode) || 0}`);
  }

  let payload;
  try {
    payload = JSON.parse(result.bodyText);
  } catch (err) {
    throw new Error('Agent Identity task 注册响应不是合法 JSON');
  }

  if (!isPlainObject(payload)) {
    throw new Error('Agent Identity task 注册响应必须是 JSON 对象');
  }

  const taskId = normalizeString(payload.task_id || payload.taskId);
  if (taskId) {
    return taskId;
  }

  const encryptedTaskId = normalizeString(payload.encrypted_task_id || payload.encryptedTaskId);
  if (!encryptedTaskId) {
    throw new Error('Agent Identity task 注册响应缺少 task_id');
  }

  return decryptAgentTaskId(config, encryptedTaskId);
}

function createSub2ApiAgentIdentityManager(options = {}) {
  const requestBufferedFn = options.requestBufferedFn || requestBuffered;
  const persistTaskFn = typeof options.persistTaskFn === 'function'
    ? options.persistTaskFn
    : async () => {
      throw new Error('Agent Identity task 持久化函数未配置');
    };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const authBaseUrl = normalizeString(options.authBaseUrl) || AGENT_TASK_AUTH_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TASK_REGISTRATION_TIMEOUT_MS;
  const recoveries = new Map();

  async function registerAndPersistTask(config, expectedTaskId) {
    const currentTaskId = normalizeString(config && config.credentials && config.credentials.task_id);
    if (currentTaskId && (!expectedTaskId || currentTaskId !== expectedTaskId)) {
      return currentTaskId;
    }

    const request = buildTaskRegistrationRequest(config, {
      authBaseUrl,
      timeoutMs,
      now,
    });
    const result = await requestBufferedFn(request);
    const taskId = parseTaskRegistrationResponse(config, result);
    const persistedTaskId = normalizeString(await persistTaskFn({
      config,
      taskId,
      expectedTaskId,
    })) || taskId;

    if (!isPlainObject(config.credentials)) {
      config.credentials = {};
    }
    config.credentials.task_id = persistedTaskId;
    return persistedTaskId;
  }

  function recoverTask(config, expectedTaskId = '') {
    if (!isSub2ApiConfig(config)) {
      return Promise.resolve('');
    }

    const identity = getAgentTaskIdentity(config);
    if (!identity) {
      return Promise.reject(new Error('Agent Identity 账号标识不完整'));
    }

    if (recoveries.has(identity)) {
      return recoveries.get(identity).then(taskId => {
        if (!isPlainObject(config.credentials)) {
          config.credentials = {};
        }
        config.credentials.task_id = taskId;
        return taskId;
      });
    }

    const recovery = registerAndPersistTask(config, normalizeString(expectedTaskId))
      .finally(() => {
        if (recoveries.get(identity) === recovery) {
          recoveries.delete(identity);
        }
      });
    recoveries.set(identity, recovery);
    return recovery;
  }

  function ensureTask(config) {
    if (!isSub2ApiConfig(config)) {
      return Promise.resolve('');
    }

    const taskId = normalizeString(config && config.credentials && config.credentials.task_id);
    return taskId ? Promise.resolve(taskId) : recoverTask(config, '');
  }

  return {
    ensureTask,
    recoverTask,
  };
}

module.exports = {
  AGENT_IDENTITY_AUTH_MODE,
  AGENT_TASK_AUTH_BASE_URL,
  SUB2API_SUBTYPE,
  buildAgentAssertion,
  buildSub2ApiAuthHeaders,
  buildTaskRegistrationRequest,
  createSub2ApiAgentIdentityManager,
  decryptAgentTaskId,
  getAgentTaskIdentity,
  isSub2ApiConfig,
  isSub2ApiExportItem,
  isSub2ApiTaskInvalidResponse,
  normalizeSub2ApiCredentials,
  parseAgentPrivateKey,
  parseTaskRegistrationResponse,
};
