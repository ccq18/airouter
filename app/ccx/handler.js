const { createUpstreamRequest: defaultCreateUpstreamRequest, consumeResponseBody } = require('../upstream-request');
const { applyPromptCacheHints } = require('./cache');
const {
  buildTargetUrl,
  buildUpstreamPath,
  detectDownstreamProtocol,
  isCompactPath,
  protocolCapability,
  resolveCcxOptions,
} = require('./protocols');
const {
  createResponseId,
  normalizeResponsesRequest,
  normalizeResponsesResponse,
  recordConvertedSession,
} = require('./canonical-responses');
const {
  buildLocalCompactRequest,
  isNativeCompactUnsupported,
} = require('./compact');
const {
  createResponsesToMessagesSseTransformer,
  messagesRequestToResponses,
  messagesResponseToResponses,
  responsesRequestToMessages,
  responsesResponseToMessages,
} = require('./messages-converter');
const {
  chatRequestToResponses,
  chatResponseToResponses,
  createResponsesToChatSseTransformer,
  responsesRequestToChat,
  responsesResponseToChat,
} = require('./chat-converter');
const { createCcxSessionStore } = require('./session-store');
const {
  parseSseText,
  writeSseDone,
  writeSseEvent,
} = require('./stream-sse');
const {
  responsesUsageFromChatUsage,
  responsesUsageFromMessagesUsage,
} = require('./usage');

const HOP_BY_HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const LOCAL_ONLY_AUTH_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'chatgpt-account-id',
]);
const LOCAL_ONLY_HEADER_PREFIXES = [
  'x-airouter-',
  'x-admin-',
];

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(bodyBuffer) {
  if (!bodyBuffer || bodyBuffer.length === 0) {
    return {};
  }
  return JSON.parse(bodyBuffer.toString('utf8'));
}

function buildAuthHeaders(config) {
  if (config.type === 'apikey') {
    return {
      authorization: `Bearer ${config.apiKey}`,
    };
  }
  return {
    authorization: `Bearer ${config.access_token}`,
    'chatgpt-account-id': config.account_id,
  };
}

function buildUpstreamHeaders(reqHeaders, config, contentLength, isStream) {
  const headers = { ...reqHeaders };
  for (const headerName of Object.keys(headers)) {
    const normalized = String(headerName).toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(normalized) ||
      LOCAL_ONLY_AUTH_HEADERS.has(normalized) ||
      LOCAL_ONLY_HEADER_PREFIXES.some(prefix => normalized.startsWith(prefix))
    ) {
      delete headers[headerName];
    }
  }
  Object.assign(headers, buildAuthHeaders(config));
  headers['content-type'] = 'application/json';
  headers.accept = isStream ? 'text/event-stream' : 'application/json';
  if (typeof contentLength === 'number') {
    headers['content-length'] = String(contentLength);
  } else {
    delete headers['content-length'];
  }
  return headers;
}

function copyResponseHeaders(res, headers = {}, options = {}) {
  for (const [name, value] of Object.entries(headers || {})) {
    const normalized = String(name).toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(normalized) || normalized === 'content-length' || typeof value === 'undefined') {
      continue;
    }
    if (options.contentType && normalized === 'content-type') {
      continue;
    }
    res.setHeader(normalized, value);
  }
  if (options.contentType) {
    res.setHeader('content-type', options.contentType);
  }
}

