const CHATGPT_BASE_URL = 'https://chatgpt.com';
const CODEX_API_BASE_PATH = '/backend-api/codex';
const DEFAULT_CLAUDE_CODE_MODEL = 'gpt-5.4';
const DEFAULT_CLAUDE_CODE_REASONING_EFFORT = 'high';
const SUPPORTED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);

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

    if (!Array.isArray(parsed.configs)) {
        throw new Error('配置文件 configs 必须是数组');
    }

    if (parsed.apikeys !== undefined) {
        if (!Array.isArray(parsed.apikeys)) {
            throw new Error('配置文件 apikeys 必须是字符串数组');
        }

        if (parsed.apikeys.some(item => typeof item !== 'string')) {
            throw new Error('配置文件 apikeys 必须是字符串数组');
        }
    }

    if (parsed.auth_token !== undefined && typeof parsed.auth_token !== 'string') {
        throw new Error('配置文件 auth_token 必须是字符串');
    }

    if (parsed.claude_code !== undefined) {
        if (!parsed.claude_code || typeof parsed.claude_code !== 'object' || Array.isArray(parsed.claude_code)) {
            throw new Error('配置文件 claude_code 必须是对象');
        }

        if (
            parsed.claude_code.model !== undefined &&
            (typeof parsed.claude_code.model !== 'string' || parsed.claude_code.model.trim().length === 0)
        ) {
            throw new Error('配置文件 claude_code.model 必须是非空字符串');
        }

        if (parsed.claude_code.reasoning_effort !== undefined) {
            if (
                typeof parsed.claude_code.reasoning_effort !== 'string' ||
                !SUPPORTED_REASONING_EFFORTS.has(parsed.claude_code.reasoning_effort)
            ) {
                throw new Error('配置文件 claude_code.reasoning_effort 仅支持 none、minimal、low、medium、high、xhigh');
            }
        }
    }

    return parsed;
}

function resolveClaudeCodeOptions(parsed) {
    const claudeCode = parsed && parsed.claude_code && typeof parsed.claude_code === 'object'
        ? parsed.claude_code
        : {};

    return {
        model: typeof claudeCode.model === 'string' && claudeCode.model.trim().length > 0
            ? claudeCode.model.trim()
            : DEFAULT_CLAUDE_CODE_MODEL,
        reasoningEffort: typeof claudeCode.reasoning_effort === 'string' && claudeCode.reasoning_effort.length > 0
            ? claudeCode.reasoning_effort
            : DEFAULT_CLAUDE_CODE_REASONING_EFFORT
    };
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
        return parsed.configs.map((config, index) => createApiKeyRuntimeConfig(config, index));
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
    DEFAULT_CLAUDE_CODE_MODEL,
    DEFAULT_CLAUDE_CODE_REASONING_EFFORT,
    parseOpenAiConfigFile,
    resolveClaudeCodeOptions,
    createRuntimeConfigs,
    createTokenRuntimeConfig,
    createApiKeyRuntimeConfig,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
};
