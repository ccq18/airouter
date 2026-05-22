const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const desktopDir = path.join(__dirname, '..', 'desktop');

test('desktop boot page exposes a first-run config wizard', () => {
  const html = fs.readFileSync(path.join(desktopDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(desktopDir, 'src', 'main.js'), 'utf8');

  assert.match(html, /id="setupForm"/);
  assert.match(html, /id="servicePortInput"/);
  assert.match(html, /id="proxyEnabledInput"/);
  assert.match(html, /id="proxyPortInput"/);
  assert.match(html, /id="apikeyEnabledInput"/);
  assert.match(script, /airouter-config-missing/);
  assert.match(script, /initialize_config/);
  assert.match(script, /show_config_page/);
  assert.match(script, /if \(panel\.dataset\.state === 'loading'\)[\s\S]+progress\.hidden = true;/);
});
