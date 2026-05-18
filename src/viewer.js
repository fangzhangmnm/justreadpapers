// pdf.js 全屏连续滚动 viewer + reading-line 位置恢复。
//
// 关键设计:
//  - 位置坐标是 {pageIndex, yFraction} (PDF 文档坐标),不是 viewport 像素。
//  - reading-line 钉死在 viewport 高度的 READING_LINE_ANCHOR 处(默认 25%)。
//    存:取当前滚动位置 → 找 reading-line 落在哪一页的哪个 yFraction。
//    恢:把 (pageIndex, yFraction) 算成像素后,scrollTop 设到能让那一点落在 anchor 处。
//  - zoom / fit-mode 是设备属性,存 localStorage,不上 session.json。
//  - 滚动事件 → 报告新位置(节流),由 app.js 决定要不要 setPosition。

import { READING_LINE_ANCHOR } from "./config.js";

const PDFJS_VERSION = "4.10.38";
const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
// fallback CDN
const PDFJS_BASE_FB = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}`;

const ZOOM_KEY = "jrp.zoom";

let pdfjsLib = null;
let pdfViewerNs = null;
let viewer = null;
let linkService = null;
let eventBus = null;
let container = null;
let currentPdf = null;
let currentDocId = null;
let pendingRestore = null;
let scrollHandler = null;
let onPositionChange = null;
let saveTimer = null;
let saveDelayMs = 800;

async function loadModule(rel) {
  const urls = [`${PDFJS_BASE}/${rel}`, `${PDFJS_BASE_FB}/${rel}`];
  let last = null;
  for (const u of urls) {
    try {
      return await import(/* @vite-ignore */ u);
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`pdf.js 加载失败 (${rel}): ${last?.message ?? "?"}`);
}

async function ensureLib() {
  if (pdfjsLib && pdfViewerNs) return;
  [pdfjsLib, pdfViewerNs] = await Promise.all([
    loadModule("build/pdf.mjs"),
    loadModule("web/pdf_viewer.mjs"),
  ]);
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
}

export async function initViewer({ containerEl, onPosition }) {
  await ensureLib();
  container = containerEl;
  onPositionChange = onPosition;

  eventBus = new pdfViewerNs.EventBus();
  linkService = new pdfViewerNs.PDFLinkService({ eventBus });
  viewer = new pdfViewerNs.PDFViewer({
    container,
    eventBus,
    linkService,
    // 连续垂直滚动模式
    // (默认就是,但显式写出更清楚)
  });
  linkService.setViewer(viewer);

  eventBus.on("pagesinit", () => {
    // 应用上次的 fit/zoom (device-local)
    const saved = localStorage.getItem(ZOOM_KEY);
    viewer.currentScaleValue = saved || "page-width";
    // pages 都 init 完了,如果有 pendingRestore 立刻执行
    if (pendingRestore) {
      const p = pendingRestore;
      pendingRestore = null;
      restorePosition(p);
    }
  });

  // 页面渲染过程中尺寸会变,继续追加 restore 直到稳定
  eventBus.on("pagesloaded", () => {
    if (pendingRestore) {
      const p = pendingRestore;
      pendingRestore = null;
      restorePosition(p);
    }
  });

  // 用户改了 zoom (Ctrl+wheel / 按钮) → 保存
  eventBus.on("scalechanging", (evt) => {
    try {
      // 优先存语义值(如 "page-width"),没就存数字
      const val = viewer.currentScaleValue;
      if (typeof val === "string" && isNaN(parseFloat(val))) {
        localStorage.setItem(ZOOM_KEY, val);
      } else {
        localStorage.setItem(ZOOM_KEY, String(evt.scale));
      }
    } catch (_) {}
  });

  scrollHandler = () => {
    // restore 期间不要回报 (防止覆盖即将恢复到的位置)
    if (isRestoring) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      const p = currentPosition();
      if (p && onPositionChange) onPositionChange(p);
    }, saveDelayMs);
  };
  container.addEventListener("scroll", scrollHandler, { passive: true });
}

// 加载一个 PDF (blob 或 ArrayBuffer)
// position = 可选的 {pageIndex, yFraction}
export async function loadPdf({ docId, data, position }) {
  if (!viewer) throw new Error("viewer 未 init");
  currentDocId = docId;
  // 清掉上一篇
  if (currentPdf) {
    try { currentPdf.destroy(); } catch (_) {}
    currentPdf = null;
  }
  pendingRestore = position || null;

  // pdf.js 接 ArrayBuffer 比 Blob 直接,但都能接
  let docData = data;
  if (data instanceof Blob) {
    docData = await data.arrayBuffer();
  }

  const loadingTask = pdfjsLib.getDocument({
    data: docData,
    // 字体子集/标准字体目录
    cMapUrl: `${PDFJS_BASE}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
  });
  currentPdf = await loadingTask.promise;
  viewer.setDocument(currentPdf);
  linkService.setDocument(currentPdf);
  return currentPdf;
}

