/* Reading pipeline, main-thread side.

   Rendering and image clean-up happen in a small pool of `pipeline.worker.js`
   workers; the OCR runs through tesseract.js, which manages its own worker and
   WASM. Both stay off the UI thread, and neither is throttled when the tab is
   in the background. */

const POOL_SIZE = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));

export const OCR_PROFILES = {
  fast: "Fast — clean digital scans",
  balanced: "Balanced — recommended",
  sharp: "Sharp — slowest, best on poor scans",
};

let pool = [];
let queue = [];
let jobId = 0;

/* ── render workers ─────────────────────────────────────────────── */

function spawn() {
  const worker = new Worker(new URL("./pipeline.worker.js", import.meta.url), { type: "module" });
  const slot = { worker, busy: false, job: null };
  worker.onmessage = ({ data }) => {
    if (data.type === "status") { slot.job?.onStatus?.(data.text); return; }
    const job = slot.job;
    if (!job || data.id !== job.id) return;          // ignore anything stale
    slot.busy = false; slot.job = null;
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data);
    pump();
  };
  worker.onerror = (event) => {
    const job = slot.job;
    slot.busy = false; slot.job = null;
    job?.reject(new Error(event.message || "the reader worker stopped"));
    pump();
  };
  return slot;
}

function pump() {
  while (queue.length) {
    const slot = pool.find((s) => !s.busy);
    if (!slot) return;
    const job = queue.shift();
    slot.busy = true;
    slot.job = job;
    slot.worker.postMessage({ id: job.id, buffer: job.buffer, options: job.options }, [job.buffer]);
  }
}

function prepare(buffer, options, onStatus) {
  if (!pool.length) pool = Array.from({ length: POOL_SIZE }, spawn);
  return new Promise((resolve, reject) => {
    queue.push({ id: ++jobId, buffer, options, onStatus, resolve, reject });
    pump();
  });
}

/* ── OCR ────────────────────────────────────────────────────────── */

let ocrWorker = null;
let ocrLangs = "";
let ocrPsm = "";

async function getOcr(langs, psm, onStatus) {
  if (!ocrWorker || ocrLangs !== langs) {
    if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; }
    onStatus?.("Loading the OCR engine (once, then cached offline)…");
    ocrWorker = await Tesseract.createWorker(langs, 1, { logger: () => {} });
    ocrLangs = langs;
    ocrPsm = "";
  }
  if (ocrPsm !== psm) {
    await ocrWorker.setParameters({
      tessedit_pageseg_mode: psm,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    ocrPsm = psm;
  }
  return ocrWorker;
}

/** Rebuild lines from word boxes: a gap wider than about a third of a character
    is a space. Tesseract's plain `text` output drops those on tight layouts -
    that is what glued "CORNERSCOMPANYBeneficiaryAccount" into one word. */
function wordsToText(data) {
  const lines = [];
  const collect = (node) => {
    if (!node) return;
    if (node.words?.length) { lines.push(node.words); return; }
    for (const child of node.paragraphs || node.lines || node.blocks || []) collect(child);
  };
  for (const block of data.blocks || []) collect(block);
  if (!lines.length) return { text: data.text || "", confidence: data.confidence ?? null };

  let sum = 0, count = 0;
  const rendered = lines.map((words) => {
    let out = "";
    words.forEach((word, i) => {
      const text = word.text ?? "";
      if (!text.trim()) return;
      sum += word.confidence ?? 0;
      count++;
      if (out) {
        const previous = words[i - 1];
        const gap = (word.bbox?.x0 ?? 0) - (previous?.bbox?.x1 ?? 0);
        const charWidth = Math.max(1, ((previous?.bbox?.x1 ?? 0) - (previous?.bbox?.x0 ?? 0)) /
                                       Math.max(1, (previous?.text || "").length));
        if (gap > charWidth * 0.35) out += " ";
      }
      out += text;
    });
    return out.trim();
  }).filter(Boolean);

  return { text: rendered.join("\n"), confidence: count ? Math.round(sum / count) : null };
}

/* ── public API ─────────────────────────────────────────────────── */

/** Read one PDF. `buffer` is transferred to a worker - do not reuse it. */
export async function readPdf(buffer, { allowOcr = true, langs = "eng",
                                        profile = "balanced", onStatus } = {}) {
  const prepared = await prepare(buffer, { allowOcr, profileName: profile }, onStatus);
  if (prepared.engine !== "ocr") {
    return { text: prepared.text, engine: prepared.engine, confidence: 100, note: prepared.note };
  }

  const worker = await getOcr(langs, prepared.psm || "6", onStatus);
  let text = "", confidence = 0, pages = 0;
  for (const [index, png] of (prepared.pages || []).entries()) {
    onStatus?.(`Reading page ${index + 1} of ${prepared.pages.length}…`);
    const image = new Blob([png], { type: "image/png" });
    const { data } = await worker.recognize(image, {}, { text: true, blocks: true });
    const assembled = wordsToText(data);
    text += assembled.text + "\n";
    confidence += assembled.confidence ?? 0;
    pages++;
  }
  return { text, engine: "ocr", confidence: pages ? Math.round(confidence / pages) : null };
}

export async function shutdownReaders() {
  pool.forEach((slot) => slot.worker.terminate());
  pool = [];
  queue = [];
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; ocrLangs = ""; }
}
