import { test, eq, assert } from "./_harness.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { createCloudSync, memKv } from "../src/store/cloud-sync.ts";
import { createLocalHead } from "../src/store/local-head.ts";
import { createSafeResolve } from "../src/store/safe-resolve.ts";
import { createSubstrate } from "../src/store/substrate.ts";
import { createPush } from "../src/store/push.ts";
import { createIdentity } from "../src/store/identity.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  if (x instanceof Blob) return await x.text();
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}
const sealPass = { sealForWrite: async (_n: string, b: Uint8Array) => b, isContainer: async () => false };

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  const safeResolve = createSafeResolve({ cloud, local, head });
  const sub = createSubstrate();
  const { doPush } = createPush({ cloud, head, seal: sealPass, safeResolve, serialize: sub.serialize, editVersion: () => 0 });
  const id = createIdentity({ cloud, local, head, doPush, serialize: sub.serialize, serialize2: sub.serialize2 });
  return { cloud, local, head, ...id };
}

test("rename local-only：新名先存、旧名后删（phantom-path）", async () => {
  const { local, rename } = rig();
  await local.save("old.pdf", enc("DATA"));
  const r = await rename("old.pdf", "new.pdf", { cloud: false });
  eq(r.where, "local", "本地改名");
  assert(await local.exists("new.pdf"), "新名在");
  assert(!(await local.exists("old.pdf")), "旧名删");
  eq(await asStr(await local.get("new.pdf")), "DATA", "字节搬过去");
});

test("rename cloud synced → 服务端 move（etag 顺延）", async () => {
  const { cloud, local, head, rename } = rig();
  await cloud.push("old.pdf", enc("DATA")); await local.save("old.pdf", enc("DATA"));
  head.markSeen("old.pdf", cloud.getETag("old.pdf"));      // synced（不 dirty）
  const r = await rename("old.pdf", "new.pdf");
  eq(r.where, "cloud-move", "服务端 move");
  eq(await asStr((await cloud.pull("new.pdf"))?.blob), "DATA", "云端新名有字节");
});

test("saveAs：写新身份，云端有", async () => {
  const { cloud, saveAs } = rig();
  const r = await saveAs("copy.pdf", { encode: () => enc("COPY") });
  eq(r.where, "cloud", "推云端");
  eq(await asStr((await cloud.pull("copy.pdf"))?.blob), "COPY", "云端 copy");
});

test("acquire：云端 item → 本地 + adopt", async () => {
  const { cloud, local, acquire } = rig();
  await cloud.push("remote.pdf", enc("REMOTE"));
  let adopted: string | null = null;
  const r = await acquire("remote.pdf", { adopt: (_b, n) => { adopted = n; } });
  eq(r.status, "acquired", "拉取成功");
  eq(await asStr(await local.get("remote.pdf")), "REMOTE", "落本地");
  eq(adopted, "remote.pdf", "adopt 回调");
});
