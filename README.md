# Airouter

Airouter 是一个本地 API 转发 App。

你可以把 ChatGPT/Codex 登录态、OpenAI 兼容 API、Claude Messages 兼容 API 放进 Airouter，然后让 Codex、Claude Code、cc-switch 等工具统一访问一个本地地址：

```text
http://localhost:3009/v1
```

Airouter 会在本机转发请求，并在账号不可用时自动切换到其他可用账号。

## 下载和启动

打开 [GitHub Releases](https://github.com/ccq18/airouter/releases) 下载最新版。

- macOS：下载 `Airouter_*.app.zip`，解压后打开 `Airouter.app`。
- Windows：下载 `Airouter_*.exe`，安装后打开 Airouter。

打开 App 后，它会自动启动本地服务，并打开管理页面。退出 App 时，本地服务也会一起关闭。

## 第一次使用

第一次打开时，App 会让你完成基础设置：

1. 服务端口：默认 `3009`，一般不用改。
2. 本地代理端口：如果你访问 ChatGPT 需要代理，常见填 `7890`；不需要可以留空。
3. 入口 apikey：可选。开启后，客户端访问 Airouter 时需要带这个 apikey。

完成后会进入管理页面。
![cc-switch Codex 配置](docs/img/img.png)

## 添加账号

管理页面里主要添加两类账号。

### ChatGPT/Codex 账号

适合使用 ChatGPT/Codex 账号额度。

有两种添加方式。

方式一：App 自动获取。

在 `AuthSession JSON` 旁边点击 `App 自动获取`，App 会打开一个新的 ChatGPT 登录窗口。你登录成功后，Airouter 会自动读取登录态并填回表单。

方式二：手动粘贴 JSON。

如果你已经有 AuthSession JSON 文件或别人提供给你的 JSON 内容，直接打开文件，复制完整 JSON，粘贴到 `AuthSession JSON` 文本框。

无论用哪种方式，确认文本框里已经有 JSON 后，点击 `新增配置项`。

注意：

- 登录窗口是临时窗口，不会复用上次登录信息。
- 如果你手动关闭登录窗口，`App 自动获取`按钮会恢复可点。
- 手动粘贴时请复制完整 JSON，不要只复制 `accessToken`。
- 登录态添加成功后，不要主动退出这个 ChatGPT 登录态，否则 token 可能失效。

### 第三方 API Key

适合接入 OpenAI 兼容接口或 Claude Messages 兼容接口。

选择 `API Key 模式`，填写：

- `Base URL`：上游地址，通常写到 `/v1`，例如 `https://api.example.com/v1`。
- `API Key`：上游服务提供的 key。
- `支持类型`：
  - `GPT`：支持 OpenAI 兼容接口。
  - `Claude`：支持 Claude Messages 接口。

填完后点击 `新增配置项`。

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

Token 配置下，`/v1/images/generations` 和 `/v1/images/edits` 会通过 Codex Responses 的 `image_generation` 工具兼容输出 OpenAI Images JSON：

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

Airouter 会对 ChatGPT/Codex token 账号做会话粘性调度。相同 `session_id`、`conversation_id`、`thread_id`、`previous_response_id`，或请求头里的 `x-airouter-session-id` / `x-client-request-id`，会尽量固定到同一个可用 token 账号。

你可以：

- 用 `置顶` 调整优先级。
- 在 token 行用 `设为锚点` 指定 token 并发池的调度焦点。
- 在 apikey 行用 `全量切换` 进入 API Key 覆盖模式。
- 删除不可用或不再需要的账号。

token 账号不可用时，同一会话会自动漂移到其他可用 token 账号；没有会话标识的 token 请求会按当前 in-flight 数分摊。`apikey` 上游不参与这套并发调度，只有 token 不可用时才作为传统 fallback。Airouter 会自动检查 ChatGPT/Codex token 账号状态。额度低、登录态失效或账号不可用时，会跳过它。

`/v1/messages` 会优先使用支持 `Claude` 的 API Key；没有可用 Claude 上游时，再走兼容转换。

## 端口说明

管理页可以修改两个端口：

- 服务端口：Airouter 对外提供接口的端口，默认 `3009`。
- 本地代理端口：Airouter 访问上游时使用的代理端口，例如 `7890`。

保存端口后会立即生效。服务端口变化时，页面会自动跳转到新地址。

## 常见问题

### 管理页面打不开

重新打开 App。App 会尝试启动本地服务，并清理旧进程占用的端口。

### 提示 auth_token 无效

管理页面地址里的 `auth_token` 不对。请使用 App 自动打开的管理页面，不要手动删改 URL 后面的参数。

### 请求返回 401 或 token_revoked

通常是 ChatGPT 登录态失效。重新点击 `App 自动获取`，登录 ChatGPT 后添加新的配置项。

### API Key 有两种，怎么区分

- 上游 API Key：填在 `API Key 模式`里，Airouter 用它访问上游。
- 入口 apikey：填在客户端里，客户端用它访问 Airouter。

## 命令行运行

推荐使用桌面 App。确实需要命令行时，可以这样运行：

```bash
npm install
npm start
```

常用命令：

```bash
npm start        # 启动
npm run stop     # 停止
npm run restart  # 重启
npm run logs     # 查看日志
```

命令行版本会使用项目目录下的 `openai.json`。桌面 App 会使用系统应用数据目录里的配置文件，升级 App 不会覆盖你的配置。
