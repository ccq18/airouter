const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildRequestUrl, extractErrorMessage, normalizePortValue, parsePortSettings,
  parseImportJson, createSettingsAdmin,
} = require('../public/config-admin.js');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.js'), 'utf8');

function harness(respond, origin = 'https://gateway.example') {
  const elements = new Map();
  const listeners = new Map();
  for (const id of ['settingsDrawer', 'message', 'apiKeyStatusBadge', 'apiKeysList', 'servicePortInput', 'proxyPortInput', 'proxyV1Url', 'proxyEndpointMeta', 'rawJsonInput', 'addApiKeyButton', 'saveProxySettingsButton', 'addButton']) {
    elements.set(id, { value: '', textContent: '', innerHTML: '', addEventListener(name, callback) { listeners.set(`${id}:${name}`, callback); } });
  }
  const calls = [];
  const events = [];
  const doc = { getElementById: id => elements.get(id), addEventListener: (name, callback) => listeners.set(`document:${name}`, callback) };
  const win = {
    location: { origin, search: '?auth_token=admin-fixture', href: `${origin}/admin/configs/upstreams?auth_token=admin-fixture` },
    fetch: async (url, init) => {
      calls.push({ url, ...init });
      const result = await respond(url, init);
      return { ok: (result.status || 200) < 400, status: result.status || 200, text: async () => JSON.stringify(result.body ?? result) };
    },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    dispatchEvent: event => events.push(event),
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => {},
  };
  return { admin: createSettingsAdmin({ document: doc, window: win }), elements, calls, events, win, listeners };
}

