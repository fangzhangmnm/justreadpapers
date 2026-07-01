// persistence host —— **唯一** import store 并构造 store/catalog/content 的地方。
// 红线②钉死在此一处：app 其它处碰 localStorage/indexedDB/graph/store 内部 = 违规（build.sh lint 挡）。
// 全走 createStore 唯一入口；catalog=阅读态(collection)、content=PDF(file)、settings=store.localSettings。

import { createStore, createOneDriveProvider } from "../store/index.ts";
import type { Store, StoreUI } from "../store/index.ts";
import { createCatalog } from "./catalog.ts";
import type { Catalog, CatalogPayload } from "./catalog.ts";
import { createContent } from "./content.ts";
import type { Content } from "./content.ts";
import { buildItems } from "../gallery-model.ts";
import type { GalleryItem, CatalogMeta } from "../gallery-model.ts";
import { createValuableSave } from "../domain/valuable-save.ts";
import type { ValuableSave } from "../domain/valuable-save.ts";
import type { Position } from "../domain/viewer-geometry.ts";
import * as cfg from "../config.ts";

// ── 设备本地设置(zoom/spread/theme)，over store.localSettings(不同步)。app 调这个，不碰 localStorage ──
export interface Settings {
  get(key: string): string | null;
  set(key: string, val: string): void;
  getNum(key: string, dflt: number): number;
  setNum(key: string, val: number): void;
}
function createSettings(ls: Store["localSettings"]): Settings {
  return {
    get: (k) => ls.get<string>(k) ?? null,
    set: (k, v) => ls.set(k, v),
    getNum: (k, d) => { const v = ls.get<number>(k); return typeof v === "number" && Number.isFinite(v) ? v : d; },
    setNum: (k, v) => ls.set(k, v),
  };
}

export type Auth = ReturnType<typeof createOneDriveProvider>["auth"];

export type SaveState = "dirty" | "saving" | "saved";

/** host 注入的 UI 回调：错误 surface（红线：冲突/错误必 surface，不吞 console）+ 保存状态指示。 */
export interface PersistenceHooks {
  onError?: (msg: string) => void;
  onSaveState?: (s: SaveState) => void;
  onBusy?: (label: string | null) => void;   // 全屏遮罩驱动（store 危险写操作锁屏；label=进入、null=退出，ref-count 在 host）
  resolveConflict: StoreUI["resolveConflict"];                 // 冲突 sheet（红线：冲突必 surface，必传，绝不静默 cancel）
  offlineEscape?: NonNullable<StoreUI["offlineEscape"]>;       // 云检查「跳过到离线」逃生闸（fetchMeta 挂死时用户即超时）；不给 → 无逃生
}

export interface Persistence {
  auth: Auth;
  catalog: Catalog;     // 资产：阅读态(collection)
  content: Content;     // PDF 字节(只读镜像 + 离线缓存)
  settings: Settings;   // 设备本地
  save: ValuableSave;   // 位置节流，绑 catalog.commitNow
  listGallery(): Promise<{ items: GalleryItem[]; folders: string[]; complete: boolean }>;
  recordPosition(docId: string, pos: Position): void;
  boot(): Promise<{ signedIn: boolean }>;
}

