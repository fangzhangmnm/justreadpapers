// ⚠ 使用前必读 STORE.md。app 不直接 import 本文件——经 createStore 的 store.collection 拿。
//
// GENERIC — Collection store facade（STORE.md §3）。一份同步 JSON 装多个**原子** item。
// 自拥内存 envelope（不像 folder-store 让 app 注入 snapshot()/onResult）；item = 普通 JSON 对象。
// 信封 { id, uat, ...payload } 由本模块强制：id 类型上必填、uat **内部盖戳**（app 既传不进也读不到）、
//   其余字段 = opaque payload。合并复用 folder-merge（per-item uat-LWW，CRDT-lite，零冲突）；
//   同步复用 folder-flow（pull-merge-push）。序列化 = JSON（#68：collection 是结构化可合并 JSON，
//   不要 app 传 encode/decode）。
import { createFolderFlow } from "./folder-flow.ts";
import { emptyFolder, parseFolderBlob, mergeFolders, normalizeFolder } from "./folder-merge.ts";
import type { FolderEnvelope, FolderItem } from "./folder-merge.ts";
import type { CloudSync } from "./types.ts";

// 对外 item：调用方给的 payload + 必填 id（uat 不在此——库内部的事）。
export type CollectionItem<T extends object> = T & { id: string };

export interface CollectionConfig {
  cloud: CloudSync;
  name: string;                 // 同步键 = 云端文件名（如 "reading-state.json"）
  isOnline?: () => boolean;
  syncDelayMs?: number;         // 编辑后防抖自动同步（collection 无冲突、union 安全，频繁推也行）
  now?: () => number;           // uat 盖戳（默认 Date.now；测试可注入确定时钟）
  manual?: boolean;             // true=upsert/delete 只标脏不自动调度，由 flush 驱动 commit（阅读位置走 valuable-save 节流）
}

export interface Collection<T extends object> {
  init(): Promise<void>;                              // 首次拉云端 merge 进内存
  upsertItem(item: CollectionItem<T>): void;          // 新增 / 整条原子替换
  deleteItem(id: string): void;                       // 移到 trash（edit-wins 合并）
  getItem(id: string): CollectionItem<T> | undefined;
  items(): CollectionItem<T>[];                       // 全部 item（每条含自己的 id）
  keys(): string[];                                   // 全部 id
  flush(): Promise<void>;                             // 取消防抖、若脏立即同步
  isDirty(): boolean;
}

const encode = (f: FolderEnvelope): Uint8Array => new TextEncoder().encode(JSON.stringify(f));
const decode = (text: string): FolderEnvelope | null => parseFolderBlob(text);

// FolderItem（内部，带 uat）→ 对外 item（剥掉 uat，留 id + payload）。
function toItem<T extends object>(e: FolderItem): CollectionItem<T> {
  const { uat: _uat, ...rest } = e;
  return rest as CollectionItem<T>;
}

export function createCollection<T extends object>(cfg: CollectionConfig): Collection<T> {
  const { cloud, name, isOnline, syncDelayMs = 1500, now = () => Date.now(), manual = false } = cfg;
  const flow = createFolderFlow({ cloud, name, encode, decode, isOnline });
  let env: FolderEnvelope = emptyFolder();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() { if (timer != null) { clearTimeout(timer); timer = null; } }
  function scheduleSync() {
    cloud.setDirty(name, true);
    if (manual) return;          // 手动模式：只标脏，commit 由调用方 flush() 驱动（valuable-save 节流）
    clearTimer();
    timer = setTimeout(() => { timer = null; void sync(); }, syncDelayMs);
  }

  // sync：snapshot 内存 env → folder-flow（pull-merge-push）→ 把合并结果**并回**当前 env。
  // ★关键：用 mergeFolders 并回、不整体替换——sync 是 async，期间 env 可能又被编辑（如 fire-and-forget
  //   flush 与后续 upsert 撞车）；per-item LWW 保那些新编辑（更高 uat）不被旧快照的合并结果覆盖。
  // dirty 收尾（K12）：只有"synced 且并回后没新编辑（== 已推的 res.folder）"才清脏；否则留脏，下次 flush 推新编辑。
  async function sync(): Promise<void> {
    const res = await flow.sync(env);
    env = mergeFolders(env, res.folder);
    if (res.status === "synced") {
      if (res.etag) cloud.setETag(name, res.etag);
      if (normalizeFolder(env) === normalizeFolder(res.folder)) cloud.setDirty(name, false);
    }
  }

  async function init(): Promise<void> {
    const res = await flow.sync(env);   // 离线则空起步，后续 sync 收敛
    env = mergeFolders(env, res.folder);
    if (res.status === "synced" && res.etag) cloud.setETag(name, res.etag);
  }

  function upsertItem(item: CollectionItem<T>): void {
    if (item == null || item.id == null) throw new Error("collection.upsertItem: item.id 必填");
    const fi: FolderItem = { ...item, id: item.id, uat: now() };   // uat 内部盖戳
    env = { ...env, items: [...env.items.filter((e) => e.id !== item.id), fi] };
    scheduleSync();
  }

  function deleteItem(id: string): void {
    if (!env.items.some((e) => e.id === id)) return;
    env = {
      ...env,
      items: env.items.filter((e) => e.id !== id),
      trash: [...env.trash.filter((t) => t.id !== id), { id, uat: now() }],
    };
    scheduleSync();
  }

  function getItem(id: string): CollectionItem<T> | undefined {
    const e = env.items.find((x) => x.id === id);
    return e ? toItem<T>(e) : undefined;
  }
  function items(): CollectionItem<T>[] { return env.items.map((e) => toItem<T>(e)); }
  function keys(): string[] { return env.items.map((e) => String(e.id)); }
  function flush(): Promise<void> { clearTimer(); return cloud.isDirty(name) ? sync() : Promise.resolve(); }
  function isDirty(): boolean { return cloud.isDirty(name); }

  return { init, upsertItem, deleteItem, getItem, items, keys, flush, isDirty };
}
