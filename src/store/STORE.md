# sync-store —— 使用手册（tutorial + API overview）

> 一个内容无关、安全的云同步存储库。你的 app 只跟**一个入口**打交道，碰不到底层。
> 行为以本文为准（本文 = 这份引擎的 SSoT）。标 ⚠TODO 的是已定、待实现。
>
> **复用规则**：本引擎在各 app 间**互相拷代码**（没有 canonical 中央仓，别去找/改 MyPWAPatterns）。本 STORE.md 随引擎一起拷，是唯一权威。

---

## 0. 铁律（用了本库就必须守）

1. **禁止**直接碰 `localStorage`、`IndexedDB`、任何 cloud vendor（Microsoft Graph / MSAL / 裸 `fetch` 云端）。全部走本库。
2. 本库**零内容格式知识**——你的文件是 `.ora`/`.glb`/`.pdf`/`.txt` 都一样，对库只是**不透明 binary blob**。库永不解码你的内容。（唯一例外：库懂 **zip 这种通用容器**，见 §2 `isZip`——那是容器机制，不是内容知识。）
3. **缺接口、库没实现你要的行为 → escalate to human 改库 API。绝不在 app 端绕过库自己实现。**
4. **不要 deep import 库内部文件**。只从 `index.ts` 拿 `createStore` + 一个 provider。内部文件顶部有 WARNING，构建 lint 会挡 deep import。
5. **API 难用是故意的**（§7）。觉得别扭、想绕——**停下 escalate**，别绕。
6. 对本库的修改，重构，API修改前，需要阅读`DATA SAFETY GUIDELINE.md`

> 为什么这么严：这个库存在的**唯一意义**是把红线数据安全（不丢、不静默覆盖、离线可读、冲突 surface、加密）**一次在库里保证好，每个兄弟项目开箱即得**。你绕过去，库就失败了。

---

## 1. 唯一入口

```ts
import { createStore, createOneDriveProvider } from "./store/index.ts";

const { provider } = createOneDriveProvider({ clientId, msalUrl: "./vendor/msal/msal-browser.min.js" });
const { sevenZip } = createSevenZip({ wasmUrl: "./vendor/7z-wasm/7zz.wasm" });   // 仅加密用，见下

const store = createStore({
  provider,                                  // 必填：云端低层（OneDrive / mock provider）
  ui,                                        // 必填：UI 回调 bundle，store 在决策点回调进来（见 §7）
  sevenZip,                                  // 选填：注入 7z 引擎（wasm ~1.6MB，应懒加载）。不注入 → 不支持加密
  syncedSettingsFileName: "settings.json",   // 选填：要跨设备同步设置时给（§4）
  encryptionSaltFileName: "vault.salt",      // 选填：用「库统一密钥」加密时给（§5）
  keepOnOpen: true,                          // 选填(默认 true)：消费模式。true=开即自动留本地(读者/编辑器)；false=过路/流式(开不留本地，§2)⚠TODO 未实现
});
```
> **关于 `sevenZip`**：加密**逻辑**全在库内，唯一例外是重型 7z 引擎（wasm ~1.6MB）由 app vendor + 注入——体积大，不塞进每个 app 的 bundle。不注入 → `store.encryption` 在类型上不存在、加密 API 抛错（JRP 不加密就不 vendor，省 1.6MB）。轻量 zip.js（容器机制）随库 ship、KDF/GCM 走内置 WebCrypto，都不用注入。

`createStore(config)` 返回**你 app 需要的一切**——你永远不自己构造 cloud / 本地缓存 / 集合。

| 拿到的 | 是什么 | 章节 |
|---|---|---|
| `store.file(name, opts)` | 文件 store（一个名字一个文件） | §2 |
| `store.collection(name, opts)` | 集合 store（一个 JSON 装多个原子 item） | §3 |
| `store.localSettings` | 设备本地设置 KV（不同步） | §4 |
| `store.syncedSettings` | 跨设备同步设置 KV（config 给了 `syncedSettingsFileName` 才有此属性） | §4 |
| `store.encryption` | 库统一密钥的解锁/上锁（config 给了 `encryptionSaltFileName` 才有此属性） | §5 |
| `store.list()` / `store.listAll()` | 列文件 + 文件夹 | §2 |

