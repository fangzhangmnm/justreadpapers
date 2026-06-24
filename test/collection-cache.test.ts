// collection 本地缓存对抗测试（85–88：透明 IDB 缓存 + 离线可读 + 旧设备旧缓存不盖新 + 笔刷大 payload）。
// 红线对照：A5 旧设备旧缓存盖新 = 必须 user-action-time(uat) max-wins、单调前进；
//   A2/captive-portal = 坏/空云端绝不 wipe 本地；I5 = collection 可弃但不"意外丢"；C5 删除 tombstone 不复活。
import { test, eq, assert } from "./_harness.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal, type MockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createCollection, collectionLocalKey, type Collection } from "../src/store/collection.ts";
import type { CloudProvider, Kv } from "../src/store/types.ts";

interface Pos { pageIndex: number; yFraction: number }
const NAME = "reading-state.json";

// 一个"设备"：provider(云) + local(IDB) + kv(localStorage)。reload = 同 local+kv 新实例；换设备 = 全新 local+kv。
function dev(provider: CloudProvider, local: MockLocal, kv: Kv, t: number, online = true): Collection<Pos> {
  const cloud = createCloudSync({ provider, kv, fileName: (n) => n });
  return createCollection<Pos>({ cloud, name: NAME, local, now: () => t, syncDelayMs: 0, isOnline: () => online });
}

// ── 1. 离线可读：写位置→flushLocal→新实例离线 init→从本地 hydrate 出位置 ──
test("[cache] 离线可读：本地 hydrate", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  const A = dev(provider, local, kv, 1000);
  A.upsertItem({ id: "wei", pageIndex: 5, yFraction: 0.3 });
  await A.flushLocal();
  // reload：同 local+kv，但离线
  const B = dev(provider, local, kv, 2000, false);
  await B.init();
  eq(B.getItem("wei")?.pageIndex, 5, "离线也能从本地缓存读到上次位置");
});

// ── 2. 强杀 durability：只 flushLocal（没 cloud flush）→ 新实例仍读得到 ──
test("[cache] 强杀：仅本地落盘也存活", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  const A = dev(provider, local, kv, 1000);
  A.upsertItem({ id: "doc", pageIndex: 42, yFraction: 0.7 });
  await A.flushLocal();                       // 模拟卸载只落本地（云没推）
  const B = dev(provider, local, kv, 1100, false);
  await B.init();
  eq(B.getItem("doc")?.pageIndex, 42, "未推云的编辑靠本地缓存存活");
});

// ── 3. 旧设备旧缓存不盖新（A5，用户 85 的核心顾虑）──
test("[cache] 旧设备旧缓存(旧 uat)不覆盖云端新位置", async () => {
  const provider = createMockProvider();
  // 设备 A：page50 @uat=100 推上云
  const A = dev(provider, createMockLocal(), memKv(), 100);
  A.upsertItem({ id: "doc", pageIndex: 50, yFraction: 0.9 });
  await A.flush();
  // 设备 B：本地有旧缓存 page10 @uat=50（用一个早时钟的实例只写本地 seed）
  const localB = createMockLocal(); const kvB = memKv();
  const seedB = dev(provider, localB, kvB, 50, false);
  seedB.upsertItem({ id: "doc", pageIndex: 10, yFraction: 0.1 });
  await seedB.flushLocal();                   // 只写本地，不碰云
  // B 上线 init：hydrate 旧本地 + pull 云 → merge → 新 uat 胜
  const B = dev(provider, localB, kvB, 200);
  await B.init();
  eq(B.getItem("doc")?.pageIndex, 50, "旧本地缓存(uat50)绝不盖掉云端(uat100)");
});

// ── 3b. 反向：真正更新的离线编辑(新 uat)应胜过旧云端（单调前进，不是盲目 last-write）──
test("[cache] 真更新的离线编辑(新 uat)胜过旧云端", async () => {
  const provider = createMockProvider();
  const A = dev(provider, createMockLocal(), memKv(), 100);
  A.upsertItem({ id: "doc", pageIndex: 50, yFraction: 0.9 });
  await A.flush();                            // 云端 page50 @uat100
  // 设备 C：离线时把它读到 page99 @uat300（比云端新）
  const localC = createMockLocal(); const kvC = memKv();
  const seedC = dev(provider, localC, kvC, 300, false);
  seedC.upsertItem({ id: "doc", pageIndex: 99, yFraction: 0.5 });
  await seedC.flushLocal();
  const C = dev(provider, localC, kvC, 400);
  await C.init();
  eq(C.getItem("doc")?.pageIndex, 99, "真更新的本地编辑胜过旧云端(forward-only)");
});

// ── 4. 坏/空云端绝不 wipe 本地（A2 / captive-portal）──
test("[cache] 云端坏字节绝不 wipe 本地缓存", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  const A = dev(provider, local, kv, 1000);
  A.upsertItem({ id: "doc", pageIndex: 7, yFraction: 0.2 });
  await A.flushLocal();
  // 云端被 captive-portal HTML 占据（非法 JSON）
  await provider.upload(NAME, new TextEncoder().encode("<html>login</html>"), { conflictBehavior: "replace" });
  const B = dev(provider, local, kv, 1100);   // 在线，但 pull 到垃圾
  await B.init();
  eq(B.getItem("doc")?.pageIndex, 7, "坏云端 parse 失败 → 本地缓存保留，不被清空");
});

