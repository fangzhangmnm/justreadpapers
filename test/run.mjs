// 测试入口:node test/run.mjs(node 24 strip-types 直跑导入的 .ts)。
// 加新测试文件:在下面 import 一行即可。
import "./valuable-save.test.ts";
import "./doc-id.test.ts";
import "./viewer-geometry.test.ts";
import "./catalog.test.ts";
import "./local-head.test.ts";
import "./safe-resolve.test.ts";
import "./seal.test.ts";
import "./push.test.ts";
import "./freshness.test.ts";
import "./delete.test.ts";
import "./identity.test.ts";
import "./trash.test.ts";
import "./collection.test.ts";
import "./settings.test.ts";
import "./gallery-model.test.ts";
import { run } from "./_harness.ts";

await run();
