# T7 Code Review Report: Sub2API Agent Identity 账号接入

> **Review Date**: 2026-07-21
> **Task**: T7 - 格式检查、定向测试、全量测试和双 reviewer 评审
> **Scope**: sssrouter，19 个实现、配置和测试文件，当前工作树统计 +2231/-272（包含重叠文件中用户已有的本地改动）
> **Reviewers**: 2 并行 reviewer（correctness-reviewer + quality-reviewer）

---

## 1. Review Scope

### 改动文件清单

1. `app/sub2api-agent-identity.js` - Agent Identity 识别、校验、签名、请求头、task 注册、解密和并发恢复。
2. `app/openai-config.js` - `type=token, subtype=sub2api` 配置校验、运行态构造和动态认证头。
3. `app/config-editor.js` - Sub2API 单对象/数组导入和持久化归一化。
4. `app/account-manager.js` - quota 动态认证、task 恢复和传统 refresh token 分流。
5. `app/claude-messages-handler.js` - Messages 转 Responses 链路的 task 准备、恢复和取消处理。
6. `app/runtime-config-reconciler.js` - Agent Identity 稳定运行时身份。
7. `openai.js` - Responses、Images、Wham、task 持久化和访问日志脱敏接入。
8. `public/config-admin.js` - 管理台 Sub2API 导入、识别和安全展示。
9. `public/config-admin.html` - 管理台导入提示和 subtype 展示入口。
10. `docs/config-item-reference.md` - 配置字段、请求头和恢复语义说明。
11. `openai.json.example` - 禁用状态的假值示例配置。
12. `package.json` - sealed-box 兼容依赖声明。
13. `package-lock.json` - 新依赖锁定。
14. `test/sub2api-agent-identity.test.js` - 密码学、请求头和 task manager 单元测试。
15. `test/account-manager.test.js` - quota、恢复和传统 token 回归测试。
16. `test/config-admin.test.js` - 管理台导入与敏感字段展示测试。
17. `test/config-editor.test.js` - Sub2API 导入、缺字段和私钥校验测试。
18. `test/proxy-boundary.test.js` - Responses、Messages、Images、Wham 和日志边界测试。
19. `test/runtime-config-reconciler.test.js` - 热重载稳定身份测试。

### 关联文档

- Spec: `spec.md` §3-8（需求、设计、测试与运维）
- Tasks: `tasks.md` T7（1 个交付任务、4 类验收证据）

### 关键设计决策（如有用户确认）

1. 使用 `type=token, subtype=sub2api` 复用现有 token 调度，不新增顶层配置类型。
2. Responses 和 quota 使用不同的 Sub2API 请求头模板，每次请求动态生成 `AgentAssertion`。
3. task 注册后先持久化并同步同身份配置，再对原请求最多重试一次。
4. Ed25519 使用 Node.js 内置 `crypto`；NaCl sealed-box 兼容仅引入 `tweetnacl` 和 `blakejs`。

---

## 2. Round 1: Findings

> correctness-reviewer 产出的 finding 归入健壮性/契约破坏/需求符合度，quality-reviewer 产出的 finding 归入性能/工程规范。

### 2.1 性能类 (Performance)

无。

### 2.2 健壮性类 (Robustness)

**F-2** (P1) - quota 在识别明文 task 错误前强制解析 JSON
- **位置**: `app/account-manager.js:1158`
- **问题**: 非 JSON 的 `401 unknown task id` 会先因 `JSON.parse` 失败退出，无法进入 task 恢复逻辑。
- **证据**: 修复后 `requestQuotaPayload()` 保留原始 `bodyText` 和独立的 `payloadParseError`，`app/account-manager.js:1264` 先用原始响应判断 task 失效；`test/account-manager.test.js:1934` 覆盖明文错误恢复。

**F-3** (P1) - Messages 在等待 task 准备或恢复时遗漏客户端取消
- **位置**: `app/claude-messages-handler.js:1108`
- **问题**: 客户端在 `ensureSub2ApiTask()` 或 `recoverSub2ApiTask()` 等待期间关闭连接后，处理器仍可能创建上游请求并占用配置租约。
- **证据**: 修复后 task 准备完成和恢复完成后均检查 `requestClosed`，`app/claude-messages-handler.js:1527` 在关闭时释放 pending/current lease；`test/proxy-boundary.test.js:1451` 验证不会启动上游。

### 2.3 工程规范类 (Standards)

**F-5** (P1) - access log 会记录完整 AgentAssertion
- **位置**: `openai.js:355`
- **问题**: 转发日志直接输出上游请求头时会泄露动态断言、账号 ID 和其他认证头。
- **证据**: 修复后 `sanitizeProxyHeadersForLog()` 对 Authorization、ChatGPT account ID、API key、Cookie 和 proxy authorization 统一脱敏；`test/proxy-boundary.test.js:210` 验证敏感值不出现在日志快照中。

