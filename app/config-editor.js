const fs = require('node:fs');
const {
    parseOpenAiConfigFile,
    createRuntimeConfigs,
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

function getEditableFields(type) {
    if (type === 'api_key') {
        return ['api_key', 'base_url', 'description'];
    }

    if (type === 'token') {
        return ['access_token', 'account_id', 'description'];
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

function normalizeConfigItem(type, item, existingItem = {}) {
    assertPlainObject(item, '配置项必须是对象');

    const nextItem = {
        ...(existingItem && typeof existingItem === 'object' && !Array.isArray(existingItem) ? existingItem : {}),
        ...item,
    };

    for (const field of getEditableFields(type)) {
        nextItem[field] = normalizeString(item[field]);
    }

    return nextItem;
}

function buildImportedConfigItem(type, item) {
    assertPlainObject(item, '配置项 JSON 必须是对象');

    if (type !== 'token') {
        return normalizeConfigItem(type, item);
    }

    const explicitAccessToken = normalizeString(item.access_token);
    const explicitAccountId = normalizeString(item.account_id);
    const explicitDescription = normalizeString(item.description);
    const sessionAccessToken = normalizeString(item.accessToken);
    const sessionAccountId = normalizeString(item.account && item.account.id);
    const sessionDescription = normalizeString(item.user && item.user.email);

    const accessToken = explicitAccessToken || sessionAccessToken;
    const accountId = explicitAccountId || sessionAccountId;
    const description = explicitDescription || sessionDescription || accountId;

    if (!accessToken || !accountId) {
        throw new ConfigEditorError('token 模式下请提供 access_token/account_id，或直接粘贴包含 user.email、account.id、accessToken 的 AuthSession JSON');
    }

    return {
        access_token: accessToken,
        account_id: accountId,
        description,
    };
}

function getConfigIndex(index, parsed) {
    if (!Number.isInteger(index) || index < 0 || index >= parsed.configs.length) {
        throw new ConfigEditorError('配置项索引不合法');
    }

    return index;
}

function addConfigItem(parsed, item) {
    const nextParsed = cloneParsedConfig(parsed);
    nextParsed.configs.push(normalizeConfigItem(nextParsed.type, item));
    return validateParsedConfig(nextParsed);
}

function updateConfigItem(parsed, index, item) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = getConfigIndex(index, nextParsed);
    nextParsed.configs[targetIndex] = normalizeConfigItem(nextParsed.type, item, nextParsed.configs[targetIndex]);
    return validateParsedConfig(nextParsed);
}

function deleteConfigItem(parsed, index) {
    const nextParsed = cloneParsedConfig(parsed);
    const targetIndex = getConfigIndex(index, nextParsed);

    nextParsed.configs.splice(targetIndex, 1);
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
    deleteConfigItem,
    readParsedConfigFile,
    writeParsedConfigFile,
};
