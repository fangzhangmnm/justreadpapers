# 交接给下一个 agent —— JRP store 收口后的待办

> as-of 2026-06-28 · 上一轮把 sync-store 库收口到生产级 + 静态验证红线。本 doc 是开放工作的主交接。
> 配套：docs/10(对账+STALE) · 11(加密 port) · 12(真机清单) · 13(身份建模) · src/store/README.md(SSoT)。

## 0. 先记住两条

1. **store = 把文件系统架空**：它把「网络/本地/离线」抽象成一个**路径寻址的虚拟文件系统**——你只跟 path 打交道，离线在线透明。**store 已收口、红线验过、160 测、别动它**（除非走 pwa-cloud-store skill + escalate）。
2. **身份 = path/name**（store 的唯一身份）。「按内容认出同一篇文档」是**文件系统之上的应用语义层**，不归 store。

## 1. 它的现状（不要重做）

**store 已生产级**：path/name 单一身份 · §A 10 条红线静态验证全 SAFE · 加密 wiring 全（codec 注入式/getPassword 模型/encrypt-decrypt/verifyPassword/peek，mock codec 测）· validateAdopt 全 consumer 必传(验解密明文) · callback 卫生(resolveConflict/reportError 必传、askPassword 删) · offload/reconcile/collection-cache/skip-to-offline/C2 TOCTOU 修 · 160 测。**StoreUI 是破坏性签名（回传 WebPaint 时对齐）。**

**prod**：旧 app(ARCHIVE)上传/图库**也 gate 在登录**——所以下面 Bug1/2 **不是回归**，不挡平价 prod。`/dev/`(TS 重写)真机验核心环过了就能 promote 到 `/`（**promote prod 必问 user**）。

## 2. 待办（优先级）

### 🔴 P1 — offline-first 本地图书馆（Bug 1，「无账号可用」红线 + app 层）
**现象**（真机 2026-06-28）：未登录没法用、拖不了论文。**铁证（全 app 层）**：`ui/app.ts:154` `canDrop=galSignedIn`(未登录禁拖)、`:64` `refreshGallery` 未登录清空、`persistence/content.ts:60` `listTree=store.listAll()` 只列云端不用 `localKeys`。
**store 没错**：`file.save` 必写 IDB + push 优雅降级——未登录上传字节照进本地，是 app 不让 + 不显示。
**修（app/folder 层）**：① 允许未登录上传到本地（去 canDrop 的 signedIn gate）② gallery 合并 `store.localKeys()` + 云端 listing（offline-first，未登录/离线显示本地论文）③ 登录后本地论文 sync 上云。
> JRP 一直云优先（旧 app 也是），所以这是**新增 offline-first 能力**、不是修回归。和「folder UI 抽象」同批做。

### 🟠 P2 — 「太监」文档身份层归属 + 双 SSoT（docs/13）
**根因**：JRP 旧代码用内容哈希 docId(`domain/doc-id.ts`,整块字节 SHA)当 catalog key = **第二个身份**（store 是 path/name）。openPaper(`ui/app.ts:210-235`)inline **静默**裁决「同内容两份共位置 / 内容变=新文档塞幽灵 entry / 外部移动 re-bind」——违反 store 自己的 Model-B「决策必 surface」。
**归属**：用文件系统模型看——「按内容认同一篇文档」是文件系统**之上**的应用语义，**归 app reader/library 域，不归 store**。
**先决决策（定了再动）**：
- **A 砍内容哈希**：catalog key 改 path（对齐 store 单 SSoT）。JRP 内改名已更 fileName(位置不丢)；只外部 OneDrive 移动丢位置(wart E 接受到位置上)。最简单。
- **B 留**：做成有纪律的 reader 域层（身份一等、静默裁决 surface、openPaper 退纯 UI 调 `library.open(path)→{blob,docId,position,事件}`）。复杂但位置扛外部移动。
**抽「读者域共享层」**：doc-id + catalog + valuable-save + 打开-解析-绑态 → store 的兄弟库，给 JRP/JustReadBooks/音频位置复用，**不进 cloud-store**（内容哈希身份编辑器用不了：可变内容每改哈希就变）。

### 🟠 P3 — folder UI 抽象 + 拉 siblings（user 方向）
WebPaint + JRP 一起把 **folder/gallery UI** 抽成共享件，顺带拉上 webxiaoheiwu、RealHome。P1(offline-first 图书馆)+P2(reader 域)正好并这批。folder-tree paradigm 是跨 sibling 设计件（PLAN P3 一直欠）。

### 🟠 P4 — store 回传 WebPaint（pwa-cloud-store skill）
把 JRP 领先项带进 WebPaint 单体 store.ts：getToken-no-redirect 修(WebPaint auth.ts:193 还带旧 bug=红线)、codec 注入式 crypto-container、offload/reconcile/collection-cache 下沉、加密 wiring、**validateAdopt 必传 + StoreUI 破坏性签名(resolveConflict/reportError 必传、删 askPassword)对齐**、content-agnostic local-cache 拆分(WebPaint local-adapter 反向 import app=污染)。**WebPaint 红线为准**，逐模块走 skill。回传前确认 WebPaint 传 validateAdopt(它是编辑器=珍贵数据，必须验真 .ora)。

### 🟡 P5 — 零碎
- **Bug 2 不是 bug**：删 IDB 还看到最后一篇 = 论文在 OneDrive、IDB 只是缓存、登录态重载从云还原（云=SoT 设计）。要真忘掉得登出/OneDrive 删。
- **潜在 store robustness**（collection.ts etag-skip）：只删 IDB 留 localStorage(etag 还在)→ hydrate 空 env + etag 匹配 → 跳过重拉 → catalog 留空。正常「清站点数据」一起清不触发；可加「本地真有数据才信 etag」。低优先。
- 双页 🐞 spread mode 1 UI 够不到（引擎现成，暴露即可，FEATURES.md）。
- docs/10 §6 的待补测试 backlog（freshness R1 save-failure 等，已补大部）。
- StoreUI 的 `askPassword` 已删；若 WebPaint 加密 UI 需要解锁循环——那是 app 在 busy 外自管（非 store ui），别加回 askPassword。

## 3. 红线/纪律（别破）
- store 身份=path/name；内容语义身份在 app 层。store 格式盲（GUID-in-content 否决过）。
- 改 store 红线区前读 `src/store/DATA SAFETY GUIDELINE.md` + escalate；走 pwa-cloud-store skill。
- 决策必 surface（Model-B），离线不丢、不静默 LWW、删=move-aside、driven 永不驱逐 dirty。
- promote prod 必问 user。worktree 改完 merge 回 main（出过 remote/local 错位）。
- journal/ 纯人类区，AI 不写。
</content>
