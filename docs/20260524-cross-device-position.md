# 跨设备位置恢复

核心:**位置存 PDF 文档坐标,不存 viewport 像素**。

## 数据结构

`session.json` 里每篇:

```json
{
  "position": {
    "pageIndex": 6,
    "yFraction": 0.38
  }
}
```

- `pageIndex` = 0-based 物理页号(PDF 是 fixed-layout,跨设备稳定)
- `yFraction` = reading-line 在该页内的高度比例 [0, 1]
- **绝不存 `scrollTop` / viewport offset 这种像素值** —— 跨屏幕完全没意义

## Reading-line 概念

用户的"眼睛实际所在的行",视觉上设定为 **viewport 高度的 25%**:

```js
const READING_LINE_ANCHOR = 0.25;
```

读位置:从滚动位置算 reading-line,找它落在哪页的哪 yFraction。
写位置:反向 —— 把保存的 (pageIndex, yFraction) 渲染到 reading-line (viewport 25% 处)。

为什么 25%(不是顶部):spec 原话 "用户眼睛实际在的行,周边上下文随屏幕变,这是物理,不是 bug"。25% 让上下文都能看到一点,跨设备体感最稳。

## 读位置(currentPosition)

```js
function currentPosition() {
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
  return null;  // ← 不要兜底返末页!见 01-pdfjs-gotchas 坑 5
}
```

## 写位置(restorePosition)

```js
function restorePosition({ pageIndex, yFraction }) {
  const pv = viewer.getPageView(pageIndex);
  if (!pv?.div?.offsetHeight) {
    pendingRestore = { pageIndex, yFraction };  // 等 pagesloaded 再试
    return;
  }
  const pageTop = pv.div.offsetTop;
  const readingLineY = pageTop + pv.div.offsetHeight * yFraction;
  isRestoring = true;
  container.scrollTop = readingLineY - container.clientHeight * READING_LINE_ANCHOR;
  // 2 帧 rAF 后再校准一次,因为 scale change / page render 会 re-flow
  requestAnimationFrame(() => requestAnimationFrame(() => {
    container.scrollTop = pv.div.offsetTop + pv.div.offsetHeight * yFraction
      - container.clientHeight * READING_LINE_ANCHOR;
    isRestoring = false;
  }));
}
```

要点:
- 早期 page 没建好 (offsetHeight = 0) → 挂 `pendingRestore` 等 `pagesloaded` 事件
- 2 帧 rAF 后再 nudge,因为 scale change / page render 会 re-flow
- `isRestoring` flag 期间禁用 scroll handler 上报(不然刚 restore 又被覆盖回去)

## Zoom / fit-mode 是 device-local,不 sync

跨设备 sync 的只是 `position`。zoom / spread mode / fit-mode 全存 localStorage,**不进 session.json**。

为什么:同一篇在 desktop 偏好 1.2 倍,在 phone 偏好 fit-width,在 Quest 偏好 0.8 倍 —— 三套 device 偏好,sync 反而互相覆盖。

## Spread mode 下的 position 语义

`pageIndex` 在 spread 里指向 "reading-line 落在的左页或右页"。我的 `currentPosition` 实现是 first match → 左页。

承认 limitation:在 spread mode 设备 A 读到右页底,switch 到单页 mode 设备 B → 它会恢复到左页底。**视觉位置差半页**,但段落 / 章节大致对得上。spec 说"接受残留"。

## 跨设备位置切换的完整链路

1. Device A 滚动 → `currentPosition()` → `setPosition(itemId, {pageIndex, yFraction})` → 节流写 OneDrive
2. Device B 打开同篇 → 读 session.json → `loadPdf({position})` → pagesinit 后 `restorePosition`
3. 体感 = "我在 desktop 读到这,Quest 一开就在这"

如果 (1) 的节流过激,(3) 会 stale。见 [20260524-session-sync-throttle.md](20260524-session-sync-throttle.md) 的 close-event 兜底设计。

## 相关
- [20260524-fit-width-zoom.md](20260524-fit-width-zoom.md) - zoom 是 device-local 的,跟 position 分清
- [20260524-session-sync-throttle.md](20260524-session-sync-throttle.md) - position 怎么节流写 OneDrive
