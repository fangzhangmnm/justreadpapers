import { test, eq, assert } from "./_harness.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createCollection } from "../src/store/collection.ts";
import { createLocalSettings, createSyncedSettings, type SettingItem } from "../src/store/settings.ts";
import type { CloudProvider } from "../src/store/types.ts";

test("localSettings get/set/delete + 无 default", () => {
  const s = createLocalSettings(memKv());
  eq(s.get("theme"), undefined, "没设 → undefined");
  s.set("theme", "night");
  eq(s.get("theme"), "night", "set 后读回");
  s.set("zoom", 1.25);
  eq(s.get<number>("zoom"), 1.25, "数值 JSON round-trip");
  s.delete("theme");
  eq(s.get("theme"), undefined, "delete 后 undefined");
});

function syncBacked(provider: CloudProvider, clock: { t: number }) {
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
  const coll = createCollection<SettingItem>({ cloud, name: "settings.json", now: () => clock.t, syncDelayMs: 0 });
  return createSyncedSettings(coll);
}

test("syncedSettings 并发设不同 key 都不丢(per-key LWW) + 跨 tab", async () => {
  const provider = createMockProvider();
  const A = syncBacked(provider, { t: 1000 });
  const B = syncBacked(provider, { t: 1000 });
  await A.init(); await B.init();

  A.set("defaultZoom", 1.2);     // A 设一个 key
  B.set("defaultSpread", "odd"); // B 设另一个 key（并发）
  await A.flush();
  await B.flush();               // B 推时会 pull-merge-push，两 key 都活

  const C = syncBacked(provider, { t: 5000 });
  await C.init();
  eq(C.get<number>("defaultZoom"), 1.2, "A 的 key 在");
  eq(C.get<string>("defaultSpread"), "odd", "B 的 key 也在(没被 clobber)");
});

test("syncedSettings delete", async () => {
  const provider = createMockProvider();
  const A = syncBacked(provider, { t: 1000 });
  await A.init();
  A.set("x", 1);
  await A.flush();
  A.delete("x");
  await A.flush();
  const B = syncBacked(provider, { t: 5000 });
  await B.init();
  assert(B.get("x") === undefined, "delete 跨 tab 生效");
});
