// catalog 深模块 —— session 那个"资产":一个 JSON envelope 装一堆论文(docId→元数据+阅读位置)。
// 坐在 folder-store(泛型 synced-items-doc)之上,免费拿 If-Match 412 合并 + per-id uat-LWW。
// app 只经此面读写阅读态,**不直接碰 cloud**。可注入 cloud(mock)→ node 可测整条 pull-merge-push。
//
// trash 用 item 上的 `deleted` 标记(保留数据可 restore,对齐旧 session.json 的 deleted 字段),
// 不用 folder-merge 的 trash 集 —— 低风险阅读态,whole-item uat-LWW 的 edit-wins 够了。
// "上次在读" = 派生(max-uat),不存独立 lastActive 字段。

import { createFolderStore } from "../store/folder-store.ts";
import { emptyFolder, parseFolderBlob } from "../store/folder-merge.ts";
import type { FolderEnvelope } from "../store/folder-merge.ts";
import type { Bytes, CloudSync } from "../store/types.ts";
import type { Position } from "../domain/viewer-geometry.ts";

/** catalog 里一篇论文(folder item + JRP payload)。其余字段对 folder-merge 是 opaque,原样搬运。 */
export interface CatalogDoc {
  id: string;            // docId(内容 hash | arxiv),稳定身份
  uat: number;           // last-user-action-time(LWW + lastActive 派生)
  fileName: string;      // /papers 下文件名(可变,改名只更新这里 → 位置不脱链)
  title?: string;
  addedAt?: number;
  position?: Position;
  deleted?: boolean;     // 软删(trash)。list 过滤;restore 翻回。
  [k: string]: unknown;
}

export interface Catalog {
  /** 拉远端 catalog merge 进来(启动调一次)。 */
  init(): Promise<void>;
  /** 活跃(非 deleted)docs,按 uat 倒序(最近在读在前)。 */
  list(): CatalogDoc[];
  /** 回收站(deleted)docs。 */
  listTrash(): CatalogDoc[];
  get(docId: string): CatalogDoc | undefined;
  /** 新增/改元数据(fileName/title/addedAt…),bump uat,排元数据同步(folder-store 防抖)。 */
  upsert(docId: string, fields: Partial<Omit<CatalogDoc, "id" | "uat">>): void;
  /** 改阅读位置,bump uat,**只标脏不调度**(由 valuable-save 决定何时 commit)。 */
  setPosition(docId: string, pos: Position): void;
  /** 打开一篇 → bump uat(让它成为 lastActive),排同步。 */
  touch(docId: string): void;
  trash(docId: string): void;
  restore(docId: string): void;
  /** 派生:max-uat 的 doc id(URL 打开跳它);无 → null。 */
  lastActiveId(): string | null;
  subscribe(fn: (docs: CatalogDoc[]) => void): () => void;
  /** valuable-save 调:立即 flush 到云(若脏)。 */
  commitNow(): Promise<void>;
  isDirty(): boolean;
}

export interface CatalogOpts {
  cloud: CloudSync;
  name: string;           // 云端文件名(config.CATALOG_NAME)
  now?: () => number;
  isOnline?: () => boolean;
}

export function createCatalog(opts: CatalogOpts): Catalog {
  const now = opts.now ?? ((): number => Date.now());
  let env: FolderEnvelope = emptyFolder();
  const subs = new Set<(docs: CatalogDoc[]) => void>();

  const encode = (folder: FolderEnvelope): Bytes | Blob =>
    new Blob([JSON.stringify(folder)], { type: "application/json" });
  const decode = (text: string): FolderEnvelope | null => parseFolderBlob(text);

  const store = createFolderStore({ cloud: opts.cloud, name: opts.name, encode, decode, isOnline: opts.isOnline });
  store.configure({
    snapshot: () => env,
    onResult: (res) => { if (res.folder) { env = res.folder; notify(); } },
  });

  const items = (): CatalogDoc[] => env.items as unknown as CatalogDoc[];
  const sortedActive = (): CatalogDoc[] =>
    items().filter((d) => !d.deleted).sort((a, b) => (b.uat || 0) - (a.uat || 0));
  function notify(): void { const d = sortedActive(); for (const fn of subs) { try { fn(d); } catch { /* */ } } }
  function find(docId: string): CatalogDoc | undefined { return items().find((d) => d.id === docId); }
  function ensure(docId: string): CatalogDoc {
    let it = find(docId);
    if (!it) { it = { id: docId, uat: now(), fileName: "" }; env.items.push(it); }
    return it;
  }
  function bump(it: CatalogDoc): void { it.uat = now(); }

  return {
    async init(): Promise<void> {
      // sync 当前(空)env → 内部 pull-merge-push;onResult 采纳远端。离线则保持空,下次再 sync。
      try { await store.sync(); } catch { /* 离线 */ }
    },
    list: sortedActive,
    listTrash: (): CatalogDoc[] => items().filter((d) => d.deleted),
    get: find,
    upsert(docId, fields): void {
      const it = ensure(docId);
      Object.assign(it, fields);
      bump(it);
      notify(); store.edit();
    },
    setPosition(docId, pos): void {
      const it = ensure(docId);
      it.position = pos; bump(it);
      notify(); store.setDirty(true);   // 不 schedule:valuable-save 驱动 commit
    },
    touch(docId): void {
      const it = find(docId); if (!it) return;
      bump(it); notify(); store.edit();
    },
    trash(docId): void {
      const it = find(docId); if (!it) return;
      it.deleted = true; bump(it); notify(); store.edit();
    },
    restore(docId): void {
      const it = find(docId); if (!it) return;
      it.deleted = false; bump(it); notify(); store.edit();
    },
    lastActiveId(): string | null {
      let best: CatalogDoc | null = null;
      for (const it of sortedActive()) { best = it; break; }   // 已按 uat 倒序
      return best ? best.id : null;
    },
    subscribe(fn): () => void { subs.add(fn); return () => { subs.delete(fn); }; },
    async commitNow(): Promise<void> { await store.flush(); },
    isDirty(): boolean { return store.isDirty(); },
  };
}
