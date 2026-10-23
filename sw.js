// Offline support: serve the app shell from cache when the network is unavailable.
// Bump VERSION whenever app files change so phones pick up the new cache.
const VERSION = "fishcast-v33";
const SHELL = ["./", "index.html", "styles.css", "engine.js", "map.js", "app.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];

// GitHub Pages lets browsers reuse files for 10 minutes, so always ask the server (cache: "reload" / "no-cache");
// otherwise an update can install yesterday's files.
self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Network first so updates show up right away; cache when offline. Weather APIs are not cached here
// (the app keeps the last forecast for each spot itself).
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  const shell = url.origin === location.origin || url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com" || url.hostname === "cdnjs.cloudflare.com";
  if (e.request.method !== "GET" || !shell) return;
  // A page navigation can't be copied with new options, so it's rebuilt from its URL.
  const req = url.origin !== location.origin ? e.request
    : e.request.mode === "navigate" ? new Request(e.request.url, { cache: "no-cache", credentials: "same-origin" })
    : new Request(e.request, { cache: "no-cache" });
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })
    .then(r => r || (e.request.mode === "navigate" ? caches.match("index.html") : Response.error()))));
});
