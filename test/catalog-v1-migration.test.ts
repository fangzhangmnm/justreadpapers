import { test, eq, assert } from "./_harness.ts";
import { parseV1Catalog } from "../src/persistence/catalog-v1-migration.ts";

// 旧引擎 /catalog.json（v1 信封）→ 种子的纯解析器。语义 = v1 自己的合并规则结算：
// resetAt 水位线、同 id uat 大者胜、trash edit-wins。

const env = (o: object): string => JSON.stringify({ version: 1, items: [], trash: [], resetAt: 0, ...o });

test("v1 items 内联 payload → {id,value}，id/uat 剥掉", () => {
  const seeds = parseV1Catalog(env({ items: [{ id: "a.pdf", uat: 100, fileName: "a.pdf", title: "T", position: { pageIndex: 3, yFraction: 0.5 }, lastReadAt: 99 }] }));
  assert(seeds !== null, "解析成功");
  eq(seeds!.length, 1, "一条");
  eq(seeds![0].id, "a.pdf", "id");
  const v = seeds![0].value as Record<string, unknown>;
  eq(v.fileName, "a.pdf", "payload 搬运");
  eq(v.title, "T", "title 搬运");
  eq((v.position as { pageIndex: number }).pageIndex, 3, "position 搬运");
  eq(v.id, undefined, "信封字段 id 不进 value");
  eq(v.uat, undefined, "信封字段 uat 不进 value");
});

test("trash edit-wins：编辑更晚→留，删更晚→不迁", () => {
  const seeds = parseV1Catalog(env({
    items: [{ id: "keep.pdf", uat: 200, fileName: "keep.pdf" }, { id: "gone.pdf", uat: 100, fileName: "gone.pdf" }],
    trash: [{ id: "keep.pdf", uat: 150 }, { id: "gone.pdf", uat: 150 }],
  }));
  eq(seeds!.length, 1, "只剩编辑赢的");
  eq(seeds![0].id, "keep.pdf", "keep 活着");
});

test("resetAt 水位线：≤ resetAt 的一律丢", () => {
  const seeds = parseV1Catalog(env({
    resetAt: 100,
    items: [{ id: "old.pdf", uat: 100, fileName: "old.pdf" }, { id: "new.pdf", uat: 101, fileName: "new.pdf" }],
  }));
  eq(seeds!.length, 1, "水位线下的丢");
  eq(seeds![0].id, "new.pdf", "水位线上的留");
});

test("同 id 撞 → uat 大者胜", () => {
  const seeds = parseV1Catalog(env({
    items: [{ id: "x.pdf", uat: 100, fileName: "x.pdf", title: "旧" }, { id: "x.pdf", uat: 200, fileName: "x.pdf", title: "新" }],
  }));
  eq(seeds!.length, 1, "去重");
  eq((seeds![0].value as { title: string }).title, "新", "uat 大者胜");
});

test("损坏/非 v1 → null（保守不迁，绝不半截乱种）", () => {
  eq(parseV1Catalog("not json"), null, "坏 JSON");
  eq(parseV1Catalog("42"), null, "非对象");
  eq(parseV1Catalog(JSON.stringify({ version: 2, items: [] })), null, "不认识的版本");
});

test("缺 trash/resetAt 字段的宽容解析（旧文件字段可能缺省）", () => {
  const seeds = parseV1Catalog(JSON.stringify({ version: 1, items: [{ id: "a.pdf", uat: 1, fileName: "a.pdf" }] }));
  eq(seeds!.length, 1, "缺省字段不炸");
});
