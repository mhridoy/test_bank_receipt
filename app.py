"""Serves the Receipt Renamer page.

The app is entirely client-side: reading the PDFs, the OCR, the field rules and
the renaming all happen in the browser, against a folder the user picks. This
server only hands over the HTML, CSS and JS - it never sees a receipt.

Run it locally (`python app.py`) for an offline copy, or deploy it anywhere that
serves static files over HTTPS (the File System Access API needs a secure origin).
"""
from __future__ import annotations

import os
import socket
import threading
import webbrowser

from pathlib import Path

from flask import Flask, jsonify, render_template, send_from_directory

TEMPLATE_PRESETS = {
    "standard": "{bank}_{receiver}_{amount}{currency}_{invoice}",
    "with_date": "{date}_{bank}_{receiver}_{amount}{currency}_{invoice}",
    "audit": "{date}_{bank}_{sender}_TO_{receiver}_{amount}{currency}_{invoice}",
    "ref_based": "{bank}_{receiver}_{amount}{currency}_{ref}",
}

app = Flask(__name__)
SAMPLES = Path(__file__).parent / "samples"


@app.after_request
def security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    return response


@app.get("/")
def index():
    return render_template("index.html", presets=TEMPLATE_PRESETS,
                           default_template=TEMPLATE_PRESETS["standard"])


@app.get("/test")
def test_page():
    """Dev harness: runs the browser engine over the PDFs in ./samples."""
    if not SAMPLES.is_dir():
        return jsonify({"error": "no samples folder"}), 404
    return render_template("test.html",
                           samples=sorted(p.name for p in SAMPLES.glob("*.pdf")))


@app.get("/samples/<path:name>")
def sample_file(name: str):
    if not SAMPLES.is_dir():
        return jsonify({"error": "no samples folder"}), 404
    return send_from_directory(SAMPLES, name)


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True})


def _free_port(preferred: int = 8765) -> int:
    for port in (preferred, 0):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return sock.getsockname()[1]
            except OSError:
                continue
    return preferred


def main() -> None:
    port = int(os.environ.get("PORT") or _free_port())
    url = f"http://127.0.0.1:{port}"
    print(f"\n  Receipt Renamer running at {url}\n  (Ctrl+C to stop)\n")
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="0.0.0.0" if os.environ.get("CLOUD_MODE") else "127.0.0.1",
            port=port, threaded=True)


if __name__ == "__main__":
    main()
