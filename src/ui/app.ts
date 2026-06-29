// 根组件 = shell 编排。顶栏精简(左:文件夹+目录;中:标题;右:状态+☰),所有选项进 ☰(user 2026-06-21)。
// 打开论文:read 云字节→docId→catalog upsert/touch→viewer+复位。boot→jumpscare(自动开 lastActive)。
import { defineComponent, ref, computed, reactive, onMounted } from "../vendor/vue/vue.esm-browser.prod.js";
import { Viewer } from "./viewer.ts";
import { Gallery } from "./gallery.ts";
import { contentDocId } from "../domain/doc-id.ts";
import type { Position } from "../domain/viewer-geometry.ts";
import { persistence, settings, appUi, pwaShell, pushToast, withBusy, conflictUi, answerConflict, passwordUi, answerPassword, cloudCheckUi, skipToOffline } from "../app-state.ts";
import { PAPERS_FOLDER, BUILD_ID } from "../config.ts";
import { pathFolder, pathJoin } from "../gallery-model.ts";
import type { GalleryItem } from "../gallery-model.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
// 拖拽中是否带文件(而非纯文本/链接)。dragover 期 dt.files 为空,只能查 types。
function dtHasFiles(dt: DataTransfer | null): boolean {
  if (!dt || !dt.types) return false;
  for (const t of dt.types) if (t === "Files" || t === "application/x-moz-file") return true;
  return false;
}
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
    const currentPaperFolder = ref("");   // 当前打开论文所在文件夹（相对 papers 根）；阅读模式拖拽落点
    const title = ref("");
    const pos = ref<Position | null>(null);
    const page = ref(0);
    const total = ref(0);
    const spread = ref(0);

    // ── in-app 确认（红线：禁 system confirm）。promise 化：danger 操作 await appConfirm()。后续加密密码也复用此模式。──
    const confirmState = reactive({ open: false, title: "", body: "", danger: false });
    let _confirmResolve: ((ok: boolean) => void) | null = null;
    function appConfirm(ctx: { title: string; body: string; danger?: boolean }): Promise<boolean> {
      confirmState.open = true; confirmState.title = ctx.title; confirmState.body = ctx.body; confirmState.danger = !!ctx.danger;
      return new Promise<boolean>((res) => { _confirmResolve = res; });
    }
    function confirmAnswer(ok: boolean): void { confirmState.open = false; const r = _confirmResolve; _confirmResolve = null; if (r) r(ok); }

    // ── Gallery host：folder div 是窄接口展示组件，宿主在此喂数据 + 执行操作（碰 store）。──
    const galItems = ref<GalleryItem[]>([]);
    const galFolders = ref<string[]>([]);
    const galLoading = ref(false);
    const galSignedIn = ref(false);
    const galAccount = ref("");   // 已登录账号显示名（喂 Gallery 账号 popup）
    const galTrash = ref<{ cloudId: string; name: string }[]>([]);    // 回收站项（懒加载）
    const galBackup = ref<{ cloudId: string; name: string }[]>([]);   // 备份箱项（懒加载）
    const galCurrentFolder = ref("");   // Gallery 当前层（@folderchange 汇报）；拖拽上传落点用
    async function refreshGallery(): Promise<void> {
      if (!galSignedIn.value) { galItems.value = []; galFolders.value = []; return; }
      galLoading.value = true;
      try { const g = await persistence().listGallery(); galItems.value = g.items; galFolders.value = g.folders; }
      finally { galLoading.value = false; }
    }
    async function onGalLoadBin(kind: "trash" | "backup"): Promise<void> {   // 进恢复箱视图才拉（不拖慢每次开库）
      if (!galSignedIn.value) { galTrash.value = []; galBackup.value = []; return; }
      galLoading.value = true;
      try {
        const items = kind === "trash" ? await persistence().content.listTrash() : await persistence().content.listBackup();
        if (kind === "trash") galTrash.value = items; else galBackup.value = items;
      } catch { /* 保留旧值 */ } finally { galLoading.value = false; }
    }
    function onGalMove(p: { item: GalleryItem; folder: string }): void {
      const base = pathFolder(p.item.path) ? p.item.path.slice(p.item.path.lastIndexOf("/") + 1) : p.item.path;
      const rel = p.folder ? `${p.folder}/${base}` : base;
      const newPath = `${PAPERS_FOLDER}/${rel}`;
      if (newPath === p.item.path) return;
      void withGalleryBusy(async () => {
        await persistence().content.rename(p.item.path, newPath);
        if (p.item.docId) persistence().catalog.upsert(p.item.docId, { fileName: rel });
      }, "已移动", "移动失败(同名?)");
    }
    function onGalKeepOffline(it: GalleryItem): void {
      void withGalleryBusy(() => persistence().content.keepOffline(it.path), "已下载到本地", "下载失败(未登录/离线?)");
    }
    function onGalOffload(it: GalleryItem): void {
      void withGalleryBusy(async () => {
        await persistence().content.offload(it.path);
        showToast("已移除本地缓存");
      }, "", "移除缓存失败");
    }
    function onGalRestore(e: { cloudId: string; name: string; kind: "trash" | "backup" }): void {
      void withGalleryBusy(async () => { await persistence().content.restore(e.cloudId, `${PAPERS_FOLDER}/${e.name}`); await onGalLoadBin(e.kind); }, "已恢复", "恢复失败");
    }
    function onGalPurge(e: { cloudId: string; name: string; kind: "trash" | "backup" }): void {
      void withGalleryBusy(async () => { await persistence().content.purge(e.cloudId, appConfirm); await onGalLoadBin(e.kind); }, "", "删除失败");
    }
    async function onGalEmptyTrash(): Promise<void> {
      if (!(await appConfirm({ title: "清空回收站", body: "彻底删除全部，不可恢复", danger: true }))) return;
      await withGalleryBusy(async () => { await persistence().content.emptyTrash(); await onGalLoadBin("trash"); }, "已清空回收站", "清空失败");
    }
    async function withGalleryBusy(fn: () => Promise<void>, okMsg: string, failMsg: string): Promise<void> {
      galLoading.value = true;
      try { await fn(); if (okMsg) showToast(okMsg); } catch { showToast(failMsg); } finally { await refreshGallery(); }
    }
    function onGalRename(p: { item: GalleryItem; name: string }): void {
      const base = /\.pdf$/i.test(p.name) ? p.name : p.name + ".pdf";   // .pdf 是 JRP-specific，宿主补
      const parent = pathFolder(p.item.path);
      const newPath = parent ? `${parent}/${base}` : base;
      if (newPath === p.item.path) return;
      void withGalleryBusy(async () => {
        await persistence().content.rename(p.item.path, newPath);
        if (p.item.docId) persistence().catalog.upsert(p.item.docId, { fileName: newPath.slice(PAPERS_FOLDER.length + 1) });
      }, "已改名", "改名失败");
    }
    function onGalTrash(it: GalleryItem): void {
      void withGalleryBusy(async () => {
        await persistence().content.trash(it.path);
        if (it.docId) persistence().catalog.trash(it.docId);
      }, "已移到回收站", "删除失败");
    }
    function onGalNewFolder(p: { parent: string; name: string }): void {
      const rel = pathJoin(p.parent, p.name);
      void withGalleryBusy(() => persistence().content.ensureFolder(`${PAPERS_FOLDER}/${rel}`), "已建文件夹", "建文件夹失败");
    }
    function onGalUpload(p: { folder: string; files: File[] }): void {
      const base = p.folder ? `${PAPERS_FOLDER}/${p.folder}` : PAPERS_FOLDER;
      let last: { path: string; name: string; title: string } | null = null;   // 最后一份成功的，上传完自动打开(抄旧版 spec)
      void withGalleryBusy(async () => {
        let ok = 0; const failed: string[] = [];
        for (const f of p.files) {
          const stem = f.name.replace(/[\\/:*?"<>|]/g, "").replace(/\.pdf$/i, "").trim();
          const nm = stem + ".pdf";
          try {
            await persistence().content.upload(`${base}/${nm}`, f); ok++;
            last = { path: `${base}/${nm}`, name: p.folder ? `${p.folder}/${nm}` : nm, title: stem };
          } catch { failed.push(nm); }
        }
        if (!ok) throw new Error("none");
        showToast(failed.length ? `上传 ${ok} 个，${failed.length} 个失败(同名?)` : `已上传 ${ok} 个`);
      }, "", "上传失败(同名/未登录/离线?)").then(() => { if (last) void openPaper(last); });
    }
    function onGalFolderChange(folder: string): void { galCurrentFolder.value = folder; }

    // 拖拽上传(抄旧版 spec)：整窗监听、**任何模式都能拖**(阅读时也行)，不只开图库时。
    // dragenter 计数防抖(进子元素也 fire dragleave)；dragover 必 preventDefault 否则不触发 drop。
    // 落点：图库开着→当前文件夹；否则→papers 根。上传完 onGalUpload 自动打开最后一份。
    const dragActive = ref(false);
    let dragDepth = 0;
    const canDrop = (): boolean => galSignedIn.value;   // 上传需登录；未登录不亮蒙层、drop 提示登录
    function onDragEnter(e: DragEvent): void {
      if (!dtHasFiles(e.dataTransfer)) return;
      e.preventDefault(); if (!canDrop()) return;
      dragDepth += 1; dragActive.value = true;
    }
    function onDragOver(e: DragEvent): void {
      if (!dtHasFiles(e.dataTransfer)) return;
      e.preventDefault(); if (canDrop() && e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    }
    function onDragLeave(e: DragEvent): void {
      if (!dtHasFiles(e.dataTransfer)) return;
      dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) dragActive.value = false;
    }
    function onDrop(e: DragEvent): void {
      if (!dtHasFiles(e.dataTransfer)) return;
      e.preventDefault(); dragDepth = 0; dragActive.value = false;
      if (!canDrop()) { showToast("请先登录 OneDrive"); return; }
      const files = Array.from(e.dataTransfer?.files || []).filter((f) => /\.pdf$/i.test(f.name) || f.type === "application/pdf");
      if (!files.length) { showToast("不是 PDF，忽略"); return; }
      // 落点：图库开着→图库当前层；阅读模式→当前论文所在文件夹（user 钉）。
      onGalUpload({ folder: galleryOpen.value ? galCurrentFolder.value : currentPaperFolder.value, files });
    }

    function onGalDeleteFolder(rel: string): void {
      // store removeFolder：非空→抛(catch 提示)；不存在→返 false(已没了,也算成功)。
      void withGalleryBusy(() => persistence().content.deleteFolder(`${PAPERS_FOLDER}/${rel}`).then(() => undefined),
        "已删除空文件夹", "删除失败(文件夹非空?)");
    }

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
      // [perf] 打开慢在哪：开 devtools console 看 [jrp][perf] 各步耗时（content.read=取字节+云端 etag 检查 / 算哈希 / 渲染定位）。
      const P = (label: string, t0: number): void => console.info(`[jrp][perf] ${label}`, Math.round(performance.now() - t0), "ms");
      const tAll = performance.now();
      await withBusy("打开…", async () => {
        const t1 = performance.now();
        let blob: Blob | null = null;
        try { blob = await persistence().content.read(item.path); } catch { /* */ }
        P("content.read(取字节+云端etag检查)", t1);
        if (!blob) { showToast("读取失败(未登录/离线?)"); return; }
        const t2 = performance.now();
        const docId = await contentDocId(await blob.arrayBuffer());
        P("contentDocId(算哈希)", t2);
        const cat = persistence().catalog;
        if (!cat.get(docId)) cat.upsert(docId, { fileName: item.name, addedAt: nowMs() });
        else cat.upsert(docId, { fileName: item.name });
        cat.touch(docId);
        currentDocId.value = docId; title.value = item.title; pos.value = null; outline.value = [];
        currentPaperFolder.value = pathFolder(item.name);   // 阅读模式拖拽 → 落当前论文同夹
        const restore = cat.get(docId)?.position ?? null;
        const t3 = performance.now();
        await v()?.loadBlob(blob, { key: docId, pos: restore });
        P("loadBlob(渲染+定位到pagesloaded)", t3);
      });
      P("openPaper 总计", tAll);
    }
    function onGalleryOpen(it: GalleryItem): void { void openPaper({ path: it.path, name: it.name, title: it.title }); }

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
      // 拖拽上传整窗常驻(根组件不卸载,无需 remove)。
      window.addEventListener("dragenter", onDragEnter); window.addEventListener("dragover", onDragOver);
      window.addEventListener("dragleave", onDragLeave); window.addEventListener("drop", onDrop);
      const auth = persistence().auth;
      const acctName = (st: any): string => (st && st.account && (st.account.username || st.account.name)) || "";
      // boot 续读分两段，互不卡死：
      //  ①【带遮罩、唯一一次】从本地 catalog 续读并开论文/图库 —— 离线 / 未登录也走得通
      //     （catalog.init 在离线/未登录下 cloud sync 优雅降级为本地，绝不卡死遮罩；
      //      getToken 不再后台跳转，所以未登录时秒返回、遮罩立即抬起 → 进得了图库去登录）。
      //  ②【后台、不遮罩、不重开】登录态后到（silent 探测翻 signedIn）→ 把云端 catalog 并进来。
      let opened = false;      // 已 jumpscare（开过论文 / 已决定开图库）—— 只开一次，防双开双转
      let cloudSynced = false; // 登录后云端 catalog 已同步 —— 只跑一次后台续读
      async function doResume(overlay: boolean): Promise<void> {
        const run = async (): Promise<void> => {
          const tc = performance.now();
          await persistence().catalog.init();
          console.info("[jrp][perf] catalog.init", overlay ? "(本地续读)" : "(后台云同步)", Math.round(performance.now() - tc), "ms");
          if (!opened) { opened = true; jumpscare(); }
        };
        if (overlay) {
          try { await withBusy("打开…", run); } catch { if (!opened) { opened = true; galleryOpen.value = true; } }
        } else {
          try { await run(); } catch { /* 后台云同步失败无妨：本地已续读，下个 dirty 周期再推 */ }
        }
      }
      auth.onAuthChanged((st: any) => {
        galSignedIn.value = !!(st && st.signedIn);
        galAccount.value = acctName(st);
        void refreshGallery();
        // 登录态到达 → 后台云端 catalog 同步（不遮罩、不重开；论文/图库已由 ① 决定）。
        if (st && st.signedIn && !cloudSynced) { cloudSynced = true; void doResume(false); }
      });
      try {
        const st = await auth.initAuth();
        galSignedIn.value = !!st.signedIn;
        galAccount.value = acctName(st);
        if (st.signedIn) cloudSynced = true;   // 已登录：① 即云端续读，onAuthChanged 不再重复跑 ②
        await doResume(true);                   // 唯一带遮罩的续读；未登录/probing 也在此优雅落地
      } catch { await doResume(true); }
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
      currentDocId, title, pos, page, total, spread, themeLabel, appUi, saveLabel, buildId: BUILD_ID,
      galItems, galFolders, galLoading, galSignedIn, galAccount, galTrash, galBackup, dragActive,
      onGalRename, onGalTrash, onGalNewFolder, onGalDeleteFolder, onGalUpload, onGalFolderChange, refreshGallery,
      onGalLoadBin, onGalMove, onGalKeepOffline, onGalOffload, onGalRestore, onGalPurge, onGalEmptyTrash, confirmState, confirmAnswer,
      conflictUi, answerConflict, passwordUi, answerPassword, cloudCheckUi, skipToOffline,
      onGalSignin: (): void => { void persistence().auth.signIn(); },
      onGalSignout: (): void => { void persistence().auth.signOut(); },
      onGalleryOpen,
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
        <button class="jrp-icon" @click="toggleOutline" v-if="total" title="目录 / 阅读控制" aria-label="目录">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="14" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/></svg>
        </button>
        <span class="jrp-fname">{{ title || '打开论文库选一篇' }}</span>
        <span class="jrp-pos" v-if="total">p.{{ page }}/{{ total }}</span>
        <span class="jrp-save" :class="appUi.saveState" v-if="total && saveLabel" :title="'阅读位置 ' + saveLabel">{{ saveLabel }}</span>
        <button class="jrp-icon" :class="{ pad: !total }" @click="toggleMenu" title="菜单" aria-label="菜单">
          <svg viewBox="0 0 20 20" width="18" height="18"><path stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M4 6h12M4 10h12M4 14h12"/></svg>
        </button>
      </header>
      <div class="jrp-body">
        <Gallery v-if="galleryOpen" :items="galItems" :folders="galFolders" :signed-in="galSignedIn" :loading="galLoading" :account="galAccount" :trash="galTrash" :backup="galBackup"
          @open="onGalleryOpen" @close="galleryOpen = false" @toast="onToast" @refresh="refreshGallery" @loadbin="onGalLoadBin"
          @rename="onGalRename" @move="onGalMove" @trash="onGalTrash" @keepoffline="onGalKeepOffline" @offload="onGalOffload" @restore="onGalRestore" @purge="onGalPurge" @emptytrash="onGalEmptyTrash"
          @newfolder="onGalNewFolder" @deletefolder="onGalDeleteFolder" @upload="onGalUpload" @folderchange="onGalFolderChange"
          @signin="onGalSignin" @signout="onGalSignout" />
        <aside class="jrp-outline" v-if="outlineOpen">
          <div class="jrp-ctrlbar">
            <button class="jrp-ctrl" @click="zoomOut" title="缩小"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="7.5" y1="11" x2="14.5" y2="11"/></svg></button>
            <button class="jrp-ctrl" @click="fitWidth" title="适配宽度"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 8 4 4 8 4"/><polyline points="20 8 20 4 16 4"/><polyline points="4 16 4 20 8 20"/><polyline points="20 16 20 20 16 20"/><line x1="7" y1="12" x2="17" y2="12"/><polyline points="10 9 7 12 10 15"/><polyline points="14 9 17 12 14 15"/></svg></button>
            <button class="jrp-ctrl" @click="zoomIn" title="放大"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="7.5" y1="11" x2="14.5" y2="11"/><line x1="11" y1="7.5" x2="11" y2="14.5"/></svg></button>
            <button class="jrp-ctrl" @click="toggleSpread" :title="spread ? '切单页' : '切双页'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="8" height="14" rx="1"/><rect x="13" y="5" width="8" height="14" rx="1"/></svg></button>
            <button class="jrp-ctrl" @click="outlineOpen = false; overview()" title="页面总览"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg></button>
          </div>
          <div class="jrp-gal-list">
            <div class="jrp-ol-row" v-for="(o, i) in outlineFlat" :key="i" :style="{ paddingLeft: (10 + o.depth * 16) + 'px' }" @click="goToOutline(o.dest)">{{ o.title }}</div>
            <div v-if="!outlineFlat.length" class="jrp-gal-msg">此文档无目录</div>
          </div>
        </aside>
        <div class="jrp-backdrop" v-if="galleryOpen || outlineOpen" @click="galleryOpen = false; outlineOpen = false"></div>
        <div class="jrp-viewer-wrap"><Viewer ref="viewerRef" @position="onPos" @page="onPage" @spread="onSpread" @toast="onToast" @outline="onOutline" /></div>
      </div>
      <div class="jrp-menu-backdrop" v-if="menuOpen" @click="menuOpen = false"></div>
      <div class="jrp-menu" v-if="menuOpen">
        <template v-if="total">
          <button class="jrp-menu-item" @click="saveNow">保存阅读位置 · Ctrl+S</button>
          <button class="jrp-menu-item" @click="screenshot">截图当前页</button>
          <button class="jrp-menu-item" @click="copyText">复制当前页文本</button>
          <div class="jrp-menu-sep"></div>
        </template>
        <button class="jrp-menu-item" @click="cycleTheme">颜色模式 · {{ themeLabel }}</button>
        <button class="jrp-menu-item" @click="forceUpdate">强制更新 · <span class="jrp-build-id">{{ buildId }}</span></button>
      </div>
      <div class="jrp-confirm-backdrop" v-if="confirmState.open" @click="confirmAnswer(false)"></div>
      <div class="jrp-confirm" v-if="confirmState.open">
        <div class="jrp-confirm-title">{{ confirmState.title }}</div>
        <div class="jrp-confirm-body">{{ confirmState.body }}</div>
        <div class="jrp-confirm-btns">
          <button class="jrp-btn" @click="confirmAnswer(false)">取消</button>
          <button class="jrp-btn" :class="confirmState.danger ? 'jrp-btn-danger' : 'jrp-btn-dark'" @click="confirmAnswer(true)">确定</button>
        </div>
      </div>
      <div class="jrp-confirm-backdrop" v-if="conflictUi.open"></div>
      <div class="jrp-confirm" v-if="conflictUi.open">
        <div class="jrp-confirm-title">云端有冲突版本</div>
        <div class="jrp-confirm-body">「{{ conflictUi.name }}」云端被改过、你本地也改了。保留哪份？（另一份进 .backup，不丢）</div>
        <div class="jrp-confirm-btns">
          <button class="jrp-btn" @click="answerConflict('cancel')">先不动</button>
          <button class="jrp-btn" @click="answerConflict('takeCloud')">用云端</button>
          <button class="jrp-btn jrp-btn-dark" @click="answerConflict('keepMine')">保留我的</button>
        </div>
      </div>
      <div class="jrp-confirm-backdrop" v-if="passwordUi.open"></div>
      <div class="jrp-confirm" v-if="passwordUi.open">
        <div class="jrp-confirm-title">需要密码</div>
        <div class="jrp-confirm-body">「{{ passwordUi.name }}」是加密文件，输入密码。</div>
        <input class="jrp-gal-edit" type="password" v-model="passwordUi.input" @keydown.enter="answerPassword(passwordUi.input || null)" placeholder="密码" />
        <div class="jrp-confirm-btns">
          <button class="jrp-btn" @click="answerPassword(null)">取消</button>
          <button class="jrp-btn jrp-btn-dark" @click="answerPassword(passwordUi.input || null)">确定</button>
        </div>
      </div>
      <div class="jrp-busy" v-if="appUi.busy"><div class="jrp-busy-spin"></div><div class="jrp-busy-label">{{ appUi.busy }}</div><button class="jrp-btn jrp-busy-skip" v-if="cloudCheckUi.skippable" @click="skipToOffline">跳过到离线</button></div>
      <div class="jrp-toast jrp-update" v-if="appUi.updateAvailable" @click="forceUpdate">有新版本 · 点此刷新</div>
      <div class="jrp-toast" v-if="appUi.toast">{{ appUi.toast }}</div>
      <div class="jrp-drop-overlay" v-if="dragActive">
        <div class="jrp-drop-card">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
          <div class="jrp-drop-title">松手即上传</div>
          <div class="jrp-drop-hint">PDF 进论文库，并打开最后一份</div>
        </div>
      </div>
    </div>
  `,
});
