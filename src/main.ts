// 组合根:构造 app（后续装配 persistence + provide app-state）→ mount。
// esbuild bundle 入口（build.sh ENTRY=./src/main.ts）。
import { createApp } from "./vendor/vue/vue.esm-browser.prod.js";
import { App } from "./ui/app.ts";
import { initPwaShell } from "./pwa-shell.ts";

createApp(App).mount("#app");

// PWA shell:注册 SW + 4 路更新检测。/dev/ 与 localhost 不注册。
// TODO(P3):onUpdateAvailable → Vue Toasts "有新版本" 组件;现在先 console。
initPwaShell({
  onUpdateAvailable: () => { console.info("[pwa] 检测到新版本(待接 Vue toast)"); },
});
