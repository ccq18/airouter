const {
    normalizeResponsesRequestBody
} = require('./responses-defaults');

function normalizeClaudeContent(content) {
    if (typeof content === 'string') {
        return [{
            type: 'text',
            text: content
        }];
    }

    if (Array.isArray(content)) {
        return content;
    }

    if (content && typeof content === 'object') {
        return [content];
    }

    return [];
}

function extractSystemInstructions(system) {
    return normalizeClaudeContent(system)
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n\n');
}

function mapClaudeToolChoice(toolChoice) {
    if (!toolChoice) {
        return 'auto';
    }

    if (typeof toolChoice === 'string') {
        return toolChoice;
    }

    if (toolChoice.type === 'auto') {
        return 'auto';
    }

    if (toolChoice.type === 'any') {
        return 'required';
    }

    if (toolChoice.type === 'tool' && toolChoice.name) {
        return {
            type: 'function',
            name: toolChoice.name
        };
    }

    if (toolChoice.type === 'none') {
        return 'none';
    }

    return toolChoice;
}

function normalizeJsonSchemaForCodex(schema) {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return schema;
    }

    if (Object.keys(schema).length === 0) {
        return {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false
        };
    }

    const normalized = { ...schema };
    delete normalized.propertyNames;
    if (normalized.format === 'uri') {
        delete normalized.format;
    }
    const hasObjectProperties = normalized.properties && typeof normalized.properties === 'object' && !Array.isArray(normalized.properties);
    const isObjectSchema = normalized.type === 'object' || hasObjectProperties;

    if (isObjectSchema) {
        if (!Object.prototype.hasOwnProperty.call(normalized, 'additionalProperties')) {
            normalized.additionalProperties = false;
        }

        if (hasObjectProperties) {
            normalized.properties = Object.fromEntries(
                Object.entries(normalized.properties).map(([name, value]) => [name, normalizeJsonSchemaForCodex(value)])
            );
        } else {
            normalized.properties = {};
        }

        const propertyNames = Object.keys(normalized.properties);
        normalized.required = propertyNames;
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

function mapClaudeTools(tools) {
    if (!Array.isArray(tools)) {
        return [];
    }

    return tools.map(tool => ({
        type: 'function',
        name: tool.name,
        description: tool.description || '',
        parameters: normalizeJsonSchemaForCodex(tool.input_schema || {
            type: 'object',
            properties: {}
        }),
        strict: true
    }));
}

function mapClaudeImageBlock(block) {
    if (block.type !== 'image' || !block.source || typeof block.source !== 'object') {
        return null;
    }

    if (block.source.type === 'base64' && block.source.media_type && block.source.data) {
        return {
            type: 'input_image',
            image_url: `data:${block.source.media_type};base64,${block.source.data}`
        };
    }

    if (block.source.type === 'url' && block.source.url) {
        return {
            type: 'input_image',
            image_url: block.source.url
        };
    }

    return null;
}

function mapClaudeDocumentBlock(block) {
    if (block.type !== 'document' || !block.source || typeof block.source !== 'object') {
        return null;
    }

    if (block.source.type === 'base64' && block.source.media_type && block.source.data) {
        return {
            type: 'input_file',
            filename: block.title || 'document',
            file_data: `data:${block.source.media_type};base64,${block.source.data}`
        };
    }

    return null;
}

function pushCurrentMessageInput(items, currentMessage) {
    if (!currentMessage || currentMessage.content.length === 0) {
        return;
    }

    items.push(currentMessage);
}

function normalizeToolResultContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        const text = content
            .filter(block => block && block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('\n');
        return text || JSON.stringify(content);
    }

    if (content && typeof content === 'object') {
        return JSON.stringify(content);
    }

    return '';
}

function mapTextBlockByRole(role, text) {
    if (role === 'assistant') {
        return {
            type: 'output_text',
            text
        };
    }

    return {
        type: 'input_text',
        text
    };
}

function mapClaudeMessagesToResponsesInput(messages) {
    const input = [];

    for (const message of Array.isArray(messages) ? messages : []) {
        const blocks = normalizeClaudeContent(message.content);
        let currentMessage = {
            type: 'message',
            role: message.role,
            content: []
        };

        for (const block of blocks) {
            if (!block || typeof block !== 'object') {
                continue;
            }

            if (block.type === 'text' && typeof block.text === 'string') {
                currentMessage.content.push(mapTextBlockByRole(message.role, block.text));
                continue;
            }

            const imageInput = mapClaudeImageBlock(block);
            if (imageInput) {
                currentMessage.content.push(imageInput);
                continue;
            }

            const documentInput = mapClaudeDocumentBlock(block);
            if (documentInput) {
                currentMessage.content.push(documentInput);
                continue;
            }

            if (block.type === 'tool_use') {
                pushCurrentMessageInput(input, currentMessage);
                currentMessage = {
                    type: 'message',
                    role: message.role,
                    content: []
                };
                input.push({
                    type: 'function_call',
                    call_id: block.id,
                    name: block.name,
                    arguments: JSON.stringify(block.input || {})
                });
                continue;
            }

            if (block.type === 'tool_result') {
                pushCurrentMessageInput(input, currentMessage);
                currentMessage = {
                    type: 'message',
                    role: message.role,
                    content: []
                };
                input.push({
                    type: 'function_call_output',
                    call_id: block.tool_use_id,
                    output: normalizeToolResultContent(block.content)
                });
            }
        }

        pushCurrentMessageInput(input, currentMessage);
    }

    return input;
}

