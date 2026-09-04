/* Makes the page work without a connection after the first visit, and lets
   Chrome/Edge install it as an app. Receipts are never cached - they are never
   sent here in the first place; only the page's own code and the CDN libraries. */

const CACHE = "receipt-renamer-v1";
const CORE = [
  "/", "/static/style.css", "/static/app.js", "/static/engine.js",
  "/static/reader.js", "/static/memory.js", "/static/pipeline.worker.js",
  "/static/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  const cacheable = url.origin === location.origin ||
    /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|fonts\.(googleapis|gstatic)\.com/.test(url.hostname);
  if (!cacheable) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    const network = fetch(request).then(async (response) => {
      if (response.ok || response.type === "opaque") {
        const cache = await caches.open(CACHE);
        cache.put(request, response.clone());
      }
      return response;
    }).catch(() => cached);
    return cached || network;      // cache first, refresh in the background
  })());
});
