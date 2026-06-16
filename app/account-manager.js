const { requestBuffered } = require('./upstream-request');
const { isSuccessfulResponsesStatus } = require('./responses-failover');
const crypto = require('node:crypto');

const SESSION_HASH_LENGTH = 12;
const APIKEY_RECOVERY_RESPONSES_PATH = '/v1/responses';
const APIKEY_REQUEST_WINDOW_SIZE = 10;
const APIKEY_REQUEST_FAILURE_THRESHOLD = 3;
const APIKEY_REQUEST_SAMPLE_TTL_MS = 30 * 60 * 1000;
const TOKEN_QUOTA_CHECK_FAILURE_THRESHOLD = 3;
const DEFAULT_TOKEN_UNAVAILABLE_COOLDOWN_MS = 60 * 60 * 1000;
const DEFAULT_APIKEY_RECOVERY_TIMEOUT_MS = 10 * 60 * 1000;
const APIKEY_RECOVERY_REQUEST_BODY = {
  model: 'gpt-5.5',
  input: 'hello',
  stream: false,
};

/**
 * 封装账号状态、额度刷新和活动账号切换逻辑。
 */
function createAccountManager(options) {
  const {
    configs,
    initialActiveConfigIndex = 0,
    quotaCheckPath,
    quotaCheckTimeoutMs = 0,
    apiKeyRecoveryTimeoutMs = DEFAULT_APIKEY_RECOVERY_TIMEOUT_MS,
    tokenUnavailableCooldownMs = DEFAULT_TOKEN_UNAVAILABLE_COOLDOWN_MS,
    quotaCheckIntervalMs,
    allQuotaCheckIntervalMs = 10 * 60 * 1000,
    allQuotaCheckDelayMs = 1000,
    minRemainingPercent,
    minWeeklyRemainingPercent = 1,
    buildAuthHeadersForConfig,
    requestBufferedFn = requestBuffered,
    shouldUseQuotaMonitoring,
    refreshTokenFn = null,
    persistTokenRefreshFn = async () => {},
    sleepFn = ms => new Promise(resolve => setTimeout(resolve, ms)),
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    log,
    warn,
    now,
  } = options;

  let activeConfigIndex = Number.isInteger(initialActiveConfigIndex) && initialActiveConfigIndex >= 0
    ? Math.min(initialActiveConfigIndex, Math.max(configs.length - 1, 0))
    : 0;
  let anonymousDispatchCursor = activeConfigIndex;
  let dispatchLeaseCounter = 0;
  let quotaMonitorRunning = false;
  let currentQuotaMonitorTimer = null;
  let allQuotaMonitorTimer = null;

  /**
   * 生成日志里使用的账号标识。
   */
  function getAccountLabel(config) {
    return `#${config.index + 1} ${config.description}`;
  }

  /**
   * 将额度百分比格式化为日志文本。
   */
  function formatQuotaPercent(value) {
    return value === null || typeof value === 'undefined' ? 'unknown' : `${value}%`;
  }

  /**
   * 将额度重置时间格式化为上海时区文本。
   */
  function formatQuotaResetTime(epochSeconds) {
    if (epochSeconds === null || typeof epochSeconds === 'undefined') {
      return 'unknown';
    }

    return new Date(epochSeconds * 1000).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });
  }

  /**
   * 将布尔值转换为中文日志文案。
   */
  function formatBooleanText(value) {
    return value ? '是' : '否';
  }

  /**
   * 将内部原因码转换为日志可读文案。
   */
  function formatReasonText(reason) {
    const reasonMap = {
      ok: '正常',
      unchecked: '未检查',
      apikey: 'API Key 模式',
      missing_credentials: '缺少凭证',
      rate_limit_not_allowed: '额度不可用',
      rate_limit_reached: '额度已用尽',
      membership_expired: '会员已过期',
      responses_insufficient_quota: 'responses 配额不足',
      responses_usage_limit_reached: 'responses 窗口额度已用尽',
      responses_usage_not_included: 'responses 套餐不支持',
      responses_unknown_error: 'responses 未知错误',
      apikey_auth_failed: 'API Key 鉴权失败',
      apikey_rate_limited: 'API Key 被限流',
      apikey_upstream_5xx: 'API Key 上游服务错误',
      apikey_upstream_error: 'API Key 上游请求失败',
      [`remaining_below_${minRemainingPercent}%`]: `剩余额度低于 ${minRemainingPercent}%`,
      [`secondary_remaining_not_above_${minWeeklyRemainingPercent}%`]: `周额度不高于 ${minWeeklyRemainingPercent}%`,
      quota_check_failed: '额度检查失败',
    };

    return reasonMap[reason] || reason || '未知';
  }

  function supportsGptApiKey(config) {
    if (!config || config.type !== 'apikey') {
      return false;
    }

    if (!Array.isArray(config.support)) {
      return true;
    }

    return config.support.includes('gpt');
  }

  function shouldUseApiKeyRecoveryMonitoring(config) {
    return supportsGptApiKey(config);
  }

  function hasQuotaOrApiKeyRecoveryTargets(reason = 'poll') {
    if (configs.some(config => shouldUseQuotaMonitoring(config.type))) {
      return true;
    }

    return reason === 'all_poll' && configs.some(shouldUseApiKeyRecoveryMonitoring);
  }

  /**
   * 汇总单个账号当前的运行时状态，供日志打印。
   */
  function getRuntimeSummary(config) {
    const runtime = config.runtime;
    const parts = [
      `可用=${formatBooleanText(runtime.available)}`,
      `额度=${formatQuotaPercent(runtime.primaryRemainingPercent)}`,
      `刷新时间=${formatQuotaResetTime(runtime.primaryResetAt)}`,
      `周额度=${formatQuotaPercent(runtime.secondaryRemainingPercent)}`,
      `刷新时间=${formatQuotaResetTime(runtime.secondaryResetAt)}`,
      `状态=${formatReasonText(runtime.reason)}`,
    ];

    if (runtime.lastError) {
      parts.push(`错误=${runtime.lastError}`);
    }

    const unavailableUntil = normalizeUnavailableUntil(config);
    if (unavailableUntil) {
      parts.push(`冷却至=${formatRuntimeTimestamp(unavailableUntil)}`);
    }

    return parts.join(' | ');
  }

  function formatRuntimeTimestamp(epochMs) {
    if (!Number.isFinite(epochMs) || epochMs <= 0) {
      return 'unknown';
    }

    return new Date(epochMs).toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
    });
  }

  /**
   * 返回账号对外展示所需的只读视图数据。
   */
  function getAccountStatus(config) {
    if (!config) {
      return null;
    }

    return {
      index: config.index,
      description: config.description,
      label: getAccountLabel(config),
      available: config.runtime.available,
      remainingPercent: config.runtime.remainingPercent,
      primaryRemainingPercent: config.runtime.primaryRemainingPercent,
      primaryResetAt: config.runtime.primaryResetAt,
      primaryResetAfterSeconds: config.runtime.primaryResetAfterSeconds,
      secondaryRemainingPercent: config.runtime.secondaryRemainingPercent,
      secondaryResetAt: config.runtime.secondaryResetAt,
      secondaryResetAfterSeconds: config.runtime.secondaryResetAfterSeconds,
      lastCheckedAt: config.runtime.lastCheckedAt,
      reason: config.runtime.reason,
      quotaCheckFailures: isDispatchManagedConfig(config) ? getQuotaCheckFailures(config) : null,
      unavailableUntil: isDispatchManagedConfig(config) ? normalizeUnavailableUntil(config) : null,
      apiKeyRequestWindow: config.type === 'apikey' ? summarizeApiKeyRequestResults(config) : null,
      apiKeyRecovery: config.type === 'apikey' ? summarizeApiKeyRecovery(config) : null,
      inFlight: isDispatchManagedConfig(config) ? normalizeInFlight(config) : null,
      dispatchSession: isDispatchManagedConfig(config) ? serializeDispatchSession(config.runtime.dispatchSession) : null,
      responseModel: serializeResponseModel(config.runtime.responseModel),
      runtimeSummary: getRuntimeSummary(config),
      summaryLine: `${getAccountLabel(config)} | ${getRuntimeSummary(config)}`,
    };
  }

  /**
   * 从额度窗口结构中计算剩余额度百分比。
   */
  function computeRemainingPercent(windowData) {
    if (!windowData || typeof windowData.used_percent !== 'number') {
      return null;
    }

    return Math.max(0, 100 - windowData.used_percent);
  }

  function normalizePlanText(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  function pickFirstPlanText(values) {
    for (const value of values) {
      const normalized = normalizePlanText(value);
      if (normalized) {
        return normalized;
      }
    }

    return '';
  }

  function getSubscriptionActiveSignal(payload) {
    if (!payload || typeof payload !== 'object') {
      return null;
    }

    const subscription = payload.subscription && typeof payload.subscription === 'object'
      ? payload.subscription
      : payload.account?.subscription && typeof payload.account.subscription === 'object'
        ? payload.account.subscription
        : payload.billing?.subscription && typeof payload.billing.subscription === 'object'
          ? payload.billing.subscription
          : null;

    const activeValues = [
      payload.has_active_subscription,
      payload.active_subscription,
      payload.is_subscribed,
      payload.is_plus_user,
      subscription?.active,
      subscription?.is_active,
    ];

    if (activeValues.some(value => value === false)) {
      return false;
    }

    if (activeValues.some(value => value === true)) {
      return true;
    }

    const status = normalizePlanText(subscription?.status ?? payload.subscription_status);
    if (['expired', 'inactive', 'canceled', 'cancelled', 'past_due', 'unpaid', 'not_subscribed'].includes(status)) {
      return false;
    }

    if (['active', 'trialing'].includes(status)) {
      return true;
    }

    return null;
  }

  function getPlanType(payload, rateLimit) {
    return pickFirstPlanText([
      payload?.plan_type,
      payload?.plan?.type,
      payload?.account?.plan_type,
      payload?.account?.plan?.type,
      payload?.subscription?.plan_type,
      payload?.subscription?.plan?.type,
      payload?.billing?.plan_type,
      rateLimit?.plan_type,
    ]);
  }

  function getPaidPlanSignal(planType) {
    if (!planType) {
      return null;
    }

    if (['free', 'none', 'unknown', 'expired', 'not_subscribed', 'no_subscription', 'unsubscribed'].includes(planType)) {
      return false;
    }

    if (['plus', 'pro', 'team', 'business', 'enterprise', 'edu'].includes(planType)) {
      return true;
    }

    return null;
  }

  /**
   * 将额度接口返回转换为统一的运行时状态。
   */
  function evaluateQuotaPayload(payload) {
    const detail = payload && typeof payload.detail === 'string' ? payload.detail.trim().toLowerCase() : '';
    const errorCode = payload && payload.error && typeof payload.error.code === 'string' ? payload.error.code.trim().toLowerCase() : '';
    if (detail === 'unauthorized' || detail.includes('token_revoked') || detail.includes('invalidated oauth token') || errorCode === 'token_revoked') {
      return {
        available: false,
        reason: 'missing_credentials',
        remainingPercent: null,
        primaryRemainingPercent: null,
        primaryResetAt: null,
        primaryResetAfterSeconds: null,
        secondaryRemainingPercent: null,
        secondaryResetAt: null,
        secondaryResetAfterSeconds: null,
      };
    }

    const rateLimit = payload && typeof payload === 'object' ? payload.rate_limit || {} : {};
    const primaryRemainingPercent = computeRemainingPercent(rateLimit.primary_window);
    const secondaryRemainingPercent = computeRemainingPercent(rateLimit.secondary_window);
    const subscriptionActiveSignal = getSubscriptionActiveSignal(payload);
    const paidPlanSignal = getPaidPlanSignal(getPlanType(payload, rateLimit));
    const hasPrimaryWindow = Boolean(rateLimit.primary_window);
    const hasSecondaryWindow = Boolean(rateLimit.secondary_window);
    // 对外汇总口径跟随主额度窗口；周额度单独作为可用性保护条件。
    const remainingPercent = primaryRemainingPercent !== null
      ? primaryRemainingPercent
      : secondaryRemainingPercent;

    let available = true;
    let reason = 'ok';

    if (subscriptionActiveSignal === false || paidPlanSignal === false || (hasPrimaryWindow && !hasSecondaryWindow && paidPlanSignal !== true)) {
      available = false;
      reason = 'membership_expired';
    } else if (rateLimit.allowed === false) {
      available = false;
      reason = 'rate_limit_not_allowed';
    } else if (rateLimit.limit_reached === true) {
      available = false;
      reason = 'rate_limit_reached';
    } else if (primaryRemainingPercent !== null && primaryRemainingPercent < minRemainingPercent) {
      available = false;
      reason = `remaining_below_${minRemainingPercent}%`;
    } else if (secondaryRemainingPercent !== null && secondaryRemainingPercent <= minWeeklyRemainingPercent) {
      available = false;
      reason = `secondary_remaining_not_above_${minWeeklyRemainingPercent}%`;
    }

    return {
      available,
      reason,
      remainingPercent,
      primaryRemainingPercent,
      primaryResetAt: rateLimit.primary_window?.reset_at ?? null,
      primaryResetAfterSeconds: rateLimit.primary_window?.reset_after_seconds ?? null,
      secondaryRemainingPercent,
      secondaryResetAt: rateLimit.secondary_window?.reset_at ?? null,
      secondaryResetAfterSeconds: rateLimit.secondary_window?.reset_after_seconds ?? null,
    };
  }

  /**
   * 将统一额度状态写回账号运行时对象。
   */
  function applyQuotaState(config, quotaState) {
    config.runtime.available = quotaState.available;
    config.runtime.reason = quotaState.reason;
    config.runtime.lastCheckedAt = now();
    config.runtime.remainingPercent = quotaState.remainingPercent;
    config.runtime.primaryRemainingPercent = quotaState.primaryRemainingPercent;
    config.runtime.primaryResetAt = quotaState.primaryResetAt;
    config.runtime.primaryResetAfterSeconds = quotaState.primaryResetAfterSeconds;
    config.runtime.secondaryRemainingPercent = quotaState.secondaryRemainingPercent;
    config.runtime.secondaryResetAt = quotaState.secondaryResetAt;
    config.runtime.secondaryResetAfterSeconds = quotaState.secondaryResetAfterSeconds;
    config.runtime.lastError = null;
    config.runtime.quotaCheckFailures = 0;
    config.runtime.unavailableUntil = null;
  }

  /**
   * 应用实时额度信息；默认在当前账号失效时立即校正活动账号。
   */
  function applyQuotaPayload(config, payload, options = {}) {
    const { allowSwitch = config === getActiveConfig() } = options;
    const quotaState = evaluateQuotaPayload(payload);
    applyQuotaState(config, quotaState);

    if (allowSwitch && config === getActiveConfig()) {
      return ensureActiveConfig('quota_update');
    }

    return config;
  }

  /**
   * 在非额度查询场景下，将账号直接标记为不可用，并按需切换活动账号。
   */
  function markConfigUnavailable(config, reason, options = {}) {
    const {
      allowSwitch = config === getActiveConfig(),
      lastError = null,
      switchReason = 'runtime_unavailable',
    } = options;

    if (!config || !config.runtime) {
      return getActiveConfig();
    }

    config.runtime.available = false;
    config.runtime.reason = reason;
    config.runtime.lastCheckedAt = now();
    config.runtime.lastError = lastError;
    if (isDispatchManagedConfig(config)) {
      config.runtime.unavailableUntil = calculateUnavailableUntil(options);
    }

    if (allowSwitch && config === getActiveConfig()) {
      return ensureActiveConfig(switchReason);
    }

    return config;
  }

  function getQuotaCheckFailures(config) {
    const value = Number(config?.runtime?.quotaCheckFailures || 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function normalizeUnavailableUntil(config) {
    const value = Number(config?.runtime?.unavailableUntil);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }

  function calculateUnavailableUntil(options = {}) {
    if (Object.prototype.hasOwnProperty.call(options, 'unavailableUntil')) {
      return normalizeUnavailableUntil({ runtime: { unavailableUntil: options.unavailableUntil } });
    }

    const cooldownMs = Number(options.cooldownMs ?? tokenUnavailableCooldownMs);
    if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) {
      return null;
    }

    return now() + Math.floor(cooldownMs);
  }

  function isCoolingDown(config) {
    const unavailableUntil = normalizeUnavailableUntil(config);
    return unavailableUntil !== null && unavailableUntil > now();
  }

  function recordQuotaCheckFailure(config, err) {
    const failureCount = getQuotaCheckFailures(config) + 1;
    config.runtime.quotaCheckFailures = failureCount;
    config.runtime.lastCheckedAt = now();
    config.runtime.lastError = err.message;

    if (failureCount >= TOKEN_QUOTA_CHECK_FAILURE_THRESHOLD) {
      config.runtime.available = false;
      config.runtime.reason = 'quota_check_failed';
    }

    return failureCount;
  }

  function getApiKeyRequestResults(config) {
    if (!config || !config.runtime) {
      return [];
    }

    if (!Array.isArray(config.runtime.apiKeyRequestResults)) {
      config.runtime.apiKeyRequestResults = [];
    }

    return config.runtime.apiKeyRequestResults;
  }

  function resetApiKeyRequestResults(config) {
    if (!config || !config.runtime) {
      return;
    }

    config.runtime.apiKeyRequestResults = [];
  }

  function normalizeApiKeyRequestSample(sample, observedAt) {
    if (sample && typeof sample === 'object') {
      return {
        ok: Boolean(sample.ok),
        at: Number.isFinite(sample.at) ? sample.at : observedAt,
        reason: typeof sample.reason === 'string' ? sample.reason : null,
        lastError: typeof sample.lastError === 'string' ? sample.lastError : null,
      };
    }

    return {
      ok: Boolean(sample),
      at: observedAt,
      reason: null,
      lastError: null,
    };
  }

  function pruneApiKeyRequestResults(config, observedAt = now()) {
    const cutoff = observedAt - APIKEY_REQUEST_SAMPLE_TTL_MS;
    const results = getApiKeyRequestResults(config)
      .map(sample => normalizeApiKeyRequestSample(sample, observedAt))
      .filter(sample => sample.at >= cutoff);
    if (results.length > APIKEY_REQUEST_WINDOW_SIZE) {
      results.splice(0, results.length - APIKEY_REQUEST_WINDOW_SIZE);
    }

    config.runtime.apiKeyRequestResults = results;
    return results;
  }

  function summarizeApiKeyRequestResults(config) {
    const results = pruneApiKeyRequestResults(config);
    const failureCount = results.reduce((count, sample) => sample.ok ? count : count + 1, 0);

    return {
      failureCount,
      sampleSize: results.length,
      failureThreshold: APIKEY_REQUEST_FAILURE_THRESHOLD,
      windowSize: APIKEY_REQUEST_WINDOW_SIZE,
      sampleTtlMs: APIKEY_REQUEST_SAMPLE_TTL_MS,
    };
  }

  function summarizeApiKeyRecovery(config) {
    const enabled = shouldUseApiKeyRecoveryMonitoring(config);
    const recovery = config && config.runtime && config.runtime.apiKeyRecovery && typeof config.runtime.apiKeyRecovery === 'object'
      ? config.runtime.apiKeyRecovery
      : {};

    return {
      enabled,
      pending: Boolean(enabled && config.runtime && config.runtime.enabled && !config.runtime.available),
      intervalMs: allQuotaCheckIntervalMs,
      lastCheckedAt: Number.isFinite(Number(recovery.lastCheckedAt)) ? Number(recovery.lastCheckedAt) : null,
      result: typeof recovery.result === 'string' && recovery.result ? recovery.result : 'never',
      statusCode: Number.isFinite(Number(recovery.statusCode)) ? Number(recovery.statusCode) : null,
      reason: typeof recovery.reason === 'string' && recovery.reason ? recovery.reason : null,
      lastError: typeof recovery.lastError === 'string' && recovery.lastError ? recovery.lastError : null,
      model: getApiKeyRecoveryModel(config),
    };
  }

  function recordApiKeyRecoveryResult(config, result = {}) {
    if (!config || config.type !== 'apikey' || !config.runtime) {
      return;
    }

    config.runtime.apiKeyRecovery = {
      lastCheckedAt: Number.isFinite(Number(result.lastCheckedAt)) ? Number(result.lastCheckedAt) : now(),
      result: typeof result.result === 'string' && result.result ? result.result : 'failed',
      statusCode: Number.isFinite(Number(result.statusCode)) ? Number(result.statusCode) : null,
      reason: typeof result.reason === 'string' && result.reason ? result.reason : null,
      lastError: typeof result.lastError === 'string' && result.lastError ? result.lastError : null,
      model: getApiKeyRecoveryModel(config),
    };
  }

  function recordApiKeyRequestResult(config, result = {}) {
    if (!config || config.type !== 'apikey' || !config.runtime) {
      return {
        unavailable: false,
        failureCount: 0,
        sampleSize: 0,
        failureThreshold: APIKEY_REQUEST_FAILURE_THRESHOLD,
        windowSize: APIKEY_REQUEST_WINDOW_SIZE,
      };
    }

    const observedAt = now();
    const results = pruneApiKeyRequestResults(config, observedAt);
    results.push({
      ok: Boolean(result.ok),
      at: observedAt,
      reason: result.reason || null,
      lastError: result.lastError || null,
    });
    if (results.length > APIKEY_REQUEST_WINDOW_SIZE) {
      results.splice(0, results.length - APIKEY_REQUEST_WINDOW_SIZE);
    }
    config.runtime.apiKeyRequestResults = results;

    const failureCount = results.reduce((count, sample) => sample.ok ? count : count + 1, 0);
    const summary = {
      failureCount,
      sampleSize: results.length,
      failureThreshold: APIKEY_REQUEST_FAILURE_THRESHOLD,
      windowSize: APIKEY_REQUEST_WINDOW_SIZE,
      sampleTtlMs: APIKEY_REQUEST_SAMPLE_TTL_MS,
    };
    const unavailable = summary.failureCount >= APIKEY_REQUEST_FAILURE_THRESHOLD;
    let selectedConfig = config;

    if (unavailable && config.runtime.available !== false) {
      selectedConfig = markConfigUnavailable(config, result.reason || 'apikey_upstream_error', {
        allowSwitch: result.allowSwitch,
        lastError: result.lastError || null,
        switchReason: result.switchReason || 'apikey_upstream_failover',
      });
    }

    return {
      ...summary,
      unavailable,
      selectedConfig,
    };
  }

  /**
   * 判断账号当前是否可用。
   */
  function isConfigAvailable(config) {
    return Boolean(config && config.runtime && config.runtime.enabled && config.runtime.available && !isCoolingDown(config));
  }

  function findHighestPriorityAvailableConfigIndex(predicate = () => true) {
    for (let index = 0; index < configs.length; index += 1) {
      const config = configs[index];
      if (!predicate(config) || !isConfigAvailable(config)) {
        continue;
      }

      return index;
    }

    return -1;
  }

  /**
   * 返回当前活动账号，不做切换，也不做任何 I/O。
   */
  function getActiveConfig(predicate = () => true) {
    const currentConfig = configs[activeConfigIndex] || null;
    return currentConfig && predicate(currentConfig) ? currentConfig : null;
  }

  function activateConfig(index, reason = 'manual') {
    if (!Number.isInteger(index) || index < 0 || index >= configs.length) {
      throw new Error('配置项索引不合法');
    }

    const previousConfig = configs[activeConfigIndex] || null;
    const nextConfig = configs[index];
    if (nextConfig.type === 'apikey') {
      nextConfig.runtime.available = true;
      nextConfig.runtime.reason = 'apikey';
      nextConfig.runtime.lastCheckedAt = now();
      nextConfig.runtime.lastError = null;
      resetApiKeyRequestResults(nextConfig);
    }
    activeConfigIndex = index;
    if (nextConfig.type === 'token') {
      anonymousDispatchCursor = index;
    }

    if (previousConfig !== nextConfig && reason !== 'startup') {
      warn(`账号切换: ${previousConfig ? getAccountLabel(previousConfig) : 'none'} -> ${getAccountLabel(nextConfig)} (${reason})`);
    }

    return nextConfig;
  }

  function withTimeout(promise, timeoutMs, label) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }

    let timeoutHandle = null;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`${label} timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise])
      .finally(() => {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      });
  }

  function withQuotaCheckTimeout(promise) {
    return withTimeout(promise, quotaCheckTimeoutMs, 'quota check');
  }

  function withApiKeyRecoveryTimeout(promise) {
    return withTimeout(promise, apiKeyRecoveryTimeoutMs, 'apikey recovery');
  }

  function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  }

  function hashText(value) {
    return crypto
      .createHash('sha256')
      .update(String(value))
      .digest('hex');
  }

  function hashTextToUInt64(value) {
    return crypto
      .createHash('sha256')
      .update(String(value))
      .digest()
      .readBigUInt64BE(0);
  }

  function getDispatchIdentity(config) {
    if (!config || typeof config !== 'object') {
      return '';
    }

    if (config.type === 'token') {
      return [
        'token',
        config.baseUrl || '',
        config.account_id || '',
      ].join(':');
    }

    if (config.type === 'apikey') {
      return [
        'apikey',
        config.baseUrl || '',
        hashText(config.apiKey || ''),
        Array.isArray(config.support) ? config.support.join(',') : '',
      ].join(':');
    }

    return '';
  }

  function isDispatchManagedConfig(config) {
    return Boolean(config && config.type === 'token');
  }

  function normalizeExcludedIdentitySet(excludedConfigs = []) {
    const excluded = new Set();

    for (const item of excludedConfigs || []) {
      const identity = typeof item === 'string' ? item : getDispatchIdentity(item);
      if (identity) {
        excluded.add(identity);
      }
    }

    return excluded;
  }

  function normalizeInFlight(config) {
    const value = Number(config?.runtime?.inFlight || 0);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function incrementInFlight(config) {
    if (!config || !config.runtime) {
      return;
    }

    config.runtime.inFlight = normalizeInFlight(config) + 1;
  }

  function decrementInFlight(config) {
    if (!config || !config.runtime) {
      return;
    }

    config.runtime.inFlight = Math.max(0, normalizeInFlight(config) - 1);
  }

  function createDispatchLeaseId() {
    dispatchLeaseCounter += 1;
    return `${now()}:${dispatchLeaseCounter}`;
  }

  function serializeDispatchSession(dispatchSession) {
    if (!dispatchSession || typeof dispatchSession !== 'object') {
      return null;
    }

    const sessionHash = typeof dispatchSession.sessionHash === 'string' && dispatchSession.sessionHash
      ? dispatchSession.sessionHash
      : null;

    return {
      sessionHash,
      label: typeof dispatchSession.label === 'string' && dispatchSession.label
        ? dispatchSession.label
        : sessionHash
          ? `#${sessionHash}`
          : '匿名请求',
      hasSessionKey: Boolean(dispatchSession.hasSessionKey),
      active: Boolean(dispatchSession.active),
      sticky: Boolean(dispatchSession.sticky),
      fallback: Boolean(dispatchSession.fallback),
      reason: typeof dispatchSession.reason === 'string' ? dispatchSession.reason : '',
      startedAt: Number.isFinite(dispatchSession.startedAt) ? dispatchSession.startedAt : null,
      lastSeenAt: Number.isFinite(dispatchSession.lastSeenAt) ? dispatchSession.lastSeenAt : null,
    };
  }

  function serializeResponseModel(responseModel) {
    if (!responseModel || typeof responseModel !== 'object') {
      return null;
    }

    return {
      requestModel: typeof responseModel.requestModel === 'string' && responseModel.requestModel
        ? responseModel.requestModel
        : null,
      responseModel: typeof responseModel.responseModel === 'string' && responseModel.responseModel
        ? responseModel.responseModel
        : null,
      active: Boolean(responseModel.active),
      source: typeof responseModel.source === 'string' ? responseModel.source : '',
      statusCode: Number.isInteger(responseModel.statusCode) ? responseModel.statusCode : null,
      observedAt: Number.isFinite(responseModel.observedAt) ? responseModel.observedAt : null,
      lastSeenAt: Number.isFinite(responseModel.lastSeenAt) ? responseModel.lastSeenAt : null,
    };
  }

  function observeResponseModel(config, observation = {}) {
    if (!config || !config.runtime) {
      return null;
    }

    const previous = config.runtime.responseModel && typeof config.runtime.responseModel === 'object'
      ? config.runtime.responseModel
      : {};
    const requestModel = normalizeString(observation.requestModel) || previous.requestModel || null;
    const hasObservedResponseModel = Object.prototype.hasOwnProperty.call(observation, 'responseModel');
    const observedResponseModel = normalizeString(observation.responseModel);
    const responseModel = observedResponseModel || (observation.active === true ? null : previous.responseModel || null);
    const timestamp = now();
    const statusCode = Number(observation.statusCode);

    config.runtime.responseModel = {
      requestModel,
      responseModel,
      active: Object.prototype.hasOwnProperty.call(observation, 'active')
        ? Boolean(observation.active)
        : Boolean(previous.active),
      source: normalizeString(observation.source) || previous.source || 'responses',
      statusCode: Number.isInteger(statusCode) && statusCode > 0 ? statusCode : previous.statusCode ?? null,
      observedAt: hasObservedResponseModel && responseModel ? timestamp : previous.observedAt ?? null,
      lastSeenAt: timestamp,
    };

    return serializeResponseModel(config.runtime.responseModel);
  }

  function observeDispatchAcquire(config, metadata, leaseId) {
    if (!isDispatchManagedConfig(config) || !config.runtime) {
      return;
    }

    const sessionKey = normalizeString(metadata.sessionKey);
    const sessionHash = sessionKey ? hashText(sessionKey).slice(0, SESSION_HASH_LENGTH) : null;
    const timestamp = now();

    config.runtime.dispatchSession = {
      leaseId,
      sessionHash,
      label: sessionHash ? `#${sessionHash}` : '匿名请求',
      hasSessionKey: Boolean(sessionHash),
      active: true,
      sticky: Boolean(metadata.sticky),
      fallback: Boolean(metadata.fallback),
      reason: normalizeString(metadata.reason) || 'dispatch',
      startedAt: timestamp,
      lastSeenAt: timestamp,
    };
  }

  function observeDispatchRelease(config, leaseId) {
    if (!isDispatchManagedConfig(config) || !config.runtime || !config.runtime.dispatchSession) {
      return;
    }

    if (config.runtime.dispatchSession.leaseId !== leaseId) {
      return;
    }

    config.runtime.dispatchSession = {
      ...config.runtime.dispatchSession,
      active: false,
      lastSeenAt: now(),
    };
  }

  function createConfigLease(config, metadata = {}) {
    if (!config) {
      return null;
    }

    let released = false;
    const leaseId = createDispatchLeaseId();
    incrementInFlight(config);
    observeDispatchAcquire(config, metadata, leaseId);

    return {
      config,
      sessionKey: metadata.sessionKey || '',
      sticky: Boolean(metadata.sticky),
      fallback: Boolean(metadata.fallback),
      release() {
        if (released) {
          return;
        }

        released = true;
        decrementInFlight(config);
        observeDispatchRelease(config, leaseId);
      },
    };
  }

  function getAvailableDispatchCandidates(predicate = () => true, excludedConfigs = []) {
    const excluded = normalizeExcludedIdentitySet(excludedConfigs);

    return configs.filter(config => {
      const identity = getDispatchIdentity(config);
      return isDispatchManagedConfig(config) && identity && !excluded.has(identity) && predicate(config) && isConfigAvailable(config);
    });
  }

  function getFallbackDispatchConfig(predicate = () => true, excludedConfigs = []) {
    const excluded = normalizeExcludedIdentitySet(excludedConfigs);
    const currentConfig = configs[activeConfigIndex] || null;
    if (isDispatchManagedConfig(currentConfig) && predicate(currentConfig) && !excluded.has(getDispatchIdentity(currentConfig)) && !isCoolingDown(currentConfig)) {
      return currentConfig;
    }

    return configs.find(config => (
      isDispatchManagedConfig(config) &&
      predicate(config) &&
      !excluded.has(getDispatchIdentity(config)) &&
      !isCoolingDown(config)
    )) || null;
  }

  function pickByRendezvousHash(sessionKey, candidates) {
    if (!sessionKey || candidates.length === 0) {
      return null;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    let selected = null;
    let selectedScore = null;
    let selectedIdentity = '';

    for (const config of candidates) {
      const identity = getDispatchIdentity(config);
      const score = hashTextToUInt64(`${sessionKey}:${identity}`);

      if (
        selected === null ||
        score > selectedScore ||
        (score === selectedScore && identity.localeCompare(selectedIdentity) < 0)
      ) {
        selected = config;
        selectedScore = score;
        selectedIdentity = identity;
      }
    }

    return selected;
  }

  function pickLeastInFlight(candidates) {
    if (candidates.length === 0) {
      return null;
    }

    let selected = null;
    let selectedDistance = Number.POSITIVE_INFINITY;

    for (const config of candidates) {
      if (!selected || normalizeInFlight(config) < normalizeInFlight(selected)) {
        selected = config;
        selectedDistance = getDispatchDistance(config.index);
        continue;
      }

      if (normalizeInFlight(config) === normalizeInFlight(selected)) {
        const distance = getDispatchDistance(config.index);
        if (distance < selectedDistance) {
          selected = config;
          selectedDistance = distance;
        }
      }
    }

    anonymousDispatchCursor = (selected.index + 1) % Math.max(configs.length, 1);
    return selected;
  }

  function getDispatchDistance(index) {
    const length = Math.max(configs.length, 1);
    return (index - anonymousDispatchCursor + length) % length;
  }

  function acquireConfig(reason = 'dispatch', predicate = () => true, options = {}) {
    const sessionKey = normalizeString(options.sessionKey);
    const allowFallback = options.allowFallback !== false;
    const candidates = getAvailableDispatchCandidates(predicate, options.exclude);
    const selected = sessionKey
      ? pickByRendezvousHash(sessionKey, candidates)
      : pickLeastInFlight(candidates);

    if (selected) {
      return createConfigLease(selected, {
        sessionKey,
        sticky: Boolean(sessionKey),
        reason,
      });
    }

    if (!allowFallback) {
      return null;
    }

    const fallbackConfig = getFallbackDispatchConfig(predicate, options.exclude);
    if (!fallbackConfig) {
      return null;
    }

    if (configs.length > 0) {
      warn(`没有可用账号，继续使用当前账号 ${getAccountLabel(fallbackConfig)} (${reason})`);
    }

    return createConfigLease(fallbackConfig, {
      sessionKey,
      sticky: Boolean(sessionKey),
      fallback: true,
      reason,
    });
  }

  function isMissingCredentialsPayload(payload) {
    return evaluateQuotaPayload(payload).reason === 'missing_credentials';
  }

  function isRefreshableQuotaAuthFailure(result, payload) {
    return Number(result && result.statusCode) === 401 || isMissingCredentialsPayload(payload);
  }

  async function requestQuotaPayload(config, targetUrl) {
    const result = await withQuotaCheckTimeout(requestBufferedFn({
      method: 'GET',
      targetUrl,
      headers: buildAuthHeadersForConfig(config),
      timeoutMs: quotaCheckTimeoutMs,
      maxRedirects: 5,
    }));

    return {
      result,
      payload: JSON.parse(result.bodyText),
    };
  }

  async function refreshConfigAccessToken(config) {
    const refreshToken = normalizeString(config.refresh_token);

    if (!refreshToken || typeof refreshTokenFn !== 'function') {
      return false;
    }

    const refreshed = await refreshTokenFn({
      config,
      refreshToken,
      clientId: normalizeString(config.client_id),
    });
    const accessToken = normalizeString(refreshed && (refreshed.access_token || refreshed.accessToken));
    const nextRefreshToken = normalizeString(refreshed && (refreshed.refresh_token || refreshed.refreshToken)) || refreshToken;
    const clientId = normalizeString(refreshed && (refreshed.client_id || refreshed.clientId)) || normalizeString(config.client_id);

    if (!accessToken) {
      throw new Error('token refresh response missing access_token');
    }

    config.access_token = accessToken;
    config.refresh_token = nextRefreshToken;
    if (clientId) {
      config.client_id = clientId;
    }

    await persistTokenRefreshFn({
      config,
      accessToken,
      refreshToken: nextRefreshToken,
      ...(clientId ? { clientId } : {}),
    });

    return true;
  }

  /**
   * 保证活动账号可用，仅当当前账号不可用时才切换。
   */
  function ensureActiveConfig(reason = 'select', predicate = () => true) {
    if (configs.length === 0) {
      return null;
    }

    const currentConfig = configs[activeConfigIndex] || null;
    if (currentConfig && predicate(currentConfig) && isConfigAvailable(currentConfig)) {
      return currentConfig;
    }

    const priorityIndex = findHighestPriorityAvailableConfigIndex(predicate);
    if (priorityIndex !== -1) {
      const nextConfig = configs[priorityIndex];
      if (priorityIndex !== activeConfigIndex) {
        const previousConfig = currentConfig;
        activeConfigIndex = priorityIndex;
        if (reason !== 'startup') {
          warn(`账号切换: ${previousConfig ? getAccountLabel(previousConfig) : 'none'} -> ${getAccountLabel(nextConfig)} (${reason})`);
        }
      }

      return nextConfig;
    }
    if (currentConfig && predicate(currentConfig)) {
      warn(`没有可用账号，继续使用当前账号 ${getAccountLabel(currentConfig)} (${reason})`);
      return currentConfig;
    }

    return null;
  }

  /**
   * 刷新单个账号的额度状态。
   */
  async function checkSingleAccountQuota(config, options = {}) {
    const { allowSwitch = true } = options;

    if (!shouldUseQuotaMonitoring(config.type)) {
      return config.runtime;
    }

    if (!config.runtime.enabled) {
      config.runtime.available = false;
      config.runtime.reason = 'missing_credentials';
      return config.runtime;
    }

    const targetUrl = new URL(quotaCheckPath, config.baseUrl).toString();

    try {
      let { result, payload } = await requestQuotaPayload(config, targetUrl);
      if (result.statusCode < 200 || result.statusCode >= 300) {
        const missingCredentials = isMissingCredentialsPayload(payload);
        if (isRefreshableQuotaAuthFailure(result, payload)) {
          const refreshed = await refreshConfigAccessToken(config);
          if (refreshed) {
            ({ result, payload } = await requestQuotaPayload(config, targetUrl));
            if (result.statusCode >= 200 && result.statusCode < 300) {
              applyQuotaPayload(config, payload, { allowSwitch });
              return config.runtime;
            }
          }

          if (missingCredentials) {
            applyQuotaPayload(config, payload, { allowSwitch });
            return config.runtime;
          }
        }

        throw new Error(`quota check status ${result.statusCode}`);
      }

      applyQuotaPayload(config, payload, { allowSwitch });
    } catch (err) {
      recordQuotaCheckFailure(config, err);
    }

    return config.runtime;
  }

  /**
   * 刷新单个账号并按状态变化输出日志。
   */
  async function refreshSingleConfigWithLogging(config, reason) {
    const previousAvailability = config.runtime.available;
    const previousReason = config.runtime.reason;

    await checkSingleAccountQuota(config, { allowSwitch: false });

    const availabilityChanged = previousAvailability !== config.runtime.available || previousReason !== config.runtime.reason;
    if (availabilityChanged && !config.runtime.available && reason !== 'startup') {
      warn(`账号不可用: ${getAccountLabel(config)} (${config.runtime.reason}${config.runtime.lastError ? `: ${config.runtime.lastError}` : ''})`);
    } else if (availabilityChanged && config.runtime.available && previousAvailability === false && reason !== 'startup') {
      warn(`账号恢复可用: ${getAccountLabel(config)} (remaining=${config.runtime.remainingPercent ?? 'unknown'}%)`);
    }
  }

  function getQuotaMonitoredConfigs() {
    return configs.filter(config => shouldUseQuotaMonitoring(config.type));
  }

  function shouldRefreshAllQuotas(reason, options = {}) {
    if (typeof options.refreshAll === 'boolean') {
      return options.refreshAll;
    }

    return true;
  }

  function getQuotaRefreshTargets(reason, options = {}) {
    if (shouldRefreshAllQuotas(reason, options)) {
      return getQuotaMonitoredConfigs();
    }

    const currentConfig = getActiveConfig();
    return currentConfig && shouldUseQuotaMonitoring(currentConfig.type)
      ? [currentConfig]
      : [];
  }

  function shouldRefreshApiKeyRecoveryTargets(reason, options = {}) {
    if (typeof options.refreshApiKeys === 'boolean') {
      return options.refreshApiKeys;
    }

    return reason === 'all_poll';
  }

  function getApiKeyRecoveryTargets(reason, options = {}) {
    if (!shouldRefreshApiKeyRecoveryTargets(reason, options)) {
      return [];
    }

    return configs.filter(config => (
      shouldUseApiKeyRecoveryMonitoring(config) &&
      config.runtime &&
      config.runtime.enabled &&
      !config.runtime.available
    ));
  }

  function classifyApiKeyRecoveryStatus(statusCode, previousReason) {
    const normalizedStatusCode = Number(statusCode);
    if (normalizedStatusCode === 401 || normalizedStatusCode === 403) {
      return 'apikey_auth_failed';
    }

    if (normalizedStatusCode === 429) {
      return 'apikey_rate_limited';
    }

    if (normalizedStatusCode >= 500 && normalizedStatusCode <= 599) {
      return 'apikey_upstream_5xx';
    }

    return 'apikey_upstream_error';
  }

  function getApiKeyRecoveryModel(config) {
    const healthModel = normalizeString(config && config.health && config.health.model);
    return healthModel || APIKEY_RECOVERY_REQUEST_BODY.model;
  }

  function buildApiKeyRecoveryRequestBody(config) {
    return Buffer.from(JSON.stringify({
      ...APIKEY_RECOVERY_REQUEST_BODY,
      model: getApiKeyRecoveryModel(config),
    }));
  }

  async function checkApiKeyRecovery(config) {
    const targetUrl = new URL(APIKEY_RECOVERY_RESPONSES_PATH, config.baseUrl).toString();
    const body = buildApiKeyRecoveryRequestBody(config);
    const headers = {
      ...buildAuthHeadersForConfig(config),
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    };

    const result = await withApiKeyRecoveryTimeout(requestBufferedFn({
      method: 'POST',
      targetUrl,
      headers,
      body,
      timeoutMs: apiKeyRecoveryTimeoutMs,
    }));

    const statusCode = Number(result && result.statusCode);
    const checkedAt = now();
    config.runtime.lastCheckedAt = checkedAt;

    if (isSuccessfulResponsesStatus(statusCode)) {
      config.runtime.available = true;
      config.runtime.reason = 'apikey';
      config.runtime.lastError = null;
      recordApiKeyRecoveryResult(config, {
        lastCheckedAt: checkedAt,
        result: 'success',
        statusCode,
        reason: 'apikey',
        lastError: null,
      });
      resetApiKeyRequestResults(config);
      return config.runtime;
    }

    config.runtime.available = false;
    config.runtime.reason = classifyApiKeyRecoveryStatus(statusCode, config.runtime.reason);
    config.runtime.lastError = Number.isFinite(statusCode) ? `http:${statusCode}` : 'invalid_status';
    recordApiKeyRecoveryResult(config, {
      lastCheckedAt: checkedAt,
      result: 'failed',
      statusCode: Number.isFinite(statusCode) ? statusCode : null,
      reason: config.runtime.reason,
      lastError: config.runtime.lastError,
    });
    return config.runtime;
  }

  async function refreshApiKeyRecoveryWithLogging(config) {
    const previousAvailability = config.runtime.available;
    const previousReason = config.runtime.reason;

    try {
      await checkApiKeyRecovery(config);
    } catch (err) {
      config.runtime.available = false;
      config.runtime.reason = 'apikey_upstream_error';
      const checkedAt = now();
      config.runtime.lastCheckedAt = checkedAt;
      config.runtime.lastError = err.message;
      recordApiKeyRecoveryResult(config, {
        lastCheckedAt: checkedAt,
        result: 'error',
        statusCode: null,
        reason: config.runtime.reason,
        lastError: config.runtime.lastError,
      });
    }

    const availabilityChanged = previousAvailability !== config.runtime.available || previousReason !== config.runtime.reason;
    if (availabilityChanged && config.runtime.available && previousAvailability === false) {
      warn(`API Key 恢复可用: ${getAccountLabel(config)}`);
    } else if (availabilityChanged && !config.runtime.available) {
      warn(`API Key 仍不可用: ${getAccountLabel(config)} (${config.runtime.reason}${config.runtime.lastError ? `: ${config.runtime.lastError}` : ''})`);
    }
  }

  function normalizeDelayMs(value) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0;
  }

  async function waitBetweenFullQuotaChecks(index, delayMs) {
    if (index === 0 || delayMs <= 0) {
      return;
    }

    await sleepFn(delayMs);
  }

  /**
   * 轮询 token 账号额度；十分钟全量校正会额外探测已不可用的 GPT API Key。
   */
  async function refreshQuotas(reason = 'poll', options = {}) {
    if (!hasQuotaOrApiKeyRecoveryTargets(reason)) {
      return;
    }

    if (quotaMonitorRunning) {
      return;
    }

    quotaMonitorRunning = true;
    const previousActiveIndex = activeConfigIndex;
    const targets = [
      ...getQuotaRefreshTargets(reason, options).map(config => ({ type: 'quota', config })),
      ...getApiKeyRecoveryTargets(reason, options).map(config => ({ type: 'apikey_recovery', config })),
    ];
    const delayBetweenAccountsMs = shouldRefreshAllQuotas(reason, options)
      ? normalizeDelayMs(options.delayBetweenAccountsMs)
      : 0;

    try {
      for (let index = 0; index < targets.length; index += 1) {
        await waitBetweenFullQuotaChecks(index, delayBetweenAccountsMs);
        if (targets[index].type === 'apikey_recovery') {
          await refreshApiKeyRecoveryWithLogging(targets[index].config);
        } else {
          await refreshSingleConfigWithLogging(targets[index].config, reason);
        }
      }

      const currentConfig = ensureActiveConfig(reason);

      if (previousActiveIndex !== activeConfigIndex && currentConfig) {
        warn(`当前活动账号: ${getAccountLabel(currentConfig)}`);
      }

      if ((reason === 'poll' || reason === 'all_poll') && currentConfig) {
        log(`轮询额度: ${getAccountStatus(currentConfig).summaryLine}`);
      }
    } finally {
      quotaMonitorRunning = false;
    }
  }

  /**
   * 启动后台额度轮询定时器。
   */
  function startQuotaMonitor() {
    if (!hasQuotaOrApiKeyRecoveryTargets('all_poll')) {
      return;
    }

    if (currentQuotaMonitorTimer) {
      clearIntervalFn(currentQuotaMonitorTimer);
    }

    if (allQuotaMonitorTimer) {
      clearIntervalFn(allQuotaMonitorTimer);
    }

    currentQuotaMonitorTimer = setIntervalFn(() => {
      void refreshQuotas('poll', {
        refreshAll: true,
        delayBetweenAccountsMs: allQuotaCheckDelayMs,
      });
    }, quotaCheckIntervalMs);

    allQuotaMonitorTimer = setIntervalFn(() => {
      void refreshQuotas('all_poll', {
        refreshAll: true,
        delayBetweenAccountsMs: allQuotaCheckDelayMs,
      });
    }, allQuotaCheckIntervalMs);
  }

  /**
   * 停止后台额度轮询定时器。
   */
  function stopQuotaMonitor() {
    if (currentQuotaMonitorTimer) {
      clearIntervalFn(currentQuotaMonitorTimer);
      currentQuotaMonitorTimer = null;
    }

    if (allQuotaMonitorTimer) {
      clearIntervalFn(allQuotaMonitorTimer);
      allQuotaMonitorTimer = null;
    }
  }

  return {
    ensureActiveConfig,
    refreshQuotas,
    startQuotaMonitor,
    stopQuotaMonitor,
    getActiveConfig,
    activateConfig,
    getAccountStatus,
    applyQuotaPayload,
    markConfigUnavailable,
    recordApiKeyRequestResult,
    acquireConfig,
    getDispatchIdentity,
    observeResponseModel,
  };
}

module.exports = {
  createAccountManager,
};
