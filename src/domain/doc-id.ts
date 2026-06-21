// docId = 论文的稳定身份(catalog item 的 key)。spec:arxivId | 内容 hash。
// 选 docId 而非 path 的理由:扛改名/重传/跨设备 —— docId 不变 → 阅读位置永不脱链(catalog 存
// docId→当前 fileName 映射,改名只更新映射)。
//   - 本地上传 → 内容 hash(本文件 contentDocId)。
//   - arxiv 下载(留待重构后) → arxiv id(arxivDocId);多格式 URL 解析在 ingest/download 模块,不在这。
// 纯模块:只依赖 Web Crypto(node 24 + 浏览器都有 globalThis.crypto.subtle)。零 store/DOM。

const CONTENT_PREFIX = "c-";
const ARXIV_PREFIX = "arxiv-";
const CONTENT_HEX_LEN = 16;   // SHA-256 前 16 hex(64-bit):个人库规模碰撞概率远低于中奖

/** SHA-256 内容指纹 → "c-"+前 16 hex。同字节恒得同 id(确定性),用于本地上传的论文身份。 */
export async function contentDocId(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // 拷进独立 ArrayBuffer,避免 SharedArrayBuffer / 偏移视图喂给 subtle.digest 的边界坑。
  const copy = view.slice();
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const hex = bytesToHex(new Uint8Array(digest));
  return CONTENT_PREFIX + hex.slice(0, CONTENT_HEX_LEN);
}

/** 规范 arxiv id → "arxiv-<canonical>"。canonical 只做 id 规范化(去版本 vN、老式分类 / → -),
 *  不做 URL 解析(那是 download 模块的多格式匹配)。 */
export function arxivDocId(canonicalArxivId: string): string {
  return ARXIV_PREFIX + canonicalArxivId.replace(/\//g, "-");
}

/** 判别:这个 docId 是内容 hash 还是 arxiv 来源(UI/迁移可能要分)。 */
export function docIdKind(docId: string): "content" | "arxiv" | "unknown" {
  if (docId.startsWith(CONTENT_PREFIX)) return "content";
  if (docId.startsWith(ARXIV_PREFIX)) return "arxiv";
  return "unknown";
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
