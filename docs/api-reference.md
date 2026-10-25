# HTTP API

## 1. 鉴权与约定

业务接口包括 `/health`、`/v1/models` 和三个对话入口，使用 `Authorization: Bearer <入口密钥>` 或 `x-api-key`，匹配 `config.json.apikeys`。明确配置空数组时不校验入口密钥。

`/admin/*` 使用独立管理凭证：查询参数 `auth_token`，或 `Authorization: Bearer <管理凭证>` / `x-api-key`。管理认证失败返回 401，不回显正确凭证。账号读取只返回 `has_credentials`、`has_refresh_token` 等标记；入口密钥仅在受保护的设置响应中展示。

对话请求必须使用 `Content-Type: application/json`，JSON 体默认上限 16 MiB；管理 API 使用 JSON，体积上限 1 MiB。管理修改串行化执行，校验通过后原子保存并热加载。

## 2. 业务接口

| 方法与路径 | 输入与返回 |
| --- | --- |
| `GET /health` | 返回 `status`、账号数量与客户端模型 ID 列表 |
| `GET /v1/models` | OpenAI 风格 `data[]`，只列已启用的客户端路由 ID |
| `POST /v1/chat/completions` | Chat Completions JSON；必填已配置 `model`，按候选协议转发或桥接 |
| `POST /v1/responses` | Responses JSON；必填已配置 `model`，支持流式与非流式响应 |
| `POST /v1/messages` | Messages JSON；必填已配置 `model`，按候选协议转发或桥接 |

