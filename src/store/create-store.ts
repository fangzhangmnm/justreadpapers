// ⚠ 这是库的唯一入口。接库必读同目录 STORE.md + CONTEXT.md。
//
// createStore —— 薄组合根：provider → 库内造 cloud/local/kv/脊椎 → 装配 10 个深模块 →
//   暴露 STORE.md 的面（file / collection / localSettings / syncedSettings / list）。
//   红线全在各深模块内 enforce；这里只接线 + 把 ui bundle 映射到各 flow 的回调。
import { toU8, createSubstrate } from "./substrate.ts";
import type { Bytes } from "./substrate.ts";
import { createLocalHead } from "./local-head.ts";
import { createSeal } from "./seal.ts";
import { looksEncryptedContainer, packContainer, unpackContainer } from "./crypto-container.ts";
import { createSafeResolve, type ResolveChoice } from "./safe-resolve.ts";
import { createPush } from "./push.ts";
import { createFreshness } from "./freshness.ts";
import { createDelete } from "./delete.ts";
import { createIdentity } from "./identity.ts";
import { createTrash } from "./trash.ts";
import { createOffload } from "./offload.ts";
import { createReconcile } from "./reconcile.ts";
import { createCollection, type Collection } from "./collection.ts";
import { createLocalSettings, createSyncedSettings, type LocalSettings, type SyncedSettings, type SettingItem } from "./settings.ts";
import type { CloudProvider, CloudSync, Kv, LocalCache } from "./types.ts";
import { createCloudSync } from "./cloud-sync.ts";
import { createLocalCache } from "./local-cache.ts";

// ── ui bundle（Model B，STORE.md §7）：store 在决策点回调进来 + await ──
export interface StoreUI {
  busy: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  askPassword?: (ctx: { name: string; reason: "open" | "save" | "unlock" }) => Promise<string | null>;
  resolveConflict?: (ctx: { name: string; local: Blob | null; cloud: Blob | null }) => Promise<ResolveChoice>;
  reportError?: (err: unknown) => void;
}

export interface StoreConfig {
  provider: CloudProvider;
  ui: StoreUI;
  syncedSettingsFileName?: string;
  encryptionSaltFileName?: string;   // ⚠TODO：库统一密钥（需 sevenZip 注入）；本版未实现
  // ── 内部/测试 seam（prod 默认 idb + localStorage）──
  kv?: Kv;
  local?: LocalCache;
  getPassword?: (name: string) => string | null;   // 非交互密码源（加密用；默认 null=不解锁）
  validateAdopt?: (blob: Blob) => boolean | Promise<boolean>;
  isOnline?: () => boolean;                          // offload 离线守卫（默认 navigator.onLine）
  keepOnOpen?: boolean;                              // 消费模式：true=开即自动留本地(读者/编辑器)；false=过路/流式(开整份拉云不落本地；range 按需取片是 ⚠TODO 优化)
}

// ── 文件对象（STORE.md §2）。isZip 在编译期分出两种：RawFile 无 setPreview ──
export interface RawFile {
  save(bytes: Bytes | Blob): Promise<void>;
  open(): Promise<Blob | null>;
  rename(newName: string): Promise<void>;
  delete(): Promise<void>;
  isDirty(): boolean;
  // ── 离线副本（keepOffline/offload；无 LRU、无 pin flag：有本地副本 = kept offline）──
  isKeptOffline(): Promise<boolean>;            // 本地有副本？（= 已留作离线）
  keepOffline(): Promise<void>;                 // 留一份离线副本（未缓存则 acquire）。注：open 已含下载子过程，故名 keepOffline 非 download
  offload(): Promise<void>;                     // 合法(clean∧在线∧曾synced∧云端有完整)→hardDelete；非法(唯一副本/不可重取)→抛 OffloadIllegalError（banner）
}
export interface ZipFile extends RawFile {
  setPreview(previewBlob: Blob): Promise<void>;
  getPreview(): Promise<Blob | null>;
}

function localStorageKv(): Kv {
  const ls = (globalThis as { localStorage?: Storage }).localStorage;
  if (!ls) throw new Error("createStore: 无 localStorage，请注入 kv");
  return { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v), remove: (k) => ls.removeItem(k) };
}

