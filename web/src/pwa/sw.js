// Pulse service worker: caches the app shell only (this page, its icons, fonts and manifest) so
// Pulse opens offline. It never caches or sees user data, which lives in IndexedDB, and it never
// touches requests to any other host.
const CACHE = "pulse-shell-v1";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
  "./fonts/bricolage-grotesque-latin-standard-normal.woff2", "./fonts/onest-latin-wght-normal.woff2",
  "./fonts/geist-mono-latin-400-normal.woff2", "./fonts/geist-mono-latin-500-normal.woff2"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  const path = "./" + url.pathname.split("/").pop();
  const isShell = SHELL.includes(path) || url.pathname.endsWith("/") || url.pathname.includes("/fonts/");
  if (!isShell) return;
  // network first for the page (so updates arrive), cache first for static assets
  // Only a good same-origin answer is cached, and always under the one page key, so query strings
  // cannot grow the cache and an error page never replaces the app. build_pages.py stamps CACHE.
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(CACHE).then((c) => c.put("./index.html", copy)); }
      return r;
    }).catch(() => caches.match("./index.html")));
  } else {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
  }
});
