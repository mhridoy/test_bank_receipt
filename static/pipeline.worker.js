/* Opens one PDF, pulls out its text layer and - when there is none - renders and
   cleans up the pages for OCR.

   This runs in a Web Worker for two reasons: canvas rendering on the main thread
   is throttled to a standstill when the tab is in the background, and rendering a
   3600 px page would otherwise stutter the interface. The OCR itself happens back
   on the main thread (tesseract.js keeps its own worker) because its ESM build
   cannot be imported inside a worker. */

import * as pdfjs from "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.6.82/pdf.worker.min.mjs";

const MIN_TEXT_CHARS = 60;
const MAX_PAGES = 3;

export const PROFILES = {
  fast:     { px: 2200, preprocess: "contrast", psm: "6", sharpen: false },
  balanced: { px: 3000, preprocess: "auto",     psm: "6", sharpen: false },
  sharp:    { px: 3800, preprocess: "auto",     psm: "6", sharpen: true },
};

function post(message) { self.postMessage(message); }

/* ── image preparation ─────────────────────────────────────────── */

function toGrayscale(data) {
  for (let i = 0; i < data.length; i += 4) {
    const v = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

/** Stretch the 2nd..98th percentile to full range - fixes grey, washed-out scans. */
function stretchContrast(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  const total = data.length / 4;
  let lo = 0, hi = 255, seen = 0;
  for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen > total * 0.02) { lo = v; break; } }
  seen = 0;
  for (let v = 255; v >= 0; v--) { seen += hist[v]; if (seen > total * 0.02) { hi = v; break; } }
  if (hi - lo < 24) return;
  const scale = 255 / (hi - lo);
  for (let i = 0; i < data.length; i += 4) {
    const v = Math.max(0, Math.min(255, (data[i] - lo) * scale)) | 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

/** How bimodal the page is: a screen capture is mostly paper-white and ink-black,
    a phone photo is a broad smear. Decides whether local thresholding is worth it. */
function isPhotoLike(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  const total = data.length / 4;
  let extremes = 0;
  for (let v = 0; v < 40; v++) extremes += hist[v];
  for (let v = 216; v < 256; v++) extremes += hist[v];
  return extremes / total < 0.72;
}

/** Sauvola local thresholding over integral images - handles uneven lighting and
    shadows in photographed receipts, where a single global cut-off fails. */
function sauvola(data, width, height, window = 25, k = 0.28) {
  const size = width * height;
  const gray = new Float64Array(size);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = data[i];

  const sum = new Float64Array((width + 1) * (height + 1));
  const sqsum = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0, rowSq = 0;
    for (let x = 0; x < width; x++) {
      const v = gray[y * width + x];
      rowSum += v; rowSq += v * v;
      sum[(y + 1) * (width + 1) + x + 1] = sum[y * (width + 1) + x + 1] + rowSum;
      sqsum[(y + 1) * (width + 1) + x + 1] = sqsum[y * (width + 1) + x + 1] + rowSq;
    }
  }

  const half = window >> 1;
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(height - 1, y + half);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(width - 1, x + half);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const a = (y1 + 1) * (width + 1) + x1 + 1, b = y0 * (width + 1) + x1 + 1;
      const c = (y1 + 1) * (width + 1) + x0, d = y0 * (width + 1) + x0;
      const mean = (sum[a] - sum[b] - sum[c] + sum[d]) / area;
      const variance = Math.max(0, (sqsum[a] - sqsum[b] - sqsum[c] + sqsum[d]) / area - mean * mean);
      const threshold = mean * (1 + k * (Math.sqrt(variance) / 128 - 1));
      const p = y * width + x;
      const v = gray[p] > threshold ? 255 : 0;
      data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v;
    }
  }
}

