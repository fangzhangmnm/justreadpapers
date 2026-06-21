import { test, eq, assert } from "./_harness.ts";
import { contentDocId, arxivDocId, docIdKind } from "../src/domain/doc-id.ts";

function bytes(s: string): Uint8Array { return new TextEncoder().encode(s); }

test("contentDocId 确定性:同字节恒得同 id", async () => {
  const a = await contentDocId(bytes("same pdf bytes"));
  const b = await contentDocId(bytes("same pdf bytes"));
  eq(a, b, "同内容同 id");
});

test("contentDocId 不同字节得不同 id", async () => {
  const a = await contentDocId(bytes("paper A"));
  const b = await contentDocId(bytes("paper B"));
  assert(a !== b, "不同内容不同 id");
});

test("contentDocId 接受 Uint8Array 与 ArrayBuffer 等价", async () => {
  const u = bytes("hello");
  const a = await contentDocId(u);
  const b = await contentDocId(u.buffer.slice(0));   // 独立 ArrayBuffer
  eq(a, b, "Uint8Array 与同内容 ArrayBuffer 同 id");
});

test("contentDocId 格式 = c- + 16 hex", async () => {
  const id = await contentDocId(bytes("x"));
  assert(/^c-[0-9a-f]{16}$/.test(id), `格式应为 c-<16hex>,实际 ${id}`);
  eq(docIdKind(id), "content", "判别为 content");
});

test("arxivDocId 规范化:老式分类 / → -", () => {
  eq(arxivDocId("1102.5064"), "arxiv-1102.5064", "新式 id");
  eq(arxivDocId("hep-th/9901001"), "arxiv-hep-th-9901001", "老式分类 / 转 -");
  eq(docIdKind("arxiv-1102.5064"), "arxiv", "判别为 arxiv");
});

test("docIdKind 未知前缀", () => {
  eq(docIdKind("/papers/foo.pdf"), "unknown", "path 不是合法 docId");
});