function sendJson(res, statusCode, payload) {
  res.status(statusCode);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

function sendError(res, statusCode, message, details) {
  sendJson(res, statusCode, {
    error: 'ccx_error',
    message,
    ...(details ? { details } : {}),
  });
}

function isEventStream(headers) {
  return String(headers?.['content-type'] || '').toLowerCase().includes('text/event-stream');
}

function looksLikeSseText(text) {
  return /^\s*(event:|data:)/.test(String(text || ''));
}

function protocolSupportsConfig(config, protocol) {
  if (!config) {
    return false;
  }
  if (config.type === 'token') {
    return protocol !== 'messages';
  }
  const capability = protocolCapability(protocol);
  return Array.isArray(config.support)
    ? config.support.includes(capability)
    : capability === 'gpt';
}

function responsesRequestForDownstream(protocol, body, options) {
  if (protocol === 'responses') {
    return normalizeResponsesRequest(body);
  }
  if (protocol === 'messages') {
    return normalizeResponsesRequest(messagesRequestToResponses(body, options));
  }
  return normalizeResponsesRequest(chatRequestToResponses(body));
}

function upstreamRequestBodyFromResponses(protocol, responsesRequest, session) {
  if (protocol === 'responses') {
    return responsesRequest;
  }
  if (protocol === 'messages') {
    return responsesRequestToMessages(responsesRequest, session);
  }
  return responsesRequestToChat(responsesRequest, session);
}

function adaptResponsesBodyForConfig(body, config) {
  if (!body || typeof body !== 'object' || !config || config.type !== 'token') {
    return body;
  }
  const adapted = { ...body };
  delete adapted.max_output_tokens;
  adapted.store = false;
  return adapted;
}

function responsesResponseFromUpstream(protocol, payload, request) {
  if (protocol === 'responses') {
    return normalizeResponsesResponse(payload, request);
  }
  if (protocol === 'messages') {
    return messagesResponseToResponses(payload, request);
  }
  return chatResponseToResponses(payload, request);
}

function downstreamResponseFromResponses(protocol, response, request) {
  if (protocol === 'responses') {
    return normalizeResponsesResponse(response, request);
  }
  if (protocol === 'messages') {
    return responsesResponseToMessages(response);
  }
  return responsesResponseToChat(response, request);
}

function makeResponsesSseEntry(event, data) {
  return {
    event,
    data: {
      type: event,
      ...data,
    },
  };
}

function convertResponsesSseToEntries(text) {
  return parseSseText(text)
    .filter(entry => entry.dataText !== '[DONE]')
    .map(entry => {
      const payload = JSON.parse(entry.dataText || '{}');
      return {
        event: entry.eventName || payload.type || '',
        data: payload,
      };
    });
}

function responsesResponseFromSseEntries(entries, request) {
  let completed = null;
  const textByItem = new Map();
  let currentItemId = '';
  let model = request.model;
  for (const entry of entries) {
    if (entry.event === 'error') {
      throw new Error(entry.data?.error?.message || 'upstream responses stream error');
    }
    if (entry.event === 'response.failed') {
      throw new Error(entry.data?.response?.error?.message || 'upstream responses failed');
    }
    if (entry.event === 'response.created') {
      model = entry.data?.response?.model || model;
      continue;
    }
    if (entry.event === 'response.output_item.added' && entry.data?.item?.type === 'message') {
      currentItemId = entry.data.item.id || currentItemId;
      if (currentItemId && !textByItem.has(currentItemId)) {
        textByItem.set(currentItemId, '');
      }
      continue;
    }
    if (entry.event === 'response.output_text.delta') {
      const itemId = entry.data?.item_id || currentItemId || 'msg_0';
      textByItem.set(itemId, `${textByItem.get(itemId) || ''}${entry.data?.delta || ''}`);
      continue;
    }
    if (entry.event === 'response.completed' && entry.data?.response) {
      completed = normalizeResponsesResponse(entry.data.response, request);
    }
  }
  if (completed && Array.isArray(completed.output) && completed.output.length > 0) {
    return completed;
  }
  const output = Array.from(textByItem.entries())
    .filter(([, text]) => text.length > 0)
    .map(([id, text]) => ({
      id,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    }));
  return normalizeResponsesResponse({
    ...(completed || {}),
    model,
    output,
  }, request);
}

function convertChatSseToResponsesEntries(text, request) {
  const responseId = createResponseId();
  const messageId = `msg_${responseId.slice('resp_'.length)}`;
  const state = {
    created: false,
    contentStarted: false,
    text: '',
    model: request.model,
    usage: null,
  };
  const entries = [];

  function ensureCreated(model) {
    if (!state.created) {
      state.created = true;
      state.model = model || state.model;
      entries.push(makeResponsesSseEntry('response.created', {
        response: {
          id: responseId,
          model: state.model,
          status: 'in_progress',
          output: [],
        },
      }));
    }
  }

  function ensureContentStarted() {
    if (state.contentStarted) {
      return;
    }
    state.contentStarted = true;
    entries.push(makeResponsesSseEntry('response.output_item.added', {
      output_index: 0,
      item: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
      },
    }));
    entries.push(makeResponsesSseEntry('response.content_part.added', {
      item_id: messageId,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    }));
  }

  for (const entry of parseSseText(text)) {
    if (entry.dataText === '[DONE]') {
      continue;
    }
    const payload = JSON.parse(entry.dataText || '{}');
    if (payload.usage) {
      state.usage = payload.usage;
    }
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
    if (!choice) {
      continue;
    }
    ensureCreated(payload.model);
    const delta = choice?.delta || {};
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      ensureContentStarted();
      state.text += delta.content;
      entries.push(makeResponsesSseEntry('response.output_text.delta', {
        item_id: messageId,
        content_index: 0,
        delta: delta.content,
      }));
    }
    if (choice?.finish_reason) {
      if (state.contentStarted) {
        entries.push(makeResponsesSseEntry('response.content_part.done', {
          item_id: messageId,
          content_index: 0,
        }));
      }
      entries.push(makeResponsesSseEntry('response.completed', {
        response: {
          id: responseId,
          model: state.model,
          status: 'completed',
          output: [{
            id: messageId,
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: state.text }],
          }],
          usage: responsesUsageFromChatUsage(payload.usage || state.usage || {}),
        },
      }));
    }
  }
  if (!entries.some(entry => entry.event === 'response.completed')) {
    entries.push(makeResponsesSseEntry('response.completed', {
      response: {
        id: responseId,
        model: state.model,
        status: 'completed',
        output: state.text
          ? [{
              id: messageId,
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: state.text }],
            }]
          : [],
        usage: responsesUsageFromChatUsage(state.usage || {}),
      },
    }));
  }
  return entries;
}

