# 统一上游与模型路由

## 1. 交付范围

管理台仅保留“上游账号”和“模型路由”两个页签。首页展示账号或路由列表；新增、编辑在独立弹窗中完成，保存后返回列表。入口密钥、登录态导入和端口收进设置入口，默认关闭。

所有账号平等。平台与凭证类型只决定地址、鉴权、模型发现和额度解释，不决定优先级。配置统一使用 `config.json`，不读取或迁移旧文件；只有一套路由规则，没有模式开关、停用账号数组、焦点或全局别名。所有对话请求必须命中配置中的客户端模型 ID。

## 2. 配置与交互

账号使用稳定的 `configs[].id`，维护平台、名称、转发凭证和支持模型列表。模型可手动增删改，也可同步供应商目录；只有自定义平台显示模型列表地址。新增账号尚未保存时也可使用草稿凭证同步，接口不持久化草稿。

同步结果先展示差异：已有模型默认保留，新增项可勾选，接口未返回的本地项不自动删除。合并只修改编辑草稿，保存才生效。被路由引用的模型不能直接删除；需要先修改相关候选。

客户端模型 ID 可任意命名、区分大小写，最长 200 字符。每条路由包含有序候选，每个候选选择“上游账号 + 该账号支持的后端模型 + 协议”。切换账号时模型选项立即联动。新增候选和调整顺序不会覆盖已有候选的稳定 ID。

例如 `deepseek` 可以映射到某个 GLM 账号的 `glm-5.3`，也可以命名为其他 ID。`GET /v1/models` 只返回已启用的客户端 ID，不泄露全部上游目录。配置字段与完整样例见 [配置项参考](config-item-reference.md)。

## 3. 供应商适配

| 平台 | 默认推理地址 | 模型同步 | 额度来源 |
| --- | --- | --- | --- |
| ChatGPT/Codex | `chatgpt.com/backend-api/codex/responses` | 未核实账号目录接口，手动维护 | `backend-api/wham/usage` |
| Claude OAuth | 保留已有登录态链路 | 手动维护 | 未配置可验证的额度来源 |
| OpenCode Go | `opencode.ai/inference/go` 下的 OpenAI/Anthropic 协议路径 | `/inference/go/v1/models` | `/zen/go/v1/usage` |
| OpenCode Zen | `opencode.ai/inference` 下的 OpenAI/Anthropic 协议路径 | `/inference/v1/models` | 普通 Key 余额接口未核实，显示未知 |
| OpenRouter | `openrouter.ai/api/v1` | `/api/v1/models` | 同凭证读取 `/api/v1/key` 和 `/api/v1/credits` |
| GLM Coding Plan 中国 | `open.bigmodel.cn/api/coding/paas/v4` | 对应 `/models` | `/api/monitor/usage/quota/limit` |
| GLM Coding Plan 国际 | `api.z.ai/api/coding/paas/v4` | 对应 `/models` | `/api/monitor/usage/quota/limit` |
| 自定义 | 用户配置 | 用户配置 | 默认未知 |

模型目录不是写死的模型名单。目录未包含协议元数据时，OpenCode 的模型家族用于推导默认协议；用户仍可手动调整。GLM 的 `TIME_LIMIT` 是工具额度，不阻断模型推理；推理窗口使用 `TOKENS_LIMIT` 等可解释指标。

OpenRouter 模型目录公开可读，成功不能证明 Key 有效。普通转发 Key 的 `/credits` 可用性以实际响应为准；若账号返回无权限，保留可用的 Key 限额，不伪造账户余额、不要求增加凭证。余额与 Key 限额分别保留，任一明确耗尽都会阻断。适配器不假定每个 Key 都具备相同权限。

OpenCode 请求使用明确的 Airouter User-Agent，保留客户端稳定会话标识；同一请求重试保持 `x-opencode-session` 不变，不转发入口鉴权凭证。

