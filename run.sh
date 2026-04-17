#!/usr/bin/env bash

PID_FILE="openai.pid"
LOG_FILE="openai.log"
CONFIG_FILE="openai.json"
STARTUP_CHECK_DELAY_SECONDS="${STARTUP_CHECK_DELAY_SECONDS:-10}"
STARTUP_LOG_LINES="${STARTUP_LOG_LINES:-20}"

PROXY_PORT=$(jq -r '.proxy_port' "$CONFIG_FILE")
PORT=$(jq -r '.port // 3000' "$CONFIG_FILE")

START_CMD="CONFIG=${CONFIG_FILE} PORT=${PORT} https_proxy=http://127.0.0.1:${PROXY_PORT} http_proxy=http://127.0.0.1:${PROXY_PORT} all_proxy=socks5://127.0.0.1:${PROXY_PORT} nohup node openai.js > ${LOG_FILE} 2>&1 &"

is_pid_running() {
  ps -p "$1" >/dev/null 2>&1
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

  new_logs=$(tail -n "$STARTUP_LOG_LINES" "$LOG_FILE")

  if [ -n "$new_logs" ]; then
    echo "recent logs:"
    printf '%s\n' "$new_logs"
  fi
}

start() {
  if [ -f "$PID_FILE" ] && is_pid_running "$(current_pid)"; then
    echo "stopping existing pid=$(current_pid)"
    kill "$(current_pid)"
    rm -f "$PID_FILE"
  else
    rm -f "$PID_FILE"
  fi

  echo "starting"
  eval "$START_CMD"
  echo $! > "$PID_FILE"
  sleep "$STARTUP_CHECK_DELAY_SECONDS"

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
  tail -n "$STARTUP_LOG_LINES" -f "$LOG_FILE"
}

stop() {
  if [ -f "$PID_FILE" ] && is_pid_running "$(current_pid)"; then
    kill "$(current_pid)"
    rm -f "$PID_FILE"
    echo "stopped"
  else
    rm -f "$PID_FILE"
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
