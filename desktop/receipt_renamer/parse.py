"""Rule-based field extraction - no AI, no network, no API key.

Everything here is plain regex over the receipt text (embedded text layer, or
OCR output for scans). Rules are grouped so a new bank layout usually needs one
extra pattern, not new code.
"""
from __future__ import annotations

import re
from datetime import datetime

CURRENCIES = "SAR|USD|EUR|AED|QAR|KWD|BHD|OMR|GBP|JOD|EGP|TRY|INR|CNY"

MONTHS = {m.lower(): i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}

# --- bank identification ----------------------------------------------------
BANK_PATTERNS = [
    ("Riyad Bank",            r"riyad\s*bank|riyadbank\.com|بنك\s*الرياض"),
    ("Bank Aljazira",         r"al\s*jazira|aljazira|bajksa|الجزيرة"),
    ("Al Rajhi Bank",         r"al\s*rajhi|alrajhi|الراجحي"),
    ("Saudi National Bank",   r"saudi\s*national\s*bank|national\s*commercial\s*bank|\bsnb\b|\bncb\b|الأهلي"),
    ("Alinma Bank",           r"alinma|الإنماء"),
    ("Bank Albilad",          r"al\s*bilad|albilad|البلاد"),
    ("Arab National Bank",    r"arab\s*national\s*bank|\banb\b|العربي\s*الوطني"),
    ("SABB",                  r"\bsabb\b|saudi\s*british|الأول"),
    ("Saudi Investment Bank", r"saudi\s*investment\s*bank|\bsaib\b"),
    ("Banque Saudi Fransi",   r"saudi\s*fransi|\bbsf\b|الفرنسي"),
    ("Gulf International Bank", r"gulf\s*international|\bgib\b"),
    ("Emirates NBD",          r"emirates\s*nbd"),
    ("First Abu Dhabi Bank",  r"first\s*abu\s*dhabi|\bfab\b"),
    ("QNB",                   r"\bqnb\b|qatar\s*national"),
    ("HSBC",                  r"\bhsbc\b"),
    ("Standard Chartered",    r"standard\s*chartered"),
    ("Citibank",              r"\bciti\s*bank\b|citibank"),
]

# --- field rules ------------------------------------------------------------
# Each rule is (view, pattern). view: "line" = whitespace-collapsed spaced text,
# "raw" = original line structure, "flat" = all whitespace removed.
RECEIVER_RULES = [
    ("line", r"\bTO\s*:\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s*(?:,|;|\bREF\b|$)"),
    ("line", r"\bBeneficiary\s+(?:Name\s*[:\-]?\s*)?([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s+Beneficiary\s+Account"),
    ("line", r"\bBeneficiary\s+Name\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s{2,}"),
    ("line", r"\b(?:Payee|Pay\s+to|Credit\s+to)\s*[:\-]?\s*([A-Za-z][A-Za-z0-9 &.'\-]{3,70}?)\s*(?:,|$)"),
    ("raw",  r"(?:المستفيد|اسم\s*المستفيد)\s*[:\-]?\s*(.+)"),
]

SENDER_RULES = [
    ("raw",  r"Account\s*Name\s*\n\s*(.+)"),
    ("line", r"\bAccount\s*Name\s*[:\-]\s*([^\n,]{3,70})"),
    ("line", r"\b(?:From|Debit)\s+Account\s+Name\s*[:\-]?\s*([^\n,]{3,70})"),
    ("raw",  r"^(.{6,70})\s*\n\s*The operation has completed"),
    ("raw",  r"(?:اسم\s*(?:صاحب\s*)?الحساب)\s*[:\-]?\s*(.+)"),
    ("raw",  r"^\s*([\u0600-\u06FF][^\n]{5,70})\s*$"),   # an Arabic line is usually the account holder
]

RECEIVER_BANK_RULES = [
    ("line", r"\bTo\s+((?:Saudi|Bank|Al|Arab|National|Riyad|Emirates)[A-Za-z ]{2,30}?Bank)\b"),
    ("line", r"\bBeneficiary\s+Bank\s*[:\-]?\s*([A-Za-z][A-Za-z .'\-]{3,40})"),
    ("line", r"SAR\s*-\s*([A-Z][A-Z ]{3,40}BANK)"),
]

INVOICE_RULES = [
    ("line", r"\b(?:invoice|inv|bill)\b\s*(?:no\.?|number|#)?\s*[:.\-]?\s*(\d[A-Z0-9/\-]{2,20}|[A-Z]{1,4}[\-/]?\d[A-Z0-9/\-]{1,18})"),
    ("raw",  r"(?:رقم\s*الفاتورة|فاتورة)\s*[:\-]?\s*([0-9/\-]{3,20})"),
    ("line", r"\bds\s*0*(\d{5,})\b"),      # Riyad Bank narration tail: ",ds 07260019"
]

REFERENCE_RULES = [
    ("raw",  r"Reference\s*(?:No\.?|Number)?\s*[:\-]?\s*([A-Z0-9]{6,25})\b"),
    ("flat", r"Reference(?:No|Number)?[:\-]?([A-Z0-9]{6,25}?)(?=Currency|Amount|Date|Time|Status|$)"),
    ("flat", r"REF[:\-]?([A-Z0-9]{8,25}?)(?=,|;|Currency|Amount|Date|$)"),
    ("line", r"\bREF\s*[:\-]?\s*([A-Z0-9]{8,25})\b"),
    ("flat", r"TransactionRef(?:erence)?(?:No)?[:\-]?([A-Z0-9]{6,25})"),
]