---

## 2. 文件 store —— 一个名字一个文件

```ts
const f = store.file("papers/Wei 2011.pdf", { isZip: false });
await f.save(bytes);          // 新建 or 覆盖：本地落盘 + 按节律推云（If-Match 守冲突）
const blob = await f.open();  // 本地有则秒开；无则拉云 + 缓存本地（下次离线可读）
await f.rename("papers/new.pdf");
await f.delete();             // 销毁：本地副本→本地 .trash / 云端副本→云端 .trash（各自 move-aside，可恢复）
```
- **新建文件 = 对一个新 name `save`**（没有单独的 create）。云端已有同名但内容不同 → 提示用户，绝不覆盖。
- **delete vs offload**：offload 只丢「可重取的 shadow」、云端不动；delete 是**销毁**。delete 内部按原子态分流——本地若是 offloadable shadow → 硬删本地（云端 .trash 已救着，不留双份）；本地若是唯一副本（dirty/local-only）→ 先变 local-only 再进**本地** .trash（未推字节可恢复，绝不硬删）。云端副本进**云端** .trash。两套 trash 各管各、不跨网（ADR-0015）。
- **`open` 自动把字节缓存本地**（离线可读，你不碰 IndexedDB）。
- `store.list()` / `store.listAll()` → `{ files, folders, complete }`。`complete:false` = 列举有子树失败，**别据此删缓存**。

### 离线副本 —— keepOffline / offload（无 LRU、无 pin）

```ts
await f.keepOffline();    // 留一份离线副本（未缓存则下载）。注：open 已含下载子过程，故名 keepOffline 非 download
await f.offload();        // 移除本地副本（只删本地，云端不动）。**非法时抛错**，见下
await f.isKeptOffline();  // 本地有副本？（= 已留作离线）
store.localKeys();        // 已留作离线（=有本地副本）的文件名列表（批量标记 UI 用）
```
- **心智模型**：有本地副本 = "kept offline"。无 LRU、无 pin、无 unpin、无 force——只有「留一份」(`keepOffline`) 和「移除」(`offload`)；中间「可被自动驱逐的 cache」态**不存在**（开了 / 下载了就留着，直到显式 `offload`）。
- **offload 只对 shadow 合法**：本地副本是「云端某完整版的可重取镜像」时，offload = hardDelete（**不进本地 trash**，可重下）。合法 = `clean ∧ 在线 ∧ 已登录 ∧ 曾 synced ∧ 云端仍有完整副本(size>0)`。cloudMoved（云端被别人推了新版）**仍合法**（clean 本地下次 open 会快进）。
- **非法 offload = 内部错误（banner），不是软保留**：本地是**世界唯一副本**（local-only / 未上传 / dirty / forked / cloud-gone / 离线）时，它不是谁的 shadow，offload **不适用** → 抛 `OffloadIllegalError`，经 ui.reportError 出 banner。UX 不该暴露非法 offload；要清掉唯一副本走的是 **delete** 语义，不是 offload。
- `keepOnOpen:true`（默认，见 §1）下 `open` 即自动留本地；`keepOnOpen:false`（⚠TODO 未实现）流式消费则 `open` 过路不留，只有显式 `keepOffline` 才落地。

### 回收站 / 备份

```ts
store.listTrash();    store.listBackup();                      // 列回收站 / 备份
store.restore({ fromCloud: true, cloudItemId, targetName });   // 恢复到 targetName
store.purge({ cloudItemId, confirm });                         // 彻底删除（confirm 回调确认）
store.emptyTrash({ scope: "both" });                          // 清空回收站（"local" | "cloud" | "both"）
```
- `delete()` 把文件移入回收站（可恢复）；版本冲突时被替下的旧副本进备份（不丢）。两者都能列出、恢复、彻底删除。

