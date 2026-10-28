#!/usr/bin/env bash
# Milestone 1 verification run.
#
#   bash test/run-m1.sh
#
# Starts two isolated instances from freshly seeded data:
#   * normal  (CASELINK_DEMO=false) on 8091 — authenticated sign-in only
#   * demo    (CASELINK_DEMO=true)  on 8092 — explicit fixture environment
# and runs the security regressions against the normal instance, the demo checks against the demo
# instance, and the existing suites against the instance they belong to.
set -uo pipefail
cd "$(dirname "$0")/.."

NORMAL_PORT=${NORMAL_PORT:-8091}
DEMO_PORT=${DEMO_PORT:-8092}
DATA_NORMAL=${CASELINK_M1_DATA:-/tmp/caselink-m1-normal}
DATA_DEMO=${CASELINK_M1_DEMO_DATA:-/tmp/caselink-m1-demo}
FAILED=0

start_instance() { # port data demo
  local port=$1 data=$2 demo=$3
  rm -rf "$data"
  CASELINK_DATA_DIR="$data" npx tsx server/src/seed.ts --force >/tmp/seed-$port.log 2>&1 || {
    echo "seed failed on $data"; tail -5 /tmp/seed-$port.log; return 1; }
  setsid env CASELINK_DATA_DIR="$data" PORT="$port" CASELINK_DEMO="$demo" CASELINK_TEST_HOOKS=true \
    npx tsx server/src/index.ts >/tmp/server-$port.log 2>&1 &
  echo $!
}

wait_health() {
  local port=$1
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "instance on $port did not become healthy"; tail -20 /tmp/server-$port.log; return 1
}

# The browser suites need the built interface; build it if it is missing or older than the sources.
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src server/src -newer web/dist/index.html -print -quit 2>/dev/null)" ]; then
  echo "building interface for the browser suites…"
  npx vite build >/tmp/m1-ui-build.log 2>&1 || { echo "UI build failed"; tail -20 /tmp/m1-ui-build.log; exit 1; }
fi

port_free() { ! (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -q ":$1 "; }
for p in "$NORMAL_PORT" "$DEMO_PORT"; do
  if ! port_free "$p"; then
    echo "port $p is already in use — stop the process using it and re-run"
    exit 1
  fi
done

NORMAL_PID=$(start_instance "$NORMAL_PORT" "$DATA_NORMAL" false) || exit 1
DEMO_PID=$(start_instance "$DEMO_PORT" "$DATA_DEMO" true) || exit 1
cleanup() { # each instance runs in its own process group
  kill -TERM -- "-$NORMAL_PID" "-$DEMO_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

wait_health "$NORMAL_PORT" || exit 1
wait_health "$DEMO_PORT" || exit 1

section() { echo; echo "=============== $1 ==============="; }

section "M1 security regressions (demo disabled)"
BASE="http://127.0.0.1:$NORMAL_PORT" CASELINK_DB="$DATA_NORMAL/caselink.db" node test/security-m1.mjs || FAILED=1

section "M1.1 regional authorisation regressions (demo disabled)"
BASE="http://127.0.0.1:$NORMAL_PORT" CASELINK_DB="$DATA_NORMAL/caselink.db" node test/security-m1-1.mjs || FAILED=1

section "M1 demo-mode checks (demo explicitly enabled)"
BASE="http://127.0.0.1:$DEMO_PORT" CASELINK_DEMO=true node test/demo-mode.mjs || FAILED=1

section "Acceptance suite T01–T12 (normal instance)"
node test/acceptance.mjs "http://127.0.0.1:$NORMAL_PORT" || FAILED=1

section "Sign-in suite (normal instance)"
BASE="http://127.0.0.1:$NORMAL_PORT" node test/login-check.mjs || FAILED=1

section "Direct-entry suite (demo instance)"
BASE="http://127.0.0.1:$DEMO_PORT" CASELINK_DEMO=true node test/direct-entry.mjs || FAILED=1

section "Interface smoke / screenshots (normal instance, explicit sign-in)"
BASE="http://127.0.0.1:$NORMAL_PORT" node test/ui-smoke.mjs || FAILED=1

echo
if [ "$FAILED" -ne 0 ]; then echo "M1 verification: FAILURES PRESENT"; exit 1; fi
echo "M1 verification: ALL SUITES PASSED"
