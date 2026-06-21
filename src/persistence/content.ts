// PDF 字节面(只读镜像 over cloud-sync)。app 不碰 cloud/Graph/IDB。
// PDF = 只读镜像:listTree/read 为主;upload(摄入)/rename/trash 是对用户自己文件的管理(走 store 的
// move-aside/never-overwrite 红线)。**永不查 PDF 的 dirty/status**(避开 G2:isDirty 默认 true 误判镜像)。
// PDF 本地缓存(Cache API + frecency)是 P3 的 pdf-cache,这层先直 pull。

import type { CloudSync, Bytes } from "../store/types.ts";

export interface PaperFile {
  path: string;       // approot 相对路径,如 "papers/Wei 2011.pdf"
  fileName: string;   // basename
  folder: string;     // 所在文件夹(folder-tree 用),如 "papers"
  size: number;
}

export interface Content {
  /** 列 approot 下所有 PDF + 文件夹(folder-tree 吃这个)。complete=false → 列举有子树失败,别据此删缓存。 */
  listTree(): Promise<{ files: PaperFile[]; folders: string[]; complete: boolean }>;
  /** 读 PDF 字节(只读 pull)。 */
  read(path: string): Promise<Blob | null>;
  /** 摄入:上传 PDF(新文件;store 的 conflictBehavior=fail + 大小核验防覆盖别人同名)。 */
  upload(path: string, bytes: Bytes | Blob): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  /** 软删:move 到 .trash(store 红线 move-aside)。 */
  trash(path: string): Promise<void>;
  /** 新建文件夹(完整 approot 路径,如 "papers/组合")。idempotent。 */
  ensureFolder(path: string): Promise<void>;
}

function baseName(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? p : p.slice(i + 1); }
function dirName(p: string): string { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }

export function createContent(cloud: CloudSync): Content {
  return {
    async listTree() {
      const { files, folders, complete } = await cloud.listAll();
      return {
        files: files.map((it) => ({
          path: it.path, fileName: baseName(it.path), folder: dirName(it.path), size: it.size,
        })),
        folders, complete,
      };
    },
    async read(path) {
      const res = await cloud.pull(path);
      return res ? res.blob : null;
    },
    async upload(path, bytes) { await cloud.push(path, bytes); },
    async rename(oldPath, newPath) { await cloud.rename(oldPath, newPath); },
    async trash(path) { await cloud.trash(path); },
    async ensureFolder(path) { await cloud.ensureFolder(path); },
  };
}
