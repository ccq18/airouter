# Airouter

Airouter 是一个本地 API 转发服务。

你可以把 ChatGPT/Codex 登录态、OpenAI 兼容 API、Claude Messages 兼容 API 放进 Airouter，然后让 Codex、Claude Code、cc-switch 等工具统一访问一个本地地址：

```text
http://localhost:3009/v1
```

Airouter 会在本机转发请求，并在账号不可用时自动切换到其他可用账号。

## 安装和启动

在项目目录里安装依赖并启动服务：

```bash
npm install
npm start
```

服务会在本机启动，默认端口是 `3009`。管理页面地址会写入日志，可以用下面的命令查看：

```bash
npm run logs
```

## 第一次使用

第一次启动时，如果项目目录里还没有 `openai.json`，命令行会进入配置引导：

1. 服务端口：默认 `3009`，一般不用改。
2. 本地代理端口：如果你访问 ChatGPT 需要代理，常见填 `7890`；不需要可以留空。
3. 入口 apikey：可选。开启后，客户端访问 Airouter 时需要带这个 apikey。

完成后访问日志里显示的管理页面。
![cc-switch Codex 配置](docs/img/img.png)

## 添加账号

管理页面里主要添加两类账号。

### ChatGPT/Codex 账号

适合使用 ChatGPT/Codex 账号额度。

在管理页打开 `OpenAI token` 页面。打开 `https://chatgpt.com/api/auth/session` 获取 AuthSession JSON，复制完整 JSON，粘贴到 `AuthSession JSON` 文本框，然后点击 `新增 OpenAI token`。

如果你手里的是 OAuth 导出数组，也可以直接粘贴进同一个文本框；系统会自动从每个条目里提取 `access_token`、`chatgpt_account_id`、`refresh_token` 和邮箱备注。

新增 OpenAI token 只追加当前输入并写入配置文件，不会完整校验历史配置；暂时无法构建运行态的新增项会显示为不可用，不会阻塞保存。

注意：

- 请复制完整 JSON，不要只复制 `accessToken`。
- 登录态添加成功后，不要主动退出这个 ChatGPT 登录态，否则 token 可能失效。

### 第三方 API Key

适合接入 OpenAI 兼容接口或 Claude Messages 兼容接口，作为对应 token 主链路不可用后的 fallback。

在管理页打开 `Fallback apikey` 页面，填写：

- `Base URL`：上游地址，通常写到 `/v1`，例如 `https://api.example.com/v1`。
- `API Key`：上游服务提供的 key。
- `支持类型`：
  - `GPT`：支持 OpenAI 兼容接口，也可作为 `/v1/messages` 的 Responses 转换上游。
  - `Claude`：支持 Claude Messages 原样转发接口。
- `可用性测试模型`：用于 GPT fallback 恢复探测，默认 `gpt-5.4-mini`，可选 `gpt-5.4`。

填完后点击 `新增 fallback apikey`。

新增 fallback apikey 只追加当前输入并写入配置文件，不会完整校验历史配置；暂时无法构建运行态的新增项会显示为不可用，不会阻塞保存。

### Claude OAuth 登录态

适合让 Claude Code 以本地 OAuth token 形态访问 Airouter，再由 Airouter 替换为真实 Claude OAuth token 转发到 Anthropic。

运行登录脚本：

```bash
npm run claude:login
```

脚本会启动一个本地 OAuth 回调服务，打印 Claude 授权链接。浏览器授权成功后，它会把一个 `type: "claude_token"` 配置追加到 `openai.json`，并生成一个本地 fake auth token 写入顶层 `apikeys`。如果本机 Claude Code Keychain 里存在同一登录态的交互式 OAuth token，脚本只会把它的 SHA-256 写入 `request_auth_token_sha256s`，不额外保存这枚 token 明文。

Claude Code 使用示例：

```bash
export ANTHROPIC_BASE_URL=http://localhost:3009
export CLAUDE_CODE_OAUTH_TOKEN=<脚本输出的本地 fake auth token>
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
```

