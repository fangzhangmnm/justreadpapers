// 主编排:启动序列、UI 绑定、ingestion、跨设备 reconcile。
//
// 启动序列 (the jumpscare):
//   1. silent MSAL 取 token
//   2. 读 session.json
//   3. 拿 lastActive → cache 命中秒开;未命中 → 进度条 + Graph download
//   全程没有 library 落地屏。

import {
  initAuth, signIn, signOut, getToken, isSignedIn, getActiveAccount,
} from "./auth.js";
import {
  listChildren, getItemMeta, downloadItemBlob, uploadFileToApproot,
  renameItem, moveItemToFolder, deleteItem, ensureSubfolder, getApprootId,
} from "./graph.js";
import {
  initSession, getState, setPosition, setLastActive, ensureDoc,
  forgetDoc, getPosition, flush, flushKeepalive, checkRemoteChanged,
  reloadFromRemote, subscribe, getSyncSnapshot,
} from "./session.js";
import * as cache from "./cache.js";
import {
  initViewer, loadPdf, restorePosition, currentPosition,
  teardownCurrent, getPdfMetadata, getOutline, jumpToDest, fitToWidth,
  setSpreadMode, getSpreadMode, zoomBy,
  setOverviewVisible, isOverviewVisible, goToPage, canOverview,
  snapshotCurrentPage, extractCurrentPageText,
} from "./viewer.js";
import {
  PAPERS_FOLDER, TRASH_FOLDER,
} from "./config.js";

// ── DOM refs ─────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const viewerContainer = $("viewerContainer");
const thumbContainer = $("thumbContainer");
const overviewButton = $("overviewButton");
const screenshotButton = $("screenshotButton");
const copyTextButton = $("copyTextButton");
const emptyLanding = $("emptyLanding");
const emptyTitle = $("emptyTitle");
const emptyHint = $("emptyHint");
const emptyUploadButton = $("emptyUploadButton");
const progressBar = $("progressBar");
const progressFill = $("progressFill");
const topBar = $("topBar");
const menuButton = $("menuButton");
const outlineButton = $("outlineButton");
const fitWidthButton = $("fitWidthButton");
const spreadButton = $("spreadButton");
const zoomInButton = $("zoomInButton");
const zoomOutButton = $("zoomOutButton");
const currentTitle = $("currentTitle");
const pageStatus = $("pageStatus");
const syncStatus = $("syncStatus");
const drawer = $("drawer");
const drawerBackdrop = $("drawerBackdrop");
const drawerCloseButton = $("drawerCloseButton");
const drawerSortButton = $("drawerSortButton");
const drawerRefreshButton = $("drawerRefreshButton");
const drawerTitle = $("drawerTitle");
const authRow = $("authRow");
const authWho = $("authWho");
const loginButton = $("loginButton");
const logoutButton = $("logoutButton");
const papersActions = $("papersActions");
const trashActions = $("trashActions");
const fileInput = $("fileInput");
const uploadButton = $("uploadButton");
const openTrashButton = $("openTrashButton");
const backFromTrashButton = $("backFromTrashButton");
const emptyTrashButton = $("emptyTrashButton");
const docList = $("docList");
const docListEmpty = $("docListEmpty");
const cacheStatsText = $("cacheStatsText");
const themeButton = $("themeButton");
const themeLabel = $("themeLabel");
const updateToast = $("updateToast");
const updateToastReload = $("updateToastReload");
const updateToastDismiss = $("updateToastDismiss");
const idleOverlay = $("idleOverlay");
const dropOverlay = $("dropOverlay");
const outlineDrawer = $("outlineDrawer");
const outlineCloseButton = $("outlineCloseButton");
const outlineList = $("outlineList");
const outlineEmpty = $("outlineEmpty");

// ── UI state ─────────────────────────────────────────────────────────────

const SORT_KEY = "jrp.sort";       // "modified" | "name"
const VIEW_KEY = "jrp.view";       // "papers" | "trash"
const THEME_KEY = "jrp.theme";     // "day" | "night" | "auto"
const IDLE_MS = 1000 * 60 * 30;    // 30min

let sortMode = localStorage.getItem(SORT_KEY) || "modified";
let drawerView = "papers";          // 当前显示 papers 还是 trash
let papersItems = [];               // 当前 /papers/ 列表 (driveItems)
let trashItemsCache = [];           // 当前 /trash/ 列表
let currentDocId = null;            // 正在 viewer 里的 doc 的 OneDrive itemId
let trashFolderIdCache = null;

let idleTimer = null;
let outlineJumpFlushTimer = null;  // outline 跳页后的延时 flush,后来的连击 replace 前一个

// ── 小工具 ───────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

// xiaoheiwu-style status:setSyncStatus 写的是 transient (默认 2s,error 5s),
// 之后 tickSyncStatus 会接管,根据 session 实际状态 (dirty / writeInFlight /
// lastSyncedAt) 计算出 "未同步 / 同步中… / 已同步 HH:MM / 就绪 / 未登录" 这些。
let statusTransientUntil = 0;
function setSyncStatus(text, opts = {}) {
  syncStatus.textContent = text;
  syncStatus.classList.toggle("error", !!opts.error);
  syncStatus.classList.toggle("unsynced", !!opts.unsynced);
  syncStatus.classList.toggle("syncing", !!opts.syncing);
  if (opts.sticky !== true) {
    statusTransientUntil = Date.now() + (opts.duration || (opts.error ? 5000 : 1800));
  }
}

