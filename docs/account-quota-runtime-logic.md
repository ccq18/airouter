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
- 只有 token 不可用时，才按原有可用性/顺序语义作为 fallback；这也适用于 `/v1/messages` 的 GPT apikey Responses 转换路径
- 直连上游在响应提交给客户端前遇到任意非 200 HTTP 状态、请求失败或响应体中断时，会在本次请求内先尝试切到下一个可用配置
- 普通 apikey 代理在响应提交给客户端时记录成功；响应提交后发生的传输中断不会再触发透明切换，也不会把本次请求记为失败
- 最近 30 分钟内最多 10 个已完成真实请求累计 3 次失败时，apikey 会被临时标记为不可用
- 已被标记为不可用且是当前 OpenAI fallback 焦点、`support` 包含 `gpt` 时，会在每 3 分钟全量校正中用 `/v1/responses` 的 `hello` 请求探测；上游返回 HTTP 200 时恢复为可用
- GPT apikey 恢复探测默认超时为 `30000ms`（30 秒），可用环境变量 `APIKEY_RECOVERY_TIMEOUT_MS` 覆盖；该超时独立于 token 额度检查的短超时
- GPT apikey 恢复探测默认使用模型 `gpt-5.4-mini`，管理页新增 fallback apikey 时可选择 `gpt-5.4-mini` 或 `gpt-5.4`，对应写入配置项里的 `health.model`
- 管理页会显示当前 OpenAI fallback 焦点的 GPT apikey 恢复探测是否启用、是否待恢复、上次探测时间、结果、HTTP 状态/错误和探测模型
- 只支持 `claude` 的 apikey 不做 `/v1/responses` 恢复探测
- 管理页分别提供 OpenAI fallback 与 Claude fallback 两个 apikey 焦点开关；手动切换到某个 `apikey` 配置项时，只会调整对应链路的焦点，并把该配置恢复为可用

后台每分钟只轮询当前活动配置（当前活动配置为 `token` 时）；每 3 分钟全量轮询所有 `token` 配置项，并额外探测已不可用的当前 OpenAI fallback 焦点。全量轮询中账号之间间隔 1 秒。

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
- `unavailableUntil`（仅 token 请求失败冷却使用）
- `apiKeyRequestResults`（仅 apikey 最近请求窗口使用）

其中：

- `primary*` 表示主额度窗口
- `secondary*` 表示辅助/周额度窗口
- 对外汇总口径跟随主额度窗口；周额度只展示，不参与可用性摘除
- `unavailableUntil` 是毫秒时间戳；为空表示没有请求失败冷却

## 3. 账号可用性判定

### 3.1 额度接口成功返回时

当 `/backend-api/wham/usage` 返回成功后，当前实现按以下顺序判定账号可用性：

额度接口成功返回可用状态时，会清空 token 的请求失败冷却字段 `unavailableUntil`。
1. `rate_limit.allowed === false`
   - 标记为不可用
   - `reason = rate_limit_not_allowed`
2. `rate_limit.limit_reached === true`
   - 标记为不可用
   - `reason = rate_limit_reached`
3. 主额度窗口剩余百分比 `< minRemainingPercent`
   - 标记为不可用
   - `reason = remaining_below_3%`
4. 以上都不满足
   - 标记为可用
   - `reason = ok`

说明：

- 当前主额度默认阈值为 `3%`
- 当前不校验会员状态
- 当前不校验周额度；周额度窗口缺失或周额度很低都不会直接标记 token 不可用
- `remainingPercent` 的对外汇总口径跟随主额度窗口
- `secondaryRemainingPercent` 仅用于展示

### 3.2 额度接口失败时

当额度检查请求超时、网络失败、返回非 2xx，或响应解析失败时：

- 当前 token 账号不会因为单次 quota 检查失败立即摘除
- `quotaCheckFailures` 会连续累加，成功拿到额度 payload 后清零
- 前 2 次连续失败保留原来的 `available` 与 `reason`
- 第 3 次连续失败才标记为不可用
- 第 3 次失败后 `reason = quota_check_failed`
- `lastError` 记录原始错误信息

这样可以避免短暂网络抖动把仍可转发的 token 账号过早摘除；连续失败达到阈值时，仍会进入正常不可用与切换流程。

例外：额度接口返回 401 或缺少凭证时，如果配置带 `refresh_token` 但刷新失败，系统会立即把该 token 标记为不可用，`reason = token_refresh_failed`，不会继续显示为可用。

### 3.3 非额度查询场景下的主动失效

当真实业务请求已经命中某个 token 账号，且响应被识别为额度错误或上游错误时，系统会直接把当前账号标记为不可用。请求非 `gpt-5.4-mini` 或它的日期版本后缀时，成功响应被降级成 `gpt-5.4-mini` 或同名日期版本只触发本次请求切走，不标记账号不可用；系统会在运行态模型观测里记录 `downgraded = true`。apikey 账号不会因单次上游错误立即摘除，而是记录最近 30 分钟内最多 10 个已完成真实请求结果；响应提交给客户端前的非 200 HTTP 状态、请求失败或响应体中断累计达到 3 次时，才把当前 apikey 标记为不可用。

当前已接入的场景：

