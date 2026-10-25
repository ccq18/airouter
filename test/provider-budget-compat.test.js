const test = require('node:test');
const assert = require('node:assert/strict');
const { parseQuotaBody } = require('../app/provider-presets');

test('OpenRouter exhausted workspace USD budget blocks a key with remaining credit', () => {
  const budget = {
    limit_usd: 50,
    spend_usd: 50,
    remaining_usd: 0,
    resets_at: '2026-11-01T00:00:00.000Z',
    scope: 'workspace',
  };
  const quota = parseQuotaBody({ preset: 'openrouter', type: 'apikey' }, {
    data: { limit: 100, usage: 25, limit_remaining: 75, budgets: [budget], effective_budget: budget },
  });
  assert.equal(quota.state, 'exhausted');
  const effective = quota.metrics.find(metric => metric.id === 'effective_budget');
  assert.equal(effective.limit, 50);
  assert.equal(effective.used, 50);
  assert.equal(effective.remaining, 0);
});

test('OpenRouter remaining USD budget is readable without inventing a key spending cap', () => {
  const quota = parseQuotaBody({ preset: 'openrouter', type: 'apikey' }, {
    data: { limit: null, limit_remaining: null, effective_budget: {
      limit_usd: 50, spend_usd: 32.5, remaining_usd: 17.5, scope: 'member',
    } },
  });
  assert.equal(quota.state, 'available');
  assert.equal(quota.metrics[0].remaining, 17.5);
  assert.equal(quota.metrics[0].limit, 50);
});