/** Light unsharp mask: puts the edge back on thin, anti-aliased glyphs. */
function sharpen(data, width, height) {
  const original = new Uint8ClampedArray(data);
  const at = (x, y) => original[(y * width + x) * 4];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const centre = at(x, y);
      const blur = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) + centre * 4) / 8;
      const v = Math.max(0, Math.min(255, centre + (centre - blur) * 0.9));
      const p = (y * width + x) * 4;
      data[p] = data[p + 1] = data[p + 2] = v;
    }
  }
}

/** Otsu's threshold, then a hard black/white image - best for clean scans. */
function binarize(data) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) hist[data[i]]++;
  const total = data.length / 4;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0, wB = 0, best = 0, threshold = 128;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const between = wB * wF * ((sumB / wB) - ((sum - sumB) / wF)) ** 2;
    if (between > best) { best = between; threshold = v; }
  }
  for (let i = 0; i < data.length; i += 4) {
    const v = data[i] > threshold ? 255 : 0;
    data[i] = data[i + 1] = data[i + 2] = v;
  }
}

async function renderPage(page, profile) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(profile.px / Math.max(base.width, base.height), 5);
  const viewport = page.getViewport({ scale });
  const canvas = new OffscreenCanvas(Math.floor(viewport.width), Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  if (profile.preprocess !== "none") {
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    toGrayscale(image.data);
    stretchContrast(image.data);
    if (profile.sharpen) sharpen(image.data, canvas.width, canvas.height);
    if (profile.preprocess === "binarize"
        || (profile.preprocess === "auto" && isPhotoLike(image.data))) {
      // A photographed receipt: light varies across the page, so threshold locally.
      sauvola(image.data, canvas.width, canvas.height);
    }
    ctx.putImageData(image, 0, 0);
  }
  return canvas;
}

/* ── text assembly ─────────────────────────────────────────────── */

/** pdf.js text fragments -> lines, using their y position. */
function itemsToText(items) {
  const lines = new Map();
  for (const item of items) {
    if (!item.str || !item.str.trim()) continue;
    const y = Math.round(item.transform[5]);
    const key = [...lines.keys()].find((k) => Math.abs(k - y) <= 2) ?? y;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ x: item.transform[4], s: item.str });
  }
  return [...lines.entries()].sort((a, b) => b[0] - a[0])
    .map(([, parts]) => parts.sort((a, b) => a.x - b.x).map((p) => p.s).join(" ").trim())
    .join("\n");
}

/* ── main entry ────────────────────────────────────────────────── */

async function read(buffer, { allowOcr = true, profileName = "balanced" }) {
  const profile = PROFILES[profileName] || PROFILES.balanced;
  const doc = await pdfjs.getDocument({ data: buffer, isEvalSupported: false }).promise;
  const pageCount = Math.min(MAX_PAGES, doc.numPages);

  let text = "";
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    text += itemsToText((await page.getTextContent()).items) + "\n";
  }
  if (text.trim().length >= MIN_TEXT_CHARS) {
    await doc.destroy();
    return { text, engine: "text-layer", pages: [] };
  }
  if (!allowOcr) {
    await doc.destroy();
    return { text: "", engine: "none", pages: [],
             note: "Scanned PDF - switch OCR on to read it." };
  }

  // PNG bytes rather than an ImageBitmap: tesseract.js cannot read a bitmap,
  // and an ArrayBuffer transfers to the main thread just as cheaply.
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    post({ type: "status", text: `Preparing page ${i} of ${pageCount}…` });
    const canvas = await renderPage(await doc.getPage(i), profile);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    pages.push(await blob.arrayBuffer());
  }
  await doc.destroy();
  return { text: "", engine: "ocr", pages, psm: profile.psm };
}

self.onmessage = async (event) => {
  const { id, buffer, options } = event.data;
  try {
    const result = await read(buffer, options || {});
    self.postMessage({ type: "done", id, ...result }, result.pages || []);
  } catch (error) {
    self.postMessage({ type: "done", id, error: String(error?.message || error) });
  }
};
