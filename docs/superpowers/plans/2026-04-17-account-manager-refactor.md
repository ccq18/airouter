# Account Manager Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract quota polling, account availability tracking, and active-account selection out of `openai.js` into `app/account-manager.js` without changing runtime behavior.

**Architecture:** `openai.js` remains the composition root for config loading, Express setup, and proxying. A new factory module `app/account-manager.js` owns active account state, quota evaluation, quota polling, and account selection behind a small injected-dependency interface.

**Tech Stack:** Node.js CommonJS, `node:test`, Express, `child_process.spawn`, curl-based upstream requests

---

## File Structure

- Create: `app/account-manager.js`
- Create: `test/account-manager.test.js`
- Modify: `openai.js`
- Verify: `test/run.test.js`

## Task 1: Lock Existing Account Behavior With Failing Tests

**Files:**
- Create: `test/account-manager.test.js`
- Reference: `app/openai-config.js`

- [ ] **Step 1: Write the failing unit tests for account selection and quota evaluation**

Create `test/account-manager.test.js` with this content:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAccountManager } = require('../app/account-manager');

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
        ...overrides
    };
}

function createConfig(index, runtimeOverrides = {}) {
    return {
        type: 'token',
        index,
        description: `account-${index + 1}`,
        baseUrl: 'https://chatgpt.com',
        apiBasePath: '/backend-api/codex',
        access_token: `token-${index}`,
        account_id: `account-${index}`,
        runtime: createRuntime(runtimeOverrides)
    };
}

function createManager(configs, overrides = {}) {
    const warnings = [];
    const logs = [];
    const spawn = overrides.spawn || (() => {
        throw new Error('spawn stub not provided');
    });

    const manager = createAccountManager({
        configs,
        configType: 'token',
        quotaCheckPath: '/backend-api/wham/usage',
        quotaCheckIntervalMs: 60 * 1000,
        minRemainingPercent: 3,
        buildAuthHeadersForConfig: config => ({
            authorization: `Bearer ${config.access_token}`,
            'chatgpt-account-id': config.account_id
        }),
        shouldUseQuotaMonitoring: type => type === 'token',
        spawn,
        log: (...args) => logs.push(args.join(' ')),
        warn: (...args) => warnings.push(args.join(' ')),
        now: () => 1713337200000
    });

    return { manager, logs, warnings };
}

test('ensureActiveConfig keeps the current account when it is still available', () => {
    const configs = [
        createConfig(0, { available: true, reason: 'ok' }),
        createConfig(1, { available: true, reason: 'ok' })
    ];
    const { manager, warnings } = createManager(configs);

    const selected = manager.ensureActiveConfig('poll');

    assert.equal(selected, configs[0]);
    assert.equal(manager.getActiveConfig(), configs[0]);
    assert.equal(warnings.length, 0);
});

