import { test, eq, assert } from "./_harness.ts";
import { createStore } from "../src/store/create-store.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { memKv } from "../src/store/cloud-sync.ts";
import type { CloudProvider } from "../src/store/types.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  if (x instanceof Blob) return await x.text();
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}
function mkStore(provider: CloudProvider) {
  return createStore({
    provider,
    ui: { busy: (_l, fn) => fn() },
    local: createMockLocal(),
    kv: memKv(),
    syncedSettingsFileName: "settings.json",
  });
}

test("file round-trip：A.save → 云端 → B.open 读回（脱绕，全走 createStore）", async () => {
  const provider = createMockProvider();           // 共享云
  const A = mkStore(provider);
  await A.file("papers/wei.pdf", { isZip: false }).save(enc("PDFBYTES"));
  const B = mkStore(provider);                      // 另一设备：空 local
  const blob = await B.file("papers/wei.pdf", { isZip: false }).open();
  eq(await asStr(blob), "PDFBYTES", "B 从云端拉回 A 存的");
});

test("file save 后本地干净（推成功清脏）", async () => {
  const s = mkStore(createMockProvider());
  const f = s.file("a.pdf", { isZip: false });
  await f.save(enc("X"));
  assert(!f.isDirty(), "推成功 → 干净");
});

test("collection 经 store", async () => {
  const s = mkStore(createMockProvider());
  const c = s.collection<{ pageIndex: number }>("reading.json");
  c.upsertItem({ id: "wei", pageIndex: 6 });
  await c.flush();
  eq(c.getItem("wei")?.pageIndex, 6, "collection 读写");
});

test("settings 经 store（local + synced）", () => {
  const s = mkStore(createMockProvider());
  s.localSettings.set("zoom", 1.5);
  eq(s.localSettings.get("zoom"), 1.5, "localSettings");
  assert(!!s.syncedSettings, "配了 fileName → syncedSettings 在");
});

test("RawFile 运行时无 setPreview / ZipFile 有", () => {
  const s = mkStore(createMockProvider());
  assert(!("setPreview" in s.file("a.pdf", { isZip: false })), "RawFile 无 setPreview");
  assert("setPreview" in s.file("a.ora", { isZip: true }), "ZipFile 有 setPreview");
});

test("keepOnOpen:false 过路 open：拉云返字节但不落本地（#5）", async () => {
  const provider = createMockProvider();
  await mkStore(provider).file("papers/wei.pdf", { isZip: false }).save(enc("PDFBYTES"));   // A 存云
  const localB = createMockLocal();
  const B = createStore({ provider, ui: { busy: (_l, fn) => fn() }, local: localB, kv: memKv(), keepOnOpen: false });
  const blob = await B.file("papers/wei.pdf", { isZip: false }).open();
  eq(await asStr(blob), "PDFBYTES", "过路也能读回云端字节");
  assert(!(await B.file("papers/wei.pdf", { isZip: false }).isKeptOffline()), "过路 open 不落本地（isKeptOffline=false）");
  eq(localB._items.size, 0, "本地 mock 仍空（没缓存）");
});

test("file.delete 经 store", async () => {
  const provider = createMockProvider();
  const s = mkStore(provider);
  const f = s.file("gone.pdf", { isZip: false });
  await f.save(enc("BYE"));
  await f.delete();
  const list = await s.list();
  assert(!list.some((it) => it.name === "gone.pdf"), "删后列表不含（进了 .trash）");
});
