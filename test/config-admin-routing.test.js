const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');
const routingJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin-routing.js'), 'utf8');
const adminJs = require('../public/config-admin.js');
const routingAdmin = require('../public/config-admin-routing.js');

function between(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `missing start marker: ${startNeedle}`);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

test('routing UI exposes exactly two tabs and no quota template or credential selectors', () => {
  const tabLinks = [...html.matchAll(/<a href="\/admin\/configs\/([^"]+)" data-page-link="([^"]+)">([^<]+)/g)]
    .map(match => ({ href: match[1], page: match[2], label: match[3].replace(/<[^>]*>/g, '').trim() }));

  assert.deepEqual(tabLinks, [
    { href: 'upstreams', page: 'upstreams', label: '上游账号' },
    { href: 'routes', page: 'routes', label: '模型路由' },
  ]);
  assert.doesNotMatch(html, /额度模板/);
  assert.doesNotMatch(html, /quota[_-]?(template|credential)/i);
  assert.doesNotMatch(html, /额度查询凭证/);
});

test('accounts and routes start as list-only views with editors and settings closed', () => {
  assert.match(html, /<section class="admin-page" data-view="accounts"/);
  assert.match(html, /<section class="admin-page" data-view="routes"[^>]*hidden/);
  assert.match(html, /<div class="dialog-layer" id="accountDialog" hidden>/);
  assert.match(html, /<div class="dialog-layer" id="routeDialog" hidden>/);
  assert.match(html, /<div class="drawer-layer" id="settingsDrawer" hidden>/);
  assert.match(html, /<div class="dialog-layer" id="tokenImportDialog" hidden>/);
  assert.match(html, /<div class="dialog-layer" id="claudeDialog" hidden>/);
  assert.doesNotMatch(html, /legacyConfigsDialog/);

  const accountsView = between(html, 'data-view="accounts"', 'data-view="routes"');
  assert.match(accountsView, /id="routingUpstreamsTable"/);
  assert.match(accountsView, /data-action="new-account"/);
  assert.doesNotMatch(accountsView, /id="unifiedUpstreamsPanel"/);
  assert.doesNotMatch(accountsView, /id="rawJsonInput"/);
  assert.doesNotMatch(accountsView, /id="cards"/);
  assert.doesNotMatch(accountsView, /id="claudeConfigs"/);
  assert.doesNotMatch(accountsView, /id="upstreamPresetSelect"/);
  assert.doesNotMatch(accountsView, /MAIN|FALLBACK|主链路|兜底/);

  const accountDialog = between(html, 'id="accountDialog"', 'id="routeDialog"');
  assert.match(accountDialog, /id="unifiedUpstreamsPanel"/);
  assert.match(accountDialog, /id="upstreamPresetSelect"/);
  assert.match(accountDialog, /id="upstreamModelsEditor"/);
  assert.match(accountDialog, /id="upstreamCredentialPanel"/);
  assert.match(accountDialog, /id="customModelsEndpointField"[^>]*hidden/);
});

test('settings contain only entry credentials, ports, and unified login imports', () => {
  const settingsDrawer = between(html, 'id="settingsDrawer"', 'id="tokenImportDialog"');
  assert.match(settingsDrawer, /id="servicePortInput"/);
  assert.match(settingsDrawer, /id="apiKeysList"/);
  assert.match(settingsDrawer, /data-action="open-token-import"/);
  assert.match(settingsDrawer, /data-action="open-claude-manager"/);
  assert.doesNotMatch(html, /legacy|旧模式|Fallback|responsesModelAliases|batchToolbar/);
  assert.doesNotMatch(routingJs, /open-legacy-configs|legacyConfigsDialog|routing_mode/);
});

