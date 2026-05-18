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

const ZOOM_KEY_PREFIX = "jrp.zoom:";  // per-doc 缩放比率,key 后接 docId
const SPREAD_KEY = "jrp.spread";  // "0" (none) | "1" (odd: 单封面后 2+3...) | "2" (even: 1+2, 3+4...)

let pdfjsLib = null;
let pdfViewerNs = null;
let viewer = null;
let thumbViewer = null;
let renderingQueue = null;
let thumbContainer = null;
let linkService = null;
let eventBus = null;
let container = null;
let currentPdf = null;
let currentDocId = null;
let pendingRestore = null;
let scrollHandler = null;
let onPositionChange = null;
let onPagePeek = null;       // realtime,每帧报当前 pageIndex (rAF throttled)
let pagePeekRaf = null;
let saveTimer = null;
let saveDelayMs = 500;  // scroll 停 → 算 position → 报 setPosition (内存),再交给 session 节流
let programmaticScale = false;

// 每页阅读宽度上限 9 英寸(@ 96 CSS px/inch = 864 px ≈ A4 全宽)。
// 单页:render 单元 = 1 页 → 上限 9";
// 双页:render 单元 = 2 页 → 上限 18" → 每页 ≤ 9"。
// 容器比上限小就 fit 容器(原则:大屏不占满,小屏占满,Quest / phone / spread 同理)。
// 下限 scale 0.1 让真窄的屏不被卡住。
const TARGET_INCHES_PER_PAGE = 9;
const CSS_PX_PER_INCH = 96;
// 容器宽度里给 .page / .spread 的 1px border 各两侧 + 一点呼吸,够避免 1-2px 横向溢出
const PAGE_BORDER_RESERVE = 4;

function computeCozyScale() {
  try {
    const pv = viewer.getPageView(0);
    if (!pv) return null;
    const vp = pv.viewport;
    if (!vp) return null;
    const naturalCssWidth = vp.width / vp.scale;
    const availCss = container.clientWidth - PAGE_BORDER_RESERVE;
    const isSpread = !!(viewer.spreadMode && viewer.spreadMode !== 0);
    const pagesPerRow = isSpread ? 2 : 1;
    const targetCss = Math.min(
      availCss,
      TARGET_INCHES_PER_PAGE * pagesPerRow * CSS_PX_PER_INCH,
    );
    if (targetCss <= 0) return null;
    const s = targetCss / (naturalCssWidth * pagesPerRow);
    return Math.max(0.1, Math.min(4, s));
  } catch (_) {
    return null;
  }
}

// 内部 cozy 应用 —— pagesinit / spread toggle / fit-width button 都走它
function applyAutoFit() {
  if (!viewer) return;
  programmaticScale = true;
  const s = computeCozyScale();
  if (s != null) viewer.currentScale = s;
  else viewer.currentScaleValue = "page-width";
  programmaticScale = false;
}

// 显式 fit-width 按钮:清掉本论文的 per-doc 保存值 + auto-fit 重新算一次
export function fitToWidth() {
  if (!viewer) return;
  if (currentDocId) {
    try { localStorage.removeItem(ZOOM_KEY_PREFIX + currentDocId); } catch (_) {}
  }
  applyAutoFit();
}

// 按比例 zoom in / out。scalechanging 会自动存 per-doc localStorage。
export function zoomBy(factor) {
  if (!viewer) return;
  const cur = viewer.currentScale || 1;
  const next = Math.max(0.1, Math.min(8, cur * factor));
  viewer.currentScale = next;
}

// Spread mode: 0=单页,1=封面单页+后续双页(odd),2=全程双页(even)。
// 切换后:auto-fit 重新算(因为渲染宽度变了,旧 scale 没意义了),并保留 reading-line。
export function setSpreadMode(mode) {
  if (!viewer) return;
  const pos = currentPosition();
  viewer.spreadMode = mode;
  try { localStorage.setItem(SPREAD_KEY, String(mode)); } catch (_) {}
  // pdf.js 异步 re-layout → 下一帧 auto-fit + 再下一帧 restore
  requestAnimationFrame(() => {
    applyAutoFit();
    requestAnimationFrame(() => {
      if (pos) restorePosition(pos);
    });
  });
}

export function getSpreadMode() {
  return viewer?.spreadMode ?? 0;
}

// 概览模式 —— pdfjs-dist 不暴露 PDFThumbnailViewer,自己 roll:
// CSS Grid 占位 .thumb-card,IntersectionObserver 进可见区才 render 那一页的小 canvas。
// 200 页论文也只渲染 ~10-20 张 (可视 + rootMargin 预取)。
let overviewOn = false;
let overviewIO = null;
let overviewRendered = new Set();  // pageNumber → 已渲染
let overviewBuiltForPdf = null;    // pdf instance,换论文要重建

