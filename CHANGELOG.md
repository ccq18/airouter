# Changelog

## 0.5.10

- 发布在线升级验证版本，用于确认已安装的 Airouter Desktop 可发现、下载、验证签名并重启至新版本。

## 0.5.9

- 修复 Windows Tauri updater 发布资产收集，使用实际生成的签名 `.exe` 安装包与 `.exe.sig`，不再要求不存在的 `.zip` 包。

## 0.5.8

- 轮换 Desktop 自动更新签名密钥，并通过 GitHub Actions 发布首个可验证的签名更新版本。
- 该版本作为从已安装应用验证在线更新流程的基线版本。

## 0.5.7

- 启用 Airouter Desktop 启动时静默检查、签名下载、安装进度和自动重启更新流程。
- 为 macOS arm64、macOS x64 和 Windows x64 Release 生成签名 updater 资产与 `latest.json`。
- 修复桌面打包可能携带缺失或过期 Node.js 依赖，及旧版本升级后不迁移新增依赖导致客户端无法启动的问题。
- 更新检查超过 5 秒时自动进入本地管理页，避免 GitHub、DNS 或代理异常阻塞客户端启动。
