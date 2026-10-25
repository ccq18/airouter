// Test contract only. Never import production converters to generate expectations.
const CHAT = 'chat_completions', RESPONSES = 'responses', MESSAGES = 'messages';
const PROTOCOLS = [CHAT, RESPONSES, MESSAGES];
const HTTP_FILE = 'test/protocol-boundary-contract.integration.test.js';
const OPENAI = [CHAT, RESPONSES];
const NATIVE_ONLY_REASON = '产品契约仅支持原生协议；账号模型未显式支持入口协议时必须在发送前跳过，禁止跨协议转换。';
function nativeContract(cell) {
  return cell.source === cell.backend ? { ...cell, applicable: true } : { ...cell, applicable: false, exclusion: 'native_only', reason: NATIVE_ONLY_REASON };
}
const SCHEMA = { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'], additionalProperties: false };
const fn = { name: 'alpha', description: 'Fixture function', parameters: SCHEMA };
const tools = { [CHAT]: [{ type: 'function', function: fn }], [RESPONSES]: [{ type: 'function', ...fn }], [MESSAGES]: [{ name: fn.name, description: fn.description, input_schema: SCHEMA }] };
const points = [];
function point(id, patches, expected, options = {}) {
  points.push({ id, area: 'request', patches, expected, rule: 'all', modes: ['json', 'sse'], ...options });
}
function scalar(id, field, value, sources = PROTOCOLS, options = {}) {
  const patches = Object.fromEntries(sources.map(p => [p, { [field]: value }]));
  point(id, patches, patches, options);
}
function native(id, field, value, source, reason) { scalar(id, field, value, [source], { rule: 'native', reason }); }
const noMessages = 'Messages 与此 OpenAI 控制没有已核实的等价字段/生命周期，保留原生；拒绝回归另计。';
point('request.model', Object.fromEntries(PROTOCOLS.map(p => [p, {}])), Object.fromEntries(PROTOCOLS.map(p => [p, {}])));
point('request.message_history', { [CHAT]: { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'prior' }, { role: 'user', content: 'next' }] }, [RESPONSES]: { input: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'prior' }, { role: 'user', content: 'next' }] }, [MESSAGES]: { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'prior' }, { role: 'user', content: 'next' }] } }, Object.fromEntries(PROTOCOLS.map(p => [p, {}])), { semantic: 'history' });
point('request.instructions', { [CHAT]: { messages: [{ role: 'system', content: 'system-fixture' }, { role: 'user', content: '边界🙂' }] }, [RESPONSES]: { instructions: 'system-fixture' }, [MESSAGES]: { system: 'system-fixture' } }, Object.fromEntries(PROTOCOLS.map(p => [p, {}])), { semantic: 'instructions' });
scalar('request.temperature.zero', 'temperature', 0);
scalar('request.top_p.fraction', 'top_p', 0.75);
point('request.output_budget', { [CHAT]: { max_completion_tokens: 91 }, [RESPONSES]: { max_output_tokens: 91 }, [MESSAGES]: { max_tokens: 91 } }, { [CHAT]: { max_completion_tokens: 91 }, [RESPONSES]: { max_output_tokens: 91 }, [MESSAGES]: { max_tokens: 91 } });
point('request.legacy_max_tokens', { [CHAT]: { max_tokens: 73 } }, { [CHAT]: { max_tokens: 73 }, [RESPONSES]: { max_output_tokens: 73 }, [MESSAGES]: { max_tokens: 73 } });
for (const [field, value] of [['service_tier', 'default'], ['safety_identifier', 'subject-fixture'], ['user', 'legacy-subject'], ['metadata', { tenant: 'fixture', seed: 'application data' }], ['prompt_cache_key', 'cache-key-fixture'], ['prompt_cache_retention', '24h']]) {
  scalar('request.' + field, field, value, OPENAI, { rule: 'openai', reason: noMessages });
}
for (const [field, value] of [['mode', 'explicit'], ['ttl', '30m']]) point('request.prompt_cache_options.' + field,
  Object.fromEntries(OPENAI.map(p => [p, { prompt_cache_options: { [field]: value } }])),
  Object.fromEntries(OPENAI.map(p => [p, { prompt_cache_options: { [field]: value } }])), { rule: 'openai', reason: noMessages });
