# Airouter

Airouter 将任意客户端模型 ID 映射到有序的「上游账号 + 后端模型」候选。ChatGPT/Codex、Claude OAuth、OpenCode Zen/Go、OpenRouter、GLM Coding Plan 和自定义接口按同一规则参与路由；账号类型不决定优先级。

三种入口只转发到相同原生协议；一个候选可声明支持多种协议，由入口自动匹配。不再进行跨协议内容转换。

## 1. 启动与配置

运行环境使用 Node.js 22 或更新版本。

```bash
npm install
npm start
```

首次在交互终端启动时，会依据 `config.json.example` 创建 `config.json`；也可以复制模板后手动填写。服务不会读取或迁移 `openai.json`。本次只支持统一模型路由，不存在模式开关、旧账号焦点或全局模型别名。

```bash
npm run stop
npm run restart
npm run logs
```

默认端口为 `3009`。管理凭证 `auth_token` 为空时，服务会生成并写回配置；日志不打印该值。从自己的 `config.json` 获取它后访问：

```text
http://localhost:3009/admin/configs?auth_token=<管理凭证>
```

`apikeys` 是客户端入口密钥，区别于上游转发凭证。缺少该字段时服务生成一枚入口密钥；显式配置为空数组时关闭入口密钥校验。

## 2. 配置账号与路由

管理台只有两个页签：

- **上游账号**：账号列表；新增和编辑通过弹窗完成。选择平台、填写转发凭证，维护支持模型。内置平台不需要填写模型目录地址，只有自定义接口需要。
- **模型路由**：填写任意客户端 ID，添加「账号 + 后端模型」候选并调整顺序。客户端 ID 与后端模型名相互独立；候选不再固定协议，界面展示模型支持的原生协议。

模型同步先预览差异、合并到草稿，再保存。取消不会修改配置；被路由引用的模型不能直接删除。新增账号保存前也能使用草稿凭证同步目录。入口密钥、端口和登录态导入在设置入口中维护。

最高优先级候选可用时持续使用；额度耗尽或出现可重试故障后使用后备。确认额度恢复后，后续不依赖上游私有状态的请求自动回切。额度未知或查询失败不会被显示为零；已知耗尽不会因查询失败而恢复。

## 3. 客户端调用

支持三个 JSON 对话入口和模型目录：

```text
POST /v1/chat/completions
POST /v1/responses
POST /v1/messages
GET  /v1/models
```

客户端 Base URL 为 `http://localhost:3009/v1`，使用 `Authorization: Bearer <入口密钥>` 或 `x-api-key`。请求中的 `model` 必须是已配置的客户端路由 ID；没有路由时不会猜测或自动选择账号。

流式响应已经开始后不会拼接其他上游的答案；`previous_response_id` 固定到原账号、模型和协议，绑定丢失时需要客户端重发完整上下文。

## 4. 登录态与平台边界

ChatGPT/Codex 可通过管理台导入 AuthSession 或 Sub2API Agent Identity JSON，然后维护支持模型与路由。Claude OAuth 使用：

```bash
npm run claude:login -- --config config.json --open
npm run restart
```

登录脚本修改磁盘配置后需重启服务，再添加模型与路由。管理接口保存的修改会热加载；直接编辑配置文件也需要重启。

Go、GLM 和 OpenRouter 按各平台接口读取额度，复用转发凭证。Zen 普通 Key 余额、Claude OAuth 额度尚无已核实的读取接口，会显示未知。完整平台与协议边界见[统一设计](docs/unified-model-routing-design.md)。

## 5. 验证与部署

```bash
npm test
```

集成测试使用临时配置和本地假上游；真实套餐、供应商网络与推理需另行验收。服务器可直接运行 `CONFIG=/绝对路径/config.json AIROUTER_BIND_HOST=127.0.0.1 node openai.js`，由 Nginx 提供 HTTPS。配置文件应仅对服务用户可读写，反向代理应关闭 SSE 缓冲。

桌面应用的开发、打包和签名更新见 [desktop/README.md](desktop/README.md)。

## 6. 参考

[配置契约](docs/config-item-reference.md) · [HTTP 接口](docs/api-reference.md) · [统一路由设计与运行边界](docs/unified-model-routing-design.md)