请求中的客户端 `model` 与后端模型名独立；响应中的模型身份保持客户端 ID。支持的文本、图片内容、普通工具和 SSE 能力受目标模型与协议转换能力约束；不支持的结构不会静默丢弃。完整边界见[统一设计第 5 节](unified-model-routing-design.md#5-转发和上下文边界)。

`previous_response_id` 只允许续接原调用者的原 Responses 候选；服务重启、账号身份或候选模型变化后可能需要重发完整上下文。已经向客户端输出的流不会切换到后备拼接。

没有 `/v1/*` 通配代理，也没有图片生成/编辑或 CPA 入口；未注册路径返回 404。

## 3. 账号与目录管理

| 方法与路径 | 请求 | 成功返回 |
| --- | --- | --- |
| `GET /admin/api/upstreams` | 无 | `revision`、`presets`、`configs`，包含模型、额度和路由引用 |
| `POST /admin/api/upstreams` | 账号对象；必填有效 `preset`，其余字段见配置契约 | 201，账号概览及 `added_id` |
| `POST /admin/api/upstreams/import` | `{ "raw_json": "<AuthSession 或 Sub2API JSON 字符串>" }`；字符串内可为对象或非空数组 | 201，账号概览及 `added_ids`；导入账号模型列表初始为空 |
| `PUT /admin/api/upstreams/:id` | 账号补丁；凭证字段为空时保留旧值 | 更新后的账号概览 |
| `DELETE /admin/api/upstreams/:id` | 无 | 删除后的账号概览 |
| `POST /admin/api/upstreams/models/discover` | 草稿账号字段；可传 `config_id` 复用已有凭证 | 模型目录与差异预览，不保存草稿 |
| `POST /admin/api/upstreams/:id/models/discover` | 空对象 | 使用已保存账号查询目录并返回差异 |
| `POST /admin/api/upstreams/:id/quota-refresh` | 空对象 | `config_id`、归一化 `quota`、当前 `upstream` |

目录差异包含 `discovered`、`added`、`removed`、`kept`、`protocol_changes` 和 `suggested_models`；界面合并后仍需保存账号才会持久化。内置平台使用内置目录规则，自定义平台支持 `models_endpoint`。Sub2API 中转站使用同一转发 Key 查询站点 `/v1/models` 与 `/v1/usage`，钱包/Key/订阅额度按 USD 金额归一化；配置及上游信息缺失边界见[Sub2API 配置](config-item-reference.md#7-sub2api-中转站-api-key)。

账号对象和模型字段详见[配置契约](config-item-reference.md#4-上游账号)。被路由引用的模型或协议不可直接移除；仍被引用的账号不可删除。

### 3.1 免费池详情与刷新

`GET /admin/api/upstreams` 的池账号包含 `credential_ref`、高级配置 `pool`、运行快照 `pool_status`；`models` 只有 `free`，`quota` 为 null。`has_credentials` 包含有效引用来源。`pool_status` 提供 `state`、内部 `models[]`、最后成功/尝试同步时间、异常、价格来源、最近请求实际模型及账号级健康；内部模型含资格证据、上下文/能力、可用状态、档位及依据、近期成功率/延迟。

`POST /admin/api/upstreams/:id/pool-refresh` 使用管理鉴权及已保存凭证，返回 `{ "pool_status": {}, "upstream": {} }`。目录调用失败保留缓存并返回带 `error` 的快照，HTTP 200 不等于同步成功；非池返回 400，未知账号返回 404。普通 `models/discover` 对池拒绝，防止手动目录覆盖固定 `free`。

新增/编辑池沿用账号 POST/PUT。`credential_ref` 与独立 `apikey` 二选一，空引用可切换独立 Key；引用账号不可删除或改成不兼容平台。字段和有效期见[配置契约第 6 节](config-item-reference.md#6-免费模型池)。测试接口的 `attempts[]` 对池额外返回 `pool_id`、`pool_target_id`，`model` 是实际后端模型；客户端模型身份保持原公开 ID。

## 4. 路由与设置

| 方法与路径 | 请求 | 成功返回 |
| --- | --- | --- |
| `GET /admin/api/model-routes` | 无 | `revision`、`max_attempts`、`models`、`route_status`、账号/平台目录和公开 ID |
| `PUT /admin/api/model-routes` | `{ "revision": "可选修订号", "models": [], "max_attempts": 3 }` | 更新后的路由概览；提供旧修订号时返回 409 |
| `GET /admin/api/settings` | 无 | `apikeys`、`port`、`proxy_port` |
| `POST /admin/api/settings` | 仅支持 `port`、`proxy_port`；`proxy_port: null` 可取消代理端口 | 更新后的设置；监听端口变更成功后生效 |
| `POST /admin/api/apikeys` | 空对象 | 201，新增随机入口密钥后的设置 |
| `DELETE /admin/api/apikeys/:index` | `index` 为从 0 开始的入口密钥下标 | 删除后的设置 |

管理页面路径是 `/admin/configs`、`/admin/configs/upstreams`、`/admin/configs/routes`。旧 `/admin/api/configs`、焦点、批量停用数组及全局别名设置接口不再提供。

### 4.1 手动链路测试

`POST /admin/api/model-routes/test` 使用管理鉴权，发送真实模型请求，不保存输入或结果。请求示例：

```json
{ "model": "auto", "input": "请计算 1+1", "mode": "candidate", "target_id": "auto-glm", "protocol": "chat_completions" }
```

| 字段 | 约束 |
| --- | --- |
| `model` | 已保存的客户端路由 ID，区分大小写 |
| `input` | 非空文本，最多 16000 字符，保留原始空白和换行 |
| `mode` | `route` 走正常路由；`candidate` 只测试指定候选 |
| `target_id` | candidate 模式必填，必须属于该路由 |
| `protocol` | 可选，须在路由入口协议中；默认第一项 |

route 模式复用业务入口的调度和转发处理，包括优先级、额度、冷却、尝试次数和自动后备；同时正常更新运行状态。candidate 模式使用内存中的单候选快照，绕过缓存额度和冷却以检查实际可用性，不回退、不改写配置或生产额度/冷却；停用账号直接跳过。已有凭证自动刷新机制仍有效。管理页面的“测试全部候选”按路由顺序串行调用 candidate 模式，单项失败后继续下一项。

请求以非流式文本生成执行，输出上限 2048 tokens，单次最长 60 秒（可通过 `ROUTE_TEST_TIMEOUT_MS` 调低）。响应保留实际 HTTP 状态，JSON 包含 `mode`、`model`、`protocol`、`target_id`、`elapsed_ms`、`status_code`、`response`；`response` 是所选入口协议的真实响应或错误。`attempts[]` 按实际尝试顺序包含 `target_id`、`config_id`、`account_label`、后端 `model` 和 `protocol`，不含凭证。

停用账号返回 HTTP 200、`outcome: "skipped"`、`status_code: 0`、空 attempts 和 `account_disabled` 错误，表示未调用。输入或目标不合法返回 400，未知路由返回 404；进入转发前的校验错误使用普通错误格式。超时返回 504 / `test_timeout` 并中止活动上游。关闭弹窗或停止测试会取消当前请求及后续队列，不撤销已经完成的调用及其用量。

## 5. 主要错误

| 状态 | 错误码或语义 | 处理 |
| --- | --- | --- |
| 400 | `model_required`、`invalid_json`、`invalid_request_body` | 修正客户端请求 |
| 400 | `entry_protocol_not_supported` | 使用路由启用的入口协议 |
| 400 | `model_referenced` | 先修改引用该模型或协议的路由 |
| 400 | `invalid_request` | 管理字段、配置或目录请求不合法，见 `message` |
| 401 | `invalid_api_key` / `unauthorized` | 分别检查入口密钥或管理凭证 |
| 404 | `model_not_found` / `upstream_not_found` / `not_found` | 检查客户端 ID、账号 ID 或接口路径 |
| 409 | `revision_conflict` | 重新读取路由后再保存 |
| 409 | `upstream_referenced` | 先移除账号的路由引用 |
| 409 | `upstream_context_unavailable` | 重发完整上下文，不迁移私有状态 |
| 413 / 415 | 请求体超限 / `unsupported_media_type` | 缩小请求或使用 JSON |
| 503 | `no_available_upstream` | 检查账号、模型、额度与冷却状态 |
| 502 等 | 上游传输或供应商错误 | 未输出前按分类有界重试；已输出后不会拼接其他答案 |

协议入口的错误包装会适配对应协议；不要假定所有供应商错误都具有相同字段。模型转换的已知限制、额度失败的含义和恢复规则以统一设计为准。
