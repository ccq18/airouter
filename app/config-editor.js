const fs = require('node:fs');
const {
    parseOpenAiConfigFile,
    createRuntimeConfigs,
    getConfigItemType,
} = require('./openai-config');
const {
    isSub2ApiConfig,
    isSub2ApiExportItem,
    normalizeSub2ApiCredentials,
} = require('./sub2api-agent-identity');
const {
    ensureConfigIds,
    createConfigId,
    isPlainObject,
    parseRoutingConfig,
    validateConfigModels,
} = require('./routing-config');

class ConfigEditorError extends Error {}

function assertPlainObject(value, message) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigEditorError(message);
    }
}

function normalizeString(value) {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (value === null || typeof value === 'undefined') {
        return '';
    }

    return String(value);
}

function decodeJwtPayload(token) {
    const text = normalizeString(token);
    const parts = text.split('.');

    if (parts.length !== 3) {
        return null;
    }

    try {
        const normalizedPayload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        const paddedPayload = normalizedPayload.padEnd(Math.ceil(normalizedPayload.length / 4) * 4, '=');
        const payload = JSON.parse(Buffer.from(paddedPayload, 'base64').toString('utf8'));

        return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
    } catch (err) {
        return null;
    }
}

function normalizeStringArray(values) {
    if (!Array.isArray(values)) {
        throw new ConfigEditorError('配置设置 apikeys 必须是数组');
    }

    return values
        .map(value => normalizeString(value))
        .filter(Boolean);
}

function normalizePortSetting(value, fieldName, options = {}) {
    if ((value === null || value === undefined || String(value).trim() === '') && options.optional) {
        return null;
    }

    const normalized = typeof value === 'number' ? String(value) : normalizeString(value);
    if (!/^\d+$/.test(normalized)) {
        throw new ConfigEditorError(`配置设置 ${fieldName} 必须是 1-65535 之间的端口号`);
    }

    const port = Number.parseInt(normalized, 10);
    if (port < 1 || port > 65535) {
        throw new ConfigEditorError(`配置设置 ${fieldName} 必须是 1-65535 之间的端口号`);
    }

    return port;
}

function getEditableFields(type) {
    if (type === 'apikey') {
        return ['type', 'id', 'preset', 'apikey', 'base_url', 'description', 'models_endpoint', 'quota_url'];
    }

    if (type === 'token') {
        return ['type', 'id', 'preset', 'subtype', 'access_token', 'refresh_token', 'account_id', 'description', 'base_url', 'api_base_path'];
    }

    if (type === 'claude_token') {
        return ['type', 'id', 'preset', 'access_token', 'refresh_token', 'expires_at', 'account_uuid', 'organization_uuid', 'local_auth_token', 'request_auth_token_sha256s', 'base_url', 'description'];
    }

    throw new ConfigEditorError(`不支持的配置类型: ${type}`);
}

function validateParsedConfig(parsed) {
    try {
        const reparsed = parseOpenAiConfigFile(JSON.stringify(parsed));
        createRuntimeConfigs(reparsed);
        return reparsed;
    } catch (error) {
        throw new ConfigEditorError(error.message);
    }
}

function cloneParsedConfig(parsed) {
    const cloneConfigItem = item => ({
        ...item,
        ...(item && typeof item.credentials === 'object' && !Array.isArray(item.credentials)
            ? { credentials: { ...item.credentials } }
            : {}),
    });
    const cloned = {
        ...parsed,
        configs: parsed.configs.map(cloneConfigItem),
    };

    return cloned;
}

function readParsedConfigFile(configFile, options = {}) {
    const raw = fs.readFileSync(configFile, 'utf8');

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new ConfigEditorError(`配置文件不是合法 JSON: ${err.message}`);
        }

        throw err;
    }

    try {
        return validateParsedConfig(parsed);
    } catch (err) {
        if (err instanceof ConfigEditorError) {
            throw err;
        }

        throw new ConfigEditorError(err.message);
    }
}