function fmtHM(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function computeSyncStatus() {
  if (!isSignedIn()) return { text: "未登录" };
  if (!currentDocId) return { text: "就绪" };
  const s = getSyncSnapshot();
  if (s.lastError && s.dirty) return { text: "同步失败 · 重试中", error: true };
  if (s.writeInFlight) return { text: "同步中…", syncing: true };
  if (s.dirty) return { text: "未同步", unsynced: true };
  if (s.lastSyncedAt > 0) return { text: `已同步 ${fmtHM(s.lastSyncedAt)}` };
  return { text: "synced" };
}

function tickSyncStatus() {
  if (Date.now() < statusTransientUntil) return;
  const r = computeSyncStatus();
  // 写文本同时清掉旧的 class
  syncStatus.textContent = r.text;
  syncStatus.classList.toggle("error", !!r.error);
  syncStatus.classList.toggle("unsynced", !!r.unsynced);
  syncStatus.classList.toggle("syncing", !!r.syncing);
}
setInterval(tickSyncStatus, 500);

function showProgress(v) {
  if (v == null) {
    progressBar.classList.add("hidden");
    return;
  }
  progressBar.classList.remove("hidden");
  progressFill.style.width = `${Math.min(100, Math.max(0, v * 100))}%`;
}

function showLanding({ title, hint, showUpload }) {
  emptyTitle.textContent = title;
  emptyHint.textContent = hint;
  emptyUploadButton.hidden = !showUpload;
  emptyLanding.classList.remove("hidden");
}
function hideLanding() {
  emptyLanding.classList.add("hidden");
}

// 标题展示用:从文件名去掉 .pdf
function fileNameToTitle(name) {
  return (name || "").replace(/\.pdf$/i, "");
}

// OneDrive 不允许这些字符:\/:*?"<>| 以及前导 .。
function sanitizeFilename(name) {
  return String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 200);
}

function ensurePdfExt(name) {
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

// ── Drawer 开关 (mutex:同一时间只允许一个 drawer 开) ───────────────────

let openDrawerName = null; // "papers" | "outline" | null

function closeDrawer() {
  drawer.classList.add("hidden");
  drawer.setAttribute("aria-hidden", "true");
  outlineDrawer.classList.add("hidden");
  outlineDrawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.add("hidden");
  openDrawerName = null;
}

function openPapersDrawer() {
  closeDrawer();
  drawer.classList.remove("hidden");
  drawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.classList.remove("hidden");
  openDrawerName = "papers";
}

function openOutlineDrawer() {
  closeDrawer();
  outlineDrawer.classList.remove("hidden");
  outlineDrawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.classList.remove("hidden");
  openDrawerName = "outline";
}

function toggleDrawer(name) {
  if (openDrawerName === name) { closeDrawer(); return; }
  if (name === "papers") openPapersDrawer();
  else if (name === "outline") openOutlineDrawer();
}

// ── Auth UI ──────────────────────────────────────────────────────────────

function refreshAuthRow(account) {
  if (account) {
    authWho.textContent = account.username || account.name || "已登录";
    loginButton.hidden = true;
    logoutButton.hidden = false;
  } else {
    authWho.textContent = "未登录";
    loginButton.hidden = false;
    logoutButton.hidden = true;
  }
}

// ── 列文件 + 渲染 drawer ─────────────────────────────────────────────────

async function loadFolderItems() {
  if (drawerView === "papers") {
    try {
      papersItems = await listChildren(PAPERS_FOLDER);
      papersItems = papersItems.filter((i) => i.file && /\.pdf$/i.test(i.name || ""));
    } catch (e) {
      // 离线 / Graph 失败 → 从 IndexedDB cache 列已有的论文
      // 让飞机上也能看到本地有什么可以读
      console.warn("listChildren failed, falling back to local cache:", e?.message);
      const meta = await cache.listMeta().catch(() => []);
      papersItems = meta.map((m) => ({
        id: m.itemId,
        name: m.name || `(unnamed ${m.itemId.slice(-6)})`,
        file: { mimeType: "application/pdf" },
        size: m.size || 0,
        eTag: m.eTag || null,
        lastModifiedDateTime: m.lastUsed ? new Date(m.lastUsed).toISOString() : null,
        _offlineStub: true,
      }));
    }
    return papersItems;
  } else {
    try {
      trashItemsCache = await listChildren(TRASH_FOLDER);
      trashItemsCache = trashItemsCache.filter((i) => i.file && /\.pdf$/i.test(i.name || ""));
    } catch (_) {
      trashItemsCache = [];
    }
    return trashItemsCache;
  }
}

function sortItems(items) {
  if (sortMode === "name") {
    return [...items].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  // modified: 最近修改在前
  return [...items].sort((a, b) => {
    const ta = Date.parse(a.lastModifiedDateTime || "") || 0;
    const tb = Date.parse(b.lastModifiedDateTime || "") || 0;
    return tb - ta;
  });
}

async function renderDocList() {
  if (!isSignedIn()) {
    docList.innerHTML = "";
    docListEmpty.classList.remove("hidden");
    docListEmpty.textContent = "请先登录 OneDrive。";
    return;
  }
  docList.innerHTML = "";
  docListEmpty.classList.remove("hidden");
  docListEmpty.textContent = "加载中…";

  let items;
  try {
    items = await loadFolderItems();
  } catch (e) {
    console.warn("列文件失败", e);
    docListEmpty.textContent = `列文件失败: ${e.message}`;
    return;
  }
  items = sortItems(items);

  if (items.length === 0) {
    docListEmpty.classList.remove("hidden");
    docListEmpty.textContent = drawerView === "trash" ? "垃圾箱是空的。" : "还没有论文,点上面「上传 PDF」。";
    return;
  }
  docListEmpty.classList.add("hidden");

  // 并发查 cache 命中
  const cacheHits = new Map();
  await Promise.all(items.map(async (it) => {
    try { cacheHits.set(it.id, await cache.isCached(it.id)); }
    catch (_) { cacheHits.set(it.id, false); }
  }));

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "doc-row";
    li.dataset.itemId = item.id;
    if (item.id === currentDocId) li.classList.add("active");
    if (cacheHits.get(item.id)) li.classList.add("cached");

    const name = fileNameToTitle(item.name);
    const dateText = fmtDate(item.lastModifiedDateTime);
    li.innerHTML = `
      <span class="cache-dot" title="${cacheHits.get(item.id) ? "已缓存" : "未缓存"}"></span>
      <span class="name">${escapeHtml(name)}</span>
      <span class="meta">${escapeHtml(dateText)}</span>
      <span class="row-actions">
        ${drawerView === "papers"
          ? `<button data-act="rename" title="改名" aria-label="改名">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
            </button>
            <button data-act="trash" title="移到垃圾箱" aria-label="移到垃圾箱">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>
            </button>`
          : `<button data-act="restore" title="还原" aria-label="还原">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 14 4 9 9 4"></polyline><path d="M20 20v-7a4 4 0 0 0-4-4H4"></path></svg>
            </button>
            <button data-act="purge" title="永久删除" aria-label="永久删除">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>`
        }
      </span>
    `;
    // 行点击 → 打开 (trash 视图不打开,只用按钮 restore / purge)
    li.addEventListener("click", (e) => {
      if (e.target.closest(".row-actions")) return;
      if (drawerView === "papers") openPaper(item);
    });
    const actsEl = li.querySelector(".row-actions");
    actsEl?.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      e.stopPropagation();
      const act = btn.dataset.act;
      if (act === "rename") startRename(li, item);
      else if (act === "trash") trashPaper(item);
      else if (act === "restore") restorePaper(item);
      else if (act === "purge") purgePaper(item);
    });
    docList.appendChild(li);
  }

  updateCacheStats();
}

