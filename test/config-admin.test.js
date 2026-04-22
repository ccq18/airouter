const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildConfigSnapshotRequest,
  buildHelloTestRequest,
  buildJsonRequestOptions,
  parseResponsesApiResponse,
  getPreferredApiKey,
  extractResponseSummary,
} = require('../public/config-admin.js');

test('buildConfigSnapshotRequest uses GET when only loading the latest snapshot', () => {
  assert.deepEqual(
    buildConfigSnapshotRequest(),
    {
      url: '/admin/api/configs',
      options: {},
    },
  );
});

test('buildConfigSnapshotRequest uses POST refresh endpoint when forcing a full quota refresh', () => {
  assert.deepEqual(
    buildConfigSnapshotRequest(true),
    {
      url: '/admin/api/configs/refresh',
      options: {
        method: 'POST',
      },
    },
  );
});

test('buildHelloTestRequest uses the configured Claude Code model and fixed hello input', () => {
  const requestBody = buildHelloTestRequest({
    claude_code: {
      model: 'gpt-5-mini',
    },
  });

  assert.deepEqual(requestBody, {
    model: 'gpt-5-mini',
    stream: true,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'hello',
          },
        ],
      },
    ],
  });
});

test('buildHelloTestRequest falls back to gpt-5.4 when no Claude Code model is configured', () => {
  assert.equal(buildHelloTestRequest({}).model, 'gpt-5.4');
});

test('getPreferredApiKey returns the first configured apikey', () => {
  assert.equal(getPreferredApiKey({
    apikeys: ['router-key', 'backup-key'],
  }), 'router-key');
});

test('extractResponseSummary prefers output_text when available', () => {
  assert.equal(extractResponseSummary({
    output_text: 'hello from upstream',
  }), 'hello from upstream');
});

test('extractResponseSummary falls back to nested output_text content', () => {
  assert.equal(extractResponseSummary({
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: 'nested hello',
          },
        ],
      },
    ],
  }), 'nested hello');
});

test('extractResponseSummary concatenates multiple nested output_text parts', () => {
  assert.equal(extractResponseSummary({
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: 'hello',
          },
          {
            type: 'output_text',
            text: ' world',
          },
        ],
      },
    ],
  }), 'hello world');
});

test('extractResponseSummary returns an empty string when no text is available', () => {
  assert.equal(
    extractResponseSummary({
      id: 'resp_123',
      status: 'completed',
    }),
    '',
  );
});

test('buildJsonRequestOptions preserves application/json when authorization header is added', () => {
  assert.deepEqual(
    buildJsonRequestOptions({
      method: 'POST',
      headers: {
        Authorization: 'Bearer router-key',
      },
      body: '{"hello":"world"}',
    }),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer router-key',
      },
      body: '{"hello":"world"}',
    },
  );
});

test('parseResponsesApiResponse returns the completed response from event-stream payloads', () => {
  const eventStreamText = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"hel"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}',
    '',
  ].join('\n');

  assert.deepEqual(
    parseResponsesApiResponse(eventStreamText, 'text/event-stream; charset=utf-8'),
    {
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'hello',
            },
          ],
        },
      ],
    },
  );
});

test('parseResponsesApiResponse keeps accumulated output_text when response.completed has an empty output array', () => {
  const eventStreamText = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_real","model":"gpt-5.4","output":[]}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hello","item_id":"msg_1","content_index":0}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"! How can I help?","item_id":"msg_1","content_index":0}',
    '',
    'event: response.output_text.done',
    'data: {"type":"response.output_text.done","text":"Hello! How can I help?","item_id":"msg_1","content_index":0}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_real","model":"gpt-5.4","status":"completed","output":[]}}',
    '',
  ].join('\n');

  assert.deepEqual(
    parseResponsesApiResponse(eventStreamText, 'text/event-stream; charset=utf-8'),
    {
      id: 'resp_real',
      model: 'gpt-5.4',
      status: 'completed',
      output: [],
      output_text: 'Hello! How can I help?',
    },
  );
});

test('parseResponsesApiResponse detects event-stream bodies even when the content-type header is missing', () => {
  const eventStreamText = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"!"}',
    '',
  ].join('\n');

  assert.deepEqual(
    parseResponsesApiResponse(eventStreamText, ''),
    {
      output_text: 'Hello!',
    },
  );
});
