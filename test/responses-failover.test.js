const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
  applyResponsesFailoverRequestHeaders,
  classifyResponsesModelDowngrade,
  classifyRetryableResponsesHttpError,
  createResponsesEventStreamInspector,
  isInspectableResponsesEventStream,
  drainAbandonedResponse,
  shouldMarkResponsesFailoverUnavailable,
} = require('../app/responses-failover');

test('classifyRetryableResponsesHttpError detects usage_limit_reached', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 429,
    bodyText: JSON.stringify({
      error: {
        type: 'usage_limit_reached',
        plan_type: 'plus',
      },
    }),
  });

  assert.deepEqual(result, {
    reason: 'responses_usage_limit_reached',
    retryKey: 'usage_limit_reached',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError detects raw usage limit messages', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 429,
    bodyText: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:22 PM.",
  });

  assert.deepEqual(result, {
    reason: 'responses_usage_limit_reached',
    retryKey: 'usage_limit_reached',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError falls back to usage limit messages when error type is unknown', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 429,
    bodyText: JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: "You've hit your usage limit. Upgrade to Pro.",
      },
    }),
  });

  assert.deepEqual(result, {
    reason: 'responses_usage_limit_reached',
    retryKey: 'usage_limit_reached',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError treats unknown 429 error types as failed', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 429,
    bodyText: JSON.stringify({
      error: {
        type: 'rate_limit_error',
        message: 'request is rate limited',
      },
    }),
  });

  assert.deepEqual(result, {
    reason: 'responses_unknown_error',
    retryKey: 'rate_limit_error',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError detects usage_not_included', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 429,
    bodyText: JSON.stringify({
      error: {
        type: 'usage_not_included',
      },
    }),
  });

  assert.deepEqual(result, {
    reason: 'responses_usage_not_included',
    retryKey: 'usage_not_included',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError detects unauthorized detail payloads', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 401,
    bodyText: JSON.stringify({
      detail: 'Unauthorized',
    }),
  });

  assert.deepEqual(result, {
    reason: 'missing_credentials',
    retryKey: 'unauthorized',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError detects revoked oauth token payloads', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 401,
    bodyText: JSON.stringify({
      detail: 'Encountered invalidated oauth token for user, failing request',
      error: {
        code: 'token_revoked',
      },
    }),
  });

  assert.deepEqual(result, {
    reason: 'missing_credentials',
    retryKey: 'token_revoked',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError detects token_revoked in raw error text', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 401,
    bodyText: 'unexpected status 401 Unauthorized: Encountered invalidated oauth token for user, auth error code: token_revoked',
  });

  assert.deepEqual(result, {
    reason: 'missing_credentials',
    retryKey: 'token_revoked',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError treats unknown auth failures as failed', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 401,
    bodyText: JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'authentication failed',
      },
    }),
  });

  assert.deepEqual(result, {
    reason: 'responses_unknown_error',
    retryKey: '401',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError detects model capacity HTTP errors', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 503,
    bodyText: JSON.stringify({
      error: {
        code: 'model_at_capacity',
        message: 'Selected model is at capacity. Please try a different model.',
      },
    }),
  });

  assert.deepEqual(result, {
    reason: 'responses_model_at_capacity',
    retryKey: 'model_at_capacity',
    retrySource: 'http',
  });
});

test('classifyRetryableResponsesHttpError treats non-200 success statuses as failed', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 201,
    bodyText: '',
  });

  assert.deepEqual(result, {
    reason: 'responses_unknown_error',
    retryKey: 'http_201',
    retrySource: 'http',
  });
});

test('createResponsesEventStreamInspector catches insufficient_quota failures', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'data: {"type":"response.failed","response":{"error":{"code":"insufficient_quota"}}}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_insufficient_quota',
    retryKey: 'insufficient_quota',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector ignores prelude events and retries usage_not_included', () => {
  const inspector = createResponsesEventStreamInspector();

  const firstResult = inspector.push(Buffer.from(
    'data: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    'utf8',
  ));
  const secondResult = inspector.push(Buffer.from(
    'data: {"type":"response.failed","response":{"error":{"code":"usage_not_included"}}}\n\n',
    'utf8',
  ));

  assert.deepEqual(firstResult, { action: 'pending' });
  assert.deepEqual(secondResult, {
    action: 'retry',
    reason: 'responses_usage_not_included',
    retryKey: 'usage_not_included',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector retries usage_limit_reached stream failures', () => {
  const inspector = createResponsesEventStreamInspector();

  const firstResult = inspector.push(Buffer.from(
    'data: {"type":"response.created","response":{"id":"resp_123"}}\n\n',
    'utf8',
  ));
  const secondResult = inspector.push(Buffer.from(
    'data: {"type":"response.failed","response":{"error":{"code":"usage_limit_reached","message":"You\\u0027ve hit your usage limit."}}}\n\n',
    'utf8',
  ));

  assert.deepEqual(firstResult, { action: 'pending' });
  assert.deepEqual(secondResult, {
    action: 'retry',
    reason: 'responses_usage_limit_reached',
    retryKey: 'usage_limit_reached',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector retries usage limit messages without an error code', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'data: {"type":"response.failed","response":{"error":{"message":"You\\u0027ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:22 PM."}}}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_usage_limit_reached',
    retryKey: 'usage_limit_reached',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector falls back to usage limit messages when error code is unknown', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'data: {"type":"response.failed","response":{"error":{"code":"rate_limit_error","message":"You\\u0027ve hit your usage limit. Upgrade to Pro."}}}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_usage_limit_reached',
    retryKey: 'usage_limit_reached',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector treats response.failed with unknown error code as failed', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'data: {"type":"response.failed","response":{"error":{"code":"model_overloaded","message":"model overloaded"}}}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_unknown_error',
    retryKey: 'model_overloaded',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector retries model capacity stream failures', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'event: response.failed\n' +
    'data: {"response":{"error":{"code":"model_at_capacity","message":"Selected model is at capacity. Please try a different model."}}}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_model_at_capacity',
    retryKey: 'model_at_capacity',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector retries generic SSE error events', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'event: error\n' +
    'data: {"error":{"code":"server_is_overloaded","message":"server overloaded"}}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_unknown_error',
    retryKey: 'server_is_overloaded',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector retries malformed SSE events before forwarding', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'event: response.failed\n' +
    'data: not-json\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_unknown_error',
    retryKey: 'response.failed',
    retrySource: 'stream',
  });
});

test('createResponsesEventStreamInspector passes through on the first non-prelude event', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, { action: 'pass' });
});

