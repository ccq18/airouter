const { createHash, randomUUID } = require('node:crypto');
const { parseSourceReasoning, hasBridgeReasoning, REASONING_TRANSPORT } = require('./reasoning-content');
const { UnsupportedProtocolFeatureError } = require('./protocol-errors');
const { validateConfigModels } = require('./routing-config');
const clone = value => JSON.parse(JSON.stringify(value));
class ExactNumber { constructor(source) { this.source = source; } }
function numberIdentity(source) {
  const [, sign, integer, fraction = '', exponent = '0'] = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(source);
  let digits = (integer + fraction).replace(/^0+/, '');
  if (!digits) return '0';
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailing);
  return sign + digits + 'e' + (BigInt(exponent) - BigInt(fraction.length) + BigInt(trailing));
}
function exactBody(raw, fallback) {
  if (raw == null) return fallback;
  return JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') throw contextError('当前运行时无法验证原生私有上下文的精确数值');
    return new ExactNumber(context.source);
  });
}
function typed(value) {
  if (value instanceof ExactNumber) return ['number', numberIdentity(value.source)];
  if (typeof value === 'number') return ['number', Number.isFinite(value) ? numberIdentity(String(value)) : String(value)];
  if (value === null) return ['null'];
  if (Array.isArray(value)) return ['array', value.map(typed)];
  if (value && typeof value === 'object') return ['object', Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, typed(value[key])])];
  return [typeof value, value];
}
const digest = value => createHash('sha256').update(JSON.stringify(typed(value))).digest('hex');
const preciseClone = value => value instanceof ExactNumber ? value : Array.isArray(value) ? value.map(preciseClone) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, preciseClone(item)])) : value;
const hasNumbers = value => typeof value === 'number' || value instanceof ExactNumber || value && typeof value === 'object' && Object.values(value).some(hasNumbers);
function contextError(message) { const error = new Error(message); error.name = 'ReasoningContextError'; error.code = 'upstream_context_unavailable'; error.statusCode = 409; return error; }
function content(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  if (!Array.isArray(value)) return value;
  return value.map(part => part && ['input_text', 'output_text', 'text'].includes(part.type) ? { ...part, type: 'text' } : part);
}
function history(entryProtocol, body) {
  let items = entryProtocol === 'responses' ? body.input : body.messages;
  if (typeof items === 'string') items = [{ role: 'user', content: items }];
  return (Array.isArray(items) ? items : []).map(item => {
    if (item && (item.role || item.type === 'message')) {
      const { id, status, type, ...rest } = item;
      return { ...rest, content: content(item.content) };
    }
    return item;
  });
}
function prefix(entryProtocol, body, length) {
  return { history: history(entryProtocol, body).slice(0, length), system: content(body.system ?? body.instructions ?? ''), tools: body.tools || [] };
}
function nativeBlock(block) {
  const result = preciseClone(block);
  if (result && typeof result === 'object') delete result.status;
  return result;
}
function nativeKey(authHash, publicModel, protocol, block) { return digest({ authHash, publicModel, protocol, block: nativeBlock(block) }); }
function isAssistant(item) { return Boolean(item && (item.role === 'assistant' || ['reasoning', 'function_call'].includes(item.type))); }

// Native replay does not need a canonical understanding of vendor state. Known
// public text stays unbound; an unrecognized reasoning shape is kept intact and
// can only return to the account/model/protocol that actually produced it.
function nativeParts(protocol, raw) {
  const block = protocol === 'chat_completions'
    ? Object.fromEntries(['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details'].filter(key => raw[key] != null).map(key => [key, clone(raw[key])]))
    : clone(raw);
  try { if (!parseSourceReasoning(protocol, raw).some(part => part.opaque)) return []; }
  catch (error) {
    if (!(error instanceof UnsupportedProtocolFeatureError)) throw error;
  }
  return Object.keys(block).length ? [{ type: 'reasoning', opaque: true, originProtocol: protocol, originBlock: block }] : [];
}
const identityBlock = (protocol, raw) => protocol === 'chat_completions'
  ? Object.fromEntries(['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details'].filter(key => raw[key] != null).map(key => [key, raw[key]])) : raw;