async function updateCacheStats() {
  try {
    const bytes = await cache.totalBytes();
    cacheStatsText.textContent = `缓存 ${cache.formatBytes(bytes)}`;
  } catch (_) {
    cacheStatsText.textContent = "缓存 -";
  }
}

// ── Inline rename ────────────────────────────────────────────────────────

function startRename(rowEl, item) {
  const nameEl = rowEl.querySelector(".name");
  const current = fileNameToTitle(item.name);
  const input = document.createElement("input");
  input.type = "text";
  input.className = "name-input";
  input.value = current;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = async () => {
    const next = sanitizeFilename(input.value);
    if (!next || next === current) {
      cancel();
      return;
    }
    const newName = ensurePdfExt(next);
    try {
      setSyncStatus("改名中…");
      const updated = await renameItem(item.id, newName, item.eTag);
      item.name = updated.name;
      item.eTag = updated.eTag;
      setSyncStatus("已同步");
      // 当前正在读的话同步顶栏
      if (currentDocId === item.id) {
        currentTitle.textContent = fileNameToTitle(updated.name);
      }
      await renderDocList();
    } catch (e) {
      console.warn("rename 失败", e);
      setSyncStatus(`改名失败: ${e.message}`, { error: true });
      cancel();
    }
  };
  const cancel = () => {
    const span = document.createElement("span");
    span.className = "name";
    span.textContent = current;
    input.replaceWith(span);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    else if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

// ── Trash actions ────────────────────────────────────────────────────────

async function getTrashFolderId() {
  if (trashFolderIdCache) return trashFolderIdCache;
  trashFolderIdCache = await ensureSubfolder(TRASH_FOLDER);
  return trashFolderIdCache;
}

async function trashPaper(item) {
  if (!confirm(`把「${fileNameToTitle(item.name)}」移到垃圾箱?`)) return;
  try {
    setSyncStatus("移动中…");
    const trashId = await getTrashFolderId();
    await moveItemToFolder(item.id, trashId);
    // 删本地 cache 让空间能给别的论文
    await cache.del(item.id).catch(() => {});
    // 当前正读的就是它 → teardown + 切到 lastActive 或空
    if (currentDocId === item.id) {
      teardownCurrent();
      currentDocId = null;
      currentTitle.textContent = "";
      pageStatus.textContent = "";
      outlineButton.hidden = true;
      renderOutline([]);
      // session.lastActive 也清掉
      forgetDoc(item.id);
      showLanding({ title: "已移到垃圾箱", hint: "选另一篇,或上传新的。", showUpload: true });
    } else {
      forgetDoc(item.id);
    }
    setSyncStatus("已同步");
    await renderDocList();
  } catch (e) {
    console.warn("trash 失败", e);
    setSyncStatus(`移动失败: ${e.message}`, { error: true });
  }
}

async function restorePaper(item) {
  try {
    setSyncStatus("还原中…");
    const rootId = await getApprootId();
    // 先 ensure papers folder
    const papersId = await ensureSubfolder(PAPERS_FOLDER);
    await moveItemToFolder(item.id, papersId);
    setSyncStatus("已同步");
    await renderDocList();
  } catch (e) {
    console.warn("restore 失败", e);
    setSyncStatus(`还原失败: ${e.message}`, { error: true });
  }
}

async function purgePaper(item) {
  if (!confirm(`永久删除「${fileNameToTitle(item.name)}」?不可撤销。`)) return;
  try {
    setSyncStatus("删除中…");
    await deleteItem(item.id);
    await cache.del(item.id).catch(() => {});
    forgetDoc(item.id);
    setSyncStatus("已同步");
    await renderDocList();
  } catch (e) {
    console.warn("purge 失败", e);
    setSyncStatus(`删除失败: ${e.message}`, { error: true });
  }
}

async function emptyAllTrash() {
  if (!confirm("清空垃圾箱,所有文件永久删除?")) return;
  try {
    setSyncStatus("清空中…");
    for (const it of trashItemsCache) {
      try { await deleteItem(it.id); } catch (_) {}
      cache.del(it.id).catch(() => {});
      forgetDoc(it.id);
    }
    setSyncStatus("已同步");
    await renderDocList();
  } catch (e) {
    console.warn("empty trash 失败", e);
    setSyncStatus(`失败: ${e.message}`, { error: true });
  }
}

// ── 打开 (load) 一篇论文 ─────────────────────────────────────────────────

async function openPaper(item) {
  hideLanding();
  closeDrawer();
  currentDocId = item.id;
  currentTitle.textContent = fileNameToTitle(item.name);
  pageStatus.textContent = "";
  setSyncStatus("加载中…");
  setLastActive(item.id);
  ensureDoc(item.id, { addedAt: Date.parse(item.createdDateTime || "") || Date.now() });

  // 1) 试 cache
  let blob = null;
  try { blob = await cache.getBlob(item.id); } catch (_) {}
  if (blob) {
    cache.touch(item.id).catch(() => {});
    showProgress(null);
  } else {
    // 2) Graph 下载,显示进度条
    showProgress(0);
    try {
      const { blob: downloaded } = await downloadItemBlob(item.id);
      blob = downloaded;
      cache.set(item.id, blob, { name: item.name, eTag: item.eTag }).catch((e) => {
        console.warn("cache.set 失败", e);
      });
    } catch (e) {
      console.warn("下载失败", e);
      setSyncStatus(`下载失败: ${e.message}`, { error: true });
      showProgress(null);
      showLanding({
        title: "加载失败",
        hint: e.message,
        showUpload: false,
      });
      return;
    }
    showProgress(null);
  }

  // 3) 进 viewer
  try {
    const pos = getPosition(item.id);
    await loadPdf({ docId: item.id, data: blob, position: pos });
    // 页号让 onPagePeek 自己跑;sync status 让 tickSyncStatus 接管。这里不主动写。
    if (pos) pageStatus.textContent = `p.${pos.pageIndex + 1}`;
    // 高亮 drawer 里这一行(下次 render 也会高亮)
    for (const el of docList.querySelectorAll(".doc-row.active")) {
      el.classList.remove("active");
    }
    const row = docList.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
    if (row) row.classList.add("active");
    // 新论文 → 重算 outline
    refreshOutline();
  } catch (e) {
    console.warn("loadPdf 失败", e);
    setSyncStatus(`渲染失败: ${e.message}`, { error: true });
    showLanding({ title: "渲染失败", hint: e.message, showUpload: false });
    outlineButton.hidden = true;
    renderOutline([]);
  }
}

// 顶栏页号:rAF 节流,直接从 viewer onPagePeek 来。realtime,不 debounce。
function onPagePeekFromViewer(pageIndex) {
  if (currentDocId) pageStatus.textContent = `p.${pageIndex + 1}`;
}

// ── Outline (PDF 章节目录) ───────────────────────────────────────────────

function renderOutline(nodes) {
  outlineList.innerHTML = "";
  if (!nodes || nodes.length === 0) {
    outlineEmpty.classList.remove("hidden");
    return;
  }
  outlineEmpty.classList.add("hidden");
  for (const node of nodes) {
    outlineList.appendChild(buildOutlineItem(node, 0));
  }
}

function buildOutlineItem(node, depth) {
  const li = document.createElement("li");
  li.className = "outline-row";
  const row = document.createElement("div");
  row.className = "outline-item";
  row.style.paddingLeft = `${12 + depth * 14}px`;
  const hasChildren = node.items && node.items.length > 0;
  const twisty = document.createElement("span");
  twisty.className = "twisty";
  twisty.textContent = hasChildren ? "▾" : "";
  const label = document.createElement("span");
  label.className = "label";
  label.textContent = node.title || "(无标题)";
  if (node.bold) label.style.fontWeight = "600";
  if (node.italic) label.style.fontStyle = "italic";
  row.append(twisty, label);
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    // 如果点的是 twisty,只折叠/展开,不跳
    if (e.target === twisty && hasChildren) {
      const kidsEl = li.querySelector(".outline-children");
      if (kidsEl) {
        const collapsed = kidsEl.classList.toggle("collapsed");
        twisty.textContent = collapsed ? "▸" : "▾";
      }
      return;
    }
    if (node.dest) {
      // 高亮 active
      for (const el of outlineList.querySelectorAll(".outline-item.active")) {
        el.classList.remove("active");
      }
      row.classList.add("active");
      jumpToDest(node.dest);
      // 跳转是明确意图,等 viewer scroll 沉淀 + setPosition 报告 → 立刻 push,不等 debounce
      // 连击只保留最后一个 timer
      if (outlineJumpFlushTimer) clearTimeout(outlineJumpFlushTimer);
      outlineJumpFlushTimer = setTimeout(() => {
        outlineJumpFlushTimer = null;
        flush().catch(() => {});
      }, 800);
    }
  });
  li.appendChild(row);
  if (hasChildren) {
    const kids = document.createElement("ul");
    kids.className = "outline-children";
    for (const child of node.items) {
      kids.appendChild(buildOutlineItem(child, depth + 1));
    }
    li.appendChild(kids);
  }
  return li;
}

