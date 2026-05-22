# CCX Protocol Conversion

Airouter exposes an isolated CCX compatibility router under `/ccx`. Existing `/v1/*`
routes keep their previous behavior.

## Routes

- `POST /ccx/v1/responses`
- `POST /ccx/v1/responses/compact`
- `POST /ccx/v1/messages`
- `POST /ccx/v1/chat/completions`

The downstream protocol is detected from the route:

- `responses`: OpenAI Responses API
- `messages`: Claude Messages API
- `chat`: OpenAI Chat Completions API

## Configuration

The optional `ccx` block controls the upstream protocol. Defaults enable only the
Responses upstream:

```json
{
  "ccx": {
    "enabled": true,
    "upstream_protocol": "responses",
    "enabled_upstream_protocols": ["responses"],
    "cache": {
      "enabled": true,
      "prompt_cache_retention": null
    }
  }
}
```

Supported `upstream_protocol` values are `responses`, `messages`, and `chat`.
`messages` requires an apikey config with `support: ["claude"]`; `responses`
and `chat` use token configs or apikey configs with `support: ["gpt"]`.

`ccx.cache.enabled` is enabled by default. When CCX converts a downstream
request into a Responses or Chat upstream request, it copies a stable session
identifier into `prompt_cache_key` when the client supplied one through
`Conversation_id`, `Session_id`, `X-Claude-Code-Session-Id`,
`X-Client-Request-Id`, `X-Gemini-Api-Privileged-User-Id`, request `user`,
request `prompt_cache_key`, or `metadata.user_id`.

`ccx.cache.prompt_cache_retention` may be set to `in_memory` or `24h`. It is
only injected for apikey-backed GPT upstreams; token-backed Codex upstreams
currently reject the standard `prompt_cache_retention` parameter and also reject
`metadata`, `user`, and `previous_response_id`.

## Conversion Behavior

When the downstream protocol matches the configured upstream protocol, CCX
forwards the request and response without JSON normalization. Local auth headers
and hop-by-hop headers are still removed before forwarding upstream.

When protocols differ, CCX converts through a Responses-shaped canonical form:

- `messages -> responses/chat`
- `chat -> responses/messages`
- `responses -> messages/chat`

The conversion preserves roles, text, image URLs/base64 inputs, tools, tool
calls, tool outputs, usage, and basic streaming text/tool deltas where the target
protocol can express them. Provider-specific fields that have no target-protocol
equivalent are best-effort and are not byte-for-byte lossless.

Prompt-cache usage is preserved across converted responses. Responses
`usage.input_tokens_details.cached_tokens`, Chat Completions
`usage.prompt_tokens_details.cached_tokens`, and Claude Messages
`usage.cache_read_input_tokens` are mapped into the downstream protocol's usage
shape. A zero value means the selected upstream did not report a cache hit, not
that CCX dropped the field.

Same-protocol passthrough remains byte-level passthrough for request bodies:
CCX does not add `prompt_cache_key` or `prompt_cache_retention` in that path.

## Local Session

For converted Responses requests that target a non-Responses upstream, CCX keeps
an in-memory mapping from `response.id` to local session history. This lets a
later `previous_response_id` expand into full Chat or Claude Messages context.

The local session store is process memory only. It is cleared on restart and is
bounded by these defaults:

- 24 hours max age
- 100 messages
- 100000 tokens

## Compact

`POST /ccx/v1/responses/compact` first tries native Responses compact when the
upstream protocol is `responses`. If native compact is unsupported with 404,
405, or 501, or if the upstream is `messages` or `chat`, CCX builds a local
transcript from the in-memory session plus the current input and asks the
configured upstream to summarize it.
