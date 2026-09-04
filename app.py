"""Bank Receipt Renamer - local web app.

Runs entirely on the user's own machine (Windows / macOS / Linux): reads a local
folder of bank-receipt PDFs and renames them to a consistent, searchable pattern.

No API key, no account, no upload - digital PDFs are read from their text layer
and scanned ones through offline OCR (RapidOCR), then parsed with plain rules.
"""
from __future__ import annotations

import os
import socket
import threading
import webbrowser
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

from receipt_renamer import config, ocr, renamer, uploads

app = Flask(__name__)
app.config["JSON_AS_ASCII"] = False
app.config["MAX_CONTENT_LENGTH"] = (uploads.MAX_FILES * uploads.MAX_FILE_MB + 32) * 1024 * 1024

# CLOUD_MODE=1 when hosted (Render): no local folder access, upload/download only.
CLOUD_MODE = os.environ.get("CLOUD_MODE") == "1"


def _folder_arg(raw: str) -> Path:
    return Path(os.path.expandvars(os.path.expanduser((raw or "").strip().strip('"')))).resolve()


@app.get("/")
def index():
    s = config.load_settings()
    return render_template(
        "index.html",
        settings=s,
        presets=config.TEMPLATE_PRESETS,
        aliases=config.load_aliases(),
        ocr_ready=ocr.available(),
        ocr_error=ocr.engine_error(),
        cloud_mode=CLOUD_MODE,
        max_files=uploads.MAX_FILES,
        max_file_mb=uploads.MAX_FILE_MB,
    )


@app.get("/api/aliases")
def get_aliases():
    return jsonify(config.load_aliases())


@app.post("/api/aliases")
def post_alias():
    """Teach the app a clean name for something a receipt spells badly."""
    body = request.get_json(force=True) or {}
    kind = body.get("kind", "receiver")
    aliases = config.save_alias(kind, body.get("raw", ""), body.get("clean", ""))
    job = renamer.JOBS.get(body.get("job_id", ""))
    if job:
        job.rebuild_names({})
    return jsonify({"aliases": aliases, "job": job.snapshot() if job else None})


@app.get("/healthz")
def healthz():
    return jsonify({"ok": True, "ocr": ocr.available(), "cloud": CLOUD_MODE})


@app.get("/api/settings")
def get_settings():
    s = config.load_settings()
    s["api_key"] = "***" if s.get("api_key") else ""
    return jsonify(s)


@app.post("/api/settings")
def post_settings():
    patch = request.get_json(force=True) or {}
    if patch.get("api_key") == "***":
        patch.pop("api_key")
    s = config.save_settings(patch)
    s["api_key"] = "***" if s.get("api_key") else ""
    return jsonify(s)


@app.post("/api/upload")
def upload():
    """Hosted mode: take copies of the PDFs and read them in a session folder."""
    files = request.files.getlist("files")
    if not files:
        return jsonify({"error": "No files received."}), 400
    folder, saved, rejected = uploads.save_uploads(files)
    if not saved:
        return jsonify({"error": "; ".join(rejected) or "No PDF files received."}), 400

    settings = config.load_settings()
    settings.update({
        "template": request.form.get("template") or config.DEFAULT_TEMPLATE,
        "recursive": False,
        "strip_legal_suffix": request.form.get("strip_legal_suffix") == "true",
        "invoice_from_filename": request.form.get("invoice_from_filename") == "true",
        "ocr_dpi": int(request.form.get("ocr_dpi") or 400),
    })
    job = renamer.start_job(folder, settings)
    return jsonify({"job_id": job.id, "total": job.total, "rejected": rejected})


@app.get("/api/download/<job_id>")
def download(job_id: str):
    job = renamer.JOBS.get(job_id)
    if not job or not uploads.is_session(job.folder):
        return jsonify({"error": "nothing to download"}), 404
    return send_file(uploads.zip_folder(job.folder), mimetype="application/zip",
                     as_attachment=True, download_name="renamed_receipts.zip")


