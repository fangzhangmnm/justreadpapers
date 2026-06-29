# Store 收口 + 回传 WebPaint —— 对账表 & 计划

> as-of 2026-06-28 · 作者 = AI coding agent，人类监督依据
> 本 doc 是缓存、无失效机制：与代码冲突时**信代码**，反直觉条目去人类语料/ADR 验出处。
> 信任顺序：代码现状 > journal 人类原话 > ADR > 本 doc。

## 0. 背景与方向（先读）

- **库无中央仓**：各 app 互相拷代码（`MyPWAPatterns` 不是 SSoT，只有 README）。
- **WebPaint = 红线 ground-truth**（store 行为对错以它为准）；**JRP = 结构最领先的 baked copy**（已把 WebPaint 的单体 `store.ts` 拆成 ~12 个深模块）。
- **回传 = 双向 merge，不是单向拷贝**。两边各有对方没有/更好的东西（见 §2 方向列）。
- 触及红线模块前必读 `src/store/DATA SAFETY GUIDELINE.md` 并 escalate human（硬规则）。

### 一句话现状
JRP 在**结构**上领先（深模块分解 + store-driven Model-B + offload/reconcile/collection-cache 下沉到库层），但有**自己的退化**（加密未接线、skip-to-offline 逃生闸丢失）。WebPaint 在**行为完整度**上领先（加密全实现、skip-to-offline 正确），但 store 是单体、eviction-guard/reconcile/conflict-UI 都散在 app 层（债）。

---

## 1. 架构对账（顶层）

| 维度 | WebPaint（ground-truth，单体） | JRP（深模块分解，新） | 方向 |
|---|---|---|---|
| 结构 | `store.ts` 1054 行 god-closure + `folder-store.ts`(旧名) | 拆成 ~12 深模块 + `create-store.ts` 薄组合根 | 结构 JRP→WP（大重构） |
| flow 编排 | **app 驱动**：`cloud-freshness.ts` 自管 busy/sync-gate/conflict dialog，store 只暴露 flow + 只读 state | **store 驱动 (Model B)**：busy/resolveConflict/askPassword 全在 store 内回调，app 只注入 `ui` bundle | TBD（最大风险，见 §3.4） |
| 公共面 | `flow.{push,open,...}` + seal/peek/edit/autosave/cloud/settings 一堆原语 | `file(name,{isZip})`→RawFile/ZipFile 高层门面 + collection + reconcile | 随结构 |

---

## 2. 逐模块对账表

> 方向：`JRP→WP` = 把 JRP 的分解/新能力带进 WebPaint；`WP→JRP` = JRP 退化，从 WebPaint 取回；`双向` = 都要；`parity` = 行为一致，只是 JRP 抽成独立模块。
> 标 ⚠ = 回传前必处理的退化/缺口。