function normalizeConfigItem(item, existingItem = {}) {
    assertPlainObject(item, '配置项必须是对象');
    for (const field of ['support', 'health', 'apiKey', 'api_key', 'baseUrl', 'baseURL']) {
        if (Object.prototype.hasOwnProperty.call(item, field)) {
            throw new ConfigEditorError(`配置项不再支持 ${field}`);
        }
    }

    const typeProbe = {
        ...(existingItem && typeof existingItem === 'object' && !Array.isArray(existingItem) ? existingItem : {}),
        ...item,
    };
    const type = getConfigItemType(typeProbe);
    const normalizedItem = item;
    const nextItem = {
        ...(existingItem && typeof existingItem === 'object' && !Array.isArray(existingItem) ? existingItem : {}),
        ...normalizedItem,
    };

    for (const field of getEditableFields(type)) {
        if (!Object.prototype.hasOwnProperty.call(normalizedItem, field)) continue;

        nextItem[field] = normalizeString(normalizedItem[field]);
    }

    {
        if (Object.prototype.hasOwnProperty.call(normalizedItem, 'protocol_paths')) {
            if (normalizedItem.protocol_paths === null) {
                delete nextItem.protocol_paths;
            } else {
                if (!isPlainObject(normalizedItem.protocol_paths)) {
                    throw new ConfigEditorError('配置项 protocol_paths 必须是对象');
                }
                nextItem.protocol_paths = { ...normalizedItem.protocol_paths };
            }
        }

        if (Object.prototype.hasOwnProperty.call(normalizedItem, 'models')) {
            if (normalizedItem.models === null) {
                delete nextItem.models;
            } else {
                if (!Array.isArray(normalizedItem.models)) {
                    throw new ConfigEditorError('配置项 models 必须是数组');
                }
                nextItem.models = normalizedItem.models.map(model => (
                    isPlainObject(model) ? { ...model } : model
                ));
            }
        }

        if (Object.prototype.hasOwnProperty.call(normalizedItem, 'enabled')) {
            nextItem.enabled = normalizedItem.enabled;
        }
    }

    if (!nextItem.id) {
        delete nextItem.id;
    }
    if (!nextItem.preset) {
        delete nextItem.preset;
    }
    if (nextItem.models_endpoint === '') {
        delete nextItem.models_endpoint;
    }
    if (nextItem.quota_url === '') {
        delete nextItem.quota_url;
    }

    nextItem.type = type;

    if (type === 'token' && !nextItem.refresh_token) {
        delete nextItem.refresh_token;
    }

    if (type === 'token' && isSub2ApiConfig(nextItem)) {
        try {
            nextItem.type = 'token';
            nextItem.subtype = 'sub2api';
            nextItem.credentials = normalizeSub2ApiCredentials(nextItem.credentials);
        } catch (err) {
            throw new ConfigEditorError(err.message);
        }
        delete nextItem.access_token;
        delete nextItem.refresh_token;
        delete nextItem.client_id;
        delete nextItem.account_id;
    } else if (type === 'token' && nextItem.subtype) {
        throw new ConfigEditorError('token subtype 仅支持 sub2api');
    } else if (type === 'token') {
        delete nextItem.subtype;
    }

    if (type === 'apikey') {
        const rawApiKey = typeProbe.apikey;
        const rawBaseUrl = typeProbe.base_url;
        nextItem.type = 'apikey';
        nextItem.apikey = normalizeString(rawApiKey);
        nextItem.base_url = normalizeString(rawBaseUrl).replace(/\/+$/, '');
    }

    if (type === 'claude_token') {
        nextItem.type = 'claude_token';
        if (nextItem.base_url) {
            nextItem.base_url = nextItem.base_url.replace(/\/+$/, '');
        } else {
            delete nextItem.base_url;
        }
        if (!nextItem.refresh_token) {
            delete nextItem.refresh_token;
        }
        if (!nextItem.expires_at) {
            delete nextItem.expires_at;
        }
        if (!nextItem.account_uuid) {
            delete nextItem.account_uuid;
        }
        if (!nextItem.organization_uuid) {
            delete nextItem.organization_uuid;
        }
        if (!nextItem.local_auth_token) {
            delete nextItem.local_auth_token;
        }
    }

    return nextItem;
}

