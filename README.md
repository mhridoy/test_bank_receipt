# Receipt Renamer

A web page that renames your bank-receipt PDFs — **in your own folder, on your own PC**.

```
PV INV 4260007.PDF   →   SaudiNationalBank_WajdAlamani_SAR440766.48_INV_4260007.pdf
RV INV 7260019.pdf   →   RiyadBank_PioneerMetal_SAR200640.50_INV_7260019.pdf
```

Nothing to install. Nothing is uploaded. You open the page in Chrome or Edge,
click **Choose folder**, and the browser asks your permission to let the page use
that folder. From then on the page reads the PDFs and renames them where they sit.

The reading happens inside the browser tab:

| PDF type | How it is read |
|---|---|
| Digital (text inside the PDF) | pdf.js text layer — instant, exact |
| Scanned / image-only | rendered up to 3800 px, cleaned up, then tesseract.js OCR |

Scans go through a real pipeline, not a plain OCR call:

1. **Rendered in a Web Worker** — a background tab throttles canvas work to a
   standstill, which used to stall the whole run.
2. **Cleaned up** — greyscale, 2–98 % contrast stretch, and for photographed
   receipts (uneven light) a Sauvola *local* threshold instead of a global one.
   The "Sharp" profile also runs an unsharp mask for thin, anti-aliased text.
3. **Lines rebuilt from word boxes** — Tesseract's plain text output glues words
   together on tight layouts (`CORNERSCOMPANYBeneficiaryAccount`); the app measures
   the gaps between word boxes instead.
4. **Retried harder when unsure** — quality *Auto* reads with the balanced profile,
   and if a field is missing or confidence is low it re-reads with the sharp one
   and keeps whichever result is better.

The bank, beneficiary, amount, account number, invoice number and date are then
pulled out with plain rules (`static/engine.js`). No AI service, no API key, no server.

## It learns every day

- **Account numbers and beneficiary IDs.** An IBAN, an account number, or a bank's
  `BEN ID` never changes spelling; a company name does. When a
  receipt is read cleanly, the app stores *account number → company*. Every later
  receipt to that account is named the same way, even if the OCR mangles the name.
  IBANs are checked with the ISO 13616 checksum first, so a mis-read number is
  never learned.
- **Your corrections.** "Fix name" teaches the spelling and the account behind it —
  and so does simply editing a name in the table before renaming: the app compares
  what it generated with what you kept, and learns the difference.
- **OCR spellings.** When an account tells the app who a company really is, the
  mangled spelling on that receipt is remembered too, so the next receipt matches
  even if it shows no account number.
- **Both sides.** The sending account is learned as well, so a company known as a
  payer today is recognised as a beneficiary tomorrow.
- **Duplicates.** Same bank, company, amount and day twice is flagged and left
  unticked, so a double-filed payment does not get renamed into place silently.

Everything it learns lives in this browser (IndexedDB). It also protects itself:
a name that has proved itself over several receipts is not overwritten by one bad
read, and only a person's correction can override a confirmed name.

### One memory for the whole office

Under **Name corrections → Shared office memory**, point every PC at a single JSON
file on your network drive (`Create file` once, `Use existing file` on the others).
Each PC merges that file when the page opens and writes back after every rename —
newest entry per account wins. What one person teaches today, everyone has tomorrow.

---

## Use it

1. Open the page in **Chrome or Edge** (Firefox and Safari cannot open a local
   folder yet — they will show a notice).
2. **Choose folder** → allow the permission prompt (“Edit files”).
3. Check the proposed names. Anything uncertain is marked **review** and is left
   unticked; every name is editable in the table.
4. **Rename selected.** **Undo rename** puts the old names back.

Filter by *Ready / Needs a look / Duplicates / Failed*, search across every field,
press `/` to search, `a` to select all, `Enter` to rename.

After the first visit the page works offline and Chrome/Edge offer to install it
as an app (it is a PWA; the OCR data is cached too).

**Export CSV** gives a report of every file — bank, sender, receiver, amount,
invoice, reference, date — for accounts reconciliation.

