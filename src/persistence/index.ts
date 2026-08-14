// persistence host —— **唯一** import @internal/store（值级）并构造 store/catalog/content 的地方。
// 红线②钉死在此一处：app 其它处碰 localStorage/indexedDB/graph/store 内部 = 违规（build.sh lint 挡；
//   类型 import type { ... } from "@internal/store" 不在此限）。
// 引擎已分仓（cutover 2026-08-14）：@internal/store 0.1.0（../20260813 internal-store 仓，file:vendor-pkgs tgz）。
//   改引擎去库仓（红线区，改前 escalate）；升级 = 仓根跑 pull-package.sh。缺接口 escalate 改库 API，绝不在 app 端绕。
// 全走 createStore 唯一入口；catalog=阅读态(collection)、content=PDF(file/files)、settings=local-only collection KV。
// 列举 = 网盘模型：**唯一列举面 = store.files.watchFolder（订阅当前夹）**，app 包成 watchGallery；全树列举已死。

import { createStore, createOneDriveProvider } from "@internal/store";
import type { Store, StoreUI, FolderSnapshot, Collection } from "@internal/store";
import { createCatalog } from "./catalog.ts";
import type { Catalog, CatalogPayload } from "./catalog.ts";
import { createContent } from "./content.ts";
import type { Content, BinEntry } from "./content.ts";
import { buildItems } from "../gallery-model.ts";
import type { GalleryItem, CatalogMeta } from "../gallery-model.ts";
import { createValuableSave } from "../domain/valuable-save.ts";
import type { ValuableSave } from "../domain/valuable-save.ts";
import type { Position } from "../domain/viewer-geometry.ts";
import { parseV1Catalog, V1_MIGRATED_MARKER } from "./catalog-v1-migration.ts";
import * as cfg from "../config.ts";

export type { BinEntry } from "./content.ts";

