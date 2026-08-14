import { test, eq, assert } from "./_harness.ts";
import { createStore } from "@internal/store";
import type { Store, StoreUI, Kv, LocalCache } from "@internal/store";
import { createMockProvider, createMockLocal } from "@internal/store/testing";
import { createCatalog } from "../src/persistence/catalog.ts";
import type { Catalog } from "../src/persistence/catalog.ts";

// catalog 坐在 @internal/store 的 collection(manual) 上——测试组**真 store**（mock provider/local/memKv 注入，
// skipMigration：node 无 localStorage），collection 合并/持久化语义全真。clock 只喂 catalog.now(lastReadAt)。

function memKv(): Kv {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => { m.set(k, v); }, remove: (k) => { m.delete(k); } };
}
const ui: StoreUI = { busy: async (_l, fn) => fn(), reportError: () => { /* 测试静默 */ }, resolveConflict: async () => "cancel" };

function mkStore(provider: ReturnType<typeof createMockProvider>): Store {
  return createStore({
    provider, ui, appId: "jrptest", kv: memKv(), local: createMockLocal() as unknown as LocalCache,
    validateAdopt: () => true, signedIn: () => true, skipMigration: true,
  });
}
function mk(provider: ReturnType<typeof createMockProvider>, clock: { t: number }): Catalog {
  const collection = mkStore(provider).collection("catalog", { manual: true });
  return createCatalog({ collection, now: () => clock.t });
}

test("upsert + list 按 lastReadAt 倒序 + lastActive 派生", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  await cat.init();
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  clock.t = 2000;
  cat.upsert("c-bbb", { fileName: "B.pdf" });
  const list = cat.list();
  eq(list.length, 2, "两篇");
  eq(list[0].id, "c-bbb", "recency 倒序最近在前");
  eq(cat.lastActiveId(), "c-bbb", "lastActive = max lastReadAt");
  await cat.commitNow();
});

test("setPosition 存页+yFraction", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  await cat.init();
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  cat.setPosition("c-aaa", { pageIndex: 6, yFraction: 0.38 });
  eq(cat.get("c-aaa")?.position?.pageIndex, 6, "页");
  assert(Math.abs((cat.get("c-aaa")?.position?.yFraction ?? -1) - 0.38) < 1e-9, "yFraction");
  await cat.commitNow();
});

test("trash 软删 + restore", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  await cat.init();
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  clock.t = 1100; cat.trash("c-aaa");
  eq(cat.list().length, 0, "list 不含 trashed");
  eq(cat.listTrash().length, 1, "listTrash 含");
  clock.t = 1200; cat.restore("c-aaa");
  eq(cat.list().length, 1, "restore 回来");
  await cat.commitNow();
});

test("touch bump recency → 成为 lastActive", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  await cat.init();
  cat.upsert("c-aaa", { fileName: "A.pdf" });
  clock.t = 2000; cat.upsert("c-bbb", { fileName: "B.pdf" });
  eq(cat.lastActiveId(), "c-bbb", "B 最近");
  clock.t = 3000; cat.touch("c-aaa");
  eq(cat.lastActiveId(), "c-aaa", "touch 后 A 最近");
  await cat.commitNow();
});

test("rekey 迁移条目：新 path-key 承接 position，老 key 消失（②太监砍后 in-app 改名不丢位置）", async () => {
  const clock = { t: 1000 };
  const cat = mk(createMockProvider(), clock);
  await cat.init();
  cat.upsert("old.pdf", { fileName: "old.pdf", title: "T" });
  cat.setPosition("old.pdf", { pageIndex: 9, yFraction: 0.5 });
  clock.t = 2000; cat.rekey("old.pdf", "组合/new.pdf");
  eq(cat.get("old.pdf"), undefined, "老 key 没了");
  const moved = cat.get("组合/new.pdf");
  assert(moved !== undefined, "新 key 存在");
  eq(moved!.fileName, "组合/new.pdf", "fileName = 新 path");
  eq(moved!.title, "T", "title 承接");
  eq(moved!.position?.pageIndex, 9, "position 承接（位置不丢）");
  eq(cat.list().length, 1, "list 只剩迁移后一条");
  cat.rekey("组合/new.pdf", "组合/new.pdf");   // 同名 no-op
  eq(cat.get("组合/new.pdf")?.position?.pageIndex, 9, "同名 rekey no-op 不损坏");
  await cat.commitNow();
});

test("持久化 round-trip：A commitNow → B init 读回(真 collection+mock cloud)", async () => {
  const provider = createMockProvider();
  const A = mk(provider, { t: 1000 });
  await A.init();
  A.upsert("c-wei", { fileName: "Wei 2011.pdf", title: "AKLT" });
  A.setPosition("c-wei", { pageIndex: 6, yFraction: 0.38 });
  await A.commitNow();

  const B = mk(provider, { t: 5000 });
  await B.init();
  await B.commitNow();   // manual collection：init 本地即回，云端帧经 reconcile——显式对齐后再读
  const doc = B.get("c-wei");
  assert(doc !== undefined, "B 读到 A 推的 doc");
  eq(doc!.fileName, "Wei 2011.pdf", "fileName round-trip");
  eq(doc!.title, "AKLT", "title round-trip");
  eq(doc!.position?.pageIndex, 6, "position.pageIndex round-trip");
  assert(Math.abs((doc!.position?.yFraction ?? -1) - 0.38) < 1e-9, "position.yFraction round-trip");
});

test("非 payload 条目（迁移 marker）被读面过滤，不混进论文列表", async () => {
  const clock = { t: 1000 };
  const provider = createMockProvider();
  const store = mkStore(provider);
  const coll = store.collection("catalog", { manual: true });
  const cat = createCatalog({ collection: coll, now: () => clock.t });
  await cat.init();
  coll.setItem("__v1migrated", { at: 123 });   // 无 fileName → 非论文
  cat.upsert("a.pdf", { fileName: "a.pdf" });
  eq(cat.list().length, 1, "list 只有真论文");
  eq(cat.lastActiveId(), "a.pdf", "lastActive 不会是 marker");
  eq(cat.get("__v1migrated"), undefined, "get 也不认 marker");
});
