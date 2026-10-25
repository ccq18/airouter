# 三协议兼容性修复与验证

当前逐点测试计划及结果入口为第 10 节。前文测试数量为各次历史快照，不表示所有协议能力已兼容。

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

## 6. 本次追加的协议交付门禁

基线为 `d918de1`。先核对上述既有测试和先失败记录，再补实际缺口；保留免费池实现、用户文件与现有统一配置。沿用 Node 内置测试、临时配置、随机端口和既有可控 HTTP 上游，没有引入第二套测试框架。

执行入口：`npm run test:protocol`。该入口包括桥接、请求/响应回归、HTTP、Responses 状态、模型路由和免费池测试；完整 `npm test` 包含这些测试，是提交与部署前的最终门禁。`.github/workflows/test.yml` 在 main 推送与 PR 上使用 Node 22 执行完整测试，失败会使检查失败；没有配置自动部署或变更分支保护权限。

### 6.1 覆盖矩阵

箭头表示客户端入口 → 后端协议。下列每格对应 `protocol-http-regressions.integration.test.js` 中独立的 `wire matrix <entry> <- <backend>: <upstream> -> <client>` 用例；每个用例检查实际请求体、模型映射、并行工具历史、结果配对、响应头、文本、工具参数、终态、缓存 usage、尝试次数和流内 ID。预期为字面客户端结构与数值，未调用转换器生成预期，也未用往返相等作为验收标准。

| 入口 → 后端 | 请求转换/原样保留 | JSON → JSON | SSE → SSE | SSE → JSON 聚合 | JSON → SSE 合成 |
| --- | --- | --- | --- | --- | --- |
| Chat → Responses | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Chat → Messages | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Responses → Chat | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Responses → Messages | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Messages → Chat | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Messages → Responses | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Chat → Chat | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Responses → Responses | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |
| Messages → Messages | 覆盖 | 覆盖 | 覆盖 | 覆盖 | 覆盖 |

矩阵的基础语义为文本和两个并行工具调用。专门的边界用例另验能力限制，不能把基础矩阵解释为支持所有上游扩展字段：

| 主题 | 测试与独立预期 |
| --- | --- |
| UTF-8/帧 | `protocol-stream-regressions` 的逐字节边界和 `multi-event CRLF SSE...`：中文、emoji、四字节汉字、é；同一多事件 CRLF 字节流在每个字节位置切分，固定种子 `0x5eed1234` 的 64 组随机分片；包含注释、多行 data、无尾部分隔符、重复 finish；三种同协议 rewriter 逐字段断言。异常尾字节单独断言 U+FFFD，不把损坏输入伪装有效 JSON |
| 输入/角色/内容顺序 | `protocol-request-regressions`：简写和显式 message、instructions/system/developer/user/assistant、内容块和消息位置；Messages 不能表达的 developer/中途 system 明确拒绝 |
| ID | 六向不同完整源 ID、标点、UTF-8、目标前缀和二次编码命名空间不碰撞；HTTP 流每帧 ID 一致 |
| 工具 | 六向两轮并行请求历史；六向 forced/required/none/auto、函数名、strict 和 parallel 开关（none 无并行语义）；HTTP 六向实际请求体和逆序结果配对；参数原字符串、无损数值、非法对象/大数/小数、is_error 不可表达时拒绝；每项工具结束恰好一次，重复源 end 事件也只结束一次 |
| 缓存 | 同协议原始请求控制、JSON/SSE usage/TTL 明细；跨协议公共控制及读写换算；缺统计省略、计数基数不同时具名来源扩展；不等价的 Claude/OpenAI 控制、Responses 独有预热等明确拒绝，HTTP 断言不会联系上游 |
| 停止/终态 | 六向 `terminal matrix` JSON/SSE 拒绝及截断、明确文字/原因；Chat content_filter、403/200 policy error、工具错误、未知 incomplete、pause_turn、上下文耗尽；stop 双向映射，Responses 不可表达时拒绝；三种原生流分别覆盖 clean EOF 与 socket 异常断开，不得输出成功终态 |
| 状态 | `responses-state*`、`model-router`：普通默认不注入 store:false、Token 强制限制、上游明确保存才绑定；previous/conversation 语法和互斥、调用者隔离、账号/目标 A→B→A、迟到结果、TTL、重启；上游删除状态只删除绑定，不冷却模型、不换上游 |
| 故障切换/免费池 | 复用 `unified-routing.integration` 的 200 JSON/SSE 错误前置重试、402、已输出中断和取消；`free-pool.integration` 的真实 HTTP 池内故障、下一个池、付费和来源 Go 套餐耗尽后免费池接替、额度恢复切回。`auto` 和 `any-client-id` 使用相同配置、相同预期，无 auto 专有逻辑 |
| 私有思考状态 | `protocol-response-boundaries` 和 HTTP private fixture：Messages thinking/signature、redacted_thinking、Responses reasoning/encrypted_content 原生保留；跨协议没有等价字段，明确错误，不静默降级成普通答案、不重放或冷却原生模型 |

### 6.2 先失败证据与最小修复

原八类问题的基线复现和修复见第 2～3 节，其首批失败日志仍保留为 `/tmp/airouter-protocol-requests-red.log`、`/tmp/airouter-protocol-streams-red.log`、`/tmp/airouter-responses-state-red.log`。本次在 `d918de1` 补充测试，区分发现的新缺陷和本来已通过的覆盖补充：

| 本次确认的问题 | 修复前实际失败 | 修复位置与修复后断言 |
| --- | --- | --- |
| Chat 并行工具流漏工具结束事件 | `/tmp/airouter-gate-matrix-red.log`：37 项中 35 通过、2 失败；Responses 缺 item.done、Messages 缺 block.stop。多事件 UTF-8 原本通过 | `protocol-bridge.js/createEntryEventSerializer` 在最终完成前结束未关闭工具，重复结束幂等；逐工具事件顺序和恰好一次 |
| 上游删除响应误伤模型健康 | `/tmp/airouter-gate-state404-red.log`：1 项失败，绑定已删除但 fresh 请求实际 503、预期 200 | `explicit-routing-handler.js/markNotCommittedFailure` 只失效私有绑定；第一次续接只打原生一次，第二次本地 409 零调用，全新请求原生 200 |
| 私有思考/签名静默丢失 | `/tmp/airouter-gate-response-boundaries-red.log`：15 项中原生 3 通过、跨协议 12 失败 | `protocol-bridge.js/assertResponseContentSupported` 与流 parser 检查无等价内容；原生旁路保留，跨协议明确 unsupported，不能产生普通成功终态 |
| 内容已发出后的转换错误缺少具体原因 | `/tmp/airouter-gate-late-error-red.log`：文字已收到，但断流没有 thinking/signature 错误原因 | `explicit-routing-handler.js` 流回调 guard 发送明确 SSE error 后结束；保留已发送文字、只调用一次、没有成功终态 |
| 三种原生流异常断开被正常结束连接 | `/tmp/airouter-gate-native-cut-red.log`：6 项中 clean EOF 3 通过、异常 socket 3 失败，缺错误或传输中断标记 | 同 handler 的 onError 发 `upstream_stream_error`；三种协议都保留文字、明确失败、不补 DONE/message_stop/completed、不重放 |
| 原生 Messages 私有内容格式互转失败 | `/tmp/airouter-gate-native-messages-red.log`：强制 SSE→JSON 与 JSON→SSE 两项均因实际 502、预期 200 失败 | `protocol-bridge.js/nativeMessagesToSse/createNativeMessagesAccumulator` 与 handler 同协议旁路保留 thinking/signature/redacted、文本、工具、usage 与消息扩展；未知 delta 明确拒绝，缺有效终态不能成功 |

