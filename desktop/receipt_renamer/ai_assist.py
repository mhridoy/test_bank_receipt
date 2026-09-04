"""OPTIONAL, OFF BY DEFAULT.

The app is fully rule-based and needs no API. If one day a bank layout refuses
to parse, set "use_ai": true and "api_key" in the settings file and low-confidence
files (only those) get a second pass from Claude. Delete this file if you never
want the option to exist.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path


def refine_with_claude(path: Path, fields: dict, settings: dict) -> dict:
    import anthropic

    key = (settings.get("api_key") or "").strip()
    if not key:
        return fields

    client = anthropic.Anthropic(api_key=key, timeout=180.0)
    pdf_b64 = base64.standard_b64encode(path.read_bytes()).decode("ascii")
    schema = {
        "type": "object",
        "properties": {k: {"type": "string"} for k in (
            "bank_name", "sender_name", "receiver_name", "amount", "currency",
            "invoice_number", "reference_number", "transaction_date")},
        "required": ["bank_name", "sender_name", "receiver_name", "amount", "currency",
                     "invoice_number", "reference_number", "transaction_date"],
        "additionalProperties": False,
    }
    response = client.messages.create(
        model=settings.get("model", "claude-opus-5"),
        max_tokens=2000,
        system=("Read this bank transfer receipt. The sender is the account holder the money "
                "leaves; the receiver is the beneficiary. bank_name is the issuing bank. "
                "amount is digits only. Empty string for anything not printed. Never invent."),
        messages=[{"role": "user", "content": [
            {"type": "document", "source": {"type": "base64",
                                            "media_type": "application/pdf", "data": pdf_b64}},
            {"type": "text", "text": f"File name: {path.name}"},
        ]}],
        output_config={"format": {"type": "json_schema", "schema": schema}},
    )
    text = next(b.text for b in response.content if b.type == "text")
    data = json.loads(text)
    for k, v in data.items():
        if v and not fields.get(k):
            fields[k] = v
    fields["receiver_name_en"] = fields.get("receiver_name", "")
    fields["sender_name_en"] = fields.get("sender_name", "")
    fields["_engine"] = fields.get("_engine", "") + "+ai"
    return fields