export function createStore(config: StoreConfig) {
  const { provider, ui, syncedSettingsFileName, kv = localStorageKv(), getPassword = () => null, validateAdopt, keepOnOpen = true } = config;
  const local = config.local ?? createLocalCache();   // prod=idb；测试注入 mock-local
  const isOnline = config.isOnline ?? ((): boolean => (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false);

  // ── 脊椎 + 低层 ──
  const cloud: CloudSync = createCloudSync({ provider, kv, fileName: (n: string) => n });
  const sub = createSubstrate();
  const head = createLocalHead({ kv, getCloudEtag: (n: string) => cloud.getETag(n) });
  const offloadMod = createOffload({ cloud, local, head, isOnline });
  const reconcileMod = createReconcile({ cloud, local, head, isOnline });

  // ── seal：加密透明（crypto-container 默认；getPassword 非交互）。JRP 不加密 → getPassword 恒 null=透传 ──
  const seal = createSeal({
    looksContainer: (b) => looksEncryptedContainer(b),
    pack: (o) => packContainer({ dataBytes: o.dataBytes, fileName: o.fileName, ext: o.ext, peek: o.peek, password: o.password }),
    unpack: (blob, pw) => unpackContainer(blob, pw),
    getPassword,
    getPrev: (n) => local.get(n),
  });

  // ── flow 深模块 ──
  const safeResolve = createSafeResolve({
    cloud, local, head,
    localDirty: () => sub.edits.localDirty(),
    validateAdopt,
    unseal: async (n, blob) => (await seal.unsealForRead(n, blob)) ?? blob,
    looksEncrypted: (b) => looksEncryptedContainer(b),
  });
  const pushMod = createPush({ cloud, head, seal, safeResolve, serialize: sub.serialize, editVersion: () => sub.edits.version(), busy: ui.busy });
  const fresh = createFreshness({ cloud, head, safeResolve, busy: ui.busy });
  const del = createDelete({ cloud, local, head, kv, busy: ui.busy });
  const identity = createIdentity({ cloud, local, head, doPush: pushMod.doPush, serialize: sub.serialize, serialize2: sub.serialize2, seal, busy: ui.busy });
  const trashMod = createTrash({ cloud, local, head, busy: ui.busy });

  // ── 单飞守卫（port 自 WebPaint store.ts，2026-06-21 起红线）：用户态写流同一时刻只一个，
  //   并发的第二个**直接拒**（throw STORE_BUSY），调用方 catch→报状态。与 ui.busy 正交、更硬
  //   （busy 只是 UI 防误点、无 UI 时失效；这道库内自带，无头复用也挡得住）。同名字节竞争仍由
  //   substrate.serialize2 兜底，这道在其上加「全局同一时刻只一个用户态写」的更强语义（user 明确要）。
  //   安全前提：被守的流互不内部调用——saveAs/rename 内部走 doPush（非被守流）；del/restore/purge/
  //   emptyTrash 直调 adapter；newFolder/deleteFolder 直调 cloud.*。新增被守流前先核这条，否则嵌套自锁。
  let _userWriteInFlight: string | null = null;
  function singleFlight<A extends unknown[], R>(label: string, fn: (...a: A) => Promise<R>): (...a: A) => Promise<R> {
    return (...a: A): Promise<R> => {
      if (_userWriteInFlight) {
        const e = new Error(`有另一项操作进行中（${_userWriteInFlight}），请等它完成再试`) as Error & { code?: string };
        e.code = "STORE_BUSY";
        return Promise.reject(e);
      }
      _userWriteInFlight = label;
      return Promise.resolve().then(() => fn(...a)).finally(() => { _userWriteInFlight = null; });
    };
  }
  const delSF = singleFlight("删除", (n: string) => del.del(n));
  const renameSF = singleFlight("重命名", (n: string, nn: string) => identity.rename(n, nn));

  // ── ui 映射：冲突回调把 local/cloud 字节取来喂 ui.resolveConflict（默认 cancel=留 dirty）──
  const onConflict = async ({ name }: { name: string }): Promise<ResolveChoice> => {
    if (!ui.resolveConflict) return "cancel";
    const [localBlob, cloudPull] = await Promise.all([local.get(name), cloud.pull(name).catch(() => null)]);
    return ui.resolveConflict({ name, local: localBlob, cloud: cloudPull?.blob ?? null });
  };

  // ── file 工厂（重载：isZip 编译期分流）──
  function makeRaw(name: string): RawFile {
    return {
      async save(bytes) {
        head.recordEdit(name);
        const plain = await toU8(bytes);
        const sealed = await seal.sealForWrite(name, plain);
        await local.save(name, sealed);
        try { await pushMod.push(name, { encode: () => plain, onConflict }); }
        catch (e) { ui.reportError?.(e); }
      },
      async open() {
        if (await local.exists(name)) {                          // 有本地副本（kept）→ freshness 检查后读本地
          await fresh.open(name).catch((e) => ui.reportError?.(e));
        } else if (keepOnOpen) {                                  // 持有模式（读者/编辑器）→ 拉云落本地（白得离线缓存）
          await identity.acquire(name, { localName: name });
        } else {                                                 // 过路模式（keepOnOpen:false，流式消费）→ 整份拉云、**不落本地**，直接返字节
          const pulled = await cloud.pull(name).catch((e) => { ui.reportError?.(e); return null; });
          return pulled ? await seal.unsealForRead(name, pulled.blob) : null;   // range/streaming（按需取片）是 ⚠TODO 优化
        }
        const blob = await local.get(name);
        if (!blob) return null;
        const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
        return await seal.unsealForRead(name, asBlob);
      },
      async rename(newName) { await renameSF(name, newName); },
      async delete() { await delSF(name); },
      isDirty() { return head.isDirty(name); },
      isKeptOffline() { return local.exists(name); },   // 有本地副本 = 已留作离线（无 LRU、无独立 pin flag）
      async keepOffline() {   // 确保本地有副本（未缓存则 acquire；离线/失败 best-effort）
        if (!(await local.exists(name))) { try { await identity.acquire(name, { localName: name }); } catch (e) { ui.reportError?.(e); } }
      },
      offload() { return offloadMod.offload(name); },
    };
  }

  function file(name: string, opts: { isZip: true }): ZipFile;
  function file(name: string, opts: { isZip: false }): RawFile;
  function file(name: string, opts: { isZip: boolean }): RawFile | ZipFile;
  function file(name: string, opts: { isZip: boolean }): RawFile | ZipFile {
    const raw = makeRaw(name);
    if (!opts.isZip) return raw;
    // ZipFile：previewBlob 作 zip entry（⚠TODO：需 zip 注入；本版 setPreview/getPreview 暂未实现）。
    const notYet = () => { throw new Error("ZipFile.preview ⚠TODO：zip 预览管线尚未实现（STORE.md §2，待 zip 接入）"); };
    return Object.assign(raw, { setPreview: async (_b: Blob) => notYet(), getPreview: async () => notYet() }) as ZipFile;
  }

  // ── collection / settings ──
  function collection<T extends object>(name: string, opts: { manual?: boolean } = {}): Collection<T> {
    return createCollection<T>({ cloud, name, local, manual: opts.manual });   // local=IDB 透明缓存（离线可读/强杀存活）
  }
  const localSettings: LocalSettings = createLocalSettings(kv);
  const syncedSettings: SyncedSettings | undefined = syncedSettingsFileName
    ? createSyncedSettings(createCollection<SettingItem>({ cloud, name: syncedSettingsFileName, local }))
    : undefined;

  return {
    file,
    collection,
    localSettings,
    syncedSettings,
    list: () => cloud.list(),
    listAll: () => cloud.listAll(),
    // 文件夹操作（gallery folder-tree）：空文件夹增删走深模块（删除"必须空"在 cloud 内强制）。
    ensureFolder: (path: string) => cloud.ensureFolder(path),
    newFolder: singleFlight("新建文件夹", (path: string) => ui.busy("新建文件夹…", () => cloud.ensureFolder(path))),
    deleteFolder: singleFlight("删除文件夹", (path: string) => ui.busy("删除文件夹…", () => cloud.removeFolder(path))),
    // 后台 / 事件流（app 在 focus/visibility/online 调）+ 离线删重放 + cloud-gone 收敛（安全子集 #43）。
    refresh: (name: string, opts?: Parameters<typeof fresh.refresh>[1]) => fresh.refresh(name, opts),
    drainDeleteQueue: () => del.drainDeleteQueue(),
    reconcile: (opts?: { activeName?: string }) => reconcileMod.reconcile(opts),   // gallery list-fetch 时调：clean 孤儿→local-only（不删不 trash）

    listTrash: () => cloud.listTrash(),   // 回收站列表（gallery trash 视图）
    listBackup: () => cloud.listBackup(),   // 备份箱列表（恢复箱视图；webxiaoheiwu 用）
    localKeys: () => local.appKeys(),     // 已缓存的应用文件名集合（gallery 批量判 cached）
    restore: singleFlight("恢复", trashMod.restore),
    purge: singleFlight("彻底删除", trashMod.purge),
    emptyTrash: singleFlight("清空回收站", trashMod.emptyTrash),
    saveAs: singleFlight("另存为", identity.saveAs),
    // 编辑游标（app 标脏入口经 file.save；此处暴露给需要的高级用法）。
    _internal: { head, cloud, sub },
  };
}

export type Store = ReturnType<typeof createStore>;
