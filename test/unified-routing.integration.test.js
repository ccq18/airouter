const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const ADMIN_TOKEN = 'admin-test-token';
const ENTRY_KEY = 'router-test-key';
const ENTRY_KEY_2 = 'router-test-key-2';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function sseChunk(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function createGlmFake(name) {
  const stats = {
    name,
    chatRequests: [],
    quotaRequests: 0,
    modelRequests: 0,
    streamingClosed: false,
    openStreams: 0,
    quota: { state: 'ok', percentage: 25, resetOffset: 3600000 },
    hangRequests: 0,
    hangClosed: 0,
    truncateJsonRequests: 0,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/quota') {
      stats.quotaRequests += 1;
      if (stats.quota.state === 'forbidden') {
        res.statusCode = 403;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'no quota permission' } }));
        return;
      }
      if (stats.quota.state === 'malformed') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end('not-json');
        return;
      }
      if (stats.quota.state === 'error') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'quota backend down' } }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        code: 200,
        success: true,
        data: {
          limits: [{
            type: 'TOKENS_LIMIT',
            percentage: stats.quota.percentage,
            nextResetTime: Date.now() + stats.quota.resetOffset,
          }],
        },
      }));
      return;
    }

    if (url.pathname.endsWith('/models')) {
      stats.modelRequests += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        object: 'list',
        data: [
          { id: 'glm-5.3' },
          { id: 'glm-4.7' },
          { id: 'glm-new' },
        ],
      }));
      return;
    }

    if (url.pathname.endsWith('/chat/completions')) {
      const body = await readJsonBody(req);
      stats.chatRequests.push({ path: url.pathname, body, headers: req.headers });
      const model = body.model;

      if (model === 'sse-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.write(sseChunk({
          id: `chatcmpl-${name}-sse`,
          model: 'sse-backend',
          choices: [{ index: 0, delta: { content: `${name}-part` } }],
        }));
        setTimeout(() => {
          stats.streamingClosed = true;
          res.destroy();
        }, 20);
        return;
      }

      if (model === 'cancel-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        stats.openStreams += 1;
        res.write(sseChunk({
          id: `chatcmpl-${name}-cancel`,
          model: 'cancel-backend',
          choices: [{ index: 0, delta: { content: `${name}-cancel-first` } }],
        }));
        res.on('close', () => {
          stats.openStreams -= 1;
          stats.streamingClosed = true;
        });
        return;
      }

      if (model === 'fail-backend') {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: `${name} failed` } }));
        return;
      }

      if (model === 'rate-backend') {
        res.statusCode = 429;
        res.setHeader('content-type', 'application/json');
        res.setHeader('retry-after', '30');
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_exceeded' } }));
        return;
      }

      if (model === 'hang-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        stats.hangRequests += 1;
        res.on('close', () => {
          stats.hangClosed += 1;
        });
        return;
      }

      if (model === 'truncate-json-backend') {
        stats.truncateJsonRequests += 1;
        if (stats.truncateJsonRequests === 1) {
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json');
          res.setHeader('content-length', '5000');
          res.write('{"id":"truncated","model":"truncate-json-backend","choices":[');
          setTimeout(() => res.destroy(), 20);
          return;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: 'chatcmpl-g-recovered',
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: `from-${name}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }));
        return;
      }

      if (name === 'A' && model === 'inflight-backend') {
        res.statusCode = 402;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          error: {
            message: 'in-flight budget exceeded',
            code: 'budget_exceeded',
            metadata: { limit_source: 'openrouter_in_flight_budget' },
          },
        }));
        return;
      }

      if (name === 'A' && model === 'badrequest-backend') {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'invalid arguments', type: 'invalid_request_error' } }));
        return;
      }

      if (name === 'A' && model === 'json-error-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_exceeded' } }));
        return;
      }

      if (name === 'A' && model === 'sse-error-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ error: { message: 'rate limited before output', type: 'rate_limit_exceeded' } })}\n\n`);
        return;
      }

      if (name === 'A' && model === 'sse-policy-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.end(`data: ${JSON.stringify({ error: { message: 'policy blocked', type: 'content_policy_violation' } })}\n\n`);
        return;
      }

      if (name === 'A' && model === 'sse-mid-error-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.write(sseChunk({
          id: `chatcmpl-${name}-mid`,
          model,
          choices: [{ index: 0, delta: { content: `${name}-partial` } }],
        }));
        res.end(`data: ${JSON.stringify({ error: { message: 'upstream failed mid-stream', type: 'upstream_error' } })}\n\n`);
        return;
      }

      if (model === 'tool-backend') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          id: `chatcmpl-${name}-tool`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_tool_1',
                type: 'function',
                function: { name: 'lookup', arguments: '{"id":7}' },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }));
        return;
      }

      if (body.stream === true) {
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.write(sseChunk({
          id: `chatcmpl-${name}-stream`,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content: `from-${name}` } }],
        }));
        res.write(sseChunk({
          id: `chatcmpl-${name}-stream`,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        }));
        res.end('data: [DONE]\n\n');
        return;
      }

      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        id: `chatcmpl-${name}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `from-${name}` },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: `unexpected path ${url.pathname}` } }));
  });

  return { server, stats };
}

function createTokenFake() {
  const stats = {
    responseRequests: [],
    quotaRequests: 0,
    streamingClosed: false,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/backend-api/wham/usage') {
      stats.quotaRequests += 1;
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        rate_limit: { primary_window: { used_percent: 10, reset_at: Math.floor(Date.now() / 1000) + 3600 } },
      }));
      return;
    }

    if (url.pathname.endsWith('/responses')) {
      const body = await readJsonBody(req);
      stats.responseRequests.push({ path: url.pathname, body });
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      if (body.model === 'incomplete-backend' || body.model === 'incomplete-only-backend') {
        res.write(sseChunk({
          type: 'response.created',
          response: { id: 'resp_incomplete_1', model: 'incomplete-backend', status: 'in_progress' },
        }));
        res.write(sseChunk({
          type: 'response.output_text.delta',
          item_id: 'msg_incomplete_1',
          output_index: 0,
          content_index: 0,
          delta: 'token-partial',
        }));
        res.end();
        return;
      }
      res.write(sseChunk({
        type: 'response.created',
        response: { id: 'resp_token_1', model: 'gpt-backend', status: 'in_progress' },
      }));
      res.write(sseChunk({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'msg_token_1', type: 'message', role: 'assistant', content: [] },
      }));
      res.write(sseChunk({
        type: 'response.output_text.delta',
        item_id: 'msg_token_1',
        output_index: 0,
        content_index: 0,
        delta: 'from-token',
      }));
      res.write(sseChunk({
        type: 'response.completed',
        response: {
          id: 'resp_token_1',
          model: 'gpt-backend',
          status: 'completed',
          output: [{
            id: 'msg_token_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'from-token' }],
          }],
          usage: { input_tokens: 2, output_tokens: 2 },
        },
      }));
      res.end();
      return;
    }

    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { message: `unexpected path ${url.pathname}` } }));
  });

  return { server, stats };
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: { authorization: `Bearer ${ENTRY_KEY}` },
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`health HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw lastError || new Error('health check timeout');
}

