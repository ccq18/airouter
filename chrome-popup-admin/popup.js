const DEFAULT_SETTINGS = {
  baseUrl: 'http://localhost:3100',
  authToken: ''
};

const messageEl = document.getElementById('message');
const cardsEl = document.getElementById('cards');
const apiKeysListEl = document.getElementById('apiKeysList');
const baseUrlInput = document.getElementById('baseUrlInput');
const authTokenInput = document.getElementById('authTokenInput');
const connectionBadge = document.getElementById('connectionBadge');
const apiKeyStatusBadge = document.getElementById('apiKeyStatusBadge');
const rawJsonInput = document.getElementById('rawJsonInput');
const tokenConfigPanel = document.getElementById('tokenConfigPanel');
const apiKeyConfigPanel = document.getElementById('apiKeyConfigPanel');
const apiKeyBaseUrlInput = document.getElementById('apiKeyBaseUrlInput');
const apiKeyInput = document.getElementById('apiKeyInput');
const apiKeyDescriptionInput = document.getElementById('apiKeyDescriptionInput');
const saveSettingsButton = document.getElementById('saveSettingsButton');
const openAdminButton = document.getElementById('openAdminButton');
const startServiceButton = document.getElementById('startServiceButton');
const restartServiceButton = document.getElementById('restartServiceButton');
const refreshButton = document.getElementById('refreshButton');
const addApiKeyButton = document.getElementById('addApiKeyButton');
const addConfigButton = document.getElementById('addConfigButton');

let snapshot = null;
let settings = { ...DEFAULT_SETTINGS };

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function setMessage(type, text) {
  if (!text) {
    messageEl.className = 'message';
    messageEl.textContent = '';
    return;
  }

  messageEl.className = `message show ${type}`;
  messageEl.textContent = text;
}

function getChromeStorage() {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error('当前环境不支持 chrome.storage.local');
  }

  return globalThis.chrome.storage.local;
}

async function loadSettings() {
  const storage = getChromeStorage();
  const stored = await storage.get(DEFAULT_SETTINGS);
  settings = {
    baseUrl: String(stored.baseUrl || DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, ''),
    authToken: String(stored.authToken || '')
  };

  baseUrlInput.value = settings.baseUrl;
  authTokenInput.value = settings.authToken;
}

async function saveSettings() {
  const nextSettings = {
    baseUrl: String(baseUrlInput.value || '').trim().replace(/\/+$/, ''),
    authToken: String(authTokenInput.value || '').trim()
  };

  if (!nextSettings.baseUrl) {
    throw new Error('Base URL 不能为空');
  }

  await getChromeStorage().set(nextSettings);
  settings = nextSettings;
}

function buildUrl(path) {
  const base = settings.baseUrl || DEFAULT_SETTINGS.baseUrl;
  const resolved = new URL(path, `${base}/`);
  if (settings.authToken) {
    resolved.searchParams.set('auth_token', settings.authToken);
  }
  return resolved.toString();
}

function setConnectionBadge(state, text) {
  connectionBadge.className = `badge ${state}`;
  connectionBadge.textContent = text;
}

