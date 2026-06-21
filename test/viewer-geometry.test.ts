import { test, eq, assert } from "./_harness.ts";
import {
  scrollTopForPosition, positionForScroll, cozyScale, spreadRows, pagesPerRow,
  type PageBox,
} from "../src/domain/viewer-geometry.ts";

// 3 页,各高 1000,tops 0/1000/2000;总高 3000。
const pages: PageBox[] = [
  { top: 0, height: 1000 },
  { top: 1000, height: 1000 },
  { top: 2000, height: 1000 },
];

test("位置 → scrollTop:reading-line 锚 0.25", () => {
  // page1 的 0.5 → docY 1500;scrollTop = 1500 - 0.25*800 = 1300
  eq(scrollTopForPosition(pages, { pageIndex: 1, yFraction: 0.5 }, 800, 0.25), 1300, "已知值");
});

test("位置 ↔ scrollTop round-trip", () => {
  const pos = { pageIndex: 2, yFraction: 0.3 };
  const st = scrollTopForPosition(pages, pos, 800, 0.25);
  const back = positionForScroll(pages, st, 800, 0.25);
  assert(back !== null, "应非 null");
  eq(back!.pageIndex, 2, "页 round-trip");
  assert(Math.abs(back!.yFraction - 0.3) < 1e-9, "fraction round-trip");
});

test("scrollTop clamp 到可滚范围", () => {
  // 末页底 yFraction 1 → docY 3000;raw = 3000-200=2800;maxScroll=3000-800=2200 → clamp 2200
  eq(scrollTopForPosition(pages, { pageIndex: 2, yFraction: 1 }, 800, 0.25), 2200, "clamp 末端");
  // 首页顶 → raw 负 → clamp 0
  eq(scrollTopForPosition(pages, { pageIndex: 0, yFraction: 0 }, 800, 0.25), 0, "clamp 0");
});

test("positionForScroll 全页高 0 → null(⚙ 防把文末写进 session)", () => {
  const dead: PageBox[] = [{ top: 0, height: 0 }, { top: 0, height: 0 }];
  eq(positionForScroll(dead, 0, 800, 0.25), null, "退化布局返 null");
  eq(positionForScroll([], 0, 800, 0.25), null, "空页返 null");
});

test("cozyScale:宽屏封顶 9in/页 + 预留滚动条", () => {
  // 8.5in 页(612pt)在宽屏:target=min(1980, 9*96)=864;natural=612*96/72=816;scale=864/816
  const s = cozyScale({ containerWidth: 2000, scrollbarWidth: 20, pageWidthPt: 612, pagesPerRow: 1 });
  assert(Math.abs(s - 864 / 816) < 1e-9, `宽屏 cozy=${s}`);
});

test("cozyScale:窄屏 fit 到可用宽(扣滚动条)", () => {
  // avail=480 < 9in cap → target=480;scale=480/816
  const s = cozyScale({ containerWidth: 500, scrollbarWidth: 20, pageWidthPt: 612, pagesPerRow: 1 });
  assert(Math.abs(s - 480 / 816) < 1e-9, `窄屏 cozy=${s}`);
});

test("🐞 双页修复:论文从第 1 页就成对 (1,2)(3,4)", () => {
  eq(JSON.stringify(spreadRows(5, "double")), JSON.stringify([[0, 1], [2, 3], [4]]), "paired from 0(默认)");
  eq(JSON.stringify(spreadRows(4, "double")), JSON.stringify([[0, 1], [2, 3]]), "偶数页");
});

test("spread:cover-alone 变体(书)+ 单页", () => {
  eq(JSON.stringify(spreadRows(5, "double", "cover-alone")), JSON.stringify([[0], [1, 2], [3, 4]]), "首页单独");
  eq(JSON.stringify(spreadRows(3, "single")), JSON.stringify([[0], [1], [2]]), "单页每行一");
  eq(JSON.stringify(spreadRows(0, "double")), JSON.stringify([]), "零页");
});

test("pagesPerRow", () => {
  eq(pagesPerRow("double"), 2, "双页 2");
  eq(pagesPerRow("single"), 1, "单页 1");
});
