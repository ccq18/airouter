const CHATGPT_BASE_URL = 'https://chatgpt.com';
const CODEX_API_BASE_PATH = '/backend-api/codex';
const CLAUDE_API_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_CLAUDE_CODE_MODEL = 'gpt-5.5';
const DEFAULT_CLAUDE_CODE_REASONING_EFFORT = 'high';
const SUPPORTED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SUPPORTED_APIKEY_CAPABILITIES = new Set(['gpt', 'claude']);
const SUPPORTED_CONFIG_TYPES = new Set(['token', 'apikey', 'claude_token']);
const {
    buildSub2ApiAuthHeaders,
    isSub2ApiConfig,
    normalizeSub2ApiCredentials,
} = require('./sub2api-agent-identity');

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

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
        lastError: null,
        unavailableUntil: null
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
        reason: 'apikey',
        lastError: null
    };
}

function createDefaultClaudeTokenRuntime(isEnabled) {
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
        reason: isEnabled ? 'claude_token' : 'missing_credentials',
        lastError: null,
        unavailableUntil: null
    };
}

function normalizeString(value) {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (value === null || typeof value === 'undefined') {
        return '';
    }

    return String(value).trim();
}

function getFirstNormalizedString(source, keys) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return '';
    }

    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            const normalized = normalizeString(source[key]);
            if (normalized) {
                return normalized;
            }
        }
    }

    return '';
}

function normalizeSha256HexArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }

    return values
        .map(normalizeString)
        .map(value => value.toLowerCase())
        .filter(value => /^[0-9a-f]{64}$/.test(value));
}

function getConfigItemType(config) {
    const type = normalizeString(config && config.type);
    return type || 'token';
}

function normalizeApiKeySupport(value) {
    if (typeof value === 'undefined' || value === null) {
        return ['gpt'];
    }

    if (!Array.isArray(value)) {
        throw new Error('apikey support 必须是字符串数组');
    }

    const support = [];
    for (const item of value) {
        const capability = normalizeString(item).toLowerCase();
        if (!SUPPORTED_APIKEY_CAPABILITIES.has(capability)) {
            throw new Error('apikey support 仅支持 gpt 或 claude');
        }

        if (!support.includes(capability)) {
            support.push(capability);
        }
    }

    if (support.length === 0) {
        throw new Error('apikey support 至少需要包含 gpt 或 claude');
    }

    return support;
}

function normalizeApiKeyHealth(value) {
    if (typeof value === 'undefined' || value === null) {
        return {};
    }

    if (!isPlainObject(value)) {
        throw new Error('apikey health 必须是对象');
    }

    const health = {};
    if (Object.prototype.hasOwnProperty.call(value, 'model')) {
        const model = normalizeString(value.model);
        if (!model) {
            throw new Error('apikey health.model 必须是非空字符串');
        }

        health.model = model;
    }

    return health;
}

function configSupportsCapability(config, capability) {
    if (!config || config.type !== 'apikey') {
        return false;
    }

    return normalizeApiKeySupport(config.support).includes(capability);
}

