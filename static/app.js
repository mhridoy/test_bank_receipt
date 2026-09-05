/* Controller: pick a folder, read every receipt, review, rename in place.
   Everything runs in this tab - see reader.js (workers + OCR), engine.js (rules)
   and memory.js (what the app remembers between sessions). */

import { animate, stagger } from "https://cdn.jsdelivr.net/npm/motion@11.11.17/+esm";
import { parseText, buildName, duplicateKey, aliasKey } from "./engine.js";
import { readPdf, shutdownReaders } from "./reader.js";
import * as memory from "./memory.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const HAS_FS = "showDirectoryPicker" in window;

const DEFAULTS = {
  template: "{bank}_{party}_{currency}{amount}_{inv}",
  recursive: false, stripLegal: true, invFromName: true,
  useOcr: true, autoLearn: true, quality: "auto", ocrLangs: "eng", theme: "system",
  nameWords: 2, shortBankNames: true, trimCents: false,
};

let settings = { ...DEFAULTS };
let dirHandle = null;
let rows = [];
let names = { receiver: {}, sender: {}, bank: {} };
let filter = "all";
let search = "";
let cancelled = false;
let teachRow = null;

/* ── small helpers ─────────────────────────────────────────────── */

/** motion returns different control objects across versions - never assume .finished. */
const finished = (controls) => Promise.resolve(controls?.finished ?? controls).catch(() => {});

function toast(message, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  $("toasts").appendChild(el);
  animate(el, { opacity: [0, 1], y: [14, 0], scale: [0.96, 1] },
          { duration: 0.28, easing: [0.2, 0.8, 0.2, 1] });
  setTimeout(async () => {
    await finished(animate(el, { opacity: 0, y: 8 }, { duration: 0.2 }));
    el.remove();
  }, 3800);
}

const options = () => ({
  template: $("template").value,
  recursive: $("recursive").checked,
  stripLegal: $("stripLegal").checked,
  invFromName: $("invFromName").checked,
  useOcr: $("useOcr").checked,
  autoLearn: $("autoLearn").checked,
  quality: $("quality").value,
  ocrLangs: $("ocrLangs").value,
  nameWords: Number($("nameWords").value),
  shortBankNames: $("shortBank").checked,
  trimCents: $("trimCents").checked,
  theme: settings.theme,
});

async function persist() {
  settings = options();
  await memory.saveSettings(settings);
}

/* ── theme ─────────────────────────────────────────────────────── */

function applyTheme(theme) {
  const dark = theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
$("themeBtn").onclick = () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  applyTheme(settings.theme);
  persist();
};

/* ── name pattern ──────────────────────────────────────────────── */

const SAMPLE = {
  bank: "RiyadBank", sender: "TabeebArabia", receiver: "PioneerMetalCorners",
  amount: "200640.50", amount_net: "200632.45", currency: "SAR", invoice: "7260019",
  ref: "946702450951BNBD", date: "2026-09-02", receiver_bank: "SaudiNationalBank",
  orig: "RV INV 7260019",
};

function updateExample() {
  const name = $("template").value.replace(/\{(\w+)\}/g, (_, k) => SAMPLE[k] ?? "");
  $("example").textContent = name.replace(/_{2,}/g, "_").replace(/^[_\-.]+|[_\-.]+$/g, "") + ".pdf";
  document.querySelectorAll(".preset").forEach((p) =>
    p.classList.toggle("active", p.dataset.tpl === $("template").value));
}

document.querySelectorAll(".preset").forEach((preset) => {
  preset.onclick = () => {
    $("template").value = preset.dataset.tpl;
    updateExample(); persist(); rebuildNames();
    animate(preset, { scale: [0.97, 1] }, { duration: 0.22 });
  };
});
document.querySelectorAll(".token").forEach((btn) => {
  btn.onclick = () => { $("template").value += btn.dataset.token; updateExample(); persist(); rebuildNames(); };
});
$("template").oninput = updateExample;
$("template").onchange = () => { persist(); rebuildNames(); };
$("advBtn").onclick = () => {
  const panel = $("advanced");
  panel.hidden = !panel.hidden;
  if (!panel.hidden) animate(panel, { opacity: [0, 1], y: [-6, 0] }, { duration: 0.25 });
};
["stripLegal", "invFromName", "useOcr", "autoLearn", "recursive", "quality", "ocrLangs", "nameWords", "shortBank", "trimCents"]
  .forEach((id) => ($(id).onchange = () => { persist(); if (id !== "recursive") rebuildNames(); }));

