"""User settings + API key handling (cross-platform: Windows / macOS / Linux)."""
from __future__ import annotations

import json
import os
from pathlib import Path

APP_NAME = "BankReceiptRenamer"

DEFAULT_TEMPLATE = "{bank}_{receiver}_{amount}{currency}_{invoice}"

TEMPLATE_PRESETS = {
    "standard": "{bank}_{receiver}_{amount}{currency}_{invoice}",
    "with_date": "{date}_{bank}_{receiver}_{amount}{currency}_{invoice}",
    "audit": "{date}_{bank}_{sender}_TO_{receiver}_{amount}{currency}_{invoice}",
    "ref_based": "{bank}_{receiver}_{amount}{currency}_{ref}",
}

DEFAULTS = {
    "template": DEFAULT_TEMPLATE,
    "ocr_dpi": 400,
    "recursive": False,
    "strip_legal_suffix": True,
    "invoice_from_filename": True,
    "max_workers": 4,
    "last_folder": "",
    # Optional Claude assist for layouts the rules cannot read. Off by default;
    # the app is fully functional (and free) without it.
    "use_ai": False,
    "model": "claude-opus-5",
    "api_key": "",
}


def config_dir() -> Path:
    """Per-user config dir that works on Windows (APPDATA) and POSIX."""
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    d = base / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def settings_path() -> Path:
    return config_dir() / "settings.json"


def history_dir() -> Path:
    d = config_dir() / "history"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_settings() -> dict:
    s = dict(DEFAULTS)
    p = settings_path()
    if p.exists():
        try:
            s.update(json.loads(p.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, OSError):
            pass
    return s


def save_settings(patch: dict) -> dict:
    s = load_settings()
    s.update({k: v for k, v in patch.items() if k in DEFAULTS})
    settings_path().write_text(json.dumps(s, indent=2), encoding="utf-8")
    return s


def aliases_path() -> Path:
    return config_dir() / "aliases.json"


def load_aliases() -> dict:
    """Names the office has taught the app: raw text -> clean name."""
    p = aliases_path()
    base = {"receiver": {}, "sender": {}, "bank": {}}
    if p.exists():
        try:
            saved = json.loads(p.read_text(encoding="utf-8"))
            for k in base:
                base[k].update(saved.get(k, {}))
        except (json.JSONDecodeError, OSError):
            pass
    return base


def save_alias(kind: str, raw: str, clean: str) -> dict:
    aliases = load_aliases()
    if kind not in aliases:
        return aliases
    raw, clean = (raw or "").strip(), (clean or "").strip()
    if not raw:
        return aliases
    if clean:
        aliases[kind][raw] = clean
    else:
        aliases[kind].pop(raw, None)
    aliases_path().write_text(json.dumps(aliases, indent=2, ensure_ascii=False), encoding="utf-8")
    return aliases


def resolve_api_key(settings: dict | None = None) -> str:
    """Env var wins, then the key saved from the UI."""
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    s = settings if settings is not None else load_settings()
    return (s.get("api_key") or "").strip()