`claude_token` 只用于 `/v1/messages` Claude Messages 原样转发链路。Airouter 不改写 Claude Code 请求体，只替换上游 `Authorization`，并保留 Claude Code 发来的 `anthropic-version`、`anthropic-beta`、`x-claude-code-session-id` 等请求头。请求里的本地 fake auth token 命中某个 `local_auth_token` 时会严格绑定到该登录态，不会透明切到其它 Claude 登录态；交互式 Claude Code 主请求如果改用本机 Keychain 中同一登录态的真实 Claude OAuth access token，Airouter 会通过 `request_auth_token_sha256s` 做入站匹配并绑定到这条 `claude_token` 配置。`airouter-oauth-` 前缀的本地 fake token 如果没有绑定到可用 `claude_token`，也不会 fallback 到 OpenAI/GPT 上游。

## 给客户端使用

管理页面会显示代理地址，通常是：

```text
http://localhost:3009/v1
```

常用接口：

```text
http://localhost:3009/v1/responses
http://localhost:3009/v1/images/generations
http://localhost:3009/v1/images/edits
http://localhost:3009/v1/messages
```

完整接口说明见 [API 接口文档](docs/api-reference.md)。

Token 配置下，`/v1/images/generations` 和 `/v1/images/edits` 会通过 Codex Responses 的 `image_generation` 工具兼容输出 OpenAI Images JSON；图片业务请求在响应提交给客户端前遇到 token Responses 错误时，也会排除当前配置并尝试切到下一个可用配置：

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

如果页面里配置了入口 `apikey`，客户端里还要填同一个 `apikey`：

```http
Authorization: Bearer sk-airouter-xxxx
```

如果没有配置入口 apikey，本机请求不会校验 apikey。

## 配合 cc-switch