- `/v1/responses` 自动切号
- `/v1/messages` 业务请求自动切号
- `/v1/images/generations` 和 `/v1/images/edits` 业务请求自动切号
- `responses_model_downgraded` 模型降级请求级切换，不改变账号可用性
- `responses_model_at_capacity` 模型容量不足会触发自动切号，并把当前 token 临时摘除
- 普通 token 代理在响应提交前遇到上游非成功 HTTP 状态、请求异常或响应体异常时，也会临时摘除当前 token 并重放到下一个可用配置
- `/v1/messages` 的 responses 兼容链路会把 `event: response.failed`、`event: error`、格式异常和流中断统一视为可切换异常
- 图片兼容路径中，即使上游 HTTP 200，只要 Responses body 不能提取出有效图片结果，也会视为异常并切号
- 同一个业务请求发现可切换错误后会找下一个可用配置重放，但最多重放 2 次；第 3 个配置仍失败时返回该次上游错误
- `apikey` 直连上游最近 30 分钟内最多 10 个真实请求累计 3 次提交响应前的非 200 HTTP 状态、普通代理请求失败或响应体中断摘除
- 每 3 分钟全量校正中的 GPT apikey 恢复探测

此时会：

- token 额度错误或上游错误自动切号会调用 `markConfigUnavailable()`；`responses_model_downgraded` 不会调用该流程
- 模型降级会写入 `response_model.downgraded = true`，用于管理页和运行态摘要展示
- apikey 达到窗口阈值后也会进入不可用标记流程
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

活动账号仍然存在，主要用于管理页展示、手动切换、静态配置 fallback 顺序，以及额度刷新后的状态校正。活动账号选择由 `ensureActiveConfig(reason)` 负责，规则如下：

管理页手动切换的语义是：

- 切换到 OpenAI token：把该 token 设为 Responses 主链路的调度焦点
- 切换到 Claude token：把该 token 设为 `/v1/messages` 原样转发主链路的焦点
- 切换 OpenAI fallback apikey：只调整 Responses/OpenAI fallback 焦点；token 主链路可用时仍优先走 token
- 切换 Claude fallback apikey：只调整 Claude Messages fallback 焦点；Claude token 主链路可用时仍优先走 Claude token
- fallback apikey 失败后，会被临时摘除，再尝试同链路下一个 token 或 fallback 配置

1. 如果当前活动配置符合当前路由能力且 `runtime.available = true`，继续保持当前配置。
2. 如果当前活动配置不可用或不支持当前路由，按 `configs[]` 顺序从前到后扫描。
3. 找到第一个符合当前路由能力且 `runtime.available = true` 的配置后立即切换。
4. 如果没有找到任何可用账号：
   - 保留当前账号
   - 记录“没有可用账号，继续使用当前账号”日志

配置顺序调整是例外：管理页“置顶”、“上移”、“下移”只改变 `configs[]` 顺序，并按配置身份保留当前活动配置，不会因为保存顺序而触发重新选路。

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
- 每 3 分钟执行一次 `refreshQuotas('all_poll')`

当前 `poll` 分支的行为是：

1. 当前活动配置是 token 时，只刷新这个 token 账号
2. 当前活动配置不是 token 时，本轮不发 token quota 请求
3. 刷新结束后，统一执行一次 `ensureActiveConfig('poll')`
4. 输出当前活动账号摘要日志

这个逻辑的含义是：

- 分钟级轮询降低为单账号检查，避免 token 较多时频繁串行访问 quota 接口
- 非活动 token 的状态由 3 分钟全量校正或管理页强制刷新更新
- 恢复可用的非活动账号会在下一轮 3 分钟全量校正或管理页强制刷新中重新进入调度集合

### 7.1 三分钟全量轮询

`all_poll` 分支的行为是：

1. 按 `configs[]` 顺序刷新所有 token 账号
2. 每两个账号的刷新请求之间等待 1 秒
3. 刷新结束后调用 `ensureActiveConfig('all_poll')`
4. 输出当前活动账号摘要日志

因此：

- 全量刷新不会集中瞬间打满所有账号额度接口
- 非活动账号的恢复通常会在三分钟全量轮询中被发现
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
- 账号运行态包含 `response_model` 观测；它记录最近一次请求模型和上游响应模型，用于管理页观察是否出现实际模型变化；同名日期版本后缀会视为一致

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

### 8.3 配置写入和排序

管理页新增、删除、停用、启用和排序等写操作会写入配置文件并重载内存运行态，但不会触发额度刷新。批量新增会一次性追加所有配置项；新增和排序路径只解析当前请求并写文件，不会完整校验历史配置。新增项如果暂时无法构建运行态，会在管理页显示为不可用配置，不会阻塞保存。

`POST /admin/api/configs/:index/move-up`、`POST /admin/api/configs/:index/move-previous` 和 `POST /admin/api/configs/:index/move-next` 只重排当前内存运行态和配置文件顺序，并返回 `ok`、`moved_from` 和 `moved_to` 等轻量确认字段；管理页收到确认后在本地快照中重排列表，避免排序时重新传输完整配置列表。

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
  - 每分钟轮询或 3 分钟全量轮询结束后输出当前活动账号摘要

## 11. 当前实现的关键结论

为了快速判断系统行为，可以直接记住下面这几条：

1. 启动和热重载会全量刷新所有账号。
2. 每分钟轮询只刷新当前活动 token；每 3 分钟全量刷新所有 token。
3. 只有全量轮询会在账号之间间隔 1 秒。
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