native('request.messages.metadata.user_id', 'metadata', { user_id: 'subject-fixture' }, MESSAGES, 'Messages 只定义 user_id 元数据，不能泛化为 OpenAI 任意 metadata 字典。');
point('request.verbosity', { [CHAT]: { verbosity: 'low' }, [RESPONSES]: { text: { verbosity: 'low' } } }, { [CHAT]: { verbosity: 'low' }, [RESPONSES]: { 'text.verbosity': 'low' } }, { rule: 'openai', reason: noMessages });
for (const type of ['text', 'json_object']) point('request.format.' + type,
  { [CHAT]: { response_format: { type } }, [RESPONSES]: { text: { format: { type } } } },
  { [CHAT]: { response_format: { type } }, [RESPONSES]: { 'text.format': { type } } }, { rule: 'openai', reason: noMessages });
for (const variant of ['name', 'description', 'strict', 'schema']) {
  const spec = { name: variant === 'name' ? 'distinct_fixture' : 'fixture', schema: SCHEMA,
    ...(variant === 'description' ? { description: 'Description must survive' } : {}), ...(variant === 'strict' ? { strict: false } : {}) };
  point('request.format.json_schema.' + variant,
    { [CHAT]: { response_format: { type: 'json_schema', json_schema: spec } }, [RESPONSES]: { text: { format: { type: 'json_schema', ...spec } } } },
    { [CHAT]: { response_format: { type: 'json_schema', json_schema: spec } }, [RESPONSES]: { 'text.format': { type: 'json_schema', ...spec } } }, { rule: 'openai', reason: noMessages });
}
point('request.tools.definition', Object.fromEntries(PROTOCOLS.map(p => [p, { tools: tools[p] }])), Object.fromEntries(PROTOCOLS.map(p => [p, { tools: tools[p] }])));
point('request.tools.strict.false', Object.fromEntries(PROTOCOLS.map(p => [p, { tools: p === CHAT ? [{ type: 'function', function: { ...fn, strict: false } }] : p === RESPONSES ? [{ type: 'function', ...fn, strict: false }] : [{ ...tools[p][0], strict: false }] }])),
  { [CHAT]: { tools: [{ type: 'function', function: { ...fn, strict: false } }] }, [RESPONSES]: { tools: [{ type: 'function', ...fn, strict: false }] }, [MESSAGES]: { tools: [{ ...tools[MESSAGES][0], strict: false }] } });
for (const mode of ['auto', 'none', 'required', 'named']) {
  const choice = { [CHAT]: mode === 'named' ? { type: 'function', function: { name: 'alpha' } } : mode,
    [RESPONSES]: mode === 'named' ? { type: 'function', name: 'alpha' } : mode,
    [MESSAGES]: mode === 'named' ? { type: 'tool', name: 'alpha' } : { type: mode === 'required' ? 'any' : mode } };
  point('request.tools.choice.' + mode, Object.fromEntries(PROTOCOLS.map(p => [p, { tools: tools[p], tool_choice: choice[p] }])), Object.fromEntries(PROTOCOLS.map(p => [p, { tools: tools[p], tool_choice: choice[p] }])), { fixture: mode === 'named' || mode === 'required' ? 'single-tool' : 'text' });
}
for (const enabled of [true, false]) {
  const patches = { [CHAT]: { tools: tools[CHAT], parallel_tool_calls: enabled, tool_choice: 'auto' }, [RESPONSES]: { tools: tools[RESPONSES], parallel_tool_calls: enabled, tool_choice: 'auto' }, [MESSAGES]: { tools: tools[MESSAGES], tool_choice: { type: 'auto', disable_parallel_tool_use: !enabled } } };
  point('request.tools.parallel.' + enabled, patches, patches);
}
point('request.stop', { [CHAT]: { stop: ['END', 'STOP'] }, [MESSAGES]: { stop_sequences: ['END', 'STOP'] } }, { [CHAT]: { stop: ['END', 'STOP'] }, [MESSAGES]: { stop_sequences: ['END', 'STOP'] } }, { rule: 'stop', reason: 'Responses 没有等价 stop 请求字段，不能删除停止条件。' });
for (const enabled of [true, false]) point('request.logprobs.' + enabled, { [CHAT]: { logprobs: enabled }, ...(enabled ? { [RESPONSES]: { include: ['message.output_text.logprobs'] } } : {}) },
  { [CHAT]: { logprobs: enabled }, [RESPONSES]: enabled ? { include: ['message.output_text.logprobs'] } : {} }, { rule: 'openai', reason: noMessages });
