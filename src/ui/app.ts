// 根组件。greenfield Vue:整棵 UI 树的入口,后续 Viewer/LibraryPanel/StatusLine 等挂这里。
// 现在是最小骨架,只验证 Vue + esbuild + strip-types 管线通。
import { defineComponent } from "../vendor/vue/vue.esm-browser.prod.js";

export const App = defineComponent({
  name: "JrpApp",
  template: `
    <div class="jrp-shell">
      <p class="jrp-boot">JustReadPapers · Vue greenfield 骨架就位</p>
    </div>
  `,
});
