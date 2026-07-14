# API 接口文档

本文档只描述客户端可以直接调用的 Airouter 对外接口。管理页、管理 API、上游后台接口不在本文档范围内。

默认服务地址：

```text
http://localhost:3009
```

如果配置了入口 `apikeys`，所有接口都需要携带其中一个入口密钥：

```http
Authorization: Bearer sk-airouter-xxxx
```

也可以使用：

```http
x-api-key: sk-airouter-xxxx
```

如果没有配置入口 `apikeys`，本机请求不会校验入口密钥。

## 接口列表

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/health` | 查看本地服务和当前账号状态 |
| `POST` | `/v1/responses` | OpenAI Responses 兼容接口 |
| `POST` | `/v1/messages` | Claude Messages 兼容接口 |
| `POST` | `/cpa/v1/responses` | CLIProxyAPI 风格前缀下的 Responses 兼容入口 |
| `POST` | `/cpa/v1/messages` | CLIProxyAPI 风格前缀下的 Claude Messages 兼容入口 |
| `POST` | `/v1/images/generations` | OpenAI Images 图片生成兼容接口 |
| `POST` | `/v1/images/edits` | OpenAI Images 图片编辑兼容接口 |
| 任意 | `/v1/*` | 其它 OpenAI `/v1` 兼容接口透传 |
| 任意 | `/cpa/v1/*` | 剥离 `/cpa` 前缀后复用 `/v1/*` 兼容链路 |

## 通用转发规则

Airouter 会按管理页里的配置顺序选择可用账号。越靠前的配置优先级越高；当前活动配置可用时会继续沿用。

`token` 配置项用于 ChatGPT/Codex 登录态链路。普通 `/v1/*` 请求会被 Airouter 转到对应 Codex 能力链路，并自动处理 Responses 默认值、模型别名和运行态可用性选择；OpenAI token 和 Claude token 不依赖手动切换焦点，只区分可用/不可用。

`apikey` 配置项用于第三方上游。`support` 包含 `gpt` 时参与 `/v1/*` OpenAI 兼容链路，也可作为 `/v1/messages` 的 Responses 转换上游；`support` 包含 `claude` 时参与 `/v1/messages` Claude Messages 原样转发链路。OpenAI/GPT apikey fallback 与 Claude apikey fallback 分别维护活动焦点和 failover，不会互相覆盖。

`/cpa/v1/*` 是 CLIProxyAPI 风格前缀入口，内部会剥离 `/cpa` 后复用同一套 `/v1/*` 鉴权、调度和模型别名逻辑；仅该前缀会启用 CLIProxyAPI 风格的额外请求体规范化。

业务接口的 failover 只作用于客户端转发链路，包括 Responses、Messages、Images 和普通 `/v1/*` 代理；`/admin/*`、`/health`、quota 轮询、token refresh 和 apikey 恢复探测不走这套逻辑。上游 `apikey` 在响应提交给客户端前出现非 200 HTTP 状态、请求失败或响应体中断时，Airouter 会先在本次请求内排除当前配置并尝试切到下一个可用配置；如果没有可切换配置，才按当前上游错误返回给客户端。响应已经开始写给客户端后不再透明切换，也不会因为后续传输中断把本次请求记为失败。`apikey` 是否被临时标记为不可用仍由统计窗口决定：最近 30 分钟内最多 10 个已完成真实请求中累计 3 次失败后才会标记不可用。

## GET /health

用于检查本地服务是否存活，以及当前活动账号摘要。

示例：

```bash
curl -sS http://localhost:3009/health \
  -H "Authorization: Bearer sk-airouter-xxxx"
```

响应示例：

```json
{
  "status": "ok",
  "mode": "openai",
  "timestamp": "2026/5/26 18:30:00",
  "active_account": {
    "index": 0,
    "description": "account@example.com"
  },
  "configs": {
    "total": 2,
    "default": "account@example.com"
  },
  "concurrency": {
    "inFlight": 3,
    "maxInFlight": 32,
    "queued": 1,
    "maxQueueSize": 64
  }
}
```

`concurrency` 用于观察业务入口的当前处理数和排队数；健康检查本身不占用业务并发槽位。

## POST /v1/responses

OpenAI Responses 兼容入口。请求体使用 JSON。

示例：

```bash
curl -sS http://localhost:3009/v1/responses \
  -H "Authorization: Bearer sk-airouter-xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "input": "用一句话介绍 Airouter"
  }'
```

常用字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名。会先经过 `responses.model_aliases` 映射 |
| `input` | string 或 array | 用户输入，格式兼容 Responses API |
| `instructions` | string | 可选，系统指令 |
| `tools` | array | 可选，工具列表 |
| `tool_choice` | string 或 object | 可选，默认 `auto` |
| `stream` | boolean | 可选，Airouter 默认补 `true` |
| `store` | boolean | 可选，token 模式下会强制为 `false` |

Airouter 会给 `/v1/responses` 补这些默认值：

```json
{
  "instructions": "",
  "tools": [],
  "tool_choice": "auto",
  "parallel_tool_calls": false,
  "store": false,
  "stream": true,
  "include": []
}
```

当普通 `/v1/responses` 请求走 token/Codex 兼容链路时，Airouter 会保留 Responses 请求形状，包含 `instructions`、`input` 中的 `system` role、`top_p`、`service_tier` 和工具名等字段；仅会移除历史兼容所需的 `max_output_tokens`、`temperature`，并在 token 模式下强制 `store: false`。function tool 的 JSON Schema 会被规范化为 Codex 可接受的 schema 形状，包括给嵌套字段补齐缺失的 `type`，并把 object schema 的 `additionalProperties` 固定为 `false`。

当使用 `/cpa/v1/responses` 时，会额外启用 CLIProxyAPI 风格规范化：原始 `instructions` 会转成 `input` 开头的 `developer` message，同时保留空字符串 `instructions` 字段；`input` 中的 `system` role 也会转成 `developer`。同时会移除当前 CPA/Codex 链路不支持的 `max_output_tokens`、`max_completion_tokens`、`temperature`、`top_p`、`truncation`、`context_management`、`user` 等字段，并把旧的 `web_search_preview` 工具名规范为 `web_search`。

如果配置了 `responses.model_aliases`，`model` 会按大小写不敏感规则替换。例如配置：

```json
{
  "responses": {
    "model_aliases": {
      "gpt-5.2": "gpt-5.5"
    }
  }
}
```

请求里的 `"model": "GPT-5.2"` 会被转成 `"gpt-5.5"`。

## POST /v1/messages

Claude Messages 兼容入口。请求体使用 JSON。

Airouter 会先使用可用的 `claude_token` 原样转发 Claude Messages 请求；没有可用 Claude token 时，才使用 `support` 包含 `claude` 的 `apikey` 原样转发。`claude_token` 用于 Claude Code OAuth 登录态：请求 Authorization 命中 `local_auth_token`、同一配置里的真实 `access_token`，或命中 `request_auth_token_sha256s` 哈希列表时，会绑定到该配置并替换为真实 Claude OAuth Bearer token 转发。共享 Claude Code 登录态时，客户端可用 `npm run claude:install-login -- --token <local_auth_token> --base-url <Airouter 地址>` 把 `local_auth_token` 写入 Claude Code 本地凭证，并补齐交互模式依赖的全局 onboarding 状态，使交互模式主请求也使用这枚本地 token；启动 Claude Code 的 shell 里不要残留 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `CLAUDE_CODE_OAUTH_TOKEN`，否则这些环境变量会覆盖本地登录态。没有可用 Claude 直转上游时，Airouter 会把 Claude Messages 请求转换为 Responses 请求：优先使用 OpenAI token 配置项；OpenAI token 不可用时，使用 `support` 包含 `gpt` 的 `apikey` 配置项并请求 `${base_url}/responses`。

`/cpa/v1/messages` 是同一入口的 CLIProxyAPI 风格前缀别名，调度行为与 `/v1/messages` 一致，但转换到 Responses 时会启用 CPA 风格请求体规范化。

示例：

```bash
curl -sS http://localhost:3009/v1/messages \
  -H "Authorization: Bearer sk-airouter-xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-5",
    "max_tokens": 512,
    "messages": [
      {
        "role": "user",
        "content": "用一句话介绍 Airouter"
      }
    ]
  }'
```

常用字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | Claude Messages 模型名。原样转发时由上游决定；转换链路固定请求 `gpt-5.5` |
| `max_tokens` | number | 最大输出 token。转换链路当前不向 Responses 传递该字段 |
| `system` | string 或 array | 可选，系统提示词 |
| `messages` | array | Claude Messages 消息列表 |
| `tools` | array | 可选，Claude 工具定义 |
| `tool_choice` | string 或 object | 可选，工具选择策略 |
| `stream` | boolean | 可选，是否流式返回 |

转换链路固定请求模型为 `gpt-5.5`，推理强度可通过配置调整：

```json
{
  "claude_code": {
    "reasoning_effort": "high"
  }
}
```

`/v1/messages` 的 Responses 转换链路固定请求模型为 `gpt-5.5`，`claude_code.model` 不再影响该链路。`claude_code.reasoning_effort` 只影响转换链路，不影响普通 `/v1/responses`，也不影响 `support` 包含 `claude` 的 apikey 原样转发链路。

普通 `/v1/messages` 的 Responses 转换链路会把 Claude `system` 字段放入 Responses `instructions`，`messages` 按原角色转换为 `input`，并保持 `parallel_tool_calls: false` 和 `include: []`。

`/cpa/v1/messages` 的 Responses 转换链路会按 CLIProxyAPI 风格把 Claude `system` 字段和 `messages[].role = "system"` 转成 Responses `input` 里的 `developer` message，并过滤 Claude Code 的 `x-anthropic-billing-header:` attribution 文本；原始系统提示不会作为 Responses `instructions` 发送，只保留空字符串 `instructions` 字段。

## POST /v1/images/generations

OpenAI Images 图片生成兼容入口。请求体使用 JSON。

示例：

```bash
curl -sS http://localhost:3009/v1/images/generations \
  -H "Authorization: Bearer sk-airouter-xxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image-2",
    "prompt": "A clean product-style photo of a small white ceramic mug on a desk.",
    "size": "1024x1024",
    "quality": "medium",
    "output_format": "png"
  }' \
  -o image-generation-response.json
```

常用字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 图片生成提示词 |
| `model` | string | 否 | OpenAI Images 兼容字段。token 模式下不会直接作为上游 Responses 模型使用 |
| `n` | number | 否 | token 模式下只支持 `1` |
| `output_format` | string | 否 | token 模式下支持 `png`、`jpeg`、`webp`，默认 `png` |
| `size` | string | 否 | apikey 模式由上游决定；token 模式当前仅作为兼容字段接收 |
| `quality` | string | 否 | apikey 模式由上游决定；token 模式当前仅作为兼容字段接收 |

token 模式下，Airouter 会通过 Codex Responses 的 `image_generation` 工具生成图片，并返回 OpenAI Images 风格 JSON。token Responses 上游在响应提交给客户端前返回非 200 或请求失败时，会排除当前配置并尝试下一个可用配置；apikey 模式继续原生转发到上游 Images API：

```json
{
  "created": 1779778600,
  "data": [
    {
      "b64_json": "...",
      "revised_prompt": "..."
    }
  ]
}
```

apikey 模式下，请求会直连上游 Images API，支持字段和返回格式由上游决定。

### 图片模型速度实测

下面是 2026-05-26 18:36 左右在本机 `http://127.0.0.1:3009` 上的单次生成测速。测试请求都使用同一条小 prompt、`output_format=png`，并校验返回里存在 `data[0].b64_json`。

当前测试环境是 token 模式。token 模式下，`model` 字段用于兼容 OpenAI Images 客户端；Airouter 实际会转成 Codex Responses + `image_generation` 工具调用，真正发给上游的 Responses 模型由 `AIROUTER_IMAGE_GENERATION_RESPONSES_MODEL` 控制。因此这张表只能代表当前 Airouter token 兼容路径的端到端耗时，不代表第三方 apikey 上游原生 Images API 的模型速度。

| 请求里的图片模型 | HTTP 状态 | 单次耗时 | 返回图片数 | 备注 |
| --- | --- | ---: | ---: | --- |
| `gpt-image-2` | `200` | `16.14s` | `1` | 当前默认值 |
| `gpt-image-1.5` | `200` | `17.32s` | `1` | 兼容旧客户端传参 |
| `gpt-image-1` | `200` | `18.28s` | `1` | 兼容旧客户端传参 |
| `gpt-image-1-mini` | `200` | `21.04s` | `1` | 兼容旧客户端传参 |

复杂任务的耗时差异会明显放大。下面是同一环境下追加的一组单次复杂任务实测：

- 复杂生成：同一条写实猫咪花园场景 prompt，包含自然光、毛发、胡须、眼睛、叶脉、石材纹理、景深、曝光平衡等细节要求。
- 复杂编辑：同一张猫图作为输入，要求保留猫、姿势、构图和花园环境，同时改善曝光、暗部细节、色偏、毛发锐度和噪点。

| 请求里的图片模型 | 复杂生成耗时 | 复杂编辑耗时 | 结果 |
| --- | ---: | ---: | --- |
| `gpt-image-2` | `300.05s` | `49.25s` | 生成超时；编辑成功 |
| `gpt-image-1.5` | `139.63s` | `47.75s` | 生成成功；编辑成功 |
| `gpt-image-1` | `84.67s` | `300.07s` | 生成成功；编辑超时 |
| `gpt-image-1-mini` | `68.73s` | `300.04s` | 生成成功；编辑超时 |

这里的 `300s` 左右表示 Airouter 等上游返回时达到服务端请求超时边界，返回 HTTP 500 `request timeout after 300000ms`。这些数据是单次样本，受账号状态、上游排队、图片尺寸、prompt 复杂度和网络状态影响很大，只适合作为当前链路的粗略参考。

后续默认上游总 deadline 已经按官方 SDK 默认请求窗口调整为 `600000ms`（10 分钟）。优先使用 `UPSTREAM_TOTAL_TIMEOUT_MS` 覆盖；旧变量 `UPSTREAM_REQUEST_TIMEOUT_MS` 在未设置新变量时继续兼容。failover 和 redirect 共享同一个总 deadline，不会为每次尝试重新计算 10 分钟。连接、流式首响应和流式空闲另有更短的分阶段超时，详见 [并发、背压与超时](performance-and-timeouts.md)。两个图片测试脚本的客户端默认 timeout 是 `660s`，比服务端多 60 秒，方便服务端先返回上游结果或明确的超时错误。上表中的 `300s` 超时结果保留为调大超时前的实测记录。

## POST /v1/images/edits

OpenAI Images 图片编辑兼容入口。请求体使用 `multipart/form-data`。

示例：

```bash
curl -sS http://localhost:3009/v1/images/edits \
  -H "Authorization: Bearer sk-airouter-xxxx" \
  -F "model=gpt-image-2" \
  -F "prompt=Add a small red hat to the subject. Keep the original style and composition." \
  -F "image=@/absolute/path/to/input.png" \
  -F "size=1024x1024" \
  -F "quality=medium" \
  -F "output_format=png" \
  -o image-edit-response.json
```

常用字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 是 | 图片编辑提示词 |
| `image` | file | 是 | 输入图片。token 模式支持一个或多个同名 `image` 文件 |
| `model` | string | 否 | OpenAI Images 兼容字段。token 模式下不会直接作为上游 Responses 模型使用 |
| `n` | number | 否 | token 模式下只支持 `1` |
| `output_format` | string | 否 | token 模式下支持 `png`、`jpeg`、`webp`，默认 `png` |
| `size` | string | 否 | apikey 模式由上游决定；token 模式当前仅作为兼容字段接收 |
| `quality` | string | 否 | apikey 模式由上游决定；token 模式当前仅作为兼容字段接收 |
| `mask` | file | 否 | apikey 模式由上游决定；token 模式当前不处理 mask |

token 模式下返回格式与 `/v1/images/generations` 一致：

```json
{
  "created": 1779778600,
  "data": [
    {
      "b64_json": "...",
      "revised_prompt": "..."
    }
  ]
}
```

保存图片示例：

```bash
python3 - <<'PY'
import base64
import json
from pathlib import Path

data = json.loads(Path("image-edit-response.json").read_text())
Path("edited.png").write_bytes(base64.b64decode(data["data"][0]["b64_json"]))
PY
```

## 其它 /v1/* OpenAI 兼容接口

除上面单独处理的接口外，Airouter 会把其它 `/v1/*` 请求作为 OpenAI 兼容接口透传，例如：

```text
/v1/models
/v1/chat/completions
/v1/embeddings
```

示例：

```bash
curl -sS http://localhost:3009/v1/models \
  -H "Authorization: Bearer sk-airouter-xxxx"
```

对这些接口：

- token 配置项会走 Airouter 的 Codex 兼容链路；具体路径是否可用由当前账号对应的上游能力决定。
- apikey 配置项会直连配置里的 `base_url`；具体路径是否可用由第三方上游决定。
- 路径命中 `/responses` 时会应用 Responses 默认值、模型别名和必要的 Codex 兼容规范化；只有 `/cpa/v1/*` 前缀会启用 CPA 风格转换。其它路径一般保持请求体原样。

## 状态码和错误格式

Airouter 自己产生的错误通常是 JSON：

```json
{
  "error": "请求体处理失败",
  "details": "prompt 必须是非空字符串"
}
```

常见状态码：

| 状态码 | 场景 |
| --- | --- |
| `400` | 请求体格式错误、必填字段缺失、当前兼容路径不支持的参数 |
| `408` | 客户端上传请求体时长时间没有新数据 |
| `401` | 配置了入口 `apikeys`，但请求没有提供有效入口密钥 |
| `413` | JSON、普通代理或图片编辑请求体超过配置上限 |
| `404` | 路径不存在 |
| `405` | 接口不支持该 HTTP 方法 |
| `415` | `/v1/messages` 没有使用 `application/json` |
| `502` | 没有可用配置项，或上游请求失败 |
| `503` | 全局并发队列已满或排队超时；响应携带 `Retry-After: 1` |
| `504` | 上游请求超时 |

上游直接返回的错误会尽量保持原状态码、响应头和响应体。
