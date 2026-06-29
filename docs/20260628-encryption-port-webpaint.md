# 加密：从 WebPaint 移植到 JRP 库 —— 对账 & port 计划

> as-of 2026-06-28 · 红线区（改前已读 DATA SAFETY GUIDELINE，用户已授权「做加密，多和 webpaint 对账」）
> 信任顺序：代码现状 > 人类原话 > ADR > 本 doc。WebPaint 加密=用户**真机验过**的 ground-truth。

## 0. 架构定位（先读）

加密**逻辑**在库；重型 **7z(1.6MB wasm) + zip codec 由 app 注入**（不塞进每个 app bundle）。
- **JRP 自己不加密**（平铺明文 PDF）→ **不 vendor 7z、不注入 codec** → 加密 seam 在但 dormant（省 1.6MB）。
- **WebPaint 加密** → vendor `vendor/7z-wasm/`(7zz.wasm 1.65MB + 7zz.umd.js) + `vendor/zip-js/` + `src/sevenzip.ts` + `src/zip.ts`，注入 codec。
- 本轮 = **补全库的加密 wiring（在 JRP create-store）**，用 **mock codec 测**，JRP runtime 保持 non-encrypting。codec 提供者 + wasm **不进 JRP**，回传时 WebPaint 自带。

## 1. 对账：两边加密现状

| 件 | WebPaint（ground-truth，真机验） | JRP（现状） | 缺口 |
|---|---|---|---|
| `crypto-container.ts` | 3 层格式 + peek 加密，**静态 import** zip.ts/sevenzip.ts | **同逻辑 + 更先进**：codec **注入式**（`configureCryptoCodec`/`CryptoCodec` 接口，2026-06-21 去静态宿主依赖） | ✅ 完整（JRP 领先） |
| `seal.ts`（_seal/_unseal） | inline 在 store.ts（`_seal`/`_unseal`/`_withPassword`） | **已抽成 seal.ts**，含 makePeek+ext seam + LOCKED 红线 | ✅ 完整（JRP 领先） |
| codec 提供者 | `src/sevenzip.ts`(pack7z/unpack7z, -t7z -mhe=on -mx=0) + `src/zip.ts`(zipPack/zipUnpack, vendored zip-js) | 无 | 不进 JRP（app 注入；WebPaint 已有） |
| 7z-wasm | `vendor/7z-wasm/7zz.wasm`(1.65MB) 懒加载 | 无 | 不进 JRP |
| **createStore 收 codec** | app 直接 import（无注入参数） | **没调 configureCryptoCodec** | ⚠ 补：config 收 codec → configureCryptoCodec |
| **crypt config** | `crypt:{ext, makePeek, getPassword}` | config 有 `getPassword`，但 createSeal **没传 makePeek/ext** | ⚠ 补：config 收 crypt，接进 createSeal |
| save/open 透明封解 | `save`→_seal、`load`→_unseal | ✅ makeRaw save/open 已接 seal | ✅ |
| `verifyPassword(name,pw)` | 解 peek 验密码（便宜，不碰 7z） | 无 | ⚠ 补 |
| `readPeek`/`getTailBytes`/`decryptPeekBytes` | 本地 tail / 云 pullTail byte-range | 无（cloud.pullTail 已具备） | ⚠ 补 |
| `encryptFile`/`decryptFile` | `_swapBytes`：先本地后云 If-Match、离线 defer、错密码不落 | 无 | ⚠ 补（红线，照搬 _swapBytes） |
| `isEncrypted`/`looksEncrypted` | 本地字节尾扫 | crypto-container 有 looksEncryptedContainer | ⚠ 补 isEncrypted 查询 |
| ZipFile `setPreview/getPreview` | **无此 API**（peek 自动 via makePeek） | notYet throw | ⚠ getPreview→readPeek；setPreview 搁置（无 WP 等价 + 无 JRP 消费者） |

## 2. 密码模型决策（多对账 WebPaint）

**采 WebPaint 模型**：
- `getPassword(name): string|null` —— 同步、非交互、**只读内存**（唯一密码源）。app 侧 `crypto-state.ts` 持内存密码（统一图库密码 + per-name override），永不持久。
- store **非交互**：无/错密码 → flow 返 `locked`（不弹窗、不阻塞）。**prompt/verify/retry 全是 app 的事，且永在 busy 外**（busy 遮罩 z > sheet → 死锁；铁律）。app 用 `store.verifyPassword` 便宜验 → `setPassword` → 重跑 flow。
- peek = app 经 `makePeek(plain)` 自动派生（WebPaint=ora 缩略图 PNG）。

**搁置 README §5 的 `store.encryption`/库统一密钥/salt 文件/saveEncrypted/addEncryption 超集**——那是 AI 投机 spec、WebPaint 没有、JRP 不需要。本轮不实现；README §5 标「未采用，见本 doc」。**若用户要库统一密钥再单独 escalate。**

> Model-B 注记：JRP StoreUI 有 `askPassword`（store-driven），但加密**不走它**——对齐 WebPaint 的 app-driven getPassword（非交互）。askPassword 保持 unwired（或后续移除）。

## 3. Port 步骤（增量，每步 mock codec 测）

1. **codec 注入**：`StoreConfig.crypto?: CryptoCodec`；createStore 内 `if (crypto) configureCryptoCodec(crypto)`。types 导出 CryptoCodec。
2. **crypt config**：`StoreConfig.crypt?: { ext?; makePeek?; getPassword? }`（getPassword 从顶层挪进来或并存）；createSeal 接 `makePeek, ext`。
3. **verify + peek 读**：create-store 暴露 `verifyPassword(name,pw)`、`readPeek(name)`、`getTailBytes(name,n)`、`decryptPeekBytes(name,tail)`（用 crypto-container 的 scanEncPeekFromEnd/decryptPeek + local tail / cloud.pullTail）。
4. **encryptFile/decryptFile**：照搬 WebPaint `_swapBytes` 红线（local-first → cloud push If-Match → 失败 mark dirty + parentBase=swap 前云版；离线 status:offline；错密码前置退出）。进 singleFlight。
5. **ZipFile preview**：`getPreview()→readPeek`；`setPreview` 暂留 notYet（标注：WP 用 makePeek 自动，无显式 setPreview；待真需求再定）。
6. **isEncrypted(name)** + 暴露 `looksEncrypted`。
7. README §5 改：标「未采用 store.encryption 超集，加密走 getPassword/encryptFile，见 docs/11」。

## 4. 测试（mock codec，不 vendor 7z）

注入一个 fake CryptoCodec（zipPack/zipUnpack/pack7z/unpack7z 用内存 map 模拟，pack7z 错密码抛 `code:WRONG_PASSWORD`）：
- seal round-trip：encrypted 文件 save→open 透明封解；无密码→open 返 null(locked)、save 抛 LOCKED。
- verifyPassword：对密码 true、错密码 false（不碰 payload）。
- encryptFile/decryptFile：明文↔密文切换；离线 defer 不丢；错密码不落盘。
- readPeek：makePeek 写的 peek 读得回（local tail）。
- isEncrypted 查询。
- looksContainer 探测：明文 PDF→false、容器→true。

## 5. 回传 WebPaint 注记

JRP 完成后，回传时 WebPaint：保留它的 `vendor/7z-wasm` + `src/sevenzip.ts` + `src/zip.ts`，把它们包成 `CryptoCodec` 注入 createStore（替掉 crypto-container 的静态 import = 采 JRP 的注入式）。makePeek 仍=ora 缩略图。verify/encryptFile/peek 行为对账一致即可。
</content>
