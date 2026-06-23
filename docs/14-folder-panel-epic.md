# Folder Panel 全套 — 设计 SSoT

> as-of 2026-06-23 · user 签字（"一次定完一次做完"）。把 gallery/folder panel 做成可复用窄接口模块 +
> 补齐 store 缺口（cache/uncache、listBackup、加密）。信任顺序：代码现状 > journals 人类原话 > 本文。
> 调研出处：本 session 三个 research agent（cache/pin/evict、加密、trash/backup/move+多 sibling）。

## 风险分区（铁律）
- **app UI/胶水**（trash/backup 视图、move picker、cache 按钮、模块抽取）= greenfield，大胆做。
- **store/引擎红线改**（evict/pin、listBackup、加密 codec+transform）= 改前 escalate（本文=escalate）+ 稳后
  reconcile 回 canonical（注意：canonical 仍未实现，现行=兄弟互拷，见 STORE.md 复用模型）。

## 可复用模块：分层窄接口（emit 意图、宿主执行、零 store）
| 层 | 操作 | 谁要 |
|---|---|---|
| 核心 | open / enter / refresh / signin / signout (+account/signedIn/loading props) | 全员 |
| 文件管理 | rename / trash / move / upload / newfolder / deletefolder | JRP/WebPaint/JRB |
| 回收箱 | restore / purge / emptyTrash(scope) + trash/backup 视图 | JRP/WP/JRB/小黑屋 |
| 同步态 | cache(pull) / uncache(evict) / push + 行级 badge(云端/本地/dirty/ghost) | WP/JRB/RealHome |
| 加密 | encrypt / decrypt / unlock + 行级锁态 | WP/小黑屋/(JRP 这轮加) |

变体：RealHome=flat grid(无 folder/trash)；list vs grid layout 留 slot。
主题化：模块自带 CSS，色走两级 fallback `var(--gal-accent, var(--accent, #..))` + inline `currentColor` SVG。
确认流：**绝不 system confirm/prompt**（JRB/小黑屋反例）；emit 意图，宿主弹 in-app sheet；**sheet 不在 busy 内开**。

## 各功能 UX（抄 WebPaint）
- trash：同挂载点 view 切换；行内 恢复/永久删；⋯→清空本地/云端(scope)；in-app confirm。
- move：⋯→「移动到…」→ folder picker 按钮列表（候选=folders 去当前夹 + 根），非拖拽；落地=带新前缀 rename。
- cache/uncache：行级 badge + ⋯→缓存/取消缓存(evict)。
- 加密：⋯→加密/解除；密码 in-app sheet，**必须在 busy 外**（WebPaint 血泪）。

## store API 补完（红线）
1. cache/uncache：新增 `evict.ts` + `pin-set.ts`(kv)；file 面 `isCached/isPinned/pin/unpin/evict` + store `localKeys()`。
   守卫：evict 只动 clean∧在线∧云端在∧!pinned；dirty→`.backup`+保留；离线不 evict；evict≠delete(走 local.hardDelete)。
   pin 存 kv(per-device，不同步)。全是组合现有 head.isDirty/cloud.fetchMeta/local.hardDelete|backup，无新红线逻辑。
2. listBackup：`cloud.listBackup`(对称 listTrash) + `restoreFromBackup` + 放开 `.backup` 在 list 的排除；trash.ts backup 等价。
3. 加密：vendor 7z-wasm(1.6MB,惰性) + port sevenzip.ts + zip codec + `configureCryptoCodec` 注入(现在 inert!)
   + cloud-sync ext-flip(.zip) + per-file `encrypt(pw)/decrypt(pw)` transform（**对接 JRP push/local-head seam，非照抄 OLD store.ts**）
   + `ui.askPassword` in-app sheet。crypto-container/seal 已健康移植，只差 codec 注入 + transform + UI。

## 构建顺序（每阶段过门+推 dev）
P1 trash 视图 + move picker（引擎就绪 UI）→ P2 cache/uncache（store+UI）→ P3 listBackup + backup 视图
→ P4 全套加密（store+UI，红线密集）→ P5 模块抽取 + 主题化（gallery+folder 收成一个组件）。

## 遗留 / 注意
- **busy 遮罩**（"象1"）单独：JRP 的 `ui.busy` 现在是 no-op → folder ops 无加载反馈；本 epic 不含，单独修。
- 加密是 escalate-human 级、reconcile-canonical：本 epic 在 JRP 落地+测，稳后拷给 WebPaint/canonical。
- RealHome flat 变体、小黑屋 encryption-aware row、backup 视图：接口预留，UI 各 sibling 接入时补。
