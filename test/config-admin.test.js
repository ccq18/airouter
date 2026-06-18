const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildConfigSnapshotRequest,
  buildRequestUrl,
  buildHelloTestRequest,
  buildJsonRequestOptions,
  formatResponsesModelAliasesInput,
  parseResponsesModelAliasesInput,
  parseResponsesApiResponse,
  extractErrorMessage,
  getPreferredApiKey,
  buildHelloTestHeaders,
  getConfigGuideContent,
  getConfigIdentityColumnLabel,
  getConfigIdentityValue,
  buildConfigItemFromForm,
  normalizeOAuthExportInput,
  buildAdminStatusSummary,
  extractRuntimeStatusTags,
  formatDispatchSessionStatus,
  formatResponseModelStatus,
  formatApiKeyRecoveryStatus,
  getDispatchModeSummary,
  getActiveConfigLabel,
  hasRefreshTokenConfig,
  hasRuntimeProblem,
  extractResponseSummary,
  normalizePortValue,
  buildProxyAccessInfo,
  buildRuntimeSyncText,
  formatConfigItemCopyText,
} = require('../public/config-admin.js');

test('config admin hides the responses settings module', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');
  const start = html.indexOf('<div id="responsesSettingsSection" class="hidden-settings" hidden>');
  const end = html.indexOf('</main>', start);
  const section = start >= 0 && end > start ? html.slice(start, end) : '';

  assert.ok(section, 'responses settings section should be wrapped in a hidden container');
  assert.match(section, /Responses 设置/);
  assert.match(section, /这里可以配置 `\/v1\/responses` 的模型别名映射/);
  assert.match(section, /saveResponsesSettingsButton/);
});

test('config admin shows upstream config before edit controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');
  const messageIndex = html.indexOf('<div id="message"');
  const upstreamIndex = html.indexOf('<section class="panel list-panel">');
  const consoleGridIndex = html.indexOf('<section class="console-grid">');
  const addConfigIndex = html.indexOf('<h2 class="panel-title">新增配置项</h2>');

  assert.ok(messageIndex >= 0, 'message area should be present');
  assert.ok(upstreamIndex > messageIndex, 'upstream config should follow the message area');
  assert.ok(consoleGridIndex > upstreamIndex, 'edit controls should appear after upstream config');
  assert.ok(addConfigIndex > upstreamIndex, 'add config panel should appear after upstream config');
});

test('config admin exposes manual runtime config activation controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');

  assert.match(html, /data-action="activate"/);
  assert.match(html, /\/admin\/api\/configs\/\$\{index\}\/activate/);
  assert.match(html, /已进入 API Key 覆盖模式/);
  assert.match(html, /已设置 token 调度锚点/);
});

test('config admin exposes enable and disable controls for soft-deleted configs', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');

  assert.match(html, /disabled_configs/);
  assert.match(html, /data-action="disable"/);
  assert.match(html, /data-action="enable"/);
  assert.match(html, /\/admin\/api\/disabled-configs\/\$\{index\}\/enable/);
  assert.match(html, /item\.item\.disabled_status \|\| '服务不可见'/);
  assert.match(html, /配置项已停用并热重载/);
  assert.match(html, /配置项已启用并热重载/);
});

test('config admin exposes batch delete controls for configs, disabled configs, and apikeys', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');

  assert.doesNotMatch(html, /data-action="toggle-select-all-configs"/);
  assert.doesNotMatch(html, /data-action="toggle-select-all-disabled-configs"/);
  assert.doesNotMatch(html, /data-action="toggle-select-all-apikeys"/);
  assert.match(html, /id="batchSelectProblemConfigsButton"/);
  assert.match(html, /data-action="batch-select-problem-configs"/);
  assert.match(html, /选择异常配置/);
  assert.match(html, /id="batchEnableSelectedButton"/);
  assert.match(html, /data-action="batch-enable-selected"/);
  assert.match(html, /批量启用所选/);
  assert.match(html, /id="batchDisableSelectedButton"/);
  assert.match(html, /data-action="batch-disable-selected"/);
  assert.match(html, /批量停用所选/);
  assert.match(html, /data-action="toggle-select-config"/);
  assert.match(html, /data-action="toggle-select-disabled-config"/);
  assert.match(html, /data-action="toggle-select-apikey"/);
  assert.doesNotMatch(html, /id="batchDeleteConfigsButton"/);
  assert.doesNotMatch(html, /id="batchDeleteDisabledConfigsButton"/);
  assert.doesNotMatch(html, /id="batchDeleteApiKeysButton"/);
  assert.match(html, /id="batchDeleteSelectedButton"/);
  assert.match(html, /data-action="batch-delete-selected"/);
  assert.match(html, /批量删除所选/);
  assert.match(html, /\/admin\/api\/configs\/batch-disable/);
  assert.match(html, /\/admin\/api\/disabled-configs\/batch-enable/);
  assert.match(html, /已批量删除/);
  assert.match(html, /已批量启用/);
  assert.match(html, /已批量停用/);
});