### `opts.isZip` —— 决定能否带预览图、加密几层

> ⚠ **as-of 2026-06-23：`setPreview`/`getPreview` 未实现（TODO）**——create-store.ts 里目前 `throw`（zip 预览管线待接入）。下面是**目标形状**、不是现状。JRP 全是 `isZip:false` 的 PDF，暂不受影响。

你的文件是不是 zip 容器格式（`.ora`/`.atlas.zip` 是；`.pdf`/`.txt` 不是），创建时声明。库据此**在编译期**给两种不同的对象：

```ts
const raw = store.file("a.pdf", { isZip: false });   // 类型 RawFile
raw.setPreview(blob);   // ❌ 编译错：RawFile 没有 setPreview

const zip = store.file("a.ora", { isZip: true });    // 类型 ZipFile
await zip.setPreview(previewBlob);   // ✓ previewBlob 作为容器里一段，库当 zip entry 管
const p = await zip.getPreview();    // 一次云端尾部 byte-range 取预览，不全量下载
```
- `isZip:false` → **`RawFile`**：原始字节直存（云端文件 = 原始内容，双击能开，守 anti-abandonware）。**无预览图**。加密 = 2 层。
- `isZip:true` → **`ZipFile`**：库把 `previewBlob` 当 zip entry 管（**你不写任何 zip 代码**）。加密 = 3 层（含加密预览）。
- `previewBlob` 是**格式无关的不透明 binary blob**（jpg/png/随便，库不看、不构造、不解码）。

---

## 3. 集合 store —— 一个 JSON 装多个**原子** item

> 旧名 `folder-store` 是误导（它不是文件夹，是"一份同步 JSON，里头一堆带 id 的 item"）。⚠TODO 改名 `collection`。

```ts
const reading = store.collection("reading-state.json");      // 不传序列化器：item 是普通 JSON 对象
reading.upsertItem({ id: docId, pageIndex, yFraction });     // 新增 / 整条原子替换（id 类型上强制必填）
reading.deleteItem(docId);
reading.getItem(docId);                                      // 一条 | undefined
reading.items();                                             // 全部 item（数组，每条含自己的 id）
reading.keys();                                              // 全部 id（数组）
```
- 用于：阅读位置表、笔架、任何"一堆小条目、跨设备合并、零冲突"的东西。
- **不传 `encode/decode`**：item 是普通 JSON 对象，库自己序列化（content-agnostic 是给 §2 file 的不透明 blob；collection 本就是结构化可合并 JSON，库懂它的信封）。
- **信封由类型强制，不靠约定**：库内部把每条包成 `{ id, uat, payload }`——`id` 类型上必填（`upsertItem(item: { id: string } & T)`）；`uat`（合并时间戳）**库内部盖戳，app 既传不进也看不到**（顺带守"内容里不放 timestamp"红线）；payload = 你给的其余字段。
- **item 是原子的：只有 `upsertItem`（整条替换），没有 partial update。** 想改一个字段 = 取整条 → 改 → 整条 upsert。换来合并简单 + 无中间态。
- 内部按 item 合并，**逐 item last-write-wins**（每 item 各带时间戳，并发改不同 item 都不丢，不静默覆盖）。
- **自动本地缓存**：离线、重新打开、意外关闭后都能读到上次的数据（你不碰 IndexedDB）。页面卸载时（关闭 / 切到后台）调一次 `reading.flushLocal()` 把最新状态落到本地。

---

## 4. 设置 —— 你**不碰** localStorage

两种，别混：

```ts
// A. 设备本地（theme/zoom/spread…，每台设备独立，不同步）
store.localSettings.set("theme", "night");
store.localSettings.get("theme");      // 没设 → undefined（不提供 default 参数）
store.localSettings.delete("theme");

// B. 跨设备同步（config 给了 syncedSettingsFileName 才有此属性）
store.syncedSettings.set("defaultZoom", 1.2);
store.syncedSettings.get("defaultZoom");
store.syncedSettings.delete("defaultZoom");
```
- **`get` 不给 default**：把"默认设置"放你 app **一处 SSoT**（一个 defaults 对象），别每次取值各写各的 default → 不一致。
- `syncedSettings` 内部就是一个 collection，**每个 setting key 当一个 item**——所以"并发设不同 key 都不丢"是 §3 per-item LWW 白送的，没有第二套合并逻辑。

