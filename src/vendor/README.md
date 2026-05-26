# vendor/

第三方 JS 库整包 vendor 进来,**不走 CDN**。

理由:
- 旅馆 / 飞机 / 公司限速代理网拉不动 CDN 时,app 仍然能用
- Edge 的 "Tracking Prevention" 会拦截某些跨源 storage 访问(对 SW 缓存跨源 CDN 资源尤其不友好)
- PWA 主屏冷启动时网络不一定立刻有
- 同源 = SW 一次 precache 完一劳永逸,不用维护"哪些 CDN 域名走 cache-first"白名单

体积代价 ≈ **4.4 MB**(pdfjs ~4.1 + msal ~0.3),可接受。

## 子目录

### `pdfjs/`

[`pdfjs-dist@4.10.38`](https://www.npmjs.com/package/pdfjs-dist),Mozilla 的 PDF 渲染器。

| 文件 | 说明 |
|---|---|
| `pdf.mjs` | 主库 ESM(用 `pdf.min.mjs` 重命名) |
| `pdf.worker.mjs` | Worker 入口(用 `pdf.worker.min.mjs` 重命名) |
| `web/pdf_viewer.mjs` | 高层 viewer 组件(`PDFViewer` / `EventBus` / `PDFLinkService`) |
| `web/pdf_viewer.css` | viewer 样式 |
| `web/images/` | viewer UI 用到的小图标(loading 之类) |
| `cmaps/` | 中日韩 PDF 字符映射表(`.bcmap`),非 ASCII PDF 必需 |
| `standard_fonts/` | PDF 标准字体替代品(Foxit + Liberation),PDF 没嵌字体时用 |

代码里通过 `new URL("./vendor/pdfjs/", import.meta.url)` 算绝对路径加载,
见 [src/viewer.js](../viewer.js) + [src/app.js](../app.js) 的 `deriveFileName`。

⚠ pdf.js v4 的 `pdf_viewer.mjs` **只 export** `EventBus / PDFLinkService / PDFViewer`,
**没有** `PDFThumbnailViewer` / `PDFRenderingQueue`(见 docs/01-pdfjs-gotchas.md 坑 2)。
缩略图概览是自己 roll 的,见 docs/08-thumbnail-overview-diy.md。

### `msal/`

[`@azure/msal-browser@3.27.0`](https://www.npmjs.com/package/@azure/msal-browser),Microsoft 登录库。

| 文件 | 说明 |
|---|---|
| `msal-browser.min.js` | 全部(UMD bundle,挂 `window.msal`) |

通过 `<script src="...">` 注入,见 [src/auth.js](../auth.js)。

## 更新流程

1. 改对应文件里的 `*_VERSION` 常量(`src/viewer.js` 的 `PDFJS_VERSION` / `src/auth.js` 的 `MSAL_VERSION`)
2. 下 tarball:`curl -sL https://registry.npmjs.org/<pkg>/-/<pkg>-<ver>.tgz -o /tmp/x.tgz`
3. 解 + 把对应文件 cp 进来(略过 `.map` sourcemap 和 `.d.ts/.d.mts` 类型声明)
4. 用 `.min.mjs` / `.min.js` 重命名成 `.mjs` / `.js`(省体积)
5. 更新 `service-worker.js` 的 `PRECACHE_URLS`(如果加 / 删了文件)+ bump `CACHE_VERSION`
6. 本地 `python3 -m http.server` 验一遍 PDF 打开 / 登录都还行
7. commit + push

## 为什么不用 jsdelivr / unpkg?

跨源 CDN 在 PWA SW + Edge 隐私保护下偶尔抓不到,导致离线模式打不开 PDF / 登不上。
整包 vendor 同源,SW 一次 precache 完一劳永逸。

之前 SW 有专门的 `CDN_DOMAINS` 白名单走 cache-first lazy populate,vendor 后整个删掉,
SW 只剩同源 cache-first 一套逻辑,简单很多。
