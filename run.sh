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
PORT=$(read_config_value port "3000")

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

  new_logs=$(tail -n 20 "$LOG_FILE")

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
  sleep 10

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
