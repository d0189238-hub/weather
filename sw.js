// 推播通知＋離線備份：有網路時一律抓最新的（並順手存一份），沒網路時才拿上次存的
const CACHE = "sai-offline-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (/\/data\/(radar\/|raw-|tmp-)/.test(url.pathname)) return;
  const scope = new URL("./", self.registration.scope).href;
  const key = req.mode === "navigate" ? scope : url.origin + url.pathname;
  // 訊號差時不要乾等：網路幾秒內沒回應，就先拿上次存的，網路回來後再默默存新的
  const wait = req.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname) ? 2500 : /\/data\//.test(url.pathname) ? 4000 : 0;
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const cached = () => c.match(key).then(h => h || (req.mode === "navigate" ? c.match(scope) : null));
    // 圖示、字型等不太會變的檔案：有存就直接用
    if (!wait) { const h = await cached(); if (h) { e.waitUntil(fetch(req).then(r => r.ok && r.type === "basic" && c.put(key, r)).catch(() => {})); return h; } }
    const net = fetch(req, req.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname) ? { cache: "no-cache" } : {})
      .then(r => { if (r.ok && r.type === "basic") e.waitUntil(c.put(key, r.clone())); return r; });
    if (!wait) return net;
    const slow = new Promise(res => setTimeout(() => cached().then(res), wait));
    try {
      const first = await Promise.race([net, slow.then(h => h || net)]);
      e.waitUntil(net.catch(() => {}));
      return first;
    } catch (err) {
      const h = await cached(); if (h) return h;
      throw err;
    }
  })());
});