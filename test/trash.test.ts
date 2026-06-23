import { test, eq, assert } from "./_harness.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead } from "../src/store/local-head.ts";
import { createTrash } from "../src/store/trash.ts";

const enc = (s: string) => new TextEncoder().encode(s);

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  return { cloud, local, head, ...createTrash({ cloud, local, head }) };
}

test("restore 本地：从 trashKey 恢复", async () => {
  const { local, restore } = rig();
  await local.save("f", enc("X"));
  const tk = await local.trash("f");
  const r = await restore({ trashKey: tk });
  eq(r.status, "restored", "恢复"); assert(r.local, "本地恢复");
  assert(await local.exists("f"), "文件回来");
});

test("purge：强制 danger confirm，确认 → 彻底删", async () => {
  const { local, purge } = rig();
  await local.save("f", enc("X")); const tk = await local.trash("f");
  eq((await purge({ trashKey: tk, confirm: () => false })).status, "cancelled", "拒绝 → 取消");
  eq((await purge({ trashKey: tk, confirm: () => true })).status, "purged", "确认 → 彻底删");
});

test("emptyTrash local：批量清空本地回收站", async () => {
  const { local, emptyTrash } = rig();
  await local.save("a", enc("1")); await local.trash("a");
  await local.save("b", enc("2")); await local.trash("b");
  const r = await emptyTrash({ scope: "local" });
  eq(r.status, "emptied", "清空");
  eq(r.purged, 2, "清了 2 个");
});
