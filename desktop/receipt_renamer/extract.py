"""Get the text out of a receipt PDF, then read the fields out of that text.

Two steps, both free and fully offline:

1. Embedded text layer (PyMuPDF) - digital receipts, instant and exact.
2. OCR (RapidOCR) - only for scans / image-only PDFs.

Field extraction is rule-based (`parse.py`). No API key, no account, no upload.
An optional Claude assist exists for stubborn layouts but is OFF by default;
see `use_ai` in the settings file.
"""
from __future__ import annotations

from pathlib import Path

from . import ocr
from .parse import parse_text

MIN_TEXT_CHARS = 60      # below this the "text layer" is just page furniture


def _pymupdf():
    """PyMuPDF ships as `pymupdf` now, `fitz` on older installs."""
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        try:
            import fitz
            return fitz
        except ImportError:
            return None


def read_pdf_text(path: Path, max_pages: int = 3) -> str:
    """Embedded text layer, if the PDF has one (scans return '')."""
    fitz = _pymupdf()
    if fitz is None:
        return ""
    try:
        with fitz.open(path) as doc:
            return "\n".join(doc[i].get_text() for i in range(min(max_pages, doc.page_count)))
    except Exception:
        return ""


def extract_fields(path: Path, settings: dict | None = None,
                   aliases: dict | None = None) -> dict:
    settings = settings or {}
    engine = "text-layer"
    text = read_pdf_text(path)

    if len(text.strip()) < MIN_TEXT_CHARS:
        engine = "ocr"
        text = ocr.ocr_pdf(path, dpi=int(settings.get("ocr_dpi", ocr.DEFAULT_DPI)))
        if not text.strip():
            fields = parse_text("", aliases)
            fields["_engine"] = "none"
            fields["notes"] = (
                "Scanned PDF and OCR is unavailable - run: pip install rapidocr-onnxruntime"
                if not ocr.available() else "Nothing readable on the page.")
            return fields

    fields = parse_text(text, aliases)
    fields["_engine"] = engine
    fields["_text"] = text[:4000]

    if settings.get("use_ai") and fields.get("confidence") == "low":
        try:
            from .ai_assist import refine_with_claude
            fields = refine_with_claude(path, fields, settings)
        except Exception as exc:
            fields["notes"] = f"{fields.get('notes','')} AI assist skipped: {exc}".strip()
    return fields