// Only provider-specific opaque state is bound. Plain reasoning is transported
// as explicit text and does not pin an account or defeat priority failover.
function createReasoningSession({ store, router, route, entryProtocol, body, rawBody, authHash, publicModel }) {
  const preciseBody = exactBody(rawBody, body);
  const inputHistory = history(entryProtocol, preciseBody);
  const prefixHash = digest(prefix(entryProtocol, preciseBody, inputHistory.length));
  const encountered = [], seenDuringScan = new Set(); let location = null, scanning = false, origin = null;
  function authorize(record, view, native = false) {
    if (!record || !record.part || record.part._ambiguous || record.auth_hash !== authHash || record.public_model !== publicModel || record.entry_protocol !== entryProtocol) throw contextError('思考状态未知、已过期或不属于当前调用者/入口；请发送可验证的完整历史');
    if (!native && record.viewHash !== digest(view)) throw contextError('思考文本/摘要与已签发的来源状态不一致，不能篡改后回传');
    const target = route.targets.find(target => target.id === record.target_id && target.config_id === record.config_id && target.enabled !== false);
    const config = router.getConfig(record.config_id);
    let model = null;
    if (config && target) {
      if (typeof router.getModel === 'function') model = router.getModel(config.id, target.model);
      else try { model = validateConfigModels(config.models, { preset: config.preset }).find(model => model.id === target.model); } catch (_) { /* invalid catalog cannot own private state */ }
    }
    if (!target || !config || config.enabled === false || route.enabled === false || route.entry_protocols && !route.entry_protocols.includes(entryProtocol)
      || record.protocol !== entryProtocol || !model?.protocols?.includes(entryProtocol)
      || (record.pool_fingerprint == null && target.model !== record.model)
      || (record.pool_fingerprint != null && (!router.poolEngine || digest(router.poolEngine.fingerprint(config)) !== digest(record.pool_fingerprint)))) throw contextError('思考状态的原账号、模型、支持协议或免费池成员来源已变化');
    if (location !== null) {
      let validPrefix = false;
      for (let length = 0; length <= location; length++) {
        if (digest(prefix(entryProtocol, preciseBody, length)) === record.prefixHash && inputHistory.slice(length, location).every(isAssistant)) { validPrefix = true; break; }
      }
      if (!validPrefix) throw contextError('思考状态的 system、tools 或前置消息已变化，不能续用旧状态');
    }
    const nextOrigin = { targetId: record.target_id, configId: record.config_id, model: record.model, protocol: record.protocol };
    if (origin && digest(origin) !== digest(nextOrigin)) throw contextError('同一请求的思考状态来自不同账号、模型或协议，不能合并迁移');
    origin = nextOrigin;
    if (scanning) {
      const key = record.token || record.native_key;
      if (seenDuringScan.has(key)) throw contextError('同一不透明思考块不能在历史中重复回放');
      seenDuringScan.add(key); encountered.push(record);
    }
    return clone(record.part);
  }
  const session = {
    resolve(token, view) { return authorize(store?.resolveReasoning(token), view); },
    resolveNative(protocol, block, exactBlock = block) { return authorize(store?.resolveNativeReasoning(nativeKey(authHash, publicModel, protocol, exactBlock)), null, true); },
    inspect() {
      if (hasBridgeReasoning(body)) throw contextError('旧跨协议思考标记不再支持；请使用原生协议和新的完整历史');
      scanning = true;
      try {
        const items = entryProtocol === 'responses' ? (Array.isArray(body.input) ? body.input : []) : body.messages || [];
        const preciseItems = entryProtocol === 'responses' ? (Array.isArray(preciseBody.input) ? preciseBody.input : []) : preciseBody.messages || [];
        for (const [index, item] of items.entries()) {
          location = index;
          const inspectBlock = (block, exact) => { for (const part of nativeParts(entryProtocol, block)) session.resolveNative(entryProtocol, part.originBlock, identityBlock(entryProtocol, exact)); };
          if (entryProtocol === 'responses' && item?.type === 'reasoning' || item?.role === 'assistant' && entryProtocol === 'chat_completions') inspectBlock(item, preciseItems[index]);
          else if (item?.role === 'assistant' && Array.isArray(item.content)) for (const [offset, block] of item.content.entries()) if (['thinking', 'redacted_thinking'].includes(block?.type)) inspectBlock(block, preciseItems[index].content[offset]);
        }
        const positions = new Map();
        for (const record of encountered) {
          const group = record.part._group;
          if (group && positions.has(group) && positions.get(group) >= record.part._order) throw contextError('思考状态块的原始顺序已变化');
          if (group) positions.set(group, record.part._order);
        }
      } finally { scanning = false; location = null; }
      Object.defineProperty(body, REASONING_TRANSPORT, { value: session, enumerable: false });
      return origin;
    },
    forLease(lease) {
      const issued = new Map(), observed = new Map(), blocks = new Map(), exactBlocks = new Map(), chatChoices = new Map(); const group = randomUUID(); let order = 0, committed = false;
      const outerTarget = lease.outerTargetId || lease.target.id;
      const epoch = store?.getEpoch(lease.config.id, publicModel, outerTarget);
      const current = () => (!lease.isCurrent || lease.isCurrent()) && store?.getEpoch(lease.config.id, publicModel, outerTarget) === epoch;
      const details = part => ({ config_id: lease.config.id, target_id: outerTarget, model: lease.target.model, protocol: lease.target.protocol,
        auth_hash: authHash, public_model: publicModel, entry_protocol: entryProtocol, expected_epoch: epoch,
        pool_fingerprint: lease.pool ? lease.poolFingerprint : null, prefixHash, part });
      function collect(part, exact) {
        if (!part.opaque) return;
        // Without source tokens a parsed number cannot prove its identity, even
        // when it is finite or an integer (underflow and rounding both collide).
        if (!exact && hasNumbers(part.originBlock)) return;
        const key = nativeKey(authHash, publicModel, part.originProtocol, exact || part.originBlock);
        if (!observed.has(key)) observed.set(key, { ...clone(part), _group: group, _order: order++ });
      }
      function from(protocol, raw, exact) {
        for (const part of nativeParts(protocol, raw)) collect(part, exact && identityBlock(protocol, exact));
      }
      const transport = {
        resolve: session.resolve, resolveNative: session.resolveNative,
        issue(part, view) {
          if (!store || !current()) throw new UnsupportedProtocolFeatureError('账号或路由已变化，迟到思考状态不能重新生效');
          const key = digest({ part, view });
          if (issued.has(key)) return issued.get(key).token;
          const record = store.issueReasoning({ ...details({ ...clone(part), _group: group, _order: order++ }), viewHash: digest(view), pending: true });
          if (!record) throw new UnsupportedProtocolFeatureError('思考状态超出传输缓存上限，无法保证可验证回传');
          issued.set(key, record); return record.token;
        },
        observe(payload, rawJSON) {
          if (!payload || typeof payload !== 'object') return;
          const exact = rawJSON == null ? null : exactBody(rawJSON);
          const protocol = lease.target.protocol, full = payload.response || payload;
          const exactFull = exact && (exact.response || exact);
          if (protocol !== entryProtocol) return;
          if (protocol === 'responses') {
            if (['response.completed', 'response.incomplete'].includes(payload.type) || Array.isArray(payload.output)) for (const [index, item] of (full.output || []).entries()) if (item.type === 'reasoning') from(protocol, item, exactFull?.output?.[index]);
            if (payload.type === 'response.output_item.done' && payload.item?.type === 'reasoning') from(protocol, payload.item, exact?.item);
          } else if (protocol === 'messages') {
            const blockIndex = digest(exact?.index ?? payload.index);
            if (Array.isArray(payload.content)) for (const [index, block] of payload.content.entries()) if (['thinking', 'redacted_thinking'].includes(block.type)) from(protocol, block, exact?.content?.[index]);
            if (payload.type === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(payload.content_block?.type)) {
              blocks.set(blockIndex, clone(payload.content_block));
              if (exact?.content_block) exactBlocks.set(blockIndex, preciseClone(exact.content_block));
            }
            if (payload.type === 'content_block_delta' && blocks.has(blockIndex)) {
              const block = blocks.get(blockIndex), delta = payload.delta || {}, key = { thinking_delta: 'thinking', signature_delta: 'signature' }[delta.type];
              if (key) {
                block[key] = (block[key] || '') + (delta[key] || '');
                if (exactBlocks.has(blockIndex)) exactBlocks.get(blockIndex)[key] = block[key];
              }
            }
            if (payload.type === 'content_block_stop' && blocks.has(blockIndex)) from(protocol, blocks.get(blockIndex), exactBlocks.get(blockIndex));
          } else {
            for (const [offset, choice] of (payload.choices || []).entries()) {
              const exactChoice = exact?.choices?.[offset];
              if (choice.message) { from(protocol, choice.message, exactChoice?.message); continue; }
              const index = digest(exactChoice?.index ?? choice.index ?? 0);
              if (!chatChoices.has(index)) chatChoices.set(index, { raw: {}, exactRaw: {}, exactDetails: new Map(), details: new Map(), valid: true, exact: true });
              const state = chatChoices.get(index), delta = choice.delta || {};
              if (!exactChoice) state.exact = false;
              const exactDelta = exactChoice?.delta || delta;
              for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) if (delta[key] != null) {
                if (typeof delta[key] === 'string' && (state.raw[key] === undefined || typeof state.raw[key] === 'string')) state.raw[key] = state.exactRaw[key] = (state.raw[key] || '') + delta[key];
                else if (state.raw[key] === undefined) { state.raw[key] = clone(delta[key]); state.exactRaw[key] = preciseClone(exactDelta[key]); }
                else if (digest(state.exactRaw[key]) !== digest(exactDelta[key])) state.valid = false;
              }
              if (delta.reasoning_details != null) {
                if (!Array.isArray(delta.reasoning_details)) {
                  if (state.details.size || state.raw.reasoning_details !== undefined && digest(state.exactRaw.reasoning_details) !== digest(exactDelta.reasoning_details)) state.valid = false;
                  else { state.raw.reasoning_details = clone(delta.reasoning_details); state.exactRaw.reasoning_details = preciseClone(exactDelta.reasoning_details); }
                } else if (state.raw.reasoning_details !== undefined) state.valid = false;
                else for (const [position, detail] of delta.reasoning_details.entries()) {
                  const exactDetail = exactDelta.reasoning_details?.[position] || detail;
                  const key = digest(exactDetail?.index ?? detail?.index ?? exactDetail?.id ?? detail?.id ?? position);
                  if (!state.details.has(key)) { state.details.set(key, {}); state.exactDetails.set(key, {}); }
                  const merged = state.details.get(key), exactMerged = state.exactDetails.get(key);
                  for (const [name, value] of Object.entries(detail || {})) {
                    if (['text', 'summary'].includes(name) && typeof value === 'string') merged[name] = exactMerged[name] = (merged[name] || '') + value;
                    else if (merged[name] !== undefined && digest(exactMerged[name]) !== digest(exactDetail[name])) state.valid = false;
                    else { merged[name] = clone(value); exactMerged[name] = preciseClone(exactDetail[name]); }
                  }
                }
              }
              if (choice.finish_reason != null) {
                if (state.details.size) { state.raw.reasoning_details = [...state.details.values()]; state.exactRaw.reasoning_details = [...state.exactDetails.values()]; }
                if (state.valid) from(protocol, state.raw, state.exact ? state.exactRaw : null);
                chatChoices.delete(index);
              }
            }
          }
        },
        commit() {
          if (committed || !store || !current()) return;
          committed = true;
          for (const record of issued.values()) store.activateReasoning(record.token);
          for (const [key, part] of observed) {
            const old = store.resolveNativeReasoning(key);
            const ambiguous = old && (old.part?._ambiguous || old.config_id !== lease.config.id || old.model !== lease.target.model || old.protocol !== lease.target.protocol);
            store.registerNativeReasoning(key, details(ambiguous ? { ...part, _ambiguous: true } : part));
          }
        },
      };
      return transport;
    },
  };
  return session;
}
module.exports = { createReasoningSession, nativeKey, digest };