export function canOverview() {
  return !!thumbContainer;
}

export function isOverviewVisible() {
  return overviewOn;
}

export function setOverviewVisible(visible) {
  if (!thumbContainer || !container) return;
  const want = !!visible;
  if (want === overviewOn) return;
  overviewOn = want;
  if (overviewOn) {
    if (overviewBuiltForPdf !== currentPdf) buildOverviewSkeleton();
    thumbContainer.classList.remove("hidden");
    container.classList.add("hidden");
    attachOverviewObserver();
    markCurrentThumb();
    // 滚到当前页
    const cur = viewer.currentPageNumber || 1;
    requestAnimationFrame(() => {
      const node = thumbContainer.querySelector(`[data-page-number="${cur}"]`);
      if (node) node.scrollIntoView({ block: "center", inline: "nearest" });
    });
  } else {
    thumbContainer.classList.add("hidden");
    container.classList.remove("hidden");
    if (overviewIO) { overviewIO.disconnect(); overviewIO = null; }
  }
}

function clearOverview() {
  if (overviewIO) { overviewIO.disconnect(); overviewIO = null; }
  if (thumbContainer) thumbContainer.innerHTML = "";
  overviewRendered.clear();
  overviewBuiltForPdf = null;
}

function buildOverviewSkeleton() {
  clearOverview();
  if (!currentPdf || !thumbContainer) return;
  const np = currentPdf.numPages;
  const frag = document.createDocumentFragment();
  for (let i = 1; i <= np; i++) {
    const card = document.createElement("div");
    card.className = "thumb-card";
    card.dataset.pageNumber = String(i);
    card.innerHTML = `<div class="thumb-canvas-wrap"></div><div class="thumb-label">${i}</div>`;
    frag.appendChild(card);
  }
  thumbContainer.appendChild(frag);
  overviewBuiltForPdf = currentPdf;
}

function attachOverviewObserver() {
  if (overviewIO) overviewIO.disconnect();
  overviewIO = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const card = entry.target;
      const pn = parseInt(card.dataset.pageNumber, 10);
      if (!pn || overviewRendered.has(pn)) continue;
      overviewRendered.add(pn);
      renderThumb(card, pn).catch((e) => {
        overviewRendered.delete(pn);
        console.warn("thumb render", pn, e);
      });
    }
  }, { root: thumbContainer, rootMargin: "400px" });
  for (const card of thumbContainer.querySelectorAll(".thumb-card")) {
    overviewIO.observe(card);
  }
}

async function renderThumb(card, pn) {
  if (!currentPdf) return;
  const pdf = currentPdf;
  const page = await pdf.getPage(pn);
  // 换 PDF 了就别画了
  if (pdf !== currentPdf) return;
  const wrap = card.querySelector(".thumb-canvas-wrap");
  if (!wrap) return;
  const targetCssWidth = wrap.clientWidth || 180;
  const vp1 = page.getViewport({ scale: 1 });
  const scale = targetCssWidth / vp1.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  // dpr cap 2 避免 200 页 × 4x 内存爆
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(vp.width * dpr);
  canvas.height = Math.round(vp.height * dpr);
  canvas.style.width = vp.width + "px";
  canvas.style.height = vp.height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // 渲染完发现 PDF 变了/容器没了 → 丢弃
  if (pdf !== currentPdf || !card.isConnected) return;
  wrap.innerHTML = "";
  wrap.appendChild(canvas);
}

function markCurrentThumb() {
  if (!thumbContainer || !viewer) return;
  const cur = viewer.currentPageNumber;
  for (const el of thumbContainer.querySelectorAll(".thumb-card.current")) {
    el.classList.remove("current");
  }
  const node = thumbContainer.querySelector(`[data-page-number="${cur}"]`);
  if (node) node.classList.add("current");
}

// 程序化跳到某一页 (1-based)。从缩略图点击进来,会先用这个跳主 viewer
export function goToPage(pageNumber) {
  if (!viewer) return;
  viewer.currentPageNumber = pageNumber;
}

