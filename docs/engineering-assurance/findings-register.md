# 工程发现登记

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
