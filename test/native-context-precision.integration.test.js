const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
let upstream, child, directory, base, serial = 0, opaqueNumber = null, providerStream = false;
const calls = [];
const marker = '__PRECISE_NUMBER__';
function wire(value, number) { return JSON.stringify(value).replaceAll('"' + marker + '"', number); }
function request(slot, content) {
  const body = { model: 'native', max_tokens: 50, stream: false, messages: [{ role: 'user', content: 'first' }], tools: [{ name: 'test', input_schema: { type: 'object', properties: { number: { enum: [1] } } } }] };
  if (slot === 'tools') body.tools[0].input_schema.properties.number.enum = [marker];
  if (slot === 'system') body.system = [{ type: 'text', text: 'system', vendor_counter: marker }];
  if (slot === 'history') body.messages[0].content = [{ type: 'text', text: 'first', vendor_counter: marker }];
  if (content) body.messages.push({ role: 'assistant', content }, { role: 'user', content: 'next' });
  return body;
}
async function entry(body, number) {
  const response = await fetch(base + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer precision-fixture', 'content-type': 'application/json' }, body: wire(body, number) });
  const raw = await response.text();
  let payload;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const events = raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
    payload = { content: events.filter(event => event.type === 'content_block_start').map(event => event.content_block) };
  } else payload = JSON.parse(raw);
  return { status: response.status, body: payload };
}
test.before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'airouter-native-precision-'));
  upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push(raw);
    const content = [{ type: 'thinking', thinking: 'proof', signature: 'fixture-signed-' + ++serial, ...(opaqueNumber ? { vendor_number: marker } : {}) }, { type: 'text', text: 'answer' }];
    const message = { id: 'msg-' + serial, type: 'message', role: 'assistant', model: 'backend', content, stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 2 } };
    if (providerStream) {
      const events = [{ type: 'message_start', message: { ...message, content: [], stop_reason: null } }, ...content.flatMap((block, index) => [{ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }]), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }, { type: 'message_stop' }];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => 'event: ' + event.type + '\ndata: ' + wire(event, opaqueNumber || '1') + '\n\n').join(''));
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(wire(message, opaqueNumber || '1'));
    }
  });
  const upstreamPort = await listen(upstream), reserve = http.createServer(), port = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  const config = { port, auth_token: 'precision-admin-fixture', apikeys: ['precision-fixture'], configs: [{ id: 'account', type: 'apikey', preset: 'custom', apikey: 'fake-provider-fixture', base_url: 'http://127.0.0.1:' + upstreamPort, models: [{ id: 'backend', protocols: ['messages'] }] }], routing: { models: [{ id: 'native', targets: [{ id: 'target', config_id: 'account', model: 'backend' }] }] } };
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config)); base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.join(__dirname, '..', 'openai.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, CONFIG: path.join(directory, 'config.json'), AIROUTER_BIND_HOST: '127.0.0.1' }, stdio: 'ignore' });
  for (let n = 0; n < 200; n++) { try { if ((await fetch(base + '/admin/api/upstreams', { headers: { authorization: 'Bearer precision-admin-fixture' } })).ok) return; } catch (_) {} await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('fixture gateway did not start');
});
test.after(async () => { if (child?.exitCode === null) { const done = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await done; } if (upstream) { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); } if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

for (const slot of ['tools', 'system', 'history']) test(`native signed context compares precise JSON numbers in ${slot}`, async () => {
  const initial = await entry(request(slot), '9007199254740993'); assert.equal(initial.status, 200);
  assert.match(calls.at(-1), /9007199254740993/, 'ordinary native forwarding retains numeric lexemes');
  const next = request(slot, initial.body.content);
  const unchanged = await entry(next, '9007199254740993'); assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
  const before = calls.length;
  const changed = await entry(next, '9007199254740992');
  assert.equal(changed.status, 409); assert.equal(changed.body.error.type, 'upstream_context_unavailable');
  assert.equal(calls.length, before, 'changed private context cannot contact any upstream');
  const forgedString = await entry(next, '"9007199254740993"'); assert.equal(forgedString.status, 409); assert.equal(calls.length, before);
  const forgedObject = await entry(next, '{"source":"9007199254740993"}'); assert.equal(forgedObject.status, 409); assert.equal(calls.length, before);
});

test('private context numeric hashes distinguish high precision decimals from rounded values', async () => {
  const initial = await entry(request('tools'), '0.100000000000000005'); assert.equal(initial.status, 200);
  const before = calls.length;
  const changed = await entry(request('tools', initial.body.content), '0.1');
  assert.equal(changed.status, 409); assert.equal(calls.length, before);
});

for (const stream of [false, true]) for (const number of ['9007199254740993', '0.100000000000000005', '1e-999']) test(`native opaque ${stream ? 'SSE' : 'JSON'} numeric identity distinguishes source ${number}`, async () => {
  opaqueNumber = number; providerStream = stream;
  try {
    const initial = await entry({ ...request('none'), stream }, '1'); assert.equal(initial.status, 200, JSON.stringify(initial.body));
    const exactContent = JSON.parse(JSON.stringify(initial.body.content)); exactContent[0].vendor_number = marker;
    const unchanged = await entry({ ...request('none', exactContent), stream }, number); assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
    const before = calls.length;
    // response.json has rounded/underflowed the number: this is a changed block.
    const changed = await entry({ ...request('none', initial.body.content), stream }, '1');
    assert.equal(changed.status, 409); assert.equal(calls.length, before);
  } finally { opaqueNumber = null; providerStream = false; }
});

test('mathematically equivalent numeric source spellings preserve private context', async () => {
  const initial = await entry(request('tools'), '1.00e+0'); assert.equal(initial.status, 200);
  const next = await entry(request('tools', initial.body.content), '1'); assert.equal(next.status, 200);
});
