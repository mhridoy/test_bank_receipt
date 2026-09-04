const $ = (id) => document.getElementById(id);
const CLOUD = document.body.dataset.cloud === "1";
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const post = (url, body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
               body: JSON.stringify(body || {}) }).then((r) => r.json());

let jobId = null, rows = [], poller = null, renamedAny = false;

function toast(message, ms = 3200) {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), ms);
}

const options = () => ({
  folder: CLOUD ? "" : $("folder").value,
  template: $("template").value,
  recursive: !CLOUD && $("recursive").checked,
  strip_legal_suffix: $("stripLegal").checked,
  invoice_from_filename: $("invFromName").checked,
  ocr_dpi: +$("ocrDpi").value,
});

/* ── tabs ─────────────────────────────────────────────── */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".tabpane").forEach((p) =>
      p.classList.toggle("hidden", p.id !== `pane-${tab.dataset.tab}`));
  };
});

/* ── name pattern ─────────────────────────────────────── */
const SAMPLE = {
  bank: "RiyadBank", sender: "TabeebArabia", receiver: "PioneerMetalCorners",
  amount: "200640.50", amount_net: "200632.45", currency: "SAR",
  invoice: "7260019", ref: "946702450951BNBD", date: "2026-09-02",
  receiver_bank: "SaudiNationalBank", orig: "RV INV 7260019",
};
function updateExample() {
  const name = $("template").value.replace(/\{(\w+)\}/g, (_, k) => SAMPLE[k] ?? "");
  $("example").textContent = name.replace(/_{2,}/g, "_").replace(/^[_\-.]+|[_\-.]+$/g, "") + ".pdf";
  document.querySelectorAll(".preset").forEach((p) =>
    p.classList.toggle("active", p.dataset.tpl === $("template").value));
}
document.querySelectorAll(".preset").forEach((preset) => {
  preset.onclick = () => { $("template").value = preset.dataset.tpl; updateExample(); refreshNames(); };
});
$("template").oninput = updateExample;
$("template").onchange = refreshNames;
$("advBtn").onclick = () => $("advanced").classList.toggle("hidden");
document.querySelectorAll(".token").forEach((btn) => {
  btn.onclick = () => { $("template").value += btn.dataset.token; updateExample(); refreshNames(); };
});
$("stripLegal").onchange = $("invFromName").onchange = refreshNames;
$("ocrDpi").onchange = () => post("/api/settings", { ocr_dpi: +$("ocrDpi").value });

async function refreshNames() {
  if (!jobId) return;
  const data = await post(`/api/job/${jobId}/retemplate`, options());
  if (!data.error) render(data);
}

/* ── folder mode ──────────────────────────────────────── */
if (!CLOUD) {
  $("scanBtn").onclick = async () => {
    const data = await post("/api/scan", options());
    if (data.error) return toast(data.error);
    startJob(data.job_id);
  };
  $("browseBtn").onclick = () => openBrowser($("folder").value);
  $("browserClose").onclick = () => $("browserModal").classList.add("hidden");
  $("browserUp").onclick = () => openBrowser($("browserUp").dataset.parent);
  $("browserPick").onclick = () => {
    $("folder").value = $("browserPath").textContent;
    $("browserModal").classList.add("hidden");
  };
}

async function openBrowser(folder) {
  const data = await post("/api/browse", { folder });
  if (data.error) return toast(data.error);
  $("browserModal").classList.remove("hidden");
  $("browserPath").textContent = data.folder;
  $("browserUp").dataset.parent = data.parent || data.folder;
  $("browserUp").disabled = !data.parent;
  $("browserPick").textContent = `Use this folder · ${data.pdf_count} PDF`;
  const sep = data.folder.includes("\\") ? "\\" : "/";
  $("browserList").innerHTML = "";
  for (const name of data.subfolders) {
    const li = document.createElement("li");
    li.textContent = name;
    li.onclick = () => openBrowser(data.folder.replace(/[\\/]$/, "") + sep + name);
    $("browserList").appendChild(li);
  }
  if (!data.subfolders.length)
    $("browserList").innerHTML = '<li class="muted">No sub-folders here.</li>';
}

