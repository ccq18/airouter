# 工程发现登记

## DEF-SEC-001：跨源重定向转发上游凭证和请求体

- 类型/等级：已确认缺陷 / 严重（P1）
- 状态：Verified
- 发现日期：2026-07-14
- 评审基线：`main`，`d587875`
- 受影响组件：`app/upstream-request.js`、token 额度检查、OpenAI OAuth refresh
- 事实与证据：`requestBuffered()` 跟随重定向时仅替换 URL，保留原 headers 和 body；本地双服务复现确认 307 跨源跳转后目标服务收到 `Authorization: Bearer secret` 与 `refresh_token=secret-refresh`。
- 预期行为：敏感 headers/body 不得自动跨 origin 转发；OAuth refresh 和额度检查应限制到明确可信 origin。
- 影响：恶意或异常重定向可泄露 access token、apikey 或 refresh token。
- 处置建议：已改为只允许同 origin 重定向，跨协议、主机或端口直接中止。
- 验收标准：跨源 301/302/303/307/308 均不能携带凭证或 refresh body；同源兼容行为有测试覆盖。
- 验证方法：双本地 HTTP 服务捕获跳转后的 headers/body；运行完整测试。
- 责任人/目标日期：待指派 / 待确认
- 关联变更/证据：`test/upstream-request.test.js` 跨源凭证转发回归测试
- 残余风险：可信同源服务仍可接收原请求，这是 HTTP 重定向的预期行为。
- 关闭记录：2026-07-15 自动化测试验证跨源请求未发出
- 状态历史：2026-07-14 Open；2026-07-15 Resolved → Verified
- 去重指纹：`SEC|request-buffered|cross-origin-redirect-credential-forwarding`

## DEF-REL-003：缓冲型上游响应没有大小上限

- 类型/等级：已确认缺陷 / 高（P1）
- 状态：Verified
- 发现日期：2026-07-14
- 评审基线：`main`，`d587875`
- 受影响组件：`app/upstream-request.js`、额度查询、OAuth refresh、图片请求
- 事实与证据：`consumeResponseBody()` 将所有 chunk 无界加入数组并最终 `Buffer.concat()`；`requestBuffered()` 没有 response limit 参数。
- 预期行为：所有内存缓冲响应必须具备可配置且按用途设置的硬上限，超限时立即销毁上游响应。
- 影响：异常或恶意上游可持续推送数据导致进程内存耗尽；并发时风险放大。
- 处置建议：已增加 `maxResponseBytes`；普通缓冲响应默认 16 MiB，图片结果 64 MiB，声明长度及 chunk 累计均执行限制。
- 验收标准：Content-Length 预检和 chunked 运行时累计均能拒绝超限响应，且不会继续读取。
- 验证方法：固定长度及 chunked 超限测试、并发内存回归、完整测试。
- 责任人/目标日期：待指派 / 待确认
- 关联变更/证据：`test/upstream-request.test.js` 声明长度及 chunked 超限测试
- 残余风险：并发请求仍会按各自上限占用内存，需要继续监控进程 RSS。
- 关闭记录：2026-07-15 自动化测试验证超限响应被销毁
- 状态历史：2026-07-14 Open；2026-07-15 Resolved → Verified
- 去重指纹：`REL|buffered-response|unbounded-memory`

## DEF-REL-004：普通 token 请求的任意非成功状态会禁用账号

- 类型/等级：产品特性 / 不适用
- 状态：Closed
- 发现日期：2026-07-14
- 评审基线：`main`，`d587875`
- 受影响组件：`openai.js` token HTTP 分类与 failover
- 事实与证据：`classifyTokenUpstreamFailure()` 对 token 的所有非成功 HTTP 状态统一触发切号和账号冷却。
- 预期行为：产品方于 2026-07-15 确认该行为属于既定 feature，保持当前语义。
- 影响：所有非成功状态会触发统一故障转移，这是已确认的产品取舍。
- 处置建议：不修改。
- 验收标准：保持现有测试和运行语义。
- 验证方法：现有 token failover 回归测试。
- 责任人/目标日期：待指派 / 待确认
- 关联变更/证据：`openai.js:733`、`openai.js:2780`
- 残余风险：已由用户作为产品行为确认；未进行风险豁免或外部合规签审。
- 关闭记录：2026-07-15 用户确认“是 feature”
- 状态历史：2026-07-14 Open；2026-07-15 Closed（产品意图确认，非缺陷）
- 去重指纹：`REL|token-proxy|all-non-2xx-global-quarantine`

