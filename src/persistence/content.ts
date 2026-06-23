// PDF 字节面（只读镜像 over createStore）。app 不碰 cloud/Graph/IDB——全走注入的 store。
// PDF 读经 store.file(path).open() → **白得离线缓存**（open 自动把云端字节缓存本地，库强制）。
// 摄入/改名/软删走 store.file 的 save/rename/delete（move-aside / never-overwrite 红线在库内）。

import type { Bytes } from "../store/types.ts";
import type { Store, EvictResult } from "../store/index.ts";

export interface PaperFile {
  path: string;       // approot 相对路径，如 "papers/Wei 2011.pdf"
  fileName: string;   // basename
  folder: string;     // 所在文件夹（folder-tree 用），如 "papers"
  size: number;
}

/** 回收站一项（去掉 move-aside 时间戳后的显示名 + 云端 item id）。 */
export interface TrashEntry { cloudId: string; name: string; }

export interface Content {
  /** 列 approot 下所有 PDF + 文件夹。complete=false → 列举有子树失败，别据此删缓存。 */
  listTree(): Promise<{ files: PaperFile[]; folders: string[]; complete: boolean }>;
  /** 回收站列表（.trash 里的 PDF；name 已去 [时间戳]）。 */
  listTrash(): Promise<TrashEntry[]>;
  /** 备份箱列表（.backup 里的 loser 字节；恢复/彻底删走通用 restore/purge）。 */
  listBackup(): Promise<TrashEntry[]>;
  /** 从回收站恢复到 targetPath（host 决定落点，如 papers/<name>）。 */
  restore(cloudId: string, targetPath: string): Promise<void>;
  /** 永久删除（danger confirm 由 host 经 confirm 注入；store 强制）。 */
  purge(cloudId: string, confirm: (ctx: { title: string; body: string; danger?: boolean }) => boolean | Promise<boolean>): Promise<void>;
  /** 清空回收站（本地+云端）。 */
  emptyTrash(): Promise<{ purged: number; failed: unknown[] }>;
  /** 缓存到本地常驻（pin + 确保已缓存，离线可读）。 */
  cache(path: string): Promise<void>;
  /** 取消缓存（unpin + 守卫式 evict；dirty/离线/云端没了会保留）。 */
  uncache(path: string): Promise<EvictResult>;
  isPinned(path: string): boolean;
  /** 已缓存的应用文件路径集合（gallery 批量判 cached）。 */
  cachedKeys(): Promise<Set<string>>;
  /** 读 PDF 字节（store.file.open：本地有秒开 / 无则拉云 + 缓存）。 */
  read(path: string): Promise<Blob | null>;
  /** 摄入：上传 PDF（新文件；store 红线 never-overwrite）。 */
  upload(path: string, bytes: Bytes | Blob): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 软删：move 到 .trash（store 红线 move-aside）。 */
  trash(path: string): Promise<void>;
  /** 新建文件夹（完整 approot 路径）。idempotent。 */
  ensureFolder(path: string): Promise<void>;
  /** 删除**空**文件夹（store 强制非空拒删）。返 false=云端已无此夹（noop）。 */
  deleteFolder(path: string): Promise<boolean>;
}

function baseName(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function dirName(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }

type ContentStore = Pick<Store, "file" | "listAll" | "ensureFolder" | "deleteFolder" | "listTrash" | "listBackup" | "restore" | "purge" | "emptyTrash" | "localKeys">;

const stripStamp = (n: string): string => n.replace(/ \[[^\]]*\]$/, "");   // 去 move-aside 的 [yyyymmddhhmmss-guid]

export function createContent(store: ContentStore): Content {
  const raw = (path: string) => store.file(path, { isZip: false });
  return {
    async listTree() {
      const { files, folders, complete } = await store.listAll();
      return {
        files: files.map((it) => ({ path: it.path, fileName: baseName(it.path), folder: dirName(it.path), size: it.size })),
        folders, complete,
      };
    },
    read: (path) => raw(path).open(),
    async upload(path, bytes) { await raw(path).save(bytes); },
    async rename(oldPath, newPath) { await raw(oldPath).rename(newPath); },
    async trash(path) { await raw(path).delete(); },
    async ensureFolder(path) { await store.ensureFolder(path); },
    deleteFolder: (path) => store.deleteFolder(path),
    async listTrash() {
      const items = await store.listTrash();
      return items
        .map((it) => ({ cloudId: it.id, name: stripStamp(baseName(it.path || it.name)) }))
        .filter((e) => /\.pdf$/i.test(e.name));
    },
    async listBackup() {
      const items = await store.listBackup();
      return items
        .map((it) => ({ cloudId: it.id, name: stripStamp(baseName(it.path || it.name)) }))
        .filter((e) => /\.pdf$/i.test(e.name));
    },
    async restore(cloudId, targetPath) { await store.restore({ fromCloud: true, cloudItemId: cloudId, targetName: targetPath }); },
    async purge(cloudId, confirm) { await store.purge({ cloudItemId: cloudId, confirm }); },
    async emptyTrash() { const r = await store.emptyTrash({ scope: "both" }); return { purged: r.purged ?? 0, failed: r.failed ?? [] }; },
    async cache(path) { await raw(path).pin(); },
    async uncache(path) { raw(path).unpin(); return raw(path).evict({ force: true }); },
    isPinned: (path) => raw(path).isPinned(),
    async cachedKeys() { return new Set(await store.localKeys()); },
  };
}
