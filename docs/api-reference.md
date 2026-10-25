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

目录差异包含 `discovered`、`added`、`removed`、`kept`、`protocol_changes` 和 `suggested_models`；界面合并后仍需保存账号才会持久化。内置平台使用内置目录规则，自定义平台支持 `models_endpoint`。

账号对象和模型字段详见[配置契约](config-item-reference.md#4-上游账号)。被路由引用的模型或协议不可直接移除；仍被引用的账号不可删除。

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
