# `/responses` 自动切号当前实现说明

本文档描述的是 `airouter` 当前已经落地的 `/responses` 自动切号实现边界。

它和 [codex-error-recognition.md](/Users/lrd/code/airouter/docs/codex-error-recognition.md) 的定位不同：

- [codex-error-recognition.md](/Users/lrd/code/airouter/docs/codex-error-recognition.md) 关注接口层错误识别规则
- 本文档只记录当前代码里真正接进自动切号链路的行为

## 1. 生效范围

当前自动切号只对以下请求生效：

- 路径命中 `/responses`
- 当前账号类型是 `token`
- 本次请求还没有进行过 failover

也就是说：

- 不是所有 OpenAI 兼容接口都会自动切号
- `api_key` 模式不会走这套逻辑
- 同一个请求最多只会自动重试一次

## 2. 当前真正会触发自动切号的错误

当前实现只把下面这四类情况当作 `/responses` 自动切号触发条件：

- HTTP `429` 且 `error.type == "usage_limit_reached"`
- HTTP `429` 且 `error.type == "usage_not_included"`
- SSE `response.failed` 且 `response.error.code == "insufficient_quota"`
- SSE `response.failed` 且 `response.error.code == "usage_not_included"`

对应内部原因码如下：

| 上游返回 | 内部原因码 |
| --- | --- |
| `429 + usage_limit_reached` | `responses_usage_limit_reached` |
| `429 + usage_not_included` | `responses_usage_not_included` |
| `response.failed + insufficient_quota` | `responses_insufficient_quota` |
| `response.failed + usage_not_included` | `responses_usage_not_included` |

## 3. 当前不参与自动切号、只做识别或透传的情况

下面这些值虽然仍然属于可识别的 `responses` 错误，但当前没有接入自动切号：

- `context_length_exceeded`
- `invalid_prompt`
- `server_is_overloaded`
- `slow_down`
- 其他非上述两类 `429`
- 其他 `response.failed`

这些情况当前仍然按原始上游响应向下游透传，或者继续按通用错误处理流程走，不会触发账号切换。

## 4. 流式检查方式

`/responses` 的流式自动切号不是等整个响应结束后再判断，而是先做一段前置检查：

1. 如果上游是 HTTP `429`，先读取完整 body，再看 `error.type`
2. 如果上游是 `text/event-stream`，先检查前几个 SSE 事件
3. 如果在前置事件里看到：
   - `response.created`
   - `response.in_progress`
   这两类事件，会继续等待
4. 如果看到：
   - `response.failed` 且错误码命中可切号集合
   就中断当前转发流程，改走切号重试
5. 如果在前置阶段先看到了正常输出事件，例如 `response.output_text.delta`
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

一旦命中第 2 节里的任一条件，当前逻辑统一按“全局不可用”处理：

1. 调用 `markConfigUnavailable(...)`
2. 把当前账号的：
   - `runtime.available = false`
   - `runtime.reason = responses_*`
   - `runtime.lastError = <retrySource>:<retryKey>`
3. 立即切换到下一个可用账号
4. 用新账号重放同一个 `/responses` 请求

这里没有保留 request 级别的局部切号语义。

也就是说：

- `usage_not_included` 当前和其他额度类错误一致
- 命中后会把当前账号整体摘除
- 直到后续额度刷新或配置重载把它恢复

## 7. 无可用账号或无法重试时的退化行为

如果命中了可切号错误，但下面任一条件不满足：

- 没有找到新的可用账号
- 当前请求已经重试过一次
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
