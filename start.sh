#!/usr/bin/env bash
# Starts CaseLink on port ${PORT:-8080}. Run as: bash start.sh  (or ./start.sh after chmod +x).
# Safe to run repeatedly:
# installs dependencies and rebuilds the interface only when they are missing.
set -euo pipefail
cd "$(dirname "$0")"
export PORT="${PORT:-8080}"
# Authenticated sign-in is the default. Set CASELINK_DEMO=true explicitly for fixture entry.
export CASELINK_DEMO="${CASELINK_DEMO:-false}"
if [ "${1:-}" != "" ] && [ "$1" != "--setup-only" ]; then
  echo "Usage: bash start.sh [--setup-only]" >&2
  exit 2
fi

if [ ! -d node_modules ] || [ ! -d node_modules/express ]; then
  echo "[caselink] installing dependencies…"
  npm ci --no-audit --no-fund
fi
if [ ! -f web/dist/index.html ] || [ -n "$(find web/src server/src -newer web/dist/index.html -print -quit 2>/dev/null)" ]; then
  echo "[caselink] building interface…"
  npx vite build
fi
if [ "${1:-}" = "--setup-only" ]; then
  echo "[caselink] setup complete"
  exit 0
fi
echo "[caselink] demo mode: ${CASELINK_DEMO} (passwordless fixture entry requires CASELINK_DEMO=true)"
echo "[caselink] starting on port ${PORT}"
exec node --import tsx server/src/index.ts