function buildImportedConfigItem(typeOrItem, maybeItem) {
    const item = typeof typeOrItem === 'string' ? maybeItem : typeOrItem;
    assertPlainObject(item, '配置项 JSON 必须是对象');

    const type = typeof typeOrItem === 'string'
        ? typeOrItem
        : getConfigItemType(item) || 'token';

    if (type !== 'token') {
        return normalizeConfigItem({
            ...item,
            type
        });
    }

    if (isSub2ApiExportItem(item)) {
        const credentials = item.credentials && typeof item.credentials === 'object' && !Array.isArray(item.credentials)
            ? item.credentials
            : {};
        const extra = item.extra && typeof item.extra === 'object' && !Array.isArray(item.extra)
            ? item.extra
            : {};
        let normalizedCredentials;
        try {
            normalizedCredentials = normalizeSub2ApiCredentials({
                ...credentials,
                email: credentials.email || extra.email,
                chatgpt_account_id: credentials.chatgpt_account_id || credentials.account_id ||
                    extra.chatgpt_account_id || extra.account_id,
            });
        } catch (err) {
            throw new ConfigEditorError(err.message);
        }
        const imported = {
            type: 'token',
            preset: 'chatgpt',
            subtype: 'sub2api',
            description: normalizeString(item.description) || normalizedCredentials.email ||
                normalizeString(item.name) || normalizedCredentials.chatgpt_account_id,
            credentials: normalizedCredentials,
        };

        for (const field of ['concurrency', 'priority', 'rate_multiplier', 'auto_pause_on_expired']) {
            if (Object.prototype.hasOwnProperty.call(item, field)) {
                imported[field] = item[field];
            }
        }

        return imported;
    }

    const explicitAccessToken = normalizeString(item.access_token);
    const explicitAccountId = normalizeString(item.account_id);
    const explicitDescription = normalizeString(item.description);
    const explicitRefreshToken = normalizeString(item.refresh_token);
    const explicitClientId = normalizeString(item.client_id);
    const credentials = item.credentials && typeof item.credentials === 'object' && !Array.isArray(item.credentials)
        ? item.credentials
        : {};
    const extra = item.extra && typeof item.extra === 'object' && !Array.isArray(item.extra)
        ? item.extra
        : {};
    const credentialAccessToken = normalizeString(credentials.access_token);
    const credentialAccountId = normalizeString(credentials.chatgpt_account_id) ||
        normalizeString(credentials.account_id) ||
        normalizeString(extra.chatgpt_account_id) ||
        normalizeString(extra.account_id);
    const credentialDescription = normalizeString(credentials.email) ||
        normalizeString(extra.email) ||
        normalizeString(item.name);
    const credentialRefreshToken = normalizeString(credentials.refresh_token);
    const credentialClientId = normalizeString(credentials.client_id);
    const sessionAccessToken = normalizeString(item.accessToken);
    const sessionAccountId = normalizeString(item.account && item.account.id);
    const sessionDescription = normalizeString(item.user && item.user.email) || normalizeString(item.email);
    const sessionRefreshToken = normalizeString(item.refreshToken) ||
        normalizeString(item.tokens && item.tokens.refresh_token) ||
        normalizeString(item.tokens && item.tokens.refreshToken);
    const sessionClientId = normalizeString(item.clientId) ||
        normalizeString(item.tokens && item.tokens.client_id) ||
        normalizeString(item.tokens && item.tokens.clientId);

    const accessToken = explicitAccessToken || credentialAccessToken || sessionAccessToken;
    const accountId = explicitAccountId || credentialAccountId || sessionAccountId;
    const description = explicitDescription || credentialDescription || sessionDescription || accountId;
    const refreshToken = explicitRefreshToken || credentialRefreshToken || sessionRefreshToken;
    const decodedAccessToken = decodeJwtPayload(accessToken);
    const decodedIdToken = decodeJwtPayload(item.id_token || credentials.id_token);
    const clientId = explicitClientId || credentialClientId || sessionClientId || normalizeString(decodedAccessToken && decodedAccessToken.client_id) || normalizeString(decodedIdToken && decodedIdToken.client_id);

    if (!accessToken || !accountId) {
        throw new ConfigEditorError('token 模式下请提供 access_token/account_id，或直接粘贴包含 user.email、account.id、accessToken 的 AuthSession JSON');
    }

    const imported = {
        type: 'token',
        preset: 'chatgpt',
        access_token: accessToken,
        account_id: accountId,
        description,
    };

    if (refreshToken) {
        imported.refresh_token = refreshToken;
    }

    if (clientId) {
        imported.client_id = clientId;
    }

    return imported;
}