---

## 5. 加密 —— 全 store 管，对 app 透明

> ⚠ **as-of 2026-06-23：整章未实现（TODO）**——`createSevenZip` / config `sevenZip` / `store.encryption` / `encrypted:true` / `saveEncrypted` / `addEncryption` 等本版**都不存在**（create-store.ts 标 `encryptionSaltFileName ⚠TODO 本版未实现`）。本节是**目标 spec、不是现状**，别照此调用。JRP 不加密。

加密的**逻辑**（容器 / 层数 / 预览图加密 / KDF / salt / 验证器 / peek）全在库内。app 只负责两件库做不了的事：**注入 7z 引擎**（见 §1 `sevenZip`）+ **把密码输进来**（库非交互、永不弹框，§7）。

### 5.1 库统一密钥（最常见：整库一个密码）

config 给 `encryptionSaltFileName` → 多一个 `store.encryption`：

```ts
const store = createStore({ provider, encryptionSaltFileName: "vault.salt" });

// 首次建库密钥（salt 文件还不存在时，一次）：
await store.encryption.init(password);   // 写 salt + 验证器到 vault.salt

// 解锁（可选，做"启动时先解锁"UX）。也可以不调——首次用到加密文件时 store 会自己 ui.askPassword：
const ok = await store.encryption.unlock(password);  // 验 salt → true/false；对则内存持 key
store.encryption.isUnlocked();           // 库是否已解锁
store.encryption.lock();                 // 清内存 key
```
- `vault.salt` 是个小云文件，存 **salt + 验证器**：让所有设备从「密码+salt」派生**同一把钥匙**，且没有任何加密内容文件时也能**验证密码**（错密码当场拒）。
- salt 不保密（防彩虹表用）；防暴力靠**强 KDF**（实现照搬 WebPaint）。

### 5.2 标记文件加密

```ts
// (a) 库统一密钥：save/open 透明加解密；未解锁时 store 自己调 ui.askPassword 取密码（§7），不用你 catch
const f = store.file("secret.ora", { isZip: true, encrypted: true });
await f.save(bytes);   // 已解锁 → 自动加密；未解锁 → store 驱动取密码 → 加密
await f.open();        // 已解锁 → 自动解密；未解锁 → store 驱动取密码 → 解密

// (b) 每文件独立密码：用到的那一刻显式传 pw（无 callback、无闭包留密码）
const g = store.file("x.ora", { isZip: true });
await g.saveEncrypted(bytes, pw);
await g.openEncrypted(pw);
```
- 加密对 `save`/`open` **透明**：你照常存原始 `bytes`，库负责打/拆容器。
- `ZipFile + 加密`：`previewBlob` 一起加密进容器尾部，`getPreview` 解锁后仍可读（云端尾部 byte-range，不全量下载）。

### 5.3 给既有文件加/去加密

```ts
await f.addEncryption();      // 明文文件 → 加密（库 key；per-file 版 f.addEncryption(pw)）
await f.removeEncryption();   // ⚠ 危险：加密 → 明文，云端从此可被任何人直接打开
```
（不叫 encrypt/decrypt——`removeEncryption` 是危险操作，名字自带警告。）

---

## 6. 大概做了什么（红线在库内 enforce，UI 永不自己保证）

push-serialize（每文件串行推）· If-Match（每次写带 etag，412 → surface 冲突不静默）· 采纳每次 provider mutation 返回的新 etag（rename/move/restore/upload）· 删除=移到 `.trash`（脏字节绝不硬删）· 离线删除队列持久化并重放 · pull 前校验字节（防 captive-portal HTML 覆盖唯一好副本）· 驱逐只动 `clean ∧ 可重取`（脏的先 `.backup`）· ready-gate（含带编辑器 resume）· 加密容器。