// ── 5. 坏本地缓存不崩，回退到云端 ──
test("[cache] 本地缓存损坏不崩 + 回退云端", async () => {
  const provider = createMockProvider();
  // 云端有合法 page8
  const seed = dev(provider, createMockLocal(), memKv(), 100);
  seed.upsertItem({ id: "doc", pageIndex: 8, yFraction: 0.4 });
  await seed.flush();
  // 设备本地缓存被写坏
  const local = createMockLocal(); const kv = memKv();
  await local.save(collectionLocalKey(NAME), new TextEncoder().encode("{not json"));
  const B = dev(provider, local, kv, 200);
  await B.init();                              // hydrate 失败应被吞 → 仍能 pull 云端
  eq(B.getItem("doc")?.pageIndex, 8, "坏本地缓存被忽略，回退云端");
});

// ── 6. 笔刷大 payload（88：textureB64 可上百 KB）round-trip ──
test("[cache] 笔刷大 payload 本地缓存 round-trip", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  const big = "x".repeat(200 * 1024);          // ~200KB base64 纹理替身
  const A = createCollection<{ textureB64: string }>({ cloud: createCloudSync({ provider, kv, fileName: (n) => n }), name: "rack", local, now: () => 1, syncDelayMs: 0 });
  A.upsertItem({ id: "brush1", textureB64: big });
  await A.flushLocal();
  const cloudB = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
  const B = createCollection<{ textureB64: string }>({ cloud: cloudB, name: "rack", local, now: () => 2, isOnline: () => false });
  await B.init();
  eq(B.getItem("brush1")?.textureB64.length, big.length, "大 payload 完整经 IDB 缓存回来");
});

// ── 7. 删除 tombstone 跨 reload 不复活（C5）──
test("[cache] 删除 tombstone 跨 reload 不复活", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  const A = dev(provider, local, kv, 1000);
  A.upsertItem({ id: "a", pageIndex: 1, yFraction: 0 });
  await A.flush();
  A.deleteItem("a");                            // tombstone @uat 1000
  await A.flushLocal();
  const B = dev(provider, local, kv, 1100, false);
  await B.init();
  eq(B.getItem("a"), undefined, "删除经 tombstone 持久，reload 后不复活");
});

// ── 8. dirty 标志跨 reload 持久（不静默丢未推编辑）──
test("[cache] dirty 跨 reload 持久 → 下次能推", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  // manual 模式：upsert 只标脏不自动推
  const cloud = createCloudSync({ provider, kv, fileName: (n) => n });
  const A = createCollection<Pos>({ cloud, name: NAME, local, now: () => 1000, manual: true });
  A.upsertItem({ id: "doc", pageIndex: 3, yFraction: 0.1 });
  await A.flushLocal();                         // 只本地，未推云
  // reload：同 kv → dirty 仍 true
  const cloudB = createCloudSync({ provider, kv, fileName: (n) => n });
  const B = createCollection<Pos>({ cloud: cloudB, name: NAME, local, now: () => 1100, manual: true });
  assert(B.isDirty(), "reload 后 dirty 仍为 true（kv 持久）");
  await B.init();
  eq(B.getItem("doc")?.pageIndex, 3, "数据也在本地");
});

// ── 9. init etag-skip 快路径（clean ∧ 云端 etag 没变 → 不重 pull，秒开；用户 #1 提的优化）──
test("[cache] init etag-skip：clean ∧ 云端没变 → 跳过 pull（秒开）", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  const A = dev(provider, local, kv, 100);
  A.upsertItem({ id: "wei", pageIndex: 7, yFraction: 0.5 });
  await A.flush();                              // 云端有数据 + kv 存 etag
  const cloud = createCloudSync({ provider, kv, fileName: (n) => n });
  let pulls = 0; const orig = cloud.pull.bind(cloud);
  (cloud as unknown as { pull: typeof cloud.pull }).pull = (n: string) => { pulls++; return orig(n); };
  const B = createCollection<Pos>({ cloud, name: NAME, local, now: () => 200, syncDelayMs: 0 });
  await B.init();
  eq(pulls, 0, "etag 没变 → 没重新 pull（走快路径）");
  eq(B.getItem("wei")?.pageIndex, 7, "仍从本地 hydrate 读到");
});

// ── 10. 云端 etag 变了 → 仍 pull（快路径不误跳，freshness 不破）──
test("[cache] init：云端 etag 变了 → 仍 pull 到新位置（freshness 不破）", async () => {
  const provider = createMockProvider();
  const local = createMockLocal(); const kv = memKv();
  const A = dev(provider, local, kv, 100);
  A.upsertItem({ id: "wei", pageIndex: 7, yFraction: 0.5 }); await A.flush();
  const C = dev(provider, createMockLocal(), memKv(), 300);   // 另一设备改云端 → etag 变
  await C.init(); C.upsertItem({ id: "wei", pageIndex: 99, yFraction: 0.1 }); await C.flush();
  const B = dev(provider, local, kv, 400);                    // reload B：本地+kv 是 A 的旧 etag
  await B.init();
  eq(B.getItem("wei")?.pageIndex, 99, "云端变了 → pull 到新位置（快路径只在 etag 相同才跳）");
});
