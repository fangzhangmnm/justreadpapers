# pdf.js 的几个隐藏地雷

我用 `pdfjs-dist@4.10.38` 从 jsdelivr CDN 加载。四个坑写在前面,后来者别再踩。

## 坑 1:`viewport.scale ≠ user scale`(差 96/72 倍)

**整个项目最贵的 bug**,跑了十几个 commit 才意识到。

pdf.js 的 `PDFPageView` 内部把 user scale × `PixelsPerInch.PDF_TO_CSS_UNITS` (= 96/72 ≈ 1.333) 才传给 `getViewport`:

```js
// pdf.js 内部 (大致)
this.viewport = pdfPage.getViewport({
  scale: this._scale * PixelsPerInch.PDF_TO_CSS_UNITS,
});
```

所以:
- `viewport.scale` = `userScale × 96/72`(**不是** `userScale`!)
- `viewport.width` = `pageWidthPts × userScale × 96/72`(**CSS px**)

我之前写:

```js
// ❌ 错的
const naturalCssWidth = vp.width / vp.scale;  // 实际拿到的是 pageWidthPts (PDF point)
const s = targetCss / (naturalCssWidth * pagesPerRow);
// → s 大 33% → page 渲染 1.33 倍容器 → 永远横向溢出
```

正确写法(任选一):

```js
// 法 A:从 pdfPage.view bbox 直接算 (最稳)
const view = pv.pdfPage.view;
const pageWidthPts = view[2] - view[0];
const naturalCssWidth = pageWidthPts * (96 / 72);

// 法 B:从 viewport 反推
const naturalCssWidth = vp.width * (96 / 72) / vp.scale;
```

**症状**:fit-width 永远把 page 渲染比容器宽 33%。用户反复说"宽度不对",我反复修 min/max / scrollbar / cap / UA factor,全是猜偏方向。最后用户一句"差一个常数倍"才定位。

记忆点:**任何 PDF 渲染宽度计算,先确认是 PDF point 还是 CSS px。把单位写进变量名**(naturalCssWidth vs pageWidthPts)。

## 坑 2:`pdfjs-dist` 公开 export 只有 3 个

`web/pdf_viewer.mjs` 里 export 的:
- `EventBus`
- `PDFLinkService`
- `PDFViewer`

**`PDFThumbnailViewer` 和 `PDFRenderingQueue` 不在 public exports 里**,虽然类型声明里有 `types/web/pdf_thumbnail_viewer.d.ts`。我误用导致 iOS 启动 crash(`undefined is not a constructor`),桌面也悄悄炸了,只是 iOS 报错弹得醒目。

v4.x、v5.x 都一样,不是版本问题。Mozilla 故意只把"基础 viewer"打进 npm dist,demo 用的那些(thumbnail / find / scripting)留给你自己 roll。

后果:**缩略图概览必须自己写**,用 IntersectionObserver + `pdfPage.render()` 自渲染。见 [08-thumbnail-overview-diy.md](08-thumbnail-overview-diy.md)。

## 坑 3:`viewer.currentScaleValue = "page-width"` 在 spread mode 行为不一致

spread 模式下,pdf.js 的 `"page-width"` 字符串可能算成"单页填满容器",于是整个 spread 变 2 倍容器宽 → 横向溢出。

修法:**永远用数字 scale,不用字符串 "page-width"**。自己算 `s = targetCss / (naturalCssWidth × pagesPerRow)` 然后 `viewer.currentScale = s`。

fallback 也别落到 "page-width",用 `1.0` 兜底。

## 坑 4:`scrollPageIntoView` 在 `display:none` 容器上 no-op

做缩略图概览时,点缩略图 → `goToPage` → `viewer.currentPageNumber = X` → pdf.js 调 scrollIntoView,但此时 viewer-container 还是 `display:none`(没退出概览模式)→ 没效果。

修:先 `setOverviewVisible(false)`,**等两帧 rAF** 让 layout 把 container 恢复可见,再 `goToPage`:

```js
setOverviewVisible(false);
requestAnimationFrame(() => {
  requestAnimationFrame(() => goToPage(pn));
});
```

## 坑 5:`currentPosition()` 在 teardown 期不要瞎兜底

撕页期 (reload / 切论文 / spread 切换),所有 pageView 的 `offsetHeight = 0`,循环找 reading-line 全部 skip。

```js
// ❌ 错的兜底:返"末页 + yFraction 1"
if (readingLineY < 0) return { pageIndex: 0, yFraction: 0 };
return { pageIndex: pages - 1, yFraction: 1 };
```

→ scroll handler fire 时把"末页"写进 session.json → 下次 restore 跳到文档底。我遇到过这 bug,F5 后从末页开始。

正确:**找不到就返 `null`**,让上游 `if (!p) return` guard 跳过。

## ESM 加载 + worker 路径

```js
const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38";
const PDFJS_BASE_FB = "https://unpkg.com/pdfjs-dist@4.10.38";

async function loadModule(rel) {
  for (const base of [PDFJS_BASE, PDFJS_BASE_FB]) {
    try { return await import(/* @vite-ignore */ `${base}/${rel}`); }
    catch (_) {}
  }
  throw new Error("pdf.js 加载失败");
}

pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
```

`pdf.worker.mjs` 是另一个文件(不是同一 mjs),必须显式 set `workerSrc`。
