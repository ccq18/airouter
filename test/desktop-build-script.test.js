const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const buildScript = fs.readFileSync('desktop/scripts/run-tauri-build.mjs', 'utf8');

test('desktop build launcher runs npx.cmd through a shell on Windows', () => {
  assert.match(buildScript, /const isWindows = process\.platform === 'win32'/);
  assert.match(buildScript, /shell:\s*isWindows/);
});

test('desktop build launcher reports spawn failures before exiting', () => {
  assert.match(buildScript, /if \(result\.error\)/);
  assert.match(buildScript, /console\.error/);
});
