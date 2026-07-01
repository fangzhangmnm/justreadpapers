import { test, eq } from "./_harness.ts";
import { pathFolder, pathBasename, pathJoin, buildItems, sliceFolder, breadcrumb } from "../src/gallery-model.ts";
import type { CatalogMeta } from "../src/gallery-model.ts";
import type { SyncState } from "../src/store/index.ts";

const f = (name: string, syncState: SyncState = "synced") => ({ name, path: "papers/" + name, syncState });

test("path 代数", () => {
  eq(pathFolder("组合/x.pdf"), "组合", "有夹");
  eq(pathFolder("x.pdf"), "", "根");
  eq(pathBasename("组合/x.pdf"), "x.pdf", "basename");
  eq(pathJoin("组合", "x.pdf"), "组合/x.pdf", "join");
  eq(pathJoin("", "x.pdf"), "x.pdf", "join 根");
});

test("buildItems:catalog 标题/docId 按相对路径配;无 catalog → basename 去 .pdf", () => {
  const cat = new Map<string, CatalogMeta>([["Wei 2011.pdf", { docId: "c-1", name: "Wei 2011.pdf", title: "AKLT" }]]);
  const items = buildItems([f("Wei 2011.pdf"), f("组合/B.pdf")], cat);
  eq(items[0].title, "AKLT", "catalog 标题");
  eq(items[0].docId, "c-1", "docId");
  eq(items[1].title, "B", "无 catalog → basename 去 .pdf");
  eq(items[1].docId, undefined, "无 docId");
});

test("sliceFolder 根层:immediate 子夹 + 直属文件", () => {
  const items = buildItems([f("A.pdf"), f("组合/B.pdf"), f("组合/sub/C.pdf")], new Map());
  const r = sliceFolder(items, ["组合", "组合/sub"], "");
  eq(JSON.stringify(r.subfolders), JSON.stringify(["组合"]), "根只见 immediate 子夹");
  eq(r.files.length, 1, "根直属 1 文件");
  eq(r.files[0].name, "A.pdf", "是 A.pdf");
});

test("sliceFolder 进子夹:见 sub + 直属 B", () => {
  const items = buildItems([f("A.pdf"), f("组合/B.pdf"), f("组合/sub/C.pdf")], new Map());
  const r = sliceFolder(items, ["组合", "组合/sub"], "组合");
  eq(JSON.stringify(r.subfolders), JSON.stringify(["sub"]), "组合 下见 sub");
  eq(r.files.length, 1, "组合 直属 1 文件");
  eq(r.files[0].name, "组合/B.pdf", "是 B");
});

test("sliceFolder 空夹靠 cloudFolders 单一真相源", () => {
  const r = sliceFolder([], ["空夹"], "");
  eq(JSON.stringify(r.subfolders), JSON.stringify(["空夹"]), "无文件也显示空夹");
});

test("sliceFolder 文件按标题字母序", () => {
  const items = buildItems([f("b.pdf"), f("a.pdf")], new Map());
  const r = sliceFolder(items, [], "");
  eq(r.files.map((x) => x.title).join(","), "a,b", "标题升序");
});

test("breadcrumb 逐级", () => {
  eq(JSON.stringify(breadcrumb("")), "[]", "根无面包屑");
  eq(JSON.stringify(breadcrumb("组合/sub")),
    JSON.stringify([{ name: "组合", path: "组合" }, { name: "sub", path: "组合/sub" }]), "逐级");
});
