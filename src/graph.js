// Microsoft Graph wrapper,所有路径都锚在 /me/drive/special/approot 沙盒里。
// 即使 token 泄漏也只能访问本 app 自己的 approot,不波及用户其它 OneDrive。
//
// 内容简化:只处理 PDF 二进制 + JSON,不做 webxiaoheiwu 的 GB18030 / Big5 decode。

import { getToken } from "./auth.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function encodeSeg(name) {
  return encodeURIComponent(name).replace(/'/g, "%27");
}

// 多段路径(如 papers/foo.pdf)逐段 encode,保留 /
export function encodeApprootPath(path) {
  return path.split("/").filter(Boolean).map(encodeSeg).join("/");
}

async function graphFetch(method, pathOrUrl, { headers = {}, body = null, raw = false } = {}) {
  const token = await getToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const init = {
    method,
    headers: { Authorization: `Bearer ${token}`, ...headers },
  };
  if (body != null) {
    if (
      typeof body === "string" ||
      body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body) ||
      body instanceof Blob
    ) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!init.headers["Content-Type"]) {
        init.headers["Content-Type"] = "application/json";
      }
    }
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    let detail = "";
    try {
      detail = await response.text();
    } catch (_) {}
    const err = new Error(`Graph ${method} ${pathOrUrl} → ${response.status}: ${detail}`);
    err.status = response.status;
    err.body = detail;
    throw err;
  }
  return raw ? response : response;
}

// ── Listing ────────────────────────────────────────────────────────────────

// subfolder = "" 列 approot 根;否则列 approot/<subfolder>。404 静默返回 []
// (子文件夹可能还没建)。
export async function listChildren(subfolder = "") {
  const pathPart = subfolder ? `:/${encodeApprootPath(subfolder)}:` : "";
  const items = [];
  let next = `/me/drive/special/approot${pathPart}/children?$top=200&$select=id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder,parentReference`;
  while (next) {
    let response;
    try {
      response = await graphFetch("GET", next);
    } catch (e) {
      if (e.status === 404 && subfolder) return [];
      throw e;
    }
    const page = await response.json();
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
  }
  return items;
}

export async function getItemMeta(itemId) {
  const r = await graphFetch(
    "GET",
    `/me/drive/items/${itemId}?$select=id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,parentReference,@microsoft.graph.downloadUrl`,
  );
  return r.json();
}

// 二进制下载(PDF 用)。返回 Blob;调用方负责入 IndexedDB cache。
export async function downloadItemBlob(itemId) {
  // 先拿 downloadUrl(短期签名 URL,跨源 + 走 CDN,比直接 GET /content 快)
  const meta = await getItemMeta(itemId);
  const dl = meta["@microsoft.graph.downloadUrl"];
  if (dl) {
    const r = await fetch(dl);
    if (!r.ok) throw new Error(`downloadUrl 失败 ${r.status}`);
    return { blob: await r.blob(), meta };
  }
  // fallback: 直接 GET /content
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`);
  return { blob: await r.blob(), meta };
}

// ── Read JSON file (session.json 用) ───────────────────────────────────────
// 返回 { data, eTag, item },404 → { data: null }

export async function readApprootJson(path) {
  try {
    // 先拿 meta 拿 eTag —— GET /content 不返回 eTag header(看 driveItem 才有)
    const meta = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(path)}?$select=id,name,eTag`,
    );
    const metaJson = await meta.json();
    const r = await graphFetch(
      "GET",
      `/me/drive/items/${metaJson.id}/content`,
    );
    const data = await r.json();
    return { data, eTag: metaJson.eTag, item: metaJson };
  } catch (e) {
    if (e.status === 404) return { data: null, eTag: null, item: null };
    throw e;
  }
}

// 写 JSON 到 approot 路径。eTag 非 null → If-Match 防冲突。
// conflictBehavior=replace 创建/覆盖;If-Match 优先于它。
export async function writeApprootJson(path, data, eTag = null) {
  const headers = { "Content-Type": "application/json" };
  if (eTag) headers["If-Match"] = eTag;
  const r = await graphFetch(
    "PUT",
    `/me/drive/special/approot:/${encodeApprootPath(path)}:/content?@microsoft.graph.conflictBehavior=replace`,
    {
      headers,
      body: JSON.stringify(data),
    },
  );
  return r.json(); // 新的 driveItem,含新 eTag
}

// ── Upload PDF (binary) ────────────────────────────────────────────────────

// 简单 PUT;Graph 单次 PUT 限 4MB,但论文 PDF 一般 1-5MB,
// 边界情况(>4MB)走 createUploadSession。
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

export async function uploadFileToApproot(path, blob, contentType = "application/pdf") {
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    const r = await graphFetch(
      "PUT",
      `/me/drive/special/approot:/${encodeApprootPath(path)}:/content?@microsoft.graph.conflictBehavior=rename`,
      {
        headers: { "Content-Type": contentType },
        body: blob,
      },
    );
    return r.json();
  }
  // 大文件 chunked
  const sessR = await graphFetch(
    "POST",
    `/me/drive/special/approot:/${encodeApprootPath(path)}:/createUploadSession`,
    {
      body: {
        item: {
          "@microsoft.graph.conflictBehavior": "rename",
          name: path.split("/").pop(),
        },
      },
    },
  );
  const { uploadUrl } = await sessR.json();
  const CHUNK = 5 * 1024 * 1024; // 5MB
  let offset = 0;
  let last = null;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK, blob.size) - 1;
    const chunk = blob.slice(offset, end + 1);
    const r = await fetch(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.size),
        "Content-Range": `bytes ${offset}-${end}/${blob.size}`,
      },
      body: chunk,
    });
    if (!r.ok && r.status !== 202) {
      throw new Error(`chunked upload 失败 ${r.status}`);
    }
    last = await r.json().catch(() => null);
    offset = end + 1;
  }
  return last;
}

// ── Rename / move / delete ─────────────────────────────────────────────────

export async function renameItem(itemId, newName, eTag = null) {
  const headers = {};
  if (eTag) headers["If-Match"] = eTag;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, {
    headers,
    body: { name: newName },
  });
  return r.json();
}

export async function moveItemToFolder(itemId, targetFolderId, eTag = null) {
  const headers = {};
  if (eTag) headers["If-Match"] = eTag;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, {
    headers,
    body: { parentReference: { id: targetFolderId } },
  });
  return r.json();
}

export async function deleteItem(itemId) {
  await graphFetch("DELETE", `/me/drive/items/${itemId}`);
}

// ── Approot root + 子文件夹 ensure ─────────────────────────────────────────

let approotIdCache = null;
const subfolderIdCache = new Map();

export async function getApprootId() {
  if (approotIdCache) return approotIdCache;
  const r = await graphFetch("GET", "/me/drive/special/approot?$select=id");
  approotIdCache = (await r.json()).id;
  return approotIdCache;
}

export async function ensureSubfolder(name) {
  if (subfolderIdCache.has(name)) return subfolderIdCache.get(name);
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(name)}?$select=id,name,folder`,
    );
    const item = await r.json();
    if (item.folder) {
      subfolderIdCache.set(name, item.id);
      return item.id;
    }
    throw new Error(`${name} 已存在但不是文件夹`);
  } catch (e) {
    if (e.status !== 404) throw e;
    const r = await graphFetch("POST", "/me/drive/special/approot/children", {
      body: {
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      },
    });
    const item = await r.json();
    subfolderIdCache.set(name, item.id);
    return item.id;
  }
}
