const { isDeepStrictEqual } = require('node:util');
const { UnsupportedProtocolFeatureError } = require('./protocol-bridge');

const clone = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function unsupported(path, reason) { throw new UnsupportedProtocolFeatureError(`${path}: ${reason}`); }
function immutable(target, key, value, path) {
  if (own(target, key) && !isDeepStrictEqual(target[key], value)) unsupported(path, '没有已知的无损合并规则；不能丢弃变化的扩展字段');
  target[key] = clone(value);
}
function indexOf(value, fallback, path) {
  const index = value ?? fallback;
  if (!Number.isInteger(index) || index < 0) unsupported(path, '必须是非负整数，多个候选不能共享隐式索引');
  return index;
}
function appendString(target, key, value, path) {
  if (value === null) { if (!own(target, key)) target[key] = null; return; }
  if (typeof value !== 'string') unsupported(path, '只支持字符串或 null 的原生分片');
  target[key] = (target[key] || '') + value;
}

// Source: OpenAI Chat Completion chunk schema. Choice and tool indexes are
// independent namespaces; unknown immutable extensions survive, ambiguous
// evolving extensions fail rather than being guessed or silently discarded.
function createNativeChatAccumulator(publicModel) {
  const top = {}, choices = new Map();
  let rawUsage, sawUsage = false;
  return {
    accept(payload) {
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.choices)) unsupported('choices', '原生 Chat chunk 必须包含 choices 数组');
      for (const [key, value] of Object.entries(payload)) {
        if (['choices', 'usage', 'object', 'model'].includes(key)) continue;
        immutable(top, key, value, key);
      }
      if (own(payload, 'usage')) {
        sawUsage = true;
        if (payload.usage !== null) {
          if (rawUsage !== undefined && !isDeepStrictEqual(rawUsage, payload.usage)) unsupported('usage', '多个非空 usage 不一致，不能猜测覆盖或累加');
          rawUsage = clone(payload.usage);
        }
      }
      for (const choice of payload.choices) {
        const index = indexOf(choice.index, payload.choices.length === 1 ? 0 : undefined, 'choices[].index');
        let state = choices.get(index);
        if (!state) { state = { value: { index, message: {} }, tools: new Map() }; choices.set(index, state); }
        const path = `choices[${index}]`;
        for (const [key, value] of Object.entries(choice)) {
          if (['index', 'delta', 'message', 'finish_reason', 'logprobs'].includes(key)) continue;
          immutable(state.value, key, value, `${path}.${key}`);
        }
        const delta = choice.delta || choice.message || {};
        if (state.value.finish_reason && Object.keys(delta).length) unsupported(`${path}.delta`, '该 choice 已结束后仍有内容');
        for (const [key, value] of Object.entries(delta)) {
          if (['content', 'refusal', 'reasoning_content', 'reasoning_text'].includes(key) || key === 'reasoning' && typeof value === 'string') appendString(state.value.message, key, value, `${path}.delta.${key}`);
          else if (key === 'tool_calls') {
            if (!Array.isArray(value)) unsupported(`${path}.delta.tool_calls`, '必须是数组');
            for (const tool of value) {
              const toolIndex = indexOf(tool.index, undefined, `${path}.delta.tool_calls[].index`);
              let call = state.tools.get(toolIndex);
              if (!call) { call = {}; state.tools.set(toolIndex, call); }
              for (const [toolKey, toolValue] of Object.entries(tool)) {
                if (toolKey === 'index') continue;
                if (toolKey === 'function') {
                  if (!toolValue || typeof toolValue !== 'object') unsupported(`${path}.tool_calls[${toolIndex}].function`, '必须是对象');
                  if (!call.function) call.function = {};
                  for (const [field, part] of Object.entries(toolValue)) {
                    if (field === 'arguments') appendString(call.function, field, part, `${path}.tool_calls[${toolIndex}].function.${field}`);
                    else immutable(call.function, field, part, `${path}.tool_calls[${toolIndex}].function.${field}`);
                  }
                } else immutable(call, toolKey, toolValue, `${path}.tool_calls[${toolIndex}].${toolKey}`);
              }
            }
          } else if (key === 'function_call') {
            if (!state.value.message.function_call) state.value.message.function_call = {};
            for (const [field, part] of Object.entries(value || {})) {
              if (['name', 'arguments'].includes(field)) appendString(state.value.message.function_call, field, part, `${path}.delta.function_call.${field}`);
              else immutable(state.value.message.function_call, field, part, `${path}.delta.function_call.${field}`);
            }
          } else if (key === 'annotations') {
            if (!Array.isArray(value)) unsupported(`${path}.delta.annotations`, '必须是数组');
            (state.value.message.annotations || (state.value.message.annotations = [])).push(...clone(value));
          } else if (key === 'audio' && value != null) unsupported(`${path}.delta.audio`, '音频分片格式互转尚未实现；请保持原生流式格式');
          else immutable(state.value.message, key, value, `${path}.delta.${key}`);
        }
        if (own(choice, 'logprobs')) {
          if (choice.logprobs === null) { if (!own(state.value, 'logprobs')) state.value.logprobs = null; }
          else {
            if (!state.value.logprobs) state.value.logprobs = {};
            for (const [key, value] of Object.entries(choice.logprobs)) {
              if (['content', 'refusal'].includes(key)) {
                if (value === null) { if (!own(state.value.logprobs, key)) state.value.logprobs[key] = null; }
                else if (Array.isArray(value)) state.value.logprobs[key] = [...(state.value.logprobs[key] || []), ...clone(value)];
                else unsupported(`${path}.logprobs.${key}`, '必须是数组或 null');
              } else immutable(state.value.logprobs, key, value, `${path}.logprobs.${key}`);
            }
          }
        }
        if (choice.finish_reason != null) {
          if (typeof choice.finish_reason !== 'string' || !choice.finish_reason) unsupported(`${path}.finish_reason`, '必须是非空字符串或 null');
          immutable(state.value, 'finish_reason', choice.finish_reason, `${path}.finish_reason`);
        }
      }
    },
    isComplete() { return choices.size > 0 && [...choices.values()].every(state => typeof state.value.finish_reason === 'string' && state.value.finish_reason); },
    build() {
      if (!this.isComplete()) unsupported('choices[].finish_reason', '原生 Chat 流缺少每个 choice 的有效终态');
      return { ...clone(top), object: 'chat.completion', model: publicModel,
        choices: [...choices.entries()].sort(([a], [b]) => a - b).map(([, state]) => ({ ...clone(state.value), message: { ...clone(state.value.message), ...(state.tools.size ? { tool_calls: [...state.tools.entries()].sort(([a], [b]) => a - b).map(([, call]) => clone(call)) } : {}) } })),
        ...(sawUsage ? { usage: rawUsage === undefined ? null : clone(rawUsage) } : {}) };
    },
  };
}