function buildConfig(upstreams, tokenBaseUrl) {
  const configs = [
    {
      id: 'cfg-a',
      type: 'apikey',
      preset: 'glm-cn',
      description: 'A GLM',
      base_url: upstreams.a.baseUrl,
      apikey: 'sk-fake-a',
      quota_url: `${upstreams.a.baseUrl}/quota`,
      models: [
        { id: 'glm-5.3', protocols: ['chat_completions'] },
        { id: 'glm-4.7', protocols: ['chat_completions'] },
        { id: 'sse-backend', protocols: ['chat_completions'] },
        { id: 'cancel-backend', protocols: ['chat_completions'] },
        { id: 'tool-backend', protocols: ['chat_completions'] },
        { id: 'inflight-backend', protocols: ['chat_completions'] },
        { id: 'badrequest-backend', protocols: ['chat_completions'] },
        { id: 'json-error-backend', protocols: ['chat_completions'] },
        { id: 'sse-error-backend', protocols: ['chat_completions'] },
        { id: 'sse-mid-error-backend', protocols: ['chat_completions'] },
        { id: 'sse-policy-backend', protocols: ['chat_completions'] },
      ],
    },
    {
      id: 'cfg-b',
      type: 'apikey',
      preset: 'glm-cn',
      description: 'B GLM',
      base_url: upstreams.b.baseUrl,
      apikey: 'sk-fake-b',
      quota_url: `${upstreams.b.baseUrl}/quota`,
      models: [
        { id: 'glm-5.3', protocols: ['chat_completions'] },
        { id: 'sse-backend', protocols: ['chat_completions'] },
        { id: 'cancel-backend', protocols: ['chat_completions'] },
        { id: 'tool-backend', protocols: ['chat_completions'] },
        { id: 'inflight-backend', protocols: ['chat_completions'] },
        { id: 'json-error-backend', protocols: ['chat_completions'] },
        { id: 'sse-error-backend', protocols: ['chat_completions'] },
        { id: 'sse-mid-error-backend', protocols: ['chat_completions'] },
        { id: 'sse-policy-backend', protocols: ['chat_completions'] },
      ],
    },
    {
      id: 'cfg-token',
      type: 'token',
      preset: 'chatgpt',
      description: 'Token C',
      base_url: tokenBaseUrl,
      access_token: 'token-fake-c',
      account_id: 'account-fake-c',
      quota_url: `${tokenBaseUrl}/backend-api/wham/usage`,
      models: [
        { id: 'gpt-backend', protocols: ['responses'] },
        { id: 'gpt-backend-2', protocols: ['responses'] },
        { id: 'incomplete-backend', protocols: ['responses'] },
        { id: 'incomplete-only-backend', protocols: ['responses'] },
      ],
    },
    {
      id: 'cfg-d',
      type: 'apikey',
      preset: 'glm-cn',
      description: 'D fail',
      base_url: upstreams.d.baseUrl,
      apikey: 'sk-fake-d',
      quota_url: `${upstreams.d.baseUrl}/quota`,
      models: [
        { id: 'fail-backend', protocols: ['chat_completions'] },
        { id: 'rate-backend', protocols: ['chat_completions'] },
      ],
    },
    {
      id: 'cfg-e',
      type: 'apikey',
      preset: 'glm-cn',
      description: 'E fail',
      base_url: upstreams.e.baseUrl,
      apikey: 'sk-fake-e',
      quota_url: `${upstreams.e.baseUrl}/quota`,
      models: [
        { id: 'fail-backend', protocols: ['chat_completions'] },
        { id: 'hang-backend', protocols: ['chat_completions'] },
      ],
    },
    {
      id: 'cfg-f',
      type: 'apikey',
      preset: 'glm-cn',
      description: 'F never called',
      base_url: upstreams.f.baseUrl,
      apikey: 'sk-fake-f',
      quota_url: `${upstreams.f.baseUrl}/quota`,
      models: [{ id: 'fail-backend', protocols: ['chat_completions'] }],
    },
    {
      id: 'cfg-g',
      type: 'apikey',
      preset: 'glm-cn',
      description: 'G hang/truncate',
      base_url: upstreams.g.baseUrl,
      apikey: 'sk-fake-g',
      quota_url: `${upstreams.g.baseUrl}/quota`,
      models: [
        { id: 'hang-backend', protocols: ['chat_completions'] },
        { id: 'truncate-json-backend', protocols: ['chat_completions'] },
        { id: 'glm-5.3', protocols: ['chat_completions'] },
      ],
    },
  ];

  return {
    auth_token: ADMIN_TOKEN,
    apikeys: [ENTRY_KEY, ENTRY_KEY_2],
    port: 0,
    configs,
    routing: {
      max_attempts: 2,
      models: [
        {
          id: 'DeepSeek-Custom',
          entry_protocols: ['chat_completions', 'responses', 'messages'],
          targets: [
            { id: 't-a', config_id: 'cfg-a', model: 'glm-5.3', protocol: 'chat_completions' },
            { id: 't-b', config_id: 'cfg-b', model: 'glm-5.3', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'discovery-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-new', config_id: 'cfg-a', model: 'glm-5.3', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'sse-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-sse', config_id: 'cfg-a', model: 'sse-backend', protocol: 'chat_completions' },
            { id: 't-b-sse', config_id: 'cfg-b', model: 'sse-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'cancel-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-cancel', config_id: 'cfg-a', model: 'cancel-backend', protocol: 'chat_completions' },
            { id: 't-b-cancel', config_id: 'cfg-b', model: 'cancel-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'fair-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-token', config_id: 'cfg-token', model: 'gpt-backend', protocol: 'responses' },
            { id: 't-b-fair', config_id: 'cfg-b', model: 'glm-5.3', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'Responses-Public',
          entry_protocols: ['chat_completions', 'responses', 'messages'],
          targets: [
            { id: 't-token-responses', config_id: 'cfg-token', model: 'gpt-backend', protocol: 'responses' },
            { id: 't-b-responses', config_id: 'cfg-b', model: 'glm-5.3', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'tool-model',
          entry_protocols: ['chat_completions', 'responses', 'messages'],
          targets: [
            { id: 't-a-tool', config_id: 'cfg-a', model: 'tool-backend', protocol: 'chat_completions' },
            { id: 't-b-tool', config_id: 'cfg-b', model: 'tool-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'inflight-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-inflight', config_id: 'cfg-a', model: 'inflight-backend', protocol: 'chat_completions' },
            { id: 't-b-inflight', config_id: 'cfg-b', model: 'inflight-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'badrequest-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-bad', config_id: 'cfg-a', model: 'badrequest-backend', protocol: 'chat_completions' },
            { id: 't-b-bad', config_id: 'cfg-b', model: 'glm-5.3', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'json-error-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-jsonerror', config_id: 'cfg-a', model: 'json-error-backend', protocol: 'chat_completions' },
            { id: 't-b-jsonerror', config_id: 'cfg-b', model: 'json-error-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'sse-error-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-sseerror', config_id: 'cfg-a', model: 'sse-error-backend', protocol: 'chat_completions' },
            { id: 't-b-sseerror', config_id: 'cfg-b', model: 'sse-error-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'sse-mid-error-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-ssemid', config_id: 'cfg-a', model: 'sse-mid-error-backend', protocol: 'chat_completions' },
            { id: 't-b-ssemid', config_id: 'cfg-b', model: 'sse-mid-error-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'sse-policy-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-a-ssepolicy', config_id: 'cfg-a', model: 'sse-policy-backend', protocol: 'chat_completions' },
            { id: 't-b-ssepolicy', config_id: 'cfg-b', model: 'sse-policy-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'incomplete-model',
          entry_protocols: ['responses'],
          targets: [
            { id: 't-token-incomplete', config_id: 'cfg-token', model: 'incomplete-backend', protocol: 'responses' },
            { id: 't-b-incomplete', config_id: 'cfg-b', model: 'glm-5.3', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'abort-after-fail-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-d-rate', config_id: 'cfg-d', model: 'rate-backend', protocol: 'chat_completions' },
            { id: 't-e-hang', config_id: 'cfg-e', model: 'hang-backend', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'cleanup-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-g-truncate', config_id: 'cfg-g', model: 'truncate-json-backend', protocol: 'chat_completions' },
            { id: 't-b-cleanup', config_id: 'cfg-b', model: 'glm-5.3', protocol: 'chat_completions' },
          ],
        },
        {
          id: 'incomplete-only-model',
          entry_protocols: ['responses'],
          targets: [
            { id: 't-token-incomplete-only', config_id: 'cfg-token', model: 'incomplete-only-backend', protocol: 'responses' },
          ],
        },
        {
          id: 'retry-model',
          entry_protocols: ['chat_completions'],
          targets: [
            { id: 't-d', config_id: 'cfg-d', model: 'fail-backend', protocol: 'chat_completions' },
            { id: 't-e', config_id: 'cfg-e', model: 'fail-backend', protocol: 'chat_completions' },
            { id: 't-f', config_id: 'cfg-f', model: 'fail-backend', protocol: 'chat_completions' },
          ],
        },
      ],
    },
  };
}

let tempDir;
let configPath;
let child;
let baseUrl;
let fakeA;
let fakeB;
let fakeD;
let fakeE;
let fakeF;
let fakeG;
let tokenFake;
let childLog = '';

async function adminFetch(pathname, options = {}) {
  const url = new URL(`${baseUrl}${pathname}`);
  url.searchParams.set('auth_token', ADMIN_TOKEN);
  const response = await fetch(url.toString(), {
    ...options,
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    payload = { raw: text };
  }
  return { status: response.status, payload, text };
}

async function entryFetch(pathname, body, extraHeaders = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ENTRY_KEY}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

async function getRoutes() {
  const response = await adminFetch('/admin/api/model-routes');
  assert.equal(response.status, 200);
  return response.payload;
}

async function saveRoutes(models, maxAttempts = 2) {
  const current = await getRoutes();
  const response = await adminFetch('/admin/api/model-routes', {
    method: 'PUT',
    body: JSON.stringify({
      revision: current.revision,
      models,
      max_attempts: maxAttempts,
    }),
  });
  assert.equal(response.status, 200, response.text);
  return response.payload;
}

async function updateRoute(routeId, updater) {
  const current = await getRoutes();
  const models = JSON.parse(JSON.stringify(current.models));
  const route = models.find(item => item.id === routeId);
  assert.ok(route, `route ${routeId} exists`);
  updater(route);
  return saveRoutes(models, current.max_attempts);
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-routing-'));
  configPath = path.join(tempDir, 'config.json');

  fakeA = createGlmFake('A');
  fakeB = createGlmFake('B');
  fakeD = createGlmFake('D');
  fakeE = createGlmFake('E');
  fakeF = createGlmFake('F');
  fakeG = createGlmFake('G');
  tokenFake = createTokenFake();

  const [portA, portB, portD, portE, portF, portG, tokenPort, servicePort] = await Promise.all([
    listen(fakeA.server),
    listen(fakeB.server),
    listen(fakeD.server),
    listen(fakeE.server),
    listen(fakeF.server),
    listen(fakeG.server),
    listen(tokenFake.server),
    getFreePort(),
  ]);

  const upstreams = {
    a: { baseUrl: `http://127.0.0.1:${portA}` },
    b: { baseUrl: `http://127.0.0.1:${portB}` },
    d: { baseUrl: `http://127.0.0.1:${portD}` },
    e: { baseUrl: `http://127.0.0.1:${portE}` },
    f: { baseUrl: `http://127.0.0.1:${portF}` },
    g: { baseUrl: `http://127.0.0.1:${portG}` },
  };
  const tokenBaseUrl = `http://127.0.0.1:${tokenPort}`;
  const config = buildConfig(upstreams, tokenBaseUrl);
  config.port = servicePort;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  baseUrl = `http://127.0.0.1:${servicePort}`;
  child = spawn(process.execPath, [path.join(REPO_ROOT, 'openai.js')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(servicePort),
      CONFIG: configPath,
      ACCESS_LOG: '0',
      UPSTREAM_REQUEST_TIMEOUT_MS: '10000',
      QUOTA_CHECK_TIMEOUT_MS: '3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => {
    childLog += chunk.toString('utf8');
  });
  child.stderr.on('data', chunk => {
    childLog += chunk.toString('utf8');
  });

  await waitForHealth(baseUrl);
});

test.after(async () => {
  if (child && !child.killed) {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  await Promise.all([
    closeServer(fakeA.server),
    closeServer(fakeB.server),
    closeServer(fakeD.server),
    closeServer(fakeE.server),
    closeServer(fakeF.server),
    closeServer(fakeG.server),
    closeServer(tokenFake.server),
  ]);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('service exposes public model IDs and protects entry/admin APIs', async () => {
  const unauthorizedModels = await fetch(`${baseUrl}/v1/models`);
  assert.equal(unauthorizedModels.status, 401);

  const unauthorizedAdmin = await fetch(`${baseUrl}/admin/api/upstreams`);
  assert.equal(unauthorizedAdmin.status, 401);

  const models = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${ENTRY_KEY}` },
  });
  assert.equal(models.status, 200);
  const payload = await models.json();
  assert.ok(payload.data.some(model => model.id === 'DeepSeek-Custom'));
  assert.ok(!payload.data.some(model => model.id === 'glm-5.3'));

  const routesPage = await fetch(`${baseUrl}/admin/configs/routes?auth_token=${ADMIN_TOKEN}`);
  assert.equal(routesPage.status, 200);
  const routesHtml = await routesPage.text();
  assert.match(routesHtml, /data-page-link="upstreams"/);
  assert.match(routesHtml, /data-page-link="routes"/);
  assert.match(routesHtml, /\/config-admin-routing\.js/);
  assert.match(routesHtml, /id="routeTargetsEditor"/);

  const routingScript = await fetch(`${baseUrl}/config-admin-routing.js`);
  assert.equal(routingScript.status, 200);
  assert.match(await routingScript.text(), /createRoutingAdmin/);

  const routeStatus = await getRoutes();
  assert.equal(Object.hasOwn(routeStatus, 'mode'), false);
  assert.equal(routeStatus.models[0].id, 'DeepSeek-Custom');
  assert.equal(routeStatus.route_status['DeepSeek-Custom'].chat_completions.targets[0].selected, true);
});

test('arbitrary case-sensitive public model maps to account+backend model and response model stays public', async () => {
  const before = fakeA.stats.chatRequests.length;
  const response = await entryFetch('/v1/chat/completions', {
    model: 'DeepSeek-Custom',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.model, 'DeepSeek-Custom');
  assert.equal(payload.choices[0].message.content, 'from-A');

  assert.equal(fakeA.stats.chatRequests.length, before + 1);
  const upstream = fakeA.stats.chatRequests[fakeA.stats.chatRequests.length - 1];
  assert.equal(upstream.body.model, 'glm-5.3');

  const missing = await entryFetch('/v1/chat/completions', {
    model: 'deepseek-custom',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.equal(missing.status, 404);
  const missingPayload = await missing.json();
  assert.equal(missingPayload.error.code, 'model_not_found');
});

test('Messages and Responses entries bridge text, tools and SSE to Chat or Responses targets', async () => {
  let response = await entryFetch('/v1/messages', {
    model: 'DeepSeek-Custom',
    max_tokens: 128,
    messages: [{ role: 'user', content: 'hello messages' }],
  });
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.type, 'message');
  assert.equal(payload.model, 'DeepSeek-Custom');
  assert.equal(payload.content[0].text, 'from-A');

  response = await entryFetch('/v1/responses', {
    model: 'DeepSeek-Custom',
    input: 'hello responses',
    stream: false,
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.object, 'response');
  assert.equal(payload.model, 'DeepSeek-Custom');
  assert.equal(payload.output_text, 'from-A');

  const beforeToken = tokenFake.stats.responseRequests.length;
  response = await entryFetch('/v1/responses', {
    model: 'Responses-Public',
    input: 'hello token responses',
    stream: false,
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.model, 'Responses-Public');
  assert.equal(payload.output_text, 'from-token');
  assert.equal(tokenFake.stats.responseRequests.length, beforeToken + 1);
  assert.equal(tokenFake.stats.responseRequests[beforeToken].body.model, 'gpt-backend');

  const beforeA = fakeA.stats.chatRequests.length;
  const streamResponse = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ENTRY_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'DeepSeek-Custom',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'stream messages' }],
    }),
  });
  assert.equal(streamResponse.status, 200);
  const streamText = await streamResponse.text();
  assert.match(streamText, /event: message_start/);
  assert.match(streamText, /from-A/);
  assert.match(streamText, /event: message_stop/);
  assert.equal(fakeA.stats.chatRequests.length, beforeA + 1);
  assert.equal(fakeA.stats.chatRequests[beforeA].body.model, 'glm-5.3');

  response = await entryFetch('/v1/chat/completions', {
    model: 'tool-model',
    messages: [{ role: 'user', content: 'call a tool' }],
    tools: [{
      type: 'function',
      function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
    }],
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.choices[0].finish_reason, 'tool_calls');
  assert.equal(payload.choices[0].message.tool_calls[0].id, 'call_tool_1');

  const beforeToolRoundTrip = fakeA.stats.chatRequests.length;
  response = await entryFetch('/v1/messages', {
    model: 'DeepSeek-Custom',
    max_tokens: 128,
    messages: [
      { role: 'user', content: 'lookup please' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 1 } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'result text' }],
      },
    ],
    tools: [{ name: 'lookup', input_schema: { type: 'object', properties: {} } }],
  });
  assert.equal(response.status, 200);
  const bridgeRequest = fakeA.stats.chatRequests[beforeToolRoundTrip].body;
  assert.ok(bridgeRequest.messages.some(message => message.role === 'tool' && message.tool_call_id === 'toolu_1'));
  assert.ok(Array.isArray(bridgeRequest.tools));
});

test('previous_response_id stays on its original candidate and never migrates across protocols', async () => {
  let response = await entryFetch('/v1/responses', {
    model: 'Responses-Public',
    input: 'first context request',
    stream: false,
  });
  assert.equal(response.status, 200);
  const bound = await response.json();
  assert.match(bound.id, /^resp_/);

  const beforeToken = tokenFake.stats.responseRequests.length;
  response = await entryFetch('/v1/responses', {
    model: 'Responses-Public',
    input: 'continue',
    previous_response_id: bound.id,
    stream: false,
  });
  assert.equal(response.status, 200);
  const continued = await response.json();
  assert.equal(continued.model, 'Responses-Public');
  assert.equal(tokenFake.stats.responseRequests.length, beforeToken + 1);

  response = await entryFetch('/v1/responses', {
    model: 'Responses-Public',
    input: 'other local key',
    previous_response_id: bound.id,
    stream: false,
  }, {
    authorization: `Bearer ${ENTRY_KEY_2}`,
  });
  assert.equal(response.status, 409);
  const otherKey = await response.json();
  assert.equal(otherKey.error.code, 'upstream_context_unavailable');

  response = await entryFetch('/v1/responses', {
    model: 'Responses-Public',
    input: 'unknown context',
    previous_response_id: 'resp_unknown_context',
    stream: false,
  });
  assert.equal(response.status, 409);
  const missing = await response.json();
  assert.equal(missing.error.code, 'upstream_context_unavailable');

  const routeModels = (await getRoutes()).models;
  const responsesRoute = routeModels.find(route => route.id === 'Responses-Public');
  responsesRoute.targets[0].model = 'gpt-backend-2';
  await saveRoutes(routeModels, 2);
  response = await entryFetch('/v1/responses', {
    model: 'Responses-Public',
    input: 'model changed after binding',
    previous_response_id: bound.id,
    stream: false,
  });
  assert.equal(response.status, 409);
  const changedModel = await response.json();
  assert.equal(changedModel.error.code, 'upstream_context_unavailable');

  response = await entryFetch('/v1/responses', {
    model: 'DeepSeek-Custom',
    input: 'chat-bound context',
    stream: false,
  });
  assert.equal(response.status, 200);
  const chatBound = await response.json();
  response = await entryFetch('/v1/responses', {
    model: 'DeepSeek-Custom',
    input: 'cannot migrate',
    previous_response_id: chatBound.id,
    stream: false,
  });
  assert.equal(response.status, 409);
  const cannotMigrate = await response.json();
  assert.equal(cannotMigrate.error.code, 'upstream_context_unavailable');

  response = await entryFetch('/v1/responses', {
    model: 'DeepSeek-Custom',
    input: [{ type: 'reasoning', encrypted_content: 'opaque-encrypted-state' }],
    stream: false,
  });
  assert.equal(response.status, 409);
  const encryptedReasoning = await response.json();
  assert.equal(encryptedReasoning.error.code, 'upstream_context_unavailable');

  response = await entryFetch('/v1/responses', {
    model: 'DeepSeek-Custom',
    conversation: 'conv_remote_state',
    input: 'conversation state',
    stream: false,
  });
  assert.equal(response.status, 409);
  const conversationState = await response.json();
  assert.equal(conversationState.error.code, 'upstream_context_unavailable');
});

test('200 JSON errors and pre-output SSE errors fail over without empty success', async () => {
  const beforeBadB = fakeB.stats.chatRequests.length;
  let response = await entryFetch('/v1/chat/completions', {
    model: 'badrequest-model',
    messages: [{ role: 'user', content: 'bad request' }],
  });
  assert.equal(response.status, 400);
  assert.equal(fakeB.stats.chatRequests.length, beforeBadB);
  const beforeSecondBad = fakeA.stats.chatRequests.length;
  const secondBad = await entryFetch('/v1/chat/completions', {
    model: 'badrequest-model',
    messages: [{ role: 'user', content: 'bad request again' }],
  });
  assert.equal(secondBad.status, 400);
  assert.equal(fakeA.stats.chatRequests.length, beforeSecondBad + 1);

  response = await entryFetch('/v1/chat/completions', {
    model: 'json-error-model',
    messages: [{ role: 'user', content: 'json error' }],
  });
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.choices[0].message.content, 'from-B');

  const beforeSseB = fakeB.stats.chatRequests.length;
  response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ENTRY_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sse-error-model',
      stream: true,
      messages: [{ role: 'user', content: 'sse error' }],
    }),
  });
  assert.equal(response.status, 200);
  const sseText = await response.text();
  assert.match(sseText, /from-B/);
  assert.equal(fakeB.stats.chatRequests.length, beforeSseB + 1);

  const beforePolicyB = fakeB.stats.chatRequests.length;
  response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ENTRY_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sse-policy-model',
      stream: true,
      messages: [{ role: 'user', content: 'policy' }],
    }),
  });
  assert.equal(response.status, 400);
  assert.equal(fakeB.stats.chatRequests.length, beforePolicyB);

  const beforeMidB = fakeB.stats.chatRequests.length;
  response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ENTRY_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'sse-mid-error-model',
      stream: true,
      messages: [{ role: 'user', content: 'mid error' }],
    }),
  });
  assert.equal(response.status, 200);
  const midText = await response.text();
  assert.match(midText, /A-partial/);
  assert.doesNotMatch(midText, /from-B/);
  assert.equal(fakeB.stats.chatRequests.length, beforeMidB);
});

test('in-flight budget 402 is transient and does not mark account quota exhausted', async () => {
  const response = await entryFetch('/v1/chat/completions', {
    model: 'inflight-model',
    messages: [{ role: 'user', content: 'inflight budget' }],
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, 'from-B');

  const upstreams = await adminFetch('/admin/api/upstreams');
  const configA = upstreams.payload.configs.find(item => item.id === 'cfg-a');
  assert.notEqual(configA.quota.state, 'exhausted');
});

test('incomplete token SSE cannot serialize as an empty successful Responses result', async () => {
  const beforeToken = tokenFake.stats.responseRequests.length;
  const beforeB = fakeB.stats.chatRequests.length;
  const response = await entryFetch('/v1/responses', {
    model: 'incomplete-model',
    input: 'incomplete token stream',
    stream: false,
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.model, 'incomplete-model');
  assert.equal(payload.output_text, 'from-B');
  assert.equal(tokenFake.stats.responseRequests.length, beforeToken + 1);
  assert.equal(fakeB.stats.chatRequests.length, beforeB + 1);

  const onlyResponse = await entryFetch('/v1/responses', {
    model: 'incomplete-only-model',
    input: 'incomplete without fallback',
    stream: false,
  });
  assert.equal(onlyResponse.status, 502);
  const onlyPayload = await onlyResponse.json();
  assert.equal(onlyPayload.error.code, 'incomplete_upstream_stream');
});

test('client disconnect after a failed first attempt aborts the hanging fallback', async () => {
  const controller = new AbortController();
  const beforeHang = fakeE.stats.hangRequests;
  const beforeClosed = fakeE.stats.hangClosed;
  const requestPromise = fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ENTRY_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'abort-after-fail-model',
      stream: true,
      messages: [{ role: 'user', content: 'abort fallback' }],
    }),
    signal: controller.signal,
  }).catch(error => error);

  const startedAt = Date.now();
  while (fakeE.stats.hangRequests === beforeHang && Date.now() - startedAt < 3000) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(fakeE.stats.hangRequests, beforeHang + 1);
  controller.abort();
  await requestPromise;

  const closedAt = Date.now();
  while (fakeE.stats.hangClosed === beforeClosed && Date.now() - closedAt < 3000) {
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(fakeE.stats.hangClosed, beforeClosed + 1);
});

test('truncated non-stream response fails over before committing and cools the failed target', async () => {
  const beforeG = fakeG.stats.chatRequests.length;
  const beforeB = fakeB.stats.chatRequests.length;
  const first = await entryFetch('/v1/chat/completions', {
    model: 'cleanup-model',
    messages: [{ role: 'user', content: 'truncate once' }],
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).choices[0].message.content, 'from-B');
  assert.equal(fakeG.stats.chatRequests.length, beforeG + 1);

  const second = await entryFetch('/v1/chat/completions', {
    model: 'cleanup-model',
    messages: [{ role: 'user', content: 'cleanup probe retry' }],
  });
  assert.equal(second.status, 200);
  const payload = await second.json();
  assert.equal(payload.choices[0].message.content, 'from-B');
  assert.equal(fakeG.stats.chatRequests.length, beforeG + 1);
  assert.equal(fakeB.stats.chatRequests.length, beforeB + 2);
});

test('quota exhaustion switches to B, recovery automatically prefers A on the next request', async () => {
  fakeA.stats.quota.state = 'ok';
  fakeA.stats.quota.percentage = 100;
  fakeA.stats.quota.resetOffset = -1000;
  let refresh = await adminFetch('/admin/api/upstreams/cfg-a/quota-refresh', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(refresh.status, 200, refresh.text);
  assert.equal(refresh.payload.quota.state, 'exhausted', JSON.stringify(refresh.payload));

  const beforeB = fakeB.stats.chatRequests.length;
  let response = await entryFetch('/v1/chat/completions', {
    model: 'DeepSeek-Custom',
    messages: [{ role: 'user', content: 'use B' }],
  });
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.choices[0].message.content, 'from-B');
  assert.equal(fakeB.stats.chatRequests.length, beforeB + 1);

  fakeA.stats.quota.percentage = 20;
  const beforeA = fakeA.stats.chatRequests.length;
  response = await entryFetch('/v1/chat/completions', {
    model: 'DeepSeek-Custom',
    messages: [{ role: 'user', content: 'back to A' }],
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.choices[0].message.content, 'from-A');
  assert.equal(fakeA.stats.chatRequests.length, beforeA + 1);
});

test('forbidden, malformed, and failed quota reads stay unknown or keep known exhaustion', async () => {
  fakeA.stats.quota.state = 'forbidden';
  let refresh = await adminFetch('/admin/api/upstreams/cfg-a/quota-refresh', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(refresh.status, 200);
  assert.equal(refresh.payload.quota.state, 'unknown');
  assert.ok(refresh.payload.quota.error);

  const beforeA = fakeA.stats.chatRequests.length;
  let response = await entryFetch('/v1/chat/completions', {
    model: 'DeepSeek-Custom',
    messages: [{ role: 'user', content: 'unknown is probeable' }],
  });
  assert.equal(response.status, 200);
  assert.equal(fakeA.stats.chatRequests.length, beforeA + 1);

  fakeA.stats.quota.state = 'malformed';
  refresh = await adminFetch('/admin/api/upstreams/cfg-a/quota-refresh', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(refresh.payload.quota.state, 'unknown');
  assert.ok(refresh.payload.quota.error);

  fakeA.stats.quota.state = 'ok';
  fakeA.stats.quota.percentage = 100;
  refresh = await adminFetch('/admin/api/upstreams/cfg-a/quota-refresh', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(refresh.payload.quota.state, 'exhausted');

  fakeA.stats.quota.state = 'error';
  refresh = await adminFetch('/admin/api/upstreams/cfg-a/quota-refresh', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(refresh.payload.quota.state, 'exhausted');
  assert.ok(refresh.payload.quota.error);

  const beforeB = fakeB.stats.chatRequests.length;
  response = await entryFetch('/v1/chat/completions', {
    model: 'DeepSeek-Custom',
    messages: [{ role: 'user', content: 'keep B' }],
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, 'from-B');
  assert.equal(fakeB.stats.chatRequests.length, beforeB + 1);

  fakeA.stats.quota.state = 'ok';
  fakeA.stats.quota.percentage = 10;
  await adminFetch('/admin/api/upstreams/cfg-a/quota-refresh', {
    method: 'POST',
    body: '{}',
  });
});

test('model discovery returns a merge diff and referenced model deletion is rejected', async () => {
  const currentRoutes = await getRoutes();
  const stale = await adminFetch('/admin/api/model-routes', {
    method: 'PUT',
    body: JSON.stringify({
      revision: 'stale-revision',
      models: currentRoutes.models,
      max_attempts: 2,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.error.code, 'revision_conflict');

  const referencedUpstream = await adminFetch('/admin/api/upstreams/cfg-a', {
    method: 'DELETE',
  });
  assert.equal(referencedUpstream.status, 409);
  assert.equal(referencedUpstream.payload.error.code, 'upstream_referenced');

  const discovery = await adminFetch('/admin/api/upstreams/cfg-a/models/discover', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(discovery.status, 200, discovery.text);
  assert.ok(discovery.payload.added.some(model => model.id === 'glm-new'));
  assert.ok(discovery.payload.removed.includes('cancel-backend'));
  assert.ok(discovery.payload.suggested_models.some(model => model.id === 'glm-4.7'));

  const applied = await adminFetch('/admin/api/upstreams/cfg-a', {
    method: 'PUT',
    body: JSON.stringify({ models: discovery.payload.suggested_models }),
  });
  assert.equal(applied.status, 200, applied.text);
  const configA = applied.payload.configs.find(item => item.id === 'cfg-a');
  assert.ok(configA.models.some(model => model.id === 'glm-new'));

  const routeModels = (await getRoutes()).models;
  const discoveryRoute = routeModels.find(route => route.id === 'discovery-model');
  discoveryRoute.targets[0].model = 'glm-4.7';
  await saveRoutes(routeModels, 2);

  const before = fakeA.stats.chatRequests.length;
  const response = await entryFetch('/v1/chat/completions', {
    model: 'discovery-model',
    messages: [{ role: 'user', content: 'discovered route' }],
  });
  assert.equal(response.status, 200);
  assert.equal(fakeA.stats.chatRequests.length, before + 1);
  assert.equal(fakeA.stats.chatRequests[before].body.model, 'glm-4.7');

  const removeReferenced = await adminFetch('/admin/api/upstreams/cfg-a', {
    method: 'PUT',
    body: JSON.stringify({
      models: configA.models.filter(model => model.id !== 'glm-4.7'),
    }),
  });
  assert.equal(removeReferenced.status, 400);
  assert.equal(removeReferenced.payload.error.code, 'model_referenced');
});

test('token-backed and apikey targets are chosen by explicit route order', async () => {
  const beforeToken = tokenFake.stats.responseRequests.length;
  let response = await entryFetch('/v1/chat/completions', {
    model: 'fair-model',
    messages: [{ role: 'user', content: 'token first' }],
  });
  assert.equal(response.status, 200);
  let payload = await response.json();
  assert.equal(payload.model, 'fair-model');
  assert.equal(payload.choices[0].message.content, 'from-token');
  assert.equal(tokenFake.stats.responseRequests.length, beforeToken + 1);

  await updateRoute('fair-model', route => {
    route.targets.reverse();
  });
  const beforeB = fakeB.stats.chatRequests.length;
  response = await entryFetch('/v1/chat/completions', {
    model: 'fair-model',
    messages: [{ role: 'user', content: 'apikey first' }],
  });
  assert.equal(response.status, 200);
  payload = await response.json();
  assert.equal(payload.choices[0].message.content, 'from-B');
  assert.equal(fakeB.stats.chatRequests.length, beforeB + 1);
});

test('streaming upstream failure after commit never splices a fallback answer', async () => {
  const beforeB = fakeB.stats.chatRequests.length;
  const response = await entryFetch('/v1/chat/completions', {
    model: 'sse-model',
    stream: true,
    messages: [{ role: 'user', content: 'stream' }],
  });
  assert.equal(response.status, 200);
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    text = '';
  }

  assert.match(text, /A-part/);
  assert.doesNotMatch(text, /B-part/);
  assert.equal(fakeB.stats.chatRequests.length, beforeB);
});

test('client cancellation aborts the active upstream and does not start a fallback', async () => {
  const controller = new AbortController();
  const beforeB = fakeB.stats.chatRequests.length;
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ENTRY_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'cancel-model',
      stream: true,
      messages: [{ role: 'user', content: 'cancel' }],
    }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  controller.abort();
  try {
    await reader.cancel();
  } catch (error) {
    // expected
  }

  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fakeB.stats.chatRequests.length, beforeB);
  assert.equal(fakeA.stats.openStreams, 0);
});

test('bounded retries stop after max attempts and do not try lower candidates', async () => {
  const beforeD = fakeD.stats.chatRequests.length;
  const beforeE = fakeE.stats.chatRequests.length;
  const beforeF = fakeF.stats.chatRequests.length;
  const response = await entryFetch('/v1/chat/completions', {
    model: 'retry-model',
    messages: [{ role: 'user', content: 'retry' }],
  });
  assert.equal(response.status, 500);
  assert.equal(fakeD.stats.chatRequests.length, beforeD + 1);
  assert.equal(fakeE.stats.chatRequests.length, beforeE + 1);
  assert.equal(fakeF.stats.chatRequests.length, beforeF);

  const attemptD = fakeD.stats.chatRequests[beforeD];
  const attemptE = fakeE.stats.chatRequests[beforeE];
  assert.match(attemptD.headers['user-agent'], /airouter/i);
  assert.ok(attemptD.headers['x-opencode-session']);
  assert.equal(attemptD.headers['x-opencode-session'], attemptE.headers['x-opencode-session']);
  assert.equal(attemptD.headers.authorization, 'Bearer sk-fake-d');
  assert.equal(attemptE.headers['x-api-key'], undefined);
});

test('admin responses never echo upstream credentials', async () => {
  const upstreams = await adminFetch('/admin/api/upstreams');
  const routes = await adminFetch('/admin/api/model-routes');
  const combined = `${upstreams.text}\n${routes.text}`;
  assert.doesNotMatch(combined, /sk-fake-a/);
  assert.doesNotMatch(combined, /token-fake-c/);
  assert.doesNotMatch(combined, /account-fake-c/);
  assert.match(combined, /glm-5\.3/);
});


test('unsaved upstream can discover models without persisting credentials or draft changes', async () => {
  const before = fs.readFileSync(configPath, 'utf8');
  const response = await adminFetch('/admin/api/upstreams/models/discover', {
    method: 'POST', body: JSON.stringify({ preset: 'glm-cn', base_url: `http://127.0.0.1:${fakeA.server.address().port}`, apikey: 'sk-draft-fixture', models: [] }),
  });
  assert.equal(response.status, 200);
  const payload = response.payload;
  assert.ok(payload.discovered.some(model => model.id === 'glm-5.3'));
  assert.equal(fs.readFileSync(configPath, 'utf8'), before);
  assert.equal(JSON.stringify(payload).includes('sk-draft-fixture'), false);
});


test('empty routes never fall back to token accounts or unlisted models', async () => {
  const original = await getRoutes();
  const before = [fakeA.stats.chatRequests.length, fakeB.stats.chatRequests.length, tokenFake.stats.responseRequests.length];
  try {
    await saveRoutes([]);
    const listing = await fetch(`${baseUrl}/v1/models`, { headers: { authorization: `Bearer ${ENTRY_KEY}` } });
    assert.deepEqual((await listing.json()).data, []);
    const response = await entryFetch('/v1/chat/completions', { model: 'gpt-backend', messages: [{ role: 'user', content: 'must not dispatch' }] });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'model_not_found');
    assert.deepEqual([fakeA.stats.chatRequests.length, fakeB.stats.chatRequests.length, tokenFake.stats.responseRequests.length], before);
  } finally { await saveRoutes(original.models, original.max_attempts); }
});

test('removed legacy endpoints cannot reach an upstream', async () => {
  for (const route of ['/cpa/v1/messages', '/wham/usage', '/v1/arbitrary', '/v1/images/generations']) {
    const response = await entryFetch(route, { model: 'DeepSeek-Custom', messages: [] });
    assert.equal(response.status, 404, route);
  }
  for (const route of ['/admin/api/configs', '/admin/api/disabled-configs', '/admin/configs/fallbacks']) {
    const response = await adminFetch(route);
    assert.equal(response.status, 404, route);
  }
});

test('settings and credential import use dedicated APIs without exposing upstream secrets', async () => {
  const settings = await adminFetch('/admin/api/settings');
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.payload.apikeys, [ENTRY_KEY, ENTRY_KEY_2]);
  const before = (await adminFetch('/admin/api/upstreams')).payload.configs.length;
  const imported = await adminFetch('/admin/api/upstreams/import', { method: 'POST', body: JSON.stringify({ raw_json: JSON.stringify({ accessToken: 'import-token-fixture', account: { id: 'import-account-fixture' } }) }) });
  assert.equal(imported.status, 201, imported.text);
  assert.equal(imported.payload.added_ids.length, 1);
  assert.equal(imported.payload.configs.length, before + 1);
  assert.equal(imported.text.includes('import-token-fixture'), false);
  const removed = await adminFetch('/admin/api/upstreams/'+imported.payload.added_ids[0], { method: 'DELETE' });
  assert.equal(removed.status, 200);
});
