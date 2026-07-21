# Feature: Sub2API Agent Identity 账号接入

**作者**: Codex
**日期**: 2026-07-21
**状态**: Implemented

---

## 1. 背景 (Background)
### 1.1 问题描述
- Airouter 当前仅支持通过 `access_token` 和 `chatgpt-account-id` 转发 ChatGPT/Codex token 账号，请求认证固定使用 Bearer token。
- Sub2API 新版可导出 OpenAI Agent Identity 账号。该格式不保存 OAuth access/refresh token，而是使用 Ed25519 私钥、runtime ID 和 task ID 为每次请求动态生成 `AgentAssertion`。
- 现有管理台和服务端导入逻辑要求 `access_token/account_id`，会拒绝 Agent Identity 对象；即使手工写入配置，运行态也会因缺少 access token 被标记为不可用，无法参与 Responses 转发、额度刷新和自动切号。
- 需要让 Airouter 直接接收 Sub2API Agent Identity 账号导出对象，并在不破坏传统 token 账号的前提下复用现有调度和 failover 能力。
### 1.2 现状分析
- `public/config-admin.js` 和 `public/config-admin.html` 负责管理台 OpenAI token 导入与展示。当前 OAuth 导出识别依赖 `credentials.access_token`，没有 token 子类型概念。
- `app/config-editor.js` 负责服务端导入转换和持久化归一化。当前 `buildImportedConfigItem()` 将 OAuth/AuthSession 压平为 `access_token`、`account_id`、`refresh_token` 等传统 token 字段。
- `app/openai-config.js` 负责配置校验、运行时配置构造和认证头生成。当前 token 运行态以 `access_token && account_id` 判断是否启用，并固定生成 Bearer 认证。
- `app/account-manager.js` 负责 token 账号额度刷新、可用性状态、粘性调度和 failover。额度请求与 Responses 转发共用认证头构造，但传统 token 的 401 恢复逻辑只支持 refresh token。
- `openai.js` 负责将客户端请求规范化后转发到 ChatGPT Codex backend-api。它会清理本地鉴权头、注入所选账号认证、处理流式响应和在可重试错误时切换账号。
- 未写 `type` 的历史配置仍按 `token` 处理；`type=token` 是现有 Responses 主链路和额度监控的调度边界。
### 1.3 主要使用场景
- 管理员在 Airouter 管理台粘贴单个或批量 Sub2API OpenAI Agent Identity 账号导出对象，系统自动生成可持久化配置。
- Agent Identity 账号与传统 token 账号共同进入 OpenAI token 池，参与会话粘性调度、并发分配、额度检查和 Responses failover。
- Airouter 使用 Agent Identity 账号转发 `/v1/responses`、由 `/v1/messages` 转换产生的 Responses 请求，以及现有其他复用 token Responses 链路的请求。
- Airouter 定时或手工查询 Agent Identity 账号的 `/backend-api/wham/usage` 额度；task 失效时恢复 task 后重试一次。

## 2. 目标 (Goals)
- 支持将 Sub2API OpenAI Agent Identity 账号对象导入并规范化为 `type=token, subtype=sub2api` 配置。
- 使用与 Sub2API 一致的动态签名、请求头和 task 恢复语义完成 Responses 与额度请求，同时完整复用 Airouter 现有 token 调度和 failover 能力。
- 保证传统 token、apikey 和 Claude token 的现有配置、认证、刷新及转发行为保持兼容。
### 2.1 非目标 (Non-Goals)
- 不新增第四种顶层配置 `type`；`sub2api` 仅作为 `token` 的子类型。
- 不支持 Sub2API 的其他平台、其他 OAuth 形态、代理/分组备份或完整数据包恢复；本期只支持 `platform=openai + type=oauth + auth_mode=agentIdentity`。
- 不把 Airouter 改造成 Sub2API 的完整协议转换层，不迁移其数据库、计费或管理功能。
- 不改变传统 OAuth token 的 Bearer 认证和 refresh token 刷新流程。
- 不在自动化测试中使用真实账号、私钥、task ID 或真实上游网络请求。

