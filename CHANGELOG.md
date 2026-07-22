# Changelog

## 0.5.7

- 启用 Airouter Desktop 启动时静默检查、签名下载、安装进度和自动重启更新流程。
- 为 macOS arm64、macOS x64 和 Windows x64 Release 生成签名 updater 资产与 `latest.json`。
- 修复桌面打包可能携带缺失或过期 Node.js 依赖，及旧版本升级后不迁移新增依赖导致客户端无法启动的问题。
- 更新检查超过 5 秒时自动进入本地管理页，避免 GitHub、DNS 或代理异常阻塞客户端启动。
