// pdf.js viewer 的纯几何 —— 零 DOM / 零 pdf.js / 零 store,全可单测。
// 看 ARCHIVE/viewer.js + docs/{cross-device-position,fit-width-zoom} 的算法重写(不抄)。
// 三块 IP:① 跨设备位置 {pageIndex,yFraction}↔scrollTop 复位(reading-line 锚) ② cozy fit-scale
// ③ spread 分行(修双页 bug)。viewer(P3 imperative island)把这些套到 pdf.js 上。

// ── 类型 ───────────────────────────────────────────────────────────────────
/** 一页在连续滚动布局里的文档坐标盒。spread 下成对页共享同一行的 top/height(=该行)。 */
export interface PageBox { top: number; height: number; }
/** 阅读位置:0-based 物理页 + 该页内高度比例 [0,1]。PDF 文档坐标,跨设备硬不变量。 */
export interface Position { pageIndex: number; yFraction: number; }

const PT_TO_CSS_PX = 96 / 72;   // PDF point(1/72in) → CSS px(scale1, pdf.js 96dpi)。旧版栽过这个单位坑。

// ── ① 位置 ↔ 滚动 ──────────────────────────────────────────────────────────
// reading-line = 用户眼睛实际所在行,锚在 viewport 高度的 anchorFraction(默认 0.25)处。
// 复位:让 (pageIndex,yFraction) 那个文档点落到 reading-line 上。

/** (pageIndex,yFraction) → scrollTop。clamp 到可滚范围。 */
export function scrollTopForPosition(
  pages: PageBox[], pos: Position, viewportH: number, anchorFraction = 0.25,
): number {
  if (pages.length === 0) return 0;
  const i = clampInt(pos.pageIndex, 0, pages.length - 1);
  const box = pages[i];
  const docY = box.top + clamp01(pos.yFraction) * box.height;
  const raw = docY - anchorFraction * viewportH;
  const last = pages[pages.length - 1];
  const maxScroll = Math.max(0, last.top + last.height - viewportH);
  return Math.min(Math.max(0, raw), maxScroll);
}

/** scrollTop → 当前 Position(reading-line 落在哪页的哪 fraction)。
 *  全页高 0 / 无页 → null(⚙ 旧版 currentPosition 的守卫:别把"文末"写进 session 害下次跳末页)。 */
export function positionForScroll(
  pages: PageBox[], scrollTop: number, viewportH: number, anchorFraction = 0.25,
): Position | null {
  if (pages.length === 0) return null;
  const total = pages[pages.length - 1].top + pages[pages.length - 1].height;
  if (total <= 0 || pages.every((p) => p.height <= 0)) return null;

  const lineY = scrollTop + anchorFraction * viewportH;
  if (lineY <= pages[0].top) return { pageIndex: 0, yFraction: 0 };

  const i = pageIndexAtY(pages, lineY);
  const box = pages[i];
  const yFraction = box.height > 0 ? clamp01((lineY - box.top) / box.height) : 0;
  return { pageIndex: i, yFraction };
}

/** 二分:lineY 落在哪页(pages[i].top <= lineY < pages[i].top+height;超末页 → 末页)。 */
function pageIndexAtY(pages: PageBox[], y: number): number {
  let lo = 0, hi = pages.length - 1, ans = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pages[mid].top <= y) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

// ── ② cozy fit-scale ───────────────────────────────────────────────────────
// "舒适"宽度:页宽贴容器,但宽屏封顶 maxInches/页(留白,别拉满 4K)。预留滚动条宽防 jitter。
export interface CozyOpts {
  containerWidth: number;   // viewport 可用宽(px)
  scrollbarWidth: number;   // 预留的滚动条宽(px),Quest 默认粗,旧版栽过 fit 满→条出现→横溢
  pageWidthPt: number;      // PDF 页宽(point)
  pagesPerRow: number;      // 1 单页 / 2 双页
  maxInches?: number;       // 每页封顶英寸,默认 9
}
/** → scale 因子(pdf.js scale)。 */
export function cozyScale(o: CozyOpts): number {
  const maxInches = o.maxInches ?? 9;
  const availW = Math.max(0, o.containerWidth - o.scrollbarWidth);
  const rowCapW = maxInches * 96 * o.pagesPerRow;
  const targetRowW = Math.min(availW, rowCapW);
  const targetPageW = targetRowW / o.pagesPerRow;
  const naturalPageW = o.pageWidthPt * PT_TO_CSS_PX;
  if (naturalPageW <= 0) return 1;
  return targetPageW / naturalPageW;
}

// ── ③ spread 分行(修双页 bug)──────────────────────────────────────────────
// 🐞 旧版双页:第 1 页单独、然后 (2,3)(4,5)…(封面单独,书的约定)。对论文是错的(论文无封面约定)。
// 修:论文双页**从第 1 页就成对** (1,2)(3,4)…。cover-alone 变体保留(books),但默认 paired。
export type SpreadChoice = "single" | "double";
export type SpreadStart = "paired" | "cover-alone";   // paired=从首页成对(论文,默认);cover-alone=首页单独(书)

export function pagesPerRow(choice: SpreadChoice): number { return choice === "double" ? 2 : 1; }

/** 每行的 0-based pageIndex 数组。例:spreadRows(5,"double") = [[0,1],[2,3],[4]]。 */
export function spreadRows(totalPages: number, choice: SpreadChoice, start: SpreadStart = "paired"): number[][] {
  const rows: number[][] = [];
  if (totalPages <= 0) return rows;
  if (choice === "single") {
    for (let i = 0; i < totalPages; i++) rows.push([i]);
    return rows;
  }
  let i = 0;
  if (start === "cover-alone") { rows.push([0]); i = 1; }   // 书:首页单独成行
  for (; i < totalPages; i += 2) {
    rows.push(i + 1 < totalPages ? [i, i + 1] : [i]);
  }
  return rows;
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x; }
function clampInt(x: number, lo: number, hi: number): number {
  const n = Math.max(0, Math.floor(x));
  return Math.min(Math.max(n, lo), hi);
}
