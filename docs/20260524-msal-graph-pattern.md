# MSAL + Microsoft Graph AppFolder

## 为什么 AppFolder

`/me/drive/special/approot` 是 Microsoft 的"沙盒目录":
- 自动在用户 OneDrive 里建 `Apps/<AppDisplayName>/`
- 我们只能访问这个文件夹,**token 即使泄漏也碰不到用户其它 OneDrive 文件**
- 单 scope `Files.ReadWrite.AppFolder` 就够,不用 `Files.ReadWrite.All`(后者要 admin consent / 权限过大)

Display name 决定文件夹名。比如 Azure 注册 display name = `JustReadPapers`,OneDrive 网页里就看到 `Apps/JustReadPapers/`。代码里用 `/me/drive/special/approot` 这个 alias 路径,跟 display name 无关。

## Azure 注册要点

1. **Single-page application (SPA)** 平台,不是 Web,不是 Public client。SPA 走 Auth Code + PKCE 流。
2. **Personal Microsoft accounts only** 或 multi-tenant 都行,只有 personal 最干净。
3. Redirect URI 必须**精确匹配**:`https://fangzhangmnm.github.io/justreadpapers/`(注意结尾 `/`)。本地测试加 `http://localhost:8000/`。
4. API permissions → **Delegated** 加 `Files.ReadWrite.AppFolder` + `offline_access`。
5. **不需要 admin consent**(个人账号自助授权)。

### Delegated vs Application 的坑

我之前在另一个项目误选了 Application — 个人 MS 账号根本不支持 Application 权限,但 MSAL 的 OAuth flow 会按 scope 字符串名匹配 delegated 等价权限,所以"看起来能跑"。哪天换 work/school 账号 / 改用 client_credentials flow 就立刻断。

**SPA + 用户登录 = 一定是 Delegated。Application 给后台 daemon 用。**

## MSAL.js 加载 + init 模板

```js
import { CLIENT_ID, AUTHORITY, SCOPES } from "./config.js";

const MSAL_URLS = [
  `https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.27.0/lib/msal-browser.min.js`,
  `https://unpkg.com/@azure/msal-browser@3.27.0/lib/msal-browser.min.js`,  // fallback
];

let pca = null;
let activeAccount = null;

export async function initAuth() {
  await loadMsalFromAnyCdn();
  pca = new window.msal.PublicClientApplication({
    auth: {
      clientId: CLIENT_ID,
      authority: "https://login.microsoftonline.com/common",
      redirectUri: location.origin + location.pathname,
      postLogoutRedirectUri: location.origin + location.pathname,
    },
    cache: { cacheLocation: "localStorage" },
  });
  await pca.initialize();

  // 1. 检查 redirect 回来
  const response = await pca.handleRedirectPromise().catch(() => null);
  if (response?.account) {
    pca.setActiveAccount(response.account);
    activeAccount = response.account;
    return { signedIn: true };
  }

  // 2. 缓存账号 — 不能直接信!可能是同 origin 别的 app 登的账号
  const cached = pca.getAllAccounts();
  if (cached.length === 0) return { signedIn: false };

  // 3. **关键**:试 silent acquire 一次确认本 app (本 clientId) 真被授权过
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
    pca.setActiveAccount(cached[0]);
    activeAccount = cached[0];
    return { signedIn: true };
  } catch (_) {
    // silent 失败 = 本 app 未授权 → UI 标"未登录",让用户 explicit consent
    return { signedIn: false, probedAccount: cached[0] };
  }
}
```

### 为什么要 silent 探测

同 origin 下如果还有别的 app (比如 `webxiaoheiwu`),它们的 MSAL 都把 token 存在 `localStorage`。`getAllAccounts()` 会返回那个 account,UI 误以为"已登录"但调 Graph 立刻 401(本 clientId 没授权)。silent acquire 是唯一的"我这个 app 真有 token 吗"验证。

`probedAccount` 字段告诉 UI:"账号在,但本 app 需要 consent",可以提示 `点登录授权 ${probedAccount.username}`,UX 更友好。

## SignOut:**不要 logoutRedirect**

```js
// ❌ 别这么写 —— 会把用户从 Outlook / OneDrive 网页 / 别的 tab 全部踢掉
await pca.logoutRedirect();