| JRP 模块 | WebPaint 对应位置 | delta | 方向 |
|---|---|---|---|
| `create-store.ts`（组合根 + Model-B 门面） | `store.ts` 顶部 + 返回面（god-closure） | JRP 拆分 + Model-B；WP 单体 + app-driven | 结构 JRP→WP；Model-B = TBD |
| `local-head.ts`（HEAD `_base`/parent/dirty 三合一） | `store.ts` inline（`_base` Map / `seenBase` / `parentFor`） | 抽成独立模块 vs inline | JRP→WP（抽取） |
| `push.ts`（serial+If-Match+retry+conflict） | `store.ts` push (≈230) | 红线一致（parentBase If-Match、412→heal→surface、默认 cancel 无 LWW） | parity（抽取） |
| `freshness.ts`（open/refresh gate） | `store.ts` open(321)/refresh(382) | ⚠ **JRP 没接 probe**（裸 await fetchMeta，遮罩能挂死）；WP `cloud-freshness.ts` 传 user-gesture probe | 抽取 JRP→WP；**probe 退化 WP→JRP** |
| `delete.ts`（三态 move-aside + 离线删队列） | `store.ts` del(411) | parity（move-aside `.trash`、dirty 先降 local-only 不硬删、null base 不入队） | parity（抽取） |
| `identity.ts`（rename/saveAs/acquire） | `store.ts` rename(591)/saveAs(639)/acquire(662) | parity（phantom-path 先存新再删旧、server move 保 etag） | parity（抽取） |
| `trash.ts`（restore/purge/emptyTrash） | `store.ts` restore(506)/purge(531)/emptyTrash(552) | parity（restore 采纳新 etag、purge 强确认、批量失败聚合不吞） | parity（抽取） |
| `offload.ts`（keepOffline/offload + eviction-guard） | **WebPaint 无**（offload/pin/evict API 不存在；clean-guard 在 app 层 `app-store.ts` reconcileCloudGone） | ⚠ **债 N4**：JRP 把 eviction-guard（dirty 永不驱逐、只 clean∧可重取）下沉到库层；WP 散在 app | JRP→WP（新增模块 + 下沉） |
| `reconcile.ts`（cloud-gone 收敛 + 纯 classifier） | WebPaint **app 层**：`app-store.ts` reconcileCloudGone + `gallery-model.ts` classifyCloudGone | JRP 把 cloud-gone 收敛搬进库层（clean 孤儿→local-only 不删，partial/empty list 不动） | JRP→WP（app→store 下沉） |
| `collection.ts`（+ IDB hydrate 本地缓存） | `folder-store.ts`（**memory+cloud only，无 IDB hydrate**） | ⚠ JRP 有透明本地缓存（离线读/强杀续存/init etag-skip 快路径）；WP 持久化甩给 app | JRP→WP（加 IDB hydrate + 改名 folder-store→collection） |
| `safe-resolve.ts`（safePull/tryHeal/weakOverride/resolveConflict） | `store.ts` _safePull(242)/_tryHeal(158)/_resolveConflict | parity（backup-before-overwrite、validateAdopt 防 captive-portal、etag 在 save 成功后才推进 R1） | parity（抽取） |
| `seal.ts` + `crypto-container.ts`（at-rest 加密） | `store.ts` _seal/_unseal/encryptFile/decryptFile + `crypto-container.ts`（**全实现**） | ⚠ **JRP 加密 inert/未接线**：crypto-container 的 peek 真 crypto 在，但 7z codec seam 没注入（`configureCryptoCodec` 没被调）、`getPassword=()=>null`、ZipFile preview `throw notYet`、`encryptionSaltFileName` ⚠TODO | **WP→JRP（接线加密）** |
| `settings.ts`（localSettings + syncedSettings） | `store.ts` settings（通用 KV，无 syncedSettings collection） | JRP 多 syncedSettings（跨设备、collection per-key LWW） | JRP→WP（小，加 syncedSettings） |
| `substrate.ts`（edits/session/serialize/serialize2） | `store.ts` substrate（edits/session 住这） | parity | parity（共用） |
| `cloud-sync.ts`（session 级 cloud 语义） | `cloud-sync.ts`（同名） | 疑似近 parity（都有 fetchMeta/If-Match/move-aside/H7 size+tail 防冒认）；**需逐行 diff 确认** | verify parity |
| `local-cache.ts` / `idb-store.ts` | `local-adapter.ts` | 需对比 API（backup/trash/hardDelete/appKeys 命名空间） | verify parity |
| `folder-flow.ts` / `folder-merge.ts` / `move-aside.ts` | 同名文件 | 疑似 parity（folder-flow 有 15s withTimeout、merge 是 config-class 故意 LWW、move-aside guid 防撞） | verify parity |
| `providers/auth.ts`（MSAL） | `providers/auth.ts` | ⚠ **WP 还是旧 bug**（auth.ts:193-196 getToken 后台 `acquireTokenRedirect`）；JRP 0caf386 已修（silent 失败 throw 降级离线，绝不后台跳转） | **JRP→WP（getToken 修复）** |
| `providers/graph.ts` / `onedrive-provider.ts` | 同名 | 需对比（0B blob-coercion seam、chunked upload、conflictBehavior） | verify parity |

---

## 3. JRP 退化项 / 必补（回传前先在 JRP 补齐，再双向 merge）

