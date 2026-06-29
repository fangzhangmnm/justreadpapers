# PWA 热更新(iOS PWA 是大头)

GitHub Pages 部署 + service worker 缓存,用户什么时候能看到新版?简单答案"刷新就行"在 iOS PWA 上不成立 —— 从主屏冷启动 fetch 全走 cache,**永远看不到新版**直到 SW 源 byte 变。

## 三条更新检测路径(都要开)

每条覆盖不同场景:

```js
// A. SW fetch handler 里 eTag/length diff → postMessage "asset-updated"
//    适合:tab 一直开,SW 后台 revalidate 发现新版本
self.addEventListener("fetch", (event) => {
  // 同源 cache-first + 后台 fetch + diff eTag → notify
  ...
});

// B. registration.updatefound + newWorker.statechange = "installed"
//    适合:本次访问期间发现 SW 源换了 (主要触发路径)
reg.addEventListener("updatefound", () => {
  const nw = reg.installing;
  nw.addEventListener("statechange", () => {
    if (nw.state === "installed" && navigator.serviceWorker.controller) {
      showUpdateToast();
    }
  });
});

// C. 启动时 registration.waiting 已存在 + 当前 controller 存在
//    适合:上次访问已装好新 SW 但当时没刷,这次冷启动直接报
if (reg.waiting && navigator.serviceWorker.controller) {
  showUpdateToast();
}
```

**iOS PWA 关键**:从主屏冷启动,fetch 多半全走 cache → A 不 fire,靠 B/C 兜底。

## Bump CACHE_VERSION 是必须的部署仪式

```js
// service-worker.js
const CACHE_VERSION = "v17-2026-05-18";
```

SW 源 byte 变 = 浏览器触发 `updatefound`。如果只改 app.js 不改 SW,SW 内容相同 → 浏览器不认为 SW 变了 → B 不 fire,iOS PWA 永远收不到更新。

我建立的规矩:**每次 push bump 一次**。手动,因为没 build pipeline。`v18-2026-05-18` 这样。

## 不要在 localhost 注册 SW(本地开发)

F5 时 cache 会捣乱。注册前 skip:

```js
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 注册 SW
}
```

`python -m http.server 8000` 本地跑就是干净浏览器 reload,改 CSS 看到立即生效。

## SW fetch 策略:cache-first + 后台 revalidate

```js
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    // 跨源:CDN 走 cache-first lazy populate,Graph / login 直接 passthrough
    ...
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const networkFetch = fetch(req).then((response) => {
      if (response?.ok) {
        if (cached) {
          // diff eTag / content-length → 通知更新
          const changed = (cached.headers.get("etag") !== response.headers.get("etag"))
            || (cached.headers.get("content-length") !== response.headers.get("content-length"));
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(req, response.clone()).catch(() => {});
      }
      return response;
    }).catch(() => null);

    if (cached) { networkFetch.catch(() => {}); return cached; }  // 先返 cache,不 await
    const response = await networkFetch;
    if (response) return response;
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});
```

## Update toast (UX)

不自动 reload(用户可能正读):

```js
function showUpdateToast() {
  toast.classList.remove("hidden");
}
reloadButton.addEventListener("click", () => {
  // 把 session flush 一下再 reload,免得位置丢
  flushKeepalive();
  navigator.serviceWorker.controller?.postMessage({ type: "skip-waiting" });
  location.reload();
});
```

SW 端响应 skip-waiting:

```js
self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
```

## Dedup announce 一次 per SW lifetime

避免反复弹 toast(用户已经看到一次了别再骚扰):

```js
let updateAnnouncedThisLoad = false;
async function notifyUpdate(url) {
  if (updateAnnouncedThisLoad) return;
  updateAnnouncedThisLoad = true;
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  for (const client of clientsList) client.postMessage({ type: "asset-updated", url });
}
```

## 容易踩的坑

- **PWA toast 只有一种文案,但实际有两种来源**(SW 检测到 site 版本变 vs OneDrive session.json 改了)。我用 `updateMode = "site" | "session"` state 区分,reload 按钮按 mode 分流(site → skip-waiting + reload,session → reloadFromRemote)。两个混在一起不区分会双触发或语义乱。
- **Activate 清旧 cache**(`keys.filter(k !== CACHE_NAME).map(caches.delete)`),不然 IndexedDB 涨爆。
- **skipWaiting + clientsClaim** 让新 SW 立即接管,无需关所有 tab。

## 相关
- [20260524-design-principles.md](20260524-design-principles.md) — "iOS / Quest / 4K 同时跑"约束
- [20260524-offline-persistence.md](20260524-offline-persistence.md) — SW 同时也是离线兜底