function transformClaudeMessagesRequest(body, options = {}) {
    const responsesBody = {
        model: options.model || body.model,
        instructions: extractSystemInstructions(body.system),
        input: mapClaudeMessagesToResponsesInput(body.messages),
        tools: mapClaudeTools(body.tools),
        tool_choice: mapClaudeToolChoice(body.tool_choice),
        parallel_tool_calls: false,
        store: false,
        stream: typeof options.stream === 'boolean' ? options.stream : body.stream === true,
        include: []
    };

    if (typeof options.reasoningEffort === 'string' && options.reasoningEffort.length > 0) {
        responsesBody.reasoning = {
            effort: options.reasoningEffort
        };
    }

    const includeMaxOutputTokens = options.includeMaxOutputTokens !== false;
    if (includeMaxOutputTokens && typeof body.max_tokens === 'number') {
        responsesBody.max_output_tokens = body.max_tokens;
    }

    return normalizeResponsesRequestBody('/responses', responsesBody, options.responsesOptions);
}

function safeParseJson(text) {
    if (typeof text !== 'string') {
        return text && typeof text === 'object' ? text : {};
    }

    try {
        return JSON.parse(text);
    } catch (err) {
        return {};
    }
}

function synthesizeClaudeMessageId(responseId) {
    if (typeof responseId !== 'string' || responseId.length === 0) {
        return 'msg_generated';
    }

    if (responseId.startsWith('msg_')) {
        return responseId;
    }

    return `msg_${responseId.replace(/^[^_]+_/, '')}`;
}

function mapResponsesUsage(usage) {
    return {
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: usage?.input_tokens_details?.cached_tokens ?? 0
    };
}

function mapResponsesStopReason(response, contentBlocks) {
    if (response?.incomplete_details?.reason === 'max_output_tokens' || response?.status === 'incomplete') {
        return 'max_tokens';
    }

    if (contentBlocks.some(block => block.type === 'tool_use')) {
        return 'tool_use';
    }

    return 'end_turn';
}

function transformResponsesResponseToClaudeMessage(response) {
    const content = [];
    let messageId = null;

    for (const item of Array.isArray(response?.output) ? response.output : []) {
        if (item.type === 'message' && item.role === 'assistant') {
            if (!messageId && item.id) {
                messageId = item.id;
            }

            for (const block of Array.isArray(item.content) ? item.content : []) {
                if (block.type === 'output_text' && typeof block.text === 'string') {
                    content.push({
                        type: 'text',
                        text: block.text
                    });
                }
            }
            continue;
        }

        if (item.type === 'function_call') {
            content.push({
                type: 'tool_use',
                id: item.call_id || item.id || synthesizeClaudeMessageId(response?.id),
                name: item.name,
                input: safeParseJson(item.arguments)
            });
        }
    }

    return {
        id: messageId || synthesizeClaudeMessageId(response?.id),
        type: 'message',
        role: 'assistant',
        model: response?.model,
        content,
        stop_reason: mapResponsesStopReason(response, content),
        stop_sequence: null,
        usage: mapResponsesUsage(response?.usage)
    };
}