/* ── folder ────────────────────────────────────────────────────── */

if (!HAS_FS) { $("noFs").hidden = false; $("pickBtn").disabled = true; }

async function pickFolder() {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "receipts" });
  } catch { return; }
  if (await dirHandle.requestPermission({ mode: "readwrite" }) !== "granted")
    return toast("Permission to change files was not granted.", "bad");
  $("pickState").hidden = true;
  $("folderState").hidden = false;
  $("folderName").textContent = dirHandle.name;
  animate($("folderState"), { opacity: [0, 1], y: [-6, 0] }, { duration: 0.3 });
  scan();
}
$("pickBtn").onclick = pickFolder;
$("changeBtn").onclick = pickFolder;
$("rescanBtn").onclick = () => dirHandle && scan();

async function* walk(handle, prefix = "", recursive = false) {
  for await (const entry of handle.values()) {
    if (entry.kind === "file" && entry.name.toLowerCase().endsWith(".pdf")
        && !entry.name.startsWith(".") && !entry.name.startsWith("~$")) {
      yield { handle: entry, parent: handle, name: entry.name, relative: prefix + entry.name };
    } else if (entry.kind === "directory" && recursive && !entry.name.startsWith(".")) {
      yield* walk(entry, prefix + entry.name + "/", true);
    }
  }
}

/* ── reading ───────────────────────────────────────────────────── */

/** Read one file, escalating to a slower, more careful pass when the first one
    misses something. Quality "auto" is what makes a poor scan still come out right. */
async function readWithRetry(row, o, onStatus) {
  const ladder = o.quality === "auto" ? ["balanced", "sharp"] : [o.quality];
  let best = null;

  for (const profile of ladder) {
    const file = await row.handle.getFile();
    const result = await readPdf(await file.arrayBuffer(),
      { allowOcr: o.useOcr, langs: o.ocrLangs, profile, onStatus });
    const fields = parseText(result.text, names);
    const score = 3 - fields.missing.length + (result.confidence ?? 0) / 200;
    if (!best || score > best.score) best = { ...result, fields, score, profile };
    if (!fields.missing.length && (result.confidence ?? 100) >= 75) break;
    if (result.engine !== "ocr") break;             // a text layer will not improve
  }
  return best;
}

/** Fill in from memory: the account number is the anchor, the printed name is not. */
async function applyMemory(fields) {
  let known = await memory.lookupAccount(fields.receiver_account);
  for (const key of fields.receiver_accounts || []) {          // an in-bank transfer
    if (known?.name) break;                                    // may print a different
    known = await memory.lookupAccount(key);                   // number for the same firm
    if (known?.name) fields.receiver_account = key;
  }
  if (known?.name) {
    const printed = aliasKey(fields.receiver_name || "");
    if (!printed || aliasKey(known.name) !== printed) {
      // The account says who this is, so the mis-read spelling is worth keeping
      // too: the next receipt may not show an account number at all.
      if (fields.receiver_name && fields.receiver_name.length > 3)
        await memory.rememberName(fields.receiver_name, known.name, "auto");
      fields.receiver_name = known.name;
      fields.receiver_name_en = known.name;
      fields.from_memory = true;
      fields.missing = fields.missing.filter((m) => m !== "receiver_name");
    }
    // count the sighting either way, so the list shows which accounts are common
    await memory.rememberAccount(fields.receiver_account, known.name, {});
  }
  return fields;
}