测试开发中修正了两处假上游/预期问题，不将它们算作产品缺陷：Responses 拒绝流原先错误使用 output_text 事件，改用 refusal 事件与最终 payload 一致；工具选择 none 没有 parallel 语义，不能向 Claude none 强加不合法的并行选项。OpenAI 未报告匹配停止串时仍保持既有“未知省略”断言，未改成假设值。未跳过、降低或删除既有业务断言。

### 6.3 真实供应商与线上边界

本次新增本地隔离配置的真实探测：Go 原生 `gpt-6-luna` Responses 携带 store:true 返回 200、文本 17、usage input=14/output=31/total=45，但响应未提供 store 字段。因此不建立可续接绑定，随后 previous_response_id 本地返回 409 `upstream_context_unavailable`。这证明协议调用与保守存储判定，不能证明供应商已保存响应。Sub2API `gpt-5.6-luna` 的 store:true 请求在 55 秒超时，没有验证服务端保存与续接闭环。完整脱敏结果为 `/tmp/airouter-protocol-gate-live/storage-results.json`。

缓存命中沿用第 4 节本次主修复的真实 usage 证据：Chat 缓存读 4352/总输入 4368，Claude 首次写 9039、重复读 9039。本次门禁追加未修改缓存计数映射，不把这些值改称新的命中测试，也不以新的普通请求成功替代缓存证据。没有真实供应商故障注入、账号切换缓存继承或完整六向真实模型验收；这些规则的证明来自可控 HTTP 自动化。

原生 Messages 同协议格式互转按完整块及 text/thinking/signature/input_json/citations 标准 delta 聚合；未知 delta 没有通用重建依据时明确拒绝。跨协议私有思考内容仍不迁移。

### 6.4 最终本地门禁结果

Node 22.19.0：`npm run test:protocol` 为 **247/247**，完整 `npm test` 为 **499/499**，均为零失败、零跳过；相关新代码收敛后执行，完整日志分别在 `/tmp/airouter-gate-protocol-final.log`、`/tmp/airouter-gate-full-final.log`。`git diff --check` 通过。完整测试已包含专项用例，CI 仅跑完整测试，避免在同一次 CI 重复执行。

本次新增的先失败用例在对应修复后全部通过；已正确工作的分片、角色、缓存、状态与免费池能力只补覆盖，不虚构修复前失败。提交与部署使用通过门禁的同一源码；部署验收核对运行版本、服务健康、三种入口和免费池，并比较持久 `config.json` 部署前后 SHA256，保留账号、路由、凭证与用户文件。

## 7. 28329ef 之后的原生格式互转与控制字段修复

### 7.1 依据、范围与实测结论

本轮从当前 `28329ef` 开始，没有回退提交、恢复旧配置模式或改动 auto 语义。先沿 HTTP 入口、路由预检、转换器、真实本地上游补回归，再根据失败修复。旁支直接函数探针只作为线索：reasoning 和 structured output 原先被路由提前拦截，不能将其描述成实际 HTTP 静默丢失。seed、penalty、n、消息 name、未知控制等则实际返回 200 且上游请求字段已消失，已记录先失败证据。