function createClaudeSseTransformer() {
    const state = {
        responseId: null,
        model: null,
        messageStarted: false,
        messageId: null,
        nextBlockIndex: 0,
        contentBlockKeys: new Map(),
        functionCallBlockIndexes: new Map(),
        functionCallDeltaSeen: new Set(),
        openBlockIndexes: new Set()
    };

    function ensureMessageStarted(preferredId) {
        if (state.messageStarted) {
            return [];
        }

        state.messageStarted = true;
        state.messageId = preferredId || synthesizeClaudeMessageId(state.responseId);
        return [{
            event: 'message_start',
            data: {
                type: 'message_start',
                message: {
                    id: state.messageId,
                    type: 'message',
                    role: 'assistant',
                    model: state.model,
                    content: [],
                    stop_reason: null,
                    stop_sequence: null,
                    usage: {
                        input_tokens: 0,
                        output_tokens: 0
                    }
                }
            }
        }];
    }

    function allocateContentBlockIndex(key) {
        if (!state.contentBlockKeys.has(key)) {
            state.contentBlockKeys.set(key, state.nextBlockIndex);
            state.nextBlockIndex += 1;
        }

        return state.contentBlockKeys.get(key);
    }

    function closeBlock(index) {
        if (!state.openBlockIndexes.has(index)) {
            return [];
        }

        state.openBlockIndexes.delete(index);
        return [{
            event: 'content_block_stop',
            data: {
                type: 'content_block_stop',
                index
            }
        }];
    }

    return {
        accept(eventName, payload) {
            const emitted = [];

            if (eventName === 'response.created') {
                state.responseId = payload?.response?.id || null;
                state.model = payload?.response?.model || null;
                return emitted;
            }

            if (eventName === 'response.output_item.added') {
                const item = payload?.item || {};
                state.model = state.model || payload?.response?.model || null;
                emitted.push(...ensureMessageStarted(item.type === 'message' ? item.id : null));

                if (item.type === 'function_call') {
                    const key = `function:${item.id || item.call_id || payload.output_index}`;
                    const index = allocateContentBlockIndex(key);
                    state.functionCallBlockIndexes.set(item.id || item.call_id, index);
                    state.openBlockIndexes.add(index);
                    emitted.push({
                        event: 'content_block_start',
                        data: {
                            type: 'content_block_start',
                            index,
                            content_block: {
                                type: 'tool_use',
                                id: item.call_id || item.id,
                                name: item.name,
                                input: {}
                            }
                        }
                    });
                }

                return emitted;
            }

            if (eventName === 'response.content_part.added' && payload?.part?.type === 'output_text') {
                emitted.push(...ensureMessageStarted(payload.item_id));
                const key = `content:${payload.item_id}:${payload.content_index}`;
                const index = allocateContentBlockIndex(key);
                state.openBlockIndexes.add(index);
                emitted.push({
                    event: 'content_block_start',
                    data: {
                        type: 'content_block_start',
                        index,
                        content_block: {
                            type: 'text',
                            text: ''
                        }
                    }
                });
                return emitted;
            }

            if (eventName === 'response.output_text.delta') {
                const key = `content:${payload.item_id}:${payload.content_index}`;
                const index = allocateContentBlockIndex(key);
                emitted.push({
                    event: 'content_block_delta',
                    data: {
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'text_delta',
                            text: payload.delta || ''
                        }
                    }
                });
                return emitted;
            }

            if (eventName === 'response.content_part.done') {
                const key = `content:${payload.item_id}:${payload.content_index}`;
                emitted.push(...closeBlock(allocateContentBlockIndex(key)));
                return emitted;
            }

            if (eventName === 'response.function_call_arguments.delta') {
                const index = state.functionCallBlockIndexes.get(payload.item_id);
                if (typeof index !== 'number') {
                    return emitted;
                }

                state.functionCallDeltaSeen.add(payload.item_id);
                emitted.push({
                    event: 'content_block_delta',
                    data: {
                        type: 'content_block_delta',
                        index,
                        delta: {
                            type: 'input_json_delta',
                            partial_json: payload.delta || ''
                        }
                    }
                });
                return emitted;
            }

            if (eventName === 'response.output_item.done') {
                const item = payload?.item || {};
                if (item.type === 'function_call') {
                    const index = state.functionCallBlockIndexes.get(item.id || item.call_id);
                    if (typeof index === 'number') {
                        if (!state.functionCallDeltaSeen.has(item.id || item.call_id) && typeof item.arguments === 'string' && item.arguments.length > 0) {
                            emitted.push({
                                event: 'content_block_delta',
                                data: {
                                    type: 'content_block_delta',
                                    index,
                                    delta: {
                                        type: 'input_json_delta',
                                        partial_json: item.arguments
                                    }
                                }
                            });
                        }
                        emitted.push(...closeBlock(index));
                    }
                }
                return emitted;
            }

            if (eventName === 'response.completed') {
                for (const index of Array.from(state.openBlockIndexes)) {
                    emitted.push(...closeBlock(index));
                }

                const response = payload?.response || {};
                const mappedResponse = transformResponsesResponseToClaudeMessage(response);
                emitted.push({
                    event: 'message_delta',
                    data: {
                        type: 'message_delta',
                        delta: {
                            stop_reason: mappedResponse.stop_reason,
                            stop_sequence: null
                        },
                        usage: mappedResponse.usage
                    }
                });
                emitted.push({
                    event: 'message_stop',
                    data: {
                        type: 'message_stop'
                    }
                });
                return emitted;
            }

            return emitted;
        }
    };
}

module.exports = {
    transformClaudeMessagesRequest,
    transformResponsesResponseToClaudeMessage,
    createClaudeSseTransformer
};