test('config admin exposes copy controls for config item JSON', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');
  const copyFunctionStart = html.indexOf('async function copyConfigItemJson(index)');
  const copyFunctionEnd = html.indexOf('async function disableConfig(index)', copyFunctionStart);
  const copyFunction = copyFunctionStart >= 0 && copyFunctionEnd > copyFunctionStart
    ? html.slice(copyFunctionStart, copyFunctionEnd)
    : '';

  assert.match(html, /data-action="copy-config"/);
  assert.match(html, /copyConfigItemJson\(copyButton\.dataset\.index\)/);
  assert.match(html, /navigator\.clipboard\.writeText/);
  assert.ok(copyFunction, 'copyConfigItemJson should be present');
  assert.match(copyFunction, /copyTextToClipboard\(formatConfigItemCopyText\(config\)\)/);
  assert.doesNotMatch(copyFunction, /当前浏览器不支持剪贴板写入/);
});

test('config admin keeps the upstream config column compact after adding activation controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');

  assert.match(html, /min-width:\s*1040px;/);
  assert.match(html, /\.account-id-col,\s*\.account-id-cell\s*\{\s*width:\s*240px;\s*min-width:\s*240px;/);
  assert.match(html, /\.account-id-cell\s*\{\s*white-space:\s*normal;\s*word-break:\s*break-word;\s*overflow-wrap:\s*anywhere;/);
  assert.match(html, /\.action-cell\s*\{\s*width:\s*360px;\s*white-space:\s*nowrap;/);
});

test('config admin keeps all console controls after UI refresh', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'config-admin.html'), 'utf8');
  const accessControlStart = html.indexOf('<h2 class="panel-title">访问控制</h2>');
  const accessControlEnd = html.indexOf('<div id="responsesSettingsSection"', accessControlStart);
  const accessControlSection = accessControlStart >= 0 && accessControlEnd > accessControlStart
    ? html.slice(accessControlStart, accessControlEnd)
    : '';

  assert.match(html, /class="topbar"/);
  assert.doesNotMatch(html, /id="statusSummary"/);
  assert.match(html, /class="console-grid"/);
  assert.match(html, /id="addApiKeyButton"/);
  assert.match(html, /id="proxySettingsPanel"/);
  assert.match(html, /id="servicePortInput"/);
  assert.match(html, /id="proxyPortInput"/);
  assert.match(html, /id="proxyV1Url"/);
  assert.match(html, /id="saveProxySettingsButton"/);
  assert.match(html, /代理访问地址/);
  assert.match(html, /即时生效/);
  assert.doesNotMatch(html, /重启 App 后完整生效/);
  assert.match(html, /id="refreshButton"/);
  assert.match(html, /id="runtimeSyncStatus"/);
  assert.match(html, /RUNTIME_SYNC_INTERVAL_MS\s*=\s*10000/);
  assert.match(html, /refreshRuntimeSnapshot\(\)/);
  assert.match(html, /document\.visibilityState === 'visible'/);
  assert.match(html, /refreshStatic:\s*false/);
  assert.match(html, /silent:\s*true/);
  assert.match(html, /if \(!options\.silent\) \{/);
  assert.match(html, /id="testResponseButton"/);
  assert.match(html, /id="addButton"/);
  assert.match(html, /config_type:\s*getSelectedConfigMode\(\)/);
  assert.match(html, /data-copy-url="https:\/\/chatgpt\.com\/api\/auth\/session"/);
  assert.match(html, /链接已复制/);
  assert.doesNotMatch(html, /href="https:\/\/chatgpt\.com\/api\/auth\/session"/);
  assert.match(html, /\/admin\/api\/open-external/);
  assert.doesNotMatch(html, /window\.location\.href\s*=\s*url/);
  assert.doesNotMatch(html, /<button[^>]+id="autoAuthSessionButton"/);
  assert.doesNotMatch(html, /desktopAuthSessionActions/);
  assert.doesNotMatch(html, /desktop_app/);
  assert.doesNotMatch(html, /AirouterReceiveAuthSession/);
  assert.doesNotMatch(html, /\/admin\/api\/desktop\/auth-session/);
  assert.doesNotMatch(html, /airouter:\/\/auth-session/);
  assert.doesNotMatch(html, /window\.__TAURI__/);
  assert.match(html, /隐私模式登录 ChatGPT/);
  assert.match(html, /不要退出该登录态/);
  assert.match(html, /name="configMode" value="token"/);
  assert.match(html, /name="configMode" value="apikey"/);
  assert.match(html, /name="apiKeySupport" value="gpt"/);
  assert.match(html, /name="apiKeySupport" value="claude"/);
  assert.match(html, /data-action="activate"/);
  assert.match(html, /data-action="move-up"/);
  assert.match(html, /\/admin\/api\/configs\/\$\{index\}\/move-up/);
  assert.match(html, />置顶<\/button>/);
  assert.doesNotMatch(html, />上移<\/button>/);
  assert.match(html, /配置项已置顶，当前使用账号未改变/);
  assert.match(html, /data-action="disable"/);
  assert.match(html, /data-action="enable"/);
  assert.match(html, /data-action="delete-apikey"/);
  assert.match(html, /可刷新/);
  assert.match(html, /确认删除/);
  assert.match(html, /确认停用/);
  assert.doesNotMatch(html, /window\.confirm/);
  assert.ok(accessControlSection, 'access control section should be present');
  assert.match(accessControlSection, /id="addApiKeyButton"/);
});

