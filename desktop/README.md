# Optional desktop engine (Python)

The app itself is the static site in the repo root — it runs in Chrome/Edge, reads
the folder you pick and renames the files there, with no install and no upload.

This folder keeps the original Python implementation of the same rules
(`parse.py`, `naming.py`, OCR through RapidOCR). It is useful for:

- batch work over thousands of files, where a script beats a browser tab
- browsers without the File System Access API (Firefox, Safari)

`static/engine.js` in the repo root is a port of `parse.py` + `naming.py`.
**When you add a bank rule, add it in both places.**

The browser version has since gained things this one does not have: account-number
learning, IBAN checksum validation, duplicate detection and the adaptive OCR
pipeline. Treat the browser app as the reference implementation.

Run the CLI:

```bash
pip install -r ../requirements-desktop.txt
python -m desktop.rename_cli "C:\path\to\receipts" --template "{bank}_{receiver}_{amount}{currency}_{invoice}" --apply
```
