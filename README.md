# 介绍
- 实现了openai codex 接口转发，支持多账号额度调度，5小时额度低于3%会自动切换新账号
- 并且实现了messages api和responses api的翻译，可以让claude code 使用gpt-5.4
## 配置
```bash
git clone git@github.com:ccq18/airouter.git
cd airouter
npm install
cp openai.json.example openai.json
npm start
```
说明：
- `proxy_port` 可选；只有在需要通过本地代理访问上游时才填写，例如 `7890`

## 配置账号
启动后访问启动日志里打印的管理地址，例如 `http://127.0.0.1:3009/admin/configs?auth_token=...`
![config_account.png](docs/img/config_account.png)
管理页里可以新增随机 `apikey`，也可以删除已有 `apikey`
执行以下curl,有正常内容返回，就表示airouter已经成功配置
!注意不要退出登录,退出登录token就失效了，建议在无痕窗口登录gpt后获取登录态
如果你配置了入口 `apikeys`，记得额外加上 `-H "Authorization: Bearer <apikey>"`

```
无api_key
curl http://127.0.0.1:3009/v1/responses \
-H "Content-Type: application/json" \
-d '{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}'


带api_key
curl http://127.0.0.1:3009/v1/responses \
-H "Content-Type: application/json" \
-H "Authorization: Bearer <api key>" \
-d '{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}'

```
## ccs配置
建议使用 https://github.com/farion1231/cc-switch 管理本地的配置
使用 ccs 配置转发到对应地址即可；如果 airouter 配置了入口 `apikeys`，这里填其中任意一个值，否则可以留空或随便写。也可以自己手动配置
![ccs_codex.png](docs/img/ccs_codex.png)
![ccs_claude.png](docs/img/ccs_claude.png)

## 其他命令

说明：
- `npm start`：启动服务，首次启动后可以在日志里看到管理后台地址和访问令牌
- `npm run restart`：重启当前服务进程
- `npm run stop`：停止当前服务进程
- `npm run logs`：查看服务运行日志，排查启动问题时优先看这里