function convertMessagesSseToResponsesEntries(text, request) {
  const responseId = createResponseId();
  const state = {
    responseId,
    messageId: '',
    model: request.model,
    contentStarted: false,
    text: '',
    usage: {},
  };
  const entries = [];

  for (const entry of parseSseText(text)) {
    const payload = JSON.parse(entry.dataText || '{}');
    const eventName = entry.eventName || payload.type || '';
    if (eventName === 'message_start') {
      state.messageId = payload.message?.id || `msg_${responseId.slice('resp_'.length)}`;
      state.model = payload.message?.model || state.model;
      entries.push(makeResponsesSseEntry('response.created', {
        response: {
          id: responseId,
          model: state.model,
          status: 'in_progress',
          output: [],
        },
      }));
      continue;
    }
    if (eventName === 'content_block_start' && payload.content_block?.type === 'text') {
      state.contentStarted = true;
      entries.push(makeResponsesSseEntry('response.output_item.added', {
        output_index: 0,
        item: {
          id: state.messageId,
          type: 'message',
          role: 'assistant',
          content: [],
        },
      }));
      entries.push(makeResponsesSseEntry('response.content_part.added', {
        item_id: state.messageId,
        content_index: payload.index || 0,
        part: { type: 'output_text', text: '' },
      }));
      continue;
    }
    if (eventName === 'content_block_delta' && payload.delta?.type === 'text_delta') {
      state.text += payload.delta.text || '';
      entries.push(makeResponsesSseEntry('response.output_text.delta', {
        item_id: state.messageId,
        content_index: payload.index || 0,
        delta: payload.delta.text || '',
      }));
      continue;
    }
    if (eventName === 'content_block_stop' && state.contentStarted) {
      entries.push(makeResponsesSseEntry('response.content_part.done', {
        item_id: state.messageId,
        content_index: payload.index || 0,
      }));
      continue;
    }
    if (eventName === 'message_delta') {
      state.usage = payload.usage || state.usage;
      continue;
    }
    if (eventName === 'message_stop') {
      entries.push(makeResponsesSseEntry('response.completed', {
        response: {
          id: responseId,
          model: state.model,
          status: 'completed',
          output: state.text
            ? [{
                id: state.messageId,
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: state.text }],
              }]
            : [],
          usage: responsesUsageFromMessagesUsage(state.usage || {}),
        },
      }));
    }
  }
  return entries;
}

function convertUpstreamSseToResponsesEntries(upstreamProtocol, text, request) {
  if (upstreamProtocol === 'responses') {
    return convertResponsesSseToEntries(text);
  }
  if (upstreamProtocol === 'chat') {
    return convertChatSseToResponsesEntries(text, request);
  }
  return convertMessagesSseToResponsesEntries(text, request);
}

