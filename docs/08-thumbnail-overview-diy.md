# 自己 roll 的缩略图概览

200 页论文需要 PPT 式的多页 overview 选页。pdf.js 不暴露 `PDFThumbnailViewer`(见 [01-pdfjs-gotchas.md](01-pdfjs-gotchas.md) 坑 2),只能自己写。**~100 行,IntersectionObserver 懒渲染,内存可控**。

## 整体结构

1. 进入概览模式 → 主 viewer `display:none`,thumb container 全屏
2. 一次性建 N 个 `.thumb-card` 骨架(只占位,不渲染 canvas)
3. IntersectionObserver 监视 cards,进可见区(+ rootMargin 预取)才真的 `pdfPage.render()` 到 canvas
4. 点缩略图 → 退出概览 + 跳页 + immediate flush

## HTML 骨架

```html
<div id="thumbContainer" class="thumb-container hidden"></div>
```

CSS Grid 自适应:

```css
.thumb-container {
  position: absolute;
  top: calc(36px + env(safe-area-inset-top, 0px));
  left: 0; right: 0; bottom: 0;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(180px, 28vw), 1fr));
  gap: 16px;
  padding: 16px;
}
.thumb-container.hidden { display: none; }
.thumb-card {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  cursor: pointer;
}
.thumb-canvas-wrap {
  border: 2px solid var(--line-strong);
  border-radius: 4px;
  background: var(--bg-1);
  width: 100%;
  aspect-ratio: 1 / 1.414;  /* 占位,渲染前不抖布局 */
  overflow: hidden;
}
.thumb-card.current .thumb-canvas-wrap {
  border-color: var(--accent);
  border-width: 3px;
}
```

⚠ **CSS specificity 坑**:用 `.thumb-container` (class) 而不是 `#thumbContainer` (id) 写 `display: grid`,否则 ID 选择器比 `.thumb-container.hidden` 高一档,**永远 grid → 永远覆盖在 viewer 上,看起来 night 模式黑屏**。见 [09-css-layout-traps.md](09-css-layout-traps.md) 坑 1。

## 建骨架 + 装 IO

```js
let overviewIO = null;
let overviewRendered = new Set();  // pageNumber → 已渲染
let overviewBuiltForPdf = null;    // 换论文要重建

export function setOverviewVisible(visible) {
  if (visible) {
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
    overviewIO?.disconnect();
    overviewIO = null;
  }
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
      if (overviewRendered.has(pn)) continue;
      overviewRendered.add(pn);
      renderThumb(card, pn).catch((e) => {
        overviewRendered.delete(pn);  // 失败 → 让下次再 render 尝试
      });
    }
  }, { root: thumbContainer, rootMargin: "400px" });
  for (const card of thumbContainer.querySelectorAll(".thumb-card")) {
    overviewIO.observe(card);
  }
}
```

## 单 thumb 渲染

```js
async function renderThumb(card, pn) {
  if (!currentPdf) return;
  const pdf = currentPdf;  // capture in case it changes mid-render
  const page = await pdf.getPage(pn);
  if (pdf !== currentPdf) return;  // 换 PDF 了就别画了
  const wrap = card.querySelector(".thumb-canvas-wrap");
  if (!wrap) return;
  const targetCssWidth = wrap.clientWidth || 180;
  const vp1 = page.getViewport({ scale: 1 });
  const scale = targetCssWidth / vp1.width;
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  // dpr cap 2 避免 200 页 × 4x 内存爆 (4K 屏 dpr=2 已经够清,5K dpr=3 也没必要更高)
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(vp.width * dpr);
  canvas.height = Math.round(vp.height * dpr);
  canvas.style.width = vp.width + "px";
  canvas.style.height = vp.height + "px";
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  // 渲染完发现 PDF 变了 / card 飞了 → 丢弃
  if (pdf !== currentPdf || !card.isConnected) return;
  wrap.innerHTML = "";
  wrap.appendChild(canvas);
}
```

要点:
- 用 `page.getViewport({ scale: 1 }).width` 算 fit 比例(这里直接拿 PDF pt 也行,关键是用 `scale: 1` 这一组,**不要混 user scale 和 viewport scale**)。
- **DPR cap 2**:200 页 × 4 倍 dpr canvas ≈ 200 × ~600KB = 120MB,内存爆。cap 2 ≈ 30MB,可接受。
- **mid-render guard**:`pdf !== currentPdf` 多次检查,中途换论文 / teardown 丢弃当前帧不出 console warn 暴雨。

## 当前页高亮 + pagechanging

```js
function markCurrentThumb() {
  const cur = viewer.currentPageNumber;
  for (const el of thumbContainer.querySelectorAll(".thumb-card.current"))
    el.classList.remove("current");
  thumbContainer.querySelector(`[data-page-number="${cur}"]`)?.classList.add("current");
}

eventBus.on("pagechanging", () => {
  if (overviewOn) markCurrentThumb();
});
```

## 点缩略图跳页

```js
thumbContainer.addEventListener("click", (e) => {
  const thumb = e.target.closest(".thumb-card");
  if (!thumb) return;
  const pn = parseInt(thumb.dataset.pageNumber, 10);
  if (!pn) return;
  e.preventDefault();
  setOverviewVisible(false);  // ← 必须先退出概览
  // 等 layout 把 viewer container 恢复可见,再跳页 (display:none 期间 scrollIntoView no-op)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => goToPage(pn));
  });
  // 跳页是明确意图 → immediate flush (dedup)
  if (outlineJumpFlushTimer) clearTimeout(outlineJumpFlushTimer);
  outlineJumpFlushTimer = setTimeout(() => flush().catch(() => {}), 800);
});
```

## 切论文 / teardown 清缓存

```js
function clearOverview() {
  overviewIO?.disconnect();
  overviewIO = null;
  if (thumbContainer) thumbContainer.innerHTML = "";
  overviewRendered.clear();
  overviewBuiltForPdf = null;
}
// loadPdf 结尾 + teardownCurrent 都调
```

不然换论文后 IntersectionObserver 还在监听旧 cards,触发渲染拿到 stale pdf instance → 报错。

## 容量估算 (200 页)

- canvas 每张 ~180×254 css × 2 dpr = 360×508 = ~733KB(actual depends on PDF content,白底简单 PDF 压缩好,数学论文复杂)
- 实际可见 ~10 张 + rootMargin 预取 ~10 张 = 20 张 ≈ 15MB
- 用户滚到的最远点累积 = N 张 × ~700KB,200 张全渲染 ≈ 140MB(理论上限)

对于论文场景(用户偶尔进概览找一页),实际命中 ~30 页,内存 ~20MB。OK。

textbook 用户(进概览翻 500 页)可能爆。**未来 mitigation**:加 IntersectionObserver 反方向 unobserve + 释放 canvas placeholder。MVP 不做。

## 相关
- [01-pdfjs-gotchas.md](01-pdfjs-gotchas.md) — 为什么 pdf.js 内置 thumbnail viewer 用不了
- [09-css-layout-traps.md](09-css-layout-traps.md) — `.thumb-container` vs `#thumbContainer` 黑屏 bug