官方依据为实际获取的 [Chat create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)及[缓存](https://developers.openai.com/api/docs/guides/prompt-caching)。官方支持字段不等于每个兼容站/模型都支持；不删除参数掩盖供应商拒绝。

### 7.2 最终处理规则

`app/protocol-request-controls.js` 集中处理跨协议控制；`protocol-bridge.js/transformRequestForTarget` 同时被路由发送前预检和真正转发调用。只扫描协议控制对象，不把 metadata、Schema、工具 parameters/input/arguments 中的同名用户数据当控制。普通同协议请求继续原样保留字段。

| 类别 | 当前规则 |
| --- | --- |
| 同名公共字段 | Chat↔Responses 保留 service_tier、safety_identifier、user、metadata；返回使用上游实际 service_tier，不用请求值填充 |
| verbosity / format | verbosity↔text.verbosity；text/json_object 格式直接映射；json_schema 包装/展开配置层，完整保留 name、description、strict 和原 Schema。缺 Schema 不编造，未知格式控制明确拒绝 |
| logprobs | Chat logprobs:true↔Responses include 中 message.output_text.logprobs；top_logprobs 保留并检查 0..20 及启用条件。token/bytes/logprob/top_logprobs 经 JSON/SSE、聚合/合成保留；delta 与 done/final 快照语义去重，对象键序变化不算冲突，真正值变化明确失败 |
| 拒绝概率 | 非空 Chat logprobs.refusal 没有已核实 Responses refusal 等价字段，明确报错，保留原拒绝原因且不换上游 |
| stream_options | 逐子项处理。Chat include_usage 在网关入口消费，true 时在 DONE 前发 choices:[] 用量块，其余块 usage:null；未报告统计发 null，不编造零。false/省略不强发 usage。include_obfuscation:false 可等价处理；显式 true 的跨协议/JSON→SSE 重建尚未实现随机混淆保证，明确拒绝；原生 SSE 透传保持上游事件 |
| 缓存 | 公共 key/retention/options.mode/ttl/breakpoint 原值映射，retention 与 ttl 不互换、不自动延长；预热/比较私有响应等独有项明确拒绝；读写计数维持原基数，缺失不补零，原生完整 usage 保留 |
| 输出上限 | max_completion_tokens↔max_output_tokens；Responses→Chat 发 max_completion_tokens，Responses→Messages 发 max_tokens。Chat 旧 max_tokens 单独给出时保留既有输出上限映射，不由此开放 reasoning；同时提供两个 Chat max 字段时明确拒绝，官方没有可据以发明的优先级 |
| reasoning | effort 参数相似不等于完整输出/私有状态可迁移，当前 reasoning_effort、reasoning、thinking 仍需同协议。已知 Chat reasoning_content/reasoning/audio/旧 function_call 输出也不能静默丢掉，跨协议明确拒绝；原生保留 |
| 无等价控制 | n>1 不拆多次付费请求；seed、penalty、logit_bias、消息 name、音频/预测、内置工具等未实现控制拒绝/跳过候选。n:1 识别为一次生成。后台 true、自动裁剪 auto 拒绝；background:false/truncation:disabled 作为同步、不裁剪的明确等价默认处理，不自行改历史 |
| 未知字段 | 未认识的跨协议根控制及 text/format/include/stream_options/tool/image 等控制子项明确报出路径。未知同协议字段继续交上游，不因新检查删字段 |

原生 Chat 新增 `app/native-chat-bridge.js`：JSON↔SSE 按 choice.index 和各自 tool.index 隔离，保留内容、拒绝、参数、logprobs、完整 usage、service_tier、system_fingerprint 与稳定扩展。相同工具身份重复不拼接；身份冲突或无法无损合并的变化扩展明确拒绝。原生 JSON→JSON、SSE→SSE 继续透传。不同 choice 的分片跨 Responses 不会合成一条回答。

原生 Responses JSON→SSE 除最终 payload 外，补全连续 sequence_number、annotation.added、text delta/done 的 logprobs。仅对已经实现完整生命周期的 message/text/refusal 和 function_call 合成；reasoning、内置工具等其他 output 类型不能凭 final 存在就伪造流式生命周期，格式互转明确失败。它们的原生 JSON/SSE 直接透传仍保留。

### 7.3 HTTP 先失败证据与覆盖

所有新增回归沿用 Node 测试和现有受控 HTTP 上游。断言实际请求体、字段路径、完整语义、响应头、顺序、次数和后续原生健康；不是只判断 200、非空文本或往返相等。

| 确认问题/补充 | 修复前实际 HTTP 证据 | 修复后对应测试 |
| --- | --- | --- |
| 原生 Chat 多 choices/扩展丢失 | `/tmp/airouter-native-chat-http-red.log`：5 项中原始两路径 2 项原本通过，互转和扩展冲突 3 项失败 | native Chat 四路径，多 choice 的相同 tool.index、交错片段、拒绝、logprobs、完整 usage/扩展；无法无损扩展明确失败 |
| 原生 Responses 流事件不完整 | `/tmp/airouter-native-response-events-red.log`：2 项失败 | sequence、annotation.added、text delta/done 概率与 final 独立断言；未知生命周期拒绝 |
| 请求控制缺失/笼统阻断 | `/tmp/airouter-followup-fields-red.log`：24 项中原生未知字段保留 2 项原本通过，其余 22 项失败；其中 format 为原路由阻断而非静默丢失 | 两向三种 format/verbosity/身份/cache/max/logprobs组合；20 类控制逐路径拒绝、零上游尝试，后续健康不受影响；字段不兼容时保留优先级并走原生后备 |
| 未知嵌套工具/图片控制 | `/tmp/airouter-followup-nested-fields-red.log`、`/tmp/airouter-followup-image-fields-red.log`：各 2 项先失败 | tools/function、tool_choice.function、image_url/source 子项严格处理，metadata/工具 Schema 中同名用户数据保持 |
| 跨协议响应明细丢失 | `/tmp/airouter-followup-cross-detail-red.log`：9 项先失败；`/tmp/airouter-followup-cross-choices-red.log`：不同 choice 分帧被混入一条成功 | Chat↔Responses JSON/SSE 四路径，完整 token 字节与 top 概率、真实 tier、拒绝概率限制、多 choices 拒绝及一次调用 |
| 概率快照对象键序误报 | `/tmp/airouter-followup-probability-order-red.log`：键序两项失败、真实冲突两项原本正确拒绝 | semantic deep comparison，包括 nested top_logprobs；真正冲突不放宽 |
| 私有/未实现 Chat 输出被丢弃 | `/tmp/airouter-followup-chat-output-red.log`：8 项失败，原生保留但跨协议 200 字段消失 | JSON/SSE 四类字段、两个跨协议目标，明确 502、一次调用、随后原生健康 |
| 工具身份重复/冲突 | `/tmp/airouter-native-chat-identity-red.log`：3 项先失败 | id/name 同值去重、异值拒绝；只有 arguments 累计，choice/tool 两层索引不串线 |
| 免费池 text 默认误判 | `/tmp/airouter-followup-pool-fields-red.log`：实际误选低优先级池 | type:text 不需要 structuredOutput；json_object 跳过明确不支持的成员；相同预检阻止未知控制的付费/免费调用 |
| 预算/未知 usage | `/tmp/airouter-followup-budget-target-red.log`：新增规则一度向 Messages 泄漏 Chat 上限字段；`/tmp/airouter-followup-unknown-usage-red.log`：2 项遗漏未知用量尾块 | 目标仅收到自身预算字段；两种源格式都发一次 usage:null 尾块，不伪造计数 |

用户专门新增的 `test/protocol-boundary-contract.integration.test.js` 保持内容和断言不变，单独运行 **31/31** 通过，现纳入 `npm run test:protocol`；覆盖原生四路径完整对象、两向格式/用户数据、发送前拒绝、原生后备、Responses 概率及 sequence 事件。旧的 json_object“必须拒绝”用例按本轮明确开放需求改为精确映射断言，保留不支持文件的拒绝断言。

最终本地门禁：协议专项 **347/347**，完整 `npm test` **599/599**，零失败、零跳过；日志 `/tmp/airouter-followup-protocol-final.log`、`/tmp/airouter-followup-full-final.log`。三协议原有回归、取消、拒绝不重试、状态归属、免费池耗尽接替及恢复切回包含在本轮验证内。

### 7.4 真实供应商结果与仍未满足的边界

在受保护临时配置中使用现有账号验证，没有写线上 config.json：

- 原生 Go DeepSeek Chat JSON 返回 200，中文/emoji 完整。
- 同账号/模型、相同缓存前缀重复请求的标准 prompt_tokens 都为 4368，首次 cached_tokens=4096、重复=4352；重复 total_tokens=4433（含 output=65），4352 已在 4368 内，不再相加。Go 自有明细普通输入=16、缓存读取=4352，与标准总输入相符。这是本轮真实缓存 usage，不以回答成功替代命中。
- Go DeepSeek 的普通输出实际带非空 reasoning_content（探测样本长度 42），因此当前指向该 Chat 后端的 Responses/Messages JSON/SSE 入口会遇到明确 502 `upstream_response_not_representable`，路径为 choices[0].message.reasoning_content。不是三个入口均已实供通过，也不会删除此字段或换上游规避限制。
- Go 原生 gpt-6-luna Responses 实际返回 200，但 output 含加密 reasoning 与 message。转 Chat 明确拒绝该私有 output。原生透传可用，不能据此声称跨协议 reasoning 已支持。
- 带新 format/标识或 logprobs 参数的真实跨协议请求本次同样止于上述私有输出边界，未获得可作为格式遵循或概率支持验收的成功响应。等价字段及六向规则由受控 HTTP 测试证明，尚未取得所有真实供应商/模型的成功矩阵。
- 服务端存储/续接沿用第 6.3 节未验证边界；本轮没有改造 Conversations、后台任务管理、持久本地会话，也没有放宽账号身份、路由代际、TTL/重启/迟到响应保护。

脱敏真实结果保留于 `/tmp/airouter-protocol-followup-live/supplier-results.json` 与 `boundary-results.json`。部署仍必须保持持久配置校验值；线上应分别记录原生成功和明确受限路径，不能把可控测试通过当作供应商全部兼容。

## 8. 接口边界契约测试补充

本节是测试补充，保留前文历史执行结果；不把测试注册完整等同于实现已通过。入口为 `test/protocol-boundary-contract.integration.test.js`，已由 `npm run test:protocol` 和完整 `npm test` 包含。测试启动真实 Airouter 子进程，使用临时配置、随机回环端口和受控 HTTP 供应商；只检查客户端实际响应和供应商实际收到的请求，不导入业务转换函数、生产 SSE 解析器或路由实现来生成预期。

### 8.1 必须无空项的核心矩阵

箭头为客户端入口到后端协议。下表每格都有六个独立语义用例：文本及完整缓存读写统计、拒绝、截断、未报告 usage、部分 usage、两轮并行工具及逆序结果配对。

| 入口 → 后端 | JSON → JSON | JSON → SSE | SSE → JSON | SSE → SSE |
| --- | --- | --- | --- | --- |
| Chat → Chat | 6 项 | 6 项 | 6 项 | 6 项 |
| Chat → Responses | 6 项 | 6 项 | 6 项 | 6 项 |
| Chat → Messages | 6 项 | 6 项 | 6 项 | 6 项 |
| Responses → Chat | 6 项 | 6 项 | 6 项 | 6 项 |
| Responses → Responses | 6 项 | 6 项 | 6 项 | 6 项 |
| Responses → Messages | 6 项 | 6 项 | 6 项 | 6 项 |
| Messages → Chat | 6 项 | 6 项 | 6 项 | 6 项 |
| Messages → Responses | 6 项 | 6 项 | 6 项 | 6 项 |
| Messages → Messages | 6 项 | 6 项 | 6 项 | 6 项 |

共 216 项，另有 `MATRIX coverage audit` 检查每一方向、格式和语义的注册键，禁止重复键并防止空项。每个工具用例实际发送两轮 HTTP 请求，检查最终回答、call ID、函数名、参数原字符串/对象、结果顺序和尝试次数；不是单次构造历史后只看 200。

### 8.2 核心矩阵之外的专项边界

| 用例前缀 | 覆盖内容 |
| --- | --- |
| `HTTP boundary` | 原生完整请求/响应对象、多 choices、工具索引、概率、未知扩展，以及原生 Responses 的概率与 sequence 事件 |
| `REQUEST` / `FIELD` | 采样、预算、metadata、缓存控制、结构化输出、思考控制、stop、默认值、未知字段；逐字段的保留/映射/发送前拒绝；auto/none/required/指定函数、strict、并行开关；图片与指令顺序；文件和音频的原生保留或跨协议拒绝；Schema 中的应用字段不能误当 API 控制 |
| `INPUT` / `AUTH` | 字符串/内容块、Responses 简写及显式 message、developer 与中途 system；非法 JSON、未知公开模型、无效入口 Key；错误不得调用上游或泄露其凭证 |
| `PROBABILITY` | Chat/Responses 四个协议对 × 四种格式路径，检查 token、bytes、logprob、top_logprobs 和请求控制；概率只发一次；Messages 无等价请求能力时明确拒绝 |
| `STATE` / `REJECTION` | store 的保留或拒绝；未归属 previous response/conversation；三种私有历史形式不得跨协议默默删除；未知输出项不能伪造 SSE 生命周期。合法原生存储、调用者/账号身份、代际、TTL、重启和迟到结果继续由 `responses-state.integration.test.js` 等既有专项测试负责 |
| `ID` | 九种协议对 × 四种格式路径，每格依次使用七个含不同前缀、标点、Unicode 的上游 ID；不同响应不碰撞，单流 ID 一致，原生 ID 不改写 |
| `TOOL` | 无效 JSON 参数和不安全整数：OpenAI 原始字符串保持精确，Messages 不可无损表示时明确失败；工具结果 is_error 不得丢失 |
| `FAULT` | 九种协议对分别验证 429 切换、403 策略拒绝、HTTP 200 内错误、可见输出后错误、clean EOF、socket 异常断开；配置真实后备，检查调用次数和实际落点，不允许绕过策略或在已输出后重放 |
| `CANCEL` | 九种协议对都取消真实 HTTP 流，确认供应商连接被中止；随后新请求仍选择原主账号，取消不能误冷却 |
| `NATIVE precision` | 同协议未知 JSON 扩展中的大整数不得因模型字段改写而被舍入成另一个值 |
| `PRODUCT acceptance` | 已观察的 DeepSeek 默认 reasoning_content、Responses 加密 reasoning、Claude 缓存统计形态；另有明确标记为合成的 Claude thinking/signature 示例。普通使用要求成功、最终答案不混入思考/密文、源数据单独保留，不以 502 作为成功验收 |

原样 JSON/SSE 透传比较完整对象/事件；JSON/SSE 格式互转检查必要生命周期、字段内容、顺序、终态和次数，允许合法的分片差异与未完成状态占位。Claude 流可能直到终态才声明拒绝，因此已经发出的文字不能撤回，但必须补明确拒绝语义且不重复文本。图片内嵌样例使用有效 PNG，并依据 [Claude 图片输入契约](https://platform.claude.com/docs/en/build-with-claude/vision) 区分 base64 数据与在线 URL。

### 8.3 不适用项与证据边界

Responses 没有 stop 请求字段，Messages 没有 OpenAI 标准概率请求字段：分别验证相关跨协议拒绝，不用无断言的占位测试假装覆盖。未实现能力必须显式拒绝或跳过候选；普通已公开路由的日常请求失败则属于 `PRODUCT acceptance` 失败，两类结果不能合并宣传为兼容成功。

样本 `test/fixtures/supplier-response-shapes.json` 明确记录来源：部分结构及 usage 数字来自主会话的脱敏观测，ID、回答、思考和密文为合成值；Claude 签名思考例也是合成协议样例。它们不是完整供应商原始录包，不证明新的真实调用、实际缓存命中或全部供应商/模型均支持。UTF-8 的每字节/固定种子分片、配置/额度/免费池/状态竞争等专项继续纳入既有完整测试门禁。

### 8.4 本次测试补充的运行结果

2026-10-25，Node 22.19.0：接口契约文件 **778 项，776 通过、2 失败、零跳过**；完整 `npm test` **1428 项，1418 通过、10 失败、零跳过**。两项接口失败是 Responses `store:true` 指向 Chat/Messages：请求没有发送到供应商，但返回 503 `no_available_upstream`，预期应为请求语义不支持的 400，不能伪装成上游暂时不可用。完整测试另有八项来自既有私有状态/思考及故障切换用例，留待主会话核对实现和有效契约，不在本次测试补充中改业务代码或降低断言。

日志分别为 `/tmp/airouter-interface-matrix-final.log` 与 `/tmp/airouter-interface-full-final.log`。运行前后核对 `app/*.js`、`openai.js`、本契约测试及样本的 SHA256，确认期间未变化，清单为 `/tmp/airouter-interface-final-before.json` 与 `after.json`。这是共享工作区当时源码的自动化快照，不是一次提交、部署或真实供应商验收。

## 9. 默认思考内容及来源状态传输修复

本节为 2026-10-25 当前实现，更新第 7.4 节当时仍返回 502 的默认 reasoning 边界；前述历史失败证据保留。普通 DeepSeek 请求不再因出现公开 `reasoning_content` 而被整体拒绝。不通过关闭思考、删除思考字段、混入最终回答或切换供应商规避问题。

### 9.1 字段与来源契约

| 来源内容 | 当前表示与回传 | 限制 |
| --- | --- | --- |
| Chat 文本 `reasoning_content` / 字符串 `reasoning` / `reasoning_text` | 独立 canonical reasoning；Responses 使用 `content[].reasoning_text`，Messages 使用独立 thinking 与 `airouter-text-v1:` 公开标记；Chat 保留原别名 | 不把完整文本伪称摘要；别名冲突明确拒绝；公开文本不绑定账号，仍可正常优先级切换 |
| Responses reasoning，包括 `summary`、`content`、`encrypted_content` | 原生保持原始字段；跨协议保留源块并签发 `airouter-state-v1:` 随机句柄 | 密文不解密；只恢复给原来源，不能作为另一供应商的有效私有状态 |
| Messages thinking/signature、redacted_thinking | 保留原块、文本和签名；跨协议输出可验证的来源句柄 | 网关签名标记不是 Claude 签名，绝不向原生 Claude 伪造签名；保持原有块顺序 |
| Chat `reasoning_details` | 识别 text、summary、encrypted 的供应商扩展，保留 id/format/index 等来源字段 | `airouter-bridge-v1` 是明确网关扩展，不宣称为 OpenAI Chat 标准 |

跨协议完整源字段单独放在 `airouter_upstream_reasoning`，用于保真及诊断，不混入答案。客户端应回传完整 reasoning/assistant 内容；公开 provenance 扩展可省略，但若回传则验证其与来源一致。不透明句柄必须保留。删除句柄或仅回传答案不能保证私有多轮继续可用。

协议依据：[DeepSeek thinking/tool 历史要求](https://api-docs.deepseek.com/guides/thinking_mode/)、[Responses 输入输出结构](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Responses 流事件](https://developers.openai.com/api/reference/resources/responses/streaming-events)、[Claude thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)、[OpenRouter reasoning 扩展](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。网关标记及来源校验是 Airouter 自身契约，不是供应商原生能力。

### 9.2 生命周期、路由与状态保护

- `app/reasoning-content.js` 处理字段保留和请求还原；`app/protocol-bridge.js` 处理 JSON/SSE、文本/摘要/工具顺序及完成时状态。思考增量立即输出；cipher/signature 只采用完整完成块，不能把 incomplete added 快照当成最终状态。
- 原生 Responses JSON→SSE 支持 reasoning item 的 added/done、summary part/text 生命周期、reasoning text delta/done，最终 item 与密文完整保留，sequence 连续。未知输出项仍明确拒绝。原生格式互转若会舍入数字（包括扩展中的大整数/精细小数、溢出/下溢）明确拒绝，原始 JSON→JSON / SSE→SSE 保留数字原文。验收已从旧“必须 502”升级为完整 200、逐项事件顺序/字段/密文/一次调用断言。
- `app/reasoning-transport.js` 复用原上下文存储，另设有界内存记录：默认最多 1000 条、8 MiB，沿用上下文 TTL。句柄绑定调用者、公开路由、入口、原账号、具体后端模型/协议、前置消息/system/tools、块分组和顺序；免费池同时绑定具体成员与凭证来源。pending 句柄在合法完成前不可回传。
- 重启、TTL、账号/路由变化、篡改、混合来源、块重排均拒绝。`app/credential-context.js` 同时失效凭证引用的依赖池，防止 A→B→A 后旧状态或迟到请求复活；相同原生密文出现不同来源后持续标为歧义，重复观察不能清除。
- 公开思考历史继续按普通候选优先级选路；携带已验证不透明历史时仅能选择原目标/成员。没有给 `auto` 添加特殊逻辑，免费池的目录、资格、健康和耗尽恢复规则不变。
- 这与服务端 `previous_response_id` 分开：完整加密历史可在 `store:false` 下原样手动回传；它不建立服务端保存绑定，不扩大 conversation、后台任务、持久续接或跨账号迁移能力。单独 effort 控制的后续映射见第 10.6 节；summary 等其他控制仍受原有限制约束。

### 9.3 复现与自动化证据

| 确认问题 | 修复前证据 | 修复后断言与位置 |
| --- | --- | --- |
| 普通 Chat 思考导致跨协议整体拒绝；JSON/SSE 历史回传缺口 | `reasoning-content.test.js` 初始 6 项失败；实际 HTTP 回归出现默认思考/opaque 的 502 | helper、`protocol-reasoning.integration.test.js` 九条路径/格式转换、源块精确回传、工具结果配对、不同调用者零上游调用 |
| 思考流被缓冲到答案；来源明细缺失 | async HTTP 回归 3 项中 2 项先失败；provenance 回归先失败 | `protocol-reasoning-stream.test.js` 和 HTTP 回归检查先到达思考、晚到密文、顺序、完成、断流不激活；用户 `PRODUCT acceptance` 检查源命名字段独立存在 |
| 凭证引用池 A→B→A、来源歧义被第三次观察清除 | `reasoning-transport-security.test.js` 3 项先失败，退出码 1 | 相同 3 项转绿；另补原生 Chat SSE 按 choice 注册完整 opaque 的先红后绿，不提前激活 |
| base64 data URL 错发成 Claude URL | 用户相关 HTTP 21 项中 5 项先失败，含图片及精度缺口 | 三入口实际请求体检查 `source.type=base64`、media_type、data |
| 同协议 JSON 模型改写舍入扩展大整数 | 同上，原始响应 `9007199254740993` 被舍入 | `app/json-wire.js` 只替换约定 model token；原生 SSE 同样保留 data JSON 的数字词法；`json-wire.test.js` 验证整数、小数、指数、嵌套和转义，用户三协议 HTTP 精度验收 |
| 同协议 SSE 扩展数字舍入 | 三协议 raw SSE HTTP 回归均先失败（`airouter-native-sse-precision-red.log`，退出码 1） | 同样使用 token 改写，event 保留，多行 data 按 SSE 重新加前缀；三项修复后通过；另有六项 JSON↔SSE 大数互转先红后绿，不能无损重建时明确 502，不返回舍入后的成功 |
| 200 错误载荷中的策略拒绝分类 | 严格 403 HTTP 新回归先失败，退出码 1 | `content_policy_violation`→403，不重试/不误冷却；其他错误分类保持原规则 |
| store:true 跨协议被粗能力检查分类为 503 | 用户 HTTP 两项确实失败 | 先运行共同转换预检，400 附 store 字段原因，零供应商调用，不改变请求保存语义 |

日志为本机 `/tmp/airouter-reasoning-*.log`。历史负向断言只在本轮确实实现对应能力后升级为完整内容和无重放正向验收；audio、旧 function_call、对象型私有 reasoning、未知输出类型、无归属历史继续验证明确拒绝。用户补充的 fixtures 与矩阵保持独立预期，不用转换器生成预期。

### 9.4 真实供应商验证及未验证边界

本地当前代码用服务器最新配置的受保护临时副本验证，未修改线上账号、路由、凭证。证据在 `/tmp/airouter-reasoning-live/` 的脱敏 JSON；临时凭证副本在交付前删除。

- `supplier-final-results.json`：Go DeepSeek 在 Chat、Responses、Messages 三入口的 JSON/SSE 均成功，最终答案为 `中文🙂`，思考独立保留；Responses 和 Messages 工具两轮都原样携带第一轮思考并得到 `30`。模型有时不返回思考，不能要求每次必须存在。
- Go 原生 gpt-6-luna Responses 经 Chat/Messages 的工具两轮也成功。但这些工具调用实际没有返回加密 reasoning，因此不把它们计作真实跨协议密文回传证据。
- `native-state-results.json`：原生 Responses 显式 low effort + encrypted include，第一轮收到 1572 字符密文；`store:false` 完整手动历史第二轮得到 `1592`。使用第一轮 ID 作 `previous_response_id` 返回 409，未伪造保存成功。
- `supplier.log` 保留首个缓存实验：输入 3815、首轮 cached_tokens=0，重复 cached_tokens=3712；后续复验仍为 3712。直接报告供应商 usage，不由回答成功推断缓存，不把读取再次加进 prompt 总数。
- `auto` 通过普通 Responses 入口真实请求成功。没有为验收人为耗尽付费额度、篡改线上健康或强制切换付费账号；耗尽接替、池内故障切换及高优先级恢复回切由受控 HTTP/免费池回归证明。

真实跨协议 opaque 句柄回传、Claude 真实签名多轮及所有供应商的概率/格式组合仍未完成全面真实验证；相应转换和归属规则由自动化证明。持久服务端续接、conversation、后台任务、重启后的本地句柄恢复仍未实现。外部 OpenCode CLI 未在本轮启动，遵守当前用户禁止调用外部 AI 工具的约定；本轮使用真实 HTTP 客户端验证普通 `auto` 路由。

### 9.5 19c445e 交付门禁快照

Node v22.19.0；`npm run test:protocol` **1188/1188**，完整 `npm test` **1440/1440**，真实退出码均为 0，无 skip/cancel/todo。日志分别为 `/tmp/airouter-reasoning-protocol-final.log` 与 `/tmp/airouter-reasoning-full-final.log`。专项命令已包含新增的 reasoning、来源安全、HTTP 与原始 JSON token 测试，并继续包含原有三协议、状态、取消、免费池和恢复切回回归。

## 10. 逐兼容点测试计划与实施

### 10.1 验收口径与改动边界

2026-10-25 从 `19c445e` 核对：已有九条协议路径 × 四种响应格式及 216 项核心 HTTP 语义用例。缺口是部分测试把字段组合在一起，部分测试接受“保留或拒绝”，总通过数不能表示逐点兼容程度。本次只修改测试、测试运行入口及本文档；不修改应用实现、账号配置，不调用真实供应商、不提交或部署主会话代码。

兼容性验收必须要求正确转发及完整语义，合法可映射请求返回 400/502 同样是失败。没有等价语义的组合标为“无等价映射”，边界拒绝测试单独报告；能够等价但尚未实现的组合继续执行正向验收，失败保留为缺口。缺少、跳过、todo、重复注册的必需用例均不能计作通过。自动化结果不能代替真实供应商验收。

### 10.2 实施顺序与完成条件

| 顺序 | 实施内容 | 完成条件 |
| --- | --- | --- |
| 1 | 独立兼容点清单，列出字段路径、合法源协议、等价映射及无等价原因 | 不读取转换器推导预期；必需请求字段均有兼容点；九条方向及格式明确 |
| 2 | 在现有受控 HTTP 文件增加原子请求字段验收，拆开 temperature/top_p、预算、身份、缓存、格式、工具等；复用核心响应矩阵拆出 usage 子项 | 实际请求体按字段独立断言，错误状态不能算兼容；请求两种 stream 模式，响应四种格式；共享已有临时服务器、fixture、HTTP/SSE 读取 |
| 3 | 基于 Node 内置测试事件生成逐点 JSON 和 Markdown 报告 | 分开兼容通过/失败、未实现、未覆盖、无等价映射、边界回归；测试异常及缺用例导致非零退出码 |
| 4 | 验证报告器不会将拒绝、skip、todo 或漏测染绿；运行逐点验收、协议专项、完整测试 | 保留真实退出码及所有失败；如暴露产品缺口，记录实际转发次数、字段和错误，不更改应用或弱化预期 |

### 10.3 兼容点及证据范围

请求字段以独立测试清单为准：通用采样、输出预算、metadata、身份/service_tier、verbosity、输出格式及 Schema 各控制、工具选择/strict/parallel、缓存 key/retention/options、stop、概率与 stream_options，以及原生专属 seed/penalty/n/logit_bias/音频/预测/思考字段。Responses 的服务端状态和 Messages 的专属控制保留原生/边界证据，不能因跨协议被拒绝就计为兼容。

响应复用已有矩阵，覆盖正常文本、拒绝、截断、未知/部分用量、多轮并行工具；分别记录输入/输出/总 token、缓存读取/写入。补充关联现有 ID、多 choices、默认思考、原生 Responses 生命周期、概率和 UTF-8 用例。原生字段、客户端模型身份、未知扩展、原始数字、取消、终态和故障切换继续保留原测试。没有收录的未来 API 字段不在当前有限清单的覆盖承诺中，不能宣称覆盖整个未来协议。

Chat `reasoning_effort` 与 Responses `reasoning.effort` 的单独控制按同一明确 effort 值验收；不将 summary、加密私有历史或跨供应商迁移当成它的等价含义。这个请求控制若尚被笼统拦截，要显示为“未实现/验收失败”，不改为预期拒绝。依据为实际打开的 [OpenAI reasoning 文档](https://developers.openai.com/api/docs/guides/reasoning)及 [Chat 参数契约](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。这是一项单独的参数映射验收，不宣称任意模型支持全部 effort 值。

原生专属请求字段用例证明网关转发字段，不证明供应商实际接受这些值、产生音频或完成后台任务生命周期。可验证的原生 Responses 保存/续接与完整加密历史另有关联的 HTTP 用例；conversation、后台任务管理、供应商全量模型/参数组合及完整音频工作流不在当前正向证明中，也不计为已兼容。

### 10.4 可执行入口与报告

- `scripts/protocol-compatibility-catalog.js`：独立的字段/语义清单、协议方向、格式、必需正向测试及无等价原因。当前 87 个兼容点、1153 个单元格，其中 995 格要求正向通过，158 格无已核实的等价映射。
- `test/protocol-boundary-contract.integration.test.js`：复用原临时 HTTP 网关和供应商，新增 484 项原子请求验收、4 项 Messages 原生扩展四路径验收；将原 36 个 text-cache 用例中的 usage 断言拆为 180 个独立子测试，不增加重复 HTTP 请求。正向用例要求状态、实际请求字段、调用次数、完整答案/工具和正确终态。
- `scripts/protocol-compatibility-report.js` 与 `scripts/check-protocol-compatibility.js`：消费 Node 内置测试事件，按文件及精确用例名匹配证据，生成逐点 JSON/Markdown。继续读取 `package.json` 的现有协议专项文件清单，不维护第二套测试框架或重复服务器。
- `test/protocol-compatibility-report.test.js`：8 项防误报检查，覆盖仅拒绝测试通过、已知/未知失败、缺失、skip/todo、重复、错误文件、无等价原因及独立清单审计。

使用 Node 22：

```bash
npm run test:compatibility -- --output /tmp/airouter-compatibility-final
npm run test:protocol
npm test
```

第一个命令生成 `/tmp/airouter-compatibility-final.json` 与 `.md`。报告分别列出兼容通过、兼容失败、未实现、未覆盖、未验证、无效证据及无等价映射；边界拒绝/安全回归另计。`knownGap` 只影响失败的分类，不修改 200 正向预期，也不会放宽门禁；修复后同一测试真实通过才转为兼容。任何必需项失败或缺失均返回非零退出码。

### 10.5 19c445e 修复前结果与暴露的缺口

2026-10-25，基于应用提交 `19c445e`，Node v22.19.0；以下为本次新测试在应用未修改时的结果：

| 命令/证据 | 实际结果 | 退出码 |
| --- | --- | --- |
| `npm run test:compatibility` | 987 格兼容通过，其中 HTTP 986 格、单元 1 格；8 格未实现且正向验收失败；158 格无已核实等价映射；当前清单内未覆盖/未验证/无效证据均为 0 | 1 |
| `npm run test:protocol` | 1864 项：1856 通过、8 失败，零跳过/取消/todo | 1 |
| 完整 `npm test` | 2116 项：2108 通过、8 失败，零跳过/取消/todo | 1 |
| 其余已执行回归 | 边界/拒绝 317 项、其他回归 552 项均通过，不增加兼容通过数 | 包含于上列门禁 |

| 兼容点 | 方向 | 格式与失败数 | 实际 HTTP 证据 |
| --- | --- | --- | --- |
| `request.reasoning.effort` | Chat→Responses、Responses→Chat | 各 JSON/SSE，共 4 项 | 请求仅带 low effort；网关笼统要求同协议，400 `unsupported_protocol_feature`，供应商调用 0；没有把它误称为 HTTP 静默丢字段 |
| `request.background.false` | Responses→Messages | JSON/SSE，共 2 项 | 明确同步默认值仍被 400 拒绝，供应商调用 0；没有自动执行后台任务的需求 |
| `request.truncation.disabled` | Responses→Messages | JSON/SSE，共 2 项 | 明确禁用自动裁剪仍被 400 拒绝，供应商调用 0；没有要求自行裁剪历史 |

上述测试保持失败；本次没有修改应用来实现这些能力，也没有改为“预期拒绝”或 skip/todo。初次另外两项 system 指令测试失败，经核对是合法的 input system 消息配合空 instructions：修正预期表示判断后仍精确断言原始指令、层级、顺序与无重复，不将测试错误记作产品缺陷。完整运行也发现 CLI 名称若以 `test-` 开头会被 Node 自动发现并嵌套运行，现使用 `check-protocol-compatibility.js`，最终不存在此测试入口错误。

最终日志：`/tmp/airouter-compat-{protocol,full,points}-final.log`；真实退出码汇总 `/tmp/airouter-compat-final-exits.json`。测试及运行入口 SHA256 在最终三次命令执行期间一致，清单 `/tmp/airouter-compat-tests-{before,after}.json`。应用、启动器及本地 config.json 前后校验一致，未提交、推送、部署或调用真实供应商。本轮清单之外的能力不能因为“未覆盖=0”而被宣称已兼容；真实供应商验收数量为 0。

### 10.6 三项控制兼容修复与当前验收

本节续接第 10.5 节的旁支失败快照，开始修改应用实现。未回退 `19c445e`，保留旁支清单、报告器、测试及历史结果；不修改 `config.json`、账号、路由或凭证，不提交原有生成图片。

| 问题及实际复现 | 修复位置与当前语义 | 对应验收 |
| --- | --- | --- |
| 单独 low effort 双向 JSON/SSE 均在发送前 400，供应商调用 0，共 4 项 | `app/protocol-request-controls.js` 只映射 Chat `reasoning_effort` ↔ Responses `{effort}`；支持当前官方共有枚举及 null，值原样保留，不替换供应商不支持的值。Responses 解析器移除笼统拒绝，路由在完整请求已经通过共享转换器后不再用粗 reasoning 标记拦截。只有能力标记、没有完整请求体时仍保守拒绝 | 原 4 项保持 200、精确字段、完整答案/工具、正确终态及一次调用断言；新增 8 项两方向×上游 JSON/SSE×下游 JSON/SSE 的实际 reasoning 输出验收，以及 4 项 effort + 工具多轮/来源精确还原 |
| `background:false`→Messages，JSON/SSE 共 2 项发送前 400、调用 0 | 共享字段规则明确消费同步默认值，Messages 请求不携带 background；未实现后台任务 | 原 2 项正向验收不变；true 及 true/disabled 组合继续 400、零调用；随后原主目标仍可用 |
| `truncation:disabled`→Messages，JSON/SSE 共 2 项发送前 400、调用 0 | 共享字段规则消费禁止自动裁剪的控制，完整历史交给 Messages，不携带 truncation，不裁剪或压缩历史 | 原 2 项正向验收不变；auto 及 false/auto 组合继续 400、零调用；新增精确检查完整 user/assistant/user 顺序 |

字段依据已实际读取：[Chat reasoning_effort](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[Responses reasoning/background/truncation](https://developers.openai.com/api/reference/resources/responses/methods/create)。同一 effort 值具有共享请求控制语义；支持哪些值仍由实际模型决定，不根据一次回答或 token 数推断某模型一定遵循每个档位。`background:false` 与 `truncation:disabled` 的 Messages 适配是网关消费明确默认控制，不冒充 Messages 新增了这两个 API 字段。

#### 10.6.1 回归与失败证据

- 修改应用前重新执行逐点入口，结果仍为 **987 通过、8 未实现失败、158 无等价**，退出码 1：`/tmp/airouter-compatibility-before-fix.{json,md,log}`。
- 新增的 12 项 effort + 输出/工具组合先 **0/12、退出码 1**，修复后 **12/12、退出码 0**：`/tmp/airouter-effort-combined-{red,green}.log`。独立预期包括公开 reasoning_text、原始来源密文、工具 ID/参数/结果、完成事件、两轮调用次数；不只检查参数改名或 200。
- 额外两条原生 HTTP 回归先 0/2、退出码 1，证明恢复公开思考标记时同协议 effort 被重建流程删除；修复后 2/2、退出码 0。原生路径现在仅替换恢复后的 input/messages，保留完整根控制字段：`/tmp/airouter-effort-native-history-{red,green}.log`。
- 新增边界 HTTP 检查：summary/encrypted_content/generate_summary/context/未知 effort/空 reasoning 对象继续明确拒绝；附 effort 的外来加密历史仍 409，零供应商调用。拒绝后原主模型立即成功，未冷却、未转后备。另补共有 effort 枚举/null 的精确映射及非法值/未知子字段断言。
- 一条旧“Chat high effort 必须拒绝”的组合回归与本期实现冲突，已升级为精确 `{effort:'high'}` 及不泄漏源字段的成功验收；Responses 的 summary、Messages 的 thinking/budget 仍按原边界拒绝。没有将原 8 项正向验收改成拒绝、删除或 skip。
- 清单仅移除这 8 个已实现格子的 knownGap 标记，方向和 158 格无等价范围均不变。报告器仍验证 knownGap 失败不能染绿；清单审计改为精确要求这批已实现项不再声明缺口，不再要求永远至少存在一个未实现项。

#### 10.6.2 当前自动化结果

Node v22.19.0，零 skip/todo/取消；三项命令保留真实退出码：

| 命令 | 当前结果 | 退出码 |
| --- | --- | --- |
| `npm run test:compatibility -- --output /tmp/airouter-compatibility-fixed` | 87 点、1153 格：**995 格兼容通过**（994 HTTP、1 单元），**158 格无等价**；未实现/兼容失败/未覆盖/未验证/无效证据均为 0。边界 319、其他回归 567 分开统计，不加入兼容通过数 | 0 |
| `npm run test:protocol` | **1881/1881** | 0 |
| `npm test` | **2133/2133** | 0 |

日志为 `/tmp/airouter-compatibility-fixed.log`、`/tmp/airouter-effort-protocol-final.log`、`/tmp/airouter-effort-full-final.log`。完整门禁继续包含私有状态归属、TTL/重启/迟到/A→B→A、免费池、普通 auto、耗尽接替/恢复、取消、拒绝不重试及输出后不重放；本期未改这些生命周期实现。

#### 10.6.3 独立真实供应商验证

用服务器最新配置的受保护临时副本在本地运行当前代码，额外路由仅存在于副本：Go `gpt-6-luna` 原生 Responses、`claude-haiku-5-5` 原生 Messages。未向服务器持久配置添加路由。

`/tmp/airouter-effort-live/supplier-results.json` 共 **10 项成功**：

- Chat low effort→Go Responses、Responses low effort→Go DeepSeek Chat，分别 JSON/SSE，4 项成功，答案 `7`。
- Responses background:false→Go Messages、truncation:disabled→Go Messages，分别 JSON/SSE，4 项成功，答案 `7`。
- 两个 effort 方向均进行真实工具两轮，答案 `30`。DeepSeek 第一轮实际有 23 个 reasoning tokens，单独 reasoning 内容随完整工具历史回传。原生 Responses 工具轮实际没有返回 reasoning/密文，**不将该成功记作真实 opaque 回传证明**。

网关没有删除被请求的 effort 或重试不带参数的请求。真实请求成功证明对应供应商当次接受这组控制及协议，不证明所有模型支持每个 effort 值。逐点报告的 realSupplierChecks 仍为 0，因为它只统计受控自动化；上述真实证据单独保存，不混入 995 格。

仍不开放 reasoning.summary/context/私有 include 等未核实等价控制；不允许 effort 绕过不透明历史来源校验。后台任务、自动裁剪、conversation、持久续接及跨账号/模型迁移的原边界不变。本轮没有新增缓存命中实验，不借用一次回答成功宣称缓存或服务端存储验收。