test('ensureActiveConfig switches to the next available account when current one becomes unavailable', () => {
    const configs = [
        createConfig(0, { available: false, reason: 'remaining_below_3%' }),
        createConfig(1, { available: true, reason: 'ok' }),
        createConfig(2, { available: true, reason: 'ok' })
    ];
    const { manager, warnings } = createManager(configs);

    const selected = manager.ensureActiveConfig('poll');

    assert.equal(selected, configs[1]);
    assert.equal(manager.getActiveConfig(), configs[1]);
    assert.match(warnings[0], /账号切换: #1 account-1 -> #2 account-2 \(poll\)/);
});

test('ensureActiveConfig keeps the current account when no account is marked available', () => {
    const configs = [
        createConfig(0, { available: false, reason: 'quota_check_failed' }),
        createConfig(1, { available: false, reason: 'remaining_below_3%' })
    ];
    const { manager, warnings } = createManager(configs);

    const selected = manager.ensureActiveConfig('poll');

    assert.equal(selected, configs[0]);
    assert.equal(manager.getActiveConfig(), configs[0]);
    assert.match(warnings[0], /没有可用账号，继续使用当前账号 #1 account-1 \(poll\)/);
});

test('evaluateQuotaPayload marks allowed=false as unavailable', () => {
    const { manager } = createManager([createConfig(0)]);

    const state = manager.evaluateQuotaPayload({
        rate_limit: {
            allowed: false,
            primary_window: { used_percent: 10, reset_at: 1713350000 },
            secondary_window: { used_percent: 20, reset_at: 1713360000 }
        }
    });

    assert.equal(state.available, false);
    assert.equal(state.reason, 'rate_limit_not_allowed');
});

test('evaluateQuotaPayload marks limit_reached=true as unavailable', () => {
    const { manager } = createManager([createConfig(0)]);

    const state = manager.evaluateQuotaPayload({
        rate_limit: {
            allowed: true,
            limit_reached: true,
            primary_window: { used_percent: 10, reset_at: 1713350000 },
            secondary_window: { used_percent: 20, reset_at: 1713360000 }
        }
    });

    assert.equal(state.available, false);
    assert.equal(state.reason, 'rate_limit_reached');
});

test('evaluateQuotaPayload marks remaining below threshold as unavailable', () => {
    const { manager } = createManager([createConfig(0)]);

    const state = manager.evaluateQuotaPayload({
        rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 98, reset_at: 1713350000 },
            secondary_window: { used_percent: 10, reset_at: 1713360000 }
        }
    });

    assert.equal(state.available, false);
    assert.equal(state.reason, 'remaining_below_3%');
    assert.equal(state.remainingPercent, 2);
});
```

- [ ] **Step 2: Run the test file to verify it fails because the module does not exist**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: FAIL with `Cannot find module '../app/account-manager'`.

- [ ] **Step 3: Add the poll logging regression test before implementation**

Append this test to `test/account-manager.test.js`:

```js
test('refreshQuotas logs the active account summary after a poll', async () => {
    function createSpawnFromBodies(bodies) {
        let index = 0;

        return (_command, _args, _options) => {
            const { EventEmitter } = require('node:events');
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            child.stdin = { end() {} };

            process.nextTick(() => {
                child.stdout.emit('data', `${JSON.stringify(bodies[index])}\n__CURL_STATUS__:200`);
                child.emit('close', 0);
                index += 1;
            });

            return child;
        };
    }

    const configs = [
        createConfig(0, { available: true, reason: 'ok' }),
        createConfig(1, { available: true, reason: 'ok' })
    ];

    const { manager, logs } = createManager(configs, {
        spawn: createSpawnFromBodies([
            {
                rate_limit: {
                    allowed: true,
                    limit_reached: false,
                    primary_window: { used_percent: 25, reset_at: 1713350000 },
                    secondary_window: { used_percent: 40, reset_at: 1713360000 }
                }
            },
            {
                rate_limit: {
                    allowed: true,
                    limit_reached: false,
                    primary_window: { used_percent: 30, reset_at: 1713351000 },
                    secondary_window: { used_percent: 35, reset_at: 1713361000 }
                }
            }
        ])
    });

    await manager.refreshQuotas('poll');

    assert.match(logs[0], /轮询额度: #1 account-1 \| 可用=是/);
});
```

- [ ] **Step 4: Re-run the test file to confirm the new poll test also fails for the same missing-module reason**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: FAIL with the same missing-module error; no passing tests yet.

- [ ] **Step 5: Commit the red test file**

```bash
git add test/account-manager.test.js
git commit -m "test: cover account manager behavior"
```

## Task 2: Implement app/account-manager.js Until the Unit Tests Pass

**Files:**
- Create: `app/account-manager.js`
- Test: `test/account-manager.test.js`

- [ ] **Step 1: Create the module shell with the public API used by the tests**

Create `app/account-manager.js` with this initial structure:

```js
const { EventEmitter } = require('node:events');

function createAccountManager(options) {
    const {
        configs,
        configType,
        quotaCheckPath,
        quotaCheckIntervalMs,
        minRemainingPercent,
        buildAuthHeadersForConfig,
        shouldUseQuotaMonitoring,
        spawn,
        log,
        warn,
        now
    } = options;

    let activeConfigIndex = 0;
    let quotaMonitorRunning = false;
    let quotaMonitorTimer = null;

    function getActiveConfig() {
        return configs[activeConfigIndex] || null;
    }

    function evaluateQuotaPayload(_payload) {
        throw new Error('not implemented');
    }

    function getRuntimeSummary(_config) {
        throw new Error('not implemented');
    }

    function ensureActiveConfig(_reason = 'select') {
        throw new Error('not implemented');
    }

    function selectConfig() {
        return ensureActiveConfig('request');
    }

    async function refreshQuotas(_reason = 'poll') {
        throw new Error('not implemented');
    }

    function startQuotaMonitor() {
        if (!shouldUseQuotaMonitoring(configType)) {
            return;
        }

        if (quotaMonitorTimer) {
            clearInterval(quotaMonitorTimer);
        }

        quotaMonitorTimer = setInterval(() => {
            void refreshQuotas('poll');
        }, quotaCheckIntervalMs);
    }

    return {
        selectConfig,
        ensureActiveConfig,
        refreshQuotas,
        startQuotaMonitor,
        getActiveConfig,
        getRuntimeSummary,
        evaluateQuotaPayload
    };
}

module.exports = {
    createAccountManager
};
```

- [ ] **Step 2: Run the unit tests and confirm they now fail on unimplemented methods instead of a missing module**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: FAIL with `not implemented` from one of the new methods.

- [ ] **Step 3: Fill in the pure quota-evaluation and formatting helpers**

Replace the throwing helpers with this implementation:

```js
function formatQuotaPercent(value) {
    return value === null || typeof value === 'undefined' ? 'unknown' : `${value}%`;
}

function formatQuotaResetTime(epochSeconds) {
    if (epochSeconds === null || typeof epochSeconds === 'undefined') {
        return 'unknown';
    }

    return new Date(epochSeconds * 1000).toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });
}

