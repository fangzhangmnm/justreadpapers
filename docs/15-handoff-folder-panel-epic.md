# Handoff —— folder-panel epic（写于 store-drift 事故之后）

> as-of 2026-06-23。接手前先读：本文 + `docs/14-folder-panel-epic.md`（设计 SSoT）+ `src/store/README.md`（库手册）。
> 信任顺序：代码现状 > journals 人类原话 > 本文。

## epic 进度（在 dev 上，未真机验；commit 在 main/origin）

设计 SSoT：`docs/14-folder-panel-epic.md`。实现走单 worktree `jrp-folder-panel-epic`，每阶段 ff-merge 回 main + push dev。

- **P1 已上 dev**：回收站视图（恢复/永久删/清空，**in-app confirm，绝不 system confirm**）+ 跨夹「移动到…」folder picker（非拖拽）。content 加 listTrash/restore/purge/emptyTrash。
- **P2 已上 dev（⚠ 手搓，待审计）**：cache/uncache —— `evict.ts`+`pin-set.ts` + file.pin/unpin/evict/isCached/isPinned + store.localKeys + LocalCache.appKeys。gallery ⋯缓存/取消缓存 + cached/pinned badge。8 例对抗测试。**← 这套是 drift 风险面，用户已经开新agent解决，如果缺少合适api请escalate，进入api design phase。**
- **P3 已上 dev**：cloud-sync.listBackup + content.listBackup；gallery **trash+backup 合并成「恢复箱」**（共享 bin 渲染 + 行原语）。
- **README.md 已清理**：回归 tutorial + API overview，删掉细节碎念，规范术语（README.md 不是反馈/历史日志，要对人类透明、不堆黑话）。

剩余：
- **P4 全套加密（最大、红线最密）**：vendor 7z-wasm（1.6MB）+ zip codec + `configureCryptoCodec` 注入（JRP 现在 codec 从未注入 → 加密 inert）+ cloud-sync 扩展名翻转(.zip) + per-file encrypt/decrypt（**对接 JRP push/local-head seam，移植 WebPaint `store.ts:891-947` 的 encryptFile/decryptFile/_swapBytes，不照抄**）+ 密码 in-app sheet（**必须在 busy 遮罩外**，否则死锁）。seal.ts/crypto-container.ts 已健康移植，只差 codec 注入 + transform + UI。**这是 escalate-human + reconcile-canonical 级，走 pwa-cloud-store。** 用户已拍板"这轮顺手做全套"，但鉴于刚出 drift 事故，接手前重新和用户确认切法。
- **P5 模块抽取 + 主题化**：gallery+folder panel 收成可复用自带 CSS/SVG 的主题化组件（CSS 变量两级 fallback + inline currentColor SVG），供 webxiaoheiwu/realhome/JRB/WebPaint 复用。用户说"folder-tree 做完后统一收接口"——现在 gallery.ts 的 props/emit 是务实加的，P5 统一收。

## 其它待办（用户 dump 过、未做）
- **busy 遮罩接 `ui.busy`**（"象1"，独立于本 epic）：JRP persistence 的 `busy:(_l,fn)=>fn()` 是 **no-op** → folder ops 无加载反馈（"创建夹静默"根因）。实现一个吞输入的遮罩接到 store 的 ui.busy seam（store 已给钩子，是 app 没接，不是 store 失败）。
- **加载性能**：`store.listAll` 递归 walk，每文件夹一次 Graph 请求、不缓存 → 每次开库慢。考虑 tree 缓存 / Graph delta。
- **JRB 加载逻辑参考**：锁屏→判在线→fade 下锁/转圈 block→可取消进离线（app-shell 层，store 只喂 online/signedIn 信号）。
- 真机待验清单：P1–P3 的回收站/备份箱/移动/缓存取消缓存；以及更早的续读修复、thumbnails、cloud 账号 popup。

## 规范 / 风格（用户强调）
- **README.md = tutorial + API overview**，对人类透明，**不堆细节、不记反馈、不用 session 黑话**（强杀/续读/surface/红线代号/恢复箱…用规范术语）。
- **无 system dialog**（alert/prompt/confirm）；用 in-app sheet。
- 中文 UI；commit/push dev 是常规，**prod 必问**；worktree 改完 merge 回 main。

## suggested skills（接手按需）
- **`pwa-cloud-store`** —— 任何碰 store 引擎（审计我手搓的 pin/evict、做 P4 加密、改红线）必走，改前 escalate。
- **`fix-vibe-coding`** —— 审计 store drift（"先考古再动刀"）：对照 WebPaint/旧 store.ts/文档，找出新 store 偏离了哪些 vetted 红线。
- **`verify`** / **`run`** —— P1–P3 真机/浏览器验。
