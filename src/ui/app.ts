// 根组件 = shell 编排。顶栏精简(左:文件夹+目录;中:标题;右:状态+☰),所有选项进 ☰(user 2026-06-21)。
// 打开论文:read 云字节→docId→catalog upsert/touch→viewer+复位。boot→jumpscare(自动开 lastActive)。
import { defineComponent, ref, computed, onMounted } from "../vendor/vue/vue.esm-browser.prod.js";
import { Viewer } from "./viewer.ts";
import { Gallery } from "./gallery.ts";
import { contentDocId } from "../domain/doc-id.ts";
import type { Position } from "../domain/viewer-geometry.ts";
import { persistence, settings, appUi, pwaShell, pushToast } from "../app-state.ts";
import { PAPERS_FOLDER } from "../config.ts";
import type { GalleryItem } from "../gallery-model.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface OutlineRow { title: string; dest: unknown; depth: number; }
function flattenOutline(items: any[], depth: number, out: OutlineRow[]): void {
  for (const it of items || []) {
    out.push({ title: String(it.title || ""), dest: it.dest, depth });
    if (it.items && it.items.length) flattenOutline(it.items, depth + 1, out);
  }
}

export const App = defineComponent({
  name: "JrpApp",
  components: { Viewer, Gallery },
  setup() {
    const viewerRef = ref<any>(null);
    const galleryOpen = ref(false);
    const outlineOpen = ref(false);
    const outline = ref<any[]>([]);
    const menuOpen = ref(false);
    const currentDocId = ref<string | null>(null);
    const title = ref("");
    const pos = ref<Position | null>(null);
    const page = ref(0);
    const total = ref(0);
    const spread = ref(0);

    const themeMode = ref(settings().get("theme") || "auto");
    function resolveTheme(m: string): string { return m === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day") : m; }
    function applyTheme(): void { document.documentElement.dataset.theme = resolveTheme(themeMode.value); }
    function cycleTheme(): void {
      themeMode.value = themeMode.value === "auto" ? "day" : themeMode.value === "day" ? "night" : "auto";
      settings().set("theme", themeMode.value); applyTheme();
    }
    const themeLabel = computed(() => themeMode.value === "auto" ? "跟随系统" : themeMode.value === "day" ? "日间" : "夜间");
    const outlineFlat = computed(() => { const out: OutlineRow[] = []; flattenOutline(outline.value, 0, out); return out; });
    // 保存状态指示(给续读修复一个可见确认)：未保存/保存中/已保存。
    const saveLabel = computed(() => {
      const m: Record<string, string> = { dirty: "未保存", saving: "保存中…", saved: "已保存" };
      return m[appUi.saveState] || "";
    });

    function showToast(msg: string): void { pushToast(msg); }
    const v = (): any => viewerRef.value;
    function nowMs(): number { return Date.now(); }

    // 人工保存阅读位置:显式 flush(若脏立即推云;不脏=已是最新)。Ctrl/Cmd+S 与菜单按钮共用。
    async function saveNow(): Promise<void> {
      if (!currentDocId.value) { showToast("没有正在读的论文"); return; }
      try { await persistence().save.flush(); showToast("已保存阅读位置"); }
      catch { showToast("保存失败(未登录/离线?)"); }
    }

    async function openPaper(item: { path: string; name: string; title: string }): Promise<void> {
      galleryOpen.value = false;
      let blob: Blob | null = null;
      try { blob = await persistence().content.read(item.path); } catch { /* */ }
      if (!blob) { showToast("读取失败(未登录/离线?)"); return; }
      const docId = await contentDocId(await blob.arrayBuffer());
      const cat = persistence().catalog;
      if (!cat.get(docId)) cat.upsert(docId, { fileName: item.name, addedAt: nowMs() });
      else cat.upsert(docId, { fileName: item.name });
      cat.touch(docId);
      currentDocId.value = docId; title.value = item.title; pos.value = null; outline.value = [];
      const restore = cat.get(docId)?.position ?? null;
      await v()?.loadBlob(blob, { key: docId, pos: restore });
    }
    function onGalleryOpen(it: GalleryItem): void { void openPaper({ path: it.path, name: it.name, title: it.title }); }

    async function onLocalFile(e: Event): Promise<void> {
      const input = e.target as HTMLInputElement;
      const f = input.files && input.files[0]; if (!f) return;
      menuOpen.value = false; currentDocId.value = null; title.value = f.name; pos.value = null; outline.value = [];
      await v()?.loadBlob(f, { key: f.name, pos: null });
    }

    function jumpscare(): void {
      const cat = persistence().catalog;
      const id = cat.lastActiveId();
      console.info("[jrp] resume lastActive =", id || "(无 → 开 gallery)");
      if (!id) { galleryOpen.value = true; return; }
      const doc = cat.get(id); if (!doc || !doc.fileName) { galleryOpen.value = true; return; }
      void openPaper({ path: `${PAPERS_FOLDER}/${doc.fileName}`, name: doc.fileName, title: doc.title || doc.fileName });
    }

    onMounted(async () => {
      applyTheme();
      const auth = persistence().auth;
      let resumed = false;
      async function onSignedIn(): Promise<void> {
        if (resumed) return; resumed = true;
        await persistence().catalog.init();
        jumpscare();
      }
      auth.onAuthChanged((st: any) => { if (st && st.signedIn) void onSignedIn(); });
      try {
        const st = await auth.initAuth();
        if (st.signedIn) await onSignedIn(); else galleryOpen.value = true;
      } catch { galleryOpen.value = true; }
      const flush = (): void => { persistence().save.flushKeepalive(); };
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
      // Ctrl/Cmd+S = 人工保存阅读位置(抢下浏览器"保存网页"对话框)。
      window.addEventListener("keydown", (e: KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); void saveNow(); }
      });
    });

    function menuRun(fn: () => void): void { menuOpen.value = false; fn(); }

    return {
      viewerRef, galleryOpen, outlineOpen, outline, outlineFlat, menuOpen,
      currentDocId, title, pos, page, total, spread, themeLabel, appUi, saveLabel,
      onGalleryOpen, onLocalFile,
      onPos: (p: Position): void => { pos.value = p; if (currentDocId.value) persistence().recordPosition(currentDocId.value, p); },
      onPage: (info: { page: number; total: number }): void => { page.value = info.page; total.value = info.total; },
      onSpread: (m: number): void => { spread.value = m; },
      onOutline: (o: any[]): void => { outline.value = o || []; },
      onToast: showToast,
      toggleGallery: (): void => { galleryOpen.value = !galleryOpen.value; outlineOpen.value = false; },
      toggleOutline: (): void => { outlineOpen.value = !outlineOpen.value; galleryOpen.value = false; },
      toggleMenu: (): void => { menuOpen.value = !menuOpen.value; },
      goToOutline: (dest: unknown): void => { outlineOpen.value = false; v()?.goToDest(dest); },
      cycleTheme,
      forceUpdate: (): void => menuRun(() => { void pwaShell().reload(); }),
      zoomIn: (): void => v()?.zoomIn(),
      zoomOut: (): void => v()?.zoomOut(),
      fitWidth: (): void => v()?.fitWidth(),
      toggleSpread: (): void => v()?.toggleSpread(),
      screenshot: (): void => menuRun(() => v()?.screenshot()),
      copyText: (): void => menuRun(() => v()?.copyText()),
      saveNow: (): void => menuRun(() => { void saveNow(); }),
      overview: (): void => menuRun(() => v()?.toggleOverview()),
    };
  },
  template: `
    <div class="jrp-shell">
      <header class="jrp-topbar">
        <button class="jrp-icon" @click="toggleGallery" title="论文库" aria-label="论文库">
          <svg viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M2 5a1 1 0 0 1 1-1h5l1.5 1.5H17a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>
        </button>
        <button class="jrp-icon" @click="toggleOutline" v-if="outline.length" title="目录" aria-label="目录">
          <svg viewBox="0 0 20 20" width="18" height="18"><path stroke="currentColor" stroke-width="1.5" stroke-linecap="round" d="M7 6h9M7 10h9M7 14h9M4 6h.01M4 10h.01M4 14h.01"/></svg>
        </button>
        <span class="jrp-fname">{{ title || '打开论文库选一篇' }}</span>
        <span class="jrp-pos" v-if="total">p.{{ page }}/{{ total }}<template v-if="pos"> · {{ Math.round(pos.yFraction * 100) }}%</template></span>
        <span class="jrp-save" :class="appUi.saveState" v-if="total && saveLabel" :title="'阅读位置 ' + saveLabel">{{ saveLabel }}</span>
        <button class="jrp-icon" :class="{ pad: !total }" @click="toggleMenu" title="菜单" aria-label="菜单">
          <svg viewBox="0 0 20 20" width="18" height="18"><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 6h12M4 10h12M4 14h12"/></svg>
        </button>
      </header>
      <div class="jrp-body">
        <Gallery v-if="galleryOpen" @open="onGalleryOpen" @close="galleryOpen = false" @toast="onToast" />
        <aside class="jrp-outline" v-if="outlineOpen">
          <div class="jrp-gal-head"><button class="jrp-btn" @click="outlineOpen = false">关闭</button><span class="jrp-gal-acct">目录</span></div>
          <div class="jrp-gal-list">
            <div class="jrp-ol-row" v-for="(o, i) in outlineFlat" :key="i" :style="{ paddingLeft: (10 + o.depth * 16) + 'px' }" @click="goToOutline(o.dest)">{{ o.title }}</div>
          </div>
        </aside>
        <div class="jrp-backdrop" v-if="galleryOpen || outlineOpen" @click="galleryOpen = false; outlineOpen = false"></div>
        <div class="jrp-viewer-wrap"><Viewer ref="viewerRef" @position="onPos" @page="onPage" @spread="onSpread" @toast="onToast" @outline="onOutline" /></div>
      </div>
      <div class="jrp-menu-backdrop" v-if="menuOpen" @click="menuOpen = false"></div>
      <div class="jrp-menu" v-if="menuOpen">
        <template v-if="total">
          <div class="jrp-menu-zoom">
            <button @click="zoomOut">−</button><button @click="fitWidth">适配</button><button @click="zoomIn">＋</button>
          </div>
          <button class="jrp-menu-item" @click="toggleSpread">{{ spread ? '切单页' : '切双页' }}</button>
          <button class="jrp-menu-item" @click="overview">页面总览</button>
          <button class="jrp-menu-item" @click="saveNow">保存阅读位置 · Ctrl+S</button>
          <button class="jrp-menu-item" @click="screenshot">截图当前页</button>
          <button class="jrp-menu-item" @click="copyText">复制当前页文本</button>
          <div class="jrp-menu-sep"></div>
        </template>
        <button class="jrp-menu-item" @click="cycleTheme">颜色模式 · {{ themeLabel }}</button>
        <button class="jrp-menu-item" @click="forceUpdate">强制更新</button>
        <label class="jrp-menu-item">打开本地 PDF（仅预览，不入库）<input type="file" accept="application/pdf" @change="onLocalFile" hidden></label>
      </div>
      <div class="jrp-toast jrp-update" v-if="appUi.updateAvailable" @click="forceUpdate">有新版本 · 点此刷新</div>
      <div class="jrp-toast" v-if="appUi.toast">{{ appUi.toast }}</div>
    </div>
  `,
});