async function refreshOutline() {
  try {
    const outline = await getOutline();
    renderOutline(outline);
    outlineButton.hidden = !outline || outline.length === 0;
  } catch (e) {
    console.warn("outline load failed", e);
    renderOutline([]);
    outlineButton.hidden = true;
  }
}

// ── Ingestion: 本地上传 ───────────────────────────────────────────────────

async function uploadFiles(files) {
  if (!files || !files.length) return;
  if (!isSignedIn()) {
    alert("请先登录");
    return;
  }
  closeDrawer();
  showProgress(0);
  setSyncStatus("上传中…");
  try {
    let lastUploaded = null;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const desired = await deriveFileName(f);
      // path = papers/<desired>
      const targetName = ensurePdfExt(sanitizeFilename(desired));
      // ensure /papers/ 存在 (uploadFileToApproot 写 path 时,OneDrive 会自动建中间文件夹)
      const item = await uploadFileToApproot(`${PAPERS_FOLDER}/${targetName}`, f, "application/pdf");
      // session: ensure doc
      ensureDoc(item.id, { addedAt: Date.now() });
      // 进度
      showProgress((i + 1) / files.length);
      lastUploaded = item;
    }
    setSyncStatus("已同步");
    showProgress(null);
    // 上传完自动打开最后一份
    if (lastUploaded) {
      // 拿一次 meta 拿 downloadUrl 之类(uploadFileToApproot 已经返回够用的 driveItem)
      await openPaper(lastUploaded);
    } else {
      await renderDocList();
    }
  } catch (e) {
    console.warn("upload 失败", e);
    setSyncStatus(`上传失败: ${e.message}`, { error: true });
    showProgress(null);
    alert(`上传失败: ${e.message}`);
  }
}

