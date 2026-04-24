const RESPONSES_DEFAULTS = {
    instructions: '',
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: []
};

const RESPONSES_MODEL_ALIASES = {
    'gpt-5.4-mini': 'gpt-5.5'
};

function isResponsesPath(requestPath) {
    if (typeof requestPath !== 'string' || requestPath.length === 0) {
        return false;
    }

    const pathname = new URL(requestPath, 'http://localhost').pathname;
    return pathname === '/responses' || pathname.endsWith('/responses');
}

function normalizeResponsesRequestBody(requestPath, body) {
    if (!isResponsesPath(requestPath) || !body || Array.isArray(body) || typeof body !== 'object') {
        return body;
    }

    const normalizedBody = {
        ...RESPONSES_DEFAULTS,
        ...body
    };

    if (RESPONSES_MODEL_ALIASES[body.model]) {
        normalizedBody.model = RESPONSES_MODEL_ALIASES[body.model];
    }

    return normalizedBody;
}

module.exports = {
    RESPONSES_DEFAULTS,
    RESPONSES_MODEL_ALIASES,
    isResponsesPath,
    normalizeResponsesRequestBody
};
