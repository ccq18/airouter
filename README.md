# 介绍
实现了openai codex 接口转发，支持多账号额度调度，5小时额度低于3%会自动切换新账号
并且实现了messages api和responses api的翻译，可以让claude code 使用gpt-5.4
## 配置
- npm install

- apikey

```
{
  "type": "token",
  "configs": [
   {
    "access_token": "",
    "account_id": "",
    "description": "ChatGPT Codex 默认配置，获取：https://chatgpt.com/api/auth/session"
  }
  ]
}

```

- token
```
{
  "type":"token",
  "configs":[
      {
        "access_token": "",
        "account_id": "",
        "description": ""
      }
    ]
}

```

## 启动
CONFIG=openai.json PORT=3000 https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890 node openai.js

CONFIG=openai_api.json PORT=3000 https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=socks5://127.0.0.1:7890 node openai.js


## ccs配置
使用ccs配置转发到对应地址就可以，apikey随便写。也可以自己手动配置
![codex.jpg](doc/codex.jpg)
![claude.jpg](doc/claude.jpg)