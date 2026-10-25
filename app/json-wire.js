/** Rewrite only native response model identities, retaining every other JSON
 * token exactly (including integers/decimals outside JavaScript precision).
 * The HTTP handler validates JSON before calling this; this scanner never
 * parses numbers or reserializes application/vendor data.
 */
function rewriteJsonModels(input, publicModel) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const replacement = JSON.stringify(publicModel);
  const spans = [];
  const whitespace = offset => { while (offset < text.length && /[\x20\t\r\n]/.test(text[offset])) offset++; return offset; };
  function stringEnd(offset) {
    if (text[offset] !== '"') throw new SyntaxError('JSON string expected');
    for (offset++; offset < text.length; offset++) {
      if (text[offset] === '\\') { offset++; continue; }
      if (text[offset] === '"') return offset + 1;
    }
    throw new SyntaxError('Unterminated JSON string');
  }
  function valueEnd(offset) {
    if (text[offset] === '"') return stringEnd(offset);
    if (text[offset] === '{' || text[offset] === '[') {
      let depth = 0;
      for (; offset < text.length; offset++) {
        const char = text[offset];
        if (char === '"') { offset = stringEnd(offset) - 1; continue; }
        if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') { if (--depth === 0) return offset + 1; }
      }
      throw new SyntaxError('Unterminated JSON value');
    }
    const start = offset;
    while (offset < text.length && !/[\x20\t\r\n,\]}]/.test(text[offset])) offset++;
    if (offset === start) throw new SyntaxError('JSON value expected');
    return offset;
  }
  function objectEnd(offset, root = false) {
    offset = whitespace(offset + 1);
    if (text[offset] === '}') return offset + 1;
    while (offset < text.length) {
      const end = stringEnd(offset), key = JSON.parse(text.slice(offset, end));
      offset = whitespace(end);
      if (text[offset] !== ':') throw new SyntaxError('JSON property colon expected');
      const start = whitespace(offset + 1);
      if (root && ['message', 'response'].includes(key) && text[start] === '{') offset = objectEnd(start);
      else {
        offset = valueEnd(start);
        if (key === 'model') spans.push({ start, end: offset });
      }
      offset = whitespace(offset);
      if (text[offset] === '}') return offset + 1;
      if (text[offset] !== ',') throw new SyntaxError('JSON property separator expected');
      offset = whitespace(offset + 1);
    }
    throw new SyntaxError('Unterminated JSON object');
  }
  const start = whitespace(0);
  if (text[start] !== '{') return Buffer.isBuffer(input) ? input : text;
  objectEnd(start, true);
  let result = '', cursor = 0;
  for (const span of spans) { result += text.slice(cursor, span.start) + replacement; cursor = span.end; }
  result += text.slice(cursor);
  return Buffer.isBuffer(input) ? Buffer.from(result, 'utf8') : result;
}
function decimalIdentity(token) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) return null;
  let digits = (match[2] + (match[3] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  const exponent = (match[4] || '0').replace(/^([+-]?)0+(?=\d)/, '$1');
  if (exponent.replace(/^[+-]/, '').length > 6) return null;
  const trailing = digits.length - digits.replace(/0+$/, '').length;
  digits = digits.slice(0, digits.length - trailing);
  return `${match[1]}${digits}e${Number(exponent) - (match[3] || '').length + trailing}`;
}

// Native format conversion builds JS objects. Refuse numeric values that
// serialization would change; raw native paths retain their original tokens.
function assertRepresentableJsonNumbers(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const tokens = /"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  for (const match of text.matchAll(tokens)) if (match[1] !== undefined) {
    const value = Number(match[1]);
    if (!Number.isFinite(value) || decimalIdentity(match[1]) !== decimalIdentity(String(value))) {
      const { UnsupportedProtocolFeatureError } = require('./protocol-errors');
      throw new UnsupportedProtocolFeatureError('响应数字精度无法无损完成 JSON/SSE 格式互转；请保持同协议原始响应格式');
    }
  }
}
module.exports = { rewriteJsonModels, assertRepresentableJsonNumbers };
