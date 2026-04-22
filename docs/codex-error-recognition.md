# Codex 接口错误识别说明

本文档只保留接口层逻辑，按两部分写：

- 通用 `responses` 逻辑
- 单独的 `usage` 接口逻辑

不展开本地错误对象、UI 提示文案或内部重试实现。

## 1. 通用 `responses` 逻辑

这里把 `responses` 当成一套统一协议处理，不区分具体接在哪个产品入口后面。

`responses` 是主请求链路，和对话、补全、推理、工具调用直接相关。接口错误识别主要看两类返回：

- 流式返回中的 `response.failed`
- 普通 HTTP 错误响应

### 1.1 流式事件里的 `response.failed`

当 `responses` 走 SSE 或 websocket 时，失败可能不是直接体现在 HTTP 状态码，而是体现在流里的事件：

```json
{
  "type": "response.failed",
  "response": {
    "id": "resp_xxx",
    "error": {
      "code": "insufficient_quota",
      "message": "You exceeded your current quota..."
    }
  }
}
```

这种情况下，接口识别方式是：

1. 先判断事件类型是不是 `response.failed`
2. 再读取 `response.error.code`
3. 必要时结合 `response.error.message`

#### 1.1.1 明确可识别的 `error.code`

以下错误码可以直接按 `response.error.code` 识别：

- `insufficient_quota`
  - 含义：账户配额或计费额度不足
  - 识别方式：`type == "response.failed"` 且 `response.error.code == "insufficient_quota"`
- `usage_not_included`
  - 含义：当前套餐不包含该能力
  - 识别方式：`type == "response.failed"` 且 `response.error.code == "usage_not_included"`
- `context_length_exceeded`
  - 含义：上下文长度超限
  - 识别方式：`type == "response.failed"` 且 `response.error.code == "context_length_exceeded"`
- `invalid_prompt`
  - 含义：请求参数或 prompt 非法
  - 识别方式：`type == "response.failed"` 且 `response.error.code == "invalid_prompt"`
- `server_is_overloaded`
  - 含义：服务繁忙
  - 识别方式：`type == "response.failed"` 且 `response.error.code == "server_is_overloaded"`
- `slow_down`
  - 含义：服务端要求降速，可视作繁忙 / 容量紧张
  - 识别方式：`type == "response.failed"` 且 `response.error.code == "slow_down"`

#### 1.1.2 需要从 `message` 里补充识别的信息

有些 `response.failed` 不一定带你关心的固定错误码，但会在 `message` 里给出重试提示，例如：

```text
Rate limit reached for gpt-5.1 ... Please try again in 11.054s.
```

此时可以补充识别：

- 是否包含 `try again in`
- 后面是否跟秒数或毫秒数

可抽取的信息：

- 建议等待时间
- 是否属于短期限流而非永久配额不足

### 1.2 直接 HTTP 错误响应

有些错误不是通过 `response.failed` 事件返回，而是直接通过 HTTP 状态码和响应体返回。

最关键的是 `429 Too Many Requests`。

#### 1.2.1 `429` 的识别方式

当 HTTP 状态码是 `429` 时，先看响应体里的：

- `error.type`

典型响应形态：

```json
{
  "error": {
    "type": "usage_limit_reached",
    "plan_type": "plus",
    "resets_at": 1760000000
  }
}
```

或者：

```json
{
  "error": {
    "type": "usage_not_included"
  }
}
```

因此 `429` 的接口识别规则建议写成：

1. 先判断 `status == 429`
2. 再读取 `error.type`
3. 再按 `error.type` 分类

#### 1.2.2 明确可识别的 `error.type`

- `usage_limit_reached`
  - 含义：当前计划的使用窗口打满
  - 识别方式：`status == 429` 且 `error.type == "usage_limit_reached"`
  - 可附带字段：
    - `plan_type`
    - `resets_at`
- `usage_not_included`
  - 含义：当前套餐不包含该能力
  - 识别方式：`status == 429` 且 `error.type == "usage_not_included"`

#### 1.2.3 `429` 响应头里的辅助识别信息

如果上游返回了限流相关响应头，还可以额外读取：

- `x-codex-active-limit`
- `x-request-id`
- `x-oai-request-id`
- `cf-ray`

其中：

- `x-codex-active-limit`
  - 可用于识别当前命中的具体 limit
- `x-request-id` / `x-oai-request-id`
  - 用于问题追踪
- `cf-ray`
  - 可作为请求链路追踪辅助信息

如果接口还返回了窗口信息头，可以进一步提取：

- 当前命中的 limit 名称
- 窗口重置时间
- primary / secondary rate limit 快照

#### 1.2.4 `503` 服务繁忙

当 HTTP 状态码是 `503` 时，仍然建议继续看 body 中的：

- `error.code`

如果满足以下任一条件，可识别为服务繁忙：

- `status == 503` 且 `error.code == "server_is_overloaded"`
- `status == 503` 且 `error.code == "slow_down"`

#### 1.2.5 其他常见状态

- `500`
  - 一般可归类为服务端内部错误
- `400`
  - 一般可归类为请求参数错误
  - 若 body 明确包含图像非法等字段，再做更细分类

### 1.3 通用识别规则建议

#### 1.3.1 对 `responses` 流式返回

1. 判断是否收到 `type == "response.failed"`
2. 读取 `response.error.code`
3. 用以下映射表直接判断：

| 识别字段 | 值 | 建议分类 |
| --- | --- | --- |
| `response.error.code` | `insufficient_quota` | 配额不足 |
| `response.error.code` | `usage_not_included` | 套餐不支持 |
| `response.error.code` | `context_length_exceeded` | 上下文超限 |
| `response.error.code` | `invalid_prompt` | 请求非法 |
| `response.error.code` | `server_is_overloaded` | 服务繁忙 |
| `response.error.code` | `slow_down` | 服务繁忙 / 降速 |