test('buildRuntimeSyncText describes idle, polling, and synced runtime states', () => {
  assert.equal(buildRuntimeSyncText(), '运行态尚未同步');
  assert.equal(buildRuntimeSyncText({ state: 'refreshing' }), '正在刷新额度...');
  assert.equal(
    buildRuntimeSyncText({
      state: 'synced',
      syncedAt: new Date('2026-05-20T06:30:08.000Z'),
      locale: 'en-US',
      timeZone: 'UTC',
    }),
    '运行态已同步: 06:30:08',
  );
  assert.equal(
    buildRuntimeSyncText({
      state: 'error',
      error: 'HTTP 500',
    }),
    '运行态同步失败: HTTP 500',
  );
});

test('buildProxyAccessInfo builds displayed proxy URLs from runtime and configured ports', () => {
  assert.equal(normalizePortValue(' 3009 '), 3009);
  assert.equal(normalizePortValue('70000'), null);

  const info = buildProxyAccessInfo({
    runtime_port: 3009,
    file_port: 3010,
    proxy_port: '7890',
  });

  assert.equal(info.runtimePort, 3009);
  assert.equal(info.configuredPort, 3010);
  assert.equal(info.proxyPort, 7890);
  assert.equal(info.v1Url, 'http://localhost:3009/v1');
  assert.equal(info.configuredV1Url, 'http://localhost:3010/v1');
  assert.equal(info.responsesUrl, 'http://localhost:3009/v1/responses');
  assert.equal(info.portPendingRestart, true);
});

test('buildConfigSnapshotRequest uses GET when only loading the latest snapshot', () => {
  assert.deepEqual(
    buildConfigSnapshotRequest(),
    {
      url: '/admin/api/configs',
      options: {},
    },
  );
});

test('buildConfigSnapshotRequest uses POST refresh endpoint when forcing a full quota refresh', () => {
  assert.deepEqual(
    buildConfigSnapshotRequest(true),
    {
      url: '/admin/api/configs/refresh',
      options: {
        method: 'POST',
      },
    },
  );
});

test('buildRequestUrl only appends admin auth token to admin endpoints', () => {
  assert.equal(
    buildRequestUrl('/admin/api/configs', {
      adminAuthToken: 'auth-secret',
      origin: 'http://localhost:3009',
    }),
    '/admin/api/configs?auth_token=auth-secret',
  );
  assert.equal(
    buildRequestUrl('/v1/responses', {
      adminAuthToken: 'auth-secret',
      origin: 'http://localhost:3009',
    }),
    '/v1/responses',
  );
});

test('buildHelloTestRequest matches the Codex CLI responses probe shape', () => {
  const requestBody = buildHelloTestRequest({});

  assert.deepEqual(requestBody, {
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
  });
});

