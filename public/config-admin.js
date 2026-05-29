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

  function buildConfigItemFromForm(values) {
    const formValues = values && typeof values === 'object' ? values : {};
    const mode = normalizeText(formValues.mode || 'token').toLowerCase();

    if (mode === 'token') {
      const parsed = parseJsonValue(formValues.tokenRawJson, 'AuthSession JSON');
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
          description: 'token 模式适合 ChatGPT Codex 登录态；apikey 模式适合 OpenAI 兼容或 Claude Messages 上游。先在右侧选一种模式。',
          actionText: '打开 ChatGPT',
          actionHref: 'https://chatgpt.com/',
        },
        {
          title: 'Token 模式',
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
          title: 'API Key 模式',
          description: '直接用输入框填写 Base URL、API Key 和备注，再勾选这个上游支持 GPT、Claude 或两者。普通 OpenAI 兼容服务通常选 GPT；原样转发 Claude Messages API 时选 Claude。',
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
    return configs.some(item => {
      const configItem = item && item.item ? item.item : item;
      return configItem && configItem.type === 'apikey';
    });
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

    const value = configItem && configItem.account_id;

    return typeof value === 'string' && value.trim() ? value.trim() : '-';
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

  function getDispatchModeSummary(snapshot) {
    const dispatch = snapshot && snapshot.dispatch && typeof snapshot.dispatch === 'object'
      ? snapshot.dispatch
      : null;
    if (dispatch && dispatch.mode === 'apikey_override') {
      return {
        value: dispatch.label || 'API Key 覆盖',
        tone: 'active',
        detail: dispatch.detail || '支持的流量会优先走当前 apikey',
      };
    }

    if (dispatch && dispatch.mode === 'token_pool') {
      return {
        value: dispatch.label || 'Token 并发池',
        tone: 'active',
        detail: dispatch.detail || 'token 请求按会话调度',
      };
    }

    const configs = Array.isArray(snapshot && snapshot.configs) ? snapshot.configs : [];
    const active = configs.find(item => item && item.is_active);
    if (active && active.item && active.item.type === 'apikey') {
      return {
        value: `API Key 覆盖: 配置 #${active.index + 1}`,
        tone: 'active',
        detail: '支持的流量会优先走当前 apikey',
      };
    }

    if (active) {
      return {
        value: `Token 并发池: 锚点配置 #${active.index + 1}`,
        tone: 'active',
        detail: 'token 请求按会话调度',
      };
    }

    return {
      value: '无可用配置',
      tone: 'muted',
      detail: '请先添加 token 或 apikey 配置',
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
      model: 'gpt-5.5',
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
    getConfigIdentityColumnLabel,
    getConfigIdentityValue,
    buildConfigItemFromForm,
    buildAdminStatusSummary,
    getDispatchModeSummary,
    extractRuntimeStatusTags,
    getActiveConfigLabel,
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
