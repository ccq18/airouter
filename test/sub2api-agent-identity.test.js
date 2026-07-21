const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const nacl = require('tweetnacl');
const { blake2b } = require('blakejs');
const {
  buildAgentAssertion,
  buildSub2ApiAuthHeaders,
  createSub2ApiAgentIdentityManager,
  decryptAgentTaskId,
  getAgentTaskIdentity,
  isSub2ApiExportItem,
  isSub2ApiTaskInvalidResponse,
  normalizeSub2ApiCredentials,
} = require('../app/sub2api-agent-identity');
const {
  buildAuthHeadersForConfig,
  createTokenRuntimeConfig,
} = require('../app/openai-config');

function createAgentIdentityConfig(overrides = {}) {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const { credentials: credentialOverrides = {}, ...configOverrides } = overrides;
  const encodedPrivateKey = privateKey.export({
    format: 'der',
    type: 'pkcs8',
  }).toString('base64');

  return {
    type: 'token',
    subtype: 'sub2api',
    index: 0,
    credentials: {
      auth_mode: 'agentIdentity',
      agent_runtime_id: 'agent-runtime-example',
      agent_private_key: encodedPrivateKey,
      task_id: 'task-example',
      chatgpt_account_id: 'account-example',
      chatgpt_user_id: 'user-example',
      chatgpt_account_is_fedramp: false,
      email: 'user@example.com',
      plan_type: 'team',
      ...credentialOverrides,
    },
    ...configOverrides,
  };
}

function decodeAssertion(assertion) {
  const encoded = assertion.replace(/^AgentAssertion /, '');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function getCurveKeyPair(config) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(config.credentials.agent_private_key, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const digest = crypto.createHash('sha512').update(seed).digest();
  const secretKey = new Uint8Array(digest.subarray(0, nacl.box.secretKeyLength));
  secretKey[0] &= 248;
  secretKey[31] &= 127;
  secretKey[31] |= 64;
  return {
    secretKey,
    publicKey: nacl.scalarMult.base(secretKey),
  };
}

function sealTaskId(config, taskId) {
  const recipient = getCurveKeyPair(config);
  const ephemeral = nacl.box.keyPair();
  const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipient.publicKey.length);
  nonceInput.set(ephemeral.publicKey, 0);
  nonceInput.set(recipient.publicKey, ephemeral.publicKey.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);
  const encrypted = nacl.box(
    new Uint8Array(Buffer.from(taskId)),
    nonce,
    recipient.publicKey,
    ephemeral.secretKey
  );
  return Buffer.concat([
    Buffer.from(ephemeral.publicKey),
    Buffer.from(encrypted),
  ]).toString('base64');
}

