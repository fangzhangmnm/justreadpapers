// SW: cache-first + 后台 revalidate + ETag/length diff → 通知页面 "有新版本"。
// 页面 toast,用户点刷新才 skipWaiting + reload (永不自动 reload,可能正在读书)。
//
// 所有运行依赖都 vendor 在 src/vendor/(见 src/vendor/README.md),全部同源。
// SW 只管两类 origin:
//   1. 同源 (本站文件 + vendor): precache + cache-first + 后台 revalidate
//   2. 其它跨源 (Graph / login.microsoftonline / OneDrive downloadUrl): passthrough,不 cache (SSOT)
//
// 改了 precache 文件后 bump CACHE_VERSION。

const CACHE_VERSION = "v19-2026-05-26";
const CACHE_NAME = `jrp-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  // app shell
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

  // vendor: pdf.js (cmaps + standard_fonts 不预缓 —— 一百多个文件,按需 fetch + 同源 cache-first 自然落盘)
  "./src/vendor/pdfjs/pdf.mjs",
  "./src/vendor/pdfjs/pdf.worker.mjs",
  "./src/vendor/pdfjs/web/pdf_viewer.mjs",
  "./src/vendor/pdfjs/web/pdf_viewer.css",

  // vendor: MSAL
  "./src/vendor/msal/msal-browser.min.js",
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
  // 跨源 (Graph / login / OneDrive downloadUrl) passthrough,不缓
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