test('buildHelloTestHeaders matches the Codex CLI probe headers', () => {
  assert.deepEqual(buildHelloTestHeaders('session-123'), {
    originator: 'codex_cli_rs',
    version: '1.0.1',
    session_id: 'session-123',
    'x-client-request-id': 'session-123',
  });
});

test('formatResponsesModelAliasesInput serializes configured responses aliases', () => {
  assert.equal(
    formatResponsesModelAliasesInput({
      responses: {
        model_aliases: {
          'gpt-5.2': 'gpt-5.5',
        },
      },
    }),
    '{\n  "gpt-5.2": "gpt-5.5"\n}',
  );
});

test('formatConfigItemCopyText serializes only the raw config item', () => {
  const copied = formatConfigItemCopyText({
    index: 1,
    is_active: true,
    item: {
      type: 'apikey',
      apikey: 'sk-example',
      base_url: 'https://api.example.com/v1',
      description: 'backup',
      support: ['gpt'],
    },
    runtime: {
      runtime_summary: '可用=是',
    },
  });

  assert.equal(copied, JSON.stringify({
    type: 'apikey',
    apikey: 'sk-example',
    base_url: 'https://api.example.com/v1',
    description: 'backup',
    support: ['gpt'],
  }, null, 2));
});

test('parseResponsesModelAliasesInput parses alias JSON and trims keys and values', () => {
  assert.deepEqual(
    parseResponsesModelAliasesInput('{\n  "  GPT-5.2  ": "  gpt-5.5  "\n}'),
    {
      'GPT-5.2': 'gpt-5.5',
    },
  );
});

test('parseResponsesModelAliasesInput returns an empty object for blank input', () => {
  assert.deepEqual(parseResponsesModelAliasesInput('   '), {});
});

test('parseResponsesModelAliasesInput rejects non-object JSON', () => {
  assert.throws(() => {
    parseResponsesModelAliasesInput('["gpt-5.2", "gpt-5.5"]');
  }, err => {
    assert.equal(err instanceof Error, true);
    assert.match(err.message, /必须是 JSON 对象/);
    return true;
  });
});

test('getPreferredApiKey returns the first configured apikey', () => {
  assert.equal(getPreferredApiKey({
    apikeys: ['router-key', 'backup-key'],
  }), 'router-key');
});

test('getConfigGuideContent explains token JSON and apikey form entry separately', () => {
  const guide = getConfigGuideContent({
    mode: 'token',
  });

  assert.match(guide.rawJsonPlaceholder, /"accessToken": "\.\.\."/);
  assert.match(guide.rawJsonPlaceholder, /"refresh_token": "\.\.\."/);
  assert.doesNotMatch(guide.rawJsonPlaceholder, /"type": "apikey"/);
  assert.equal(guide.steps.some(step => /apikey 模式/.test(step.description)), true);

  const tokenStep = guide.steps.find(step => step.title === 'Token 模式');
  assert.match(tokenStep.description, /AuthSession JSON/);
  assert.match(tokenStep.description, /隐私模式/);
  assert.match(tokenStep.description, /不要退出该登录态/);
  assert.match(tokenStep.example, /"accessToken": "\.\.\."/);
  assert.match(tokenStep.example, /"refresh_token": "\.\.\."/);
  assert.equal(tokenStep.actionText, '复制 AuthSession 页面');
  assert.equal(tokenStep.actionCopyText, 'https://chatgpt.com/api/auth/session');
  assert.equal(tokenStep.actionHref, undefined);

  const apiKeyStep = guide.steps.find(step => step.title === 'API Key 模式');
  assert.match(apiKeyStep.description, /输入框/);
  assert.match(apiKeyStep.description, /Claude/);
  assert.match(apiKeyStep.description, /GPT/);
  assert.equal(apiKeyStep.example, undefined);
  assert.equal(apiKeyStep.actionHref, undefined);
});

test('hasRefreshTokenConfig detects token configs that can be refreshed', () => {
  assert.equal(hasRefreshTokenConfig({
    item: {
      refresh_token: 'refresh-token',
    },
  }), true);
  assert.equal(hasRefreshTokenConfig({
    item: {
      type: 'apikey',
      apikey: 'sk-1',
    },
  }), false);
});

