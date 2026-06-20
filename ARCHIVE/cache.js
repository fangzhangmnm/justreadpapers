// IndexedDB cache for PDF blobs,frecency 淘汰。
//
// 两个 store: blobs (itemId → Blob) + meta (itemId → {size, lastUsed, useCount, name, eTag})
// 容量到上限 → 按 score 升序淘汰(score 低的先扔):
//   score = lastUsed + useCount × USE_BONUS_MS  (越大越保)
// 每次访问 touch() 把 lastUsed 推到 now 并 useCount++,所以:
//   - 常读的论文 useCount 累得多 → score 高 → 保留
//   - 新读一次的 + 老读了 100 次的:依然新读的可能更新鲜,但老读的有大 frequency bonus
//   - 路过看一眼再没碰的:useCount=1 + 老 lastUsed → 最先淘汰
//
// 缓存键 = OneDrive itemId,等价内容寻址(同一文件多设备 itemId 同)。
// 文件被服务器端 rename 后 itemId 不变 → cache 仍有效。
// 文件内容变了(罕见,基本是用户重传)→ eTag 变,我们存 eTag 但只在 mismatch 时手动失效;
// 默认 hit cache 直接返回,不 revalidate(PDF immutable assumption)。

const DB_NAME = "justreadpapers-cache";
const DB_VERSION = 1;
const STORE_BLOBS = "blobs";
const STORE_META = "meta";

import { CACHE_CAP_BYTES, CACHE_USE_BONUS_MS } from "./config.js";

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS);
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "itemId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function awaitTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getBlob(itemId) {
  const db = await openDb();
  const tx = db.transaction(STORE_BLOBS, "readonly");
  return reqAsPromise(tx.objectStore(STORE_BLOBS).get(itemId));
}

export async function getMeta(itemId) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  return reqAsPromise(tx.objectStore(STORE_META).get(itemId));
}

export async function isCached(itemId) {
  return !!(await getMeta(itemId));
}

export async function listMeta() {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readonly");
  return reqAsPromise(tx.objectStore(STORE_META).getAll());
}

export async function totalBytes() {
  const all = await listMeta();
  return all.reduce((acc, m) => acc + (m.size || 0), 0);
}

export async function touch(itemId) {
  const m = await getMeta(itemId);
  if (!m) return;
  m.lastUsed = Date.now();
  m.useCount = (m.useCount || 0) + 1;
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put(m);
  return awaitTx(tx);
}

function frecencyScore(m) {
  // 越大越保。lastUsed 是绝对时间,useCount 通过 BONUS_MS 折算成"等价新鲜度时间"。
  return (m.lastUsed || 0) + (m.useCount || 0) * CACHE_USE_BONUS_MS;
}

export async function del(itemId) {
  const db = await openDb();
  const tx = db.transaction([STORE_BLOBS, STORE_META], "readwrite");
  tx.objectStore(STORE_BLOBS).delete(itemId);
  tx.objectStore(STORE_META).delete(itemId);
  return awaitTx(tx);
}

async function ensureRoom(reserveBytes) {
  let all = await listMeta();
  let total = all.reduce((a, m) => a + (m.size || 0), 0);
  if (total + reserveBytes <= CACHE_CAP_BYTES) return;
  // 按 frecency 升序(score 低的先扔)
  all.sort((a, b) => frecencyScore(a) - frecencyScore(b));
  for (const m of all) {
    if (total + reserveBytes <= CACHE_CAP_BYTES) break;
    await del(m.itemId);
    total -= m.size || 0;
  }
}

export async function set(itemId, blob, extra = {}) {
  if (blob.size > CACHE_CAP_BYTES) {
    throw new Error(`blob ${blob.size} 超过 cap ${CACHE_CAP_BYTES}`);
  }
  await ensureRoom(blob.size);
  // 新 set 当作首次"使用",useCount=1
  // 如果这个 itemId 之前缓存过(被 evict 后重 download),保留旧的 useCount 累积
  const prev = await getMeta(itemId).catch(() => null);
  const meta = {
    itemId,
    size: blob.size,
    type: blob.type,
    lastUsed: Date.now(),
    useCount: (prev?.useCount || 0) + 1,
    ...extra,
  };
  const db = await openDb();
  const tx = db.transaction([STORE_BLOBS, STORE_META], "readwrite");
  tx.objectStore(STORE_BLOBS).put(blob, itemId);
  tx.objectStore(STORE_META).put(meta);
  return awaitTx(tx);
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
