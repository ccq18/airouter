const { isFreePool, FREE_MODEL, credentialSource, validateFreePools } = require('./free-pool-config');
const { getProviderPreset, normalizeSub2ApiBaseUrl } = require('./provider-presets');
const CHATGPT_BASE_URL = 'https://chatgpt.com';
const CODEX_API_BASE_PATH = '/backend-api/codex';
const CLAUDE_API_BASE_URL = 'https://api.anthropic.com';
const SUPPORTED_CONFIG_TYPES = new Set(['token', 'apikey', 'claude_token']);
const {
    buildSub2ApiAuthHeaders,
    isSub2ApiConfig,
    normalizeSub2ApiCredentials,
} = require('./sub2api-agent-identity');

const {
    validateConfigModels,
    parseRoutingConfig,
    validateIdentifier,
} = require('./routing-config');

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
    return type;
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
    validateFreePools(parsed.configs);
    for (const config of parsed.configs) if (isFreePool(config)) config.models = [{ ...FREE_MODEL }];

    for (const removedField of ['type', 'disabled_configs', 'responses', 'claude_code']) {
        if (Object.prototype.hasOwnProperty.call(parsed, removedField)) {
            throw new Error(`配置文件不再支持 ${removedField}，请使用统一账号与模型路由配置`);
        }
    }

    const configIds = new Set();
    for (const [index, config] of parsed.configs.entries()) {
        if (typeof config.id === 'string' && config.id.trim()) {
            const id = config.id.trim();
            if (configIds.has(id)) {
                throw new Error(`配置文件 configs[] 的 id 重复: ${id}`);
            }
            configIds.add(id);
        }
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

    if (parsed.routing !== undefined) {
        if (!isPlainObject(parsed.routing)) {
            throw new Error('配置文件 routing 必须是对象');
        }

        parseRoutingConfig(parsed);
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

        if (config.id !== undefined) {
            try {
                validateIdentifier(config.id, `配置文件 ${fieldName}[${index}].id`);
            } catch (err) {
                throw new Error(err.message);
            }
        }

        if (config.preset !== undefined) {
            if (typeof config.preset !== 'string' || config.preset.trim().length === 0) {
                throw new Error(`配置文件 ${fieldName}[${index}].preset 必须是非空字符串`);
            }
        }

        if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
            throw new Error(`配置文件 ${fieldName}[${index}].enabled 必须是布尔值`);
        }

        if (config.models !== undefined) {
            try {
                validateConfigModels(config.models, { preset: config.preset });
            } catch (err) {
                throw new Error(`配置文件 ${fieldName}[${index}] ${err.message}`);
            }
        }

        if (config.models_endpoint !== undefined && typeof config.models_endpoint !== 'string') {
            throw new Error(`配置文件 ${fieldName}[${index}].models_endpoint 必须是字符串`);
        }

        if (config.protocol_paths !== undefined) {
            if (!isPlainObject(config.protocol_paths)) {
                throw new Error(`配置文件 ${fieldName}[${index}].protocol_paths 必须是对象`);
            }

            for (const [protocol, path] of Object.entries(config.protocol_paths)) {
                if (!['chat_completions', 'responses', 'messages'].includes(protocol)) {
                    throw new Error(`配置文件 ${fieldName}[${index}].protocol_paths 包含不支持的协议`);
                }
                if (path !== null && typeof path !== 'string') {
                    throw new Error(`配置文件 ${fieldName}[${index}].protocol_paths.${protocol} 必须是字符串或 null`);
                }
            }
        }

        for (const removedField of ['support', 'health', 'apiKey', 'api_key', 'baseUrl', 'baseURL']) {
            if (Object.prototype.hasOwnProperty.call(config, removedField)) {
                throw new Error(`配置文件 ${fieldName}[${index}] 不再支持 ${removedField}`);
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

function createTokenRuntimeConfig(config, index) {
    if (isSub2ApiConfig(config)) {
        const credentials = normalizeSub2ApiCredentials(config.credentials);
        const enabled = Boolean(
            credentials.agent_runtime_id &&
            credentials.agent_private_key &&
            credentials.chatgpt_account_id &&
            credentials.chatgpt_user_id
        ) && config.enabled !== false;

        return {
            type: 'token',
            subtype: 'sub2api',
            index,
            id: normalizeString(config.id),
            preset: normalizeString(config.preset) || 'chatgpt',
            enabled: config.enabled !== false,
            baseUrl: CHATGPT_BASE_URL,
            apiBasePath: CODEX_API_BASE_PATH,
            access_token: '',
            refresh_token: '',
            client_id: '',
            account_id: credentials.chatgpt_account_id,
            credentials,
            models: Array.isArray(config.models) ? config.models : [],
            description: config.description || credentials.email || `Sub2API 配置 #${index + 1}`,
            runtime: createDefaultTokenRuntime(enabled)
        };
    }

    const enabled = Boolean(config.access_token && config.account_id) && config.enabled !== false;
    const baseUrl = normalizeString(config.base_url) || CHATGPT_BASE_URL;
    const apiBasePath = normalizeString(config.api_base_path) ||
        (baseUrl === CHATGPT_BASE_URL ? CODEX_API_BASE_PATH : '');

    return {
        type: 'token',
        index,
        id: normalizeString(config.id),
        preset: normalizeString(config.preset) || 'chatgpt',
        enabled: config.enabled !== false,
        baseUrl,
        apiBasePath,
        access_token: config.access_token || '',
        refresh_token: config.refresh_token || '',
        client_id: config.client_id || '',
        account_id: config.account_id || '',
        models: Array.isArray(config.models) ? config.models : [],
        description: config.description || `OpenAI 配置 #${index + 1}`,
        runtime: createDefaultTokenRuntime(enabled)
    };
}

function createApiKeyRuntimeConfig(config, index) {
    const apikey = normalizeString(config.apikey);
    const baseUrl = config.preset === 'sub2api' ? normalizeSub2ApiBaseUrl(config.base_url) : normalizeString(config.base_url).replace(/\/+$/, '');

    if (!apikey || !baseUrl) {
        throw new Error('apikey 配置至少需要 apikey 和 base_url');
    }

    const enabled = config.enabled !== false;
    const runtime = createDefaultApiKeyRuntime();
    if (!enabled) {
        runtime.enabled = false;
        runtime.available = false;
        runtime.reason = 'disabled';
    }

    return {
        type: 'apikey',
        index,
        id: normalizeString(config.id),
        preset: normalizeString(config.preset) || 'custom',
        enabled,
        baseUrl,
        apiBasePath: '',
        apiKey: apikey,
        models: Array.isArray(config.models) ? config.models : [],
        models_endpoint: normalizeString(config.models_endpoint),
        protocol_paths: isPlainObject(config.protocol_paths) ? { ...config.protocol_paths } : {},
        description: config.description || `APIKey 配置 #${index + 1}`,
        runtime
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
        id: normalizeString(config.id),
        preset: normalizeString(config.preset) || 'claude',
        enabled: config.enabled !== false,
        baseUrl,
        apiBasePath: '',
        access_token: accessToken,
        refresh_token: refreshToken,
        local_auth_token: localAuthToken,
        request_auth_token_sha256s: requestAuthTokenSha256s,
        account_uuid: accountUuid,
        organization_uuid: organizationUuid,
        expires_at: expiresAt,
        models: Array.isArray(config.models) ? config.models : [],
        description: config.description || `Claude OAuth 配置 #${index + 1}`,
        runtime: createDefaultClaudeTokenRuntime(Boolean(accessToken) && config.enabled !== false)
    };
}

function createRuntimeConfigs(parsed) {
    validateFreePools(parsed.configs);
    return parsed.configs.map((config, index) => {
        if (isFreePool(config)) {
            const source = credentialSource(config, parsed.configs);
            const sourcePreset = config.preset === 'openrouter-free' ? 'openrouter' : (source.preset === 'opencode-zen' ? 'opencode-zen' : 'opencode-go');
            const defaultBase = getProviderPreset(sourcePreset).default_base_url;
            const configuredBase = config.base_url;
            const builtinBase = ['https://opencode.ai/inference', 'https://opencode.ai/inference/go', 'https://openrouter.ai/api/v1'];
            const effective = { ...config, models: [{ ...FREE_MODEL }], apikey: source.apikey,
                enabled: config.enabled !== false && source.enabled !== false,
                base_url: !configuredBase || builtinBase.includes(configuredBase) ? defaultBase : configuredBase };
            return { ...createApiKeyRuntimeConfig(effective, index), poolSourcePreset: sourcePreset, credential_ref: config.credential_ref || null };
        }
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
    parseOpenAiConfigFile,
    createRuntimeConfigs,
    createTokenRuntimeConfig,
    createApiKeyRuntimeConfig,
    createClaudeTokenRuntimeConfig,
    getConfigItemType,
    buildAuthHeadersForConfig,
    shouldUseQuotaMonitoring
};