test('hasRuntimeProblem detects unavailable and failed runtime summaries', () => {
  assert.equal(hasRuntimeProblem({
    runtime_summary: '可用=否 | 额度=unknown | 状态=额度检查失败 | 错误=request timeout',
  }), true);
  assert.equal(hasRuntimeProblem({
    runtime_summary: '可用=是 | 额度=83%',
  }), false);
  assert.equal(hasRuntimeProblem(null), false);
});

test('buildConfigItemFromForm keeps token mode as pasted AuthSession JSON', () => {
  assert.deepEqual(
    buildConfigItemFromForm({
      mode: 'token',
      tokenRawJson: JSON.stringify({
        user: {
          email: 'user@example.com',
        },
        account: {
          id: 'account-1',
        },
        accessToken: 'token-1',
      }),
    }),
    {
      user: {
        email: 'user@example.com',
      },
      account: {
        id: 'account-1',
      },
      accessToken: 'token-1',
    },
  );
});

test('buildConfigItemFromForm accepts token mode AuthSession JSON arrays', () => {
  const sessions = [
    {
      user: { email: 'user-1@example.com' },
      account: { id: 'account-1' },
      accessToken: 'token-1',
    },
    {
      user: { email: 'user-2@example.com' },
      account: { id: 'account-2' },
      accessToken: 'token-2',
    },
  ];

  assert.deepEqual(
    buildConfigItemFromForm({
      mode: 'token',
      tokenRawJson: JSON.stringify(sessions),
    }),
    sessions,
  );
});

test('buildConfigItemFromForm rejects invalid token mode AuthSession JSON array items', () => {
  assert.throws(
    () => buildConfigItemFromForm({
      mode: 'token',
      tokenRawJson: JSON.stringify([{ accessToken: 'token-1' }, null]),
    }),
    /第 2 项必须是 JSON 对象/,
  );
});

test('normalizeOAuthExportInput extracts oauth export arrays into token items', () => {
  const parsed = normalizeOAuthExportInput(JSON.stringify([
    {
      name: 'account-a',
      type: 'oauth',
      credentials: {
        access_token: 'token-a',
        refresh_token: 'refresh-a',
        email: 'a@example.com',
        chatgpt_account_id: 'account-a-id',
      },
    },
    {
      name: 'account-b',
      platform: 'openai',
      type: 'oauth',
      extra: {
        chatgpt_account_id: 'account-b-id',
      },
      credentials: {
        access_token: 'token-b',
      },
    },
  ]));

  assert.deepEqual(parsed, [
    {
      description: 'a@example.com',
      account_id: 'account-a-id',
      access_token: 'token-a',
      refresh_token: 'refresh-a',
    },
    {
      description: 'account-b',
      account_id: 'account-b-id',
      access_token: 'token-b',
    },
  ]);
});

test('normalizeOAuthExportInput tolerates trailing commas in pasted oauth exports', () => {
  const parsed = normalizeOAuthExportInput(`[
    {
      "name": "account-a",
      "type": "oauth",
      "credentials": {
        "access_token": "token-a",
        "chatgpt_account_id": "account-a-id"
      },
    },
  ]`);

  assert.deepEqual(parsed, [
    {
      description: 'account-a',
      account_id: 'account-a-id',
      access_token: 'token-a',
    },
  ]);
});

test('normalizeOAuthExportInput tolerates a truncated oauth export array tail', () => {
  const parsed = normalizeOAuthExportInput(`[
    {
      "name": "account-a",
      "type": "oauth",
      "credentials": {
        "access_token": "token-a",
        "chatgpt_account_id": "account-a-id"
      },
      "extra": {
        "email": "extra-a@example.com"
      }
    },`);

  assert.deepEqual(parsed, [
    {
      description: 'extra-a@example.com',
      account_id: 'account-a-id',
      access_token: 'token-a',
    },
  ]);
});

test('buildConfigItemFromForm converts oauth export arrays from the token textbox', () => {
  const imported = buildConfigItemFromForm({
    mode: 'token',
    tokenRawJson: JSON.stringify([
      {
        name: 'account-a',
        type: 'oauth',
        credentials: {
          access_token: 'token-a',
          chatgpt_account_id: 'account-a-id',
          refresh_token: 'refresh-a',
        },
      },
      {
        name: 'account-b',
        type: 'oauth',
        extra: {
          account_id: 'account-b-id',
        },
        credentials: {
          access_token: 'token-b',
          email: 'b@example.com',
        },
      },
    ]),
  });

  assert.deepEqual(imported, [
    {
      description: 'account-a',
      account_id: 'account-a-id',
      access_token: 'token-a',
      refresh_token: 'refresh-a',
    },
    {
      description: 'b@example.com',
      account_id: 'account-b-id',
      access_token: 'token-b',
    },
  ]);
});

