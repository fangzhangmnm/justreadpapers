// SW: cache-first + 后台 revalidate + ETag/length diff → 通知页面 "有新版本"。
// 页面 toast,用户点刷新才 skipWaiting + reload (永不自动 reload,可能正在读书)。
//
// 同源 only。pdf.js CDN / Graph / MSAL CDN 都 passthrough,
// 因为它们应该走浏览器 HTTP cache + SSOT 原则。
//
// 改了 precache 文件后 bump CACHE_VERSION。

// Bump 这个常量 = SW 源 byte 变 → 浏览器触发 updatefound,iOS PWA 也能感知
// 部署前手 bump (没自动化 build pipeline)。
const CACHE_VERSION = "v5-2026-05-18";
const CACHE_NAME = `jrp-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./src/styles.css",
  "./src/app.js",
  "./src/auth.js",
  "./src/graph.js",
  "./src/session.js",
  "./src/cache.js",
  "./src/viewer.js",
  "./src/config.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k.startsWith("jrp-") && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

let updateAnnouncedThisLoad = false;

async function notifyUpdate(url) {
  if (updateAnnouncedThisLoad) return;
  updateAnnouncedThisLoad = true;
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clientsList) client.postMessage({ type: "asset-updated", url });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // 跨源 passthrough
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const networkFetch = fetch(req).then((response) => {
      if (response && response.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = response.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = response.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(req, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);

    if (cached) {
      networkFetch.catch(() => {});
      return cached;
    }
    const response = await networkFetch;
    if (response) return response;
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") {
    self.skipWaiting();
  }
});