推荐用 [cc-switch](https://github.com/farion1231/cc-switch) 管理 Codex、Claude Code 等客户端配置。

在 cc-switch 里填写：

```text
Base URL: http://localhost:3009/v1
API Key: 管理页里的入口 apikey，没有配置就留空
```

示例：

![cc-switch Codex 配置](docs/img/ccs_codex.png)

![cc-switch Claude 配置](docs/img/ccs_claude.png)

## 账号顺序和自动切换

Airouter 会对 ChatGPT/Codex token 账号做会话粘性调度。相同 `session_id`、`conversation_id`、`thread_id`、`previous_response_id`，或请求头里的 `x-airouter-session-id` / `x-client-request-id`，会通过 HRW/Rendezvous 一致性哈希尽量固定到同一个可用 token 账号。

你可以：

- 用 `置顶`、`上移`、`下移` 调整优先级。
- 在 OpenAI token 行用 `设为 OpenAI 焦点` 调整 Responses 主链路的调度焦点。
- 在 Claude token 行用 `设为 Claude 焦点` 调整 `/v1/messages` 原样转发主链路的调度焦点。
- 在 apikey 行用 `设为兜底焦点` 调整 fallback 优先级；apikey 仍只在对应 token 链路不可用时兜底。
- 用 `停用` 将账号移入停用列表。停用账号对服务不可见，后续请求、额度刷新和 fallback 都不会读取它，但可以在管理页重新启用；管理页也支持勾选多项后批量停用已启用配置、批量启用停用配置。
- 用 `删除` 永久移除不再需要的账号；管理页也支持勾选多项后批量删除启用配置、停用配置和入口 apikey。

token 账号不可用时，同一会话会自动漂移到其他可用 token 账号；没有会话标识的 token 请求会按当前 in-flight 数分摊。`apikey` 上游不参与这套并发调度，只有 token 不可用时才作为传统 fallback。Airouter 会自动检查 ChatGPT/Codex token 账号状态；额度低、登录态失效或账号不可用时，会跳过它。额度检查本身连续 3 次失败才会把 token 标记为 `quota_check_failed`，成功检查会清零失败计数。token Responses 请求如果请求模型不是 `gpt-5.4-mini` 或它的日期版本后缀，但上游成功响应里的实际模型变成了 `gpt-5.4-mini` 或同名日期版本，会被视为模型降级并触发本次请求自动切号，但不会把账号标记为不可用。apikey 直连上游在响应提交给客户端前遇到任意非 200 HTTP 状态、请求失败或响应体中断时，会在本次请求内先尝试切到下一个可用配置；响应已经开始写给客户端后不再透明切换。最近 30 分钟内最多 10 个已完成真实请求累计达到 3 次失败时，才会被临时标记为不可用。已被标记为不可用的 GPT apikey 会在每 3 分钟全量校正中用 `/v1/responses` 的 `hello` 请求探测，成功后自动恢复可用；探测默认超时 `600000ms`（10 分钟），可用环境变量 `APIKEY_RECOVERY_TIMEOUT_MS` 覆盖；探测模型默认 `gpt-5.4-mini`，管理页新增 fallback apikey 时可选择 `gpt-5.4-mini` 或 `gpt-5.4`，配置文件中对应 `"health": {"model": "gpt-5.4-mini"}`。

管理页会在“调度模式”和 token 账号摘要里显示安全的调度观测：正在请求时显示 `当前会话 #短hash -> 配置 #N`，请求结束后保留 `最近会话 #短hash`，用于观察某个会话实际命中了哪个账号。原始会话 ID 不会写入配置，也不会返回到页面。

管理页也会在账号摘要中显示最近一次 `/v1/responses` 或 `/v1/messages` 转换链路的模型观测，例如 `响应模型 gpt-5.4-mini-2026-03-17 · 请求 gpt-5.4-mini`，同名日期版本会视为一致，方便判断上游实际返回的模型是否符合预期。

`/v1/messages` 会优先使用 `claude_token` 原样转发；没有可用 Claude token 时，使用支持 `Claude` 的 API Key 原样转发。Claude 直转链路都不可用时，才转换到 Responses：优先使用 OpenAI token，OpenAI token 不可用时再使用支持 `GPT` 的 API Key。

`/cpa/v1/*` 提供 CLIProxyAPI 风格前缀入口，内部剥离 `/cpa` 后复用 `/v1/*` 链路。走 Codex/Responses 转换时，Airouter 会把原始 `instructions` 或 Claude `system` 转成 `developer` input，并保留空字符串 `instructions` 字段，避免把系统提示直接作为 system/instructions 发给上游。

## 端口说明

管理页可以修改两个端口：

- 服务端口：Airouter 对外提供接口的端口，默认 `3009`。
- 本地代理端口：Airouter 访问上游时使用的代理端口，例如 `7890`。

保存端口后会立即生效。服务端口变化时，页面会自动跳转到新地址。

## 常见问题

### 管理页面打不开

先确认服务正在运行：

```bash
npm start
npm run logs
```

### 提示 auth_token 无效

管理页面地址里的 `auth_token` 不对。请使用日志里显示的完整管理页面地址，不要手动删改 URL 后面的参数。

### 请求返回 401 或 token_revoked

通常是 ChatGPT 登录态失效。重新获取 AuthSession JSON 后添加新的配置项。

### API Key 有两种，怎么区分

- 上游 API Key：填在 `Fallback apikey` 页面里，Airouter 用它访问上游。
- 入口 apikey：填在客户端里，客户端用它访问 Airouter。

## 常用命令

```bash
npm start        # 启动
npm run stop     # 停止
npm run restart  # 重启
npm run logs     # 查看日志
npm run claude:login # 追加 Claude OAuth 登录态
```

服务会使用项目目录下的 `openai.json`。

npm run claude:login
export ANTHROPIC_BASE_URL=http://localhost:3009
export CLAUDE_CODE_OAUTH_TOKEN=<local-fake-auth-token>
unset ANTHROPIC_API_KEY
unset ANTHROPIC_AUTH_TOKEN