test('buildConfigItemFromForm builds an apikey config from normal form fields', () => {
  assert.deepEqual(
    buildConfigItemFromForm({
      mode: 'apikey',
      apiKey: '  sk-third-party  ',
      baseUrl: ' https://api.example.com/v1/ ',
      description: ' backup provider ',
      support: ['gpt', 'claude'],
    }),
    {
      type: 'apikey',
      apikey: 'sk-third-party',
      base_url: 'https://api.example.com/v1',
      description: 'backup provider',
      support: ['gpt', 'claude'],
    },
  );
});

test('buildConfigItemFromForm defaults apikey support to gpt when nothing is selected', () => {
  assert.deepEqual(
    buildConfigItemFromForm({
      mode: 'apikey',
      apiKey: 'sk-third-party',
      baseUrl: 'https://api.example.com/v1',
      support: [],
    }),
    {
      type: 'apikey',
      apikey: 'sk-third-party',
      base_url: 'https://api.example.com/v1',
      description: '',
      support: ['gpt'],
    },
  );
});

test('getActiveConfigLabel identifies the active config item', () => {
  assert.equal(
    getActiveConfigLabel({
      configs: [
        { index: 0, is_active: false },
        { index: 1, is_active: true },
      ],
    }),
    '配置 #2',
  );
});

test('getActiveConfigLabel returns default routing when no config is manually active', () => {
  assert.equal(
    getActiveConfigLabel({
      configs: [
        { index: 0, is_active: false },
      ],
    }),
    '自动调度',
  );
});

test('buildAdminStatusSummary summarizes apikeys, configs, active config, and health', () => {
  assert.deepEqual(
    buildAdminStatusSummary({
      apikeys: ['sk-airouter-one', 'sk-airouter-two'],
      dispatch: {
        mode: 'token_pool',
        label: 'Token 并发池: 锚点配置 #2',
        detail: 'token 请求按会话调度，apikey 仅作 fallback',
      },
      configs: [
        {
          index: 0,
          is_active: false,
          runtime: {
            runtime_summary: '可用=否 | 额度=unknown | 刷新时间=unknown | 周额度=unknown | 刷新时间=unknown | 状态=额度检查失败 | 错误=request timeout after 10000ms',
          },
        },
        {
          index: 1,
          is_active: true,
          runtime: {
            runtime_summary: '可用=是 | 额度=83%',
          },
        },
      ],
    }),
    [
      {
        label: '入口 apikey',
        value: '2 个',
        tone: 'ok',
        detail: '请求会校验入口 apikey',
      },
      {
        label: '上游配置',
        value: '2 个',
        tone: 'ok',
        detail: 'Token 与 API Key 配置总数',
      },
      {
        label: '调度模式',
        value: 'Token 并发池: 锚点配置 #2',
        tone: 'active',
        detail: 'token 请求按会话调度，apikey 仅作 fallback',
      },
      {
        label: '健康状态',
        value: '1 个异常',
        tone: 'warn',
        detail: '发现 timeout',
      },
    ],
  );
});

test('getDispatchModeSummary shows the observed token session target when present', () => {
  assert.deepEqual(
    getDispatchModeSummary({
      dispatch: {
        mode: 'token_pool',
        label: 'Token 并发池: 锚点配置 #1',
        detail: 'token 请求按会话调度，apikey 仅作 fallback',
        observed_session: {
          config_index: 2,
          session_hash: 'abc123def456',
          label: '#abc123def456',
          has_session_key: true,
          active: true,
          sticky: true,
        },
      },
    }),
    {
      value: 'Token 并发池: 锚点配置 #1',
      tone: 'active',
      detail: '当前会话 #abc123def456 -> 配置 #3',
    },
  );
});

test('extractRuntimeStatusTags pulls readable status tags from runtime summary', () => {
  assert.deepEqual(
    extractRuntimeStatusTags({
      runtime_summary: '可用=否 | 额度=unknown | 刷新时间=unknown | 周额度=unknown | 状态=额度检查失败 | 错误=request timeout after 10000ms',
    }),
    [
      { label: '不可用', tone: 'danger' },
      { label: '额度 unknown', tone: 'warn' },
      { label: '刷新 unknown', tone: 'warn' },
      { label: 'timeout', tone: 'danger' },
    ],
  );
});

