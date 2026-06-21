# sync-store —— 使用手册（这是 SSoT，接库前必读）

> 一句话：**一个内容无关、红线安全的云同步存储库。你的 app 只跟它一个入口打交道，碰不到底层。**
>
> 状态：**设计定稿 2026-06-21。** 行为以本文为准；本文与代码冲突 = 代码 bug，修代码对齐本文。
> 标 ⚠TODO 的是已定、待实现的 API。

---

## 0. 铁律（用了本库就必须守）

1. **禁止**直接碰 `localStorage`、`IndexedDB`、任何 cloud vendor（Microsoft Graph / MSAL / 裸 `fetch` 云端）。**全部走本库。**
2. 本库**零内容格式知识**——你的文件是 `.ora`/`.glb`/`.pdf`/`.txt` 都一样，对库而言只是**不透明 binary blob**。库永不解码你的内容。（唯一例外：库**知道 zip 这种通用容器格式**——见 §2 `isZip`——但那是容器机制，不是内容知识。）
3. **缺接口、库没实现你要的行为？→ escalate to human 改库 API。绝不在 app 端绕过库自己实现。**
4. **不要 deep import 库内部文件**（`cloud-sync.ts`/`local-cache.ts`/`store.ts`/`crypto-container.ts`…）。只从 `index.ts` 拿 `createStore` + 一个 provider。内部文件顶部都有 WARNING。构建会 lint 挡 deep import。
5. **API 难用是故意的**（§6）。觉得某个 API 别扭、想绕——**停下来 escalate**，别绕。

> 为什么这么严？这个库存在的**唯一意义**：红线数据安全（不丢、不静默覆盖、离线可读、冲突 surface、加密）**一次在库里保证好，每个兄弟项目开箱即得**，不必每个项目重盯。你绕过去，库就失败了。

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

`createStore(config)` 返回一个对象，**覆盖你 app 需要的一切**。你**永远不**自己构造 cloud / 本地缓存 / 集合——都从它拿。返回：

| 拿到的 | 是什么 | 章节 |
|---|---|---|
| `store.file(name, { isZip })` | 文件 store（一个名字一个文件） | §2 |
| `store.collection(name, {...})` | 集合 store（一个 JSON 多 item） | §3 |
| `store.localSettings` | 设备本地设置 KV | §4 |
| `store.syncedSettings` | 跨设备同步设置（**只有 config 给了 `syncedSettingsFileName` 才有此属性**，否则编译期不存在） | §4 |
| `store.list()` / `store.listAll()` | 列文件 + 文件夹 | §2 |

---

## 2. 文件 store —— 一个名字一个文件

```ts
const f = store.file("papers/Wei 2011.pdf", { isZip: false });
await f.save(bytes);          // 新建 or 覆盖：本地落盘 + 按节律推云（If-Match 守冲突）
const blob = await f.open();  // 本地有则秒开；无则拉云 + 缓存到本地（下次离线可读）
await f.rename("papers/new.pdf");
await f.delete();             // = 移到 .trash（可恢复），绝不硬删脏字节
```
- **新建文件 = 对一个新 name `save`**（没有单独的 create）。云端撞同名异内容 → surface、绝不覆盖。
- **`open` 自动把字节缓存到本地** → 这就是"离线可读"，库强制，你不碰 IndexedDB。
- `store.list()` / `store.listAll()` → `{ files, folders, complete }`。`complete:false` = 列举有子树失败，**别据此删缓存**。

### `isZip` —— 决定能不能带预览图、加密几层（**编译期静态区分**）
你的文件是不是 zip 容器格式（`.ora`/`.atlas.zip` 是；`.pdf`/`.txt` 不是），创建时声明：

```ts
const raw = store.file("a.pdf", { isZip: false });   // 类型 = RawFile
raw.setPreview(blob);   // ❌ 编译错：RawFile 没有 setPreview

const zip = store.file("a.ora", { isZip: true });    // 类型 = ZipFile
await zip.setPreview(previewBlob);   // ✓ previewBlob 作为 zip 里一个 entry
const p = await zip.getPreview();    // 一次云端尾部 byte-range 取预览，不全量下载
```
- `isZip:false` → **`RawFile`**：原始字节直存（云端文件 = 原始内容，双击能开，守 anti-abandonware）。**无预览图**（类型上就没有 `setPreview`）。加密 = **2 层**。
- `isZip:true` → **`ZipFile`**：库把 `previewBlob` 当一个 zip entry 管（**库管 zip，你不写任何 zip 代码**）。加密 = **3 层**（外层明文 zip + 内层加密 + 尾部加密预览）。
- `previewBlob` 是**格式无关的不透明 binary blob**（jpg/png/随便，库不看、不构造、不解码——这是当年 ORA 误混进库的根因，已拔掉）。

> 静态原理：`store.file` 用 TS **函数重载**，按 `{isZip:true/false}` 的字面量返回 `ZipFile`/`RawFile`。（写死 `true`/`false` 时最强；传 runtime `boolean` 变量则退回保守 union。）

---

## 3. 集合 store —— 一个 JSON 文件里装多个 item

