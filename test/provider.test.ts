// provider 适配器契约测试：graphToCloudProvider 的 0 字节上传守卫（postmortem 2026-06-05 根因）。
//   Uint8Array.size===undefined → undefined<=4MB 为 false → 永远走分块 → while(0<undefined) 一块都不传
//   → 上传 0 字节占位还回 etag = 静默丢内容。守卫=接缝处强制 Uint8Array→Blob。
import { test, eq, assert } from "./_harness.ts";
import { graphToCloudProvider } from "../src/store/onedrive-provider.ts";

function fakeGraph(onUpload: (body: unknown) => void) {
  return {
    uploadFileToApproot: async (_path: string, body: Blob, _ct: string, _opts: unknown) => {
      onUpload(body);
      return { id: "id-1", name: "f", size: (body as Blob).size, eTag: "e1", lastModifiedDateTime: "t" };
    },
  } as unknown as Parameters<typeof graphToCloudProvider>[0];
}

test("[provider] upload Uint8Array → 强制转 Blob 且 size 正确（防 0 字节占位，postmortem 2026-06-05）", async () => {
  let received: unknown = null;
  const provider = graphToCloudProvider(fakeGraph((b) => { received = b; }));
  const item = await provider.upload("f", new Uint8Array([1, 2, 3, 4, 5]), {});
  assert(received instanceof Blob, "body 被转成 Blob（不是裸 Uint8Array → 避免 size===undefined→永远分块→0字节）");
  eq((received as Blob).size, 5, "Blob.size = 真实 5 字节（不是 0）");
  eq(item.size, 5, "回执 size 正确（不是 0 字节占位）");
});

test("[provider] upload 空 Uint8Array → Blob size 0（如实，不是 undefined 触发分块）", async () => {
  let received: unknown = null;
  const provider = graphToCloudProvider(fakeGraph((b) => { received = b; }));
  await provider.upload("f", new Uint8Array(0), {});
  assert(received instanceof Blob, "空字节也转 Blob");
  eq((received as Blob).size, 0, "size=0 是如实的空（走简单上传路径，不是 undefined→分块陷阱）");
});

test("[provider] upload 已是 Blob → 原样传（不二次包）", async () => {
  let received: unknown = null;
  const provider = graphToCloudProvider(fakeGraph((b) => { received = b; }));
  const blob = new Blob([new Uint8Array([9, 8, 7])]);
  await provider.upload("f", blob, {});
  assert(received === blob, "Blob 原样透传（不二次包成 Blob-of-Blob）");
});
