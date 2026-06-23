// Viewer —— pdf.js 全屏连续滚动,**imperative island**(Vue 壳,pdf.js 自管 DOM/canvas,绝不进 reactive 图)。
// 位置/几何/cozy 全走纯模块 domain/viewer-geometry(已测)。
// 暴露 loadBlob/zoomIn/zoomOut/fitWidth/toggleSpread;emit position/page/spread 给父组件。

import { defineComponent, onMounted, onUnmounted, ref } from "../vendor/vue/vue.esm-browser.prod.js";
import { loadPdfjs } from "../pdfjs-loader.ts";
import { scrollTopForPosition, positionForScroll, cozyScale, pagesPerRow } from "../domain/viewer-geometry.ts";
import type { PageBox, Position, SpreadChoice } from "../domain/viewer-geometry.ts";
import { READING_LINE_ANCHOR } from "../config.ts";
import { settings } from "../app-state.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SetupCtx { emit: (e: string, payload?: unknown) => void; expose: (api: object) => void; }

const ZOOM_STEP = 1.15;
const SCALE_MIN = 0.1, SCALE_MAX = 8;
// pdf.js spreadMode:0=none,1=ODD(成对 (1,2)(3,4)=论文要的),2=EVEN(封面单独=旧 bug)。
// 我们只在 single(0) ↔ double(ODD=1) 之间切。
const SPREAD_SINGLE = 0, SPREAD_DOUBLE = 1;

let _scrollbarW = -1;
function scrollbarWidth(): number {
  if (_scrollbarW >= 0) return _scrollbarW;
  try {
    const d = document.createElement("div");
    d.style.cssText = "width:50px;height:50px;overflow:scroll;position:absolute;top:-9999px;visibility:hidden;";
    document.body.appendChild(d); _scrollbarW = d.offsetWidth - d.clientWidth; d.remove();
  } catch { _scrollbarW = 0; }
  return _scrollbarW;
}
function clampScale(s: number): number { return Math.min(Math.max(s, SCALE_MIN), SCALE_MAX); }

