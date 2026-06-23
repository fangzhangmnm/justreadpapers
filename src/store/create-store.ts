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
}

// ── 文件对象（STORE.md §2）。isZip 在编译期分出两种：RawFile 无 setPreview ──
export interface RawFile {
  save(bytes: Bytes | Blob): Promise<void>;
  open(): Promise<Blob | null>;
  rename(newName: string): Promise<void>;
  delete(): Promise<void>;
  isDirty(): boolean;
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
  const { provider, ui, syncedSettingsFileName, kv = localStorageKv(), getPassword = () => null, validateAdopt } = config;
  const local = config.local ?? createLocalCache();   // prod=idb；测试注入 mock-local

  // ── 脊椎 + 低层 ──
  const cloud: CloudSync = createCloudSync({ provider, kv, fileName: (n: string) => n });
  const sub = createSubstrate();
  const head = createLocalHead({ kv, getCloudEtag: (n: string) => cloud.getETag(n) });

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
        if (!(await local.exists(name))) await identity.acquire(name, { localName: name });
        else await fresh.open(name).catch((e) => ui.reportError?.(e));
        const blob = await local.get(name);
        if (!blob) return null;
        const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
        return await seal.unsealForRead(name, asBlob);
      },
      async rename(newName) { await identity.rename(name, newName); },
      async delete() { await del.del(name); },
      isDirty() { return head.isDirty(name); },
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
    newFolder: (path: string) => ui.busy("新建文件夹…", () => cloud.ensureFolder(path)),
    deleteFolder: (path: string) => ui.busy("删除文件夹…", () => cloud.removeFolder(path)),
    // 后台 / 事件流（app 在 focus/visibility/online 调）+ 离线删重放。
    refresh: (name: string, opts?: Parameters<typeof fresh.refresh>[1]) => fresh.refresh(name, opts),
    drainDeleteQueue: () => del.drainDeleteQueue(),
    listTrash: () => cloud.listTrash(),   // 回收站列表（gallery trash 视图）
    restore: trashMod.restore,
    purge: trashMod.purge,
    emptyTrash: trashMod.emptyTrash,
    saveAs: identity.saveAs,
    // 编辑游标（app 标脏入口经 file.save；此处暴露给需要的高级用法）。
    _internal: { head, cloud, sub },
  };
}

export type Store = ReturnType<typeof createStore>;
