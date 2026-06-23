// offload 深模块对抗测试（移除本地副本的红线守卫）：只 offload clean∧在线∧云端在；
// dirty/离线/cloud-gone/未缓存 一律保留（不丢未推字节）。无 LRU、无 pin flag：有本地副本 = kept offline。
import { test, eq, assert } from "./_harness.ts";
import { createOffload } from "../src/store/offload.ts";

function setup(opts: { online?: boolean } = {}) {
  const localSet = new Set<string>();
  const cloudSet = new Set<string>();
  const dirtySet = new Set<string>();
  const forgotten: string[] = [];
  const off = createOffload({
    cloud: { fetchMeta: async (n: string) => (cloudSet.has(n) ? ({ etag: "e", lastModified: 0, size: 1, item: {} as any }) : null) },
    local: { exists: async (n: string) => localSet.has(n), hardDelete: async (n: string) => { localSet.delete(n); } },
    head: { isDirty: (n: string) => dirtySet.has(n), forget: (n: string) => { forgotten.push(n); } },
    isOnline: () => opts.online !== false,
  });
  return { off, localSet, cloudSet, dirtySet, forgotten };
}

test("[offload] clean∧在线∧云端在 → 移除本地", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf");
  const r = await s.off.offload("a.pdf");
  eq(r.status, "offloaded", "移除"); assert(!s.localSet.has("a.pdf"), "本地已删"); eq(s.forgotten[0], "a.pdf", "谱系已清");
});

test("[offload] dirty → 保留（绝不丢未推字节）", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf"); s.dirtySet.add("a.pdf");
  const r = await s.off.offload("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "dirty", "因 dirty"); assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] 离线 → 保留（不可重取）", async () => {
  const s = setup({ online: false }); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf");
  const r = await s.off.offload("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "offline", "因离线"); assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] cloud-gone（云端无副本/未登录取不到）→ 保留（唯一好副本）", async () => {
  const s = setup(); s.localSet.add("a.pdf"); /* cloudSet 不加 */
  const r = await s.off.offload("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "cloud-gone", "因云端没了"); assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[offload] 未缓存 → noop", async () => {
  const s = setup();
  const r = await s.off.offload("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "not-cached", "本就没缓存");
});