### 3.1 ⚠ skip-to-offline 逃生闸（WP→JRP，纯 JRP 内修，不碰 WebPaint）
- **病**：`create-store.ts:152` `await fresh.open(name)` 不传 probe；遮罩 `busy("检查云端…")` 在 fetchMeta 挂死（iOS 登录态老 token acquireTokenSilent iframe 永不 resolve）时永久转。
- **WebPaint 正解**（ground-truth）：`cloud-freshness.ts:96-110` 造一个 user-gesture probe，「检查云端…」对话框带「跳过到离线」按钮，点击 resolve probe → `Promise.race` 让 open 走 `{source:"local",reason:"skipped"}`。**无硬超时，用户即超时**。
- **同源 0caf386 模式**：后台流绝不卡死/劫持导航，降级离线，只 user-gesture 触发交互。
- **修法**：JRP busy 遮罩加「跳过到离线」动作 → 把它做成 probe 传进 `fresh.open(name, { probe, isOnline, localDirty, onNewer, adopt })`。注意 Model-B 下 busy 是 store 驱动，probe 的造法要适配（store 在 `ui.busy` 回调里暴露一个 skip signal，或 open 内置一个可由 ui 触发的逃生）。**设计点需想清楚再动**（Model-B vs WebPaint app-driven 的 probe 来源不同）。

### 3.2 ⚠ 加密接线（WP→JRP）
- **病**：JRP 加密架构在（seal.ts + crypto-container.ts，peek 真 crypto），但**未接线**：codec seam 没注入、getPassword 恒 null、ZipFile preview throw、saltFile ⚠TODO。
- **WebPaint 正解**：3 层 ADR-0012（外层明文 zip + 内层 AES-256 .7z `-mhe` + 尾部 AES-GCM peek），PBKDF2-250k，7z-wasm vendored，format-blind + 非交互 getPassword。
- **修法**：把 WebPaint 的 `configureCryptoCodec` 注入 + encrypt/decrypt/verifyPassword/peek 接线移植进 JRP 的模块结构；接 ZipFile setPreview/getPreview 管线；实现 `store.encryption`（库统一密钥 + saltFile）。**这是 store 红线区 + 体量大，改前 escalate。**

### 3.3 providers/auth.ts getToken 修复（JRP→WP）
- JRP 0caf386 已修（getToken silent 失败 throw 降级离线、绝不后台 acquireTokenRedirect）；WebPaint auth.ts:193-196 还是旧 bug。回传时把这条带过去。

### 3.4 Model-B（store-driven）是否回传 = 待你拍板（最大风险）
- JRP = store 在决策点回调 ui.busy/resolveConflict/askPassword；WebPaint = app 驱动（cloud-freshness.ts 自管，store 是非交互 mechanism lib）。
- 把 WebPaint 整体搬到 Model-B = 重写它的 app↔store 接缝，风险最高。选项：①整体迁 Model-B；②WebPaint 保 app-driven，只回传深模块分解（offload/reconcile/collection-cache）+ 行为修复，不动编排范式。**默认建议 ②**（先收割低风险高价值的深模块下沉，编排范式留后），但这是你的决定。

---

## 4. 红线静态论证 checklist（§3 补完后，subagent 跑）

> 用户要求：「store 设计应在**离线模式完美工作**，重连后**不导致恶意覆盖丢数据**」。逐条静态论证（不靠真机）。
> 论证对象 = 补完退化后的 JRP store（也是回传基线）。

**场景 A：离线模式完美工作**
- [ ] 离线 open：fetchMeta 失败/挂死 → 走 local 读（skip-to-offline / isOnline guard），不卡、不报错吞掉。
- [ ] 离线 save：本地落盘 + 标 dirty + push 失败降级（reportError，不丢）。
- [ ] 离线 delete：local trash + 持久化删队列（base-etag != null 才入队）。
- [ ] 离线 list/空 list：`complete:false` 绝不据此删本地缓存（reconcile no-op）。
- [ ] 强杀/reload：collection IDB hydrate 续存；dirty 永不被驱逐。

