# docs / 索引

这是 justreadpapers 项目踩坑总结,**只写做过的那些**(主要是 PDF viewer + OneDrive sync + PWA 离线 + iOS/Quest/4K 多设备适配)。后来者(尤其 AI)做类似项目可以参考。

## 推荐阅读顺序

新项目接手前先看 [00 + 11](#),其它按需查。

| # | 文档 | 一句话 |
| --- | --- | --- |
| 00 | [设计原则](00-design-principles.md) | 1-click resume / SSOT / 单表面 / device-local vs cross-device / iOS-Quest-4K 兜底 |
| 01 | [pdf.js 隐藏地雷](01-pdfjs-gotchas.md) | 96/72 单位坑 + 只 export 3 个类 + page-width spread 坑 + display:none scrollIntoView |
| 02 | [Fit-width / cozy / zoom](02-fit-width-zoom.md) | 公式推导 / scrollbar reserve / per-paper factor 不绝对 scale / RO + resize 双保险 |
| 03 | [跨设备位置恢复](03-cross-device-position.md) | {pageIndex, yFraction} PDF 坐标,reading-line 25%,撕页期返 null 不兜底 |
| 04 | [MSAL + Graph AppFolder](04-msal-graph-pattern.md) | SPA + Delegated,silent token 探测,clearCache 不 logoutRedirect,If-Match |
| 05 | [Session.json 节流 + 冲突](05-session-sync-throttle.md) | 10s debounce / 30s ceiling / trivial-skip 50% / close-event 三条兜底 / 412 merge |
| 06 | [PWA 热更新](06-pwa-hot-update.md) | 三条检测路径 (asset diff + updatefound + waiting) / iOS PWA / bump CACHE_VERSION |
| 07 | [离线持久化](07-offline-persistence.md) | SW precache CDN deps + listChildren fallback to cache + localStorage session backup |
| 08 | [自己 roll 的缩略图概览](08-thumbnail-overview-diy.md) | CSS Grid + IntersectionObserver lazy render + dpr cap 2 |
| 09 | [CSS / Layout 坑](09-css-layout-traps.md) | specificity 黑屏 / safe-area / hover 行高跳 / scrollbar reserve / mutex drawer / on-accent token |
| 10 | [iOS / Quest / 4K 兼容](10-device-compat.md) | structuredClone < 15.4,pagehide,RO 不稳定,scrollbar styling 不一定听 |
| 11 | [跟这个用户的协作风格](11-user-iteration-style.md) | 节奏 / 反馈方式 / 选项+tradeoff / 短 blunt / commit 风格 |
| 12 | [Cache frecency](12-cache-frecency.md) | LRU + LFU hybrid,score = lastUsed + useCount × 24h,250MB cap |

## 主要决策追溯(commit 维度)

- 第一版 (`655618f`):脚手架,MSAL + AppFolder + PDF viewer + IndexedDB cache + drawer
- UI 收敛 (`a5a88e7`, `c0b0289`):text selection + middle-mouse pan + 主题 token + outline drawer
- Throttle 收敛 (`070b1a7` → `b90d5cc` → `f43e5f3`):debounce → +ceiling → +trivial-skip → 调参 50% / 10s / 30s
- PWA 热更新 (`7d5d839`):iOS 三条路径 + CACHE_VERSION bump 规矩
- 离线持久化 (`8b2038f`):SW CDN cache + localStorage backup + listChildren fallback
- 缩略图概览 (`d284bdb`):pdf.js 不暴露 thumbnail viewer,自己写 + IO lazy
- fit-width 96/72 bug (`a80c23d`):**单位坑,十几个 commit 才找到**
- scrollbar reserve / ResizeObserver / window.resize 兜底:小修一堆

## "再做一个类似项目" 的最短 checklist

1. **先读 [00-design-principles.md](00-design-principles.md)** 内化 5 条北极星
2. **PDF viewer**:从 pdf.js 起,**单位写进变量名** (`naturalCssWidth` vs `naturalPdfWidth`),公式带 96/72 因子
3. **OneDrive AppFolder**:Azure 注册 SPA + Delegated + Files.ReadWrite.AppFolder + offline_access
4. **session.json + If-Match** 写盘,无 conflict 不要 polling,window focus 时查 eTag
5. **PWA SW**:同源 cache-first + CDN cache-first + bump CACHE_VERSION 每次部署
6. **iOS / Quest / 4K 三类设备的兜底**:safe-area / pagehide / overlay scrollbar / RO + window.resize
7. **device-local localStorage** vs **cross-device session.json** 严格分

## 这套文档**不**覆盖

- 具体 commit 的 diff(查 git log)
- pdf.js 自身 API(看 mozilla/pdf.js 文档)
- Microsoft Graph API(看 docs.microsoft.com)
- 新功能 brainstorming(看 `journals/`)
