# 配置项字段说明

顶层 `type` 已废弃，即使存在也会被忽略；配置类型写在 `configs[]` 的每个配置项里。未写 `type` 的配置项默认是 `token`。

## 基础结构

```
{
  "apikeys": [],
  "auth_token": "",
  "port":3009,
  "claude_code": {
    "model": "gpt-5.5",
    "reasoning_effort": "high"
  },
  "responses": {
    "model_aliases": {
      "gpt-5.2": "gpt-5.5"
    }
  },
  "configs":[
      {
        "access_token": "",
        "account_id": "",
        "description": ""
      },
      {
        "type": "apikey",
        "base_url": "https://api.example.com/v1",
        "apikey": "sk-xxx",
        "support": ["gpt"],
        "health": {
          "model": "gpt-4.1-mini"
        },
        "description": "third-party provider"
      }
    ],
  "disabled_configs": []
}

```

## token 配置项

未写 `type` 或 `type` 为 `token` 时，配置项格式如下：

```json
{
  "access_token": "",
  "account_id": "",
  "description": ""
}
```

- access_token 和 account_id 获取  
  登录gpt plus后打开：https://chatgpt.com/api/auth/session
  取以下值配置上去，有效时间是3个月
  ![session_json.png](docs/img/session_json.png)

!注意不要退出登录,退出登录token就失效了
- `proxy_port` 为可选项；只有在需要通过本地代理访问上游时才填写本地代理端口，例如 `7890`
- `port` 填服务监听端口，不填时默认 `3009`
- `apikeys` 为入口请求校验密钥数组，支持 `Authorization: Bearer <apikey>` 或 `x-api-key`
- `apikeys` 为空时，不校验入口请求；只要数组非空，请求就必须命中其中一个 key
- `auth_token` 为管理后台访问令牌；配置页必须通过 `.../admin/configs?auth_token=<token>` 访问
- `auth_token` 为空或缺失时，服务启动后会自动生成并写回配置文件
- `configs` 是启用配置列表，只有这里的配置会进入运行时请求调度、额度刷新和 fallback
- `disabled_configs` 是停用配置列表。管理页点“停用”会把配置从 `configs` 移到这里；停用配置对服务不可见，后续请求不会读取它。管理页点“启用”会把它移回 `configs`
- `disabled_configs[]` 中的配置项会额外记录 `disabled_status` 文本字段，用来保存停用瞬间的运行态摘要，例如 `可用=否 | 额度=99% | ...`；启用回 `configs[]` 时会移除该字段
- 管理页“删除”仍是永久删除；停用不是删除，只是从服务可见列表中移出
- `/v1/messages` Responses 兼容转换链路固定请求模型为 `gpt-5.5`，`claude_code.model` 会保留在配置中但不再影响该链路
- `claude_code.reasoning_effort` 用来强制覆盖 Claude Code 走 `/v1/messages` Responses 兼容转换链路时的推理强度，默认 `high`，支持枚举：`none`、`minimal`、`low`、`medium`、`high`、`xhigh`
- `claude_code.reasoning_effort` 只作用于 `/v1/messages` 的 Responses 兼容转换链路，不会影响普通 `/v1/*` OpenAI 兼容接口，也不会影响 `support` 包含 `claude` 的 `apikey` 原样转发链路
- `responses.model_aliases` 用来给 `/v1/responses` 请求里的 `model` 做别名替换，键和值都必须是非空字符串
- `responses.model_aliases` 的键比较时忽略大小写，例如配置 `GPT-5.2` 也会匹配请求里的 `gpt-5.2`
- 默认示例配置里包含 `gpt-5.2 -> gpt-5.5`
- 原因：当前 Codex API 的配置形式暂不直接支持 `gpt-5.5`，所以默认把 `gpt-5.2` 映射成 `gpt-5.5`，方便继续沿用现有配置写法
- `/v1/messages` 优先使用 `support` 包含 `claude` 的 `apikey` 原样转发；没有可用 Claude apikey 时优先使用 `token` 配置项走 responses 兼容转换，token 不可用时可使用 `support` 包含 `gpt` 的 `apikey` 配置项请求 `${base_url}/responses`
- `/cpa/v1/*` 是 CLIProxyAPI 风格前缀入口，内部剥离 `/cpa` 后复用 `/v1/*` 链路；普通 `/v1/messages` 转换会把 Claude `system` 放入 Responses `instructions`，只有 `/cpa/v1/messages` 会把 Claude `system` 转成 `developer` input 并保留空字符串 `instructions`
- 每分钟额度轮询会检查所有 `token` 配置项
- `apikey` 直连上游会记录最近 30 分钟内最多 10 个已完成真实请求，401/403、429、5xx、请求失败或响应体中断累计达到 3 次时，会被临时标记为不可用并尝试切换
- 每 10 分钟全量校正会额外尝试恢复已被标记为不可用的 `support` 包含 `gpt` 的 `apikey` 配置项；恢复探测默认使用 `gpt-5.5`，可通过该配置项的 `health.model` 覆盖
- token 请求调度：有会话 key 时使用 HRW/Rendezvous 一致性哈希，尽量把相同会话固定到同一 token 账号；token 账号不可用或本次 failover 排除后会在剩余账号中按同一会话 key 重新选择
- 会话 key 来源包括 `x-airouter-session-id`、`session-id`、`session_id`、`x-client-request-id`，以及 URL/JSON body 顶层的 `session_id`、`conversation_id`、`thread_id`、`previous_response_id`
- 没有会话 key 时，token 请求按当前内存 `inFlight` 数做轻量分摊
- `apikey` 配置项不参与 token 并发调度、一致性哈希或 `inFlight` 计数
- 管理页切换到 token 时，会把该 token 设为并发池锚点；切换到 `apikey` 时，会进入该 `apikey` 支持流量的覆盖模式
- 管理页“调度模式”和 token 行会显示当前/最近命中的会话短 hash，用于观察实际调度账号；原始会话 ID 不会持久化或返回页面
- 管理页账号行会显示最近一次响应模型观测，包括请求模型和上游响应模型
- 手动切换到 `apikey` 配置项时，会把该 `apikey` 的运行态恢复为可用


