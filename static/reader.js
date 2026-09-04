/* Reads a PDF in the browser: embedded text layer first, OCR only if needed.
   Nothing is uploaded - pdf.js and tesseract.js both run inside the tab. */

import * as pdfjs from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";

const MIN_TEXT_CHARS = 60;    // less than this and the "text layer" is page furniture
const MAX_PAGES = 3;
const OCR_MAX_PX = 2600;      // long edge sent to OCR

let ocrWorker = null;
let ocrLangs = "";

async function getWorker(langs, onStatus) {
  if (ocrWorker && ocrLangs === langs) return ocrWorker;
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; }
  onStatus?.("Loading the OCR engine (one time, ~15 MB)…");
  ocrWorker = await Tesseract.createWorker(langs, 1, { logger: () => {} });
  ocrLangs = langs;
  return ocrWorker;
}

export async function terminateOcr() {
  if (ocrWorker) { await ocrWorker.terminate(); ocrWorker = null; ocrLangs = ""; }
}

/* pdf.js hands back positioned fragments; rebuild lines from their y position. */
function itemsToText(items) {
  const lines = new Map();
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ x: item.transform[4], s: item.str });
  }
  return [...lines.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").trim())
    .join("\n");
}

async function pageToCanvas(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_MAX_PX / Math.max(base.width, base.height), 4);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d", { willReadFrequently: true }),
                      viewport }).promise;
  return canvas;
}

export async function readPdf(buffer, { allowOcr = true, langs = "eng", onStatus } = {}) {
  const doc = await pdfjs.getDocument({ data: buffer, isEvalSupported: false }).promise;
  const pageCount = Math.min(MAX_PAGES, doc.numPages);

  let text = "";
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    text += itemsToText((await page.getTextContent()).items) + "\n";
  }
  if (text.trim().length >= MIN_TEXT_CHARS) {
    await doc.destroy();
    return { text, engine: "text-layer" };
  }

  if (!allowOcr) {
    await doc.destroy();
    return { text: "", engine: "none", note: "Scanned PDF - switch OCR on to read it." };
  }

  const worker = await getWorker(langs, onStatus);
  let ocrText = "";
  for (let i = 1; i <= pageCount; i++) {
    onStatus?.(`Reading page ${i} of ${pageCount} with OCR…`);
    const canvas = await pageToCanvas(await doc.getPage(i));
    const { data } = await worker.recognize(canvas);
    ocrText += (data.text || "") + "\n";
    canvas.width = canvas.height = 0;      // let the bitmap go
  }
  await doc.destroy();
  return { text: ocrText, engine: "ocr" };
}