export const Viewer = defineComponent({
  name: "Viewer",
  emits: ["position", "page", "spread", "toast", "outline"],
  setup(_props: unknown, ctx: SetupCtx) {
    const containerRef = ref<HTMLElement | null>(null);
    const thumbRef = ref<HTMLElement | null>(null);
    let lib: any = null, ns: any = null, viewer: any = null, eventBus: any = null, linkService: any = null, pdf: any = null;
    let restorePos: Position | null = null;
    let reporting = false;
    // 页面总览(缩略图)—— pdf.js 不暴露 PDFThumbnailViewer,自己 roll:CSS Grid 占位卡 +
    // IntersectionObserver 进可见区才渲染那一页小 canvas(200 页论文也只渲 ~可视+预取)。命令式 island,不进 reactive。
    let overviewOn = false;
    let overviewIO: IntersectionObserver | null = null;
    const overviewRendered = new Set<number>();
    let overviewBuiltForPdf: any = null;   // 换论文要重建骨架
    // 加载门:setDocument→restore 完成前,pdf.js 布局把 scrollTop 摆在 0,
    // 这些瞬态 scroll 绝不能 emit position(否则覆写 catalog 已存位置 → 续读丢失,"await default 0 覆盖"老坑)。
    let loading = false;
    let currentKey = "anon";              // 缩放偏好的 doc 键(local file=文件名;cloud=docId)
    let spreadMode = SPREAD_SINGLE;
    let cozyBaseline = 1;                 // factor=1 时的 scale(cozy);保存的是相对它的倍率

    const zoomfKey = (): string => `zoomf:${currentKey}:${spreadMode}`;
    const spreadChoice = (): SpreadChoice => (spreadMode === SPREAD_SINGLE ? "single" : "double");

    function boxes(): PageBox[] {
      const c = containerRef.value; if (!c) return [];
      const cTop = c.getBoundingClientRect().top, st = c.scrollTop;
      return Array.from(c.querySelectorAll(".pdfViewer .page")).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { top: r.top - cTop + st, height: r.height };
      });
    }
    async function computeCozy(): Promise<number> {
      const c = containerRef.value; if (!c || !pdf) return 1;
      const page = await pdf.getPage(1);
      const view = page.view as number[];               // [x0,y0,x1,y1] PDF points
      return cozyScale({
        containerWidth: c.clientWidth, scrollbarWidth: scrollbarWidth(),
        pageWidthPt: view[2] - view[0], pagesPerRow: pagesPerRow(spreadChoice()),
      });
    }
    async function applyFit(): Promise<void> {
      if (!viewer) return;
      cozyBaseline = await computeCozy();
      const factor = settings().getNum(zoomfKey(), 1);
      viewer.currentScale = clampScale(cozyBaseline * factor);
    }
    function saveFactor(): void {
      if (cozyBaseline > 0) settings().setNum(zoomfKey(), viewer.currentScale / cozyBaseline);
    }
    function currentPos(): Position | null {
      const c = containerRef.value; if (!c) return null;
      return positionForScroll(boxes(), c.scrollTop, c.clientHeight, READING_LINE_ANCHOR);
    }
    function restore(pos: Position): void {
      const c = containerRef.value; if (!c) return;
      c.scrollTop = scrollTopForPosition(boxes(), pos, c.clientHeight, READING_LINE_ANCHOR);
    }
    function emitPage(): void {
      if (viewer && pdf) ctx.emit("page", { page: viewer.currentPageNumber, total: pdf.numPages });
    }
    function onScroll(): void {
      if (loading || reporting) return;
      reporting = true;
      requestAnimationFrame(() => {
        reporting = false;
        const p = currentPos();
        if (p) ctx.emit("position", p);
      });
    }
    function onWheel(e: WheelEvent): void {
      if (!(e.ctrlKey || e.metaKey)) return;            // 裸滚轮 = 原生滚动
      e.preventDefault();
      zoomAround(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    }
    // 缩放(保住 reading-line:缩放前后让同一文档点留在 anchor)。
    function zoomAround(f: number): void {
      const keep = currentPos();
      viewer.currentScale = clampScale(viewer.currentScale * f);
      saveFactor();
      if (keep) requestAnimationFrame(() => restore(keep));
    }

    // ── 页面总览(缩略图概览)island ──────────────────────────────────────────
    function grid(): HTMLElement | null { return thumbRef.value?.querySelector(".jrp-thumbs-grid") ?? null; }
    function clearOverview(): void {
      if (overviewIO) { overviewIO.disconnect(); overviewIO = null; }
      const g = grid(); if (g) g.innerHTML = "";
      overviewRendered.clear();
      overviewBuiltForPdf = null;
    }
    function buildSkeleton(): void {
      clearOverview();
      const g = grid(); if (!g || !pdf) return;
      const np = pdf.numPages as number;
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= np; i++) {
        const card = document.createElement("div");
        card.className = "jrp-thumb-card";
        card.dataset.page = String(i);
        // canvas-wrap 用 A4 aspect-ratio 占位撑高度 → 空骨架不会一次性全 intersect 把整本渲染了。
        card.innerHTML = `<div class="jrp-thumb-wrap"></div><div class="jrp-thumb-label">${i}</div>`;
        card.addEventListener("click", () => { goToPage(i); setOverview(false); });
        frag.appendChild(card);
      }
      g.appendChild(frag);
      overviewBuiltForPdf = pdf;
    }
    function attachObserver(): void {
      const g = grid(); if (!g) return;
      if (overviewIO) overviewIO.disconnect();
      overviewIO = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const card = e.target as HTMLElement;
          const pn = parseInt(card.dataset.page || "", 10);
          if (!pn || overviewRendered.has(pn)) continue;
          overviewRendered.add(pn);
          void renderThumb(card, pn).catch(() => { overviewRendered.delete(pn); });
        }
      }, { root: g, rootMargin: "400px" });
      g.querySelectorAll(".jrp-thumb-card").forEach((c) => overviewIO!.observe(c));
    }
    async function renderThumb(card: HTMLElement, pn: number): Promise<void> {
      const myPdf = pdf; if (!myPdf) return;
      const page = await myPdf.getPage(pn);
      if (myPdf !== pdf) return;                       // 渲染中换了论文 → 丢弃
      const wrap = card.querySelector(".jrp-thumb-wrap") as HTMLElement | null; if (!wrap) return;
      const cssW = wrap.clientWidth || 180;
      const vp1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: cssW / vp1.width });
      const canvas = document.createElement("canvas");
      const dpr = Math.min(window.devicePixelRatio || 1, 2);   // cap 2:避免 200 页 ×4x 内存爆
      canvas.width = Math.round(vp.width * dpr);
      canvas.height = Math.round(vp.height * dpr);
      const cx = canvas.getContext("2d"); if (!cx) return;
      cx.scale(dpr, dpr);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      if (myPdf !== pdf || !card.isConnected) return;          // 渲染完又变了 → 丢弃
      wrap.innerHTML = ""; wrap.appendChild(canvas);
    }
    function markCurrent(): void {
      const g = grid(); if (!g || !viewer) return;
      g.querySelectorAll(".jrp-thumb-card.current").forEach((el) => el.classList.remove("current"));
      const node = g.querySelector(`.jrp-thumb-card[data-page="${viewer.currentPageNumber}"]`);
      if (node) node.classList.add("current");
    }
    function setOverview(visible: boolean): void {
      const root = thumbRef.value; if (!root || !pdf) return;
      const want = !!visible;
      if (want === overviewOn) return;
      overviewOn = want;
      if (overviewOn) {
        if (overviewBuiltForPdf !== pdf) buildSkeleton();
        root.classList.remove("hidden");
        attachObserver();
        markCurrent();
        const cur = viewer.currentPageNumber || 1;
        requestAnimationFrame(() => grid()?.querySelector(`.jrp-thumb-card[data-page="${cur}"]`)?.scrollIntoView({ block: "center" }));
      } else {
        root.classList.add("hidden");
        if (overviewIO) { overviewIO.disconnect(); overviewIO = null; }
      }
    }
    function goToPage(n: number): void { if (viewer) viewer.currentPageNumber = n; }

    async function loadBlob(blob: Blob, opts?: { key?: string; pos?: Position | null }): Promise<void> {
      if (!viewer || !lib) return;
      setOverview(false); clearOverview();   // 换论文:关总览 + 弃旧骨架(下次开时按新 pdf 重建)
      loading = true;                 // 关门:布局期的 page0 瞬态 scroll 不入 record(restore 完成才开门)
      currentKey = opts?.key || "anon";
      restorePos = opts?.pos ?? null;
      try {
        const data = await blob.arrayBuffer();
        const base = (await loadPdfjs()).base;
        const task = lib.getDocument({ data, cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/" });
        pdf = await task.promise;
        viewer.setDocument(pdf);
        linkService.setDocument(pdf);
        void pdf.getOutline().then((o: any) => ctx.emit("outline", o || [])).catch(() => ctx.emit("outline", []));
      } catch (e) {
        loading = false;              // 加载失败也开门,否则永久吞掉后续 scroll
        ctx.emit("toast", "PDF 加载失败");
        throw e;
      }
    }

    onMounted(async () => {
      const loaded = await loadPdfjs();
      lib = loaded.pdfjsLib; ns = loaded.ns;
      const c = containerRef.value; if (!c) return;
      eventBus = new ns.EventBus();
      linkService = new ns.PDFLinkService({ eventBus });
      viewer = new ns.PDFViewer({ container: c, viewer: c.querySelector(".pdfViewer"), eventBus, linkService });
      linkService.setViewer(viewer);
      eventBus.on("pagesinit", () => {
        spreadMode = settings().getNum("spread", SPREAD_SINGLE) === SPREAD_DOUBLE ? SPREAD_DOUBLE : SPREAD_SINGLE;
        viewer.spreadMode = spreadMode;
        ctx.emit("spread", spreadMode);
        // 粗调:scale 落定后先 restore 一次,然后开门(page0 布局期 churn 到此为止)。
        // restorePos 不在此清——留给 pagesloaded 全渲染后精修一次(高度落定,位置才准)。
        void applyFit().then(() => { if (restorePos) restore(restorePos); emitPage(); loading = false; });
      });
      // 精修:全页渲染后高度落定,再 restore 一次并清 restorePos;此时门已开,这次 scroll 会把准确位置记下。
      eventBus.on("pagesloaded", () => { if (restorePos) { restore(restorePos); restorePos = null; } loading = false; });
      eventBus.on("pagechanging", () => emitPage());
      c.addEventListener("scroll", onScroll, { passive: true });
      c.addEventListener("wheel", onWheel, { passive: false });
      thumbRef.value?.querySelector("[data-thumb-close]")?.addEventListener("click", () => setOverview(false));
    });
    onUnmounted(() => {
      const c = containerRef.value;
      c?.removeEventListener("scroll", onScroll);
      c?.removeEventListener("wheel", onWheel);
      if (overviewIO) { overviewIO.disconnect(); overviewIO = null; }
    });

    // Quest 核心:截当前页 canvas → 剪贴板 PNG(拿去问 AI)。
    async function screenshot(): Promise<void> {
      const c = containerRef.value; if (!c || !viewer) return;
      const n = viewer.currentPageNumber;
      const canvas = c.querySelector(`.pdfViewer .page[data-page-number="${n}"] canvas`) as HTMLCanvasElement | null;
      if (!canvas) { ctx.emit("toast", "当前页还没渲染好"); return; }
      try {
        const blob: Blob = await new Promise((res, rej) =>
          canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob null"))), "image/png"));
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        ctx.emit("toast", `已截图第 ${n} 页到剪贴板`);
      } catch { ctx.emit("toast", "截图失败(剪贴板不支持?)"); }
    }
    // 复制当前页文本(LaTeX 公式出 glyph 非源码,tooltip 已注明)。
    async function copyText(): Promise<void> {
      if (!pdf || !viewer) return;
      const n = viewer.currentPageNumber;
      try {
        const page = await pdf.getPage(n);
        const tc = await page.getTextContent();
        const text = (tc.items as any[]).map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " ").trim();
        await navigator.clipboard.writeText(text);
        ctx.emit("toast", `已复制第 ${n} 页文本 (${text.length} 字)`);
      } catch { ctx.emit("toast", "复制文本失败"); }
    }

    ctx.expose({
      loadBlob, screenshot, copyText,
      goToDest: (dest: unknown): void => { try { linkService.goToDestination(dest); } catch { /* */ } },
      zoomIn: (): void => zoomAround(ZOOM_STEP),
      zoomOut: (): void => zoomAround(1 / ZOOM_STEP),
      fitWidth: (): void => { settings().setNum(zoomfKey(), 1); void applyFit(); },
      toggleSpread: (): void => {
        const keep = currentPos();
        spreadMode = spreadMode === SPREAD_SINGLE ? SPREAD_DOUBLE : SPREAD_SINGLE;
        viewer.spreadMode = spreadMode;
        settings().setNum("spread", spreadMode);
        ctx.emit("spread", spreadMode);
        void applyFit().then(() => { if (keep) restore(keep); });
      },
      toggleOverview: (): void => { if (pdf) setOverview(!overviewOn); else ctx.emit("toast", "先打开一篇论文"); },
    });
    return { containerRef, thumbRef };
  },
  template: `<div class="jrp-viewer-root">
    <div ref="containerRef" class="jrp-viewer"><div class="pdfViewer"></div></div>
    <div ref="thumbRef" class="jrp-thumbs hidden">
      <div class="jrp-thumbs-bar"><button class="jrp-btn" data-thumb-close>关闭总览</button><span class="jrp-thumbs-title">页面总览</span></div>
      <div class="jrp-thumbs-grid"></div>
    </div>
  </div>`,
});
