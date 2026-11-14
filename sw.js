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
  e.respondWith((async () => {
    try {
      // 網頁本身一律跟伺服器確認是不是最新版，避免手機拿到舊的暫存
      const r = await fetch(req, req.mode === "navigate" || /\/(index\.html)?$/.test(url.pathname) ? { cache: "no-cache" } : {});
      if (r.ok && r.type === "basic") { const c = await caches.open(CACHE); c.put(key, r.clone()); }
      return r;
    } catch (err) {
      const c = await caches.open(CACHE);
      const hit = await c.match(key) || (req.mode === "navigate" ? await c.match(scope) : null);
      if (hit) return hit;
      throw err;
    }
  })());
});

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "曬衣服嗎", {
    body: d.body || "", tag: d.tag || "rain", icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow(e.notification.data && e.notification.data.url || "./");
  }));
});
