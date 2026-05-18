# justreadpapers

> 输入 URL → 立刻回到上次那篇论文的那一页。

**🔗 https://fangzhangmnm.github.io/justreadpapers/**

PDF 论文阅读 PWA。OneDrive `approot` 沙盒做存储,session.json 是唯一 asset,PDF 是可丢弃 cache。

## 当前 MVP 状态

- ✅ MSAL 登录 + OneDrive AppFolder
- ✅ pdf.js 全屏 viewer + reading-line 25% 锚位置恢复
- ✅ per-doc 位置 + lastActive (session.json)
- ✅ 本地 PDF 上传 (auto-rename = PDF metadata Title,fallback 文件名)
- ✅ 文件面板 (改名 / 日期·名称排序 / 移到垃圾箱 / 还原 / 永久删除 / 清空)
- ✅ IndexedDB LRU 缓存 (1GB cap)
- ✅ PWA manifest + service worker (cache-first,新版本 toast)
- ✅ window focus reconcile (检测远端 session 变化,弹"同步"提示)
- ✅ idle overlay (30min)
- ⏸ arxiv 摄入 (延后,要 Cloudflare Worker proxy 才行)

## 配置需要做的两步

### 1. Azure App Registration

在 https://entra.microsoft.com → **App registrations → New registration**

| 字段 | 值 |
| ---- | -- |
| Name | `justreadpapers` |
| Supported account types | **Personal Microsoft accounts only** (或 *Accounts in any org directory + personal* 也行) |
| Redirect URI 平台 | **Single-page application (SPA)** |
| Redirect URI 值 | `https://fangzhangmnm.github.io/justreadpapers/` |

注册完之后:

1. **Overview** 页拿 **Application (client) ID** → 填到 `src/config.js` 里的 `CLIENT_ID`。
2. **Authentication** 页 → 「Single-page application」下,如果还要本地测试,把 `http://localhost:8000/` 也加进去 (跟你本地 `python -m http.server` 的端口一致)。
3. **API permissions** → 应该已经默认带 `User.Read`。点 **Add a permission → Microsoft Graph → Delegated**,加上:
   - `Files.ReadWrite.AppFolder`
   - `offline_access`

不需要 admin consent (个人账号自助授权)。

### 2. GitHub Pages

在 GitHub 新建 repo:

| 字段 | 值 |
| ---- | -- |
| Owner | `fangzhangmnm` |
| Repo name | `justreadpapers` |
| Visibility | **Public** (GH Pages 免费层要求) |

push 完之后:**Settings → Pages** → Source: **Deploy from a branch**,Branch: **main / `/` (root)**。等 1-2 分钟,`https://fangzhangmnm.github.io/justreadpapers/` 就活了。

## 本地跑

```bash
python -m http.server 8000
# 打开 http://localhost:8000/
```

记得把 `http://localhost:8000/` 加进 Azure 的 Redirect URI(同上)。

## 架构 (照搬 webxiaoheiwu)

```
index.html               主表面 (全屏 pdf viewer + 顶栏 + drawer + toasts)
manifest.webmanifest     PWA
service-worker.js        cache-first + 新版本 toast (同源 only)
icon.svg                 暖色 parchment 主题图标
src/
  config.js              CLIENT_ID 等常量
  auth.js                MSAL (silent token + probed-account)
  graph.js               OneDrive AppFolder wrapper (list/upload/rename/move/delete + JSON read/write w/ ETag)
  session.js             session.json: in-memory state + debounced PUT + If-Match conflict merge
  cache.js               IndexedDB LRU for PDF blobs
  viewer.js              pdf.js 全屏连续滚动 + reading-line {pageIndex, yFraction} restore
  app.js                 orchestrator: 启动序列 + UI 绑定 + ingestion + reconcile
  styles.css             warm parchment 主题
```

approot 布局:

```
/papers/             所有 PDF (文件名 = auto-rename 后的人类标题)
/trash/              软删除的 PDF
session.json         {lastActive, docs: {itemId: {position, addedAt}}}
```

## 跨设备位置恢复

- 位置 = **PDF 文档坐标** `{pageIndex, yFraction}`,**不是** viewport 像素。
- reading-line 钉死在 viewport 高度的 25% 处。把那一行视作"用户眼睛实际所在"。
- zoom / fit-mode 是**设备属性**,只存 `localStorage`,不进 session.json。

## TODO (later,不入 MVP)

- arxiv 摄入 (Cloudflare Worker CORS proxy + arxiv API metadata 抓取)
- 真正的 PNG / maskable icons (现在只有 SVG)
- text selection / 标注 (整块功能,可能独立成另一个 app)
- 显式 fit-width / fit-page 切换按钮

## arxiv 合规 (当 arxiv 摄入做了再启用)

- 用 `export.arxiv.org` 子域
- 描述性 User-Agent
- ≤ 每 3 秒 1 次 API call
- 页脚:`Thank you to arXiv for use of its open access interoperability.`
- 不 bulk download
- 不要叫自己 "arXiv" 什么的
