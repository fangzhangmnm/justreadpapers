import { test, eq, assert } from "./_harness.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createCollection, type Collection } from "../src/store/collection.ts";
import type { CloudProvider } from "../src/store/types.ts";

interface Pos { pageIndex: number; yFraction: number }

function mk(provider: CloudProvider, clock: { t: number }): Collection<Pos> {
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
  return createCollection<Pos>({ cloud, name: "reading-state.json", now: () => clock.t, syncDelayMs: 0 });
}

test("upsertItem + getItem + items + keys", async () => {
  const c = mk(createMockProvider(), { t: 1000 });
  c.upsertItem({ id: "a", pageIndex: 3, yFraction: 0.1 });
  c.upsertItem({ id: "b", pageIndex: 7, yFraction: 0.5 });
  eq(c.items().length, 2, "两条");
  eq(c.getItem("a")?.pageIndex, 3, "a 页");
  eq(c.keys().sort().join(","), "a,b", "keys");
  await c.flush();
});

test("upsertItem 整条原子替换(无 partial)", async () => {
  const c = mk(createMockProvider(), { t: 1000 });
  c.upsertItem({ id: "a", pageIndex: 3, yFraction: 0.1 });
  c.upsertItem({ id: "a", pageIndex: 9, yFraction: 0.9 });
  eq(c.items().length, 1, "仍一条");
  eq(c.getItem("a")?.pageIndex, 9, "替换为新值");
  await c.flush();
});

test("deleteItem 移除", async () => {
  const c = mk(createMockProvider(), { t: 1000 });
  c.upsertItem({ id: "a", pageIndex: 3, yFraction: 0.1 });
  c.deleteItem("a");
  eq(c.items().length, 0, "删后空");
  eq(c.getItem("a"), undefined, "getItem undefined");
  await c.flush();
});

test("upsertItem 无 id 抛错", () => {
  const c = mk(createMockProvider(), { t: 1000 });
  let threw = false;
  try { c.upsertItem({ pageIndex: 1, yFraction: 0 } as unknown as { id: string } & Pos); }
  catch { threw = true; }
  assert(threw, "无 id 必须抛");
});

test("uat 内部盖戳(对外不暴露) + 跨 tab round-trip", async () => {
  const provider = createMockProvider();
  const A = mk(provider, { t: 1000 });
  A.upsertItem({ id: "wei", pageIndex: 6, yFraction: 0.38 });
  await A.flush();
  assert(!("uat" in (A.getItem("wei") as object)), "对外 item 不含 uat");

  const B = mk(provider, { t: 5000 });
  await B.init();
  eq(B.getItem("wei")?.pageIndex, 6, "B 读到 A 推的");
  assert(Math.abs((B.getItem("wei")?.yFraction ?? -1) - 0.38) < 1e-9, "yFraction round-trip");
});
