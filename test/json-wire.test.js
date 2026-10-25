const test = require('node:test');
const assert = require('node:assert/strict');
const { rewriteJsonModels, assertRepresentableJsonNumbers } = require('../app/json-wire');

test('format conversion accepts equivalent numeric spellings and ignores digits in strings', () => {
  for (const raw of ['{"n":1e3,"decimal":1.2500,"zero":-0}', '{"n":1e-7,"quoted":"9007199254740993\\\" tail 1e999"}', '{"n":9007199254740992,"small":0.1}']) {
    assert.doesNotThrow(() => assertRepresentableJsonNumbers(raw));
  }
});

test('format conversion explicitly rejects rounded integers, decimals, overflow and underflow', () => {
  for (const token of ['9007199254740993', '0.100000000000000005', '1e999', '1e-999']) {
    assert.throws(() => assertRepresentableJsonNumbers('{"nested":[{"n":' + token + '}]}'), /数字精度/);
  }
});

test('native JSON model substitution retains numeric and whitespace tokens byte-for-byte', () => {
  const raw = ' { "model" : "backend", "extension" : { "serial":9007199254740993, "decimal":0.100000000000000005, "exponent":1e999 }, "message":{"model":"inner","n":9007199254740995}, "response":{"model":"nested","deep":{"model":"unchanged"}}, "choices":[{"model":"also-unchanged"}] }\n';
  const expected = ' { "model" : "public", "extension" : { "serial":9007199254740993, "decimal":0.100000000000000005, "exponent":1e999 }, "message":{"model":"public","n":9007199254740995}, "response":{"model":"public","deep":{"model":"unchanged"}}, "choices":[{"model":"also-unchanged"}] }\n';
  const actual = rewriteJsonModels(Buffer.from(raw), 'public');
  assert.ok(Buffer.isBuffer(actual)); assert.equal(actual.toString(), expected);
});

test('JSON escaped property names, escaped string content and replacement quotes remain valid', () => {
  const raw = String.raw`{"\u006dodel":"old","response":{"\u006dodel":"inner","vendor":1e+29},"text":"\"model\": \"not a field\"\\尾🙂","array":[{"model":"keep"}]}`;
  const publicModel = '模型"\\\n🙂';
  const encoded = JSON.stringify(publicModel);
  const expected = String.raw`{"\u006dodel":` + encoded + String.raw`,"response":{"\u006dodel":` + encoded + String.raw`,"vendor":1e+29},"text":"\"model\": \"not a field\"\\尾🙂","array":[{"model":"keep"}]}`;
  const actual = rewriteJsonModels(raw, publicModel);
  assert.equal(actual, expected); assert.equal(JSON.parse(actual).model, publicModel);
});

test('model-like fields inside unknown nested objects and arrays are untouched without recursive stack limits', () => {
  const nested = '['.repeat(20000) + '{"model":"keep","n":9007199254740993}' + ']'.repeat(20000);
  const raw = '{"vendor":' + nested + ',"model":"backend"}';
  assert.equal(rewriteJsonModels(raw, 'public'), '{"vendor":' + nested + ',"model":"public"}');
});

test('native JSON without identity fields is returned without inventing model properties', () => {
  for (const raw of ['{"extension":9007199254740993}', '[{"model":"keep"}]', 'null']) assert.equal(rewriteJsonModels(raw, 'public'), raw);
});
