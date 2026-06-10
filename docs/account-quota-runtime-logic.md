# 账号额度刷新与切换逻辑（当前实现）

**Date:** 2026-05-30

**Status:** Current

本文档描述 GPT 链路中 `token` 配置项当前已经落地的账号额度刷新、可用性判定、请求级会话调度、活动账号选择、`apikey` 失败窗口与恢复探测，以及管理页强制刷新的真实行为。

适用代码：

- `app/account-manager.js`
- `openai.js`

不适用范围：

- `support` 只包含 `claude` 的 apikey 原样转发细节
- 历史设计文档中已经过时的轮询策略说明

## 1. 适用模式

只有 `token` 配置项会启用账号额度管理和每分钟额度轮询。

`apikey` 配置项：

- 不参与账号额度轮询
- 不参与 token 并发调度、一致性哈希或 `inFlight` 计数
- 只有 token 不可用时，才按原有可用性/顺序语义作为 fallback
- 直连上游会记录最近 30 分钟内最多 10 个已完成真实请求，401/403、429、5xx、请求失败或响应体中断累计达到 3 次时，会被临时标记为不可用
- 普通 apikey 代理只有在上游响应体完整结束后才记录成功；请求失败或响应体错误会记录失败
- 已被标记为不可用且 `support` 包含 `gpt` 时，会在每 10 分钟全量校正中用 `/v1/responses` 的 `hello` 请求探测；上游返回 2xx 时恢复为可用
- GPT apikey 恢复探测默认使用模型 `gpt-5.5`，可通过配置项里的 `health.model` 覆盖
- 只支持 `claude` 的 apikey 不做 `/v1/responses` 恢复探测
- 手动切换到某个 `apikey` 配置项时，会把该配置恢复为可用

后台每分钟轮询所有 `token` 配置项；每 10 分钟也会全量轮询所有 `token` 配置项，并额外探测已不可用的 GPT apikey。定时轮询中账号之间间隔 1 秒。

## 2. 运行时核心对象

每个账号在运行时维护一份 `runtime` 状态，核心字段包括：

- `enabled`
- `available`
- `reason`
- `lastCheckedAt`
- `lastError`
- `remainingPercent`
- `primaryRemainingPercent`
- `secondaryRemainingPercent`
- `inFlight`（仅 token 并发调度使用）
- `quotaCheckFailures`（仅 token 额度检查失败保护使用）
- `apiKeyRequestResults`（仅 apikey 最近请求窗口使用）

其中：

- `primary*` 表示主额度窗口
- `secondary*` 表示辅助/周额度窗口
- 对外汇总口径跟随主额度窗口；可用性同时检查主额度和周额度

## 3. 账号可用性判定

### 3.1 额度接口成功返回时

当 `/backend-api/wham/usage` 返回成功后，当前实现按以下顺序判定账号可用性：

1. 订阅/会员显式失效
   - 包括 `subscription.active === false`、`has_active_subscription === false`、`plan_type === "free"` 等形态
   - 标记为不可用
   - `reason = membership_expired`
2. 主额度窗口存在但周额度窗口缺失，且没有明确的付费计划信号
   - 作为会员过期/未订阅的兼容兜底
   - 标记为不可用
   - `reason = membership_expired`
3. `rate_limit.allowed === false`
   - 标记为不可用
   - `reason = rate_limit_not_allowed`
4. `rate_limit.limit_reached === true`
   - 标记为不可用
   - `reason = rate_limit_reached`
5. 主额度窗口剩余百分比 `< minRemainingPercent`
   - 标记为不可用
   - `reason = remaining_below_3%`
6. 周额度窗口剩余百分比 `<= minWeeklyRemainingPercent`
   - 标记为不可用
   - `reason = secondary_remaining_not_above_1%`
7. 以上都不满足
   - 标记为可用
   - `reason = ok`

说明：

- 当前主额度默认阈值为 `3%`
- 当前周额度默认阈值为 `> 1%`
- `remainingPercent` 的对外汇总口径跟随主额度窗口
- `secondaryRemainingPercent` 用于展示，也参与周额度可用性判断

### 3.2 额度接口失败时

当额度检查请求超时、网络失败、返回非 2xx，或响应解析失败时：

- 当前 token 账号不会因为单次 quota 检查失败立即摘除
- `quotaCheckFailures` 会连续累加，成功拿到额度 payload 后清零
- 前 2 次连续失败保留原来的 `available` 与 `reason`
- 第 3 次连续失败才标记为不可用
- 第 3 次失败后 `reason = quota_check_failed`
- `lastError` 记录原始错误信息

这样可以避免短暂网络抖动把仍可转发的 token 账号过早摘除；连续失败达到阈值时，仍会进入正常不可用与切换流程。

### 3.3 非额度查询场景下的主动失效

