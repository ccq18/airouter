# Sub2API Agent Identity 实施任务

| ID | 任务 | 状态 | 验收证据 |
|---|---|---|---|
| T1 | 新增 Agent Identity 密钥、签名、请求头、sealed-box 和 task recovery 模块 | 完成 | `test/sub2api-agent-identity.test.js` |
| T2 | 扩展单个/批量配置导入、规范化、校验和运行态构造 | 完成 | `test/config-editor.test.js`、`test/runtime-config-reconciler.test.js` |
| T3 | 接入 quota 动态认证、task 恢复和传统 token refresh 分流 | 完成 | `test/account-manager.test.js` |
| T4 | 接入 Responses、Messages 转换和 Images 转发的一次同账号恢复 | 完成 | `test/proxy-boundary.test.js` |
| T5 | 更新管理台识别、subtype 展示和安全账号标识 | 完成 | `test/config-admin.test.js` |
| T6 | 更新配置参考、示例、设计和安全说明 | 完成 | `docs/config-item-reference.md`、`openai.json.example`、`spec.md` |
| T7 | 格式检查、定向测试、全量测试和双 reviewer 评审 | 完成 | 格式检查通过；定向测试 156/156；全量 `npm test` 428/428；双 reviewer Round 2 PASS |
