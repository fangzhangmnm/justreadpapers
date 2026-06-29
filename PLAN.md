# JustReadPapers —— 纯 TS greenfield 重写：架构提案 (v2)

> as-of 2026-06-19 · 分支 `rewrite-ts-greenfield` · **proposal**，待 user 定稿才动手。
> v2：读了 `journals/20260518 proposal.md`（产品北极星 spec）+ `cached feedback JRP.md` 后重构——见 §1 的 4 个重构。
> 脊柱见集群根 `CLAUDE.md`；store 红线见 `MyPWAPatterns/docs/MASTER.md §A`（identity=path/name）。

## 0. 北极星（spec 原话，判断取舍按这个）

1. **产品全部价值 = 1-click resume。** 打开 = 已经在读那篇、那页、那滚动位置。严格 1 次点击。
2. **没有 library 落地屏。** 落地态就是上一篇全屏。文件面板默认不出现。
3. **单表面。** PDF viewer 全屏 ZEN MODE，不分屏、不多 pane。
4. **content(PDF) 可丢弃可重下；session(catalog) 神圣、要稳要 sync。** 一切取舍按这条。

## 0b. 工程硬约束（已拍板）

- **纯 TS greenfield，旧 JRP 代码一律不抄**（`ARCHIVE/*.js` 只当算法/UX spec 读，重新写 TS）。`src/store/` 是 WebPaint bake 的共享依赖（FORK-BASE 戳），不算抄旧 IP。
- **store 是唯一持久化接缝**：app 不直接碰 OneDrive/localStorage/IndexedDB。
- **UI = Vue**（vendor `vue.esm-browser.prod` + template 字符串 + esbuild，对齐 WebPaint pilot；user 2026-06-20 定）。domain/persistence **framework-free**（valuable-save 等纯模块不受影响）；pdf.js viewer 当 **imperative island**（Vue 组件里 mount，pdf.js 自管 canvas/DOM）。
- UI 全中文、无 system dialog、SVG icon、vendor 一切（pdf.js/MSAL/**Vue** 复用）。
- Quest 一等公民（截图当前页→剪贴板、滚动条宽度、DPI/safe-area）。纯 URL 访问(不装 PWA)必须完整可用。
- UI 可抄兄弟 `../webxiaoheiwu`、`../background radio`（user 批准，思路策略一样）——文件面板/idle-conflict toast/暖主题。

## 1. spec 强制的 4 个重构（v1→v2 的关键认识）

1. **资产 = catalog，不是"一堆位置"。** `session.json = {lastActive, docs:{docId:{fileName,title,authors,year,arxivId,position,deleted}}}` = 论文注册表。**它正好是一个 folder-store（items-doc）**：item=doc，id=docId，payload=元数据+position，trash=deleted。library UI 读 catalog（不是 listAll `/papers/`）。`/papers/*.pdf` 只是被 catalog 寻址的字节。
2. **identity = docId（arxivId | 内容 hash），不是 path。** catalog 存 `docId→fileName`，所以改名（含跨设备）位置不脱链（docId 不变）；wart E 不适用。path 只是 catalog 里的可变属性。
3. **关键路径 = resume 序列**（token→catalog→全屏 viewer 跳 lastActive 的 position→字节缓存/downloadUrl）。抽成一等 `resume` 编排器。viewer = 唯一主表面；library = 滑出 panel。
4. **ingest 是真模块**（漏过）：本地上传/arxiv+proxy/auto-rename。

## 2. 模块架构（按关键路径 + catalog-centric 组织）

```
vendored:   src/vendor/pdfjs   src/vendor/msal           (原样)
baked:      src/store/**       = sync-store (WebPaint)    (v1 零改)
            └ provider(OneDrive+auth) · cloud-sync(per-file 字节) · folder-store(items-doc) · settings(KV)

唯一持久化接缝 ▼
src/persistence.ts   装配 store，对 app 暴露 3 面:
   catalog   (over folder-store, name="session")  ← 那个 asset
   content   (over cloud-sync/provider)            ← PDF 字节,可丢
   settings  (over store settings KV)              ← device-local

纯域模块 (TS 重写,零 IO/DOM,可单测) ▼
   domain/doc-id.ts          docId = arxivId | sha(bytes)
   domain/valuable-save.ts   位置保存节流 (trivial-skip+debounce+ceiling)
   domain/viewer-geometry.ts {pageIndex,yFraction}↔scroll · cozy fit · scrollbar 预留 · spread reflow
   domain/catalog-merge.ts   (可选) folder-store 的 field-level resolve(position vs 元数据)

关键路径 ▼
   src/resume.ts             启动编排:token→catalog→render lastActive@position→bytes
   src/ingest.ts             upload(now)/arxiv(proxy,later)/auto-rename

UI (imperative DOM,中文,zen 单表面) ▼
   ui/viewer.ts          全屏 pdf.js 连续滚动 = 主/唯一表面
   ui/library-panel.ts   边缘滑出:recent sessions + 文件管理(list catalog/改名/日期排序/trash/切篇)
   ui/folder-tree.ts     深模块,panel 内文件夹导航 (store-adjacent,未来抽共享)
   ui/thumbnails.ts      DIY 缩略图总览 (IntersectionObserver)
   ui/reading-controls.ts zoom/spread/outline (调 settings)
   ui/quest.ts           截图→剪贴板 · 滚动条宽度 · DPI/safe-area
   ui/status.ts          极小状态行 (p.7/32·synced) + "有更新/新版本" toast

shell ▼
   main.ts               组合根:构造 persistence→跑 resume→挂 UI→注册 SW
   service-worker.js     app-shell cache-first + 更新检测 (+ PDF Cache 见 §4)
   src/pdf-cache.ts      PDF 字节缓存 (见 §4 开放问题)
   index.html  styles.css
```

### 2b. UI 架构 = greenfield Vue（**不抄 WebPaint 的 brownfield 岛**）
WebPaint 的 Vue 是 brownfield：Vue 岛 `mountXxx(el,{getX,onY})` 用 ref 桥进命令式 app.js——retrofit 妥协，**不抄其结构**。只复用机械工具链（vendored `vue.esm-browser.prod` 3.5.35 + template 字符串 + esbuild）。JRP **Vue 一路到底**：
- **reactive 应用 store**（`src/app-state.ts`：Vue `reactive()` + composable + provide/inject）= UI 单一反应式真相源,包住 persistence(catalog/content/settings)+domain(当前 doc/viewer/同步态)。组件**直接消费,无命令式 app 桥**。
- 组件树：`App` → `Viewer`(pdf.js imperative island,onMounted 驱动 PDFViewer,watch 当前 doc 重载,scroll→store.setPosition) / `TopBar` / `LibraryPanel`→`FolderTree` / `OutlineDrawer` / `ThumbnailOverview` / `StatusLine` / `Toasts`(更新/冲突/idle) / `ReadingControls`(zoom/spread/theme via settings)。
- **reactivity 纪律(WebPaint 踩出来的 Vue 事实,干净地一开始就守)**：leaf 过边界传**值快照**不传活引用(props 相等闸 + computed 依赖闸会断信号)；cross-cutting state 走 reactive-SSoT,窄值 seam 走 leaf-by-value；**pdf.js 页 canvas / in-flight 渲染 / pdf.js 内部状态绝不进 reactive 图**。

**side panel = 可抽取深模块 paradigm（user 2026-06-20）**：不只是文件列表,而是 `FolderTree`(**嵌套子文件夹**导航,读 `content.listTree()` 的 folders) + **菜单**(改名/删/排序/新建夹…) + **云选项**(登录/登出/同步状态/手动刷新,绑 `auth` + catalog 同步态)。整体写成**自洽深模块**(reactive over persistence 的窄面,UI 语义自包含),目标是日后**搬给 JRB / WebXiaoHeiWu 当 side-panel paradigm**——所以接口按"任意 folder-tree + 文件管理 + 云"抽象,别糊死 JRP 专属。

## 3. 三个持久化面（把红线钉死在 persistence.ts 一处）

`src/persistence.ts` 是**唯一** import `src/store/*`、构造 provider/folderStore/settings 的文件，一处注入 MSAL config + localStorage 包装的 kv（store 内部用）。grep `src/`（除 persistence + store）出现 `localStorage|indexedDB|graph|msal` = 违规。

- **`catalog`**（over `createFolderStore`，name=`"session"`）= 那个 asset
  - `list()` / `get(docId)` / `upsert(docId, meta)` / `setPosition(docId, pos)` / `trash(docId)` / `restore(docId)` / `subscribe(fn)`。
  - **lastActive = 派生**（max-uat 的 item；打开/读一篇就 touch 它的 uat）——不存独立字段（比旧 session.json 简化一格）。
  - 免费拿 If-Match 412 merge + per-id uat-LWW + trash(edit-wins)。旧 `session.json` 迁移在 decode 注入。
  - **不做**：不直接碰 cloud。
- **`content`**（over `cloud-sync`/provider）= PDF 字节
  - `read(fileName): Blob`（pull，过 `pdf-cache`）/ `upload(fileName, blob)`（ingest）/ `rename(old,new)` / `trash(fileName)` / `restore`。
  - **不做**：不 push catalog、不查字节 dirty/status（避 G2 footgun）。
- **`settings`**（over store settings KV）= device-local：zoom factor / spread mode / theme。app 调 `settings.get/set`，store 落 localStorage，**app 不碰 localStorage**。

## 4. 开放问题（要你拍）

1. **PDF 字节缓存放哪？**（红线②边界）PDF=只读可重下的 hamster mirror（家族模型 evict-iff-clean∧refetchable）。spec 原本说 IndexedDB LRU，但你定了 app 不碰 IDB。三选：
   - **(A 推荐)** **Cache API**（SW 管）+ 薄 `pdf-cache.ts` frecency-LRU(250MB)。Cache API ≠ 你禁的 IDB/localStorage，是 re-fetchable 远程文件的天然家；store 专注 asset。
   - (B) 走 store LocalAdapter——写死 ORA(G5)，要先 backprop 格式无关只读镜像缓存=store 改动。
   - (C) 你认为只读镜像缓存也必须归 store→新 gap，一起设计+backprop。
2. **catalog 并发合并粒度**：folder-store 默认整-entry uat-LWW。position(常变) vs 元数据(罕变) 并发时整-entry LWW 可能丢字段。v1 接受（reader 的 update 携带它那份元数据胜，够用），还是注入 field-level `resolve`（`catalog-merge.ts`）？我倾向 v1 接受、留 resolve 钩子。

> 已定：**identity = docId（内容 hash | arxivId）**（user 2026-06-20 确认）——catalog 按它键，存 docId→fileName。**folder 现名** v1 直接用，改名走 backlog item 1。**PDF 缓存** (#1) 延后到 P3 再定（不挡 P1，content.read 先直 pull）。

## 5. 阶段（resequenced 2026-06-20：dev/prod + PWA shell 提前,好让 user 监管 /dev/）

- **P0 工具链** ✅（package.json/tsconfig/build.sh/.gitignore；store baked；旧 code 进 ARCHIVE）。
- **P1 域模块（进行中）**：`domain/valuable-save` ✅（7 测过，逮哨兵 bug）。接着 `domain/{doc-id,viewer-geometry}`，纯模块配 node 单测。
- **P1.5 部署骨架（提前 = 解锁监管）**：vendor Vue → 最小 Vue app 骨架（main.ts mount）→ **PWA shell**（service-worker 重写：app-shell cache-first + 4 路更新检测 + 离线 + manifest）→ **dev/prod 分离**（GH Actions `main→/dev/`，prod 另开）。产出**可部署 `/dev/`**。此后 merge WIP 回 main 只动 `/dev/`、**prod 不动** → user 实时监管。PWA shell + deploy 写成可抽取 = 家族 **sw-kit** 候选 artifact。
- **P2 持久化 + resume**：`persistence.ts`（catalog/content/settings 三面，装配 store）+ `resume.ts`（启动编排：token→catalog→render lastActive@position→bytes）。打通 spec build-order #1+#2 → Quest 场景成立。store 红线改动若需→escalate。
- **P3 UI（Vue）**：viewer（imperative island，主表面）→ library-panel → folder-tree → thumbnails/reading-controls/quest/status。抄 webxiaoheiwu 面板/conflict/暖主题 + FEATURES.md parity。
- **P4 ingest**：本地上传 + auto-rename（修双页 bug、接死按钮也在这批）。下载（URL）留到重构跑通后。
- 每阶段 node 测过 + `/dev/` 部署看过。**promote prod 前问人。**

## 6. 排期外 / parked

- **下载（URL 摄入）= 重构跑通后的高优**（user 2026-06-20），不是本轮。设计已定，本轮**只为它留接缝不实现**：
  - **单一输入入口**，app **自动判断** arxiv vs 任意 PDF 链接；arxiv 要**多格式匹配**（abs/pdf 链接、export 子域、新式 `1102.5064v2`、老式 `hep-th/9901001`、带/不带版本…）。
  - 命中 arxiv → 走 arxiv 路（顺带抓 title/authors/year metadata）；否则当直接 PDF 链接。
  - **需 CORS proxy**（静态页跨域 fetch 被挡）——**那时再建**。建时要：① 跟 user 解释 CORS proxy 是什么；② **守 anti-abandonware（ADR-0006 / MASTER §C）**：proxy 不能成单点故障/弃用砖——proxy 挂了 app 与数据仍完好，proxy 只是 autofill 便利，能 recover-without-proxy。
- AtlasMaker 不碰（等 JRP 跑通验证 kit）。
- store v1 零改动；G2/G4/G5 backprop 缓（backlog）。
- AI summary/陪读、notes/LaTeX 笔记本 —— spec 明确 OUT，别为它们预留复杂度。

## 7. 参考
- **spec（北极星）**：`journals/20260518 proposal.md`（AI 只读不写）+ `journals/cached feedback JRP.md`。
- spec 算法/UX：`ARCHIVE/*.js` + `docs/*`（13 篇：cross-device-position/fit-width-zoom/pdfjs-gotchas/session-sync-throttle…）。
- UI 抄源：`../webxiaoheiwu`、`../background radio`。
- store：`src/store/FORK-BASE.md`、`MyPWAPatterns/docs/MASTER.md §A`、`MyPWAPatterns/docs/20260619-backlog.md`。
