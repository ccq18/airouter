#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3009}"
MODEL="${MODEL:-gpt-5.4}"
API_KEY="${API_KEY:-}"
CURL_MAX_TIME="${CURL_MAX_TIME:-180}"
REQUEST_RETRIES="${REQUEST_RETRIES:-2}"
OUT_DIR="${OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/airouter-ccx-smoke.XXXXXX")}"

mkdir -p "$OUT_DIR"

headers=(-H "Content-Type: application/json")
if [[ -n "$API_KEY" ]]; then
  headers+=(-H "Authorization: Bearer $API_KEY")
fi

quote_arg() {
  printf "%q" "$1"
}

single_quote() {
  printf "'"
  printf "%s" "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

print_curl_command() {
  local path="$1"
  local payload="$2"
  local accept="$3"

  printf 'curl -sS'
  printf ' --connect-timeout 10'
  printf ' --max-time %s' "$(quote_arg "$CURL_MAX_TIME")"
  printf ' -H %s' "$(quote_arg "Content-Type: application/json")"
  if [[ -n "$API_KEY" ]]; then
    printf ' -H %s' "$(quote_arg "Authorization: Bearer \$API_KEY")"
  fi
  printf ' -H %s' "$(quote_arg "Accept: $accept")"
  printf ' %s' "$(quote_arg "$BASE_URL$path")"
  printf ' --data-raw '
  single_quote "$payload"
  printf '\n'
}

build_payload() {
  PAYLOAD_KIND="$1" MODEL="$MODEL" node <<'NODE'
const model = process.env.MODEL || 'gpt-5.4';
const kind = process.env.PAYLOAD_KIND;

const responsesInput = text => ([
  {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  },
]);

const payloads = {
  responses_stream: {
    model,
    stream: true,
    store: false,
    instructions: 'Reply with exactly CCX_RESPONSES_OK and no extra text.',
    input: responsesInput('Reply exactly: CCX_RESPONSES_OK'),
  },
  messages_nonstream: {
    model,
    stream: false,
    max_tokens: 64,
    system: 'Reply with exactly the token requested by the user.',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'Reply exactly: CCX_MESSAGES_OK' }],
      },
    ],
  },
  chat_nonstream: {
    model,
    stream: false,
    max_tokens: 64,
    messages: [
      { role: 'system', content: 'Reply with exactly the token requested by the user.' },
      { role: 'user', content: 'Reply exactly: CCX_CHAT_OK' },
    ],
  },
  chat_stream: {
    model,
    stream: true,
    max_tokens: 64,
    messages: [
      { role: 'system', content: 'Reply with exactly the token requested by the user.' },
      { role: 'user', content: 'Reply exactly: CCX_CHAT_STREAM_OK' },
    ],
  },
  compact: {
    model,
    instructions: 'Create a compact summary of the supplied context.',
    input: responsesInput('Compact this context and preserve this marker: CCX_COMPACT_CONTEXT'),
  },
};

if (!payloads[kind]) {
  console.error(`unknown payload kind: ${kind}`);
  process.exit(1);
}

process.stdout.write(JSON.stringify(payloads[kind], null, 2));
NODE
}

post_json() {
  local label="$1"
  local path="$2"
  local payload="$3"
  local output="$4"
  local accept="${5:-application/json}"
  local code
  local attempt=1

  printf '\n==> %s\n' "$label"
  printf 'request body:\n%s\n' "$payload"
  print_curl_command "$path" "$payload" "$accept"
  while true; do
    code="$(
      curl -sS \
        --connect-timeout 10 \
        --max-time "$CURL_MAX_TIME" \
        -o "$output" \
        -w '%{http_code}' \
        "${headers[@]}" \
        -H "Accept: $accept" \
        "$BASE_URL$path" \
        --data-raw "$payload"
    )"

    if [[ "$code" =~ ^2[0-9][0-9]$ ]]; then
      break
    fi

    if [[ "$attempt" -lt "$REQUEST_RETRIES" && "$code" =~ ^(408|429|5[0-9][0-9])$ ]]; then
      printf 'HTTP %s, retrying (%s/%s)...\n' "$code" "$attempt" "$REQUEST_RETRIES" >&2
      attempt=$((attempt + 1))
      sleep "$attempt"
      continue
    fi

    printf 'HTTP %s\n' "$code" >&2
    sed -n '1,80p' "$output" >&2
    return 1
  done

  printf 'HTTP %s -> %s\n' "$code" "$output"
}

