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

`previous_response_id` 按入口调用者、原账号、后端模型和协议绑定；不能跨账号迁移。未知绑定、服务重启后丢失绑定、账号身份变化或候选模型变化时返回明确错误，客户端需重发完整上下文。绑定只保存在内存，不持久化完整对话。

不能保真转换的文件、音频、内置服务端工具、加密 reasoning 等能力会过滤候选或返回错误，不静默丢弃。没有图片生成/编辑或 CPA 通配入口；图像消息内容的协议桥接也不等同于图片生成能力。

对话请求体默认上限为 16 MiB，接收空闲超时为 30 秒。`UPSTREAM_TOTAL_TIMEOUT_MS` 默认 600000 毫秒，传给每次上游请求；当前不承诺跨候选共用一个总 deadline。没有全局业务请求队列或统一并发上限；单账号未知额度探测锁不能解释为通用并发控制。配置项见[运行环境变量](config-item-reference.md#6-运行环境变量)。

## 6. 管理接口

管理接口受独立管理凭证保护；上游凭证不回显，编辑时留空保留原值。

账号操作使用 `/admin/api/upstreams`，登录态导入使用 `/admin/api/upstreams/import`，路由使用 `/admin/api/model-routes`；端口和入口密钥分别使用 `/admin/api/settings`、`/admin/api/apikeys`。模型目录支持已保存账号查询和未保存草稿预览，额度刷新返回统一状态。

管理修改串行处理，路由保存可携带修订号；过期修订号返回 409。校验失败不会写入配置。界面读取路由状态不会占用请求探测锁。完整方法、字段、返回与错误码只在 [API 参考](api-reference.md) 定义。

不提供旧配置管理 API、焦点、全局别名、额度模板页签或额度凭证选择器。供应商差异由内部适配器处理。

## 7. 实现与验证

`provider-presets.js` 管地址、目录和额度解析；`routing-config.js` 管契约；`quota-engine.js` 管快照和刷新；`model-router.js` 管选择、健康及上下文归属；`protocol-bridge.js` 管协议转换；`explicit-routing-handler.js` 管一次 HTTP 请求的执行和清理。`openai.js` 连接运行态与管理接口，`config-admin-routing.js` 实现列表和编辑交互。

自动化覆盖配置、额度归一化、故障分类、优先级和恢复、上下文归属、协议桥接、管理接口及交互草稿。HTTP 集成测试启动真实本地服务和受控假上游，验证耗尽切换、恢复回切、SSE 边界、取消、截断、模型引用保护和草稿同步不落盘。

真实供应商验证使用私有临时配置，分别确认目录、额度和网关回答。真实凭证不进入仓库、测试样本和文档。单元与假上游测试不能替代套餐权限、区域网络或真实推理验收；发布结果应给出该版本实际执行的验证。

## 8. 服务部署

服务默认只读取 `config.json`，可通过绝对路径 `CONFIG` 指定受保护的持久配置，通过 `AIROUTER_BIND_HOST=127.0.0.1` 只监听回环地址，由 Nginx 提供公网 HTTPS。管理认证失败和启动日志不输出管理凭证。公网部署使用独立系统用户、只读代码目录和受保护的可写配置目录；代理关闭包含管理查询参数的访问日志，并关闭 SSE 缓冲。

代码按 Git 提交打包至独立 release 目录，切换 current 链接后重启 systemd 服务。IP 证书需要自动续期和续期后 Nginx reload；不能仅以安装服务或进程 active 作为转发验收。
