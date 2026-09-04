"""Free, offline OCR for scanned receipts.

RapidOCR (ONNX Runtime) is used because it is a plain `pip install` on Windows -
no admin rights, no Tesseract/poppler binaries, no downloads at run time, and no
API key. Everything happens on the PC; nothing leaves the machine.
"""
from __future__ import annotations

import re
import threading
from pathlib import Path

DEFAULT_DPI = 400          # 400 keeps word gaps that 200 dpi glues together.

_engine = None
_engine_lock = threading.Lock()
_infer_lock = threading.Lock()   # the ONNX session is shared; one page at a time
_engine_error = ""


def available() -> bool:
    return load_engine() is not None


def engine_error() -> str:
    return _engine_error


def load_engine():
    """Build the OCR engine once and share it across worker threads."""
    global _engine, _engine_error
    if _engine is not None:
        return _engine
    with _engine_lock:
        if _engine is None:
            try:
                from rapidocr_onnxruntime import RapidOCR
                _engine = RapidOCR()
            except Exception as exc:
                _engine_error = str(exc)
                return None
    return _engine


def _deglue(text: str) -> str:
    """OCR often drops spaces inside a line: 'CORNERSCOMPANYBeneficiary'.

    Re-insert the obvious boundaries so the field patterns can match.
    """
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text)          # ...yA...
    text = re.sub(r"(?<=[A-Za-z])(?=\d)", " ", text)          # SAR302 -> SAR 302
    text = re.sub(r"(?<=\d)(?=[A-Za-z])", " ", text)          # 302SAR -> 302 SAR
    return re.sub(r"[ \t]{2,}", " ", text)


def ocr_pdf(path: Path, dpi: int = DEFAULT_DPI, max_pages: int = 3) -> str:
    """Render each page and read it. Returns '' when OCR is unavailable."""
    eng = load_engine()
    if eng is None:
        return ""
    try:
        import pymupdf
    except ImportError:
        return ""

    chunks: list[str] = []
    try:
        with pymupdf.open(path) as doc:
            for i in range(min(max_pages, doc.page_count)):
                png = doc[i].get_pixmap(dpi=dpi).tobytes("png")
                with _infer_lock:
                    result, _ = eng(png)
                if result:
                    chunks.append("\n".join(line[1] for line in result))
    except Exception:
        return "\n".join(chunks)
    return "\n".join(chunks)


def normalise(text: str) -> dict:
    """Three views of the same text - patterns pick whichever suits them."""
    raw = text
    spaced = _deglue(text.replace("\n", " \n "))
    flat = re.sub(r"\s+", "", text)
    return {"raw": raw, "spaced": spaced, "flat": flat}
