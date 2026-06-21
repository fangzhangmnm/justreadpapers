// persistence host —— **唯一** import store/* 并构造 provider/cloud/catalog 的地方。
// 红线②钉死在此一处:grep src/(除本目录 + store/)出现 localStorage/indexedDB/graph/msal = 违规。
// 对 app 暴露四面 + boot/recordPosition。

import { createOneDriveProvider } from "../store/providers/index.ts";
import { createCloudSync } from "../store/cloud-sync.ts";
import { createCatalog } from "./catalog.ts";
import type { Catalog } from "./catalog.ts";
import { createContent } from "./content.ts";
import type { Content } from "./content.ts";
import { createValuableSave } from "../domain/valuable-save.ts";
import type { ValuableSave } from "../domain/valuable-save.ts";
import type { Position } from "../domain/viewer-geometry.ts";
import type { CloudItem, Kv } from "../store/types.ts";
import * as cfg from "../config.ts";

// ── 唯一碰 localStorage 的地方(红线②) ──
function localStorageKv(): Kv {
  return {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 满/隐私模式 */ } },
    remove: (k) => { try { localStorage.removeItem(k); } catch { /* */ } },
  };
}

// ── 设备本地设置(zoom/spread/theme)。app 调这个,不碰 localStorage ──
export interface Settings {
  get(key: string): string | null;
  set(key: string, val: string): void;
  getNum(key: string, dflt: number): number;
  setNum(key: string, val: number): void;
}
function createSettings(kv: Kv): Settings {
  const K = (k: string): string => `jrp.set:${k}`;
  return {
    get: (k) => kv.get(K(k)),
    set: (k, v) => kv.set(K(k), v),
    getNum: (k, d) => { const v = kv.get(K(k)); const n = v == null ? NaN : Number(v); return Number.isFinite(n) ? n : d; },
    setNum: (k, v) => kv.set(K(k), String(v)),
  };
}

export type Auth = ReturnType<typeof createOneDriveProvider>["auth"];

export interface Persistence {
  auth: Auth;
  catalog: Catalog;     // 资产:阅读态(folder-store)
  content: Content;     // PDF 字节(只读镜像)
  settings: Settings;   // 设备本地
  save: ValuableSave;   // 位置节流,绑 catalog.commitNow
  /** 滚动汇报位置:trivial(同页+|Δy|<阈值)只标脏;否则排防抖。catalog 内存即时更新供 UI 读。 */
  recordPosition(docId: string, pos: Position): void;
  /** 启动:initAuth +(若登录)catalog.init。返回即时 auth 状态(后台 silent 探测经 auth.onAuthChanged)。 */
  boot(): Promise<{ signedIn: boolean }>;
}

export function createPersistence(): Persistence {
  const kv = localStorageKv();
  const { provider, auth } = createOneDriveProvider({
    clientId: cfg.CLIENT_ID, msalUrl: cfg.MSAL_URL, scopes: cfg.SCOPES, authority: cfg.AUTHORITY,
  });
  const cloud = createCloudSync({
    provider, kv,
    fileName: (n) => n,                                              // name = approot 相对路径
    match: (it: CloudItem) => !it.isFolder && /\.pdf$/i.test(it.name),   // 只 PDF 进 gallery 列表(catalog.json 走 pull 不受影响)
    toName: (n) => n,
  });
  const catalog = createCatalog({ cloud, name: cfg.CATALOG_NAME, isOnline: () => navigator.onLine });
  const content = createContent(cloud);
  const settings = createSettings(kv);

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
    commit: async () => { await catalog.commitNow(); lastPushed = snapshotPositions(); },
    keepalive: () => { void catalog.commitNow(); },                 // unload:best-effort fire-forget
  });

  return {
    auth, catalog, content, settings, save,
    recordPosition(docId, pos): void {
      catalog.setPosition(docId, pos);                              // 内存即时(UI 读)
      if (isTrivial(lastPushed.get(docId), pos)) save.markTrivial();   // fidget:标脏不调度
      else save.mark();
    },
    async boot(): Promise<{ signedIn: boolean }> {
      const st = await auth.initAuth();
      if (st.signedIn) { await catalog.init(); lastPushed = snapshotPositions(); }
      return { signedIn: !!st.signedIn };
    },
  };
}
