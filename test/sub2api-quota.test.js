const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSub2ApiUsage } = require('../app/sub2api-quota');
const NOW = Date.parse('2026-10-25T10:00:00Z');
const parse = payload => parseSub2ApiUsage(payload, { now: () => NOW });

test('observed Sub2API wallet response shape preserves USD balance without inventing a deposit limit', () => {
  const payload = { balance: 9.125, daily_usage: [{ date: '2026-10-01', requests: 1, cost: 0.25, actual_cost: 0.125 }], isValid: true, mode: 'unrestricted', model_stats: [{ model: 'fixture-model', requests: 1 }], planName: '钱包余额', remaining: 9.125, unit: 'USD', usage: {} };
  const result = parse(payload);
  assert.equal(result.state, 'available');
  assert.equal(result.metrics[0].remaining, 9.125);
  assert.equal(result.metrics[0].unit, 'USD');
  assert.equal(result.metrics[0].limit, null);
  assert.equal(result.metrics[0].used, null);
  assert.equal(result.metrics[0].remainingPercent, null);
});

test('wallet zero and negative balance remain unknown because usage does not expose Simple mode', () => {
  for (const balance of [0, -1]) {
    const result = parse({ mode: 'unrestricted', isValid: true, balance, remaining: balance, unit: 'USD' });
    assert.equal(result.state, 'unknown');
    assert.match(result.reason, /Simple/);
    assert.equal(result.metrics[0].remaining, balance);
  }
});

test('key quota and monetary rate windows combine and preserve explicit reset times', () => {
  const result = parse({ mode: 'quota_limited', isValid: true, status: 'active', quota: { limit: 100, used: 10, remaining: 90, unit: 'USD' }, rate_limits: [{ window: '5h', limit: 5, used: 5, remaining: 0, reset_at: '2026-10-25T12:00:00Z' }] });
  assert.equal(result.state, 'exhausted');
  assert.equal(result.metrics[0].remainingPercent, 90);
  assert.equal(result.metrics[1].remainingPercent, 0);
  assert.equal(result.resetAt, Date.parse('2026-10-25T12:00:00Z'));
  assert.equal(result.metrics[1].unit, 'USD');
});

test('zero key quota is unlimited, while omitted usage is unknown rather than zero', () => {
  let result = parse({ mode: 'quota_limited', isValid: true, quota: { limit: 0, used: 0, remaining: 0, unit: 'USD' } });
  assert.equal(result.state, 'available');
  assert.equal(result.unrestricted, true);
  assert.equal(result.metrics[0].blocking, false);
  result = parse({ mode: 'quota_limited', isValid: true, quota: { limit: 10, unit: 'USD' } });
  assert.equal(result.state, 'unknown');
  assert.equal(result.metrics[0].remaining, null);
  assert.equal(parse({ mode: 'quota_limited', isValid: true }).state, 'unknown');
});

test('subscription actual day/week/month limits gate independently of wallet summary', () => {
  const result = parse({ mode: 'unrestricted', isValid: true, unit: 'USD', balance: 0, remaining: 0, subscription: { daily_limit_usd: 10, daily_usage_usd: 10, weekly_limit_usd: 50, weekly_usage_usd: 12, monthly_limit_usd: null, monthly_usage_usd: 12, expires_at: '2026-11-25T10:00:00Z' } });
  assert.equal(result.state, 'exhausted');
  assert.equal(result.metrics[0].id, 'subscription_daily');
  assert.equal(result.metrics[1].remaining, 38);
  assert.equal(result.metrics[2].blocking, false);
  assert.equal(result.metrics[0].resetAt, null);
});

test('unlimited subscription requires all configured periods, not only remaining minus one', () => {
  const base = { mode: 'unrestricted', isValid: true, unit: 'USD', remaining: -1 };
  assert.equal(parse(base).state, 'unknown');
  assert.equal(parse({ ...base, subscription: {} }).state, 'unknown');
  const result = parse({ ...base, subscription: { daily_limit_usd: null, weekly_limit_usd: 0, monthly_limit_usd: null } });
  assert.equal(result.state, 'available');
  assert.equal(result.unrestricted, true);
});

test('disabled, expired key, exhausted status and expired subscriptions remain blocking', () => {
  const base = { mode: 'quota_limited', isValid: true, quota: { limit: 10, used: 0, remaining: 10, unit: 'USD' } };
  for (const patch of [{ isValid: false }, { status: 'disabled' }, { status: 'expired' }, { status: 'quota_exhausted' }, { expires_at: '2026-10-25T09:00:00Z' }]) assert.equal(parse({ ...base, ...patch }).state, 'exhausted');
  assert.equal(parse({ mode: 'unrestricted', isValid: true, unit: 'USD', subscription: { expires_at: '2026-10-25T09:00:00Z' } }).state, 'exhausted');
});

test('stale rate window cannot manufacture either exhaustion or recovery', () => {
  const result = parse({ mode: 'quota_limited', isValid: true, rate_limits: [{ window: '1d', limit: 5, used: 5, remaining: 0, reset_at: '2026-10-25T09:00:00Z' }] });
  assert.equal(result.state, 'unknown');
  assert.equal(result.metrics[0].remaining, null);
  assert.equal(result.metrics[0].evidence.stale_window, true);
});

test('invalid response and nonnumeric values do not turn into zero budget', () => {
  for (const payload of [null, {}, { error: { message: 'unauthorized' } }, { mode: 'unrestricted', isValid: true, unit: 'USD' }, { mode: 'unrestricted', balance: 2, unit: 'USD' }]) assert.equal(parse(payload).state, 'unknown');
  for (const value of [null, '', false, {}, 'NaN', 'Infinity']) {
    const result = parse({ mode: 'quota_limited', isValid: true, quota: { limit: 10, remaining: value, unit: 'USD' } });
    assert.equal(result.state, 'unknown');
    assert.equal(result.metrics[0].remaining, null);
  }
});