当真实业务请求已经命中某个 token 账号，但响应被识别为需要自动切号时，系统会直接把当前账号标记为不可用。apikey 账号不会因单次上游错误立即摘除，而是记录最近 30 分钟内最多 10 个已完成真实请求结果；其中 401/403、429、5xx、请求失败或响应体中断累计达到 3 次时，才把当前 apikey 标记为不可用。

当前已接入的场景：

- `/v1/responses` 自动切号
- `apikey` 直连上游最近 30 分钟内最多 10 个真实请求累计 3 次 401/403、429、5xx、普通代理请求失败或响应体中断摘除
- 每 10 分钟全量校正中的 GPT apikey 恢复探测

此时会：

- token 自动切号会调用 `markConfigUnavailable()`；apikey 达到窗口阈值后也会进入同样的不可用标记流程
- 设置对应失败原因
- 记录 `lastError`
- token 请求按相同会话 key 在一致性哈希候选中排除失败账号，尝试切到下一个可用 token 账号
- apikey 请求不进入一致性哈希；失败后仍按传统可用性/顺序选择 fallback
- 如果失效账号正好是活动账号，再按活动账号选择逻辑切换活动账号

## 4. 请求级会话调度

token 业务请求不再固定使用全局活动账号，而是先按请求级 lease 选择 token 账号。`apikey` 配置项不参与这套并发调度。

### 4.1 有会话 key 的请求

请求会按下面顺序提取会话 key：

1. `x-airouter-session-id`
2. `session-id`
3. `session_id`
4. `x-client-request-id`
5. URL 查询参数里的 `session_id`、`conversation_id`、`thread_id`、`previous_response_id`
6. JSON body 顶层的 `session_id`、`conversation_id`、`thread_id`、`previous_response_id`

命中会话 key 后：

- 使用稳定 token 账号身份做 HRW/Rendezvous 一致性哈希打分
- 相同会话 key 会尽量落到同一个 token 账号
- 命中的账号不可用时，沿当前可用账号集合重新落点
- failover 时会排除刚失败的账号，再按同一个会话 key 选择下一个账号
- 不记录 `session_id -> 账号` 映射，不持久化会话数据
- 运行态只保留最近一次调度观测，管理页显示短 hash 和落点，例如 `当前会话 #a1b2c3d4e5f6 -> 配置 #3`

### 4.2 没有会话 key 的请求

没有会话 key 时，token 请求使用当前内存中的 `inFlight` 计数做轻量分摊：

- 优先选择可用且支持当前接口的 token 账号
- 选择 `inFlight` 最少的 token 账号
- 并列时按一个内存游标轮转
- 请求结束、失败或客户端断开后释放 `inFlight`

## 5. 活动账号选择逻辑

活动账号仍然存在，主要用于管理页展示、手动切换、无可用账号时的兜底，以及额度刷新后的状态校正。活动账号选择由 `ensureActiveConfig(reason)` 负责，规则如下：

管理页手动切换的语义是：

- 切换到 token：回到 token 并发池，并把该 token 设为调度锚点
- 切换到 apikey：进入 API Key 覆盖模式，该 apikey 支持的流量优先全量走它
- apikey 覆盖中的账号失败后，会被临时摘除，再回到 token 并发池或其他可用 fallback

1. 如果当前活动配置符合当前路由能力且 `runtime.available = true`，继续保持当前配置。
2. 如果当前活动配置不可用或不支持当前路由，按 `configs[]` 顺序从前到后扫描。
3. 找到第一个符合当前路由能力且 `runtime.available = true` 的配置后立即切换。
4. 如果没有找到任何可用账号：
   - 保留当前账号
   - 记录“没有可用账号，继续使用当前账号”日志

配置顺序调整是例外：管理页“置顶”只改变 `configs[]` 顺序，并按配置身份保留当前活动配置，不会因为保存顺序而触发重新选路。

补充说明：

- 这里的“下一个可用账号”指的是**当前运行时状态中已经被判定为可用的账号**
- 是否先刷新账号，再用这套选择规则，由调用方控制

## 6. 启动与热重载逻辑

服务启动、配置热重载、管理页新增/删除/停用/启用配置项后，会进入一次刷新流程：

1. 创建或重建 `accountManager`
2. 调用 `refreshQuotas(reason)`
3. 全量刷新 `configs[]` 中所有 token 账号额度
4. 刷新完成后调用 `ensureActiveConfig(reason)`
5. 启动后台额度轮询定时器

也就是说：

- 启动时一定会做一次全量额度刷新
- 热重载时也会重新做一次全量额度刷新
- `disabled_configs[]` 是停用配置列表，不会参与运行时调度、额度刷新或 fallback；只有从管理页启用回 `configs[]` 后才会重新进入运行态

## 7. 后台轮询逻辑

后台定时器分为两类：

- 每分钟执行一次 `refreshQuotas('poll')`
- 每 10 分钟执行一次 `refreshQuotas('all_poll')`