// 提取当前 reading-line 那一页的文本(从 pdf.js 已经渲染的 text layer 拿)。
// LaTeX 公式: PDF 本身只存定位的 glyph,没源,所以你得到 "α+β" 这种,不是 \alpha+\beta。
// 想要真 LaTeX 要 .tex 源或 math OCR (MathPix),浏览器侧做不到。
export async function extractCurrentPageText() {
  if (!viewer || !currentPdf) return null;
  const pos = currentPosition();
  if (!pos) return null;
  // 优先用 pdf.js 的 getTextContent (更结构化,自己拼 reading order),
  // 拿不到再 fallback 到 text layer DOM 的 textContent。
  try {
    const page = await currentPdf.getPage(pos.pageIndex + 1);
    const tc = await page.getTextContent();
    // tc.items[i] = { str, hasEOL, transform, width, height, dir, fontName }
    // 简单拼接:有 EOL 就换行,否则空格隔开
    const out = [];
    for (const it of tc.items) {
      out.push(it.str);
      if (it.hasEOL) out.push("\n");
    }
    return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  } catch (e) {
    // fallback
    const pv = viewer.getPageView(pos.pageIndex);
    const tl = pv?.textLayer?.div || pv?.div?.querySelector(".textLayer");
    return tl ? (tl.textContent || tl.innerText || "").trim() : null;
  }
}

// 把当前 reading-line 落在的那一页的 canvas 截图为 PNG Blob,
// 调用方写到剪贴板(给 AI 喂图问问题用)。
export async function snapshotCurrentPage() {
  if (!viewer || !currentPdf) return null;
  const pos = currentPosition();
  if (!pos) return null;
  const pv = viewer.getPageView(pos.pageIndex);
  if (!pv?.div) return null;
  // pageView.canvas 是 pdf.js 直接公开的;有些版本只在 div 里找
  const canvas = pv.canvas || pv.div.querySelector("canvas");
  if (!canvas) return null;
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob 返回空"));
    }, "image/png");
  });
}

function setupMousePan(c) {
  let isDown = false;
  let startX = 0, startY = 0;
  let startScrollL = 0, startScrollT = 0;
  let pointerId = -1;
  let moved = false;
  c.addEventListener("pointerdown", (e) => {
    // 只接中键(button=1)平移 —— 左键留给文本选区。
    // touch / pen 走原生 scroll。
    if (e.pointerType !== "mouse") return;
    if (e.button !== 1) return;
    isDown = true;
    moved = false;
    pointerId = e.pointerId;
    startX = e.clientX; startY = e.clientY;
    startScrollL = c.scrollLeft; startScrollT = c.scrollTop;
    c.setPointerCapture(pointerId);
    c.classList.add("panning");
    // Windows / Linux 上中键按下默认进入 auto-scroll 模式,要 prevent
    e.preventDefault();
  });
  c.addEventListener("pointermove", (e) => {
    if (!isDown) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    moved = true;
    c.scrollLeft = startScrollL - dx;
    c.scrollTop = startScrollT - dy;
  });
  function release(e) {
    if (!isDown) return;
    isDown = false;
    try { c.releasePointerCapture(pointerId); } catch (_) {}
    c.classList.remove("panning");
    // 如果有 mouse move,吃掉随后的 click,避免误触发链接 / text layer
    if (moved) {
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); c.removeEventListener("click", swallow, true); };
      c.addEventListener("click", swallow, true);
      setTimeout(() => c.removeEventListener("click", swallow, true), 0);
    }
  }
  c.addEventListener("pointerup", release);
  c.addEventListener("pointercancel", release);
}

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

