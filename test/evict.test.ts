// evict 深模块对抗测试（取消缓存红线守卫）：只驱逐 clean∧在线∧云端在∧!pinned；
// dirty/离线/cloud-gone/pinned 一律保留（不丢未推字节）。
import { test, eq, assert } from "./_harness.ts";
import { createEvict } from "../src/store/evict.ts";
import { createPinSet } from "../src/store/pin-set.ts";
import { memKv } from "../src/store/cloud-sync.ts";

function setup(opts: { online?: boolean } = {}) {
  const localSet = new Set<string>();
  const cloudSet = new Set<string>();
  const dirtySet = new Set<string>();
  const forgotten: string[] = [];
  const pins = createPinSet(memKv());
  const ev = createEvict({
    cloud: { fetchMeta: async (n: string) => (cloudSet.has(n) ? ({ etag: "e", lastModified: 0, size: 1, item: {} as any }) : null) },
    local: { exists: async (n: string) => localSet.has(n), hardDelete: async (n: string) => { localSet.delete(n); } },
    head: { isDirty: (n: string) => dirtySet.has(n), forget: (n: string) => { forgotten.push(n); } },
    pins,
    isOnline: () => opts.online !== false,
  });
  return { ev, localSet, cloudSet, dirtySet, forgotten, pins };
}

test("[evict] clean∧在线∧云端在∧!pinned → 驱逐本地", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf");
  const r = await s.ev.evict("a.pdf");
  eq(r.status, "evicted", "驱逐"); assert(!s.localSet.has("a.pdf"), "本地已删"); eq(s.forgotten[0], "a.pdf", "谱系已清");
});

test("[evict] dirty → 保留（绝不丢未推字节）", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf"); s.dirtySet.add("a.pdf");
  const r = await s.ev.evict("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "dirty", "因 dirty"); assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[evict] pinned（无 force）→ 保留", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf"); s.pins.add("a.pdf");
  const r = await s.ev.evict("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "pinned", "因 pinned"); assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[evict] pinned + force → 驱逐（取消缓存=unpin 后 force）", async () => {
  const s = setup(); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf"); s.pins.add("a.pdf");
  const r = await s.ev.evict("a.pdf", { force: true });
  eq(r.status, "evicted", "force 跳过 pin 检查"); assert(!s.localSet.has("a.pdf"), "本地已删");
});

test("[evict] 离线 → 保留（不可重取）", async () => {
  const s = setup({ online: false }); s.localSet.add("a.pdf"); s.cloudSet.add("a.pdf");
  const r = await s.ev.evict("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "offline", "因离线"); assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[evict] cloud-gone（云端无副本）→ 保留（唯一好副本）", async () => {
  const s = setup(); s.localSet.add("a.pdf"); /* cloudSet 不加 */
  const r = await s.ev.evict("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "cloud-gone", "因云端没了"); assert(s.localSet.has("a.pdf"), "本地还在");
});

test("[evict] 未缓存 → noop", async () => {
  const s = setup();
  const r = await s.ev.evict("a.pdf");
  eq(r.status, "kept", "保留"); eq(r.reason, "not-cached", "本就没缓存");
});

test("[pin-set] has/add/remove + 跨实例(同 kv)持久", () => {
  const kv = memKv();
  const p1 = createPinSet(kv); p1.add("a"); assert(p1.has("a"), "add 后 has");
  const p2 = createPinSet(kv); assert(p2.has("a"), "同 kv 新实例可见(持久)");
  p2.remove("a"); assert(!p1.has("a"), "remove 生效");
});