**场景 B：重连后不恶意覆盖 / 不丢数据**
- [ ] 每次 push 带 If-Match = parentBase（不是 last-seen / 共享 etag / 时间）→ 陈旧设备推必 412。
- [ ] 412 → tryHeal（byte-equal 自愈）→ 否则 surface conflict（resolveConflict），**绝不静默 LWW**。
- [ ] 冲突 keepMine = weakOverride（云端 loser 进 `.backup`，不丢）；cancel = 不动，留 dirty。
- [ ] clean → safePull 快进（跳 backup）；dirty → 必 surface（onNewer/resolveConflict）。
- [ ] 删除/覆盖 = move-aside（`.trash`/`.backup`，同层不跨网）；脏字节绝不硬删。
- [ ] 驱逐（offload）只 clean∧在线∧曾 synced∧云端完整(size>0)；dirty/local-only/cloud-gone → OffloadIllegalError。
- [ ] adopt 前 validateAdopt（防 captive-portal HTML 覆盖唯一好副本）；etag 在 local.save 成功后才推进（R1）。
- [ ] 身份 = path/name（无 GUID）；new-file 无 base → conflictBehavior:"fail" + size/tail 校验，撞名两份都留不冒认。
- [ ] uat = user-action-time（非 save/sync/cache 时间）；boot/reconcile 期杂散滚动不盖新 uat。

每条：指到 enforce 它的模块 + 行号，论证「能否产生左栏坏结果」。

### 4.1 审计结果（as-of 2026-06-28，3 个对抗 subagent 跑 skip-fixed 基线）

- **场景 A（离线完美）**：红线轴 5 条全 **SAFE**。freshness 离线短路（`freshness.ts:44`）落在 fetchMeta/token 之前；离线删 null-base 守卫双重 enforce（`delete.ts:58,95`）。
- **场景 B-1（push/冲突）**：6 条全 **SAFE**。每个分叉要么 412→surface、要么 byte-equal 自愈、要么 no-base collision 守卫，两侧都留。理论 silent-overwrite（markSeen 重捕 _parent 到 moved tip）**结构不可达**（markSeen 没接进 open/refresh）。
- **场景 B-2（move-aside/驱逐/身份）**：C1/C3/C4/C5 SAFE；**C2 = HOLE，已修**（见下）。
  - ⚠ **C3 前提**：`validateAdopt` 是可选 config，JRP **必须**注入（`create-store.ts` 经 `config.validateAdopt`）；不给 → clean 本地可被云端垃圾覆盖无备份。回传时确认 app 有接。

**已修红线**：
- ✅ **C2 offload TOCTOU（a97da5b）**：check-then-act 跨 fetchMeta + offload 不在 serialize → 并发 save 写的 dirty 字节被 hardDelete + 清 dirty 标志 = 最毒红线（驱逐吃未推字节）。修=offload 进同名 serialize 链（⟂ save 的 local 写）+ fetchMeta 后 re-check isDirty（抄 `freshness.ts:87`）+ save 的 local.save 也进 serialize。1 回归测。

**backlog（审计副产，非数据安全红线）—— 已清（4a2a984）**：
- ✅ **del 的 isOnline 未接**：delSF 接 `isOnline`（离线走删队列）+ persistence online 监听 & listGallery 各 drain 一次（之前 drainDeleteQueue app 根本没调 → 双修）。
- ✅ **markSeen 没接进 open**：freshness.open 的 in-sync 路径（meta.etag===base 安全态）调 markSeen 重捕 _base/_parent，闭合 reload-后误报 collision 窗口；只在云端没动时调（防 B1 silent-overwrite）。回传时 WebPaint 用 app-driven `adoptBase` 等价物，对齐即可。

---

## 5. 执行顺序（用户定）& 进度

1. ✅ **对账表**（本 doc）。
2. **补退化**：
   - ✅ 3.1 skip-to-offline（28aabba，纯 JRP 内修，2 测，未真机验）。
   - ⏳ 3.2 加密接线（红线 + 体量大；**JRP 本身不加密**，这是为回传 WebPaint 的库完整性——WebPaint 已有可用加密，回传时是把 WebPaint 的加密移植进 JRP 模块结构，不是 JRP 凭空造。**待 escalate 定 scope：现在做 vs 留回传阶段**）。
   - ✅ 3.3 auth getToken 修复（已在 JRP/0caf386，回传时带去 WebPaint）。