@app.post("/api/browse")
def browse():
    """List sub-folders so users can click their way to a folder on any OS."""
    if CLOUD_MODE:
        return jsonify({"error": "Folder browsing is only available in the desktop version."}), 403
    raw = (request.get_json(force=True) or {}).get("folder", "")
    folder = _folder_arg(raw) if raw else Path.home()
    if not folder.is_dir():
        return jsonify({"error": f"Not a folder: {folder}"}), 400
    try:
        subs = sorted((p.name for p in folder.iterdir()
                       if p.is_dir() and not p.name.startswith(".")), key=str.lower)
    except PermissionError:
        return jsonify({"error": f"No permission to read {folder}"}), 403
    return jsonify({
        "folder": str(folder),
        "parent": str(folder.parent) if folder.parent != folder else "",
        "subfolders": subs[:400],
        "pdf_count": len(renamer.list_pdfs(folder, False)),
    })


@app.post("/api/scan")
def scan():
    if CLOUD_MODE:
        return jsonify({"error": "Folder scanning is only available in the desktop version."}), 403
    body = request.get_json(force=True) or {}
    folder = _folder_arg(body.get("folder", ""))
    if not folder.is_dir():
        return jsonify({"error": f"Folder not found: {folder}"}), 400

    settings = config.save_settings({
        "template": body.get("template") or config.DEFAULT_TEMPLATE,
        "recursive": bool(body.get("recursive")),
        "strip_legal_suffix": bool(body.get("strip_legal_suffix")),
        "invoice_from_filename": bool(body.get("invoice_from_filename")),
        "ocr_dpi": int(body.get("ocr_dpi") or 400),
        "last_folder": str(folder),
    })
    job = renamer.start_job(folder, settings)
    if job.total == 0:
        return jsonify({"error": f"No PDF files in {folder}"}), 400
    return jsonify({"job_id": job.id, "total": job.total})


@app.get("/api/job/<job_id>")
def job_status(job_id: str):
    job = renamer.JOBS.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404
    return jsonify(job.snapshot())


@app.post("/api/job/<job_id>/retemplate")
def retemplate(job_id: str):
    job = renamer.JOBS.get(job_id)
    if not job:
        return jsonify({"error": "job not found"}), 404
    body = request.get_json(force=True) or {}
    config.save_settings({k: body[k] for k in
                          ("template", "strip_legal_suffix", "invoice_from_filename")
                          if k in body})
    job.rebuild_names(body)
    return jsonify(job.snapshot())


@app.post("/api/job/<job_id>/cancel")
def cancel(job_id: str):
    job = renamer.JOBS.get(job_id)
    if job:
        job.cancelled = True
    return jsonify({"ok": True})


@app.post("/api/apply")
def apply():
    body = request.get_json(force=True) or {}
    items = body.get("items", [])
    if CLOUD_MODE:
        job = renamer.JOBS.get(body.get("job_id", ""))
        if not job or not uploads.is_session(job.folder):
            return jsonify({"error": "session expired - please upload again"}), 400
        allowed = {str(p) for p in job.folder.glob("*.pdf")}
        items = [i for i in items if i.get("path") in allowed]
    return jsonify(renamer.apply_renames(items, keep_history=not CLOUD_MODE))


@app.get("/api/history")
def history():
    return jsonify({"entries": renamer.list_history()})


@app.post("/api/undo")
def undo():
    name = (request.get_json(force=True) or {}).get("file", "")
    return jsonify(renamer.undo(name))


@app.get("/api/preview")
def preview():
    """Serve one PDF back to the browser so the user can eyeball it."""
    path = Path(request.args.get("path", ""))
    if not path.is_file() or path.suffix.lower() != ".pdf":
        return jsonify({"error": "not a pdf"}), 404
    if CLOUD_MODE and not uploads.is_session(path.parent):
        return jsonify({"error": "not available"}), 403
    return send_file(path, mimetype="application/pdf")


def _free_port(preferred: int = 8765) -> int:
    for port in (preferred, 0):
        with socket.socket() as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return sock.getsockname()[1]
            except OSError:
                continue
    return 8765


def main() -> None:
    port = int(os.environ.get("PORT") or _free_port())
    url = f"http://127.0.0.1:{port}"
    print(f"\n  Bank Receipt Renamer running at {url}\n  (Ctrl+C to stop)\n")
    if os.environ.get("NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
