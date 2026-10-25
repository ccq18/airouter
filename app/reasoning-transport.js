const { createHash, randomUUID } = require('node:crypto');
const { parseClientReasoning, parseSourceReasoning, REASONING_TRANSPORT } = require('./reasoning-content');
const { UnsupportedProtocolFeatureError } = require('./protocol-errors');
const clone = value => JSON.parse(JSON.stringify(value));
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sorted(value[key])]));
  return value;
}
const digest = value => createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
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
  const result = clone(block);
  if (result && typeof result === 'object') delete result.status;
  return result;
}
function nativeKey(authHash, publicModel, protocol, block) { return digest({ authHash, publicModel, protocol, block: nativeBlock(block) }); }
function isAssistant(item) { return Boolean(item && (item.role === 'assistant' || ['reasoning', 'function_call'].includes(item.type))); }

// Only provider-specific opaque state is bound. Plain reasoning is transported
// as explicit text and does not pin an account or defeat priority failover.
function createReasoningSession({ store, router, route, entryProtocol, body, authHash, publicModel }) {
  const inputHistory = history(entryProtocol, body);
  const prefixHash = digest(prefix(entryProtocol, body, inputHistory.length));
  const encountered = [], seenDuringScan = new Set(); let location = null, scanning = false, origin = null;
  function authorize(record, view, native = false) {
    if (!record || !record.part || record.part._ambiguous || record.auth_hash !== authHash || record.public_model !== publicModel || record.entry_protocol !== entryProtocol) throw contextError('思考状态未知、已过期或不属于当前调用者/入口；请发送可验证的完整历史');
    if (!native && record.viewHash !== digest(view)) throw contextError('思考文本/摘要与已签发的来源状态不一致，不能篡改后回传');
    const target = route.targets.find(target => target.id === record.target_id && target.config_id === record.config_id && target.protocol === record.protocol);
    const config = router.getConfig(record.config_id);
    if (!target || !config || (record.pool_fingerprint == null && target.model !== record.model) || (record.pool_fingerprint != null && (!router.poolEngine || digest(router.poolEngine.fingerprint(config)) !== digest(record.pool_fingerprint)))) throw contextError('思考状态的原账号、模型或免费池成员来源已变化');
    if (location !== null) {
      let validPrefix = false;
      for (let length = 0; length <= location; length++) {
        if (digest(prefix(entryProtocol, body, length)) === record.prefixHash && inputHistory.slice(length, location).every(isAssistant)) { validPrefix = true; break; }
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
    resolveNative(protocol, block) { return authorize(store?.resolveNativeReasoning(nativeKey(authHash, publicModel, protocol, block)), null, true); },
    inspect() {
      scanning = true;
      try {
        const items = entryProtocol === 'responses' ? (Array.isArray(body.input) ? body.input : []) : body.messages || [];
        for (const [index, item] of items.entries()) {
          location = index;
          if (entryProtocol === 'responses' && item?.type === 'reasoning') parseClientReasoning(entryProtocol, item, session);
          else if (item?.role === 'assistant' && entryProtocol === 'chat_completions') parseClientReasoning(entryProtocol, item, session);
          else if (item?.role === 'assistant' && Array.isArray(item.content)) for (const block of item.content) if (['thinking', 'redacted_thinking'].includes(block?.type)) parseClientReasoning(entryProtocol, block, session);
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
      const issued = new Map(), observed = new Map(), blocks = new Map(), chatChoices = new Map(); const group = randomUUID(); let order = 0, committed = false;
      const outerTarget = lease.outerTargetId || lease.target.id;
      const epoch = store?.getEpoch(lease.config.id, publicModel, outerTarget);
      const current = () => (!lease.isCurrent || lease.isCurrent()) && store?.getEpoch(lease.config.id, publicModel, outerTarget) === epoch;
      const details = part => ({ config_id: lease.config.id, target_id: outerTarget, model: lease.target.model, protocol: lease.target.protocol,
        auth_hash: authHash, public_model: publicModel, entry_protocol: entryProtocol, expected_epoch: epoch,
        pool_fingerprint: lease.pool ? lease.poolFingerprint : null, prefixHash, part });
      function collect(part) {
        if (!part.opaque) return;
        const key = nativeKey(authHash, publicModel, part.originProtocol, part.originBlock);
        if (!observed.has(key)) observed.set(key, { ...clone(part), _group: group, _order: order++ });
      }
      function from(protocol, raw) {
        try { for (const part of parseSourceReasoning(protocol, raw)) collect(part); }
        catch (error) {
          // Tracking never rewrites native payloads. An unrecognized provider
          // extension can pass through, but cannot acquire a verified replay binding.
          if (!(error instanceof UnsupportedProtocolFeatureError)) throw error;
        }
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
        observe(payload) {
          if (!payload || typeof payload !== 'object') return;
          const protocol = lease.target.protocol, full = payload.response || payload;
          if (protocol !== entryProtocol) return;
          if (protocol === 'responses') {
            if (['response.completed', 'response.incomplete'].includes(payload.type) || Array.isArray(payload.output)) for (const item of full.output || []) if (item.type === 'reasoning') from(protocol, item);
            if (payload.type === 'response.output_item.done' && payload.item?.type === 'reasoning') from(protocol, payload.item);
          } else if (protocol === 'messages') {
            if (Array.isArray(payload.content)) for (const block of payload.content) if (['thinking', 'redacted_thinking'].includes(block.type)) from(protocol, block);
            if (payload.type === 'content_block_start' && ['thinking', 'redacted_thinking'].includes(payload.content_block?.type)) blocks.set(payload.index, clone(payload.content_block));
            if (payload.type === 'content_block_delta' && blocks.has(payload.index)) {
              const block = blocks.get(payload.index), delta = payload.delta || {}, key = { thinking_delta: 'thinking', signature_delta: 'signature' }[delta.type];
              if (key) block[key] = (block[key] || '') + (delta[key] || '');
            }
            if (payload.type === 'content_block_stop' && blocks.has(payload.index)) from(protocol, blocks.get(payload.index));
          } else {
            for (const choice of payload.choices || []) {
              if (choice.message) { from(protocol, choice.message); continue; }
              const index = choice.index ?? 0;
              if (!chatChoices.has(index)) chatChoices.set(index, { raw: {}, details: new Map(), valid: true });
              const state = chatChoices.get(index), delta = choice.delta || {};
              for (const key of ['reasoning_content', 'reasoning', 'reasoning_text']) if (delta[key] != null) {
                if (typeof delta[key] !== 'string') state.valid = false;
                else state.raw[key] = (state.raw[key] || '') + delta[key];
              }
              if (delta.reasoning_details != null) {
                if (!Array.isArray(delta.reasoning_details)) state.valid = false;
                else for (const [position, detail] of delta.reasoning_details.entries()) {
                  const key = detail?.index ?? detail?.id ?? position;
                  if (!state.details.has(key)) state.details.set(key, {});
                  const merged = state.details.get(key);
                  for (const [name, value] of Object.entries(detail || {})) {
                    if (['text', 'summary'].includes(name) && typeof value === 'string') merged[name] = (merged[name] || '') + value;
                    else if (merged[name] !== undefined && digest(merged[name]) !== digest(value)) state.valid = false;
                    else merged[name] = clone(value);
                  }
                }
              }
              if (choice.finish_reason != null) {
                if (state.details.size) state.raw.reasoning_details = [...state.details.values()];
                if (state.valid) from(protocol, state.raw);
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
