// Lưu sẵn giao diện để web app mở được cả khi không có mạng.
// Đổi VERSION mỗi khi cập nhật index.html để máy người dùng nhận bản mới.
const VERSION = "astra-v64";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./sw.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;
  // API và worker không cache.
  if (u.pathname.includes("/api") || u.pathname.includes("worker")) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const net = fetch(e.request)
        .then((res) => {
          if (res.ok && (u.pathname.endsWith(".html") || u.pathname.endsWith("/") || u.pathname.endsWith(".js") || u.pathname.endsWith(".webmanifest"))) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || net;
    })
  );
});
