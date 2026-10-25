(function attachConfigAdmin(globalScope) {
  function buildRequestUrl(path, options = {}) {
    const url = new URL(path, options.origin || 'http://localhost');
    if (options.adminAuthToken && url.pathname.startsWith('/admin/')) {
      url.searchParams.set('auth_token', options.adminAuthToken);
    }
    return `${url.pathname}${url.search}`;
  }

  function extractErrorMessage(payload, fallback = '请求失败') {
    return payload?.error?.message || payload?.message || fallback;
  }

  function normalizePortValue(value) {
    const text = String(value ?? '').trim();
    if (!/^\d+$/.test(text)) return null;
    const port = Number(text);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  }

  function parsePortSettings(portValue, proxyValue) {
    const port = normalizePortValue(portValue);
    if (!port) throw new Error('服务端口必须是 1-65535 之间的整数');
    const proxyText = String(proxyValue ?? '').trim();
    const proxyPort = proxyText ? normalizePortValue(proxyText) : null;
    if (proxyText && !proxyPort) throw new Error('代理端口必须是 1-65535 之间的整数，或留空');
    return { port, proxy_port: proxyPort };
  }

  function parseImportJson(rawText) {
    let parsed;
    try {
      parsed = JSON.parse(String(rawText || '').trim());
    } catch {
      throw new Error('请粘贴完整、合法的 AuthSession 或 Sub2API JSON');
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (!items.length || items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
      throw new Error('登录态必须是 JSON 对象或非空对象数组');
    }
    return JSON.stringify(parsed);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  function createSettingsAdmin(options = {}) {
    const doc = options.document || globalScope.document;
    const win = options.window || globalScope;
    if (!doc) return null;
    const el = id => doc.getElementById(id);
    if (!el('settingsDrawer')) return null;
    const state = { settings: null, loading: false };
    const token = new URLSearchParams(win.location.search).get('auth_token') || '';

    function message(kind, text) {
      const target = el('message');
      target.className = `message show ${kind}`;
      target.textContent = text;
    }

    async function request(path, init = {}) {
      const response = await win.fetch(buildRequestUrl(path, { adminAuthToken: token, origin: win.location.origin }), {
        ...init, headers: { 'content-type': 'application/json', ...init.headers },
      });
      const text = await response.text();
      let payload;
      try { payload = text ? JSON.parse(text) : {}; }
      catch { throw new Error(`服务返回无法识别的响应（HTTP ${response.status}）`); }
      if (!response.ok) throw new Error(extractErrorMessage(payload, `HTTP ${response.status}`));
      return payload;
    }

    function renderSettings(settings) {
      state.settings = settings;
      const keys = Array.isArray(settings.apikeys) ? settings.apikeys : [];
      el('apiKeyStatusBadge').textContent = keys.length ? `${keys.length} 个入口密钥` : '入口鉴权未启用';
      el('apiKeysList').innerHTML = keys.length ? keys.map((key, index) => `
        <div class="key-item">
          <div><div class="key-meta">入口密钥 ${index + 1}</div><input class="mono" type="password" readonly value="${escapeHtml(key)}" aria-label="入口密钥 ${index + 1}"></div>
          <div class="actions"><button class="secondary" type="button" data-reveal-key="${index}">显示</button><button class="secondary" type="button" data-copy-key="${index}">复制</button><button class="danger" type="button" data-delete-key="${index}">删除</button></div>
        </div>`).join('') : '<div class="empty">没有入口密钥，请求将不校验入口鉴权。</div>';
      el('servicePortInput').value = String(settings.port || 3009);
      el('proxyPortInput').value = settings.proxy_port ? String(settings.proxy_port) : '';
      // Reverse-proxy deployments use the page origin, not the internal Node port.
      el('proxyV1Url').textContent = `${win.location.origin}/v1`;
      el('proxyEndpointMeta').textContent = settings.proxy_port ? `上游代理端口：${settings.proxy_port}` : '未配置上游代理';
    }

    async function loadSettings() {
      const settings = await request('/admin/api/settings');
      renderSettings(settings);
      return settings;
    }

    async function addApiKey() {
      renderSettings(await request('/admin/api/apikeys', { method: 'POST' }));
      message('info', '入口密钥已新增，可使用复制按钮。');
    }

    async function deleteApiKey(index) {
      renderSettings(await request(`/admin/api/apikeys/${index}`, { method: 'DELETE' }));
      message('info', '入口密钥已删除。');
    }

    async function savePorts() {
      const settings = parsePortSettings(el('servicePortInput').value, el('proxyPortInput').value);
      const result = await request('/admin/api/settings', { method: 'POST', body: JSON.stringify(settings) });
      renderSettings(result);
      message('info', '端口配置已保存。反向代理部署请同步检查代理目标端口。');
      const change = result.network_settings;
      const page = new URL(win.location.href);
      const direct = page.hostname === 'localhost' || page.hostname === '127.0.0.1' || page.hostname === '[::1]';
      if (direct && change?.port_changed && change.next_port) {
        page.port = String(change.next_port);
        win.location.href = page.toString();
      }
    }

    async function importAccounts() {
      const rawJson = parseImportJson(el('rawJsonInput').value);
      const result = await request('/admin/api/upstreams/import', { method: 'POST', body: JSON.stringify({ raw_json: rawJson }) });
      el('rawJsonInput').value = '';
      win.dispatchEvent(new win.CustomEvent('airouter:configs-changed', {
        detail: { source: 'token-import', added_ids: result.added_ids || [] },
      }));
      message('info', '登录态已导入，请为账号配置支持的模型。');
      return result;
    }

    async function run(button, action) {
      button.disabled = true;
      try { await action(); }
      catch (error) { message('error', error.message); }
      finally { button.disabled = false; }
    }

    function init() {
      el('addApiKeyButton').addEventListener('click', event => void run(event.currentTarget, addApiKey));
      el('saveProxySettingsButton').addEventListener('click', event => void run(event.currentTarget, savePorts));
      el('addButton').addEventListener('click', event => void run(event.currentTarget, importAccounts));
      doc.addEventListener('click', event => {
        const reveal = event.target.closest('[data-reveal-key]');
        if (reveal) {
          const input = reveal.closest('.key-item').querySelector('input');
          input.type = input.type === 'password' ? 'text' : 'password';
          reveal.textContent = input.type === 'password' ? '显示' : '隐藏';
          return;
        }
        const copy = event.target.closest('[data-copy-key]');
        if (copy) {
          void run(copy, async () => {
            await win.navigator.clipboard.writeText(state.settings.apikeys[Number(copy.dataset.copyKey)]);
            message('info', '入口密钥已复制。');
          });
          return;
        }
        const remove = event.target.closest('[data-delete-key]');
        if (remove) {
          if (remove.dataset.confirm !== 'true') {
            remove.dataset.confirm = 'true'; remove.textContent = '确认删除';
            win.setTimeout(() => { remove.dataset.confirm = ''; remove.textContent = '删除'; }, 4000);
          } else void run(remove, () => deleteApiKey(Number(remove.dataset.deleteKey)));
          return;
        }
        if (event.target.closest('[data-open-settings], #openSettingsButton')) {
          void loadSettings().catch(error => message('error', error.message));
        }
      });
      return loadSettings().catch(error => message('error', error.message));
    }

    return { state, init, loadSettings, addApiKey, deleteApiKey, savePorts, importAccounts };
  }

  const exported = { buildRequestUrl, extractErrorMessage, normalizePortValue, parsePortSettings, parseImportJson, createSettingsAdmin };
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  globalScope.AirouterConfigAdmin = exported;
  if (typeof document !== 'undefined') {
    const start = () => createSettingsAdmin()?.init();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