## 3. 需求细化 (Requirements)
### 3.1 功能性需求
- 管理台和管理 API 必须接受单个对象、对象数组以及现有 token 导入形式；仅当对象满足 `platform=openai`、`type=oauth` 且 `credentials.auth_mode` 大小写归一后为 `agentIdentity` 时识别为 Sub2API Agent Identity。
- 导入后必须持久化为 `type=token, subtype=sub2api`，保留 Agent Identity 运行必需字段，并将账号名称、并发、优先级和倍率等可用配置字段按 Airouter 配置语义保存。
- Agent Identity 必填字段至少包括 runtime ID、PKCS#8 Ed25519 私钥、ChatGPT account ID 和 ChatGPT user ID；task ID 允许缺失。无效条目不得影响同批次其他条目的错误定位和保存结果。
- 管理台必须能区分传统 OpenAI token 与 Sub2API Agent Identity，展示安全的账号标识，不得把私钥或动态断言渲染为普通文本或写入日志。
- `subtype=sub2api` 配置必须继续以运行时 `type=token` 参与现有 token 账号池、额度监控、粘性调度、并发分配和 Responses failover。
- 每次 Agent Identity 上游请求必须使用当前 UTC 时间、runtime ID、task ID 和 Ed25519 私钥生成新的 `AgentAssertion`，不得回退成空 Bearer token 或复用过期断言。
- Responses 请求必须转发到 ChatGPT Codex backend-api，并注入动态 Authorization、ChatGPT account ID、可选 FedRAMP 标记以及 Airouter 现有 Codex 兼容头；不得把客户端本地鉴权头转发到上游。
- 额度请求必须使用 Agent Identity 动态认证，并补齐 Sub2API 额度查询所需的 Codex/语言/fetch/priority 请求头；额度响应继续进入现有运行时可用性计算。
- Agent Identity 不得进入 OAuth refresh token 流程。收到明确的 task 无效、缺失或过期响应时，系统必须按 runtime 注册新 task、持久化新 task ID，并对原请求最多重试一次。
- task 注册成功但本地持久化失败时必须返回明确失败，不得继续使用未落盘的新 task 制造运行时与配置文件不一致。
- 并发请求同时发现同一账号 task 失效时，必须合并为一次恢复操作；等待者复用持久化后的新 task，不得并发注册多个 task。
- `disabled_configs`、重新启用、排序、热重载和运行时 reconcile 必须保留 `subtype` 及其嵌套凭据，且不得用传统 token 的空字段覆盖 Agent Identity 配置。
- 管理 API 返回和复制配置的行为必须遵守现有管理员鉴权；Agent Identity 私钥必须按敏感凭据处理，不能出现在无鉴权接口、普通状态对象或错误响应中。
### 3.2 非功能性需求
- **兼容性**：没有 `subtype` 的历史 token 配置继续使用 Bearer token；现有 apikey、Claude token、Responses 请求体转换和 failover 行为不变。
- **安全性**：私钥仅用于本地签名；日志、错误、状态摘要和测试快照必须脱敏 `agent_private_key`、runtime/task ID、动态断言和现有 token。上游请求继续使用 TLS，禁止关闭证书校验。
- **故障恢复**：所有新增网络调用必须使用现有超时和代理边界；只对能够确认 task 失效的业务响应执行一次恢复，网络超时不得推断 task 已失效或盲目注册新 task。
- **一致性**：新 task 必须先成功写入配置文件并完成运行态同步后再用于重试；配置写入失败时保留旧配置并暴露可诊断错误。
- **性能**：正常请求只增加一次本地 Ed25519 签名，不新增额外网络调用；task 注册仅在缺少 task 或明确失效时发生，并按账号串行合并。
- **可观测性**：日志应能区分导入校验失败、断言生成失败、task 注册失败、task 持久化失败、额度失败和 Responses 上游失败，但不得记录敏感值或完整上游错误体。
- **可维护性**：认证、签名和 task 恢复应形成可测试的独立模块，由 Responses 和额度路径共同复用；Ed25519 使用 Node.js 内置 `crypto`，sealed-box 兼容使用最小化的 `tweetnacl` 和 `blakejs` 依赖。
- **测试性**：使用伪造 Ed25519 PKCS#8 密钥、可控时间和本地 HTTP stub 覆盖签名、请求头、导入、持久化、并发恢复、失败重试及传统 token 回归。

