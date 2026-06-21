// app 级单例:persistence + pwa-shell + 反应式 UI 标志。组件直接 import(单 app,模块单例够用)。
import { reactive } from "./vendor/vue/vue.esm-browser.prod.js";
import { createPersistence } from "./persistence/index.ts";
import type { Persistence, Settings } from "./persistence/index.ts";
import { initPwaShell } from "./pwa-shell.ts";
import type { PwaShell } from "./pwa-shell.ts";

let _p: Persistence | null = null;
/** 懒装配 persistence(首次用时建;createOneDriveProvider 只配置不连网,安全)。 */
export function persistence(): Persistence {
  if (!_p) _p = createPersistence();
  return _p;
}
/** 设备本地设置面(zoom factor / spread / theme)。app 调这个,不碰 localStorage。 */
export function settings(): Settings {
  return persistence().settings;
}

// 反应式 UI 标志(跨组件共享):有新版本可更新。
export const appUi = reactive({ updateAvailable: false });

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