3. ✅ **subagent 静态论证红线**（§4.1，A/B 全 SAFE + 修了 C2 + 2 backlog）。
4. **逐模块回传 WebPaint**：先 verify parity 的（cloud-sync/local-cache/folder-*/providers diff）；再 JRP→WP 下沉（offload/reconcile/collection-cache + getToken 修复 + C2 修）；Model-B（3.4）按你 §3.4 决定。WebPaint 红线为准，逐模块走 `pwa-cloud-store` skill。

---

## 6. 对账状态 & STALE 清单（as-of 2026-06-28，2 个 subagent 对账后）

**代码对账 ✓**（JRP 全部模块对过 WebPaint，结论=JRP 在 parity 或领先，**无 JRP 落后项**）：
- cloud-sync 近乎逐字相同（仅 WP 缺 listBackup，additive）；folder-flow/merge/move-aside、graph.ts 逐字相同。
- local-cache/idb（JRP 纯）vs WP local-adapter（反向 import app 代码污染）：同数据安全，JRP 更纯。
- providers/auth.ts：**WP 还带 getToken redirect bug**（0caf386 已在 JRP 修）。

**测试对账**：JRP 加密红线测试缺口已补（swap 两端/离线拒/错密码零副作用/byte-exact/锁定 getPreview/容器探测 false-cases/peek 错密码）。**仍开口（本 session 前既有代码，WebPaint 测了 JRP 没测）**：

### STALE — 待补测试（按严重度）
- **HIGH push 409/claim + H7 0字节 + no-base collision**（引擎唯一静默丢数据路径；cloud-sync.ts:137-195 守卫在、push.test 没驱动 409/claim 路径）。
- **MED freshness R1 adopt-deferred 失败**（heal/save 失败时 etag 不前进、dirty 留 → 防重启后陈旧覆盖窗口）。
- **MED identity**：dirty-rename → 旧名进 .trash；N7 旧名 trash 失败 → oldCloudOrphan 不吞；S1 move 采纳新 etag 不弹假冲突。
- **MED trash**：cloud-restore 采纳 etag（不弹假 collision）；emptyTrash scope=cloud / 离线只清本地。
- **MED move-aside**：同时钟两次 weakOverride 同名（guid 防撞）；.backup 不漏进 gallery 列表。
- **MED provider contract**：`onedrive-provider.ts` 无 contract 测（0字节 Uint8Array 上传守卫=2026-06-05 prod bug、412/409/range）。

### STALE — 待做（非测试）
- **回传 WebPaint（phase 4，大件，未开始）**：把 JRP 领先项带进 WP 单体 store.ts——getToken 修复（红线，WP 还带 bug）· listBackup（additive）· codec 注入式 crypto-container · offload/reconcile/collection-cache 下沉 · 加密 wiring · content-agnostic local-cache 拆分（WP 反向 import app=污染，较大重构）· Model-B 决定（§3.4 待你拍）。逐模块走 pwa-cloud-store skill，WP 红线为准。
- **真机验 /dev/**：本 session 全部改动（skip-to-offline 跳过按钮 / 加密全流程 / 开图库开 PDF 删除）未真机验。
- **README §7 askPassword**：StoreUI 仍声明 askPassword 但加密改走 getPassword → askPassword 已 unwired（dead）；待清理或重新定位。
- **config.encryptionSaltFileName**：字段还在（标「未采用」）；待移除。

> 已落地 main→/dev/（worktree `jrp-store-finalize` 已全 merge）：
> `4b8c1a0` README §8 · `3b667ac` 对账 doc · `28aabba` skip-to-offline · `a97da5b` C2 TOCTOU ·
> `4a2a984` 2 backlog · `c651a0a` 加密 wiring + docs/11 · `0d967f0` 加密红线测试。
</content>
</invoke>
