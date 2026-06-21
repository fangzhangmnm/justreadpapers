// 组合根:挂 Vue app + 初始化 PWA shell(注册 SW + 更新检测)。
import { createApp } from "./vendor/vue/vue.esm-browser.prod.js";
import { App } from "./ui/app.ts";
import { pwaShell } from "./app-state.ts";

createApp(App).mount("#app");
pwaShell();   // 注册 SW + 4 路更新检测(/dev/ 与 localhost 自动跳过)
