const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getRuntimeConfigIdentity,
    reconcileRuntimeConfigs,
} = require('../app/runtime-config-reconciler');

function createRuntime(overrides = {}) {
    return {
        enabled: true,
        available: true,
        lastCheckedAt: null,
        remainingPercent: null,
        primaryRemainingPercent: null,
        primaryResetAt: null,
        primaryResetAfterSeconds: null,
        secondaryRemainingPercent: null,
        secondaryResetAt: null,
        secondaryResetAfterSeconds: null,
        reason: 'unchecked',
        lastError: null,
        ...overrides,
    };
}

function createTokenConfig(index, runtimeOverrides = {}, overrides = {}) {
    return {
        type: 'token',
        index,
        description: `account-${index + 1}`,
        baseUrl: 'https://chatgpt.com',
        apiBasePath: '/backend-api/codex',
        access_token: `token-${index}`,
        account_id: `account-${index}`,
        runtime: createRuntime(runtimeOverrides),
        ...overrides,
    };
}

test('getRuntimeConfigIdentity includes the token credentials for token configs', () => {
    const config = createTokenConfig(0);

    assert.equal(
        getRuntimeConfigIdentity(config),
        'token:https://chatgpt.com:account-0:token-0'
    );
});

test('reconcileRuntimeConfigs preserves existing runtime state for unchanged configs', () => {
    const previousConfigs = [
        createTokenConfig(0, { available: false, reason: 'quota_check_failed', lastCheckedAt: 1713337200000 }),
        createTokenConfig(1, { available: true, reason: 'ok', remainingPercent: 66, lastCheckedAt: 1713337200000 }),
    ];
    const nextConfigs = [
        createTokenConfig(0),
        createTokenConfig(1),
        createTokenConfig(2),
    ];

    const reconciled = reconcileRuntimeConfigs(previousConfigs, nextConfigs, {
        previousActiveConfig: previousConfigs[1],
        previousActiveIndex: 1,
    });

    assert.equal(nextConfigs[0].runtime.reason, 'quota_check_failed');
    assert.equal(nextConfigs[0].runtime.lastCheckedAt, 1713337200000);
    assert.equal(nextConfigs[1].runtime.remainingPercent, 66);
    assert.equal(nextConfigs[2].runtime.reason, 'unchecked');
    assert.equal(reconciled.initialActiveConfigIndex, 1);
});

test('reconcileRuntimeConfigs prefers runtime overrides for newly added configs', () => {
    const previousConfigs = [createTokenConfig(0, { available: true, reason: 'ok' })];
    const nextConfigs = [
        createTokenConfig(0),
        createTokenConfig(1),
    ];
    const validatedConfig = createTokenConfig(99, {
        available: false,
        reason: 'remaining_below_3%',
        remainingPercent: 2,
        lastCheckedAt: 1713337200000,
    }, {
        access_token: 'token-1',
        account_id: 'account-1',
    });

    reconcileRuntimeConfigs(previousConfigs, nextConfigs, {
        previousActiveConfig: previousConfigs[0],
        previousActiveIndex: 0,
        runtimeOverrides: [validatedConfig],
    });

    assert.equal(nextConfigs[1].runtime.reason, 'remaining_below_3%');
    assert.equal(nextConfigs[1].runtime.remainingPercent, 2);
    assert.equal(nextConfigs[1].runtime.lastCheckedAt, 1713337200000);
});

test('reconcileRuntimeConfigs falls back to the previous index when the active config is removed', () => {
    const previousConfigs = [
        createTokenConfig(0, { available: true, reason: 'ok' }),
        createTokenConfig(1, { available: true, reason: 'ok' }),
        createTokenConfig(2, { available: true, reason: 'ok' }),
    ];
    const nextConfigs = [
        createTokenConfig(0),
        createTokenConfig(1, {}, {
            access_token: 'token-2',
            account_id: 'account-2',
        }),
    ];

    const reconciled = reconcileRuntimeConfigs(previousConfigs, nextConfigs, {
        previousActiveConfig: previousConfigs[1],
        previousActiveIndex: 1,
    });

    assert.equal(reconciled.initialActiveConfigIndex, 1);
});