function parseOpenAiConfigFile(raw) {
    const parsed = JSON.parse(raw);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('配置文件必须是包含 configs 的对象');
    }

    if (!Array.isArray(parsed.configs)) {
        throw new Error('配置文件 configs 必须是数组');
    }

    validateConfigItemArray(parsed.configs, 'configs');

    if (parsed.disabled_configs !== undefined) {
        if (!Array.isArray(parsed.disabled_configs)) {
            throw new Error('配置文件 disabled_configs 必须是数组');
        }

        validateConfigItemArray(parsed.disabled_configs, 'disabled_configs');
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

    for (const fieldName of ['port', 'proxy_port']) {
        if (parsed[fieldName] === undefined) {
            continue;
        }

        const rawPort = parsed[fieldName];
        const normalizedPort = typeof rawPort === 'number' ? String(rawPort) : rawPort;
        if (typeof normalizedPort !== 'string' || !/^\d+$/.test(normalizedPort.trim())) {
            throw new Error(`配置文件 ${fieldName} 必须是 1-65535 之间的端口号`);
        }

        const port = Number.parseInt(normalizedPort.trim(), 10);
        if (port < 1 || port > 65535) {
            throw new Error(`配置文件 ${fieldName} 必须是 1-65535 之间的端口号`);
        }
    }

    if (parsed.claude_code !== undefined) {
        if (!isPlainObject(parsed.claude_code)) {
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

    if (parsed.responses !== undefined) {
        if (!isPlainObject(parsed.responses)) {
            throw new Error('配置文件 responses 必须是对象');
        }

        if (parsed.responses.model_aliases !== undefined) {
            if (!isPlainObject(parsed.responses.model_aliases)) {
                throw new Error('配置文件 responses.model_aliases 必须是对象');
            }

            for (const [sourceModel, targetModel] of Object.entries(parsed.responses.model_aliases)) {
                if (typeof sourceModel !== 'string' || sourceModel.trim().length === 0) {
                    throw new Error('配置文件 responses.model_aliases 的键必须是非空字符串');
                }

                if (typeof targetModel !== 'string' || targetModel.trim().length === 0) {
                    throw new Error('配置文件 responses.model_aliases 的值必须是非空字符串');
                }
            }
        }
    }

    return parsed;
}

function validateConfigItemArray(configs, fieldName) {
    for (const [index, config] of configs.entries()) {
        if (!isPlainObject(config)) {
            throw new Error(`配置文件 ${fieldName}[${index}] 必须是对象`);
        }

        const configType = getConfigItemType(config);
        if (!SUPPORTED_CONFIG_TYPES.has(configType)) {
            throw new Error(`配置文件 ${fieldName}[${index}] type 仅支持 token、apikey 或 claude_token`);
        }

        if (configType === 'apikey') {
            try {
                normalizeApiKeySupport(config.support);
                normalizeApiKeyHealth(config.health);
            } catch (err) {
                throw new Error(`配置文件 ${fieldName}[${index}] ${err.message}`);
            }
        }

        if (configType === 'token' && normalizeString(config.subtype)) {
            if (!isSub2ApiConfig(config)) {
                throw new Error(`配置文件 ${fieldName}[${index}] token subtype 仅支持 sub2api`);
            }

            try {
                normalizeSub2ApiCredentials(config.credentials);
            } catch (err) {
                throw new Error(`配置文件 ${fieldName}[${index}] ${err.message}`);
            }
        }
    }
}

function resolveClaudeCodeOptions(parsed) {
    const claudeCode = parsed && isPlainObject(parsed.claude_code)
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

function resolveResponsesOptions(parsed) {
    const responses = parsed && isPlainObject(parsed.responses)
        ? parsed.responses
        : {};
    const modelAliases = {};

    if (isPlainObject(responses.model_aliases)) {
        for (const [sourceModel, targetModel] of Object.entries(responses.model_aliases)) {
            modelAliases[sourceModel.trim().toLowerCase()] = targetModel.trim();
        }
    }

    return {
        modelAliases
    };
}

function createTokenRuntimeConfig(config, index) {
    if (isSub2ApiConfig(config)) {
        const credentials = normalizeSub2ApiCredentials(config.credentials);
        const enabled = Boolean(
            credentials.agent_runtime_id &&
            credentials.agent_private_key &&
            credentials.chatgpt_account_id &&
            credentials.chatgpt_user_id
        );

        return {
            type: 'token',
            subtype: 'sub2api',
            index,
            baseUrl: CHATGPT_BASE_URL,
            apiBasePath: CODEX_API_BASE_PATH,
            access_token: '',
            refresh_token: '',
            client_id: '',
            account_id: credentials.chatgpt_account_id,
            credentials,
            description: config.description || credentials.email || `Sub2API 配置 #${index + 1}`,
            runtime: createDefaultTokenRuntime(enabled)
        };
    }

    const enabled = Boolean(config.access_token && config.account_id);

    return {
        type: 'token',
        index,
        baseUrl: CHATGPT_BASE_URL,
        apiBasePath: CODEX_API_BASE_PATH,
        access_token: config.access_token || '',
        refresh_token: config.refresh_token || '',
        client_id: config.client_id || '',
        account_id: config.account_id || '',
        description: config.description || `OpenAI 配置 #${index + 1}`,
        runtime: createDefaultTokenRuntime(enabled)
    };
}

function createApiKeyRuntimeConfig(config, index) {
    const apikey = getFirstNormalizedString(config, ['apikey', 'apiKey', 'api_key']);
    const baseUrl = getFirstNormalizedString(config, ['base_url', 'baseUrl', 'baseURL']).replace(/\/+$/, '');

    if (!apikey || !baseUrl) {
        throw new Error('apikey 配置至少需要 apikey 和 base_url');
    }

    return {
        type: 'apikey',
        index,
        baseUrl,
        apiBasePath: '',
        apiKey: apikey,
        support: normalizeApiKeySupport(config.support),
        health: normalizeApiKeyHealth(config.health),
        description: config.description || `APIKey 配置 #${index + 1}`,
        runtime: createDefaultApiKeyRuntime()
    };
}

function createClaudeTokenRuntimeConfig(config, index) {
    const accessToken = normalizeString(config && config.access_token);
    const refreshToken = normalizeString(config && config.refresh_token);
    const baseUrl = (normalizeString(config && config.base_url) || CLAUDE_API_BASE_URL).replace(/\/+$/, '');
    const localAuthToken = normalizeString(config && config.local_auth_token);
    const requestAuthTokenSha256s = normalizeSha256HexArray(config && config.request_auth_token_sha256s);
    const accountUuid = normalizeString(config && config.account_uuid);
    const organizationUuid = normalizeString(config && config.organization_uuid);
    const expiresAtText = normalizeString(config && config.expires_at);
    const expiresAt = expiresAtText && /^\d+$/.test(expiresAtText)
        ? Number.parseInt(expiresAtText, 10)
        : null;

    if (!accessToken) {
        throw new Error('claude_token 配置至少需要 access_token');
    }

    return {
        type: 'claude_token',
        index,
        baseUrl,
        apiBasePath: '',
        access_token: accessToken,
        refresh_token: refreshToken,
        local_auth_token: localAuthToken,
        request_auth_token_sha256s: requestAuthTokenSha256s,
        account_uuid: accountUuid,
        organization_uuid: organizationUuid,
        expires_at: expiresAt,
        description: config.description || `Claude OAuth 配置 #${index + 1}`,
        runtime: createDefaultClaudeTokenRuntime(Boolean(accessToken))
    };
}

function createRuntimeConfigs(parsed) {
    return parsed.configs.map((config, index) => {
        const configType = getConfigItemType(config);

        if (configType === 'apikey') {
            return createApiKeyRuntimeConfig(config, index);
        }

        if (configType === 'claude_token') {
            return createClaudeTokenRuntimeConfig(config, index);
        }

        return createTokenRuntimeConfig(config, index);
    });
}

function buildAuthHeadersForConfig(config, options = {}) {
    if (config.type === 'apikey') {
        return {
            authorization: `Bearer ${config.apiKey}`
        };
    }

    if (config.type === 'claude_token') {
        return {
            authorization: `Bearer ${config.access_token}`
        };
    }

    if (isSub2ApiConfig(config)) {
        return buildSub2ApiAuthHeaders(config, options);
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
    CLAUDE_API_BASE_URL,
    DEFAULT_CLAUDE_CODE_MODEL,
    DEFAULT_CLAUDE_CODE_REASONING_EFFORT,
    parseOpenAiConfigFile,
    resolveClaudeCodeOptions,
    resolveResponsesOptions,
    createRuntimeConfigs,
    createTokenRuntimeConfig,
    createApiKeyRuntimeConfig,
    createClaudeTokenRuntimeConfig,
    getConfigItemType,
    normalizeApiKeySupport,
    normalizeApiKeyHealth,
    configSupportsCapability,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
};
