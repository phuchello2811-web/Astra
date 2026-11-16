// Lưu sẵn giao diện để web app mở được cả khi không có mạng.
// Đổi VERSION mỗi khi cập nhật index.html để máy người dùng nhận bản mới.
const VERSION = "astra-v79";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => /^(astra|glm)-/.test(k) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== self.location.origin) return;
  if (e.request.mode === "navigate" || SHELL.some((p) => u.pathname.endsWith(p.replace("./", "/")))) {
    e.respondWith(
      caches.match(e.request).then((cached) =>
        fetch(e.request)
          .then((res) => {
            if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
            return res;
          })
          .catch(() => cached)
      )
    );
  }
});
