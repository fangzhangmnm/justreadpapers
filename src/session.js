// session.json 是 SSOT 的"唯一 asset"。结构:
//   { lastActive: itemId | null, docs: { itemId: { position: {pageIndex,yFraction}, addedAt } } }
//
// 设计原则:
//  - 内存里的 state 是单一来源,UI 直接读它。写盘是 debounce 后的副作用。
//  - 写盘用 If-Match (eTag) 检测冲突。412 → re-fetch + merge + retry。
//  - merge 策略:remote 当 base,把本地"活跃 doc"的位置 + lastActive 盖上去
//    (这是用户当下正在读的、最新的真实状态)。其它 doc 的 position 取 remote。
//  - 文件本身的存在性(谁活着 / 谁在 trash / 文件名)是 list approot 拿,不存 session。
//    session 只存阅读状态。这样 rename 不用 sync session,trash 也不用。
//
// 调用方:
//  init()                        启动时拉一次,拿到初始 state
//  setPosition(itemId, p)        每次滚动调,内部 debounce
//  setLastActive(itemId)         切论文时调,立即写盘
//  flush()                        beforeunload / visibilitychange-hidden 调,
//                                  强制 PUT 当前 state(配 keepalive)
//  checkRemoteChanged()          window focus 调,返回 true = 远端 eTag 变了,
//                                  让 UI 弹 "云端有更新" 提示
//  reloadFromRemote()            用户点了"同步" → 重读 remote 覆盖本地 state

import {
  readApprootJson,
  writeApprootJson,
  encodeApprootPath,
} from "./graph.js";
import { getToken } from "./auth.js";
import { SESSION_FILE, POSITION_DEBOUNCE_MS, POSITION_HEARTBEAT_MS } from "./config.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function emptyState() {
  return { lastActive: null, docs: {} };
}

let state = emptyState();
let knownETag = null; // last server eTag we've seen (after read or successful write)
let dirty = false;
let firstDirtyAt = 0; // 用于 debounce-with-ceiling:即使一直在脏,也保证 HEARTBEAT 后强推
let writeTimer = null;
let writeInFlight = null; // Promise of current PUT,避免重叠 PUT
let listeners = new Set();

function notify() {
  for (const fn of listeners) {
    try { fn(state); } catch (_) {}
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getState() {
  return state;
}

// ── init ──────────────────────────────────────────────────────────────────

export async function initSession() {
  const { data, eTag } = await readApprootJson(SESSION_FILE);
  if (data) {
    state = normalize(data);
    knownETag = eTag;
  } else {
    state = emptyState();
    knownETag = null;
    // 创建空 session.json 让 eTag 早点稳定下来
    try {
      const item = await writeApprootJson(SESSION_FILE, state, null);
      knownETag = item.eTag;
    } catch (_) {
      // 创建失败不致命 —— 下次有写需求再试
    }
  }
  notify();
  return state;
}

function normalize(raw) {
  const s = emptyState();
  if (raw && typeof raw === "object") {
    if (typeof raw.lastActive === "string") s.lastActive = raw.lastActive;
    if (raw.docs && typeof raw.docs === "object") {
      for (const [id, d] of Object.entries(raw.docs)) {
        if (!d || typeof d !== "object") continue;
        const entry = {};
        if (d.position && Number.isFinite(d.position.pageIndex)) {
          entry.position = {
            pageIndex: Math.max(0, Math.floor(d.position.pageIndex)),
            yFraction: clamp01(d.position.yFraction ?? 0),
          };
        }
        if (Number.isFinite(d.addedAt)) entry.addedAt = d.addedAt;
        s.docs[id] = entry;
      }
    }
  }
  return s;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

// ── mutations ────────────────────────────────────────────────────────────

export function setPosition(itemId, position) {
  if (!itemId) return;
  if (!state.docs[itemId]) state.docs[itemId] = {};
  state.docs[itemId].position = {
    pageIndex: Math.max(0, Math.floor(position.pageIndex ?? 0)),
    yFraction: clamp01(position.yFraction ?? 0),
  };
  scheduleWrite();
}

export function setLastActive(itemId) {
  if (state.lastActive === itemId) return;
  state.lastActive = itemId;
  if (itemId && !state.docs[itemId]) {
    state.docs[itemId] = { addedAt: Date.now() };
  }
  // lastActive 是 UX 关键(跨设备 resume),立即写不等 debounce
  scheduleWrite(0);
}

export function ensureDoc(itemId, { addedAt } = {}) {
  if (!state.docs[itemId]) {
    state.docs[itemId] = { addedAt: addedAt ?? Date.now() };
    scheduleWrite();
  }
}

export function forgetDoc(itemId) {
  if (state.docs[itemId]) {
    delete state.docs[itemId];
    if (state.lastActive === itemId) state.lastActive = null;
    scheduleWrite(0);
  }
}

export function getPosition(itemId) {
  return state.docs[itemId]?.position ?? null;
}

// ── write scheduling ─────────────────────────────────────────────────────

function scheduleWrite(delay = POSITION_DEBOUNCE_MS) {
  dirty = true;
  if (firstDirtyAt === 0) firstDirtyAt = Date.now();
  if (writeTimer) clearTimeout(writeTimer);
  const now = Date.now();
  // debounce: 每次脏 → 重置 delay 倒计时
  // 但封顶 firstDirtyAt + HEARTBEAT,避免一直脏导致永不 push
  // delay=0 (lastActive / forgetDoc) 走立即,不受 ceiling 影响
  const target = delay === 0
    ? now
    : Math.min(now + delay, firstDirtyAt + POSITION_HEARTBEAT_MS);
  const wait = Math.max(0, target - now);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flush().catch((e) => console.warn("session flush failed:", e));
  }, wait);
}

// 强制写盘。返回 Promise。
export async function flush() {
  if (!dirty && !writeInFlight) return;
  // 已有 PUT 在跑:等它完,再看是不是又脏了
  if (writeInFlight) {
    try { await writeInFlight; } catch (_) {}
    if (!dirty) return;
  }
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }

  // 把 dirty 标记移交给当前这次 PUT —— 期间又脏了的话,标记会被 setPosition 重置成 true
  dirty = false;
  const ceilingMarkAtSnapshot = firstDirtyAt;
  firstDirtyAt = 0;  // 提前 reset,这样 PUT 期间又脏会重新起 ceiling 起点
  const snapshot = structuredClone(state);
  const eTagAtSnapshot = knownETag;

  writeInFlight = (async () => {
    try {
      const item = await writeApprootJson(SESSION_FILE, snapshot, eTagAtSnapshot);
      knownETag = item.eTag;
    } catch (e) {
      if (e.status === 412) {
        // 远端被另一设备改了 —— merge + retry 一次
        await mergeRemoteAndRetry(snapshot);
      } else {
        // 网络 / 5xx → 标 dirty 让下次再试,ceiling 起点恢复
        dirty = true;
        if (firstDirtyAt === 0) firstDirtyAt = ceilingMarkAtSnapshot || Date.now();
        throw e;
      }
    }
  })();

  try {
    await writeInFlight;
  } finally {
    writeInFlight = null;
  }
}