test('account editing uses platform, credential, editable models, sync preview, and save-close flow', () => {
  for (const id of [
    'unifiedUpstreamsPanel',
    'upstreamPresetSelect',
    'upstreamModelsEditor',
    'upstreamAddModelButton',
    'upstreamDiscoverModelsButton',
    'upstreamDiscoveryPanel',
    'customModelsEndpointField',
    'upstreamModelsEndpointInput',
    'routingUpstreamsTable',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }

  assert.match(routingJs, /\/admin\/api\/upstreams/);
  assert.match(routingJs, /\/models\/discover/);
  assert.match(routingJs, /\/quota-refresh/);
  assert.match(routingJs, /preset\.id !== 'custom'/);
  assert.match(routingJs, /suggested_models|discovered/);
  assert.match(routingJs, /renderModelEditor/);
  assert.match(routingJs, /open-token-import/);
  assert.match(routingJs, /open-claude-manager/);
  assert.match(routingJs, /openTokenImportFromAccount/);
  assert.match(routingJs, /同步差异已合并到编辑草稿；保存上游后才会生效/);

  const openAccount = between(routingJs, 'function openAccount(', 'function accountStatus(');
  assert.match(openAccount, /openLayer\('accountDialog'\)/);

  const saveUpstream = between(routingJs, 'async function saveUpstream()', 'async function refreshQuota(');
  assert.match(saveUpstream, /closeLayer\('accountDialog'\)/);
  assert.match(saveUpstream, /resetUpstreamForm\(\{ close: false \}\)/);
  assert.match(saveUpstream, /await loadAll\(\)/);
  assert.match(saveUpstream, /isTokenPreset\(preset\) && !state\.editingUpstreamId/);
});

test('routing UI maps arbitrary public IDs to ordered account/model targets with automatic native protocol matching', () => {
  for (const id of [
    'routeModelIdInput',
    'routeEntryProtocol',
    'routeTargetsEditor',
    'routeAddTargetButton',
    'routeSaveButton',
    'modelRoutesList',
    'routesRevisionBadge',
  ]) {
    assert.match(html, new RegExp(id));
  }

  assert.match(html, /<details class="advanced-settings"[\s\S]*?routeEntryProtocol/);
  assert.match(routingJs, /data-target-editor-field="account"/);
  assert.match(routingJs, /data-target-editor-field="model"/);
  assert.doesNotMatch(routingJs, /data-target-editor-field="protocol"/);
  assert.match(routingJs, /支持协议/);
  assert.match(routingJs, /data-move-target-up/);
  assert.match(routingJs, /data-move-target-down/);
  assert.match(routingJs, /\/admin\/api\/model-routes/);
  assert.match(routingJs, /max_attempts/);
  assert.match(routingJs, /revision/);

  const saveRoute = between(routingJs, 'async function saveRoute()', 'async function deleteRoute(');
  assert.match(saveRoute, /closeLayer\('routeDialog'\)/);
  assert.match(saveRoute, /resetRouteForm\(\{ close: false \}\)/);
  assert.match(saveRoute, /await loadAll\(\)/);
});

test('manually added OpenCode models require explicit native protocol selection rather than all provider endpoints', () => {
  for (const id of ['opencode-go', 'opencode-zen']) assert.deepEqual(routingAdmin.initialModelProtocols({ id, protocols: ['chat_completions', 'responses', 'messages'] }), []);
  assert.deepEqual(routingAdmin.initialModelProtocols({ id: 'claude', protocols: ['messages'] }), ['messages']);
});

test('account cards keep platforms equal and quota unknown is never exhausted', () => {
  const config = { id: 'account-1', type: 'token', description: 'ChatGPT', models: [] };
  assert.equal(routingAdmin.providerIdForConfig(config), 'chatgpt');
  assert.equal(routingAdmin.providerIdForConfig({ id: 'a', preset: 'glm-cn' }), 'glm-cn');
  assert.equal(routingAdmin.providerIdForConfig({ id: 'b', type: 'claude_token' }), 'claude');
  assert.equal(routingAdmin.providerIdForConfig({ id: 'c', type: 'apikey' }), 'custom');
  assert.equal(routingAdmin.getPresetLabel([], 'chatgpt'), 'ChatGPT / Codex');

  assert.deepEqual(routingAdmin.formatQuotaSummary(null), {
    label: '额度未读取',
    tone: 'warn',
    detail: '尚未读取额度',
  });
  assert.deepEqual(routingAdmin.formatQuotaSummary({ state: 'unknown', error: 'read failed' }), {
    label: '额度未读取',
    tone: 'warn',
    detail: 'read failed',
  });
  assert.deepEqual(routingAdmin.formatQuotaSummary({
    state: 'available',
    metrics: [{ remaining_percent: 62 }, { remaining_percent: 45 }],
  }), {
    label: '剩余 45%',
    tone: 'ok',
    detail: '',
  });
  assert.equal(routingAdmin.formatQuotaSummary({ state: 'exhausted' }).tone, 'danger');
  assert.doesNotMatch(routingJs, /额度模板|demoCatalog|演示数据/);
});

test('shared admin helpers build authenticated URLs and parse errors', () => {
  assert.equal(
    adminJs.buildRequestUrl('/admin/api/upstreams', {
      adminAuthToken: 'admin-example',
      origin: 'http://localhost:3009',
    }),
    '/admin/api/upstreams?auth_token=admin-example',
  );
  assert.equal(
    adminJs.extractErrorMessage({ error: { message: 'bad route' } }, 'fallback'),
    'bad route',
  );
  assert.equal(typeof routingAdmin.createRoutingAdmin, 'function');
});


test('model test responses extract text for all three entry protocols and keep error envelopes', () => {
  const { extractTestResponseText, normalizeTestResult } = routingAdmin;
  assert.equal(extractTestResponseText({ choices: [{ message: { content: 'chat reply' } }] }), 'chat reply');
  assert.equal(extractTestResponseText({ choices: [{ message: { content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] } }] }), 'one\ntwo');
  assert.equal(extractTestResponseText({ output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'responses reply' }] }] }), 'responses reply');
  assert.equal(extractTestResponseText({ output_text: 'simple response' }), 'simple response');
  assert.equal(extractTestResponseText({ content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'messages reply' }] }), 'messages reply');
  const payload = { status_code: 429, elapsed_ms: 37, attempts: [{ config_id: 'limited' }], response: { error: { message: 'quota exhausted' } } };
  const result = normalizeTestResult(payload, 429, 42);
  assert.equal(result.statusCode, 429);
  assert.equal(result.elapsedMs, 37);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error, 'quota exhausted');
  assert.deepEqual(result.attempts, payload.attempts);
  assert.equal(result.raw, payload);
  assert.equal(normalizeTestResult({ error: { message: 'invalid input' } }, 400, 2).error, 'invalid input');
  assert.equal(normalizeTestResult({ outcome: 'skipped', response: { error: 'disabled' } }, 200, 2).outcome, 'skipped');
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('candidate tests run sequentially, publish each result, and continue after request failure', async () => {
  const first = deferred();
  const calls = [];
  const snapshots = [];
  const runner = routingAdmin.createRouteTestRunner({
    execute: async job => {
      calls.push(job);
      if (job === 'one') return first.promise;
      if (job === 'two') throw new Error('connection failed');
      return { outcome: 'success', text: 'last reply' };
    },
    onChange: snapshot => snapshots.push(snapshot),
  });
  const running = runner.start(['one', 'two', 'three']);
  assert.deepEqual(calls, ['one']);
  assert.equal(await runner.start(['duplicate']), false);
  first.resolve({ outcome: 'failed', statusCode: 429 });
  assert.equal(await running, true);
  assert.deepEqual(calls, ['one', 'two', 'three']);
  assert.ok(snapshots.some(snapshot => snapshot.items[0].state === 'done' && snapshot.items[1].state === 'waiting'));
  const final = snapshots.at(-1);
  assert.equal(final.running, false);
  assert.deepEqual(final.items.map(item => item.state), ['done', 'done', 'done']);
  assert.equal(final.items[0].result.statusCode, 429);
  assert.equal(final.items[1].error, 'connection failed');
  assert.equal(final.items[2].result.text, 'last reply');
});

