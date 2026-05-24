# IndexedDB blob cache + frecency 淘汰

PDF 文件按 OneDrive itemId 缓在 IndexedDB,容量到上限按 **frecency = recency × frequency** 淘汰。

## 容量决策

```js
export const CACHE_CAP_BYTES = 250 * 1024 * 1024;  // 250MB,放 50-250 篇
```

之前 1GB 太大,**OneDrive 版本历史污染 / 设备存储压力都不可见但累计**。250MB 对 1-5MB 的论文 ≈ 50-250 篇,远超 active reading session 需要。

## 为什么不用纯 LRU

纯 LRU 按 `lastUsed` 一刀切。问题:用户**频繁读的论文哪怕一周没碰,也比"误点过一次"的优先级低**(后者 lastUsed 更新)。

frecency = 时间 + 频率 的 hybrid:

```js
export const CACHE_USE_BONUS_MS = 24 * 60 * 60 * 1000;  // 每次访问 = 24h 新鲜度奖励

function frecencyScore(m) {
  // 越大越保。lastUsed 是绝对时间 ms,useCount 通过 BONUS 折算成"等价新鲜度时间"。
  return (m.lastUsed || 0) + (m.useCount || 0) * CACHE_USE_BONUS_MS;
}
```

意义:
- 一篇 lastUsed = 今天的论文,useCount = 1 → score = today + 1 day = tomorrow
- 一篇 lastUsed = 一周前,useCount = 10 → score = -7day + 10day = +3day (= 三天后)
- **第二篇赢**(因为 10 次访问的频次抵过 7 天没碰)

## meta + blob 两 store

```js
const STORE_BLOBS = "blobs";   // itemId → Blob
const STORE_META  = "meta";    // itemId → {size, lastUsed, useCount, name, eTag, type}
```

把 meta 单独 store 让 `listMeta()` 不用 deserialize 大 blob。eviction 算 score 时只读 meta,快。

## touch (访问后) 更新

```js
export async function touch(itemId) {
  const m = await getMeta(itemId);
  if (!m) return;
  m.lastUsed = Date.now();
  m.useCount = (m.useCount || 0) + 1;
  await put(STORE_META, m);
}
```

openPaper 命中 cache 立即 touch,异步不 await(用户不等)。

## set (新加 / 重加) 保留 useCount

```js
export async function set(itemId, blob, extra = {}) {
  if (blob.size > CACHE_CAP_BYTES) throw new Error(`blob 太大`);
  await ensureRoom(blob.size);
  const prev = await getMeta(itemId).catch(() => null);
  const meta = {
    itemId,
    size: blob.size,
    type: blob.type,
    lastUsed: Date.now(),
    useCount: (prev?.useCount || 0) + 1,  // ← 即使被 evict 过,重下载累积 useCount
    ...extra,
  };
  await put([STORE_BLOBS, STORE_META], [blob, meta]);
}
```

被 evict 后又下载 → useCount 累积 → "**热度记忆**" 不丢。

## ensureRoom: 按 score 升序扔

```js
async function ensureRoom(reserveBytes) {
  let all = await listMeta();
  let total = all.reduce((a, m) => a + (m.size || 0), 0);
  if (total + reserveBytes <= CACHE_CAP_BYTES) return;
  all.sort((a, b) => frecencyScore(a) - frecencyScore(b));  // 低 score 先扔
  for (const m of all) {
    if (total + reserveBytes <= CACHE_CAP_BYTES) break;
    await del(m.itemId);
    total -= m.size || 0;
  }
}
```

## 命中率优化的副产品:offline list fallback

cache 里的 meta 包含 `name`,离线时 `listChildren` 失败可以拿来当 paper list:

```js
const meta = await cache.listMeta().catch(() => []);
papersItems = meta.map(m => ({
  id: m.itemId,
  name: m.name || `(unnamed ${m.itemId.slice(-6)})`,
  // 重建 driveItem-shape
  file: { mimeType: "application/pdf" },
  size: m.size,
  lastModifiedDateTime: m.lastUsed ? new Date(m.lastUsed).toISOString() : null,
  _offlineStub: true,
}));
```

所以 `set` 时必须保存 `name`(从 driveItem.name 抄过来):

```js
cache.set(item.id, blob, { name: item.name, eTag: item.eTag });
```

## 未做的优化(textbook 场景)

200 页论文 + 30 张缩略图 canvas ≈ 20MB GPU 内存。500 页 textbook 进概览模式 → 内存涨。

未来可以:
- 缩略图 canvas 按 IntersectionObserver 反向 unobserve + 释放(目前只渲染不释放,直到换 PDF / teardown)
- blob cache 加 LRU+size cap (单 blob 大于 N MB 不缓,直接走 Graph)

MVP 没做,留着。

## 相关
- [00-design-principles.md](00-design-principles.md) — PDF 是 cache,session 是 asset
- [07-offline-persistence.md](07-offline-persistence.md) — cache meta 兼当 offline paper list
