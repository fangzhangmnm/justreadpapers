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

export function createPersistence(hooks: PersistenceHooks = {}): Persistence {
  const { provider, auth } = createOneDriveProvider({
    clientId: cfg.CLIENT_ID, msalUrl: cfg.MSAL_URL, scopes: cfg.SCOPES, authority: cfg.AUTHORITY,
  });
  // ui bundle（Model B）：JRP 是 zen reader，busy 暂用轻量透传（无阻塞遮罩），冲突默认 cancel，错误上 console。
  const ui: StoreUI = {
    busy: (_label, fn) => fn(),
    reportError: (e) => { console.warn("[jrp][store]", e); hooks.onError?.("同步出错(已保留本地，稍后自动重试)"); },
  };
  const store = createStore({ provider, ui });   // local=idb、kv=localStorage 库内默认装配

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
      try {
        const tree = await content.listTree();
        const files = tree.files
          .filter((f) => f.path.startsWith(prefix) && /\.pdf$/i.test(f.path))
          .map((f) => ({ name: f.path.slice(prefix.length), path: f.path }));
        const folders = tree.folders
          .filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length)).filter((p) => p.length > 0);
        const catMap = new Map<string, CatalogMeta>();
        for (const d of catalog.list()) catMap.set(d.fileName, { docId: d.id, name: d.fileName, title: d.title });
        return { items: buildItems(files, catMap), folders, complete: tree.complete };
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
