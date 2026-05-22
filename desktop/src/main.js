(function () {
  const panel = document.querySelector('#bootPanel');
  const eyebrow = document.querySelector('.eyebrow');
  const headline = document.querySelector('#headline');
  const message = document.querySelector('#message');
  const actions = document.querySelector('#actions');
  const retryBtn = document.querySelector('#retryBtn');
  const logBtn = document.querySelector('#logBtn');
  const revealBtn = document.querySelector('#revealBtn');
  const logOutput = document.querySelector('#logOutput');
  const setupForm = document.querySelector('#setupForm');
  const setupSubmitBtn = document.querySelector('#setupSubmitBtn');
  const servicePortInput = document.querySelector('#servicePortInput');
  const proxyEnabledInput = document.querySelector('#proxyEnabledInput');
  const proxyPortInput = document.querySelector('#proxyPortInput');
  const apikeyEnabledInput = document.querySelector('#apikeyEnabledInput');
  const progress = document.querySelector('#progress');

  function invoke(command, args) {
    const api = window.__TAURI__?.core;
    if (!api?.invoke) {
      throw new Error('请在 Airouter 桌面应用中打开');
    }
    return api.invoke(command, args);
  }

  function showLoading(text = '启动本地服务') {
    panel.dataset.state = 'loading';
    eyebrow.textContent = '正在打开配置页';
    headline.textContent = text;
    message.textContent = '服务就绪后会直接进入管理配置页面。';
    actions.hidden = true;
    setupForm.hidden = true;
    logOutput.hidden = true;
    progress.hidden = false;
  }

  function showError(error) {
    panel.dataset.state = 'error';
    eyebrow.textContent = '启动遇到问题';
    headline.textContent = '没有打开配置页';
    message.textContent = String(error || '本地服务启动失败，请查看最近日志。');
    actions.hidden = false;
    setupForm.hidden = true;
    progress.hidden = true;
  }

  function showSetup(status) {
    panel.dataset.state = 'setup';
    eyebrow.textContent = '首次配置';
    headline.textContent = '先完成初始配置';
    message.textContent = status?.message || '检测到运行目录中还没有 openai.json，保存配置后会继续启动并进入管理页面。';
    actions.hidden = true;
    setupForm.hidden = false;
    logOutput.hidden = true;
    progress.hidden = true;
  }

  function normalizePort(input, fallback) {
    const value = String(input.value || '').trim();
    if (!value) {
      return fallback;
    }

    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`${input.labels?.[0]?.textContent || '端口'}必须是 1-65535 之间的数字`);
    }

    return port;
  }

  function generateApiKey() {
    const bytes = new Uint8Array(24);
    window.crypto.getRandomValues(bytes);
    return `sk-airouter-${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  function updateSetupControls() {
    proxyPortInput.disabled = !proxyEnabledInput.checked;
  }

  async function submitSetup(event) {
    event.preventDefault();

    try {
      setupSubmitBtn.disabled = true;
      headline.textContent = '正在写入配置';
      message.textContent = '配置保存后会自动启动本地服务。';

      await invoke('initialize_config', {
        request: {
          servicePort: normalizePort(servicePortInput, 3009),
          proxyEnabled: proxyEnabledInput.checked,
          proxyPort: proxyEnabledInput.checked ? normalizePort(proxyPortInput, 7890) : null,
          apikeyEnabled: apikeyEnabledInput.checked,
          apikey: apikeyEnabledInput.checked ? generateApiKey() : null,
        },
      });

      showLoading('启动本地服务');
      await invoke('show_config_page');
    } catch (error) {
      showSetup({ message: String(error) });
    } finally {
      setupSubmitBtn.disabled = false;
    }
  }

  async function retry() {
    showLoading('重新连接配置页');
    try {
      await invoke('show_config_page');
    } catch (error) {
      showError(error);
    }
  }

  async function showLogs() {
    try {
      const logs = await invoke('read_recent_logs', { limit: 120 });
      logOutput.textContent = logs || '暂无日志';
    } catch (error) {
      logOutput.textContent = String(error);
    }
    logOutput.hidden = false;
  }

  retryBtn.addEventListener('click', retry);
  logBtn.addEventListener('click', showLogs);
  revealBtn.addEventListener('click', () => invoke('reveal_runtime_dir').catch(showError));
  proxyEnabledInput.addEventListener('change', updateSetupControls);
  setupForm.addEventListener('submit', submitSetup);

  updateSetupControls();

  async function initializeBootState() {
    const status = await invoke('get_status');
    if (!status.hasConfig) {
      showSetup(status);
    }
  }

  Promise.all([
    window.__TAURI__?.event?.listen('airouter-startup-error', (event) => showError(event.payload)),
    window.__TAURI__?.event?.listen('airouter-config-missing', (event) => showSetup(event.payload)),
    initializeBootState(),
  ].filter(Boolean)).catch(showError);

  window.setTimeout(() => {
    if (panel.dataset.state === 'loading') {
      headline.textContent = '仍在等待本地服务';
      message.textContent = '如果长时间停留在这里，可以重新进入配置页或查看日志。';
      actions.hidden = false;
      progress.hidden = true;
    }
  }, 12000);
})();
