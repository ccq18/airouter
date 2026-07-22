(function () {
  const STARTUP_UPDATE_CHECK_TIMEOUT_MS = 5000;
  const panel = document.querySelector('#bootPanel');
  const eyebrow = document.querySelector('.eyebrow');
  const headline = document.querySelector('#headline');
  const message = document.querySelector('#message');
  const actions = document.querySelector('#actions');
  const retryBtn = document.querySelector('#retryBtn');
  const logBtn = document.querySelector('#logBtn');
  const revealBtn = document.querySelector('#revealBtn');
  const updateCheckBtn = document.querySelector('#updateCheckBtn');
  const updateToast = document.querySelector('#updateToast');
  const updateDialog = document.querySelector('#updateDialog');
  const updateCloseBtn = document.querySelector('#updateCloseBtn');
  const updateLaterBtn = document.querySelector('#updateLaterBtn');
  const updateInstallBtn = document.querySelector('#updateInstallBtn');
  const updateVersionText = document.querySelector('#updateVersionText');
  const updateDateRow = document.querySelector('#updateDateRow');
  const updateDateText = document.querySelector('#updateDateText');
  const updateNotes = document.querySelector('#updateNotes');
  const updateProgressPanel = document.querySelector('#updateProgressPanel');
  const updateProgressMessage = document.querySelector('#updateProgressMessage');
  const updateProgressPercent = document.querySelector('#updateProgressPercent');
  const updateProgressTrack = document.querySelector('#updateProgressTrack');
  const updateProgressFill = document.querySelector('#updateProgressFill');
  const logOutput = document.querySelector('#logOutput');
  const setupForm = document.querySelector('#setupForm');
  const setupSubmitBtn = document.querySelector('#setupSubmitBtn');
  const servicePortInput = document.querySelector('#servicePortInput');
  const proxyEnabledInput = document.querySelector('#proxyEnabledInput');
  const proxyPortInput = document.querySelector('#proxyPortInput');
  const apikeyEnabledInput = document.querySelector('#apikeyEnabledInput');
  const progress = document.querySelector('#progress');
  let updateBusy = false;
  let startupServicePromise = null;
  let shouldNavigateAfterUpdate = false;

  function invoke(command, args) {
    const api = window.__TAURI__?.core;
    if (!api?.invoke) {
      throw new Error('请在 Airouter 桌面应用中打开');
    }
    return api.invoke(command, args);
  }

  function setUpdateBusy(nextBusy) {
    updateBusy = nextBusy;
    updateCheckBtn.disabled = nextBusy;
    updateCloseBtn.disabled = nextBusy;
    updateLaterBtn.disabled = nextBusy;
    updateInstallBtn.disabled = nextBusy;
  }

  function showUpdateToast(message, isError = false) {
    updateToast.textContent = message;
    updateToast.className = `update-toast${isError ? ' error' : ''}`;
    updateToast.hidden = false;
    window.clearTimeout(showUpdateToast.timer);
    showUpdateToast.timer = window.setTimeout(() => {
      updateToast.hidden = true;
    }, 2800);
  }

  function formatDate(value) {
    if (!value) {
      return '';
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
  }

  function resetUpdateProgress() {
    updateProgressPanel.hidden = true;
    updateProgressMessage.textContent = '准备下载更新';
    updateProgressPercent.textContent = '';
    updateProgressFill.style.width = '0%';
    updateProgressTrack.classList.remove('indeterminate');
    updateProgressTrack.removeAttribute('aria-valuenow');
  }

  function showUpdateDialog(update) {
    updateVersionText.textContent = update.version || '-';
    const formattedDate = formatDate(update.date);
    updateDateRow.hidden = !formattedDate;
    updateDateText.textContent = formattedDate || '-';
    updateNotes.textContent = (update.body || '').trim() || '暂无更新说明。';
    resetUpdateProgress();
    updateDialog.hidden = false;
  }

  function closeUpdateDialog() {
    if (updateBusy) {
      return;
    }
    updateDialog.hidden = true;
    resetUpdateProgress();
    if (shouldNavigateAfterUpdate) {
      shouldNavigateAfterUpdate = false;
      finishConfiguredStartup().catch(showError);
    }
  }

  function renderUpdateProgress(payload = {}) {
    updateProgressPanel.hidden = false;
    updateProgressMessage.textContent = payload.message || '正在更新';
    if (Number.isFinite(payload.percent)) {
      const percent = Math.max(0, Math.min(100, Number(payload.percent)));
      updateProgressPercent.textContent = `${percent}%`;
      updateProgressFill.style.width = `${percent}%`;
      updateProgressTrack.classList.remove('indeterminate');
      updateProgressTrack.setAttribute('aria-valuenow', String(percent));
    } else {
      updateProgressPercent.textContent = '';
      updateProgressFill.style.width = '0%';
      updateProgressTrack.classList.add('indeterminate');
      updateProgressTrack.removeAttribute('aria-valuenow');
    }
  }

  async function checkForUpdates({
    notifyNoUpdate = true,
    notifyError = true,
    acceptResult = () => true,
  } = {}) {
    if (updateBusy) {
      return false;
    }

    try {
      setUpdateBusy(true);
      updateCheckBtn.textContent = '检查中';
      const update = await invoke('check_for_updates');
      if (!acceptResult()) {
        return false;
      }
      if (update && update.available) {
        showUpdateDialog(update);
        return true;
      } else if (notifyNoUpdate) {
        showUpdateToast('当前已是最新版本');
      }
    } catch (error) {
      if (notifyError) {
        showUpdateToast(String(error), true);
      } else {
        console.warn('启动时检查更新失败', error);
      }
    } finally {
      updateCheckBtn.textContent = '检查更新';
      setUpdateBusy(false);
    }

    return false;
  }

  async function checkForUpdatesAtStartup() {
    let didTimeout = false;
    let timeoutId;
    const checkPromise = checkForUpdates({
      notifyNoUpdate: false,
      notifyError: false,
      acceptResult: () => !didTimeout,
    });
    const timeoutPromise = new Promise((resolve) => {
      timeoutId = window.setTimeout(() => {
        didTimeout = true;
        console.warn('启动时检查更新超时，继续进入管理页面');
        resolve(false);
      }, STARTUP_UPDATE_CHECK_TIMEOUT_MS);
    });

    try {
      return await Promise.race([checkPromise, timeoutPromise]);
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  async function installUpdate() {
    if (updateBusy) {
      return;
    }

    try {
      setUpdateBusy(true);
      renderUpdateProgress({ message: '准备下载更新' });
      await invoke('install_update');
    } catch (error) {
      showUpdateToast(String(error), true);
      renderUpdateProgress({ message: String(error) });
      setUpdateBusy(false);
    }
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
    progress.hidden = false;
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
  updateCheckBtn.addEventListener('click', () => checkForUpdates());
  updateCloseBtn.addEventListener('click', closeUpdateDialog);
  updateLaterBtn.addEventListener('click', closeUpdateDialog);
  updateInstallBtn.addEventListener('click', installUpdate);
  proxyEnabledInput.addEventListener('change', updateSetupControls);
  setupForm.addEventListener('submit', submitSetup);

  updateSetupControls();

  async function initializeBootState() {
    let status;
    try {
      status = await invoke('get_status');
    } catch (error) {
      showError(error);
      await checkForUpdates({ notifyNoUpdate: false, notifyError: false });
      return;
    }

    if (!status.hasConfig) {
      showSetup(status);
      await checkForUpdates({ notifyNoUpdate: false, notifyError: false });
      return;
    }

    startupServicePromise = invoke('start_service');
    startupServicePromise.catch(() => {});
    shouldNavigateAfterUpdate = await checkForUpdatesAtStartup();
    if (!shouldNavigateAfterUpdate) {
      await finishConfiguredStartup();
    }
  }

  async function finishConfiguredStartup() {
    const servicePromise = startupServicePromise;
    startupServicePromise = null;
    if (servicePromise) {
      await servicePromise;
    } else {
      await invoke('start_service');
    }
    await invoke('open_admin_window');
  }

  Promise.all([
    window.__TAURI__?.event?.listen('airouter-update-progress', (event) => renderUpdateProgress(event.payload)),
    initializeBootState(),
  ].filter(Boolean)).catch(showError);

  window.setTimeout(() => {
    if (panel.dataset.state === 'loading') {
      headline.textContent = '仍在等待本地服务';
      message.textContent = '如果长时间停留在这里，可以重新进入配置页或查看日志。';
      actions.hidden = false;
    }
  }, 12000);
})();
