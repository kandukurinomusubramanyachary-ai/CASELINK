#!/usr/bin/env bash
# Starts CaseLink on port ${PORT:-8080}. Run as: bash start.sh  (or ./start.sh after chmod +x).
# Safe to run repeatedly:
# installs dependencies and rebuilds the interface only when they are missing.
set -euo pipefail
cd "$(dirname "$0")"
export PORT="${PORT:-8080}"
# Authenticated sign-in is the default. Set CASELINK_DEMO=true explicitly for fixture entry.
export CASELINK_DEMO="${CASELINK_DEMO:-false}"

if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  echo "[caselink] installing dependencies…"
  npm install --no-audit --no-fund
fi
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src server/src -newer web/dist/index.html -print -quit 2>/dev/null)" ]; then
  echo "[caselink] building interface…"
  npx vite build
fi
if [ ! -f data/caselink.db ]; then
  echo "[caselink] seeding demo data…"
  npx tsx server/src/seed.ts --force
fi
echo "[caselink] demo mode: ${CASELINK_DEMO} (passwordless fixture entry requires CASELINK_DEMO=true)"
echo "[caselink] starting on port ${PORT}"
exec npx tsx server/src/index.ts
