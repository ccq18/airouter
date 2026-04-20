# Start Config Wizard Design

**Date:** 2026-04-20

**Status:** Approved

## Goal

在执行 `npm start` / `node run.js start` 时，先检查当前目录下是否存在 `openai.json`。如果配置文件不存在，则直接进入命令行初始化向导：

- 读取 `openai.json.example` 作为模板
- 询问是否启用本地代理端口；若启用，再询问代理端口，默认 `7890`
- 询问是否启用入口 `apikey` 校验；若启用，则自动生成一个随机 `apikey`
- 根据回答写入 `openai.json`
- 完成初始化后继续现有启动流程

## Scope

包含：

- 在 `run.js` 启动前增加缺失配置检查
- 在 `run.js` 中新增交互式初始化向导
- 复用模板文件生成初始配置
- 为初始化流程补启动脚本测试
- 更新 README 的首次启动说明

不包含：

- 修改 `openai.js` 的管理后台逻辑
- 修改 `configs` 账号配置流程
- 修改现有 `auth_token` 自动生成逻辑
- 引入新的初始化命令

## Current Problem

当前 README 要求用户先手动执行 `cp openai.json.example openai.json`，但 `run.js start` 本身不会帮助用户补齐缺失配置。首次使用时如果直接运行 `npm start`，启动脚本会立即读取 `openai.json` 并因为文件缺失报错，导致体验割裂。

## Target Behavior

### Existing Config Present

- 若 `openai.json` 已存在，`start`、`restart` 的行为保持不变
- 仍然按当前流程检查旧进程、端口、拉起 `openai.js`

### Existing Config Missing + Interactive Terminal

- 打印检测到配置缺失和即将进入向导的提示
- 从 `openai.json.example` 读取模板 JSON
- 依次询问：
  1. 是否启用本地代理端口
  2. 若启用，代理端口是多少，默认 `7890`
  3. 是否启用入口 `apikey`
- 保存生成后的 `openai.json`
- 打印配置文件已创建的提示
- 继续执行原有启动逻辑

### Existing Config Missing + Non-interactive Environment

- 不进入阻塞式提问
- 直接输出清晰错误并退出，提示用户在交互终端执行初始化或先手工创建配置文件

## Data Rules

配置文件以模板为基础，仅覆盖初始化向导关心的字段：

- `proxy_port`
  - 启用时写入用户输入端口字符串或数字
  - 不启用时移除该字段，保持“未配置代理”语义
- `apikeys`
  - 启用时写入一个自动生成的随机 key
  - 不启用时写入空数组

其余字段保持模板内容：

- `type`
- `configs`
- `port`
- `claude_code`
- `auth_token`

其中 `auth_token` 继续交给 `openai.js` 启动时通过现有 `ensureSecuritySettings()` 自动补齐，避免在 `run.js` 中复制第二套安全字段初始化逻辑。

## Implementation Shape

主要修改文件：

- `run.js`
- `test/run.test.js`
- `README.md`

### run.js

新增几类职责：

- 检查配置文件是否存在
- 读取模板配置
- 通过 `readline/promises` 在 TTY 环境中询问用户
- 规范化 yes/no 和端口输入
- 将生成结果写入 `openai.json`

保持不变的职责：

- 管理 PID 和控制文件
- 停止旧进程
- 检查端口
- 拉起 `openai.js`
- 显示启动日志

## Error Handling

- 模板文件不存在：输出明确错误并退出
- 模板 JSON 非法：输出明确错误并退出
- 用户输入空端口：启用代理时回退到默认 `7890`
- 用户输入非法端口：反复提示直到输入合法端口
- 交互被中断：终止启动，不写出半成品配置

## Testing Strategy

扩展 `test/run.test.js`，覆盖以下行为：

- 有配置文件时，`start` 行为保持不变
- 缺配置文件时，交互回答可以生成配置并继续启动
- 选择启用代理后支持自定义端口
- 启用代理但端口留空时写入默认 `7890`
- 启用 `apikey` 时会生成并持久化一个 key
- 非 TTY 且缺配置文件时，启动失败并打印清晰提示

## Acceptance Criteria

- `npm start` 在首次运行时不再要求用户手工 `cp`
- 初始化向导能生成可用的 `openai.json`
- 生成配置后会继续现有启动流程
- 既有启动相关测试保持通过
- README 首次使用说明与新行为一致
