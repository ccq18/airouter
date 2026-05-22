function numberOrZero(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : 0;
}

function extractCachedTokens(usage = {}) {
  return numberOrZero(
    usage?.input_tokens_details?.cached_tokens ??
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.cache_read_input_tokens ??
    usage?.prompt_cache_hit_tokens
  );
}

function responsesUsageFromResponsesUsage(usage = {}) {
  const inputTokens = numberOrZero(usage.input_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || inputTokens + outputTokens;
  const inputDetails = {
    ...(usage.input_tokens_details && typeof usage.input_tokens_details === 'object' ? usage.input_tokens_details : {}),
    cached_tokens: extractCachedTokens(usage),
  };
  return {
    ...usage,
    input_tokens: inputTokens,
    input_tokens_details: inputDetails,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
  };
}

function responsesUsageFromChatUsage(usage = {}) {
  const inputTokens = numberOrZero(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = numberOrZero(usage.completion_tokens ?? usage.output_tokens);
  return responsesUsageFromResponsesUsage({
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberOrZero(usage.total_tokens) || inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: extractCachedTokens(usage),
    },
  });
}

function responsesUsageFromMessagesUsage(usage = {}) {
  const inputTokens = numberOrZero(usage.input_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  return responsesUsageFromResponsesUsage({
    ...usage,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: numberOrZero(usage.total_tokens) || inputTokens + outputTokens,
    input_tokens_details: {
      cached_tokens: extractCachedTokens(usage),
    },
  });
}

function chatUsageFromResponsesUsage(usage = {}) {
  const normalized = responsesUsageFromResponsesUsage(usage);
  return {
    prompt_tokens: normalized.input_tokens,
    prompt_tokens_details: {
      cached_tokens: extractCachedTokens(normalized),
    },
    completion_tokens: normalized.output_tokens,
    total_tokens: normalized.total_tokens || normalized.input_tokens + normalized.output_tokens,
  };
}

module.exports = {
  chatUsageFromResponsesUsage,
  extractCachedTokens,
  responsesUsageFromChatUsage,
  responsesUsageFromMessagesUsage,
  responsesUsageFromResponsesUsage,
};
