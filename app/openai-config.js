const CHATGPT_BASE_URL = 'https://chatgpt.com';
const CODEX_API_BASE_PATH = '/backend-api/codex';

function createDefaultTokenRuntime(isEnabled) {
    return {
        enabled: isEnabled,
        available: isEnabled,
        lastCheckedAt: null,
        remainingPercent: null,
        primaryRemainingPercent: null,
        primaryResetAt: null,
        primaryResetAfterSeconds: null,
        secondaryRemainingPercent: null,
        secondaryResetAt: null,
        secondaryResetAfterSeconds: null,
        reason: isEnabled ? 'unchecked' : 'missing_credentials',
        lastError: null
    };
}

function createDefaultApiKeyRuntime() {
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
        reason: 'api_key',
        lastError: null
    };
}

function parseOpenAiConfigFile(raw) {
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('配置文件必须是包含 type 和 configs 的对象');
    }

    if (parsed.type !== 'token' && parsed.type !== 'api_key') {
        throw new Error('配置文件 type 仅支持 token 或 api_key');
    }

    if (!Array.isArray(parsed.configs) || parsed.configs.length === 0) {
        throw new Error('配置文件 configs 必须是非空数组');
    }

    return parsed;
}

function createTokenRuntimeConfig(config, index) {
    const enabled = Boolean(config.access_token && config.account_id);

    return {
        type: 'token',
        index,
        baseUrl: CHATGPT_BASE_URL,
        apiBasePath: CODEX_API_BASE_PATH,
        access_token: config.access_token || '',
        account_id: config.account_id || '',
        description: config.description || `OpenAI 配置 #${index + 1}`,
        runtime: createDefaultTokenRuntime(enabled)
    };
}

function createApiKeyRuntimeConfig(config, index) {
    if (!config || !config.api_key || !config.base_url) {
        throw new Error('api_key 配置至少需要 api_key 和 base_url');
    }

    return {
        type: 'api_key',
        index,
        baseUrl: String(config.base_url).replace(/\/+$/, ''),
        apiBasePath: '',
        apiKey: config.api_key,
        description: config.description || `OpenAI APIKey 配置 #${index + 1}`,
        runtime: createDefaultApiKeyRuntime()
    };
}

function createRuntimeConfigs(parsed) {
    if (parsed.type === 'api_key') {
        return [createApiKeyRuntimeConfig(parsed.configs[0], 0)];
    }

    return parsed.configs.map((config, index) => createTokenRuntimeConfig(config, index));
}

function buildAuthHeadersForConfig(config) {
    if (config.type === 'api_key') {
        return {
            authorization: `Bearer ${config.apiKey}`
        };
    }

    return {
        authorization: `Bearer ${config.access_token}`,
        'chatgpt-account-id': config.account_id
    };
}

function shouldUseQuotaMonitoring(type) {
    return type === 'token';
}

module.exports = {
    CHATGPT_BASE_URL,
    CODEX_API_BASE_PATH,
    parseOpenAiConfigFile,
    createRuntimeConfigs,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
};