当前 `poll` 分支的行为是：

1. 按 `configs[]` 顺序刷新所有 token 账号
2. 定时器触发的后台轮询会在账号之间等待 1 秒
3. 刷新结束后，统一执行一次 `ensureActiveConfig('poll')`
4. 输出当前活动账号摘要日志

这个逻辑的含义是：

- 一致性哈希并发调度下，非活动账号也可能承载请求，因此每分钟都要刷新所有 token 账号
- 账号失效不必等业务请求命中才发现
- 恢复可用的账号会在下一轮分钟级轮询或管理页强制刷新中重新进入调度集合

### 7.1 十分钟全量轮询

`all_poll` 分支的行为是：

1. 按 `configs[]` 顺序刷新所有 token 账号
2. 每两个账号的刷新请求之间等待 1 秒
3. 刷新结束后调用 `ensureActiveConfig('all_poll')`
4. 输出当前活动账号摘要日志

因此：

- 全量刷新不会集中瞬间打满所有账号额度接口
- 恢复可用的账号通常会在分钟级轮询中被发现；十分钟全量轮询保留为额外校正
- 如果当前账号仍然可用，不会因为较早配置项恢复就主动切回

### 7.2 并发保护

如果上一轮轮询还没结束，新的轮询周期到了：

- 新的一轮会直接跳过
- 不会并发执行多个 `refreshQuotas()`

这由 `quotaMonitorRunning` 锁保护。

## 8. 管理页刷新逻辑

管理页现在有两种不同语义的接口：

### 8.1 只读取当前快照

`GET /admin/api/configs`

行为：

- 只返回当前内存中的配置与运行时状态
- 不触发额度刷新
- token 账号的运行态包含安全的 `dispatch_session` 观测；它只用于显示当前/最近命中的会话短 hash，不包含原始会话 ID
- 账号运行态包含 `response_model` 观测；它记录最近一次请求模型和上游响应模型，用于管理页观察是否出现实际模型变化

适用场景：

- 页面初始化
- 普通重新加载页面
- 其他依赖当前快照的调用方

### 8.2 强制刷新所有账号额度后再返回快照

`POST /admin/api/configs/refresh`

行为：

1. 如果当前模式启用了额度管理：
   - 调用 `refreshQuotas('admin_refresh')`
   - 因为 `reason !== 'poll'`，所以会全量刷新所有账号
2. 刷新完成后返回最新管理页快照

管理页顶部“刷新”按钮使用的是这个接口。

因此当前按钮语义是：

- 不是“重新读一遍状态”
- 而是“强制把所有账号额度实际刷新一遍，再显示最新结果”

## 9. 实时额度更新入口

除了后台轮询和管理页强制刷新以外，系统还有一条实时更新账号额度的路径：

- 当代理请求本身就是额度查询接口时
- 响应返回后会立即解析额度 payload
- 并调用 `applyQuotaPayload()` 更新当前账号状态

这意味着：

- 某些账号状态可能在正常请求过程中被即时修正
- 不一定要等下一分钟轮询才变化

## 10. 当前日志语义

与账号刷新和切换相关的主要日志包括：

- `账号不可用`
  - 某个账号从可用变为不可用
- `账号恢复可用`
  - 某个账号从不可用恢复为可用
- `账号切换`
  - 活动账号发生切换
- `当前活动账号`
  - 本轮刷新后活动账号索引发生变化
- `轮询额度`
  - 每分钟轮询或 10 分钟全量轮询结束后输出当前活动账号摘要

## 11. 当前实现的关键结论

为了快速判断系统行为，可以直接记住下面这几条：

1. 启动和热重载会全量刷新所有账号。
2. 每分钟轮询刷新所有 token 账号。
3. 定时轮询会在账号之间间隔 1 秒。
4. 有会话 key 的 token 请求走 HRW/Rendezvous 一致性哈希，尽量固定到同一 token 账号。
5. token 账号失效后，同一请求会排除失败账号并尝试在剩余账号中按同一会话 key 重新选择 token 账号。
6. `quota_check_failed` 当前会直接把账号判定为不可用。
7. 管理页 `GET /admin/api/configs` 只读快照，不刷新额度。
8. 管理页 `POST /admin/api/configs/refresh` 会强制全量刷新后再返回快照。

## 12. 推荐阅读顺序

如果要继续改这块逻辑，建议按这个顺序看代码：

1. `app/account-manager.js`
   - `acquireConfig()`
   - `evaluateQuotaPayload()`
   - `ensureActiveConfig()`
   - `refreshQuotas()`
2. `openai.js`
   - `reloadRuntime()`
   - `refreshConfigAdminResponse()`
   - `/admin/api/configs/refresh`
3. `test/account-manager.test.js`
4. `test/openai-admin-refresh.test.js`
