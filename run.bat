@echo off
REM Serves the Receipt Renamer page locally. You only need this for an offline
REM copy - the hosted page does exactly the same thing in the browser.
setlocal
cd /d "%~dp0"

where py >nul 2>nul && (set PY=py -3) || (set PY=python)

if not exist ".venv\Scripts\python.exe" (
  echo Setting up ^(first run only^)...
  %PY% -m venv .venv || goto :nopython
  ".venv\Scripts\python.exe" -m pip install --upgrade pip >nul
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail
)

".venv\Scripts\python.exe" app.py
goto :eof

:nopython
echo.
echo Python 3 was not found. Install it from https://www.python.org/downloads/
echo and tick "Add python.exe to PATH" during setup.
pause
goto :eof

:fail
echo.
echo Install failed. Check your internet connection or proxy settings.
pause
