# Session.json 节流 + 冲突 + 离线兜底

OneDrive 上的 `session.json` 是唯一 asset (~1KB JSON, lastActive + 每篇 position)。两个 trade-off:
- **写太频** → OneDrive 版本历史污染 / 活动 feed 闹 / 浪费 Graph quota
- **写太懒** → 跨设备 handoff stale,user 切设备打开看到旧位置

## 演进史 (commit-by-commit)

| commit | 方案 | 教训 |
| --- | --- | --- |
| 初版 | 单次 debounce 1.5s | 持续 scroll 永不 flush;crash 丢一切 |
| `070b1a7` | debounce 5s + ceiling 30s (抄 webxiaoheiwu) | 还是写得太频,典型 reading 1hr ~120 PUT |
| `b90d5cc` | + 10s/60s + trivial-skip(同页 yFrac<5% 不调度) | OK 多了,但还是按 yFrac 阈值不直观 |
| `f43e5f3` | 10s debounce / 30s ceiling / **trivial 50% = 半页** | 鼠标 fidget 真的不推 → 用户接受 |

最终参数:`POSITION_DEBOUNCE_MS=10_000`、`POSITION_HEARTBEAT_MS=30_000`、`TRIVIAL_POSITION_Y_DELTA=0.5`。

## 写盘三层节流

```js
// 1. viewer 层:scroll 停 500ms → setPosition (内存)
//                                    rAF 节流另一路 → realtime pageStatus 显示用
//
// 2. session 层:debounce + ceiling
//    每次 non-trivial setPosition 重置 10s 倒计时
//    但封顶 firstDirty + 30s,持续脏不会无限拖
//
// 3. trivial-skip
//    跟"上次成功推到 OneDrive"的位置比:同页 + |yFrac Δ| < 0.5 → 只更新内存,
//    不调度。专门吃掉鼠标 fidget / loitering
```

trivial-skip 的精髓在跟 **lastPushed** 比(不是跟内存上一帧比),否则连续微移 0.4 → 0.45 → 0.5 → 0.55 ... 永远 trivial,累计跑半张页都不推。

## 兜底:close events

定时器在某些场景靠不住(用户切 tab 后台 setTimeout 被浏览器 throttle 到分钟级)。挂三条:

```js
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flush().catch(() => {});
    flushKeepalive();
  }
});
// pagehide 在移动 / iOS 上比 beforeunload 更可靠
window.addEventListener("pagehide", () => {
  flush().catch(() => {});
  flushKeepalive();
});
window.addEventListener("beforeunload", flushKeepalive);
```

`flushKeepalive` 用 `fetch(..., { keepalive: true })`,unload 时浏览器仍把 body 推上 wire。session.json < 64KB body,符合 keepalive 限制。

## If-Match (eTag) + 412 merge retry

cross-device 冲突 protection。每个 PUT 带 `If-Match: <eTag>`,远端被另一设备改了 → 412 → re-fetch + merge + 重 PUT。

```js
try {
  const item = await writeApprootJson(SESSION_FILE, snapshot, eTagAtSnapshot);
  knownETag = item.eTag;
} catch (e) {
  if (e.status === 412) await mergeRemoteAndRetry(snapshot);
  else { dirty = true; throw e; }  // 网络 / 5xx,下次再试
}

async function mergeRemoteAndRetry(localSnapshot) {
  const { data: remote, eTag: remoteETag } = await readApprootJson(SESSION_FILE);
  // merge: remote 当 base,本地"活跃"的覆盖
  //   - lastActive: 本地优先(本设备的当下读的)
  //   - docs[*].position: 本地有就用本地(本设备活跃 → 远端 stale)
  //   - 其它 (addedAt 等): remote 优先
  const merged = JSON.parse(JSON.stringify(remote));  // structuredClone iOS<15.4 没有
  if (localSnapshot.lastActive) merged.lastActive = localSnapshot.lastActive;
  for (const [id, d] of Object.entries(localSnapshot.docs)) {
    if (!merged.docs[id]) merged.docs[id] = {};
    if (d.position) merged.docs[id].position = d.position;
  }
  await writeApprootJson(SESSION_FILE, merged, remoteETag);
}
```

