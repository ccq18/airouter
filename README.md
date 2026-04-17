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
![codex.jpg](doc/codex.jpg)
![claude.jpg](doc/claude.jpg)