async function requestJson(path, options = {}) {
  const response = await fetch(buildUrl(path), {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = new Error(payload?.details || payload?.message || payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function runtimeBadge(item) {
  if (item.is_active) {
    return '<span class="badge active">当前使用</span>';
  }
  return '';
}

function getSelectedConfigMode() {
  const selected = document.querySelector('input[name="configMode"]:checked');
  return selected ? selected.value : 'token';
}

function updateConfigMode() {
  const mode = getSelectedConfigMode();
  tokenConfigPanel.hidden = mode !== 'token';
  apiKeyConfigPanel.hidden = mode !== 'apikey';
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function getSelectedApiKeySupport() {
  return [...document.querySelectorAll('input[name="apiKeySupport"]:checked')]
    .map(input => input.value);
}

function buildConfigItemFromInputs() {
  const mode = getSelectedConfigMode();
  if (mode === 'token') {
    const rawJson = String(rawJsonInput.value || '').trim();
    if (!rawJson) {
      throw new Error('请先输入 AuthSession JSON');
    }
    try {
      const parsed = JSON.parse(rawJson);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('AuthSession JSON 必须是对象');
      }
      return parsed;
    } catch (error) {
      throw new Error(`AuthSession JSON 解析失败: ${error.message}`);
    }
  }

  const apikey = String(apiKeyInput.value || '').trim();
  const baseUrl = normalizeBaseUrl(apiKeyBaseUrlInput.value);
  const support = getSelectedApiKeySupport();

  if (!apikey) {
    throw new Error('apikey 模式下请填写 API Key');
  }
  if (!baseUrl) {
    throw new Error('apikey 模式下请填写 Base URL');
  }
  if (support.length === 0) {
    throw new Error('请至少选择一种 support');
  }

  return {
    type: 'apikey',
    apikey,
    base_url: baseUrl,
    description: String(apiKeyDescriptionInput.value || '').trim(),
    support
  };
}

function clearConfigForm() {
  rawJsonInput.value = '';
  apiKeyBaseUrlInput.value = '';
  apiKeyInput.value = '';
  apiKeyDescriptionInput.value = '';
  document.querySelectorAll('input[name="apiKeySupport"]').forEach(input => {
    input.checked = input.value === 'gpt';
  });
}

function renderSwitchButton(item) {
  if (item.is_active) {
    return '';
  }

  return `<button class="button secondary inline-switch" type="button" data-action="switch-config" data-index="${item.index}">切换</button>`;
}

function hasRefreshToken(item) {
  const configItem = item?.item || {};
  return configItem.type !== 'apikey' && typeof configItem.refresh_token === 'string' && configItem.refresh_token.trim().length > 0;
}

function isApiKeyConfig(item) {
  return item?.item?.type === 'apikey';
}

function getConfigStateClass(item) {
  return item?.runtime?.available === false ? 'is-abnormal' : 'is-normal';
}

function renderRefreshTokenButton(item) {
  if (!hasRefreshToken(item)) {
    return '';
  }

  return `<button class="button soft-success inline-refresh" type="button" data-action="refresh-config-token" data-index="${item.index}">刷新 Token</button>`;
}

function parseRuntimeMetrics(runtimeSummary) {
  const parts = String(runtimeSummary || '')
    .split('|')
    .map(part => part.trim())
    .filter(Boolean);

  const metrics = {
    remaining: { value: null, refreshAt: null },
    weekly: { value: null, refreshAt: null }
  };

  let currentMetric = null;
  for (const part of parts) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    if (key === '额度') {
      metrics.remaining.value = value;
      currentMetric = metrics.remaining;
      continue;
    }

    if (key === '周额度') {
      metrics.weekly.value = value;
      currentMetric = metrics.weekly;
      continue;
    }

    if (key === '刷新时间' && currentMetric) {
      currentMetric.refreshAt = value;
    }
  }

  return metrics;
}

function renderMetricCard(label, value, refreshAt) {
  if (!value) {
    return '';
  }

  return `<div class="metric-card">
    <span class="metric-badge">${escapeHtml(label)} <strong>${escapeHtml(value)}</strong></span>
    ${refreshAt ? `<div class="metric-time">刷新时间 ${escapeHtml(refreshAt)}</div>` : ''}
  </div>`;
}

function renderRuntimeHighlights(item) {
  if (isApiKeyConfig(item)) {
    return '';
  }

  const runtime = item?.runtime;
  const runtimeSummary = runtime?.runtime_summary || '';
  const metrics = parseRuntimeMetrics(runtimeSummary);

  const cards = [
    renderMetricCard('额度', metrics.remaining.value, metrics.remaining.refreshAt),
    renderMetricCard('周额度', metrics.weekly.value, metrics.weekly.refreshAt)
  ].join('');

  return cards ? `<div class="metric-group">${cards}</div>` : '';
}

function formatRuntimeSummary(item) {
  const runtimeSummary = item?.runtime?.runtime_summary || '暂无运行态数据';
  const normalized = String(runtimeSummary || '暂无运行态数据').trim();

  if (isApiKeyConfig(item)) {
    return normalized
      .split('|')
      .map(part => part.trim())
      .filter(part => part && !part.startsWith('额度=') && !part.startsWith('周额度=') && !part.startsWith('刷新时间='))
      .join(' | ');
  }

  return normalized.replace(/\s*\|\s*周额度=/, '\n周额度=');
}

function formatCreatedAt(item) {
  const rawValue = item?.item?.created_at || item?.item?.createdAt;
  if (!rawValue) {
    return '';
  }

  const date = new Date(rawValue);
  if (Number.isNaN(date.getTime())) {
    return String(rawValue);
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${date.getFullYear()}年${month}月${day}号 ${hour}:${minute}`;
}

function formatCreatedDays(item) {
  const rawValue = item?.item?.created_at || item?.item?.createdAt;
  if (!rawValue) {
    return '';
  }

  const createdAt = new Date(rawValue);
  if (Number.isNaN(createdAt.getTime())) {
    return '';
  }

  const days = Math.max(0, (Date.now() - createdAt.getTime()) / (24 * 60 * 60 * 1000));
  return days.toFixed(1);
}

function renderToggleMeta(item) {
  const createdAt = formatCreatedAt(item);
  const createdDays = formatCreatedDays(item);
  return `<div class="config-toggle-row">
    <span class="created-days">${escapeHtml(createdDays)}</span>
    <div class="config-toggle-meta">
      <span class="toggle-label toggle-label-closed">展开</span>
      <span class="toggle-label toggle-label-open">收起</span>
      ${createdAt ? `<span class="created-at">创建时间 ${escapeHtml(createdAt)}</span>` : ''}
    </div>
  </div>`;
}

function getConfigIdentity(item) {
  const configItem = item?.item || {};
  if (configItem.type === 'apikey') {
    return `账户: ${configItem.description || configItem.base_url || '-'}`;
  }

  return `账户: ${configItem.description || configItem.account_id || '-'}`;
}

function renderApiKeys(apikeys) {
  if (!apikeys.length) {
    apiKeysListEl.innerHTML = '<div class="empty">当前没有代理 apikey，请求不会校验 apikey。</div>';
    return;
  }

  apiKeysListEl.innerHTML = apikeys.map((apikey, index) => `
    <div class="key-item">
      <div>
        <div class="key-meta">apikey #${index + 1}</div>
        <div class="mono">${escapeHtml(apikey)}</div>
      </div>
      <button class="button danger" type="button" data-action="delete-apikey" data-index="${index}">删除</button>
    </div>
  `).join('');
}

function renderCards(data) {
  if (!data.configs.length) {
    cardsEl.innerHTML = '<div class="empty">当前没有配置项。</div>';
    return;
  }

  cardsEl.innerHTML = `<div class="stack-list">
    ${data.configs.map(item => `
      <details class="config-item config-disclosure ${getConfigStateClass(item)}">
        <summary class="config-summary-head">
          <div class="config-summary-layout">
            <div class="config-head-row">
              <div class="config-main">
                <div class="config-title-row">
                  <span>配置 #${item.index + 1}</span>
                  <span class="config-identity mono">${escapeHtml(getConfigIdentity(item))}</span>
                </div>
                <div class="config-status-row">
                  ${runtimeBadge(item)}
                  ${renderRuntimeHighlights(item)}
                </div>
              </div>
              ${renderSwitchButton(item)}
            </div>
          </div>
          ${renderToggleMeta(item)}
        </summary>
        <div class="config-content">
          <div class="config-actions-row">
            <div class="config-runtime-line">${escapeHtml(formatRuntimeSummary(item))}</div>
            <div class="config-button-group">
              ${renderRefreshTokenButton(item)}
              <button class="button danger inline-danger" type="button" data-action="delete-config" data-index="${item.index}">删除</button>
            </div>
          </div>
        </div>
      </details>
    `).join('')}
  </div>`;
}

function renderSnapshot(data) {
  snapshot = data;
  const apikeys = Array.isArray(data?.apikeys) ? data.apikeys : [];

  if (apikeys.length > 0) {
    apiKeyStatusBadge.className = 'badge ok';
    apiKeyStatusBadge.textContent = `已配置 ${apikeys.length} 个 apikey`;
  } else {
    apiKeyStatusBadge.className = 'badge warn';
    apiKeyStatusBadge.textContent = '未配置 apikey';
  }

  renderApiKeys(apikeys);
  renderCards(data);
}

async function loadSnapshot(message = '') {
  try {
    const data = await requestJson('/admin/api/configs');
    renderSnapshot(data);
    setConnectionBadge('ok', '连接正常');
    setMessage(message ? 'info' : '', message);
  } catch (error) {
    if (error.status === 401) {
      setConnectionBadge('warn', '鉴权失败');
      apiKeyStatusBadge.className = 'badge warn';
      apiKeyStatusBadge.textContent = 'auth_token 无效';
      apiKeysListEl.innerHTML = '<div class="empty">当前管理地址缺少或带错 auth_token。</div>';
      cardsEl.innerHTML = '<div class="empty">当前管理地址缺少或带错 auth_token。</div>';
      setMessage('error', '当前管理地址缺少或带错 auth_token，请更新插件设置。');
      return;
    }

    setConnectionBadge('warn', '连接失败');
    cardsEl.innerHTML = `<div class="empty">${escapeHtml(error.message)}</div>`;
    apiKeysListEl.innerHTML = '<div class="empty">当前未能读取 apikey 列表。</div>';
    setMessage('error', error.message);
  }
}

async function addConfig() {
  const configItem = buildConfigItemFromInputs();
  const configMode = getSelectedConfigMode();
  const result = await requestJson('/admin/api/configs', {
    method: 'POST',
    body: JSON.stringify({
      raw_json: JSON.stringify(configItem),
      config_type: configMode
    })
  });

  clearConfigForm();
  renderSnapshot(result);
  setMessage('info', '配置项已写入配置文件。');
}

async function addApiKey() {
  const result = await requestJson('/admin/api/apikeys', {
    method: 'POST'
  });

  renderSnapshot(result);
  setMessage('info', `已新增 apikey: ${result.generated_apikey}`);
}

async function deleteApiKey(index) {
  const result = await requestJson(`/admin/api/apikeys/${index}`, {
    method: 'DELETE'
  });

  renderSnapshot(result);
  setMessage('info', 'apikey 已删除。');
}

async function deleteConfig(index) {
  const result = await requestJson(`/admin/api/configs/${index}`, {
    method: 'DELETE'
  });

  renderSnapshot(result);
  setMessage('info', '配置项已删除并热重载。');
}

async function activateConfig(index) {
  const result = await requestJson(`/admin/api/configs/${index}/switch-runtime`, {
    method: 'POST'
  });

  renderSnapshot(result);
  setMessage('info', '已切换当前使用配置。');
}

async function refreshConfigToken(index) {
  const result = await requestJson(`/admin/api/configs/${index}/refresh-token`, {
    method: 'POST'
  });

  renderSnapshot(result);
  setMessage('info', 'Token 已刷新并写回配置。');
}

async function startService() {
  await requestJson('/admin/api/start-service', {
    method: 'POST'
  });

  setMessage('info', '启动命令已触发。');
}

async function restartService() {
  await requestJson('/admin/api/restart-service', {
    method: 'POST'
  });

  setMessage('info', '重启命令已触发。');
}

function openAdminPage() {
  const adminUrl = buildUrl('/admin/configs');
  if (globalThis.chrome?.tabs?.create) {
    globalThis.chrome.tabs.create({ url: adminUrl });
    return;
  }

  window.open(adminUrl, '_blank', 'noopener');
}

function bindBusy(button, task) {
  return async () => {
    button.disabled = true;
    try {
      await task();
    } catch (error) {
      setMessage('error', error.message);
    } finally {
      button.disabled = false;
    }
  };
}

saveSettingsButton.addEventListener('click', bindBusy(saveSettingsButton, async () => {
  await saveSettings();
  await loadSnapshot('设置已保存并刷新。');
}));

refreshButton.addEventListener('click', bindBusy(refreshButton, async () => {
  await loadSnapshot('已刷新配置状态。');
}));

openAdminButton.addEventListener('click', () => {
  openAdminPage();
});

startServiceButton.addEventListener('click', bindBusy(startServiceButton, async () => {
  await startService();
}));

restartServiceButton.addEventListener('click', bindBusy(restartServiceButton, async () => {
  await restartService();
}));

addApiKeyButton.addEventListener('click', bindBusy(addApiKeyButton, async () => {
  await addApiKey();
}));

addConfigButton.addEventListener('click', bindBusy(addConfigButton, async () => {
  await addConfig();
}));

document.querySelectorAll('input[name="configMode"]').forEach(input => {
  input.addEventListener('change', updateConfigMode);
});

document.addEventListener('click', async event => {
  const refreshConfigTokenButton = event.target.closest('[data-action="refresh-config-token"]');
  if (refreshConfigTokenButton) {
    event.preventDefault();
    refreshConfigTokenButton.disabled = true;
    try {
      await refreshConfigToken(refreshConfigTokenButton.dataset.index);
    } catch (error) {
      setMessage('error', error.message);
    } finally {
      refreshConfigTokenButton.disabled = false;
    }
    return;
  }

  const switchConfigButton = event.target.closest('[data-action="switch-config"]');
  if (switchConfigButton) {
    event.preventDefault();
    event.stopPropagation();
    switchConfigButton.disabled = true;
    try {
      await activateConfig(switchConfigButton.dataset.index);
    } catch (error) {
      setMessage('error', error.message);
    } finally {
      switchConfigButton.disabled = false;
    }
    return;
  }

  const deleteApiKeyButton = event.target.closest('[data-action="delete-apikey"]');
  if (deleteApiKeyButton) {
    if (!window.confirm('确认删除这个 apikey 吗？')) {
      return;
    }

    deleteApiKeyButton.disabled = true;
    try {
      await deleteApiKey(deleteApiKeyButton.dataset.index);
    } catch (error) {
      setMessage('error', error.message);
    } finally {
      deleteApiKeyButton.disabled = false;
    }
    return;
  }

  const deleteConfigButton = event.target.closest('[data-action="delete-config"]');
  if (!deleteConfigButton) {
    return;
  }

  if (!window.confirm('确认删除这个配置项吗？')) {
    return;
  }

  deleteConfigButton.disabled = true;
  try {
    await deleteConfig(deleteConfigButton.dataset.index);
  } catch (error) {
    setMessage('error', error.message);
  } finally {
    deleteConfigButton.disabled = false;
  }
});

async function bootstrap() {
  try {
    await loadSettings();
    updateConfigMode();
    await loadSnapshot();
  } catch (error) {
    setConnectionBadge('warn', '初始化失败');
    setMessage('error', error.message);
  }
}

bootstrap();
