"""Command-line fallback: rename a folder of receipts without a browser.

    python -m desktop.rename_cli "C:\\receipts" --apply

Same rules as the web page (see desktop/README.md).
"""
from __future__ import annotations

import argparse
from pathlib import Path

from .receipt_renamer import config
from .receipt_renamer.extract import extract_fields
from .receipt_renamer.naming import build_name, unique_path
from .receipt_renamer.renamer import list_pdfs


def main() -> None:
    ap = argparse.ArgumentParser(description="Rename bank-receipt PDFs.")
    ap.add_argument("folder", type=Path)
    ap.add_argument("--template", default=config.DEFAULT_TEMPLATE)
    ap.add_argument("--recursive", action="store_true")
    ap.add_argument("--keep-legal-suffix", action="store_true",
                    help="keep 'Company / LLC / Est' in names")
    ap.add_argument("--apply", action="store_true",
                    help="actually rename; without it you only get the preview")
    args = ap.parse_args()

    files = list_pdfs(args.folder, args.recursive)
    if not files:
        print(f"No PDF files in {args.folder}")
        return

    settings = {"ocr_dpi": 400}
    aliases = config.load_aliases()
    taken: set[str] = set()

    for path in files:
        fields = extract_fields(path, settings, aliases)
        proposed = build_name(fields, args.template, path.name,
                              not args.keep_legal_suffix, True)
        flag = "" if fields.get("confidence") == "high" else "  [check]"
        print(f"{path.name}\n  -> {proposed}{flag}")
        if args.apply and proposed != path.name:
            path.rename(unique_path(path.parent, proposed, taken))

    print(f"\n{len(files)} file(s) {'renamed' if args.apply else 'previewed (use --apply)'}.")


if __name__ == "__main__":
    main()
