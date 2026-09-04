"""Turn extracted receipt fields into a safe, consistent file name."""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path

# Windows forbids these outright; we also drop them on macOS for portability.
ILLEGAL = r'<>:"/\\|?*'
WINDOWS_RESERVED = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{i}" for i in range(1, 10)),
    *(f"LPT{i}" for i in range(1, 10)),
}

LEGAL_SUFFIXES = {
    "company", "co", "coltd", "ltd", "llc", "wll", "est", "establishment",
    "corp", "corporation", "inc", "plc", "jsc", "sa", "sarl", "trading",
}

# Canonical short names for banks we see often. Anything else is CamelCased.
BANK_ALIASES = [
    (r"riyad", "RiyadBank"),
    (r"jazira|jazeera", "AlJaziraBank"),
    (r"rajhi", "AlRajhiBank"),
    (r"\bsnb\b|saudi national|national commercial|\bncb\b|الأهلي", "SaudiNationalBank"),
    (r"samba", "SambaBank"),
    (r"\bsabb\b|british", "SABB"),
    (r"alinma|inma", "AlinmaBank"),
    (r"albilad|bilad", "BankAlbilad"),
    (r"arab national|\banb\b", "ArabNationalBank"),
    (r"saudi investment|\bsaib\b", "SaudiInvestmentBank"),
    (r"gulf international|\bgib\b", "GulfInternationalBank"),
    (r"emirates nbd", "EmiratesNBD"),
    (r"\bfab\b|first abu dhabi", "FirstAbuDhabiBank"),
    (r"\bqnb\b", "QNB"),
    (r"\bhsbc\b", "HSBC"),
    (r"standard chartered", "StandardChartered"),
    (r"citi", "Citibank"),
]

KNOWN_ACRONYMS = {
    "LLC", "WLL", "JSC", "PLC", "KSA", "UAE", "SAR", "USD", "EUR", "SNB", "NCB",
    "ANB", "GIB", "QNB", "NBD", "FAB", "SABB", "HSBC", "SAIB", "IBAN", "VAT",
}

_TOKEN_RE = re.compile(r"\{(\w+)\}")


def _strip_marks(text: str) -> str:
    """Drop accents but keep non-Latin scripts (Arabic) intact."""
    out = unicodedata.normalize("NFKD", text)
    return "".join(c for c in out if not unicodedata.combining(c))


def camel(text: str, strip_legal: bool = False) -> str:
    """'PIONEER METAL CORNERS COMPANY' -> 'PioneerMetalCorners'."""
    if not text:
        return ""
    text = _strip_marks(str(text))
    words = [w for w in re.split(r"[^0-9A-Za-z؀-ۿ]+", text) if w]
    if strip_legal:
        while words and words[-1].lower().strip(".") in LEGAL_SUFFIXES:
            words.pop()
    parts = []
    for w in words:
        if w.upper() in KNOWN_ACRONYMS or re.fullmatch(r"\d+", w):
            parts.append(w.upper() if w.isalpha() else w)   # SNB, LLC, KSA, 2026
        elif w.isascii():
            parts.append(w[:1].upper() + w[1:].lower())
        else:
            parts.append(w)              # Arabic and other scripts: as-is
    return "".join(parts)


def canonical_bank(name: str) -> str:
    if not name:
        return ""
    low = str(name).lower()
    for pattern, canon in BANK_ALIASES:
        if re.search(pattern, low):
            return canon
    return camel(name, strip_legal=False)


def clean_amount(value) -> str:
    """'302,358.00 SAR' / -302365.0 -> '302358.00' (absolute, 2 decimals)."""
    if value in (None, ""):
        return ""
    s = str(value)
    s = re.sub(r"[^\d.,\-]", "", s).replace(",", "")
    if not s:
        return ""
    try:
        num = abs(float(s))
    except ValueError:
        return ""
    return f"{num:.2f}"


def clean_ref(value) -> str:
    if not value:
        return ""
    return re.sub(r"[^0-9A-Za-z\-]", "", str(value))


def clean_invoice(value) -> str:
    """'ds 07260019' -> '7260019'; 'INV-2026/118' -> 'INV-2026-118'."""
    if not value:
        return ""
    s = str(value).strip()
    digits = re.findall(r"\d{4,}", s)
    if len(digits) == 1 and not re.search(r"[A-Za-z]{3,}", s):
        return digits[0].lstrip("0") or digits[0]
    return re.sub(r"[^0-9A-Za-z\-]+", "-", s).strip("-")


def invoice_from_name(filename: str) -> str:
    """Fallback: pull an invoice-ish number out of the original file name."""
    stem = Path(filename).stem
    m = re.search(r"(?:inv|invoice|bill|fatura|فاتورة)[^0-9]{0,6}(\d{4,})", stem, re.I)
    if m:
        return m.group(1)
    nums = re.findall(r"\d{5,}", stem)
    return nums[-1] if nums else ""


def sanitize(name: str, max_len: int = 150) -> str:
    for ch in ILLEGAL:
        name = name.replace(ch, "")
    name = "".join(c for c in name if ord(c) >= 32)
    name = re.sub(r"_{2,}", "_", name).strip(" ._-")
    if not name:
        name = "unnamed_receipt"
    if name.split("_")[0].upper() in WINDOWS_RESERVED:
        name = "_" + name
    return name[:max_len].rstrip(" ._-")


def build_name(fields: dict, template: str, original: str,
               strip_legal: bool = True, invoice_fallback: bool = True) -> str:
    """Render `template` with the extracted fields. Empty tokens drop out cleanly."""
    invoice = clean_invoice(fields.get("invoice_number"))
    if not invoice and invoice_fallback:
        invoice = invoice_from_name(original)

    receiver = fields.get("receiver_name_en") or fields.get("receiver_name") or ""
    sender = fields.get("sender_name_en") or fields.get("sender_name") or ""

    values = {
        "bank": canonical_bank(fields.get("bank_name") or ""),
        "receiver_bank": canonical_bank(fields.get("receiver_bank") or ""),
        "sender": camel(sender, strip_legal),
        "receiver": camel(receiver, strip_legal),
        "amount": clean_amount(fields.get("amount")),
        "currency": (fields.get("currency") or "").upper()[:4],
        "invoice": invoice,
        "ref": clean_ref(fields.get("reference_number")),
        "date": (fields.get("transaction_date") or "")[:10],
        "orig": Path(original).stem,
    }
    # An empty {amount} must not leave a dangling currency behind.
    if not values["amount"]:
        values["currency"] = ""

    def repl(m):
        return values.get(m.group(1), "")

    rendered = _TOKEN_RE.sub(repl, template)
    return sanitize(rendered) + Path(original).suffix.lower()


def unique_path(folder: Path, filename: str, taken: set[str]) -> Path:
    """Avoid clobbering: name.pdf -> name_2.pdf -> name_3.pdf."""
    stem, suffix = Path(filename).stem, Path(filename).suffix
    candidate, i = filename, 2
    while (folder / candidate).exists() or candidate.lower() in taken:
        candidate = f"{stem}_{i}{suffix}"
        i += 1
    taken.add(candidate.lower())
    return folder / candidate
