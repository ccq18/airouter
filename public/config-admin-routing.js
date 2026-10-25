(function attachRoutingAdmin(globalScope) {
  const PROTOCOLS = ['chat_completions', 'responses', 'messages'];
  const PROTOCOL_LABELS = {
    chat_completions: 'Chat Completions',
    responses: 'Responses',
    messages: 'Claude Messages',
  };
  const TOKEN_PRESETS = new Set(['chatgpt', 'claude']);
  const POOL_PRESETS = new Set(['opencode-free', 'openrouter-free']);
  const FREE_MODEL = { id: 'free', protocols: ['chat_completions'] };
  const POOL_DEFAULTS = { sync_interval_seconds: 900, max_stale_seconds: 3600, max_attempts: 8, strategy: 'quality_first', tiers: {} };
  const DEFAULT_PRESETS = [
    { id: 'chatgpt', label: 'ChatGPT / Codex', credential: 'token', default_base_url: 'https://chatgpt.com', protocols: ['responses'] },
    { id: 'opencode-go', label: 'OpenCode Go', credential: 'apikey', default_base_url: 'https://opencode.ai/inference/go', protocols: [...PROTOCOLS] },
    { id: 'opencode-zen', label: 'OpenCode Zen', credential: 'apikey', default_base_url: 'https://opencode.ai/inference', protocols: [...PROTOCOLS] },
    { id: 'openrouter', label: 'OpenRouter', credential: 'apikey', default_base_url: 'https://openrouter.ai/api/v1', protocols: ['chat_completions'] },
    { id: 'opencode-free', label: 'OpenCode 免费模型池', credential: 'apikey', pool: true, default_base_url: 'https://opencode.ai/inference/go', protocols: ['chat_completions'] },
    { id: 'openrouter-free', label: 'OpenRouter 免费模型池', credential: 'apikey', pool: true, default_base_url: 'https://openrouter.ai/api/v1', protocols: ['chat_completions'] },
    { id: 'glm-cn', label: 'GLM Coding Plan 中国', credential: 'apikey', default_base_url: 'https://open.bigmodel.cn/api/coding/paas/v4', protocols: ['chat_completions', 'messages'] },
    { id: 'glm-global', label: 'GLM Coding Plan 国际', credential: 'apikey', default_base_url: 'https://api.z.ai/api/coding/paas/v4', protocols: ['chat_completions', 'messages'] },
    { id: 'claude', label: 'Claude OAuth', credential: 'token', default_base_url: 'https://api.anthropic.com', protocols: ['messages'] },
    { id: 'sub2api', label: 'Sub2API API Key', credential: 'apikey', default_base_url: '', protocols: [...PROTOCOLS] },
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

  function initialModelProtocols(preset) {
    return ['opencode-go', 'opencode-zen'].includes(preset?.id) ? [] : [...(preset?.protocols || ['chat_completions'])];
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
    return (Array.isArray(presets) && presets.length ? presets : DEFAULT_PRESETS)
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
      protocol_not_supported: '协议不兼容', native_protocol_unsupported: '不支持当前原生协议', entry_protocol_not_supported: '入口协议未启用',
      quota_unsupported: '此平台暂不支持额度查询', ok: '可用',
    };
    return labels[reason] || (/^[a-z_]+$/.test(reason || '') ? '暂时不可用' : reason || '');
  }

  function formatUsd(value) {
    const amount = Math.abs(value);
    if (amount > 0 && amount < 1e-8) return `${value < 0 ? '-' : ''}<$0.00000001`;
    const digits = amount > 0 && amount < 0.01 ? Math.min(8, Math.ceil(-Math.log10(amount)) + 1) : 2;
    return `${value < 0 ? '-' : ''}$${amount.toFixed(digits)}`;
  }

  function isKeyBudget(metric) {
    return /^key:/.test(metric.id || '') || /^(key_limit|key_quota|key_window_.+)$/.test(metric.id || '');
  }

  function budgetTitle(metric) {
    const id = (metric.id || '').replace(/^(key|credits):/, '');
    return ({ account_balance: '账户余额', wallet_balance: '钱包余额',
      key_window_5h: 'Key 5小时', key_window_1d: 'Key 每日', key_window_7d: 'Key 7天',
      subscription_daily: '订阅每日', subscription_weekly: '订阅每周', subscription_monthly: '订阅每月',
      subscription_expiry: '订阅有效期', key_status: 'Key 状态', key_expiry: 'Key 有效期',
    })[id] || (isKeyBudget(metric) ? 'Key' : '额度');
  }

  function isBudgetExhausted(metric) {
    if (metric.blocking === false) return false;
    return metric.state === 'exhausted' || (metric.state === undefined && Number.isFinite(metric.remaining) && metric.remaining <= 0);
  }

  function formatQuotaSummary(quota) {
    const metrics = Array.isArray(quota?.metrics) ? quota.metrics : [];
    const budgets = metrics.filter(metric => metric?.kind === 'budget' && metric.unit === 'USD');
    if (budgets.length) {
      const known = budgets.filter(metric => Number.isFinite(metric.remaining));
      const account = known.find(metric => /(^|:)(account_balance|wallet_balance)$/.test(metric.id || ''));
      const keys = known.filter(isKeyBudget);
      const primary = account || keys.reduce((lowest, metric) => !lowest || metric.remaining < lowest.remaining ? metric : lowest, null) || known[0];
      const title = primary ? budgetTitle(primary) : '';
      const label = primary ? `${account ? '余额' : title === '额度' ? '剩余额度' : `${title} 剩余`} ${formatUsd(primary.remaining)}`
        : quota.state === 'exhausted' ? '额度已耗尽' : quota.state === 'unknown' ? '额度未读取' : '额度可用';
      const details = [];
      for (const budget of budgets) {
        const name = budgetTitle(budget);
        if (budget !== primary) {
          if (Number.isFinite(budget.remaining)) details.push(`${name} 剩余 ${formatUsd(budget.remaining)}${Number.isFinite(budget.limit) ? ` / ${formatUsd(budget.limit)}` : ''}`);
          else if (budget.blocking === false && budget.state === 'available') details.push(`${name} 不限额`);
          else if (Number.isFinite(budget.limit) || /^(subscription_|key_window_)/.test(budget.id || '')) details.push(`${name} 剩余额度未读取${Number.isFinite(budget.limit) ? ` / ${formatUsd(budget.limit)}` : ''}`);
        } else if (!account && Number.isFinite(budget.limit)) details.push(`${name} 限额 ${formatUsd(budget.limit)}`);
        if (isBudgetExhausted(budget)) details.push(name === '账户余额' ? '账户余额已耗尽' : name === 'Key' ? 'Key 限额已耗尽' : `${name} 已耗尽`);
        else if (budget.state === 'unknown' && Number.isFinite(budget.remaining)) details.push(`${name} 是否限制调用尚未确认`);
      }
      if (quota.error) details.push(String(quota.error));
      if (quota.reason && !['quota_available', 'probe_success'].includes(quota.reason)) details.push(statusLabel(quota.reason));
      const exhausted = quota.state === 'exhausted' || budgets.some(isBudgetExhausted);
      if (exhausted && !budgets.some(isBudgetExhausted)) details.push('额度已耗尽');
      if (quota.state === 'unknown' && !details.length) details.push('额度状态未确认');
      return { label, tone: exhausted ? 'danger' : quota.state === 'unknown' ? 'warn' : 'ok', detail: [...new Set(details)].join('；') };
    }
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

  function isPoolPreset(preset) {
    return POOL_PRESETS.has(typeof preset === 'string' ? preset : preset?.id);
  }

  function poolCredentialOptions(configs, presetId) {
    const allowed = presetId === 'opencode-free' ? ['opencode-go', 'opencode-zen'] : ['openrouter'];
    return configs.filter(config => config.type === 'apikey' && allowed.includes(config.preset));
  }

  function normalizePoolSettings(value = {}) {
    const settings = { ...POOL_DEFAULTS, ...value };
    const ranges = { sync_interval_seconds: [60, 86400], max_stale_seconds: [60, 86400], max_attempts: [1, 32] };
    for (const [field, [min, max]] of Object.entries(ranges)) {
      const number = Number(settings[field]);
      if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${field} 须为 ${min}-${max} 的整数`);
      settings[field] = number;
    }
    if (settings.max_stale_seconds < settings.sync_interval_seconds) throw new Error('资格缓存有效期不能短于同步间隔');
    if (!['quality_first', 'fastest'].includes(settings.strategy)) throw new Error('请选择有效的池内策略');
    if (!settings.tiers || typeof settings.tiers !== 'object' || Array.isArray(settings.tiers)) throw new Error('质量分级须为模型 ID 到等级的 JSON 对象');
    for (const [id, tier] of Object.entries(settings.tiers)) {
      if (!id.trim() || !Number.isInteger(tier) || tier < 1 || tier > 10) throw new Error('质量等级须为 1-10 的整数，1 为最高档');
    }
    return settings;
  }

  function poolStateLabel(value) {
    return ({ ready: '有可用候选', available: '有可用候选', ok: '可用', empty: '没有合格候选', stale: '资格信息已过期', expired: '资格信息已过期', syncing: '正在同步', unknown: '等待同步', error: '同步异常', cooldown: '冷却中', auth_failed: '凭证验证失败', unavailable: '暂不可用', disabled: '已停用' })[value] || value || '等待同步';
  }

  function formatPoolTime(value) {
    if (!value) return '尚无记录';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  function poolValue(value) {
    return typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  }

  function extractTestResponseText(response) {
    if (!response || typeof response !== 'object') return typeof response === 'string' ? response : '';
    const contentText = content => {
      if (typeof content === 'string') return content;
      if (!Array.isArray(content)) return '';
      return content.map(part => typeof part === 'string' ? part : (part?.text || part?.refusal || '')).filter(Boolean).join('\n');
    };
    if (Array.isArray(response.choices)) {
      return response.choices.map(choice => contentText(choice.message?.content) || choice.message?.refusal || choice.text || '').filter(Boolean).join('\n');
    }
    if (typeof response.output_text === 'string') return response.output_text;
    if (Array.isArray(response.output)) {
      return response.output.map(item => contentText(item.content)).filter(Boolean).join('\n');
    }
    return contentText(response.content);
  }

  function normalizeTestResult(payload, httpStatus, elapsedMs) {
    const envelope = payload && typeof payload === 'object' ? payload : {};
    const response = Object.prototype.hasOwnProperty.call(envelope, 'response') ? envelope.response : envelope;
    const error = response?.error || envelope.error;
    const statusCode = Number.isFinite(envelope.status_code) ? envelope.status_code : httpStatus;
    const errorText = typeof error === 'string' ? error : error?.message || (error ? JSON.stringify(error) : '');
    return {
      statusCode,
      elapsedMs: Number.isFinite(envelope.elapsed_ms) ? envelope.elapsed_ms : elapsedMs,
      attempts: Array.isArray(envelope.attempts) ? envelope.attempts : [],
      outcome: envelope.outcome || (statusCode >= 200 && statusCode < 300 && !error ? 'success' : 'failed'),
      text: extractTestResponseText(response),
      error: errorText || (statusCode >= 400 ? `HTTP ${statusCode}` : ''),
      raw: payload,
    };
  }

  // A stopped run may settle after another starts. Only the active run can publish results.
  function createRouteTestRunner({ execute, onChange = () => {} }) {
    let active = null;
    function publish(run) {
      onChange({ running: run.running, stopped: run.stopped, items: run.items.map(item => ({ ...item })) });
    }
    return {
      stop() {
        if (!active?.running) return;
        const run = active;
        run.running = false;
        run.stopped = true;
        run.controller.abort();
        run.items.forEach(item => {
          if (item.state === 'waiting' || item.state === 'running') item.state = 'cancelled';
        });
        publish(run);
      },
      async start(jobs) {
        if (active?.running) return false;
        const run = {
          controller: new AbortController(), running: true, stopped: false,
          items: jobs.map(job => ({ job, state: 'waiting', result: null, error: '' })),
        };
        active = run;
        publish(run);
        for (const item of run.items) {
          if (active !== run || run.controller.signal.aborted) return false;
          item.state = 'running';
          publish(run);
          try {
            const result = await execute(item.job, run.controller.signal);
            if (active !== run || run.controller.signal.aborted) return false;
            item.result = result;
            item.state = 'done';
          } catch (error) {
            if (active !== run || run.controller.signal.aborted) return false;
            item.error = error?.message || String(error);
            item.state = 'done';
          }
          publish(run);
        }
        if (active !== run || run.controller.signal.aborted) return false;
        run.running = false;
        publish(run);
        return true;
      },
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
      poolDetailId: '',
      testRoute: null,
      testRun: { running: false, stopped: false, items: [] },
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
      poolFields: el('upstreamPoolFields'),
      credentialRef: el('upstreamCredentialRefSelect'),
      poolSyncInterval: el('poolSyncIntervalInput'),
      poolMaxStale: el('poolMaxStaleInput'),
      poolMaxAttempts: el('poolMaxAttemptsInput'),
      poolStrategy: el('poolStrategySelect'),
      poolTiers: el('poolTiersInput'),
      poolDetail: el('poolDetailsContent'),
      poolTitle: el('poolDetailsTitle'),
      poolRefresh: el('poolRefreshButton'),
      poolStatus: el('poolDetailsStatus'),
      modelSection: el('upstreamModelSection'),
      testDialog: el('routeTestDialog'),
      testRouteId: el('routeTestModelId'),
      testInput: el('routeTestInput'),
      testProtocol: el('routeTestProtocol'),
      testRouteButton: el('routeTestRunButton'),
      testCandidatesButton: el('routeTestAllButton'),
      testStopButton: el('routeTestStopButton'),
      testResults: el('routeTestResults'),
      testStatus: el('routeTestStatus'),
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
      return Array.isArray(presets) && presets.length ? presets : DEFAULT_PRESETS;
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
      if (id === 'routeTestDialog') testRunner.stop();
      if (id === 'poolDetailsDialog') state.poolDetailId = '';
      layer.hidden = true;
      if (id === 'tokenImportDialog') {
        state.pendingTokenImportFromAccount = false;
      }
      syncBodyLock();
    }

    function openSettings() {
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
      const preset = getPreset(dom.preset.value) || DEFAULT_PRESETS[DEFAULT_PRESETS.length - 1];
      if (!state.editingUpstreamId && preset.default_base_url) {
        dom.baseUrl.value = preset.default_base_url;
      }
      dom.baseUrl.placeholder = preset.id === 'sub2api' ? 'https://your-sub2api.example/v1' : preset.default_base_url || 'https://...';
      const baseHint = el('upstreamBaseUrlHint');
      if (baseHint) baseHint.textContent = preset.id === 'sub2api' ? '填写你的 Sub2API 网关根网址或 /v1 地址；模型与用量接口使用同一转发凭证。' : '内置平台会填入官方地址，通常无需修改。';
      const connectionSettings = dom.baseUrl.closest?.('details');
      if (connectionSettings && preset.id === 'sub2api') connectionSettings.open = true;
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
      const pool = isPoolPreset(preset);
      if (dom.poolFields) dom.poolFields.hidden = !pool;
      if (dom.modelSection) dom.modelSection.hidden = pool;
      dom.baseUrl.readOnly = pool;
      if (pool) {
        const config = selectedAccountConfig();
        const options = poolCredentialOptions(getUpstreamConfigs(), preset.id);
        const selected = config?.credential_ref || (!state.editingUpstreamId ? options.find(item => item.enabled !== false)?.id || options[0]?.id : '') || '';
        dom.credentialRef.innerHTML = options.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.description || item.id)}${item.enabled === false ? '（已停用）' : ''}</option>`).join('') + '<option value="">使用独立 API Key</option>';
        dom.credentialRef.value = selected;
        updatePoolCredentialMode();
        state.formModels = [cloneJson(FREE_MODEL)];
      }
      if (state.editingUpstreamId) {
        dom.saveUpstream.textContent = '保存修改';
      } else if (token) {
        dom.saveUpstream.textContent = '导入登录态以新增';
      } else {
        dom.saveUpstream.textContent = '新增上游账号';
      }
      const presetHint = el('upstreamPresetHint');
      if (presetHint) {
        presetHint.textContent = isPoolPreset(preset) ? '对路由固定提供 free；内部模型按价格与能力自动同步，免费资格不明确的模型不会调用。' : ({'sub2api':'使用 Sub2API 网关 API Key，自动读取其 Key、钱包或订阅金额；模型目录无需单独填写接口。','glm-cn':'自动读取推理额度窗口，工具额度不影响模型转发。','glm-global':'自动读取推理额度窗口，工具额度不影响模型转发。','opencode-go':'自动读取套餐额度；每个会话保持稳定的上游连接标识。','openrouter':'使用同一转发凭证读取账户余额和 Key 限额。','opencode-zen':'支持模型转发和同步；平台尚未提供已验证的普通 Key 余额接口。'}[preset.id]) || (preset.id === 'custom'
          ? '自定义接口需要维护 Base URL 和模型列表接口。'
          : '内置平台的接口地址与模型发现规则由系统维护。');
      }
    }

    function updatePoolCredentialMode() {
      if (!isPoolPreset(dom.preset.value)) return;
      const reference = Boolean(dom.credentialRef?.value);
      dom.apiKeyField.hidden = reference;
      dom.apiKey.disabled = reference;
      if (reference) dom.apiKey.value = '';
    }

    function fillPoolSettings(config) {
      const settings = { ...POOL_DEFAULTS, ...(config?.pool || {}) };
      dom.poolSyncInterval.value = settings.sync_interval_seconds;
      dom.poolMaxStale.value = settings.max_stale_seconds;
      dom.poolMaxAttempts.value = settings.max_attempts;
      dom.poolStrategy.value = settings.strategy;
      dom.poolTiers.value = JSON.stringify(settings.tiers || {}, null, 2);
    }

    function readPoolSettings() {
      let tiers;
      try { tiers = JSON.parse(dom.poolTiers.value || '{}'); }
      catch { throw new Error('质量分级 JSON 格式不正确'); }
      return normalizePoolSettings({
        sync_interval_seconds: dom.poolSyncInterval.value,
        max_stale_seconds: dom.poolMaxStale.value,
        max_attempts: dom.poolMaxAttempts.value,
        strategy: dom.poolStrategy.value, tiers,
      });
    }

    function renderModelEditor() {
      if (!dom.modelsEditor) {
        return;
      }
      if (isPoolPreset(dom.preset.value)) { dom.modelsEditor.innerHTML = ''; return; }
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
      if (isPoolPreset(dom.preset.value)) return [cloneJson(FREE_MODEL)];
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
      fillPoolSettings();
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
      fillPoolSettings(selectedAccountConfig());
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
      const pool = isPoolPreset(providerId);
      const models = pool ? [FREE_MODEL] : Array.isArray(config.models) ? config.models : [];
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
              <div class="fact-value quota-line">${pool ? `<span class="route-status-chip ${['ready', 'available', 'ok'].includes(config.pool_status?.state) ? 'ok' : 'warn'}">${escapeHtml(poolStateLabel(config.pool_status?.state))}</span><span class="quota-detail">${config.pool_status?.models?.length || 0} 个内部模型 · 独立于付费套餐额度</span>` : renderQuotaCell(config.quota)}</div>
            </div>
            <div>
              <span class="fact-label">路由引用</span>
              <div class="fact-value">${refs.length ? refs.map(id => `<span class="tag">${escapeHtml(id)}</span>`).join('') : '<span class="quota-detail">尚未被引用</span>'}</div>
            </div>
          </div>
          <div class="account-actions">
            <button class="secondary" type="button" data-edit-upstream="${escapeHtml(config.id)}">编辑</button>
            ${pool ? `<button class="secondary" type="button" data-pool-details="${escapeHtml(config.id)}">免费池详情</button>` : `<button class="secondary" type="button" data-sync-account="${escapeHtml(config.id)}">同步模型</button><button class="secondary" type="button" data-refresh-quota="${escapeHtml(config.id)}">刷新额度</button>`}
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
            protocols: Array.isArray(remote.protocols)
              ? [...remote.protocols]
              : initialModelProtocols(getPreset(dom.preset.value)),
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
      if (isPoolPreset(preset)) throw new Error('免费池由系统自动同步，保存后可在免费池详情中查看');
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

      if (isPoolPreset(preset)) {
        item.models = [cloneJson(FREE_MODEL)];
        item.credential_ref = dom.credentialRef.value || '';
        item.pool = readPoolSettings();
      }
      if (!state.editingUpstreamId && !isTokenPreset(preset) && !apiKey && !item.credential_ref) {
        throw new Error('新增账号需要填写 API Key');
      }
      if (!item.base_url && preset.id === 'sub2api') throw new Error('Sub2API 需要填写网关 Base URL');
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

    function renderPoolDetails(config) {
      const status = config.pool_status || {};
      const models = Array.isArray(status.models) ? status.models : [];
      dom.poolTitle.textContent = config.description || config.id;
      dom.poolStatus.textContent = `${poolStateLabel(status.state)} · 最后成功同步：${formatPoolTime(status.last_sync_at)}${status.error ? ` · ${poolValue(status.error)}` : ''}`;
      const last = status.last_request;
      const source = config.credential_ref ? `复用 ${accountLabel(config.credential_ref)}` : '独立 API Key';
      dom.poolDetail.innerHTML = `
        <div class="pool-detail-summary"><span class="tag mono">free</span><span>${escapeHtml(source)}</span><span>${models.length} 个内部候选</span></div>
        <p class="field-hint">${config.pool?.strategy === 'fastest' ? '速度优先' : '质量分级优先，同档结合近期成功率和速度'}。未分级的模型视为同档，不代表自动评定质量。目录能力与价格不明确时不会调用。</p>
        <p class="pool-request-point"><strong>最近实际落点</strong><span class="mono">${escapeHtml(last ? poolValue(last) : '尚未发生请求')}</span></p>
        <div class="pool-model-list">${models.map((model, index) => {
          const latency = Number.isFinite(model.latency_ms) ? `${Math.round(model.latency_ms)} ms` : '暂无样本';
          const success = Number.isFinite(model.success_rate) ? `${Math.round(model.success_rate <= 1 ? model.success_rate * 100 : model.success_rate)}%` : '暂无样本';
          const capabilities = Object.entries(model.capabilities || {}).filter(([, enabled]) => enabled === true).map(([name]) => ({ tools: '工具', images: '图片', streaming: '流式', structuredOutput: '结构化输出' })[name] || name);
          return `<article class="pool-model-card">
            <div class="pool-model-heading"><strong class="mono">${index + 1}. ${escapeHtml(model.id)}</strong><span class="route-status-chip ${model.status === 'ok' || model.status === 'available' ? 'ok' : 'warn'}">${escapeHtml(poolStateLabel(model.status))}</span></div>
            <p class="field-hint">质量档位：${escapeHtml(model.quality_tier ?? '未分级')} · 依据：${escapeHtml(poolValue(model.quality_source) || '未分级，同档比较速度与成功率')}</p>
            <div class="pool-model-metrics"><span>近期响应 ${escapeHtml(latency)}</span><span>成功率 ${escapeHtml(success)}</span><span>上下文 ${escapeHtml(model.context_window || '未核实')}</span></div>
            <p class="field-hint">${escapeHtml(capabilities.join(' · ') || '仅已核实的基础文本能力')}${model.until ? ` · 恢复时间 ${escapeHtml(formatPoolTime(model.until))}` : ''}</p>
            <details class="advanced-settings"><summary>免费资格依据</summary><pre class="pool-evidence">${escapeHtml(poolValue(model.free_evidence) || '等待核验')}</pre></details>
          </article>`;
        }).join('') || '<div class="empty">暂无已核实的免费候选。可刷新目录查看最新结果；收费或资格不明确的模型不会加入。</div>'}</div>
        <details class="advanced-settings" style="margin-top:16px"><summary>同步来源与时间</summary><div class="advanced-settings-body"><p class="field-hint">最后尝试：${escapeHtml(formatPoolTime(status.last_attempt_at))}</p><pre class="pool-evidence">${escapeHtml(poolValue(status.source_urls || []))}</pre></div></details>`;
    }

    function openPoolDetails(configId) {
      const config = getAccountConfig(configId);
      if (!config || !isPoolPreset(config.preset)) return;
      state.poolDetailId = configId;
      renderPoolDetails(config);
      openLayer('poolDetailsDialog');
    }

    async function refreshPool() {
      const configId = state.poolDetailId;
      if (!configId) return;
      dom.poolRefresh.disabled = true;
      dom.poolStatus.textContent = '正在核验免费模型目录…';
      try {
        const result = await requestJson(`/admin/api/upstreams/${encodeURIComponent(configId)}/pool-refresh`, { method: 'POST', body: '{}' });
        await loadAll();
        if (state.poolDetailId === configId) renderPoolDetails(result.upstream || { ...getAccountConfig(configId), pool_status: result.pool_status });
      } catch (error) {
        if (state.poolDetailId === configId) dom.poolStatus.textContent = `同步失败：${error.message}；保留上次有效模型列表。`;
      } finally { dom.poolRefresh.disabled = false; }
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
          models: isPoolPreset(config.preset) ? [FREE_MODEL] : config.models,
          pool: isPoolPreset(config.preset),
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
              <span>${escapeHtml(target.model || '未选择模型')} · 支持协议：${escapeHtml((model?.protocols || []).map(protocolLabel).join('、') || '未声明')}</span>
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
            <select id="routeTargetModelSelect" data-target-editor-field="model" ${account.pool ? 'disabled' : ''}>
              ${account.models.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === model?.id ? 'selected' : ''}>${escapeHtml(item.id)}</option>`).join('')}
            </select>
          </div>
        </div>
        ${account.pool ? '<p class="field-hint">免费池固定使用 free，内部真实模型由池自动选择。</p>' : ''}
        <p class="field-hint">支持协议：${escapeHtml(protocols.map(protocolLabel).join('、') || '未声明')}。按请求入口自动匹配原生协议，不匹配时跳过此候选。</p>
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
      if (!accountId || !modelId) {
        throw new Error('请选择上游账号和后端模型');
      }
      const duplicate = state.formTargets.some((target, index) => (
        index !== state.editingTargetIndex
        && target.config_id === accountId
        && target.model === modelId
      ));
      if (duplicate) {
        throw new Error('这个上游与模型组合已经在候选列表中');
      }
      const nextTarget = { config_id: accountId, model: modelId };
      if (state.editingTargetIndex !== null && state.formTargets[state.editingTargetIndex]?.id) nextTarget.id = state.formTargets[state.editingTargetIndex].id;
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
              <button class="secondary" type="button" data-test-route="${escapeHtml(route.id)}">测试</button>
              <button class="secondary" type="button" data-edit-route="${escapeHtml(route.id)}">编辑</button>
              <button class="danger" type="button" data-delete-route="${escapeHtml(route.id)}">删除</button>
            </div>
          </div>
          <ol class="route-chain">
            ${targets.map((target, index) => {
              const model = getAccountOptions().find(account => account.id === target.config_id)?.models.find(model => model.id === target.model);
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
                    <span class="tag">支持协议：${escapeHtml((model?.protocols || []).map(protocolLabel).join('、') || '未声明')}</span>
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

    const testRunner = createRouteTestRunner({
      async execute(job, signal) {
        const started = Date.now();
        const response = await windowScope.fetch(requestUrl('/admin/api/model-routes/test'), {
          method: 'POST', signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(job.request),
        });
        const text = await response.text();
        let payload;
        try {
          payload = JSON.parse(text);
        } catch (error) {
          payload = { error: { message: text || '服务返回了空响应' } };
        }
        return normalizeTestResult(payload, response.status, Date.now() - started);
      },
      onChange(snapshot) {
        state.testRun = snapshot;
        renderTestResults();
      },
    });

    function renderTestResults() {
      if (!dom.testResults) return;
      const { running, stopped, items } = state.testRun;
      dom.testRouteButton.disabled = running;
      dom.testCandidatesButton.disabled = running || !state.testRoute?.targets?.length;
      dom.testInput.disabled = running;
      dom.testProtocol.disabled = running;
      dom.testStopButton.hidden = !running;
      const completed = items.filter(item => item.state === 'done').length;
      dom.testStatus.textContent = stopped ? `已停止，完成 ${completed} / ${items.length} 项。` : running
        ? `正在测试 ${Math.min(completed + 1, items.length)} / ${items.length} 项…`
        : items.length ? `测试完成，共 ${completed} 项。` : '输入内容后选择测试方式。';
      dom.testResults.innerHTML = items.map((item, index) => {
        const result = item.result;
        const label = item.state === 'waiting' ? '等待中' : item.state === 'running' ? '请求中' : item.state === 'cancelled' ? '已取消'
          : item.error ? '请求失败' : result?.outcome === 'skipped' ? '已跳过' : result?.outcome === 'success' ? '可用' : '不可用';
        const tone = item.state !== 'done' || result?.outcome === 'skipped' ? 'warn' : result?.outcome === 'success' ? 'ok' : 'danger';
        const attempts = result?.attempts || [];
        const last = attempts[attempts.length - 1];
        const selection = last ? `${last.account_label || accountLabel(last.config_id)} / ${last.model}` : '';
        const output = item.error || result?.error || result?.text || (result ? '没有文本内容，请展开完整响应查看详情。' : '');
        return `<article class="route-test-result">
          <div class="route-test-result-head"><strong>${index + 1}. ${escapeHtml(item.job.label)}</strong><span class="route-status-chip ${tone}">${label}</span></div>
          ${result ? `<p class="route-test-meta">${result.statusCode ? `HTTP ${escapeHtml(result.statusCode)}` : '未发送请求'} · ${escapeHtml(result.elapsedMs)} ms${selection ? ` · ${result.outcome === 'success' ? '命中' : '最后尝试'}：${escapeHtml(selection)}` : ''}</p>` : ''}
          ${attempts.length > 1 ? `<p class="field-hint">尝试顺序：${attempts.map(attempt => escapeHtml(`${attempt.account_label || accountLabel(attempt.config_id)} / ${attempt.model}`)).join(' → ')}</p>` : ''}
          ${output ? `<pre class="route-test-output">${escapeHtml(output)}</pre>` : ''}
          ${result ? `<details class="route-test-json"><summary>完整响应 JSON</summary><pre>${escapeHtml(JSON.stringify(result.raw, null, 2))}</pre></details>` : ''}
        </article>`;
      }).join('');
    }

    function openRouteTest(routeId) {
      const route = getRoutes().find(item => item.id === routeId);
      if (!route || !dom.testDialog) return;
      testRunner.stop();
      state.testRoute = cloneJson(route);
      state.testRun = { running: false, stopped: false, items: [] };
      dom.testRouteId.textContent = route.id;
      dom.testInput.value = '';
      const protocols = route.entry_protocols?.length ? route.entry_protocols : ['chat_completions'];
      dom.testProtocol.innerHTML = protocols.map(protocol => `<option value="${escapeHtml(protocol)}">${escapeHtml(protocolLabel(protocol))}</option>`).join('');
      renderTestResults();
      openLayer('routeTestDialog');
      dom.testInput.focus();
    }

    function runRouteTest(mode) {
      if (state.testRun.running || !state.testRoute) return;
      const input = dom.testInput.value;
      if (!input.trim()) {
        dom.testStatus.textContent = '请先输入要发送给模型的内容。';
        dom.testInput.focus();
        return;
      }
      const route = state.testRoute;
      const request = { model: route.id, input, mode, protocol: dom.testProtocol.value };
      const jobs = mode === 'route' ? [{ label: `路由入口 / ${route.id}`, request }] : (route.targets || []).map(target => ({
        label: `${accountLabel(target.config_id)} / ${target.model}`,
        request: { ...request, target_id: target.id },
      }));
      return testRunner.start(jobs);
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
        if (!target.config_id || !target.model) {
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
        targets: state.formTargets.map(({ id, config_id, model }) => ({ ...(id ? { id } : {}), config_id, model })),
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
          openSettings();
          return;
        }
        if (event.target.closest('[data-close-settings]')) {
          closeSettings();
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
        if (action === 'add-model') {
          syncModelsFromEditor();
          const protocols = initialModelProtocols(getPreset(dom.preset.value));
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

        const poolButton = event.target.closest('[data-pool-details]');
        if (poolButton) { openPoolDetails(poolButton.dataset.poolDetails); return; }
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

        const testRouteButton = event.target.closest('[data-test-route]');
        if (testRouteButton) {
          openRouteTest(testRouteButton.dataset.testRoute);
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

      dom.testRouteButton?.addEventListener('click', () => runRouteTest('route'));
      dom.testCandidatesButton?.addEventListener('click', () => runRouteTest('candidate'));
      dom.testStopButton?.addEventListener('click', () => testRunner.stop());

      dom.credentialRef?.addEventListener('change', updatePoolCredentialMode);
      dom.poolRefresh?.addEventListener('click', () => { void refreshPool(); });

      dom.preset.addEventListener('change', () => {
        if (!state.editingUpstreamId) {
          dom.baseUrl.value = getPreset(dom.preset.value)?.default_base_url || '';
        }
        state.discovery = null;
        renderDiscovery();
        updatePresetFields();
        fillPoolSettings();
        renderModelEditor();
      });

      dom.addModel.addEventListener('click', () => {
        syncModelsFromEditor();
        const protocols = initialModelProtocols(getPreset(dom.preset.value));
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
          renderTargetEditor(state.editingTargetIndex, {
            accountId,
            modelId: event.target.value,
          });
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
        void loadAll().then(() => {
          const addedIds = event.detail?.added_ids;
          if (source === 'token-import' && Array.isArray(addedIds) && addedIds.length === 1) {
            openAccount(addedIds[0]);
          }
        }).catch(handleError);
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
      doc.querySelectorAll("[data-page-link]").forEach(link => {
        link.href = requestUrl(`/admin/configs/${link.dataset.pageLink}`);
      });
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
      openRouteTest,
      openPoolDetails,
      refreshPool,
      runRouteTest,
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
    isPoolPreset,
    poolCredentialOptions,
    normalizePoolSettings,
    poolStateLabel,
    extractTestResponseText,
    normalizeTestResult,
    createRouteTestRunner,
    providerIdForConfig,
    getPresetLabel,
    formatQuotaSummary,
    protocolLabel,
    initialModelProtocols,
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