async function learnFrom(fields) {
  if (!settings.autoLearn) return;
  const name = fields.receiver_name_en || fields.receiver_name;
  const trustworthy = fields.receiver_account &&
    (fields.receiver_account_valid !== false) &&   // never learn from a mis-read IBAN
    name && name.length > 3 && !fields.from_memory;
  if (!trustworthy) return;
  // A company can appear as an IBAN on one receipt and a plain account number on
  // an in-bank transfer: remember every number seen on the beneficiary's side.
  const keys = fields.receiver_accounts?.length ? fields.receiver_accounts : [fields.receiver_account];
  for (const key of keys) {
    await memory.rememberAccount(key, name, { bank: fields.receiver_bank || "",
                                              kind: key === fields.receiver_account
                                                ? fields.receiver_account_kind : "linked" });
  }
  // The sending account belongs to a company as well - worth knowing when that
  // company turns up as the beneficiary on someone else's receipt.
  const sender = fields.sender_name_en || fields.sender_name;
  if (fields.sender_account && sender && sender.length > 3)
    await memory.rememberAccount(fields.sender_account, sender, { side: "sender" });
}

async function scan() {
  const o = options();
  cancelled = false;
  rows = [];
  names = await memory.nameBook();

  for await (const file of walk(dirHandle, "", o.recursive)) {
    rows.push({ ...file, status: "pending", proposed: "", fields: {}, rawFields: null,
                engine: "", notes: "", confidence: null });
    if (rows.length >= 800) break;
  }
  $("fileCount").textContent = `${rows.length} PDF${rows.length === 1 ? "" : "s"}`;
  if (!rows.length) { toast("No PDF files in that folder."); return; }

  rows.sort((a, b) => a.relative.localeCompare(b.relative, undefined, { numeric: true }));
  $("results").hidden = false;
  $("progress").hidden = false;
  setProgress(0, rows.length, "");
  render();

  let done = 0;
  for (const row of rows) {
    if (cancelled) { row.status = "cancelled"; done++; continue; }
    setProgress(done, rows.length, row.name);
    try {
      const result = await readWithRetry(row, o, (msg) => setProgress(done, rows.length, `${row.name} — ${msg}`));
      const fields = await applyMemory(result.fields);
      await learnFrom(fields);

      row.rawFields = { ...fields };
      row.fields = fields;
      row.engine = result.engine + (result.profile && result.engine === "ocr" ? `·${result.profile}` : "");
      row.confidence = result.confidence;
      row.notes = result.note || "";
      row.proposed = buildName(fields, o.template, row.name, o.stripLegal, o.invFromName, o.nameWords, o);
      row.status = fields.missing.length ? "review" : "ready";
      if (fields.missing.length) row.notes = `${row.notes} Missing: ${fields.missing.join(", ")}.`.trim();
      else if ((result.confidence ?? 100) < 65) {
        row.status = "review";
        row.notes = `${row.notes} The scan was hard to read (${result.confidence}% sure).`.trim();
      }
    } catch (error) {
      row.status = "error";
      row.notes = String(error?.message || error);
    }
    done++;
    setProgress(done, rows.length, "");
    render();
  }

  markDuplicates();
  $("progress").hidden = true;
  render();
  renderMemory();
  const ready = rows.filter((r) => r.status === "ready").length;
  toast(`Read ${rows.length} file${rows.length === 1 ? "" : "s"} · ${ready} ready to rename`);
}

/** Same bank, company, amount and day twice = probably a double-filed payment. */
function markDuplicates() {
  const seen = new Map();
  for (const row of rows) {
    const key = duplicateKey(row.fields || {});
    if (!key) continue;
    if (seen.has(key)) { row.duplicateOf = seen.get(key); } else seen.set(key, row.relative);
  }
}

function setProgress(done, total, detail) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  $("ringFill").style.strokeDashoffset = String(97.4 - (97.4 * pct) / 100);
  $("ringText").textContent = pct + "%";
  $("progressTitle").textContent = `Reading ${Math.min(done + 1, total)} of ${total}`;
  $("progressDetail").textContent = detail;
}
$("cancelBtn").onclick = () => { cancelled = true; toast("Stopping after this file…"); };

/* ── rendering ─────────────────────────────────────────────────── */

function visibleRows() {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "duplicate" && !r.duplicateOf) return false;
    if (filter !== "all" && filter !== "duplicate" && r.status !== filter) return false;
    if (!q) return true;
    const f = r.fields || {};
    return [r.relative, r.proposed, f.bank_name, f.receiver_name, f.amount, f.invoice_number]
      .some((v) => String(v ?? "").toLowerCase().includes(q));
  });
}

