(function attachRoutingAdmin(globalScope) {
  const PROTOCOLS = ['chat_completions', 'responses', 'messages'];
  const PROTOCOL_LABELS = {
    chat_completions: 'Chat Completions',
    responses: 'Responses',
    messages: 'Claude Messages',
  };
  const TOKEN_PRESETS = new Set(['chatgpt', 'claude']);
  const FALLBACK_PRESETS = [
    { id: 'chatgpt', label: 'ChatGPT / Codex', credential: 'token', default_base_url: 'https://chatgpt.com', protocols: ['responses'] },
    { id: 'opencode-go', label: 'OpenCode Go', credential: 'apikey', default_base_url: 'https://opencode.ai/inference/go', protocols: [...PROTOCOLS] },
    { id: 'opencode-zen', label: 'OpenCode Zen', credential: 'apikey', default_base_url: 'https://opencode.ai/inference', protocols: [...PROTOCOLS] },
    { id: 'openrouter', label: 'OpenRouter', credential: 'apikey', default_base_url: 'https://openrouter.ai/api/v1', protocols: ['chat_completions', 'responses'] },
    { id: 'glm-cn', label: 'GLM Coding Plan 中国', credential: 'apikey', default_base_url: 'https://open.bigmodel.cn/api/coding/paas/v4', protocols: ['chat_completions'] },
    { id: 'glm-global', label: 'GLM Coding Plan 国际', credential: 'apikey', default_base_url: 'https://api.z.ai/api/coding/paas/v4', protocols: ['chat_completions'] },
    { id: 'claude', label: 'Claude OAuth', credential: 'token', default_base_url: 'https://api.anthropic.com', protocols: ['messages'] },
    { id: 'custom', label: '自定义接口', credential: 'apikey', default_base_url: '', protocols: [...PROTOCOLS] },
  ];

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function protocolLabel(protocol) {
    return PROTOCOL_LABELS[protocol] || protocol;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function providerIdForConfig(config) {
    if (config && config.preset) {
      return config.preset;
    }
    if (config && config.type === 'token') {
      return 'chatgpt';
    }
    if (config && config.type === 'claude_token') {
      return 'claude';
    }
    return 'custom';
  }

  function findPreset(presets, presetId) {
    return (Array.isArray(presets) && presets.length ? presets : FALLBACK_PRESETS)
      .find(preset => preset.id === presetId) || null;
  }

  function getPresetLabel(presets, presetId) {
    const preset = findPreset(presets, presetId);
    return preset ? preset.label : (presetId || '自定义接口');
  }

  function statusLabel(reason) {
    const labels = {
      quota_unknown: '尚未读取额度', quota_available: '额度充足', quota_exhausted: '额度已耗尽',
      quota_unknown_probe: '等待首次请求验证', quota_probe_in_flight: '正在验证可用性',
      probe_success: '请求验证成功', health_cooldown: '暂时不可用，稍后重试',
      auth_failed: '凭证验证失败', permission_denied: '没有模型访问权限',
      model_unavailable: '模型暂不可用', config_disabled: '账号已停用',
      config_not_found: '账号已删除', model_not_supported: '模型不在支持列表',
      protocol_not_supported: '协议不兼容', entry_protocol_not_supported: '入口协议未启用',
      quota_unsupported: '此平台暂不支持额度查询', ok: '可用',
    };
    return labels[reason] || (/^[a-z_]+$/.test(reason || '') ? '暂时不可用' : reason || '');
  }

  function formatQuotaSummary(quota) {
    if (!quota || !quota.state || quota.state === 'unknown') {
      const detail = quota && quota.error
        ? String(quota.error).slice(0, 120)
        : (quota && quota.reason ? statusLabel(quota.reason).slice(0, 120) : '尚未读取额度');
      return { label: '额度未读取', tone: 'warn', detail };
    }

    const percentValues = (Array.isArray(quota.metrics) ? quota.metrics : [])
      .map(metric => metric && metric.remaining_percent)
      .filter(value => Number.isFinite(value));
    const percentText = percentValues.length ? `剩余 ${Math.min(...percentValues)}%` : '';

    if (quota.state === 'exhausted') {
      return {
        label: '额度已耗尽',
        tone: 'danger',
        detail: statusLabel(quota.reason) || '候选会自动使用下一项',
      };
    }

    return {
      label: percentText || '额度可用',
      tone: 'ok',
      detail: statusLabel(quota.reason),
    };
  }

  function createRoutingAdmin(options = {}) {
    const doc = options.document || globalScope.document;
    const windowScope = options.window || globalScope;
    if (!doc) {
      return null;
    }

    const el = id => doc.getElementById(id);
    const state = {
      upstreams: null,
      routes: null,
      currentView: 'accounts',
      editingUpstreamId: '',
      editingRouteId: '',
      formModels: [],
      formTargets: [],
      editingTargetIndex: null,
      discovery: null,
      pendingTokenImportFromAccount: false,
    };

    const dom = {
      preset: el('upstreamPresetSelect'),
      description: el('upstreamDescriptionInput'),
      enabled: el('upstreamEnabledInput'),
      baseUrl: el('upstreamBaseUrlInput'),
      apiKey: el('upstreamApiKeyInput'),
      apiKeyField: el('upstreamApiKeyField'),
      credentialPanel: el('upstreamCredentialPanel'),
      customEndpointField: el('customModelsEndpointField'),
      modelsEndpoint: el('upstreamModelsEndpointInput'),
      modelsEditor: el('upstreamModelsEditor'),
      addModel: el('upstreamAddModelButton'),
      discover: el('upstreamDiscoverModelsButton'),
      discoveryPanel: el('upstreamDiscoveryPanel'),
      saveUpstream: el('upstreamSaveButton'),
      resetUpstream: el('upstreamResetButton'),
      editHint: el('upstreamEditHint'),
      accountDialog: el('accountDialog'),
      accountDialogTitle: el('accountDialogTitle'),
      accountDialogEyebrow: el('accountDialogEyebrow'),
      upstreamTable: el('routingUpstreamsTable'),
      accountSummary: el('accountSummary'),
      routeModelId: el('routeModelIdInput'),
      routeMaxAttempts: el('routeMaxAttemptsInput'),
      targetsEditor: el('routeTargetsEditor'),
      targetEditorPane: el('routeTargetEditorPane'),
      addTarget: el('routeAddTargetButton'),
      saveRoute: el('routeSaveButton'),
      resetRoute: el('routeResetButton'),
      routeEditHint: el('routeEditHint'),
      routeDialog: el('routeDialog'),
      routeDialogTitle: el('routeDialogTitle'),
      routeDialogEyebrow: el('routeDialogEyebrow'),
      routesList: el('modelRoutesList'),
      revisionBadge: el('routesRevisionBadge'),
      message: el('message'),
      settingsDrawer: el('settingsDrawer'),
      tokenImportDialog: el('tokenImportDialog'),
      claudeDialog: el('claudeDialog'),
      legacyConfigsDialog: el('legacyConfigsDialog'),
    };

    if (!dom.preset || !dom.upstreamTable || !dom.targetsEditor) {
      return null;
    }

    const adminAuthToken = new URLSearchParams(windowScope.location.search).get('auth_token') || '';
    const requestUrl = globalScope.AirouterConfigAdmin && globalScope.AirouterConfigAdmin.buildRequestUrl
      ? path => globalScope.AirouterConfigAdmin.buildRequestUrl(path, {
        adminAuthToken,
        origin: windowScope.location.origin,
      })
      : path => path;

    function setMessage(type, text) {
      if (!dom.message) {
        return;
      }
      if (!text) {
        dom.message.className = 'message';
        dom.message.textContent = '';
        return;
      }
      dom.message.className = `message show ${type}`;
      dom.message.textContent = text;
    }

    function handleError(error) {
      const text = error && error.message ? error.message : String(error || '操作失败');
      if (dom.accountDialog && !dom.accountDialog.hidden && dom.editHint) {
        dom.editHint.textContent = text;
        dom.editHint.classList.add('is-error');
        return;
      }
      if (dom.routeDialog && !dom.routeDialog.hidden && dom.routeEditHint) {
        dom.routeEditHint.textContent = text;
        dom.routeEditHint.classList.add('is-error');
        return;
      }
      setMessage('error', text);
    }

    function setFormHint(element, text) {
      if (!element) {
        return;
      }
      element.textContent = text;
      element.classList.remove('is-error');
    }

    async function requestJson(path, requestOptions = {}) {
      const response = await windowScope.fetch(requestUrl(path), {
        ...requestOptions,
        headers: {
          'Content-Type': 'application/json',
          ...(requestOptions.headers || {}),
        },
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch (error) {
          payload = { error: { message: text } };
        }
      }
      if (!response.ok) {
        const message = payload?.error?.message || payload?.error?.details || payload?.details || `HTTP ${response.status}`;
        const error = new Error(message);
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    }

    function getPresets() {
      const presets = state.upstreams?.presets;
      return Array.isArray(presets) && presets.length ? presets : FALLBACK_PRESETS;
    }

    function getUpstreamConfigs() {
      return Array.isArray(state.upstreams?.configs) ? state.upstreams.configs : [];
    }

    function getRoutes() {
      return Array.isArray(state.routes?.models) ? state.routes.models : [];
    }

    function getPreset(presetId) {
      return findPreset(getPresets(), presetId);
    }

    function getAccountConfig(configId) {
      return getUpstreamConfigs().find(config => config.id === configId) || null;
    }

    function accountLabel(configId) {
      const config = getAccountConfig(configId);
      if (!config) {
        return configId || '未知上游';
      }
      return config.description || config.id || configId;
    }

    function isTokenPreset(preset) {
      return Boolean(preset && (preset.credential === 'token' || TOKEN_PRESETS.has(preset.id)));
    }

    function routeReferencesForModel(configId, modelId) {
      if (!configId || !modelId) {
        return [];
      }
      return getRoutes()
        .filter(route => (route.targets || []).some(target => target.config_id === configId && target.model === modelId))
        .map(route => route.id);
    }

    function routeReferencesForAccount(configId) {
      return getRoutes()
        .filter(route => (route.targets || []).some(target => target.config_id === configId))
        .map(route => route.id);
    }

    function syncBodyLock() {
      const open = [...doc.querySelectorAll('.dialog-layer, .drawer-layer')]
        .some(node => node && !node.hidden);
      doc.body.classList.toggle('modal-open', open);
    }

    function openLayer(id) {
      const layer = el(id);
      if (!layer) {
        return;
      }
      layer.hidden = false;
      syncBodyLock();
    }

    function closeLayer(id) {
      const layer = el(id);
      if (!layer) {
        return;
      }
      layer.hidden = true;
      if (id === 'tokenImportDialog') {
        state.pendingTokenImportFromAccount = false;
      }
      syncBodyLock();
    }

    function setSettingsTab(tab) {
      const target = tab === 'compat' ? 'compat' : 'general';
      doc.querySelectorAll('[data-settings-tab]').forEach(button => {
        button.setAttribute('aria-selected', String(button.dataset.settingsTab === target));
      });
      doc.querySelectorAll('[data-settings-panel]').forEach(panel => {
        panel.hidden = panel.dataset.settingsPanel !== target;
      });
    }

    function openSettings(tab = 'general') {
      setSettingsTab(tab);
      openLayer('settingsDrawer');
    }

    function closeSettings() {
      closeLayer('settingsDrawer');
    }

    function viewPath(view) {
      return view === 'routes' ? '/admin/configs/routes' : '/admin/configs/upstreams';
    }

    function viewFromLocation() {
      return /\/admin\/configs\/routes\/?$/.test(windowScope.location.pathname) ? 'routes' : 'accounts';
    }

    function viewMeta(view) {
      if (view === 'routes') {
        return {
          title: '模型路由',
          subtitle: '客户端模型 ID 可任意命名；候选按从上到下的顺序严格选择。',
        };
      }
      return {
        title: '上游账号',
        subtitle: '管理可用账号与它们允许调用的后端模型。编辑在独立面板中完成。',
      };
    }

    function setView(view, options = {}) {
      const nextView = view === 'routes' ? 'routes' : 'accounts';
      state.currentView = nextView;
      const meta = viewMeta(nextView);
      const title = el('currentPageTitle');
      const subtitle = el('currentPageSubtitle');
      if (title) {
        title.textContent = meta.title;
      }
      if (subtitle) {
        subtitle.textContent = meta.subtitle;
      }
      doc.querySelectorAll('[data-view]').forEach(section => {
        section.hidden = section.dataset.view !== nextView;
      });
      doc.querySelectorAll('[data-page-link]').forEach(link => {
        const active = (link.dataset.pageLink === 'routes' ? 'routes' : 'accounts') === nextView;
        link.classList.toggle('active', active);
        if (active) {
          link.setAttribute('aria-current', 'page');
        } else {
          link.removeAttribute('aria-current');
        }
      });
      if (options.push !== false && windowScope.location.pathname !== viewPath(nextView)) {
        const nextUrl = new URL(windowScope.location.href);
        nextUrl.pathname = viewPath(nextView);
        windowScope.history.pushState({ airouterView: nextView }, '', nextUrl.toString());
      }
    }

    function fillPresetOptions() {
      const current = dom.preset.value;
      dom.preset.innerHTML = getPresets().map(preset => (
        `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`
      )).join('');
      if (current && getPresets().some(preset => preset.id === current)) {
        dom.preset.value = current;
      }
    }

    function selectedAccountConfig() {
      return state.editingUpstreamId ? getAccountConfig(state.editingUpstreamId) : null;
    }

    function renderCredentialPanel(preset) {
      if (!dom.credentialPanel) {
        return;
      }
      if (!isTokenPreset(preset)) {
        dom.credentialPanel.hidden = true;
        dom.credentialPanel.innerHTML = '';
        return;
      }

      const config = selectedAccountConfig();
      const hasCredentials = Boolean(config && config.has_credentials);
      const isClaude = preset.id === 'claude';
      const title = isClaude ? 'Claude 登录态' : 'ChatGPT / Codex 登录态';
      const detail = isClaude
        ? '通过现有 Claude 登录命令写入本地登录态，凭证不会回显。'
        : '通过 AuthSession 或 Sub2API Agent Identity 导入，凭证不会回显。';
      dom.credentialPanel.hidden = false;
      dom.credentialPanel.innerHTML = `
        <div class="credential-panel-copy">
          <strong>${escapeHtml(title)}${hasCredentials ? ' <span class="credential-state">已保存凭证</span>' : ''}</strong>
          <span>${escapeHtml(detail)}</span>
        </div>
        <div class="actions">
          <button class="secondary" type="button" data-action="${isClaude ? 'open-claude-manager' : 'open-token-import'}">${isClaude ? '打开 Claude 登录' : '导入登录态'}</button>
        </div>
      `;
    }

    function updatePresetFields() {
      const preset = getPreset(dom.preset.value) || FALLBACK_PRESETS[FALLBACK_PRESETS.length - 1];
      if (!state.editingUpstreamId && preset.default_base_url) {
        dom.baseUrl.value = preset.default_base_url;
      }
      dom.baseUrl.placeholder = preset.default_base_url || 'https://...';
      if (dom.customEndpointField) {
        dom.customEndpointField.hidden = preset.id !== 'custom';
      }
      const token = isTokenPreset(preset);
      if (dom.apiKeyField) {
        dom.apiKeyField.hidden = token;
      }
      dom.apiKey.disabled = token;
      dom.apiKey.placeholder = token ? '由登录态导入管理' : '留空表示编辑时不改凭证';
      renderCredentialPanel(preset);
      if (state.editingUpstreamId) {
        dom.saveUpstream.textContent = '保存修改';
      } else if (token) {
        dom.saveUpstream.textContent = '导入登录态以新增';
      } else {
        dom.saveUpstream.textContent = '新增上游账号';
      }
      const presetHint = el('upstreamPresetHint');
      if (presetHint) {
        presetHint.textContent = ({'glm-cn':'自动读取推理额度窗口，工具额度不影响模型转发。','glm-global':'自动读取推理额度窗口，工具额度不影响模型转发。','opencode-go':'自动读取套餐额度；每个会话保持稳定的上游连接标识。','openrouter':'使用同一转发凭证读取账户余额和 Key 限额。','opencode-zen':'支持模型转发和同步；平台尚未提供已验证的普通 Key 余额接口。'}[preset.id]) || (preset.id === 'custom'
          ? '自定义接口需要维护 Base URL 和模型列表接口。'
          : '内置平台的接口地址与模型发现规则由系统维护。');
      }
    }

    function renderModelEditor() {
      if (!dom.modelsEditor) {
        return;
      }
      dom.modelsEditor.innerHTML = state.formModels.map((model, index) => {
        const protocols = Array.isArray(model.protocols) ? model.protocols : [];
        return `
          <div class="model-row" data-model-index="${index}">
            <div class="model-row-main">
              <input type="text" data-model-field="id" value="${escapeHtml(model.id || '')}" placeholder="后端模型 ID" aria-label="后端模型 ID ${index + 1}">
            </div>
            <button class="danger" type="button" data-remove-model="${index}">删除</button>
            <details class="advanced-settings">
              <summary>协议：${escapeHtml(protocols.map(protocolLabel).join('、') || '未选择')}</summary>
              <div class="advanced-settings-body">
                <div class="model-protocol-options">
                  ${PROTOCOLS.map(protocol => `
                    <label>
                      <input type="checkbox" data-model-protocol="${protocol}" ${protocols.includes(protocol) ? 'checked' : ''}>
                      ${escapeHtml(protocolLabel(protocol))}
                    </label>
                  `).join('')}
                </div>
              </div>
            </details>
          </div>
        `;
      }).join('') || '<div class="empty">尚未配置模型。可以从平台同步，或手动添加后端模型 ID。</div>';
    }

    function collectModelsFromEditor() {
      const rows = dom.modelsEditor ? [...dom.modelsEditor.querySelectorAll('[data-model-index]')] : [];
      return rows.map(row => {
        const index = Number(row.dataset.modelIndex);
        const original = state.formModels[index] || {};
        const protocols = [...row.querySelectorAll('[data-model-protocol]:checked')].map(input => input.dataset.modelProtocol);
        const idInput = row.querySelector('[data-model-field="id"]');
        const model = {
          ...original,
          id: normalizeText(idInput ? idInput.value : ''),
          protocols,
        };
        delete model.source;
        return model;
      });
    }

    function syncModelsFromEditor() {
      state.formModels = collectModelsFromEditor();
      return state.formModels;
    }

    function defaultPresetId() {
      return getPreset('glm-cn') ? 'glm-cn' : getPresets()[0]?.id || 'custom';
    }

    function resetUpstreamForm(options = {}) {
      state.editingUpstreamId = '';
      state.formModels = [];
      state.discovery = null;
      dom.description.value = '';
      dom.enabled.checked = true;
      dom.apiKey.value = '';
      dom.modelsEndpoint.value = '';
      dom.discoveryPanel.hidden = true;
      dom.discoveryPanel.innerHTML = '';
      setFormHint(dom.editHint, '');
      if (dom.preset.options.length) {
        dom.preset.value = defaultPresetId();
      }
      updatePresetFields();
      dom.baseUrl.value = getPreset(dom.preset.value)?.default_base_url || '';
      renderModelEditor();
      if (options.close !== false) {
        closeLayer('accountDialog');
      }
    }

    function openAccount(configId = '', options = {}) {
      state.discovery = null;
      if (configId) {
        const config = getAccountConfig(configId);
        if (!config) {
          handleError(new Error('上游账号不存在，请刷新后重试'));
          return;
        }
        state.editingUpstreamId = config.id;
        state.formModels = cloneJson(Array.isArray(config.models) ? config.models : []);
        dom.preset.value = providerIdForConfig(config);
        dom.description.value = config.description || '';
        dom.enabled.checked = config.enabled !== false;
        dom.baseUrl.value = config.base_url || '';
        dom.apiKey.value = '';
        dom.modelsEndpoint.value = config.models_endpoint || '';
        dom.discoveryPanel.hidden = true;
        dom.discoveryPanel.innerHTML = '';
        setFormHint(dom.editHint, `正在编辑 ${config.id}；凭证留空表示保留原值。`);
        if (dom.accountDialogTitle) {
          dom.accountDialogTitle.textContent = '编辑上游';
        }
        if (dom.accountDialogEyebrow) {
          dom.accountDialogEyebrow.textContent = 'Account / Edit';
        }
      } else {
        state.editingUpstreamId = '';
        state.formModels = [];
        dom.preset.value = defaultPresetId();
        dom.description.value = '';
        dom.enabled.checked = true;
        dom.apiKey.value = '';
        dom.modelsEndpoint.value = '';
        dom.baseUrl.value = getPreset(dom.preset.value)?.default_base_url || '';
        dom.discoveryPanel.hidden = true;
        dom.discoveryPanel.innerHTML = '';
        setFormHint(dom.editHint, '新增账号先选择平台；ChatGPT / Claude 通过登录态导入入口新增。');
        if (dom.accountDialogTitle) {
          dom.accountDialogTitle.textContent = '添加上游';
        }
        if (dom.accountDialogEyebrow) {
          dom.accountDialogEyebrow.textContent = 'Account / New';
        }
      }
      updatePresetFields();
      renderModelEditor();
      openLayer('accountDialog');
      if (options.sync && state.editingUpstreamId) {
        windowScope.setTimeout(() => {
          void discoverModels().catch(handleError);
        }, 0);
      } else if (dom.description) {
        dom.description.focus();
      }
    }

    function accountStatus(config) {
      if (config.enabled === false) {
        return { label: '已停用', tone: 'warn' };
      }
      if (!config.has_credentials) {
        return { label: '待导入凭证', tone: 'warn' };
      }
      return { label: '已启用', tone: 'ok' };
    }

    function renderQuotaCell(quota) {
      const summary = formatQuotaSummary(quota);
      return `
        <span class="route-status-chip ${summary.tone}">${escapeHtml(summary.label)}</span>
        ${summary.detail ? `<span class="quota-detail">${escapeHtml(summary.detail)}</span>` : ''}
      `;
    }

    function renderAccountCard(config, index) {
      const providerId = providerIdForConfig(config);
      const provider = getPresetLabel(getPresets(), providerId);
      const status = accountStatus(config);
      const models = Array.isArray(config.models) ? config.models : [];
      const refs = routeReferencesForAccount(config.id);
      const modelTags = models.map(model => {
        const protocols = Array.isArray(model.protocols) ? model.protocols.join(' / ') : '';
        return `<span class="tag" title="${escapeHtml(protocols)}">${escapeHtml(model.id)}</span>`;
      }).join('');
      return `
        <article class="account-card${config.enabled === false ? ' is-disabled' : ''}" data-config-id="${escapeHtml(config.id)}">
          <div class="account-card-head">
            <div class="account-identity">
              <span class="account-ordinal">${String(index + 1).padStart(2, '0')}</span>
              <div>
                <h3 title="${escapeHtml(config.description || config.id)}">${escapeHtml(config.description || config.id)}</h3>
                <span class="account-provider">${escapeHtml(provider)}</span>
              </div>
            </div>
            <span class="status-dot ${status.tone}">${escapeHtml(status.label)}</span>
          </div>
          <div class="account-models">
            <span class="account-models-label">支持模型 · ${models.length}</span>
            <div class="tag-list">${modelTags || '<span class="tag-more">尚未配置模型</span>'}</div>
          </div>
          <div class="account-facts">
            <div>
              <span class="fact-label">额度 / 状态</span>
              <div class="fact-value quota-line">${renderQuotaCell(config.quota)}</div>
            </div>
            <div>
              <span class="fact-label">路由引用</span>
              <div class="fact-value">${refs.length ? refs.map(id => `<span class="tag">${escapeHtml(id)}</span>`).join('') : '<span class="quota-detail">尚未被引用</span>'}</div>
            </div>
          </div>
          <div class="account-actions">
            <button class="secondary" type="button" data-edit-upstream="${escapeHtml(config.id)}">编辑</button>
            <button class="secondary" type="button" data-sync-account="${escapeHtml(config.id)}">同步模型</button>
            <button class="secondary" type="button" data-refresh-quota="${escapeHtml(config.id)}">刷新额度</button>
            <button class="danger" type="button" data-delete-upstream="${escapeHtml(config.id)}">删除</button>
          </div>
        </article>
      `;
    }

    function renderUpstreams() {
      const configs = getUpstreamConfigs();
      if (dom.accountSummary) {
        const enabled = configs.filter(config => config.enabled !== false).length;
        const modelCount = configs.reduce((sum, config) => sum + (Array.isArray(config.models) ? config.models.length : 0), 0);
        dom.accountSummary.innerHTML = configs.length
          ? `<span>共 ${configs.length} 个上游</span><span>${enabled} 个启用</span><span>${modelCount} 个可用后端模型</span>`
          : '<span>尚未添加任何上游账号</span>';
      }
      if (!configs.length) {
        dom.upstreamTable.innerHTML = `
          <div class="empty-state">
            <strong>还没有上游账号</strong>
            <p>先添加一个平台账号，再为它维护可被路由使用的后端模型。ChatGPT / Claude 通过登录态导入。</p>
            <button class="primary" type="button" data-action="new-account">＋ 添加上游</button>
          </div>
        `;
        return;
      }
      dom.upstreamTable.innerHTML = configs.map(renderAccountCard).join('');
    }

    function localDiscoveryDiff() {
      if (!state.discovery) {
        return null;
      }
      const local = state.formModels
        .map(model => ({ id: normalizeText(model.id), protocols: [...(model.protocols || [])] }))
        .filter(model => model.id);
      const remote = (Array.isArray(state.discovery.discovered) ? state.discovery.discovered : [])
        .map(model => typeof model === 'string'
          ? { id: model, protocols: [] }
          : { id: normalizeText(model.id), protocols: [...(model.protocols || [])] })
        .filter(model => model.id);
      const localIds = new Set(local.map(model => model.id));
      const remoteIds = new Set(remote.map(model => model.id));
      return {
        added: remote.filter(model => !localIds.has(model.id)),
        removed: local.filter(model => !remoteIds.has(model.id)),
        changed: local.map(model => {
          const match = remote.find(item => item.id === model.id);
          if (!match) {
            return null;
          }
          const left = [...model.protocols].sort().join(',');
          const right = [...match.protocols].sort().join(',');
          return left === right ? null : { id: model.id, local: model.protocols, remote: match.protocols };
        }).filter(Boolean),
      };
    }

    function renderDiscovery() {
      if (!dom.discoveryPanel) {
        return;
      }
      if (!state.discovery) {
        dom.discoveryPanel.hidden = true;
        dom.discoveryPanel.innerHTML = '';
        return;
      }
      const diff = localDiscoveryDiff();
      const addedHtml = diff.added.length ? diff.added.map((model, index) => `
        <label class="sync-row">
          <input type="checkbox" data-sync-new="${index}" value="${escapeHtml(model.id)}" checked>
          <code>${escapeHtml(model.id)}</code>
          <span class="sync-tag route-status-chip ok">接口新增</span>
        </label>
      `).join('') : '<div class="sync-row"><span class="empty">没有新增模型</span></div>';
      const removedHtml = diff.removed.length ? diff.removed.map(model => {
        const refs = routeReferencesForModel(state.editingUpstreamId, model.id);
        return `
          <label class="sync-row">
            <input type="checkbox" data-sync-remove value="${escapeHtml(model.id)}" ${refs.length ? 'disabled' : ''}>
            <code>${escapeHtml(model.id)}</code>
            <span class="sync-tag route-status-chip warn">${refs.length
              ? `被路由 ${escapeHtml(refs.join('、'))} 引用，需先处理`
              : '接口未返回，默认保留'}</span>
          </label>
        `;
      }).join('') : '<div class="sync-row"><span class="empty">没有仅存在于本地的模型</span></div>';
      const changedHtml = diff.changed.length ? `
        <details class="advanced-settings" style="margin-top:8px">
          <summary>${diff.changed.length} 个模型的协议与接口不同（合并时保留本地设置）</summary>
          <div class="advanced-settings-body">
            ${diff.changed.map(change => `<div class="sync-row"><code>${escapeHtml(change.id)}</code><span class="sync-tag">本地 ${escapeHtml(change.local.join(' / ') || '-')} · 接口 ${escapeHtml(change.remote.join(' / ') || '-')}</span></div>`).join('')}
          </div>
        </details>
      ` : '';
      dom.discoveryPanel.hidden = false;
      dom.discoveryPanel.innerHTML = `
        <div class="form-section-head">
          <div><strong>同步差异预览</strong><p class="field-hint">先合并到编辑草稿，再点保存才会写入配置。</p></div>
          <span class="badge note">${(state.discovery.discovered || []).length} 个接口模型</span>
        </div>
        <div style="margin-top:8px">${addedHtml}</div>
        <div>${removedHtml}</div>
        ${changedHtml}
        <div class="actions" style="margin-top:10px">
          <button class="primary" type="button" data-action="merge-discovery">合并到草稿</button>
          <button class="secondary" type="button" data-action="dismiss-discovery">取消同步</button>
        </div>
      `;
    }

    function mergeDiscovery() {
      if (!state.discovery) {
        return;
      }
      syncModelsFromEditor();
      const added = new Set([...dom.discoveryPanel.querySelectorAll('[data-sync-new]:checked')]
        .map(input => input.value));
      const removed = new Set([...dom.discoveryPanel.querySelectorAll('[data-sync-remove]:checked')]
        .map(input => input.value));
      const remoteModels = (state.discovery.discovered || []).map(model => typeof model === 'string'
        ? { id: model, protocols: [] }
        : model);
      state.formModels = state.formModels.filter(model => !removed.has(normalizeText(model.id)));
      remoteModels.forEach(remote => {
        if (!added.has(remote.id)) {
          return;
        }
        if (!state.formModels.some(model => normalizeText(model.id) === remote.id)) {
          state.formModels.push({
            id: remote.id,
            protocols: Array.isArray(remote.protocols) && remote.protocols.length
              ? [...remote.protocols]
              : [...(getPreset(dom.preset.value)?.protocols || ['chat_completions'])],
          });
        }
      });
      state.discovery = null;
      renderDiscovery();
      renderModelEditor();
      setMessage('info', '同步差异已合并到编辑草稿；保存上游后才会生效。');
    }

    async function discoverModels() {
      const preset = getPreset(dom.preset.value);
      if (isTokenPreset(preset) && !state.editingUpstreamId) {
        throw new Error('请先通过登录态导入入口添加账号');
      }
      syncModelsFromEditor();
      const draft = {
        config_id: state.editingUpstreamId || undefined,
        preset: preset.id, base_url: normalizeText(dom.baseUrl.value),
        models: state.formModels,
      };
      if (dom.apiKey.value.trim()) draft.apikey = dom.apiKey.value.trim();
      if (preset.id === 'custom') draft.models_endpoint = normalizeText(dom.modelsEndpoint.value);
      state.discovery = await requestJson('/admin/api/upstreams/models/discover', {
        method: 'POST', body: JSON.stringify(draft),
      });
      renderDiscovery();
      setMessage('info', `已读取 ${state.discovery.discovered.length} 个模型；先预览差异，再合并到草稿。`);
    }

    function applyDiscovery() {
      mergeDiscovery();
    }

    async function saveUpstream() {
      const preset = getPreset(dom.preset.value);
      if (!preset) {
        throw new Error('请选择平台');
      }
      if (isTokenPreset(preset) && !state.editingUpstreamId) {
        openTokenImportFromAccount();
        return { requiresImport: true };
      }

      const models = syncModelsFromEditor();
      const description = normalizeText(dom.description.value);
      if (!description) {
        throw new Error('请填写账号名称');
      }
      models.forEach((model, index) => {
        if (!model.id) {
          throw new Error(`第 ${index + 1} 个模型 ID 不能为空`);
        }
        if (!Array.isArray(model.protocols) || model.protocols.length === 0) {
          throw new Error(`模型 ${model.id} 至少选择一个协议`);
        }
      });
      const ids = models.map(model => model.id);
      if (new Set(ids).size !== ids.length) {
        throw new Error('模型 ID 不能重复');
      }

      const item = {
        preset: preset.id,
        description,
        enabled: dom.enabled.checked,
        base_url: normalizeText(dom.baseUrl.value),
        models,
      };
      if (preset.id === 'custom') {
        item.models_endpoint = normalizeText(dom.modelsEndpoint.value);
      }
      const apiKey = normalizeText(dom.apiKey.value);
      if (apiKey) {
        item.apikey = apiKey;
      }

      if (!state.editingUpstreamId && !isTokenPreset(preset) && !apiKey) {
        throw new Error('新增账号需要填写 API Key');
      }
      if (!item.base_url && preset.id === 'custom') {
        throw new Error('自定义接口需要填写 Base URL');
      }

      if (state.editingUpstreamId) {
        await requestJson(`/admin/api/upstreams/${encodeURIComponent(state.editingUpstreamId)}`, {
          method: 'PUT',
          body: JSON.stringify(item),
        });
        setMessage('info', '上游账号已保存。');
      } else {
        const result = await requestJson('/admin/api/upstreams', {
          method: 'POST',
          body: JSON.stringify(item),
        });
        setMessage('info', '上游账号已创建');
      }

      resetUpstreamForm({ close: false });
      closeLayer('accountDialog');
      await loadAll();
    }

    async function refreshQuota(configId) {
      await requestJson(`/admin/api/upstreams/${encodeURIComponent(configId)}/quota-refresh`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await loadAll();
      setMessage('info', '额度状态已刷新；未知和读取失败不会伪装为已耗尽。');
    }

    async function deleteUpstream(configId) {
      await requestJson(`/admin/api/upstreams/${encodeURIComponent(configId)}`, {
        method: 'DELETE',
      });
      if (state.editingUpstreamId === configId) {
        resetUpstreamForm({ close: false });
        closeLayer('accountDialog');
      }
      await loadAll();
      setMessage('info', '上游账号已删除。');
    }

    function getAccountOptions() {
      return getUpstreamConfigs()
        .filter(config => Array.isArray(config.models) && config.models.length > 0)
        .map(config => ({
          id: config.id,
          label: config.description || config.id,
          models: config.models,
        }));
    }

    function targetDefault() {
      const accounts = getAccountOptions();
      const account = accounts[0];
      if (!account) {
        return null;
      }
      const model = account.models[0];
      return {
        config_id: account.id,
        model: model.id,
        protocol: (model.protocols || [])[0] || 'chat_completions',
      };
    }

    function renderRouteTargets() {
      if (!dom.targetsEditor) {
        return;
      }
      const accounts = getAccountOptions();
      if (!accounts.length) {
        dom.targetsEditor.innerHTML = '<div class="empty">还没有带模型的上游账号。请先到「上游账号」添加上游并维护模型。</div>';
        return;
      }
      dom.targetsEditor.innerHTML = state.formTargets.map((target, index) => {
        const account = accounts.find(item => item.id === target.config_id);
        const model = account?.models.find(item => item.id === target.model);
        return `
          <div class="route-target-row" data-target-index="${index}">
            <span class="route-priority">${index + 1}</span>
            <div class="route-target-copy">
              <strong>${escapeHtml(account ? account.label : '无效上游')}</strong>
              <span>${escapeHtml(target.model || '未选择模型')} · ${escapeHtml(protocolLabel(model && target.protocol ? target.protocol : target.protocol))}</span>
            </div>
            <div class="actions">
              <button class="secondary" type="button" data-edit-target="${index}">修改</button>
              <button class="secondary" type="button" data-move-target-up="${index}" ${index === 0 ? 'disabled' : ''} aria-label="上移">↑</button>
              <button class="secondary" type="button" data-move-target-down="${index}" ${index === state.formTargets.length - 1 ? 'disabled' : ''} aria-label="下移">↓</button>
              <button class="danger" type="button" data-remove-target="${index}">删除</button>
            </div>
          </div>
        `;
      }).join('') || '<div class="route-empty-candidates">还没有候选。添加一个上游账号与后端模型组合。</div>';
      if (dom.saveRoute) {
        dom.saveRoute.disabled = !dom.targetEditorPane.hidden;
      }
    }

    function targetEditorHtml(index, preferred = {}) {
      const accounts = getAccountOptions();
      if (!accounts.length) {
        return '<div class="empty">没有可用上游账号。</div>';
      }
      const original = index === null ? null : state.formTargets[index];
      const accountId = preferred.accountId || original?.config_id || accounts[0].id;
      const account = accounts.find(item => item.id === accountId) || accounts[0];
      const modelId = preferred.modelId || original?.model || account.models[0]?.id || '';
      const model = account.models.find(item => item.id === modelId) || account.models[0];
      const protocols = Array.isArray(model?.protocols) ? model.protocols : [];
      const protocol = preferred.protocol && protocols.includes(preferred.protocol)
        ? preferred.protocol
        : (protocols.includes(original?.protocol) ? original.protocol : (protocols[0] || 'chat_completions'));
      return `
        <h3>${index === null ? '添加后端候选' : '修改后端候选'}</h3>
        <div class="form-grid">
          <div class="field">
            <label class="field-label" for="routeTargetAccountSelect">上游账号</label>
            <select id="routeTargetAccountSelect" data-target-editor-field="account">
              ${accounts.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === account.id ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label class="field-label" for="routeTargetModelSelect">后端模型</label>
            <select id="routeTargetModelSelect" data-target-editor-field="model">
              ${account.models.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === model?.id ? 'selected' : ''}>${escapeHtml(item.id)}</option>`).join('')}
            </select>
          </div>
        </div>
        <details class="advanced-settings" style="margin-top:12px">
          <summary>协议：${escapeHtml(protocolLabel(protocol))}</summary>
          <div class="advanced-settings-body">
            <div class="field">
              <label class="field-label" for="routeTargetProtocolSelect">上游协议</label>
              <select id="routeTargetProtocolSelect" data-target-editor-field="protocol">
                ${protocols.map(item => `<option value="${escapeHtml(item)}" ${item === protocol ? 'selected' : ''}>${escapeHtml(protocolLabel(item))}</option>`).join('')}
              </select>
              <p class="field-hint">选项来自这个后端模型声明的协议，不能随意跨协议。</p>
            </div>
          </div>
        </details>
        <div class="dialog-sub-actions">
          <button class="primary" type="button" data-action="confirm-target">确认候选</button>
          <button class="secondary" type="button" data-action="cancel-target">取消</button>
        </div>
      `;
    }

    function renderTargetEditor(index, preferred = {}) {
      if (!dom.targetEditorPane) {
        return;
      }
      state.editingTargetIndex = index;
      dom.targetEditorPane.hidden = false;
      dom.targetEditorPane.innerHTML = targetEditorHtml(index, preferred);
      if (dom.saveRoute) {
        dom.saveRoute.disabled = true;
      }
    }

    function closeTargetEditor() {
      state.editingTargetIndex = null;
      dom.targetEditorPane.hidden = true;
      dom.targetEditorPane.innerHTML = '';
      if (dom.saveRoute) {
        dom.saveRoute.disabled = false;
      }
    }

    function confirmTarget() {
      const accountId = dom.targetEditorPane.querySelector('[data-target-editor-field="account"]')?.value || '';
      const modelId = dom.targetEditorPane.querySelector('[data-target-editor-field="model"]')?.value || '';
      const protocol = dom.targetEditorPane.querySelector('[data-target-editor-field="protocol"]')?.value || '';
      if (!accountId || !modelId || !protocol) {
        throw new Error('请选择上游账号、后端模型和协议');
      }
      const duplicate = state.formTargets.some((target, index) => (
        index !== state.editingTargetIndex
        && target.config_id === accountId
        && target.model === modelId
      ));
      if (duplicate) {
        throw new Error('这个上游与模型组合已经在候选列表中');
      }
      const nextTarget = { config_id: accountId, model: modelId, protocol };
      if (state.editingTargetIndex === null) {
        state.formTargets.push(nextTarget);
      } else {
        state.formTargets[state.editingTargetIndex] = nextTarget;
      }
      closeTargetEditor();
      renderRouteTargets();
    }

    function statusForRoute(route) {
      const protocol = (route.entry_protocols || ['chat_completions'])[0];
      return state.routes?.route_status?.[route.id]?.[protocol] || null;
    }

    function renderRouteCard(route) {
      const status = statusForRoute(route);
      const targets = Array.isArray(route.targets) ? route.targets : [];
      return `
        <article class="route-card" data-route-id="${escapeHtml(route.id)}">
          <div class="route-card-head">
            <div>
              <h3 class="route-id">${escapeHtml(route.id)}</h3>
              <div class="route-meta">
                ${(route.entry_protocols || []).map(protocol => `<span class="tag">${escapeHtml(protocolLabel(protocol))}</span>`).join('')}
                <span class="tag">${route.enabled === false ? '已停用' : '已启用'}</span>
              </div>
            </div>
            <div class="route-actions">
              <button class="secondary" type="button" data-edit-route="${escapeHtml(route.id)}">编辑</button>
              <button class="danger" type="button" data-delete-route="${escapeHtml(route.id)}">删除</button>
            </div>
          </div>
          <ol class="route-chain">
            ${targets.map((target, index) => {
              const targetStatus = (status?.targets || []).find(item => item.target_id === target.id);
              const selected = targetStatus?.selected;
              const available = targetStatus?.available;
              const tone = selected ? 'ok' : available ? 'warn' : 'danger';
              return `
                <li class="route-candidate">
                  <span class="route-priority">${index + 1}</span>
                  <div class="route-candidate-copy">
                    <strong>${escapeHtml(accountLabel(target.config_id))}</strong>
                    <span class="mono">${escapeHtml(target.model)}</span>
                    <span class="tag">${escapeHtml(protocolLabel(target.protocol))}</span>
                    ${!selected && targetStatus?.reason ? `<span class="quota-detail">${escapeHtml(statusLabel(targetStatus.reason))}</span>` : ''}
                  </div>
                  <div class="route-candidate-flags">
                    <span class="route-status-chip ${tone}">${selected ? '当前首选' : available ? '可用' : '跳过'}</span>
                  </div>
                </li>
              `;
            }).join('') || '<li class="route-empty-candidates">这条路由还没有候选。</li>'}
          </ol>
        </article>
      `;
    }

    function renderRoutes() {
      if (dom.revisionBadge) {
        dom.revisionBadge.textContent = state.routes?.revision ? `revision ${state.routes.revision}` : 'revision 未读取';
      }
      const routes = getRoutes();
      if (!routes.length) {
        dom.routesList.innerHTML = `
          <div class="empty-state">
            <strong>还没有模型路由</strong>
            <p>创建客户端模型 ID，再从上游账号中选择支持的后端模型作为候选。</p>
            <button class="primary" type="button" data-action="new-route">＋ 新增模型路由</button>
          </div>
        `;
        return;
      }
      dom.routesList.innerHTML = routes.map(renderRouteCard).join('')
        + (state.routes?.parse_error ? `<div class="message show error">${escapeHtml(state.routes.parse_error)}</div>` : '');
    }

    function getSelectedEntryProtocols() {
      return [...doc.querySelectorAll('input[name="routeEntryProtocol"]:checked')].map(input => input.value);
    }

    function resetRouteForm(options = {}) {
      state.editingRouteId = '';
      state.formTargets = [];
      state.editingTargetIndex = null;
      dom.routeModelId.value = '';
      dom.routeMaxAttempts.value = String(state.routes?.max_attempts || 3);
      doc.querySelectorAll('input[name="routeEntryProtocol"]').forEach(input => {
        input.checked = true;
      });
      setFormHint(dom.routeEditHint, '');
      closeTargetEditor();
      renderRouteTargets();
      if (dom.routeDialogTitle) {
        dom.routeDialogTitle.textContent = '新增模型路由';
      }
      if (dom.routeDialogEyebrow) {
        dom.routeDialogEyebrow.textContent = 'Route / New';
      }
      if (options.close !== false) {
        closeLayer('routeDialog');
      }
    }

    function openRoute(routeId = '') {
      const route = getRoutes().find(item => item.id === routeId);
      if (routeId && !route) {
        handleError(new Error('模型路由不存在，请刷新后重试'));
        return;
      }
      state.editingRouteId = route ? route.id : '';
      state.formTargets = route ? cloneJson(route.targets || []) : [];
      state.editingTargetIndex = null;
      dom.routeModelId.value = route ? route.id : '';
      dom.routeMaxAttempts.value = String(state.routes?.max_attempts || 3);
      doc.querySelectorAll('input[name="routeEntryProtocol"]').forEach(input => {
        input.checked = route ? (route.entry_protocols || []).includes(input.value) : true;
      });
      setFormHint(dom.routeEditHint, route
        ? `正在编辑 ${route.id}；排序变化会直接影响候选优先级。`
        : '保存前不会影响现有路由；候选可以随时调整顺序。');
      if (dom.routeDialogTitle) {
        dom.routeDialogTitle.textContent = route ? '编辑模型路由' : '新增模型路由';
      }
      if (dom.routeDialogEyebrow) {
        dom.routeDialogEyebrow.textContent = route ? 'Route / Edit' : 'Route / New';
      }
      closeTargetEditor();
      renderRouteTargets();
      openLayer('routeDialog');
      dom.routeModelId.focus();
    }

    async function saveRoute() {
      const modelId = normalizeText(dom.routeModelId.value);
      if (!modelId) {
        throw new Error('客户端模型 ID 不能为空');
      }
      const entryProtocols = getSelectedEntryProtocols();
      if (!entryProtocols.length) {
        throw new Error('至少选择一个入口协议');
      }
      if (!state.formTargets.length) {
        throw new Error('至少配置一个路由候选');
      }
      for (const [index, target] of state.formTargets.entries()) {
        if (!target.config_id || !target.model || !target.protocol) {
          throw new Error(`第 ${index + 1} 个候选不完整`);
        }
      }

      const models = Array.isArray(state.routes?.models) ? cloneJson(state.routes.models) : [];
      const conflictingRoute = models.find(route => route.id === modelId && route.id !== state.editingRouteId);
      if (conflictingRoute) {
        throw new Error(`客户端模型 ID 已存在: ${modelId}`);
      }
      const editingId = state.editingRouteId;
      const nextRoute = {
        ...(models.find(route => route.id === editingId || route.id === modelId) || {}),
        id: modelId,
        enabled: true,
        entry_protocols: entryProtocols,
        targets: cloneJson(state.formTargets),
      };
      const existingIndex = models.findIndex(route => route.id === editingId || route.id === modelId);
      if (existingIndex === -1) {
        models.push(nextRoute);
      } else {
        models[existingIndex] = nextRoute;
      }

      const result = await requestJson('/admin/api/model-routes', {
        method: 'PUT',
        body: JSON.stringify({
          revision: state.routes?.revision,
          max_attempts: Number(dom.routeMaxAttempts.value) || 3,
          models,
        }),
      });
      state.routes = result;
      resetRouteForm({ close: false });
      closeLayer('routeDialog');
      await loadAll();
      setMessage('info', '模型路由已保存并热加载。');
    }

    async function deleteRoute(routeId) {
      const models = cloneJson(state.routes?.models || []).filter(route => route.id !== routeId);
      const result = await requestJson('/admin/api/model-routes', {
        method: 'PUT',
        body: JSON.stringify({
          revision: state.routes?.revision,
          max_attempts: Number(dom.routeMaxAttempts?.value) || state.routes?.max_attempts || 3,
          models,
        }),
      });
      state.routes = result;
      if (state.editingRouteId === routeId) {
        resetRouteForm({ close: false });
        closeLayer('routeDialog');
      }
      await loadAll();
      setMessage('info', '模型路由已删除。');
    }

    async function loadUpstreams() {
      state.upstreams = await requestJson('/admin/api/upstreams');
      fillPresetOptions();
      if (dom.accountDialog && !dom.accountDialog.hidden) {
        updatePresetFields();
      }
      renderUpstreams();
    }

    async function loadRoutes() {
      state.routes = await requestJson('/admin/api/model-routes');
      if (dom.revisionBadge) {
        dom.revisionBadge.textContent = state.routes.revision ? `revision ${state.routes.revision}` : 'revision 未读取';
      }
      if (dom.routeMaxAttempts && !dom.routeDialog?.hidden) {
        dom.routeMaxAttempts.value = String(state.routes.max_attempts || 3);
      }
      if (dom.routeDialog && !dom.routeDialog.hidden) {
        renderRouteTargets();
      }
      renderRoutes();
    }

    async function loadAll() {
      await Promise.all([loadUpstreams(), loadRoutes()]);
      renderUpstreams();
      renderRoutes();
    }

    function openTokenImportFromAccount() {
      state.pendingTokenImportFromAccount = true;
      openLayer('tokenImportDialog');
      setMessage('info', '导入登录态后会新增一个 ChatGPT / Codex 上游账号。');
    }

    function armConfirm(button, confirmLabel) {
      if (button.dataset.confirm === 'true') {
        button.dataset.confirm = '';
        button.classList.remove('confirming');
        button.textContent = button.dataset.originalText || '删除';
        return true;
      }
      button.dataset.originalText = button.textContent;
      button.dataset.confirm = 'true';
      button.classList.add('confirming');
      button.textContent = confirmLabel;
      windowScope.setTimeout(() => {
        if (button.dataset.confirm === 'true') {
          button.dataset.confirm = '';
          button.classList.remove('confirming');
          button.textContent = button.dataset.originalText || '删除';
        }
      }, 4000);
      return false;
    }

    function wireEvents() {
      doc.addEventListener('click', event => {
        const pageLink = event.target.closest('[data-page-link]');
        if (pageLink) {
          event.preventDefault();
          closeLayer('settingsDrawer');
          setView(pageLink.dataset.pageLink === 'routes' ? 'routes' : 'accounts');
          return;
        }

        if (event.target.closest('[data-open-settings]') || event.target.closest('#openSettingsButton')) {
          openSettings('general');
          return;
        }
        if (event.target.closest('[data-close-settings]')) {
          closeSettings();
          return;
        }
        const settingsTab = event.target.closest('[data-settings-tab]');
        if (settingsTab) {
          setSettingsTab(settingsTab.dataset.settingsTab);
          return;
        }

        const closeDialogButton = event.target.closest('[data-close-dialog]');
        if (closeDialogButton) {
          closeLayer(closeDialogButton.dataset.closeDialog);
          return;
        }

        const actionButton = event.target.closest('[data-action]');
        const action = actionButton?.dataset.action;

        if (action === 'new-account') {
          openAccount();
          return;
        }
        if (action === 'new-route') {
          openRoute();
          return;
        }
        if (action === 'open-token-import') {
          const fromAccount = Boolean(event.target.closest('#accountDialog'));
          closeSettings();
          if (fromAccount) {
            state.pendingTokenImportFromAccount = true;
          }
          openLayer('tokenImportDialog');
          return;
        }
        if (action === 'open-claude-manager') {
          const fromAccount = Boolean(event.target.closest('#accountDialog'));
          closeSettings();
          state.pendingTokenImportFromAccount = fromAccount;
          openLayer('claudeDialog');
          return;
        }
        if (action === 'open-legacy-configs') {
          closeSettings();
          openLayer('legacyConfigsDialog');
          return;
        }
        if (action === 'add-model') {
          syncModelsFromEditor();
          const protocols = [...(getPreset(dom.preset.value)?.protocols || ['chat_completions'])];
          state.formModels.push({ id: '', protocols });
          renderModelEditor();
          return;
        }
        if (action === 'sync') {
          void discoverModels().catch(handleError);
          return;
        }
        if (action === 'merge-discovery') {
          mergeDiscovery();
          return;
        }
        if (action === 'dismiss-discovery') {
          state.discovery = null;
          renderDiscovery();
          return;
        }
        if (action === 'add-target') {
          if (!getAccountOptions().length) {
            setMessage('error', '请先添加带模型的上游账号。');
            return;
          }
          renderTargetEditor(null);
          return;
        }
        if (action === 'confirm-target') {
          try {
            confirmTarget();
          } catch (error) {
            handleError(error);
          }
          return;
        }
        if (action === 'cancel-target') {
          closeTargetEditor();
          renderRouteTargets();
          return;
        }

        const editUpstream = event.target.closest('[data-edit-upstream]');
        if (editUpstream) {
          openAccount(editUpstream.dataset.editUpstream);
          return;
        }
        const syncAccount = event.target.closest('[data-sync-account]');
        if (syncAccount) {
          openAccount(syncAccount.dataset.syncAccount, { sync: true });
          return;
        }
        const refreshButton = event.target.closest('[data-refresh-quota]');
        if (refreshButton) {
          refreshButton.disabled = true;
          void refreshQuota(refreshButton.dataset.refreshQuota)
            .catch(handleError)
            .finally(() => {
              refreshButton.disabled = false;
            });
          return;
        }
        const deleteUpstreamButton = event.target.closest('[data-delete-upstream]');
        if (deleteUpstreamButton) {
          if (!armConfirm(deleteUpstreamButton, '确认删除')) {
            return;
          }
          deleteUpstreamButton.disabled = true;
          void deleteUpstream(deleteUpstreamButton.dataset.deleteUpstream)
            .catch(handleError)
            .finally(() => {
              deleteUpstreamButton.disabled = false;
            });
          return;
        }

        const removeModel = event.target.closest('[data-remove-model]');
        if (removeModel) {
          syncModelsFromEditor();
          const index = Number(removeModel.dataset.removeModel);
          const model = state.formModels[index];
          const refs = model ? routeReferencesForModel(state.editingUpstreamId, model.id) : [];
          if (refs.length) {
            setMessage('error', `此模型仍被路由 ${refs.join('、')} 引用，请先修改路由候选。`);
            return;
          }
          state.formModels.splice(index, 1);
          renderModelEditor();
          return;
        }

        const editTarget = event.target.closest('[data-edit-target]');
        if (editTarget) {
          renderTargetEditor(Number(editTarget.dataset.editTarget));
          return;
        }
        const upButton = event.target.closest('[data-move-target-up]');
        const downButton = event.target.closest('[data-move-target-down]');
        const removeTargetButton = event.target.closest('[data-remove-target]');
        if (upButton || downButton || removeTargetButton) {
          const button = upButton || downButton || removeTargetButton;
          const index = Number(button.dataset.moveTargetUp ?? button.dataset.moveTargetDown ?? button.dataset.removeTarget);
          if (removeTargetButton) {
            state.formTargets.splice(index, 1);
          } else {
            const nextIndex = index + (upButton ? -1 : 1);
            [state.formTargets[index], state.formTargets[nextIndex]] = [state.formTargets[nextIndex], state.formTargets[index]];
          }
          closeTargetEditor();
          renderRouteTargets();
          return;
        }

        const editRouteButton = event.target.closest('[data-edit-route]');
        if (editRouteButton) {
          openRoute(editRouteButton.dataset.editRoute);
          return;
        }
        const deleteRouteButton = event.target.closest('[data-delete-route]');
        if (deleteRouteButton) {
          if (!armConfirm(deleteRouteButton, '确认删除')) {
            return;
          }
          deleteRouteButton.disabled = true;
          void deleteRoute(deleteRouteButton.dataset.deleteRoute)
            .catch(handleError)
            .finally(() => {
              deleteRouteButton.disabled = false;
            });
          return;
        }
      });

      dom.preset.addEventListener('change', () => {
        if (!state.editingUpstreamId) {
          dom.baseUrl.value = getPreset(dom.preset.value)?.default_base_url || '';
        }
        state.discovery = null;
        renderDiscovery();
        updatePresetFields();
      });

      dom.addModel.addEventListener('click', () => {
        syncModelsFromEditor();
        const protocols = [...(getPreset(dom.preset.value)?.protocols || ['chat_completions'])];
        state.formModels.push({ id: '', protocols });
        renderModelEditor();
      });

      dom.discover.addEventListener('click', () => {
        void discoverModels().catch(handleError);
      });

      dom.saveUpstream.addEventListener('click', () => {
        dom.saveUpstream.disabled = true;
        void saveUpstream()
          .catch(handleError)
          .finally(() => {
            dom.saveUpstream.disabled = false;
          });
      });
      dom.resetUpstream.addEventListener('click', () => {
        resetUpstreamForm({ close: false });
        closeLayer('accountDialog');
      });

      dom.addTarget.addEventListener('click', () => {
        if (!getAccountOptions().length) {
          setMessage('error', '请先添加带模型的上游账号。');
          return;
        }
        renderTargetEditor(null);
      });

      dom.targetEditorPane.addEventListener('change', event => {
        const field = event.target.dataset.targetEditorField;
        if (field === 'account') {
          const accountId = event.target.value;
          const account = getAccountOptions().find(item => item.id === accountId);
          renderTargetEditor(state.editingTargetIndex, {
            accountId,
            modelId: account?.models[0]?.id || '',
          });
        } else if (field === 'model') {
          const accountId = dom.targetEditorPane.querySelector('[data-target-editor-field="account"]')?.value || '';
          const account = getAccountOptions().find(item => item.id === accountId);
          const model = account?.models.find(item => item.id === event.target.value);
          const protocol = (model?.protocols || [])[0] || '';
          renderTargetEditor(state.editingTargetIndex, {
            accountId,
            modelId: event.target.value,
            protocol,
          });
        } else if (field === 'protocol') {
          const summary = dom.targetEditorPane.querySelector('.advanced-settings summary');
          if (summary) {
            summary.textContent = `协议：${protocolLabel(event.target.value)}`;
          }
        }
      });

      dom.saveRoute.addEventListener('click', () => {
        dom.saveRoute.disabled = true;
        void saveRoute()
          .catch(handleError)
          .finally(() => {
            if (dom.routeDialog && !dom.routeDialog.hidden) {
              dom.saveRoute.disabled = false;
            }
          });
      });
      dom.resetRoute.addEventListener('click', () => {
        resetRouteForm({ close: false });
        closeLayer('routeDialog');
      });

      const refresh = el('refreshButton');
      if (refresh) {
        refresh.addEventListener('click', () => {
          void loadAll()
            .catch(handleError)
            .finally(() => {
              refresh.disabled = false;
            });
        });
      }

      windowScope.addEventListener('airouter:configs-changed', event => {
        const source = event.detail?.source || 'config-change';
        if (source === 'token-import') {
          const closeAccountAfterImport = state.pendingTokenImportFromAccount;
          closeLayer('tokenImportDialog');
          if (closeAccountAfterImport) {
            closeLayer('accountDialog');
          }
          setView('accounts', { push: false });
        }
        void loadAll().catch(handleError);
      });

      windowScope.addEventListener('popstate', () => {
        setView(viewFromLocation(), { push: false });
      });

      doc.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
          return;
        }
        const visibleLayers = [...doc.querySelectorAll('.dialog-layer, .drawer-layer')]
          .filter(layer => !layer.hidden);
        const topLayer = visibleLayers[visibleLayers.length - 1];
        if (topLayer) {
          closeLayer(topLayer.id);
        }
      });
    }

    async function init() {
      wireEvents();
      fillPresetOptions();
      setView(viewFromLocation(), { push: false });
      resetUpstreamForm({ close: false });
      resetRouteForm({ close: false });
      try {
        await loadAll();
        resetUpstreamForm({ close: false });
        resetRouteForm({ close: false });
      } catch (error) {
        setMessage('error', `统一路由管理加载失败: ${error.message}`);
      }
    }

    return {
      state,
      init,
      loadAll,
      setView,
      openSettings,
      openAccount,
      openRoute,
      openTokenImportFromAccount,
      closeLayer,
      saveUpstream,
      discoverModels,
      applyDiscovery,
      mergeDiscovery,
      refreshQuota,
      saveRoute,
      deleteRoute,
      deleteUpstream,
      editUpstream: openAccount,
      editRoute: openRoute,
      renderRoutes,
    };
  }

  const exported = {
    createRoutingAdmin,
    providerIdForConfig,
    getPresetLabel,
    formatQuotaSummary,
    protocolLabel,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }
  globalScope.AirouterRoutingAdmin = exported;

  if (typeof document !== 'undefined') {
    const start = () => {
      const admin = createRoutingAdmin();
      if (admin) {
        admin.init();
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }
}(typeof globalThis !== 'undefined' ? globalThis : this));