// 决定上传文件的目标名:
//   优先 PDF metadata Title (经过 cleanTitle + 质量门),
//   不靠谱就 fallback 到原文件名(去后缀)
//
// 为什么需要质量门:LaTeX 工具链(dvipdfm 等)经常把 /Title 写成 "superspace4.dvi"
// 这种源文件名;Word 导出的会带 "Microsoft Word - " 前缀;有些是 "Untitled" / 空。
async function deriveFileName(file) {
  let title = "";
  try {
    const buf = await file.arrayBuffer();
    const pdfjs = await import("https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs";
    const doc = await pdfjs.getDocument({ data: buf }).promise;
    const meta = await doc.getMetadata();
    title = cleanPdfTitle(meta?.info?.Title || "");
    doc.destroy();
  } catch (e) {
    console.warn("PDF metadata 读失败,fallback 到原名", e);
  }
  if (isUsableTitle(title)) return title;
  return file.name.replace(/\.pdf$/i, "");
}

function cleanPdfTitle(raw) {
  let t = String(raw || "").trim();
  // 剥掉 Word 导出的前缀:"Microsoft Word - actual_title.docx"
  t = t.replace(/^Microsoft Word\s*-\s*/i, "");
  // 剥掉 LaTeX / Word / InDesign / TeX 工具链留下的源文件扩展名
  t = t.replace(/\.(dvi|tex|ps|docx?|indd|pdf|aux|toc|out|fdb_latexmk)$/i, "");
  return t.trim();
}

function isUsableTitle(t) {
  if (!t) return false;
  if (t.length < 5) return false;                  // 太短大概率不是标题
  if (/^untitled\b/i.test(t)) return false;        // "Untitled" / "Untitled-1"
  // 没空格 + 有点 = 看起来像个文件名 / arxiv id,不要
  if (!/\s/.test(t) && /\./.test(t)) return false;
  return true;
}

// ── 启动序列 (the jumpscare) ─────────────────────────────────────────────

async function jumpscare() {
  // session 已 init 完毕,看 lastActive
  const st = getState();
  const lastId = st.lastActive;
  if (!lastId) {
    showLanding({
      title: papersItems.length === 0 ? "还没有论文" : "选一篇开始",
      hint: papersItems.length === 0 ? "点左上角菜单,上传 PDF。" : "点左上角菜单选一篇。",
      showUpload: true,
    });
    return;
  }
  // 找当前 papers 列表里有没有
  let item = papersItems.find((p) => p.id === lastId);
  if (!item) {
    // 可能 lastActive 是另一台设备 trash 掉的;或者 papers 列表还没拉到
    try {
      item = await getItemMeta(lastId);
    } catch (_) {
      // 找不到 → 清掉 lastActive,落到 landing
      console.warn("lastActive 找不到了:", lastId);
      // 不调 forgetDoc,可能只是 trash;留着 doc 状态
      showLanding({
        title: "上次的论文不见了",
        hint: "可能已被另一台设备删除。选一篇或上传新的。",
        showUpload: true,
      });
      return;
    }
  }
  await openPaper(item);
}

// ── reconcile (window focus + idle) ──────────────────────────────────────

async function reconcileOnFocus() {
  if (!isSignedIn()) return;
  try {
    const changed = await checkRemoteChanged();
    if (changed) showUpdateToast("session", "云端有更新", "同步");
  } catch (_) {}
}

// updateMode = "session" (远端 session.json 变了 → reload session) |
//             "site" (GH Pages 部署有新版本 → SW skip-waiting + 整页 reload)
let updateMode = null;

function showUpdateToast(mode, text, reloadLabel) {
  updateMode = mode;
  $("updateToastText").textContent = text;
  $("updateToastReload").textContent = reloadLabel;
  updateToast.classList.remove("hidden");
}
function hideUpdateToast() {
  updateToast.classList.add("hidden");
  updateMode = null;
}

async function applyRemoteUpdate() {
  hideUpdateToast();
  updateMode = null;
  try {
    setSyncStatus("同步中…");
    await reloadFromRemote();
    const st = getState();
    // 远端 lastActive 跟本地当前 viewer 不一样 → 切过去
    if (st.lastActive && st.lastActive !== currentDocId) {
      await renderDocList();
      // 拿到 driveItem(优先用刚 list 的;不然 meta 查)
      let item = papersItems.find((p) => p.id === st.lastActive);
      if (!item) {
        try { item = await getItemMeta(st.lastActive); }
        catch (_) { item = null; }
      }
      if (item) await openPaper(item);
    } else if (currentDocId) {
      // 还是同一篇,但 position 可能被另一端更新了 → restore 到 remote 位置
      const pos = getPosition(currentDocId);
      if (pos) restorePosition(pos);
      await renderDocList();
    } else {
      await renderDocList();
    }
    setSyncStatus("synced");
  } catch (e) {
    setSyncStatus(`同步失败: ${e.message}`, { error: true });
  }
}

// idle: N 分钟没操作 → 弹蒙层提示 "点击同步"
function resetIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleOverlay.classList.add("hidden");
  idleTimer = setTimeout(() => {
    idleOverlay.classList.remove("hidden");
  }, IDLE_MS);
}
["mousemove", "keydown", "wheel", "touchstart", "scroll"].forEach((ev) => {
  window.addEventListener(ev, resetIdle, { passive: true, capture: true });
});

