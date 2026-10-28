#!/usr/bin/env bash
# Milestone 3 verification run.
#
#   bash test/run-m3.sh
#
#   * seeds a fresh isolated database (never the working one) and starts the API with the admin-only
#     fault-injection hooks enabled, which the acceptance suite needs to prove rollback;
#   * runs the M3 lifecycle/outcome/reporting suite against that instance;
#   * runs the migration check against a *copy* of the existing database, proving an upgrade in place
#     keeps every record and is idempotent;
#   * re-runs the acceptance suite and the M2 privacy suite so M3 cannot regress earlier milestones.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8103}
DATA=${CASELINK_M3_DATA:-/tmp/caselink-m3}
FAILED=0

port_free() { ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$1 "; }
if ! port_free "$PORT"; then
  echo "port $PORT is already in use — stop that process and re-run"
  exit 1
fi

section() { echo; echo "=============== $1 ==============="; }

section "Fresh isolated database + API on :$PORT"
rm -rf "$DATA"
CASELINK_DATA_DIR="$DATA" npx tsx server/src/seed.ts --force >/tmp/seed-$PORT.log 2>&1 || {
  echo "seed failed"; tail -5 /tmp/seed-$PORT.log; exit 1; }
start_server() {
  setsid env CASELINK_DATA_DIR="$DATA" PORT="$PORT" CASELINK_TEST_HOOKS=true \
    npx tsx server/src/index.ts >/tmp/server-$PORT.log 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "instance did not become healthy"; tail -20 /tmp/server-$PORT.log; return 1
}
stop_server() {
  # Kill by port owner: the pid recorded from `setsid ... &` is only the session leader, and a stale
  # instance would otherwise keep writing to a database file we are about to replace.
  local owner
  owner=$(ss -ltnp 2>/dev/null | grep ":$PORT " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  if [ -n "${owner:-}" ]; then kill -TERM "$owner" 2>/dev/null; fi
  kill -TERM -- "-$SERVER_PID" 2>/dev/null
  for _ in $(seq 1 60); do port_free "$PORT" && return 0; sleep 0.25; done
  if [ -n "${owner:-}" ]; then kill -KILL "$owner" 2>/dev/null; fi
  return 0
}
cleanup() { stop_server; }
trap cleanup EXIT

start_server || exit 1

section "M3 lifecycle, outcomes and reporting"
BASE="http://127.0.0.1:$PORT" CASELINK_DB="$DATA/caselink.db" node test/lifecycle-m3.mjs || FAILED=1

section "Acceptance suite T01–T12 (same instance)"
node test/acceptance.mjs "http://127.0.0.1:$PORT" || FAILED=1

section "M2 relationship privacy regressions (fresh instance: the suite builds its own pair)"
stop_server
rm -rf "$DATA"
CASELINK_DATA_DIR="$DATA" npx tsx server/src/seed.ts --force >/tmp/seed-m2.log 2>&1 || {
  echo "seed failed"; tail -5 /tmp/seed-m2.log; exit 1; }
start_server || exit 1
BASE="http://127.0.0.1:$PORT" CASELINK_DB="$DATA/caselink.db" node test/security-m2.mjs || FAILED=1

section "In-place migration of a copy of the existing database"
node test/migration-check.mjs "${CASELINK_SOURCE_DB:-data/caselink.db}" || FAILED=1

echo
if [ "$FAILED" -ne 0 ]; then echo "M3 verification: FAILURES PRESENT"; exit 1; fi
echo "M3 verification: ALL SUITES PASSED"