## 4. 设计方案 (Design)
### 4.1 方案概览
- 复用 `type=token` 的调度边界，以 `subtype=sub2api` 区分认证方式；传统 token 继续使用 Bearer token。
- `app/sub2api-agent-identity.js` 统一负责导出识别、凭据校验、Ed25519 签名、sealed-box task 解密、请求头、task 错误识别、注册和并发恢复合并。
- 配置导入层只做规范化和本地密码学校验；运行时在业务/额度请求前确保 task 存在。
- task 恢复采用“注册 -> 原子持久化 -> 更新运行态 -> 同账号重试一次”的顺序。
### 4.2 组件设计 (Component Design)
#### 4.2.1 核心类/模块设计
- `sub2api-agent-identity`：无状态签名函数和有状态 task recovery manager。
- `config-editor`：将 Sub2API 导出规范化为持久化配置，保留可识别元数据。
- `openai-config`：构造 `type=token` 运行态并按 purpose 生成 Responses/Quota 请求头。
- `account-manager`：额度请求前确保 task，明确 task 失效时同账号重试；Agent Identity 不进入 refresh token。
- `openai.js` / `claude-messages-handler`：Responses、Messages 转换和 Images 业务请求的一次 task 恢复。
#### 4.2.2 接口设计
- 管理 API 路径保持不变：`POST /admin/api/configs`，`config_type=token` 时接受单个或数组导出。
- 核心模块暴露 `buildAgentAssertion`、`buildSub2ApiAuthHeaders`、`isSub2ApiTaskInvalidResponse` 和 `createSub2ApiAgentIdentityManager`。
- 不新增外部业务 API；客户端仍请求现有 `/v1/responses`、`/v1/messages`、Images 和 `/wham/*`。
#### 4.2.3 数据模型
- 持久化模型固定为 `type=token, subtype=sub2api, credentials={...}`。
- 必填：`auth_mode`、`agent_runtime_id`、`agent_private_key`、`chatgpt_account_id`、`chatgpt_user_id`；`task_id` 可缺失。
- 运行态复制嵌套 credentials，顶层 `account_id` 映射自 `chatgpt_account_id`，便于复用调度与展示。
#### 4.2.4 并发模型
- recovery manager 使用稳定账号标识 `subtype + account ID + runtime ID` 作为 Map key。
- 同一账号同时恢复时共享同一个 Promise；不同账号可以并行恢复。
- 热重载身份不包含私钥和 task ID，task 轮换不会丢失运行态。
#### 4.2.5 错误处理
- 只有 HTTP 401 且错误体明确包含 task 无效标记才恢复。
- 网络异常、超时、普通 401、token revoked 不推断 task 失效。
- 注册、解密或持久化失败均终止同账号重试；错误不包含私钥、断言或完整上游响应体。
- 原业务请求最多执行一次 task recovery replay，之后回到既有 failover。
### 4.3 核心逻辑实现
- 断言 payload：`runtime_id + ":" + task_id + ":" + RFC3339 UTC timestamp`。
- 使用 PKCS#8 Ed25519 私钥签名，signature 用标准 Base64；JSON envelope 用无 padding Base64URL，认证 scheme 为 `AgentAssertion`。
- task 注册签名 payload：`runtime_id + ":" + timestamp`，请求 `POST /api/accounts/v1/agent/{runtime}/task/register`。
- 注册响应同时支持明文 `task_id` 和 libsodium sealed-box `encrypted_task_id`；后者使用 Ed25519 seed 转 X25519、BLAKE2b nonce 和 NaCl box 解密。
### 4.4 方案优劣分析
- 优点：不扩展顶层调度类型；认证和恢复由 Responses/Quota 共用；传统 token 改动小；恢复顺序可保证磁盘与内存一致。
- 局限：Sub2API 顶层并发/优先级元数据只保留，不改变 Airouter 既有调度算法；协议变化需要同步维护 Agent Identity 模块。

