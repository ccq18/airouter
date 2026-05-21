const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const popupScript = fs.readFileSync(path.join(__dirname, '..', 'chrome-popup-admin', 'popup.js'), 'utf8');

test('chrome popup switch button prevents details summary click handling', () => {
  const switchHandlerStart = popupScript.indexOf('const switchConfigButton = event.target.closest');
  const switchHandlerEnd = popupScript.indexOf('const deleteApiKeyButton = event.target.closest', switchHandlerStart);
  const switchHandler = switchHandlerStart >= 0 && switchHandlerEnd > switchHandlerStart
    ? popupScript.slice(switchHandlerStart, switchHandlerEnd)
    : '';

  assert.match(popupScript, /data-action="switch-config"/);
  assert.match(switchHandler, /event\.preventDefault\(\);/);
  assert.match(switchHandler, /event\.stopPropagation\(\);/);
  assert.match(switchHandler, /await activateConfig\(switchConfigButton\.dataset\.index\);/);
});

test('chrome popup hides the top-priority action from config cards', () => {
  assert.doesNotMatch(popupScript, /data-action="move-config"/);
  assert.doesNotMatch(popupScript, /\/admin\/api\/configs\/\$\{index\}\/move-up/);
});
