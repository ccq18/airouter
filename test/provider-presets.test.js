const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PROVIDER_PRESETS,
  getProviderPreset,
  listProviderPresets,
  getProtocolPath,
  buildUpstreamUrl,
  buildDiscoveryRequest,
  parseModelsResponse,
  buildQuotaRequest,
  parseQuotaPayload,
  parseQuotaBody,
  buildUpstreamAuthHeaders,
} = require('../app/provider-presets');

test('provider presets expose the approved built-in providers and custom', () => {
  const ids = Object.keys(PROVIDER_PRESETS);

  assert.deepEqual(ids, [
    'chatgpt',
    'opencode-go',
    'opencode-zen',
    'openrouter',
    'glm-cn',
    'glm-global',
    'claude',
    'custom',
    'opencode-free',
    'openrouter-free',
    'sub2api',
  ]);
  assert.equal(getProviderPreset('glm-cn').label, 'GLM Coding Plan 中国');
  assert.equal(getProviderPreset('glm-global').label, 'GLM Coding Plan 国际');
  assert.equal(getProviderPreset('missing'), null);
  for (const id of ['opencode-free', 'openrouter-free']) {
    assert.equal(getProviderPreset(id).pool, true);
    assert.equal(getProviderPreset(id).quota.supported, false);
  }
  assert.ok(listProviderPresets().every(item => typeof item.id === 'string' && typeof item.label === 'string'));
});