test('buildAgentAssertion creates a verifiable Sub2API AgentAssertion envelope', () => {
  const config = createAgentIdentityConfig();
  const assertion = buildAgentAssertion(config, {
    now: new Date('2026-07-14T00:09:10.987Z'),
  });
  const envelope = decodeAssertion(assertion);
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(config.credentials.agent_private_key, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = crypto.createPublicKey(privateKey);
  const payload = `${envelope.agent_runtime_id}:${envelope.task_id}:${envelope.timestamp}`;

  assert.equal(envelope.agent_runtime_id, 'agent-runtime-example');
  assert.equal(envelope.task_id, 'task-example');
  assert.equal(envelope.timestamp, '2026-07-14T00:09:10Z');
  assert.equal(
    crypto.verify(null, Buffer.from(payload), publicKey, Buffer.from(envelope.signature, 'base64')),
    true
  );
});

test('buildSub2ApiAuthHeaders uses distinct Responses and quota identity headers', () => {
  const config = createAgentIdentityConfig({
    credentials: {
      chatgpt_account_is_fedramp: true,
    },
  });
  const responsesHeaders = buildSub2ApiAuthHeaders(config, { now: 0 });
  const quotaHeaders = buildSub2ApiAuthHeaders(config, { purpose: 'quota', now: 0 });

  assert.match(responsesHeaders.authorization, /^AgentAssertion /);
  assert.equal(responsesHeaders['chatgpt-account-id'], 'account-example');
  assert.equal(responsesHeaders['openai-beta'], 'responses=experimental');
  assert.equal(responsesHeaders.originator, 'codex_cli_rs');
  assert.match(responsesHeaders['user-agent'], /^codex_cli_rs\/0\.144\.1/);
  assert.equal(responsesHeaders.version, '0.144.1');
  assert.equal(responsesHeaders['x-openai-fedramp'], 'true');
  assert.equal(quotaHeaders['openai-beta'], 'codex-1');
  assert.equal(quotaHeaders['oai-language'], 'zh-CN');
  assert.equal(quotaHeaders.originator, 'Codex Desktop');
  assert.equal(quotaHeaders.accept, 'application/json');
  assert.equal(quotaHeaders['sec-fetch-site'], 'none');
  assert.equal(quotaHeaders['sec-fetch-mode'], 'no-cors');
  assert.equal(quotaHeaders['sec-fetch-dest'], 'empty');
  assert.equal(quotaHeaders.priority, 'u=4, i');
});

test('OpenAI runtime keeps Sub2API as a token config and builds dynamic assertions', () => {
  const persistedConfig = createAgentIdentityConfig({
    description: 'Sub2API example',
  });
  const runtimeConfig = createTokenRuntimeConfig(persistedConfig, 3);
  const firstHeaders = buildAuthHeadersForConfig(runtimeConfig, { now: 0 });
  const secondHeaders = buildAuthHeadersForConfig(runtimeConfig, { now: 1_000 });

  assert.equal(runtimeConfig.type, 'token');
  assert.equal(runtimeConfig.subtype, 'sub2api');
  assert.equal(runtimeConfig.index, 3);
  assert.equal(runtimeConfig.account_id, 'account-example');
  assert.equal(runtimeConfig.runtime.enabled, true);
  assert.notEqual(firstHeaders.authorization, secondHeaders.authorization);
  assert.equal(decodeAssertion(firstHeaders.authorization).timestamp, '1970-01-01T00:00:00Z');
  assert.equal(decodeAssertion(secondHeaders.authorization).timestamp, '1970-01-01T00:00:01Z');
});

test('Sub2API export detection and credential validation reject incomplete identities', () => {
  const config = createAgentIdentityConfig();
  const exportItem = {
    platform: 'openai',
    type: 'oauth',
    credentials: config.credentials,
  };

  assert.equal(isSub2ApiExportItem(exportItem), true);
  assert.equal(getAgentTaskIdentity(config), 'sub2api:account-example:agent-runtime-example');
  assert.throws(() => normalizeSub2ApiCredentials({
    auth_mode: 'agentIdentity',
  }), /agent_runtime_id.*agent_private_key.*chatgpt_account_id.*chatgpt_user_id/);
});

test('isSub2ApiTaskInvalidResponse only recognizes explicit task errors on HTTP 401', () => {
  assert.equal(isSub2ApiTaskInvalidResponse(401, '{"error":{"code":"invalid_task_id"}}'), true);
  assert.equal(isSub2ApiTaskInvalidResponse(401, 'unknown task id'), true);
  assert.equal(isSub2ApiTaskInvalidResponse(500, '{"error":{"code":"invalid_task_id"}}'), false);
  assert.equal(isSub2ApiTaskInvalidResponse(401, '{"error":{"code":"token_revoked"}}'), false);
});

test('decryptAgentTaskId opens the sealed-box task response used by Sub2API', () => {
  const config = createAgentIdentityConfig();
  const encryptedTaskId = sealTaskId(config, 'task-from-sealed-box');

  assert.equal(decryptAgentTaskId(config, encryptedTaskId), 'task-from-sealed-box');
});

test('Agent Identity manager persists a new task before exposing it to the runtime config', async () => {
  const config = createAgentIdentityConfig({
    credentials: {
      task_id: '',
    },
  });
  const events = [];
  const manager = createSub2ApiAgentIdentityManager({
    now: () => Date.parse('2026-07-14T00:09:10Z'),
    requestBufferedFn: async request => {
      events.push(`request:${new URL(request.targetUrl).pathname}`);
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ task_id: 'task-registered' }),
      };
    },
    persistTaskFn: async ({ taskId }) => {
      assert.equal(config.credentials.task_id, '');
      events.push(`persist:${taskId}`);
      return taskId;
    },
  });

  const taskId = await manager.ensureTask(config);

  assert.equal(taskId, 'task-registered');
  assert.equal(config.credentials.task_id, 'task-registered');
  assert.deepEqual(events, [
    'request:/api/accounts/v1/agent/agent-runtime-example/task/register',
    'persist:task-registered',
  ]);
});

test('Agent Identity manager merges concurrent task recovery for the same account', async () => {
  const config = createAgentIdentityConfig();
  const waitingConfig = {
    ...config,
    index: 1,
    credentials: {
      ...config.credentials,
    },
  };
  let requestCount = 0;
  let releaseRequest;
  const requestGate = new Promise(resolve => {
    releaseRequest = resolve;
  });
  const manager = createSub2ApiAgentIdentityManager({
    requestBufferedFn: async () => {
      requestCount += 1;
      await requestGate;
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ task_id: 'task-recovered' }),
      };
    },
    persistTaskFn: async ({ taskId }) => taskId,
  });

  const first = manager.recoverTask(config, 'task-example');
  const second = manager.recoverTask(waitingConfig, 'task-example');
  releaseRequest();

  assert.deepEqual(await Promise.all([first, second]), ['task-recovered', 'task-recovered']);
  assert.equal(requestCount, 1);
  assert.equal(config.credentials.task_id, 'task-recovered');
  assert.equal(waitingConfig.credentials.task_id, 'task-recovered');
});

test('Agent Identity manager does not update runtime task when persistence fails', async () => {
  const config = createAgentIdentityConfig();
  const manager = createSub2ApiAgentIdentityManager({
    requestBufferedFn: async () => ({
      statusCode: 200,
      bodyText: JSON.stringify({ task_id: 'task-not-persisted' }),
    }),
    persistTaskFn: async () => {
      throw new Error('disk unavailable');
    },
  });

  await assert.rejects(manager.recoverTask(config, 'task-example'), /disk unavailable/);
  assert.equal(config.credentials.task_id, 'task-example');
});
