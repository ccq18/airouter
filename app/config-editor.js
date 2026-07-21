const fs = require('node:fs');
const {
    parseOpenAiConfigFile,
    createRuntimeConfigs,
    getConfigItemType,
    normalizeApiKeySupport,
} = require('./openai-config');
const {
    isSub2ApiConfig,
    isSub2ApiExportItem,
    normalizeSub2ApiCredentials,
} = require('./sub2api-agent-identity');

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

function getFirstObjectValue(source, keys) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return undefined;
    }

    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            return source[key];
        }
    }

    return undefined;
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

function hasOwnField(value, field) {
    return Object.prototype.hasOwnProperty.call(value, field);
}

function normalizeApiKeyConfigAliases(item) {
    const normalized = { ...item };

    if (!hasOwnField(normalized, 'apikey')) {
        if (hasOwnField(normalized, 'apiKey')) {
            normalized.apikey = normalized.apiKey;
        } else if (hasOwnField(normalized, 'api_key')) {
            normalized.apikey = normalized.api_key;
        }
    }

    if (!hasOwnField(normalized, 'base_url')) {
        if (hasOwnField(normalized, 'baseUrl')) {
            normalized.base_url = normalized.baseUrl;
        } else if (hasOwnField(normalized, 'baseURL')) {
            normalized.base_url = normalized.baseURL;
        }
    }

    delete normalized.apiKey;
    delete normalized.api_key;
    delete normalized.baseUrl;
    delete normalized.baseURL;

    return normalized;
}

function normalizeResponsesModelAliases(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new ConfigEditorError('配置设置 responses.model_aliases 必须是对象');
    }

    const normalized = {};

    for (const [sourceModel, targetModel] of Object.entries(value)) {
        const normalizedSource = normalizeString(sourceModel);
        const normalizedTarget = normalizeString(targetModel);

        if (!normalizedSource) {
            throw new ConfigEditorError('配置设置 responses.model_aliases 的键必须是非空字符串');
        }

        if (!normalizedTarget) {
            throw new ConfigEditorError('配置设置 responses.model_aliases 的值必须是非空字符串');
        }

        normalized[normalizedSource] = normalizedTarget;
    }

    return normalized;
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
        return ['type', 'apikey', 'base_url', 'description', 'support'];
    }

    if (type === 'token') {
        return ['type', 'subtype', 'access_token', 'refresh_token', 'account_id', 'description'];
    }

    if (type === 'claude_token') {
        return ['type', 'access_token', 'refresh_token', 'expires_at', 'account_uuid', 'organization_uuid', 'local_auth_token', 'request_auth_token_sha256s', 'base_url', 'description'];
    }

    throw new ConfigEditorError(`不支持的配置类型: ${type}`);
}

function validateParsedConfig(parsed) {
    const reparsed = parseOpenAiConfigFile(JSON.stringify(parsed));
    createRuntimeConfigs(reparsed);
    return reparsed;
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

    if (Array.isArray(parsed.disabled_configs)) {
        cloned.disabled_configs = parsed.disabled_configs.map(cloneConfigItem);
    }

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

    if (options.validate === false) {
        return parsed;
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

    const typeProbe = {
        ...(existingItem && typeof existingItem === 'object' && !Array.isArray(existingItem) ? existingItem : {}),
        ...item,
    };
    const type = getConfigItemType(typeProbe);
    const normalizedItem = type === 'apikey' ? normalizeApiKeyConfigAliases(item) : item;
    const nextItem = {
        ...(existingItem && typeof existingItem === 'object' && !Array.isArray(existingItem) ? existingItem : {}),
        ...normalizedItem,
    };

    for (const field of getEditableFields(type)) {
        if (field === 'support') {
            continue;
        }

        if (field === 'subtype' && !Object.prototype.hasOwnProperty.call(normalizedItem, field)) {
            continue;
        }

        nextItem[field] = normalizeString(normalizedItem[field]);
    }

    if (type === 'token' && !nextItem.type) {
        delete nextItem.type;
    }

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
        const rawApiKey = getFirstObjectValue(item, ['apikey', 'apiKey', 'api_key']);
        const rawBaseUrl = getFirstObjectValue(item, ['base_url', 'baseUrl', 'baseURL']);
        nextItem.type = 'apikey';
        nextItem.apikey = normalizeString(rawApiKey);
        nextItem.base_url = normalizeString(rawBaseUrl).replace(/\/+$/, '');
        if (Object.prototype.hasOwnProperty.call(item, 'support')) {
            nextItem.support = normalizeApiKeySupport(item.support);
        }
        delete nextItem.apiKey;
        delete nextItem.api_key;
        delete nextItem.baseUrl;
        delete nextItem.baseURL;
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
        : getConfigItemType(item);

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

function getDisabledConfigIndex(index, parsed) {
    const disabledConfigs = Array.isArray(parsed.disabled_configs) ? parsed.disabled_configs : [];
    if (!Number.isInteger(index) || index < 0 || index >= disabledConfigs.length) {
        throw new ConfigEditorError('停用配置项索引不合法');
    }

    return index;
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
    nextParsed.configs.push(...items.map(item => normalizeConfigItem(item)));
    return nextParsed;
}

function updateConfigItem(parsed, index, item) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = getConfigIndex(index, nextParsed);
    nextParsed.configs[targetIndex] = normalizeConfigItem(item, nextParsed.configs[targetIndex]);
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

function disableConfigItem(parsed, index, options = {}) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = getConfigIndex(index, nextParsed);
    const [item] = nextParsed.configs.splice(targetIndex, 1);
    const disabledStatus = normalizeString(options.disabledStatus);
    const disabledItem = { ...item };

    if (disabledStatus) {
        disabledItem.disabled_status = disabledStatus;
    } else {
        delete disabledItem.disabled_status;
    }

    nextParsed.disabled_configs = Array.isArray(nextParsed.disabled_configs)
        ? nextParsed.disabled_configs
        : [];
    nextParsed.disabled_configs.push(disabledItem);
    return validateParsedConfig(nextParsed);
}

function disableConfigItems(parsed, indexes, options = {}) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndexes = normalizeDeleteIndexes(indexes, nextParsed.configs.length, '配置项');
    const disabledStatuses = options.disabledStatuses && typeof options.disabledStatuses === 'object'
        ? options.disabledStatuses
        : {};
    const movedItems = [];

    for (const index of targetIndexes) {
        const [item] = nextParsed.configs.splice(index, 1);
        const disabledStatus = normalizeString(disabledStatuses[index]);
        const disabledItem = { ...item };

        if (disabledStatus) {
            disabledItem.disabled_status = disabledStatus;
        } else {
            delete disabledItem.disabled_status;
        }

        movedItems.unshift(disabledItem);
    }

    nextParsed.disabled_configs = Array.isArray(nextParsed.disabled_configs)
        ? nextParsed.disabled_configs
        : [];
    nextParsed.disabled_configs.push(...movedItems);
    return validateParsedConfig(nextParsed);
}

