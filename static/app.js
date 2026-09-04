/* Drives the page: pick a local folder, read every receipt in the browser,
   rename the files in place. No server, no upload - the File System Access
   API hands the page a real handle to the folder the user picked. */

import { parseText, buildName, aliasKey } from "./engine.js";
import { readPdf, terminateOcr } from "./reader.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const HAS_FS = "showDirectoryPicker" in window;

let dirHandle = null;
let rows = [];            // {name, handle, parent, relative, fields, proposed, status, notes, engine}
let undoStack = [];       // [{handle, from, to}]
let cancelled = false;
let aliases = loadAliases();

/* ── settings ─────────────────────────────────────────── */
const SETTINGS_KEY = "receipt-renamer-settings";
const ALIAS_KEY = "receipt-renamer-aliases";

function loadSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(options())); } catch { /* private mode */ }
}
function loadAliases() {
  try { return JSON.parse(localStorage.getItem(ALIAS_KEY)) || { receiver: {}, sender: {}, bank: {} }; }
  catch { return { receiver: {}, sender: {}, bank: {} }; }
}
function saveAliases() {
  try { localStorage.setItem(ALIAS_KEY, JSON.stringify(aliases)); } catch { /* private mode */ }
}

const options = () => ({
  template: $("template").value,
  recursive: $("recursive").checked,
  strip_legal_suffix: $("stripLegal").checked,
  invoice_from_filename: $("invFromName").checked,
  ocr: $("useOcr").checked,
  langs: $("ocrLangs").value,
});

function restoreSettings() {
  const s = loadSettings();
  if (s.template) $("template").value = s.template;
  if (typeof s.recursive === "boolean") $("recursive").checked = s.recursive;
  if (typeof s.strip_legal_suffix === "boolean") $("stripLegal").checked = s.strip_legal_suffix;
  if (typeof s.invoice_from_filename === "boolean") $("invFromName").checked = s.invoice_from_filename;
  if (typeof s.ocr === "boolean") $("useOcr").checked = s.ocr;
  if (s.langs) $("ocrLangs").value = s.langs;
}

function toast(message, ms = 3500) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), ms);
}

/* ── name pattern ─────────────────────────────────────── */
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
  saveSettings();
}
document.querySelectorAll(".preset").forEach((preset) => {
  preset.onclick = () => { $("template").value = preset.dataset.tpl; updateExample(); rebuildNames(); };
});
document.querySelectorAll(".token").forEach((btn) => {
  btn.onclick = () => { $("template").value += btn.dataset.token; updateExample(); rebuildNames(); };
});
$("template").oninput = updateExample;
$("template").onchange = rebuildNames;
$("advBtn").onclick = () => $("advanced").classList.toggle("hidden");
$("stripLegal").onchange = $("invFromName").onchange = () => { saveSettings(); rebuildNames(); };
$("useOcr").onchange = $("ocrLangs").onchange = $("recursive").onchange = saveSettings;

function rebuildNames() {
  const o = options();
  for (const row of rows) {
    if (!row.rawFields) continue;
    row.fields = { ...row.rawFields };
    applyAliasesTo(row.fields);
    row.proposed = buildName(row.fields, o.template, row.name,
                             o.strip_legal_suffix, o.invoice_from_filename);
  }
  render();
}

function applyAliasesTo(fields) {
  const lookup = {};
  for (const [k, v] of Object.entries(aliases.receiver || {})) lookup[aliasKey(k)] = v;
  const clean = lookup[aliasKey(fields.receiver_name)];
  if (clean) { fields.receiver_name = clean; fields.receiver_name_en = clean; }
}

/* ── folder access ────────────────────────────────────── */
if (!HAS_FS) {
  $("noFs").hidden = false;
  $("pickBtn").disabled = true;
}

$("pickBtn").onclick = async () => {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: "readwrite", id: "receipts" });
  } catch { return; }                                    // user cancelled
  const permission = await dirHandle.requestPermission({ mode: "readwrite" });
  if (permission !== "granted") return toast("Permission to change files was not granted.");
  $("folderName").textContent = dirHandle.name;
  $("folderRow").hidden = false;
  scan();
};
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

