# 设计原则(给后来者 / AI)

跑了几十个 commit 总结的「决策北极星」,每次拿不准就回看这里。

## 1. 1-click resume 是产品全部价值

打开 URL → 立刻回到上次那篇论文的那一页。**严格 1 次点击**(0 最好)。任何让用户多点的设计都要被怀疑。

落地态不是"论文 list 让你挑",是**上一篇 + 全屏 viewer + 正确的页 + 正确的 yFraction**。

## 2. 单 SSOT,asset 与 cache 严格分离

- **OneDrive 上的 `session.json` = 唯一 asset**(lastActive / 每篇 position / metadata)。小、瞬间 sync,失败要兜底重传。
- **PDF 文件 = 可丢弃 cache**(IndexedDB)。能重下 / 重传。挂了不要紧。
- **取舍永远按这条**:asset 神圣,cache 随便。

不要建本地数据库当影子 SSOT,会 fork。

## 3. 单表面、零 chrome、ZEN

主表面只有一个 = 全屏 PDF viewer。**不分屏、不做多 pane IDE**。
顶栏窄到极限(24-36 px),按钮能塞进 drawer 就塞 drawer。

## 4. device-local 偏好 vs cross-device 状态分清

| 类别 | 存哪 | 例子 |
| --- | --- | --- |
| cross-device 阅读状态 | session.json (OneDrive) | lastActive, per-doc {pageIndex, yFraction} |
| device-local 偏好 | localStorage | zoom factor (per-paper), spread mode, 主题, sort |
| 本地 cache | IndexedDB | PDF blob |

混在一起就会有"我在桌面调的字号在 Quest 也变了"这种诡异。

## 5. 没有自动测试 → 每改一处问"会不会破 1-click resume"

scroll-to-bottom、黑屏、fit-width 偏 33% 都是细微改动连带破了主流程。修 bug 之后回到 lastActive 测一次再 push。

## 6. iOS / Quest / 4K 三类设备同时跑

- 不能假设 keyboard / Ctrl key 存在(Quest 无键盘)
- 不能假设 webkit-scrollbar / 内置 zoom 工作(Quest 不一定听)
- 不能假设 CSS px ≈ 1/96 inch(Quest perceived 偏大,DPR 非整数)
- 不能假设 hover 存在(touch)
- 不能假设 visibilitychange / beforeunload 都 fire(iOS 偏好 pagehide)

每个改动至少在脑里跑一遍三类设备。

## 7. 用户改动节奏快,iterate frequently

- commit-per-feature,push 立刻
- 用户读 commit message 当 changelog,所以**写人话**(不写无意义 "updated foo")
- 每次 push **bump `CACHE_VERSION`**,否则 PWA 用户(尤其 iOS)看不到新版

## 相关
- [01-pdfjs-gotchas.md](01-pdfjs-gotchas.md) — pdf.js 隐藏地雷
- [05-session-sync-throttle.md](05-session-sync-throttle.md) — asset sync 节流
- [11-user-iteration-style.md](11-user-iteration-style.md) — 跟这个用户的协作风格
