// app 配置常量(从 ARCHIVE/config.js 搬,TS 化)。Azure 注册 / approot 布局 / 节流 / 锚点。
// ⚠ Azure redirect URI:旧注册只有 .../justreadpapers/ + localhost。**/dev/ 要能登录需在
//   entra.microsoft.com 给这个 clientId 加 redirect URI https://fangzhangmnm.github.io/justreadpapers/dev/**
//   (manual,等真要在 /dev/ 测 auth 时做)。

export const CLIENT_ID = "8b5063a4-6fd4-40d0-8973-fb6388a6db24";
export const AUTHORITY = "https://login.microsoftonline.com/common";
export const SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
export const MSAL_URL = "./vendor/msal/msal-browser.min.js";   // vendored,相对 baseURI(/ 与 /dev/ 都对)

// approot 内部布局
export const PAPERS_FOLDER = "papers";          // PDF 平铺于此
export const TRASH_FOLDER = "trash";
// catalog collection 名（@internal/store 云端落 `.justreadpapers/catalog.json`，库自动加 .json）。
// 旧引擎的 approot /catalog.json 是迁移源（见 persistence/catalog-v1-migration.ts）——只读不改不删，可回捞。
// （更旧的 session.json 是内容哈希 docId 时代,身份变了无法迁,继续不碰。）
export const CATALOG_NAME = "catalog";
export const OLD_CATALOG_PATH = "catalog.json";   // 旧引擎 catalog 云端落点（v1 信封）
export const APP_ID = "justreadpapers";           // store 命名空间（同 origin 兄弟 PWA 隔离红线）
export const SETTINGS_NAME = "local-settings";    // 设备本地设置 collection（local-only 不上云）。旧 localStorage settings:* 键孤儿化不迁（低价值，重置）

// valuable-save 节流("有价值的保存"理论)
export const POSITION_DEBOUNCE_MS = 10_000;
export const POSITION_CEILING_MS = 30_000;
export const TRIVIAL_Y_DELTA = 0.5;             // 同页 + |yΔ|<0.5 = trivial(吃 fidget)

// 阅读
export const READING_LINE_ANCHOR = 0.25;        // reading-line 在 viewport 内固定锚位
export const PDF_CACHE_CAP_BYTES = 250 * 1024 * 1024;

// build 版本号 = bundle content-hash(每次 build 必变),从本模块运行时 URL(已被 esbuild 打成
// 单 jrp-<hash>.mjs)抠出。给 ☰ 菜单显示,让人肉眼确认"这次推送的新版到了没"。
export const BUILD_ID = (() => {
  try { const m = String(import.meta.url).match(/jrp-([0-9a-f]+)\.mjs/i); return m ? m[1] : "dev"; }
  catch { return "dev"; }
})();
