// Gallery 纯数据层 —— lift 自 WebPaint gallery-path/gallery-model,为 JRP 适配。
// 扁平路径名(用 "/" 表文件夹层级,无真嵌套结构)+ 当前文件夹切片 → 嵌套文件夹免费、零 tree-sync bug。
// JRP 适配:无 local-session(PDF 是云镜像);item = 云 PDF 文件 ⊕ catalog 元数据(标题/docId/缓存态)。
// **丢掉** WebPaint 的:加密、copy、ghost/cloud-gone 收敛(那是 store 域)、dirty-sync badge、多选。
// 零 DOM / 零网络 / 零 store → 可单测。

// ── 路径代数(lift) ──────────────────────────────────────────────────────────
export function pathFolder(name: string): string { const i = name.lastIndexOf("/"); return i < 0 ? "" : name.slice(0, i); }
export function pathBasename(name: string): string { const i = name.lastIndexOf("/"); return i < 0 ? name : name.slice(i + 1); }
export function pathJoin(folder: string, name: string): string {
  if (!folder) return name;
  if (!name) return folder;
  return `${folder}/${name}`;
}

// ── item 模型 ────────────────────────────────────────────────────────────────
export interface GalleryItem {
  name: string;       // 相对 papers 根的路径(切片键),如 "Wei 2011.pdf" / "组合/x.pdf"
  path: string;       // approot 完整路径(content 操作用),如 "papers/Wei 2011.pdf"
  title: string;      // 展示标题(catalog 有则用,否则 basename 去 .pdf)
  docId?: string;     // catalog 身份(有 = 记过阅读位置)
  keptOffline?: boolean;   // 本地有副本(已留作离线/离线可读)。无 LRU、无独立 pin → 单一态
}
export interface CatalogMeta { docId: string; name: string; title?: string; }   // name = 相对 papers 根的路径

// 云 PDF 文件(已剥 papers/ 前缀的 {name,path})⊕ catalog → items(标题/docId 来自 catalog,按相对路径配——
// 不用 basename,否则不同文件夹同名会撞)。keptOffline 由 host 注入判定函数。
export function buildItems(
  files: { name: string; path: string }[],
  catalogByName: Map<string, CatalogMeta>,
  isKeptOffline?: (path: string) => boolean,
): GalleryItem[] {
  return files.map((f) => {
    const meta = catalogByName.get(f.name);
    return {
      name: f.name,
      path: f.path,
      title: meta?.title || pathBasename(f.name).replace(/\.pdf$/i, ""),
      docId: meta?.docId,
      keptOffline: isKeptOffline ? isKeptOffline(f.path) : false,
    };
  });
}

// 切当前文件夹层 → { subfolders(immediate 子夹,字母序), files(直属文件,按标题字母序) }。
//   items = buildItems 结果(name 相对 papers 根);cloudFolders = 真文件夹(含空夹,相对 papers 根);folder = 当前层("" = 根)。
//   空夹无法从文件路径推出 → 必须有 cloudFolders 作单一真相源(lift 自 WebPaint 的关键正确点)。
export function sliceFolder(
  items: GalleryItem[], cloudFolders: string[], folder: string,
): { subfolders: string[]; files: GalleryItem[] } {
  const prefix = folder ? `${folder}/` : "";
  const folderSet = new Set<string>();
  const files: GalleryItem[] = [];
  for (const it of items) {
    if (folder && !it.name.startsWith(prefix)) continue;
    const rest = it.name.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) folderSet.add(rest.slice(0, slash));
    else if (rest) files.push(it);
  }
  for (const f of cloudFolders) {
    if (folder) {
      if (f === folder || !f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const seg = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
      if (seg) folderSet.add(seg);
    } else {
      const first = f.split("/")[0];
      if (first) folderSet.add(first);
    }
  }
  files.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  const subfolders = [...folderSet].sort((a, b) => a.localeCompare(b));
  return { subfolders, files };
}

// 面包屑:当前文件夹路径 → [{name, path}](逐级)。根("")→ []。
export function breadcrumb(folder: string): { name: string; path: string }[] {
  if (!folder) return [];
  const segs = folder.split("/");
  return segs.map((s, i) => ({ name: s, path: segs.slice(0, i + 1).join("/") }));
}