/* ── upload mode ──────────────────────────────────────── */
const drop = $("drop");
$("pickBtn").onclick = () => $("fileInput").click();
$("fileInput").onchange = (e) => upload([...e.target.files]);
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
  e.preventDefault(); drop.classList.remove("over");
  upload([...e.dataTransfer.files].filter((f) => f.name.toLowerCase().endsWith(".pdf")));
};

async function upload(files) {
  if (!files.length) return toast("No PDF files chosen.");
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  const o = options();
  form.append("template", o.template);
  form.append("strip_legal_suffix", o.strip_legal_suffix);
  form.append("invoice_from_filename", o.invoice_from_filename);
  form.append("ocr_dpi", o.ocr_dpi);
  toast(`Uploading ${files.length} file(s)…`);
  const data = await fetch("/api/upload", { method: "POST", body: form }).then((r) => r.json());
  if (data.error) return toast(data.error);
  if (data.rejected?.length) toast(data.rejected.join(" · "), 6000);
  startJob(data.job_id);
}

/* ── job polling ──────────────────────────────────────── */
function startJob(id) {
  jobId = id; renamedAny = false;
  $("results").hidden = false;
  $("progress").classList.remove("hidden");
  $("applyBtn").disabled = true;
  $("downloadBtn").hidden = true;
  $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  clearInterval(poller);
  poller = setInterval(poll, 800);
  poll();
}
$("cancelBtn").onclick = () => jobId && post(`/api/job/${jobId}/cancel`);

async function poll() {
  if (!jobId) return;
  const data = await fetch(`/api/job/${jobId}`).then((r) => r.json());
  if (data.error) return clearInterval(poller);
  render(data);
  if (data.finished) {
    clearInterval(poller);
    $("progress").classList.add("hidden");
    $("applyBtn").disabled = false;
  }
}

