# Airouter Desktop

Tauri wrapper for the existing airouter Node.js service.

The desktop app keeps runtime state in the platform application data directory:

```text
macOS:   ~/Library/Application Support/Airouter/airouter/
Windows: %APPDATA%\Airouter\airouter\
```

It does not modify the root service files. Build preparation copies the service into `desktop/src-tauri/resources/airouter/` and places the platform Node.js sidecar in `desktop/src-tauri/binaries/`.

The bundled management page can use the desktop shell to fetch ChatGPT AuthSession JSON. Click `App 自动获取`, log in in the ChatGPT window opened by the app, and the session JSON is filled back into the Token config form after login succeeds.

## Development

```bash
cd desktop
npm install
npm run prepare
npm run dev
```

If `npm` is unavailable in the shell, install or use a Node.js distribution that includes npm for Tauri CLI dependency installation. The packaged app itself does not rely on system Node.js.

The preparation scripts can be run with plain Node.js:

```bash
node scripts/prepare-resources.mjs
node scripts/prepare-node.mjs
```

## Build

```bash
cd desktop
npm run build
```

Build only the current platform installer:

```bash
npm run build:macos
npm run build:windows
```

`build:macos` creates a signed `.dmg` for the current Mac architecture. `build:macos:app` creates only the signed `.app` bundle for local inspection. `build:windows` creates a Windows NSIS installer (`.exe`). GitHub Releases are produced by the tag workflow in `.github/workflows/release.yml`; it builds separate macOS DMGs for Apple Silicon and Intel runners.

## Online Updates

Airouter Desktop uses the Tauri v2 updater with static GitHub Release metadata:

```text
https://github.com/ccq18/airouter/releases/latest/download/latest.json
```

The updater verifies every downloaded package with the public key embedded in `src-tauri/tauri.conf.json`. Keep the matching private key outside the repository. The local default path used by `scripts/run-tauri-build.mjs` is:

```text
~/.tauri/airouter-updater.key
```

Generate a key pair when setting up a release machine:

```bash
cd desktop
npx tauri signer generate --ci -w ~/.tauri/airouter-updater.key
```

For CI, provide one of these secret forms:

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

or point at a key file with:

```text
TAURI_SIGNING_PRIVATE_KEY_PATH
```

The app checks this endpoint quietly on startup and opens the update dialog only when a newer version is available. The **Check for updates** button remains available for an explicit check. Downloads are installed only after user confirmation, then the app restarts.

The tag workflow requires `TAURI_SIGNING_PRIVATE_KEY`, builds macOS arm64, macOS x64, and Windows x64 artifacts, and publishes both user-facing installers and signed updater packages. It then generates `latest.json` in the same GitHub Release. The expected release assets are:

```text
Airouter_<version>_arm64.dmg
Airouter_<version>_arm64.app.tar.gz
Airouter_<version>_arm64.app.tar.gz.sig
Airouter_<version>_x64.dmg
Airouter_<version>_x64.app.tar.gz
Airouter_<version>_x64.app.tar.gz.sig
Airouter_<version>_x64-setup.exe
Airouter_<version>_x64-setup.exe.zip
Airouter_<version>_x64-setup.exe.zip.sig
latest.json
```

To regenerate `latest.json` from already collected signed updater artifacts, run:

```bash
cd desktop
npm run release:latest-json -- --input dist-release --output dist-release
```
