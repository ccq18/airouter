const { buildAuthHeadersForConfig } = require('./openai-config');
const crypto = require('node:crypto');
const { buildUpstreamUrl } = require('./provider-presets');
const {
  UnsupportedProtocolFeatureError,
  normalizeEntryProtocol,
  transformRequestForTarget,
  transformResponseForEntry,
  serializeCanonicalResponse,
  createSseEventParser,
  createSameProtocolSseRewriter,
  createProtocolStreamBridge,
  responseToEntrySse,
  detectRequestCapabilities,
} = (() => {
  const bridge = require('./protocol-bridge');
  return {
    ...bridge,
    detectRequestCapabilities: require('./model-router').detectRequestCapabilities,
  };
})();
const { normalizeResponsesRequestBody } = require('./responses-defaults');

const RETRYABLE_STATUS_CODES = new Set([401, 402, 403, 404, 408, 409, 425, 429]);
const MAX_UPSTREAM_ERROR_BODY_BYTES = 512 * 1024;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildStableSessionId(sessionKey) {
  const key = normalizeString(sessionKey);
  if (!key) {
    return `airouter-${crypto.randomUUID()}`;
  }

  return `airouter-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

function hasOpaqueServerState(body) {
  if (!body || typeof body !== 'object') {
    return false;
  }

  if (typeof body.conversation === 'string' && body.conversation) {
    return true;
  }

  if (Array.isArray(body.input)) {
    return body.input.some(item => item && typeof item === 'object' && (
      item.type === 'reasoning' ||
      item.type === 'item_reference' ||
      item.type === 'computer_call_output' ||
      item.type === 'local_shell_call_output'
    ));
  }

  return false;
}

function sendProtocolError(res, entryProtocol, statusCode, code, message, details = {}) {
  if (res.headersSent) {
    if (!res.writableEnded) {
      res.end();
    }
    return;
  }

  if (entryProtocol === 'messages') {
    res.status(statusCode).json({
      type: 'error',
      error: {
        type: code,
        message,
      },
      ...(Object.keys(details).length ? { details } : {}),
    });
    return;
  }

  res.status(statusCode).json({
    error: {
      message,
      type: code,
      code,
      ...details,
    },
  });
}

function parseRetryAfterMs(headers) {
  const raw = headers && (headers['retry-after'] || headers['Retry-After']);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    return null;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

function extractUpstreamError(bodyText) {
  if (!bodyText) {
    return { message: '', code: '', type: '', metadata: {} };
  }

  try {
    const payload = JSON.parse(bodyText);
    const error = payload && payload.error && typeof payload.error === 'object'
      ? payload.error
      : payload && typeof payload === 'object' ? payload : {};
    const metadata = error.metadata && typeof error.metadata === 'object'
      ? error.metadata
      : payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    return {
      message: normalizeString(error.message || payload.message || ''),
      code: normalizeString(error.code || payload.code || ''),
      type: normalizeString(error.type || payload.type || ''),
      metadata,
    };
  } catch (err) {
    return { message: bodyText.slice(0, 500), code: '', type: '', metadata: {} };
  }
}

function isRetryableStatus(statusCode) {
  return RETRYABLE_STATUS_CODES.has(statusCode) || statusCode >= 500;
}

function isClientRejectionFailure(statusCode, errorCode, message) {
  const text = `${normalizeString(errorCode)} ${normalizeString(message)}`.toLowerCase();
  return statusCode === 400 ||
    statusCode === 413 ||
    statusCode === 422 ||
    statusCode === 405 ||
    /invalid_request|invalid_argument|invalid_prompt|content_policy|policy_violation|context_length|string_too_long/.test(text);
}

function isUpstreamErrorPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  if (payload.error) {
    return true;
  }

  const type = normalizeString(payload.type || payload.object);
  if (type === 'error' || type === 'response.failed' || type === 'response.error') {
    return true;
  }

  return Boolean(payload.response && payload.response.error);
}

function classifyUpstreamErrorPayload(payload) {
  const error = payload.error && typeof payload.error === 'object'
    ? payload.error
    : payload.response && payload.response.error && typeof payload.response.error === 'object'
      ? payload.response.error
      : payload.error && typeof payload.error === 'string'
        ? { message: payload.error }
        : payload;
  const message = normalizeString(error.message || error.detail || '上游返回错误');
  const errorCode = normalizeString(
    error.code ||
    error.type ||
    payload.type ||
    (payload.response && payload.response.status) ||
    '',
  );
  const metadata = error.metadata && typeof error.metadata === 'object'
    ? error.metadata
    : payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  const text = `${errorCode} ${message}`.toLowerCase();
  let statusCode = 502;

  if (/insufficient_quota|quota_exceeded|quota_exhausted|insufficient_balance|billing|usage_limit_reached|usage_not_included/.test(text)) {
    statusCode = 402;
  } else if (/rate.?limit|too.?many.?requests/.test(text)) {
    statusCode = 429;
  } else if (/unauthor|invalid.*(?:api.?key|token)|authentication|auth_failed/.test(text)) {
    statusCode = 401;
  } else if (/invalid_request|invalid_argument|invalid_prompt|content_policy|policy_violation|context_length/.test(text)) {
    statusCode = 400;
  }

  return {
    message,
    code: errorCode,
    metadata,
    statusCode,
  };
}

function isSameProtocolTerminal(protocol, eventName, payload) {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  if (protocol === 'chat_completions') {
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    return Boolean(choice && choice.finish_reason);
  }

  if (protocol === 'messages') {
    const type = payload.type || eventName;
    return type === 'message_delta' || type === 'message_stop';
  }

  const type = payload.type || eventName;
  return type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete';
}

function isMeaningfulStreamEntry(entry, entryProtocol) {
  if (!entry) {
    return false;
  }
  if (entry.raw) {
    return true;
  }

  const data = entry.data || {};
  if (entry.event === 'error') {
    return true;
  }

  if (entryProtocol === 'chat_completions') {
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (!choice) {
      return false;
    }
    if (choice.finish_reason) {
      return true;
    }
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      return true;
    }
    return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
  }

  if (entryProtocol === 'messages') {
    return Boolean(
      entry.event === 'content_block_start' && data.content_block && data.content_block.type === 'tool_use' ||
      entry.event === 'content_block_delta' ||
      entry.event === 'message_delta' ||
      entry.event === 'message_stop',
    );
  }

  return Boolean(
    entry.event === 'response.output_text.delta' ||
    entry.event === 'response.function_call_arguments.delta' ||
    entry.event === 'response.output_item.added' && data.item && data.item.type === 'function_call' ||
    entry.event === 'response.completed' ||
    entry.event === 'response.failed' ||
    entry.event === 'response.incomplete',
  );
}

function buildTargetUrl(config, runtime, protocol) {
  const effectiveConfig = {
    ...config,
    ...(runtime || {}),
    base_url: (runtime && runtime.baseUrl) || config.base_url || '',
    protocol_paths: runtime && runtime.protocol_paths ? runtime.protocol_paths : config.protocol_paths,
    preset: (runtime && runtime.preset) || config.preset,
    type: (runtime && runtime.type) || config.type,
  };
  return buildUpstreamUrl(effectiveConfig, protocol);
}

function buildTargetHeaders(req, runtime, targetProtocol, stream, clientVersion, requestSessionId) {
  const headers = {
    ...buildAuthHeadersForConfig(runtime),
    'content-type': 'application/json',
    accept: stream ? 'text/event-stream' : 'application/json',
    'accept-encoding': 'identity',
    'user-agent': 'Airouter/1.0.0 (coding-agent)',
    'x-opencode-session': requestSessionId,
    session_id: requestSessionId,
  };

  if (runtime && runtime.type === 'token') {
    headers.version = clientVersion || '0.0.1';
    headers.originator = 'codex_cli_rs';
    headers['x-client-request-id'] = requestSessionId;
  }

  if (targetProtocol === 'messages') {
    const anthropicVersion = req.headers['anthropic-version'];
    headers['anthropic-version'] = Array.isArray(anthropicVersion)
      ? anthropicVersion[0]
      : (anthropicVersion || '2023-06-01');
    const anthropicBeta = req.headers['anthropic-beta'];
    if (anthropicBeta) {
      headers['anthropic-beta'] = anthropicBeta;
    }
  }

  return headers;
}

function writeSse(res, entry) {
  if (!entry) {
    return;
  }

  if (entry.raw) {
    res.write(`data: ${entry.raw}\n\n`);
    return;
  }

  if (entry.event) {
    res.write(`event: ${entry.event}\n`);
  }
  res.write(`data: ${JSON.stringify(entry.data)}\n\n`);
}

function consumeStreamToBuffer(response, maxBytes = MAX_UPSTREAM_ERROR_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    function settle(error, value) {
      if (settled) {
        return;
      }
      settled = true;
      response.removeListener('data', handleData);
      response.removeListener('end', handleEnd);
      response.removeListener('error', handleError);
      response.removeListener('close', handleClose);
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }

    function handleData(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total <= maxBytes) {
        chunks.push(buffer);
      }
    }

    function handleEnd() {
      settle(null, Buffer.concat(chunks));
    }

    function handleError(err) {
      settle(err);
    }

    function handleClose() {
      if (!response.complete) {
        settle(response.errored || new Error('upstream response closed before completion'));
      }
    }

    response.on('data', handleData);
    response.on('end', handleEnd);
    response.on('error', handleError);
    response.on('close', handleClose);
  });
}

function applyStreamHeaders(res) {
  if (res.headersSent) {
    return;
  }
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
}

function bindResponseContext(contextStore, entryProtocol, responseId, lease, publicModel, authHash) {
  if (lease && lease.isCurrent && !lease.isCurrent()) return;
  if (entryProtocol !== 'responses' || !contextStore || !normalizeString(responseId)) {
    return;
  }

  contextStore.bind(responseId, {
    config_id: lease.config.id,
    target_id: lease.target.id,
    model: lease.target.model,
    protocol: lease.target.protocol,
    public_model: publicModel,
    auth_hash: authHash,
  });
}

function minRetryAfterFromSkipped(skipped, now = Date.now()) {
  const values = (Array.isArray(skipped) ? skipped : [])
    .map(item => item && item.until)
    .filter(value => Number.isFinite(value) && value > now);
  if (!values.length) {
    return null;
  }
  return Math.min(...values);
}

function createExplicitRoutingHandler(options = {}) {
  const getRouter = typeof options.getRouter === 'function' ? options.getRouter : () => null;
  const getQuotaEngine = typeof options.getQuotaEngine === 'function' ? options.getQuotaEngine : () => null;
  const getContextStore = typeof options.getContextStore === 'function' ? options.getContextStore : () => null;
  const prepareUpstreamConfig = typeof options.prepareUpstreamConfig === 'function' ? options.prepareUpstreamConfig : null;
  const refreshUpstreamAuth = typeof options.refreshUpstreamAuth === 'function' ? options.refreshUpstreamAuth : null;
  const getAuthIdentityHash = typeof options.getAuthIdentityHash === 'function' ? options.getAuthIdentityHash : () => '';
  const getSessionKey = typeof options.getSessionKey === 'function' ? options.getSessionKey : () => '';
  const readRequestBody = options.readRequestBody;
  const createUpstreamRequest = options.createUpstreamRequest;
  const upstreamTimeoutMs = Number.isFinite(options.upstreamTimeoutMs) ? options.upstreamTimeoutMs : 0;
  const bodyLimitBytes = Number.isFinite(options.bodyLimitBytes) ? options.bodyLimitBytes : 16 * 1024 * 1024;
  const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 30 * 1000;
  const clientVersion = normalizeString(options.clientVersion) || '0.0.1';
  const log = typeof options.log === 'function' ? options.log : () => {};
  const error = typeof options.error === 'function' ? options.error : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  async function refreshExhaustedCandidates(router, route) {
    const quotaEngine = getQuotaEngine();
    if (!quotaEngine || typeof quotaEngine.ensureFresh !== 'function') {
      return;
    }

    const configIds = new Set((route.targets || []).map(target => target.config_id).filter(Boolean));
    for (const configId of configIds) {
      const snapshot = typeof quotaEngine.getSnapshot === 'function'
        ? quotaEngine.getSnapshot(configId)
        : null;
      if (!snapshot || snapshot.state !== 'exhausted') {
        continue;
      }

      const resetDue = Number.isFinite(snapshot.resetAt) && snapshot.resetAt <= now();
      const stale = Number.isFinite(snapshot.checkedAt) && now() - snapshot.checkedAt >= 60 * 1000;
      if (!resetDue && !stale) {
        continue;
      }

      const config = typeof router.getConfig === 'function' ? router.getConfig(configId) : null;
      if (!config) {
        continue;
      }

      try {
        await quotaEngine.ensureFresh(config);
      } catch (err) {
        // A failed refresh is not proof of recovery; keep the exhausted state.
        error(`统一路由额度刷新失败: ${configId} (${err.message})`);
      }
    }
  }

  async function handle(req, res) {
    const entryProtocol = normalizeEntryProtocol(options.entryProtocol || req.path || req.url);
    if (!entryProtocol || !['POST'].includes(req.method)) {
      sendProtocolError(res, entryProtocol || 'responses', 405, 'method_not_allowed', '仅支持 POST 对话请求');
      return;
    }

    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.includes('application/json')) {
      sendProtocolError(res, entryProtocol, 415, 'unsupported_media_type', 'Content-Type 必须是 application/json');
      return;
    }

    const router = getRouter();
    if (!router) {
      sendProtocolError(res, entryProtocol, 503, 'routing_not_ready', '统一路由尚未初始化');
      return;
    }

    let rawBody;
    try {
      rawBody = await readRequestBody(req, {
        idleTimeoutMs,
        limitBytes: bodyLimitBytes,
      });
    } catch (err) {
      sendProtocolError(res, entryProtocol, err.statusCode || 400, err.code || 'invalid_request_body', err.message);
      return;
    }

    if (req.aborted || res.destroyed || res.writableEnded) return;

    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch (err) {
      sendProtocolError(res, entryProtocol, 400, 'invalid_json', `请求体不是合法 JSON: ${err.message}`);
      return;
    }

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendProtocolError(res, entryProtocol, 400, 'invalid_request_body', '请求体必须是 JSON 对象');
      return;
    }

    const requestAuthHash = normalizeString(getAuthIdentityHash(req));
    const requestSessionId = buildStableSessionId(getSessionKey(req, body));

    const publicModel = normalizeString(body.model);
    if (!publicModel) {
      sendProtocolError(res, entryProtocol, 400, 'model_required', '请求缺少 model');
      return;
    }

    const route = router.resolve(publicModel);
    if (!route) {
      sendProtocolError(res, entryProtocol, 404, 'model_not_found', `未配置客户端模型: ${publicModel}`);
      return;
    }

    if (!route.entry_protocols.includes(entryProtocol)) {
      sendProtocolError(res, entryProtocol, 400, 'entry_protocol_not_supported', `客户端模型 ${publicModel} 不支持当前入口协议`);
      return;
    }

    await refreshExhaustedCandidates(router, route);
    if (req.aborted || res.destroyed || res.writableEnded) return;

    let forcedTargetId = '';
    const previousResponseId = entryProtocol === 'responses' ? normalizeString(body.previous_response_id) : '';
    if (previousResponseId) {
      const contextStore = getContextStore();
      const binding = contextStore ? contextStore.resolve(previousResponseId) : null;
      if (
        !binding ||
        binding.public_model !== publicModel ||
        binding.protocol !== 'responses' ||
        binding.auth_hash !== requestAuthHash
      ) {
        sendProtocolError(
          res,
          entryProtocol,
          409,
          'upstream_context_unavailable',
          'previous_response_id 无法迁移到其他账号、调用凭证或供应商；请重新发送完整上下文',
        );
        return;
      }

      const boundTarget = route.targets.find(target => target.id === binding.target_id && target.config_id === binding.config_id);
      if (
        !boundTarget ||
        boundTarget.model !== binding.model ||
        boundTarget.protocol !== binding.protocol
      ) {
        sendProtocolError(
          res,
          entryProtocol,
          409,
          'upstream_context_unavailable',
          'previous_response_id 绑定的上游候选或模型已变化；请重新发送完整上下文',
        );
        return;
      }
      forcedTargetId = boundTarget.id;
    }

    if (entryProtocol === 'responses' && !previousResponseId && hasOpaqueServerState(body)) {
      sendProtocolError(
        res,
        entryProtocol,
        409,
        'upstream_context_unavailable',
        '请求包含服务端会话、加密 reasoning 或 item_reference 状态；必须携带 previous_response_id 固定原候选，或重发完整上下文',
      );
      return;
    }

    const capabilities = detectRequestCapabilities(entryProtocol, body);
    const maxAttempts = router.getMaxAttempts(route);
    if (maxAttempts <= 0) {
      sendProtocolError(res, entryProtocol, 503, 'no_available_upstream', '当前客户端模型没有可用候选');
      return;
    }

    const clientWantsStream = entryProtocol === 'responses'
      ? body.stream !== false
      : body.stream === true;
    const excludeTargetIds = [];
    let attempts = 0;
    const attemptedTargetIds = new Set();
    function consumeAttempt(lease) {
      const id = lease.outerTargetId || lease.target.id;
      if (!attemptedTargetIds.has(id)) { attemptedTargetIds.add(id); attempts += 1; }
    }
    function refundAttempt(lease) {
      attemptedTargetIds.delete(lease.outerTargetId || lease.target.id);
      attempts = attemptedTargetIds.size;
    }
    function retryable(status, lease, message = '') {
      return isRetryableStatus(status) || Boolean(lease.pool && status === 400 && /privacy|training|not.?support|unavailable|not available|context.{0,20}length/i.test(message));
    }
    let lastFailure = null;
    let lastSkipped = [];
    const authRefreshedConfigs = new Set();
    let currentLease = null;
    let currentUpstream = null;
    let clientClosed = false;
    let committed = false;
    let responseFinished = false;
    let released = false;

    function releaseLease() {
      if (released) {
        return;
      }
      released = true;
      if (currentLease) {
        currentLease.release();
        currentLease = null;
      }
    }

    function markNotCommittedFailure(lease, details) {
      router.markFailure(lease, details);
    }

    const closeUpstream = () => {
      clientClosed = true;
      releaseLease();
      if (currentUpstream && !responseFinished) {
        currentUpstream.abort(new Error('client closed request'));
      }
    };

    req.on('aborted', closeUpstream);
    res.on('close', () => {
      if (!responseFinished) {
        closeUpstream();
      }
    });

    try {
    while (!clientClosed && !committed) {
      responseFinished = false;
      if (forcedTargetId && attempts > 0) {
        break;
      }

      const selection = router.select(publicModel, entryProtocol, {
        capabilities, body, attemptedTargetIds,
        excludeTargetIds: forcedTargetId ? [] : excludeTargetIds,
        onlyTargetId: forcedTargetId,
      });
      lastSkipped = selection.skipped;

      if (!selection.lease) {
        if (forcedTargetId) {
          sendProtocolError(
            res,
            entryProtocol,
            409,
            'upstream_context_unavailable',
            'previous_response_id 对应的上游当前不可用；请重新发送完整上下文',
          );
          return;
        }
        break;
      }

      currentLease = selection.lease;
      released = false;
      const lease = currentLease;
      const runtime = lease.runtime;
      const target = lease.target;
      const targetProtocol = target.protocol;

      try {
      if (previousResponseId && targetProtocol !== 'responses') {
        sendProtocolError(
          res,
          entryProtocol,
          409,
          'upstream_context_unavailable',
          'previous_response_id 只能续接到原 Responses 上游；请重新发送完整上下文',
        );
        releaseLease();
        return;
      }

      const targetStream = clientWantsStream || (runtime && runtime.type === 'token' && targetProtocol === 'responses');

      if (prepareUpstreamConfig) {
        try {
          await prepareUpstreamConfig(runtime);
        } catch (err) {
          if (clientClosed || res.destroyed || res.writableEnded) return;
          markNotCommittedFailure(lease, {
            statusCode: 401,
            reason: 'upstream_auth_prepare_failed',
            message: err.message,
          });
          releaseLease();
          excludeTargetIds.push(target.id);
          lastFailure = { statusCode: 502, message: err.message, code: 'upstream_auth_prepare_failed' };
          continue;
        }
      }

      // Preparation may settle after the client closes or a diagnostic expires.
      if (clientClosed || req.aborted || res.destroyed || res.writableEnded) return;
      if (lease.pool) {
        // A sync can revoke free eligibility while credential preparation waits.
        // Check the latest catalog/price/capability snapshot before sending.
        const currentModel = lease.isCurrent() && router.poolEngine.getCandidates(lease.config, capabilities, body).find(model => model.id === target.model);
        if (!currentModel) { releaseLease(); excludeTargetIds.push(target.id); continue; }
        lease.poolModel = currentModel;
      }

      let requestBody;
      try {
        let sourceBody = body;
        if (entryProtocol === 'responses' && targetProtocol === 'responses') {
          sourceBody = normalizeResponsesRequestBody('/responses', body, {
            forceStoreFalse: runtime && runtime.type === 'token',
          });
        }

        requestBody = transformRequestForTarget({
          entryProtocol,
          targetProtocol,
          body: sourceBody,
          targetModel: target.model,
          stream: targetStream,
        });

        if (targetProtocol === 'responses' && runtime && runtime.type === 'token') {
          requestBody.store = false;
        }
      } catch (err) {
        releaseLease();
        if (err instanceof UnsupportedProtocolFeatureError) {
          sendProtocolError(res, entryProtocol, 400, err.code, err.message);
          return;
        }
        sendProtocolError(res, entryProtocol, 400, 'request_transform_failed', err.message);
        return;
      }

      if (lease.pool) {
        if (requestBody.max_tokens == null && requestBody.max_completion_tokens == null) requestBody.max_tokens = 2048;
        router.poolEngine.recordAttempt(lease.config, lease.poolModel);
        if (lease.config.preset === 'openrouter-free') {
          // Hard price ceiling on every request; concrete model only, never a
          // user-supplied models[]/route fallback or billable hosted tool.
          delete requestBody.models; delete requestBody.route; delete requestBody.plugins;
          delete requestBody.web_search_options; delete requestBody.transforms;
          const privacy = requestBody.provider || {};
          requestBody.provider = {
            ...(privacy.data_collection === 'deny' ? { data_collection: 'deny' } : {}),
            ...(privacy.zdr === true ? { zdr: true } : {}),
            ...(privacy.enforce_distillable_text === true ? { enforce_distillable_text: true } : {}),
            ...(Array.isArray(privacy.only) ? { only: privacy.only } : {}),
            ...(Array.isArray(privacy.ignore) ? { ignore: privacy.ignore } : {}),
            require_parameters: true, allow_fallbacks: false,
            max_price: { prompt: 0, completion: 0, request: 0, image: 0 } };
        }
      }
      const effectiveConfig = lease.pool ? { ...lease.config, preset: runtime.poolSourcePreset } : lease.config;
      const targetUrl = buildTargetUrl(effectiveConfig, runtime, targetProtocol);
      if (!targetUrl) {
        releaseLease();
        markNotCommittedFailure(lease, { reason: 'protocol_endpoint_unsupported' });
        excludeTargetIds.push(target.id);
        consumeAttempt(lease);
        continue;
      }

      const headers = buildTargetHeaders(req, runtime, targetProtocol, targetStream, clientVersion, requestSessionId);
      const upstreamBody = Buffer.from(JSON.stringify(requestBody));

      if (options.accessLogEnabled) {
        log(`统一路由: ${publicModel} -> ${target.config_id}/${target.model} (${targetProtocol}, try ${attempts + 1}/${maxAttempts})`);
      }

      let upstream;
      try {
        if (typeof options.onAttempt === 'function') options.onAttempt({
          target_id: target.id, config_id: target.config_id,
          account_label: lease.config.description || target.config_id,
          model: target.model, protocol: targetProtocol,
          ...(lease.pool ? { pool_id: target.config_id, pool_target_id: lease.outerTargetId } : {}),
        });
        upstream = createUpstreamRequest({
          method: 'POST',
          targetUrl,
          headers,
          body: upstreamBody,
          timeoutMs: upstreamTimeoutMs,
        });
      } catch (err) {
        releaseLease();
        markNotCommittedFailure(lease, { reason: 'upstream_request_error', message: err.message });
        excludeTargetIds.push(target.id);
        consumeAttempt(lease);
        lastFailure = { statusCode: 502, message: err.message };
        continue;
      }
      currentUpstream = upstream;
      consumeAttempt(lease);

      let response;
      try {
        response = await upstream.responsePromise;
      } catch (err) {
        if (clientClosed) {
          releaseLease();
          return;
        }
        markNotCommittedFailure(lease, { reason: 'upstream_network_error', message: err.message });
        releaseLease();
        excludeTargetIds.push(target.id);
        lastFailure = { statusCode: 502, message: err.message };
        continue;
      }

      if (clientClosed) {
        upstream.abort(new Error('client closed request'));
        releaseLease();
        return;
      }

      const statusCode = Number(response.statusCode || 502);
      const responseContentType = String(response.headers['content-type'] || '').toLowerCase();
      const isSse = responseContentType.includes('text/event-stream');

      if (statusCode < 200 || statusCode >= 300) {
        const errorBody = await consumeStreamToBuffer(response);
        responseFinished = true;
        const errorInfo = extractUpstreamError(errorBody.toString('utf8'));
        const retryAfterMs = parseRetryAfterMs(response.headers);
        if (
          statusCode === 401 &&
          refreshUpstreamAuth &&
          !authRefreshedConfigs.has(target.config_id)
        ) {
          authRefreshedConfigs.add(target.config_id);
          try {
            if (await refreshUpstreamAuth(runtime)) {
              releaseLease();
              refundAttempt(lease);
              lastFailure = null;
              continue;
            }
          } catch (err) {
            error(`统一路由凭证刷新失败: ${target.config_id} (${err.message})`);
          }
        }
        markNotCommittedFailure(lease, {
          statusCode,
          retryAfterMs: retryAfterMs ?? undefined,
          message: errorInfo.message,
          errorCode: errorInfo.code || errorInfo.type,
          metadata: errorInfo.metadata,
          reason: `upstream_http_${statusCode}`,
        });
        releaseLease();
        excludeTargetIds.push(target.id);
        lastFailure = {
          statusCode,
          message: errorInfo.message || `上游返回 HTTP ${statusCode}`,
          code: errorInfo.code || errorInfo.type,
          retryAfterMs,
        };

        if (!retryable(statusCode, lease, errorInfo.message)) {
          break;
        }
        continue;
      }

      // Success. From here on, once any downstream bytes are written, failover is
      // forbidden and the response must be terminated, never spliced.
      if (clientWantsStream) {
        if (targetStream && isSse) {
          const parser = createSseEventParser();
          const rewriter = entryProtocol === targetProtocol
            ? createSameProtocolSseRewriter(entryProtocol, publicModel)
            : null;
          const bridge = rewriter
            ? null
            : createProtocolStreamBridge({ entryProtocol, targetProtocol, publicModel });
          let pendingEntries = [];
          let downstreamResponseId = '';
          let sawTerminal = false;
          let sawDone = false;
          let streamError = null;
          let retryDescriptor = null;
          let settled = false;

          const processEntries = entries => {
            for (const entry of entries) {
              if (entry && entry.event === 'response.created' && entry.data?.response?.id) {
                downstreamResponseId = entry.data.response.id;
              }
              if (!committed) {
                if (isMeaningfulStreamEntry(entry, entryProtocol)) {
                  applyStreamHeaders(res);
                  committed = true;
                  for (const pending of pendingEntries) {
                    writeSse(res, pending);
                  }
                  pendingEntries = [];
                  writeSse(res, entry);
                } else {
                  pendingEntries.push(entry);
                }
              } else {
                writeSse(res, entry);
              }
            }
          };

          const handleParsed = parsed => {
            if (settled || retryDescriptor) {
              return;
            }
            if (parsed.raw === '[DONE]') {
              sawDone = true;
              sawTerminal = true;
              if (bridge) {
                processEntries(bridge.finish());
              } else {
                processEntries([parsed]);
              }
              return;
            }
            if (!parsed.data || typeof parsed.data !== 'object') {
              return;
            }
            if (isUpstreamErrorPayload(parsed.data)) {
              const descriptor = classifyUpstreamErrorPayload(parsed.data);
              if (!committed) {
                retryDescriptor = descriptor;
                return;
              }
              streamError = descriptor;
              sawTerminal = true;
            }

            const entries = rewriter
              ? rewriter.accept(parsed.event, parsed.data)
              : bridge.accept(parsed.event, parsed.data);
            processEntries(entries);
            if (bridge && bridge.isComplete()) {
              sawTerminal = true;
            } else if (rewriter && isSameProtocolTerminal(entryProtocol, parsed.event, parsed.data)) {
              sawTerminal = true;
            }
          };

          const result = await new Promise(resolve => {
            const cleanup = () => {
              response.removeListener('data', onData);
              response.removeListener('end', onEnd);
              response.removeListener('error', onError);
              response.removeListener('close', onClose);
            };
            const finishAttempt = outcome => {
              if (settled) {
                return;
              }
              settled = true;
              cleanup();
              resolve(outcome);
            };
            const onData = chunk => {
              if (settled) {
                return;
              }
              for (const parsed of parser.push(chunk)) {
                handleParsed(parsed);
                if (retryDescriptor) {
                  break;
                }
              }
              if (retryDescriptor) {
                responseFinished = true;
                try {
                  upstream.abort(new Error('retry upstream stream error'));
                } catch (err) {
                  // Best-effort cleanup.
                }
                finishAttempt({ retry: retryDescriptor });
              }
            };
            const onEnd = () => {
              responseFinished = true;
              if (!retryDescriptor) {
                for (const parsed of parser.finish()) {
                  handleParsed(parsed);
                  if (retryDescriptor) {
                    break;
                  }
                }
              }
              if (retryDescriptor) {
                finishAttempt({ retry: retryDescriptor });
                return;
              }

              const complete = sawDone || sawTerminal || Boolean(bridge && bridge.isComplete());
              if (!complete) {
                const descriptor = {
                  statusCode: 502,
                  code: 'incomplete_upstream_stream',
                  message: '上游流式响应在完成标记前结束',
                };
                if (!committed) {
                  finishAttempt({ retry: descriptor });
                  return;
                }
                router.markFailure(lease, descriptor);
                streamError = descriptor;
              }

              if (streamError) {
                if (!committed) {
                  finishAttempt({ retry: streamError });
                  return;
                }
                router.markFailure(lease, {
                  statusCode: streamError.statusCode,
                  message: streamError.message,
                  errorCode: streamError.code,
                  metadata: streamError.metadata,
                  reason: streamError.code || 'upstream_stream_error',
                });
                releaseLease();
                if (!res.writableEnded) {
                  res.end();
                }
                finishAttempt({ error: streamError });
                return;
              }

              router.markSuccess(lease);
              bindResponseContext(
                getContextStore(),
                entryProtocol,
                downstreamResponseId,
                lease,
                publicModel,
                requestAuthHash,
              );
              releaseLease();
              if (!res.writableEnded) {
                res.end();
              }
              finishAttempt({ done: true });
            };
            const onError = err => {
              responseFinished = true;
              if (clientClosed) {
                releaseLease();
                finishAttempt({ aborted: true });
                return;
              }
              const descriptor = {
                statusCode: 502,
                code: 'upstream_stream_error',
                message: err.message,
              };
              if (!committed) {
                finishAttempt({ retry: descriptor });
                return;
              }
              router.markFailure(lease, descriptor);
              releaseLease();
              if (!res.writableEnded) {
                res.end();
              }
              finishAttempt({ error: descriptor });
            };
            const onClose = () => {
              if (response.complete || settled) {
                return;
              }
              onError(response.errored || new Error('上游流式响应提前关闭'));
            };

            response.on('data', onData);
            response.on('end', onEnd);
            response.on('error', onError);
            response.on('close', onClose);
          });

          responseFinished = true;
          if (clientClosed) {
            releaseLease();
            return;
          }
          if (result.retry) {
            if (
              result.retry.statusCode === 401 &&
              refreshUpstreamAuth &&
              !authRefreshedConfigs.has(target.config_id)
            ) {
              authRefreshedConfigs.add(target.config_id);
              try {
                if (await refreshUpstreamAuth(runtime)) {
                  releaseLease();
                  refundAttempt(lease);
                  lastFailure = null;
                  continue;
                }
              } catch (err) {
                error(`统一路由凭证刷新失败: ${target.config_id} (${err.message})`);
              }
            }
            markNotCommittedFailure(lease, {
              statusCode: result.retry.statusCode,
              message: result.retry.message,
              errorCode: result.retry.code,
              reason: result.retry.code || 'upstream_stream_retry',
            });
            releaseLease();
            if (!retryable(result.retry.statusCode, lease, result.retry.message)) {
              sendProtocolError(
                res,
                entryProtocol,
                result.retry.statusCode,
                result.retry.code || 'upstream_error',
                result.retry.message,
              );
              return;
            }
            excludeTargetIds.push(target.id);
            lastFailure = {
              statusCode: result.retry.statusCode,
              message: result.retry.message,
              code: result.retry.code,
            };
            continue;
          }
          return;
        }

        // Non-stream upstream response but streaming client: transform then emit SSE.
        const responseBody = await consumeStreamToBuffer(response);
        responseFinished = true;
        let parsedPayload;
        try {
          parsedPayload = JSON.parse(responseBody.toString('utf8'));
        } catch (err) {
          markNotCommittedFailure(lease, { statusCode: 502, message: err.message, reason: 'invalid_upstream_json' });
          releaseLease();
          excludeTargetIds.push(target.id);
          lastFailure = { statusCode: 502, code: 'invalid_upstream_json', message: err.message };
          continue;
        }

        if (isUpstreamErrorPayload(parsedPayload)) {
          const descriptor = classifyUpstreamErrorPayload(parsedPayload);
          if (
            descriptor.statusCode === 401 &&
            refreshUpstreamAuth &&
            !authRefreshedConfigs.has(target.config_id)
          ) {
            authRefreshedConfigs.add(target.config_id);
            try {
              if (await refreshUpstreamAuth(runtime)) {
                releaseLease();
                refundAttempt(lease);
                lastFailure = null;
                continue;
              }
            } catch (err) {
              error(`统一路由凭证刷新失败: ${target.config_id} (${err.message})`);
            }
          }
          markNotCommittedFailure(lease, {
            statusCode: descriptor.statusCode,
            message: descriptor.message,
            errorCode: descriptor.code,
            metadata: descriptor.metadata,
            reason: descriptor.code || 'upstream_error_payload',
          });
          releaseLease();
          if (retryable(descriptor.statusCode, lease, descriptor.message)) {
            excludeTargetIds.push(target.id);
            lastFailure = { statusCode: descriptor.statusCode, message: descriptor.message, code: descriptor.code };
            continue;
          }
          sendProtocolError(res, entryProtocol, descriptor.statusCode, descriptor.code || 'upstream_error', descriptor.message);
          return;
        }

        let entryPayload;
        let canonical;
        try {
          entryPayload = transformResponseForEntry({
            entryProtocol,
            targetProtocol,
            payload: parsedPayload,
            publicModel,
          });
          canonical = require('./protocol-bridge').parseTargetResponse(targetProtocol, parsedPayload);
        } catch (err) {
          markNotCommittedFailure(lease, { statusCode: 502, message: err.message, reason: 'response_transform_failed' });
          releaseLease();
          excludeTargetIds.push(target.id);
          lastFailure = { statusCode: 502, code: 'response_transform_failed', message: err.message };
          continue;
        }

        applyStreamHeaders(res);
        committed = true;
        for (const entry of responseToEntrySse(entryProtocol, canonical, publicModel)) {
          writeSse(res, entry);
        }
        router.markSuccess(lease);
        bindResponseContext(getContextStore(), entryProtocol, entryPayload.id, lease, publicModel, requestAuthHash);
        releaseLease();
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }

      // Non-stream client.
      if (targetStream && isSse) {
        const parser = createSseEventParser();
        const bridge = createProtocolStreamBridge({ entryProtocol, targetProtocol, publicModel });
        let streamError = null;
        let sawDone = false;

        await new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            response.removeListener('data', onData);
            response.removeListener('end', onEnd);
            response.removeListener('error', onError);
            response.removeListener('close', onClose);
          };
          const finish = (err) => {
            if (settled) {
              return;
            }
            settled = true;
            cleanup();
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          };
          const onData = chunk => {
            for (const parsed of parser.push(chunk)) {
              if (parsed.raw === '[DONE]') {
                sawDone = true;
                bridge.finish();
                continue;
              }
              if (!parsed.data || typeof parsed.data !== 'object') {
                continue;
              }
              if (isUpstreamErrorPayload(parsed.data)) {
                if (!streamError) {
                  streamError = classifyUpstreamErrorPayload(parsed.data);
                }
                continue;
              }
              bridge.accept(parsed.event, parsed.data);
            }
          };
          const onEnd = () => {
            responseFinished = true;
            for (const parsed of parser.finish()) {
              if (parsed.raw === '[DONE]') {
                sawDone = true;
                bridge.finish();
              } else if (parsed.data && typeof parsed.data === 'object') {
                if (isUpstreamErrorPayload(parsed.data)) {
                  if (!streamError) {
                    streamError = classifyUpstreamErrorPayload(parsed.data);
                  }
                } else {
                  bridge.accept(parsed.event, parsed.data);
                }
              }
            }
            finish();
          };
          const onError = err => {
            responseFinished = true;
            if (clientClosed) {
              finish();
              return;
            }
            finish(err);
          };
          const onClose = () => {
            if (response.complete || settled) {
              return;
            }
            onError(response.errored || new Error('上游流式响应提前关闭'));
          };

          response.on('data', onData);
          response.on('end', onEnd);
          response.on('error', onError);
          response.on('close', onClose);
        });
        responseFinished = true;
        if (clientClosed) {
          releaseLease();
          return;
        }

        if (
          streamError &&
          streamError.statusCode === 401 &&
          refreshUpstreamAuth &&
          !authRefreshedConfigs.has(target.config_id)
        ) {
          authRefreshedConfigs.add(target.config_id);
          try {
            if (await refreshUpstreamAuth(runtime)) {
              releaseLease();
              refundAttempt(lease);
              lastFailure = null;
              continue;
            }
          } catch (err) {
            error(`统一路由凭证刷新失败: ${target.config_id} (${err.message})`);
          }
        }

        if (streamError) {
          markNotCommittedFailure(lease, {
            statusCode: streamError.statusCode,
            message: streamError.message,
            errorCode: streamError.code,
            metadata: streamError.metadata,
            reason: streamError.code || 'upstream_stream_error',
          });
          releaseLease();
          if (retryable(streamError.statusCode, lease, streamError.message)) {
            excludeTargetIds.push(target.id);
            lastFailure = {
              statusCode: streamError.statusCode,
              message: streamError.message,
              code: streamError.code,
              retryAfterMs: null,
            };
            continue;
          }
          sendProtocolError(
            res,
            entryProtocol,
            streamError.statusCode,
            streamError.code || 'upstream_error',
            streamError.message,
          );
          return;
        }

        if (!sawDone && !bridge.isComplete()) {
          const incomplete = {
            statusCode: 502,
            code: 'incomplete_upstream_stream',
            message: '上游流式响应在完成标记前结束',
          };
          markNotCommittedFailure(lease, incomplete);
          releaseLease();
          excludeTargetIds.push(target.id);
          lastFailure = incomplete;
          continue;
        }

        bridge.finish();
        const canonical = bridge.getCanonicalResponse();
        const payload = serializeCanonicalResponse(entryProtocol, canonical, publicModel);
        res.status(200).json(payload);
        router.markSuccess(lease);
        bindResponseContext(getContextStore(), entryProtocol, payload.id, lease, publicModel, requestAuthHash);
        releaseLease();
        return;
      }

      const responseBody = await consumeStreamToBuffer(response);
      responseFinished = true;
      let parsedPayload;
      try {
        parsedPayload = JSON.parse(responseBody.toString('utf8'));
      } catch (err) {
        markNotCommittedFailure(lease, {
          statusCode: 502,
          message: `上游响应不是合法 JSON: ${err.message}`,
          reason: 'invalid_upstream_json',
        });
        releaseLease();
        excludeTargetIds.push(target.id);
        lastFailure = {
          statusCode: 502,
          code: 'invalid_upstream_json',
          message: `上游响应不是合法 JSON: ${err.message}`,
        };
        continue;
      }

      if (isUpstreamErrorPayload(parsedPayload)) {
        const descriptor = classifyUpstreamErrorPayload(parsedPayload);
        if (
          descriptor.statusCode === 401 &&
          refreshUpstreamAuth &&
          !authRefreshedConfigs.has(target.config_id)
        ) {
          authRefreshedConfigs.add(target.config_id);
          try {
            if (await refreshUpstreamAuth(runtime)) {
              releaseLease();
              refundAttempt(lease);
              lastFailure = null;
              continue;
            }
          } catch (err) {
            error(`统一路由凭证刷新失败: ${target.config_id} (${err.message})`);
          }
        }

        markNotCommittedFailure(lease, {
          statusCode: descriptor.statusCode,
          message: descriptor.message,
          errorCode: descriptor.code,
          metadata: descriptor.metadata,
          reason: descriptor.code || 'upstream_error_payload',
        });
        releaseLease();
        if (retryable(descriptor.statusCode, lease, descriptor.message)) {
          excludeTargetIds.push(target.id);
          lastFailure = {
            statusCode: descriptor.statusCode,
            message: descriptor.message,
            code: descriptor.code,
          };
          continue;
        }
        sendProtocolError(
          res,
          entryProtocol,
          descriptor.statusCode,
          descriptor.code || 'upstream_error',
          descriptor.message,
        );
        return;
      }

      let payload;
      try {
        payload = transformResponseForEntry({
          entryProtocol,
          targetProtocol,
          payload: parsedPayload,
          publicModel,
        });
      } catch (err) {
        markNotCommittedFailure(lease, {
          statusCode: 502,
          message: err.message,
          reason: 'response_transform_failed',
        });
        releaseLease();
        excludeTargetIds.push(target.id);
        lastFailure = {
          statusCode: 502,
          code: 'response_transform_failed',
          message: err.message,
        };
        continue;
      }

      res.status(200).json(payload);
      router.markSuccess(lease);
      bindResponseContext(getContextStore(), entryProtocol, payload.id, lease, publicModel, requestAuthHash);
      releaseLease();
      return;
      } catch (attemptError) {
        if (currentUpstream && !responseFinished) {
          currentUpstream.abort(attemptError);
        }
        if (clientClosed) return;
        if (committed || res.headersSent) {
          res.destroy(attemptError);
          return;
        }
        markNotCommittedFailure(lease, {
          statusCode: 502, message: attemptError.message, reason: 'upstream_transport_error',
        });
        releaseLease();
        excludeTargetIds.push(target.id);
        lastFailure = { statusCode: 502, code: 'upstream_transport_error', message: '上游响应传输中断' };
        continue;
      }
    }

    releaseLease();

    if (clientClosed) {
      return;
    }

    if (forcedTargetId) {
      sendProtocolError(
        res,
        entryProtocol,
        409,
        'upstream_context_unavailable',
        'previous_response_id 对应的上游当前不可用；请重新发送完整上下文',
      );
      return;
    }

    if (lastFailure && lastFailure.statusCode) {
      const retryAfterMs = lastFailure.retryAfterMs;
      if (retryAfterMs && !res.headersSent) {
        res.setHeader('retry-after', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
      sendProtocolError(
        res,
        entryProtocol,
        lastFailure.statusCode >= 400 && lastFailure.statusCode < 600 ? lastFailure.statusCode : 502,
        lastFailure.code || 'upstream_error',
        lastFailure.message || '上游请求失败',
      );
      return;
    }

    const retryAt = minRetryAfterFromSkipped(lastSkipped, now());
    if (retryAt && !res.headersSent) {
      res.setHeader('retry-after', String(Math.max(1, Math.ceil((retryAt - now()) / 1000))));
    }
    sendProtocolError(
      res,
      entryProtocol,
      503,
      'no_available_upstream',
      '当前客户端模型没有可用上游；请检查额度、健康状态或账号配置',
      lastSkipped.length ? { skipped: lastSkipped } : {},
    );
    } finally {
      if (currentUpstream && !responseFinished) {
        try {
          currentUpstream.abort(new Error('request attempt ended before completion'));
        } catch (err) {
          // Best-effort cleanup.
        }
      }
      releaseLease();
    }
  }

  return function explicitRoutingHandler(req, res) {
    void handle(req, res).catch(err => {
      if (res.headersSent) {
        if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      sendProtocolError(res, normalizeEntryProtocol(options.entryProtocol || req.path || req.url) || 'responses', 500, 'internal_error', err.message);
    });
  };
}

module.exports = {
  createExplicitRoutingHandler,
  sendProtocolError,
  extractUpstreamError,
  isRetryableStatus,
  buildTargetUrl,
};