idleOverlay.addEventListener("click", async () => {
  idleOverlay.classList.add("hidden");
  resetIdle();
  await applyRemoteUpdate();
});

// ── Position write-back ──────────────────────────────────────────────────

function onPositionFromViewer(pos) {
  if (!currentDocId || !pos) return;
  setPosition(currentDocId, pos);
  pageStatus.textContent = `p.${pos.pageIndex + 1}`;
}

// 离开页面时 keepalive flush;切后台也试一次普通 flush
window.addEventListener("beforeunload", () => {
  flushKeepalive();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flush().catch(() => {});
    flushKeepalive();
  }
});
// pagehide 在移动 / iOS 上比 beforeunload 更可靠
window.addEventListener("pagehide", () => {
  flush().catch(() => {});
  flushKeepalive();
});
window.addEventListener("focus", reconcileOnFocus);
// 重新上网 → 把离线时堆的 dirty session 推一次,并刷新论文列表
window.addEventListener("online", () => {
  flush().catch(() => {});
  if (drawerView === "papers") renderDocList().catch(() => {});
});

// ── Wiring ───────────────────────────────────────────────────────────────

menuButton.addEventListener("click", () => toggleDrawer("papers"));
outlineButton.addEventListener("click", () => toggleDrawer("outline"));
drawerCloseButton.addEventListener("click", closeDrawer);
outlineCloseButton.addEventListener("click", closeDrawer);
drawerBackdrop.addEventListener("click", closeDrawer);