- 原始配置项字段说明
![session_json.png](docs/img/session_json.png)
字段说明：

- `access_token`
  - 实际发给上游 ChatGPT 的 Bearer Token
  - 来源：AuthSession JSON 里的 `accessToken`
- `account_id`
  - 当前 ChatGPT 账号 / workspace 的账号 ID
  - 来源：AuthSession JSON 里的 `account.id`
- `description`
  - 本地展示用的描述文本，用于日志、管理页表格、账号切换提示
  - 推荐直接使用邮箱，方便区分账号
  - 默认来源：AuthSession JSON 里的 `user.email`

## 管理页导入规则

管理页支持直接粘贴完整 AuthSession JSON。导入时会自动提取并转换为上面的最小配置项：

- `description <- user.email`
- `account_id <- account.id`
- `access_token <- accessToken`

也支持直接粘贴已经整理好的最小配置项 JSON。

## apikey 配置项

`type` 为 `apikey` 时，配置项格式如下：

```json
{
  "type": "apikey",
  "base_url": "https://api.openai.com/v1",
  "apikey": "sk-xxx",
  "support": ["gpt"],
  "health": {
    "model": "gpt-4.1-mini"
  },
  "description": "primary key"
}
```

字段说明：

- `type`
  - 固定为 `apikey`
- `apikey`
  - 上游兼容接口使用的 API Key
- `base_url`
  - 上游兼容接口根地址
  - 不要求是 Codex 或 ChatGPT 地址；任意提供 OpenAI 兼容 `/v1/*` 接口的第三方服务都可以配置在这里
  - 例如 `https://api.openai.com/v1` 或 `https://api.example.com/v1`
- `support`
  - 可选，字符串数组，只支持 `gpt` 和 `claude`
  - 不填写时默认是 `["gpt"]`
  - 包含 `gpt` 时参与 `/v1/*` OpenAI 兼容链路，包括 `/v1/responses`，也可作为 `/v1/messages` 的 Responses 转换上游
  - 包含 `claude` 时参与 `/v1/messages` Claude Messages 原样转发链路
- `health`
  - 可选对象，目前只支持 `model`
  - 只影响已不可用 GPT apikey 的 10 分钟恢复探测请求
  - 未配置时恢复探测默认发送 `model: "gpt-5.5"`、`input: "hello"`、`stream: false`
  - 如果第三方上游不支持 `gpt-5.5`，可以配置为上游可用的轻量模型，例如 `"health": {"model": "gpt-4.1-mini"}`
- `description`
  - 本地展示用的描述文本
- `apikey` 配置项不参与 Codex quota 轮询
- `apikey` 配置项在直连上游最近 30 分钟内最多 10 个已完成真实请求中累计 3 次 401/403、429、5xx、请求失败或响应体中断时，会被临时标记为不可用；普通 `/v1/*` 链路会尝试切到下一个可用配置，未达到阈值前会透传上游原响应
- 已被标记为不可用且 `support` 包含 `gpt` 的 `apikey` 配置项，会在每 10 分钟全量校正中用 `/v1/responses` 的 `hello` 请求探测；上游返回 2xx 时恢复为可用
- 只支持 `claude` 的 `apikey` 不参与 `/v1/responses` 或普通 `/v1/*` OpenAI 兼容链路
- 同时支持两条链路时可以配置 `"support": ["gpt", "claude"]`

## Claude Messages apikey 示例

需要把 `/v1/messages` 原样转发到第三方 Claude Messages API 时，仍然使用 `type: "apikey"`，并配置 `support: ["claude"]`：

```json
{
  "type": "apikey",
  "base_url": "https://claude.example.com/v1",
  "apikey": "sk-xxx",
  "support": ["claude"],
  "description": "claude messages provider"
}
```

`/v1/messages` 请求会转发到 `${base_url}/messages`，不做模型转换。示例中 `support` 只有 `claude`，所以它不会参与 `/v1/responses` 或普通 `/v1/*` OpenAI 兼容链路。

## 安全说明

- `access_token`、`apikey` 都属于敏感信息
- 顶层 `apikeys`、`auth_token` 也属于敏感信息
- 不要把完整 AuthSession JSON、`openai.json`、日志里的敏感字段发给别人
- 退出 ChatGPT 登录后，`token` 模式下的 `access_token` 可能失效