function formatBooleanText(value) {
    return value ? '是' : '否';
}

function formatReasonText(reason) {
    const reasonMap = {
        ok: '正常',
        unchecked: '未检查',
        api_key: 'API Key 模式',
        missing_credentials: '缺少凭证',
        rate_limit_not_allowed: '额度不可用',
        rate_limit_reached: '额度已用尽',
        [`remaining_below_${minRemainingPercent}%`]: `剩余额度低于 ${minRemainingPercent}%`,
        quota_check_failed: '额度检查失败'
    };

    return reasonMap[reason] || reason || '未知';
}

function computeRemainingPercent(windowData) {
    if (!windowData || typeof windowData.used_percent !== 'number') {
        return null;
    }

    return Math.max(0, 100 - windowData.used_percent);
}

function evaluateQuotaPayload(payload) {
    const rateLimit = payload && typeof payload === 'object' ? payload.rate_limit || {} : {};
    const primaryRemainingPercent = computeRemainingPercent(rateLimit.primary_window);
    const secondaryRemainingPercent = computeRemainingPercent(rateLimit.secondary_window);
    const remainingValues = [primaryRemainingPercent, secondaryRemainingPercent].filter(value => value !== null);
    const remainingPercent = remainingValues.length > 0 ? Math.min(...remainingValues) : null;

    let available = true;
    let reason = 'ok';

    if (rateLimit.allowed === false) {
        available = false;
        reason = 'rate_limit_not_allowed';
    } else if (rateLimit.limit_reached === true) {
        available = false;
        reason = 'rate_limit_reached';
    } else if (remainingPercent !== null && remainingPercent < minRemainingPercent) {
        available = false;
        reason = `remaining_below_${minRemainingPercent}%`;
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
        secondaryResetAfterSeconds: rateLimit.secondary_window?.reset_after_seconds ?? null
    };
}

function getRuntimeSummary(config) {
    const runtime = config.runtime;
    const parts = [
        `可用=${formatBooleanText(runtime.available)}`,
        `额度=${formatQuotaPercent(runtime.primaryRemainingPercent)}`,
        `刷新时间=${formatQuotaResetTime(runtime.primaryResetAt)}`,
        `周额度=${formatQuotaPercent(runtime.secondaryRemainingPercent)}`,
        `刷新时间=${formatQuotaResetTime(runtime.secondaryResetAt)}`,
        `状态=${formatReasonText(runtime.reason)}`
    ];

    if (runtime.lastError) {
        parts.push(`错误=${runtime.lastError}`);
    }

    return parts.join(' | ');
}
```

- [ ] **Step 4: Fill in state updates, account selection, and quota refresh**

Add these implementations below the formatting helpers:

```js
function getAccountLabel(config) {
    return `#${config.index + 1} ${config.description}`;
}

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
}

function isConfigAvailable(config) {
    return Boolean(config && config.runtime && config.runtime.enabled && config.runtime.available);
}