export function createPersistence(hooks: PersistenceHooks): Persistence {   // resolveConflict 必传（冲突必 surface）
  const { provider, auth } = createOneDriveProvider({
    clientId: cfg.CLIENT_ID, msalUrl: cfg.MSAL_URL, scopes: cfg.SCOPES, authority: cfg.AUTHORITY,
  });
  // ui bundle（Model B）：busy = **全屏遮罩**；冲突/错误必 surface（真 sheet / toast，不静默不吞 console）。
  //   加密密码不走 ui（非交互 crypt.getPassword）；JRP 不加密、不注入 crypt → 无密码 UI。
  const ui: StoreUI = {
    busy: async (label, fn) => { hooks.onBusy?.(label); try { return await fn(); } finally { hooks.onBusy?.(null); } },
    reportError: (e) => { console.warn("[jrp][store]", e); hooks.onError?.("同步出错(已保留本地，稍后自动重试)"); },
    resolveConflict: hooks.resolveConflict,   // 必传：真冲突 sheet（app-state resolveConflictUi）
    offlineEscape: hooks.offlineEscape,        // undefined → store 退回纯 isOnline 守卫（无逃生闸）
  };
  // validateAdopt（必传，禁 placeholder）：采纳云端字节覆盖本地前验真 PDF（%PDF- magic）。
  //   挡机场/captive-portal 200-HTML、损坏副本覆盖好缓存（论文丢了也麻烦）。库对加密透明 → 拿到的是
  //   解密后明文（JRP 不加密=PDF 原文）。非 PDF 一律拒（绝不拿垃圾盖好本地；宁可不同步也不毁缓存）。
  const validateAdopt = async (plain: Blob): Promise<boolean> => {
    const h = new Uint8Array(await plain.slice(0, 5).arrayBuffer());
    return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46 && h[4] === 0x2d;   // "%PDF-"
  };
  const store = createStore({ provider, ui, validateAdopt });   // local=idb、kv=localStorage 库内默认装配

  // 重连重放离线删队列（base-etag 守卫：被别处改过/同名新文件 → edit-wins 不删，绝不盲删别设备新文件）。
  //   单 app 单例，监听不卸；listGallery 也会 drain 一次（覆盖「离线删→重连后开图库」路径）。
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
      void store.drainDeleteQueue().catch((e) => console.warn("[jrp] drainDeleteQueue", e));
      void store.drainFolders().catch((e) => console.warn("[jrp] drainFolders", e));   // 回线补建离线创建的空夹
    });
  }

  const catalog = createCatalog({ collection: store.collection<CatalogPayload>(cfg.CATALOG_NAME, { manual: true }) });
  const content = createContent(store);
  const settings = createSettings(store.localSettings);

  // 上次成功推云的每篇位置 → trivial 基线。
  let lastPushed = new Map<string, Position>();
  function snapshotPositions(): Map<string, Position> {
    const m = new Map<string, Position>();
    for (const d of catalog.list()) if (d.position) m.set(d.id, d.position);
    return m;
  }
  function isTrivial(prev: Position | undefined, next: Position): boolean {
    return !!prev && prev.pageIndex === next.pageIndex
      && Math.abs(prev.yFraction - next.yFraction) < cfg.TRIVIAL_Y_DELTA;
  }

  const save = createValuableSave({
    debounceMs: cfg.POSITION_DEBOUNCE_MS,
    ceilingMs: cfg.POSITION_CEILING_MS,
    commit: async () => {
      hooks.onSaveState?.("saving");
      try { await catalog.commitNow(); lastPushed = snapshotPositions(); hooks.onSaveState?.("saved"); console.info("[jrp] 位置已落盘 catalog.json"); }
      catch (e) { hooks.onSaveState?.("dirty"); console.warn("[jrp] 位置落盘失败", e); throw e; }
    },
    // 卸载兜底：先同步意图落本地缓存（IDB，可靠的那半，离线/强杀续读靠它），再 best-effort 推云。
    keepalive: () => { void catalog.flushLocal(); void catalog.commitNow(); },
  });

  return {
    auth, catalog, content, settings, save,
    async listGallery() {
      const prefix = cfg.PAPERS_FOLDER + "/";
      // 统一列举 ctx（store 吃 {signedIn, online} 返解析好的 syncState）。离线/登出 → 纯本地，绝不返空。
      const ctx = { signedIn: auth.isSignedIn(), online: typeof navigator !== "undefined" ? navigator.onLine !== false : true };
      try {
        // cloud-gone 收敛（安全子集 #43）：clean 孤儿→local-only（不删不 trash）。失败/离线/partial 自 no-op。
        await store.reconcile().catch((e) => console.warn("[jrp] reconcile", e));
        void store.drainDeleteQueue().catch((e) => console.warn("[jrp] drainDeleteQueue", e));   // 重放离线删（开图库/刷新时机，覆盖重连）
        void store.drainFolders().catch((e) => console.warn("[jrp] drainFolders", e));           // 回线补建离线创建的空夹

        const tree = await content.listTree(ctx);
        const files = tree.files
          .filter((f) => f.path.startsWith(prefix) && /\.pdf$/i.test(f.path))
          .map((f) => ({ name: f.path.slice(prefix.length), path: f.path, syncState: f.syncState }));
        const folders = tree.folders
          .filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).filter((p) => p.length > 0);
        const catMap = new Map<string, CatalogMeta>();
        for (const d of catalog.list()) catMap.set(d.fileName, { docId: d.id, name: d.fileName, title: d.title });
        const items = buildItems(files, catMap);   // keptOffline/badge 由 item.syncState 派生（store 单一来源，app 不再单列本地半截）
        return { items, folders, complete: tree.complete };
      } catch {
        return { items: [], folders: [], complete: false };
      }
    },
    recordPosition(docId, pos): void {
      catalog.setPosition(docId, pos);
      if (isTrivial(lastPushed.get(docId), pos)) save.markTrivial();
      else { save.mark(); hooks.onSaveState?.("dirty"); }
    },
    async boot(): Promise<{ signedIn: boolean }> {
      const st = await auth.initAuth();
      if (st.signedIn) { await catalog.init(); lastPushed = snapshotPositions(); }
      return { signedIn: !!st.signedIn };
    },
  };
}
