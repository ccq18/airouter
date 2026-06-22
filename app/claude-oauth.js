const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');

const CLAUDE_API_BASE_URL = 'https://api.anthropic.com';
const CLAUDE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const CLAUDE_OAUTH_SCOPES = [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
];

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function base64Url(buffer) {
    return Buffer.from(buffer)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function generateCodeVerifier() {
    return base64Url(crypto.randomBytes(32));
}

function generateCodeChallenge(codeVerifier) {
    return base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
}

function generateState() {
    return base64Url(crypto.randomBytes(24));
}

function generateLocalClaudeAuthToken() {
    return `airouter-oauth-${crypto.randomBytes(24).toString('hex')}`;
}

function sha256Hex(value) {
    const normalizedValue = normalizeString(value);
    if (!normalizedValue) {
        return '';
    }

    return crypto.createHash('sha256').update(normalizedValue).digest('hex');
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

function buildClaudeAuthorizeUrl({ codeChallenge, state, port }) {
    const url = new URL(CLAUDE_AUTHORIZE_URL);
    url.searchParams.set('code', 'true');
    url.searchParams.set('client_id', CLAUDE_OAUTH_CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', `http://localhost:${port}/callback`);
    url.searchParams.set('scope', CLAUDE_OAUTH_SCOPES.join(' '));
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
}

function requestJson(url, options = {}) {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const bodyBuffer = options.body === undefined
        ? null
        : Buffer.from(JSON.stringify(options.body));
    const headers = {
        ...(options.headers || {}),
    };

    if (bodyBuffer) {
        headers['content-type'] = headers['content-type'] || 'application/json';
        headers['content-length'] = String(bodyBuffer.length);
    }

    return new Promise((resolve, reject) => {
        const request = transport.request(target, {
            method: options.method || (bodyBuffer ? 'POST' : 'GET'),
            headers,
            timeout: options.timeoutMs || 15000,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let payload = null;
                if (text.trim()) {
                    try {
                        payload = JSON.parse(text);
                    } catch (err) {
                        reject(new Error(`响应不是合法 JSON: ${err.message}`));
                        return;
                    }
                }

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`HTTP ${response.statusCode}: ${text || response.statusMessage}`));
                    return;
                }

                resolve(payload || {});
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error(`请求超时: ${url}`));
        });
        request.on('error', reject);

        if (bodyBuffer) {
            request.write(bodyBuffer);
        }
        request.end();
    });
}

function exchangeCodeForTokens({ code, state, codeVerifier, port, requestJsonFn = requestJson }) {
    return requestJsonFn(CLAUDE_TOKEN_URL, {
        method: 'POST',
        body: {
            grant_type: 'authorization_code',
            code,
            redirect_uri: `http://localhost:${port}/callback`,
            client_id: CLAUDE_OAUTH_CLIENT_ID,
            code_verifier: codeVerifier,
            state,
        },
        headers: {
            'content-type': 'application/json',
        },
        timeoutMs: 15000,
    });
}

function fetchClaudeOAuthProfile(accessToken, { requestJsonFn = requestJson } = {}) {
    return requestJsonFn(`${CLAUDE_API_BASE_URL}/api/oauth/profile`, {
        method: 'GET',
        headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
        },
        timeoutMs: 10000,
    });
}

function getProfileAccount(profile) {
    return profile && profile.account && typeof profile.account === 'object'
        ? profile.account
        : {};
}

function getProfileOrganization(profile) {
    return profile && profile.organization && typeof profile.organization === 'object'
        ? profile.organization
        : {};
}

function buildClaudeDescription(profile) {
    const account = getProfileAccount(profile);
    const organization = getProfileOrganization(profile);
    const accountName = normalizeString(account.email_address) ||
        normalizeString(account.email) ||
        normalizeString(account.display_name);
    const organizationName = normalizeString(organization.name) ||
        normalizeString(organization.display_name);

    if (accountName && organizationName) {
        return `${accountName} · ${organizationName}`;
    }

    return accountName || organizationName || 'Claude OAuth account';
}