> （旧名 `folder-store` 是误导——它不是文件夹，是"一份同步 JSON，里头一堆带 id 的 item"。⚠TODO 改名 `collection`。）

```ts
const reading = store.collection("reading-state.json", { encode, decode });
reading.upsert({ id: docId, pageIndex, yFraction });   // 新增 / 整条替换
reading.update(docId, { pageIndex });                  // 局部改字段（partial）
reading.delete(docId);
reading.list();                                        // 当前所有 item（dict）
```
- 用于：阅读位置表、笔架、任何"一堆小条目、跨设备 CRDT 合并、零冲突"的东西。
- 内部 pull-merge-push + **per-id last-write-wins**，不丢、不静默覆盖。
- ⚠**合并粒度**：默认整-item LWW。两台设备并发改**同一 item 不同字段**会丢一个 → 要并发安全就开**字段级合并（per-key 时间戳）**。`syncedSettings`（§4）默认就是字段级。

---

## 4. 设置 —— 你**不碰** localStorage

两种，别混：

```ts
// A. 设备本地（theme/zoom/spread…，每台设备独立，不同步）
store.localSettings.set("theme", "night");
store.localSettings.get("theme");      // 没设 → undefined（**不提供 default 参数**）
store.localSettings.delete("theme");

// B. 跨设备同步（config 给了 syncedSettingsFileName 才有此属性）
store.syncedSettings.set("defaultZoom", 1.2);
store.syncedSettings.get("defaultZoom");
store.syncedSettings.delete("defaultZoom");
```
- **`get` 不给 default**：把"默认设置"放你 app **一处 SSoT**（一个 defaults 对象），别每次取值时各写各的 default → 不一致。
- `syncedSettings` **内部就是一个「只有一个 item 的 collection」**（§3），只对外暴露 KV——**同步逻辑 100% 复用 collection，不写两遍**。默认字段级合并（并发设不同 key 都活）。
- `syncedSettings` 只有 `config.syncedSettingsFileName` 给了才存在（**编译期条件类型**：没给就访问不到、编译错）。

---

## 5. 加密 —— 全 store 管，对 app 透明

加密的容器/zip/7z/层数/预览图加密**全在库内**，app 只提供「密码从哪来」。**安全由库强制。**

```ts
const store = createStore({ provider, encryptionSaltFileName: "vault.salt" });   // 用库统一密钥
```

两种模式：
- **per-file 密码**：每个文件各自密码。
- **库统一密钥**：整库一个密码。需 `encryptionSaltFileName` —— 一个小云文件，存 **salt + 验证器**：① 让所有设备从「密码+salt」派生**同一把钥匙**；② 没有任何加密内容文件时也能**验证密码**（错密码当场拒）。

> 密码**永不**由库弹框（库非交互）：库返 `status:"locked"`，弹框/验证/重试是你 UI 的事，且**必须在 busy 遮罩之外**（否则遮罩盖密码框 → 死锁）。UI 用 `store.verifyPassword(...)` 便宜验（解验证器，不碰 7z），过了自己 `setPassword`，再调 flow。
>
> 安全要点：**salt 不保密**（防彩虹表/预计算用）；防"逆向泄密码"靠**强 KDF**（高轮次，离线暴力极贵）+ **验证器是 KDF 派生的 GCM-tag**（碰不到明文）。实现照搬 WebPaint `crypto-container.ts`。

---

## 6. 为什么 API "难用"——是故意的，照着实现 UI

很多 API 形状**逼你把对应 UI 做对**，不是刁难：
- flow 返回 `status:"conflict"`/`"locked"`/`"invalid-cloud-bytes"` → 你**必须**接冲突 sheet / 密码框 / 提示。不接 = 用户数据风险。
- `busy(label, fn)` 注入项要求一个**全屏遮罩吞输入**（防误点）且**可重入**。
- `setPreview` 只在 `ZipFile` 上有 → 逼你想清楚文件是不是 zip 格式。

**觉得某个 API 不该这样、想绕过它实现：停下来 escalate to human。** 大概率它那样是为守某条红线。

---

## 7. 禁止 & escalate

| 你想做 | 别这样 | 应该 |
|---|---|---|
| 缓存文件离线读 | 自己开 IndexedDB | `file.open` 自动缓存（库强制） |
| 存设置 | 自己 localStorage | `localSettings` / `syncedSettings` |
| 列云端文件 | 自己 Graph fetch | `store.list*` |
| 加密 | 自己写 zip/7z/容器 | 给 `encryptionSaltFileName` + 密码 seam，库管 |
| 库没有你要的操作 | deep import 内部 / 自己实现 | **escalate to human 改库 API** |

---

## 8. 给后来接库的 agent
- 只 import `createStore` + provider。**deep import 内部文件 = 错**（顶部有 WARNING，构建 lint 会挡）。
- 红线在**库内** enforce（push-serialize / If-Match / move-aside / eviction 守卫 / ready-gate / 加密），UI 永不自己保证——绕过库 = 绕过红线。
- 不确定就 **escalate**，别猜、别绕。
