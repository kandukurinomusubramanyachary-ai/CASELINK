#!/usr/bin/env bash
# Milestone 4 verification run.
#
#   bash test/run-m4.sh
#
#   * M4 concurrency/transaction/retry suite on a fresh isolated database with the admin-only fault
#     injection enabled (needed to prove rollback);
#   * the same suite against an instance where the hooks are *off*, to show the fault-injection checks
#     are reported as skipped, never as passes;
#   * the M3 lifecycle suite, the acceptance suite T01–T12, the M2 privacy suite (fresh instance) and
#     the in-place migration check, so M4 cannot regress earlier milestones.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8104}
PORT_NOHOOK=${PORT_NOHOOK:-8108}
PORT_M2=${PORT_M2:-8109}
DATA=${CASELINK_M4_DATA:-/tmp/caselink-m4}
DATA_NOHOOK=${CASELINK_M4_NOHOOK_DATA:-/tmp/caselink-m4-nohook}
DATA_M2=${CASELINK_M4_M2_DATA:-/tmp/caselink-m4-m2}
FAILED=0

port_free() { ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$1 "; }
for p in "$PORT" "$PORT_NOHOOK" "$PORT_M2"; do
  if ! port_free "$p"; then echo "port $p is already in use — stop that process and re-run"; exit 1; fi
done

section() { echo; echo "=============== $1 ==============="; }

PIDS=()
# Stop whatever instance owns a port (the `setsid` pid is only the session leader, so a stale process
# could otherwise keep writing to a database file we are about to replace).
stop_port() {
  local owner
  owner=$(ss -ltnp 2>/dev/null | grep ":$1 " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  [ -n "${owner:-}" ] && kill -TERM "$owner" 2>/dev/null
  for _ in $(seq 1 60); do port_free "$1" && return 0; sleep 0.25; done
  [ -n "${owner:-}" ] && kill -KILL "$owner" 2>/dev/null
  return 0
}
cleanup() { for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null; done; stop_port "$PORT"; stop_port "$PORT_NOHOOK"; stop_port "$PORT_M2"; wait 2>/dev/null; }
trap cleanup EXIT

seed_and_start() { # port data hooks
  local port=$1 data=$2 hooks=$3
  rm -rf "$data"
  CASELINK_DATA_DIR="$data" npx tsx server/src/seed.ts --force >"/tmp/seed-$port.log" 2>&1 || {
    echo "seed failed"; tail -5 "/tmp/seed-$port.log"; exit 1; }
  if [ "$hooks" = "true" ]; then
    setsid env CASELINK_DATA_DIR="$data" PORT="$port" CASELINK_TEST_HOOKS=true \
      npx tsx server/src/index.ts >"/tmp/server-$port.log" 2>&1 &
  else
    setsid env CASELINK_DATA_DIR="$data" PORT="$port" CASELINK_TEST_HOOKS=false \
      npx tsx server/src/index.ts >"/tmp/server-$port.log" 2>&1 &
  fi
  PIDS+=("$!")
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "instance on $port did not become healthy"; tail -20 "/tmp/server-$port.log"; exit 1
}

section "Fresh isolated database + API with test hooks on :$PORT"
seed_and_start "$PORT" "$DATA" true

section "M4 concurrency, transactions, retries (hooks on)"
BASE="http://127.0.0.1:$PORT" CASELINK_DB="$DATA/caselink.db" node test/concurrency-m4.mjs || FAILED=1

section "M3 lifecycle, outcomes and reporting"
BASE="http://127.0.0.1:$PORT" CASELINK_DB="$DATA/caselink.db" node test/lifecycle-m3.mjs || FAILED=1

section "Acceptance suite T01–T12"
node test/acceptance.mjs "http://127.0.0.1:$PORT" || FAILED=1

section "M4 suite on an instance with the fault-injection hook disabled :$PORT_NOHOOK"
seed_and_start "$PORT_NOHOOK" "$DATA_NOHOOK" false
NOHOOK_OUT=$(BASE="http://127.0.0.1:$PORT_NOHOOK" CASELINK_DB="$DATA_NOHOOK/caselink.db" node test/concurrency-m4.mjs 2>&1)
echo "$NOHOOK_OUT" | tail -8
echo "$NOHOOK_OUT" | grep -q "M4 concurrency, transactions and retries: PASS" || FAILED=1
echo "$NOHOOK_OUT" | grep -qE "skipped: [1-9]" || { echo "expected the hook-dependent checks to be reported as skipped"; FAILED=1; }
echo "$NOHOOK_OUT" | grep -q "PASS  5a a failed upload" && { echo "a hook-dependent check reported as a pass while the hook was off"; FAILED=1; }

section "M2 relationship privacy regressions (own fresh instance on :$PORT_M2: the suite builds its pair)"
seed_and_start "$PORT_M2" "$DATA_M2" false
BASE="http://127.0.0.1:$PORT_M2" CASELINK_DB="$DATA_M2/caselink.db" node test/security-m2.mjs || FAILED=1

section "In-place migration of a copy of the existing database"
node test/migration-check.mjs "${CASELINK_SOURCE_DB:-data/caselink.db}" || FAILED=1

echo
if [ "$FAILED" -ne 0 ]; then echo "M4 verification: FAILURES PRESENT"; exit 1; fi
echo "M4 verification: ALL SUITES PASSED"
