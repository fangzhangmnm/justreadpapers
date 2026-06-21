// Viewer —— pdf.js 全屏连续滚动,**imperative island**(Vue 组件壳,内部 pdf.js 自管 DOM/canvas,
// 绝不进 reactive 图)。位置/几何全走纯模块 domain/viewer-geometry(已测)。
// 暴露 loadBlob(blob,pos) 给父组件;滚动经 emit("position") 上报(父 → persistence.recordPosition)。

import { defineComponent, onMounted, onUnmounted, ref } from "../vendor/vue/vue.esm-browser.prod.js";
import { loadPdfjs } from "../pdfjs-loader.ts";
import { scrollTopForPosition, positionForScroll, cozyScale } from "../domain/viewer-geometry.ts";
import type { PageBox, Position } from "../domain/viewer-geometry.ts";
import { READING_LINE_ANCHOR } from "../config.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SetupCtx { emit: (e: "position", p: Position) => void; expose: (api: object) => void; }

let _scrollbarW = -1;
function scrollbarWidth(): number {
  if (_scrollbarW >= 0) return _scrollbarW;
  try {
    const d = document.createElement("div");
    d.style.cssText = "width:50px;height:50px;overflow:scroll;position:absolute;top:-9999px;visibility:hidden;";
    document.body.appendChild(d);
    _scrollbarW = d.offsetWidth - d.clientWidth;
    d.remove();
  } catch { _scrollbarW = 0; }
  return _scrollbarW;
}

export const Viewer = defineComponent({
  name: "Viewer",
  emits: ["position"],
  setup(_props: unknown, ctx: SetupCtx) {
    const containerRef = ref<HTMLElement | null>(null);
    let lib: any = null, ns: any = null, viewer: any = null, eventBus: any = null, linkService: any = null, pdf: any = null;
    let restorePos: Position | null = null;
    let reporting = false;

    // 从已渲染的 .page 元素量出每页文档盒(getBoundingClientRect 相对 container + scrollTop,稳)。
    function boxes(): PageBox[] {
      const c = containerRef.value; if (!c) return [];
      const cTop = c.getBoundingClientRect().top, st = c.scrollTop;
      return Array.from(c.querySelectorAll(".pdfViewer .page")).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return { top: r.top - cTop + st, height: r.height };
      });
    }
    async function applyCozy(): Promise<void> {
      const c = containerRef.value; if (!c || !pdf || !viewer) return;
      const page = await pdf.getPage(1);
      const view = page.view as number[];            // [x0,y0,x1,y1] PDF points
      const pageWidthPt = view[2] - view[0];
      viewer.currentScale = cozyScale({
        containerWidth: c.clientWidth, scrollbarWidth: scrollbarWidth(),
        pageWidthPt, pagesPerRow: 1,
      });
    }
    function restore(pos: Position): void {
      const c = containerRef.value; if (!c) return;
      c.scrollTop = scrollTopForPosition(boxes(), pos, c.clientHeight, READING_LINE_ANCHOR);
    }
    function onScroll(): void {
      if (reporting) return;
      reporting = true;
      requestAnimationFrame(() => {
        reporting = false;
        const c = containerRef.value; if (!c) return;
        const p = positionForScroll(boxes(), c.scrollTop, c.clientHeight, READING_LINE_ANCHOR);
        if (p) ctx.emit("position", p);
      });
    }

    // 父调:加载一份 PDF blob(可带初始复位位置)。
    async function loadBlob(blob: Blob, pos?: Position | null): Promise<void> {
      if (!viewer || !lib) return;
      restorePos = pos ?? null;
      const data = await blob.arrayBuffer();
      const base = (await loadPdfjs()).base;
      const task = lib.getDocument({
        data, cMapUrl: base + "cmaps/", cMapPacked: true, standardFontDataUrl: base + "standard_fonts/",
      });
      pdf = await task.promise;
      viewer.setDocument(pdf);
      linkService.setDocument(pdf);
    }

    onMounted(async () => {
      const loaded = await loadPdfjs();
      lib = loaded.pdfjsLib; ns = loaded.ns;
      const c = containerRef.value;
      if (!c) return;
      const viewerEl = c.querySelector(".pdfViewer");
      eventBus = new ns.EventBus();
      linkService = new ns.PDFLinkService({ eventBus });
      viewer = new ns.PDFViewer({ container: c, viewer: viewerEl, eventBus, linkService });
      linkService.setViewer(viewer);
      // pages 几何就绪 → cozy fit;有待复位位置则复位(2 次:init + loaded,等 reflow 稳)。
      eventBus.on("pagesinit", () => { void applyCozy().then(() => { if (restorePos) { restore(restorePos); restorePos = null; } }); });
      eventBus.on("pagesloaded", () => { if (restorePos) { restore(restorePos); restorePos = null; } });
      c.addEventListener("scroll", onScroll, { passive: true });
    });
    onUnmounted(() => { containerRef.value?.removeEventListener("scroll", onScroll); });

    ctx.expose({ loadBlob });
    return { containerRef };
  },
  template: `<div ref="containerRef" class="jrp-viewer"><div class="pdfViewer"></div></div>`,
});
