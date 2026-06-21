// 根组件 = shell 编排:左上文件 sidebar(gallery)+目录,右上 ☰ 系统菜单(3c),中间 viewer。
// 打开论文:read 云字节 → docId(内容 hash)→ catalog upsert/touch → viewer.loadBlob + 复位位置。
// boot:initAuth → jumpscare(自动开 lastActive,产品心脏)。scroll → recordPosition(节流落盘)。
import { defineComponent, ref, computed, onMounted } from "../vendor/vue/vue.esm-browser.prod.js";
import { Viewer } from "./viewer.ts";
import { Gallery } from "./gallery.ts";
import { contentDocId } from "../domain/doc-id.ts";
import type { Position } from "../domain/viewer-geometry.ts";
import { persistence, settings, appUi, pwaShell } from "../app-state.ts";
import { PAPERS_FOLDER } from "../config.ts";
import type { GalleryItem } from "../gallery-model.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const App = defineComponent({
  name: "JrpApp",
  components: { Viewer, Gallery },
  setup() {
    const viewerRef = ref<any>(null);
    const galleryOpen = ref(false);
    const currentDocId = ref<string | null>(null);
    const title = ref("");
    const pos = ref<Position | null>(null);
    const page = ref(0);
    const total = ref(0);
    const spread = ref(0);
    const toast = ref("");
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    // ── ☰ 系统菜单 + 主题 ──
    const menuOpen = ref(false);
    const themeMode = ref(settings().get("theme") || "auto");   // auto | day | night
    function resolveTheme(m: string): string {
      return m === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day") : m;
    }
    function applyTheme(): void { document.documentElement.dataset.theme = resolveTheme(themeMode.value); }
    function cycleTheme(): void {
      themeMode.value = themeMode.value === "auto" ? "day" : themeMode.value === "day" ? "night" : "auto";
      settings().set("theme", themeMode.value); applyTheme();
    }
    const themeLabel = computed(() => themeMode.value === "auto" ? "跟随系统" : themeMode.value === "day" ? "日间" : "夜间");
    function forceUpdate(): void { menuOpen.value = false; void pwaShell().reload(); }

    function showToast(msg: string): void {
      toast.value = msg;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.value = ""; }, 2200);
    }
    const v = (): any => viewerRef.value;

    // 打开一篇云端论文(gallery 或 jumpscare 都走这):read → docId → catalog → viewer + 复位。
    async function openPaper(item: { path: string; name: string; title: string }): Promise<void> {
      galleryOpen.value = false;
      let blob: Blob | null = null;
      try { blob = await persistence().content.read(item.path); } catch { /* */ }
      if (!blob) { showToast("读取失败(未登录/离线?)"); return; }
      const docId = await contentDocId(await blob.arrayBuffer());
      const cat = persistence().catalog;
      if (!cat.get(docId)) cat.upsert(docId, { fileName: item.name, addedAt: nowMs() });
      else cat.upsert(docId, { fileName: item.name });   // 保 fileName 跟当前(扛改名)
      cat.touch(docId);
      currentDocId.value = docId; title.value = item.title; pos.value = null;
      const restore = cat.get(docId)?.position ?? null;
      await v()?.loadBlob(blob, { key: docId, pos: restore });
    }
    function onGalleryOpen(it: GalleryItem): void { void openPaper({ path: it.path, name: it.name, title: it.title }); }

    // 本地 PDF(测试 / 登录失败 fallback):不进 catalog,viewer 直加载。
    async function onLocalFile(e: Event): Promise<void> {
      const input = e.target as HTMLInputElement;
      const f = input.files && input.files[0]; if (!f) return;
      currentDocId.value = null; title.value = f.name; pos.value = null; galleryOpen.value = false;
      await v()?.loadBlob(f, { key: f.name, pos: null });
    }

    // jumpscare:启动直开 lastActive 那篇那页(产品心脏:1-click resume,无 library 落地屏)。
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
      // 登录真 resolve(含刷新后的后台 silent 探测,经 onAuthChanged)→ catalog.init + jumpscare(一次性)。
      async function onSignedIn(): Promise<void> {
        if (resumed) return; resumed = true;
        await persistence().catalog.init();
        jumpscare();
      }
      auth.onAuthChanged((st: any) => { if (st && st.signedIn) void onSignedIn(); });
      try {
        const st = await auth.initAuth();
        if (st.signedIn) await onSignedIn();   // 刚交互登录:同步就 signed
        else galleryOpen.value = true;         // 未登录 / 探测中:先开 gallery;探测成功 onAuthChanged 会 jumpscare(自动关 gallery)
      } catch { galleryOpen.value = true; }
      // 离开页面 best-effort 落盘待推位置(沿用老 code:可接受丢 1 次,代价 < 阻塞 unload)。
      const flush = (): void => { persistence().save.flushKeepalive(); };
      window.addEventListener("pagehide", flush);
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
    });

    return {
      viewerRef, galleryOpen, currentDocId, title, pos, page, total, spread, toast,
      menuOpen, themeLabel, appUi, cycleTheme, forceUpdate,
      toggleMenu: (): void => { menuOpen.value = !menuOpen.value; },
      onGalleryOpen, onLocalFile,
      onPos: (p: Position): void => { pos.value = p; if (currentDocId.value) persistence().recordPosition(currentDocId.value, p); },
      onPage: (info: { page: number; total: number }): void => { page.value = info.page; total.value = info.total; },
      onSpread: (m: number): void => { spread.value = m; },
      onToast: showToast,
      toggleGallery: (): void => { galleryOpen.value = !galleryOpen.value; },
      zoomIn: (): void => v()?.zoomIn(),
      zoomOut: (): void => v()?.zoomOut(),
      fitWidth: (): void => v()?.fitWidth(),
      toggleSpread: (): void => v()?.toggleSpread(),
      screenshot: (): void => v()?.screenshot(),
      copyText: (): void => v()?.copyText(),
    };
  },
  template: `
    <div class="jrp-shell">
      <header class="jrp-topbar">
        <button class="jrp-icon" @click="toggleGallery" title="论文库" aria-label="论文库">
          <svg viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M2 5a1 1 0 0 1 1-1h5l1.5 1.5H17a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/></svg>
        </button>
        <label class="jrp-btn" title="打开本地 PDF(测试/fallback)">本地<input type="file" accept="application/pdf" @change="onLocalFile" hidden></label>
        <div class="jrp-controls" v-if="total">
          <button class="jrp-btn" @click="zoomOut" title="缩小">−</button>
          <button class="jrp-btn" @click="fitWidth" title="适配宽度">适配</button>
          <button class="jrp-btn" @click="zoomIn" title="放大">＋</button>
          <button class="jrp-btn" @click="toggleSpread">{{ spread ? '单页' : '双页' }}</button>
          <button class="jrp-btn" @click="screenshot" title="截当前页到剪贴板">截图</button>
          <button class="jrp-btn" @click="copyText" title="复制当前页文本">复制</button>
        </div>
        <span class="jrp-fname">{{ title || '☰ 打开论文库选一篇' }}</span>
        <span class="jrp-pos" v-if="total">p.{{ page }}/{{ total }}<template v-if="pos"> · {{ Math.round(pos.yFraction * 100) }}%</template></span>
        <button class="jrp-icon" @click="toggleMenu" title="系统菜单" aria-label="系统菜单">
          <svg viewBox="0 0 20 20" width="18" height="18"><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 6h12M4 10h12M4 14h12"/></svg>
        </button>
      </header>
      <div class="jrp-body">
        <Gallery v-if="galleryOpen" @open="onGalleryOpen" @close="galleryOpen = false" />
        <div class="jrp-backdrop" v-if="galleryOpen" @click="galleryOpen = false"></div>
        <div class="jrp-viewer-wrap"><Viewer ref="viewerRef" @position="onPos" @page="onPage" @spread="onSpread" @toast="onToast" /></div>
      </div>
      <div class="jrp-menu-backdrop" v-if="menuOpen" @click="menuOpen = false"></div>
      <div class="jrp-menu" v-if="menuOpen">
        <button class="jrp-menu-item" @click="cycleTheme">颜色模式 · {{ themeLabel }}</button>
        <button class="jrp-menu-item" @click="forceUpdate">强制更新</button>
        <button class="jrp-menu-item" disabled>离线缓存 · 待接</button>
      </div>
      <div class="jrp-toast jrp-update" v-if="appUi.updateAvailable" @click="forceUpdate">有新版本 · 点此刷新</div>
      <div class="jrp-toast" v-if="toast">{{ toast }}</div>
    </div>
  `,
});

function nowMs(): number { return Date.now(); }