## 5. 备选方案 (Alternatives Considered)
- 新增顶层 `type=sub2api`：会扩散到所有 token 调度判断和管理台分组，放弃。
- 将 Agent Identity 转换为静态 Bearer token：协议不成立且会丢失每请求动态签名，放弃。
- 只支持导出中现成 task，不实现恢复：task 过期后账号不可用，不能满足实际运行要求，放弃。

## 6. 业界调研 (Industry Research)

> **注意**：本章节应在完成自主设计后填写，用于验证方案、确保下限，而非作为设计的起点。

### 6.1 业界方案
- 直接对照 Wei-Shaw/sub2api 的 `openai_agent_identity.go`、quota 和 gateway forwarding 实现。
- 加密原语遵循 Ed25519、X25519、NaCl sealed box 与 BLAKE2b 的标准组合。
### 6.2 对比分析
- 签名 envelope、请求头、task 注册、明文/加密响应和错误识别与 Sub2API 对齐。
- Airouter 没有数据库账号表，因此用配置文件原子 rename 作为持久化边界，用 Promise Map 替代数据库账号锁。
- 避免将任何 401 或网络超时误判为 task 失效，避免无限恢复循环。

## 7. 测试计划 (Test Plan)
### 7.1 单元测试
- Ed25519 私钥校验、断言时间/签名验证、Responses/Quota 请求头。
- sealed-box task 解密、明文 task 响应、并发恢复合并、持久化失败不更新运行态。
- Sub2API 单个/数组导入、缺字段和私钥错误、运行时构造、稳定身份。
### 7.2 集成测试
- 额度明确 task 失效后恢复并重试，普通 401 不恢复且不 refresh。
- Responses 代理边界、Messages 转换和 Images 同账号恢复一次。
- 管理台导入、subtype/安全身份展示和传统配置回归。
### 7.3 性能测试（如适用）
- 正常请求仅增加一次本地 Ed25519 签名；无独立性能压测要求，以全量测试无显著回归为准。

## 8. 可观测性 & 运维 (Observability & Operations)

### 8.1 可观测性
- **日志 (Logging)**: task 准备/恢复失败按账号安全描述输出，不输出私钥、断言、runtime/task ID 或完整错误体。
- **监控指标 (Metrics)**: 复用现有额度状态、quota failure 和 failover 状态，无新增持久化指标。
- **告警 (Alerting)**: 连续 quota failure 达到现有阈值时沿用账号不可用行为。

### 8.2 配置参数 (Configuration)
| 参数名 | 类型 | 默认值 | 说明 | 是否支持动态修改 |
|--------|------|--------|------|------------------|
| `configs[].subtype` | string | 空 | `sub2api` 启用 Agent Identity 认证 | 是 |
| `configs[].credentials.task_id` | string | 空 | 当前 task；缺失或失效时自动注册并写回 | 是 |

### 8.3 运维接口 (Operations Interfaces)
- 无新增运维接口；使用现有管理页导入、刷新额度、停用/启用和删除操作。

### 8.4 运维注意事项 (Operations Considerations)
- **升级兼容性**: 历史 token/apikey/claude_token 无迁移；安装新增 npm 依赖后重启即可。
- **回滚方案**: 停用 `subtype=sub2api` 配置并回滚代码；传统配置不受影响。
- **资源影响**: 每请求一次 Ed25519 签名；仅 task 恢复产生额外注册请求。
- **故障处理**: task 恢复持续失败时停用对应账号，检查 runtime/private key 和上游注册可达性后重新导入。

## 9. Changelog
| 日期 | 变更内容 | 作者 |
|------|----------|------|
| 2026-07-21 | 完成 Agent Identity 导入、动态认证、额度/业务转发、task 恢复和管理台支持 | Codex |

## 10. 参考资料 (References)
- https://github.com/Wei-Shaw/sub2api
- https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/service/openai_agent_identity.go
