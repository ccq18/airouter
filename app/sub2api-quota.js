/**
 * GET /v1/usage (Bearer API key), Wei-Shaw/sub2api at
 * 3f1c8f36ce8c2cd378015830a90e89970b9a9ea7:
 * https://github.com/Wei-Shaw/sub2api/blob/3f1c8f36ce8c2cd378015830a90e89970b9a9ea7/backend/internal/handler/gateway_handler.go#L1584
 * This endpoint does not expose server run_mode. Simple mode bypasses billing,
 * so an empty wallet by itself cannot prove that inference is blocked.
 */
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function numeric(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && value.trim())) return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function timestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function metric(id, details = {}) {
  return {
    id, scope: 'account', scope_key: null, kind: 'budget', unit: 'USD',
    remaining: null, used: null, limit: null, remainingPercent: null,
    resetAt: null, state: 'unknown', blocking: true, evidence: {}, ...details,
  };
}

function budget(id, source, evidence, resetAt, now) {
  const limit = numeric(source.limit);
  const used = numeric(source.used);
  const reportedRemaining = numeric(source.remaining);
  if (limit === null || limit < 0) return metric(id, { evidence });
  // Zero is the upstream's explicit unlimited sentinel, never exhaustion.
  if (limit === 0) return metric(id, { state: 'available', blocking: false, used, evidence: { ...evidence, unlimited: true } });
  if (used !== null && used < 0) return metric(id, { limit, evidence });
  let remaining = reportedRemaining;
  if (remaining === null && used !== null) remaining = limit - used;
  if (remaining === null) return metric(id, { limit, evidence });
  if (resetAt !== null && resetAt <= now) {
    return metric(id, { limit, resetAt, evidence: { ...evidence, stale_window: true } });
  }
  remaining = Math.max(0, Math.min(limit, remaining));
  return metric(id, {
    limit, used: used ?? Math.max(0, limit - remaining), remaining,
    remainingPercent: remaining / limit * 100, resetAt,
    state: remaining <= 0 ? 'exhausted' : 'available', evidence,
  });
}

function summarize(metrics, reason = '') {
  const blocking = metrics.filter(item => item.blocking);
  const exhausted = blocking.find(item => item.state === 'exhausted');
  const unknown = blocking.some(item => item.state === 'unknown');
  const state = exhausted ? 'exhausted' : unknown || !metrics.length ? 'unknown' : 'available';
  const resetValues = blocking.filter(item => item.state === 'exhausted' && item.resetAt !== null).map(item => item.resetAt);
  return {
    state, metrics, reason,
    ...(metrics.length && !blocking.length ? { unrestricted: true } : {}),
    ...(resetValues.length ? { resetAt: Math.min(...resetValues) } : {}),
  };
}

function parseSub2ApiUsage(payload, options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  const unknown = reason => ({ state: 'unknown', metrics: [], reason });
  if (!object(payload) || payload.error || !['quota_limited', 'unrestricted'].includes(payload.mode)) {
    return unknown('Sub2API 用量响应缺少有效 mode，或返回错误');
  }
  if (payload.isValid === false || ['disabled', 'inactive'].includes(payload.status)) {
    return summarize([metric('key_status', { state: 'exhausted', evidence: { status: payload.status || 'invalid' } })], 'Sub2API Key 已停用或无效');
  }
  if (payload.isValid !== true) return unknown('Sub2API 用量响应缺少 isValid');
  const expiresAt = timestamp(payload.expires_at);
  if (payload.status === 'expired' || (expiresAt !== null && expiresAt <= now)) {
    return summarize([metric('key_expiry', { state: 'exhausted', evidence: { expires_at: payload.expires_at || null } })], 'Sub2API Key 已过期');
  }
  if (payload.status === 'quota_exhausted') {
    return summarize([metric('key_status', { state: 'exhausted', evidence: { status: payload.status } })], 'Sub2API Key 总额度已耗尽');
  }

  if (payload.mode === 'quota_limited') {
    const metrics = [];
    if (object(payload.quota)) {
      metrics.push(payload.quota.unit === 'USD'
        ? budget('key_quota', payload.quota, { scope: 'key', source: 'quota' }, null, now)
        : metric('key_quota', { evidence: { error: 'quota unit is not USD' } }));
    }
    if (Array.isArray(payload.rate_limits)) {
      const seen = new Set();
      for (const entry of payload.rate_limits) {
        if (!object(entry) || !['5h', '1d', '7d'].includes(entry.window) || seen.has(entry.window)) {
          metrics.push(metric('key_window_unknown', { evidence: { error: 'invalid or duplicate rate limit window' } }));
          continue;
        }
        seen.add(entry.window);
        metrics.push(budget(`key_window_${entry.window}`, entry,
          { scope: 'key', source: 'rate_limits', window: entry.window }, timestamp(entry.reset_at), now));
      }
    }
    // quota_limited only describes key constraints; underlying wallet or
    // subscription availability is not included by the upstream response.
    return summarize(metrics, metrics.length ? 'Sub2API Key 限额；此响应未包含底层钱包或订阅额度' : 'Sub2API Key 限额字段缺失');
  }

  if (object(payload.subscription)) {
    const sub = payload.subscription;
    const expiry = timestamp(sub.expires_at);
    if (expiry !== null && expiry <= now) {
      return summarize([metric('subscription_expiry', { state: 'exhausted', evidence: { expires_at: sub.expires_at } })], 'Sub2API 订阅已过期');
    }
    if (payload.unit !== 'USD') return unknown('Sub2API 订阅响应缺少 USD 单位');
    const metrics = [];
    for (const period of ['daily', 'weekly', 'monthly']) {
      const field = `${period}_limit_usd`;
      if (!has(sub, field)) {
        metrics.push(metric(`subscription_${period}`, { evidence: { error: `${field} missing` } }));
      } else if (sub[field] === null || numeric(sub[field]) === 0) {
        metrics.push(metric(`subscription_${period}`, { state: 'available', blocking: false, evidence: { unlimited: true, period } }));
      } else {
        // /usage does not provide daily/monthly reset times; do not invent a
        // server timezone or a calendar/rolling-window reset policy.
        metrics.push(budget(`subscription_${period}`, { limit: sub[field], used: sub[`${period}_usage_usd`] }, { source: 'subscription', period }, null, now));
      }
    }
    return summarize(metrics, 'Sub2API 订阅日/周/月限额；上游未提供完整窗口重置时间');
  }

  if (payload.unit === 'USD' && has(payload, 'balance')) {
    const balance = numeric(payload.balance);
    if (balance === null) return unknown('Sub2API 钱包余额不是有效数值');
    const result = metric('wallet_balance', {
      remaining: balance, state: balance > 0 ? 'available' : 'unknown',
      evidence: { source: 'balance', run_mode_exposed: false },
    });
    return summarize([result], balance > 0 ? 'Sub2API 钱包余额' : 'Sub2API 未暴露运行模式；零或负余额无法区分计费模式与 Simple 模式，需由真实请求验证');
  }
  // `remaining: -1` is only an unlimited sentinel when confirmed by the
  // subscription's actual configured limits; missing subscription is unknown.
  return unknown('Sub2API 响应未包含钱包余额或完整订阅信息');
}

module.exports = { parseSub2ApiUsage };
