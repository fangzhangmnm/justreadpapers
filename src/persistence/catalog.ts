// catalog 深模块 —— session 那个"资产"：一个 collection 装一堆论文(docId→元数据+阅读位置)。
// 坐在 @internal/store 的 collection 之上（信封 {id,uat,value}，value=CatalogPayload），
// 免费拿 If-Match 412 合并 + per-id uat-LWW。app 只经此面读写阅读态，**不直接碰 cloud/store**（host 注入 collection）。
//
// trash 用 payload 上的 `deleted` 标记(保留数据可 restore)，不用 collection 的 null 墓碑——
// 低风险阅读态，whole-item LWW 的 edit-wins 够了（rekey 的老 key 才用真墓碑 deleteItem）。
// "上次在读" = max(lastReadAt)。collection 的内部 uat（合并用）app 读不到，recency 排序
// 用 payload 里的 lastReadAt（display-time，合规——非用于合并决策）。
// 同步节律：manual collection，metadata 改动(upsert/touch/trash)即时 debounced 推；
//   位置改动(setPosition)只标脏，由 valuable-save 节流驱动 commitNow（"有价值的保存"）。
//   推云 = reconcileWithRemote（pull-merge-push；manual 模式 setItem 只标脏不自动调度）。
// 读面守卫：只认 value 里带 string fileName 的条目——迁移标记(__v1migrated)等非论文 item 天然被滤掉。

import type { Collection } from "@internal/store";
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
export type CatalogDoc = CatalogPayload & { id: string };

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
  /** 改名/移动：身份=path，key 变即迁移条目（新 key 承接 position/title，老 key 墓碑）。in-app 改名不丢位置。 */
  rekey(oldId: string, newId: string): void;
  lastActiveId(): string | null;
  subscribe(fn: (docs: CatalogDoc[]) => void): () => void;
  commitNow(): Promise<void>;
  flushLocal(): Promise<void>;   // 仅写本地缓存（卸载兜底；离线/强杀续读靠它）
  isDirty(): boolean;
}

export interface CatalogOpts {
  collection: Collection;                   // host 经 store.collection(name,{manual:true,...}) 造
  now?: () => number;
  metadataDebounceMs?: number;              // metadata 改动 debounced 推云（默认 1500）
}

function isPayload(v: unknown): v is CatalogPayload {
  return !!v && typeof v === "object" && typeof (v as { fileName?: unknown }).fileName === "string";
}

export function createCatalog(opts: CatalogOpts): Catalog {
  const now = opts.now ?? ((): number => Date.now());
  const metadataDebounceMs = opts.metadataDebounceMs ?? 1500;
  const c = opts.collection;
  const subs = new Set<(docs: CatalogDoc[]) => void>();

  // metadata 改动(upsert/touch/trash) debounced 推——**绝不立即 fire-and-forget**：
  //   立即推会捕获"编辑半截"的状态，与后续 setPosition 撞车。debounced = 等编辑 settle 才推。
  //   后台推失败不 throw（best-effort；下次 commitNow / 下个周期再推，脏标记还在）。
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function clearFlush(): void { if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; } }
  function scheduleFlush(): void { clearFlush(); flushTimer = setTimeout(() => { flushTimer = null; void c.reconcileWithRemote(); }, metadataDebounceMs); }

  const allDocs = (): CatalogDoc[] => c.entries()
    .filter((e) => isPayload(e.value))
    .map((e) => ({ ...(e.value as CatalogPayload), id: e.id }));
  const sortedActive = (): CatalogDoc[] =>
    allDocs().filter((d) => !d.deleted).sort((a, b) => (b.lastReadAt || 0) - (a.lastReadAt || 0));
  function notify(): void { const d = sortedActive(); for (const fn of subs) { try { fn(d); } catch { /* */ } } }
  // 云端帧也走同一条通知（onChange 对本地写/云端 reconcile 一视同仁 → app 读侧全声明式）。
  c.onChange(() => notify());

  function cur(docId: string): CatalogPayload {
    const v = c.getItem<unknown>(docId);
    return isPayload(v) ? { ...v } : { fileName: "", lastReadAt: now() };
  }
  function put(docId: string, fields: Partial<CatalogPayload>, schedule: boolean): void {
    c.setItem(docId, { ...cur(docId), ...fields, lastReadAt: now() });
    notify();
    if (schedule) scheduleFlush();
  }
  const has = (docId: string): boolean => isPayload(c.getItem<unknown>(docId));

  return {
    init: () => c.init(),
    list: sortedActive,
    listTrash: (): CatalogDoc[] => allDocs().filter((d) => d.deleted),
    get: (docId): CatalogDoc | undefined => {
      const v = c.getItem<unknown>(docId);
      return isPayload(v) ? { ...v, id: docId } : undefined;
    },
    upsert(docId, fields): void { put(docId, fields, true); },
    setPosition(docId, pos): void { put(docId, { position: pos }, false); },   // 不调度：valuable-save 驱动
    touch(docId): void { if (has(docId)) put(docId, {}, true); },
    trash(docId): void { if (has(docId)) put(docId, { deleted: true }, true); },
    restore(docId): void { if (has(docId)) put(docId, { deleted: false }, true); },
    rekey(oldId, newId): void {
      if (oldId === newId) return;
      const v = c.getItem<unknown>(oldId);
      if (!isPayload(v)) return;
      c.setItem(newId, { ...v, fileName: newId });   // 新 path-key 承接全 payload（position/title/addedAt/lastReadAt）
      c.deleteItem(oldId);                            // 老 key → null 墓碑（跨设备照 LWW 传播）
      notify(); scheduleFlush();
    },
    lastActiveId(): string | null { const a = sortedActive(); return a.length ? a[0].id : null; },
    subscribe(fn): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
    // 清 debounce timer + 立即推（valuable-save / 显式保存点）。推不上去**且还有脏数据**→ throw，
    //   让 UI 诚实报"未保存"（脏标记还在，回线自愈）；不脏时拉不到云不算保存失败。
    commitNow: async () => {
      clearFlush();
      const r = await c.reconcileWithRemote();
      if (r.status !== "synced" && c.isDirty()) throw new Error(`catalog 未推云: ${r.status}`);
    },
    flushLocal: async () => { await c.flushLocal(); },   // 仅本地（同步落盘兜底，无网络）
    isDirty: () => c.isDirty(),
  };
}
