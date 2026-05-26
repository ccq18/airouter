const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const test = require('node:test');

const ONE_BY_ONE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lqG1NwAAAABJRU5ErkJggg==';
const REPO_ROOT = path.join(__dirname, '..');

function runScript(args, options = {}) {
  return new Promise(resolve => {
    const child = spawn('python3', [path.join(REPO_ROOT, 'scripts/auto_image_edit.py'), ...args], {
      cwd: options.cwd || REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('close', code => {
      resolve({ code, stdout, stderr });
    });
  });
}

function readRequestBody(req) {
  return new Promise(resolve => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function createMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handler(req, res).catch(reject);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(closeResolve => server.close(closeResolve)),
      });
    });
  });
}

test('auto_image_edit.py asks responses for an edit prompt before calling image edits', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airouter-auto-edit-'));
  const inputImage = path.join(tempDir, 'input.png');
  const outputDir = path.join(tempDir, 'out');
  await fs.writeFile(inputImage, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'));

  const requests = [];
  const server = await createMockServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      url: req.url,
      headers: req.headers,
      body,
    });

    if (req.url === '/v1/responses') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ output_text: 'Improve lighting and remove dust.' }));
      return;
    }

    if (req.url === '/v1/images/edits') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: ONE_BY_ONE_PNG_BASE64 }],
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  let result;
  try {
    result = await runScript([
      '--base-url',
      server.baseUrl,
      '--input-image',
      inputImage,
      '--out-dir',
      outputDir,
      '--ak',
      'sk-test',
    ]);
  } finally {
    await server.close();
  }

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, '/v1/responses');
  assert.equal(requests[0].headers.authorization, 'Bearer sk-test');
  assert.match(requests[0].body.toString('utf8'), /data:image\/png;base64,/);
  assert.equal(requests[1].url, '/v1/images/edits');
  assert.match(requests[1].headers['content-type'], /multipart\/form-data/);
  assert.match(requests[1].body.toString('latin1'), /Improve lighting and remove dust\./);
  assert.match(result.stdout, /responses prompt:/);
  assert.match(result.stdout, /edit: HTTP 200 -> /);
});

test('auto_image_edit.py accepts event-stream responses prompt output', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airouter-auto-edit-sse-'));
  const inputImage = path.join(tempDir, 'input.png');
  const outputDir = path.join(tempDir, 'out');
  await fs.writeFile(inputImage, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'));

  const requests = [];
  const server = await createMockServer(async (req, res) => {
    const body = await readRequestBody(req);
    requests.push({
      url: req.url,
      headers: req.headers,
      body,
    });

    if (req.url === '/v1/responses') {
      res.setHeader('content-type', 'text/event-stream');
      res.end([
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":"Lift shadows"}',
        '',
        'event: response.output_text.delta',
        'data: {"type":"response.output_text.delta","delta":" and sharpen fur."}',
        '',
        'event: response.completed',
        'data: {"type":"response.completed","response":{"output":[]}}',
        '',
      ].join('\n'));
      return;
    }

    if (req.url === '/v1/images/edits') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: ONE_BY_ONE_PNG_BASE64 }],
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  let result;
  try {
    result = await runScript([
      '--base-url',
      server.baseUrl,
      '--input-image',
      inputImage,
      '--out-dir',
      outputDir,
    ]);
  } finally {
    await server.close();
  }

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 2);
  assert.match(requests[1].body.toString('latin1'), /Lift shadows and sharpen fur\./);
});

test('auto_image_edit.py writes only the edited image to the current working directory by default', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airouter-auto-edit-cwd-'));
  const inputImage = path.join(tempDir, 'input.png');
  await fs.writeFile(inputImage, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'));

  const server = await createMockServer(async (req, res) => {
    await readRequestBody(req);
    if (req.url === '/v1/images/edits') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: ONE_BY_ONE_PNG_BASE64 }],
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  let result;
  try {
    result = await runScript([
      '--base-url',
      server.baseUrl,
      '--input-image',
      inputImage,
      '--prompt',
      'Improve lighting.',
    ], { cwd: tempDir });
  } finally {
    await server.close();
  }

  assert.equal(result.code, 0, result.stderr);
  const files = await fs.readdir(tempDir);
  assert.ok(files.some(file => /^auto-image-edit-\d{8}-\d{6}-edited\.png$/.test(file)));
  assert.ok(!files.some(file => /^auto-image-edit-\d{8}-\d{6}-edit-prompt\.txt$/.test(file)));
  assert.ok(!files.some(file => /^auto-image-edit-\d{8}-\d{6}-image-edit-response\.json$/.test(file)));
  assert.ok(!files.some(file => /^auto-image-edit-\d{8}-\d{6}-responses-prompt-response\.json$/.test(file)));
});

test('auto_image_edit.py writes debug files only when requested', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'airouter-auto-edit-debug-'));
  const inputImage = path.join(tempDir, 'input.png');
  await fs.writeFile(inputImage, Buffer.from(ONE_BY_ONE_PNG_BASE64, 'base64'));

  const server = await createMockServer(async (req, res) => {
    await readRequestBody(req);
    if (req.url === '/v1/images/edits') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        created: 1,
        data: [{ b64_json: ONE_BY_ONE_PNG_BASE64 }],
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  let result;
  try {
    result = await runScript([
      '--base-url',
      server.baseUrl,
      '--input-image',
      inputImage,
      '--prompt',
      'Improve lighting.',
      '--save-debug',
    ], { cwd: tempDir });
  } finally {
    await server.close();
  }

  assert.equal(result.code, 0, result.stderr);
  const files = await fs.readdir(tempDir);
  assert.ok(files.some(file => /^auto-image-edit-\d{8}-\d{6}-edited\.png$/.test(file)));
  assert.ok(files.some(file => /^auto-image-edit-\d{8}-\d{6}-edit-prompt\.txt$/.test(file)));
  assert.ok(files.some(file => /^auto-image-edit-\d{8}-\d{6}-image-edit-response\.json$/.test(file)));
});
