# 介绍
- 实现了openai codex 接口转发，支持多账号额度调度，5小时额度低于3%会自动切换新账号
- 并且实现了messages api和responses api的翻译，可以让claude code 使用gpt-5.4
- 极简依赖，只需要nodejs即可运行。
## 配置
```bash
git clone git@github.com:ccq18/airouter.git
cd airouter
npm install
npm start
```
说明：
- 首次执行 `npm start` 时，如果 `openai.json` 不存在，会自动读取 `openai.json.example` 进入创建配置文件引导
- 引导会依次询问是否启用本地代理端口（默认开启）、代理端口号（默认 `7890`，可修改）、是否启用入口 `apikey`
- 若启用入口 `apikey`，会自动生成一个 `sk-airouter-...` 并写入配置文件
- 非交互终端不会进入引导；这种场景下请先手工创建 `openai.json`

## 配置账号

启动后访问启动日志里打印的管理地址，例如 `http://127.0.0.1:3009/admin/configs?auth_token=...`
![config_account.png](docs/img/config_account.png) 
管理页里可以新增随机 `apikey`，配置了apikey则会校验，若所有apikey为空则不校验

执行以下curl,有正常内容返回，就表示airouter已经成功配置 

!注意不要退出登录,退出登录token就失效了，建议在无痕窗口登录gpt后获取登录态

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

使用 ccs 配置转发到对应地址即可；如果 airouter 配置了入口 `apikeys`，这里填其中任意一个值，否则可以留空或随便写
![ccs_codex.png](docs/img/ccs_codex.png) 
![ccs_claude.png](docs/img/ccs_claude.png) 

## 其他命令

说明：
- `npm start`：启动服务；首次启动且缺少 `openai.json` 时，会先进入创建配置文件引导，然后继续启动
- `npm run restart`：重启当前服务进程
- `npm run stop`：停止当前服务进程
- `npm run logs`：查看服务运行日志，排查启动问题时优先看这里
