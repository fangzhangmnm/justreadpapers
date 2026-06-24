// app 级单例:persistence + pwa-shell + 反应式 UI 标志。组件直接 import(单 app,模块单例够用)。
import { reactive } from "./vendor/vue/vue.esm-browser.prod.js";
import { createPersistence } from "./persistence/index.ts";
import type { Persistence, Settings } from "./persistence/index.ts";
import { initPwaShell } from "./pwa-shell.ts";
import type { PwaShell } from "./pwa-shell.ts";

// 反应式 UI 标志(跨组件共享)：更新可用 / 保存状态 / 全局 toast。
export const appUi = reactive({
  updateAvailable: false,
  saveState: "" as "" | "dirty" | "saving" | "saved",
  toast: "",
  toastSeq: 0,   // 每次 push 自增，让连续相同文案也能重新计时
  busy: "",      // 全屏遮罩 label（"" = 不忙）；防书签乱闪 + store 危险写操作锁屏（对齐 JRB「busy 永远全屏」）
});

// 全屏 busy 遮罩驱动（ref-count，可重入）：store 的 ui.busy（经 onBusy hook）+ app 的 openPaper 共用同一个遮罩。
let _busyCount = 0;
export function pushBusy(label = "请稍候…"): void { if (_busyCount === 0) appUi.busy = label; _busyCount++; }   // 只在 0→1 设 label：嵌套 busy 不换字 → 整段一个连续遮罩（不闪不双转）
export function popBusy(): void { _busyCount = Math.max(0, _busyCount - 1); if (_busyCount === 0) appUi.busy = ""; }
export async function withBusy<T>(label: string, fn: () => Promise<T>): Promise<T> {
  pushBusy(label);
  try { return await fn(); } finally { popBusy(); }
}

// ── 冲突 sheet（store 推冲突时驱动；红线：冲突必 surface，绝不静默；为将来改 PDF 的写冲突准备）──
export type ConflictChoice = "keepMine" | "takeCloud" | "cancel";
export const conflictUi = reactive({ open: false, name: "" });
let _conflictResolve: ((c: ConflictChoice) => void) | null = null;
function resolveConflictUi(ctx: { name: string }): Promise<ConflictChoice> {
  conflictUi.open = true; conflictUi.name = ctx.name;
  return new Promise<ConflictChoice>((res) => { _conflictResolve = res; });
}
export function answerConflict(choice: ConflictChoice): void {
  conflictUi.open = false; const r = _conflictResolve; _conflictResolve = null; if (r) r(choice);
}

// ── 密码 sheet（加密文件解锁/保存时 store 驱动；store 保证非交互永不弹框，这里只取一次输入）──
export const passwordUi = reactive({ open: false, name: "", reason: "", input: "" });
let _pwResolve: ((pw: string | null) => void) | null = null;
function askPasswordUi(ctx: { name: string; reason: string }): Promise<string | null> {
  passwordUi.input = ""; passwordUi.open = true; passwordUi.name = ctx.name; passwordUi.reason = ctx.reason;
  return new Promise<string | null>((res) => { _pwResolve = res; });
}
export function answerPassword(pw: string | null): void {
  passwordUi.open = false; passwordUi.input = ""; const r = _pwResolve; _pwResolve = null; if (r) r(pw);
}

let _toastTimer: ReturnType<typeof setTimeout> | null = null;
/** 全局 toast（persistence 错误 surface + app 自身消息共用一个 UI）。 */
export function pushToast(msg: string): void {
  appUi.toast = msg; appUi.toastSeq++;
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { appUi.toast = ""; }, 2200);
}

let _savedTimer: ReturnType<typeof setTimeout> | null = null;
function setSaveState(s: "dirty" | "saving" | "saved"): void {
  appUi.saveState = s;
  if (_savedTimer) { clearTimeout(_savedTimer); _savedTimer = null; }
  if (s === "saved") _savedTimer = setTimeout(() => { if (appUi.saveState === "saved") appUi.saveState = ""; }, 1500);
}

let _p: Persistence | null = null;
/** 懒装配 persistence(首次用时建;createOneDriveProvider 只配置不连网,安全)。错误/保存态注入回 appUi。 */
export function persistence(): Persistence {
  if (!_p) _p = createPersistence({ onError: pushToast, onSaveState: setSaveState, onBusy: (l) => { if (l != null) pushBusy(l); else popBusy(); }, resolveConflict: resolveConflictUi, askPassword: askPasswordUi });
  return _p;
}
/** 设备本地设置面(zoom factor / spread / theme)。app 调这个,不碰 localStorage。 */
export function settings(): Settings {
  return persistence().settings;
}

let _pwa: PwaShell | null = null;
/** PWA shell 单例(注册 SW + 4 路更新检测)。更新可用 → appUi.updateAvailable;reload 前 flush 位置。 */
export function pwaShell(): PwaShell {
  if (!_pwa) {
    _pwa = initPwaShell({
      onUpdateAvailable: () => { appUi.updateAvailable = true; },
      onBeforeReload: () => { try { persistence().save.flushKeepalive(); } catch { /* */ } },
    });
  }
  return _pwa;
}