function getConfigIndex(index, parsed) {
    if (!Number.isInteger(index) || index < 0 || index >= parsed.configs.length) {
        throw new ConfigEditorError('配置项索引不合法');
    }

    return index;
}

function findConfigIndexById(parsed, configId) {
    const id = normalizeString(configId);
    if (!id || !Array.isArray(parsed.configs)) {
        return -1;
    }

    return parsed.configs.findIndex(item => item && item.id === id);
}

function getConfigById(parsed, configId) {
    const index = findConfigIndexById(parsed, configId);
    return index === -1 ? null : parsed.configs[index];
}

function updateConfigItemById(parsed, configId, item) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = findConfigIndexById(nextParsed, configId);
    if (targetIndex === -1) {
        throw new ConfigEditorError('上游账号不存在');
    }

    if (item.id !== undefined && item.id !== configId) {
        throw new ConfigEditorError('上游账号 ID 不可修改');
    }
    nextParsed.configs[targetIndex] = normalizeConfigItem(item, nextParsed.configs[targetIndex]);
    if (Array.isArray(nextParsed.configs[targetIndex].models)) {
        nextParsed.configs[targetIndex].models = validateConfigModels(
            nextParsed.configs[targetIndex].models,
            { preset: nextParsed.configs[targetIndex].preset },
        );
    }
    return validateParsedConfig(nextParsed);
}

function deleteConfigItemById(parsed, configId) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = findConfigIndexById(nextParsed, configId);
    if (targetIndex === -1) {
        throw new ConfigEditorError('上游账号不存在');
    }

    nextParsed.configs.splice(targetIndex, 1);
    return validateParsedConfig(nextParsed);
}

function assignMissingConfigIds(parsed, options = {}) {
    const ensured = ensureConfigIds(parsed, options);
    return validateParsedConfig(ensured.parsed);
}

function normalizeDeleteIndexes(indexes, length, label) {
    if (!Array.isArray(indexes) || indexes.length === 0) {
        throw new ConfigEditorError(`${label}索引不能为空`);
    }

    const normalized = indexes.map(index => {
        if (typeof index === 'number') {
            return index;
        }

        if (typeof index === 'string' && /^\d+$/.test(index.trim())) {
            return Number.parseInt(index.trim(), 10);
        }

        return Number.NaN;
    });
    const seen = new Set();

    for (const index of normalized) {
        if (!Number.isInteger(index) || index < 0 || index >= length) {
            throw new ConfigEditorError(`${label}索引不合法`);
        }

        if (seen.has(index)) {
            throw new ConfigEditorError(`${label}索引重复`);
        }

        seen.add(index);
    }

    return normalized.sort((a, b) => b - a);
}

function addConfigItem(parsed, item) {
    return addConfigItems(parsed, [item]);
}

function addConfigItems(parsed, items) {
    if (!Array.isArray(items) || items.length === 0) {
        throw new ConfigEditorError('配置项数组不能为空');
    }

    const nextParsed = cloneParsedConfig(parsed);
    const existingIds = new Set((nextParsed.configs || []).map(item => item.id).filter(Boolean));
    const normalizedItems = items.map(item => {
        const normalized = normalizeConfigItem(item);
        if (!normalized.id) {
            normalized.id = createConfigId(existingIds);
            existingIds.add(normalized.id);
        }
        return normalized;
    });
    nextParsed.configs.push(...normalizedItems);
    return validateParsedConfig(nextParsed);
}

function updateConfigItem(parsed, index, item) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = getConfigIndex(index, nextParsed);
    nextParsed.configs[targetIndex] = normalizeConfigItem(item, nextParsed.configs[targetIndex]);
    if (Array.isArray(nextParsed.configs[targetIndex].models)) {
        nextParsed.configs[targetIndex].models = validateConfigModels(
            nextParsed.configs[targetIndex].models,
            { preset: nextParsed.configs[targetIndex].preset },
        );
    }
    return validateParsedConfig(nextParsed);
}