function writeResponsesEntriesToDownstream(res, downstreamProtocol, responsesEntries, responsesRequest) {
  if (downstreamProtocol === 'responses') {
    for (const entry of responsesEntries) {
      writeSseEvent(res, entry);
    }
    return;
  }
  const transformer = downstreamProtocol === 'messages'
    ? createResponsesToMessagesSseTransformer(responsesRequest)
    : createResponsesToChatSseTransformer(responsesRequest);
  for (const entry of responsesEntries) {
    for (const emitted of transformer.accept(entry.event, entry.data)) {
      writeSseEvent(res, emitted);
    }
  }
  if (downstreamProtocol === 'chat') {
    writeSseDone(res);
  }
}

function getSessionForUpstream(upstreamProtocol, responsesRequest, sessionStore) {
  if (upstreamProtocol === 'responses') {
    return null;
  }
  if (!responsesRequest.previous_response_id) {
    return null;
  }
  return sessionStore.getSessionByResponseId(responsesRequest.previous_response_id);
}

async function sendUpstreamRequest({
  req,
  config,
  body,
  upstreamPath,
  createUpstreamRequest,
  timeoutMs,
  isStream,
}) {
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  const headers = buildUpstreamHeaders(req.headers || {}, config, bodyBuffer.length, isStream);
  const targetUrl = buildTargetUrl(config, upstreamPath);
  const upstream = createUpstreamRequest({
    method: 'POST',
    targetUrl,
    headers,
    body: bodyBuffer,
    timeoutMs,
  });
  return {
    targetUrl,
    headers,
    body: bodyBuffer,
    upstream,
    response: await upstream.responsePromise,
  };
}

async function passthroughRequest({ req, res, config, protocol, bodyBuffer, createUpstreamRequest, timeoutMs, compact = false, isStream = false }) {
  const upstreamPath = buildUpstreamPath(protocol, config, { compact });
  const targetUrl = buildTargetUrl(config, upstreamPath);
  const headers = buildUpstreamHeaders(req.headers || {}, config, bodyBuffer.length, isStream);
  const upstream = createUpstreamRequest({
    method: 'POST',
    targetUrl,
    headers,
    body: bodyBuffer,
    timeoutMs,
  });
  const response = await upstream.responsePromise;
  res.status(Number(response.statusCode || 502));
  copyResponseHeaders(res, response.headers);
  response.on('data', chunk => res.write(chunk));
  response.on('end', () => res.end());
  response.on('error', err => {
    if (!res.headersSent) {
      sendError(res, 502, '上游响应读取失败', err.message);
    } else {
      res.end();
    }
  });
  response.resume();
}

async function handleConvertedNonStream({
  req,
  res,
  downstreamProtocol,
  upstreamProtocol,
  config,
  responsesRequest,
  sessionStore,
  createUpstreamRequest,
  timeoutMs,
  downstreamBody,
  ccxOptions,
}) {
  const session = getSessionForUpstream(upstreamProtocol, responsesRequest, sessionStore);
  const upstreamResponsesRequest = upstreamProtocol === 'responses'
    ? adaptResponsesBodyForConfig({ ...responsesRequest, stream: true }, config)
    : responsesRequest;
  const upstreamBody = applyPromptCacheHints({
    upstreamProtocol,
    upstreamBody: upstreamRequestBodyFromResponses(upstreamProtocol, upstreamResponsesRequest, session),
    req,
    downstreamBody,
    config,
    ccxOptions,
  });
  const upstreamPath = buildUpstreamPath(upstreamProtocol, config);
  const upstreamResult = await sendUpstreamRequest({
    req,
    config,
    body: upstreamBody,
    upstreamPath,
    createUpstreamRequest,
    timeoutMs,
    isStream: upstreamProtocol === 'responses' || responsesRequest.stream === true,
  });
  const response = upstreamResult.response;
  const responseBuffer = await consumeResponseBody(response);
  const statusCode = Number(response.statusCode || 502);
  if (statusCode < 200 || statusCode >= 300) {
    res.status(statusCode);
    copyResponseHeaders(res, response.headers);
    res.end(responseBuffer);
    return;
  }
  const responseText = responseBuffer.toString('utf8');
  const responsesResponse = isEventStream(response.headers) || looksLikeSseText(responseText)
    ? responsesResponseFromSseEntries(
        convertUpstreamSseToResponsesEntries(upstreamProtocol, responseText, responsesRequest),
        responsesRequest
      )
    : responsesResponseFromUpstream(upstreamProtocol, JSON.parse(responseText || '{}'), responsesRequest);
  recordConvertedSession(sessionStore, responsesRequest, responsesResponse);
  const downstreamPayload = downstreamResponseFromResponses(downstreamProtocol, responsesResponse, responsesRequest);
  sendJson(res, statusCode, downstreamPayload);
}

