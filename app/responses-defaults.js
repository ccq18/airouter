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

const CPA_UNSUPPORTED_RESPONSES_PARAMETERS = [
    ...CODEX_UNSUPPORTED_RESPONSES_PARAMETERS,
    'max_completion_tokens',
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

function normalizeCodexResponsesInput(input, options = {}) {
    if (typeof input === 'string') {
        return [buildCodexTextMessage(input)];
    }

    if (Array.isArray(input)) {
        return input.map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return item;
            }

            if (options.cpaStyleCompatibility && item.type === 'message' && item.role === 'system') {
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

function inferJsonSchemaType(schema) {
    if (schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)) {
        return 'object';
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !Array.isArray(schema.additionalProperties)) {
        return 'object';
    }

    if (schema.items) {
        return 'array';
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
        const primitiveTypes = new Set(schema.enum.map(value => {
            if (value === null) {
                return 'null';
            }
            if (Array.isArray(value)) {
                return 'array';
            }
            return typeof value;
        }));

        if (primitiveTypes.size === 1) {
            return [...primitiveTypes][0];
        }
    }

    if (Object.prototype.hasOwnProperty.call(schema, 'const')) {
        const value = schema.const;
        if (value === null) {
            return 'null';
        }
        if (Array.isArray(value)) {
            return 'array';
        }
        return typeof value;
    }

    if (
        Array.isArray(schema.anyOf) ||
        Array.isArray(schema.oneOf) ||
        Array.isArray(schema.allOf)
    ) {
        return '';
    }

    return 'object';
}

function normalizeJsonSchemaForCodex(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return schema;
    }

    const normalized = { ...schema };
    delete normalized.propertyNames;
    if (normalized.format === 'uri') {
        delete normalized.format;
    }

    if (!Object.prototype.hasOwnProperty.call(normalized, 'type')) {
        const inferredType = inferJsonSchemaType(normalized);
        if (inferredType) {
            normalized.type = inferredType;
        }
    }

    const hasObjectProperties = normalized.properties && typeof normalized.properties === 'object' && !Array.isArray(normalized.properties);
    const isObjectSchema = normalized.type === 'object' || hasObjectProperties;

    if (isObjectSchema) {
        if (hasObjectProperties) {
            normalized.properties = Object.fromEntries(
                Object.entries(normalized.properties).map(([name, value]) => [name, normalizeJsonSchemaForCodex(value)])
            );
        } else {
            normalized.properties = {};
        }

        const propertyNames = Object.keys(normalized.properties);
        normalized.required = propertyNames;
        normalized.additionalProperties = false;
    }

    if (normalized.additionalProperties && typeof normalized.additionalProperties === 'object') {
        normalized.additionalProperties = normalizeJsonSchemaForCodex(normalized.additionalProperties);
    }

    if (Array.isArray(normalized.anyOf)) {
        normalized.anyOf = normalized.anyOf.map(normalizeJsonSchemaForCodex);
    }

    if (Array.isArray(normalized.oneOf)) {
        normalized.oneOf = normalized.oneOf.map(normalizeJsonSchemaForCodex);
    }

    if (Array.isArray(normalized.allOf)) {
        normalized.allOf = normalized.allOf.map(normalizeJsonSchemaForCodex);
    }

    if (normalized.items) {
        normalized.items = normalizeJsonSchemaForCodex(normalized.items);
    }

    return normalized;
}

function normalizeCodexFunctionToolSchema(tool) {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
        return tool;
    }

    if (tool.type === 'function' && tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)) {
        return {
            ...tool,
            parameters: normalizeJsonSchemaForCodex(tool.parameters)
        };
    }

    if (
        tool.type === 'function' &&
        tool.function &&
        typeof tool.function === 'object' &&
        !Array.isArray(tool.function) &&
        tool.function.parameters &&
        typeof tool.function.parameters === 'object' &&
        !Array.isArray(tool.function.parameters)
    ) {
        return {
            ...tool,
            function: {
                ...tool.function,
                parameters: normalizeJsonSchemaForCodex(tool.function.parameters)
            }
        };
    }

    return tool;
}

function normalizeCodexTool(tool, options = {}) {
    const normalizedTool = options.normalizeBuiltinAliases
        ? normalizeCodexBuiltinTool(tool)
        : tool;

    return normalizeCodexFunctionToolSchema(normalizedTool);
}

function normalizeCodexTools(body, options = {}) {
    if (Array.isArray(body.tools)) {
        body.tools = body.tools.map(tool => normalizeCodexTool(tool, options));
    }

    if (options.normalizeBuiltinAliases && body.tool_choice && typeof body.tool_choice === 'object' && !Array.isArray(body.tool_choice)) {
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

function normalizeCodexResponsesRequestBody(body, options = {}) {
    const cpaStyleCompatibility = options.cpaStyleCompatibility === true;
    const normalizedBody = {
        ...body
    };

    const instructions = normalizeInstructionText(body.instructions);
    const normalizedInput = Object.prototype.hasOwnProperty.call(body, 'input')
        ? normalizeCodexResponsesInput(body.input, { cpaStyleCompatibility })
        : body.input;

    if (cpaStyleCompatibility && Array.isArray(normalizedInput)) {
        normalizedBody.input = instructions
            ? [buildCodexTextMessage(instructions, 'developer'), ...normalizedInput]
            : normalizedInput;
    } else if (cpaStyleCompatibility && instructions) {
        normalizedBody.input = [buildCodexTextMessage(instructions, 'developer')];
    } else if (Object.prototype.hasOwnProperty.call(body, 'input')) {
        normalizedBody.input = normalizedInput;
    }

    if (cpaStyleCompatibility) {
        normalizedBody.stream = true;
        normalizedBody.store = false;
        normalizedBody.parallel_tool_calls = true;
        normalizedBody.include = ['reasoning.encrypted_content'];
        normalizedBody.instructions = '';
    }

    const unsupportedParameters = cpaStyleCompatibility
        ? CPA_UNSUPPORTED_RESPONSES_PARAMETERS
        : CODEX_UNSUPPORTED_RESPONSES_PARAMETERS;
    for (const parameterName of unsupportedParameters) {
        delete normalizedBody[parameterName];
    }

    if (cpaStyleCompatibility && normalizedBody.service_tier !== 'priority') {
        delete normalizedBody.service_tier;
    }

    return normalizeCodexTools(normalizedBody, {
        normalizeBuiltinAliases: cpaStyleCompatibility
    });
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
        return normalizeCodexResponsesRequestBody(normalizedBody, {
            cpaStyleCompatibility: options.cpaStyleCompatibility === true
        });
    }

    return normalizedBody;
}

module.exports = {
    CODEX_UNSUPPORTED_RESPONSES_PARAMETERS,
    CPA_UNSUPPORTED_RESPONSES_PARAMETERS,
    RESPONSES_DEFAULTS,
    normalizeCodexResponsesInput,
    normalizeJsonSchemaForCodex,
    normalizeModelAlias,
    isResponsesPath,
    normalizeResponsesRequestBody
};