FEE_WORDS = r"fee|fees|comission|commission|charge|charges|vat|tax|رسوم|عمولة"


LABEL_WORDS = {
    "account type", "account number", "account name", "current account", "branch",
    "amount", "date", "description", "currency", "narration", "cheque no",
    "transaction details", "iban", "detail", "processing date", "status", "beneficiary",
}


def _views(text: str) -> dict:
    from .ocr import _deglue
    line = re.sub(r"\s+", " ", _deglue(text))
    return {"raw": text, "line": line, "flat": re.sub(r"\s+", "", text)}


def _clean_party(value: str) -> str:
    """Drop OCR noise tokens that slipped into a mostly-upper-case company name."""
    tokens = value.split()
    upper = sum(1 for t in tokens if t.isupper() and t.isalpha())
    if upper >= 2:
        tokens = [t for t in tokens if not (any(c.islower() for c in t) and t.isalpha())]
    return " ".join(tokens).strip(" .,:;-،")


def _first(rules, views, flags=re.I) -> str:
    for view, pattern in rules:
        m = re.search(pattern, views[view], flags | re.M)
        if m:
            value = m.group(1).strip(" .,:;-،")
            if value and value.lower() not in LABEL_WORDS:
                return value
    return ""


def find_bank(views: dict) -> str:
    for canon, pattern in BANK_PATTERNS:
        if re.search(pattern, views["line"], re.I):
            return canon
    m = re.search(r"\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,2}\s+Bank)\b", views["line"])
    return m.group(1) if m else ""


def find_amounts(views: dict) -> dict:
    """Return the debited amount, the net/principal amount, and the currency.

    Fee and commission figures are ignored; on a receipt that shows both a total
    and a transfer amount, the larger is the debit and the smaller is the net.
    """
    text = views["line"]
    found: list[tuple[float, str]] = []
    patterns = [
        rf"({CURRENCIES})\s*(-?[\d,]+\.\d{{2}})\b",
        rf"(-?[\d,]+\.\d{{2}})\s*({CURRENCIES})\b",
    ]
    for pattern in patterns:
        for m in re.finditer(pattern, text, re.I):
            a, b = m.group(1), m.group(2)
            currency, raw = (a, b) if re.fullmatch(CURRENCIES, a, re.I) else (b, a)
            before = text[max(0, m.start() - 22):m.start()]
            if re.search(FEE_WORDS, before, re.I):
                continue
            try:
                value = abs(float(raw.replace(",", "")))
            except ValueError:
                continue
            if value > 0:
                found.append((value, currency.upper()))

    if not found:
        return {"amount": "", "amount_net": "", "currency": ""}
    values = sorted({v for v, _ in found}, reverse=True)
    currency = found[0][1]
    return {
        "amount": f"{values[0]:.2f}",
        "amount_net": f"{values[-1]:.2f}",
        "currency": currency,
    }


def find_date(views: dict) -> str:
    text = views["line"]
    m = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})\b", text)
    if m:
        d, mo, y = m.groups()
        return _iso(y, mo, d)
    m = re.search(r"\b(20\d{2})-(\d{2})-(\d{2})\b", text)
    if m:
        return _iso(*m.groups())
    m = re.search(r"\b(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(20\d{2})\b", text)
    if m and m.group(2).lower() in MONTHS:
        return _iso(m.group(3), MONTHS[m.group(2).lower()], m.group(1))
    return ""


def _iso(year, month, day) -> str:
    try:
        return datetime(int(year), int(month), int(day)).strftime("%Y-%m-%d")
    except ValueError:
        return ""


def parse_text(text: str, aliases: dict | None = None) -> dict:
    """Pull every field we know how to name a file with out of receipt text."""
    views = _views(text)
    aliases = aliases or {}

    fields = {
        "bank_name": find_bank(views),
        "sender_name": _clean_party(_first(SENDER_RULES, views)),
        "receiver_name": _clean_party(_first(RECEIVER_RULES, views)),
        "receiver_bank": _first(RECEIVER_BANK_RULES, views),
        "invoice_number": _first(INVOICE_RULES, views),
        "reference_number": _first(REFERENCE_RULES, views),
        "transaction_date": find_date(views),
        "notes": "",
    }
    fields.update(find_amounts(views))
    fields["sender_name_en"] = fields["sender_name"]
    fields["receiver_name_en"] = fields["receiver_name"]

    apply_aliases(fields, aliases)

    missing = [k for k in ("bank_name", "receiver_name", "amount") if not fields[k]]
    fields["confidence"] = "high" if not missing else ("medium" if len(missing) == 1 else "low")
    return fields


def alias_key(text: str) -> str:
    """Match names regardless of OCR spacing: 'PIONEER METAL' == 'PIONEERMETAL'."""
    return re.sub(r"[^0-9A-Za-z؀-ۿ]", "", str(text)).upper()


def apply_aliases(fields: dict, aliases: dict) -> None:
    """Replace raw names with the clean names the user has taught the app."""
    for field, book in (("receiver", aliases.get("receiver", {})),
                        ("sender", aliases.get("sender", {})),
                        ("bank", aliases.get("bank", {}))):
        lookup = {alias_key(k): v for k, v in book.items()}
        if field == "bank":
            clean = lookup.get(alias_key(fields.get("bank_name", "")))
            if clean:
                fields["bank_name"] = clean
        else:
            clean = lookup.get(alias_key(fields.get(f"{field}_name", "")))
            if clean:
                fields[f"{field}_name_en"] = clean
                fields[f"{field}_name"] = clean