function render() {
  const count = (s) => rows.filter((r) => r.status === s).length;
  const counts = { all: rows.length, ready: count("ready"), review: count("review"),
                   duplicate: rows.filter((r) => r.duplicateOf).length, error: count("error") };
  document.querySelectorAll(".filter").forEach((b) => {
    b.querySelector("b").textContent = counts[b.dataset.filter] ?? 0;
    b.classList.toggle("active", b.dataset.filter === filter);
  });

  const body = $("table").tBodies[0];
  body.innerHTML = "";
  const list = visibleRows();
  $("emptyState").hidden = list.length > 0;

  for (const r of list) {
    const i = rows.indexOf(r);
    const f = r.fields || {};
    const chips = [
      f.bank_name && `<span class="chip"><b>${esc(f.bank_name)}</b></span>`,
      (f.receiver_name_en || f.receiver_name) &&
        `<span class="chip ${f.from_memory ? "learned" : ""}">to <b>${esc(f.receiver_name_en || f.receiver_name)}</b>${f.from_memory ? " · remembered" : ""}</span>`,
      f.amount && `<span class="chip"><b>${esc(f.amount)}</b> ${esc(f.currency || "")}</span>`,
      f.invoice_number && `<span class="chip">inv <b>${esc(f.invoice_number)}</b></span>`,
      f.transaction_date && `<span class="chip">${esc(f.transaction_date)}</span>`,
      f.receiver_account && `<span class="chip mono">${esc(f.receiver_account.slice(0, 6))}…${esc(f.receiver_account.slice(-4))}</span>`,
      r.engine && `<span class="chip">${esc(r.engine)}${r.confidence != null && r.engine.startsWith("ocr") ? ` ${r.confidence}%` : ""}</span>`,
      r.duplicateOf && `<span class="chip dup">possible duplicate of ${esc(r.duplicateOf)}</span>`,
    ].filter(Boolean).join("");

    const tr = document.createElement("tr");
    tr.dataset.i = i;
    tr.innerHTML = `
      <td><input type="checkbox" class="pick" data-i="${i}"
           ${r.status === "ready" && !r.duplicateOf ? "checked" : ""}
           ${r.status === "ready" || r.status === "review" ? "" : "disabled"}></td>
      <td>
        ${r.status === "renamed"
          ? `<div class="done-name mono">${esc(r.relative)}</div>
             <div class="old-name mono">was ${esc(r.previous || "")}</div>`
          : `<div class="old-name mono">${esc(r.relative)}</div>
             ${r.proposed ? `<div class="arrow">↓</div>
               <input class="new-name mono" type="text" data-i="${i}" value="${esc(r.proposed)}">`
             : '<span class="muted small">nothing readable</span>'}`}
      </td>
      <td><div class="chips">${chips || '<span class="muted small">no details found</span>'}</div></td>
      <td><span class="pill ${r.status}">${r.status}</span>
          ${r.notes ? `<span class="note">${esc(r.notes)}</span>` : ""}</td>
      <td><div class="row-links">
        <button class="link view" data-i="${i}">Open PDF</button>
        ${r.rawFields?.receiver_name || r.fields?.receiver_account
          ? `<button class="link teach" data-i="${i}">Fix name</button>` : ""}
      </div></td>`;
    body.appendChild(tr);
  }

  if (body.children.length) {
    animate(body.children, { opacity: [0, 1], y: [6, 0] },
            { delay: stagger(0.012), duration: 0.24, easing: [0.2, 0.8, 0.2, 1] });
  }
  updateActionBar();
}

function updateActionBar() {
  const picked = document.querySelectorAll(".pick:checked").length;
  const bar = $("actionBar");
  $("selCount").textContent = `${picked} file${picked === 1 ? "" : "s"} selected`;
  if (picked && bar.hidden) {
    bar.hidden = false;
    animate(bar, { opacity: [0, 1], y: [20, 0] }, { duration: 0.28, easing: [0.2, 0.8, 0.2, 1] });
  } else if (!picked && !bar.hidden) {
    finished(animate(bar, { opacity: 0, y: 16 }, { duration: 0.18 })).then(() => (bar.hidden = true));
  }
  document.querySelectorAll("#table tbody tr").forEach((tr) => {
    tr.classList.toggle("picked", tr.querySelector(".pick")?.checked === true);
  });
}

