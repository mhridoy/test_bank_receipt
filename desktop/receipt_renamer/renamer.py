"""Scan a folder, plan new names, apply them, and keep an undo trail."""
from __future__ import annotations

import json
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

from . import config
from .extract import extract_fields
from .parse import apply_aliases
from .naming import build_name, unique_path


def list_pdfs(folder: Path, recursive: bool = False) -> list[Path]:
    it = folder.rglob("*") if recursive else folder.glob("*")
    files = [p for p in it if p.is_file() and p.suffix.lower() == ".pdf"
             and not p.name.startswith((".", "~$"))]
    return sorted(files, key=lambda p: str(p).lower())


class Job:
    """One folder scan. Rows are filled in by a worker pool as results land."""

    def __init__(self, folder: Path, files: list[Path], settings: dict):
        self.id = uuid.uuid4().hex[:12]
        self.folder = folder
        self.settings = settings
        self.created = time.time()
        self.done = 0
        self.total = len(files)
        self.cancelled = False
        self.error = ""
        self.lock = threading.Lock()
        self.rows = [{
            "index": i,
            "path": str(p),
            "original": p.name,
            "relative": str(p.relative_to(folder)),
            "status": "pending",
            "proposed": "",
            "fields": {},
            "engine": "",
            "raw_fields": {},
            "confidence": "",
            "notes": "",
        } for i, p in enumerate(files)]

    # -- planning ----------------------------------------------------------
    def run(self) -> None:
        s = self.settings
        workers = max(1, min(int(s.get("max_workers", 4)), 8))
        try:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                list(pool.map(self._process, self.rows))
        except Exception as exc:
            self.error = str(exc)

    def _process(self, row: dict) -> None:
        if self.cancelled:
            row["status"] = "cancelled"
            return
        s = self.settings
        try:
            fields = extract_fields(Path(row["path"]), s, config.load_aliases())
            row["fields"] = {k: v for k, v in fields.items() if not k.startswith("_")}
            row["raw_fields"] = dict(row["fields"])
            row["engine"] = fields.get("_engine", "")
            row["confidence"] = fields.get("confidence", "")
            row["notes"] = fields.get("notes", "")
            row["proposed"] = build_name(
                fields, s.get("template", config.DEFAULT_TEMPLATE), row["original"],
                bool(s.get("strip_legal_suffix", True)),
                bool(s.get("invoice_from_filename", True)),
            )
            missing = [k for k in ("bank_name", "receiver_name", "amount")
                       if not (fields.get(k) or "").strip()]
            row["status"] = "review" if (missing or row["confidence"] == "low") else "ready"
            if missing:
                row["notes"] = (row["notes"] + f" Missing: {', '.join(missing)}.").strip()
        except Exception as exc:
            row["status"] = "error"
            row["notes"] = str(exc)
        finally:
            with self.lock:
                self.done += 1

    def snapshot(self) -> dict:
        return {
            "id": self.id,
            "folder": str(self.folder),
            "done": self.done,
            "total": self.total,
            "finished": self.done >= self.total or self.cancelled,
            "cancelled": self.cancelled,
            "error": self.error,
            "rows": self.rows,
        }

    def rebuild_names(self, settings: dict) -> None:
        """Re-render names after a template change or a newly taught name.

        Uses the fields already extracted - no file is read again.
        """
        self.settings.update(settings)
        aliases = config.load_aliases()
        for row in self.rows:
            if row.get("raw_fields"):
                row["fields"] = dict(row["raw_fields"])
                apply_aliases(row["fields"], aliases)
            if row["fields"]:
                row["proposed"] = build_name(
                    row["fields"], self.settings.get("template", config.DEFAULT_TEMPLATE),
                    row["original"], bool(self.settings.get("strip_legal_suffix", True)),
                    bool(self.settings.get("invoice_from_filename", True)),
                )


JOBS: dict[str, Job] = {}
JOBS_LOCK = threading.Lock()


def start_job(folder: Path, settings: dict) -> Job:
    files = list_pdfs(folder, bool(settings.get("recursive")))
    job = Job(folder, files, settings)
    with JOBS_LOCK:
        JOBS[job.id] = job
        for old_id, old in list(JOBS.items()):        # keep memory bounded
            if old is not job and time.time() - old.created > 6 * 3600:
                JOBS.pop(old_id, None)
    threading.Thread(target=job.run, daemon=True).start()
    return job


def apply_renames(items: list[dict], keep_history: bool = True) -> dict:
    """items: [{path, proposed}]. Returns a result summary and writes an undo log."""
    renamed, skipped, failed = [], [], []
    taken: set[str] = set()

    for item in items:
        src = Path(item["path"])
        proposed = (item.get("proposed") or "").strip()
        if not src.exists():
            failed.append({"path": str(src), "reason": "file no longer exists"})
            continue
        if not proposed:
            skipped.append({"path": str(src), "reason": "no proposed name"})
            continue
        if not proposed.lower().endswith(".pdf"):
            proposed += ".pdf"
        if proposed == src.name:
            skipped.append({"path": str(src), "reason": "already named correctly"})
            continue
        dest = unique_path(src.parent, proposed, taken)
        try:
            src.rename(dest)
            renamed.append({"from": str(src), "to": str(dest)})
        except OSError as exc:
            failed.append({"path": str(src), "reason": str(exc)})

    log = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "renamed": renamed, "skipped": skipped, "failed": failed,
    }
    if renamed and keep_history:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        (config.history_dir() / f"rename-{stamp}.json").write_text(
            json.dumps(log, indent=2, ensure_ascii=False), encoding="utf-8")
    return log


def list_history(limit: int = 20) -> list[dict]:
    files = sorted(config.history_dir().glob("rename-*.json"), reverse=True)[:limit]
    out = []
    for f in files:
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append({"file": f.name, "timestamp": data.get("timestamp", ""),
                    "count": len(data.get("renamed", [])),
                    "folder": str(Path(data["renamed"][0]["to"]).parent) if data.get("renamed") else ""})
    return out


def undo(log_name: str) -> dict:
    path = config.history_dir() / Path(log_name).name
    if not path.exists():
        return {"restored": [], "failed": [{"reason": "history entry not found"}]}
    data = json.loads(path.read_text(encoding="utf-8"))
    restored, failed = [], []
    for entry in reversed(data.get("renamed", [])):
        current, original = Path(entry["to"]), Path(entry["from"])
        if not current.exists():
            failed.append({"path": str(current), "reason": "renamed file not found"})
            continue
        if original.exists():
            failed.append({"path": str(original), "reason": "original name is taken again"})
            continue
        try:
            current.rename(original)
            restored.append({"from": str(current), "to": str(original)})
        except OSError as exc:
            failed.append({"path": str(current), "reason": str(exc)})
    if restored and not failed:
        path.unlink(missing_ok=True)
    return {"restored": restored, "failed": failed}
