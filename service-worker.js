// JRP service worker —— 抄 WebPaint sw shell(1:1 结构,只改 bundle 名 jrp- + precache 列表)。
// content-hash bundle → cache name 自动随 build 失效(无手动 version)。install 时 fetch index.html
// 抠出当前 bundle 文件名 → precache。论证见 WebPaint docs/why-content-hash-bundle.md。
//
// 跟家族抄:基本 1:1 拷,改 STATIC_PRECACHE + bundle 名前缀就行。
// 注意:install/hash regex 必须跟 build.sh 的 bundle 名(jrp-)一致,否则装不上→服旧缓存。

const STATIC_PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  // pdf.js / msal / 其它运行时 vendor 同源,用到才 fetch 时自动入缓(不预缓 ~4MB pdf.js)。
  // styles.css 待 P3 抽出再加进来。
];

let CACHE_NAME = "jrp-boot";   // install 时替换为 jrp-<bundleHash>

async function getCurrentBundleUrl() {
  const res = await fetch("./index.html", { cache: "no-store" });
  if (!res.ok) throw new Error("install: index.html fetch failed " + res.status);
  const html = await res.text();
  // <script type="module" src="./dist/jrp-<hash>.mjs"></script>
  const m = html.match(/src="(\.\/dist\/jrp-[a-z0-9-]+\.mjs)"/i);
  if (!m) throw new Error("install: 找不到 ./dist/jrp-*.mjs 入口 in index.html");
  return { html, bundleUrl: m[1] };
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const { bundleUrl } = await getCurrentBundleUrl();
    const bundleHash = bundleUrl.match(/jrp-([a-z0-9-]+)\.mjs/i)?.[1] || "boot";
    CACHE_NAME = `jrp-${bundleHash}`;
    const cache = await caches.open(CACHE_NAME);
    const urls = [...STATIC_PRECACHE, bundleUrl, bundleUrl + ".map"];
    await Promise.all(urls.map((u) =>
      fetch(u, { cache: "no-store" })
        .then((r) => r.ok ? cache.put(u, r) : null)
        .catch((err) => console.warn("[SW] precache miss", u, err.message))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("jrp-") && k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

let updateAnnounced = false;
async function notifyUpdate(url) {
  if (updateAnnounced) return;
  updateAnnounced = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: "asset-updated", url });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨源(Graph/login/OneDrive downloadUrl):passthrough,绝不缓(SSOT 完整性)
  if (url.pathname.includes("/dev/")) return;         // /dev/ 走纯 HTTP,改完即见(deploy 也从 /dev/ 删 SW)

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });

    const networkPromise = fetch(req).then((resp) => {
      if (resp && resp.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = resp.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = resp.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    }).catch(() => null);

    if (cached) { networkPromise.catch(() => {}); return cached; }
    const resp = await networkPromise;
    if (resp) return resp;
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