来源：[OpenRouter Key](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key)、[OpenRouter Credits](https://openrouter.ai/docs/api/api-reference/credits/get-credits)、[OpenCode Go](https://opencode.ai/v2/docs/console/go/)、[Zen 余额接口缺口](https://github.com/anomalyco/opencode/issues/44189)、[GLM 官方用量查询实现](https://github.com/zai-org/zai-coding-plugins/blob/main/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs)。

## 4. 额度和候选选择

额度统一为 `available / exhausted / unknown`，保留金额或百分比指标、更新时间、重置时间及查询错误。读取失败、字段缺失、无权限不能解释为 0。已知耗尽在查询失败时继续保持，不能通过连续失败“恢复”。OpenRouter 两个来源分别保留耗尽证据。

候选严格按顺序选择：最高优先级可用就持续使用，额度耗尽后使用下一项；确认恢复后，下一次携带完整上下文的请求自动回到高优先级。鉴权失败、短时限频、上游故障有独立的账号或模型冷却。OpenRouter 的 in-flight budget 属于短期限制，不等同于账户余额耗尽。客户端参数错误或内容拒绝不通过换上游规避。

额度未知时允许单个请求验证，探测锁在成功、异常和取消时释放。不支持额度查询的账号发生业务耗尽后，默认等待五分钟（或供应商提供的恢复时间）再允许单次恢复探测；不会每次请求立即重复尝试。

后台默认每分钟刷新，手动刷新可立即查询。更换同一账号 ID 的凭证、平台或连接地址时失效旧快照，迟到的旧查询不能污染新账号状态，同时清除旧健康和私有上下文绑定。

## 5. 转发和上下文边界

`/v1/chat/completions`、`/v1/responses`、`/v1/messages` 使用同一候选调度，并按候选协议原样转发或桥接普通文本、工具调用及 SSE。响应中的模型身份保持客户端 ID。

每个请求的候选尝试次数受配置限制；默认最多三次，不超过候选数量。未向客户端输出前的 HTTP 错误、200 错误载荷、SSE 初始错误及传输截断可按分类尝试后备。响应一旦输出，不拼接另一上游的结果。客户端取消会中止活动上游并释放资源。

`previous_response_id` 仅在原生 APIKey Responses、请求允许保存且上游明确 store:true 时，按入口调用者、原账号、后端模型和协议绑定；不能跨账号迁移。未知绑定、服务重启后丢失绑定、账号身份变化或候选模型变化时返回明确错误，客户端需重发完整上下文。绑定只保存在内存，不持久化完整对话。

不能保真转换的文件、音频、内置服务端工具等能力会过滤候选或返回错误，不静默丢弃。公开思考文本保持独立内容；已知的不透明 reasoning/signature 可通过网关标记完整回传给原账号、后端模型和协议，其来源校验与内存生命周期见[协议验证记录第 9 节](protocol-compatibility-verification.md#9-默认思考内容及来源状态传输修复)。它不增加服务端保存能力，也不允许私有状态跨供应商迁移。没有图片生成/编辑或 CPA 通配入口；图像消息内容的协议桥接也不等同于图片生成能力。

对话请求体默认上限为 16 MiB，接收空闲超时为 30 秒。`UPSTREAM_TOTAL_TIMEOUT_MS` 默认 600000 毫秒，传给每次上游请求；当前不承诺跨候选共用一个总 deadline。没有全局业务请求队列或统一并发上限；单账号未知额度探测锁不能解释为通用并发控制。配置项见[运行环境变量](config-item-reference.md#6-运行环境变量)。

## 6. 管理接口

管理接口受独立管理凭证保护；上游凭证不回显，编辑时留空保留原值。

账号操作使用 `/admin/api/upstreams`，登录态导入使用 `/admin/api/upstreams/import`，路由使用 `/admin/api/model-routes`；端口和入口密钥分别使用 `/admin/api/settings`、`/admin/api/apikeys`。模型目录支持已保存账号查询和未保存草稿预览，额度刷新返回统一状态。

管理修改串行处理，路由保存可携带修订号；过期修订号返回 409。校验失败不会写入配置。界面读取路由状态不会占用请求探测锁。完整方法、字段、返回与错误码只在 [API 参考](api-reference.md) 定义。

不提供旧配置管理 API、焦点、全局别名、额度模板页签或额度凭证选择器。供应商差异由内部适配器处理。

路由卡提供独立测试弹窗，可自定义文本和入口协议，选择正常路由测试或全部候选逐项测试。前者检查真实调度，后者独立诊断每个账号和后端模型；结果显示可用性、实际尝试顺序、响应、耗时和错误，可中途停止。候选诊断不会修改生产配置、额度或冷却；具体接口及边界见 [API 参考 4.1](api-reference.md#41-手动链路测试)。

## 7. 实现与验证

`provider-presets.js` 管地址、目录和额度解析；`routing-config.js` 管契约；`quota-engine.js` 管快照和刷新；`model-router.js` 管选择、健康及上下文归属；`protocol-bridge.js` 管协议转换；`explicit-routing-handler.js` 管一次 HTTP 请求的执行和清理。`openai.js` 连接运行态与管理接口，`config-admin-routing.js` 实现列表和编辑交互。

自动化覆盖配置、额度归一化、故障分类、优先级和恢复、上下文归属、协议桥接、管理接口及交互草稿。HTTP 集成测试启动真实本地服务和受控假上游，验证耗尽切换、恢复回切、SSE 边界、取消、截断、模型引用保护和草稿同步不落盘。

真实供应商验证使用私有临时配置，分别确认目录、额度和网关回答。真实凭证不进入仓库、测试样本和文档。单元与假上游测试不能替代套餐权限、区域网络或真实推理验收；发布结果应给出该版本实际执行的验证。

## 8. 服务部署

服务默认只读取 `config.json`，可通过绝对路径 `CONFIG` 指定受保护的持久配置，通过 `AIROUTER_BIND_HOST=127.0.0.1` 只监听回环地址，由 Nginx 提供公网 HTTPS。管理认证失败和启动日志不输出管理凭证。公网部署使用独立系统用户、只读代码目录和受保护的可写配置目录；代理关闭包含管理查询参数的访问日志，并关闭 SSE 缓冲。

代码按 Git 提交打包至独立 release 目录，切换 current 链接后重启 systemd 服务。IP 证书需要自动续期和续期后 Nginx reload；不能仅以安装服务或进程 active 作为转发验收。


## 9. 自动维护的免费模型池

两种内置池作为普通上游进入现有路由，不创建另一套路由模式。`free-pool-engine.js` 管目录、价格资格、能力、分级与统计；`model-router.js` 在外层候选轮到池时选出具体模型，`explicit-routing-handler.js` 复用原协议、错误分类与流式提交边界。池内调用失败可切换具体模型，全部不可用再尝试下一个外层候选；已输出内容后不重放。发送前再次检查身份与最新免费资格，避免同步撤销价格资格后发出迟到请求。

### 9.1 资格来源与防收费

| 池 | 自动同步与纳入规则 |
| --- | --- |
| OpenCode | 带账号凭证的 Go/Zen `/v1/models`，与 [models.dev API](https://github.com/anomalyco/models.dev#api) 对应 provider 元数据取交集；输入/输出价格必须存在，所有已列 cost 必须严格为有限零值；核验协议、能力和上下文。models.dev 为 OpenCode 使用的社区维护元数据，不能声称是供应商实时计费保证 |
| OpenRouter | [账号过滤目录 `/models/user`](https://openrouter.ai/docs/api/api-reference/models/list-models-filtered-by-user-provider-preferences-privacy-settings-and-guardrails)；prompt/completion 明确零，其余出现的价格维度递归全零；每次具体模型请求强制 [provider.max_price=0](https://openrouter.ai/docs/guides/routing/provider-selection#max-price) 及参数支持检查，取消用户自带模型后备/插件绕过 |

两池排除下架、到期、价格不明、协议或必要能力不明的模型。仅使用纯文本输出的通用对话模型，排除生成音频/图片及明确声明为专用安全分类器的模型；不能将音乐产品的零 token 价格误认为产品免费。OpenRouter 的 `openrouter/*` 路由别名不作为成员，尤其 [openrouter/free](https://openrouter.ai/docs/guides/routing/routers/free-router) 的随机策略不等于本池策略。

供应商目录失败不覆盖有效列表；保留最后成功时间及异常。超过价格有效期则停止选择，恢复成功同步后自动重新参与。后台定时刷新、手动同步和启动恢复共用同一引擎；同池同步合并，身份变化后的迟到结果丢弃。明确收费/下架撤销后的旧缓存不能因启停重新复活。

OpenCode Go 免费候选独立于付费窗口，[官方 Go 文档](https://dev.opencode.ai/v2/docs/console/go) 的套餐、免费模型与隐私规则仍由服务端执行。Zen 的[免费客户端限制](https://dev.opencode.ai/v2/docs/console/models#endpoints)如实展示，不伪装 OpenCode。API Key、账号免费次数、区域、权限和训练授权限制均保留，不自动修改平台设置。

### 9.2 选择、健康与可见性

先按请求能力过滤，再分级、近期成功率和延迟排序。默认所有无配置模型均为第 5 档，明确标注未评级，不把名称、参数量或一次成功当作质量评分。近期统计只说明实际调用表现，不代表模型能力评测；高级设置可显式分级或选择速度策略。

输入按 UTF-8 字节加输出预算、1024 余量保守估算；每张图片额外预留 32768。它不是精确 tokenizer，不保证远程图片实际 token 数，供应商仍会最终校验。输出限制未提供时，池请求补 2048，与匹配预算一致。未知上下文/最大输出的模型不接收调用；不能保真桥接或不支持的工具、图像等请求会跳过池。

模型临时故障、限流和权限失败进入模型冷却；明确账号级免费限额/负余额进入池账号冷却，401 进入认证冷却。冷却后可重新参与，池状态不污染来源付费账号的额度。最近成功/失败/实际模型落点在详情可见，客户端响应模型仍保持外层公开 ID。

管理页继续两个页签。新建上游可选免费池并复用账号；外层模型固定 `free`。内部模型和状态放独立详情弹窗，同步周期、策略、分级放高级设置。验收须区分受控自动化与真实供应商调用；自动增删、故障和恢复用可控目录/上游验证，真实调用确认当时网络、权限及实际落点，不宣称覆盖未来平台变化。


### 9.3 本次验证范围（2026-10-25）

自动化通过 316 项测试，覆盖模型自动增删、收费/未知价格排除、同步失败保留及过期停用、重启缓存和身份变化、能力/上下文匹配、池内与外层预算、限流/权限/账号级限制、故障切换、付费耗尽转免费及恢复回切、流提交后不重放。浏览器分别使用独立 UI 夹具与真实本地 Airouter 加受控上游检查表单及结果；不以夹具代替供应商权限验证。

真实账号在本地新版本同步成功：Go 免费池 2 个、OpenRouter 免费池 16 个符合当时严格价格/能力条件的成员。实际池请求分别选择 `beam-free`、`cohere/north-mini-code:free` 并返回预期文本。本地 OpenCode 使用隔离配置的普通 `auto` 路由（仅含两个免费池，用于强制覆盖免费路径），完成 read 工具往返并返回 `AIROUTER_FREE_POOL_1359:42`，实际落点为 `beam-free`；随后恢复本地四级路由。

以上真实调用证明当时的目录、网络与所选模型权限，不代表全部池内模型均经过推理验收。没有为验证故意耗尽真实付费套餐、修改隐私授权或进行长期限流压力测试；故障、耗尽、恢复和自动目录变化由受控测试覆盖。OpenCode 价格仍依赖社区维护元数据及时性；缓存有效期与发送前复核降低陈旧风险，不能宣称供应商未来不会改变计费或目录契约。


## 10. 三协议兼容性与缓存

请求转换先按可保真能力筛选候选，不能用静默丢字段或角色降级维持转发。跨协议ID使用来源协议与完整源ID编码；原生ID保留。SSE增量解码、原生格式互转、字段控制、终态、用量和缓存的精确规则及当前回归与真实供应商证据统一记录于[三协议修复与验证](protocol-compatibility-verification.md)，避免与接口清单重复定义。