---

## 7. store 怎么对 UI 有强制性（Model B）

store **不画像素**（无 DOM、无 `alert/confirm`），但它**驱动整个 flow**，在每个决策点**回调进你注入的 `ui` 并 await**——你不处理，flow 就过不去。这就是强制力：不是 store 替你画对话框，是**没解决就完不成这次写**。

### 必填注入 `ui`（store 在这些时机回调进来）
```ts
const ui = {
  // 危险写操作的锁屏遮罩：store 把每个写裹进来。你画一个吞输入的全屏遮罩即可。
  busy: <T>(label: string, fn: () => Promise<T>) => Promise<T>,
  // 需要密码时 store 调它；返回 pw 或 null(取消)。store 内部验，错了再调，直到对/取消。
  askPassword: (ctx: { name: string; reason: "open" | "save" | "unlock" }) => Promise<string | null>,
  // push 撞冲突时 store 调它；返回有限选项之一，后果由 store 执行(见下表)。
  resolveConflict: (ctx: { name: string; local: Blob; cloud: Blob }) => Promise<ConflictChoice>,
  // 非阻断错误(网络/文件不存在/字节非法)：store 调它弹 error banner。
  reportError: (err: StoreError) => void,
};
```

### 冲突的有限选项 + 后果（store 执行，app 只渲染那几个按钮）
| `ConflictChoice` | store 做什么 |
|---|---|
| `"keepMine"` | 备份云端副本到 `.backup` → 用本地快照 weak-override 云端 → 采纳新 etag |
| `"takeCloud"` | 备份本地 → 拉云端覆盖本地缓存 → 采纳云端 etag |
| `"cancel"` | 什么都不动；本地保持脏，下个周期再试 |

### store 编排的两条硬律（Model B 的代价 = 它的卖点）
1. **先退 busy 遮罩、再弹 modal**：store 调 `askPassword`/`resolveConflict` 前先退出 busy 遮罩，否则遮罩盖住对话框 = 死锁（WebPaint 踩过）。这套交错归 store 管、一次做对。
2. **await 期间 push-lock 安全**：flow 卡在回调 await 上时，同文件后续 push 排队、不死锁、不丢。

### 原子性不变量（#76）
flow 的原子单位是「进入 flow 那刻抓的**不可变快照**」，不是 wall-clock。store **永不回写 app 的活动状态**；回调 await 期间 app 的 mutation 归**下一个 dirty 周期**的新快照，绝不塞进正在飞的 flow。（外部如云端 API 的并发不在此保证内。）

### 另外的"形状强制"
- `setPreview` 只在 `ZipFile` 上 → 逼你想清文件是不是 zip。
- `get` 不给 default → 逼你把默认值收一处。
- `removeEncryption` 命名自带危险警告。

**觉得某个 API 不该这样、想绕：停下 escalate to human。** 大概率它那样是为守某条红线。

---

## 8. 禁止 & escalate 速查

| 你想做 | 别这样 | 应该 |
|---|---|---|
| 缓存文件离线读 | 自己开 IndexedDB | `file.open` 自动缓存 |
| 让文件离线常驻 / 腾本地空间 | 自己管 IndexedDB 容量 | `file.pin()` / `file.evict()` |
| 找回删掉的文件 | —— | `store.listTrash()` + `store.restore()` |
| 存设置 | 自己 localStorage | `localSettings` / `syncedSettings` |
| 列云端文件 | 自己 Graph fetch | `store.list*` |
| 加密 | 自己写 zip/7z/容器 | 注入 `sevenZip`（§1）+ `encrypted:true`/`store.encryption`，逻辑库管 |
| 局部改 collection 一条 | 找 partial-update API | 取整条 → 改 → `upsertItem` |
| 库没有你要的操作 | deep import 内部 / 自己实现 | **escalate to human 改库 API** |
