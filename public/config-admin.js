(function attachConfigAdmin(globalScope) {
  function parseSseChunk(rawEvent) {
    const lines = String(rawEvent || '').split('\n');
    let eventName = '';
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
        continue;
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    return {
      eventName,
      dataText: dataLines.join('\n'),
    };
  }

  function parseResponsesEventStream(text) {
    const rawEvents = String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n\n');

    let completedResponse = null;
    let outputText = '';

    for (const rawEvent of rawEvents) {
      if (!rawEvent.trim()) {
        continue;
      }

      const parsed = parseSseChunk(rawEvent);
      if (!parsed.dataText || parsed.dataText === '[DONE]') {
        continue;
      }

      const payload = JSON.parse(parsed.dataText);
      const eventName = payload.type || parsed.eventName;

      if (eventName === 'response.output_text.delta' && typeof payload.delta === 'string') {
        outputText = `${outputText}${payload.delta}`;
      }

      if (!outputText && eventName === 'response.output_text.done' && typeof payload.text === 'string') {
        outputText = payload.text;
      }

      if (eventName === 'response.completed' && payload.response && typeof payload.response === 'object') {
        completedResponse = payload.response;
      }
    }

    if (completedResponse) {
      const hasStructuredOutput = Array.isArray(completedResponse.output) && completedResponse.output.length > 0;

      if (outputText && !hasStructuredOutput) {
        return {
          ...completedResponse,
          output_text: outputText,
        };
      }

      return completedResponse;
    }

    if (outputText) {
      return {
        output_text: outputText,
      };
    }

    return {};
  }

  function parseResponsesApiResponse(text, contentType) {
    const normalizedContentType = String(contentType || '').toLowerCase();
    const responseText = String(text || '');
    const looksLikeEventStream = responseText.startsWith('event: ') || responseText.includes('\nevent: ');

    if (!responseText) {
      return null;
    }

    if (normalizedContentType.includes('text/event-stream') || looksLikeEventStream) {
      return parseResponsesEventStream(responseText);
    }

    if (normalizedContentType.includes('application/json')) {
      return JSON.parse(responseText);
    }

    try {
      return JSON.parse(responseText);
    } catch (error) {
      return {
        message: responseText,
      };
    }
  }

  function extractErrorMessage(payload, fallbackMessage) {
    if (payload && typeof payload === 'object') {
      if (typeof payload.details === 'string' && payload.details) {
        return payload.details;
      }

      if (typeof payload.message === 'string' && payload.message) {
        return payload.message;
      }

      if (payload.error && typeof payload.error === 'object' && typeof payload.error.message === 'string' && payload.error.message) {
        return payload.error.message;
      }

      if (typeof payload.error === 'string' && payload.error) {
        return payload.error;
      }
    }

    return fallbackMessage;
  }

  function buildJsonRequestOptions(options) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};

    return {
      ...normalizedOptions,
      headers: {
        'Content-Type': 'application/json',
        ...(normalizedOptions.headers || {}),
      },
    };
  }

  function buildConfigSnapshotRequest(forceRefresh = false) {
    if (forceRefresh) {
      return {
        url: '/admin/api/configs/refresh',
        options: {
          method: 'POST',
        },
      };
    }

    return {
      url: '/admin/api/configs',
      options: {},
    };
  }

  function buildRequestUrl(url, options = {}) {
    const origin = options.origin || 'http://localhost';
    const adminAuthToken = typeof options.adminAuthToken === 'string' ? options.adminAuthToken : '';
    const resolved = new URL(url, origin);

    if (adminAuthToken && resolved.pathname.startsWith('/admin/')) {
      resolved.searchParams.set('auth_token', adminAuthToken);
    }

    return `${resolved.pathname}${resolved.search}`;
  }

  function getPreferredApiKey(snapshot) {
    const apikeys = Array.isArray(snapshot && snapshot.apikeys) ? snapshot.apikeys : [];
    return typeof apikeys[0] === 'string' ? apikeys[0] : '';
  }

  function maskSecret(value) {
    const text = String(value || '').trim();
    if (!text) {
      return '-';
    }

    if (text.length <= 8) {
      return '***';
    }

    return `${text.slice(0, 3)}-...${text.slice(-4)}`;
  }

  function normalizeText(value) {
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  }

  function normalizeBaseUrl(value) {
    return normalizeText(value).replace(/\/+$/, '');
  }

  function normalizeSupport(values) {
    const list = Array.isArray(values) ? values : [];
    const normalized = [];

    for (const value of list) {
      const item = normalizeText(value).toLowerCase();
      if ((item === 'gpt' || item === 'claude') && !normalized.includes(item)) {
        normalized.push(item);
      }
    }

    return normalized.length ? normalized : ['gpt'];
  }

  function parseJsonObject(rawText, label) {
    const parsed = parseJsonValue(rawText, label);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${label} 必须是 JSON 对象`);
    }

    return parsed;
  }

  function parseJsonValue(rawText, label) {
    try {
      return JSON.parse(String(rawText || '').trim());
    } catch (error) {
      throw new Error(`${label} 解析失败: ${error.message}`);
    }
  }

  function parseLooseJsonValue(rawText, label) {
    const text = String(rawText || '').trim();
    const candidates = [
      text,
      text.replace(/,\s*([}\]])/g, '$1'),
    ];

    if (text.startsWith('[') && /},\s*$/.test(text)) {
      candidates.push(`${text.replace(/,\s*$/, '')}]`);
    }

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      try {
        return JSON.parse(candidate);
      } catch (error) {
        // Try the next tolerated paste shape before reporting a parse error.
      }
    }

    return parseJsonValue(rawText, label);
  }

  function isOAuthExportItem(value) {
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.credentials &&
      typeof value.credentials === 'object' &&
      !Array.isArray(value.credentials) &&
      normalizeText(value.credentials.access_token)
    );
  }

  function normalizeOAuthExportItem(item) {
    const credentials = item.credentials || {};
    const extra = item.extra && typeof item.extra === 'object' && !Array.isArray(item.extra)
      ? item.extra
      : {};
    const accessToken = normalizeText(credentials.access_token);
    const accountId = normalizeText(credentials.chatgpt_account_id) ||
      normalizeText(credentials.account_id) ||
      normalizeText(extra.chatgpt_account_id) ||
      normalizeText(extra.account_id);

    if (!accessToken || !accountId) {
      throw new Error('OAuth 导出项必须包含 credentials.access_token 和 chatgpt_account_id');
    }

    const imported = {
      description: normalizeText(credentials.email) || normalizeText(extra.email) || normalizeText(item.name) || accountId,
      account_id: accountId,
      access_token: accessToken,
    };
    const refreshToken = normalizeText(credentials.refresh_token);
    const clientId = normalizeText(credentials.client_id);

    if (refreshToken) {
      imported.refresh_token = refreshToken;
    }

    if (clientId) {
      imported.client_id = clientId;
    }

    return imported;
  }

  function normalizeOAuthExportInput(rawText) {
    const parsed = parseLooseJsonValue(rawText, 'OAuth 导出 JSON');
    const items = Array.isArray(parsed) ? parsed : [parsed];

    if (!items.every(isOAuthExportItem)) {
      throw new Error('OAuth 导出 JSON 必须是包含 credentials.access_token 的对象或对象数组');
    }

    return items.map(normalizeOAuthExportItem);
  }

  function buildConfigItemFromForm(values) {
    const formValues = values && typeof values === 'object' ? values : {};
    const mode = normalizeText(formValues.mode || 'token').toLowerCase();

    if (mode === 'token') {
      const rawTokenJson = formValues.tokenRawJson;
      let parsed;
      try {
        parsed = parseJsonValue(rawTokenJson, 'AuthSession JSON');
      } catch (error) {
        return normalizeOAuthExportInput(rawTokenJson);
      }
      const parsedItems = Array.isArray(parsed) ? parsed : [parsed];
      if (parsedItems.length > 0 && parsedItems.every(isOAuthExportItem)) {
        return normalizeOAuthExportInput(rawTokenJson);
      }

      if (Array.isArray(parsed)) {
        if (parsed.length === 0) {
          throw new Error('AuthSession JSON 数组不能为空');
        }
        parsed.forEach((item, index) => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error(`AuthSession JSON 数组第 ${index + 1} 项必须是 JSON 对象`);
          }
        });
        return parsed;
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('AuthSession JSON 必须是 JSON 对象或对象数组');
      }
      return parsed;
    }

    if (mode !== 'apikey') {
      throw new Error('请选择 token 或 apikey 模式');
    }

    const apikey = normalizeText(formValues.apiKey);
    const baseUrl = normalizeBaseUrl(formValues.baseUrl);

    if (!apikey) {
      throw new Error('apikey 模式下请填写 API Key');
    }

    if (!baseUrl) {
      throw new Error('apikey 模式下请填写 Base URL');
    }

    return {
      type: 'apikey',
      apikey,
      base_url: baseUrl,
      description: normalizeText(formValues.description),
      support: normalizeSupport(formValues.support),
    };
  }

  function getConfigGuideContent(snapshot) {
    return {
      steps: [
        {
          title: '选择模式',
          description: 'OpenAI token 是 Responses 主链路，Claude token 是 Messages 主链路，apikey 只作为对应链路的兜底上游。',
          actionText: '打开 ChatGPT',
          actionHref: 'https://chatgpt.com/',
        },
        {
          title: 'OpenAI token',
          description: '建议使用浏览器隐私模式登录 ChatGPT 后打开 AuthSession 页面，把返回的 AuthSession JSON 粘贴到文本框里。粘贴后不要退出该登录态，否则 token 会失效。',
          example: JSON.stringify({
            user: {
              email: 'user@example.com',
            },
            account: {
              id: 'account-id',
            },
            accessToken: '...',
            refresh_token: '...',
          }, null, 2),
          actionText: '复制 AuthSession 页面',
          actionCopyText: 'https://chatgpt.com/api/auth/session',
        },
        {
          title: 'Fallback apikey',
          description: '直接用输入框填写 Base URL、API Key 和备注，再选择这个兜底上游支持 GPT、Claude 或两者。普通 OpenAI 兼容服务选 GPT；Claude Messages 原样转发选 Claude。',
        },
      ],
      rawJsonPlaceholder: JSON.stringify({
        user: {
          email: 'user@example.com',
        },
        account: {
          id: 'account-id',
        },
        accessToken: '...',
        refresh_token: '...',
      }, null, 2),
    };
  }

  function hasApiKeyConfig(snapshot) {
    const configs = Array.isArray(snapshot && snapshot.configs) ? snapshot.configs : [];
    const disabledConfigs = Array.isArray(snapshot && snapshot.disabled_configs) ? snapshot.disabled_configs : [];
    return [...configs, ...disabledConfigs].some(item => {
      const configItem = item && item.item ? item.item : item;
      return configItem && (configItem.type === 'apikey' || configItem.type === 'claude_token');
    });
  }

  function getConfigItem(item) {
    return item && item.item ? item.item : item;
  }

  function getConfigType(item) {
    const configItem = getConfigItem(item);
    const type = normalizeText(configItem && configItem.type).toLowerCase();
    return type || 'token';
  }

  function getApiKeySupport(item) {
    const configItem = getConfigItem(item);
    return normalizeSupport(configItem && configItem.support);
  }

  function configSupports(item, capability) {
    return getApiKeySupport(item).includes(capability);
  }

  function getConfigRole(item) {
    const type = getConfigType(item);
    if (type === 'claude_token') {
      return {
        key: 'claude-token',
        label: 'Claude token',
        lane: 'Claude Messages',
        priority: '主链路',
        tone: 'active',
      };
    }

    if (type === 'apikey') {
      const support = getApiKeySupport(item);
      if (support.includes('gpt') && support.includes('claude')) {
        return {
          key: 'fallback-both',
          label: 'API key',
          lane: '双链路 fallback',
          priority: '兜底',
          tone: 'muted',
        };
      }

      if (support.includes('claude')) {
        return {
          key: 'fallback-claude',
          label: 'API key',
          lane: 'Claude fallback',
          priority: '兜底',
          tone: 'muted',
        };
      }

      return {
        key: 'fallback-gpt',
        label: 'API key',
        lane: 'Responses fallback',
        priority: '兜底',
        tone: 'muted',
      };
    }

    return {
      key: 'openai-token',
      label: 'OpenAI token',
      lane: 'Responses',
      priority: '主链路',
      tone: 'ok',
    };
  }

  function getConfigCollection(snapshot, key) {
    return Array.isArray(snapshot && snapshot[key]) ? snapshot[key] : [];
  }

  function getEnabledConfigsByRole(snapshot, predicate) {
    return getConfigCollection(snapshot, 'configs').filter(item => predicate(item && item.item ? item.item : item));
  }

  function getFallbackConfigs(snapshot, capability) {
    return getEnabledConfigsByRole(snapshot, item => getConfigType(item) === 'apikey' && configSupports(item, capability));
  }

  function getPrimaryConfigs(snapshot, type) {
    return getEnabledConfigsByRole(snapshot, item => getConfigType(item) === type);
  }

  function getRouteLanes(snapshot) {
    const openAiTokens = getPrimaryConfigs(snapshot, 'token');
    const claudeTokens = getPrimaryConfigs(snapshot, 'claude_token');
    const gptFallbacks = getFallbackConfigs(snapshot, 'gpt');
    const claudeFallbacks = getFallbackConfigs(snapshot, 'claude');

    return [
      {
        key: 'responses',
        title: 'Responses 链路',
        endpoint: '/v1/responses',
        primaryLabel: 'OpenAI token',
        fallbackLabel: 'GPT apikey',
        primary: openAiTokens,
        fallback: gptFallbacks,
        description: 'OpenAI token 负责主请求；全部不可用时才使用 GPT apikey。',
      },
      {
        key: 'messages',
        title: 'Claude Messages 链路',
        endpoint: '/v1/messages',
        primaryLabel: 'Claude token',
        fallbackLabel: 'Claude apikey',
        primary: claudeTokens,
        fallback: claudeFallbacks,
        description: 'Claude token 负责原样转发；全部不可用时才使用 Claude apikey。',
      },
      {
        key: 'converted-messages',
        title: 'Messages 转换兜底',
        endpoint: '/v1/messages -> /v1/responses',
        primaryLabel: 'OpenAI token',
        fallbackLabel: 'GPT apikey',
        primary: openAiTokens,
        fallback: gptFallbacks,
        description: 'Claude 直转链路不可用时，才把 Messages 转成 Responses。',
      },
    ];
  }

  function getConfigIdentityColumnLabel(snapshot) {
    return hasApiKeyConfig(snapshot) ? '上游配置' : 'account_id';
  }

  function getConfigIdentityValue(snapshot, item) {
    const configItem = item && item.item ? item.item : item;

    if (configItem && configItem.type === 'apikey') {
      const baseUrl = typeof configItem.base_url === 'string' && configItem.base_url.trim()
        ? configItem.base_url.trim()
        : '-';
      const apikey = configItem && configItem.apikey;

      return `${baseUrl} (${maskSecret(apikey)})`;
    }

    if (configItem && configItem.type === 'claude_token') {
      const baseUrl = typeof configItem.base_url === 'string' && configItem.base_url.trim()
        ? configItem.base_url.trim()
        : 'https://api.anthropic.com';
      const identity = configItem.local_auth_token || configItem.account_uuid || configItem.access_token;

      return `${baseUrl} (${maskSecret(identity)})`;
    }

    const value = configItem && configItem.account_id;

    return typeof value === 'string' && value.trim() ? value.trim() : '-';
  }

  function formatConfigItemCopyText(item) {
    const configItem = item && item.item ? item.item : item;

    return JSON.stringify(configItem || {}, null, 2);
  }

  function hasRefreshTokenConfig(item) {
    const configItem = item && item.item ? item.item : item;

    return Boolean(configItem && configItem.type !== 'apikey' && typeof configItem.refresh_token === 'string' && configItem.refresh_token.trim());
  }

  function getRuntimeSummaryText(runtime) {
    return typeof runtime?.runtime_summary === 'string' ? runtime.runtime_summary : '';
  }

  function hasRuntimeProblem(runtime) {
    const text = getRuntimeSummaryText(runtime).toLowerCase();

    return text.includes('可用=否')
      || text.includes('timeout')
      || text.includes('401')
      || text.includes('quota')
      || text.includes('失败')
      || text.includes('错误=');
  }

  function getActiveConfigLabel(snapshot) {
    const configs = Array.isArray(snapshot && snapshot.configs) ? snapshot.configs : [];
    const active = configs.find(item => item && item.is_active);

    return active && Number.isInteger(active.index) ? `配置 #${active.index + 1}` : '自动调度';
  }

  function formatObservedDispatchSession(observedSession) {
    if (!observedSession || typeof observedSession !== 'object') {
      return '';
    }

    const sessionStatus = formatDispatchSessionStatus({
      in_flight: observedSession.in_flight,
      dispatch_session: observedSession,
    });
    if (!sessionStatus) {
      return '';
    }

    const configIndex = Number(observedSession.config_index);
    const configLabel = Number.isInteger(configIndex)
      ? `配置 #${configIndex + 1}`
      : typeof observedSession.config_label === 'string' && observedSession.config_label.trim()
        ? observedSession.config_label.trim()
        : '未知配置';

    return `${sessionStatus.title} ${sessionStatus.label} -> ${configLabel}`;
  }

  function getDispatchModeSummary(snapshot) {
    const dispatch = snapshot && snapshot.dispatch && typeof snapshot.dispatch === 'object'
      ? snapshot.dispatch
      : null;
    if (dispatch && dispatch.mode === 'apikey_fallback_focus') {
      return {
        value: dispatch.label || 'Fallback apikey 焦点',
        tone: 'active',
        detail: dispatch.detail || 'apikey 只在对应 token 链路不可用时兜底',
      };
    }

    if (dispatch && dispatch.mode === 'claude_token_focus') {
      return {
        value: dispatch.label || 'Claude token 焦点',
        tone: 'active',
        detail: dispatch.detail || 'Claude token 负责 /v1/messages 主链路',
      };
    }

    if (dispatch && dispatch.mode === 'token_pool') {
      const observedDetail = formatObservedDispatchSession(dispatch.observed_session);
      return {
        value: dispatch.label || 'OpenAI token 池',
        tone: 'active',
        detail: observedDetail || dispatch.detail || 'OpenAI token 负责 Responses 主链路',
      };
    }

    const configs = Array.isArray(snapshot && snapshot.configs) ? snapshot.configs : [];
    const active = configs.find(item => item && item.is_active);
    if (active && active.item && active.item.type === 'apikey') {
      return {
        value: `Fallback apikey 焦点: 配置 #${active.index + 1}`,
        tone: 'active',
        detail: 'apikey 只在对应 token 链路不可用时兜底',
      };
    }

    if (active && active.item && active.item.type === 'claude_token') {
      return {
        value: `Claude token 焦点: 配置 #${active.index + 1}`,
        tone: 'active',
        detail: 'Claude token 负责 /v1/messages 主链路',
      };
    }

    if (active) {
      return {
        value: `OpenAI token 池: 焦点配置 #${active.index + 1}`,
        tone: 'active',
        detail: 'OpenAI token 负责 Responses 主链路，apikey 仅作 fallback',
      };
    }

    return {
      value: '无可用配置',
      tone: 'muted',
      detail: '请先添加 OpenAI token、Claude token 或 fallback apikey',
    };
  }

  function formatDispatchSessionStatus(runtime) {
    const session = runtime && typeof runtime === 'object'
      ? runtime.dispatch_session || runtime.dispatchSession
      : null;
    if (!session || typeof session !== 'object') {
      return null;
    }

    const sessionHash = typeof session.session_hash === 'string' && session.session_hash
      ? session.session_hash
      : typeof session.sessionHash === 'string' && session.sessionHash
        ? session.sessionHash
        : '';
    const label = typeof session.label === 'string' && session.label.trim()
      ? session.label.trim()
      : sessionHash
        ? `#${sessionHash}`
        : '匿名请求';
    const active = Boolean(session.active);
    const sticky = Boolean(session.sticky);
    const fallback = Boolean(session.fallback);
    const hasSessionKey = Boolean(session.has_session_key || session.hasSessionKey || sessionHash);
    const inFlight = Number(runtime.in_flight ?? runtime.inFlight);
    const detailParts = [];

    if (active) {
      detailParts.push(Number.isFinite(inFlight) && inFlight > 1
        ? `进行中 ${Math.floor(inFlight)}`
        : '进行中');
    } else {
      detailParts.push('已释放');
    }

    if (fallback) {
      detailParts.push('fallback');
    }

    if (!sticky && !hasSessionKey) {
      detailParts.push('匿名');
    }

    return {
      title: active ? '当前会话' : '最近会话',
      label,
      detail: detailParts.join(' · '),
      active,
      tone: active ? 'active' : 'muted',
    };
  }

  function normalizeModelName(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
  }

  function modelNameHasVersionPrefix(model, prefix) {
    const normalizedModel = normalizeModelName(model);
    const normalizedPrefix = normalizeModelName(prefix);
    if (!normalizedModel || !normalizedPrefix) {
      return false;
    }

    if (normalizedModel === normalizedPrefix) {
      return true;
    }

    if (!normalizedModel.startsWith(normalizedPrefix)) {
      return false;
    }

    const suffix = normalizedModel.slice(normalizedPrefix.length);
    return /^-\d{4}-\d{2}-\d{2}(?:$|[-._])/.test(suffix);
  }

  function areResponseModelsConsistent(requestModel, responseModel) {
    return modelNameHasVersionPrefix(responseModel, requestModel) ||
      modelNameHasVersionPrefix(requestModel, responseModel);
  }

  function formatResponseModelStatus(runtime) {
    const model = runtime && typeof runtime === 'object'
      ? runtime.response_model || runtime.responseModel
      : null;
    if (!model || typeof model !== 'object') {
      return null;
    }

    const requestModel = typeof model.request_model === 'string' && model.request_model.trim()
      ? model.request_model.trim()
      : typeof model.requestModel === 'string' && model.requestModel.trim()
        ? model.requestModel.trim()
        : '';
    const responseModel = typeof model.response_model === 'string' && model.response_model.trim()
      ? model.response_model.trim()
      : typeof model.responseModel === 'string' && model.responseModel.trim()
        ? model.responseModel.trim()
        : '';
    const statusCode = Number(model.status_code ?? model.statusCode);
    const active = Boolean(model.active);
    const downgraded = Boolean(model.downgraded);
    const detailParts = [];

    if (active) {
      detailParts.push('进行中');
    }

    if (downgraded) {
      detailParts.push('已降级');
    }

    const modelsDiffer = Boolean(
      requestModel &&
      responseModel &&
      !areResponseModelsConsistent(requestModel, responseModel)
    );

    if (modelsDiffer) {
      detailParts.push(`请求 ${requestModel}`);
    }

    if (Number.isInteger(statusCode) && statusCode > 0) {
      detailParts.push(`HTTP ${statusCode}`);
    }

    return {
      title: responseModel ? '响应模型' : '请求模型',
      label: responseModel || requestModel || '等待响应',
      detail: detailParts.join(' · '),
      active,
      tone: modelsDiffer ? 'warn' : active ? 'active' : 'muted',
    };
  }

  function moveConfigSnapshotItem(snapshot, fromIndex, toIndex = 0) {
    const data = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const configs = Array.isArray(data.configs) ? data.configs.slice() : [];
    const normalizedFromIndex = Number(fromIndex);
    const normalizedToIndex = Number(toIndex);

    if (
      !Number.isInteger(normalizedFromIndex) ||
      !Number.isInteger(normalizedToIndex) ||
      normalizedFromIndex < 0 ||
      normalizedToIndex < 0 ||
      normalizedToIndex >= configs.length
    ) {
      return data;
    }

    const sourcePosition = configs.findIndex(item => Number(item && item.index) === normalizedFromIndex);
    if (sourcePosition < 0) {
      return data;
    }

    const [movedItem] = configs.splice(sourcePosition, 1);
    configs.splice(Math.min(normalizedToIndex, configs.length), 0, movedItem);

    const reindexedConfigs = configs.map((item, index) => {
      const nextItem = {
        ...item,
        index,
      };

      if (item && item.runtime && typeof item.runtime === 'object') {
        nextItem.runtime = {
          ...item.runtime,
          index,
        };
      }

      return nextItem;
    });
    const activeConfig = reindexedConfigs.find(item => item && item.is_active);

    return {
      ...data,
      active_config_index: activeConfig ? activeConfig.index : data.active_config_index,
      configs: reindexedConfigs,
    };
  }

  function formatProbeTime(value, options = {}) {
    const timestamp = Number(value);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
      return '';
    }

    const checkedAt = new Date(timestamp);
    if (Number.isNaN(checkedAt.getTime())) {
      return '';
    }

    const formatOptions = {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    };
    if (options.timeZone) {
      formatOptions.timeZone = options.timeZone;
    }

    return checkedAt.toLocaleTimeString(options.locale || 'zh-CN', formatOptions);
  }

  function formatProbeInterval(value) {
    const intervalMs = Number(value);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      return '';
    }

    const minutes = Math.max(1, Math.round(intervalMs / 60000));
    return `每 ${minutes} 分钟`;
  }

  function formatApiKeyRecoveryStatus(runtime, options = {}) {
    const recovery = runtime && typeof runtime === 'object'
      ? runtime.api_key_recovery || runtime.apiKeyRecovery
      : null;
    if (!recovery || typeof recovery !== 'object' || recovery.enabled === false) {
      return null;
    }

    const result = normalizeText(recovery.result || 'never').toLowerCase();
    const pending = Boolean(recovery.pending);
    const checkedAt = formatProbeTime(recovery.last_checked_at ?? recovery.lastCheckedAt, options);
    const model = normalizeText(recovery.model);
    const statusCode = Number(recovery.status_code ?? recovery.statusCode);
    const lastError = normalizeText(recovery.last_error ?? recovery.lastError);
    const intervalText = formatProbeInterval(recovery.interval_ms ?? recovery.intervalMs);
    const detailParts = [];

    if (checkedAt) {
      detailParts.push(`上次 ${checkedAt}`);
    }

    if (model) {
      detailParts.push(`模型 ${model}`);
    }

    if (Number.isInteger(statusCode) && statusCode > 0) {
      detailParts.push(`HTTP ${statusCode}`);
    }

    if (lastError) {
      detailParts.push(lastError);
    }

    if (intervalText) {
      detailParts.push(`仅不可用时${intervalText}恢复探测`);
    }

    if (result === 'success') {
      return {
        title: 'API Key 探测',
        label: '恢复成功',
        detail: detailParts.join(' · '),
        active: false,
        tone: 'ok',
      };
    }

    if (result === 'failed' || result === 'error') {
      return {
        title: 'API Key 探测',
        label: '仍不可用',
        detail: detailParts.join(' · '),
        active: false,
        tone: 'danger',
      };
    }

    return {
      title: 'API Key 探测',
      label: pending ? '等待探测' : '未触发',
      detail: detailParts.join(' · '),
      active: false,
      tone: pending ? 'warn' : 'muted',
    };
  }

  function extractRuntimeStatusTags(runtime) {
    const text = getRuntimeSummaryText(runtime);

    if (!text) {
      return [
        { label: '暂无运行态', tone: 'muted' },
      ];
    }

    const tags = [];
    const lower = text.toLowerCase();

    if (text.includes('可用=是')) {
      tags.push({ label: '可用', tone: 'ok' });
    } else if (text.includes('可用=否')) {
      tags.push({ label: '不可用', tone: 'danger' });
    }

    const quotaMatch = text.match(/额度=([^|]+)/);
    if (quotaMatch && quotaMatch[1]) {
      const value = quotaMatch[1].trim();
      tags.push({
        label: `额度 ${value}`,
        tone: value === 'unknown' ? 'warn' : 'ok',
      });
    }

    const refreshMatch = text.match(/刷新时间=([^|]+)/);
    if (refreshMatch && refreshMatch[1]) {
      const value = refreshMatch[1].trim();
      tags.push({
        label: `刷新 ${value}`,
        tone: value === 'unknown' ? 'warn' : 'muted',
      });
    }

    if (lower.includes('timeout')) {
      tags.push({ label: 'timeout', tone: 'danger' });
    } else if (lower.includes('401')) {
      tags.push({ label: '401', tone: 'danger' });
    } else if (text.includes('失败') || text.includes('错误=')) {
      tags.push({ label: '异常', tone: 'danger' });
    }

    return tags.length ? tags.slice(0, 4) : [
      { label: '已读取', tone: 'muted' },
    ];
  }

  function buildAdminStatusSummary(snapshot) {
    const apikeys = Array.isArray(snapshot && snapshot.apikeys) ? snapshot.apikeys : [];
    const configs = Array.isArray(snapshot && snapshot.configs) ? snapshot.configs : [];
    const problemCount = configs.filter(item => hasRuntimeProblem(item && item.runtime)).length;
    const problemTags = [];
    const runtimeText = configs
      .map(item => getRuntimeSummaryText(item && item.runtime).toLowerCase())
      .join(' ');

    if (runtimeText.includes('timeout')) {
      problemTags.push('timeout');
    }

    if (runtimeText.includes('401')) {
      problemTags.push('401');
    }

    if (runtimeText.includes('quota') || runtimeText.includes('额度')) {
      problemTags.push('额度');
    }

    return [
      {
        label: '入口 apikey',
        value: apikeys.length ? `${apikeys.length} 个` : '未配置',
        tone: apikeys.length ? 'ok' : 'warn',
        detail: apikeys.length ? '请求会校验入口 apikey' : '请求不会校验入口 apikey',
      },
      {
        label: '上游配置',
        value: `${configs.length} 个`,
        tone: configs.length ? 'ok' : 'warn',
        detail: 'Token 与 API Key 配置总数',
      },
      {
        label: '调度模式',
        value: getDispatchModeSummary(snapshot).value,
        tone: getDispatchModeSummary(snapshot).tone,
        detail: getDispatchModeSummary(snapshot).detail,
      },
      {
        label: '健康状态',
        value: problemCount ? `${problemCount} 个异常` : '未发现异常',
        tone: problemCount ? 'warn' : 'ok',
        detail: problemCount ? `发现 ${problemTags[0] || '运行态异常'}` : '基于当前运行态摘要',
      },
    ];
  }

  function buildHelloTestRequest(snapshot) {
    return {
      model: 'gpt-5.4-mini',
      instructions: '',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hello',
            },
          ],
        },
      ],
      tools: [],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    };
  }

  function buildHelloTestHeaders(sessionId) {
    const normalizedSessionId = typeof sessionId === 'string' && sessionId.trim()
      ? sessionId.trim()
      : 'airouter-test-request';

    return {
      originator: 'codex_cli_rs',
      version: '1.0.1',
      session_id: normalizedSessionId,
      'x-client-request-id': normalizedSessionId,
    };
  }

  function getResponsesModelAliases(snapshot) {
    const aliases = snapshot && snapshot.responses && snapshot.responses.model_aliases;
    return aliases && typeof aliases === 'object' && !Array.isArray(aliases) ? aliases : {};
  }

  function normalizePortValue(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535) {
      return value;
    }

    const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
    if (!/^\d+$/.test(text)) {
      return null;
    }

    const port = Number.parseInt(text, 10);
    return port >= 1 && port <= 65535 ? port : null;
  }

  function getConfiguredServicePort(snapshot) {
    return normalizePortValue(snapshot && snapshot.file_port)
      || normalizePortValue(snapshot && snapshot.runtime_port)
      || 3009;
  }

  function getRuntimeServicePort(snapshot) {
    return normalizePortValue(snapshot && snapshot.runtime_port)
      || getConfiguredServicePort(snapshot);
  }

  function getConfiguredProxyPort(snapshot) {
    return normalizePortValue(snapshot && snapshot.proxy_port);
  }

  function buildProxyAccessInfo(snapshot) {
    const configuredPort = getConfiguredServicePort(snapshot);
    const runtimePort = getRuntimeServicePort(snapshot);
    const baseUrl = `http://localhost:${runtimePort}`;
    const configuredBaseUrl = `http://localhost:${configuredPort}`;

    return {
      configuredPort,
      runtimePort,
      proxyPort: getConfiguredProxyPort(snapshot),
      baseUrl,
      responsesUrl: `${baseUrl}/v1/responses`,
      v1Url: `${baseUrl}/v1`,
      configuredV1Url: `${configuredBaseUrl}/v1`,
      portPendingRestart: configuredPort !== runtimePort,
    };
  }

  function buildRuntimeSyncText(options = {}) {
    const state = normalizeText(options.state || 'idle');

    if (state === 'refreshing') {
      return '正在刷新额度...';
    }

    if (state === 'error') {
      const errorText = normalizeText(options.error);
      return errorText ? `运行态同步失败: ${errorText}` : '运行态同步失败';
    }

    if (state === 'synced' && options.syncedAt) {
      const syncedAt = options.syncedAt instanceof Date ? options.syncedAt : new Date(options.syncedAt);
      if (!Number.isNaN(syncedAt.getTime())) {
        const formatOptions = {
          hour12: false,
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        };
        if (options.timeZone) {
          formatOptions.timeZone = options.timeZone;
        }

        return `运行态已同步: ${syncedAt.toLocaleTimeString(options.locale || 'zh-CN', formatOptions)}`;
      }
    }

    return '运行态尚未同步';
  }

  function formatResponsesModelAliasesInput(snapshot) {
    return JSON.stringify(getResponsesModelAliases(snapshot), null, 2);
  }

  function parseResponsesModelAliasesInput(rawText) {
    const normalizedText = String(rawText || '').trim();

    if (!normalizedText) {
      return {};
    }

    let parsed;
    try {
      parsed = JSON.parse(normalizedText);
    } catch (error) {
      throw new Error(`模型映射配置解析失败: ${error.message}`);
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('模型映射配置必须是 JSON 对象');
    }

    const normalized = {};
    for (const [sourceModel, targetModel] of Object.entries(parsed)) {
      const normalizedSource = String(sourceModel || '').trim();
      const normalizedTarget = typeof targetModel === 'string'
        ? targetModel.trim()
        : String(targetModel ?? '').trim();

      if (!normalizedSource) {
        throw new Error('模型映射配置的键必须是非空字符串');
      }

      if (!normalizedTarget) {
        throw new Error('模型映射配置的值必须是非空字符串');
      }

      normalized[normalizedSource] = normalizedTarget;
    }

    return normalized;
  }

  function extractResponseSummary(payload) {
    if (payload && typeof payload.output_text === 'string' && payload.output_text.trim()) {
      return payload.output_text.trim();
    }

    const output = Array.isArray(payload && payload.output) ? payload.output : [];
    const textParts = [];

    for (const item of output) {
      const content = Array.isArray(item && item.content) ? item.content : [];
      for (const entry of content) {
        if (entry && typeof entry.text === 'string' && entry.text.trim()) {
          textParts.push(entry.text);
        }
      }
    }

    return textParts.join('').trim();
  }

  const exported = {
    buildConfigSnapshotRequest,
    buildRequestUrl,
    buildJsonRequestOptions,
    parseResponsesApiResponse,
    extractErrorMessage,
    getPreferredApiKey,
    buildHelloTestHeaders,
    getConfigGuideContent,
    getConfigRole,
    getRouteLanes,
    getConfigType,
    configSupports,
    getConfigIdentityColumnLabel,
    getConfigIdentityValue,
    formatConfigItemCopyText,
    buildConfigItemFromForm,
    normalizeOAuthExportInput,
    buildAdminStatusSummary,
    getDispatchModeSummary,
    formatDispatchSessionStatus,
    formatResponseModelStatus,
    moveConfigSnapshotItem,
    formatApiKeyRecoveryStatus,
    extractRuntimeStatusTags,
    getActiveConfigLabel,
    hasRuntimeProblem,
    hasRefreshTokenConfig,
    buildHelloTestRequest,
    formatResponsesModelAliasesInput,
    parseResponsesModelAliasesInput,
    extractResponseSummary,
    normalizePortValue,
    buildProxyAccessInfo,
    buildRuntimeSyncText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  globalScope.AirouterConfigAdmin = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this));
