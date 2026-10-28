#!/usr/bin/env bash
# Milestone 5 verification run.
#
#   bash test/run-m5.sh
#
#   * the M5 CSV import suite (preview/commit binding, classification, idempotent retries,
#     attachment rollback) on a fresh isolated database;
#   * the acceptance suite T01–T12 against the same instance, so the import paths of the product
#     still satisfy the cross-milestone acceptance list;
#   * the in-place migration check, which covers the v4 batch-provenance migration and the
#     normalised import identity backfill (17 checks).
#
# The source database (data/caselink.db by default) is only ever read — the migration check copies it
# before running anything against the copy.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8105}
DATA=${CASELINK_M5_DATA:-/tmp/caselink-m5}
FAILED=0

port_free() { ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$1 "; }
if ! port_free "$PORT"; then echo "port $PORT is already in use — stop that process and re-run"; exit 1; fi

section() { echo; echo "=============== $1 ==============="; }

stop_port() {
  local owner
  owner=$(ss -ltnp 2>/dev/null | grep ":$1 " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -1)
  [ -n "${owner:-}" ] && kill -TERM "$owner" 2>/dev/null
  for _ in $(seq 1 60); do port_free "$1" && return 0; sleep 0.25; done
  [ -n "${owner:-}" ] && kill -KILL "$owner" 2>/dev/null
  return 0
}
PIDS=()
cleanup() { for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null; done; stop_port "$PORT"; wait 2>/dev/null; }
trap cleanup EXIT

seed_and_start() { # port data hooks
  local port=$1 data=$2 hooks=$3
  rm -rf "$data"
  CASELINK_DATA_DIR="$data" npx tsx server/src/seed.ts --force >"/tmp/seed-$port.log" 2>&1 || {
    echo "seed failed"; tail -5 "/tmp/seed-$port.log"; exit 1; }
  setsid env CASELINK_DATA_DIR="$data" PORT="$port" CASELINK_TEST_HOOKS="$hooks" \
    npx tsx server/src/index.ts >"/tmp/server-$port.log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 60); do
    curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "instance on $port did not become healthy"; tail -20 "/tmp/server-$port.log"; exit 1
}

section "Fresh isolated database + API with test hooks on :$PORT"
seed_and_start "$PORT" "$DATA" true

section "M5 CSV import: template, preview, classification, commit, retries"
BASE="http://127.0.0.1:$PORT" CASELINK_DB="$DATA/caselink.db" node test/import-m5.mjs || FAILED=1

section "Acceptance suite T01–T12 (the same instance, after the imports)"
node test/acceptance.mjs "http://127.0.0.1:$PORT" || FAILED=1

section "In-place migration of a copy of the existing database (v4 batch provenance + identity backfill)"
node test/migration-check.mjs "${CASELINK_SOURCE_DB:-data/caselink.db}" || FAILED=1

echo
if [ "$FAILED" -ne 0 ]; then echo "M5 verification: FAILURES PRESENT"; exit 1; fi
echo "M5 verification: ALL SUITES PASSED"