### 2.4 契约破坏类 (Contract)

**F-1** (P1) - `/wham/*` 错误使用 Responses 请求头
- **位置**: `openai.js:2577`
- **问题**: 手工额度入口复用了 Responses purpose，缺少 Sub2API quota 所需的 `openai-beta=codex-1`、语言、fetch 和 priority 等请求头。
- **证据**: 修复后 `isWhamPath()` 将 Wham 请求映射为 `purpose=quota`；`test/proxy-boundary.test.js:185` 验证 quota 头完整注入。

### 2.5 需求/设计符合度类 (Spec Compliance)

**F-4** (P1) - 同一 Agent Identity 的多个配置实例只同步首个 task
- **位置**: `openai.js:1582`
- **问题**: 同账号、同 runtime 的多个持久化或运行态配置可能继续持有旧 task，导致后续请求重复失效和注册。
- **证据**: 修复后按 account ID 与 runtime ID 筛选全部匹配项并统一持久化、同步运行态；`test/proxy-boundary.test.js:242` 和 `test/sub2api-agent-identity.test.js:220` 覆盖多实例同步及 Promise 合并。

---

## 3. Round 1 Fixes（如有修复）

| ID | 优先级 | 问题 | 修复方式 | 犯错原因 |
|----|--------|------|----------|----------|
| F-1 | P1 | Wham 使用 Responses 头 | 按上游路径选择 `quota` purpose，并增加边界测试 | 执行遗漏 |
| F-2 | P1 | 非 JSON task 错误无法恢复 | 保留原始响应，延迟处理 JSON 解析错误 | 错误处理顺序考虑不足 |
| F-3 | P1 | task 等待阶段未响应客户端取消 | 增加 pending lease、关闭标记及恢复后检查 | 并发生命周期考虑不足 |
| F-4 | P1 | 同身份多配置 task 不一致 | 按稳定身份批量持久化并同步全部运行态实例 | 一致性边界考虑不足 |
| F-5 | P1 | access log 泄露动态认证头 | 集中脱敏敏感请求头并补回归测试 | 安全日志规范未完整覆盖 |

---

## 4. Round 2: Re-review（仅 Round 1 有 P0/P1 修复时执行）

> Round 1 修复后，对修复文件做定向 re-review，不重新全量审查。

- **F-1**：Wham 已使用 quota purpose，定向测试覆盖所需请求头。
- **F-2**：明文 task 错误可在 JSON 解析失败的情况下完成一次恢复。
- **F-3**：task 准备和恢复等待阶段均遵守客户端取消并正确释放租约。
- **F-4**：同身份持久化配置和运行态配置均同步到同一个 task。
- **F-5**：访问日志不再输出 AgentAssertion 或账号认证标识。
- **无新增 finding**。
- **结论: PASS**。

---

## 5. 裁决明细

| ID | 维度 | 原始优先级 | 最终处置 | 裁决依据 |
|----|------|-----------|---------|---------|
| F-1 | contract | P1 | keep，已修复 | `openai.js:2577` 按 Wham 路径选择 quota purpose，满足 spec §3.1 的额度头要求 |
| F-2 | robustness | P1 | keep，已修复 | `app/account-manager.js:1264` 在解析 payload 前使用原始 body 判断明确 task 错误 |
| F-3 | robustness | P1 | keep，已修复 | `app/claude-messages-handler.js:1119` 和 `:1527` 覆盖等待阶段取消与租约释放 |
| F-4 | spec-compl | P1 | keep，已修复 | `openai.js:1590` 和 `:1603` 同步全部持久化及运行态匹配实例 |
| F-5 | standards | P1 | keep，已修复 | `openai.js:355` 对认证、账号、Cookie 和代理认证头集中脱敏 |

---

## 6. 总体结论: PASS

Round 1 的 5 个 P1 均已修复并补充回归测试；两位 reviewer 的 Round 2 定向复审均为 PASS，未发现新增问题。

---

## 7. 正式问题

### P0（必须修复）

无。

### P1（应该修复）

无。Round 1 的 5 个 P1 已全部关闭。

### P2（建议改进）

无。

---

## 8. Follow-up Items

无。

---

## 9. Review Summary

- **Review 轮次**: 2 轮（Round 1 5 项 candidate finding -> 修复 5 项 -> Round 2 PASS）
- **P0 修复**: 0 项
- **P1 修复**: 5 项
- **P2 keep**: 0 项
- **Follow-up**: 0 项
- **验证结果**: 格式检查通过；定向测试 156/156；全量 `npm test` 428/428
- **最终结论**: PASS