## IMP-REL-001：按请求阶段收紧默认超时

- 类型/等级：改进项 / 中
- 状态：Verified
- 发现日期：2026-07-14
- 评审基线：`main`，`d587875`
- 受影响组件：代理流式请求
- 事实与证据：总 deadline、连接、首响应和空闲已分阶段控制；流式空闲 180 秒相对正常 SSE 活动间隔偏宽。GPT apikey 恢复探测会产生上游 token 消耗，不适合激进缩短后重复探测。
- 预期行为：保留长推理与 failover 的总预算，更快回收真正空闲的流，同时避免重复产生计费探测。
- 处置：流式空闲默认值调整为 120 秒；GPT apikey 恢复探测保留 30 秒，其余合理默认值保持不变。
- 验收/验证：默认值边界测试和完整 `npm test` 通过；环境变量覆盖语义不变。
- 责任人/目标日期：待指派 / 2026-07-14
- 关联变更：`docs/performance-and-timeouts.md`、`test/proxy-boundary.test.js`
- 残余风险：极少数超过 120 秒完全无网络活动的流式上游会被判定空闲；可通过 `UPSTREAM_STREAM_IDLE_TIMEOUT_MS` 按环境覆盖。
- 状态历史：2026-07-14 Open → Resolved → Verified（自动化测试）
- 去重指纹：`REL|timeout-defaults|stream-idle`

## DEF-REL-001：入口并发队列导致本地 Responses 503

- 类型/等级：已确认缺陷 / 高
- 状态：Verified
- 发现日期：2026-07-14
- 评审基线：`main`，`d576fae`
- 受影响组件：`openai.js`、`app/request-concurrency.js`
- 事实与证据：业务入口默认限制 32 个在途请求，额外请求排队 10 秒后由本地中间件返回 503“请求排队超时”；Responses 调用方会继续重试。
- 预期行为：Airouter 业务入口不自行排队或限制全局并发。
- 影响：长流式请求占满槽位后，新请求连续收到本地 503，最多重复三次。
- 处置：移除入口并发中间件、环境变量、健康状态和对应文档，不再加载排队模块。
- 验收/验证：代码检索不存在运行态排队入口；完整 `npm test` 通过。
- 责任人/目标日期：待指派 / 2026-07-14
- 关联变更：本次工作区修复；`docs/performance-and-timeouts.md`
- 残余风险：并发压力直接传递给 Node 进程和上游，应通过资源监控及上游 429/5xx 观察容量。
- 状态历史：2026-07-14 Open → Resolved → Verified（本地实现及自动化测试）
- 去重指纹：`REL|openai-entry|local-concurrency-queue-503`

## DEF-REL-002：响应关闭后清理 timeout 访问空 socket

- 类型/等级：已确认缺陷 / 高
- 状态：Verified
- 发现日期：2026-07-14
- 评审基线：`main`，`d576fae`
- 受影响组件：`app/upstream-request.js`
- 事实与证据：`IncomingMessage` 的 `close` 回调中调用 `response.setTimeout(0)`；Node 已可能将 `response.socket` 清空，内部访问 `socket.setTimeout` 时抛出 TypeError。
- 预期行为：正常关闭或异常关闭上游响应都不产生未捕获业务异常。
- 影响：每次响应关闭均可能产生重复异常日志，干扰运行并增加事件循环负担。
- 处置：仅当 socket 仍存在时直接清除 socket timeout。
- 验收/验证：新增 socket 在 close 前被清空的竞态回归测试；完整 `npm test` 通过。
- 责任人/目标日期：待指派 / 2026-07-14
- 关联变更：`test/upstream-request.test.js`
- 残余风险：无已知残余功能风险。
- 状态历史：2026-07-14 Open → Resolved → Verified（竞态回归测试）
- 去重指纹：`REL|upstream-response|close-null-socket-settimeout`
