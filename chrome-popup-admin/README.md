# OpenAIRouter Chrome Popup

这是一个可直接以 `Load unpacked` 方式安装到 Chrome 的 Popup 插件。

## 安装

1. 打开 Chrome 扩展管理页：`chrome://extensions/`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择目录：

仓库内的 `chrome-popup-admin/` 目录

## 使用

1. 确保本地代理服务已启动，例如：

```bash
npm start
```

2. 点击插件图标
3. 填写：
   - `Base URL`: `http://localhost:3100`
   - `Auth Token`: 填写本地管理页地址里的 `auth_token`
4. 保存设置后即可在 Popup 中管理配置和 apikey

## 当前能力

- 读取配置列表
- 新增配置
- 删除配置
- 新增随机 apikey
- 删除 apikey
- 保存本地 `baseUrl` 与 `authToken`