$("selectAll").onchange = (e) => {
  document.querySelectorAll(".pick:not(:disabled)").forEach((c) => (c.checked = e.target.checked));
  updateActionBar();
};
$("clearSel").onclick = () => {
  document.querySelectorAll(".pick").forEach((c) => (c.checked = false));
  $("selectAll").checked = false;
  updateActionBar();
};
document.addEventListener("change", (e) => { if (e.target.classList.contains("pick")) updateActionBar(); });

document.querySelectorAll(".filter").forEach((b) => {
  b.onclick = () => { filter = b.dataset.filter; render(); };
});
$("search").oninput = (e) => { search = e.target.value; render(); };

function rebuildNames() {
  const o = options();
  for (const row of rows) {
    if (!row.rawFields || row.status === "renamed") continue;
    row.fields = { ...row.rawFields };
    row.proposed = buildName(row.fields, o.template, row.name, o.stripLegal, o.invFromName, o.nameWords, o);
  }
  render();
}

/* ── row actions ───────────────────────────────────────────────── */

document.addEventListener("click", async (e) => {
  const i = Number(e.target.dataset?.i);
  if (e.target.classList.contains("view")) {
    const file = await rows[i].handle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  if (e.target.classList.contains("teach")) openTeach(rows[i]);
});

function openTeach(row) {
  teachRow = row;
  const raw = row.rawFields?.receiver_name || "";
  const account = row.fields?.receiver_account || "";
  $("teachRaw").value = raw || "(nothing readable)";
  $("teachClean").value = row.fields?.receiver_name || raw;
  $("teachHint").textContent = raw
    ? "The receipt spells it like this. Type the name you want in file names."
    : "The name could not be read. Type the company name for this account.";
  $("teachAccountRow").hidden = !account;
  $("teachAccountNo").textContent = account;
  $("teachDialog").showModal();
  $("teachClean").focus();
}

$("teachCancel").onclick = (e) => { e.preventDefault(); $("teachDialog").close(); };
$("teachSave").onclick = async (e) => {
  e.preventDefault();
  const clean = $("teachClean").value.trim();
  if (!clean || !teachRow) return;
  const raw = teachRow.rawFields?.receiver_name || "";
  const account = teachRow.fields?.receiver_account || "";
  if (raw) await memory.rememberName(raw, clean);
  if (account && $("teachAccount").checked)
    await memory.rememberAccount(account, clean, { confirmed: true });
  $("teachDialog").close();

  names = await memory.nameBook();
  const o = options();
  for (const row of rows) {
    if (!row.rawFields || row.status === "renamed") continue;
    const sameName = raw && aliasKey(row.rawFields.receiver_name) === aliasKey(raw);
    const sameAccount = account && row.fields.receiver_account === account;
    if (!sameName && !sameAccount) continue;
    row.fields.receiver_name = clean;
    row.fields.receiver_name_en = clean;
    row.fields.from_memory = true;
    row.rawFields.receiver_name = row.rawFields.receiver_name || clean;
    row.fields.missing = (row.fields.missing || []).filter((m) => m !== "receiver_name");
    row.status = row.fields.missing.length ? "review" : "ready";
    row.proposed = buildName(row.fields, o.template, row.name, o.stripLegal, o.invFromName, o.nameWords, o);
  }
  markDuplicates();
  render();
  renderMemory();
  toast(`Saved — “${clean}” will be used from now on.`);
};

/* ── renaming ──────────────────────────────────────────────────── */

$("applyBtn").onclick = async () => {
  const edits = {};
  document.querySelectorAll(".new-name").forEach((input) => (edits[+input.dataset.i] = input.value));
  const picks = [...document.querySelectorAll(".pick:checked")].map((c) => +c.dataset.i);
  if (!picks.length) return toast("Nothing selected.");
  if (!confirm(`Rename ${picks.length} file(s) in “${dirHandle.name}”?`)) return;

  const existing = new Set(rows.map((r) => r.name.toLowerCase()));
  const batch = [];
  let renamed = 0, skipped = 0, failed = 0;

  for (const i of picks) {
    const row = rows[i];
    let target = (edits[i] || row.proposed || "").trim();
    if (!target) { skipped++; continue; }
    if (!target.toLowerCase().endsWith(".pdf")) target += ".pdf";
    if (target === row.name) { skipped++; continue; }

    let unique = target, n = 2;
    while (existing.has(unique.toLowerCase()))
      unique = target.replace(/\.pdf$/i, "") + `_${n++}.pdf`;

    try {
      await learnFromEdit(row, edits[i]);
      await renameFile(row, unique);
      existing.delete(row.name.toLowerCase());
      existing.add(unique.toLowerCase());
      batch.push({ index: i, from: row.name, to: unique, path: row.relative });
      row.previous = row.name;
      row.relative = row.relative.replace(/[^/]+$/, unique);
      row.name = unique;
      row.proposed = unique;
      row.status = "renamed";
      renamed++;
    } catch (error) {
      failed++;
      row.status = "error";
      row.notes = String(error?.message || error);
    }
  }

  if (batch.length) {
    lastBatch = batch;
    await memory.saveBatch(batch, dirHandle.name);
    $("undoBtn").hidden = false;
  }
  render();
  if (learnedFromEdits) {
    names = await memory.nameBook();
    toast(`Learned ${learnedFromEdits} correction${learnedFromEdits === 1 ? "" : "s"} from your edits.`);
    learnedFromEdits = 0;
  }
  await renderMemory();
  await pushToTeamFile();
  toast(`Renamed ${renamed}${skipped ? ` · skipped ${skipped}` : ""}${failed ? ` · failed ${failed}` : ""}`,
        failed ? "bad" : "");
};

let lastBatch = null;

/** If someone corrected the company inside the file name before renaming, that
    is a lesson: store it against the account and the printed spelling. This is
    what makes the app steadily better the more the office uses it.

    The lesson is read by comparing the name the app generated with the name the
    person kept, segment by segment - guessing which word is the company would
    happily "learn" the bank's own name. */
async function learnFromEdit(row, edited) {
  if (!settings.autoLearn || !edited || !row.rawFields) return;
  const o = options();
  const generated = buildName(row.fields, o.template, row.name, o.stripLegal, o.invFromName, o.nameWords, o);
  const before = generated.replace(/\.pdf$/i, "").split("_");
  const after = edited.trim().replace(/\.pdf$/i, "").split("_");
  if (before.length !== after.length) return;                  // structure changed, not a rename of the party

  const receiverSegment = buildName({ ...row.fields, bank_name: "", amount: "", currency: "",
                                      invoice_number: "", reference_number: "",
                                      transaction_date: "", sender_name: "", sender_name_en: "" },
                                    "{party}", "x.pdf", o.stripLegal, false, o.nameWords, o).replace(/\.pdf$/i, "");
  if (!receiverSegment) return;

  const changed = before.map((part, i) => [part, after[i]]).filter(([a, b]) => a !== b);
  if (changed.length !== 1) return;                            // several edits: too ambiguous to learn from
  const [wasSegment, nowSegment] = changed[0];
  if (wasSegment !== receiverSegment || nowSegment.length < 3) return;

  const spaced = nowSegment.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  if (looksLikeABank(spaced)) return;                          // never learn a bank as the customer

  const printed = row.rawFields.receiver_name;
  if (printed) await memory.rememberName(printed, spaced, "manual");
  const keys = row.fields.receiver_accounts?.length
    ? row.fields.receiver_accounts : [row.fields.receiver_account];
  for (const key of keys) if (key) await memory.rememberAccount(key, spaced, { confirmed: true });
  learnedFromEdits++;
}

let learnedFromEdits = 0;

const BANKISH = /bank|masraf|مصرف|بنك|rajhi|jazira|riyad|alinma|albilad|sabb|anb\b|snb\b/i;
const looksLikeABank = (value) => BANKISH.test(value);

async function renameFile(row, newName) {
  if (row.handle.move) return row.handle.move(newName);   // Chrome / Edge
  const file = await row.handle.getFile();                // fallback: copy then delete
  const target = await row.parent.getFileHandle(newName, { create: true });
  const writable = await target.createWritable();
  await writable.write(await file.arrayBuffer());
  await writable.close();
  await row.parent.removeEntry(row.name);
  row.handle = target;
}

$("undoBtn").onclick = async () => {
  if (!lastBatch?.length) return;
  let restored = 0;
  for (const entry of [...lastBatch].reverse()) {
    const row = rows[entry.index];
    if (!row) continue;
    try {
      await renameFile(row, entry.from);
      row.relative = row.relative.replace(/[^/]+$/, entry.from);
      row.name = entry.from;
      row.previous = "";
      row.proposed = entry.to;
      row.status = row.fields?.missing?.length ? "review" : "ready";
      restored++;
    } catch { /* keep going */ }
  }
  lastBatch = null;
  $("undoBtn").hidden = true;
  render();
  toast(`Restored ${restored} original name${restored === 1 ? "" : "s"}.`);
};

/* ── the shared team file ──────────────────────────────────────── */

let teamHandle = null;

async function pushToTeamFile(quiet = true) {
  if (!teamHandle) return;
  const result = await memory.syncWithFile(teamHandle);
  if (result?.error === "permission") {
    if (!quiet) toast("The team file needs permission again — click Sync.", "bad");
    return;
  }
  if (!quiet && result) toast(`Team file synced · ${result.pulled} new item(s) came in.`);
  renderTeamState(result);
}

function renderTeamState(result) {
  const row = $("teamState");
  if (!teamHandle) { row.textContent = "No shared file yet."; return; }
  const when = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  row.innerHTML = `Sharing with <strong class="mono">${esc(teamHandle.name)}</strong>` +
    (result ? ` · synced ${esc(when)}` : "");
}

$("teamPick").onclick = async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      id: "team-memory", multiple: false,
      types: [{ description: "Receipt Renamer memory", accept: { "application/json": [".json"] } }],
    });
    teamHandle = handle;
  } catch { return; }
  await memory.setSyncHandle(teamHandle);
  await pushToTeamFile(false);
  names = await memory.nameBook();
  renderMemory();
  render();
};

