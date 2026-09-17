#!/usr/bin/env bash
#
# Starts and stops the local conformance fixtures.
#
# The fixtures are long-running servers, so running them by hand means one
# terminal each and a mental map of which port is which. This starts them in the
# background instead, with one log file per fixture, so a test run needs a single
# terminal and the logs stay readable afterwards.
#
#   ./scripts/fixtures.sh start     start every fixture that is not running
#   ./scripts/fixtures.sh status    show what is listening and what is not
#   ./scripts/fixtures.sh logs      follow every fixture log at once
#   ./scripts/fixtures.sh logs channel   follow one fixture's log
#   ./scripts/fixtures.sh stop      stop every fixture this script started
#
# Credentials come from .env, exactly as they do when a fixture is run by hand.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.fixtures"

# name:port:script
FIXTURES=(
  "x402:3001:packages/core/test/fixtures/x402-real-server.ts"
  "charge:3002:packages/core/test/fixtures/mpp-charge-server.ts"
  "channel:3003:packages/core/test/fixtures/mpp-channel-server.ts"
  "refusing:3004:packages/core/test/fixtures/mpp-channel-refusing-server.ts"
)

field() { echo "$1" | cut -d: -f"$2"; }

is_running() {
  local pid_file="$RUN_DIR/$1.pid"
  [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null
}

# Prints the pid listening on a port, or nothing. Never fails: lsof exits
# non-zero when nothing is listening, and under `set -e` that would abort the
# caller instead of simply meaning "the port is free".
port_owner() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

start_one() {
  local name port script pid_file log_file owner
  name="$(field "$1" 1)"; port="$(field "$1" 2)"; script="$(field "$1" 3)"
  pid_file="$RUN_DIR/$name.pid"; log_file="$RUN_DIR/$name.log"

  if is_running "$name"; then
    printf "  %-9s already running on :%s (pid %s)\n" "$name" "$port" "$(cat "$pid_file")"
    return
  fi

  owner="$(port_owner "$port")"
  if [ -n "$owner" ]; then
    printf "  %-9s port :%s is taken by pid %s, not started\n" "$name" "$port" "$owner"
    echo "         stop that process first, or run './scripts/fixtures.sh stop'"
    return
  fi

  ( cd "$ROOT" && nohup npx tsx "$script" >"$log_file" 2>&1 & echo $! >"$pid_file" )
  sleep 3

  if is_running "$name" && [ -n "$(port_owner "$port")" ]; then
    printf "  %-9s listening on :%s  (log: .fixtures/%s.log)\n" "$name" "$port" "$name"
  else
    printf "  %-9s FAILED to start, last lines of .fixtures/%s.log:\n" "$name" "$name"
    tail -5 "$log_file" | sed 's/^/         /'
    rm -f "$pid_file"
  fi
}

cmd_start() {
  mkdir -p "$RUN_DIR"
  if [ ! -f "$ROOT/.env" ]; then
    echo "No .env found at the repo root. The fixtures need it. Aborting." >&2
    exit 1
  fi
  echo "Starting fixtures:"
  for fixture in "${FIXTURES[@]}"; do start_one "$fixture"; done
  echo
  echo "Targets:"
  echo "  x402     http://localhost:3001/protected"
  echo "  charge   http://localhost:3002/data"
  echo "  channel  http://localhost:3003/data"
  echo "  refusing http://localhost:3004/data   (always refuses, by design)"
}

cmd_stop() {
  echo "Stopping fixtures:"
  for fixture in "${FIXTURES[@]}"; do
    local name pid_file
    name="$(field "$fixture" 1)"; pid_file="$RUN_DIR/$name.pid"
    if is_running "$name"; then
      pkill -P "$(cat "$pid_file")" 2>/dev/null || true
      kill "$(cat "$pid_file")" 2>/dev/null || true
      printf "  %-9s stopped\n" "$name"
    else
      printf "  %-9s was not running\n" "$name"
    fi
    rm -f "$pid_file"
  done
}

cmd_status() {
  for fixture in "${FIXTURES[@]}"; do
    local name port owner
    name="$(field "$fixture" 1)"; port="$(field "$fixture" 2)"
    owner="$(port_owner "$port")"
    if [ -n "$owner" ]; then
      printf "  %-9s UP    :%s (pid %s)\n" "$name" "$port" "$owner"
    else
      printf "  %-9s DOWN  :%s\n" "$name" "$port"
    fi
  done
}

cmd_logs() {
  if [ $# -gt 0 ]; then
    tail -f "$RUN_DIR/$1.log"
  else
    tail -f "$RUN_DIR"/*.log
  fi
}

case "${1:-}" in
  start)  cmd_start ;;
  stop)   cmd_stop ;;
  status) cmd_status ;;
  logs)   shift; cmd_logs "$@" ;;
  *)
    echo "usage: ./scripts/fixtures.sh {start|stop|status|logs [name]}" >&2
    exit 1
    ;;
esac