// ✅ 只清本 app 的 local MSAL cache
await pca.clearCache({ account });
pca.setActiveAccount(null);
```

`logoutRedirect` 调的是 Microsoft 全局 sign-out endpoint,会终止整个 Microsoft session。用户只是想"在我这个 app 登出"就行。

## getToken (silent + 兜底 redirect)

```js
export async function getToken() {
  if (!pca || !activeAccount) throw new Error("尚未登录");
  try {
    const r = await pca.acquireTokenSilent({ scopes: SCOPES, account: activeAccount });
    return r.accessToken;
  } catch (_) {
    await pca.acquireTokenRedirect({ scopes: SCOPES });
    throw _;
  }
}
```

silent 一般成(refresh token 自动续),失败只在 token 过期且 refresh 也死了的极端情况,这时 redirect 强制重新登录。

## Graph 调用习惯

每个 Graph fetch 都 `Bearer ${token}`:

```js
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
async function graphFetch(method, path, opts = {}) {
  const token = await getToken();
  const r = await fetch(`${GRAPH_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
    body: opts.body,
  });
  if (!r.ok) {
    const e = new Error(`Graph ${method} ${path} → ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return r;
}
```

接 path encode:OneDrive 文件名含 `中文 / 空格 / 特殊字符`,segment 全部 `encodeURIComponent`,保留 `/`。

```js
function encodeApprootPath(path) {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}
```

## 几个常用 endpoint

| 用途 | URL |
| --- | --- |
| 列 approot 根 | `/me/drive/special/approot/children` |
| 列 approot 子目录 | `/me/drive/special/approot:/<encoded path>:/children` |
| 读文件 metadata + downloadUrl | `/me/drive/items/<id>?$select=...,@microsoft.graph.downloadUrl` |
| 二进制下载 | 用 metadata 拿 `@microsoft.graph.downloadUrl` 直接 fetch(走 CDN,快;不用过 Graph) |
| 写小 JSON | `PUT /me/drive/special/approot:/session.json:/content?@microsoft.graph.conflictBehavior=replace` |
| 大文件分块上传 | `POST .../createUploadSession`,拿 `uploadUrl` 分 5MB 块 PUT |
| 改名 / 移动 | `PATCH /me/drive/items/<id>` body `{ name: ... }` 或 `{ parentReference: { id: targetFolderId } }` |
| 删除 | `DELETE /me/drive/items/<id>` |

⚠ **`@microsoft.graph.conflictBehavior` 不是 header,是 URL query**(`@` 在 header name 不合法,fetch 会报 "Invalid name")。

## 大文件上传 (>4MB)

`PUT /content` 单次限 4MB。论文 PDF 一般 1-5MB,边界:

```js
if (blob.size <= 4 * 1024 * 1024) {
  // 简单 PUT
} else {
  // 1. POST createUploadSession 拿 uploadUrl
  // 2. 5MB 一块 PUT,每块加 Content-Range: bytes A-B/total header
  // 3. 最后一块返回最终 driveItem
}
```

## ETag + If-Match 防 cross-device 覆盖

写小 JSON(`session.json`)用 ETag 乐观锁:
- 读时记下 `eTag`
- 写时 header `If-Match: <eTag>`
- 远端被另一设备改过 → 返 412 → re-fetch + merge + retry

见 [20260524-session-sync-throttle.md](20260524-session-sync-throttle.md) 的 mergeRemoteAndRetry。

## 相关
- [20260524-design-principles.md](20260524-design-principles.md) - AppFolder 是 SSOT 的物理位置
- [20260524-session-sync-throttle.md](20260524-session-sync-throttle.md) - 写盘 + 冲突解决