4. 如果没有命中固定 code，再看 `response.error.message`
5. 如果 message 中包含 `try again in <time>`，可标记为“短期限流 / 可延迟重试”

#### 1.3.2 对普通 HTTP 响应

1. 先看 `status`
2. 如果 `status == 429`，优先看 `error.type`
3. 用以下映射表判断：

| 识别字段 | 值 | 建议分类 |
| --- | --- | --- |
| `status + error.type` | `429 + usage_limit_reached` | 使用额度窗口触顶 |
| `status + error.type` | `429 + usage_not_included` | 套餐不支持 |

4. 如果 `status == 503`，再看 `error.code`
5. 用以下映射表判断：

| 识别字段 | 值 | 建议分类 |
| --- | --- | --- |
| `status + error.code` | `503 + server_is_overloaded` | 服务繁忙 |
| `status + error.code` | `503 + slow_down` | 服务繁忙 / 降速 |

### 1.4 最小落地版判断条件

#### 1.4.1 流式 `responses`

- `type == "response.failed"` 且 `response.error.code == "insufficient_quota"`
- `type == "response.failed"` 且 `response.error.code == "usage_not_included"`
- `type == "response.failed"` 且 `response.error.code == "server_is_overloaded"`
- `type == "response.failed"` 且 `response.error.code == "slow_down"`
- `type == "response.failed"` 且 `response.error.code == "context_length_exceeded"`
- `type == "response.failed"` 且 `response.error.code == "invalid_prompt"`

#### 1.4.2 普通 HTTP

- `status == 429` 且 `error.type == "usage_limit_reached"`
- `status == 429` 且 `error.type == "usage_not_included"`
- `status == 503` 且 `error.code == "server_is_overloaded"`
- `status == 503` 且 `error.code == "slow_down"`

### 1.5 可直接落地的伪代码

```ts
function classifyResponsesError(args: {
  status?: number;
  streamEventType?: string;
  responseErrorCode?: string;
  responseErrorMessage?: string;
  errorType?: string;
  errorCode?: string;
}) {
  if (args.streamEventType === "response.failed") {
    switch (args.responseErrorCode) {
      case "insufficient_quota":
        return { kind: "quota_exceeded" };
      case "usage_not_included":
        return { kind: "usage_not_included" };
      case "context_length_exceeded":
        return { kind: "context_length_exceeded" };
      case "invalid_prompt":
        return { kind: "invalid_prompt" };
      case "server_is_overloaded":
      case "slow_down":
        return { kind: "server_overloaded" };
      default:
        if (args.responseErrorMessage?.includes("try again in")) {
          return { kind: "retryable_rate_limit" };
        }
        return { kind: "unknown_stream_error" };
    }
  }

  if (args.status === 429) {
    switch (args.errorType) {
      case "usage_limit_reached":
        return { kind: "usage_limit_reached" };
      case "usage_not_included":
        return { kind: "usage_not_included" };
      default:
        return { kind: "unknown_429" };
    }
  }

  if (args.status === 503) {
    switch (args.errorCode) {
      case "server_is_overloaded":
      case "slow_down":
        return { kind: "server_overloaded" };
      default:
        return { kind: "unknown_503" };
    }
  }

  if (args.status === 500) {
    return { kind: "internal_server_error" };
  }

  if (args.status === 400) {
    return { kind: "invalid_request" };
  }

  return { kind: "unknown_http_error" };
}
```

## 2. `usage` 接口逻辑

`usage` 不是主对话链路，而是额度和限流窗口的查询接口。建议和 `responses` 错误识别彻底分开处理。

### 2.1 用途

`usage` 接口主要用于读取：

- 当前活跃 limit
- primary / secondary 限流窗口
- credits 或剩余额度快照
- 重置时间

它更像“状态查询接口”，不是“生成请求接口”。

### 2.2 常见路径形态

- `GET {base_url}/api/codex/usage`
- `GET {base_url}/wham/usage`

### 2.3 识别方式

对 `usage` 接口，不建议套用 `responses` 的 `response.failed` 逻辑，而应直接按普通 HTTP/JSON 接口处理：

1. 先看 HTTP 状态码
2. 再解析 JSON body
3. 提取 usage 快照结构
4. 如果失败，只记录为“usage 查询失败”，不要混入 `responses` 的业务错误分类

### 2.4 推荐最小处理策略

- `2xx`
  - 解析并缓存 usage 快照
- `401` / `403`
  - 识别为鉴权或权限问题
- `429`
  - 识别为 usage 查询本身被限流
- `5xx`
  - 识别为 usage 服务端异常
- 其他状态
  - 归类为未知 usage 查询错误

### 2.5 和 `responses` 分开的原因

两类接口的职责不同：

- `responses`
  - 负责生成、流式输出、工具调用
  - 错误识别重点是 `response.failed`、`error.code`、`error.type`
- `usage`
  - 负责查询额度状态
  - 错误识别重点是状态码和快照 JSON 是否可解析

因此建议在 `airouter` 中：

- 一套分类器处理 `responses`
- 另一套轻量分类器处理 `usage`

## 3. 一句话总结

只从接口层看，建议把 Codex 相关错误识别拆成两部分：

- 流式 `responses` 的 `response.failed.response.error.code`
- 普通 HTTP 错误响应里的 `status + error.type/error.code`

其中最关键的几个标识值是：

- `insufficient_quota`
- `usage_limit_reached`
- `usage_not_included`
- `server_is_overloaded`
- `slow_down`
