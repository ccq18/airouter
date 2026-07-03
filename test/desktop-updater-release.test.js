const assert = require('node:assert/strict');
const test = require('node:test');

test('desktop updater release helper builds macOS and Windows latest.json entries', async () => {
  const helper = await import(`../desktop/scripts/generate-latest-json.mjs?test=${Date.now()}`);
  const latest = helper.buildLatestJson({
    version: '1.2.3',
    notes: '更新说明',
    pubDate: '2026-05-29T00:00:00.000Z',
    artifacts: [
      {
        platform: 'darwin-aarch64',
        assetName: 'Airouter_1.2.3_arm64.app.tar.gz',
        signature: 'sig-darwin-arm64',
      },
      {
        platform: 'darwin-x86_64',
        assetName: 'Airouter_1.2.3_x64.app.tar.gz',
        signature: 'sig-darwin-x64',
      },
      {
        platform: 'windows-x86_64',
        assetName: 'Airouter_1.2.3_x64-setup.exe.zip',
        signature: 'sig-windows-x64',
      },
    ],
    githubRepo: 'ccq18/airouter',
  });

  assert.deepEqual(latest, {
    version: '1.2.3',
    notes: '更新说明',
    pub_date: '2026-05-29T00:00:00.000Z',
    platforms: {
      'darwin-aarch64': {
        signature: 'sig-darwin-arm64',
        url: 'https://github.com/ccq18/airouter/releases/download/v1.2.3/Airouter_1.2.3_arm64.app.tar.gz',
      },
      'darwin-x86_64': {
        signature: 'sig-darwin-x64',
        url: 'https://github.com/ccq18/airouter/releases/download/v1.2.3/Airouter_1.2.3_x64.app.tar.gz',
      },
      'windows-x86_64': {
        installMode: 'passive',
        signature: 'sig-windows-x64',
        url: 'https://github.com/ccq18/airouter/releases/download/v1.2.3/Airouter_1.2.3_x64-setup.exe.zip',
      },
    },
  });
});

test('desktop updater release helper infers platform keys from generated artifacts', async () => {
  const helper = await import(`../desktop/scripts/generate-latest-json.mjs?test=${Date.now()}`);

  assert.equal(
    helper.inferUpdaterPlatform('Airouter_1.2.3_arm64.app.tar.gz'),
    'darwin-aarch64',
  );
  assert.equal(
    helper.inferUpdaterPlatform('Airouter_1.2.3_x64.app.tar.gz'),
    'darwin-x86_64',
  );
  assert.equal(
    helper.inferUpdaterPlatform('Airouter_1.2.3_x64-setup.exe.zip'),
    'windows-x86_64',
  );
  assert.throws(
    () => helper.inferUpdaterPlatform('Airouter_1.2.3_arm64.dmg'),
    /Unsupported updater artifact/,
  );
});

test('desktop updater release helper normalizes local macOS updater artifact names', async () => {
  const helper = await import(`../desktop/scripts/generate-latest-json.mjs?test=${Date.now()}`);

  assert.deepEqual(
    helper.normalizeUpdaterAssetName({
      assetName: 'Airouter.app.tar.gz',
      version: '1.2.3',
      arch: 'arm64',
    }),
    'Airouter_1.2.3_arm64.app.tar.gz',
  );
  assert.equal(
    helper.inferUpdaterPlatform('Airouter_1.2.3_arm64.app.tar.gz'),
    'darwin-aarch64',
  );
});