function enableConfigItem(parsed, index) {
    const nextParsed = cloneParsedConfig(parsed);
    const disabledConfigs = Array.isArray(nextParsed.disabled_configs)
        ? nextParsed.disabled_configs
        : [];
    const targetIndex = getDisabledConfigIndex(index, nextParsed);
    const [item] = disabledConfigs.splice(targetIndex, 1);
    delete item.disabled_status;

    nextParsed.disabled_configs = disabledConfigs;
    nextParsed.configs.push(normalizeConfigItem(item));
    return validateParsedConfig(nextParsed);
}

function enableConfigItems(parsed, indexes) {
    const nextParsed = cloneParsedConfig(parsed);
    const disabledConfigs = Array.isArray(nextParsed.disabled_configs)
        ? nextParsed.disabled_configs
        : [];
    const targetIndexes = normalizeDeleteIndexes(indexes, disabledConfigs.length, '停用配置项');
    const movedItems = [];

    for (const index of targetIndexes) {
        const [item] = disabledConfigs.splice(index, 1);
        delete item.disabled_status;
        movedItems.unshift(normalizeConfigItem(item));
    }

    nextParsed.disabled_configs = disabledConfigs;
    nextParsed.configs.push(...movedItems);
    return validateParsedConfig(nextParsed);
}

function deleteDisabledConfigItem(parsed, index) {
    const nextParsed = cloneParsedConfig(parsed);
    const disabledConfigs = Array.isArray(nextParsed.disabled_configs)
        ? nextParsed.disabled_configs
        : [];
    const targetIndex = getDisabledConfigIndex(index, nextParsed);

    disabledConfigs.splice(targetIndex, 1);
    nextParsed.disabled_configs = disabledConfigs;
    return validateParsedConfig(nextParsed);
}

function deleteDisabledConfigItems(parsed, indexes) {
    const nextParsed = cloneParsedConfig(parsed);
    const disabledConfigs = Array.isArray(nextParsed.disabled_configs)
        ? nextParsed.disabled_configs
        : [];
    const targetIndexes = normalizeDeleteIndexes(indexes, disabledConfigs.length, '停用配置项');

    for (const index of targetIndexes) {
        disabledConfigs.splice(index, 1);
    }

    nextParsed.disabled_configs = disabledConfigs;
    return validateParsedConfig(nextParsed);
}

function moveConfigItem(parsed, fromIndex, toIndex) {
    const nextParsed = cloneParsedConfig(parsed);
    const sourceIndex = getConfigIndex(fromIndex, nextParsed);
    const targetIndex = getConfigIndex(toIndex, nextParsed);
    const [item] = nextParsed.configs.splice(sourceIndex, 1);

    nextParsed.configs.splice(targetIndex, 0, item);
    return nextParsed;
}

function updateConfigSettings(parsed, settings) {
    assertPlainObject(settings, '配置设置必须是对象');

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

    if (Object.prototype.hasOwnProperty.call(settings, 'responses')) {
        const nextResponses = settings.responses;

        if (!nextResponses || typeof nextResponses !== 'object' || Array.isArray(nextResponses)) {
            throw new ConfigEditorError('配置设置 responses 必须是对象');
        }

        const mergedResponses = {
            ...(parsed.responses && typeof parsed.responses === 'object' && !Array.isArray(parsed.responses) ? parsed.responses : {}),
        };

        if (Object.prototype.hasOwnProperty.call(nextResponses, 'model_aliases')) {
            mergedResponses.model_aliases = normalizeResponsesModelAliases(nextResponses.model_aliases);
        }

        nextParsed.responses = mergedResponses;
    }

    return validateParsedConfig(nextParsed);
}

function writeParsedConfigFile(configFile, parsed, options = {}) {
    const validated = options.validate === false ? parsed : validateParsedConfig(parsed);
    const tempFile = `${configFile}.tmp`;

    fs.writeFileSync(tempFile, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
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
    deleteDisabledConfigItem,
    deleteDisabledConfigItems,
    disableConfigItem,
    disableConfigItems,
    enableConfigItem,
    enableConfigItems,
    moveConfigItem,
    readParsedConfigFile,
    writeParsedConfigFile,
};
