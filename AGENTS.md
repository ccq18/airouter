# AGENTS.md

本文件适用于 Airouter 仓库，描述当前项目入口与验收约束。

## 1. 当前结构

- `openai.js`：HTTP 入口、鉴权、配置持久化与运行态连接。
- `run.js`：交互式初始化、后台启停和日志查看。默认配置为 `config.json`，模板为 `config.json.example`；不读取或迁移旧文件。
- `app/openai-config.js`、`app/config-editor.js`、`app/routing-config.js`：账号和路由配置契约、校验与编辑。
- `app/provider-presets.js`、`app/quota-engine.js`：供应商地址、目录和额度解析、快照与刷新。
- `app/model-router.js`、`app/explicit-routing-handler.js`、`app/protocol-bridge.js`：有序候选、一次请求的执行清理、协议桥接。
- `public/config-admin.html`、`public/config-admin.js`、`public/config-admin-routing.js`：两个页签的列表、编辑、设置与导入交互。
- `scripts/claude-auth-login.js`：Claude OAuth 登录与配置写入；写入后需重启运行服务。
- `desktop/`：Tauri 壳、资源准备和桌面发布；`test/`：Node 内置测试；`docs/`：当前配置、接口与统一设计。

## 2. 运行与验证

```bash
npm install
npm start
npm run stop
npm run restart
npm run logs
npm test
```

共享逻辑、HTTP、配置或管理交互发生变化时运行 `npm test`。协议变更先用 `npm run test:protocol` 检查桥接、状态、路由和免费池相关回归；完整 `npm test` 包含这些测试，是提交与部署的交付门禁。覆盖矩阵和真实供应商边界见 [协议验证记录](docs/protocol-compatibility-verification.md)。针对性检查使用 `node --test test/<名称>.test.js`；启动器重点检查 `test/run.test.js`，桌面入口重点检查 `test/desktop-boot.test.js`，路由行为重点检查 `test/unified-routing.integration.test.js`。

HTTP 集成测试使用临时配置和随机端口的假上游，不访问真实供应商。真实网络、账号额度和协议调用应另行记录结果。桌面构建会写入 `desktop/dist`、资源目录和 Rust `target`；先确认构建环境，不能把静态测试当作桌面编译成功。

## 3. 实现约束

只支持统一模型路由。`routing.models[].targets` 顺序决定优先级，不存在 `routing.mode`、Token 优先、API Key 兜底焦点或全局模型别名。账号采用稳定 ID；新增候选和重新排序不得造成 ID 冲突。

账号模型清单与客户端公开模型分离。同步目录只产生预览，用户保存才写入配置；被引用的模型和协议不能直接删除。只有自定义平台需要模型列表地址。免费池是自动维护目录的例外：外层仅暴露固定 free，内部由价格资格、能力和健康筛选；同步失败保留缓存，资格过期停止调用，不允许手工模型目录覆盖。

额度查询失败、无权限或字段缺失不能伪造为零；已知耗尽需要正面恢复证据。短期限频、认证错误与额度分开处理。未输出前可按错误分类尝试后备，已输出的流不能切换上游拼接答案。异常和客户端取消必须释放探测锁并中止活动请求。

私有响应上下文不能跨调用者、账号、模型或协议迁移。更换账号身份时失效额度、健康和上下文；迟到请求不能污染新身份。不能保真的协议能力必须明确拒绝或跳过候选。

当前业务入口只有模型目录及三种对话协议，完整清单见 [API 参考](docs/api-reference.md)。未注册的旧 API、图片生成和 CPA 通配入口不是当前能力，不恢复兼容路径。

## 4. 配置和安全

真实 `config.json`、退役的本地配置、日志、PID、控制文件、入口密钥和上游凭证不进入 Git。不要清理用户已有配置和生成物；测试使用临时目录。示例只使用明显假值。

管理接口受 `auth_token` 保护，业务接口遵守 `apikeys`。日志和认证失败响应不得泄露管理凭证；账号读取只返回凭证是否存在，不回显上游秘密。公网部署使用 HTTPS、受保护的持久配置和回环监听，避免访问日志记录查询参数中的管理凭证。

根项目使用 CommonJS；`desktop/` 前端与脚本使用 ESM。保持既有风格，新逻辑优先进入可测试模块，不引入无关框架。用户可见配置或行为变化应同步当前文档，不并行维护第二套有效规范。

## 5. Git 与桌面发布

默认分支为 `main`；口头所说的 `master` 按 `main` 理解。推送 `main` 不触发桌面打包；`.github/workflows/release.yml` 由 `v*` Tag 触发。

准备桌面版本前先获取 `origin/main` 和 Tags，完成相关验证，确认待发布提交已推送且 `main` 与 `origin/main` 一致。若最新 Tag 已指向同一提交，不为它重复发版；未指定版本范围时递增补丁版本。Tag 必须指向精确待发布提交，优先 annotated Tag；不移动、覆盖或复用已推送 Tag。

签名发布需要 `TAURI_SIGNING_PRIVATE_KEY`，有密码时还需 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，均不得写入代码或日志。推送 Tag 后检查 Actions、macOS arm64/x64 与 Windows x64 产物及 Release 资产；失败时修复后使用新 Tag，不能仅以 Tag 推送成功宣称发布完成。资产清单见 [desktop/README.md](desktop/README.md)。
