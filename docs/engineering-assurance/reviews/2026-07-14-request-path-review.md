# 请求链路可靠性与安全评审

- 评审运行 ID：`REV-20260714-REQUEST-PATH-01`
- 日期：2026-07-14
- 模式：代码评审（不修改产品实现）
- 基线：`main` / `d587875`；工作区另有未提交的 timeout 默认值调整
- 范围：请求体读取、鉴权头构造、上游 HTTP/HTTPS、代理隧道、redirect、timeout、buffer、failover、流式背压、客户端关闭
- 验证：静态调用链审查；跨源 307 双本地服务动态复现；当前工作区完整测试 384/384 通过

## 评审结论

当前流式背压、请求体上限、共享 deadline、客户端关闭中止及 hop-by-hop header 清理整体合理。`DEF-SEC-001` 和 `DEF-REL-003` 已于 2026-07-15 修复；原 `DEF-REL-004` 经用户确认属于既定 feature，不修改。

1. 契约：请求体限制和 timeout 契约清晰；redirect 信任边界未定义。新增 `DEF-SEC-001`。
2. 架构边界：本地鉴权头会被替换，但 buffered redirect 绕过 origin 边界继续携带上游凭证。
3. 失败路径：确认无界响应缓冲 `DEF-REL-003`，以及 token 非 2xx 过度隔离 `DEF-REL-004`。
4. 验证与运行：现有测试覆盖 deadline、背压、关闭竞态，但缺少跨源 redirect、响应体上限和 HTTP 分类矩阵。
5. 对抗复核：以恶意 redirect、无限 chunked 响应、客户端构造 400 三种场景反向验证，均可到达缺陷路径；未发现新的独立根因。

## 准入与修复顺序

- `DEF-SEC-001`：Verified。
- `DEF-REL-003`：Verified。
- `DEF-REL-004`：Closed，产品确认的预期行为。
- 最终准入结论：修复通过自动化验证后通过。
