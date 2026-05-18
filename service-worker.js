// SW: cache-first + 后台 revalidate + ETag/length diff → 通知页面 "有新版本"。
// 页面 toast,用户点刷新才 skipWaiting + reload (永不自动 reload,可能正在读书)。
//
// 三类 origin:
//   1. 同源 (本站文件): precache + cache-first + 后台 revalidate + 变了发"asset-updated"
//   2. 已知 CDN (pdf.js / MSAL CDN): precache 关键文件 + cache-first(lazy populate cmaps/字体)
//      → 飞机模式下也能开新论文
//   3. 其它跨源 (Graph / login.microsoftonline): passthrough,不 cache (SSOT)
//
// 改了 precache 文件后 bump CACHE_VERSION。

// Bump 这个常量 = SW 源 byte 变 → 浏览器触发 updatefound,iOS PWA 也能感知
// 部署前手 bump (没自动化 build pipeline)。
const CACHE_VERSION = "v12-2026-05-18";
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

// 第三方 CDN 关键文件 —— 装 PWA 时预缓,飞机上也能开论文
const PDFJS_VERSION = "4.10.38";
const MSAL_VERSION = "3.27.0";
const CDN_PRECACHE_URLS = [
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.mjs`,
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.mjs`,
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/web/pdf_viewer.mjs`,
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/web/pdf_viewer.css`,
  `https://cdn.jsdelivr.net/npm/@azure/msal-browser@${MSAL_VERSION}/lib/msal-browser.min.js`,
];

// 这些域名都走 cache-first lazy populate:第一次访问 fetch + cache,之后离线也能拿。
// pdf.js 的 cmaps/standard_fonts 走这条 (按需,不预缓)。
const CDN_DOMAINS = new Set(["cdn.jsdelivr.net", "unpkg.com"]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      // CDN 单独 try/catch,挂一个不要全 install 失败 (没网就先 skip,运行时再 cache)
      for (const url of CDN_PRECACHE_URLS) {
        try {
          await cache.add(new Request(url, { mode: "cors" }));
        } catch (_) {}
      }
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

  // 已知 CDN: cache-first lazy populate,离线也能拿
  if (url.origin !== self.location.origin) {
    if (CDN_DOMAINS.has(url.hostname)) {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const resp = await fetch(req);
          if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
          return resp;
        } catch (e) {
          // 离线 + 没缓存 → 503
          return new Response("offline cdn miss", { status: 503 });
        }
      })());
      return;
    }
    // Graph / login / 其它跨源 → passthrough
    return;
  }

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