$("teamCreate").onclick = async () => {
  try {
    teamHandle = await window.showSaveFilePicker({
      id: "team-memory", suggestedName: "receipt-renamer-memory.json",
      types: [{ description: "Receipt Renamer memory", accept: { "application/json": [".json"] } }],
    });
  } catch { return; }
  await memory.setSyncHandle(teamHandle);
  await pushToTeamFile(false);
};

$("teamSync").onclick = () => pushToTeamFile(false);
$("teamForget").onclick = async () => {
  teamHandle = null;
  await memory.clearSyncHandle();
  renderTeamState();
  toast("Stopped using the shared file.");
};

/* ── memory panels ─────────────────────────────────────────────── */

async function renderMemory() {
  const accounts = (await memory.listAccounts()).sort((a, b) => b.seen - a.seen);
  const accountList = $("accountList");
  accountList.innerHTML = accounts.length ? "" :
    '<li class="muted small">No accounts learned yet — read a folder and they appear here.</li>';
  for (const account of accounts.slice(0, 50)) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="grow"><strong>${esc(account.name)}</strong>
      <span class="sub mono">${esc(account.key)} · seen ${account.seen}×${account.confirmed ? " · confirmed" : ""}</span></span>`;
    const del = document.createElement("button");
    del.className = "link"; del.textContent = "forget";
    del.onclick = async () => { await memory.forgetAccount(account.key); renderMemory(); };
    li.appendChild(del);
    accountList.appendChild(li);
  }

  const nameRows = await memory.listNames();
  const nameList = $("nameList");
  nameList.innerHTML = nameRows.length ? "" :
    '<li class="muted small">Nothing corrected yet — use “Fix name” on any row.</li>';
  for (const row of nameRows) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="grow"><code>${esc(row.key)}</code> → <strong>${esc(row.clean)}</strong></span>`;
    const del = document.createElement("button");
    del.className = "link"; del.textContent = "remove";
    del.onclick = async () => { await memory.forgetName(row.key); names = await memory.nameBook(); renderMemory(); };
    li.appendChild(del);
    nameList.appendChild(li);
  }

  const stats = await memory.learningStats();
  const chip = $("memoryChip");
  chip.hidden = !(stats.accounts + stats.names);
  chip.textContent = `${stats.accounts} account${stats.accounts === 1 ? "" : "s"} · ${stats.names} name${stats.names === 1 ? "" : "s"} remembered`
    + (stats.thisWeek ? ` · ${stats.thisWeek} learned this week` : "");
}

