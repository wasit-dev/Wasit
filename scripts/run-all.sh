#!/usr/bin/env bash
#
# Runs every Wasit suite against the local fixtures in one go.
#
# Starts the fixtures if they are not already up, runs the x402, MPP charge and
# MPP channel suites, prints one summary, and stops the fixtures it started.
#
#   ./scripts/run-all.sh              free checks only (the default)
#   ./scripts/run-all.sh --full       also the checks that settle testnet payments
#   ./scripts/run-all.sh --keep       leave the fixtures running afterwards
#   ./scripts/run-all.sh --npm        run the published CLI instead of this checkout
#
# Free checks: X402-01..05 and MPP-10..12/14. --full adds X402-06/07, which
# settle or attempt a payment, and MPP-01, which settles one on every run
# (charge mode has no read-only form). MPP-13 never runs here: it closes a
# channel permanently and needs its own explicit opt-in.
#
# Credentials come from .env at the repo root, for the fixtures and the CLI
# alike. Exit code follows the CLI's: 0 all conformed, 1 at least one failure,
# 2 at least one check produced no verdict; a failure outranks a missing one.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.fixtures"

FULL=0
KEEP=0
USE_NPM=0
for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --keep) KEEP=1 ;;
    --npm)  USE_NPM=1 ;;
    *)
      echo "usage: ./scripts/run-all.sh [--full] [--keep] [--npm]" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$ROOT/.env" ]; then
  echo "No .env found at the repo root. The fixtures and the CLI need it." >&2
  exit 2
fi

# Which CLI runs the checks. The checkout is the default so a change can be
# tested before it is published; --npm checks what a user actually installs.
if [ "$USE_NPM" = 1 ]; then
  WASIT=(npx -y @wasit-dev/cli@latest)
else
  if [ ! -f "$ROOT/packages/cli/dist/index.js" ]; then
    echo "No build found; running npm run build first."
    (cd "$ROOT" && npm run build >/dev/null)
  fi
  WASIT=(node "$ROOT/packages/cli/dist/index.js")
fi

# Fixtures already up are left alone, so a run never stops servers someone
# else started.
fixtures_up() {
  local port
  for port in 3001 3002 3003; do
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || return 1
  done
}

STARTED=0
cleanup() {
  if [ "$STARTED" = 1 ] && [ "$KEEP" = 0 ]; then
    "$ROOT/scripts/fixtures.sh" stop >/dev/null 2>&1 || true
    echo "Fixtures stopped."
  fi
}
trap cleanup EXIT

mkdir -p "$LOG_DIR"
if fixtures_up; then
  echo "Fixtures already running; using them."
else
  echo "Starting fixtures..."
  # Output goes to a file: the fixtures run in the background and would hold a
  # pipe open, so piping this command would never return.
  "$ROOT/scripts/fixtures.sh" start >"$LOG_DIR/run-all-start.log" 2>&1
  STARTED=1
  for _ in $(seq 1 30); do
    fixtures_up && break
    sleep 1
  done
  if ! fixtures_up; then
    echo "Fixtures did not come up. See $LOG_DIR/run-all-start.log" >&2
    exit 2
  fi
fi

# name|arguments, run in this order.
SUITES=()
if [ "$FULL" = 1 ]; then
  SUITES+=("x402|test --target http://localhost:3001/protected")
  SUITES+=("mpp-charge|mpp-charge --target http://localhost:3002/data")
  echo "Mode: full. X402-06/07 and MPP-01 move testnet funds."
else
  SUITES+=("x402|test --target http://localhost:3001/protected --read-only")
  echo "Mode: free checks only. Pass --full to include the payment checks."
fi
SUITES+=("mpp-channel|mpp-channel --target http://localhost:3003/data")

# The CLI reads .env from its working directory.
cd "$ROOT"

WORST=0
SUMMARY=()
for suite in "${SUITES[@]}"; do
  name="${suite%%|*}"
  read -r -a args <<<"${suite#*|}"
  echo
  echo "=== $name"
  set +e
  "${WASIT[@]}" "${args[@]}"
  code=$?
  set -e
  case "$code" in
    0) verdict="conformant" ;;
    1) verdict="non-conformant" ;;
    2) verdict="no verdict" ;;
    *) verdict="exited $code" ;;
  esac
  if [ "$code" = 1 ]; then
    WORST=1
  elif [ "$code" != 0 ] && [ "$WORST" = 0 ]; then
    WORST=2
  fi
  SUMMARY+=("$(printf "  %-12s %s" "$name" "$verdict")")
done

echo
echo "=== Summary"
printf "%s\n" "${SUMMARY[@]}"
exit "$WORST"