fitWidthButton.addEventListener("click", fitToWidth);
zoomInButton.addEventListener("click", () => zoomBy(1.15));
zoomOutButton.addEventListener("click", () => zoomBy(1 / 1.15));
spreadButton.addEventListener("click", () => {
  // 单页 ↔ 全程双页(even),不引入 odd 那个变体(对论文用处不大)
  const cur = getSpreadMode();
  setSpreadMode(cur === 0 ? 2 : 0);
});

overviewButton.addEventListener("click", () => {
  setOverviewVisible(!isOverviewVisible());
});

screenshotButton.addEventListener("click", async () => {
  if (!currentDocId) {
    setSyncStatus("没有正在读的论文", { error: true });
    return;
  }
  if (!navigator.clipboard?.write || !window.ClipboardItem) {
    setSyncStatus("浏览器不支持剪贴板写图", { error: true });
    return;
  }
  try {
    const blob = await snapshotCurrentPage();
    if (!blob) { setSyncStatus("截图失败", { error: true }); return; }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    setSyncStatus("已截图到剪贴板");
  } catch (e) {
    setSyncStatus(`截图失败: ${e.message}`, { error: true });
  }
});

copyTextButton.addEventListener("click", async () => {
  if (!currentDocId) {
    setSyncStatus("没有正在读的论文", { error: true });
    return;
  }
  if (!navigator.clipboard?.writeText) {
    setSyncStatus("浏览器不支持剪贴板", { error: true });
    return;
  }
  try {
    const text = await extractCurrentPageText();
    if (!text) { setSyncStatus("当前页无可提取文本", { error: true }); return; }
    await navigator.clipboard.writeText(text);
    setSyncStatus(`已复制 ${text.length} 字`);
  } catch (e) {
    setSyncStatus(`复制失败: ${e.message}`, { error: true });
  }
});

// Esc 退出概览
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && isOverviewVisible()) {
    setOverviewVisible(false);
  }
});

// 在缩略图上点击 → 退出概览 + 主 viewer 跳到对应页 + 立刻 flush (明确意图)
// 注意:必须先 setOverviewVisible(false),否则 viewer container 还是 display:none,
// pdf.js 的 scrollIntoView no-op,跳不动。
thumbContainer.addEventListener("click", (e) => {
  const thumb = e.target.closest(".thumb-card");
  if (!thumb) return;
  const pn = parseInt(thumb.dataset.pageNumber, 10);
  if (!pn || isNaN(pn)) return;
  e.preventDefault();
  setOverviewVisible(false);
  // 等 layout 把 viewer container 恢复可见,再跳页
  requestAnimationFrame(() => {
    requestAnimationFrame(() => goToPage(pn));
  });
  if (outlineJumpFlushTimer) clearTimeout(outlineJumpFlushTimer);
  outlineJumpFlushTimer = setTimeout(() => {
    outlineJumpFlushTimer = null;
    flush().catch(() => {});
  }, 800);
});

drawerSortButton.addEventListener("click", async () => {
  sortMode = sortMode === "modified" ? "name" : "modified";
  localStorage.setItem(SORT_KEY, sortMode);
  await renderDocList();
});
drawerRefreshButton.addEventListener("click", async () => {
  await renderDocList();
});

uploadButton.addEventListener("click", () => fileInput.click());
emptyUploadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const files = Array.from(fileInput.files || []);
  fileInput.value = "";
  uploadFiles(files);
});

openTrashButton.addEventListener("click", async () => {
  drawerView = "trash";
  drawerTitle.textContent = "垃圾箱";
  papersActions.classList.add("hidden");
  trashActions.classList.remove("hidden");
  await renderDocList();
});
backFromTrashButton.addEventListener("click", async () => {
  drawerView = "papers";
  drawerTitle.textContent = "论文";
  papersActions.classList.remove("hidden");
  trashActions.classList.add("hidden");
  await renderDocList();
});
emptyTrashButton.addEventListener("click", emptyAllTrash);

loginButton.addEventListener("click", async () => {
  try { await signIn(); }
  catch (e) { alert(`登录失败: ${e.message}`); }
});
logoutButton.addEventListener("click", async () => {
  await signOut();
  refreshAuthRow(null);
  await renderDocList();
  showLanding({ title: "已登出", hint: "再登录就能继续上次的论文。", showUpload: false });
});

// ── Theme cycle (day → night → auto) ────────────────────────────────────

const THEME_LABELS = { day: "日", night: "夜", auto: "跟随系统" };

function applyTheme() {
  const m = localStorage.getItem(THEME_KEY) || "auto";
  document.documentElement.setAttribute("data-theme", m);
  if (themeLabel) themeLabel.textContent = THEME_LABELS[m] || "跟随系统";
}
applyTheme();

themeButton?.addEventListener("click", () => {
  const order = ["auto", "day", "night"];
  const cur = localStorage.getItem(THEME_KEY) || "auto";
  const next = order[(order.indexOf(cur) + 1) % order.length];
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
});

// 系统暗色变化时,如果当前是 auto,标签不变(还是"跟随系统"),
// 但 CSS 的 @media (prefers-color-scheme: dark) + data-theme="auto" 已自动切色,
// 不需要额外操作 —— theme-color meta 通过 media-aware 写法已经分别声明,浏览器自管。