export async function initViewer({ containerEl, thumbContainerEl, onPosition, onPagePeek: opp }) {
  await ensureLib();
  container = containerEl;
  thumbContainer = thumbContainerEl || null;
  onPositionChange = onPosition;
  onPagePeek = opp || null;

  // 设备 / 容器维度日志 —— Quest / 高分屏 / 大屏调试用
  try {
    console.log("[viewer] init", {
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
      containerClientWidth: container.clientWidth,
      containerClientHeight: container.clientHeight,
      ua: navigator.userAgent,
    });
  } catch (_) {}

  eventBus = new pdfViewerNs.EventBus();
  linkService = new pdfViewerNs.PDFLinkService({ eventBus });
  // pdfjs-dist v4.x 的 pdf_viewer.mjs 只 export {EventBus, PDFLinkService, PDFViewer}。
  // PDFRenderingQueue / PDFThumbnailViewer 不在 public exports 里 → 不能用。
  // 主 viewer 不带 renderingQueue 也能跑(pdf.js 内部会用一个默认的)。
  // 缩略图概览功能暂时禁用,等用别的方案实现。
  viewer = new pdfViewerNs.PDFViewer({
    container,
    eventBus,
    linkService,
  });
  linkService.setViewer(viewer);

  eventBus.on("pagesinit", () => {
    // 应用上次的 spread mode (device-local,跨论文共享)
    const savedSpread = localStorage.getItem(SPREAD_KEY);
    if (savedSpread != null) {
      const n = parseInt(savedSpread, 10);
      if (n === 0 || n === 1 || n === 2) viewer.spreadMode = n;
    }
    // 应用 per-paper zoom:
    //   - 这篇论文之前在本设备调整过 → 用上次的
    //   - 没调整过 → cozy auto-fit (= "auto fit-width on new paper" 的语义)
    const savedZoom = currentDocId
      ? localStorage.getItem(ZOOM_KEY_PREFIX + currentDocId)
      : null;
    if (savedZoom) {
      programmaticScale = true;
      viewer.currentScaleValue = savedZoom;
      programmaticScale = false;
    } else {
      applyAutoFit();
    }
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

  // 概览模式下,主 viewer 翻页 → 高亮对应缩略图
  eventBus.on("pagechanging", () => {
    if (overviewOn) markCurrentThumb();
  });

  // 用户改了 zoom → 保存到 per-doc key。programmaticScale 期间不存(避免
  // cozy 默认值被持久化,这样换设备 / 切 spread 时还能重新 auto-fit)。
  eventBus.on("scalechanging", (evt) => {
    if (programmaticScale) return;
    if (!currentDocId) return;
    try {
      const val = viewer.currentScaleValue;
      const out = (typeof val === "string" && isNaN(parseFloat(val)))
        ? val
        : String(evt.scale);
      localStorage.setItem(ZOOM_KEY_PREFIX + currentDocId, out);
    } catch (_) {}
  });

  // Ctrl/Cmd + wheel = zoom。否则放过让原生 scroll 走。
  container.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    // 每个 notch 放大约 ~10%。围绕容器中心。
    const factor = dir > 0 ? 1.1 : 1 / 1.1;
    const cur = viewer.currentScale || 1;
    const next = Math.max(0.2, Math.min(8, cur * factor));
    viewer.currentScale = next;
  }, { passive: false });

  // 鼠标拖拽平移(touch 走原生 scroll 不动)
  setupMousePan(container);

  // 容器尺寸变了(横竖屏切换 / 滚动条出现导致 clientWidth 缩 / 窗口 resize)→
  // 重新跑一次 auto-fit。但只在用户没手动 zoom 这篇时 (有保存值代表手动,不去打扰)。
  let autoFitGuard = false;
  const ro = new ResizeObserver(() => {
    if (!currentPdf || !currentDocId || autoFitGuard) return;
    if (localStorage.getItem(ZOOM_KEY_PREFIX + currentDocId)) return;
    autoFitGuard = true;
    try { applyAutoFit(); } catch (_) {}
    requestAnimationFrame(() => requestAnimationFrame(() => { autoFitGuard = false; }));
  });
  ro.observe(container);

  scrollHandler = () => {
    // restore 期间不要回报 (防止覆盖即将恢复到的位置)
    if (isRestoring) return;
    // 快路径:rAF 节流的 page peek (只报 pageIndex,给 UI 显示用 — 不存盘)
    if (onPagePeek && !pagePeekRaf) {
      pagePeekRaf = requestAnimationFrame(() => {
        pagePeekRaf = null;
        const p = currentPosition();
        if (p) onPagePeek(p.pageIndex);
      });
    }
    // 慢路径:500ms debounce,报完整 {pageIndex, yFraction} 给 session
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
  // 换论文 → 旧概览缓存全清
  clearOverview();
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

// 取当前 reading-line 落在哪页 / 哪 yFraction。
// 关键:teardown / reload 期间 pages 高度可能全 0,**不要**瞎猜成"文档末"
// (那会覆盖 session.json,刷新后跳到末页)。统统返回 null,
// 让 caller 跳过这次报告。
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
  return null;
}

export function teardownCurrent() {
  if (currentPdf) {
    try { currentPdf.destroy(); } catch (_) {}
    currentPdf = null;
  }
  if (viewer) viewer.setDocument(null);
  clearOverview();
  currentDocId = null;
  pendingRestore = null;
}

export function getCurrentDocId() {
  return currentDocId;
}

// PDF 目录树 (bookmarks)。返回 [{title, dest, items: [...]}, ...] 或 []
export async function getOutline() {
  if (!currentPdf) return [];
  try {
    const outline = await currentPdf.getOutline();
    return outline || [];
  } catch (_) {
    return [];
  }
}

// 跳到 outline 条目的 destination。dest 可以是 string (named) 或 array (explicit)。
// pdf.js 的 linkService 会自己 resolve named → array,再算 scroll 位置。
export function jumpToDest(dest) {
  if (!linkService || !dest) return;
  try {
    linkService.goToDestination(dest);
  } catch (e) {
    console.warn("jumpToDest failed:", e);
  }
}