The permission lasts for the session; the browser asks again next time you open
the page. Your settings and learned names stay in that browser.

## Name patterns

| Token | Meaning |
|---|---|
| `{bank}` | The bank that issued the receipt (`SaudiNationalBank`, `RiyadBank`) |
| `{party}` | **The other company** — the beneficiary on an outgoing payment, the payer on an incoming one |
| `{sender}` | Account holder / payer |
| `{receiver}` | Beneficiary |
| `{amount}` | Amount debited (`200640.50`) |
| `{amount_net}` | Transfer amount excluding fees, when the receipt shows both |
| `{currency}` | `SAR`, `USD`, … |
| `{inv}` | `INV_00570` — the invoice number with its prefix, or nothing when there is none |
| `{invoice}` | The bare invoice number |
| `{ben_id}` | Beneficiary ID, where the bank prints one |
| `{ref}` | Bank transaction reference |
| `{date}` | Transaction date `YYYY-MM-DD` |
| `{receiver_bank}` | Beneficiary's bank |
| `{orig}` | Original file name |

Presets: `standard` = `{bank}_{party}_{currency}{amount}_{inv}`, `with_date`
(same with the date first — sorts the folder chronologically), `audit` (both
parties), `ref_based`. A token with no value simply disappears from the name.

Company names are cut to their **first two words** by default (`Wajd Alamani
Contracting Establishment` → `WajdAlamani`); change it under *Advanced → Company
name* to one, three, or the full name.

### Arabic receipts

Saudi banks often print only the Arabic name of the beneficiary, glued to its
label, in right-to-left order, with a riyal sign (`⃂`) instead of `SAR`. All of
that is handled: the text is normalised, the name is transliterated for the file
name (`شركة وجد الأماني للمقاولات` → `WajdAlamani`), and the printed Arabic is
kept so a correction can be matched against it later.

Transliteration is a first guess — Arabic does not write short vowels. Fix a
supplier's name once and the app uses your spelling forever, matched by the
beneficiary's account number or bank ID.

Note on amounts: Bank Aljazira prints both the debited total and the transfer
amount before fees (e.g. `302365.00` and `302358.00`). `{amount}` is the debited
total; use `{amount_net}` if your invoices match the other one.

## Teaching it names

OCR spells some company names badly, and receipts write them inconsistently.
Click **teach name** on a row, type the name you want, save. Every receipt with
that text now uses your version. Matching ignores spacing and case.

The list is stored in your browser. **Export** it and **import** it on the other
office PCs so everyone gets the same names.

## Safety

- Nothing is renamed until you press the button — the table is a preview.
- **Undo rename** reverses the last batch (while the page is open).
- Existing files are never overwritten (`…_2.pdf` instead).
- Illegal Windows characters (`\ / : * ? " < > |`) and reserved names are handled.
- The page has no server side: receipts are never sent anywhere.

## Running your own copy

Hosted: any static-file host over **HTTPS** (the folder API needs a secure origin).
This repo has a `Dockerfile` and `render.yaml` for Render — the container only
serves `templates/` and `static/`.

Locally:

```bash
pip install -r requirements.txt
python app.py            # http://127.0.0.1:8765
```

`run.bat` / `run.sh` do the same with a virtual environment.
`http://localhost` counts as a secure origin, so the folder API works there too.

## Adding a bank

Two lists in `static/engine.js`: `BANK_PATTERNS` (how to recognise the bank) and
the `*_RULES` arrays (one regex per field, first match wins). `BANK_ALIASES`
holds the short name used in file names. Usually a one-line addition — send a
sample PDF of any receipt that comes out wrong.

## Layout

```
templates/index.html     the page
static/engine.js         bank detection, field rules, file naming
static/reader.js         pdf.js text extraction + tesseract.js OCR
static/app.js            folder access, table, renaming, learned names
static/style.css
app.py                   serves the page (that is all it does)
desktop/                 optional Python engine + CLI for bulk/other browsers
samples/                 test receipts (not committed - real bank data)
```
