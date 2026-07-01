// listing 深模块测试：统一列举 = local ∪ cloud，syncState 8-badge 分类器穷举 + 编排（offline-first / partial≠gone）。
// 红线：云那半拿不到 → items 仍从本地产出，绝不返空、绝不 throw；partial 缺失≠云端真没了（不判 ghost/gone）。
import { test, eq } from "./_harness.ts";
import { classifySyncState, createListing, isCached, isDirty, type SyncState } from "../src/store/listing.ts";

// ── 纯分类器穷举 ─────────────────────────────────────────────────────────────
const base = { hasLocal: true, hasCloud: true, everSynced: true, cloudMoved: false, dirty: false, cloudReachable: true, absenceAuthoritative: true };
const cls = (o: Partial<typeof base>): SyncState => classifySyncState({ ...base, ...o });

test("[listing] cloud-only：无本地", () => eq(cls({ hasLocal: false }), "cloud-only", ""));
test("[listing] synced：bound clean 云没动", () => eq(cls({}), "synced", ""));
test("[listing] unpushed：bound dirty 云没动", () => eq(cls({ dirty: true }), "unpushed", ""));
test("[listing] newer-on-cloud：bound clean cloudMoved", () => eq(cls({ cloudMoved: true }), "newer-on-cloud", ""));
test("[listing] conflict：bound dirty cloudMoved", () => eq(cls({ dirty: true, cloudMoved: true }), "conflict", ""));
test("[listing] ghost：dirty cloudGone(权威)", () => eq(cls({ hasCloud: false, dirty: true }), "ghost", ""));
test("[listing] clean 孤儿：clean cloudGone(权威)→local-only", () => eq(cls({ hasCloud: false }), "local-only", ""));
test("[listing] float：本地新文件有编辑(¬everSynced dirty)", () => eq(cls({ hasCloud: false, everSynced: false, dirty: true }), "float", ""));
test("[listing] local-only：本地新文件 clean", () => eq(cls({ hasCloud: false, everSynced: false }), "local-only", ""));
test("[listing] 撞云端同名(hasCloud ¬everSynced) clean→newer-on-cloud", () => eq(cls({ everSynced: false }), "newer-on-cloud", ""));
test("[listing] 撞云端同名 dirty→conflict", () => eq(cls({ everSynced: false, dirty: true }), "conflict", ""));

// 离线/登出（¬cloudReachable）：云轴不可知 → 塌到本地视角
test("[listing] 离线 clean cached → local-only", () => eq(cls({ cloudReachable: false, absenceAuthoritative: false }), "local-only", ""));
test("[listing] 离线 dirty everSynced → unpushed", () => eq(cls({ cloudReachable: false, absenceAuthoritative: false, dirty: true }), "unpushed", ""));
test("[listing] 离线 dirty ¬everSynced → float", () => eq(cls({ cloudReachable: false, absenceAuthoritative: false, dirty: true, everSynced: false }), "float", ""));

// partial（cloudReachable 但 ¬absenceAuthoritative）：没看到≠没了 → 保守显示「仍在」，绝不判 ghost/gone
test("[listing] partial 缺失 clean → synced(不判 gone)", () => eq(cls({ hasCloud: false, absenceAuthoritative: false }), "synced", ""));
test("[listing] partial 缺失 dirty → unpushed(不判 ghost)", () => eq(cls({ hasCloud: false, absenceAuthoritative: false, dirty: true }), "unpushed", ""));

// 便利判定
test("[listing] isCached = 非 cloud-only", () => { eq(isCached("cloud-only"), false, ""); eq(isCached("synced"), true, ""); eq(isCached("local-only"), true, ""); });
test("[listing] isDirty = unpushed/conflict/float/ghost", () => {
  for (const s of ["unpushed", "conflict", "float", "ghost"] as SyncState[]) eq(isDirty(s), true, s);
  for (const s of ["synced", "newer-on-cloud", "cloud-only", "local-only"] as SyncState[]) eq(isDirty(s), false, s);
});

