// catalog 深模块 —— session 那个"资产"：一个 collection 装一堆论文(docId→元数据+阅读位置)。
// 坐在 store.collection(泛型 synced-items-doc)之上，免费拿 If-Match 412 合并 + per-id LWW。
// app 只经此面读写阅读态，**不直接碰 cloud/store**（host 注入 collection）。
//
// trash 用 item 上的 `deleted` 标记(保留数据可 restore)，不用 collection 的 trash 集——
// 低风险阅读态，whole-item LWW 的 edit-wins 够了。
// "上次在读" = max(lastReadAt)。注：collection 的内部 uat（合并用）故意隐藏，所以 recency 排序
// 用 payload 里的 lastReadAt（display-time，合规——非用于合并决策）。
// 同步节律：manual collection，metadata 改动(upsert/touch/trash)即时 flush；
//   位置改动(setPosition)只标脏，由 valuable-save 节流驱动 commitNow（"有价值的保存"）。

import type { Collection, CollectionItem } from "../store/index.ts";
import type { Position } from "../domain/viewer-geometry.ts";

/** catalog 里一篇论文的 payload。其余字段对 collection 是 opaque，原样搬运。 */
export interface CatalogPayload {
  fileName: string;      // /papers 下文件名（可变，改名只更新这里 → 位置不脱链）
  title?: string;
  addedAt?: number;
  position?: Position;
  deleted?: boolean;     // 软删(trash)。list 过滤；restore 翻回。
  lastReadAt: number;    // display-time recency（排序 + lastActive 派生）
  [k: string]: unknown;
}
export type CatalogDoc = CollectionItem<CatalogPayload>;   // = CatalogPayload & { id }

export interface Catalog {
  init(): Promise<void>;
  list(): CatalogDoc[];                  // 活跃(非 deleted)，按 lastReadAt 倒序
  listTrash(): CatalogDoc[];
  get(docId: string): CatalogDoc | undefined;
  upsert(docId: string, fields: Partial<CatalogPayload>): void;
  setPosition(docId: string, pos: Position): void;   // 只标脏，valuable-save 驱动 commit
  touch(docId: string): void;
  trash(docId: string): void;
  restore(docId: string): void;
  lastActiveId(): string | null;
  subscribe(fn: (docs: CatalogDoc[]) => void): () => void;
  commitNow(): Promise<void>;
  flushLocal(): Promise<void>;   // 仅写本地缓存（卸载兜底；离线/强杀续读靠它）
  isDirty(): boolean;
}

export interface CatalogOpts {
  collection: Collection<CatalogPayload>;   // host 经 store.collection(name,{manual:true}) 造
  now?: () => number;
  metadataDebounceMs?: number;              // metadata 改动 debounced flush（默认 1500）
}

export function createCatalog(opts: CatalogOpts): Catalog {
  const now = opts.now ?? ((): number => Date.now());
  const metadataDebounceMs = opts.metadataDebounceMs ?? 1500;
  const c = opts.collection;
  const subs = new Set<(docs: CatalogDoc[]) => void>();

  // metadata 改动(upsert/touch/trash) debounced flush——**绝不立即 fire-and-forget**：
  //   立即 flush 会捕获"编辑半截"的 env，与后续 setPosition 撞车（相等 uat tiebreak 还会丢 position）。
  //   debounced = 等编辑 settle 才推。位置改动(setPosition)只标脏，由 valuable-save 节流驱动 commitNow。
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function clearFlush(): void { if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; } }
  function scheduleFlush(): void { clearFlush(); flushTimer = setTimeout(() => { flushTimer = null; void c.flush(); }, metadataDebounceMs); }

  const sortedActive = (): CatalogDoc[] =>
    c.items().filter((d) => !d.deleted).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  function notify(): void { const d = sortedActive(); for (const fn of subs) { try { fn(d); } catch { /* */ } } }
  function cur(docId: string): CatalogPayload {
    const it = c.getItem(docId);
    return it ? { ...it } : { fileName: "", lastReadAt: now() };
  }
  function put(docId: string, fields: Partial<CatalogPayload>, schedule: boolean): void {
    c.upsertItem({ ...cur(docId), ...fields, id: docId, lastReadAt: now() });
    notify();
    if (schedule) scheduleFlush();
  }

  return {
    init: () => c.init(),
    list: sortedActive,
    listTrash: (): CatalogDoc[] => c.items().filter((d) => d.deleted),
    get: (docId) => c.getItem(docId),
    upsert(docId, fields): void { put(docId, fields, true); },
    setPosition(docId, pos): void { put(docId, { position: pos }, false); },   // 不调度：valuable-save 驱动
    touch(docId): void { if (c.getItem(docId)) put(docId, {}, true); },
    trash(docId): void { if (c.getItem(docId)) put(docId, { deleted: true }, true); },
    restore(docId): void { if (c.getItem(docId)) put(docId, { deleted: false }, true); },
    lastActiveId(): string | null { const a = sortedActive(); return a.length ? a[0].id : null; },
    subscribe(fn): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
    commitNow: () => { clearFlush(); return c.flush(); },   // 清 debounce timer + 立即推（valuable-save / 显式点）
    flushLocal: () => c.flushLocal(),                       // 仅本地（同步落盘兜底，无网络）
    isDirty: () => c.isDirty(),
  };
}
