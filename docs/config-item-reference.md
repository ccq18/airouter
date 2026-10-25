# config.json 配置契约

## 1. 文件与加载

默认配置为项目目录下的 `config.json`，不读取或迁移 `openai.json`。直接运行服务时可用 `CONFIG` 指定绝对路径。管理接口保存会原子写入并热加载；手工编辑文件或登录脚本写入后需要重启。

账号容器仍命名为 `configs`，它保存本设计的统一上游账号，不代表旧管理接口。只有统一路由，没有模式开关。顶层 `type`、`disabled_configs`、`responses`、`claude_code`，以及 `routing.mode` 均被拒绝；账号的 `support`、`health` 和旧字段别名也不接受。

## 2. 完整示例

以下 JSON 可被程序加载，但凭证是占位值，实际调用前必须替换。客户端 ID `my-model` 优先访问 GLM，之后才尝试 Go；名称可自行修改。

```json
{
  "port": 3009,
  "auth_token": "admin-example-replace-me",
  "apikeys": ["sk-airouter-example-replace-me"],
  "configs": [
    {
      "id": "glm-primary",
      "type": "apikey",
      "preset": "glm-cn",
      "description": "GLM 主账号",
      "enabled": true,
      "base_url": "https://open.bigmodel.cn/api/coding/paas/v4",
      "apikey": "sk-example-glm-replace-me",
      "models": [{ "id": "glm-5.3", "protocols": ["chat_completions"] }]
    },
    {
      "id": "go-backup",
      "type": "apikey",
      "preset": "opencode-go",
      "description": "Go 备用账号",
      "enabled": true,
      "base_url": "https://opencode.ai/inference/go",
      "apikey": "sk-example-go-replace-me",
      "models": [{ "id": "deepseek-v4.1-flash", "protocols": ["chat_completions"] }]
    }
  ],
  "routing": {
    "max_attempts": 3,
    "models": [
      {
        "id": "my-model",
        "enabled": true,
        "entry_protocols": ["chat_completions", "responses", "messages"],
        "targets": [
          { "id": "primary", "config_id": "glm-primary", "model": "glm-5.3", "protocol": "chat_completions" },
          { "id": "backup", "config_id": "go-backup", "model": "deepseek-v4.1-flash", "protocol": "chat_completions" }
        ]
      }
    ]
  }
}
```

空白模板 `config.json.example` 的账号和路由数组均为空；没有路由时，业务请求返回模型未配置，不自动选择账号。

## 3. 顶层字段

| 字段 | 类型与默认值 | 规则 |
| --- | --- | --- |
| `configs` | 必填数组 | 统一上游账号；可以为空 |
| `routing` | 对象，缺省为空路由 | 包含 `models`、可选 `max_attempts` |
| `port` | 端口，默认 3009 | 1–65535；支持整数或数字字符串 |
| `proxy_port` | 可选端口 | 本机 HTTP 代理端口，未配置时沿用进程代理环境 |
| `auth_token` | 字符串 | 管理凭证；缺少或为空时生成并写回 |
| `apikeys` | 字符串数组 | 入口密钥；缺少时生成一枚，明确写 `[]` 则关闭入口校验 |

## 4. 上游账号

| 字段 | 说明 |
| --- | --- |
| `id` | 稳定且唯一的账号 ID；缺少时服务生成并持久化 |
| `type` | 必须为 `apikey`、`token` 或 `claude_token`，不再默认当作 Token |
| `preset` | 平台：`chatgpt`、`claude`、`opencode-go`、`opencode-zen`、`openrouter`、`glm-cn`、`glm-global`、`custom`、`opencode-free`、`openrouter-free` |
| `description` | 管理页名称 |
| `enabled` | 布尔值，缺省为 true；停用使用此字段，不另设停用账号数组 |
| `base_url` | 上游地址；管理台新增时按平台填入默认值 |
| `models` | 支持的后端模型数组；空数组不能作为路由候选 |
| `models_endpoint` | 仅自定义平台填写的目录路径或 HTTP(S) 地址 |
| `protocol_paths` | 可选协议路径覆盖，键为协议名，值为路径或 null |
| `quota_url` | 可选额度地址覆盖，仍使用该平台的额度解析器；日常表单不显示 |

API Key 账号使用 `apikey`。ChatGPT 登录态使用 `access_token`、`account_id` 和可选 `refresh_token`；Sub2API 使用 `type: "token"`、`subtype: "sub2api"` 与其导出的 `credentials`，推荐通过导入入口生成。Claude OAuth 使用 `access_token`、可选 `refresh_token`、到期时间及账号信息，由登录脚本写入。

每个模型需要非空 `id`，并可配置 `protocols`。协议仅支持 `chat_completions`、`responses`、`messages`；缺少时按平台默认值规范化。可选 `capabilities` 为布尔值映射，`context_window`、`max_output_tokens` 为正整数。模型清单只约束候选，不自动对客户端公开。