async function mergeRemoteAndRetry(localSnapshot) {
  const { data: remote, eTag: remoteETag } = await readApprootJson(SESSION_FILE);
  const remoteState = remote ? normalize(remote) : emptyState();

  // merge: remote 当 base,把"本地最近改的"东西盖上
  // - lastActive: 本地优先(本设备的当下读的)
  // - docs[*].position: 本地有就用本地 (本设备活跃,远端 stale)
  //   实际上 setPosition 只针对正在读的 doc,所以这等价于"活跃 doc 的 position 用本地"
  // - 其它字段 (addedAt) remote 优先(可能远端刚 ingest 了)
  const merged = structuredClone(remoteState);
  if (localSnapshot.lastActive) merged.lastActive = localSnapshot.lastActive;
  for (const [id, d] of Object.entries(localSnapshot.docs)) {
    if (!merged.docs[id]) merged.docs[id] = {};
    if (d.position) merged.docs[id].position = d.position;
    if (d.addedAt && !merged.docs[id].addedAt) merged.docs[id].addedAt = d.addedAt;
  }

  // 用 remote eTag 重 PUT;若再 412 就放弃这轮,让下次再试
  try {
    const item = await writeApprootJson(SESSION_FILE, merged, remoteETag);
    knownETag = item.eTag;
    state = merged;
    notify();
  } catch (e) {
    if (e.status === 412) {
      // 还冲突:把本地标 dirty,下个 cycle 再 merge
      dirty = true;
    } else {
      dirty = true;
      throw e;
    }
  }
}

// ── reconcile on window focus ────────────────────────────────────────────

// 只比 eTag,不下载内容。eTag 变了 → 返回 true,让 UI 弹"有更新"提示
export async function checkRemoteChanged() {
  if (!knownETag) return false;
  try {
    const token = await getToken();
    const r = await fetch(
      `${GRAPH_BASE}/me/drive/special/approot:/${encodeApprootPath(SESSION_FILE)}?$select=id,eTag`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r.ok) return false;
    const meta = await r.json();
    return meta.eTag && meta.eTag !== knownETag;
  } catch (_) {
    return false;
  }
}

export async function reloadFromRemote() {
  // 把本地未 flush 的先 push,避免被覆盖丢
  if (dirty) {
    try { await flush(); } catch (_) {}
  }
  const { data, eTag } = await readApprootJson(SESSION_FILE);
  if (data) {
    state = normalize(data);
    knownETag = eTag;
    notify();
  }
  return state;
}

// ── keepalive flush (beforeunload / visibility hidden) ───────────────────
// fetch keepalive 不能用 If-Match 才安全 —— 但这里 body <64KB + last-write-wins 可接受。
// 实际跑的话:位置丢 1 次的代价远比 PUT 重试失败小,所以兜底用 sendBeacon 风格的 fire-forget。

export function flushKeepalive() {
  if (!dirty) return;
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const snapshot = state;
  const eTag = knownETag;
  // 同步触发一个 keepalive fetch,不 await。
  // (异步 await getToken 会被 unload 杀掉,所以这里 best-effort:有 token 就发,没就跳过)
  getToken().then((token) => {
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    if (eTag) headers["If-Match"] = eTag;
    fetch(
      `${GRAPH_BASE}/me/drive/special/approot:/${encodeApprootPath(SESSION_FILE)}:/content?@microsoft.graph.conflictBehavior=replace`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify(snapshot),
        keepalive: true,
      },
    ).catch(() => {});
  }).catch(() => {});
}
