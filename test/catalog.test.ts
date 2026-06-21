import { test, eq, assert } from "./_harness.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createCatalog, type Catalog } from "../src/persistence/catalog.ts";
import type { CloudProvider } from "../src/store/types.ts";

// 在一个(可共享的)mock provider 上造 catalog;clock 用闭包变量,测试自己推进。
function mk(provider: CloudProvider, clock: { t: number }): Catalog {
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
  return createCatalog({ cloud, name: "catalog.json", now: () => clock.t });
}

test("upsert + list 按 uat 倒序 + lastActive 派生", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  clock.t = 2000;
  cat.upsert("c-bbb", { fileName: "B.pdf" });
  const list = cat.list();
  eq(list.length, 2, "两篇");
  eq(list[0].id, "c-bbb", "uat 倒序最近在前");
  eq(cat.lastActiveId(), "c-bbb", "lastActive = max uat");
  await cat.commitNow();
});

test("setPosition 存页+yFraction", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  cat.setPosition("c-aaa", { pageIndex: 6, yFraction: 0.38 });
  eq(cat.get("c-aaa")?.position?.pageIndex, 6, "页");
  assert(Math.abs((cat.get("c-aaa")?.position?.yFraction ?? -1) - 0.38) < 1e-9, "yFraction");
  await cat.commitNow();
});

test("trash 软删 + restore", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  clock.t = 1100; cat.trash("c-aaa");
  eq(cat.list().length, 0, "list 不含 trashed");
  eq(cat.listTrash().length, 1, "listTrash 含");
  clock.t = 1200; cat.restore("c-aaa");
  eq(cat.list().length, 1, "restore 回来");
  await cat.commitNow();
});

test("touch bump uat → 成为 lastActive", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  clock.t = 2000; cat.upsert("c-bbb", { fileName: "B.pdf" });
  eq(cat.lastActiveId(), "c-bbb", "B 最近");
  clock.t = 3000; cat.touch("c-aaa");
  eq(cat.lastActiveId(), "c-aaa", "touch 后 A 最近");
  await cat.commitNow();
});

test("持久化 round-trip:A commitNow → B init 读回(真 folder-store+cloud-sync+mock)", async () => {
  const provider = createMockProvider();   // 共享云存储
  const A = mk(provider, { t: 1000 });
  A.upsert("c-wei", { fileName: "Wei 2011.pdf", title: "AKLT" });
  A.setPosition("c-wei", { pageIndex: 6, yFraction: 0.38 });
  await A.commitNow();

  const B = mk(provider, { t: 5000 });      // 另一个 tab:不同 kv,同一 provider
  await B.init();
  const doc = B.get("c-wei");
  assert(doc !== undefined, "B 读到 A 推的 doc");
  eq(doc!.fileName, "Wei 2011.pdf", "fileName round-trip");
  eq(doc!.title, "AKLT", "title round-trip");
  eq(doc!.position?.pageIndex, 6, "position.pageIndex round-trip");
  assert(Math.abs((doc!.position?.yFraction ?? -1) - 0.38) < 1e-9, "position.yFraction round-trip");
});
