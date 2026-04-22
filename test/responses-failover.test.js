const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

const {
  applyResponsesFailoverRequestHeaders,
  classifyRetryableResponsesHttpError,
  createResponsesEventStreamInspector,
  isInspectableResponsesEventStream,
  drainAbandonedResponse,
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

test('classifyRetryableResponsesHttpError ignores non-retryable payloads', () => {
  const result = classifyRetryableResponsesHttpError({
    statusCode: 503,
    bodyText: JSON.stringify({
      error: {
        code: 'server_is_overloaded',
      },
    }),
  });

  assert.equal(result, null);
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

test('createResponsesEventStreamInspector passes through on the first non-prelude event', () => {
  const inspector = createResponsesEventStreamInspector();

  const result = inspector.push(Buffer.from(
    'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
    'utf8',
  ));

  assert.deepEqual(result, { action: 'pass' });
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
