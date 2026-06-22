# sync-store —— 使用手册（这是 SSoT，接库前必读）

> **一个内容无关、红线安全的云同步存储库。你的 app 只跟一个入口打交道，碰不到底层。**
>
> 状态：设计定稿 2026-06-21。行为以本文为准；本文与代码冲突 = 代码 bug，修代码对齐本文。
> 标 ⚠TODO 的是已定、待实现。

---

## 0. 铁律（用了本库就必须守）

1. **禁止**直接碰 `localStorage`、`IndexedDB`、任何 cloud vendor（Microsoft Graph / MSAL / 裸 `fetch` 云端）。全部走本库。
2. 本库**零内容格式知识**——你的文件是 `.ora`/`.glb`/`.pdf`/`.txt` 都一样，对库只是**不透明 binary blob**。库永不解码你的内容。（唯一例外：库懂 **zip 这种通用容器**，见 §2 `isZip`——那是容器机制，不是内容知识。）
3. **缺接口、库没实现你要的行为 → escalate to human 改库 API。绝不在 app 端绕过库自己实现。**
4. **不要 deep import 库内部文件**。只从 `index.ts` 拿 `createStore` + 一个 provider。内部文件顶部有 WARNING，构建 lint 会挡 deep import。
5. **API 难用是故意的**（§7）。觉得别扭、想绕——**停下 escalate**，别绕。

> 为什么这么严：这个库存在的**唯一意义**是把红线数据安全（不丢、不静默覆盖、离线可读、冲突 surface、加密）**一次在库里保证好，每个兄弟项目开箱即得**。你绕过去，库就失败了。

---

## 1. 唯一入口

```ts
import { createStore, createOneDriveProvider } from "./store/index.ts";

const { provider } = createOneDriveProvider({ clientId, msalUrl: "./vendor/msal/msal-browser.min.js" });

const store = createStore({
  provider,                                  // 必填
  syncedSettingsFileName: "settings.json",   // 选填：要跨设备同步设置时给（§4）
  encryptionSaltFileName: "vault.salt",      // 选填：用「库统一密钥」加密时给（§5）
});
```

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
await f.delete();             // = 移到 .trash（可恢复），绝不硬删脏字节
```
- **新建文件 = 对一个新 name `save`**（没有单独的 create）。云端撞同名异内容 → surface，绝不覆盖。
- **`open` 自动把字节缓存本地** = "离线可读"，库强制，你不碰 IndexedDB。
- `store.list()` / `store.listAll()` → `{ files, folders, complete }`。`complete:false` = 列举有子树失败，**别据此删缓存**。

### `opts.isZip` —— 决定能否带预览图、加密几层

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
- 内部 pull-merge-push，**per-item last-write-wins**（每 item 一个 `uat`，并发改不同 item 都不丢）。不丢、不静默覆盖。

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

加密的容器 / zip / 7z / 层数 / 预览图加密 / KDF / salt **全在库内**。app 只负责一件库做不了的事：**把密码输进来**（库非交互、永不弹框）。

### 5.1 库统一密钥（最常见：整库一个密码）

config 给 `encryptionSaltFileName` → 多一个 `store.encryption`：

```ts
const store = createStore({ provider, encryptionSaltFileName: "vault.salt" });

// 首次建库密钥（salt 文件还不存在时，一次）：
await store.encryption.init(password);   // 写 salt + 验证器到 vault.salt

// 每次启动解锁（app UI 在 busy 遮罩之外做）：
const ok = await store.encryption.unlock(password);  // 验 salt → true/false；对则内存持 key
store.encryption.isUnlocked();           // 库是否已解锁
store.encryption.lock();                 // 清内存 key
```
- `vault.salt` 是个小云文件，存 **salt + 验证器**：让所有设备从「密码+salt」派生**同一把钥匙**，且没有任何加密内容文件时也能**验证密码**（错密码当场拒）。
- salt 不保密（防彩虹表用）；防暴力靠**强 KDF**（实现照搬 WebPaint）。

### 5.2 标记文件加密

```ts
// (a) 库统一密钥：解锁一次(§5.1)，之后 save/open 透明加解密
const f = store.file("secret.ora", { isZip: true, encrypted: true });
await f.save(bytes);   // 已解锁 → 库自动加密
await f.open();        // 已解锁 → 自动解密

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

## 7. store 怎么对 UI 有强制性

> ⚠**评审中（Model B）**：UI 强制的**机制**（store 驱动 flow + 注入 `ui` 回调：`busy`/`askPassword`/`resolveConflict`/`reportError`，store 在决策点回调进 app 并 await）正在 grill，待定稿后补全本节 + config 的 `ui` 注入 + 冲突选项后果表。下面先列已确定的"形状强制"。

已确定的"形状强制"——很多 API 形状**逼你把对应 UI 做对**：
- `setPreview` 只在 `ZipFile` 上 → 逼你想清楚文件是不是 zip 格式。
- `get` 不给 default → 逼你把默认值收到一处。
- `removeEncryption` 命名自带危险警告。

**觉得某个 API 不该这样、想绕：停下 escalate to human。** 大概率它那样是为守某条红线。

---

## 8. 禁止 & escalate 速查

| 你想做 | 别这样 | 应该 |
|---|---|---|
| 缓存文件离线读 | 自己开 IndexedDB | `file.open` 自动缓存 |
| 存设置 | 自己 localStorage | `localSettings` / `syncedSettings` |
| 列云端文件 | 自己 Graph fetch | `store.list*` |
| 加密 | 自己写 zip/7z/容器 | `encrypted:true` + `store.encryption`，库管 |
| 局部改 collection 一条 | 找 partial-update API | 取整条 → 改 → `upsertItem` |
| 库没有你要的操作 | deep import 内部 / 自己实现 | **escalate to human 改库 API** |
