"""Server-side (hosted) mode: work on uploaded copies instead of a local folder.

When the app runs on someone's own PC it renames files where they sit. When it
runs on a server nobody's disk is reachable, so the browser uploads copies, the
server renames them in a throw-away session folder, and the user downloads a ZIP.
Session folders are deleted an hour later.
"""
from __future__ import annotations

import io
import re
import shutil
import tempfile
import time
import uuid
import zipfile
from pathlib import Path

MAX_FILES = 40
MAX_FILE_MB = 20
SESSION_TTL = 3600          # seconds

ROOT = Path(tempfile.gettempdir()) / "receipt_renamer_sessions"


def _safe_name(name: str) -> str:
    name = Path(name).name
    name = re.sub(r"[^0-9A-Za-z._ \-؀-ۿ]", "_", name)
    return name[:120] or "upload.pdf"


def new_session() -> Path:
    ROOT.mkdir(parents=True, exist_ok=True)
    folder = ROOT / f"{int(time.time())}-{uuid.uuid4().hex[:8]}"
    folder.mkdir()
    return folder


def save_uploads(files) -> tuple[Path, list[str], list[str]]:
    """files: werkzeug FileStorage list. Returns (folder, saved, rejected)."""
    purge_old()
    folder = new_session()
    saved, rejected = [], []
    for f in files[:MAX_FILES]:
        name = _safe_name(f.filename or "")
        if not name.lower().endswith(".pdf"):
            rejected.append(f"{name}: not a PDF")
            continue
        blob = f.read()
        if len(blob) > MAX_FILE_MB * 1024 * 1024:
            rejected.append(f"{name}: larger than {MAX_FILE_MB} MB")
            continue
        (folder / name).write_bytes(blob)
        saved.append(name)
    if len(files) > MAX_FILES:
        rejected.append(f"only the first {MAX_FILES} files were taken")
    return folder, saved, rejected


def zip_folder(folder: Path) -> io.BytesIO:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for pdf in sorted(folder.glob("*.pdf")):
            zf.write(pdf, pdf.name)
    buffer.seek(0)
    return buffer


def is_session(folder: Path) -> bool:
    try:
        return ROOT.resolve() in folder.resolve().parents
    except OSError:
        return False


def purge_old(ttl: int = SESSION_TTL) -> None:
    if not ROOT.exists():
        return
    cutoff = time.time() - ttl
    for folder in ROOT.iterdir():
        try:
            if folder.is_dir() and folder.stat().st_mtime < cutoff:
                shutil.rmtree(folder, ignore_errors=True)
        except OSError:
            pass
