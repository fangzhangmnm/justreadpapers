// PDF 字节面（只读镜像 over @internal/store）。app 不碰 cloud/Graph/IDB——全走注入的 store 两面(file/files)。
// PDF 读经 store.file(path).open() → **白得离线缓存**（open 自动把云端字节缓存本地，库强制）。
// 摄入/改名/软删走 store.file 的 save/tryMove/delete（move-aside / never-overwrite 红线在库内；
//   mode:"new" = 新建撞名即抛，mode:"existing" = 编辑既有）。
// 列举面（watchFolder 订阅）不在这里——host（persistence/index）直接包 store.files.watchFolder。

import type { Bytes, Store } from "@internal/store";

/** 回收站/备份箱一项（local/cloud 双腿：cloudId=云端 item id，trashKey=本地缓存键；至少一腿）。 */
export interface BinEntry {
  key: string;                  // UI 列表 key（cloudId ?? trashKey）
  cloudId: string | null;
  trashKey: string | null;
  name: string;                 // 显示名（已去 move-aside 时间戳）
}

export interface Content {
  /** 回收站列表（.trash 里的 PDF；name 已去 [时间戳]）。 */
  listTrash(): Promise<BinEntry[]>;
  /** 备份箱列表（.backup 里的 loser 字节；恢复/彻底删走通用 restore/purge）。 */
  listBackup(): Promise<BinEntry[]>;
  /** 从回收站/备份箱恢复到 targetPath（host 决定落点，如 papers/<name>）。 */
  restore(e: BinEntry, targetPath: string): Promise<void>;
  /** 永久删除（danger confirm 由 host 经 confirm 注入；store 强制）。 */
  purge(e: BinEntry, confirm: (ctx: { title: string; body: string; danger?: boolean }) => boolean | Promise<boolean>): Promise<void>;
  /** 清空回收站（本地+云端）。 */
  emptyTrash(): Promise<{ purged: number; failed: unknown[] }>;
  /** 留一份离线副本（确保已缓存，离线可读）。 */
  keepOffline(path: string): Promise<void>;
  /** 移除本地副本（守卫式 offload；非法=唯一副本/不可重取 → 抛错出 banner，不静默丢）。 */
  offload(path: string): Promise<void>;
  /** 读 PDF 字节（store.file.open：本地有秒开 / 无则拉云 + 缓存）。 */
  read(path: string): Promise<Blob | null>;
  /** 摄入：上传 PDF（新文件；store 红线 never-overwrite，撞名抛）。 */
  upload(path: string, bytes: Bytes | Blob): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 软删：move 到 .trash（store 红线 move-aside）。 */
  trash(path: string): Promise<void>;
  /** 新建文件夹（完整 approot 路径）。idempotent，离线先本地登记、回线补建。 */
  ensureFolder(path: string): Promise<void>;
  /** 删除**空**文件夹（store 强制非空拒删——非空抛错出 toast）。 */
  deleteFolder(path: string): Promise<void>;
}

const stripStamp = (n: string): string => n.replace(/ \[[^\]]*\]$/, "");   // 去 move-aside 的 [yyyymmddhhmmss-guid]
const baseName = (p: string): string => { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); };

export function createContent(store: Pick<Store, "file" | "files">): Content {
  const existing = (path: string) => store.file(path, { isZip: false, mode: "existing" });
  const toBin = (it: { cloudItemId: string | null; localKey: string | null; name: string }): BinEntry | null => {
    const key = it.cloudItemId ?? it.localKey;
    if (!key) return null;
    return { key, cloudId: it.cloudItemId, trashKey: it.localKey, name: stripStamp(baseName(it.name)) };
  };
  const listBin = async (which: "listTrash" | "listBackup"): Promise<BinEntry[]> =>
    (await store.files[which]()).map(toBin).filter((e): e is BinEntry => !!e && /\.pdf$/i.test(e.name));
  return {
    read: (path) => existing(path).open(),
    async upload(path, bytes) { await store.file(path, { isZip: false, mode: "new" }).save(bytes); },   // 默认 tryPush:true；离线→ADR-0018 队列补推
    async rename(oldPath, newPath) {
      const r = await existing(oldPath).tryMove(newPath);
      if (!r.ok) throw new Error(`同名已存在(${r.where === "cloud" ? "云端" : "本地"})`);
    },
    async trash(path) { await existing(path).delete(); },
    ensureFolder: (path) => store.files.ensureFolder(path),
    deleteFolder: (path) => store.files.deleteFolder(path),
    listTrash: () => listBin("listTrash"),
    listBackup: () => listBin("listBackup"),
    async restore(e, targetPath) {
      await store.files.restoreTrash({ fromCloud: !!e.cloudId, cloudItemId: e.cloudId, trashKey: e.trashKey, targetName: targetPath });
    },
    async purge(e, confirm) { await store.files.purgeTrash({ cloudItemId: e.cloudId, trashKey: e.trashKey, confirm }); },
    async emptyTrash() { const r = await store.files.emptyTrash({ scope: "both" }); return { purged: r.purged ?? 0, failed: r.failed ?? [] }; },
    async keepOffline(path) { await existing(path).keepOffline(); },
    offload: (path) => existing(path).offload(),
  };
}
