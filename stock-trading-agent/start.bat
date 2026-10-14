@echo off
REM One-step launcher (Windows). Double-click, or run:  start.bat   /  start.bat monitor
setlocal
cd /d "%~dp0"
where py >nul 2>nul && (set "PY=py -3") || (set "PY=python")
if not exist ".venv\Scripts\python.exe" (
  echo First run: creating .venv and installing dependencies...
  %PY% -c "import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)" || (
    echo Python 3.11+ is required. Install it from python.org and retry.
    exit /b 1
  )
  %PY% -m venv .venv || exit /b 1
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
  ".venv\Scripts\python.exe" -m pip install -e ".[dev]" || exit /b 1
)
if "%~1"=="" (
  ".venv\Scripts\python.exe" -m trading_agent ui
) else (
  ".venv\Scripts\python.exe" -m trading_agent %*
)
