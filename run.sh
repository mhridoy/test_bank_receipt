#!/usr/bin/env bash
# Bank Receipt Renamer - macOS / Linux launcher.
set -e
cd "$(dirname "$0")"

if [ ! -x ".venv/bin/python" ]; then
  echo "Setting up (first run only)..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r requirements.txt
fi

exec .venv/bin/python app.py