$("memExport").onclick = async () => {
  const data = await memory.exportAll();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = "receipt-renamer-memory.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("memImport").onclick = () => $("memFile").click();
$("memFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const count = await memory.importAll(JSON.parse(await file.text()));
    names = await memory.nameBook();
    renderMemory();
    toast(`Imported ${count} remembered item${count === 1 ? "" : "s"}.`);
  } catch { toast("That file is not a memory export.", "bad"); }
  e.target.value = "";
};

/* ── csv ───────────────────────────────────────────────────────── */

$("csvBtn").onclick = () => {
  const head = ["current_name", "new_name", "bank", "sender", "receiver", "receiver_account",
                "amount", "amount_net", "currency", "invoice", "reference", "date",
                "read_by", "confidence", "status", "duplicate_of", "notes"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(",")];
  for (const r of rows) {
    const f = r.fields || {};
    lines.push([r.relative, r.proposed, f.bank_name, f.sender_name_en || f.sender_name,
      f.receiver_name_en || f.receiver_name, f.receiver_account, f.amount, f.amount_net,
      f.currency, f.invoice_number, f.reference_number, f.transaction_date, r.engine,
      r.confidence, r.status, r.duplicateOf, r.notes].map(cell).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
  a.download = "receipt_report.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

/* ── keyboard ──────────────────────────────────────────────────── */

document.addEventListener("keydown", (e) => {
  if (e.target.matches("input, textarea, select")) return;
  if (e.key === "/") { e.preventDefault(); $("search").focus(); }
  if (e.key === "a" && rows.length) { $("selectAll").checked = !$("selectAll").checked;
                                      $("selectAll").onchange({ target: $("selectAll") }); }
  if (e.key === "Enter" && !$("actionBar").hidden) $("applyBtn").click();
});

window.addEventListener("beforeunload", () => shutdownReaders());

// Offline support: after the first visit the page (and the OCR engine) work
// without a connection, and Chrome/Edge offer to install it as an app.
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

/* ── boot ──────────────────────────────────────────────────────── */

(async function start() {
  await memory.migrateFromLocalStorage();
  settings = await memory.loadSettings(DEFAULTS);
  applyTheme(settings.theme);
  $("template").value = settings.template;
  for (const id of ["recursive", "stripLegal", "invFromName", "useOcr", "autoLearn"])
    $(id).checked = settings[id];
  $("shortBank").checked = settings.shortBankNames !== false;
  $("trimCents").checked = !!settings.trimCents;
  $("quality").value = settings.quality;
  $("ocrLangs").value = settings.ocrLangs;
  $("nameWords").value = String(settings.nameWords ?? 2);
  names = await memory.nameBook();
  updateExample();
  renderMemory();

  teamHandle = await memory.getSyncHandle();
  renderTeamState();
  if (teamHandle) {
    // Pull in whatever the rest of the office taught it since last time.
    const permission = await teamHandle.queryPermission({ mode: "readwrite" });
    if (permission === "granted") { await pushToTeamFile(); names = await memory.nameBook(); renderMemory(); }
  }

  const batches = await memory.listBatches();
  if (batches.length) $("undoBtn").hidden = true;      // undo only within a session

  animate(document.querySelectorAll(".reveal"), { opacity: [0, 1], y: [10, 0] },
          { delay: stagger(0.06), duration: 0.4, easing: [0.2, 0.8, 0.2, 1] });
})();