function nativeChatToSse(payload, publicModel, { includeUsage = false, includeObfuscation = false } = {}) {
  if (includeObfuscation) unsupported('stream_options.include_obfuscation', '网关 JSON→SSE 重建未实现随机填充；请保持原生 SSE 或省略该要求');
  if (!payload || !Array.isArray(payload.choices) || !payload.choices.length) unsupported('choices', '原生 Chat JSON 缺少 choices');
  const { choices, usage, ...top } = clone(payload), seen = new Set();
  top.object = 'chat.completion.chunk'; top.model = publicModel;
  const initial = [], terminal = [];
  for (const choice of choices) {
    const index = indexOf(choice.index, choices.length === 1 ? 0 : undefined, 'choices[].index');
    if (seen.has(index)) unsupported('choices[].index', '多个 choice 的索引重复');
    seen.add(index);
    if (!choice.message || typeof choice.message !== 'object' || typeof choice.finish_reason !== 'string' || !choice.finish_reason) unsupported(`choices[${index}]`, '消息或有效终态缺失');
    if (choice.message.audio != null) unsupported(`choices[${index}].message.audio`, '音频格式互转尚未实现；请保持原生 JSON');
    const { message, finish_reason, logprobs, ...extra } = choice;
    const delta = { ...message };
    if (Array.isArray(message.tool_calls)) delta.tool_calls = message.tool_calls.map((call, index) => ({ ...call, index }));
    initial.push({ ...extra, index, delta, finish_reason: null, ...(own(choice, 'logprobs') ? { logprobs } : {}) });
    terminal.push({ index, delta: {}, finish_reason, ...(own(choice, 'logprobs') ? { logprobs: null } : {}) });
  }
  const chunk = choices => ({ event: null, data: { ...top, choices, ...(includeUsage ? { usage: null } : {}) } });
  const output = [chunk(initial), chunk(terminal)];
  if (includeUsage) output.push({ event: null, data: { ...top, choices: [], ...(own(payload, 'usage') ? { usage } : { usage: null }) } });
  output.push({ event: null, raw: '[DONE]' });
  return output;
}

module.exports = { createNativeChatAccumulator, nativeChatToSse };