## Window focus reconcile

window focus 时**只查 eTag**(不下载内容),变了就弹 toast `云端有更新 / 同步`:

```js
async function checkRemoteChanged() {
  const token = await getToken();
  const r = await fetch(`${GRAPH_BASE}/me/drive/special/approot:/session.json:?$select=id,eTag`,
    { headers: { Authorization: `Bearer ${token}` } });
  const meta = await r.json();
  return meta.eTag && meta.eTag !== knownETag;
}
```

用户点同步 → `reloadFromRemote` 覆盖本地 state + 切论文如果 lastActive 也变了。

## Single-flight 防 PUT 重叠

```js
let writeInFlight = null;
async function flush() {
  if (writeInFlight) {
    await writeInFlight.catch(() => {});
    if (!dirty) return;  // 上一个 flush 已经把 dirty 推完了
  }
  writeInFlight = (async () => { ...PUT... })();
  try { await writeInFlight; } finally { writeInFlight = null; }
}
```

不加这个,rapid `scheduleWrite(0)` (lastActive 切换 / outline 跳页) 会并发 PUT,后到的可能覆盖前到的。

## 意图驱动的 immediate flush

非滚动的"我现在确定要在这" → bypass debounce:
- `setLastActive(itemId)` (切论文) → `scheduleWrite(0)`
- 点 outline 章节跳页 → `setTimeout(flush, 800)` (等 viewer scroll 沉淀)
- 点缩略图跳页 → 同上

`setTimeout(flush, 800)` 要 **dedup**(连击 outline 不要堆 timer):

```js
let outlineJumpFlushTimer = null;
if (outlineJumpFlushTimer) clearTimeout(outlineJumpFlushTimer);
outlineJumpFlushTimer = setTimeout(() => {
  outlineJumpFlushTimer = null;
  flush().catch(() => {});
}, 800);
```

## 离线兜底:localStorage backup

session.js 每次 mutation + 成功 PUT 都同步写一份到 localStorage:

```js
const LOCAL_BACKUP_KEY = "jrp.session.backup";
function writeLocalBackup() {
  try { localStorage.setItem(LOCAL_BACKUP_KEY, JSON.stringify(state)); } catch (_) {}
}
```

`initSession` 先 hydrate 备份(让冷启动有 lastActive 立刻可用),再尝试 Graph fetch:

```js
const backup = readLocalBackup();
if (backup) state = normalize(backup);  // optimistic hydrate

try {
  const { data, eTag } = await readApprootJson(SESSION_FILE);
  if (data) { state = normalize(data); knownETag = eTag; }
} catch (e) {
  // 离线 / Graph 失败 → 继续用 backup
  console.warn("initSession remote failed, using local backup");
}
```

`window.addEventListener("online", flush)` → 重新上网自动推积压的脏 session。

## 最坏情况 rate

| 路径 | 频率上限 |
| --- | --- |
| 持续 reading + 真在动 | 1 PUT / 30s = 120/hr (ceiling) |
| Trivial fidget (单页内) | 0 / hr (skip-and-leak-to-flushKeepalive) |
| 攻击者直接调 flush() 循环 | ~5-10 PUT/s,被 Graph 端 429 throttle 拦截 |
| burst (rapid 切论文) | 100-200ms × N,single-flight 排队 |

OneDrive 版本历史 cap 25,1.25s 轮换一遍 evict 旧的 → **存储增量稳态 ~25KB**,无持久伤害。

## 相关
- [20260524-design-principles.md](20260524-design-principles.md) — session.json 是 SSOT 的物理位置
- [20260524-msal-graph-pattern.md](20260524-msal-graph-pattern.md) — Graph API + AppFolder + If-Match
- [20260524-offline-persistence.md](20260524-offline-persistence.md) — 离线模式更完整的兜底
