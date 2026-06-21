// Gallery 文件 sidebar(深模块 paradigm)。自包含:用 persistence 单例,listGallery + sliceFolder 切层,
// 直调 content/flow(不重复 cloud)。cloud header(登录/登出/状态)在 panel 内。emit open/toast 给 shell。
// 3b:列表+导航+打开。3c:⋯菜单 改名/删除 + 新建文件夹(inline 输入,无 system dialog)。
import { defineComponent, ref, computed, onMounted } from "../vendor/vue/vue.esm-browser.prod.js";
import { sliceFolder, breadcrumb, pathFolder } from "../gallery-model.ts";
import type { GalleryItem } from "../gallery-model.ts";
import { persistence } from "../app-state.ts";
import { PAPERS_FOLDER } from "../config.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SetupCtx { emit: (e: string, payload?: unknown) => void; }

function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").replace(/^\.+/, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export const Gallery = defineComponent({
  name: "Gallery",
  emits: ["open", "close", "toast"],
  setup(_props: unknown, ctx: SetupCtx) {
    const items = ref<GalleryItem[]>([]);
    const folders = ref<string[]>([]);
    const currentFolder = ref("");
    const loading = ref(false);
    const signedIn = ref(false);
    const menuFor = ref<string | null>(null);     // ⋯ 菜单开在哪个 item.path
    const editing = ref<string | null>(null);     // 哪个 item.path 在 inline 改名
    const editVal = ref("");
    const newFolderMode = ref(false);
    const newFolderVal = ref("");

    const sliced = computed(() => sliceFolder(items.value, folders.value, currentFolder.value));
    const crumbs = computed(() => breadcrumb(currentFolder.value));
    const content = (): any => persistence().content;
    const catalog = (): any => persistence().catalog;

    async function refresh(): Promise<void> {
      menuFor.value = null;
      if (!signedIn.value) { items.value = []; folders.value = []; return; }
      loading.value = true;
      try { const g = await persistence().listGallery(); items.value = g.items; folders.value = g.folders; }
      finally { loading.value = false; }
    }
    function go(path: string): void { currentFolder.value = path; menuFor.value = null; }
    function enter(sub: string): void { currentFolder.value = currentFolder.value ? `${currentFolder.value}/${sub}` : sub; menuFor.value = null; }

    function toggleMenu(it: GalleryItem): void { menuFor.value = menuFor.value === it.path ? null : it.path; }
    function startRename(it: GalleryItem): void { editing.value = it.path; editVal.value = it.title; menuFor.value = null; }
    function cancelRename(): void { editing.value = null; }
    async function commitRename(it: GalleryItem): Promise<void> {
      if (editing.value !== it.path) return;
      editing.value = null;
      const clean = sanitizeName(editVal.value);
      if (!clean) return;
      const base = /\.pdf$/i.test(clean) ? clean : clean + ".pdf";
      const parent = pathFolder(it.path);
      const newPath = parent ? `${parent}/${base}` : base;
      if (newPath === it.path) return;
      try {
        await content().rename(it.path, newPath);
        if (it.docId) catalog().upsert(it.docId, { fileName: newPath.slice(PAPERS_FOLDER.length + 1) });
        ctx.emit("toast", "已改名");
        await refresh();
      } catch { ctx.emit("toast", "改名失败"); }
    }
    async function doTrash(it: GalleryItem): Promise<void> {
      menuFor.value = null;
      try {
        await content().trash(it.path);
        if (it.docId) catalog().trash(it.docId);
        ctx.emit("toast", "已移到回收站");
        await refresh();
      } catch { ctx.emit("toast", "删除失败"); }
    }
    function openNewFolder(): void { newFolderMode.value = true; newFolderVal.value = ""; }
    async function commitNewFolder(): Promise<void> {
      newFolderMode.value = false;
      const clean = sanitizeName(newFolderVal.value);
      if (!clean) return;
      const rel = currentFolder.value ? `${currentFolder.value}/${clean}` : clean;
      try { await content().ensureFolder(`${PAPERS_FOLDER}/${rel}`); ctx.emit("toast", "已建文件夹"); await refresh(); }
      catch { ctx.emit("toast", "建文件夹失败"); }
    }

    onMounted(() => {
      const auth = persistence().auth;
      signedIn.value = auth.getAuthState().signedIn;
      auth.onAuthChanged((st: any) => { signedIn.value = !!(st && st.signedIn); void refresh(); });
      void refresh();
    });

    return {
      items, folders, currentFolder, loading, signedIn, sliced, crumbs,
      menuFor, editing, editVal, newFolderMode, newFolderVal,
      refresh, go, enter, toggleMenu, startRename, cancelRename, commitRename, doTrash, openNewFolder, commitNewFolder,
      signIn: (): void => { void persistence().auth.signIn(); },
      signOut: (): void => { void persistence().auth.signOut(); },
      open: (it: GalleryItem): void => ctx.emit("open", it),
      close: (): void => ctx.emit("close"),
    };
  },
  template: `
    <aside class="jrp-gallery">
      <div class="jrp-gal-head">
        <button class="jrp-btn" @click="close" title="关闭">关闭</button>
        <template v-if="signedIn">
          <span class="jrp-gal-acct">已登录</span>
          <button class="jrp-btn" @click="refresh" title="刷新">刷新</button>
          <button class="jrp-btn" @click="signOut">登出</button>
        </template>
        <button class="jrp-btn jrp-btn-dark" v-else @click="signIn">登录 OneDrive</button>
      </div>
      <nav class="jrp-crumbs">
        <a @click="go('')">论文</a>
        <template v-for="c in crumbs"><span class="jrp-crumb-sep">/</span><a @click="go(c.path)">{{ c.name }}</a></template>
        <button class="jrp-newfolder" v-if="signedIn" @click="openNewFolder" title="新建文件夹">＋夹</button>
      </nav>
      <div class="jrp-newfolder-row" v-if="newFolderMode">
        <input class="jrp-gal-edit" :value="newFolderVal" @input="newFolderVal = $event.target.value"
          @keydown.enter="commitNewFolder" @keydown.esc="newFolderMode = false" @blur="commitNewFolder"
          placeholder="文件夹名" autofocus>
      </div>
      <div class="jrp-gal-list">
        <div v-if="loading" class="jrp-gal-msg">加载中…</div>
        <template v-else>
          <div class="jrp-gal-folder" v-for="fd in sliced.subfolders" :key="'f'+fd" @click="enter(fd)">
            <span class="jrp-tri">▸</span>{{ fd }}
          </div>
          <div class="jrp-gal-file-row" v-for="it in sliced.files" :key="it.path">
            <input v-if="editing === it.path" class="jrp-gal-edit" :value="editVal"
              @input="editVal = $event.target.value" @keydown.enter="commitRename(it)"
              @keydown.esc="cancelRename" @blur="commitRename(it)" autofocus>
            <template v-else>
              <div class="jrp-gal-file" :class="{ cached: it.cached }" @click="open(it)">{{ it.title }}</div>
              <template v-if="menuFor === it.path">
                <button class="jrp-gal-act" @click="startRename(it)">改名</button>
                <button class="jrp-gal-act jrp-act-del" @click="doTrash(it)">删除</button>
                <button class="jrp-gal-act" @click="toggleMenu(it)">×</button>
              </template>
              <button v-else class="jrp-gal-dots" @click.stop="toggleMenu(it)" title="更多">⋯</button>
            </template>
          </div>
          <div v-if="!sliced.subfolders.length && !sliced.files.length" class="jrp-gal-msg">
            {{ signedIn ? '这个文件夹空空的' : '登录 OneDrive 看你的论文' }}
          </div>
        </template>
      </div>
    </aside>
  `,
});