// ── 编排 rig ─────────────────────────────────────────────────────────────────
function rig() {
  // 云端：synced.pdf(与 seen 同 etag) / newer.pdf(etag 变了) / cloudonly.pdf(无本地)
  let cloudRet: { files: any[]; folders: string[]; complete: boolean } | "throw" = {
    files: [
      { path: "synced.pdf", eTag: "e1", size: 10, lastModifiedDateTime: "2026-06-01T00:00:00Z" },
      { path: "newer.pdf", eTag: "e2new", size: 20, lastModifiedDateTime: 1000 },
      { path: "cloudonly.pdf", eTag: "e3", size: 30, lastModifiedDateTime: 2000 },
    ], folders: ["组合"], complete: true,
  };
  const cloud = { listAll: async () => { if (cloudRet === "throw") throw new Error("x"); return cloudRet; }, getETag: () => null };
  // 本地缓存：synced/newer/localonly（cloudonly 无本地）
  const local = { appKeys: async () => ["synced.pdf", "newer.pdf", "localonly.pdf"] };
  const seen = new Map<string, string>([["synced.pdf", "e1"], ["newer.pdf", "e2old"]]);  // localonly 从没 synced
  const dirty = new Set<string>();
  const head = { seenBase: (n: string) => seen.get(n) ?? null, isDirty: (n: string) => dirty.has(n) };
  const { listAllItems } = createListing({ cloud: cloud as any, local: local as any, head: head as any, pendingFolders: () => ["离线夹"] });
  return { listAllItems, setCloud: (v: typeof cloudRet) => { cloudRet = v; }, dirty };
}
const byPath = (items: { path: string; syncState: SyncState }[]) => new Map(items.map((i) => [i.path, i.syncState]));

test("[listing] 在线 union：cloud ∪ local，各 badge 正确", async () => {
  const r = rig();
  const { items, folders, complete } = await r.listAllItems({ signedIn: true, online: true });
  const m = byPath(items);
  eq(items.length, 4, "synced+newer+cloudonly+localonly");
  eq(m.get("synced.pdf"), "synced", "");
  eq(m.get("newer.pdf"), "newer-on-cloud", "etag 变=云有新版");
  eq(m.get("cloudonly.pdf"), "cloud-only", "无本地");
  eq(m.get("localonly.pdf"), "local-only", "从没 synced 的本地文件");
  eq(complete, true, "");
  eq(folders.includes("组合") && folders.includes("离线夹"), true, "云 folders ∪ pending 离线夹");
});
test("[listing] 离线：不调云、items 纯本地、绝不返空", async () => {
  const r = rig();
  const { items, complete } = await r.listAllItems({ signedIn: true, online: false });
  const m = byPath(items);
  eq(items.length, 3, "只本地 3 个（cloudonly 消失=符合预期，它本就无本地）");
  eq(m.get("synced.pdf"), "local-only", "离线塌成 local-only");
  eq(m.has("cloudonly.pdf"), false, "无本地的云端文件离线不列");
  eq(complete, false, "离线=云 walk 没发生");
});
test("[listing] 登出：等价离线（不调云）", async () => {
  const r = rig();
  const { items } = await r.listAllItems({ signedIn: false, online: true });
  eq(items.length, 3, "登出只本地");
});
test("[listing] listAll 抛错 → 优雅降级本地，绝不 throw/返空", async () => {
  const r = rig(); r.setCloud("throw");
  const { items, complete } = await r.listAllItems({ signedIn: true, online: true });
  eq(items.length, 3, "云抛错 → 退本地 3 个");
  eq(complete, false, "");
});
test("[listing] partial(complete=false)：本地 item 照列，缺失不判 gone", async () => {
  const r = rig();
  r.setCloud({ files: [{ path: "synced.pdf", eTag: "e1", size: 10, lastModifiedDateTime: 0 }], folders: [], complete: false });
  const { items, complete } = await r.listAllItems({ signedIn: true, online: true });
  const m = byPath(items);
  eq(complete, false, "");
  eq(m.get("newer.pdf"), "synced", "partial 里没看到 newer.pdf → 保守 synced，不判 gone");  // everSynced ∧ !hasCloud ∧ !absenceAuth
  eq(m.get("localonly.pdf"), "local-only", "从没 synced 的仍是 local-only");
});
test("[listing] dirty cloud-gone(权威)→ ghost，绝不消失", async () => {
  const r = rig(); r.dirty.add("newer.pdf");
  r.setCloud({ files: [{ path: "synced.pdf", eTag: "e1", size: 10, lastModifiedDateTime: 0 }], folders: [], complete: true });  // newer 从云端消失
  const { items } = await r.listAllItems({ signedIn: true, online: true });
  eq(byPath(items).get("newer.pdf"), "ghost", "dirty + 权威 cloud-gone = 👻，字节还在列表里");
});
