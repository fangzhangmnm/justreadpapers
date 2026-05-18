// IndexedDB LRU cache for PDF blobs.
//
// 两个 store: blobs (itemId → Blob) + meta (itemId → {size, name, eTag, lastUsed})
// 容量到上限就按 lastUsed 升序淘汰。
//
// 缓存键 = OneDrive itemId,等价内容寻址(同一文件多设备 itemId 同)。
// 文件被服务器端 rename 后 itemId 不变 → cache 仍有效。
// 文件内容变了(罕见,基本是用户重传)→ eTag 变,我们存 eTag 但只在 mismatch 时手动失效;
// 默认 hit cache 直接返回,不 revalidate(PDF immutable assumption)。

const DB_NAME = "justreadpapers-cache";
const DB_VERSION = 1;
const STORE_BLOBS = "blobs";
const STORE_META = "meta";

import { CACHE_CAP_BYTES } from "./config.js";

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
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put(m);
  return awaitTx(tx);
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
  all.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
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
  const meta = {
    itemId,
    size: blob.size,
    type: blob.type,
    lastUsed: Date.now(),
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
