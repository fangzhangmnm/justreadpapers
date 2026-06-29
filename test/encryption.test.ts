// 加密 wiring 对抗测试（mock CryptoCodec，不 vendor 真 7z）：验 create-store 的加密接线——
//   codec 注入 + crypt config + 透明封解 + verifyPassword + encrypt/decrypt at-rest 切换 + getPreview。
//   crypto-container 的 peek 用真 WebCrypto（globalThis.crypto.subtle）；7z/zip 用下面的内存 fake。
import { test, eq, assert } from "./_harness.ts";
import { createStore } from "../src/store/create-store.ts";
import { createMockProvider } from "../src/store/mock-provider.ts";
import { createMockLocal } from "../src/store/mock-local.ts";
import { memKv } from "../src/store/cloud-sync.ts";
import type { CryptoCodec } from "../src/store/crypto-container.ts";

const te = new TextEncoder(), td = new TextDecoder();
const enc = (s: string) => te.encode(s);
const ZIP = [0x50, 0x4b, 0x03, 0x04], SEVENZ = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
function u32(n: number): Uint8Array { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; }
function rU32(a: Uint8Array, o: number): number { return new DataView(a.buffer, a.byteOffset + o, 4).getUint32(0, true); }
function cat(arrs: Uint8Array[]): Uint8Array { const len = arrs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(len); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; }
const toU8 = (d: Uint8Array | string): Uint8Array => (typeof d === "string" ? te.encode(d) : d);
function packEntries(prefix: Uint8Array, entries: { path: string; data: Uint8Array | string }[]): Uint8Array {
  const datas = entries.map((e) => toU8(e.data));
  const header: Uint8Array[] = [prefix, u32(entries.length)];
  entries.forEach((e, i) => { const p = te.encode(e.path); header.push(u32(p.length), p, u32(datas[i].length)); });
  return cat([cat(header), ...datas]);   // 数据按序接在尾部 → 最后一个 entry(peek) 落在末尾 → PEEK_MAGIC 可尾扫
}
function unpackEntries(a: Uint8Array, dataStart: number): Record<string, Uint8Array> {
  let o = dataStart; const count = rU32(a, o); o += 4;
  const metas: { path: string; dl: number }[] = [];
  for (let i = 0; i < count; i++) { const pl = rU32(a, o); o += 4; const path = td.decode(a.slice(o, o + pl)); o += pl; const dl = rU32(a, o); o += 4; metas.push({ path, dl }); }
  const rec: Record<string, Uint8Array> = {};
  for (const m of metas) { rec[m.path] = a.slice(o, o + m.dl); o += m.dl; }
  return rec;
}
// 内存 fake codec：zip 以 PK 开头（unpackContainer 的 _startsWith(ZIP) 走外壳路径）、7z 以 7z magic 开头
//   （payload 通过 _startsWith(SEVENZ) 检），密码错 → WRONG_PASSWORD。够真实让 crypto-container 全路径跑通。
const fakeCodec: CryptoCodec = {
  zipPack: async (entries) => new Blob([packEntries(new Uint8Array(ZIP), entries) as BlobPart]),
  zipUnpack: async (blob) => { const a = new Uint8Array(await blob.arrayBuffer()); return unpackEntries(a, 4); },
  pack7z: async (entries, password) => cat([new Uint8Array(SEVENZ), u32(te.encode(password).length), te.encode(password), packEntries(new Uint8Array(0), entries)]),
  unpack7z: async (bytes, password) => {
    const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let o = 6; const pl = rU32(a, o); o += 4; const storedPw = td.decode(a.slice(o, o + pl)); o += pl;
    if (storedPw !== password) { const e = new Error("wrong pw") as Error & { code?: string }; e.code = "WRONG_PASSWORD"; throw e; }
    return unpackEntries(a, o);
  },
};

function mkStore(pw: string | null, makePeek?: (b: Blob) => Promise<Uint8Array | null>) {
  return createStore({
    provider: createMockProvider(), local: createMockLocal(), kv: memKv(),
    ui: { busy: (_l, fn) => fn() },
    crypto: fakeCodec,
    crypt: { ext: "pdf", getPassword: () => pw, makePeek },
  });
}
async function asStr(b: Blob | null): Promise<string | null> { return b ? td.decode(new Uint8Array(await b.arrayBuffer())) : null; }

