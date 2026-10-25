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
