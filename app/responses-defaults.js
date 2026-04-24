const RESPONSES_DEFAULTS = {
    instructions: '',
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: []
};

function isResponsesPath(requestPath) {
    if (typeof requestPath !== 'string' || requestPath.length === 0) {
        return false;
    }

    const pathname = new URL(requestPath, 'http://localhost').pathname;
    return pathname === '/responses' || pathname.endsWith('/responses');
}

function normalizeModelAlias(model, options = {}) {
    if (typeof model !== 'string') {
        return model;
    }

    const normalizedModel = model.trim();
    if (!normalizedModel) {
        return model;
    }

    const aliasKey = normalizedModel.toLowerCase();
    return options.modelAliases && options.modelAliases[aliasKey]
        ? options.modelAliases[aliasKey]
        : model;
}

function normalizeResponsesRequestBody(requestPath, body, options = {}) {
    if (!isResponsesPath(requestPath) || !body || Array.isArray(body) || typeof body !== 'object') {
        return body;
    }

    const normalizedBody = {
        ...RESPONSES_DEFAULTS,
        ...body
    };
    normalizedBody.model = normalizeModelAlias(body.model, options);

    return normalizedBody;
}

module.exports = {
    RESPONSES_DEFAULTS,
    normalizeModelAlias,
    isResponsesPath,
    normalizeResponsesRequestBody
};