/* ── scan ─────────────────────────────────────────────── */
async function scan() {
  const o = options();
  cancelled = false;
  rows = [];
  for await (const file of walk(dirHandle, "", o.recursive)) {
    rows.push({ ...file, status: "pending", proposed: "", fields: {}, rawFields: null,
                engine: "", notes: "" });
    if (rows.length >= 500) break;
  }
  if (!rows.length) return toast("No PDF files in that folder.");

  rows.sort((a, b) => a.relative.localeCompare(b.relative));
  $("results").hidden = false;
  $("progress").classList.remove("hidden");
  $("applyBtn").disabled = true;
  render();

  let done = 0;
  for (const row of rows) {
    if (cancelled) { row.status = "cancelled"; continue; }
    setProgress(done, rows.length, row.name);
    try {
      const file = await row.handle.getFile();
      const buffer = await file.arrayBuffer();
      const { text, engine, note } = await readPdf(buffer, {
        allowOcr: o.ocr, langs: o.langs,
        onStatus: (msg) => setProgress(done, rows.length, `${row.name} — ${msg}`),
      });
      const fields = parseText(text, aliases);
      row.rawFields = { ...fields };
      row.fields = fields;
      row.engine = engine;
      row.notes = note || "";
      row.proposed = buildName(fields, o.template, row.name,
                               o.strip_legal_suffix, o.invoice_from_filename);
      row.status = fields.missing.length ? "review" : "ready";
      if (fields.missing.length)
        row.notes = `${row.notes} Missing: ${fields.missing.join(", ")}.`.trim();
    } catch (err) {
      row.status = "error";
      row.notes = String(err.message || err);
    }
    done++;
    setProgress(done, rows.length, "");
    render();
  }
  $("progress").classList.add("hidden");
  $("applyBtn").disabled = false;
  render();
}

function setProgress(done, total, label) {
  $("barFill").style.width = total ? `${Math.round((done / total) * 100)}%` : "0";
  $("progressText").textContent = label
    ? `Reading ${done + 1} of ${total} · ${label}`
    : `Read ${done} of ${total}`;
}
$("cancelBtn").onclick = () => { cancelled = true; toast("Stopping after the current file…"); };

