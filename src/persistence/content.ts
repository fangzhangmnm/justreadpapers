// PDF 字节面（只读镜像 over createStore）。app 不碰 cloud/Graph/IDB——全走注入的 store。
// PDF 读经 store.file(path).open() → **白得离线缓存**（open 自动把云端字节缓存本地，库强制）。
// 摄入/改名/软删走 store.file 的 save/rename/delete（move-aside / never-overwrite 红线在库内）。

import type { Bytes } from "../store/types.ts";
import type { Store } from "../store/index.ts";

export interface PaperFile {
  path: string;       // approot 相对路径，如 "papers/Wei 2011.pdf"
  fileName: string;   // basename
  folder: string;     // 所在文件夹（folder-tree 用），如 "papers"
  size: number;
}

export interface Content {
  /** 列 approot 下所有 PDF + 文件夹。complete=false → 列举有子树失败，别据此删缓存。 */
  listTree(): Promise<{ files: PaperFile[]; folders: string[]; complete: boolean }>;
  /** 读 PDF 字节（store.file.open：本地有秒开 / 无则拉云 + 缓存）。 */
  read(path: string): Promise<Blob | null>;
  /** 摄入：上传 PDF（新文件；store 红线 never-overwrite）。 */
  upload(path: string, bytes: Bytes | Blob): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 软删：move 到 .trash（store 红线 move-aside）。 */
  trash(path: string): Promise<void>;
  /** 新建文件夹（完整 approot 路径）。idempotent。 */
  ensureFolder(path: string): Promise<void>;
}

function baseName(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function dirName(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }

type ContentStore = Pick<Store, "file" | "listAll" | "ensureFolder">;

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
  };
}
