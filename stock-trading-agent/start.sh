#!/usr/bin/env bash
# One-step launcher (macOS / Linux). Works from any directory:
#   ./start.sh                 -> web UI (paper trading by default)
#   ./start.sh monitor         -> any other trading_agent command
set -euo pipefail
cd "$(dirname "$0")"            # always run from the folder that holds pyproject.toml

PY="${PYTHON:-python3}"
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' 2>/dev/null; then
  echo "Python 3.11+ is required (found: $("$PY" --version 2>&1)). Set PYTHON=/path/to/python3.11 and retry." >&2
  exit 1
fi
if [ ! -x .venv/bin/python ]; then
  echo "First run: creating .venv and installing dependencies..."
  "$PY" -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -e ".[dev]"
fi
if [ $# -eq 0 ]; then set -- ui; fi
exec .venv/bin/python -m trading_agent "$@"