/* ── table ────────────────────────────────────────────── */
function render(job) {
  rows = job.rows;
  const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
  $("barFill").style.width = pct + "%";
  $("progressText").textContent = `Reading ${job.done} of ${job.total}…`;

  const n = (status) => rows.filter((r) => r.status === status).length;
  $("stats").innerHTML = `
    <span class="stat"><b>${rows.length}</b>files</span>
    <span class="stat ready"><b>${n("ready")}</b>ready</span>
    <span class="stat review"><b>${n("review")}</b>need a look</span>
    ${n("error") ? `<span class="stat error"><b>${n("error")}</b>failed</span>` : ""}`;

  const body = $("table").tBodies[0];
  body.innerHTML = "";
  for (const r of rows) {
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
      <td><input type="checkbox" class="pick" data-i="${r.index}"
           ${r.status === "ready" ? "checked" : ""}
           ${r.status === "ready" || r.status === "review" ? "" : "disabled"}></td>
      <td>
        <div class="old-name mono">${esc(r.relative)}</div>
        ${r.proposed
          ? `<input class="new-name mono" type="text" data-i="${r.index}" value="${esc(r.proposed)}">`
          : '<span class="muted small">— nothing readable —</span>'}
      </td>
      <td><div class="chips">${chips || '<span class="muted small">no details found</span>'}</div></td>
      <td><span class="pill ${r.status}">${r.status}</span>
          ${r.notes ? `<span class="note">${esc(r.notes)}</span>` : ""}</td>
      <td><div class="row-links">
        <a class="link" href="/api/preview?path=${encodeURIComponent(r.path)}" target="_blank">view PDF</a>
        ${rawName(r) ? `<button class="link teach" data-i="${r.index}">teach name</button>` : ""}
      </div></td>`;
    body.appendChild(tr);
  }
}

$("selectAll").onchange = (e) =>
  document.querySelectorAll(".pick:not(:disabled)").forEach((c) => (c.checked = e.target.checked));

/* ── apply ────────────────────────────────────────────── */
$("applyBtn").onclick = async () => {
  const picks = [...document.querySelectorAll(".pick:checked")].map((c) => +c.dataset.i);
  const edits = {};
  document.querySelectorAll(".new-name").forEach((i) => (edits[+i.dataset.i] = i.value));
  const items = picks.map((i) => ({ path: rows[i].path, proposed: edits[i] || rows[i].proposed }));
  if (!items.length) return toast("Nothing selected.");
  if (!confirm(`Rename ${items.length} file(s)?`)) return;

  const res = await post("/api/apply", { items, job_id: jobId });
  if (res.error) return toast(res.error);
  toast(`Renamed ${res.renamed.length} · skipped ${res.skipped.length} · failed ${res.failed.length}`, 5000);
  if (res.failed.length) console.warn("failed:", res.failed);
  renamedAny = renamedAny || res.renamed.length > 0;

  if (CLOUD) {
    $("downloadBtn").hidden = !renamedAny;
    poll();
  } else {
    loadHistory();
    $("scanBtn").click();
  }
};

$("downloadBtn").onclick = () => { window.location = `/api/download/${jobId}`; };

/* ── csv ──────────────────────────────────────────────── */
$("csvBtn").onclick = () => {
  const head = ["current_name", "new_name", "bank", "sender", "receiver", "amount",
                "currency", "invoice", "reference", "date", "read_by", "status", "notes"];
  const cell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [head.join(",")];
  for (const r of rows) {
    const f = r.fields || {};
    lines.push([r.relative, r.proposed, f.bank_name, f.sender_name_en || f.sender_name,
      f.receiver_name_en || f.receiver_name, f.amount, f.currency, f.invoice_number,
      f.reference_number, f.transaction_date, r.engine, r.status, r.notes].map(cell).join(","));
  }
  const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url; a.download = "receipt_report.csv"; a.click();
  URL.revokeObjectURL(url);
};

/* ── learned names ────────────────────────────────────── */
const rawName = (r) => (r.raw_fields || {}).receiver_name || "";

document.addEventListener("click", (e) => {
  if (!e.target.classList.contains("teach")) return;
  const r = rows[+e.target.dataset.i];
  $("teachRaw").value = rawName(r);
  $("teachClean").value = (r.fields || {}).receiver_name || rawName(r);
  $("teachDialog").showModal();
});
$("teachCancel").onclick = (e) => { e.preventDefault(); $("teachDialog").close(); };
$("teachSave").onclick = async (e) => {
  e.preventDefault();
  const raw = $("teachRaw").value, clean = $("teachClean").value.trim();
  if (!raw || !clean) return;
  $("teachDialog").close();
  const res = await post("/api/aliases", { kind: "receiver", raw, clean, job_id: jobId });
  if (res.job) render(res.job);
  loadAliases();
  toast(`Saved — “${clean}” will be used from now on.`);
};

async function loadAliases() {
  const data = await fetch("/api/aliases").then((r) => r.json());
  const list = $("aliasList");
  const entries = Object.entries(data.receiver || {});
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
    del.onclick = async () => {
      const res = await post("/api/aliases", { kind: "receiver", raw, clean: "", job_id: jobId });
      if (res.job) render(res.job);
      loadAliases();
    };
    li.appendChild(del);
    list.appendChild(li);
  }
}

/* ── history ──────────────────────────────────────────── */
async function loadHistory() {
  if (CLOUD || !$("history")) return;
  const data = await fetch("/api/history").then((r) => r.json());
  const list = $("history");
  list.innerHTML = "";
  if (!data.entries.length) {
    list.innerHTML = '<li class="muted small">No renames yet.</li>';
    return;
  }
  for (const e of data.entries) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="grow">${esc(e.timestamp.replace("T", " "))} · ${e.count} file(s)
                    <span class="muted small">${esc(e.folder)}</span></span>`;
    const btn = document.createElement("button");
    btn.className = "link"; btn.textContent = "undo";
    btn.onclick = async () => {
      if (!confirm("Restore the original file names from this batch?")) return;
      const res = await post("/api/undo", { file: e.file });
      toast(`Restored ${res.restored.length} · failed ${res.failed.length}`);
      loadHistory();
    };
    li.appendChild(btn);
    list.appendChild(li);
  }
}
if (!CLOUD && $("histBtn")) $("histBtn").onclick = loadHistory;

updateExample();
loadAliases();
loadHistory();
