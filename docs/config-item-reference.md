# 配置项字段说明
- token
```
{
  "type":"token",
  "proxy_port":7890,
  "port":3000,
  "claude_code": {
    "model": "gpt-5.4",
    "reasoning_effort": "high"
  },
  "configs":[
      {
        "access_token": "",
        "account_id": "",
        "description": ""
      }
    ]
}

```
- access_token 和 account_id 获取  
  登录gpt plus后打开：https://chatgpt.com/api/auth/session
  取以下值配置上去，有效时间是3个月
  ![session_json.png](docs/img/session_json.png)

!注意不要退出登录,退出登录token就失效了
- proxy_port 填本地的代理端口
- port 填服务监听端口，不填时默认 `3000`
- `claude_code.model` 用来强制覆盖 Claude Code 走 `/claude/v1/messages` 时上游实际使用的模型
- `claude_code.reasoning_effort` 用来强制覆盖 Claude Code 走 `/claude/v1/messages` 时的推理强度，默认 `high`
- 以上 `claude_code` 配置只作用于 `/claude/v1/messages`，不会影响普通 `/v1/*` OpenAI 兼容接口


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

## api_key 模式

`type` 为 `api_key` 时，`configs` 里的每一项格式如下：

```json
{
  "api_key": "<api key>",
  "base_url": "https://api.openai.com/v1",
  "description": "primary key"
}
```

字段说明：

- `api_key`
  - 上游兼容接口使用的 API Key
- `base_url`
  - 上游兼容接口根地址
  - 例如 `https://api.openai.com/v1`
- `description`
  - 本地展示用的描述文本

## 安全说明

- `access_token`、`api_key` 都属于敏感信息
- 不要把完整 AuthSession JSON、`openai.json`、日志里的敏感字段发给别人
- 退出 ChatGPT 登录后，`token` 模式下的 `access_token` 可能失效