## 5. 模型路由

| 字段 | 规则 |
| --- | --- |
| `routing.models[].id` | 客户端模型 ID，非空、区分大小写、无首尾空格、最长 200 字符，不能重复 |
| `enabled` | 缺省 true；停用路由不公开、不接受调用 |
| `entry_protocols` | 允许的入口协议，缺省为三种对话协议；不能是空数组 |
| `targets` | 至少一个候选，数组顺序就是优先级 |
| `targets[].id` | 路由内唯一、稳定；缺省时生成，排序保留原 ID |
| `targets[].config_id` | 引用已存在账号 ID |
| `targets[].model` | 必须存在于该账号模型列表 |
| `targets[].protocol` | 必须在该模型支持协议中 |
| `routing.max_attempts` | 正整数，默认 3；实际尝试不超过候选数量 |
| 路由 `max_attempts` | 可覆盖顶层尝试次数，仍受候选数量限制 |

同一账号、模型和协议组合不能在一条路由中重复。删除账号或修改被引用的模型/协议前，先调整关联路由。具体失败切换、额度恢复、上下文归属和不支持的能力见[统一设计](unified-model-routing-design.md)。

## 6. 运行环境变量

| 变量 | 当前行为 |
| --- | --- |
| `CONFIG` | 服务配置路径，默认 `config.json`；部署时建议绝对路径 |
| `AIROUTER_BIND_HOST` | 监听地址，部署反向代理时可设为 `127.0.0.1` |
| `PORT` | 未配置 `port` 时的端口候选 |
| `QUOTA_CHECK_TIMEOUT_MS` | 额度请求超时，默认 10000 ms |
| `UPSTREAM_TOTAL_TIMEOUT_MS` | 单次上游请求超时，默认 600000 ms |
| `JSON_REQUEST_BODY_LIMIT_BYTES` | 对话 JSON 请求体上限，默认 16 MiB |
| `REQUEST_BODY_IDLE_TIMEOUT_MS` | 接收客户端请求体的空闲超时，默认 30000 ms |

不在配置或日志里记录真实凭证示例。HTTP 操作的请求字段与状态码见 [API 参考](api-reference.md)。

## 6. 免费模型池

`opencode-free` / `openrouter-free` 是普通上游，固定提供 `free / chat_completions`。其他入口通过现有桥接；任意客户端路由均可引用，不对 `auto` 写特殊逻辑。

```json
{
  "id": "go-free",
  "type": "apikey",
  "preset": "opencode-free",
  "credential_ref": "go-backup",
  "models": [{ "id": "free", "protocols": ["chat_completions"] }],
  "pool": {
    "sync_interval_seconds": 900,
    "max_stale_seconds": 3600,
    "max_attempts": 8,
    "strategy": "quality_first",
    "tiers": { "example-model": 1 }
  }
}
```

`credential_ref` 复用同平台普通 API Key 账号，不复制秘密；也可省略引用而填写独立 `apikey`。不允许池互相引用、跨平台引用或同时填写两种凭证。引用账号停用时池停用；引用账号付费额度耗尽时不门控免费池。更换凭证、来源或地址会使旧目录与健康身份失效。OpenCode 按引用账号的 Go/Zen 类型选择内置地址；独立 Key 默认 Go。Zen 免费接口有客户端限制，不能通过伪装客户端绕过。

| 高级字段 | 默认及约束 |
| --- | --- |
| `sync_interval_seconds` | 900；60–86400 秒 |
| `max_stale_seconds` | 3600；60–86400 秒，且不短于同步周期；超过后缓存只展示、不调用 |
| `max_attempts` | 8；每个请求在该池最多尝试 1–32 个具体模型 |
| `strategy` | `quality_first` 分级优先，同档结合成功率/延迟；`fastest` 忽略分级，以近期可靠性与延迟排序 |
| `tiers` | 模型 ID 到整数 1–10 的映射；数字越小优先级越高；未配置默认第 5 档，明确为未评级 |

池不接受 `models_endpoint`、`protocol_paths`、`quota_url` 覆盖，模型列表固定且不可编辑。内部目录是运行缓存，原子保存在配置旁的 `config.json.pools-cache.json`，不含密钥、提示词或返回内容；不进入 Git。重启恢复仅接受身份匹配且价格资格尚未过期的缓存。近期统计在内存保留近 24 小时最多 32 次记录，重启后重新积累。

路由 `max_attempts` 仍限制外层候选次数；池占其中一个名额，内部受 `pool.max_attempts` 独立限制。`auto` 可配置 DeepSeek → GLM → Go 免费池/free → OpenRouter 免费池/free，并设外层尝试上限至少 4；同样规则适用于其他客户端 ID。