point('request.top_logprobs.zero', { [CHAT]: { logprobs: true, top_logprobs: 0 }, [RESPONSES]: { include: ['message.output_text.logprobs'], top_logprobs: 0 } },
  { [CHAT]: { logprobs: true, top_logprobs: 0 }, [RESPONSES]: { include: ['message.output_text.logprobs'], top_logprobs: 0 } }, { rule: 'openai', reason: noMessages });
for (const enabled of [true, false]) point('request.stream_options.include_usage.' + enabled, { [CHAT]: { stream_options: { include_usage: enabled } } },
  { [CHAT]: { stream_options: { include_usage: enabled } }, [RESPONSES]: {}, [MESSAGES]: {} }, { modes: ['sse'] });
point('request.stream_options.include_obfuscation.false', Object.fromEntries(OPENAI.map(p => [p, { stream_options: { include_obfuscation: false } }])),
  { [CHAT]: { stream_options: { include_obfuscation: false } }, [RESPONSES]: { stream_options: { include_obfuscation: false } }, [MESSAGES]: {} }, { modes: ['sse'] });
point('request.store.false', Object.fromEntries(OPENAI.map(p => [p, { store: false }])), Object.fromEntries(OPENAI.map(p => [p, { store: false }])), { rule: 'openai', reason: 'Messages 没有等价的 OpenAI store 请求字段。' });
for (const source of OPENAI) native('request.store.true.' + source, 'store', true, source, '服务端保存/续接归属不能由 store 字段跨协议迁移。');
// Explicit synchronous/no-truncation defaults have equivalent observable behavior.
point('request.background.false', { [RESPONSES]: { background: false } }, { [CHAT]: {}, [RESPONSES]: { background: false }, [MESSAGES]: {} });
point('request.truncation.disabled', { [RESPONSES]: { truncation: 'disabled' } }, { [CHAT]: {}, [RESPONSES]: { truncation: 'disabled' }, [MESSAGES]: {} });
point('request.reasoning.effort', { [CHAT]: { reasoning_effort: 'low' }, [RESPONSES]: { reasoning: { effort: 'low' } } }, { [CHAT]: { reasoning_effort: 'low' }, [RESPONSES]: { 'reasoning.effort': 'low' } }, { rule: 'openai', reason: 'Claude thinking budget 与 OpenAI effort 没有可直接等同的控制。' });
for (const [id, field, value] of [
  ['seed', 'seed', 17], ['presence_penalty', 'presence_penalty', 0], ['frequency_penalty', 'frequency_penalty', 0], ['n.multiple', 'n', 2], ['logit_bias', 'logit_bias', { 123: -1 }],
  ['prediction', 'prediction', { type: 'content', content: 'predicted' }], ['modalities', 'modalities', ['text', 'audio']], ['audio', 'audio', { voice: 'alloy', format: 'wav' }],
]) native('request.' + id, field, value, CHAT, '目标协议没有已核实的等价控制/完整输出链路；原生保留与跨协议拒绝分别报告。');
for (const id of ['request.modalities', 'request.audio']) {
  const p = points.find(point => point.id === id);
  p.patches[CHAT] = { modalities: ['text', 'audio'], audio: { voice: 'alloy', format: 'wav' } };
  p.expected[CHAT] = p.patches[CHAT];
}
for (const [id, field, value] of [['top_k', 'top_k', 7], ['thinking', 'thinking', { type: 'enabled', budget_tokens: 1024 }], ['cache_control', 'cache_control', { type: 'ephemeral', ttl: '1h' }], ['output_config', 'output_config', { format: { type: 'json_schema', schema: SCHEMA } }], ['output_format', 'output_format', { type: 'json_schema', schema: SCHEMA }]]) {
  const patch = { [field]: value, ...(field === 'thinking' ? { max_tokens: 2048 } : {}) };
  point('request.messages.' + id, { [MESSAGES]: patch }, { [MESSAGES]: patch }, { rule: 'native', reason: 'Messages 专有控制尚无已确认的完整等价映射，原生验证单列。' });
}
for (const [id, field, value] of [['background.true', 'background', true], ['truncation.auto', 'truncation', 'auto'], ['include.encrypted', 'include', ['reasoning.encrypted_content']]]) native('request.responses.' + id, field, value, RESPONSES, '后台、自动裁剪或私有状态不能通过改名、删字段或同步执行来伪造。');