async function handleConvertedStream({
  req,
  res,
  downstreamProtocol,
  upstreamProtocol,
  config,
  responsesRequest,
  sessionStore,
  createUpstreamRequest,
  timeoutMs,
  downstreamBody,
  ccxOptions,
}) {
  // The first migration keeps SSE semantics but buffers converted streams into a
  // final semantic response. Same-protocol SSE remains byte-for-byte passthrough.
  const session = getSessionForUpstream(upstreamProtocol, responsesRequest, sessionStore);
  const upstreamResponsesRequest = upstreamProtocol === 'responses'
    ? adaptResponsesBodyForConfig(responsesRequest, config)
    : responsesRequest;
  const upstreamBody = applyPromptCacheHints({
    upstreamProtocol,
    upstreamBody: upstreamRequestBodyFromResponses(upstreamProtocol, upstreamResponsesRequest, session),
    req,
    downstreamBody,
    config,
    ccxOptions,
  });
  const upstreamPath = buildUpstreamPath(upstreamProtocol, config);
  const upstreamResult = await sendUpstreamRequest({
    req,
    config,
    body: upstreamBody,
    upstreamPath,
    createUpstreamRequest,
    timeoutMs,
    isStream: true,
  });
  const response = upstreamResult.response;
  const responseBuffer = await consumeResponseBody(response);
  if (Number(response.statusCode || 502) < 200 || Number(response.statusCode || 502) >= 300) {
    res.status(Number(response.statusCode || 502));
    copyResponseHeaders(res, response.headers);
    res.end(responseBuffer);
    return;
  }
  // If an upstream unexpectedly returns JSON for a streaming request, convert it.
  const responseText = responseBuffer.toString('utf8');
  if (!isEventStream(response.headers) && !looksLikeSseText(responseText)) {
    const payload = JSON.parse(responseText || '{}');
    const responsesResponse = responsesResponseFromUpstream(upstreamProtocol, payload, responsesRequest);
    recordConvertedSession(sessionStore, responsesRequest, responsesResponse);
    const downstreamPayload = downstreamResponseFromResponses(downstreamProtocol, responsesResponse, responsesRequest);
    sendJson(res, 200, downstreamPayload);
    return;
  }
  res.status(200);
  res.setHeader('content-type', 'text/event-stream');
  if (upstreamProtocol === downstreamProtocol) {
    res.write(responseBuffer);
    res.end();
    return;
  }
  const responsesEntries = convertUpstreamSseToResponsesEntries(upstreamProtocol, responseText, responsesRequest);
  let completedResponse = null;
  for (const entry of responsesEntries) {
    if (entry.event === 'response.completed' && entry.data.response) {
      completedResponse = normalizeResponsesResponse(entry.data.response, responsesRequest);
    }
  }
  writeResponsesEntriesToDownstream(res, downstreamProtocol, responsesEntries, responsesRequest);
  if (completedResponse) {
    recordConvertedSession(sessionStore, responsesRequest, completedResponse);
  }
  res.end();
}

async function handleConvertedRequest(options) {
  if (options.responsesRequest.stream === true) {
    await handleConvertedStream(options);
    return;
  }
  await handleConvertedNonStream(options);
}

