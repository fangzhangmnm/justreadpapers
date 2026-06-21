// 根组件。P3 第一步:topbar(打开本地 PDF,无需登录即可在 /dev/ 验 viewer)+ Viewer(主表面)+ 位置读数。
// 后续:resume 编排、library panel、folder-tree、云选项 挂这里;现在先把 viewer 跑通给 /dev/ 看。
import { defineComponent, ref } from "../vendor/vue/vue.esm-browser.prod.js";
import { Viewer } from "./viewer.ts";
import type { Position } from "../domain/viewer-geometry.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const App = defineComponent({
  name: "JrpApp",
  components: { Viewer },
  setup() {
    const viewerRef = ref<any>(null);
    const pos = ref<Position | null>(null);
    const fileName = ref("");

    async function onFile(e: Event): Promise<void> {
      const input = e.target as HTMLInputElement;
      const f = input.files && input.files[0];
      if (!f) return;
      fileName.value = f.name;
      pos.value = null;
      await viewerRef.value?.loadBlob(f, null);
    }
    function onPos(p: Position): void { pos.value = p; }

    return { viewerRef, pos, fileName, onFile, onPos };
  },
  template: `
    <div class="jrp-shell">
      <header class="jrp-topbar">
        <label class="jrp-open">打开 PDF
          <input type="file" accept="application/pdf" @change="onFile" hidden>
        </label>
        <span class="jrp-fname">{{ fileName || '选一份本地 PDF 试 viewer' }}</span>
        <span class="jrp-pos" v-if="pos">p.{{ pos.pageIndex + 1 }} · {{ Math.round(pos.yFraction * 100) }}%</span>
      </header>
      <div class="jrp-viewer-wrap">
        <Viewer ref="viewerRef" @position="onPos" />
      </div>
    </div>
  `,
});
