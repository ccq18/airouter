#!/usr/bin/env bash

PID_FILE="openai.pid"
LOG_FILE="openai.log"
CONFIG_FILE="openai.json"

read_config_value() {
  node -e '
const fs = require("fs");
const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const key = process.argv[2];
const fallback = process.argv[3];
const value = config[key];

if (value === undefined || value === null) {
  process.stdout.write(fallback);
} else {
  process.stdout.write(String(value));
}
' "$CONFIG_FILE" "$1" "$2"
}

PROXY_PORT=$(read_config_value proxy_port "")
PORT=$(read_config_value port "3009")
START_CMD="CONFIG=${CONFIG_FILE} PORT=${PORT} https_proxy=http://127.0.0.1:${PROXY_PORT} http_proxy=http://127.0.0.1:${PROXY_PORT} all_proxy=socks5://127.0.0.1:${PROXY_PORT} nohup node openai.js > ${LOG_FILE} 2>&1 &"

real_sleep_ms() {
  node -e 'setTimeout(() => process.exit(0), Number(process.argv[1]));' "$1"
}

is_pid_running() {
  kill -0 "$1" >/dev/null 2>&1
}

wait_for_pid_exit() {
  local pid="$1"
  local timeout_ms="${2:-5000}"
  local waited_ms=0

  while is_pid_running "$pid"; do
    if [ "$waited_ms" -ge "$timeout_ms" ]; then
      return 1
    fi

    real_sleep_ms 100
    waited_ms=$((waited_ms + 100))
  done

  return 0
}

terminate_pid() {
  local pid="$1"

  if ! is_pid_running "$pid"; then
    return 0
  fi

  kill "$pid" >/dev/null 2>&1 || true
  if wait_for_pid_exit "$pid" 5000; then
    return 0
  fi

  kill -9 "$pid" >/dev/null 2>&1 || true
  wait_for_pid_exit "$pid" 1000
}

port_listener_pids() {
  local port_pid

  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi

  lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | sort -u | while IFS= read -r port_pid; do
    if [ -n "$port_pid" ] && is_pid_running "$port_pid"; then
      printf '%s\n' "$port_pid"
    fi
  done
}

stop_port_listeners() {
  local port_pids
  local port_pid

  port_pids=$(port_listener_pids)
  if [ -z "$port_pids" ]; then
    return 0
  fi

  while IFS= read -r port_pid; do
    if [ -z "$port_pid" ] || ! is_pid_running "$port_pid"; then
      continue
    fi

    echo "stopping existing port listener pid=${port_pid} port=${PORT}"
    if ! terminate_pid "$port_pid"; then
      return 1
    fi
  done <<EOF
$port_pids
EOF

  return 0
}

current_pid() {
  cat "$PID_FILE"
}

show_proxy_urls() {
  echo "openai proxy: http://localhost:${PORT}/v1"
  echo "claude proxy: http://localhost:${PORT}/claude"
}

show_startup_logs() {
  if [ ! -f "$LOG_FILE" ]; then
    echo "no log output captured"
    return
  fi

  local new_logs

  new_logs=$(tail -n 20 "$LOG_FILE")

  if [ -n "$new_logs" ]; then
    echo "recent logs:"
    printf '%s\n' "$new_logs"
  fi
}

start() {
  if [ -f "$PID_FILE" ]; then
    local existing_pid
    existing_pid=$(current_pid)

    if is_pid_running "$existing_pid"; then
      echo "stopping existing pid=${existing_pid}"
      if ! terminate_pid "$existing_pid"; then
        echo "failed to stop existing pid=${existing_pid}"
        return 1
      fi
    fi

    rm -f "$PID_FILE"
  fi

  if ! stop_port_listeners; then
    echo "failed to stop listener on port=${PORT}"
    return 1
  fi

  echo "starting"
  eval "$START_CMD"
  echo $! > "$PID_FILE"
  sleep 10
  real_sleep_ms 250

  if ! is_pid_running "$(current_pid)"; then
    echo "failed to start"
    show_startup_logs
    rm -f "$PID_FILE"
    return 1
  fi

  echo "started pid=$(current_pid)"
  show_proxy_urls
  show_startup_logs
}

logs() {
  touch "$LOG_FILE"
  tail -n 100 -f "$LOG_FILE"
}

stop() {
  local stopped_any=0
  local active_port_listeners

  if [ -f "$PID_FILE" ]; then
    local existing_pid
    existing_pid=$(current_pid)

    if is_pid_running "$existing_pid"; then
      if ! terminate_pid "$existing_pid"; then
        echo "failed to stop pid=${existing_pid}"
        return 1
      fi
      rm -f "$PID_FILE"
      stopped_any=1
    else
      rm -f "$PID_FILE"
    fi
  fi

  active_port_listeners=$(port_listener_pids)
  if [ -n "$active_port_listeners" ]; then
    stopped_any=1
  fi

  if ! stop_port_listeners; then
    echo "failed to stop listener on port=${PORT}"
    return 1
  fi

  if [ "$stopped_any" -eq 1 ]; then
    echo "stopped"
  else
    echo "not running"
  fi
}

restart() {
  stop
  start
}

case "$1" in
  logs)
    logs
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  ""|start)
    start
    ;;
  *)
    echo "usage: ./run.sh [start|stop|restart|logs]"
    ;;
esac
