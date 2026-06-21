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
  emits: ["position", "page", "spread"],
  setup(_props: unknown, ctx: SetupCtx) {
    const containerRef = ref<HTMLElement | null>(null);
    let lib: any = null, ns: any = null, viewer: any = null, eventBus: any = null, linkService: any = null, pdf: any = null;
    let restorePos: Position | null = null;
    let reporting = false;
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
      if (reporting) return;
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

    async function loadBlob(blob: Blob, opts?: { key?: string; pos?: Position | null }): Promise<void> {
      if (!viewer || !lib) return;
      currentKey = opts?.key || "anon";
      restorePos = opts?.pos ?? null;
      const data = await blob.arrayBuffer();
      const base = (await loadPdfjs()).base;
      const task = lib.getDocument({ data, cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/" });
      pdf = await task.promise;
      viewer.setDocument(pdf);
      linkService.setDocument(pdf);
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
        void applyFit().then(() => { if (restorePos) { restore(restorePos); restorePos = null; } emitPage(); });
      });
      eventBus.on("pagesloaded", () => { if (restorePos) { restore(restorePos); restorePos = null; } });
      eventBus.on("pagechanging", () => emitPage());
      c.addEventListener("scroll", onScroll, { passive: true });
      c.addEventListener("wheel", onWheel, { passive: false });
    });
    onUnmounted(() => {
      const c = containerRef.value;
      c?.removeEventListener("scroll", onScroll);
      c?.removeEventListener("wheel", onWheel);
    });

    ctx.expose({
      loadBlob,
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
    });
    return { containerRef };
  },
  template: `<div ref="containerRef" class="jrp-viewer"><div class="pdfViewer"></div></div>`,
});
