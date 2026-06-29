# Fit-width / cozy / per-paper zoom

PDF viewer 的"页该多大"是水最深的一块。三个独立维度纠在一起:
1. 容器宽度(window resize / 横竖屏 / scrollbar 出现)
2. spread mode(单页 vs 双页)
3. 用户偏好(per-paper 持久化的"我要比 fit 大 / 小一点")

## Cozy scale 公式

目标:**小屏 fit 容器,大屏 cap 9 寸/页**(用户原话:"大屏不占满,小屏占满")。

```js
const TARGET_INCHES_PER_PAGE = 9;
const CSS_PX_PER_INCH = 96;
const PAGE_BORDER_RESERVE = 4;  // .page / .spread 的 1px border + 喘息

function computeCozyScale() {
  const pv = viewer.getPageView(0);
  const view = pv.pdfPage.view;  // [llx, lly, urx, ury] in PDF pt
  const pageWidthPts = view[2] - view[0];
  const naturalCssWidth = pageWidthPts * (96/72);  // ← 必须乘 96/72,见 01-pdfjs-gotchas

  // scrollbar 预留 (见下面 "scrollbar reserve")
  const sbw = detectScrollbarWidth();
  const scrollbarShowing = container.offsetWidth - container.clientWidth >= sbw - 1;
  const reserve = (sbw > 0 && !scrollbarShowing) ? sbw : 0;
  const availCss = container.clientWidth - PAGE_BORDER_RESERVE - reserve;

  const isSpread = viewer.spreadMode !== 0;
  const pagesPerRow = isSpread ? 2 : 1;
  const cap = TARGET_INCHES_PER_PAGE * pagesPerRow * CSS_PX_PER_INCH;  // 864 / 1728
  const targetCss = Math.min(availCss, cap);  // ← min 不是 max!cap 是 render 上限
  return Math.max(0.1, Math.min(4, targetCss / (naturalCssWidth * pagesPerRow)));
}
```

要点:

- **`Math.min(availCss, cap)` 是对的**。cap = 上限 → 小容器 < cap 选 availCss(填满)→ 大容器 > cap 选 cap(留白)。
- **spread mode 把 cap 也 × 2**,所以双页时整 spread ≤ 18 寸,每页 ≤ 9 寸,字号跟单页一致。
- **下限 scale 0.1** 才让窄屏(phone / Quest)真能缩到 fit-width。我之前用 0.5 在 Quest 上溢出半边。

## Scrollbar reserve

多页 PDF 必出 vertical scrollbar。如果 fit 时 scrollbar 还没出来,`clientWidth` 是无 scrollbar 状态,稍后 scrollbar 一出 container 缩 18px → page 溢出。**先减掉**。

检测平台 scrollbar 占不占空间(overlay scrollbar 占 0):

```js
let _sbw = null;
function detectScrollbarWidth() {
  if (_sbw != null) return _sbw;
  const d = document.createElement("div");
  d.style.cssText = "width:50px;height:50px;overflow:scroll;position:absolute;top:-9999px;visibility:hidden;";
  document.body.appendChild(d);
  _sbw = d.offsetWidth - d.clientWidth;
  document.body.removeChild(d);
  return _sbw;
}
```

只在 scrollbar **还没出来** 时 reserve(`scrollbarShowing` 检查 `offsetWidth > clientWidth`),否则 clientWidth 已经把它扣掉了,再扣就 double-subtract → 18px 白边。

## Per-paper zoom 必须是 factor,不能是绝对 scale

如果存 `viewer.currentScale = 1.5`,大窗口存了"放大 1.5",小窗口打开同一篇 page 也是 1.5 → 巨溢出。

存 `factor = currentScale / cozy`(相对 cozy 倍率)。下次任意窗口打开:

```js
const factor = parseFloat(localStorage.getItem(key));
viewer.currentScale = factor * computeCozyScale();
```

物理意义"我喜欢比 fit 大 30%"在任何窗口都成立。

## Key 必须包含 spread mode

`jrp.zoomf:<docId>:<mode>`。单页存的 factor 不能套到双页 —— 双页 cozy 本身就只有单页的一半,套同样 factor 意义不一样。**实测过,不分会出 bug**。

## ResizeObserver + window.resize 双保险

容器尺寸变了(横竖屏 / scrollbar 出现 / 窗口 resize)都得 re-fit。`ResizeObserver` 在某些 Quest / 老移动浏览器不稳定,加 `window.addEventListener("resize", refit)` 兜底。

防 ping-pong:applyAutoFit 自己改 scale → 容器内容尺寸变 → RO 再 fire。加 2 帧 rAF guard:

```js
let autoFitGuard = false;
const refit = () => {
  if (!currentPdf || autoFitGuard) return;
  autoFitGuard = true;
  applySavedZoomOrAutoFit();
  requestAnimationFrame(() => requestAnimationFrame(() => { autoFitGuard = false; }));
};
new ResizeObserver(refit).observe(container);
window.addEventListener("resize", refit);
```

## Spread toggle 切回 auto-fit,不用旧 factor

切单 ↔ 双时,**强制重新算 cozy**(同 mode 有 factor 就 `factor × 新 cozy`,没有就纯 cozy)。setSpreadMode 末尾必须 re-fit,因为渲染单元变了,旧 scale 不再合理。

## 我修过的演变史(教训)

| commit | 干啥 | 教训 |
| --- | --- | --- |
| `caae091` | 第一版 cozy targets 900 px | clamp 上界 / 下界 (0.5, 3) 太硬,Quest 窄屏卡 |
| `001d96e` | clamp 改 (0.1, 4) + 加 fit-width 按钮 | 上界还是 9/18 寸 cap |
| `c89fa04` | spread 模式 cap × 2 | OK |
| `d74f3f3` | per-paper zoom key 加 spread mode 维度 | 解决"单页 zoom 跑到双页" |
| `ae33e82` | per-paper 改成存 factor | 跨窗口持久化合理 |
| `781a14a` | scrollbar reserve | 减少 transient 横向 scrollbar |
| `a80c23d` | **修 96/72 单位 bug** | **真凶**。前面所有"宽度不对"投诉的根因 |

以后还出"宽度不对"投诉,**先 console.log naturalCssWidth、availCss、targetCss、s、render 后 page DOM 宽度**,数字对一遍最快。

## 相关
- [20260524-pdfjs-gotchas.md](20260524-pdfjs-gotchas.md) — 96/72 单位坑细节
- [20260524-device-compat.md](20260524-device-compat.md) — Quest / iOS / 4K 各自的 quirks
