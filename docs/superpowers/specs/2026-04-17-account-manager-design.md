# Account Manager Refactor Design

**Date:** 2026-04-17

**Status:** Proposed

## Goal

将 `openai.js` 中与账号额度检查、账号可用性状态、活动账号选择、轮询定时器相关的逻辑抽离到独立模块，降低入口文件复杂度，同时严格保持当前运行行为不变。

本次不调整任何业务策略，包括：

- 仍然按当前实现每分钟全量检查所有账号额度
- 仍然只有当前活动账号不可用时才切换到下一个可用账号
- 仍然保持现有日志文案、健康检查字段和切号时机

## Current Problem

当前 `openai.js` 同时承担了以下职责：

- 配置文件读取与运行时配置初始化
- 账号额度状态判断
- 账号可用性切换
- 额度轮询定时器生命周期管理
- HTTP 转发与响应处理
- 服务启动与路由注册

其中“账号管理”相关逻辑跨越多个函数并与入口文件状态变量耦合，导致以下问题：

- `openai.js` 过大，阅读和修改成本高
- 账号切换与额度检查难以单独测试
- 未来若调整轮询策略，容易误伤请求转发逻辑

## Scope

本次重构只处理账号管理逻辑的结构拆分。

包含：

- 抽出账号管理模块
- 将账号运行时状态相关函数迁移到新模块
- 将额度轮询定时器管理迁移到新模块
- 保持 `openai.js` 通过少量公开接口调用账号管理模块
- 为新模块补最小回归测试

不包含：

- 修改轮询频率
- 修改“何时切号”的策略
- 修改 `/health` 返回结构
- 修改请求转发逻辑
- 修改 Claude/OpenAI 协议兼容行为

## Target Structure

新增文件：

- `app/account-manager.js`

保留文件：

- `openai.js`
- `app/openai-config.js`

### app/account-manager.js

职责：

- 管理活动账号索引
- 判断账号是否可用
- 计算额度状态和原因
- 刷新单个账号额度
- 刷新所有账号额度
- 在需要时切换活动账号
- 启动和维护额度轮询定时器
- 提供账号摘要格式化能力给调用方复用

公开接口：

- `createAccountManager(options)`

返回对象至少包含：

- `selectConfig()`
- `ensureActiveConfig(reason)`
- `refreshQuotas(reason)`
- `startQuotaMonitor()`
- `getActiveConfig()`
- `getRuntimeSummary(config)`
- `evaluateQuotaPayload(payload)`

`options` 负责注入当前实现已经依赖的外部能力，避免模块直接绑定入口文件中的全局变量：

- `configs`
- `configType`
- `quotaCheckPath`
- `quotaCheckIntervalMs`
- `minRemainingPercent`
- `buildAuthHeadersForConfig`
- `shouldUseQuotaMonitoring`
- `spawn`
- `log`
- `warn`
- `now`

### openai.js

重构后保留这些职责：

- 读取配置文件并创建运行时账号配置
- 创建 `accountManager`
- 处理 URL 重写、请求头构建、curl 转发
- 初始化 Express 路由
- 在启动时触发首次额度刷新
- 在日志和健康检查中读取当前活动账号信息

`openai.js` 不再直接持有这些账号管理内部状态：

- `activeConfigIndex`
- `quotaMonitorRunning`
- `quotaMonitorTimer`

这些状态全部收敛进 `app/account-manager.js`。

## Behavior Preservation Rules

以下行为必须保持完全一致：

1. `refreshAllAccountQuotas('startup')` 的语义保持不变。
2. 轮询仍然串行检查所有账号的 `/backend-api/wham/usage`。
3. `ensureActiveConfig()` 仍然只在当前账号不可用时才尝试切换。
4. 若没有任何账号被判定为可用，仍然保留当前账号继续服务。
5. `quota_check_failed` 仍然只记录错误，不主动把账号从“可用”改成“不可用”。
6. 日志文案保持不变，尤其是：
   - `账号不可用`
   - `账号恢复可用`
   - `账号切换`
   - `当前活动账号`
   - `轮询额度`

## Data Flow

启动时：

1. `openai.js` 读取 `openai.json`
2. `openai.js` 调用 `createRuntimeConfigs`
3. `openai.js` 创建 `accountManager`
4. `openai.js` 调用 `accountManager.refreshQuotas('startup')`
5. `openai.js` 调用 `accountManager.ensureActiveConfig('startup')`
6. `openai.js` 调用 `accountManager.startQuotaMonitor()`

请求时：

1. 路由处理器调用 `accountManager.selectConfig()`
2. 账号管理模块保证返回当前应使用的活动账号
3. 转发逻辑继续使用该账号生成鉴权头并执行代理

轮询时：

1. 定时器由账号管理模块触发
2. 模块串行检查全部账号额度
3. 模块内部根据最新状态更新活动账号
4. 模块按当前实现输出轮询日志

## Testing Strategy

新增单测文件：

- `test/account-manager.test.js`

覆盖以下最小行为：

- 当前账号可用时，`ensureActiveConfig()` 不切号
- 当前账号不可用时，切换到下一个可用账号
- 所有账号不可用时，保留当前账号
- 额度响应中 `allowed=false`、`limit_reached=true`、`remaining<3` 的判定保持不变
- `refreshQuotas('poll')` 后仍然输出当前活动账号摘要

保留并继续执行已有验证：

- `node --test test/run.test.js`
- `node --check run.js`

## Risks

### Risk 1: Hidden behavior drift

如果在迁移过程中顺手修改日志、状态字段或切号时机，就会把“结构重构”变成“行为变更”。

控制方式：

- 迁移函数时先保持签名和逻辑不变
- 用单测锁定关键切号行为
- 不在本次重构里顺手优化轮询策略

### Risk 2: Circular dependency

如果 `account-manager.js` 反向依赖 `openai.js` 的工具函数，会形成耦合和初始化顺序问题。

控制方式：

- 通过依赖注入传入 `log`、`warn`、`spawn`、`buildAuthHeadersForConfig`
- 新模块不直接 `require('./openai.js')`

### Risk 3: Health endpoint breakage

如果 `/health` 改为读取错误的数据源，可能造成对外状态不一致。

控制方式：

- `openai.js` 继续通过 `accountManager.getActiveConfig()` 读取当前活动账号
- 保持原字段名和字段来源不变

## Acceptance Criteria

- `openai.js` 中账号管理相关函数和状态显著减少
- 新增 `app/account-manager.js` 承担账号轮询和切号职责
- 运行行为与当前实现一致
- 现有 `run.js` 相关测试保持通过
- 新增账号管理模块测试通过