test("[enc] encrypt → isEncrypted → open 透明解 → decrypt 往返（at-rest 切换）", async () => {
  const s = mkStore("hunter2");
  const f = s.file("papers/secret.pdf", { isZip: false });
  await f.save(enc("TOPSECRET"));
  assert(!(await f.isEncrypted()), "存时明文");
  const r = await f.encrypt();
  eq(r.status, "swapped", "加密成功");
  assert(await f.isEncrypted(), "现在是加密容器");
  eq(await asStr(await f.open()), "TOPSECRET", "open 透明解出明文");
  const d = await f.decrypt();
  eq(d.status, "swapped", "解除加密成功");
  assert(!(await f.isEncrypted()), "回到明文");
  eq(await asStr(await f.open()), "TOPSECRET", "明文仍读得回");
});

test("[enc] 无密码：open 加密文件 → null(locked)，save → 抛 LOCKED（绝不静默存明文）", async () => {
  const local = createMockLocal(), kv = memKv(), provider = createMockProvider();
  const A = createStore({ provider, local, kv, ui: { busy: (_l, fn) => fn() }, crypto: fakeCodec, crypt: { ext: "pdf", getPassword: () => "pw" } });
  const fa = A.file("x.pdf", { isZip: false });
  await fa.save(enc("DATA")); await fa.encrypt();
  // 同 local/kv/provider 的另一个 store，但无密码源（模拟未解锁的会话）：
  const B = createStore({ provider, local, kv, ui: { busy: (_l, fn) => fn() }, crypto: fakeCodec, crypt: { ext: "pdf", getPassword: () => null } });
  const fb = B.file("x.pdf", { isZip: false });
  eq(await fb.open(), null, "无密码 open 加密文件 → null(locked)，不弹窗");
  let lockedThrow = false;
  try { await fb.save(enc("NEWPLAIN")); } catch (e) { lockedThrow = (e as { code?: string } | null)?.code === "LOCKED"; }
  assert(lockedThrow, "无密码 save 加密文件 → 抛 LOCKED（绝不静默存明文）");
});

test("[enc] verifyPassword：对密码 true、错密码 false（解 peek，不碰 payload）", async () => {
  const s = mkStore("correct-horse", async () => enc("PEEKBYTES"));
  const f = s.file("b.pdf", { isZip: false });
  await f.save(enc("BODY")); await f.encrypt();
  assert(await f.verifyPassword("correct-horse"), "对密码 → true");
  assert(!(await f.verifyPassword("wrong")), "错密码 → false");
  assert(!(await f.verifyPassword("")), "空密码 → false");
});

test("[enc] getPreview：makePeek 写的 peek 读得回（ZipFile）", async () => {
  const s = mkStore("pw", async () => enc("THUMBNAIL"));
  const f = s.file("c.pdf", { isZip: false });
  await f.save(enc("BODY")); await f.encrypt();
  const z = s.file("c.pdf", { isZip: true });
  eq(await asStr(await z.getPreview()), "THUMBNAIL", "getPreview 解出 peek 字节");
});

test("[enc] 不注入 codec → dormant：明文文件正常，packContainer 不被触发", async () => {
  const s = createStore({ provider: createMockProvider(), local: createMockLocal(), kv: memKv(), ui: { busy: (_l, fn) => fn() } });   // 无 crypto/crypt
  const f = s.file("plain.pdf", { isZip: false });
  await f.save(enc("PLAIN"));
  assert(!(await f.isEncrypted()), "明文");
  eq(await asStr(await f.open()), "PLAIN", "明文正常读写（加密 dormant）");
});

test("[enc] looksEncrypted / verifyContainer / unsealWith（导入辅助）", async () => {
  const s = mkStore("imp-pw");
  const f = s.file("d.pdf", { isZip: false });
  await f.save(enc("IMPORTED")); await f.encrypt();
  const containerBlob = await s._internal.cloud.pull("d.pdf").then((p) => p?.blob ?? null);
  assert(!!containerBlob, "拿到云端加密容器");
  assert(await s.looksEncrypted(containerBlob!), "looksEncrypted → true");
  assert(await s.verifyContainer(containerBlob!, "imp-pw"), "对密码 verifyContainer → true");
  assert(!(await s.verifyContainer(containerBlob!, "nope")), "错密码 → false");
  eq(await asStr(await s.unsealWith(containerBlob!, "imp-pw")), "IMPORTED", "unsealWith 显式密码解出明文");
  eq(await s.unsealWith(containerBlob!, "nope"), null, "错密码 unsealWith → null");
});
