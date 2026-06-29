// ⚠ 这是库的唯一入口。接库必读同目录 README.md + CONTEXT.md。
//
// createStore —— 薄组合根：provider → 库内造 cloud/local/kv/脊椎 → 装配 10 个深模块 →
//   暴露 README.md 的面（file / collection / localSettings / syncedSettings / list）。
//   红线全在各深模块内 enforce；这里只接线 + 把 ui bundle 映射到各 flow 的回调。
import { toU8, createSubstrate } from "./substrate.ts";
import type { Bytes } from "./substrate.ts";
import { createLocalHead } from "./local-head.ts";
import { createSeal } from "./seal.ts";
import { looksEncryptedContainer, packContainer, unpackContainer, configureCryptoCodec, scanEncPeekFromEnd, decryptPeek, PEEK_TAIL_WINDOW, ENC_PEEK_MIME, type CryptoCodec } from "./crypto-container.ts";
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

// ── ui bundle（Model B，README.md §7）：store 在决策点回调进来 + await ──
export interface StoreUI {
  busy: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  askPassword?: (ctx: { name: string; reason: "open" | "save" | "unlock" }) => Promise<string | null>;
  resolveConflict?: (ctx: { name: string; local: Blob | null; cloud: Blob | null }) => Promise<ResolveChoice>;
  reportError?: (err: unknown) => void;
  // 可选：云端检查（freshness gate）的「跳过到离线」逃生闸（对齐 WebPaint：无硬超时，用户即超时）。
  // store 在 open 的 freshness 检查前调，拿 probe 与 fetchMeta race；用户点「跳过到离线」→ probe resolve → 读本地
  //   （iOS 登录态老 token acquireTokenSilent iframe 永不 resolve→fetchMeta 挂死时的唯一逃生）。
  // 不实现 → 无逃生闸（退回纯 isOnline 守卫 + 裸 await）。settle() 在检查结束后清理 skip UI。
  offlineEscape?: () => { probe: Promise<unknown>; settle: () => void };
}

export interface StoreConfig {
  provider: CloudProvider;
  ui: StoreUI;
  syncedSettingsFileName?: string;
  // ── 加密（对齐 WebPaint，见 docs/11；逻辑在库、重型 7z/zip codec 由 app 注入）──
  //   不注入 crypto → 加密 dormant（packContainer 抛「加密未配置」）；JRP 不加密就不注入，省 1.6MB。
  crypto?: CryptoCodec;                            // app 注入的 zip/7z codec（WebPaint 用 sevenzip.ts+zip.ts 包成）
  crypt?: {
    ext?: string;                                  // 真扩展名 → meta.bin（"ora"/"txt"…），还原真名
    makePeek?: (plain: Blob) => Promise<Uint8Array | null>;   // 明文→不透明 peek 字节（app 域；store 不看内容）
    getPassword?: (name: string) => string | null; // 同步、非交互、只读内存（唯一密码源）；app 持密码 + 解锁循环在 busy 外
  };
  encryptionSaltFileName?: string;   // ⚠ 未采用：README §5 的库统一密钥/salt 超集本版不实现（见 docs/11，加密走 crypt.getPassword）
  // ── 内部/测试 seam（prod 默认 idb + localStorage）──
  kv?: Kv;
  local?: LocalCache;
  getPassword?: (name: string) => string | null;   // 旧顶层密码源（向后兼容；优先用 crypt.getPassword）
  // 采纳云端字节前的有效性闸（N2：clean 快进/pull 覆盖本地前调）。store 格式盲、自己验不了内容 →
  //   **编辑器/珍贵数据类消费者（如 WebPaint 画作）必须注入**（验是不是真 .ora/zip 容器），否则损坏/captive-portal
  //   HTML 拿着合法 etag 能覆盖唯一好的本地副本 = 丢画（静态验证 2026-06-28 标定的唯一残留 不丢画 缺口）。
  //   只读镜像类（JRP PDF，可重下）可不给。
  validateAdopt?: (blob: Blob) => boolean | Promise<boolean>;
  isOnline?: () => boolean;                          // offload 离线守卫（默认 navigator.onLine）
  keepOnOpen?: boolean;                              // 消费模式：true=开即自动留本地(读者/编辑器)；false=过路/流式(开整份拉云不落本地；range 按需取片是 ⚠TODO 优化)
}

