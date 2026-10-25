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

test('routing UI maps arbitrary public IDs to ordered account/model/protocol targets', () => {
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
  assert.match(routingJs, /data-target-editor-field="protocol"/);
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
