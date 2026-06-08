const CHATGPT_BASE_URL = 'https://chatgpt.com';
const CODEX_API_BASE_PATH = '/backend-api/codex';
const DEFAULT_CLAUDE_CODE_MODEL = 'gpt-5.4';
const DEFAULT_CLAUDE_CODE_REASONING_EFFORT = 'high';
const SUPPORTED_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const SUPPORTED_APIKEY_CAPABILITIES = new Set(['gpt', 'claude']);

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
        reason: 'apikey',
        lastError: null
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
        if (configType !== 'token' && configType !== 'apikey') {
            throw new Error(`配置文件 ${fieldName}[${index}] type 仅支持 token 或 apikey`);
        }

        if (configType === 'apikey') {
            try {
                normalizeApiKeySupport(config.support);
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
    const apikey = normalizeString(config && config.apikey);
    const baseUrl = normalizeString(config && config.base_url).replace(/\/+$/, '');

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
        description: config.description || `APIKey 配置 #${index + 1}`,
        runtime: createDefaultApiKeyRuntime()
    };
}

function createRuntimeConfigs(parsed) {
    return parsed.configs.map((config, index) => {
        const configType = getConfigItemType(config);

        if (configType === 'apikey') {
            return createApiKeyRuntimeConfig(config, index);
        }

        return createTokenRuntimeConfig(config, index);
    });
}

function buildAuthHeadersForConfig(config) {
    if (config.type === 'apikey') {
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
    resolveResponsesOptions,
    createRuntimeConfigs,
    createTokenRuntimeConfig,
    createApiKeyRuntimeConfig,
    getConfigItemType,
    normalizeApiKeySupport,
    configSupportsCapability,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
};
