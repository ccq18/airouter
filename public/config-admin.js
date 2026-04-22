(function attachConfigAdmin(globalScope) {
  function parseSseChunk(rawEvent) {
    const lines = String(rawEvent || '').split('\n');
    let eventName = '';
    const dataLines = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
        continue;
      }

      if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    return {
      eventName,
      dataText: dataLines.join('\n'),
    };
  }

  function parseResponsesEventStream(text) {
    const rawEvents = String(text || '')
      .replace(/\r\n/g, '\n')
      .split('\n\n');

    let completedResponse = null;
    let outputText = '';

    for (const rawEvent of rawEvents) {
      if (!rawEvent.trim()) {
        continue;
      }

      const parsed = parseSseChunk(rawEvent);
      if (!parsed.dataText || parsed.dataText === '[DONE]') {
        continue;
      }

      const payload = JSON.parse(parsed.dataText);
      const eventName = payload.type || parsed.eventName;

      if (eventName === 'response.output_text.delta' && typeof payload.delta === 'string') {
        outputText = `${outputText}${payload.delta}`;
      }

      if (!outputText && eventName === 'response.output_text.done' && typeof payload.text === 'string') {
        outputText = payload.text;
      }

      if (eventName === 'response.completed' && payload.response && typeof payload.response === 'object') {
        completedResponse = payload.response;
      }
    }

    if (completedResponse) {
      const hasStructuredOutput = Array.isArray(completedResponse.output) && completedResponse.output.length > 0;

      if (outputText && !hasStructuredOutput) {
        return {
          ...completedResponse,
          output_text: outputText,
        };
      }

      return completedResponse;
    }

    if (outputText) {
      return {
        output_text: outputText,
      };
    }

    return {};
  }

  function parseResponsesApiResponse(text, contentType) {
    const normalizedContentType = String(contentType || '').toLowerCase();
    const responseText = String(text || '');
    const looksLikeEventStream = responseText.startsWith('event: ') || responseText.includes('\nevent: ');

    if (!responseText) {
      return null;
    }

    if (normalizedContentType.includes('text/event-stream') || looksLikeEventStream) {
      return parseResponsesEventStream(responseText);
    }

    if (normalizedContentType.includes('application/json')) {
      return JSON.parse(responseText);
    }

    try {
      return JSON.parse(responseText);
    } catch (error) {
      return {
        message: responseText,
      };
    }
  }

  function buildJsonRequestOptions(options) {
    const normalizedOptions = options && typeof options === 'object' ? options : {};

    return {
      ...normalizedOptions,
      headers: {
        'Content-Type': 'application/json',
        ...(normalizedOptions.headers || {}),
      },
    };
  }

  function buildConfigSnapshotRequest(forceRefresh = false) {
    if (forceRefresh) {
      return {
        url: '/admin/api/configs/refresh',
        options: {
          method: 'POST',
        },
      };
    }

    return {
      url: '/admin/api/configs',
      options: {},
    };
  }

  function getPreferredApiKey(snapshot) {
    const apikeys = Array.isArray(snapshot && snapshot.apikeys) ? snapshot.apikeys : [];
    return typeof apikeys[0] === 'string' ? apikeys[0] : '';
  }

  function buildHelloTestRequest(snapshot) {
    const configuredModel = snapshot && snapshot.claude_code && typeof snapshot.claude_code.model === 'string'
      ? snapshot.claude_code.model.trim()
      : '';

    return {
      model: configuredModel || 'gpt-5.4',
      stream: true,
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'hello',
            },
          ],
        },
      ],
    };
  }

  function extractResponseSummary(payload) {
    if (payload && typeof payload.output_text === 'string' && payload.output_text.trim()) {
      return payload.output_text.trim();
    }

    const output = Array.isArray(payload && payload.output) ? payload.output : [];
    const textParts = [];

    for (const item of output) {
      const content = Array.isArray(item && item.content) ? item.content : [];
      for (const entry of content) {
        if (entry && typeof entry.text === 'string' && entry.text.trim()) {
          textParts.push(entry.text);
        }
      }
    }

    return textParts.join('').trim();
  }

  const exported = {
    buildConfigSnapshotRequest,
    buildJsonRequestOptions,
    parseResponsesApiResponse,
    getPreferredApiKey,
    buildHelloTestRequest,
    extractResponseSummary,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  globalScope.AirouterConfigAdmin = exported;
}(typeof globalThis !== 'undefined' ? globalThis : this));
