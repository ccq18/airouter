# 三协议兼容性修复与验证

## 1. 范围与依据

核验日期：2026-10-25；基线为 `d639eee`，当前工作区与 `origin/main` 起点一致。修复保留 `config.json`、统一模型路由、免费池、账号与用户文件，不为 `auto` 添加特殊逻辑。

依据当前源码、先失败的回归及真实请求，不把旁支报告直接当作结论。官方依据为 [Responses 输入与参数](https://developers.openai.com/api/reference/python/resources/responses/methods/create)、[Responses 状态](https://developers.openai.com/api/docs/guides/conversation-state)、[OpenAI 缓存](https://developers.openai.com/api/docs/guides/prompt-caching)、[Claude 缓存](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Claude 并行工具](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use)和[停止原因](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)。公共 API 契约不能代替兼容站真实行为。

## 2. 逐项复现与修复

| 项目 | 当前基线复现 | 修复位置与行为 | 自动化证据 |
| --- | --- | --- | --- |
| 1. UTF-8 SSE | 多字节分片解码损坏；另发现 event 错误跨帧继承 | `protocol-bridge.js/createSseEventParser` 使用增量解码并在 finish 刷新；每帧重置 event，不继承上一帧 | 中文、emoji、四字节字符逐字节/任意切分、尾部刷新、混合 event/data-only；三协议同协议真实 HTTP 分片 |
| 2. Responses 输入/角色 | EasyInputMessage 简写拒绝，显式 system/developer 被降级 | `parseResponsesRequest`、各请求 serializer 保留角色、指令层级与顺序；不能保真的 Messages 转换拒绝 | 简写、显式 type、字符串/数组 content、多轮指令与六向协议请求 |
| 3. ID | 不同 chatcmpl ID 坍缩；看似目标前缀的源 ID 也可碰撞 | `responseIdFor` 跨协议使用来源协议加完整源 ID 编码；只有原生同协议保留源 ID，流内复用同一身份 | abc/def、标点、目标前缀反例；JSON→SSE、SSE→JSON、native ID 和流内一致性 |
| 4. 工具 | 并行调用拆轮、结果错位，部分选择/错误/参数语义丢失 | 请求 parser/serializer 保留同轮分组、call ID 与结果顺序；映射普通工具/strict/parallel/choice。保留 OpenAI 参数原字符串，转 Messages 严格校验 JSON 对象及数值精度 | 六向多轮、并行结果配对、选择/strict、非法参数与大数/小数精度；真实双工具往返另列 |
| 5. 缓存 | 跨协议控制字段与读写统计丢失，未知值补零 | 请求公共字段按等价语义映射；同协议原始字段/usage 保留。统计区分总输入与非缓存输入，未知字段省略；无法等价明细使用具名来源扩展 | native JSON/SSE 明细保真、读写双向计算、未知字段、无重复计数、缓存控制拒绝边界；真实命中见第 4 节 |
| 6. 停止 | stop/stop_sequences 消失，原生聚合丢匹配序列 | Chat↔Messages 映射等价停止条件；Responses 无等价 stop 时拒绝。`stopSequence` 贯穿原生 Messages 聚合 | 字符串/数组、超过 Chat 限制的序列拒绝、JSON/SSE 实际匹配值，不猜测 OpenAI 未提供的匹配串 |
| 7. 拒绝/终态 | refusal 变空成功；拒绝后 clean EOF 和不可保真 JSON 终态会重放 | JSON/SSE保留拒绝、过滤、截断；拒绝后不重试，已输出后不切换。不可表述终态明确失败；回调异常不杀进程；原生 Responses 转流/聚合保持 raw final | refusal JSON/SSE、403/200过滤错误、clean EOF、池内与外层单调用断言、异常后 health 存活、未知 incomplete native 保真 |
| 8. 状态/续接 | 普通 APIKey 被注入 store:false，却仍绑定；conversation 对象漏检；A→B→A 有迟到复活风险 | `responses-defaults.js` 不注入普通原生默认；`explicit-routing-handler.js` 只绑定原生 APIKey、请求未禁止保存且上游明确 store:true 的结果；`model-router.js` 用单调代际失效旧账号/目标绑定 | native存储续接、store:false、无存储确认、Token/Chat拒绝续接、调用者隔离、会话语法/互斥、TTL/重启、账号/路由 A→B→A 与迟到结果 |

## 3. 自动化范围

完整 `npm test`：415/415，通过，未跳过用例。另用旧 Node 18 单独复核两个数值精度场景，避免依赖新 `JSON.parse` reviver 上下文时静默失去保护；生产和主测试仍使用 Node 22。

新增回归入口：

- `test/protocol-request-regressions.test.js`：19 项请求转换；首批 13 项先全部失败，数值精度另有失败证据。
- `test/protocol-stream-regressions.test.js`：24 项响应、用量、分片、ID 与终态；首批 9 项中 8 失败、1 原本通过。后补 event 作用域、命名空间碰撞、匹配停止串均先复现再修复。
- `test/protocol-http-regressions.integration.test.js`：23 项真实本地 HTTP、受控三协议上游及免费池；拒绝 EOF、未知终态、原生保真、服务存活与请求次数都实测。
- `test/responses-state-regressions.test.js` 与 `test/responses-state.integration.test.js`：普通原生默认、绑定代际、实际存储/未保存/过期/重启/迟到状态；初版 8 项均失败，后补调用者与迟到账号回归。

旧测试中依赖错误行为的断言已对齐：Token HTTP 不再承诺保存续接；原生 Responses 流聚合使用上游 `output`，不强造 SDK 便利属性；系统角色保留输入顺序；无缓存明细时不假定 Claude 非缓存输入等于 OpenAI 总输入。

## 4. 真实供应商验证

使用现有账号的受保护临时配置运行本地新代码，没有为验证修改线上路由或新增线上账号。

| 场景 | 实际结果 | 可证明与限制 |
| --- | --- | --- |
| Chat JSON、Responses 简写 JSON/SSE、Messages 桥接 | 200，返回完整中文和 emoji | 验证真实入口到当前 Go Chat 后端；不能据此声称所有供应商或模型支持全部原生协议 |
| Responses→Chat 并行工具真实往返 | alpha/beta 两个独立 call ID；结果按 ID 回传后输出 30 | 验证模型真实并行调用和桥接配对，不只验证构造 JSON；六向完整工具矩阵仍由受控 HTTP 回归证明 |
| Chat 重复相同缓存前缀 | 总输入 4368；首次缓存读 0，重复请求明确报告读 4352 | 真实 `prompt_tokens_details.cached_tokens` 及 Go 明细均证实命中；4368 已含 4352，不再重复相加 |
| 原生 Claude Haiku Messages，5m cache_control | 首次 input=13、写入=9039、读取=0；重复 input=13、写入=0、读取=9039 | 原生返回的 `cache_creation` 5m/1h 与 usage 原样保留；总输入为非缓存、读、写三项之和，不能把 input=13 当全部输入 |
| 原生 GLM Messages 探测 | 上游 400 ModelProtocolUnsupported | 明确模型不支持该原生协议，没有据此伪造成功或更改生产模型配置；随后按官方模型元数据选择 Claude 原生链路验证 |
| 原生 Responses 兼容站 store:true | 35 秒后超时，没有成功结果 | 未完成真实保存与 previous_response_id 续接验证；只能报告受控原生回归通过，不能承诺该兼容站支持存储 |

缓存观察只对应同一次验收中固定账号、模型、相同前缀和会话条件；切换账号、模型、供应商、免费池内成员后不承诺继承缓存。请求携带缓存控制也不等于必然命中。

## 5. 明确支持边界

1. 同协议优先保留上游原始字段。原生 Responses 的 JSON/SSE 互转保留完整终态与输出明细；未知 incomplete 原因不改为普通 completed。
2. Chat↔Responses 保留共同 `prompt_cache_key`、retention、已核实的 options.mode/ttl 与 breakpoint。Responses 独有 prewarm/comparison_response_id 不强行映射；旧 retention 与新 ttl 不互相改写。
3. Claude cache_control 与 OpenAI 缓存控制没有等价契约，跨过去明确拒绝。显式存储控制、developer/中途 system 指令、工具 is_error:true、自由文本工具及不可无损数值等无法准确表示时同样拒绝。可兼容的后备先由候选筛选；所有候选不兼容返回明确错误。
4. 标准统计无法等价表示时，在 `usage.airouter_upstream_usage` 中保留原协议与原始计数基数/Claude 缓存细分，不伪装标准字段、不补零、不重复加总。下游应允许未知统计；这不承诺源未报告的字段存在。
5. Claude 末尾才声明 refusal 时，已经发出的文本不能撤回；目标流在终态补明确拒绝标记，最终 canonical 拒绝文本不重复拼接。缺终态或转换失败给明确错误/中断，不产生空 completed，也不再请求另一模型。
6. `pause_turn`、某些上下文耗尽/未知 incomplete 原因没有目标协议等价语义时，跨协议明确失败；原生路径保持真实终态。网关不可表述错误不把健康原生模型放入冷却。
7. `conversation` 合法字符串或 `{id}` 会做语法检查，但当前没有 Conversations 创建/归属机制，统一 409；不合法形式或与 previous_response_id 同用为 400。加密 reasoning、item_reference 等无可核实归属时也拒绝，需重发完整显式历史。
8. Token HTTP 仍按现有适配要求 store:false，不建立持久续接绑定。普通 APIKey 原生请求不改写未设置 store；即使请求 store:true，上游也可能按数据策略关闭，因此只有响应明确 store:true 才建立绑定。未知存储确认、Chat桥接、跨账号/模型/协议均不能续接。
9. 本地绑定默认 TTL 为 24 小时，重启丢弃；它不是供应商 30 天保存承诺。上游删除响应、密钥/账号身份变化、目标变化或代际失效后，可能需要重放完整历史。没有 WebSocket/Conversation 状态恢复能力。
