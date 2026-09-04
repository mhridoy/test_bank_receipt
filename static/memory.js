/* What the app remembers between sessions, in this browser's IndexedDB.

   The important one is `accounts`: an account number or IBAN is the one thing on
   a receipt that never changes spelling, so once a company has been seen with a
   clean name, every later receipt to that account gets the same name - even when
   the OCR mangles it. Everything else (name corrections, rename history,
   settings) rides along in the same database. */

const DB_NAME = "receipt-renamer";
const DB_VERSION = 1;
const STORES = ["accounts", "names", "history", "settings"];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: store === "history" ? "id" : "key" });
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function tx(store, mode, run) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

const get = (store, key) => tx(store, "readonly", (s) => s.get(key));
const put = (store, value) => tx(store, "readwrite", (s) => s.put(value));
const del = (store, key) => tx(store, "readwrite", (s) => s.delete(key));
const all = (store) => tx(store, "readonly", (s) => s.getAll());

/* ── accounts: account number → company ──────────────────────────── */

export async function rememberAccount(account, name, extra = {}) {
  if (!account || !name || name.length < 3) return;
  const existing = (await get("accounts", account)) || { key: account, seen: 0 };
  // Don't let one bad read overwrite a name that has proved itself, unless a
  // person confirmed the new one.
  if (existing.name && existing.name !== name && !extra.confirmed
      && existing.confirmed) return;
  if (existing.name && existing.name !== name && !extra.confirmed && existing.seen >= 3) return;
  await put("accounts", {
    ...existing, ...extra,
    key: account,
    name,
    seen: existing.seen + 1,
    updatedAt: Date.now(),
    confirmed: extra.confirmed ?? existing.confirmed ?? false,
  });
}

export const lookupAccount = (account) => (account ? get("accounts", account) : null);
export const listAccounts = () => all("accounts");
export const forgetAccount = (account) => del("accounts", account);

/* ── names: what a receipt says → what we call it ────────────────── */

export async function rememberName(raw, clean, source = "manual") {
  if (!raw || !clean || raw.length < 3) return;
  const existing = await get("names", raw);
  // a person's correction always outranks something the app worked out itself
  if (existing?.source === "manual" && source !== "manual") return;
  await put("names", { key: raw, clean, source, updatedAt: Date.now() });
}
export const listNames = () => all("names");
export const forgetName = (raw) => del("names", raw);

export async function nameBook() {
  const rows = await listNames();
  const receiver = {};
  for (const row of rows) receiver[row.key] = row.clean;
  return { receiver, sender: {}, bank: {} };
}

/* ── rename history (undo across sessions) ───────────────────────── */

export async function saveBatch(entries, folderName) {
  if (!entries.length) return null;
  const batch = { id: Date.now(), folder: folderName, at: Date.now(), entries };
  await put("history", batch);
  const rows = await all("history");
  for (const old of rows.sort((a, b) => b.id - a.id).slice(20)) await del("history", old.id);
  return batch;
}
export const listBatches = async () => (await all("history")).sort((a, b) => b.id - a.id);
export const forgetBatch = (id) => del("history", id);

/* ── the shared team file ────────────────────────────────────────── */
/* One JSON file on a network drive that every PC merges from and writes back to,
   so what one person teaches on Sunday is known by everyone on Monday. Chrome
   can store the file handle itself, so the file is only picked once per PC. */

export async function setSyncHandle(handle) { await put("settings", { key: "sync", value: handle }); }
export async function getSyncHandle() { return (await get("settings", "sync"))?.value || null; }
export async function clearSyncHandle() { await del("settings", "sync"); }

async function readSyncFile(handle) {
  const file = await handle.getFile();
  const text = await file.text();
  return text.trim() ? JSON.parse(text) : { accounts: [], names: [] };
}

/** Merge both ways: newest wins per key, and sighting counts add up. */
export async function syncWithFile(handle) {
  if (await handle.queryPermission({ mode: "readwrite" }) !== "granted"
      && await handle.requestPermission({ mode: "readwrite" }) !== "granted") {
    return { error: "permission" };
  }

  let remote = { accounts: [], names: [] };
  try { remote = await readSyncFile(handle); } catch { /* new or empty file */ }

  let pulled = 0;
  for (const row of remote.accounts || []) {
    const mine = await get("accounts", row.key);
    if (!mine || (row.updatedAt || 0) > (mine.updatedAt || 0)) {
      await put("accounts", { ...row, seen: Math.max(row.seen || 1, mine?.seen || 0) });
      pulled++;
    }
  }
  for (const row of remote.names || []) {
    const mine = await get("names", row.key);
    if (!mine || (row.updatedAt || 0) > (mine.updatedAt || 0)) { await put("names", row); pulled++; }
  }

  const merged = { version: 1, updatedAt: new Date().toISOString(),
                   accounts: await listAccounts(), names: await listNames() };
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(merged, null, 2));
  await writable.close();

  return { pulled, pushed: merged.accounts.length + merged.names.length };
}

/* ── settings ────────────────────────────────────────────────────── */

export async function loadSettings(defaults) {
  const row = await get("settings", "app");
  return { ...defaults, ...(row?.value || {}) };
}
export const saveSettings = (value) => put("settings", { key: "app", value });

/* ── backup ──────────────────────────────────────────────────────── */

export async function exportAll() {
  return {
    version: 1, exportedAt: new Date().toISOString(),
    accounts: await listAccounts(), names: await listNames(),
  };
}

/** What the app picked up recently - shown so people can see it improving. */
export async function learningStats() {
  const week = Date.now() - 7 * 24 * 3600 * 1000;
  const accounts = await listAccounts();
  const names = await listNames();
  return {
    accounts: accounts.length,
    names: names.length,
    thisWeek: [...accounts, ...names].filter((r) => (r.updatedAt || 0) > week).length,
  };
}

export async function importAll(data) {
  let count = 0;
  for (const row of data.accounts || []) {
    if (!row.key || !row.name) continue;
    await put("accounts", { ...row, updatedAt: Date.now() });
    count++;
  }
  for (const row of data.names || []) {
    if (!row.key || !row.clean) continue;
    await put("names", { ...row, updatedAt: Date.now() });
    count++;
  }
  return count;
}

/** One-time move of anything the earlier localStorage version stored. */
export async function migrateFromLocalStorage() {
  try {
    const raw = localStorage.getItem("receipt-renamer-aliases");
    if (!raw) return;
    const parsed = JSON.parse(raw);
    for (const [key, clean] of Object.entries(parsed.receiver || {})) await rememberName(key, clean);
    localStorage.removeItem("receipt-renamer-aliases");
  } catch { /* nothing to migrate */ }
}
