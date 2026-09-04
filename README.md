# Bank Receipt Renamer

A local web app for the office: point it at a folder of bank-receipt PDFs
(Riyad Bank, Bank Aljazira, Al Rajhi, SNB… Arabic, English, scanned or digital)
and it renames every file to one consistent pattern.

```
RV INV 7260019.pdf   ->   RiyadBank_PioneerMetalCorners_200640.50SAR_7260019.pdf
```

**No AI service, no API key, no account, no internet.** Everything runs on the PC:

| PDF type | How it is read |
|---|---|
| Digital (text inside the PDF) | PyMuPDF text layer — instant and exact |
| Scanned / image-only | RapidOCR — offline OCR, installed by `pip`, no Tesseract, no admin rights |

The fields are then pulled out with plain rules (`receipt_renamer/parse.py`) —
readable regex per bank, easy to extend.

---

## 1. Install (Windows)

1. Install Python 3 from <https://www.python.org/downloads/> and tick
   **“Add python.exe to PATH”**.
2. Copy this folder onto the PC (or a shared drive).
3. Double-click **`run.bat`**. The first run builds a private `.venv` and
   installs the three dependencies (~100 MB, one time). Later runs start in seconds.
4. The browser opens at <http://127.0.0.1:8765>.

macOS / Linux: `./run.sh`.

After the first install the PC can stay offline — nothing is downloaded or sent
at run time.

## 2. Daily use

1. **Browse…** to the receipts folder (or paste the path).
2. **Read receipts.** Digital PDFs finish instantly; scans take ~3–5 seconds each
   (plus ~15 s once, the first time OCR starts).
3. Check the table. Anything the rules were unsure about is marked **review** and
   is left unticked. Every proposed name is editable inline.
4. **Rename selected files.**
5. Wrong? **Undo** the whole batch under *Recent renames*.

**Export CSV** gives a report of every file — bank, sender, receiver, amount,
invoice, reference, date — useful for accounts reconciliation.

## 3. Teaching it names (this is the “training”)

OCR spells some company names badly (`TEBEBEARABICLALAKAHADAMATALBIIHCO`) and
receipts write them inconsistently (`PIONEER METAL CORNERS COMPANY`).

Click **teach name** on any row, type the name you want, save. From then on
every receipt with that text uses your version — automatically, on every scan.
The list lives under **Learned names** and is stored in
`%APPDATA%\BankReceiptRenamer\aliases.json`, so it can be copied to the other
office PCs once one person has cleaned it up.

Matching ignores spacing and case, so `PIONEERMETALCORNERS` and
`Pioneer Metal Corners` are treated as the same name.

## 4. Name patterns

Pick a preset or write your own. Tokens:

| Token | Meaning |
|---|---|
| `{bank}` | Sending bank, canonical short form (`RiyadBank`, `AlJaziraBank`) |
| `{sender}` | Account holder / payer |
| `{receiver}` | Beneficiary |
| `{amount}` | Amount debited (`200640.50`) |
| `{amount_net}` | Transfer amount excluding fees, when the receipt shows both |
| `{currency}` | `SAR`, `USD`, … |
| `{invoice}` | Invoice number, if the receipt shows one |
| `{ref}` | Bank transaction reference |
| `{date}` | Transaction date `YYYY-MM-DD` |
| `{receiver_bank}` | Beneficiary's bank |
| `{orig}` | Original file name |

Presets:

- `standard` — `{bank}_{receiver}_{amount}{currency}_{invoice}` (your format)
- `with_date` — same, date first. **Recommended for archives**: the folder sorts
  chronologically and repeat payments to one supplier stay apart.
- `audit` — `{date}_{bank}_{sender}_TO_{receiver}_{amount}{currency}_{invoice}`
- `ref_based` — bank reference instead of an invoice number

A token with no value disappears from the name; no stray underscores.

Note on amounts: Bank Aljazira receipts print both the debited total and the
transfer amount before fees (e.g. `302365.00` and `302358.00`). `{amount}` uses
the debited total; switch to `{amount_net}` if your invoices match the other one.

## 5. Safety

- Nothing is renamed until you press the button — the table is only a preview.
- Every batch writes an undo log to `%APPDATA%\BankReceiptRenamer\history\`.
- Existing files are never overwritten (`…_2.pdf` instead).
- Illegal Windows characters (`\ / : * ? " < > |`) and reserved names handled.
- Serves on `127.0.0.1` only — not reachable from other machines.
- Receipt contents never leave the PC.

## 6. Adding a new bank

Two files, both plain Python lists:

- `receipt_renamer/parse.py` — `BANK_PATTERNS` (how to recognise the bank) and the
  `*_RULES` lists (one regex per field; the first match wins).
- `receipt_renamer/naming.py` — `BANK_ALIASES` for the short name used in file names.

Send a sample PDF of any bank that comes out wrong and it is usually a one-line
addition. `samples/` holds the current test receipts.

## 7. About hosting it on a server

**A hosted copy cannot rename files in your folder.** A web page served from a
server has no access to `D:\Receipts` on your PC — the browser forbids it. That
is why this app is meant to run *on* the PC that holds the receipts: only then
can it rename files where they sit.

The repo does contain `Dockerfile` + `render.yaml` for a hosted copy, but that
copy runs in a different mode (`CLOUD_MODE=1`): you upload PDFs, it renames the
copies and gives you a ZIP back. Useful only for someone who cannot install
anything locally — and it sends receipts to a server, which the desktop version
never does. Set `APP_PASSWORD` (and `SECRET_KEY`) if you do host it.

For the office, run it locally on each PC, or on one PC that has the shared
receipts drive mapped.

## 8. Layout

```
app.py                     Flask routes
receipt_renamer/
  config.py                settings, learned-name store
  extract.py               text layer -> OCR fallback
  ocr.py                   offline RapidOCR wrapper
  parse.py                 bank detection + field rules (no AI)
  naming.py                bank short names, sanitising, name template
  renamer.py               scan jobs, apply, undo history
  ai_assist.py             optional, OFF by default - unused unless you enable it
templates/ static/         UI
samples/                   test receipts
```

`ai_assist.py` is the only file that could ever call an online service, and it is
never reached unless someone sets `"use_ai": true` in the settings file. Delete
it if you want the guarantee in writing.
