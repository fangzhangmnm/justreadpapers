// crypto-container 对抗测试（真 WebCrypto，无需 codec）：容器探测 false-cases（防误把明文锁死）
//   + peek 加解密 + 错密码 WRONG_PASSWORD + 空 peek 有效 + 尾扫定位。补 WebPaint 有、JRP 缺的覆盖。
import { test, eq, assert } from "./_harness.ts";
import { looksEncryptedContainer, encryptPeek, decryptPeek, scanEncPeekFromEnd } from "../src/store/crypto-container.ts";

const td = new TextDecoder();
const PK = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);          // 明文 zip（ora）头
const SEVENZ = new Uint8Array([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 9, 9]); // 裸 .7z 头
function cat(a: Uint8Array, b: Uint8Array): Uint8Array { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

test("[container] 探测 false-cases：明文 PK zip → false、垃圾字节 → false（绝不误把明文当容器锁死）", async () => {
  assert(!(await looksEncryptedContainer(PK)), "明文 PK zip（ora）→ false");
  assert(!(await looksEncryptedContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))), "随机垃圾字节 → false");
  assert(!(await looksEncryptedContainer(new Uint8Array(0))), "空字节 → false");
});

test("[container] 探测 true：裸 .7z magic → true；尾部带 peek → true", async () => {
  assert(await looksEncryptedContainer(SEVENZ), "裸 .7z magic → true");
  const peek = await encryptPeek(new TextEncoder().encode("THUMB"), "pw");   // 真 AES-GCM peek（含 PEEK_MAGIC）
  assert(await looksEncryptedContainer(cat(PK, peek)), "PK 外壳 + 尾部 peek → true（app 容器）");
});

test("[container] peek 加解密往返 + 错密码 WRONG_PASSWORD（GCM tag 即验证器）", async () => {
  const enc = await encryptPeek(new TextEncoder().encode("SECRET-THUMB"), "correct");
  const parsed = scanEncPeekFromEnd(enc);
  assert(!!parsed, "尾扫到 peek");
  eq(td.decode(await decryptPeek(parsed!, "correct")), "SECRET-THUMB", "对密码 → 解出原 peek");
  let code = "";
  try { await decryptPeek(parsed!, "wrong"); } catch (e) { code = (e as { code?: string }).code ?? ""; }
  eq(code, "WRONG_PASSWORD", "错密码 → throw code=WRONG_PASSWORD（不碰文件本体）");
});

test("[container] 空 peek 有效：encryptPeek(null) 仍可探测 + 解出空（探测标记不能省）", async () => {
  const enc = await encryptPeek(null, "pw");
  const parsed = scanEncPeekFromEnd(enc);
  assert(!!parsed, "空 peek 仍带 MAGIC，尾扫到（容器探测靠它）");
  eq((await decryptPeek(parsed!, "pw")).length, 0, "解出空字节");
});

test("[container] 尾扫定位：peek 前面有任意前缀也能从尾部命中", async () => {
  const enc = await encryptPeek(new TextEncoder().encode("X"), "pw");
  const prefixed = cat(new Uint8Array([0, 1, 2, 3, 0x9e, 0x57, 4, 5, 6]), enc);   // 含一个假 MAGIC 残片当干扰
  const parsed = scanEncPeekFromEnd(prefixed);
  assert(!!parsed, "从尾部反扫命中真 peek（跳过前面的假残片）");
  eq(td.decode(await decryptPeek(parsed!, "pw")), "X", "解出真 peek");
});
