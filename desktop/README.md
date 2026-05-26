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