// ── 设备本地设置(zoom/spread/theme)，over local-only collection(不同步)。app 调这个，不碰 localStorage ──
// boot 门：**先 await init() 再读写**（init 前 get 返 null、set 会抛——库故意的，别绕）。
export interface Settings {
  init(): Promise<void>;
  get(key: string): string | null;
  set(key: string, val: string): void;
  getNum(key: string, dflt: number): number;
  setNum(key: string, val: number): void;
}
function createSettings(coll: Collection): Settings {
  return {
    init: () => coll.init(),
    get: (k) => { const v = coll.getItem<unknown>(k); return typeof v === "string" ? v : null; },
    set: (k, v) => coll.setItem(k, v),
    getNum: (k, d) => { const v = coll.getItem<unknown>(k); return typeof v === "number" && Number.isFinite(v) ? v : d; },
    setNum: (k, v) => coll.setItem(k, v),
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
  confirmReplay: NonNullable<StoreUI["confirmReplay"]>;        // ADR-0018 'ask'：回线问一次「N 篇离线上传现在同步？」（必传）
  onReplayStatus: NonNullable<StoreUI["onReplayStatus"]>;      // 补推进度/冲突 surface（必传，非 silent）
}

/** watchGallery 每帧：当前夹直属 PDF（已并 catalog 元数据）+ immediate 子夹名（相对 papers 根全路径）。 */
export interface GallerySnap { files: GalleryItem[]; folders: string[]; complete: boolean; }

export interface Persistence {
  auth: Auth;
  catalog: Catalog;     // 资产：阅读态(collection)
  content: Content;     // PDF 字节(只读镜像 + 离线缓存)
  settings: Settings;   // 设备本地（先 await settings.init()）
  save: ValuableSave;   // 位置节流，绑 catalog.commitNow
  /** 订阅一个文件夹（相对 papers 根，"" = 根）：立即本地帧、云端到了同一 cb 再闪；本夹任何写即时重推。
   *  返回退订。刷新 = 退订再订（触发新一次云端帧）。 */
  watchGallery(folder: string, cb: (snap: GallerySnap) => void): () => void;
  recordPosition(docId: string, pos: Position): void;
  boot(): Promise<{ signedIn: boolean }>;
  /** 当前打开的论文（approot 全路径）：store cloud-gone 去抖绝不碰它。打开时设，无 = null。 */
  setActivePaper(path: string | null): void;
  syncOfflineUploads(): Promise<void>;   // 统一离线队列重放：建夹→补推上传(ADR-0018 ask)→删文件→删夹。app 在 online/onAuthChanged 调
  /** 旧引擎 /catalog.json → 新 collection 的一次性迁移兜底（marker 守卫，幂等；登录后调）。
   *  主路径是 collection getInitData 种子；这里只补"首次 init 时离线没读到旧文件"的场景。 */
  migrateLegacyCatalog(): Promise<void>;
}

export function createPersistence(hooks: PersistenceHooks): Persistence {   // resolveConflict 必传（冲突必 surface）
  const { provider, auth } = createOneDriveProvider({
    clientId: cfg.CLIENT_ID, msalUrl: cfg.MSAL_URL, scopes: cfg.SCOPES, authority: cfg.AUTHORITY,
  });
  // ui bundle（Model B）：busy = **全屏遮罩**；冲突/错误必 surface（真 sheet / toast，不静默不吞 console）。
  //   加密密码不走 ui（非交互 crypt.getPassword）；JRP 不加密、不注入 crypto/crypt → 加密 dormant。
  const ui: StoreUI = {
    busy: async (label, fn) => { hooks.onBusy?.(label); try { return await fn(); } finally { hooks.onBusy?.(null); } },
    reportError: (e, level) => {
      console.warn("[jrp][store]", level ?? "error", e);
      if (level !== "log" && level !== "info") hooks.onError?.("同步出错(已保留本地，稍后自动重试)");
    },
    resolveConflict: hooks.resolveConflict,   // 必传：真冲突 sheet（app-state resolveConflictUi）
    offlineEscape: hooks.offlineEscape,        // undefined → store 退回纯 isOnline 守卫（无逃生闸）
    confirmReplay: hooks.confirmReplay,        // ADR-0018 'ask'：回线补推前问一次
    onReplayStatus: hooks.onReplayStatus,      // 补推进度/冲突 surface
  };
  // validateAdopt（必传，禁 placeholder）：采纳云端字节覆盖本地前验真 PDF（%PDF- magic）。
  //   挡机场/captive-portal 200-HTML、损坏副本覆盖好缓存（论文丢了也麻烦）。JRP 不加密=PDF 原文。
  //   非 PDF 一律拒（绝不拿垃圾盖好本地；宁可不同步也不毁缓存）。
  const validateAdopt = async (plain: Blob): Promise<boolean> => {
    const h = new Uint8Array(await plain.slice(0, 5).arrayBuffer());
    return h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46 && h[4] === 0x2d;   // "%PDF-"
  };
  let _activePaper: string | null = null;
  const store: Store = createStore({
    provider, ui, validateAdopt,
    appId: cfg.APP_ID,          // 本 origin 内唯一命名空间：IDB 库 justreadpapers.defaultStore + 同前缀 localStorage 键，与兄弟 PWA 隔离
    signedIn: () => auth.isSignedIn(),          // 连接态 store 自持（网盘模型）：watchFolder/云列举不再由 app 每次传 ctx
    autoCacheOpenedFile: true,                  // open 即缓存（离线可续读——旧版语义保留）
    offlineUploadReplay: "ask",                 // ADR-0018：离线新上传回线 ask 补推
    activeFileName: () => _activePaper,         // 正在读的论文：cloud-gone 去抖 trash 绝不碰它
  });   // local=idb、kv=localStorage 库内默认装配；migration 深模块 createStore 内部自跑

  // ── 旧引擎 catalog（approot /catalog.json，v1 信封）→ 新 collection 种子 ──────────────────────
  // 读旧文件走库的 provider 面（一次性只读，不建谱系不进缓存；不裸碰 Graph）。旧文件永不改写/删除。
  //   离线/未登录 → throw，由调用方当「这次没成」（getInitData 返 []，migrateLegacyCatalog 兜底重试）。
  async function readOldCatalogText(): Promise<string | null> {
    const item = await provider.getItemByPath(cfg.OLD_CATALOG_PATH);
    if (!item) return null;   // 旧文件不存在（全新用户）→ 没有可迁的
    return await (await provider.download(item.id)).text();
  }
  // getInitData（主路径）：**IDB 无此 collection（新库）时** init 调一次。种子 uat=1 → 任何真实编辑必胜。
  //   读到（含"旧文件不存在"）→ 种子 + marker；读失败（离线）→ [] 不带 marker，migrateLegacyCatalog 兜底。
  async function catalogSeed(): Promise<{ id: string; value: unknown }[]> {
    let txt: string | null;
    try { txt = await readOldCatalogText(); } catch { return []; }
    const seeds = (txt != null ? parseV1Catalog(txt) : null) ?? [];
    return [...seeds, { id: V1_MIGRATED_MARKER, value: { at: Date.now() } }];
  }
  const catalogColl = store.collection(cfg.CATALOG_NAME, { manual: true, getInitData: catalogSeed });
  const catalog = createCatalog({ collection: catalogColl });
  // 兜底（marker 守卫，幂等）：首次 init 时离线没种上 → 登录后补。只填 catalog 里**完全不存在**的 id
  //   （绝不覆盖任何已有条目；uat=now 只落在新 id 上，安全）。成功（含"没有可迁的"）才盖 marker。
  let _migrating = false;
  async function migrateLegacyCatalog(): Promise<void> {
    if (_migrating) return;
    _migrating = true;
    try {
      await catalogColl.init();
      if (catalogColl.getItem(V1_MIGRATED_MARKER) !== undefined) return;
      let txt: string | null;
      try { txt = await readOldCatalogText(); } catch { return; }   // 还是没网/没登录 → 下次再试
      const seeds = (txt != null ? parseV1Catalog(txt) : null) ?? [];
      let added = 0;
      for (const s of seeds) if (catalogColl.getItem(s.id) === undefined) { catalogColl.setItem(s.id, s.value); added++; }
      catalogColl.setItem(V1_MIGRATED_MARKER, { at: Date.now() });
      if (added) console.info(`[jrp] 旧 catalog 迁移兜底：补 ${added} 条阅读位置`);
      void catalogColl.reconcileWithRemote();   // manual collection：显式推
    } finally { _migrating = false; }
  }

  const content = createContent(store);
  const settings = createSettings(store.collection(cfg.SETTINGS_NAME, { local: true }));

  // 统一离线队列重放（建夹→补推上传→删文件→删夹，顺序在库内）。online 事件 + 登录成功触发；
  //   in-flight 守卫防 online 与 auth-success 同时 double-ask（ask 模式对空队列内部早退，不弹）。
  let _replayInFlight = false;
  async function syncOfflineUploads(): Promise<void> {
    if (_replayInFlight) return;
    _replayInFlight = true;
    try { await store.files.drainOfflineQueue(); } catch (e) { console.warn("[jrp] drainOfflineQueue", e); } finally { _replayInFlight = false; }
  }
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { void syncOfflineUploads(); });
  }

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
      try { await catalog.commitNow(); lastPushed = snapshotPositions(); hooks.onSaveState?.("saved"); console.info("[jrp] 位置已落盘 catalog"); }
      catch (e) { hooks.onSaveState?.("dirty"); console.warn("[jrp] 位置落盘失败", e); throw e; }
    },
    // 卸载兜底：先同步意图落本地缓存（IDB，可靠的那半，离线/强杀续读靠它），再 best-effort 推云。
    keepalive: () => { void catalog.flushLocal(); void catalog.commitNow().catch(() => { /* 离线等，脏标记在，回线自愈 */ }); },
  });

  return {
    auth, catalog, content, settings, save, syncOfflineUploads, migrateLegacyCatalog,
    setActivePaper(path): void { _activePaper = path; },
    watchGallery(folder, cb): () => void {
      const prefix = cfg.PAPERS_FOLDER + "/";
      const full = folder ? `${cfg.PAPERS_FOLDER}/${folder}` : cfg.PAPERS_FOLDER;
      let last: FolderSnapshot | null = null;
      const emit = (): void => {
        if (!last) return;
        const files = last.items
          .filter((it) => /\.pdf$/i.test(it.path))
          .map((it) => ({ name: it.path.slice(prefix.length), path: it.path, syncState: it.syncState }));
        const catMap = new Map<string, CatalogMeta>();
        for (const d of catalog.list()) catMap.set(d.fileName, { docId: d.id, name: d.fileName, title: d.title });
        cb({
          files: buildItems(files, catMap),
          folders: last.folders.map((f) => f.slice(prefix.length)).filter(Boolean),
          complete: last.complete,
        });
      };
      const unStore = store.files.watchFolder(full, (snap) => { last = snap; emit(); });
      const unCat = catalog.subscribe(() => emit());   // 标题/rekey 等 catalog 变更 → 重推同一帧
      return () => { unStore(); unCat(); };
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

// 类型转口（app 侧要 store 类型经此拿，别直连库）；SyncState 给 gallery-model 的 badge 派生。
export type { SyncState } from "@internal/store";
