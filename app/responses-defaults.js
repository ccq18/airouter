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
    'max_completion_tokens',
    'temperature',
    'top_p',
    'truncation',
    'context_management',
    'user'
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

function buildCodexTextMessage(text, role = 'user') {
    return {
        type: 'message',
        role,
        content: [
            {
                type: 'input_text',
                text
            }
        ]
    };
}

function normalizeCodexResponsesInput(input) {
    if (typeof input === 'string') {
        return [buildCodexTextMessage(input)];
    }

    if (Array.isArray(input)) {
        return input.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return item;
            }

            if (item.type === 'message' && item.role === 'system') {
                return {
                    ...item,
                    role: 'developer'
                };
            }

            return item;
        });
    }

    return input;
}

function normalizeInstructionText(instructions) {
    if (typeof instructions === 'string') {
        return instructions.trim();
    }

    return '';
}

function normalizeCodexBuiltinToolType(toolType) {
    switch (toolType) {
        case 'web_search_preview':
        case 'web_search_preview_2025_03_11':
            return 'web_search';
        default:
            return '';
    }
}

function normalizeCodexBuiltinTool(tool) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return tool;
    }

    const normalizedType = normalizeCodexBuiltinToolType(tool.type);
    if (!normalizedType) {
        return tool;
    }

    return {
        ...tool,
        type: normalizedType
    };
}

function normalizeCodexBuiltinTools(body) {
    if (Array.isArray(body.tools)) {
        body.tools = body.tools.map(normalizeCodexBuiltinTool);
    }

    if (body.tool_choice && typeof body.tool_choice === 'object' && !Array.isArray(body.tool_choice)) {
        body.tool_choice = normalizeCodexBuiltinTool(body.tool_choice);

        if (Array.isArray(body.tool_choice.tools)) {
            body.tool_choice = {
                ...body.tool_choice,
                tools: body.tool_choice.tools.map(normalizeCodexBuiltinTool)
            };
        }
    }

    return body;
}

function normalizeCodexResponsesRequestBody(body) {
    const normalizedBody = {
        ...body
    };

    const instructions = normalizeInstructionText(body.instructions);
    const normalizedInput = Object.prototype.hasOwnProperty.call(body, 'input')
        ? normalizeCodexResponsesInput(body.input)
        : body.input;

    if (Array.isArray(normalizedInput)) {
        normalizedBody.input = instructions
            ? [buildCodexTextMessage(instructions, 'developer'), ...normalizedInput]
            : normalizedInput;
    } else if (instructions) {
        normalizedBody.input = [buildCodexTextMessage(instructions, 'developer')];
    }

    normalizedBody.stream = true;
    normalizedBody.store = false;
    normalizedBody.parallel_tool_calls = true;
    normalizedBody.include = ['reasoning.encrypted_content'];

    delete normalizedBody.instructions;

    for (const parameterName of CODEX_UNSUPPORTED_RESPONSES_PARAMETERS) {
        delete normalizedBody[parameterName];
    }

    if (normalizedBody.service_tier !== 'priority') {
        delete normalizedBody.service_tier;
    }

    return normalizeCodexBuiltinTools(normalizedBody);
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