test('built-in protocols resolve to the documented per-provider endpoints', () => {
  const glm = {
    id: 'cfg-glm',
    preset: 'glm-cn',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'unit-test-key',
    models: [{ id: 'glm-5.3', protocols: ['chat_completions'] }],
  };
  const go = {
    id: 'cfg-go',
    preset: 'opencode-go',
    base_url: 'https://opencode.ai/inference/go',
    apikey: 'unit-test-key',
    models: [{ id: 'grok-code', protocols: ['chat_completions', 'responses', 'messages'] }],
  };
  const zen = {
    id: 'cfg-zen',
    preset: 'opencode-zen',
    base_url: 'https://opencode.ai/inference',
    apikey: 'unit-test-key',
    models: [{ id: 'claude-sonnet-4-5', protocols: ['messages'] }],
  };
  const openrouter = {
    id: 'cfg-or',
    preset: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    apikey: 'unit-test-key',
    models: [{ id: 'openai/gpt-5.2', protocols: ['chat_completions'] }],
  };

  assert.equal(
    buildUpstreamUrl(glm, 'chat_completions'),
    'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions',
  );
  assert.equal(
    buildUpstreamUrl(go, 'chat_completions'),
    'https://opencode.ai/inference/go/openai/v1/chat/completions',
  );
  assert.equal(
    buildUpstreamUrl(go, 'responses'),
    'https://opencode.ai/inference/go/openai/v1/responses',
  );
  assert.equal(
    buildUpstreamUrl(go, 'messages'),
    'https://opencode.ai/inference/go/anthropic/v1/messages',
  );
  assert.equal(
    buildUpstreamUrl(zen, 'messages'),
    'https://opencode.ai/inference/anthropic/v1/messages',
  );
  assert.equal(
    buildUpstreamUrl(openrouter, 'chat_completions'),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.equal(getProtocolPath(glm, 'messages'), '/v1/messages');
});

test('GLM Coding Plan native Messages uses regional Anthropic endpoint and shared credential', () => {
  for (const [preset, host] of [['glm-cn', 'open.bigmodel.cn'], ['glm-global', 'api.z.ai']]) {
    const config = { preset, type: 'apikey', apikey: 'coding-plan-fixture', base_url: `https://${host}/api/coding/paas/v4` };
    assert.equal(buildUpstreamUrl(config, 'chat_completions'), `https://${host}/api/coding/paas/v4/chat/completions`);
    assert.equal(buildUpstreamUrl(config, 'messages'), `https://${host}/api/anthropic/v1/messages`);
    assert.equal(buildUpstreamUrl({ ...config, base_url: '' }, 'messages'), `https://${host}/api/anthropic/v1/messages`);
    assert.equal(buildUpstreamAuthHeaders(config).authorization, 'Bearer coding-plan-fixture');
    assert.equal(buildQuotaRequest(config).url, `https://${host}/api/monitor/usage/quota/limit`);
  }
});

test('GLM custom base and explicit protocol paths never redirect back to an official host', () => {
  const config = { preset: 'glm-cn', base_url: 'http://127.0.0.1:9123/relay', protocol_paths: { messages: '/native/messages' } };
  assert.equal(buildUpstreamUrl(config, 'messages'), 'http://127.0.0.1:9123/relay/native/messages');
  assert.equal(buildUpstreamUrl({ ...config, protocol_paths: undefined }, 'messages'), 'http://127.0.0.1:9123/relay/v1/messages');
  assert.equal(buildUpstreamUrl({ ...config, protocol_paths: { messages: null } }, 'messages'), null);
  assert.equal(buildUpstreamUrl({ ...config, protocol_paths: { messages: 'https://relay.invalid/v2/messages' } }, 'messages'), 'https://relay.invalid/v2/messages');
});

test('model discovery supports explicit multiple native protocols and conservative provider defaults', () => {
  const { parseModelCatalog } = require('../app/provider-presets');
  for (const preset of ['glm-cn', 'glm-global']) {
    const models = parseModelCatalog({ data: [{ id: 'glm-5.3' }, 'glm-5.3-flash', { id: 'glm-5.3-flash[1m]' }, { id: 'unknown-glm-model' }, { id: 'explicit', supported_endpoints: ['/chat/completions', '/v1/messages'] }] }, { preset });
    assert.deepEqual(models.map(model => model.protocols), [['chat_completions', 'messages'], ['chat_completions', 'messages'], ['chat_completions', 'messages'], ['chat_completions'], ['chat_completions', 'messages']]);
  }
  const go = parseModelCatalog({ data: ['claude-sonnet-native', { id: 'deepseek-native' }, { id: 'multi', supported_endpoints: ['/chat/completions', '/responses'] }] }, { preset: 'opencode-go' });
  assert.deepEqual(go.map(model => model.protocols), [['messages'], ['chat_completions'], ['chat_completions', 'responses']]);
});

test('custom providers only use explicitly configured protocol and model endpoints', () => {
  const custom = {
    id: 'cfg-custom',
    preset: 'custom',
    base_url: 'http://127.0.0.1:9999/v1',
    apikey: 'unit-test-key',
    models_endpoint: '/models',
    protocol_paths: {
      chat_completions: '/chat/completions',
      responses: '/responses',
    },
    models: [{ id: 'my-model', protocols: ['chat_completions', 'responses'] }],
  };

  assert.equal(buildUpstreamUrl(custom, 'chat_completions'), 'http://127.0.0.1:9999/v1/chat/completions');
  assert.equal(buildUpstreamUrl(custom, 'responses'), 'http://127.0.0.1:9999/v1/responses');
  assert.equal(buildUpstreamUrl(custom, 'messages'), null);
  assert.deepEqual(buildDiscoveryRequest(custom), {
    url: 'http://127.0.0.1:9999/v1/models',
    headers: { authorization: 'Bearer unit-test-key' },
  });

  assert.throws(
    () => buildDiscoveryRequest({ ...custom, models_endpoint: '' }),
    /自定义上游需要配置模型列表地址/,
  );
});

test('built-in model discovery uses provider-owned addresses and auth', () => {
  const go = {
    id: 'cfg-go',
    preset: 'opencode-go',
    base_url: 'https://opencode.ai/inference/go',
    apikey: 'unit-test-key',
  };
  const glm = {
    id: 'cfg-glm',
    preset: 'glm-cn',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'unit-test-key',
  };
  const openrouter = {
    id: 'cfg-or',
    preset: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    apikey: 'unit-test-key',
  };

  const chatgpt = {
    id: 'cfg-chatgpt',
    preset: 'chatgpt',
    type: 'token',
    access_token: 'unit-test-token',
    account_id: 'unit-test-account',
  };
  const claude = {
    id: 'cfg-claude',
    preset: 'claude',
    type: 'claude_token',
    access_token: 'unit-test-token',
    base_url: 'https://api.anthropic.com',
  };

  assert.equal(buildDiscoveryRequest(go).url, 'https://opencode.ai/inference/go/v1/models');
  assert.equal(buildDiscoveryRequest(glm).url, 'https://open.bigmodel.cn/api/coding/paas/v4/models');
  assert.equal(buildDiscoveryRequest(openrouter).url, 'https://openrouter.ai/api/v1/models');
  assert.equal(buildDiscoveryRequest(chatgpt).url, 'https://chatgpt.com/backend-api/codex/models');
  assert.equal(buildDiscoveryRequest(chatgpt).headers['chatgpt-account-id'], 'unit-test-account');
  const claudeDiscovery = buildDiscoveryRequest(claude);
  assert.equal(claudeDiscovery.url, 'https://api.anthropic.com/v1/models');
  assert.equal(claudeDiscovery.headers['anthropic-version'], '2023-06-01');
  assert.equal(claudeDiscovery.headers.authorization, 'Bearer unit-test-token');
});

test('provider model lists parse OpenAI-compatible data envelopes and preserve case', () => {
  assert.deepEqual(parseModelsResponse({
    object: 'list',
    data: [
      { id: 'glm-5.3' },
      { id: 'GLM-5.3-Air' },
      { id: 'glm-5.3' },
    ],
  }), ['glm-5.3', 'GLM-5.3-Air']);

  assert.deepEqual(parseModelsResponse({ data: ['a', 'B'] }), ['a', 'B']);
  assert.deepEqual(parseModelsResponse(['x']), ['x']);

  assert.throws(() => parseModelsResponse({ object: 'list' }), /模型列表/);
});

test('GLM quota parsing ignores the MCP TIME_LIMIT and uses model TOKENS_LIMIT', () => {
  const config = {
    id: 'cfg-glm',
    preset: 'glm-cn',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'unit-test-key',
  };
  const available = parseQuotaBody(config, {
    code: 200,
    success: true,
    data: {
      level: 'max',
      limits: [
        {
          type: 'TIME_LIMIT',
          unit: 5,
          number: 1,
          usage: 4000,
          currentValue: 4000,
          remaining: 0,
          percentage: 100,
          nextResetTime: 1780000000000,
          usageDetails: [{ modelCode: 'search-prime', usage: 122 }],
        },
        {
          type: 'TOKENS_LIMIT',
          unit: 3,
          number: 5,
          percentage: 25,
          nextResetTime: 1780000000000,
        },
      ],
    },
  });

  assert.equal(available.state, 'available');
  assert.equal(available.metrics.length, 1);
  assert.equal(available.metrics[0].id, 'tokens_limit');
  assert.equal(available.metrics[0].remainingPercent, 75);
  assert.equal(available.metrics[0].blocking, true);
  assert.equal(available.metrics[0].resetAt, 1780000000000);

  const exhausted = parseQuotaBody(config, {
    code: 200,
    success: true,
    data: {
      limits: [
        { type: 'TIME_LIMIT', percentage: 100 },
        { type: 'TOKENS_LIMIT', percentage: 100 },
      ],
    },
  });
  assert.equal(exhausted.state, 'exhausted');

  const timeOnly = parseQuotaBody(config, {
    code: 200,
    success: true,
    data: {
      limits: [{ type: 'TIME_LIMIT', percentage: 100 }],
    },
  });
  assert.equal(timeOnly.state, 'unknown');
  assert.equal(timeOnly.metrics.some(metric => metric.blocking && metric.state === 'exhausted'), false);

  const malformed = parseQuotaBody(config, {
    code: 200,
    success: true,
    data: {
      limits: [{ type: 'TOKENS_LIMIT', percentage: 'not-a-number' }],
    },
  });
  assert.equal(malformed.state, 'unknown');
  assert.equal(malformed.metrics[0].remainingPercent, null);
});

test('GLM CREDIT_LIMIT and weekly shapes are handled without inventing zero', () => {
  const config = {
    id: 'cfg-glm',
    preset: 'glm-global',
    base_url: 'https://api.z.ai/api/coding/paas/v4',
    apikey: 'unit-test-key',
  };
  const credit = parseQuotaBody(config, {
    code: 200,
    success: true,
    data: {
      limits: [
        {
          type: 'CREDIT_LIMIT',
          limit: 1000,
          currentValue: 400,
          percentage: 40,
          nextResetTime: 1780000000000,
        },
      ],
    },
  });
  assert.equal(credit.state, 'available');
  assert.equal(credit.metrics[0].kind, 'credits');
  assert.equal(credit.metrics[0].remaining, 600);

  const unknownCredit = parseQuotaBody(config, {
    code: 200,
    success: true,
    data: {
      limits: [{ type: 'CREDIT_LIMIT' }],
    },
  });
  assert.equal(unknownCredit.state, 'unknown');
  assert.equal(unknownCredit.metrics[0].remaining, null);
});

test('OpenCode Go quota treats rate-limited windows as exhausted even below 100 percent', () => {
  const config = {
    id: 'cfg-go',
    preset: 'opencode-go',
    base_url: 'https://opencode.ai/inference/go',
    apikey: 'unit-test-key',
  };
  const rateLimited = parseQuotaBody(config, {
    usage: {
      rolling: { status: 'rate_limited', percent: 99, resetsAt: '2026-10-25T10:00:00.000Z' },
      weekly: { status: 'ok', percent: 10, resetsAt: '2026-10-30T10:00:00.000Z' },
      monthly: { status: 'ok', percent: 5, resetsAt: '2026-11-01T10:00:00.000Z' },
    },
  });
  assert.equal(rateLimited.state, 'exhausted');
  assert.equal(rateLimited.metrics.find(metric => metric.id === 'rolling').state, 'exhausted');
  assert.equal(rateLimited.metrics.find(metric => metric.id === 'weekly').state, 'available');

  const ok = parseQuotaBody(config, {
    usage: {
      rolling: { status: 'ok', percent: 0, resetsAt: '2026-10-25T10:00:00.000Z' },
    },
  });
  assert.equal(ok.state, 'available');
  assert.equal(ok.metrics[0].remainingPercent, 100);

  const missing = parseQuotaBody(config, { usage: {} });
  assert.equal(missing.state, 'unknown');
});

test('OpenRouter key quota uses key limits only and never fabricates account balance', () => {
  const config = {
    id: 'cfg-or',
    preset: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    apikey: 'unit-test-key',
  };
  const exhausted = parseQuotaBody(config, {
    data: {
      label: 'unit-test',
      usage: 5,
      limit: 5,
      limit_remaining: 0,
      limit_reset: 'monthly',
    },
  });
  assert.equal(exhausted.state, 'exhausted');
  assert.equal(exhausted.metrics[0].id, 'key_limit');
  assert.equal(exhausted.metrics[0].remaining, 0);
  assert.equal(exhausted.metrics[0].unit, 'USD');

  const noKeyLimit = parseQuotaBody(config, {
    data: {
      label: 'unit-test',
      usage: 5,
      limit: null,
      limit_remaining: null,
    },
  });
  assert.equal(noKeyLimit.state, 'unknown');
  assert.equal(noKeyLimit.metrics.length, 0);

  assert.equal(parseQuotaPayload({
    statusCode: 200,
    body: {
      data: { limit: 10, limit_remaining: 10, usage: 0 },
    },
  }, config).state, 'available');
});

test('OpenRouter applies individual budgets even when the key limit is positive', () => {
  const config = {
    id: 'cfg-or',
    preset: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    apikey: 'unit-test-key',
  };
  const payload = {
    data: {
      label: 'unit-test',
      usage: 1,
      limit: 100,
      limit_remaining: 99,
      limit_reset: 'monthly',
      budgets: [
        {
          id: 'budget-daily',
          limit: 5,
          usage: 5,
          remaining: 0,
          reset_at: '2026-10-26T00:00:00.000Z',
        },
        {
          id: 'budget-expired',
          limit: 5,
          usage: 5,
          remaining: 0,
          active: false,
        },
      ],
    },
  };

  const parsed = parseQuotaBody(config, payload);
  assert.equal(parsed.state, 'exhausted');
  const budget = parsed.metrics.find(metric => metric.id === 'budget:budget-daily');
  assert.equal(budget.state, 'exhausted');
  assert.equal(budget.resetAt, Date.parse('2026-10-26T00:00:00.000Z'));
  assert.equal(parsed.metrics.some(metric => metric.id === 'budget:budget-expired'), false);
  // A period descriptor must never be interpreted as a timestamp.
  const keyLimit = parsed.metrics.find(metric => metric.id === 'key_limit');
  assert.equal(keyLimit.resetAt, null);
});

test('OpenRouter effective_budget can block a positive key limit', () => {
  const config = {
    id: 'cfg-or',
    preset: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    apikey: 'unit-test-key',
  };
  const parsed = parseQuotaBody(config, {
    data: {
      limit: 100,
      limit_remaining: 80,
      effective_budget: {
        limit: 10,
        usage: 10,
        resets_at: '2026-10-26T00:00:00.000Z',
      },
    },
  });

  assert.equal(parsed.state, 'exhausted');
  assert.equal(parsed.metrics.find(metric => metric.id === 'effective_budget').state, 'exhausted');
});

test('ChatGPT allowed=false blocks even when quota windows are missing', () => {
  const config = {
    id: 'cfg-chatgpt',
    preset: 'chatgpt',
    type: 'token',
    access_token: 'unit-test-token',
    account_id: 'unit-test-account',
  };

  const blocked = parseQuotaBody(config, {
    rate_limit: {
      allowed: false,
    },
  });
  assert.equal(blocked.state, 'exhausted');
  assert.equal(blocked.metrics.some(metric => metric.state === 'exhausted'), true);

  const unknown = parseQuotaBody(config, {
    rate_limit: {},
  });
  assert.equal(unknown.state, 'unknown');

  const limited = parseQuotaBody(config, {
    rate_limit: {
      limit_reached: true,
      primary_window: {},
    },
  });
  assert.equal(limited.state, 'exhausted');
});

test('unknown OpenRouter money limits stay null instead of becoming 100 percent', () => {
  const config = {
    id: 'cfg-or',
    preset: 'openrouter',
    base_url: 'https://openrouter.ai/api/v1',
    apikey: 'unit-test-key',
  };
  const parsed = parseQuotaBody(config, {
    data: {
      budgets: [{ id: 'unknown-budget', label: 'unknown' }],
    },
  });

  assert.equal(parsed.state, 'unknown');
  assert.equal(parsed.metrics.length, 1);
  assert.equal(parsed.metrics[0].remaining, null);
  assert.equal(parsed.metrics[0].limit, null);
  assert.equal(parsed.metrics[0].remainingPercent, null);
  assert.equal(parsed.metrics[0].unit, 'USD');
});

test('quota parsing accepts the Buffer bodies returned by requestBuffered', () => {
  const config = {
    id: 'cfg-glm',
    preset: 'glm-cn',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'unit-test-key',
  };
  const parsed = parseQuotaPayload({
    statusCode: 200,
    body: Buffer.from(JSON.stringify({
      code: 200,
      success: true,
      data: {
        limits: [{ type: 'TOKENS_LIMIT', percentage: 100 }],
      },
    })),
  }, config);

  assert.equal(parsed.state, 'exhausted');
});

test('Claude OAuth token targets use the native Messages path', () => {
  const config = {
    id: 'cfg-claude',
    type: 'claude_token',
    base_url: 'https://api.anthropic.com',
    access_token: 'unit-test-token',
    models: [{ id: 'claude-sonnet-4-5', protocols: ['messages'] }],
  };
  assert.equal(
    buildUpstreamUrl(config, 'messages'),
    'https://api.anthropic.com/v1/messages',
  );
  assert.equal(buildUpstreamUrl(config, 'chat_completions'), null);
});

test('quota request auth follows each provider contract', () => {
  const glm = {
    id: 'cfg-glm',
    preset: 'glm-cn',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'unit-test-key',
  };
  const go = {
    id: 'cfg-go',
    preset: 'opencode-go',
    base_url: 'https://opencode.ai/inference/go',
    apikey: 'unit-test-key',
  };
  const chatgpt = {
    id: 'cfg-chatgpt',
    preset: 'chatgpt',
    type: 'token',
    access_token: 'unit-test-token',
    account_id: 'unit-test-account',
  };

  const glmRequest = buildQuotaRequest(glm);
  assert.equal(glmRequest.url, 'https://open.bigmodel.cn/api/monitor/usage/quota/limit');
  assert.deepEqual(glmRequest.headers, { authorization: 'unit-test-key' });

  const goRequest = buildQuotaRequest(go);
  assert.equal(goRequest.url, 'https://opencode.ai/zen/go/v1/usage');
  assert.deepEqual(goRequest.headers, { authorization: 'Bearer unit-test-key' });

  const chatgptRequest = buildQuotaRequest(chatgpt);
  assert.equal(chatgptRequest.url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal(chatgptRequest.headers.authorization, 'Bearer unit-test-token');
  assert.equal(chatgptRequest.headers['chatgpt-account-id'], 'unit-test-account');

  const zen = { id: 'cfg-zen', preset: 'opencode-zen', base_url: 'https://opencode.ai/inference', apikey: 'k' };
  assert.throws(() => buildQuotaRequest(zen), /尚未核实/);

  const custom = { id: 'cfg-custom', preset: 'custom', base_url: 'http://127.0.0.1:1', apikey: 'k' };
  assert.throws(() => buildQuotaRequest(custom), /未配置额度/);
});

test('upstream auth headers never reuse quota-only raw key formatting for inference', () => {
  const glm = {
    id: 'cfg-glm',
    preset: 'glm-cn',
    base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
    apikey: 'unit-test-key',
    models: [{ id: 'glm-5.3', protocols: ['chat_completions'] }],
  };
  const headers = buildUpstreamAuthHeaders(glm, { stream: true });

  assert.equal(headers.authorization, 'Bearer unit-test-key');
  assert.equal(headers.accept, 'text/event-stream');
  assert.equal(headers['content-type'], 'application/json');
  assert.equal(buildUpstreamAuthHeaders(glm, {}).accept, 'application/json');
});


test('Sub2API root and v1 addresses reuse forwarding key for models and usage without duplicate v1', () => {
  const { normalizeSub2ApiBaseUrl, parseModelCatalog } = require('../app/provider-presets');
  for (const base_url of ['https://relay.invalid', 'https://relay.invalid/v1/', 'https://relay.invalid/v1']) {
    const config = { type: 'apikey', preset: 'sub2api', base_url, apikey: 'relay-key-fixture' };
    assert.equal(buildUpstreamUrl(config, 'responses'), 'https://relay.invalid/v1/responses');
    assert.equal(buildDiscoveryRequest(config).url, 'https://relay.invalid/v1/models');
    assert.deepEqual(buildQuotaRequest(config), { url: 'https://relay.invalid/v1/usage', headers: { authorization: 'Bearer relay-key-fixture' } });
    const parsed = parseQuotaBody(config, { mode: 'unrestricted', isValid: true, unit: 'USD', balance: 8.75 });
    assert.equal(parsed.state, 'available'); assert.equal(parsed.metrics[0].remaining, 8.75); assert.equal(parsed.metrics[0].remainingPercent, null);
  }
  assert.equal(normalizeSub2ApiBaseUrl('https://relay.invalid/prefix'), 'https://relay.invalid/prefix/v1');
  assert.throws(() => normalizeSub2ApiBaseUrl('https://relay.invalid?token=secret'));
  const models = parseModelCatalog({ data: [{ id: 'gpt-native', owned_by: 'openai' }, { id: 'claude-native', owned_by: 'anthropic' }, { id: 'other' }, { id: 'explicit', supported_endpoints: ['/chat/completions'] }] }, { preset: 'sub2api' });
  assert.deepEqual(models.map(item => item.protocols), [['responses'], ['messages'], ['chat_completions'], ['chat_completions']]);
});
