// Microsoft Entra (Azure AD) 登录 via MSAL.js.
//
// MSAL vendor 在 src/vendor/msal/msal-browser.min.js (见 src/vendor/README.md)。
// 缓存账号 + silent token 探测 = 同一 origin 下其它 app 已登录但本 app 没授权时,
// 不假装 "已登录" —— 把按钮挂出来让用户 explicit consent。

import { CLIENT_ID, AUTHORITY, SCOPES } from "./config.js";

const MSAL_VERSION = "3.27.0";
const MSAL_URL = new URL("./vendor/msal/msal-browser.min.js", import.meta.url).href;

let msalLoadPromise = null;
let pca = null;
let activeAccount = null;
let initPromise = null;

function loadScript(url) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${url}`));
    document.head.appendChild(s);
  });
}

function loadMsal() {
  if (window.msal) return Promise.resolve(window.msal);
  if (msalLoadPromise) return msalLoadPromise;
  msalLoadPromise = (async () => {
    try {
      await loadScript(MSAL_URL);
      if (window.msal) return window.msal;
      throw new Error("MSAL 加载完但 window.msal 没出现");
    } catch (e) {
      msalLoadPromise = null;
      throw new Error(`MSAL 加载失败: ${e?.message ?? "unknown"}`);
    }
  })();
  return msalLoadPromise;
}

export async function initAuth() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const msal = await loadMsal();
    pca = new msal.PublicClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: location.origin + location.pathname,
        postLogoutRedirectUri: location.origin + location.pathname,
      },
      cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false,
      },
    });
    await pca.initialize();

    let response = null;
    try {
      response = await pca.handleRedirectPromise();
    } catch (e) {
      console.warn("handleRedirectPromise failed:", e);
    }

    if (response?.account) {
      pca.setActiveAccount(response.account);
      activeAccount = response.account;
      return { signedIn: true, account: activeAccount };
    }

    const cached = pca.getAllAccounts();
    if (cached.length === 0) {
      return { signedIn: false, account: null };
    }

    // 探测:能 silent 拿到本 clientId 的 token = 本 app 已被授权
    try {
      await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
      pca.setActiveAccount(cached[0]);
      activeAccount = cached[0];
      return { signedIn: true, account: activeAccount };
    } catch (_) {
      return { signedIn: false, account: null, probedAccount: cached[0] };
    }
  })().catch((e) => {
    initPromise = null;
    throw e;
  });
  return initPromise;
}

export async function signIn() {
  if (!pca) await initAuth();
  return pca.loginRedirect({ scopes: SCOPES });
}

export async function signOut() {
  if (!pca || !activeAccount) return;
  const account = activeAccount;
  activeAccount = null;
  // 只清本 app 的 local cache —— 不 logoutRedirect,避免把用户在其它 tab(Outlook 等)的 session 一起踢掉
  try {
    await pca.clearCache({ account });
  } catch (e) {
    console.warn("clearCache failed:", e);
  }
  try {
    pca.setActiveAccount(null);
  } catch (_) {}
}

export async function getToken() {
  if (!pca || !activeAccount) throw new Error("尚未登录");
  try {
    const result = await pca.acquireTokenSilent({
      scopes: SCOPES,
      account: activeAccount,
    });
    return result.accessToken;
  } catch (e) {
    await pca.acquireTokenRedirect({ scopes: SCOPES });
    throw e;
  }
}

export function getActiveAccount() {
  return activeAccount;
}

export function isSignedIn() {
  return !!activeAccount;
}