function findNextAvailableConfigIndex(startIndex) {
    if (configs.length === 0) {
        return -1;
    }

    for (let offset = 0; offset < configs.length; offset += 1) {
        const index = (startIndex + offset) % configs.length;
        if (isConfigAvailable(configs[index])) {
            return index;
        }
    }

    return -1;
}

function ensureActiveConfig(reason = 'select') {
    const currentConfig = configs[activeConfigIndex];
    if (isConfigAvailable(currentConfig)) {
        return currentConfig;
    }

    const fallbackIndex = findNextAvailableConfigIndex((activeConfigIndex + 1) % Math.max(configs.length, 1));
    if (fallbackIndex !== -1) {
        const previousConfig = currentConfig;
        activeConfigIndex = fallbackIndex;
        const nextConfig = configs[activeConfigIndex];

        if (previousConfig !== nextConfig) {
            warn(`账号切换: ${previousConfig ? getAccountLabel(previousConfig) : 'none'} -> ${getAccountLabel(nextConfig)} (${reason})`);
        }

        return nextConfig;
    }

    if (currentConfig) {
        warn(`没有可用账号，继续使用当前账号 ${getAccountLabel(currentConfig)} (${reason})`);
        return currentConfig;
    }

    throw new Error('没有可用账号配置');
}

function runBufferedCurl(method, targetUrl, headers, body) {
    return new Promise((resolve, reject) => {
        const hasBody = Buffer.isBuffer(body) && body.length > 0;
        const args = [
            '--http1.1',
            '--silent',
            '--show-error',
            '--location',
            '-X',
            method,
            targetUrl,
            '-w',
            '\n__CURL_STATUS__:%{http_code}'
        ];

        for (const [name, value] of Object.entries(headers || {})) {
            if (typeof value === 'undefined') {
                continue;
            }

            args.push('-H', `${name}: ${value}`);
        }

        if (hasBody) {
            args.push('--data-binary', '@-');
        }

        const curl = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';

        curl.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
        });

        curl.stderr.on('data', chunk => {
            stderr += chunk.toString('utf8');
        });

        curl.on('error', reject);
        curl.on('close', code => {
            if (code !== 0) {
                reject(new Error(stderr.trim() || `curl exited with code ${code}`));
                return;
            }

            const marker = '\n__CURL_STATUS__:';
            const markerIndex = stdout.lastIndexOf(marker);
            if (markerIndex === -1) {
                reject(new Error('无法解析 curl 返回状态码'));
                return;
            }

            resolve({
                statusCode: Number(stdout.slice(markerIndex + marker.length).trim()),
                bodyText: stdout.slice(0, markerIndex),
                stderr: stderr.trim()
            });
        });

        if (hasBody) {
            curl.stdin.end(body);
        } else {
            curl.stdin.end();
        }
    });
}

async function checkSingleAccountQuota(config) {
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
        const result = await runBufferedCurl('GET', targetUrl, buildAuthHeadersForConfig(config));
        if (result.statusCode < 200 || result.statusCode >= 300) {
            throw new Error(`quota check status ${result.statusCode}`);
        }

        applyQuotaState(config, evaluateQuotaPayload(JSON.parse(result.bodyText)));
    } catch (err) {
        config.runtime.available = Boolean(config.runtime.available);
        config.runtime.reason = 'quota_check_failed';
        config.runtime.lastCheckedAt = now();
        config.runtime.lastError = err.message;
    }

    return config.runtime;
}

