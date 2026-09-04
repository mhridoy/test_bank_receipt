"""Free, offline OCR for scanned receipts.

RapidOCR (ONNX Runtime) is used because it is a plain `pip install` on Windows -
no admin rights, no Tesseract/poppler binaries, no downloads at run time, and no
API key. Everything happens on the PC; nothing leaves the machine.
"""
from __future__ import annotations

import os
import re
import threading
from pathlib import Path

DEFAULT_DPI = 400          # 400 keeps word gaps that 200 dpi glues together.
MAX_PIXELS = int(os.environ.get("OCR_MAX_PIXELS", "4000"))          # cap the long edge: a huge scan must not eat the RAM
                           # of a small server (and OCR gains nothing above this)

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
                # Detection runs on a downscaled copy (cheap) while recognition
                # still crops from the full-resolution page (accurate). One thread
                # each: these servers are small, and pages are processed serially.
                _engine = RapidOCR(det_limit_type="max", det_limit_side_len=1280,
                                   intra_op_num_threads=1, inter_op_num_threads=1)
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
                page = doc[i]
                scale = dpi / 72.0
                longest = max(page.rect.width, page.rect.height) * scale
                if longest > MAX_PIXELS:                       # keep memory bounded
                    scale *= MAX_PIXELS / longest
                pixmap = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale),
                                         colorspace=pymupdf.csGRAY, alpha=False)
                png = pixmap.tobytes("png")
                del pixmap                                     # release before OCR runs
                with _infer_lock:
                    result, _ = eng(png)
                del png
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
