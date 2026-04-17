# 介绍
- 实现了openai codex 接口转发，支持多账号额度调度，5小时额度低于3%会自动切换新账号
- 并且实现了messages api和responses api的翻译，可以让claude code 使用gpt-5.4
## 配置
- npm install




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
![session_json.png](docs/session_json.png)

!注意不要退出登录,退出登录token就失效了
- proxy_port 填本地的代理端口
- port 填服务监听端口，不填时默认 `3000`
- `claude_code.model` 用来强制覆盖 Claude Code 走 `/claude/v1/messages` 时上游实际使用的模型
- `claude_code.reasoning_effort` 用来强制覆盖 Claude Code 走 `/claude/v1/messages` 时的推理强度，默认 `high`
- 以上 `claude_code` 配置只作用于 `/claude/v1/messages`，不会影响普通 `/v1/*` OpenAI 兼容接口
## 启动
``` 
bash run.sh
bash run.sh stop
bash run.sh logs
```

执行以下curl,有正常内容返回，就表示airouter已经成功启动
```
curl http://127.0.0.1:3000/v1/responses \
-H "Content-Type: application/json" \
-d '{"model":"gpt-5.4","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}]}'
```


使用 `bash run.sh` 可以避开脚本可执行权限问题。
`bash run.sh logs` 会先展示最近 100 行日志，然后持续输出新日志。

## ccs配置
建议使用 https://github.com/farion1231/cc-switch 管理本地的配置
使用ccs配置转发到对应地址就可以，apikey随便写。也可以自己手动配置
![codex.jpg](docs/codex.jpg)
![claude.jpg](docs/claude.jpg)