async function refreshQuotas(reason = 'poll') {
    if (!shouldUseQuotaMonitoring(configType)) {
        return;
    }

    if (quotaMonitorRunning) {
        return;
    }

    quotaMonitorRunning = true;
    const previousActiveIndex = activeConfigIndex;

    try {
        for (const config of configs) {
            const previousAvailability = config.runtime.available;
            const previousReason = config.runtime.reason;

            await checkSingleAccountQuota(config);

            const availabilityChanged = previousAvailability !== config.runtime.available || previousReason !== config.runtime.reason;
            if (availabilityChanged && !config.runtime.available && reason !== 'startup') {
                warn(`账号不可用: ${getAccountLabel(config)} (${config.runtime.reason}${config.runtime.lastError ? `: ${config.runtime.lastError}` : ''})`);
            } else if (availabilityChanged && config.runtime.available && previousAvailability === false && reason !== 'startup') {
                warn(`账号恢复可用: ${getAccountLabel(config)} (remaining=${config.runtime.remainingPercent ?? 'unknown'}%)`);
            }
        }

        const currentConfig = ensureActiveConfig(reason);

        if (previousActiveIndex !== activeConfigIndex) {
            warn(`当前活动账号: ${getAccountLabel(currentConfig)}`);
        }

        if (reason === 'poll') {
            log(`轮询额度: ${getAccountLabel(currentConfig)} | ${getRuntimeSummary(currentConfig)}`);
        }
    } finally {
        quotaMonitorRunning = false;
    }
}
```

- [ ] **Step 5: Run the unit tests until they pass**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: PASS with all tests green.

- [ ] **Step 6: Commit the new module**

```bash
git add app/account-manager.js test/account-manager.test.js
git commit -m "refactor: extract account manager module"
```

## Task 3: Wire openai.js To The Extracted Manager

**Files:**
- Modify: `openai.js`
- Verify: `test/account-manager.test.js`

- [ ] **Step 1: Replace the inline account-management state and helper import with the new module**

Update the top of `openai.js` to import the module and remove the inline state variables:

```js
const { createAccountManager } = require('./app/account-manager');
const {
    parseOpenAiConfigFile,
    createRuntimeConfigs,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
} = require('./app/openai-config');

const LOADED_CONFIG = loadApiConfigs();
const CONFIG_TYPE = LOADED_CONFIG.type;
const API_CONFIGS = LOADED_CONFIG.configs;

const accountManager = createAccountManager({
    configs: API_CONFIGS,
    configType: CONFIG_TYPE,
    quotaCheckPath: QUOTA_CHECK_PATH,
    quotaCheckIntervalMs: QUOTA_CHECK_INTERVAL_MS,
    minRemainingPercent: MIN_REMAINING_PERCENT,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring,
    spawn,
    log,
    warn,
    now: getCurrentTimestamp
});
```

- [ ] **Step 2: Delete the migrated inline functions and replace call sites with accountManager methods**

Remove these functions and state from `openai.js`:

```js
let activeConfigIndex = 0;
let quotaMonitorRunning = false;
let quotaMonitorTimer = null;

function formatQuotaPercent(value) { /* delete */ }
function formatQuotaResetTime(epochSeconds) { /* delete */ }
function formatBooleanText(value) { /* delete */ }
function formatReasonText(reason) { /* delete */ }
function formatRuntimeSummary(config) { /* delete */ }
function computeRemainingPercent(windowData) { /* delete */ }
function evaluateQuotaResponse(payload) { /* delete */ }
function applyQuotaState(config, quotaState) { /* delete */ }
function isConfigAvailable(config) { /* delete */ }
function findNextAvailableConfigIndex(startIndex) { /* delete */ }
function ensureActiveConfig(reason = 'select') { /* delete */ }
function selectConfig() { /* delete */ }
function buildQuotaCheckHeaders(config) { /* delete */ }
async function checkSingleAccountQuota(config) { /* delete */ }
async function refreshAllAccountQuotas(reason = 'poll') { /* delete */ }
function startQuotaMonitor() { /* delete */ }
```

Replace the remaining call sites like this:

```js
function proxyRequest(req, res, config, body, originalUrl) {
    // ... keep existing proxy logic

    curl.on('close', (code) => {
        // ... keep existing error handling

        if (shouldLogQuotaUsage) {
            try {
                const payloadText = decodeResponseBody(
                    Buffer.concat(responseBodyChunks),
                    upstreamResponseHeaders['content-encoding']
                );
                const payload = JSON.parse(payloadText);
                const quotaState = accountManager.evaluateQuotaPayload(payload);
                config.runtime.available = quotaState.available;
                config.runtime.reason = quotaState.reason;
                config.runtime.lastCheckedAt = getCurrentTimestamp();
                config.runtime.remainingPercent = quotaState.remainingPercent;
                config.runtime.primaryRemainingPercent = quotaState.primaryRemainingPercent;
                config.runtime.primaryResetAt = quotaState.primaryResetAt;
                config.runtime.primaryResetAfterSeconds = quotaState.primaryResetAfterSeconds;
                config.runtime.secondaryRemainingPercent = quotaState.secondaryRemainingPercent;
                config.runtime.secondaryResetAt = quotaState.secondaryResetAt;
                config.runtime.secondaryResetAfterSeconds = quotaState.secondaryResetAfterSeconds;
                config.runtime.lastError = null;
                log(`额度信息: ${getAccountLabel(config)} | ${accountManager.getRuntimeSummary(config)}`);
            } catch (err) {
                warn(`额度信息解析失败: ${getAccountLabel(config)} (${err.message})`);
            }
        }
    });
}