function buildClaudeTokenConfig({ tokenResponse, profile = null, localAuthToken, now = Date.now }) {
    const accessToken = normalizeString(tokenResponse && tokenResponse.access_token);
    if (!accessToken) {
        throw new Error('Claude OAuth 响应缺少 access_token');
    }

    const refreshToken = normalizeString(tokenResponse && tokenResponse.refresh_token);
    const expiresIn = Number(tokenResponse && tokenResponse.expires_in);
    const account = getProfileAccount(profile);
    const organization = getProfileOrganization(profile);
    const config = {
        type: 'claude_token',
        access_token: accessToken,
        local_auth_token: localAuthToken,
        description: buildClaudeDescription(profile),
    };
    const requestAuthTokenSha256s = normalizeSha256HexArray(tokenResponse && tokenResponse.request_auth_token_sha256s);

    if (requestAuthTokenSha256s.length > 0) {
        config.request_auth_token_sha256s = requestAuthTokenSha256s;
    }

    if (refreshToken) {
        config.refresh_token = refreshToken;
    }

    if (Number.isFinite(expiresIn) && expiresIn > 0) {
        config.expires_at = now() + expiresIn * 1000;
    }

    const accountUuid = normalizeString(account.uuid) || normalizeString(account.account_uuid);
    if (accountUuid) {
        config.account_uuid = accountUuid;
    }

    const organizationUuid = normalizeString(organization.uuid) || normalizeString(organization.organization_uuid);
    if (organizationUuid) {
        config.organization_uuid = organizationUuid;
    }

    return config;
}

function appendClaudeTokenConfig(parsed, options) {
    const localAuthToken = normalizeString(options.localAuthToken) || generateLocalClaudeAuthToken();
    const next = {
        ...(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}),
        configs: Array.isArray(parsed && parsed.configs) ? parsed.configs.map(item => ({ ...item })) : [],
    };
    const apikeys = Array.isArray(parsed && parsed.apikeys)
        ? parsed.apikeys.map(normalizeString).filter(Boolean)
        : [];
    const config = buildClaudeTokenConfig({
        ...options,
        localAuthToken,
    });

    if (!apikeys.includes(localAuthToken)) {
        apikeys.push(localAuthToken);
    }

    next.apikeys = apikeys;
    next.configs.push(config);
    return next;
}

function startOAuthCallbackServer({ state }) {
    let server;

    const codePromise = new Promise((resolve, reject) => {
        server = http.createServer((req, res) => {
            const url = new URL(req.url, 'http://localhost');

            if (url.pathname !== '/callback') {
                res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
                return;
            }

            const error = url.searchParams.get('error');
            if (error) {
                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end(`Claude OAuth failed: ${error}`);
                reject(new Error(`Claude OAuth failed: ${error}`));
                return;
            }

            if (url.searchParams.get('state') !== state) {
                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('OAuth state mismatch');
                reject(new Error('OAuth state mismatch'));
                return;
            }

            const code = url.searchParams.get('code');
            if (!code) {
                res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('Missing OAuth code');
                reject(new Error('Missing OAuth code'));
                return;
            }

            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            res.end('<!doctype html><meta charset="utf-8"><title>Airouter Claude Auth</title><p>Claude 授权成功，可以回到终端。</p>');
            resolve(code);
        });

        server.on('error', reject);
        server.listen(0, 'localhost');
    });

    return new Promise((resolve, reject) => {
        server.once('listening', () => {
            resolve({
                port: server.address().port,
                waitForCode: () => codePromise,
                close: () => new Promise(closeResolve => server.close(closeResolve)),
            });
        });
        server.once('error', reject);
    });
}

module.exports = {
    CLAUDE_API_BASE_URL,
    CLAUDE_AUTHORIZE_URL,
    CLAUDE_TOKEN_URL,
    CLAUDE_OAUTH_CLIENT_ID,
    CLAUDE_OAUTH_SCOPES,
    appendClaudeTokenConfig,
    buildClaudeAuthorizeUrl,
    buildClaudeTokenConfig,
    exchangeCodeForTokens,
    fetchClaudeOAuthProfile,
    generateCodeChallenge,
    generateCodeVerifier,
    generateLocalClaudeAuthToken,
    generateState,
    requestJson,
    sha256Hex,
    startOAuthCallbackServer,
};
