# AGENTS.md

本文件适用于整个仓库。

## 项目概览

Airouter 是一个本地 OpenAI/Claude 兼容 API 转发工具。主进程是 Node.js/Express 服务，提供：

- `/v1/*` OpenAI 兼容代理，token 配置会改写到 ChatGPT Codex backend-api。
- `/v1/responses` 默认值、模型别名和 token 账号 failover。
- `/v1/messages` Claude Messages 兼容入口，优先原样转发到 `support: ["claude"]` 的 apikey 上游，否则转换到 responses 链路。
- `/admin/configs` 网页管理台和 `/admin/api/*` 配置管理接口。

## 重要路径

- `openai.js`：HTTP 服务入口、代理转发、管理接口、运行态调度。
- `run.js`：命令行启动器，负责配置引导、后台启动、停止、重启和日志查看。
- `app/`：可测试的业务模块。新增逻辑优先放这里，再由 `openai.js` 串接。
- `public/config-admin.html`、`public/config-admin.js`：管理台页面。
- `test/*.test.js`：Node 内置测试。
- `docs/`：配置、运行逻辑和特性设计说明。

## 常用命令

```bash
npm test
npm start
npm run stop
npm run restart
npm run logs
```

## 测试要求

- 修改共享业务模块、代理行为、配置解析或管理接口时，运行 `npm test`。
- 可用 Node 的内置测试过滤单个文件，例如 `node --test test/responses-failover.test.js`。
- 涉及 `run.js` 启停行为时，重点跑 `test/run.test.js`。
- 涉及管理台 HTML/JS 时，重点跑 `test/config-admin.test.js` 和相关 API 测试。

## 代码风格

- 根项目使用 CommonJS：`require(...)` 和 `module.exports`。
- 保持现有缩进和文件风格：多数根项目业务模块使用 2 空格或 4 空格混合的既有格式，局部修改时跟随所在文件。
- 优先写小的纯函数到 `app/` 并导出测试，避免把新业务逻辑直接堆进 `openai.js`。
- 错误信息、管理台文案和日志当前主要是中文；新增用户可见文案请保持中文。
- 不要引入新的框架或构建链，除非需求明确且收益足够大。

## 配置与安全

- 不要提交或粘贴真实 `openai.json`、`openai.log`、`openai.pid`、`openai.control.json`、`openai.control.request.json`。
- 不要把真实 `access_token`、`refresh_token`、`apikey`、`auth_token`、账号 ID 或完整 AuthSession JSON 写入测试、文档或示例。
- 示例配置请使用 `openai.json.example` 或明显的假值，如 `sk-example`、`token-1`、`account-1`。
- 管理接口必须继续受 `auth_token` 保护；普通代理入口必须继续遵守 `apikeys` 配置。
- 本项目面向本地服务，改动监听地址、鉴权、跨域或外部打开行为时要格外保守。

## 代理行为约束

- token 配置项默认优先于 apikey 配置项；只有 token 不可用时才落到 apikey。
- `apikey.support` 只支持 `gpt` 和 `claude`；默认是 `["gpt"]`。
- `/v1/messages` 只注册在 `/v1/messages`，不要新增旧式 `/claude/v1/messages` 兼容路径，除非需求明确。
- `/v1/responses` 自动切号当前只针对 token-backed responses 请求；同一请求会排除已失败账号继续尝试剩余可用 token 账号。
- Hop-by-hop headers 和本地鉴权头不要转发给上游；相关边界已有测试覆盖。
- 对流式响应和压缩响应的处理要优先保持现有 failover/透传语义，避免提前消费客户端需要的流。

## 配置文件语义

- 顶层 `type` 已废弃；配置类型写在 `configs[]` 的每一项里。
- 未写 `type` 的配置项视为 token。
- `responses.model_aliases` 的键和值必须是非空字符串，匹配时忽略大小写。
- `claude_code.model` 和 `claude_code.reasoning_effort` 只影响 `/v1/messages` 的 token 兼容转换链路。
- `port` 和 `proxy_port` 必须保持 1-65535 的端口校验。

## 文档习惯

- 改动用户可见行为时，同步更新 `README.md` 或 `docs/` 中对应说明。
- 复杂代理边界、failover 语义或配置兼容性变化，应优先补充到 `docs/`，避免只靠测试名表达。
- 已有 `docs/superpowers/specs/` 和 `docs/superpowers/plans/` 是历史设计/计划资料；新增普通项目文档优先放在 `docs/` 根层。

## 开发注意事项

- 仓库可能存在本地运行生成物或用户自己的配置文件；不要清理或重写未被要求的本地文件。
- 不要运行会覆盖真实本地服务配置的命令。需要测试配置读写时，使用临时目录或测试 fixture。
- 启动服务会使用默认端口 `3009`；如果本机已有服务运行，先确认再操作。
- 如果需要新增依赖，先确认它是否真的必要，并同步更新 `package-lock.json`。
