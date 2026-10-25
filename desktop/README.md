# Airouter Desktop

## 1. 运行目录与配置

桌面应用用 Tauri 包装 Airouter Node 服务，将可写运行态保存在平台应用数据目录：

```text
macOS:   ~/Library/Application Support/Airouter/airouter/
Windows: %APPDATA%\Airouter\airouter\
```

只使用运行目录中的 `config.json`，首次设置依据 `config.json.example` 创建；不读取或迁移旧配置文件。账号、支持模型和有序候选规则与服务端一致，见[配置契约](../docs/config-item-reference.md)。

管理页采用上游列表、模型路由列表和独立编辑/设置入口，登录态通过 JSON 导入。桌面壳不改变路由优先级，也不恢复旧调度。

构建准备把服务代码复制到 `desktop/src-tauri/resources/airouter/`，Node sidecar 放在 `desktop/src-tauri/binaries/`。资源目录运行 `npm ci --omit=dev --ignore-scripts`，使捆绑依赖与根 `package-lock.json` 一致；成功后写入 SHA-256 标记，应用升级时按标记原子替换运行依赖。

## 2. 开发与构建

```bash
cd desktop
npm install
npm run dev
```

开发和打包需要 Node/npm、Rust 与对应平台 Tauri 依赖；已打包应用不依赖系统 Node。

```bash
npm run build
npm run build:macos
npm run build:macos:app
npm run build:windows
```

macOS 命令分别生成当前架构的 DMG 或仅 App，Windows 命令生成 NSIS EXE。资源准备可单独执行：

```bash
node scripts/prepare-frontend.mjs
node scripts/prepare-resources.mjs
node scripts/prepare-node.mjs
```

修改桌面入口后先在仓库根运行 `node --test test/desktop-boot.test.js`；需要发布桌面包时必须完成目标平台构建与安装/启动验收，不能把静态测试当成编译成功。

## 3. 签名与在线更新

更新元数据地址由 `src-tauri/tauri.conf.json` 配置：

```text
https://github.com/ccq18/airouter/releases/latest/download/latest.json
```

更新包使用应用内置公钥验证。私钥不进入仓库；本地构建支持 `TAURI_SIGNING_PRIVATE_KEY_PATH`，默认密钥文件路径为 `~/.tauri/airouter-updater.key`。发布机可使用：

```bash
npx tauri signer generate --ci -w ~/.tauri/airouter-updater.key
```

GitHub Actions 配置 `TAURI_SIGNING_PRIVATE_KEY`，仅在私钥有密码时增加 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。应用启动时检查更新，安装前由用户确认；检查耗时过长时可选择暂不检查并进入本地管理页面。

## 4. 发布资产

`.github/workflows/release.yml` 由 `v*` Tag 触发，构建 macOS arm64、macOS x64、Windows x64 安装包与签名更新包。`main` 的普通推送不触发桌面发布。Tag 和版本约定见[项目规则](../AGENTS.md#5-git-与桌面发布)。

```text
Airouter_<version>_arm64.dmg
Airouter_<version>_arm64.app.tar.gz
Airouter_<version>_arm64.app.tar.gz.sig
Airouter_<version>_x64.dmg
Airouter_<version>_x64.app.tar.gz
Airouter_<version>_x64.app.tar.gz.sig
Airouter_<version>_x64-setup.exe
Airouter_<version>_x64-setup.exe.sig
latest.json
```

从已收集的签名资产重新生成元数据：

```bash
npm run release:latest-json -- --input dist-release --output dist-release
```

发布前检查三个平台构建、上述资产与更新元数据匹配；线上更新结果不等同于服务端路由或真实供应商验收。