async function handleCompact({
  req,
  res,
  body,
  bodyBuffer,
  upstreamProtocol,
  downstreamProtocol,
  config,
  ccxOptions,
  sessionStore,
  createUpstreamRequest,
  timeoutMs,
}) {
  if (upstreamProtocol === 'responses') {
    const upstreamPath = buildUpstreamPath('responses', config, { compact: true });
    const targetUrl = buildTargetUrl(config, upstreamPath);
    const headers = buildUpstreamHeaders(req.headers || {}, config, bodyBuffer.length, body.stream === true);
    const upstream = createUpstreamRequest({
      method: 'POST',
      targetUrl,
      headers,
      body: bodyBuffer,
      timeoutMs,
    });
    const response = await upstream.responsePromise;
    if (!isNativeCompactUnsupported(response.statusCode) || !ccxOptions.compact.localFallback) {
      res.status(Number(response.statusCode || 502));
      copyResponseHeaders(res, response.headers);
      response.on('data', chunk => res.write(chunk));
      response.on('end', () => res.end());
      response.resume();
      return;
    }
    response.resume();
  }

  const localCompactRequest = buildLocalCompactRequest(body, sessionStore, ccxOptions.compact);
  await handleConvertedRequest({
    req,
    res,
    downstreamProtocol,
    upstreamProtocol,
    config,
    responsesRequest: normalizeResponsesRequest(localCompactRequest),
    sessionStore,
    createUpstreamRequest,
    timeoutMs,
    downstreamBody: body,
    ccxOptions,
  });
}

function createCcxHandler(options = {}) {
  const createUpstreamRequest = options.createUpstreamRequest || defaultCreateUpstreamRequest;
  const sessionStore = options.sessionStore || createCcxSessionStore(options.ccxOptions?.session || {});
  const timeoutMs = options.upstreamRequestTimeoutMs;
  const responsesOptions = options.responsesOptions || {};
  const resolveRuntimeOptions = () => (
    options.ccxOptions && options.ccxOptions.upstreamProtocol
      ? options.ccxOptions
      : resolveCcxOptions(options.ccxOptions || {})
  );

  return async function ccxHandler(req, res) {
    const ccxOptions = resolveRuntimeOptions();
    if (!ccxOptions.enabled) {
      sendError(res, 404, 'ccx 未启用');
      return;
    }
    const downstreamProtocol = detectDownstreamProtocol(`${req.baseUrl || ''}${req.url || ''}`);
    if (!downstreamProtocol) {
      sendError(res, 404, '未知的 ccx 路由');
      return;
    }
    const upstreamProtocol = ccxOptions.upstreamProtocol;
    if (!ccxOptions.enabledUpstreamProtocols.includes(upstreamProtocol)) {
      sendError(res, 503, `ccx upstream_protocol=${upstreamProtocol} 未启用`);
      return;
    }
    const config = options.getConfig ? options.getConfig(upstreamProtocol) : null;
    if (!protocolSupportsConfig(config, upstreamProtocol)) {
      sendError(res, 503, `没有可用的 ${upstreamProtocol} 上游配置`);
      return;
    }

    let bodyBuffer;
    let body;
    try {
      bodyBuffer = await readRequestBody(req);
      body = parseJsonBody(bodyBuffer);
    } catch (err) {
      sendError(res, 400, '请求体 JSON 解析失败', err.message);
      return;
    }

    try {
      if (isCompactPath(`${req.baseUrl || ''}${req.url || ''}`)) {
        await handleCompact({
          req,
          res,
          body,
          bodyBuffer,
          downstreamProtocol,
          upstreamProtocol,
          config,
          ccxOptions,
          sessionStore,
          createUpstreamRequest,
          timeoutMs,
        });
        return;
      }

      if (downstreamProtocol === upstreamProtocol) {
        await passthroughRequest({
          req,
          res,
          config,
          protocol: upstreamProtocol,
          bodyBuffer,
          createUpstreamRequest,
          timeoutMs,
          isStream: body.stream === true,
        });
        return;
      }

      const responsesRequest = responsesRequestForDownstream(downstreamProtocol, body, {
        responsesOptions,
      });
      await handleConvertedRequest({
        req,
        res,
        downstreamProtocol,
        upstreamProtocol,
        config,
        responsesRequest,
        sessionStore,
        createUpstreamRequest,
        timeoutMs,
        downstreamBody: body,
        ccxOptions,
      });
    } catch (err) {
      sendError(res, /previous_response_id|compact/.test(err.message) ? 400 : 502, err.message);
    }
  };
}

module.exports = {
  buildUpstreamHeaders,
  createCcxHandler,
  protocolSupportsConfig,
};