updateToastReload.addEventListener("click", async () => {
  if (updateMode === "site") {
    hideUpdateToast();
    // 把 session 先 keepalive flush 一份再 reload,免得位置丢
    flushKeepalive();
    try { navigator.serviceWorker.controller?.postMessage({ type: "skip-waiting" }); } catch (_) {}
    location.reload();
    return;
  }
  if (updateMode === "session") {
    await applyRemoteUpdate();
    return;
  }
  hideUpdateToast();
});
updateToastDismiss.addEventListener("click", hideUpdateToast);

// ── Drag-and-drop 上传 ───────────────────────────────────────────────────
// 监听整个 window,因为 dragleave 在进入子元素时也会 fire 一次,得用 counter
// 防抖。dragover 必须 preventDefault,否则 drop 不会触发。

let dragDepth = 0;

function dtHasFiles(dt) {
  if (!dt) return false;
  if (dt.types) {
    for (const t of dt.types) {
      if (t === "Files" || t === "application/x-moz-file") return true;
    }
  }
  return false;
}

window.addEventListener("dragenter", (e) => {
  if (!dtHasFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth += 1;
  dropOverlay.classList.remove("hidden");
});

window.addEventListener("dragover", (e) => {
  if (!dtHasFiles(e.dataTransfer)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});

window.addEventListener("dragleave", (e) => {
  if (!dtHasFiles(e.dataTransfer)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add("hidden");
});

window.addEventListener("drop", (e) => {
  if (!dtHasFiles(e.dataTransfer)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add("hidden");
  const files = Array.from(e.dataTransfer.files || []).filter(
    (f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf",
  );
  if (files.length === 0) {
    setSyncStatus("不是 PDF,忽略");
    return;
  }
  uploadFiles(files);
});

// ── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // viewer 先 init —— 即使没登录也可以拖个本地 PDF 进来看 (将来),
  // 现在主要是为了启动期不重复加载 pdf.js
  await initViewer({
    containerEl: viewerContainer,
    thumbContainerEl: thumbContainer,
    onPosition: onPositionFromViewer,
    onPagePeek: onPagePeekFromViewer,
  });
  if (!canOverview()) overviewButton.hidden = true;

  let authResult;
  try {
    authResult = await initAuth();
  } catch (e) {
    console.warn("auth init 失败", e);
    showLanding({
      title: "登录初始化失败",
      hint: e.message,
      showUpload: false,
    });
    return;
  }

  refreshAuthRow(authResult.account);

  if (!authResult.signedIn) {
    // 没登录(包括 probedAccount 那种 "缓存账号但本 app 未授权")
    showLanding({
      title: authResult.probedAccount ? "需要授权" : "请登录 OneDrive",
      hint: authResult.probedAccount
        ? `检测到账号 ${authResult.probedAccount.username},点登录授权本 app。`
        : "登录一次,以后纯 URL 就能继续读。",
      showUpload: false,
    });
    return;
  }

  // 已登录:并发 init session + 列文件 → 然后 jumpscare
  setSyncStatus("加载…");
  try {
    await Promise.all([
      initSession(),
      (async () => { try { papersItems = await listChildren(PAPERS_FOLDER); } catch (_) { papersItems = []; } })(),
    ]);
    papersItems = papersItems.filter((i) => i.file && /\.pdf$/i.test(i.name || ""));
    setSyncStatus("synced");
  } catch (e) {
    console.warn("init session 失败", e);
    setSyncStatus(`session 加载失败: ${e.message}`, { error: true });
  }

  await jumpscare();
  // drawer 默认不开,但先 render 一次让用户打开时是最新的
  await renderDocList();
  resetIdle();
}

main().catch((e) => {
  console.error("启动失败", e);
  setSyncStatus(`启动失败: ${e.message}`, { error: true });
});

// ── Service worker registration ──────────────────────────────────────────

// SW 注册 + 热更新检测。三条检测路径,各覆盖不同场景:
//   A. fetch handler 里 eTag/length diff → postMessage "asset-updated"
//      → 适合:tab 一直开着,SW 后台 revalidate 发现新版本
//   B. registration.updatefound + newWorker.statechange="installed"
//      → 适合:本次访问期间发现 SW 源换了(主要触发路径)
//   C. 启动时 registration.waiting 已存在 + 当前 controller 存在
//      → 适合:上次访问已装好新 SW 但当时用户没刷,这次冷启动直接报
//
// iOS PWA 关键:从主屏冷启动,fetch 多半全走 cache(A 不 fire),靠 B/C 兜底。
// 本地开发不注册 SW(F5 时缓存会捣乱)。
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // A
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "asset-updated") {
      showUpdateToast("site", "本站有新版本", "刷新");
    }
  });

  window.addEventListener("load", async () => {
    let reg;
    try {
      reg = await navigator.serviceWorker.register("./service-worker.js");
      console.log("SW registered", reg.scope);
    } catch (e) {
      console.warn("SW register failed", e);
      return;
    }

    // C
    if (reg.waiting && navigator.serviceWorker.controller) {
      showUpdateToast("site", "本站有新版本", "刷新");
    }

    // B
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) {
          showUpdateToast("site", "本站有新版本", "刷新");
        }
      });
    });
  });
}
