# JRP 路线图 & 进度锚点

> as-of 2026-06-22 · 把 `PLAN.md`（master 架构提案 v2，as-of 2026-06-19）锚到当前现实。
> **store 大改是一段大 detour**（占了整个 2026-06-22 session）——本文把"做了什么 / 还欠什么"理清，
> 让下个 session 接回 **JRP 功能正题**（别再丢给 store）。
> 信任顺序：代码现状 > journals 人类原话 > 本文（AI 写的 how，最易腐烂，反直觉处去 `journals/` 验）。

不重复的权威源（按 path 引，不抄进来）：
- **产品北极星**：`journals/20260518 proposal.md` + `journals/cached feedback JRP.md`（AI 只读不写）。
- **master 架构 + 阶段 + parked**：`PLAN.md`（§5 阶段、§6 parked 下载/arxiv、§4 开放问题）。
- **store 库**：`src/store/STORE.md`（新 API SSoT）、`src/store/CONTEXT.md`（domain 术语）、`src/store/OLD-ENGINE.md`（旧引擎全貌）、`docs/reports/architecture-review-*.html`（拆分报告）。
- spec 算法/UX：`docs/00–12`（cross-device-position / fit-width-zoom / pdfjs-gotchas / session-sync-throttle …）。

---

## PLAN.md 阶段 —— 当前状态

| 阶段 | 状态 | 备注 |
|---|---|---|
| **P0 工具链** | ✅ | esbuild bundle + content-hash + tsc 门 + store baked + 旧 code 进 ARCHIVE。 |
| **P1 域模块** | ✅ | `domain/{valuable-save, doc-id, viewer-geometry}` 纯模块 + node 测（含双页 spread 修复）。 |
| **P1.5 部署骨架** | ✅ | vendor Vue 3.5.35 + greenfield Vue app + PWA shell（`pwa-shell.ts` + 4 路更新检测）+ dev/prod 分离（`main→/dev/`）。 |
| **P2 持久化 + resume** | ✅ | `persistence/{index,catalog,content}` 三面 + resume 循环（内联，无独立 `resume.ts`）+ session-save/jumpscare 已修好。**现已全走 createStore 唯一入口**（见下）。 |
| **★ store 大改（计划外 detour）** | ✅ | 见下节。 |
| **P3 UI（Vue）** | 🟡 **部分** | ✅ `ui/viewer.ts`（pdf.js imperative island，主表面）· `ui/gallery.ts`（文件面板 + sliceFolder）· `ui/app.ts`（shell + ☰ 汉堡菜单 + outline + jumpscare）· `app-state.ts`（reactive SSoT）。**欠**：folder-tree 深模块 paradigm、thumbnails 总览、quest（截图→剪贴板）、reading-controls（zoom/spread/theme）独立化、status-line、toasts（更新/冲突/idle）。 |
| **P4 ingest** | ❌ **未做** | 无 `ingest.ts`。本地上传 PDF / 下载（URL）/ arxiv+proxy 都没建。 |

---

## store 大改 detour —— 已完成（2026-06-22，`7ca3e50` 已 merge main + push dev）

起因：发现 JRP 的 persistence **深 import `createCloudSync`/`createFolderStore`** 绕过了 store 库（违反红线②"论文必须和 ora 走同一条路"）。
做法：把 1050 行 `store.ts` 神文件按**单一职责**拆成 **10 个带测深模块** + 薄 `createStore` 组合根 + 封死绕口。详见 `STORE.md`/`CONTEXT.md`/`OLD-ENGINE.md` 和该批 commit（`store 候选1..5`）。结果：
- 深模块：`local-head`(W2 谱系/bypass) · `safe-resolve`(永不丢字节) · `seal`(加密透明) · `push` · `freshness` · `delete` · `identity` · `trash` · `collection` · `settings`。**guts 逻辑一行没改，只搬家+补测**。红线测试 **0→41**。
- 唯一入口 `createStore({provider, ui, …})`（Model B：ui 注入 busy/askPassword/resolveConflict/reportError）。barrel 封口 + `build.sh` deep-import lint 强制 app 不碰 guts。
- JRP 全脱绕：catalog→`store.collection`、content→`store.file`（**白得离线缓存**）、settings→`store.localSettings`。lint 确认零违规。

**⚠ 未真机验**（91 mock 测 + 完整 build + lint 过，但浏览器端到端没跑）。真机待验清单见该 session 末尾交付（开 PDF 续读 / 滚动落盘 / 跨设备续上 / 离线可读 / 上传改名删 / 文件夹列表）。

---

## 下个 session 的正题（优先序）

1. **真机验 store 大改**（最高，是上条的门）。/dev/ 已部署。坏了先修引擎，再往下。
2. **P4 ingest —— 本地上传**（PLAN §5 P4）：`ui` 入口 + `content.upload`（已就绪，走 `store.file.save`，never-overwrite 红线）。"接死按钮"修复也在这批。
3. **P3 UI 补齐**：folder-tree 深模块（PLAN §2b "side-panel paradigm"，目标搬给 JRB/WebXiaoHeiWu）· thumbnails 总览 · quest 截图 · reading-controls · status/toasts。
4. **下载（URL/arxiv）= 重构跑通后的高优**（PLAN §6 parked，user 2026-06-20 钉死）：
   - 单一输入入口，app 自动判 arxiv vs 任意 PDF 链接；arxiv 多格式匹配（abs/pdf、export 子域、新式 `1102.5064v2`、老式 `hep-th/9901001`、带/不带版本）。
   - **需 CORS proxy**——**那时再建**，且守 anti-abandonware（ADR-0006）：proxy 挂了 app+数据仍完好，proxy 只是 autofill 便利。

## 遗留 / 已知（有意推后）
- **加密 / `ZipFile.setPreview` 是 `⚠TODO`**（需 7z 注入，STORE.md §1/§5.0）——JRP 不加密用不到；WebPaint 接库时再补实现。
- **settings 前缀**从旧 `jrp.set:` 换成库的 `settings:` → 设备本地项（zoom/spread）会重置一次，无数据风险。
- **worktree `jrp-ts-rewrite`** 已全 merge 进 main、冗余，可删。
- **store backprop**：本次重构在 JRP fork 完成；按 baked-copy 模型（`shared-lib-workflow`），稳定后要 merge 回 WebPaint/canonical（`MyPWAPatterns/sync-store`）——见 OLD-ENGINE.md 的 GAP 表。
- AtlasMaker / AI 陪读 / 笔记 —— spec 明确 OUT，别预留复杂度。

## 建议 skills（下个 session）
- **`verify`** / **`run`** —— 真机/浏览器跑通 store 大改（第 1 条门）。
- **`pwa-cloud-store`** —— 任何再碰 store 引擎（backprop 回 WebPaint、补加密 facet、改红线）必走，改前 escalate。
- **`fix-vibe-coding`** —— 若接死按钮/旧 UI 债要清，先考古 `journals/` 再动刀。
