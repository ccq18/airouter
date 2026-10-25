const { createExplicitRoutingHandler } = require('./explicit-routing-handler');
const { createModelRouter, createRoutingContextStore } = require('./model-router');
const { parseRoutingConfig } = require('./routing-config');

const PROTOCOLS = new Set(['chat_completions', 'responses', 'messages']);

function invalid(message, status = 400, code = 'invalid_test_request') {
  const error = new Error(message); error.status = status; error.code = code; throw error;
}

function buildTestBody(model, input, protocol) {
  const common = { model, stream: false };
  if (protocol === 'responses') return { ...common, input, max_output_tokens: 2048 };
  return { ...common, messages: [{ role: 'user', content: input }], max_tokens: 2048 };
}

// Test responses may contain upstream error diagnostics. Never return a known
// credential even if an upstream mistakenly echoes it in its error message.
function redactTestResponse(response, configs) {
  const secrets = new Set();
  function collect(value, key = '') {
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && value.length >= 8 && /key|token|secret|password/i.test(key)) secrets.add(value);
      return;
    }
    for (const [name, entry] of Object.entries(value)) collect(entry, name);
  }
  configs.forEach(collect);
  let serialized = JSON.stringify(response);
  for (const secret of secrets) serialized = serialized.split(JSON.stringify(secret).slice(1, -1)).join('[REDACTED]');
  return JSON.parse(serialized);
}

function createRouteTestHandler(options) {
  const timeoutMs = Math.min(60000, Math.max(100, Number(options.timeoutMs) || 60000));
  return function routeTest(req, res) {
    const request = req.body || {};
    if (typeof request.model !== 'string' || !request.model.trim()) invalid('请选择客户端模型');
    if (typeof request.input !== 'string' || !request.input.trim() || request.input.length > 16000) invalid('测试输入须为 1-16000 字符');
    if (!['route', 'candidate'].includes(request.mode)) invalid('测试模式必须为 route 或 candidate');
    const parsed = options.getParsedConfig();
    const route = parseRoutingConfig(parsed).models.find(item => item.id === request.model);
    if (!route) invalid('客户端模型不存在', 404, 'model_not_found');
    const protocol = request.protocol || route.entry_protocols[0];
    if (!PROTOCOLS.has(protocol) || !route.entry_protocols.includes(protocol)) invalid('该路由不接受所选入口协议');
    const target = request.mode === 'candidate' ? route.targets.find(item => item.id === request.target_id) : null;
    if (request.mode === 'candidate' && !target) invalid('候选不属于当前路由');
    const started = Date.now();
    const attempts = [];
    const sendJson = res.json.bind(res);
    res.json = payload => {
      if (res.writableEnded || res.destroyed) return res;
      return sendJson({
        mode: request.mode, model: route.id, protocol, target_id: target?.id || null,
        attempts, elapsed_ms: Date.now() - started, status_code: res.statusCode,
        response: redactTestResponse(payload, [parsed, options.getParsedConfig()]),
      });
    };

    if (target && parsed.configs.find(item => item.id === target.config_id)?.enabled === false) {
      res.json = payload => sendJson({ mode: request.mode, model: route.id, protocol,
        target_id: target.id, attempts: [], elapsed_ms: 0, status_code: 0, outcome: 'skipped',
        response: { error: { code: 'account_disabled', message: '账号已停用，本次未发送请求' } } });
      return res.status(200).json({});
    }

    let router = options.getRouter();
    if (target) {
      // The snapshot restricts this diagnostic to one existing candidate. It
      // never persists a route, changes account enablement, or clears production
      // quota/cooldown state. The normal protocol and credential path is reused.
      const isolated = { ...parsed, routing: { models: [{ ...route, enabled: true, targets: [target], max_attempts: 1 }] } };
      router = createModelRouter({ parsed: isolated, runtimeConfigs: options.getRuntimeConfigs(), poolEngine: options.getPoolEngine?.() });
    }
    const forwarding = options.getForwardingOptions();
    const body = Buffer.from(JSON.stringify(buildTestBody(route.id, request.input, protocol)));
    const timer = setTimeout(() => {
      if (res.writableEnded || res.destroyed) return;
      res.status(504).json({ error: { code: 'test_timeout', message: '测试超过时限，已中止上游请求' } });
      req.emit('aborted');
    }, timeoutMs);
    timer.unref?.();
    const cleanup = () => clearTimeout(timer);
    res.once('finish', cleanup);
    res.once('close', cleanup);
    const testContext = createRoutingContextStore();
    const handler = createExplicitRoutingHandler({
      ...forwarding, entryProtocol: protocol,
      preserveNativeJson: false,
      getRouter: () => router,
      ...(target ? { getQuotaEngine: () => null } : {}),
      getContextStore: () => testContext,
      readRequestBody: async () => body,
      upstreamTimeoutMs: Math.min(timeoutMs, forwarding.upstreamTimeoutMs || timeoutMs),
      onAttempt: details => attempts.push(details),
    });
    return handler(req, res);
  };
}

module.exports = { createRouteTestHandler, buildTestBody, redactTestResponse };
