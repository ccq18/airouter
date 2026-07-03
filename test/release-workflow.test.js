const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const workflow = fs.readFileSync('.github/workflows/release.yml', 'utf8');

test('release workflow builds macOS DMGs for Apple Silicon and Intel Macs', () => {
  assert.match(workflow, /platform:\s+macos-arm64/);
  assert.match(workflow, /runner:\s+macos-latest/);
  assert.match(workflow, /asset_arch:\s+arm64/);
  assert.match(workflow, /platform:\s+macos-x64/);
  assert.match(workflow, /runner:\s+macos-15-intel/);
  assert.match(workflow, /asset_arch:\s+x64/);
  assert.match(workflow, /dmg_dir="desktop\/src-tauri\/target\/release\/bundle\/dmg"/);
  assert.match(workflow, /artifact_glob:\s+desktop\/dist-release\/\*/);
  assert.doesNotMatch(workflow, /-\s+platform:\s+macos\s*\n/);
  assert.doesNotMatch(workflow, /bundle\/macos\/\*\.zip/);
});

test('release workflow derives desktop package version from the Git tag', () => {
  assert.match(workflow, /Sync desktop version from Git tag/);
  assert.match(workflow, /GITHUB_REF_NAME/);
  assert.match(workflow, /desktop\/src-tauri\/tauri\.conf\.json/);
  assert.match(workflow, /desktop\/package\.json/);
  assert.match(workflow, /desktop\/src-tauri\/Cargo\.toml/);
  assert.match(workflow, /version = tag\.replace\(\/\^v\//, 'tag version should strip the leading v');
});

test('release workflow normalizes macOS DMG names with tag version and user-facing architecture', () => {
  assert.match(workflow, /Normalize macOS DMG name/);
  assert.match(workflow, /Airouter_\$\{version\}_\$\{asset_arch\}\.dmg/);
  assert.doesNotMatch(workflow, /Airouter_\$\{version\}_aarch64\.dmg/);
});

test('release workflow renames the Windows installer with version and architecture', () => {
  assert.match(workflow, /Normalize Windows installer name/);
  assert.match(workflow, /Airouter_\$\{version\}_x64-setup\.exe/);
  assert.match(workflow, /installers=\("\$installer_dir"\/\*\.exe\)/);
});

test('release workflow signs updater artifacts and uploads latest metadata', () => {
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY_PATH/);
  assert.match(workflow, /Generate updater latest\.json/);
  assert.match(workflow, /desktop\/scripts\/generate-latest-json\.mjs/);
  assert.match(workflow, /desktop\/dist-release\/\*/);
  assert.match(workflow, /Airouter_\$\{version\}_\$\{asset_arch\}\.app\.tar\.gz/);
  assert.match(workflow, /Airouter_\$\{version\}_x64-setup\.exe\.zip/);
});
