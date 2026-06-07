const RESPONSES_DEFAULTS = {
    instructions: '',
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: []
};

const CODEX_UNSUPPORTED_RESPONSES_PARAMETERS = [
    'max_output_tokens',
    'temperature'
];

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

function buildCodexTextMessage(text) {
    return [
        {
            type: 'message',
            role: 'user',
            content: [
                {
                    type: 'input_text',
                    text
                }
            ]
        }
    ];
}

function normalizeCodexResponsesInput(input) {
    if (typeof input === 'string') {
        return buildCodexTextMessage(input);
    }

    return input;
}

function normalizeCodexResponsesRequestBody(body) {
    const normalizedBody = {
        ...body
    };
    if (Object.prototype.hasOwnProperty.call(body, 'input')) {
        normalizedBody.input = normalizeCodexResponsesInput(body.input);
    }

    for (const parameterName of CODEX_UNSUPPORTED_RESPONSES_PARAMETERS) {
        delete normalizedBody[parameterName];
    }

    return normalizedBody;
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
    if (options.forceStoreFalse) {
        normalizedBody.store = false;
    }
    if (options.codexCompatibility) {
        return normalizeCodexResponsesRequestBody(normalizedBody);
    }

    return normalizedBody;
}

module.exports = {
    CODEX_UNSUPPORTED_RESPONSES_PARAMETERS,
    RESPONSES_DEFAULTS,
    normalizeCodexResponsesInput,
    normalizeModelAlias,
    isResponsesPath,
    normalizeResponsesRequestBody
};