function deleteConfigItem(parsed, index) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = getConfigIndex(index, nextParsed);

    nextParsed.configs.splice(targetIndex, 1);
    return validateParsedConfig(nextParsed);
}

function deleteConfigItems(parsed, indexes) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndexes = normalizeDeleteIndexes(indexes, nextParsed.configs.length, '配置项');

    for (const index of targetIndexes) {
        nextParsed.configs.splice(index, 1);
    }

    return validateParsedConfig(nextParsed);
}

function updateConfigSettings(parsed, settings) {
    assertPlainObject(settings, '配置设置必须是对象');
    for (const field of Object.keys(settings)) {
        if (!['apikeys', 'auth_token', 'port', 'proxy_port', 'routing'].includes(field)) {
            throw new ConfigEditorError(`配置设置不支持 ${field}`);
        }
    }

    const nextParsed = cloneParsedConfig(parsed);

    if (Object.prototype.hasOwnProperty.call(settings, 'apikeys')) {
        nextParsed.apikeys = normalizeStringArray(settings.apikeys);
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'auth_token')) {
        nextParsed.auth_token = normalizeString(settings.auth_token);
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'port')) {
        nextParsed.port = normalizePortSetting(settings.port, 'port');
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'proxy_port')) {
        const proxyPort = normalizePortSetting(settings.proxy_port, 'proxy_port', { optional: true });
        if (proxyPort === null) {
            delete nextParsed.proxy_port;
        } else {
            nextParsed.proxy_port = proxyPort;
        }
    }

    if (Object.prototype.hasOwnProperty.call(settings, 'routing')) {
        const nextRouting = settings.routing;
        if (nextRouting === null) {
            delete nextParsed.routing;
        } else {
            if (!nextParsed || typeof nextParsed !== 'object' || Array.isArray(nextParsed)) {
                throw new ConfigEditorError('配置设置 routing 必须是对象');
            }
            if (!nextRouting || typeof nextRouting !== 'object' || Array.isArray(nextRouting)) {
                throw new ConfigEditorError('配置设置 routing 必须是对象');
            }
            nextParsed.routing = JSON.parse(JSON.stringify(nextRouting));
            const normalizedRouting = parseRoutingConfig(nextParsed);
            nextParsed.routing.models = normalizedRouting.models;
        }
    }

    return validateParsedConfig(nextParsed);
}

function updateRoutingModels(parsed, models, options = {}) {
    if (!Array.isArray(models)) {
        throw new ConfigEditorError('routing.models 必须是数组');
    }

    const nextParsed = cloneParsedConfig(parsed);
    const existingRouting = nextParsed.routing && isPlainObject(nextParsed.routing) ? nextParsed.routing : {};
    nextParsed.routing = {
        ...existingRouting,
        models: JSON.parse(JSON.stringify(models)),
    };

    if (options.maxAttempts !== undefined) {
        nextParsed.routing.max_attempts = options.maxAttempts;
    }

    const normalizedRouting = parseRoutingConfig(nextParsed);
    nextParsed.routing.models = normalizedRouting.models;
    return validateParsedConfig(nextParsed);
}

function writeParsedConfigFile(configFile, parsed, options = {}) {
    const validated = validateParsedConfig(parsed);
    const tempFile = `${configFile}.tmp`;

    fs.writeFileSync(tempFile, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(tempFile, 0o600);
    fs.renameSync(tempFile, configFile);

    return validated;
}

module.exports = {
    ConfigEditorError,
    addConfigItem,
    addConfigItems,
    buildImportedConfigItem,
    updateConfigItem,
    updateConfigSettings,
    deleteConfigItem,
    deleteConfigItems,
    deleteConfigItemById,
    findConfigIndexById,
    getConfigById,
    updateConfigItemById,
    assignMissingConfigIds,
    updateRoutingModels,
    readParsedConfigFile,
    writeParsedConfigFile,
};