/* ── table ────────────────────────────────────────────── */
function render() {
  const count = (status) => rows.filter((r) => r.status === status).length;
  $("stats").innerHTML = `
    <span class="stat"><b>${rows.length}</b>files</span>
    <span class="stat ready"><b>${count("ready")}</b>ready</span>
    <span class="stat review"><b>${count("review")}</b>need a look</span>
    ${count("error") ? `<span class="stat error"><b>${count("error")}</b>failed</span>` : ""}`;

  const body = $("table").tBodies[0];
  body.innerHTML = "";
  rows.forEach((r, i) => {
    const f = r.fields || {};
    const chips = [
      f.bank_name && `<span class="chip"><b>${esc(f.bank_name)}</b></span>`,
      (f.receiver_name_en || f.receiver_name) &&
        `<span class="chip">to <b>${esc(f.receiver_name_en || f.receiver_name)}</b></span>`,
      f.amount && `<span class="chip"><b>${esc(f.amount)}</b> ${esc(f.currency || "")}</span>`,
      f.invoice_number && `<span class="chip">inv <b>${esc(f.invoice_number)}</b></span>`,
      f.transaction_date && `<span class="chip">${esc(f.transaction_date)}</span>`,
      r.engine && `<span class="chip">${esc(r.engine)}</span>`,
    ].filter(Boolean).join("");

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" class="pick" data-i="${i}"
           ${r.status === "ready" ? "checked" : ""}
           ${r.status === "ready" || r.status === "review" ? "" : "disabled"}></td>
      <td>
        ${r.status === "renamed"
          ? `<div class="done-name mono">${esc(r.relative)}</div>
             <div class="old-name mono">${esc(r.previous || "")}</div>`
          : `<div class="old-name mono">${esc(r.relative)}</div>
             ${r.proposed
               ? `<input class="new-name mono" type="text" data-i="${i}" value="${esc(r.proposed)}">`
               : '<span class="muted small">— nothing readable —</span>'}`}
      </td>
      <td><div class="chips">${chips || '<span class="muted small">no details found</span>'}</div></td>
      <td><span class="pill ${r.status}">${r.status}</span>
          ${r.notes ? `<span class="note">${esc(r.notes)}</span>` : ""}</td>
      <td><div class="row-links">
        <button class="link view" data-i="${i}">view PDF</button>
        ${(r.rawFields?.receiver_name) ? `<button class="link teach" data-i="${i}">teach name</button>` : ""}
      </div></td>`;
    body.appendChild(tr);
  });
}

$("selectAll").onchange = (e) =>
  document.querySelectorAll(".pick:not(:disabled)").forEach((c) => (c.checked = e.target.checked));

document.addEventListener("click", async (e) => {
  const i = +e.target.dataset?.i;
  if (e.target.classList.contains("view")) {
    const file = await rows[i].handle.getFile();
    const url = URL.createObjectURL(file);
    window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  if (e.target.classList.contains("teach")) {
    const raw = rows[i].rawFields.receiver_name;
    $("teachRaw").value = raw;
    $("teachClean").value = rows[i].fields.receiver_name || raw;
    $("teachDialog").showModal();
  }
});

/* ── rename ───────────────────────────────────────────── */
$("applyBtn").onclick = async () => {
  const edits = {};
  document.querySelectorAll(".new-name").forEach((input) => (edits[+input.dataset.i] = input.value));
  const picks = [...document.querySelectorAll(".pick:checked")].map((c) => +c.dataset.i);
  if (!picks.length) return toast("Nothing selected.");
  if (!confirm(`Rename ${picks.length} file(s) in “${dirHandle.name}”?`)) return;

  const existing = new Set(rows.map((r) => r.name.toLowerCase()));
  let renamed = 0, skipped = 0, failed = 0;
  undoStack = [];

  for (const i of picks) {
    const row = rows[i];
    let target = (edits[i] || row.proposed || "").trim();
    if (!target) { skipped++; continue; }
    if (!target.toLowerCase().endsWith(".pdf")) target += ".pdf";
    if (target === row.name) { skipped++; continue; }

    let unique = target, n = 2;
    while (existing.has(unique.toLowerCase())) {
      unique = target.replace(/\.pdf$/i, "") + `_${n++}.pdf`;
    }
    try {
      await renameFile(row, unique);
      existing.delete(row.name.toLowerCase());
      existing.add(unique.toLowerCase());
      undoStack.push({ row, from: unique, to: row.name });
      row.previous = row.name;
      row.relative = row.relative.replace(/[^/]+$/, unique);
      row.name = unique;
      row.proposed = unique;
      row.status = "renamed";
      renamed++;
    } catch (err) {
      failed++;
      row.status = "error";
      row.notes = String(err.message || err);
    }
  }
  render();
  $("undoBtn").hidden = !undoStack.length;
  toast(`Renamed ${renamed} · skipped ${skipped} · failed ${failed}`, 5000);
};

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
  if (!undoStack.length) return;
  let restored = 0;
  for (const entry of [...undoStack].reverse()) {
    try {
      await renameFile(entry.row, entry.to);
      entry.row.relative = entry.row.relative.replace(/[^/]+$/, entry.to);
      entry.row.name = entry.to;
      entry.row.previous = "";
      entry.row.status = entry.row.rawFields?.missing?.length ? "review" : "ready";
      restored++;
    } catch { /* keep going */ }
  }
  undoStack = [];
  $("undoBtn").hidden = true;
  rebuildNames();
  toast(`Restored ${restored} original name(s).`);
};

/* ── learned names ────────────────────────────────────── */
$("teachCancel").onclick = (e) => { e.preventDefault(); $("teachDialog").close(); };
$("teachSave").onclick = (e) => {
  e.preventDefault();
  const raw = $("teachRaw").value, clean = $("teachClean").value.trim();
  if (!raw || !clean) return;
  aliases.receiver[raw] = clean;
  saveAliases();
  $("teachDialog").close();
  rebuildNames();
  renderAliases();
  toast(`Saved — “${clean}” will be used from now on.`);
};

function renderAliases() {
  const list = $("aliasList");
  const entries = Object.entries(aliases.receiver || {});
  list.innerHTML = "";
  if (!entries.length) {
    list.innerHTML = '<li class="muted small">Nothing taught yet — use “teach name” on any row.</li>';
    return;
  }
  for (const [raw, clean] of entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="grow"><code>${esc(raw)}</code> → <strong>${esc(clean)}</strong></span>`;
    const del = document.createElement("button");
    del.className = "link"; del.textContent = "remove";
    del.onclick = () => { delete aliases.receiver[raw]; saveAliases(); rebuildNames(); renderAliases(); };
    li.appendChild(del);
    list.appendChild(li);
  }
}

$("aliasExport").onclick = () => {
  const blob = new Blob([JSON.stringify(aliases, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "receipt-renamer-names.json";
  a.click();
  URL.revokeObjectURL(a.href);
};
$("aliasImport").onclick = () => $("aliasFile").click();
$("aliasFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    for (const kind of ["receiver", "sender", "bank"])
      Object.assign(aliases[kind], incoming[kind] || {});
    saveAliases(); rebuildNames(); renderAliases();
    toast("Names imported.");
  } catch { toast("That file is not a saved name list."); }
  e.target.value = "";
};

/* ── csv ──────────────────────────────────────────────── */
$("csvBtn").onclick = () => {
  const head = ["current_name", "new_name", "bank", "sender", "receiver", "amount", "currency",
                "invoice", "reference", "date", "read_by", "status", "notes"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(",")];
  for (const r of rows) {
    const f = r.fields || {};
    lines.push([r.relative, r.proposed, f.bank_name, f.sender_name_en || f.sender_name,
      f.receiver_name_en || f.receiver_name, f.amount, f.currency, f.invoice_number,
      f.reference_number, f.transaction_date, r.engine, r.status, r.notes].map(cell).join(","));
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
  a.download = "receipt_report.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

window.addEventListener("beforeunload", () => terminateOcr());

restoreSettings();
updateExample();
renderAliases();