// 取页数(渲染完后)
export function getNumPages() {
  return currentPdf?.numPages ?? 0;
}

// 取/恢 PDF metadata
export async function getPdfMetadata() {
  if (!currentPdf) return null;
  try {
    const m = await currentPdf.getMetadata();
    return m;
  } catch (_) {
    return null;
  }
}

let isRestoring = false;

// 把 {pageIndex, yFraction} 还原成 scrollTop,reading-line 落在 viewport 25% 处。
// 需要 pageView 已经被 build (offsetTop / offsetHeight 可读),否则啥都不做。
export function restorePosition({ pageIndex, yFraction }) {
  if (!viewer) return false;
  const pv = viewer.getPageView(pageIndex);
  if (!pv?.div) {
    pendingRestore = { pageIndex, yFraction };
    return false;
  }
  const pageTop = pv.div.offsetTop;
  const pageH = pv.div.offsetHeight;
  if (!pageH) {
    pendingRestore = { pageIndex, yFraction };
    return false;
  }
  const readingLineY = pageTop + pageH * yFraction;
  const desiredScrollTop = readingLineY - container.clientHeight * READING_LINE_ANCHOR;
  isRestoring = true;
  container.scrollTop = Math.max(0, desiredScrollTop);
  // 一帧后释放;期间渲染可能触发布局重排,需要再 nudge 一次
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      // 再算一遍校准(有时候 page-width 在首次渲染后 reflow)
      const pv2 = viewer.getPageView(pageIndex);
      if (pv2?.div?.offsetHeight) {
        const recompute = pv2.div.offsetTop + pv2.div.offsetHeight * yFraction
          - container.clientHeight * READING_LINE_ANCHOR;
        container.scrollTop = Math.max(0, recompute);
      }
      isRestoring = false;
    });
  });
  return true;
}

// 取当前 reading-line 落在哪页 / 哪 yFraction
export function currentPosition() {
  if (!viewer || !container) return null;
  const pages = viewer.pagesCount;
  if (!pages) return null;
  const readingLineY = container.scrollTop + container.clientHeight * READING_LINE_ANCHOR;
  for (let i = 0; i < pages; i++) {
    const pv = viewer.getPageView(i);
    if (!pv?.div) continue;
    const top = pv.div.offsetTop;
    const h = pv.div.offsetHeight;
    if (!h) continue;
    if (readingLineY >= top && readingLineY < top + h) {
      return { pageIndex: i, yFraction: (readingLineY - top) / h };
    }
  }
  // 兜底
  if (readingLineY < 0) return { pageIndex: 0, yFraction: 0 };
  return { pageIndex: pages - 1, yFraction: 1 };
}

export function teardownCurrent() {
  if (currentPdf) {
    try { currentPdf.destroy(); } catch (_) {}
    currentPdf = null;
  }
  if (viewer) viewer.setDocument(null);
  currentDocId = null;
  pendingRestore = null;
}

export function getCurrentDocId() {
  return currentDocId;
}