test('stop aborts active request, prevents later candidates, and rejects stale results after reopening', async () => {
  const old = deferred();
  const calls = [];
  const snapshots = [];
  let signal;
  const runner = routingAdmin.createRouteTestRunner({
    execute: (job, currentSignal) => {
      calls.push(job);
      if (job === 'old') { signal = currentSignal; return old.promise; }
      return Promise.resolve({ text: 'new result' });
    },
    onChange: snapshot => snapshots.push(snapshot),
  });
  const previous = runner.start(['old', 'never-start']);
  runner.stop();
  assert.equal(signal.aborted, true);
  assert.equal(snapshots.at(-1).stopped, true);
  assert.deepEqual(snapshots.at(-1).items.map(item => item.state), ['cancelled', 'cancelled']);
  await runner.start(['new']);
  const count = snapshots.length;
  old.resolve({ text: 'stale result' });
  assert.equal(await previous, false);
  assert.equal(snapshots.length, count);
  assert.deepEqual(calls, ['old', 'new']);
  assert.equal(snapshots.at(-1).items[0].result.text, 'new result');
});

function testAdminHarness(fetch) {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {
        id, value: '', hidden: true, disabled: false, textContent: '', innerHTML: '', options: [],
        focus() {}, classList: { toggle() {}, add() {}, remove() {} },
      });
      return nodes.get(id);
    },
    querySelectorAll() { return [this.getElementById('routeTestDialog')]; },
    body: { classList: { toggle() {} } },
  };
  const admin = routingAdmin.createRoutingAdmin({ document, window: {
    location: { search: '?auth_token=test-admin', origin: 'http://localhost:3009' }, fetch,
  } });
  admin.state.upstreams = { configs: [{ id: 'account-a', description: 'Account A' }] };
  admin.state.routes = { models: [{ id: 'public-id', entry_protocols: ['responses', 'chat_completions'], targets: [
    { id: 'target-1', config_id: 'account-a', model: 'backend-1' },
    { id: 'target-2', config_id: 'account-a', model: 'backend-2' },
  ] }] };
  admin.openRouteTest('public-id');
  // The lightweight DOM stub does not implement native select option selection.
  document.getElementById('routeTestProtocol').value = 'responses';
  document.getElementById('routeTestInput').value = 'custom\ninput';
  return { admin, nodes, document };
}

