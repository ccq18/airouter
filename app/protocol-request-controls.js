/** Cross-protocol controls. Both runtime conversion and route preflight call this
 * through transformRequestForTarget; native requests bypass these rules.
 * Schema/metadata/arguments are application data, never recursively interpreted.
 */
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const COMMON = ['model', 'stream', 'tools', 'tool_choice', 'temperature', 'top_p', 'parallel_tool_calls', 'metadata', 'store', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options'];
const CONTROLS = {
  chat_completions: ['messages', 'max_tokens', 'max_completion_tokens', 'stop', 'n', 'seed', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'user', 'service_tier', 'safety_identifier', 'verbosity', 'response_format', 'logprobs', 'top_logprobs', 'stream_options', 'reasoning_effort', 'modalities', 'audio', 'prediction'],
  responses: ['input', 'instructions', 'max_output_tokens', 'previous_response_id', 'conversation', 'background', 'truncation', 'include', 'text', 'top_logprobs', 'stream_options', 'user', 'service_tier', 'safety_identifier', 'reasoning'],
  messages: ['system', 'messages', 'max_tokens', 'stop_sequences', 'top_k', 'thinking', 'output_format', 'output_config', 'cache_control'],
};
function mapCrossProtocolControls({ entryProtocol: from, targetProtocol: to, body, fail }) {
  const out = {}, openAiPair = from !== 'messages' && to !== 'messages';
  const reject = (path, reason) => { throw fail(`${path}: ${reason}`); };
  const keys = (value, allowed, path) => {
    if (!object(value)) return reject(path, '必须为对象');
    for (const key of Object.keys(value)) if (!allowed.includes(key)) reject(`${path}.${key}`, '未实现此控制字段的无损跨协议映射，请使用同协议候选');
  };
  for (const key of Object.keys(body)) if (![...COMMON, ...CONTROLS[from]].includes(key)) reject(key, '未识别的跨协议控制字段，请使用同协议候选');
  if (own(body, 'prompt_cache_options')) keys(body.prompt_cache_options, ['mode', 'ttl'], 'prompt_cache_options');
  if (own(body, 'reasoning_effort')) reject('reasoning_effort', 'effort 参数相似不代表私有 reasoning 输出可迁移；当前需要同协议候选');
  if (own(body, 'reasoning')) reject('reasoning', '未实现完整 reasoning 输出和私有状态跨协议迁移');
  for (const key of ['modalities', 'audio', 'prediction']) if (own(body, key)) reject(key, '未实现完整音频/预测输出链路，需要同协议候选');
  if (own(body, 'n') && body.n !== 1) reject('n', '目标协议只支持一次生成，不能拆为多次付费调用');
  // These controls are model-visible, even when a particular numeric value
  // happens to look like a default. Never silently normalize/delete them.
  for (const key of ['seed', 'presence_penalty', 'frequency_penalty', 'logit_bias']) if (own(body, key)) reject(key, '目标协议没有已核实的等价控制');
  if (from === 'chat_completions' && own(body, 'max_tokens') && own(body, 'max_completion_tokens')) reject('max_tokens/max_completion_tokens', '官方未定义同时提供时的优先级，请只提供一个输出上限');
  const maxKeys = from === 'chat_completions' ? ['max_tokens', 'max_completion_tokens'] : from === 'responses' ? ['max_output_tokens'] : ['max_tokens'];
  for (const key of maxKeys) if (body[key] != null && (!Number.isInteger(body[key]) || body[key] <= 0)) reject(key, '输出上限必须为正整数');
  if (from === 'responses' && to === 'chat_completions' && own(body, 'max_output_tokens')) out.max_completion_tokens = body.max_output_tokens;
  if (own(body, 'background') && body.background !== false && body.background !== null) reject('background', 'Chat 不支持异步后台任务');
  if (own(body, 'truncation') && body.truncation !== 'disabled' && body.truncation !== null) reject('truncation', '不能将服务端自动裁剪变成普通请求或自行裁剪历史');
  for (const key of ['previous_response_id', 'conversation']) if (body[key] != null) reject(key, '服务端上下文不能跨协议迁移');
  if (openAiPair) {
    for (const key of ['service_tier', 'safety_identifier', 'user', 'metadata']) if (own(body, key)) out[key] = copy(body[key]);
    if (from === 'chat_completions' && own(body, 'verbosity')) out.text = { verbosity: copy(body.verbosity) };
    if (from === 'responses' && own(body, 'text')) {
      keys(body.text, ['verbosity', 'format'], 'text');
      if (own(body.text, 'verbosity')) out.verbosity = copy(body.text.verbosity);
    }
    const format = from === 'chat_completions' ? body.response_format : body.text?.format;
    if (format != null) {
      const path = from === 'chat_completions' ? 'response_format' : 'text.format';
      if (!object(format)) reject(path, '必须为对象');
      if (!['text', 'json_object', 'json_schema'].includes(format.type)) reject(`${path}.type`, '未实现此输出格式');
      let targetFormat;
      if (format.type === 'json_schema') {
        keys(format, from === 'chat_completions' ? ['type', 'json_schema'] : ['type', 'name', 'description', 'strict', 'schema'], path);
        const spec = from === 'chat_completions' ? format.json_schema : format;
        keys(spec, from === 'chat_completions' ? ['name', 'description', 'strict', 'schema'] : ['type', 'name', 'description', 'strict', 'schema'], from === 'chat_completions' ? path + '.json_schema' : path);
        if (!own(spec, 'schema') || !object(spec.schema)) reject(path + '.schema', '目标需要原始 JSON Schema，不能编造空对象');
        const options = {};
        for (const key of ['name', 'description', 'strict', 'schema']) if (own(spec, key)) options[key] = copy(spec[key]);
        targetFormat = from === 'chat_completions' ? { type: 'json_schema', ...options } : { type: 'json_schema', json_schema: options };
      } else { keys(format, ['type'], path); targetFormat = copy(format); }
      if (to === 'responses') out.text = { ...(out.text || {}), format: targetFormat }; else out.response_format = targetFormat;
    }
    let includeLogprobs = false;
    if (from === 'responses' && own(body, 'include')) {
      if (!Array.isArray(body.include)) reject('include', '必须为数组');
      body.include.forEach((item, index) => { if (item !== 'message.output_text.logprobs') reject(`include[${index}]`, `无法保留 ${String(item)} 的响应/私有状态语义`); includeLogprobs = true; });
      if (includeLogprobs) out.logprobs = true;
    }
    if (from === 'chat_completions' && own(body, 'logprobs')) {
      if (typeof body.logprobs !== 'boolean') reject('logprobs', '必须为布尔值');
      includeLogprobs = body.logprobs;
      if (includeLogprobs) out.include = ['message.output_text.logprobs'];
    }
    if (own(body, 'top_logprobs')) {
      if (!Number.isInteger(body.top_logprobs) || body.top_logprobs < 0 || body.top_logprobs > 20) reject('top_logprobs', '必须为 0..20 的整数');
      if (!includeLogprobs) reject('top_logprobs', '必须同时请求 logprobs:true 或 include message.output_text.logprobs，不能猜测调用者意图');
      out.top_logprobs = body.top_logprobs;
    }
    if (own(body, 'stream_options')) {
      const allowed = from === 'chat_completions' ? ['include_usage', 'include_obfuscation'] : ['include_obfuscation'];
      keys(body.stream_options, allowed, 'stream_options');
      for (const [key, value] of Object.entries(body.stream_options)) if (typeof value !== 'boolean') reject(`stream_options.${key}`, '必须为布尔值');
      if (body.stream_options.include_obfuscation === true) reject('stream_options.include_obfuscation', '尚未实现下游重建流的混淆保证，请使用同协议候选');
      if (own(body.stream_options, 'include_obfuscation')) out.stream_options = { include_obfuscation: false };
      // include_usage is a gateway entry-stream control, not a Responses option.
    }
  } else {
    for (const key of ['service_tier', 'safety_identifier', 'user', 'metadata', 'verbosity', 'text', 'response_format', 'logprobs', 'top_logprobs', 'include', 'background', 'truncation', 'top_k']) if (own(body, key)) reject(key, 'Messages 与 OpenAI 没有已实现的等价控制');
    if (own(body, 'stream_options')) {
      // These describe the caller's reconstructed stream. include_usage can be
      // fulfilled at the Chat entry even when the backend is Messages.
      keys(body.stream_options, from === 'chat_completions' ? ['include_usage', 'include_obfuscation'] : ['include_obfuscation'], 'stream_options');
      for (const [key, value] of Object.entries(body.stream_options)) if (typeof value !== 'boolean') reject(`stream_options.${key}`, '必须为布尔值');
      if (body.stream_options.include_obfuscation === true) reject('stream_options.include_obfuscation', '尚未实现重建流的混淆保证，需要同协议候选');
    }
  }
  const messages = from === 'responses' ? body.input : body.messages;
  if (Array.isArray(body.tools)) body.tools.forEach((tool, index) => {
    if (!object(tool)) reject(`tools[${index}]`, '工具定义必须为对象');
    const path = `tools[${index}]`;
    if (from === 'messages') keys(tool, ['name', 'description', 'input_schema', 'strict', 'cache_control'], path);
    else if (tool.type === 'function') {
      keys(tool, from === 'chat_completions' ? ['type', 'function'] : ['type', 'name', 'description', 'parameters', 'strict'], path);
      if (from === 'chat_completions') keys(tool.function, ['name', 'description', 'parameters', 'strict'], path + '.function');
    } else reject(path + '.type', '未实现内置/自定义服务端工具的完整跨协议生命周期');
  });
  if (object(body.tool_choice)) {
    keys(body.tool_choice, from === 'messages' ? ['type', 'name', 'disable_parallel_tool_use'] : from === 'chat_completions' ? ['type', 'function'] : ['type', 'name'], 'tool_choice');
    if (from === 'chat_completions' && own(body.tool_choice, 'function')) keys(body.tool_choice.function, ['name'], 'tool_choice.function');
  }
  if (Array.isArray(messages)) messages.forEach((message, index) => {
    if (!object(message)) return;
    const path = (from === 'responses' ? 'input' : 'messages') + `[${index}]`;
    if (own(message, 'name') && message.type !== 'function_call') reject(path + '.name', '参与者名称是模型可见语义，目标没有等价字段');
    if (from === 'chat_completions') keys(message, ['role', 'content', 'tool_calls', 'tool_call_id', 'refusal', 'reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details', 'airouter_upstream_reasoning'], path);
    else if (from === 'messages') keys(message, ['role', 'content'], path);
    else {
      const allowed = message.type === 'reasoning' ? ['type', 'id', 'content', 'summary', 'encrypted_content', 'status', 'airouter_upstream_reasoning'] : message.type === 'function_call' ? ['type', 'id', 'call_id', 'name', 'arguments', 'status'] : message.type === 'function_call_output' ? ['type', 'id', 'call_id', 'output', 'status'] : ['type', 'id', 'role', 'content', 'status'];
      keys(message, allowed, path);
    }
    if (Array.isArray(message.content)) message.content.forEach((part, partIndex) => {
      if (!object(part)) return;
      const partPath = `${path}.content[${partIndex}]`;
      const fields = { reasoning_text: ['type', 'text'], thinking: ['type', 'thinking', 'signature', 'airouter_upstream_reasoning'], redacted_thinking: ['type', 'data', 'airouter_upstream_reasoning'], text: ['type', 'text', 'cache_control', 'prompt_cache_breakpoint'], input_text: ['type', 'text', 'prompt_cache_breakpoint'], output_text: ['type', 'text', 'annotations', 'logprobs', 'prompt_cache_breakpoint'], image_url: ['type', 'image_url', 'prompt_cache_breakpoint'], input_image: ['type', 'image_url', 'detail', 'file_id', 'prompt_cache_breakpoint'], image: ['type', 'source', 'cache_control'], refusal: ['type', 'refusal'], tool_use: ['type', 'id', 'name', 'input', 'cache_control'], tool_result: ['type', 'tool_use_id', 'content', 'is_error', 'cache_control'] }[part.type];
      if (fields) keys(part, fields, partPath);
      else reject(partPath + '.type', `未实现内容块 ${part.type} 的完整跨协议转换（文件、音频、私有状态等需要同协议）`);
      if (object(part.image_url)) keys(part.image_url, ['url', 'detail'], partPath + '.image_url');
      if (part.type === 'image' && own(part, 'source')) keys(part.source, ['type', 'url', 'media_type', 'data'], partPath + '.source');
      if (own(part, 'prompt_cache_breakpoint')) keys(part.prompt_cache_breakpoint, ['mode', 'ttl'], partPath + '.prompt_cache_breakpoint');
      if (part.annotations?.length) reject(partPath + '.annotations', '尚未实现历史引用标注的跨协议映射');
      if (part.logprobs?.length) reject(partPath + '.logprobs', '历史 token 统计不属于可迁移的输入控制');
    });
  });
  return out;
}
module.exports = { mapCrossProtocolControls };
