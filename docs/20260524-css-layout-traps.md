# CSS / Layout 几个真踩过的坑

## 坑 1:`#thumbContainer { display: grid }` 干掉 `.thumb-container.hidden { display: none }`

**症状**:打开 PWA 看到一整块纯色背景,以为黑屏。
**原因**:CSS specificity。

```css
#thumbContainer { display: grid; ... }       /* specificity (1,0,0) = 100 */
.thumb-container.hidden { display: none; }   /* specificity (0,2,0) = 20 */
```

ID 选择器赢 → `display: grid` 永远生效 → 概览容器一直覆盖在 viewer 之上 → 你看到的是它的 `--bg-0` 背景色(night 模式 `#121110` 看起来是黑屏)。

**修法**:类名替换 ID:

```css
.thumb-container { display: grid; ... }       /* (0,1,0) = 10 */
.thumb-container.hidden { display: none; }    /* (0,2,0) = 20,赢 */
```

**通用教训**:**配 `.foo` 时,不要再写 `#foo` 又来一句**。规则:**toggle 类的 CSS specificity 必须 ≥ base 状态的 CSS specificity**。

## 坑 2:iOS notch / dynamic island 顶栏被遮

`viewport-fit=cover` 让 PWA 在 iPhone 上画到 safe area 之外,但 status bar / dynamic island 会盖住顶栏。

**修法**:safe-area-inset:

```css
.top-bar {
  position: fixed;
  top: 0; left: 0; right: 0;
  padding-top: env(safe-area-inset-top, 0px);
  padding-left: max(10px, env(safe-area-inset-left, 0px));
  padding-right: max(10px, env(safe-area-inset-right, 0px));
  min-height: calc(36px + env(safe-area-inset-top, 0px));
  align-items: flex-end;  /* icons 贴底,让出 safe-area-top */
}

/* viewer 物理上从 "顶栏 + 安全区" 之下开始,不靠 padding 兜底 */
.viewer-container {
  position: absolute;
  top: calc(36px + env(safe-area-inset-top, 0px));
  left: 0; right: 0; bottom: 0;
}

/* drawer 也要 */
.drawer {
  padding-top: env(safe-area-inset-top, 0px);
  padding-left: env(safe-area-inset-left, 0px);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}

/* 进度条贴在顶栏下沿 */
.progress-bar {
  top: calc(36px + env(safe-area-inset-top, 0px));
}
```

Android cutout 也用同一组 `env(safe-area-inset-*)`,代码不用分。

## 坑 3:doc-row hover 露出 action 按钮会撑高行

行结构:cache-dot (6px) + name (text ~18px line-height) + meta (10px) + row-actions (本来 display:none)。
hover → row-actions display:inline-flex 出现,但按钮 22px → 比 name 高 → 行高从 34 跳到 38 → **悬停闪动**。

**修法**:`.row-actions` 用 `position: absolute` 出 flow,加不透明背景遮 meta:

```css
.doc-row { position: relative; }
.doc-row .row-actions {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  opacity: 0;
  pointer-events: none;
  background: var(--bg-2);  /* 遮住 .meta */
  padding: 2px 4px;
  border-radius: 4px;
}
.doc-row:hover .row-actions {
  opacity: 1;
  pointer-events: auto;
}
```

`opacity: 0 → 1` 不占 flow,行高完全稳定。`pointer-events: none` 在 0 透明度时禁止误点。

## 坑 4:滚动条占空间导致初次 fit 后横向溢出

vertical scrollbar 出来后 `clientWidth` 缩 18px,先按"无 scrollbar"算 fit 的 page 就溢出 18px。

**修法**:cozy 算 fit 时,如果 scrollbar 还没出来,先预留 scrollbar width。检测平台 scrollbar 占不占:

```js
let _sbw = null;
function detectScrollbarWidth() {
  if (_sbw != null) return _sbw;
  const d = document.createElement("div");
  d.style.cssText = "width:50px;height:50px;overflow:scroll;position:absolute;top:-9999px;visibility:hidden;";
  document.body.appendChild(d);
  _sbw = d.offsetWidth - d.clientWidth;  // overlay scrollbar = 0
  document.body.removeChild(d);
  return _sbw;
}
```

只在还没出来 (`offsetWidth === clientWidth`) 时 reserve,否则 clientWidth 已经把它扣了再扣就 double-subtract。详见 [20260524-fit-width-zoom.md](20260524-fit-width-zoom.md)。

## 坑 5:scrollbar styling Quest 不完全听

`::-webkit-scrollbar` 是 Chromium 标准 pseudo,Quest browser 是 Chromium 但 OS UA stylesheet 默认 scrollbar 极细。我加 `!important` + 24px + `overflow-y: scroll` 强制常驻,在 Quest 上仍然偏细。

**当前 mitigation**:CSS 加 `!important` 至少保住 Windows / Mac OK。Quest 上如果真要修,fallback 是 JS 自己 roll overlay scrollbar (~100 行,thumb 是个 div,scroll 事件同步位置,pointer drag 改 scrollTop)。

```css
.viewer-container { overflow-y: scroll !important; }
.viewer-container::-webkit-scrollbar { width: 24px !important; height: 24px !important; }
.viewer-container::-webkit-scrollbar-thumb {
  background: var(--accent-strong) !important;
  border-radius: 12px !important;
  min-height: 48px;  /* 小文档时 thumb 也够大 */
}
```

## 坑 6:drawer mutex 跟 backdrop 共用

papers drawer / outline drawer / overview 不应该一起开(挤一起视觉乱)。**mutex**:同一时刻最多一个开。共用一个 `.backdrop` (半透明蒙层),点 backdrop 关所有 drawer。

```js
function closeDrawer() {
  drawer.classList.add("hidden");
  outlineDrawer.classList.add("hidden");
  drawerBackdrop.classList.add("hidden");
  openDrawerName = null;
}
function toggleDrawer(name) {
  if (openDrawerName === name) { closeDrawer(); return; }
  closeDrawer();
  // 然后 open name
  ...
}
```

按钮点击 toggle:相同 → 关,不同 → 切。第二次点同一按钮是退出,**符合 mobile 习惯**。

## 坑 7:Light theme 上的 light text 在 button 上读不出

我有 `accent` 颜色(铂金 / 金),button background 用 accent 时,文字颜色不能用 `#fff8ec`(浅米色,对比度差)。

**修法**:定义 `--on-accent`(在 accent 上面的对比文字色):

```css
:root {
  --accent: #B7B19F;
  --on-accent: #2A2620;  /* 浅 platinum 上用深色 */
}
:root[data-theme="night"] {
  --accent: #C8A24C;
  --on-accent: #121110;  /* 金色上用近黑 */
}
.button-primary {
  background: var(--accent);
  color: var(--on-accent);  /* 不用 white / #fff */
}
```

主题切换不用关心 on-accent 的对比,token 自动跟着切。

## 相关
- [20260524-fit-width-zoom.md](20260524-fit-width-zoom.md) — scrollbar reserve in fit calc
- [20260524-thumbnail-overview-diy.md](20260524-thumbnail-overview-diy.md) — 坑 1 出处
- [20260524-device-compat.md](20260524-device-compat.md) — safe-area / DPR 各设备