test('management HTML contains only current account, route, settings and import interfaces', () => {
  assert.deepEqual([...html.matchAll(/data-page-link="([^"]+)"/g)].map(match => match[1]), ['upstreams', 'routes']);
  for (const id of ['accountDialog', 'routeDialog', 'settingsDrawer', 'tokenImportDialog', 'claudeDialog']) {
    assert.match(html, new RegExp(`id="${id}" hidden`));
  }
  assert.doesNotMatch(html, /legacyConfigsDialog|旧模式|Fallback|responsesModelAliasesInput|batchToolbar|apiKeyConfigPanel/);
  assert.doesNotMatch(html, /<script>\s*[\s\S]*?<\/script>/);
  assert.match(html, /<script src="\/config-admin\.js"><\/script>/);
  assert.match(html, /<script src="\/config-admin-routing\.js"><\/script>/);
  assert.doesNotMatch(source, /\/admin\/api\/configs|model_aliases|activateConfig|moveConfig|configSupports/);
});

test('admin URLs carry management auth but proxy paths do not', () => {
  assert.equal(buildRequestUrl('/admin/api/settings?x=1', { adminAuthToken: 'fixture key', origin: 'https://gateway.example' }), '/admin/api/settings?x=1&auth_token=fixture+key');
  assert.equal(buildRequestUrl('/v1/models', { adminAuthToken: 'fixture' }), '/v1/models');
  assert.equal(buildRequestUrl('/admin/api/settings'), '/admin/api/settings');
  assert.equal(extractErrorMessage({ error: { message: 'invalid draft' } }, 'failed'), 'invalid draft');
});

test('port editing validates integers and allows an empty upstream proxy', () => {
  assert.deepEqual(parsePortSettings('3009', ''), { port: 3009, proxy_port: null });
  assert.deepEqual(parsePortSettings('443', '7890'), { port: 443, proxy_port: 7890 });
  for (const value of ['0', '65536', '-1', '1.2', '1e3', 'NaN', '']) assert.equal(normalizePortValue(value), null);
  assert.throws(() => parsePortSettings('1.2', ''), /服务端口/);
  assert.throws(() => parsePortSettings('3009', 'bad'), /代理端口/);
});

test('credential imports require complete object JSON and preserve server-owned interpretation', () => {
  const session = { accessToken: 'fixture-token', account: { id: 'fixture-account' } };
  assert.deepEqual(JSON.parse(parseImportJson(JSON.stringify(session))), session);
  assert.deepEqual(JSON.parse(parseImportJson(JSON.stringify([session]))), [session]);
  for (const text of ['', '{"accessToken":', '{"x":1,}', '[]', '[null]', '"token"']) {
    assert.throws(() => parseImportJson(text), /JSON|登录态/);
  }
});

test('settings load uses the new API and public origin behind a reverse proxy', async () => {
  const h = harness(async () => ({ apikeys: ['entry-fixture'], port: 3009, proxy_port: 7890 }));
  await h.admin.init();
  assert.equal(h.calls[0].url, '/admin/api/settings?auth_token=admin-fixture');
  assert.equal(h.elements.get('proxyV1Url').textContent, 'https://gateway.example/v1');
  assert.match(h.elements.get('apiKeysList').innerHTML, /type="password"/);
  assert.match(h.elements.get('apiKeysList').innerHTML, /data-copy-key="0"/);
  assert.equal(h.listeners.size, 4);
});

test('key mutations render returned settings without exposing new key in status text', async () => {
  const h = harness(async (url, init) => ({ apikeys: init.method === 'DELETE' ? [] : ['new-entry-fixture'], port: 3009 }));
  await h.admin.addApiKey();
  assert.equal(h.calls[0].url, '/admin/api/apikeys?auth_token=admin-fixture');
  assert.equal(h.calls[0].method, 'POST');
  assert.equal(h.elements.get('message').textContent.includes('new-entry-fixture'), false);
  await h.admin.deleteApiKey(0);
  assert.equal(h.calls[1].url, '/admin/api/apikeys/0?auth_token=admin-fixture');
  assert.equal(h.calls[1].method, 'DELETE');
  assert.equal(h.admin.state.settings.apikeys.length, 0);
});

test('port saves send only new settings and do not redirect public reverse-proxy URLs', async () => {
  const h = harness(async () => ({ apikeys: [], port: 3010, proxy_port: null, network_settings: { port_changed: true, next_port: 3010 } }));
  h.elements.get('servicePortInput').value = '3010';
  await h.admin.savePorts();
  assert.equal(h.calls[0].url, '/admin/api/settings?auth_token=admin-fixture');
  assert.deepEqual(JSON.parse(h.calls[0].body), { port: 3010, proxy_port: null });
  assert.equal(new URL(h.win.location.href).port, '');
  const count = h.calls.length;
  h.elements.get('servicePortInput').value = 'bad';
  await assert.rejects(h.admin.savePorts(), /服务端口/);
  assert.equal(h.calls.length, count);
});

test('direct local port changes preserve authentication when navigating', async () => {
  const h = harness(async () => ({ apikeys: [], port: 3010, network_settings: { port_changed: true, next_port: 3010 } }), 'http://localhost:3009');
  h.elements.get('servicePortInput').value = '3010';
  await h.admin.savePorts();
  assert.equal(h.win.location.href, 'http://localhost:3010/admin/configs/upstreams?auth_token=admin-fixture');
});

test('successful login import clears its input and opens unified account editing through an event', async () => {
  const h = harness(async () => ({ added_ids: ['account-fixture'] }));
  h.elements.get('rawJsonInput').value = '{"accessToken":"fixture-token"}';
  await h.admin.importAccounts();
  assert.equal(h.calls[0].url, '/admin/api/upstreams/import?auth_token=admin-fixture');
  assert.deepEqual(JSON.parse(h.calls[0].body), { raw_json: '{"accessToken":"fixture-token"}' });
  assert.equal(h.elements.get('rawJsonInput').value, '');
  assert.deepEqual(h.events[0].detail, { source: 'token-import', added_ids: ['account-fixture'] });
  assert.equal(h.elements.get('message').textContent.includes('fixture-token'), false);
});

test('failed import preserves the draft and does not emit a success event', async () => {
  const h = harness(async () => ({ status: 400, body: { error: { message: '登录态不完整' } } }));
  h.elements.get('rawJsonInput').value = '{"accessToken":"fixture-token"}';
  await assert.rejects(h.admin.importAccounts(), /登录态不完整/);
  assert.ok(h.elements.get('rawJsonInput').value);
  assert.equal(h.events.length, 0);
});
