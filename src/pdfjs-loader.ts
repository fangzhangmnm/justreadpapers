// 运行时动态加载 vendored pdf.js —— **不进 esbuild bundle**(pdf.mjs ~4MB)。
// 串行铁律:pdf.mjs 的副作用(globalThis.pdfjsLib=…)必须在 pdf_viewer.mjs evaluate 前完成,
// 否则后者顶层 `} = globalThis.pdfjsLib` destructure undefined → "Cannot destructure 'AbortException'"。
// 路径相对 bundle(../vendor/pdfjs/,部署在 / 与 /dev/ 子路径都对;动态 import 拼接 → esbuild 留为运行时)。
// pdf.js 无 vendored 类型 → any(深契约不在这,在 viewer 组件的用法)。

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Pdfjs { pdfjsLib: any; ns: any; base: string; }

let cached: Pdfjs | null = null;

export function pdfjsBase(): string {
  return new URL("../vendor/pdfjs/", import.meta.url).href;
}

export async function loadPdfjs(): Promise<Pdfjs> {
  if (cached) return cached;
  const base = pdfjsBase();
  const pdfjsLib: any = await import(/* @vite-ignore */ base + "pdf.mjs");
  const ns: any = await import(/* @vite-ignore */ base + "web/pdf_viewer.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = base + "pdf.worker.mjs";
  cached = { pdfjsLib, ns, base };
  return cached;
}