// ── 文件对象（README.md §2）。isZip 在编译期分出两种：RawFile 无 setPreview ──
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
  // ── 加密（at-rest 透明；对齐 WebPaint，见 docs/11。JRP 不注入 codec → dormant）──
  isEncrypted(): Promise<boolean>;                                       // 本地字节是否加密容器
  encrypt(opts?: { isOnline?: () => boolean }): Promise<{ status: string }>;   // 明文→密文（先本地后云 If-Match；离线 defer；错密码前置出局）
  decrypt(opts?: { isOnline?: () => boolean }): Promise<{ status: string }>;   // 密文→明文（同上红线）
  verifyPassword(pw: string): Promise<boolean>;                         // app 解锁循环（busy 外）便宜验：解 peek，不碰 7z
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
  const { provider, ui, syncedSettingsFileName, kv = localStorageKv(), validateAdopt, keepOnOpen = true } = config;
  const local = config.local ?? createLocalCache();   // prod=idb；测试注入 mock-local
  const isOnline = config.isOnline ?? ((): boolean => (globalThis as { navigator?: { onLine?: boolean } }).navigator?.onLine !== false);
  // 加密密码源（对齐 WebPaint 非交互 getPassword）：优先 crypt.getPassword，兼容旧顶层；不给 → 恒 null（透传明文）。
  const getPassword = config.crypt?.getPassword ?? config.getPassword ?? ((): string | null => null);
  if (config.crypto) configureCryptoCodec(config.crypto);   // app 注入 zip/7z codec 才启用加密；JRP 不注入 → dormant

  // ── 脊椎 + 低层 ──
  const cloud: CloudSync = createCloudSync({ provider, kv, fileName: (n: string) => n });
  const sub = createSubstrate();
  const head = createLocalHead({ kv, getCloudEtag: (n: string) => cloud.getETag(n) });
  const offloadMod = createOffload({ cloud, local, head, isOnline, serialize: sub.serialize });   // serialize：offload 的 hardDelete ⟂ save 的 local 写互斥（红线：驱逐不吃未推字节）
  const reconcileMod = createReconcile({ cloud, local, head, isOnline });

  // ── seal：加密透明（crypto-container 默认；getPassword 非交互）。JRP 不加密 → getPassword 恒 null=透传 ──
  const seal = createSeal({
    looksContainer: (b) => looksEncryptedContainer(b),
    pack: (o) => packContainer({ dataBytes: o.dataBytes, fileName: o.fileName, ext: o.ext, peek: o.peek, password: o.password }),
    unpack: (blob, pw) => unpackContainer(blob, pw),
    getPassword,
    getPrev: (n) => local.get(n),
    makePeek: config.crypt?.makePeek,   // 明文→peek（app 域，如 ora 缩略图）；不给 → 容器无 peek
    ext: config.crypt?.ext,             // 真扩展名 → meta.bin
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
  const delSF = singleFlight("删除", (n: string) => del.del(n, { isOnline }));   // 接 isOnline：离线删走 move-aside + base-etag 守卫的删队列（重连 drainDeleteQueue 重放）
  const renameSF = singleFlight("重命名", (n: string, nn: string) => identity.rename(n, nn));

  // ── ui 映射：冲突回调把 local/cloud 字节取来喂 ui.resolveConflict（默认 cancel=留 dirty）──
  const onConflict = async ({ name }: { name: string }): Promise<ResolveChoice> => {
    if (!ui.resolveConflict) return "cancel";
    const [localBlob, cloudPull] = await Promise.all([local.get(name), cloud.pull(name).catch(() => null)]);
    return ui.resolveConflict({ name, local: localBlob, cloud: cloudPull?.blob ?? null });
  };

  // ── 加密：读侧原语 + at-rest transform（照搬 WebPaint store.ts，见 docs/11；JRP 不注入 codec → dormant）──
  //   非交互：无/错密码 → null / status:"locked"（绝不弹窗）。解锁循环是 app 在 busy 外的事（seal.withPassword 守）。
  async function encTailBytes(name: string, n: number, tryCloud: boolean): Promise<Blob | null> {
    const blob = await local.get(name);                          // 本地有 → 尾切片（IDB Blob.slice 惰性）
    if (blob) { const b = blob instanceof Blob ? blob : new Blob([blob as BlobPart]); return b.slice(Math.max(0, b.size - n)); }
    if (tryCloud && cloud.pullTail) { const t = await cloud.pullTail(name, n); return t ? new Blob([t.bytes as BlobPart]) : null; }  // 纯云端 peek：byte-range
    return null;
  }
  async function encReadPeek(name: string, tryCloud: boolean): Promise<Uint8Array | null> {
    const tail = await encTailBytes(name, PEEK_TAIL_WINDOW, tryCloud);
    if (!tail) return null;
    const parsed = scanEncPeekFromEnd(new Uint8Array(await tail.arrayBuffer()));
    if (!parsed) return null;
    return await seal.withPassword(name, (pw) => decryptPeek(parsed, pw));   // 非交互内存密码；锁定 → null
  }
  async function encVerify(name: string, pw: string): Promise<boolean> {     // app 解锁循环的便宜验证器（解 peek，不碰 7z）
    if (!pw) return false;
    const tail = await encTailBytes(name, PEEK_TAIL_WINDOW, true);
    if (tail) { const p = scanEncPeekFromEnd(new Uint8Array(await tail.arrayBuffer())); if (p) { try { await decryptPeek(p, pw); return true; } catch { return false; } } }
    const full = await local.get(name);                          // 无 peek（裸 .7z）→ 退回整字节解一把（贵）
    if (!full) return false;
    try { await unpackContainer(full instanceof Blob ? full : new Blob([full as BlobPart]), pw); return true; } catch { return false; }
  }
  async function encIsEncrypted(name: string): Promise<boolean> {
    const blob = await local.get(name);
    return blob ? looksEncryptedContainer(blob instanceof Blob ? blob : new Blob([blob as BlobPart])) : false;
  }
  // 字节替换共用流（_swapBytes 红线，照搬 WebPaint）：① 本地先落地 ② 云端 If-Match 跟进，失败→标脏+锚 parent=换前云版
  //   交正常 push 流接力收敛（v233 教训：只换一端 = 加密被静默撤销）③ 曾同步但离线 → 拒（防只换一端）④ 错密码前置出局。
  async function encSwap(name: string, bytes: Bytes, online: () => boolean, encrypted: boolean): Promise<{ status: string }> {
    const prevEtag = cloud.getETag(name);
    const tracked = prevEtag != null;
    if (tracked && !online()) return { status: "offline" };
    await local.save(name, bytes);                               // ① 字节真相先落地（已在 encEncrypt 的 serialize 锁内）
    if (!tracked) return { status: "swapped" };
    try {
      const { item } = await cloud.push(name, bytes, { baseEtag: head.seenBase(name), encrypted });   // If-Match + 扩展名翻转
      head.onPushed(name, item?.eTag ?? null, false);            // 落地：base←新 etag、清 dirty/parent
      return { status: "swapped" };
    } catch (e: unknown) {
      head.onPushed(name, prevEtag, true);                       // ② 本地已换、云没跟上 → base/parent←换前云版 + dirty，push 流接力（下次 If-Match 旧云版：没人动→换成功；动过→412 surface）
      return { status: (e as { name?: string } | null)?.name === "CloudConflictError" ? "conflict" : "cloud-deferred" };
    }
  }
  async function encEncrypt(name: string, online: () => boolean): Promise<{ status: string }> {
    return ui.busy(`正在加密 ${name}…`, () => sub.serialize(name, async () => {
      const blob = await local.get(name);
      if (!blob) return { status: "no-local" };
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      if (await looksEncryptedContainer(asBlob)) return { status: "already" };
      if (cloud.getETag(name) != null && !online()) return { status: "offline" };   // 早退：还没打包就知两端换不齐
      const pw = getPassword(name);
      if (!pw) return { status: "locked" };                      // 首次加密密码由 app 调用前放进 getPassword seam
      let peek: Uint8Array | null = null;
      if (config.crypt?.makePeek) { try { peek = await config.crypt.makePeek(asBlob); } catch { peek = null; } }
      const container = await packContainer({ dataBytes: await toU8(asBlob), fileName: name, ext: config.crypt?.ext, peek, password: pw });
      return await encSwap(name, await toU8(container), online, true);
    }));
  }
  async function encDecrypt(name: string, online: () => boolean): Promise<{ status: string }> {
    return ui.busy(`正在解除加密 ${name}…`, () => sub.serialize(name, async () => {
      const blob = await local.get(name);
      if (!blob) return { status: "no-local" };
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      if (!(await looksEncryptedContainer(asBlob))) return { status: "not-encrypted" };
      if (cloud.getETag(name) != null && !online()) return { status: "offline" };
      const res = await seal.withPassword(name, (pw) => unpackContainer(asBlob, pw));   // ④ 非交互解；无/错密码→locked，任何持久改动前出局
      if (!res) return { status: "locked" };
      return await encSwap(name, await toU8(res.dataBlob), online, false);
    }));
  }

  // ── file 工厂（重载：isZip 编译期分流）──
  function makeRaw(name: string): RawFile {
    const readLocal = async (): Promise<Blob | null> => {        // 读本地缓存字节 → 解壳出明文
      const blob = await local.get(name);
      if (!blob) return null;
      const asBlob = blob instanceof Blob ? blob : new Blob([blob as BlobPart]);
      return await seal.unsealForRead(name, asBlob);
    };
    return {
      async save(bytes) {
        head.recordEdit(name);                                   // 同步标脏：offload 的 isDirty 守卫立即可见（防驱逐吃未推字节）
        const plain = await toU8(bytes);
        const sealed = await seal.sealForWrite(name, plain);
        await sub.serialize(name, () => local.save(name, sealed));   // local 写进同名串行链：与 offload.hardDelete 互斥（C2 红线）
        try { await pushMod.push(name, { encode: () => plain, onConflict }); }
        catch (e) { ui.reportError?.(e); }
      },
      async open() {
        if (await local.exists(name)) {                          // 有本地副本 → **先 etag 检查**（fresh.open）：in-sync 读本地、变了才拉云、脏 surface
          // isOnline：离线直接读本地、不碰 fetchMeta（离线模式完美工作，绝不卡 open）。
          // offlineEscape：在线但 fetchMeta 挂死（iOS 老 token iframe）时，用户点「跳过到离线」→ probe 赢 race → 读本地。
          //   对齐 WebPaint cloud-freshness「跳过到离线」（无硬超时，用户即超时）。不立即返缓存=防云端变了再采纳的闪。
          const esc = isOnline() ? ui.offlineEscape?.() : undefined;
          try { await fresh.open(name, { isOnline, probe: esc?.probe }).catch((e) => ui.reportError?.(e)); }
          finally { esc?.settle(); }
          return readLocal();
        }
        if (keepOnOpen) {                                          // 本地没有、持有模式 → 拉云落本地（无可显示，必须等）
          await identity.acquire(name, { localName: name });
          return readLocal();
        }
        // 本地没有、过路模式（keepOnOpen:false，流式消费）→ 整份拉云、**不落本地**，直接返字节
        const pulled = await cloud.pull(name).catch((e) => { ui.reportError?.(e); return null; });
        return pulled ? await seal.unsealForRead(name, pulled.blob) : null;   // range/streaming（按需取片）是 ⚠TODO 优化
      },
      async rename(newName) { await renameSF(name, newName); },
      async delete() { await delSF(name); },
      isDirty() { return head.isDirty(name); },
      isKeptOffline() { return local.exists(name); },   // 有本地副本 = 已留作离线（无 LRU、无独立 pin flag）
      async keepOffline() {   // 确保本地有副本（未缓存则 acquire；离线/失败 best-effort）
        if (!(await local.exists(name))) { try { await identity.acquire(name, { localName: name }); } catch (e) { ui.reportError?.(e); } }
      },
      offload() { return offloadMod.offload(name); },
      isEncrypted() { return encIsEncrypted(name); },
      encrypt(opts) { return encEncrypt(name, opts?.isOnline ?? isOnline); },
      decrypt(opts) { return encDecrypt(name, opts?.isOnline ?? isOnline); },
      verifyPassword(pw) { return encVerify(name, pw); },
    };
  }

  function file(name: string, opts: { isZip: true }): ZipFile;
  function file(name: string, opts: { isZip: false }): RawFile;
  function file(name: string, opts: { isZip: boolean }): RawFile | ZipFile;
  function file(name: string, opts: { isZip: boolean }): RawFile | ZipFile {
    const raw = makeRaw(name);
    if (!opts.isZip) return raw;
    // ZipFile.getPreview：读容器尾部加密 peek（本地切片或云端 byte-range）→ 不透明明文字节包 Blob；锁定/无 peek → null。
    //   peek 是 seal 时经 crypt.makePeek 自动派生（对齐 WebPaint，无显式 setPreview）；故 setPreview 暂留 notYet。
    const getPreview = async (): Promise<Blob | null> => { const b = await encReadPeek(name, true); return b ? new Blob([b as BlobPart]) : null; };
    const setPreview = async (_b: Blob): Promise<void> => { throw new Error("ZipFile.setPreview ⚠未采用：peek 经 crypt.makePeek 自动派生（对齐 WebPaint，见 docs/11）"); };
    return Object.assign(raw, { setPreview, getPreview }) as ZipFile;
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
    // ── 加密导入辅助（文件还没进 store、无 name 可查时；对齐 WebPaint）──
    looksEncrypted: (blob: Blob | Uint8Array) => looksEncryptedContainer(blob),   // 是否加密容器（导入分流）
    verifyContainer: async (blob: Blob, pw: string): Promise<boolean> => { if (!pw) return false; try { await unpackContainer(blob, pw); return true; } catch { return false; } },
    unsealWith: async (blob: Blob, pw: string): Promise<Blob | null> => {   // 显式密码解一段字节（导入：不走 getPassword、不污染全局）
      if (!(await looksEncryptedContainer(blob))) return blob;
      try { return (await unpackContainer(blob, pw)).dataBlob; } catch { return null; }
    },
    // 编辑游标（app 标脏入口经 file.save；此处暴露给需要的高级用法）。
    _internal: { head, cloud, sub },
  };
}

export type Store = ReturnType<typeof createStore>;
