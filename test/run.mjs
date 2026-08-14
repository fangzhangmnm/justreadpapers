// 测试入口:node test/run.mjs(node 24 strip-types 直跑导入的 .ts)。
// 加新测试文件:在下面 import 一行即可。
// 引擎测试已随库走（@internal/store 仓 npm test，297 件）——这里只剩 app 域。
import "./valuable-save.test.ts";
import "./viewer-geometry.test.ts";
import "./catalog.test.ts";
import "./catalog-v1-migration.test.ts";
import "./gallery-model.test.ts";
import { run } from "./_harness.ts";

await run();
