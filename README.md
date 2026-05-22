# Airouter

Airouter 是一个本地 API 转发工具。

简单说：你把 ChatGPT/Codex 账号、第三方 OpenAI 兼容 API、Claude Messages 兼容 API 配到 Airouter 里，然后让 Codex、Claude Code、cc-switch 等工具统一访问 Airouter。Airouter 会帮你转发请求、切换可用账号，并提供一个网页管理界面。

它适合这些场景：

- 想让本地工具使用 ChatGPT Codex token 账号。
- 想把多个账号放在一起，额度低或不可用时自动切换。
- 想把 Claude Code 的 Messages API 请求转到可用的 GPT 或 Claude 兼容上游。
- 想统一用一个本地地址，例如 `http://localhost:3009/v1`，管理不同上游。

## 推荐用法：下载桌面版

如果你只是想使用，不想折腾命令行，推荐下载桌面版。

打开 [GitHub Releases](https://github.com/ccq18/airouter/releases) 下载最新版本：

- macOS：下载 `Airouter_*.app.zip`，解压后打开 `Airouter.app`。
- Windows：下载 `Airouter_*.exe`，安装后打开 Airouter。

桌面版会自动启动本地服务，并直接打开配置页面。一般不需要手动点“启动”或“停止”，跟普通 App 一样打开就能用，退出 App 服务也会一起关闭。

桌面版管理页面会低频检查 GitHub Releases；只有发现新版本时，右上角才会显示“更新到 x.y.z”按钮，点击后会打开下载页。

## 第一次配置

打开 Airouter 后，会进入管理控制台。你主要需要做三件事：

1. 添加一个或多个上游账号。
2. 按需新增入口 `apikey`。
3. 复制代理访问地址给 Codex、Claude Code 或 cc-switch 使用。

![Airouter 管理控制台](docs/img/config_account.png)

管理页面里会显示类似这样的地址：

```text
http://localhost:3009/v1
```

常用接口是：

```text
http://localhost:3009/v1/responses
http://localhost:3009/v1/messages
```

如果页面里配置了入口 `apikey`，调用 Airouter 时需要带上：

```http
Authorization: Bearer sk-airouter-xxxx
```

如果入口 `apikey` 列表为空，请求不会校验 `apikey`，本机直接可访问。

## 添加账号

管理页的“新增配置项”支持两类上游。

### 1. ChatGPT/Codex 登录态

适合用 ChatGPT/Codex 账号额度。

你需要粘贴登录态 JSON。建议这样操作：

1. 用浏览器隐私模式或无痕窗口登录 ChatGPT。
2. 获取登录态 JSON。
3. 粘贴到 Airouter。如果 JSON 里带有跳转链接或 redirect 信息，请保留原样，不要删字段。
4. 粘贴后不要退出这个 ChatGPT 登录，否则 token 可能会失效。

如果遇到类似下面的错误：

```text
401 Unauthorized
token_revoked
```

通常表示登录态已经失效，需要重新获取并粘贴新的登录态。

### 2. 第三方 API Key

适合接入 OpenAI 兼容接口或 Claude Messages 兼容接口。

常见填写方式：

- `base_url`：上游地址，通常写到 `/v1`，例如 `https://api.example.com/v1`。
- `apikey`：上游的 API Key。
- `support`：支持类型。

`support` 可以这样理解：

- `gpt`：走 OpenAI 兼容接口，例如 `/v1/responses`。
- `claude`：走 Claude Messages 接口，例如 `/v1/messages`，请求体会尽量原样转发。
- 同时支持就填 `["gpt", "claude"]`。

## 账号切换规则

Airouter 在需要重新选择上游时，按管理页里的配置顺序选择可用上游。越靠前，优先级越高；可以在管理页用“置顶”调整顺序。

大致规则是：

- 当前活动配置可用且支持当前接口时，会继续使用当前配置。
- 当前配置不可用或不支持当前接口时，会按配置顺序寻找第一个可用配置；单纯置顶不会触发当前配置切换。
- token 账号仍会每分钟轮询额度；额度低、登录态失效或套餐不可用时会自动标记为不可用。
- 上游 API Key 不参与 Codex quota 轮询；直连上游遇到 401/403、429 或 5xx 时会临时标记为不可用。
- 手动切换到某个 API Key 配置时，会把该配置恢复为可用并设为当前配置。
- `/v1/messages` 会优先找支持 `claude` 的 API Key；没有可用 Claude 上游时，再走兼容转换。

你不需要手动记住每个账号状态，管理页会展示当前运行态，也可以手动切换、置顶或删除配置。

## 用 curl 测试

没有配置入口 `apikey` 时：

```bash
curl http://127.0.0.1:3009/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}'
```

配置了入口 `apikey` 时：

```bash
curl http://127.0.0.1:3009/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的 airouter apikey>" \
  -d '{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}'
```

如果返回了正常内容，说明 Airouter 已经能工作。

## 配合 cc-switch 使用

推荐使用 [cc-switch](https://github.com/farion1231/cc-switch) 管理本地工具配置。

在 cc-switch 里把 API 地址填成 Airouter 的代理地址即可：

```text
http://localhost:3009/v1
```

如果 Airouter 配了入口 `apikey`，cc-switch 里也填同一个 `apikey`；如果没配置入口 `apikey`，可以留空或随便填。

示例：

![cc-switch Codex 配置](docs/img/ccs_codex.png)

![cc-switch Claude 配置](docs/img/ccs_claude.png)

## 命令行运行

不使用桌面版，也可以直接用 Node.js 运行。

要求：本机已安装 Node.js。

```bash
git clone git@github.com:ccq18/airouter.git
cd airouter
npm install
npm start
```

第一次启动时，如果没有 `openai.json`，会进入配置引导：

- 是否启用本地代理端口。
- 代理端口号，默认 `7890`。
- 服务端口，默认 `3009`。
- 是否生成入口 `apikey`。

启动后，终端会打印管理页面地址，类似：

```text
http://127.0.0.1:3009/admin/configs?auth_token=auth_xxx
```

复制这个地址到浏览器打开即可。

常用命令：

```bash
npm start        # 启动服务
npm run stop     # 停止服务
npm run restart  # 重启服务
npm run logs     # 查看日志
```

## 配置文件在哪里

命令行版本主要使用项目根目录下的：

```text
openai.json
```

桌面版会把运行资源放到系统应用数据目录里，并保留你的 `openai.json`。升级 App 时，程序代码会更新，但你的配置不会被覆盖。

桌面版首次打开时，如果运行目录里还没有 `openai.json`，会先停在初始配置引导页。完成服务端口、本地代理端口和入口 `apikey` 选项后，应用会写入配置文件，再启动本地服务并进入管理页面。

`openai.json.example` 是配置模板，可以作为参考。

一个简化示例：

```json
{
  "apikeys": ["sk-airouter-xxxx"],
  "auth_token": "auth_xxxx",
  "port": 3009,
  "proxy_port": 7890,
  "configs": [
    {
      "access_token": "chatgpt-access-token",
      "account_id": "account-id",
      "description": "codex token account"
    },
    {
      "type": "apikey",
      "base_url": "https://api.example.com/v1",
      "apikey": "sk-xxx",
      "support": ["gpt"],
      "description": "OpenAI compatible provider"
    },
    {
      "type": "apikey",
      "base_url": "https://claude.example.com/v1",
      "apikey": "sk-xxx",
      "support": ["claude"],
      "description": "Claude Messages provider"
    }
  ]
}
```

## 端口和代理

管理页可以配置两个端口：

- 服务端口：Airouter 自己监听的端口，默认 `3009`。
- 代理端口：Airouter 访问上游时使用的本地代理端口，常见是 `7890`。

端口保存后会立即生效。服务端口变化时，页面会自动跳转到新的本地地址。

## 常见问题

### 1. 管理页面打不开

先确认服务是否启动。

命令行版本可以查看日志：

```bash
npm run logs
```

桌面版可以重新打开 App。如果端口被旧进程占用，桌面版会尝试清理占用端口的旧进程。

### 2. 提示 auth_token 无效

管理页面地址里的 `auth_token` 不对。

请使用启动日志或桌面 App 自动打开的管理地址，不要手动删掉 URL 后面的 `auth_token`。

### 3. 请求提示 401 或 token_revoked

通常是 ChatGPT 登录态失效。

重新在隐私模式登录 ChatGPT，获取新的登录态 JSON，再粘贴到 Airouter。粘贴后不要退出登录。

### 4. 新增 API Key 后怎么用

管理页里“访问控制”的 `apikey` 是 Airouter 的入口钥匙，不是上游钥匙。

也就是说：

- 上游 API Key：填在“新增配置项”里，Airouter 用它访问上游。
- 入口 API Key：填在客户端里，客户端用它访问 Airouter。

### 5. Windows 和 macOS 会自动打包吗

会。

仓库推送 `v*` tag 后，GitHub Actions 会自动构建：

- macOS `.app.zip`
- Windows `.exe` 安装包

构建成功后会自动上传到 GitHub Releases。

## 开发者信息

本项目的桌面版基于 Tauri，只做外层包装，不侵入现有 Node.js 服务逻辑。

常用开发命令：

```bash
cd desktop
npm install
npm run dev
```

本地打包：

```bash
cd desktop
npm run build:macos
```

Windows 安装包建议通过 GitHub Actions 在 Windows runner 上构建。
