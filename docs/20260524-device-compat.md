# 三类设备的 quirk(iOS / Quest / 4K desktop)

## 通用 debug 起手:打 init log

每次 viewer init 时 dump:

```js
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
```

让用户在出问题的设备上贴 console 出来,数字摆出来才能定 quirk。

## iOS Safari / iOS PWA

### `structuredClone` 在 iOS Safari < 15.4 没有

```js
// ❌ 在老 iOS 上 throw
const snapshot = structuredClone(state);

// ✅ 兜底
const snapshot = JSON.parse(JSON.stringify(state));
```

我们这个 state 只是简单 nested object,JSON 深拷贝够用,无 perf 损失。

### iOS PWA 冷启动 fetch 走 cache,不 fire SW asset-updated

iOS 主屏 PWA 启动时,fetch 大量走本地 cache,不打网。SW fetch handler 的 eTag diff (path A) 永远 miss → 用户永远看不到新版。

修:加上 `registration.updatefound` 和 `registration.waiting` 检测,**每次 push bump CACHE_VERSION 改 SW 源 byte** 才能触发 updatefound。详见 [20260524-pwa-hot-update.md](20260524-pwa-hot-update.md)。

### Safe-area-inset 必备

iPhone 刘海 / dynamic island 会盖顶栏。`viewport-fit=cover` + `env(safe-area-inset-top)` 才不被遮。drawer / progress bar / 顶栏都要。详见 [20260524-css-layout-traps.md](20260524-css-layout-traps.md) 坑 2。

### `pagehide` > `beforeunload`

iOS Safari 上 `beforeunload` 不一定 fire(尤其 Bfcache 切换),`pagehide` 更可靠。两者都挂,一起 flush:

```js
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushKeepalive();
});
window.addEventListener("pagehide", flushKeepalive);   // ← iOS 必备
window.addEventListener("beforeunload", flushKeepalive);
```

### overlay scrollbar 不占空间

iOS 浏览器默认 overlay scrollbar,`scrollbarWidth() === 0`。fit-width 算 reserve 时要 detect 这点,不要无脑减 18 留出 18px 白边。

### Pinch-to-zoom 别全局禁

`user-scalable=no` 会被 a11y 工具骂。如果某些区域(grid overview)不该 pinch,用 `touch-action: pan-y` 局部禁。

## Meta Quest browser

### 是 Chromium,但 OS 加了奇怪缩放

Quest 浏览器基于 Chromium,所以 CSS / DOM / SW / `::-webkit-*` 都是标准。但 OS 给 CSS px 一个非整数缩放(DPR 2.275 这种),且 perceived CSS px 物理偏大(虚拟屏比 desktop 近)。

我之前加过 UA 因子 `0.7×` 缩小 cozy 目标,然后又删了 —— 因为它跟"小屏 fill"原则矛盾。**现在没有 UA 特例**,Quest 上 page 可能感觉偏大,用户用 zoom- 按钮(per-paper factor 自动存)自己调。

### 没键盘,没 Ctrl,没鼠标 wheel

不能依赖:
- Esc 键(没键盘)
- Ctrl+wheel(没鼠标)
- Ctrl+S / 任何快捷键

任何"键盘退出"功能必须配 **可见 UI 按钮 fallback**。zoom +/-/fit-width 都做了按钮(在 drawer 视图控制行)。Esc 是 bonus,不是主路径。

### Pointer 精度差,touch target ≥ 22-32px

Quest 控制器是激光指针,有抖动。`.icon-button` 至少 22×22 (svg 14×14),`.vc-button` 用 40px 高。`.row-actions` 按钮也别用迷你 16×16。

### 滚动条 styling 不一定听

Quest browser 默认 OS scrollbar 偏细。我用 `!important` + 24px + `overflow-y: scroll` 强制常驻,Windows OK,Quest 仍有"听不到"的可能(没确认实机最终效果)。

Fallback:JS 自己 roll overlay scrollbar (~100 行,thumb div + pointer drag)。我没做。

### ResizeObserver 不一定每次 fire

实测 Quest / 老移动端浏览器 RO 有时漏 fire。**加 `window.addEventListener("resize", refit)` 兜底**:

```js
new ResizeObserver(refit).observe(container);
window.addEventListener("resize", refit);
```

两个都接,双保险。

## 4K / 大屏 desktop

### CSS px = ~1/96 inch 在 4K 上仍成立(浏览器自补偿 DPR)

4K 50" 显示器,物理像素 3840 px,DPR 通常 1.5-2,CSS px ≈ 1920-2560。CSS px size 物理 ≈ 1/96 inch(浏览器约定)。

我的 cozy `cap = 9" × 96 = 864 px`,4K 上 page 渲染 ~864 css px 宽,perceived ≈ 9 物理英寸。**正合 "comfortable 阅读宽度"**。

cap 是 page **不太大** 的上界,**不是** page **不太小** 的下界。用户多次质疑我把 min/max 搞反 —— 实际上我没搞反,`Math.min(availCss, cap)` 让 page 不超过 cap = 不太大,**也** 不超过 availCss = fit container。这是 min 的两层意思。

### 测试时主动 resize 窗口

桌面测时拖小窗口 → 缩到 < 864 → page 应该开始变小。如果不变,RO/resize listener 没 fire,见 [20260524-fit-width-zoom.md](20260524-fit-width-zoom.md)。

## DPR 非整数(2.275 等)

OS 自定义 UI 缩放(Windows 175% 或 Android textScale)。1 CSS px 不一定 = 1/96 inch 物理。我的 cap 假设 CSS px ≈ 1/96 inch,在非标准 DPR 上偏差不可避免。

**记下来,但 MVP 不处理**。如果某天用户多了大量 "weird DPR" 设备,可以基于 `screen.width × dpr / 假定 PPI` 估算物理英寸,做更精确的 cap。

## 测试 matrix(每次大改动跑一遍)

| 设备 | 测什么 |
| --- | --- |
| Windows desktop Chrome | 基础功能 + cozy + zoom 按钮 + scrollbar |
| iPhone Safari 竖屏 | safe-area + pagehide flush + overlay scrollbar |
| iPhone Safari PWA 主屏 | hot update 看得到 + ClipboardItem 可用 |
| Quest browser | viewer 不溢出 + zoom +/- 能点 + 顶栏不挤刘海 |
| 4K 27"+ | cap 生效 page ~864px,resize 缩到 800 page 应变小 |

## 相关
- [20260524-fit-width-zoom.md](20260524-fit-width-zoom.md) — cozy 公式怎么平衡这些 quirks
- [20260524-pwa-hot-update.md](20260524-pwa-hot-update.md) — iOS PWA 更新检测
- [20260524-css-layout-traps.md](20260524-css-layout-traps.md) — safe-area / scrollbar 细节
