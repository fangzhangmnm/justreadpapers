// 组合根:构造 app（后续装配 persistence + provide app-state）→ mount。
// esbuild bundle 入口（build.sh ENTRY=./src/main.ts）。
import { createApp } from "./vendor/vue/vue.esm-browser.prod.js";
import { App } from "./ui/app.ts";

createApp(App).mount("#app");
