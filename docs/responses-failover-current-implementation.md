# `/responses` 自动切号当前实现说明

本文档描述的是 `airouter` 当前已经落地的 `/responses` 自动切号实现边界。

它和 [codex-error-recognition.md](/Users/lrd/code/airouter/docs/codex-error-recognition.md) 的定位不同：

- [codex-error-recognition.md](/Users/lrd/code/airouter/docs/codex-error-recognition.md) 关注接口层错误识别规则
- 本文档只记录当前代码里真正接进自动切号链路的行为

Images 业务接口的 token 兼容路径也会调用 Codex Responses，但它有独立的图片业务 failover 入口；本文只描述直接 `/v1/responses` 和 `/cpa/v1/responses` 请求里的 Responses 流式识别逻辑。

## 1. 生效范围

当前自动切号只对以下请求生效：

- 路径命中 `/responses`
- 当前账号类型是 `token`

也就是说：

- 不是所有 OpenAI 兼容接口都会自动切号
- `apikey` 配置项不会走这套 Codex responses 自动切号逻辑
- 同一个请求会排除已经失败的账号继续重试，直到没有新的可用 token 账号或响应已经开始写回客户端

## 2. 当前真正会触发自动切号的错误

当前实现把“已经进入失败识别窗口”的上游响应都当作 `/responses` 自动切号触发条件。已知错误码会映射到更具体的内部原因码；不认识的错误类型也会统一记为 `responses_unknown_error`，然后继续走切号。

- HTTP `429` 且 `error.type == "usage_limit_reached"`
- HTTP `429` 且 `error.type == "usage_not_included"`
- HTTP `401/403` 且能识别为 `unauthorized` / `token_revoked`
- 其他 HTTP 非 `200` 响应，包括 `201`、`400`、`500`、`503` 等
- 请求模型不是 `gpt-5.4-mini`，但成功响应里的实际模型是 `gpt-5.4-mini`
- SSE `response.failed` 且 `response.error.code == "insufficient_quota"`
- SSE `response.failed` 且 `response.error.code == "usage_not_included"`
- 其他 `response.failed`

对应内部原因码如下：

| 上游返回 | 内部原因码 |
| --- | --- |
| `429 + usage_limit_reached` | `responses_usage_limit_reached` |
| `429 + usage_not_included` | `responses_usage_not_included` |
| `401/403 + unauthorized/token_revoked` | `missing_credentials` |
| `其他 HTTP 非 200` | `responses_unknown_error` |
| `请求模型 != gpt-5.4-mini` 但响应模型为 `gpt-5.4-mini` | `responses_model_downgraded` |
| `response.failed + insufficient_quota` | `responses_insufficient_quota` |
| `response.failed + usage_not_included` | `responses_usage_not_included` |
| `其他 response.failed` | `responses_unknown_error` |

## 3. 当前不参与自动切号、只做识别或透传的情况

下面这些值虽然仍然属于可识别的 `responses` 错误，但当前没有接入专属的细分原因码：

- `context_length_exceeded`
- `invalid_prompt`
- `server_is_overloaded`
- `slow_down`

这些情况现在不会被当成成功透传，而是会统一归到 `responses_unknown_error`，然后继续触发账号切换。

## 4. 响应检查方式

`/responses` 的自动切号会尽量在响应提交给客户端前完成判断：

1. 如果上游是 HTTP 非 `200`，先读取完整 body，再提取 `error.type` / `error.code` / 顶层 `type` / 顶层 `code`
2. 如果上游是成功 JSON，且请求模型不是 `gpt-5.4-mini`，会先缓冲完整响应体并检查 `model` / `response.model`；只有确认没有被降级时才继续透传
3. 如果上游是 `text/event-stream`，先检查前几个 SSE 事件
4. 如果在前置事件里看到：
   - `response.created`
   - `response.in_progress`
   这两类事件，会继续等待；如果这些事件里的 `response.model` 已经从请求模型降级成 `gpt-5.4-mini`，会立即切号
5. 如果看到：
   - `response.failed` 且错误码命中可切号集合
   就中断当前转发流程，改走切号重试
6. 如果在前置阶段先看到了正常输出事件，例如 `response.output_text.delta`
   就认为这条流已经开始正常产出内容，直接透传，不再尝试切号

这意味着当前逻辑是“只在流的开头窗口内识别可切号失败”，不是在整条流生命周期内持续拦截所有错误事件。

## 5. 压缩 SSE 的处理

当前实现会优先把 `/responses` 请求头里的：

- `accept-encoding`

强制改成：

- `identity`

目的是尽量让上游返回未压缩 SSE，降低流式检查复杂度。

但为了兼容上游仍然返回压缩流的情况，当前代码也支持检查以下编码的 SSE：

- 无压缩
- `gzip`
- `br`
- `deflate`

也就是说，自动切号不会依赖“必须是未压缩 SSE”这个前提。

## 6. 触发切号后的行为

一旦命中第 2 节里的任一条件，当前逻辑会先按请求级调度寻找重试账号。额度错误、上游错误会把当前账号整体摘除；模型降级只排除当前请求里的这个账号，不改变账号可用性。

额度错误或上游错误会：

1. 调用 `markConfigUnavailable(...)`
2. 把当前账号的：
   - `runtime.available = false`
   - `runtime.reason = responses_*`
   - `runtime.lastError = <retrySource>:<retryKey>`
   - `runtime.unavailableUntil = now + token 冷却时间`
3. 调度会跳过仍在冷却期内的 token 账号

模型降级会：

1. 保持当前账号的 `runtime.available`、`runtime.reason` 和 `runtime.unavailableUntil` 不变
2. 在运行态模型观测里记录 `response_model.downgraded = true`
3. 只在本次请求的重试候选中排除当前账号

随后：

1. 如果当前请求有会话 key，排除本次失败或降级账号后按 HRW/Rendezvous 一致性哈希重新选择可用 token 账号
2. 如果当前请求没有会话 key，按可用 token 账号的 `inFlight` 计数选择重试账号
3. 用新账号重放同一个 `/responses` 请求

如果失败账号正好是活动账号，活动账号也会按现有规则切换；如果失败账号不是活动账号，则只影响运行态可用性和后续请求调度。模型降级不会触发活动账号切换，只影响本次请求重试。

也就是说：

- `usage_not_included` 当前和其他额度类错误一致
- 命中额度或上游错误后会把当前账号整体摘除并进入冷却
- 命中 `responses_model_downgraded` 后只切走本次请求，并标记模型观测为已降级
- 冷却结束后允许作为无可用账号时的 fallback 探测；额度刷新成功会直接恢复并清空冷却

## 7. 无可用账号或无法重试时的退化行为

如果命中了可切号错误，但下面任一条件不满足：

- 没有找到新的可用账号
- 剩余可用账号都已经在本次请求中失败过
- 客户端请求已经关闭

则不会继续发起第二次请求。

退化策略是：

- 如果当前检查阶段已经把原始上游响应完整缓存在内存里，就直接把这份原始响应返回给客户端
- 如果是流式场景，且旧流已经开始被读取，则恢复透传旧流

换句话说，自动切号是“尽力而为”，而不是“命中错误后必须保证切到新账号”。

## 8. 旧流的收尾处理

当 SSE 场景决定切号重试时，旧上游流不会直接裸 `resume()` 后放着不管。

当前实现会：

- 给旧流挂一个临时 `error` 监听
- 继续 drain 到 `end` 或 `close`
- 再清理监听器

这样做的目的是避免旧流在新请求已经发出后，再异步抛出未处理的 `error`，导致 Node 进程异常。