validate_json() {
  local label="$1"
  local output="$2"
  local script="$3"
  LABEL="$label" OUTPUT="$output" SCRIPT="$script" node <<'NODE'
const fs = require('fs');
const label = process.env.LABEL;
const output = process.env.OUTPUT;
const script = process.env.SCRIPT;
const raw = fs.readFileSync(output, 'utf8');
let payload;
try {
  payload = JSON.parse(raw);
} catch (error) {
  console.error(`${label}: response is not valid JSON`);
  console.error(raw.slice(0, 1200));
  process.exit(1);
}

const fail = message => {
  console.error(`${label}: ${message}`);
  console.error(JSON.stringify(payload, null, 2).slice(0, 1600));
  process.exit(1);
};

const textFromContent = content => Array.isArray(content)
  ? content.map(part => part && (part.text || part.input || part.content || '')).join('')
  : '';

const checks = {
  messages() {
    if (payload.type !== 'message') fail(`expected Claude message type, got ${payload.type}`);
    if (!Array.isArray(payload.content)) fail('expected content array');
    return textFromContent(payload.content);
  },
  chat() {
    if (payload.object !== 'chat.completion') fail(`expected chat.completion, got ${payload.object}`);
    const choice = payload.choices && payload.choices[0];
    if (!choice || !choice.message) fail('expected choices[0].message');
    return choice.message.content || '';
  },
  compact() {
    if (!payload.id && !payload.type && !payload.object) fail('expected compact response metadata');
    if (payload.error) fail(`unexpected error: ${JSON.stringify(payload.error)}`);
    return payload.type || payload.object || payload.id;
  },
};

const value = checks[script]();
console.log(`${label}: ok ${value ? `(${String(value).slice(0, 80)})` : ''}`);
console.log(`${label}: response body:`);
console.log(JSON.stringify(payload, null, 2));
NODE
}

validate_sse() {
  local label="$1"
  local output="$2"
  local mode="$3"
  LABEL="$label" OUTPUT="$output" MODE="$mode" node <<'NODE'
const fs = require('fs');
const label = process.env.LABEL;
const output = process.env.OUTPUT;
const mode = process.env.MODE;
const text = fs.readFileSync(output, 'utf8');

const fail = message => {
  console.error(`${label}: ${message}`);
  console.error(text.slice(0, 1600));
  process.exit(1);
};

if (!/data:/.test(text)) fail('expected SSE data lines');
if (/"type"\s*:\s*"error"/.test(text) || /response\.failed/.test(text)) fail('upstream returned an error event');

if (mode === 'responses') {
  if (!/response\./.test(text)) fail('expected Responses event names');
} else if (mode === 'chat') {
  if (!/chat\.completion\.chunk/.test(text)) fail('expected chat completion chunks');
  if (!/data:\s*\[DONE\]/.test(text)) fail('expected final [DONE] marker');
}

const deltas = [];
let eventCount = 0;
for (const block of text.split(/\n\n+/)) {
  const dataLine = block.split(/\n/).find(line => line.startsWith('data: '));
  if (!dataLine || dataLine.trim() === 'data: [DONE]') continue;
  eventCount += 1;
  try {
    const payload = JSON.parse(dataLine.slice(6));
    if (mode === 'responses' && typeof payload.delta === 'string') deltas.push(payload.delta);
    if (mode === 'chat') {
      const content = payload.choices && payload.choices[0] && payload.choices[0].delta && payload.choices[0].delta.content;
      if (typeof content === 'string') deltas.push(content);
    }
  } catch {
    // Ignore non-JSON SSE data while still reporting the raw preview below.
  }
}

console.log(`${label}: ok (${Buffer.byteLength(text)} bytes, ${eventCount} JSON events)`);
if (deltas.length > 0) {
  console.log(`${label}: aggregated stream text: ${deltas.join('')}`);
}
console.log(`${label}: raw SSE preview:`);
console.log(text.split(/\n/).slice(0, 16).join('\n'));
NODE
}

printf 'BASE_URL=%s\nMODEL=%s\nOUT_DIR=%s\n' "$BASE_URL" "$MODEL" "$OUT_DIR"

responses_stream_payload="$(build_payload responses_stream)"
post_json "responses stream passthrough" \
  "/ccx/v1/responses" \
  "$responses_stream_payload" \
  "$OUT_DIR/responses-stream.sse" \
  "text/event-stream"
validate_sse "responses stream passthrough" "$OUT_DIR/responses-stream.sse" responses

messages_nonstream_payload="$(build_payload messages_nonstream)"
post_json "messages -> responses -> messages" \
  "/ccx/v1/messages" \
  "$messages_nonstream_payload" \
  "$OUT_DIR/messages-nonstream.json.out"
validate_json "messages -> responses -> messages" "$OUT_DIR/messages-nonstream.json.out" messages

chat_nonstream_payload="$(build_payload chat_nonstream)"
post_json "chat -> responses -> chat" \
  "/ccx/v1/chat/completions" \
  "$chat_nonstream_payload" \
  "$OUT_DIR/chat-nonstream.json.out"
validate_json "chat -> responses -> chat" "$OUT_DIR/chat-nonstream.json.out" chat

chat_stream_payload="$(build_payload chat_stream)"
post_json "chat stream conversion" \
  "/ccx/v1/chat/completions" \
  "$chat_stream_payload" \
  "$OUT_DIR/chat-stream.sse" \
  "text/event-stream"
validate_sse "chat stream conversion" "$OUT_DIR/chat-stream.sse" chat

compact_payload="$(build_payload compact)"
post_json "responses compact" \
  "/ccx/v1/responses/compact" \
  "$compact_payload" \
  "$OUT_DIR/compact.json.out"
validate_json "responses compact" "$OUT_DIR/compact.json.out" compact

printf '\nAll CCX smoke requests passed. Output kept in %s\n' "$OUT_DIR"
