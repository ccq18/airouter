# 并发、背压与超时

本文说明 Airouter 当前的流式背压、请求体限制和上游超时语义。所有数值都可以通过环境变量覆盖，修改后需要重启服务。

## 默认值

| 环境变量 | 默认值 | 作用 |
| --- | ---: | --- |
| `UPSTREAM_CONNECT_TIMEOUT_MS` | `10000` | 建连超时，包含代理 CONNECT 和 HTTPS/TLS 建连 |
| `UPSTREAM_FIRST_RESPONSE_TIMEOUT_MS` | `60000` | 流式请求等待上游响应头/首响应的最长时间 |
| `UPSTREAM_STREAM_IDLE_TIMEOUT_MS` | `180000` | 流式响应两次上游网络活动之间允许的最长空闲时间 |
| `UPSTREAM_TOTAL_TIMEOUT_MS` | `600000` | 一次客户端业务请求的共享上游总 deadline，包含 failover 重放 |
| `UPSTREAM_REQUEST_TIMEOUT_MS` | `600000` | 旧版总超时变量；只在未设置 `UPSTREAM_TOTAL_TIMEOUT_MS` 时作为兼容回退 |
| `APIKEY_RECOVERY_TIMEOUT_MS` | `30000` | GPT apikey 恢复探测超时 |
| `QUOTA_CHECK_TIMEOUT_MS` | `10000` | token quota 检查超时 |
| `REQUEST_BODY_IDLE_TIMEOUT_MS` | `30000` | 客户端上传请求体时允许的最长空闲时间 |
| `JSON_REQUEST_BODY_LIMIT_BYTES` | `16777216` | JSON 和普通代理请求体上限（16 MiB） |
| `IMAGE_REQUEST_BODY_LIMIT_BYTES` | `67108864` | `/v1/images/edits` multipart 请求体上限（64 MiB） |

`UPSTREAM_TOTAL_TIMEOUT_MS=0` 可以关闭业务请求的总 deadline；分阶段超时也接受 `0` 表示关闭。请求体上限和请求体空闲超时必须是正整数。

## 流式背压

普通 OpenAI 代理、Claude Messages 原样转发和 Responses-to-Claude SSE 转换都遵守 Node.js `res.write()` 的返回值。当下游客户端读取过慢且 `res.write()` 返回 `false` 时，Airouter 会暂停或停止继续拉取上游数据，等待下游 `drain` 后再恢复。

这避免慢客户端把尚未发送的数据持续堆积在进程内存里。客户端已经收到响应后若上游断流，Airouter 只结束当前响应，不会透明切换上游或把已提交的 apikey 请求重新记为失败。

## 总 deadline 与 failover

同一个客户端业务请求只创建一个绝对 deadline。请求发生 token/apikey failover 或 HTTP redirect 时，后续尝试继承剩余时间，不会为每次重试重新获得完整的 10 分钟。因此默认最坏等待时间接近 10 分钟，而不是“三次尝试各 10 分钟”。

超时阶段会统一使用 `ETIMEDOUT`，业务入口返回 HTTP 504。内部错误包含以下 `timeoutPhase` 之一，便于定位：

- `connect`：连接、代理隧道或 TLS 建连超时。
- `first_response`：流式请求未及时获得响应头/首响应。
- `idle`：流式上游长时间没有网络活动。
- `total`：共享总 deadline 到期。

非流式长任务不使用 60 秒首响应限制，仍受 10 分钟共享总 deadline 保护。需要超过 10 分钟的 OpenAI Responses 工作，优先考虑上游 Background mode 和轮询结果，而不是无限增大同步 HTTP 超时。

## 为什么默认总超时仍是 10 分钟

OpenAI 官方 SDK 的默认请求超时窗口是 10 分钟，因此 Airouter 保留 `600000ms` 作为兼容总上限；这不是要求所有业务都等待 10 分钟。连接、流式首响应、流式空闲和健康探测使用更短的独立边界，可以更快回收明显失效的连接。

推荐从默认值开始观察 p95/p99 延迟、进程 RSS 和上游 429/5xx，再按机器资源和上游限额调节。Airouter 不在业务入口排队或限制全局并发；上游限流时应由客户端针对上游返回的 429/5xx 使用带随机抖动的指数退避。
- 客户端自身超时应略大于 Airouter 总 deadline，例如默认可设为 630–660 秒，让 Airouter 有机会先返回明确的 504。

## 请求体错误

- 超过请求体上限返回 HTTP 413，并停止继续缓存请求体。
- 上传过程中超过 `REQUEST_BODY_IDLE_TIMEOUT_MS` 没有新数据时返回 HTTP 408。
- `/v1/images/generations` 使用 JSON 上限；`/v1/images/edits` 使用图片 multipart 上限。
