# 离线持久化(飞机模式可用)

目标:**装了 PWA 后,飞机上也能开看过的论文,继续读,飞机落地自动 sync**。

不"反而没你想的难"(用户原话),只要分清楚哪些资源走哪条路径。

## 四类资源 + 四种策略

| 资源 | 策略 | 实现 |
| --- | --- | --- |
| 同源 app shell (html/css/js/icon) | SW precache + cache-first 后台 revalidate | 见 06-pwa-hot-update |
| 第三方 CDN 依赖(pdf.js / MSAL) | SW precache 关键文件 + cache-first lazy populate | 见下 |
| PDF 文件 (二进制) | IndexedDB blob cache,frecency 淘汰 | 见 12-cache-frecency |
| Session.json | localStorage 备份 + initSession 先 hydrate 备份再 fetch Graph | 见 05-session-sync-throttle |

## SW: 缓 CDN 依赖(关键!)

默认 SW fetch handler 只处理同源,跨源 passthrough。pdf.js 是 `cdn.jsdelivr.net` 跨源 → SW 不缓 → 离线打不开 PDF。

改:**已知 CDN 走 cache-first lazy populate**:

```js
const CDN_DOMAINS = new Set(["cdn.jsdelivr.net", "unpkg.com"]);
const CDN_PRECACHE_URLS = [
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs`,
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs`,
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/web/pdf_viewer.mjs`,
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/web/pdf_viewer.css`,
  `https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.27.0/lib/msal-browser.min.js`,
];

// install 时预缓关键文件 (cmaps / fonts 太多,走 lazy populate)
self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
    for (const url of CDN_PRECACHE_URLS) {
      try { await cache.add(new Request(url, { mode: "cors" })); } catch (_) {}
      //   ↑ 单独 try/catch,挂一个不要全 install 失败
    }
    await self.skipWaiting();
  })());
});

// fetch 时已知 CDN 走 cache-first lazy populate
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    if (CDN_DOMAINS.has(url.hostname)) {
      event.respondWith((async () => {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const resp = await fetch(event.request);
          if (resp?.ok) cache.put(event.request, resp.clone()).catch(() => {});
          return resp;
        } catch (e) {
          return new Response("offline cdn miss", { status: 503 });
        }
      })());
      return;
    }
    // 其它跨源 (Graph / login) → 不 intercept,passthrough
    return;
  }
  // 同源:cache-first + revalidate
  event.respondWith(...);
});
```

pdfjs 的 `cmaps/` (CJK 字符) 和 `standard_fonts/` 文件几百个,**不 precache,lazy populate**:首次需要时 SW 缓一份,之后离线就有了。

## App 层:listChildren 离线 fallback

Graph API 调用在飞机上必失败 (`graphFetch` throws)。`listChildren` fail → 抓 IndexedDB cache.listMeta() 当替代:

```js
async function loadFolderItems() {
  try {
    papersItems = await listChildren(PAPERS_FOLDER);
    papersItems = papersItems.filter((i) => i.file && /\.pdf$/i.test(i.name || ""));
  } catch (e) {
    // 离线 → 用本地缓存的论文当列表
    const meta = await cache.listMeta().catch(() => []);
    papersItems = meta.map((m) => ({
      id: m.itemId,
      name: m.name || `(unnamed ${m.itemId.slice(-6)})`,
      file: { mimeType: "application/pdf" },
      size: m.size || 0,
      eTag: m.eTag || null,
      lastModifiedDateTime: m.lastUsed ? new Date(m.lastUsed).toISOString() : null,
      _offlineStub: true,
    }));
  }
}
```

cache.set 时把 `name`、`eTag` 也存进 meta,离线时能 reconstruct 一个 driveItem-like。

## Session.json localStorage 备份

每次 mutation + 成功 PUT 都同步写一份:

```js
const LOCAL_BACKUP_KEY = "jrp.session.backup";
function writeLocalBackup() {
  try { localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(state)); } catch (_) {}
}
```

`initSession` 先 hydrate 备份再尝试 Graph:

```js
const backup = readLocalBackup();
if (backup) state = normalize(backup);  // optimistic hydrate

try {
  const { data, eTag } = await readApprootJson(SESSION_FILE);
  if (data) { state = normalize(data); knownETag = eTag; }
} catch (e) {
  // 离线 / Graph 失败 → 继续用 backup
  console.warn("initSession remote failed, using local backup");
}
```

冷启动飞机模式:hydrate 备份 → lastActive 拿到 → openPaper → cache 命中 → 直接看。

## 网络恢复:online 事件触发 flush

```js
window.addEventListener("online", () => {
  flush().catch(() => {});  // 推积压的脏 session
  if (drawerView === "papers") renderDocList().catch(() => {});
});
```

离线期间 dirty 一直累积,online 一回来 flush 一次性推。配 If-Match 412 merge,跟设备 B 的修改自动合并。

## openPaper 离线行为

`openPaper` 已有的逻辑:
- 先 `cache.getBlob(item.id)` 命中 → 直接用 → 离线 OK
- miss → `downloadItemBlob` (Graph) → 离线 fail → 错误 toast "未联网且未缓存"

cache 命中是自动的离线路径。

## 几个细节

- **不 cache cmaps 上千文件**:precache 列表只放确定要用的几个 mjs / css。cmaps / standard_fonts 按需 cache。
- **OneDrive lib(MSAL)虽然能 cache,但离线没 token 也调不了 Graph**。让 MSAL 失败 graceful → "未登录" 状态 + 用 IndexedDB 内容继续 read。
- **session.js 在 Graph 失败时不要把状态弄成"完全空"**:hydrate localStorage backup 是 first 步。

## webxiaoheiwu 的冲突机制

用户说 "用 webxiaoheiwu 的冲突解决"。两者本质同:
- IF-Match (eTag) 乐观锁
- 412 → re-fetch + merge + retry
- 网络/5xx → mark dirty + 下次 cycle 再试

不同:webxiaoheiwu 写小说 doc 内容,冲突要保留两份(sibling .txt)避免覆盖用户文字;justreadpapers 写位置数据,本设备活跃为准就行(用户不会"误覆盖位置"),merge 直接 last-write-wins-with-local-bias。

## 相关
- [20260524-session-sync-throttle.md](20260524-session-sync-throttle.md) — session.json sync 细节
- [20260524-pwa-hot-update.md](20260524-pwa-hot-update.md) — SW 同时做缓 / 更新
- [20260524-cache-frecency.md](20260524-cache-frecency.md) — IndexedDB blob 淘汰
