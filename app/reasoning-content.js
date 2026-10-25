const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { UnsupportedProtocolFeatureError } = require('./protocol-errors');
const REASONING_TRANSPORT = Symbol.for('airouter.reasoningTransport');
const REASONING_OPAQUE_PREFIX = 'airouter-state-v1:';
const REASONING_TEXT_PREFIX = 'airouter-text-v1:';
const BRIDGE_FORMAT = 'airouter-bridge-v1';
const CHAT_REASONING_ALIASES = ['reasoning_content', 'reasoning', 'reasoning_text'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const clone = value => JSON.parse(JSON.stringify(value));
function fail(message) { throw new UnsupportedProtocolFeatureError(message); }
function summary(value) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => !object(item) || item.type !== 'summary_text' || typeof item.text !== 'string' || Object.keys(item).some(key => !['type', 'text'].includes(key)))) fail('reasoning.summary: 只支持原始 summary_text 内容块');
  return clone(value);
}
function textContent(value) {
  if (value == null) return '';
  if (!Array.isArray(value) || value.some(item => !object(item) || item.type !== 'reasoning_text' || typeof item.text !== 'string' || Object.keys(item).some(key => !['type', 'text'].includes(key)))) fail('reasoning.content: 只支持 reasoning_text，不能降级未知内容');
  return value.map(item => item.text).join('');
}
function part(protocol, raw, text = '', summaries = [], opaque = false) {
  return { type: 'reasoning', text, summary: summaries, originProtocol: protocol, originBlock: clone(raw), opaque };
}
function parseSourceReasoning(protocol, raw) {
  if (!object(raw)) return [];
  if (protocol === 'chat_completions') {
    const result = [];
    const detailText = [];
    if (raw.reasoning_details != null) {
      if (!Array.isArray(raw.reasoning_details)) fail('reasoning_details 必须为数组');
      for (const detail of raw.reasoning_details) {
        if (!object(detail)) fail('reasoning_details 内容无效');
        const source = { reasoning_details: [clone(detail)] };
        if (detail.type === 'reasoning.encrypted') {
          if (typeof detail.data !== 'string') fail('reasoning_details.data 必须为密文字串');
          result.push(part(protocol, source, '', [], true));
        } else if (detail.type === 'reasoning.text') {
          if (detail.text != null && typeof detail.text !== 'string') fail('reasoning_details.text 必须为字符串');
          const text = detail.text || ''; detailText.push(text);
          result.push(part(protocol, source, text, [], typeof detail.signature === 'string' && detail.signature !== ''));
        } else if (detail.type === 'reasoning.summary') {
          if (typeof detail.summary !== 'string') fail('reasoning_details.summary 必须为字符串');
          result.push(part(protocol, source, '', [{ type: 'summary_text', text: detail.summary }]));
        } else fail(`reasoning_details.type: 未实现 ${detail.type}`);
      }
    }
    const aliases = CHAT_REASONING_ALIASES.filter(key => raw[key] !== undefined && raw[key] !== null && raw[key] !== '');
    if (aliases.some(key => typeof raw[key] !== 'string')) fail('reasoning_content/reasoning/reasoning_text: 非文本私有结构没有通用映射');
    if (aliases.some(key => raw[key] !== raw[aliases[0]])) fail('reasoning_content/reasoning/reasoning_text: 文本别名冲突');
    if (aliases.length) {
      const text = raw[aliases[0]];
      if (detailText.length && detailText.join('') !== text) fail('reasoning_content 与 reasoning_details 文本冲突');
      if (!detailText.length) result.unshift(part(protocol, Object.fromEntries(aliases.map(key => [key, raw[key]])), text));
    }
    return result;
  }
  if (protocol === 'responses') {
    if (raw.type !== 'reasoning') return [];
    const text = textContent(raw.content), summaries = summary(raw.summary);
    if (raw.encrypted_content != null && typeof raw.encrypted_content !== 'string') fail('reasoning.encrypted_content 必须为字符串');
    const opaque = Boolean(raw.encrypted_content) || (!text && !summaries.length && Boolean(raw.id));
    return [part(protocol, raw, text, summaries, opaque)];
  }
  if (protocol === 'messages') {
    if (raw.type === 'redacted_thinking') {
      if (typeof raw.data !== 'string') fail('redacted_thinking.data 必须为字符串');
      return [part(protocol, raw, '', [], true)];
    }
    if (raw.type !== 'thinking') return [];
    if (typeof raw.thinking !== 'string' || own(raw, 'signature') && typeof raw.signature !== 'string') fail('thinking: 文本或签名结构无效');
    return [part(protocol, raw, '', raw.thinking ? [{ type: 'summary_text', text: raw.thinking }] : [], own(raw, 'signature'))];
  }
  fail(`不支持的 reasoning 来源协议: ${protocol}`);
}
function visible(part) { return part.text || (part.summary || []).map(item => item.text).join('\n'); }
function provenance(value) { return { ...clone(value.originBlock), protocol: value.originProtocol }; }
function publicView(values) { return { text: values.map(value => value.text || '').join(''), summary: values.flatMap(value => value.summary || []) }; }
function validateProvenance(raw, values) {
  if (!own(raw, 'airouter_upstream_reasoning')) return values;
  const supplied = raw.airouter_upstream_reasoning;
  const entries = Array.isArray(supplied) ? supplied : [supplied];
  if (!entries.length) fail('reasoning provenance: 来源扩展不能为空');
  const opaque = values.filter(value => value.opaque), claimed = [];
  for (const entry of entries) {
    if (!object(entry) || !['chat_completions', 'responses', 'messages'].includes(entry.protocol)) fail('reasoning provenance: 来源协议无效');
    const { protocol, ...source } = entry;
    const sourceParts = parseSourceReasoning(protocol, source);
    if (!sourceParts.length) fail('reasoning provenance: 缺少来源思考字段');
    for (const value of sourceParts) {
      if (value.opaque) {
        const index = opaque.findIndex(original => isDeepStrictEqual(provenance(original), provenance(value)));
        if (index < 0) fail('reasoning provenance: 来源签名或密文被篡改/不匹配');
        claimed.push(opaque.splice(index, 1)[0]);
      } else claimed.push(value);
    }
  }
  if (opaque.length || !isDeepStrictEqual(publicView(claimed), publicView(values))) fail('reasoning provenance: 来源公开思考与可见内容不匹配');
  return claimed;
}
function viewFor(protocol, wire) {
  if (protocol === 'responses') return { protocol, type: 'reasoning', content: clone(wire.content || []), summary: clone(wire.summary || []) };
  if (protocol === 'messages') return { protocol, type: wire.type, ...(wire.type === 'thinking' ? { thinking: wire.thinking } : {}) };
  return { protocol, type: 'reasoning.encrypted', format: BRIDGE_FORMAT, text: wire.text || '', summary: clone(wire.summary || []) };
}
function publicMarker(value) {
  return REASONING_TEXT_PREFIX + Buffer.from(JSON.stringify({ version: 1, text: value.text || '', summary: value.summary || [], originProtocol: value.originProtocol, originBlock: value.originBlock })).toString('base64url');
}
function decodePublic(marker, thinking) {
  const bytes = marker.slice(REASONING_TEXT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(bytes) || Buffer.from(bytes, 'base64url').toString('base64url') !== bytes) fail('thinking.signature: 无效公开思考标记');
  let decoded; try { decoded = JSON.parse(Buffer.from(bytes, 'base64url').toString('utf8')); } catch (_) { fail('thinking.signature: 无效公开思考标记'); }
  if (!object(decoded) || decoded.version !== 1 || typeof decoded.text !== 'string' || Object.keys(decoded).some(key => !['version', 'text', 'summary', 'originProtocol', 'originBlock'].includes(key))) fail('thinking.signature: 无效公开思考标记');
  const result = part('chat_completions', {}, decoded.text, summary(decoded.summary));
  result.originBlock = { ...(result.text ? { reasoning_content: result.text } : {}), ...(result.summary.length ? { reasoning_details: result.summary.map(item => ({ type: 'reasoning.summary', summary: item.text, format: BRIDGE_FORMAT })) } : {}) };
  if (visible(result) !== thinking) fail('thinking: 公开思考文本与标记不匹配，不能篡改后回传');
  if (decoded.originProtocol !== undefined || decoded.originBlock !== undefined) {
    const originals = validateProvenance({ airouter_upstream_reasoning: { ...decoded.originBlock, protocol: decoded.originProtocol } }, [result]);
    if (originals.length !== 1 || originals[0].opaque) fail('thinking.signature: 公开标记不能携带私有状态');
    return originals[0];
  }
  return result;
}
function renderReasoning(protocol, value, transport) {
  if (value.type !== 'reasoning') fail('reasoning: canonical 内容无效');
  if (value.opaque && protocol === value.originProtocol) return clone(value.originBlock);
  let wire;
  if (protocol === 'responses') wire = { id: value.originProtocol === 'responses' && value.originBlock.id || `rs_airouter_${randomUUID().replaceAll('-', '')}`, type: 'reasoning', summary: clone(value.summary || []), ...(value.text ? { content: [{ type: 'reasoning_text', text: value.text }] } : {}), status: 'completed' };
  else if (protocol === 'messages') wire = value.opaque && value.originBlock.type === 'redacted_thinking' ? { type: 'redacted_thinking' } : { type: 'thinking', thinking: visible(value) };
  else if (protocol === 'chat_completions') {
    if (!value.opaque) return { ...(value.text ? { reasoning_content: value.text } : {}), ...(value.summary?.length ? { reasoning_details: value.summary.map(item => ({ type: 'reasoning.summary', summary: item.text, format: BRIDGE_FORMAT })) } : {}), ...(protocol !== value.originProtocol ? { airouter_upstream_reasoning: provenance(value) } : {}) };
    wire = { type: 'reasoning.encrypted', format: BRIDGE_FORMAT, text: value.text || '', summary: clone(value.summary || []) };
  } else fail(`不支持的 reasoning 目标协议: ${protocol}`);
  if (value.opaque) {
    if (typeof transport?.issue !== 'function') fail('reasoning: 缺少可验证的来源绑定/opaque 运输上下文');
    const token = transport.issue(value, viewFor(protocol, wire));
    if (typeof token !== 'string' || !token.startsWith(REASONING_OPAQUE_PREFIX)) fail('reasoning: 运输令牌缺少明确网关命名空间');
    if (protocol === 'responses') wire.encrypted_content = token;
    else if (protocol === 'messages') wire[wire.type === 'thinking' ? 'signature' : 'data'] = token;
    else { wire.data = token; return { reasoning_details: [wire], airouter_upstream_reasoning: provenance(value) }; }
  } else if (protocol === 'messages') wire.signature = publicMarker(value);
  if (protocol !== value.originProtocol) wire.airouter_upstream_reasoning = provenance(value);
  return wire;
}
function resolve(transport, token, view) {
  if (typeof transport?.resolve !== 'function') fail('reasoning: opaque 来源归属/上下文不可用');
  const result = transport.resolve(token, view);
  if (!result || result.type !== 'reasoning') fail('reasoning: opaque 来源归属无效');
  return clone(result);
}
function native(transport, protocol, value, raw, view) {
  if (!value.opaque) return value;
  const resolved = transport?.resolveNative?.(protocol, raw, view);
  if (!resolved || resolved.type !== 'reasoning') fail('reasoning: 原生 opaque 来源归属/上下文不可验证');
  return clone(resolved);
}
function parseClientReasoning(protocol, raw, transport) {
  const checked = values => validateProvenance(raw, values);
  const clean = { ...raw }; delete clean.airouter_upstream_reasoning;
  if (protocol === 'messages' && raw?.type === 'thinking' && typeof raw.signature === 'string' && raw.signature.startsWith(REASONING_TEXT_PREFIX)) {
    const decoded = decodePublic(raw.signature, raw.thinking);
    if (own(raw, 'airouter_upstream_reasoning') && !isDeepStrictEqual(raw.airouter_upstream_reasoning, provenance(decoded))) fail('reasoning provenance: 公开标记的原始来源字段被篡改');
    return checked([decoded]);
  }
  if (protocol === 'messages' && ['thinking', 'redacted_thinking'].includes(raw?.type)) {
    const token = raw.type === 'thinking' ? raw.signature : raw.data;
    if (typeof token === 'string' && token.startsWith(REASONING_OPAQUE_PREFIX)) return checked([resolve(transport, token, viewFor(protocol, raw))]);
  }
  if (protocol === 'responses' && raw?.type === 'reasoning' && typeof raw.encrypted_content === 'string' && raw.encrypted_content.startsWith(REASONING_OPAQUE_PREFIX)) return checked([resolve(transport, raw.encrypted_content, viewFor(protocol, raw))]);
  if (protocol === 'chat_completions' && Array.isArray(raw?.reasoning_details)) {
    const output = [], plain = [];
    for (const detail of raw.reasoning_details) {
      if (detail?.format === BRIDGE_FORMAT && detail.type === 'reasoning.encrypted') output.push(resolve(transport, detail.data, viewFor(protocol, detail)));
      else plain.push(detail);
    }
    const other = { ...clean, reasoning_details: plain };
    return checked([...output, ...parseSourceReasoning(protocol, other).map(value => native(transport, protocol, value, value.originBlock, viewFor(protocol, value.originBlock)))]);
  }
  return checked(parseSourceReasoning(protocol, clean).map(value => native(transport, protocol, value, value.originBlock, viewFor(protocol, clean))));
}
function hasBridgeReasoning(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.some(message => own(message, 'airouter_upstream_reasoning') || Array.isArray(message.content) && message.content.some(block => own(block, 'airouter_upstream_reasoning')))) return true;
  if (Array.isArray(body.input) && body.input.some(item => own(item, 'airouter_upstream_reasoning'))) return true;
  if (messages.some(message => message.reasoning_details?.some(detail => detail?.format === BRIDGE_FORMAT))) return true;
  if (messages.some(message => Array.isArray(message.content) && message.content.some(block => typeof block?.signature === 'string' && /^airouter-(state|text)-v1:/.test(block.signature) || typeof block?.data === 'string' && block.data.startsWith(REASONING_OPAQUE_PREFIX)))) return true;
  return Array.isArray(body.input) && body.input.some(item => item?.type === 'reasoning' && typeof item.encrypted_content === 'string' && item.encrypted_content.startsWith(REASONING_OPAQUE_PREFIX));
}
function restoreReasoning(protocol, value) {
  if (value.opaque) {
    if (value.originProtocol !== protocol) fail('reasoning: opaque 状态只能还原给原来源协议，不能迁移');
    return clone(value.originBlock);
  }
  if (protocol === 'messages') fail('thinking.signature: 无法生成原生 Claude 签名，公开网关标记不能上送原生 Messages');
  if (protocol === value.originProtocol) return clone(value.originBlock);
  if (protocol === 'responses') return { type: 'reasoning', summary: clone(value.summary || []), ...(value.text ? { content: [{ type: 'reasoning_text', text: value.text }] } : {}) };
  const wire = renderReasoning(protocol, value); delete wire.airouter_upstream_reasoning; return wire;
}
module.exports = { REASONING_TRANSPORT, REASONING_OPAQUE_PREFIX, REASONING_TEXT_PREFIX, BRIDGE_FORMAT, parseSourceReasoning, renderReasoning, parseClientReasoning, hasBridgeReasoning, restoreReasoning, viewFor };
