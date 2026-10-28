#!/usr/bin/env bash
# Milestone 6 verification run: shared refresh, matching evaluation, performance benchmark.
#
#   bash test/run-m6.sh              # full run (benchmark on the 10 000-case database)
#   bash test/run-m6.sh --no-bench    # skip the benchmark (refresh + matching only)
#
#   * refresh-m6.mjs — one shared update across My work, case, institution, coordination and report
#     views, ≤10 s, refresh after local writes, timer lifecycle, account switching, no restricted leak
#     on refresh;
#   * matching-eval.ts — reproducible labelled set, tuned/held-out split, class-level precision and
#     recall, confusion counts, false positives, misses, runtime, exact-ID overlap;
#   * bench.mjs — 10 000 synthetic cases / 100 institutions, single-session boundaries, 20 concurrent
#     authenticated sessions, p50/p95, error counts. The result JSON is written to docs/.
#
# The benchmark rewrites its own isolated database (data/bench) and never touches data/caselink.db.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT=${PORT:-8106}
DATA=${CASELINK_M6_DATA:-/tmp/caselink-m6}
BENCH=${CASELINK_BENCH_DB:-data/bench}
RUN_BENCH=1
[ "${1:-}" = "--no-bench" ] && RUN_BENCH=0
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

section "Fresh isolated database + API on :$PORT"
rm -rf "$DATA"
CASELINK_DATA_DIR="$DATA" npx tsx server/src/seed.ts --force >"/tmp/seed-$PORT.log" 2>&1 || {
  echo "seed failed"; tail -5 "/tmp/seed-$PORT.log"; exit 1; }
setsid env CASELINK_DATA_DIR="$DATA" PORT="$PORT" CASELINK_TEST_HOOKS=true \
  npx tsx server/src/index.ts >"/tmp/server-$PORT.log" 2>&1 &
PIDS+=("$!")
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 && break; sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1 || {
  echo "instance on $PORT did not become healthy"; tail -20 "/tmp/server-$PORT.log"; exit 1; }

section "Shared timed refresh across views (headless Chromium)"
BASE="http://127.0.0.1:$PORT" node test/refresh-m6.mjs || FAILED=1

section "Matching evaluation (labelled set, tuned/held-out, exact-ID overlap)"
npx tsx test/matching-eval.ts || FAILED=1

if [ "$RUN_BENCH" -eq 1 ]; then
  section "Performance benchmark (10 000 cases / 100 institutions / 20 concurrent sessions)"
  # Stop the seed instance so the benchmark has the machine to itself.
  stop_port "$PORT"
  CASELINK_BENCH_DB="$BENCH" node test/bench.mjs --reseed || FAILED=1
  CASELINK_BENCH_DB="$BENCH" node test/bench.mjs || FAILED=1
else
  echo; echo "benchmark skipped on request (--no-bench)"
fi

echo
if [ "$FAILED" -ne 0 ]; then echo "M6 verification: FAILURES PRESENT"; exit 1; fi
echo "M6 verification: ALL SUITES PASSED"