function caseKey(id, source, backend, wire, stream) { return [id, source, backend, wire, stream ? 'sse' : 'json'].join('|'); }
function caseName(cell) { return `COMPAT ${caseKey(cell.point, cell.source, cell.backend, cell.wire, cell.stream)}`; }
function requestCells() {
  return points.flatMap(p => Object.keys(p.patches).flatMap(source => PROTOCOLS.flatMap(backend => p.modes.map(mode => {
    const cell = nativeContract({ point: p.id, source, backend, wire: mode, stream: mode === 'sse', file: HTTP_FILE, kind: 'acceptance' });
    cell.name = caseName(cell); return cell;
  }))));
}
const matrixFeatures = ['text-cache', 'refusal', 'truncation', 'usage-absent', 'usage-partial', 'parallel-tools-two-rounds'];
const usagePoints = ['input', 'output', 'total', 'cache-read', 'cache-write'];
function responseCells() {
  const cells = [];
  for (const source of PROTOCOLS) for (const backend of PROTOCOLS) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
    for (const feature of matrixFeatures) cells.push({ point: 'response.' + feature, source, backend, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true,
      name: `MATRIX ${feature}: ${source} -> ${backend}; ${wire} -> ${stream ? 'sse' : 'json'}` });
    for (const field of usagePoints) { const cell = { point: 'response.usage.' + field, source, backend, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true }; cell.name = caseName(cell); cells.push(cell); }
    cells.push({ point: 'response.id', source, backend, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true,
      name: `ID contract ${source} -> ${backend}; ${wire} -> ${stream ? 'sse' : 'json'} has no collisions and is stable throughout each stream` });
  }
  for (const protocol of PROTOCOLS) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
    const cell = { point: 'response.native.extensions', source: protocol, backend: protocol, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true };
    cell.name = protocol === MESSAGES ? caseName(cell) : `HTTP boundary native ${protocol}: ${wire} -> ${stream ? 'sse' : 'json'} preserves the complete request and response`;
    cells.push(cell);
  }
  for (const source of PROTOCOLS) for (const wire of ['json', 'sse']) for (const stream of [false, true]) {
    cells.push({ point: 'response.reasoning.public', source, backend: CHAT, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true,
      name: source === CHAT ? `PRODUCT acceptance supplier DeepSeek native Chat ${wire} -> ${stream ? 'sse' : 'json'} retains default reasoning and the answer` : `PRODUCT acceptance ordinary ${source} via DeepSeek Chat ${wire} -> ${stream ? 'sse' : 'json'} succeeds with default reasoning` });
    cells.push({ point: 'response.reasoning.opaque', source, backend: RESPONSES, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true,
      name: source === RESPONSES ? `PRODUCT acceptance native Responses ${wire} -> ${stream ? 'sse' : 'json'} retains the full supplier reasoning item` : `PRODUCT acceptance ordinary ${source} via default Responses reasoning ${wire} -> ${stream ? 'sse' : 'json'} remains usable without dropping opaque output` });
    cells.push({ point: 'response.reasoning.signed', source, backend: MESSAGES, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true,
      name: `PRODUCT acceptance signed Claude output ${source} -> messages; ${wire} -> ${stream ? 'sse' : 'json'} retains answer and separate source details` });
  }
  for (const source of OPENAI) for (const backend of OPENAI) for (const wire of ['json', 'sse']) for (const stream of [false, true]) cells.push({ point: 'response.logprobs', source, backend, wire, stream, file: HTTP_FILE, kind: 'acceptance', applicable: true,
    name: `PROBABILITY contract ${source} -> ${backend}; ${wire} -> ${stream ? 'sse' : 'json'} preserves complete token probabilities exactly once` });
  cells.push({ point: 'response.reasoning.native-lifecycle', source: RESPONSES, backend: RESPONSES, wire: 'json', stream: true, file: HTTP_FILE, kind: 'acceptance', applicable: true,
    name: 'NATIVE Responses JSON -> SSE emits complete reasoning summary/text lifecycle and final ciphertext without replay' });
  const existing = (point, file, name, source, backend, wire, stream = false, evidence = 'http') => cells.push({ point, file: 'test/' + file, name, source, backend, wire, stream, evidence, kind: 'acceptance', applicable: true });
  existing('stream.utf8.every-boundary', 'protocol-stream-regressions.test.js', 'multi-event CRLF SSE is invariant at every byte boundary and seeded random partitions', '*', '*', 'sse', true, 'unit');
  existing('state.native-store-continuation', 'responses-state.integration.test.js', 'native Responses default stores upstream and continues only confirmed stored responses', RESPONSES, RESPONSES, 'json');
  existing('state.native-store-continuation', 'responses-state.integration.test.js', 'native SSE keeps UTF8 bytes/cache details and confirmed storage binding', RESPONSES, RESPONSES, 'sse', true);
  existing('state.encrypted-full-history', 'protocol-reasoning.integration.test.js', 'native store:false encrypted reasoning can return with complete history but never grants previous_response_id', RESPONSES, RESPONSES, 'json');
  for (const source of PROTOCOLS) existing('state.native-reasoning-tool-history', 'protocol-reasoning.integration.test.js', `native reasoning tool history roundtrip preserves exact ${source} fields and pairing`, source, source, 'json');
  for (const [point, name] of [
    ['routing.free-pool.sync', 'automatic catalog changes preserve fixed routing and failed sync retains last valid cache'],
    ['routing.free-pool.recovery', 'paid exhaustion and source Go exhaustion allow free pool; recovery returns to higher priority'],
    ['routing.free-pool.capabilities', 'capability matching skips text-only pool for images and enforces concrete zero-price requests'],
    ['routing.free-pool.inner-failover', 'pool failures exhaust only inner candidates and then use next pool with diagnostic actual model trace'],
  ]) existing(point, 'free-pool.integration.test.js', name, '*', '*', 'json');
  return cells.map(nativeContract);
}
// Inventory is independent of app controls. Add fields here deliberately when
// adopting a new API contract; native-only fields cannot silently disappear.
const REQUEST_FIELD_INVENTORY = {
  [CHAT]: ['model', 'messages', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'metadata', 'service_tier', 'safety_identifier', 'user', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'verbosity', 'response_format', 'tools', 'tool_choice', 'parallel_tool_calls', 'stop', 'logprobs', 'top_logprobs', 'stream_options', 'store', 'reasoning_effort', 'seed', 'presence_penalty', 'frequency_penalty', 'n', 'logit_bias', 'prediction', 'modalities', 'audio'],
  [RESPONSES]: ['model', 'input', 'instructions', 'temperature', 'top_p', 'max_output_tokens', 'metadata', 'service_tier', 'safety_identifier', 'user', 'prompt_cache_key', 'prompt_cache_retention', 'prompt_cache_options', 'text', 'tools', 'tool_choice', 'parallel_tool_calls', 'include', 'top_logprobs', 'stream_options', 'store', 'background', 'truncation', 'reasoning'],
  [MESSAGES]: ['model', 'messages', 'system', 'temperature', 'top_p', 'max_tokens', 'metadata', 'tools', 'tool_choice', 'stop_sequences', 'top_k', 'thinking', 'cache_control', 'output_config', 'output_format'],
};
function validateCatalog() {
  const ids = new Set();
  for (const p of points) { if (ids.has(p.id)) throw Error('Duplicate compatibility point: ' + p.id); ids.add(p.id); }
  for (const source of PROTOCOLS) for (const field of REQUEST_FIELD_INVENTORY[source]) {
    if (field === 'model') continue; // Explicit model substitution in every HTTP case.
    if (!points.some(p => Object.hasOwn(p.patches[source] || {}, field))) throw Error('Uncovered request field: ' + source + '.' + field);
  }
  const keys = new Set();
  for (const cell of [...requestCells(), ...responseCells()]) { const key = caseKey(cell.point, cell.source, cell.backend, cell.wire, cell.stream); if (keys.has(key)) throw Error('Duplicate compatibility cell: ' + key); keys.add(key); if (!cell.applicable && !cell.reason) throw Error('Missing exclusion reason: ' + key); }
  return true;
}
module.exports = { CHAT, RESPONSES, MESSAGES, PROTOCOLS, HTTP_FILE, points, usagePoints, requestCells, responseCells, caseKey, caseName, REQUEST_FIELD_INVENTORY, validateCatalog };
