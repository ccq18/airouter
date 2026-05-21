const fs = require('node:fs');
const {
    parseOpenAiConfigFile,
    createRuntimeConfigs,
    getConfigItemType,
    normalizeApiKeySupport,
} = require('./openai-config');

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
        return ['type', 'access_token', 'refresh_token', 'account_id', 'description'];
    }

    throw new ConfigEditorError(`不支持的配置类型: ${type}`);
}

function validateParsedConfig(parsed) {
    const reparsed = parseOpenAiConfigFile(JSON.stringify(parsed));
    createRuntimeConfigs(reparsed);
    return reparsed;
}

function cloneParsedConfig(parsed) {
    return {
        ...parsed,
        configs: parsed.configs.map(item => ({ ...item })),
    };
}

function readParsedConfigFile(configFile) {
    const raw = fs.readFileSync(configFile, 'utf8');

    try {
        return validateParsedConfig(JSON.parse(raw));
    } catch (err) {
        if (err instanceof SyntaxError) {
            throw new ConfigEditorError(`配置文件不是合法 JSON: ${err.message}`);
        }

        if (err instanceof ConfigEditorError) {
            throw err;
        }

        throw new ConfigEditorError(err.message);
    }
}

function normalizeConfigItem(item, existingItem = {}) {
    assertPlainObject(item, '配置项必须是对象');

    const nextItem = {
        ...(existingItem && typeof existingItem === 'object' && !Array.isArray(existingItem) ? existingItem : {}),
        ...item,
    };
    const type = getConfigItemType(nextItem);

    for (const field of getEditableFields(type)) {
        if (field === 'support') {
            continue;
        }

        nextItem[field] = normalizeString(item[field]);
    }

    if (type === 'token' && !nextItem.type) {
        delete nextItem.type;
    }

    if (type === 'token' && !nextItem.refresh_token) {
        delete nextItem.refresh_token;
    }

    if (type === 'apikey') {
        nextItem.type = 'apikey';
        nextItem.base_url = nextItem.base_url.replace(/\/+$/, '');
        if (Object.prototype.hasOwnProperty.call(item, 'support')) {
            nextItem.support = normalizeApiKeySupport(item.support);
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

    const explicitAccessToken = normalizeString(item.access_token);
    const explicitAccountId = normalizeString(item.account_id);
    const explicitDescription = normalizeString(item.description);
    const explicitRefreshToken = normalizeString(item.refresh_token);
    const explicitClientId = normalizeString(item.client_id);
    const sessionAccessToken = normalizeString(item.accessToken);
    const sessionAccountId = normalizeString(item.account && item.account.id);
    const sessionDescription = normalizeString(item.user && item.user.email) || normalizeString(item.email);
    const sessionRefreshToken = normalizeString(item.refreshToken) ||
        normalizeString(item.tokens && item.tokens.refresh_token) ||
        normalizeString(item.tokens && item.tokens.refreshToken);
    const sessionClientId = normalizeString(item.clientId) ||
        normalizeString(item.tokens && item.tokens.client_id) ||
        normalizeString(item.tokens && item.tokens.clientId);

    const accessToken = explicitAccessToken || sessionAccessToken;
    const accountId = explicitAccountId || sessionAccountId;
    const description = explicitDescription || sessionDescription || accountId;
    const refreshToken = explicitRefreshToken || sessionRefreshToken;
    const decodedAccessToken = decodeJwtPayload(accessToken);
    const decodedIdToken = decodeJwtPayload(item.id_token);
    const clientId = explicitClientId || sessionClientId || normalizeString(decodedAccessToken && decodedAccessToken.client_id) || normalizeString(decodedIdToken && decodedIdToken.client_id);

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

function addConfigItem(parsed, item) {
    const nextParsed = cloneParsedConfig(parsed);
    nextParsed.configs.push(normalizeConfigItem(item));
    return validateParsedConfig(nextParsed);
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

function moveConfigItem(parsed, fromIndex, toIndex) {
    const nextParsed = cloneParsedConfig(parsed);
    const sourceIndex = getConfigIndex(fromIndex, nextParsed);
    const targetIndex = getConfigIndex(toIndex, nextParsed);
    const [item] = nextParsed.configs.splice(sourceIndex, 1);

    nextParsed.configs.splice(targetIndex, 0, item);
    return validateParsedConfig(nextParsed);
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

function writeParsedConfigFile(configFile, parsed) {
    const validated = validateParsedConfig(parsed);
    const tempFile = `${configFile}.tmp`;

    fs.writeFileSync(tempFile, `${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    fs.renameSync(tempFile, configFile);

    return validated;
}

module.exports = {
    ConfigEditorError,
    addConfigItem,
    buildImportedConfigItem,
    updateConfigItem,
    updateConfigSettings,
    deleteConfigItem,
    moveConfigItem,
    readParsedConfigFile,
    writeParsedConfigFile,
};