function createHandler(proxyPath = '') {
    return function handler(req, res) {
        const config = accountManager.selectConfig();
        // ... keep the rest unchanged
    };
}
```

- [ ] **Step 3: Update `/health` and startup flow to read active-account state from the manager**

Replace these sections in `openai.js`:

```js
app.get('/health', (req, res) => {
    const currentConfig = accountManager.getActiveConfig();
    res.json({
        status: 'ok',
        mode: CONFIG_TYPE,
        timestamp: new Date().toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false
        }),
        active_account: currentConfig ? {
            index: currentConfig.index,
            description: currentConfig.description,
            available: currentConfig.runtime.available,
            remaining_percent: currentConfig.runtime.remainingPercent,
            primary_remaining_percent: currentConfig.runtime.primaryRemainingPercent,
            primary_reset_at: currentConfig.runtime.primaryResetAt,
            primary_reset_after_seconds: currentConfig.runtime.primaryResetAfterSeconds,
            secondary_remaining_percent: currentConfig.runtime.secondaryRemainingPercent,
            secondary_reset_at: currentConfig.runtime.secondaryResetAt,
            secondary_reset_after_seconds: currentConfig.runtime.secondaryResetAfterSeconds,
            last_checked_at: currentConfig.runtime.lastCheckedAt,
            reason: currentConfig.runtime.reason
        } : null,
        configs: {
            total: API_CONFIGS.length,
            default: currentConfig ? currentConfig.description : null
        }
    });
});

async function startServer() {
    if (shouldUseQuotaMonitoring(CONFIG_TYPE)) {
        await accountManager.refreshQuotas('startup');
    }

    const currentConfig = accountManager.ensureActiveConfig('startup');
    accountManager.startQuotaMonitor();

    app.listen(PORT, () => {
        log(`  - 当前额度: ${accountManager.getRuntimeSummary(currentConfig)}`);
        if (shouldUseQuotaMonitoring(CONFIG_TYPE)) {
            log('  - 初始化账号额度:');
            for (const config of API_CONFIGS) {
                log(`    ${getAccountLabel(config)} | ${accountManager.getRuntimeSummary(config)}`);
            }
        }
    });
}
```

- [ ] **Step 4: Run the new unit tests after the integration refactor**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: PASS with all tests still green.

- [ ] **Step 5: Commit the wiring changes**

```bash
git add openai.js app/account-manager.js test/account-manager.test.js
git commit -m "refactor: wire openai entrypoint to account manager"
```

## Task 4: Run Regression Checks And Finish

**Files:**
- Verify: `test/account-manager.test.js`
- Verify: `test/run.test.js`
- Verify: `run.js`

- [ ] **Step 1: Run the unit tests for account manager**

Run:

```bash
node --test test/account-manager.test.js
```

Expected: PASS.

- [ ] **Step 2: Run the existing run.js regression tests**

Run:

```bash
node --test test/run.test.js
```

Expected: PASS.

- [ ] **Step 3: Run shell syntax verification**

Run:

```bash
node --check run.js
```

Expected: no output, exit code `0`.

- [ ] **Step 4: Inspect the final diff to confirm the refactor stayed in scope**

Run:

```bash
git diff -- app/account-manager.js openai.js test/account-manager.test.js
```

Expected: only account-manager extraction, openai wiring, and tests; no routing or protocol changes.

- [ ] **Step 5: Commit the verified refactor**

```bash
git add app/account-manager.js openai.js test/account-manager.test.js
git commit -m "refactor: extract quota polling and account selection"
```

## Self-Review

- Spec coverage: Task 1 locks behavior with tests, Task 2 creates the new module, Task 3 rewires `openai.js`, Task 4 runs the required regressions.
- Placeholder scan: no `TODO`/`TBD` placeholders remain; all tasks name exact files and commands.
- Type consistency: plan consistently uses `createAccountManager`, `refreshQuotas`, `ensureActiveConfig`, `getActiveConfig`, `getRuntimeSummary`, and `evaluateQuotaPayload`.