test('classifyResponsesModelDowngrade retries non-mini requests downgraded to gpt-5.4-mini', () => {
  assert.deepEqual(classifyResponsesModelDowngrade({
    requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.4-mini',
  }), {
    action: 'retry',
    reason: 'responses_model_downgraded',
    retryKey: 'gpt-5.5->gpt-5.4-mini',
    retrySource: 'model',
    requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.4-mini',
  });

  assert.equal(classifyResponsesModelDowngrade({
    requestedModel: 'gpt-5.4-mini',
    responseModel: 'gpt-5.4-mini',
  }), null);

  assert.equal(classifyResponsesModelDowngrade({
    requestedModel: 'gpt-5.4-mini',
    responseModel: 'gpt-5.4-mini-2026-03-17',
  }), null);

  assert.deepEqual(classifyResponsesModelDowngrade({
    requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.4-mini-2026-03-17',
  }), {
    action: 'retry',
    reason: 'responses_model_downgraded',
    retryKey: 'gpt-5.5->gpt-5.4-mini-2026-03-17',
    retrySource: 'model',
    requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.4-mini-2026-03-17',
  });

  assert.deepEqual(classifyResponsesModelDowngrade({
    requestedModel: 'gpt-5.4',
    responseModel: 'gpt-5.4-mini',
  }), {
    action: 'retry',
    reason: 'responses_model_downgraded',
    retryKey: 'gpt-5.4->gpt-5.4-mini',
    retrySource: 'model',
    requestedModel: 'gpt-5.4',
    responseModel: 'gpt-5.4-mini',
  });
});

test('createResponsesEventStreamInspector retries downgraded response.created models', () => {
  const inspector = createResponsesEventStreamInspector({
    requestedModel: 'gpt-5.5',
  });

  const result = inspector.push(Buffer.from(
    'data: {"type":"response.created","response":{"id":"resp_123","model":"gpt-5.4-mini"}}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, {
    action: 'retry',
    reason: 'responses_model_downgraded',
    retryKey: 'gpt-5.5->gpt-5.4-mini',
    retrySource: 'model',
    requestedModel: 'gpt-5.5',
    responseModel: 'gpt-5.4-mini',
  });
});

test('shouldMarkResponsesFailoverUnavailable keeps model downgrades available', () => {
  assert.equal(shouldMarkResponsesFailoverUnavailable({
    reason: 'responses_model_downgraded',
  }), false);
  assert.equal(shouldMarkResponsesFailoverUnavailable({
    reason: 'responses_usage_limit_reached',
  }), true);
});

test('applyResponsesFailoverRequestHeaders forces identity encoding for responses requests', () => {
  const headers = applyResponsesFailoverRequestHeaders({
    'accept-encoding': 'gzip, br',
    accept: 'text/event-stream',
  }, '/backend-api/codex/responses');

  assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers.accept, 'text/event-stream');
});

test('applyResponsesFailoverRequestHeaders leaves non-responses requests unchanged', () => {
  const headers = applyResponsesFailoverRequestHeaders({
    'accept-encoding': 'gzip, br',
  }, '/backend-api/codex/models');

  assert.equal(headers['accept-encoding'], 'gzip, br');
});

test('isInspectableResponsesEventStream accepts gzip-encoded event streams', () => {
  assert.equal(isInspectableResponsesEventStream({
    'content-type': 'text/event-stream',
    'content-encoding': 'gzip',
  }), true);
});

test('drainAbandonedResponse attaches a temporary error listener and cleans up after close', async () => {
  const response = new PassThrough();
  response.complete = false;

  const drained = drainAbandonedResponse(response);
  assert.equal(response.listenerCount('error') > 0, true);

  response.end('done');
  await drained;

  assert.equal(response.listenerCount('error'), 0);
});