test('test dialog sends saved route and target IDs, preserves non-200 details, and escapes model output', async () => {
  const calls = [];
  const { admin, nodes } = testAdminHarness(async (url, options) => {
    const request = JSON.parse(options.body);
    calls.push({ url, request });
    const failed = request.target_id === 'target-1';
    const response = failed ? { error: { message: '<script>bad()</script>' } }
      : { output: [{ content: [{ type: 'output_text', text: '<img src=x onerror=alert(1)>' }] }] };
    return { status: failed ? 429 : 200, text: async () => JSON.stringify({
      status_code: failed ? 429 : 200, elapsed_ms: 5,
      attempts: [{ config_id: 'account-a', account_label: 'Account A', model: 'backend-model' }], response,
    }) };
  });
  assert.match(nodes.get('routeTestProtocol').innerHTML, /^<option value="responses">/);
  await admin.runRouteTest('candidate');
  assert.deepEqual(calls.map(call => call.request), [
    { model: 'public-id', input: 'custom\ninput', mode: 'candidate', protocol: 'responses', target_id: 'target-1' },
    { model: 'public-id', input: 'custom\ninput', mode: 'candidate', protocol: 'responses', target_id: 'target-2' },
  ]);
  assert.match(calls[0].url, /\/admin\/api\/model-routes\/test/);
  const rendered = nodes.get('routeTestResults').innerHTML;
  assert.match(rendered, /HTTP 429/);
  assert.match(rendered, /backend-model/);
  assert.match(rendered, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.match(rendered, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(rendered, /<script>|<img /);
  assert.equal(nodes.get('routeTestRunButton').disabled, false);
  await admin.runRouteTest('route');
  assert.deepEqual(calls.at(-1).request, { model: 'public-id', input: 'custom\ninput', mode: 'route', protocol: 'responses' });
});

test('closing the dialog aborts its request and stops remaining candidates', async () => {
  const waiting = deferred();
  let activeSignal;
  let calls = 0;
  const { admin, nodes } = testAdminHarness(async (url, options) => {
    calls += 1;
    activeSignal = options.signal;
    return waiting.promise;
  });
  const running = admin.runRouteTest('candidate');
  assert.equal(nodes.get('routeTestRunButton').disabled, true);
  admin.closeLayer('routeTestDialog');
  assert.equal(activeSignal.aborted, true);
  assert.equal(nodes.get('routeTestDialog').hidden, true);
  admin.openRouteTest('public-id');
  const freshHtml = nodes.get('routeTestResults').innerHTML;
  waiting.resolve({ status: 200, text: async () => JSON.stringify({ response: { output_text: 'old response' } }) });
  await running;
  assert.equal(calls, 1);
  assert.equal(nodes.get('routeTestResults').innerHTML, freshHtml);
});


test('free pool credentials only reference existing accounts on the matching platform', () => {
  const accounts = [
    { id: 'go', type: 'apikey', preset: 'opencode-go' },
    { id: 'zen', type: 'apikey', preset: 'opencode-zen' },
    { id: 'or', type: 'apikey', preset: 'openrouter' },
    { id: 'glm', type: 'apikey', preset: 'glm-cn' },
    { id: 'pool', type: 'apikey', preset: 'opencode-free' },
    { id: 'invalid', type: 'token', preset: 'openrouter' },
  ];
  assert.deepEqual(routingAdmin.poolCredentialOptions(accounts, 'opencode-free').map(item => item.id), ['go', 'zen']);
  assert.deepEqual(routingAdmin.poolCredentialOptions(accounts, 'openrouter-free').map(item => item.id), ['or']);
  assert.equal(routingAdmin.isPoolPreset('opencode-free'), true);
  assert.equal(routingAdmin.isPoolPreset({ id: 'openrouter-free' }), true);
  assert.equal(routingAdmin.isPoolPreset('opencode-go'), false);
});

test('pool settings validate explicit quality tiers and bounded catalogue freshness', () => {
  assert.deepEqual(routingAdmin.normalizePoolSettings(), { sync_interval_seconds: 900, max_stale_seconds: 3600, max_attempts: 8, strategy: 'quality_first', tiers: {} });
  assert.equal(routingAdmin.normalizePoolSettings({ tiers: { 'unfamiliar-model-id': 1 }, sync_interval_seconds: '120' }).sync_interval_seconds, 120);
  for (const patch of [{ tiers: [] }, { tiers: { model: 0 } }, { tiers: { model: '1' } }, { strategy: 'random' }, { sync_interval_seconds: 59 }, { max_attempts: 33 }, { max_stale_seconds: 86401 }, { sync_interval_seconds: 900, max_stale_seconds: 100 }]) {
    assert.throws(() => routingAdmin.normalizePoolSettings(patch));
  }
});

function poolHarness() {
  const calls = [];
  const pool = { id: 'pool-a', description: 'OpenCode free pool', type: 'apikey', preset: 'opencode-free', credential_ref: 'go', has_credentials: true, base_url: 'https://opencode.ai/inference/go', models: [{ id: 'free', protocols: ['chat_completions'] }], pool: { strategy: 'quality_first', tiers: { 'beam-free': 1 } }, pool_status: { state: 'ready', last_sync_at: 1792900000000, last_request: { model: '<actual-model>' }, source_urls: ['https://example.invalid/models'], models: [{ id: '<unsafe-model>', quality_tier: 1, quality_source: '<configured>', latency_ms: 321, success_rate: 0.75, context_window: 128000, status: 'ok', capabilities: { tools: true }, free_evidence: { prompt: 0, completion: 0 } }] } };
  const configs = [{ id: 'go', type: 'apikey', preset: 'opencode-go', description: 'Existing Go account', models: [{ id: 'paid-model', protocols: ['chat_completions'] }] }, pool];
  const harness = testAdminHarness(async (url, options) => {
    calls.push({ url, options });
    const payload = url.includes('/pool-refresh') ? { upstream: pool, pool_status: pool.pool_status } : url.includes('/model-routes') ? { models: [], configs, max_attempts: 4 } : { configs };
    return { status: 200, ok: true, text: async () => JSON.stringify(payload) };
  });
  harness.admin.state.upstreams = { configs };
  harness.admin.state.routes = { models: [], max_attempts: 4 };
  return { ...harness, configs, pool, calls };
}

test('saving a route omits candidate protocol and displays all declared native model protocols', async () => {
  const { admin, nodes, document, calls, configs } = poolHarness();
  configs[0].models[0].protocols = ['chat_completions', 'messages'];
  admin.state.formTargets = [{ id: 'native-choice', config_id: 'go', model: 'paid-model', protocol: 'chat_completions' }];
  nodes.get('routeModelIdInput').value = 'arbitrary-model';
  document.querySelectorAll = selector => selector.includes('routeEntryProtocol') ? [{ checked: true, value: 'messages' }, { checked: true, value: 'chat_completions' }] : [];
  await admin.saveRoute();
  const saved = calls.find(call => call.options.method === 'PUT');
  assert.deepEqual(JSON.parse(saved.options.body).models[0].targets, [{ id: 'native-choice', config_id: 'go', model: 'paid-model' }]);
  admin.state.routes = { models: [{ id: 'arbitrary-model', entry_protocols: ['messages', 'chat_completions'], targets: [{ id: 'native-choice', config_id: 'go', model: 'paid-model' }] }] };
  admin.renderRoutes();
  const cards = nodes.get('modelRoutesList').innerHTML;
  assert.match(cards, /Chat Completions/); assert.match(cards, /Claude Messages/);
  assert.doesNotMatch(cards, /undefined/);
});

test('pool editor reuses saved credentials, hides editable model lists, and saves fixed free', async () => {
  const { admin, nodes, calls } = poolHarness();
  admin.openAccount('pool-a');
  assert.equal(nodes.get('upstreamPoolFields').hidden, false);
  assert.equal(nodes.get('upstreamModelSection').hidden, true);
  assert.equal(nodes.get('upstreamCredentialRefSelect').value, 'go');
  assert.equal(nodes.get('upstreamApiKeyField').hidden, true);
  assert.equal(nodes.get('upstreamApiKeyInput').disabled, true);
  assert.equal(nodes.get('upstreamBaseUrlInput').readOnly, true);
  assert.match(nodes.get('upstreamCredentialRefSelect').innerHTML, /Existing Go account/);
  admin.state.formModels = [{ id: 'paid-model', protocols: ['responses'] }];
  await admin.saveUpstream();
  const saved = calls.find(call => call.options.method === 'PUT');
  const body = JSON.parse(saved.options.body);
  assert.equal(body.credential_ref, 'go');
  assert.deepEqual(body.models, [{ id: 'free', protocols: ['chat_completions'] }]);
  assert.deepEqual(body.pool.tiers, { 'beam-free': 1 });
  assert.equal(body.apikey, undefined);
  assert.equal(nodes.get('accountDialog').hidden, true);
});

test('pool details display evidence, statistics and actual landing with escaped upstream content', async () => {
  const { admin, nodes, calls } = poolHarness();
  admin.openPoolDetails('pool-a');
  assert.equal(nodes.get('poolDetailsDialog').hidden, false);
  const content = nodes.get('poolDetailsContent').innerHTML;
  assert.match(content, /&lt;unsafe-model&gt;/);
  assert.match(content, /&lt;actual-model&gt;/);
  assert.doesNotMatch(content, /<unsafe-model>|<actual-model>|<configured>/);
  assert.match(content, /321 ms/);
  assert.match(content, /75%/);
  assert.match(content, /免费资格依据/);
  await admin.refreshPool();
  assert.ok(calls.some(call => call.url.includes('/upstreams/pool-a/pool-refresh') && call.options.method === 'POST'));
  assert.equal(nodes.get('poolRefreshButton').disabled, false);
  admin.closeLayer('poolDetailsDialog');
  assert.equal(admin.state.poolDetailId, '');
});

test('pool controls stay in independent dialogs and advanced settings, with fixed target model', () => {
  const poolFields = between(html, 'id="upstreamPoolFields"', 'id="upstreamModelSection"');
  assert.match(poolFields, /<details class="advanced-settings"/);
  assert.match(poolFields, /id="poolSyncIntervalInput"/);
  assert.match(poolFields, /id="poolTiersInput"/);
  assert.match(html, /class="dialog-layer" id="poolDetailsDialog" hidden/);
  assert.match(routingJs, /data-target-editor-field="model" \$\{account\.pool \? 'disabled'/);
  assert.match(routingJs, /免费池固定使用 free/);
});

test('USD quotas show remaining account balance rather than a percentage of cumulative credits', () => {
  const result = routingAdmin.formatQuotaSummary({ state: 'available', metrics: [{ id: 'credits:account_balance', kind: 'budget', unit: 'USD', remaining: 148.94495293, used: 3264.91496757, limit: 3413.8599205, remaining_percent: 4.3629485801568935 }] });
  assert.equal(result.label, '余额 $148.94');
  assert.equal(result.tone, 'ok');
  assert.doesNotMatch(result.label + result.detail, /3413|4\.362|%/);
});

test('account balance and Key allowance stay separate and never sum or replace each other', () => {
  const metrics = [
    { id: 'credits:account_balance', kind: 'budget', unit: 'USD', remaining: 148.94, limit: 3413.86 },
    { id: 'key:key_limit', kind: 'budget', unit: 'USD', remaining: 7.5, limit: 20 },
  ];
  const result = routingAdmin.formatQuotaSummary({ state: 'available', metrics });
  assert.equal(result.label, '余额 $148.94');
  assert.match(result.detail, /Key 剩余 \$7\.50 \/ \$20\.00/);
  assert.doesNotMatch(result.detail, /156\.44|3413/);
});

test('Key-only USD budgets show money without requiring remaining_percent', () => {
  const key = routingAdmin.formatQuotaSummary({ state: 'available', metrics: [{ id: 'key:key_limit', kind: 'budget', unit: 'USD', remaining: 12.34, limit: 50 }] });
  assert.equal(key.label, 'Key 剩余 $12.34');
  assert.match(key.detail, /Key 限额 \$50\.00/);
  const generic = routingAdmin.formatQuotaSummary({ state: 'available', metrics: [{ id: 'budget:other', kind: 'budget', unit: 'USD', remaining: 2.75 }] });
  assert.equal(generic.label, '剩余额度 $2.75');
});

test('unlimited or unknown Key limits never become zero money or unlimited account balance', () => {
  const account = { id: 'credits:account_balance', kind: 'budget', unit: 'USD', remaining: 148.94 };
  const unlimited = { id: 'key:key_limit', kind: 'budget', unit: 'USD', remaining: null, limit: null };
  const result = routingAdmin.formatQuotaSummary({ state: 'available', metrics: [account, unlimited] });
  assert.equal(result.label, '余额 $148.94');
  assert.doesNotMatch(result.detail, /Key 剩余|\$0\.00|无限/);
  assert.equal(routingAdmin.formatQuotaSummary({ state: 'unknown', error: 'Key endpoint failed', metrics: [unlimited] }).label, '额度未读取');
});

test('USD exhaustion keeps the real balance and identifies the exhausted constraint', () => {
  const account = { id: 'credits:account_balance', kind: 'budget', unit: 'USD', remaining: 148.94, state: 'available' };
  const key = { id: 'key:key_limit', kind: 'budget', unit: 'USD', remaining: 0, limit: 10, state: 'exhausted' };
  const keyBlocked = routingAdmin.formatQuotaSummary({ state: 'exhausted', metrics: [account, key] });
  assert.equal(keyBlocked.label, '余额 $148.94');
  assert.equal(keyBlocked.tone, 'danger');
  assert.match(keyBlocked.detail, /Key 限额已耗尽/);
  assert.match(keyBlocked.detail, /Key 剩余 \$0\.00 \/ \$10\.00/);
  const empty = routingAdmin.formatQuotaSummary({ state: 'exhausted', metrics: [{ ...account, remaining: 0, state: 'exhausted' }] });
  assert.equal(empty.label, '余额 $0.00');
  assert.equal(empty.tone, 'danger');
  assert.match(empty.detail, /账户余额已耗尽/);
});

test('small nonzero balances preserve precision and partial read failures remain visible', () => {
  for (const amount of [0.009, 0.0001, 0.00000000001]) {
    const result = routingAdmin.formatQuotaSummary({ state: 'available', error: 'Key quota request failed', metrics: [{ id: 'credits:account_balance', kind: 'budget', unit: 'USD', remaining: amount }] });
    assert.doesNotMatch(result.label, /^余额 \$0\.00$/);
    assert.match(result.label, /0\./);
    assert.match(result.detail, /Key quota request failed/);
    assert.equal(result.tone, 'ok');
  }
});

test('Sub2API zero wallets stay unknown and preserve the displayed amount', () => {
  const result = routingAdmin.formatQuotaSummary({ state: 'unknown', reason: '运行模式未暴露，需真实请求验证', metrics: [{ id: 'wallet_balance', kind: 'budget', unit: 'USD', remaining: 0, state: 'unknown', blocking: true }] });
  assert.equal(result.label, '余额 $0.00');
  assert.equal(result.tone, 'warn');
  assert.doesNotMatch(result.detail, /已耗尽/);
  assert.match(result.detail, /真实请求验证/);
  const nonblocking = routingAdmin.formatQuotaSummary({ state: 'available', metrics: [{ id: 'wallet_balance', kind: 'budget', unit: 'USD', remaining: 0, state: 'available', blocking: false }] });
  assert.equal(nonblocking.tone, 'ok');
  assert.doesNotMatch(nonblocking.detail, /已耗尽/);
});

test('Sub2API Key total quota and all monetary rate windows are shown independently', () => {
  const metrics = [
    { id: 'key_quota', remaining: 50, limit: 100, state: 'available' },
    { id: 'key_window_5h', remaining: 2, limit: 10, state: 'available' },
    { id: 'key_window_1d', remaining: 8, limit: 20, state: 'available' },
    { id: 'key_window_7d', remaining: 25, limit: 50, state: 'available' },
  ].map(metric => ({ kind: 'budget', unit: 'USD', blocking: true, ...metric }));
  const result = routingAdmin.formatQuotaSummary({ state: 'available', metrics });
  const text = result.label + '；' + result.detail;
  assert.match(text, /Key 剩余 \$50\.00 \/ \$100\.00/);
  assert.match(text, /Key 5小时 剩余 \$2\.00/);
  assert.match(text, /Key 5小时 限额 \$10\.00/);
  assert.match(text, /Key 每日 剩余 \$8\.00 \/ \$20\.00/);
  assert.match(text, /Key 7天 剩余 \$25\.00 \/ \$50\.00/);
  assert.doesNotMatch(text, /\$85\.00/);
});

test('Sub2API subscription daily weekly monthly budgets retain each remaining value and limit', () => {
  const metrics = [
    { id: 'subscription_daily', remaining: 1.5, limit: 5 },
    { id: 'subscription_weekly', remaining: 10, limit: 30 },
    { id: 'subscription_monthly', remaining: 50, limit: 100 },
  ].map(metric => ({ kind: 'budget', unit: 'USD', state: 'available', blocking: true, ...metric }));
  const result = routingAdmin.formatQuotaSummary({ state: 'available', metrics });
  assert.equal(result.label, '订阅每日 剩余 $1.50');
  assert.match(result.detail, /订阅每日 限额 \$5\.00/);
  assert.match(result.detail, /订阅每周 剩余 \$10\.00 \/ \$30\.00/);
  assert.match(result.detail, /订阅每月 剩余 \$50\.00 \/ \$100\.00/);
});

test('unlimited and missing subscription windows never look like exhausted zero allowances', () => {
  const metrics = [
    { id: 'subscription_daily', remaining: null, limit: null, state: 'available', blocking: false },
    { id: 'subscription_weekly', remaining: 0, limit: 20, state: 'unknown', blocking: true },
    { id: 'subscription_monthly', remaining: null, limit: 100, state: 'unknown', blocking: true },
  ].map(metric => ({ kind: 'budget', unit: 'USD', ...metric }));
  const result = routingAdmin.formatQuotaSummary({ state: 'unknown', metrics });
  assert.equal(result.tone, 'warn');
  assert.match(result.detail, /订阅每日 不限额/);
  assert.match(result.detail, /订阅每月 剩余额度未读取 \/ \$100\.00/);
  assert.doesNotMatch(result.detail, /已耗尽/);
  const exhausted = routingAdmin.formatQuotaSummary({ state: 'exhausted', metrics: [{ ...metrics[1], state: 'exhausted' }] });
  assert.equal(exhausted.tone, 'danger');
  assert.match(exhausted.detail, /订阅每周 已耗尽/);
});

test('Sub2API API Key preset requires its gateway URL and retains existing model discovery', async () => {
  assert.equal(routingAdmin.getPresetLabel([], 'sub2api'), 'Sub2API API Key');
  const { admin, nodes } = poolHarness();
  admin.state.editingUpstreamId = '';
  nodes.get('upstreamPresetSelect').value = 'sub2api';
  nodes.get('upstreamDescriptionInput').value = 'Self hosted gateway';
  nodes.get('upstreamApiKeyInput').value = 'fake-api-key';
  nodes.get('upstreamBaseUrlInput').value = '';
  nodes.get('upstreamModelsEditor').querySelectorAll = () => [];
  await assert.rejects(admin.saveUpstream(), /Sub2API.*Base URL/);
});
