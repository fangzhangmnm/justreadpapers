// Azure AD 应用注册的 client id。MVP 部署到 fangzhangmnm.github.io/justreadpapers/,
// 需要单独的注册 (跟 webxiaoheiwu / background radio 共一个 OneDrive 账户但不同 redirect URI)。
// 部署前在 https://entra.microsoft.com → App registrations → 新建,把 redirect URI 设为
// https://fangzhangmnm.github.io/justreadpapers/ 和 http://localhost:* (本地测试)。
export const CLIENT_ID = "8b5063a4-6fd4-40d0-8973-fb6388a6db24";

// common = 个人 + 组织账号都能登
export const AUTHORITY = "https://login.microsoftonline.com/common";

// AppFolder = approot 沙盒;offline_access = 拿 refresh token,登录一次以后纯 silent
export const SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];

// 内部布局 (相对 approot)
export const PAPERS_FOLDER = "papers";
export const TRASH_FOLDER = "trash";
export const SESSION_FILE = "session.json";

// 位置写盘节流(简单方案):
//   - 每次 non-trivial scroll 重置 10s 倒计时,期满 → push
//   - 持续活动也封顶 30s(连按 PageDown 时 rate 不会更高)
//   - trivial(同页 + |yFrac Δ| < 0.5)只更新内存,不调度
// 兜底:visibilitychange-hidden / pagehide / beforeunload 都 flushKeepalive 一次。
export const POSITION_DEBOUNCE_MS = 10_000;
export const POSITION_HEARTBEAT_MS = 30_000;

// 鼠标滚轮粒度下,半页 (0.5) 才算"真换了段"。换页(pageIndex 不同)永远 non-trivial。
export const TRIVIAL_POSITION_Y_DELTA = 0.5;

// IndexedDB LRU cap。论文 PDF 一般 1-5MB,1GB 可以放 200-1000 篇。
export const CACHE_CAP_BYTES = 1024 * 1024 * 1024;

// reading-line 在 viewport 内的固定锚位置 [0,1]。spec 推荐 0.25。
export const READING_LINE_ANCHOR = 0.25;