test('formatDispatchSessionStatus summarizes active and recent session observations', () => {
  assert.deepEqual(
    formatDispatchSessionStatus({
      in_flight: 2,
      dispatch_session: {
        session_hash: 'abc123def456',
        label: '#abc123def456',
        has_session_key: true,
        active: true,
        sticky: true,
        fallback: false,
      },
    }),
    {
      title: '当前会话',
      label: '#abc123def456',
      detail: '进行中 2',
      active: true,
      tone: 'active',
    },
  );

  assert.deepEqual(
    formatDispatchSessionStatus({
      in_flight: 0,
      dispatch_session: {
        session_hash: null,
        label: '匿名请求',
        has_session_key: false,
        active: false,
        sticky: false,
        fallback: true,
      },
    }),
    {
      title: '最近会话',
      label: '匿名请求',
      detail: '已释放 · fallback · 匿名',
      active: false,
      tone: 'muted',
    },
  );
});

test('formatResponseModelStatus summarizes requested and actual response models', () => {
  assert.deepEqual(
    formatResponseModelStatus({
      response_model: {
        request_model: 'gpt-5.5',
        response_model: 'gpt-5.4-mini',
        active: true,
        status_code: 200,
      },
    }),
    {
      title: '响应模型',
      label: 'gpt-5.4-mini',
      detail: '进行中 · 请求 gpt-5.5 · HTTP 200',
      active: true,
      tone: 'warn',
    },
  );

  assert.deepEqual(
    formatResponseModelStatus({
      response_model: {
        request_model: 'gpt-5.5',
        response_model: null,
        active: true,
      },
    }),
    {
      title: '请求模型',
      label: 'gpt-5.5',
      detail: '进行中',
      active: true,
      tone: 'active',
    },
  );
});

test('formatApiKeyRecoveryStatus summarizes GPT apikey recovery probes', () => {
  assert.deepEqual(
    formatApiKeyRecoveryStatus({
      api_key_recovery: {
        enabled: true,
        pending: true,
        interval_ms: 180000,
        last_checked_at: 1713337200000,
        result: 'failed',
        status_code: 429,
        reason: 'apikey_rate_limited',
        last_error: 'http:429',
        model: 'gpt-4.1-mini',
      },
    }, {
      locale: 'en-US',
      timeZone: 'UTC',
    }),
    {
      title: 'API Key 探测',
      label: '仍不可用',
      detail: '上次 07:00:00 · 模型 gpt-4.1-mini · HTTP 429 · http:429 · 仅不可用时每 3 分钟恢复探测',
      active: false,
      tone: 'danger',
    },
  );

  assert.deepEqual(
    formatApiKeyRecoveryStatus({
      api_key_recovery: {
        enabled: true,
        pending: true,
        interval_ms: 180000,
        last_checked_at: null,
        result: 'never',
        model: 'gpt-5.5',
      },
    }),
    {
      title: 'API Key 探测',
      label: '等待探测',
      detail: '模型 gpt-5.5 · 仅不可用时每 3 分钟恢复探测',
      active: false,
      tone: 'warn',
    },
  );

  assert.equal(formatApiKeyRecoveryStatus({
    api_key_recovery: {
      enabled: false,
    },
  }), null);
});

test('extractRuntimeStatusTags falls back when runtime data is missing', () => {
  assert.deepEqual(
    extractRuntimeStatusTags(null),
    [
      { label: '暂无运行态', tone: 'muted' },
    ],
  );
});

test('getConfigIdentityColumnLabel uses upstream config when any apikey item exists', () => {
  assert.equal(getConfigIdentityColumnLabel({
    configs: [
      {
        item: {
          type: 'apikey',
        },
      },
    ],
  }), '上游配置');
  assert.equal(getConfigIdentityColumnLabel({
    configs: [
      {
        item: {
          account_id: 'account-1',
        },
      },
    ],
  }), 'account_id');
  assert.equal(getConfigIdentityColumnLabel({
    configs: [
      {
        item: {
          account_id: 'account-1',
        },
      },
    ],
    disabled_configs: [
      {
        item: {
          type: 'apikey',
        },
      },
    ],
  }), '上游配置');
});

