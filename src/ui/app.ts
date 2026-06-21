// 根组件。P3:topbar(打开本地 PDF + zoom/spread 控件 + 页码)+ Viewer(主表面)。
// 后续:resume 编排、library panel、folder-tree、云选项 挂这里。
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
    const page = ref(0);
    const total = ref(0);
    const spread = ref(0);   // 0 单页 / 1 双页

    async function onFile(e: Event): Promise<void> {
      const input = e.target as HTMLInputElement;
      const f = input.files && input.files[0];
      if (!f) return;
      fileName.value = f.name; pos.value = null;
      await viewerRef.value?.loadBlob(f, { key: f.name, pos: null });
    }
    const v = (): any => viewerRef.value;

    return {
      viewerRef, pos, fileName, page, total, spread,
      onFile,
      onPos: (p: Position): void => { pos.value = p; },
      onPage: (info: { page: number; total: number }): void => { page.value = info.page; total.value = info.total; },
      onSpread: (m: number): void => { spread.value = m; },
      zoomIn: (): void => v()?.zoomIn(),
      zoomOut: (): void => v()?.zoomOut(),
      fitWidth: (): void => v()?.fitWidth(),
      toggleSpread: (): void => v()?.toggleSpread(),
    };
  },
  template: `
    <div class="jrp-shell">
      <header class="jrp-topbar">
        <label class="jrp-btn">打开<input type="file" accept="application/pdf" @change="onFile" hidden></label>
        <div class="jrp-controls" v-if="fileName">
          <button class="jrp-btn" @click="zoomOut" title="缩小">−</button>
          <button class="jrp-btn" @click="fitWidth" title="适配宽度">适配</button>
          <button class="jrp-btn" @click="zoomIn" title="放大">＋</button>
          <button class="jrp-btn" @click="toggleSpread">{{ spread ? '单页' : '双页' }}</button>
        </div>
        <span class="jrp-fname">{{ fileName || '选一份本地 PDF 试 viewer' }}</span>
        <span class="jrp-pos" v-if="total">p.{{ page }}/{{ total }}<template v-if="pos"> · {{ Math.round(pos.yFraction * 100) }}%</template></span>
      </header>
      <div class="jrp-viewer-wrap"><Viewer ref="viewerRef" @position="onPos" @page="onPage" @spread="onSpread" /></div>
    </div>
  `,
});
