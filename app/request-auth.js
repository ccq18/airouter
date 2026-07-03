const crypto = require('node:crypto');

function normalizeString(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim();
}

function normalizeStringArray(values) {
    if (!Array.isArray(values)) {
        return [];
    }

    return values
        .map(normalizeString)
        .filter(Boolean);
}

function sha256Hex(value) {
    const normalizedValue = normalizeString(value);
    if (!normalizedValue) {
        return '';
    }

    return crypto.createHash('sha256').update(normalizedValue).digest('hex');
}

function normalizeSha256HexArray(values) {
    return normalizeStringArray(values)
        .map(value => value.toLowerCase())
        .filter(value => /^[0-9a-f]{64}$/.test(value));
}

function generateRandomSecret(prefix) {
    return `${prefix}${crypto.randomBytes(18).toString('hex')}`;
}

function getConfiguredApiKeys(parsedConfig) {
    if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
        return [];
    }

    return normalizeStringArray(parsedConfig.apikeys);
}

function hasConfiguredApiKeys(parsedConfig) {
    return getConfiguredApiKeys(parsedConfig).length > 0;
}

function getConfiguredAuthToken(parsedConfig) {
    if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
        return '';
    }

    return normalizeString(parsedConfig.auth_token);
}

function getConfiguredClaudeTokenRequestAuthTokens(parsedConfig) {
    if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
        return [];
    }

    if (!Array.isArray(parsedConfig.configs)) {
        return [];
    }

    const tokens = [];
    for (const item of parsedConfig.configs) {
        if (!item || item.type !== 'claude_token') {
            continue;
        }

        tokens.push(item.local_auth_token);
        tokens.push(item.access_token);
    }

    return normalizeStringArray(tokens);
}

function getConfiguredClaudeTokenRequestAuthTokenHashes(parsedConfig) {
    if (!parsedConfig || typeof parsedConfig !== 'object' || Array.isArray(parsedConfig)) {
        return [];
    }

    if (!Array.isArray(parsedConfig.configs)) {
        return [];
    }

    const tokenHashes = [];
    for (const item of parsedConfig.configs) {
        if (!item || item.type !== 'claude_token') {
            continue;
        }

        tokenHashes.push(...normalizeSha256HexArray(item.request_auth_token_sha256s));
    }

    return tokenHashes;
}

function getHeaderValue(headers, headerName) {
    if (!headers || typeof headers !== 'object') {
        return '';
    }

    const directValue = headers[headerName];
    if (typeof directValue !== 'undefined') {
        return Array.isArray(directValue) ? directValue[0] : directValue;
    }

    const normalizedHeaderName = headerName.toLowerCase();
    for (const [name, value] of Object.entries(headers)) {
        if (String(name).toLowerCase() === normalizedHeaderName) {
            return Array.isArray(value) ? value[0] : value;
        }
    }

    return '';
}

function extractRequestApiKey(headers) {
    const explicitApiKey = normalizeString(getHeaderValue(headers, 'x-api-key'));
    if (explicitApiKey) {
        return explicitApiKey;
    }

    const authorization = normalizeString(getHeaderValue(headers, 'authorization'));
    if (!authorization) {
        return '';
    }

    const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
    if (!bearerMatch) {
        return '';
    }

    return normalizeString(bearerMatch[1]);
}

function secureEquals(left, right) {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');

    if (leftBuffer.length !== rightBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorizedRequest(headers, configuredApiKeys) {
    const expectedApiKeys = normalizeStringArray(configuredApiKeys);
    if (expectedApiKeys.length === 0) {
        return true;
    }

    const requestApiKey = extractRequestApiKey(headers);
    if (!requestApiKey) {
        return false;
    }

    return expectedApiKeys.some(expectedApiKey => secureEquals(requestApiKey, expectedApiKey));
}

function isAuthorizedRequestWithTokenHashes(headers, configuredApiKeys, configuredTokenHashes) {
    if (isAuthorizedRequest(headers, configuredApiKeys)) {
        return true;
    }

    const expectedTokenHashes = normalizeSha256HexArray(configuredTokenHashes);
    if (expectedTokenHashes.length === 0) {
        return false;
    }

    const requestApiKey = extractRequestApiKey(headers);
    if (!requestApiKey) {
        return false;
    }

    const requestTokenHash = sha256Hex(requestApiKey);
    return expectedTokenHashes.some(expectedTokenHash => secureEquals(requestTokenHash, expectedTokenHash));
}

function isAuthorizedAdminRequest(authToken, configuredAuthToken) {
    const normalizedConfiguredToken = normalizeString(configuredAuthToken);
    if (!normalizedConfiguredToken) {
        return false;
    }

    const normalizedRequestToken = normalizeString(authToken);
    if (!normalizedRequestToken) {
        return false;
    }

    return secureEquals(normalizedRequestToken, normalizedConfiguredToken);
}

module.exports = {
    generateRandomSecret,
    getConfiguredApiKeys,
    getConfiguredClaudeTokenRequestAuthTokenHashes,
    getConfiguredClaudeTokenRequestAuthTokens,
    hasConfiguredApiKeys,
    getConfiguredAuthToken,
    normalizeString,
    normalizeStringArray,
    normalizeSha256HexArray,
    sha256Hex,
    extractRequestApiKey,
    isAuthorizedRequest,
    isAuthorizedRequestWithTokenHashes,
    isAuthorizedAdminRequest,
};
