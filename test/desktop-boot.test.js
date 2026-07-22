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
  assert.match(script, /initialize_config/);
  assert.match(script, /show_config_page/);
});

test('desktop boot page exposes the Rust updater command flow', () => {
  const html = fs.readFileSync(path.join(desktopDir, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(desktopDir, 'src', 'main.js'), 'utf8');
  const styles = fs.readFileSync(path.join(desktopDir, 'src', 'styles.css'), 'utf8');
  const tauriConfig = fs.readFileSync(path.join(desktopDir, 'src-tauri', 'tauri.conf.json'), 'utf8');
  const cargoToml = fs.readFileSync(path.join(desktopDir, 'src-tauri', 'Cargo.toml'), 'utf8');
  const capability = fs.readFileSync(path.join(desktopDir, 'src-tauri', 'capabilities', 'default.json'), 'utf8');
  const rustMain = fs.readFileSync(path.join(desktopDir, 'src-tauri', 'src', 'main.rs'), 'utf8');

  assert.match(html, /id="updateCheckBtn"/);
  assert.match(html, /id="updateDialog"/);
  assert.match(html, /id="updateInstallBtn"/);
  assert.match(script, /check_for_updates/);
  assert.match(script, /install_update/);
  assert.match(script, /airouter-update-progress/);
  assert.match(script, /checkForUpdates\(\{ notifyNoUpdate: false, notifyError: false \}\)/);
  assert.match(script, /STARTUP_UPDATE_CHECK_NOTICE_DELAY_MS = 5000/);
  assert.match(script, /headline\.textContent = '更新检查耗时较长'/);
  assert.match(script, /updateCheckBtn\.textContent = '暂不检查'/);
  assert.match(script, /function skipStartupUpdateCheck\(\)/);
  assert.match(script, /acceptResult: \(\) => !startupUpdateCheckSkipped/);
  assert.doesNotMatch(script, /Promise\.race\(\[checkPromise, timeoutPromise\]\)/);
  assert.match(script, /let configuredStartupPromise = null/);
  assert.match(script, /startupServicePromise = invoke\('start_service'\)/);
  assert.match(script, /await invoke\('open_admin_window'\)/);
  assert.match(styles, /\.update-dialog/);
  assert.match(tauriConfig, /"createUpdaterArtifacts":\s*true/);
  assert.match(tauriConfig, /"https:\/\/github\.com\/ccq18\/airouter\/releases\/latest\/download\/latest\.json"/);
  assert.match(cargoToml, /tauri-plugin-updater/);
  assert.match(cargoToml, /tauri-plugin-process/);
  assert.match(capability, /"updater:default"/);
  assert.match(capability, /"process:default"/);
  assert.match(rustMain, /check_for_updates/);
  assert.match(rustMain, /install_update/);
  assert.doesNotMatch(rustMain, /maybe_start_or_prompt_for_config/);
});

test('desktop build installs locked production dependencies and migrates them on upgrade', () => {
  const prepareResources = fs.readFileSync(
    path.join(desktopDir, 'scripts', 'prepare-resources.mjs'),
    'utf8',
  );
  const rustMain = fs.readFileSync(path.join(desktopDir, 'src-tauri', 'src', 'main.rs'), 'utf8');

  assert.match(prepareResources, /\['ci', '--omit=dev', '--ignore-scripts'\]/);
  assert.doesNotMatch(prepareResources, /^\s*'node_modules'\s*,?$/m);
  assert.match(prepareResources, /createHash\('sha256'\)/);
  assert.match(prepareResources, /\.airouter-dependencies\.sha256/);
  assert.match(rustMain, /should_sync_dependencies/);
  assert.match(rustMain, /files_have_same_contents\(&source_dependency_marker, &destination_dependency_marker\)/);
  assert.match(rustMain, /replace_dir_atomically\(&source_modules, &destination_modules\)/);
});