test('getConfigIdentityValue shows base_url and masks apikey config secrets', () => {
  assert.equal(
    getConfigIdentityValue(
      { mode: 'mixed' },
      {
        item: {
          type: 'apikey',
          base_url: 'https://api.example.com/v1',
          apikey: 'sk-1234567890',
        },
      },
    ),
    'https://api.example.com/v1 (sk--...7890)',
  );
  assert.equal(
    getConfigIdentityValue(
      { mode: 'mixed' },
      {
        item: {
          type: 'apikey',
          base_url: 'https://claude.example.com/v1',
          apikey: 'sk-claude123456',
          support: ['claude'],
        },
      },
    ),
    'https://claude.example.com/v1 (sk--...3456)',
  );
});

test('extractResponseSummary prefers output_text when available', () => {
  assert.equal(extractResponseSummary({
    output_text: 'hello from upstream',
  }), 'hello from upstream');
});

test('extractResponseSummary falls back to nested output_text content', () => {
  assert.equal(extractResponseSummary({
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: 'nested hello',
          },
        ],
      },
    ],
  }), 'nested hello');
});

test('extractResponseSummary concatenates multiple nested output_text parts', () => {
  assert.equal(extractResponseSummary({
    output: [
      {
        content: [
          {
            type: 'output_text',
            text: 'hello',
          },
          {
            type: 'output_text',
            text: ' world',
          },
        ],
      },
    ],
  }), 'hello world');
});

test('extractResponseSummary returns an empty string when no text is available', () => {
  assert.equal(
    extractResponseSummary({
      id: 'resp_123',
      status: 'completed',
    }),
    '',
  );
});

test('buildJsonRequestOptions preserves application/json when authorization header is added', () => {
  assert.deepEqual(
    buildJsonRequestOptions({
      method: 'POST',
      headers: {
        Authorization: 'Bearer router-key',
      },
      body: '{"hello":"world"}',
    }),
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer router-key',
      },
      body: '{"hello":"world"}',
    },
  );
});

test('parseResponsesApiResponse returns the completed response from event-stream payloads', () => {
  const eventStreamText = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1","model":"gpt-5.4"}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"hel"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"lo"}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_1","model":"gpt-5.4","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}]}}',
    '',
  ].join('\n');

  assert.deepEqual(
    parseResponsesApiResponse(eventStreamText, 'text/event-stream; charset=utf-8'),
    {
      id: 'resp_1',
      model: 'gpt-5.4',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'hello',
            },
          ],
        },
      ],
    },
  );
});

test('parseResponsesApiResponse keeps accumulated output_text when response.completed has an empty output array', () => {
  const eventStreamText = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_real","model":"gpt-5.4","output":[]}}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hello","item_id":"msg_1","content_index":0}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"! How can I help?","item_id":"msg_1","content_index":0}',
    '',
    'event: response.output_text.done',
    'data: {"type":"response.output_text.done","text":"Hello! How can I help?","item_id":"msg_1","content_index":0}',
    '',
    'event: response.completed',
    'data: {"type":"response.completed","response":{"id":"resp_real","model":"gpt-5.4","status":"completed","output":[]}}',
    '',
  ].join('\n');

  assert.deepEqual(
    parseResponsesApiResponse(eventStreamText, 'text/event-stream; charset=utf-8'),
    {
      id: 'resp_real',
      model: 'gpt-5.4',
      status: 'completed',
      output: [],
      output_text: 'Hello! How can I help?',
    },
  );
});

test('parseResponsesApiResponse detects event-stream bodies even when the content-type header is missing', () => {
  const eventStreamText = [
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"Hello"}',
    '',
    'event: response.output_text.delta',
    'data: {"type":"response.output_text.delta","delta":"!"}',
    '',
  ].join('\n');

  assert.deepEqual(
    parseResponsesApiResponse(eventStreamText, ''),
    {
      output_text: 'Hello!',
    },
  );
});

test('extractErrorMessage prefers nested upstream error messages', () => {
  assert.equal(
    extractErrorMessage({
      error: {
        message: '[trace_id: abc] Invalid param: invalid response id',
      },
    }, 'HTTP 400'),
    '[trace_id: abc] Invalid param: invalid response id',
  );
  assert.equal(extractErrorMessage({ error: 'plain error' }, 'HTTP 400'), 'plain error');
  assert.equal(extractErrorMessage({}, 'HTTP 400'), 'HTTP 400');
});
