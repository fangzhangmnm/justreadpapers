// Gallery —— 文件库**窄接口展示组件**(folder-tree paradigm,可复用 standalone div)。
// 设计(2026-06-23 user 钉):一个独立 div,兄弟项目挂上去就能用。**零 store / 零 persistence / 零 app-specific 指令**。
//   数据注入(props: items/folders/signedIn/loading)→ 组件内 sliceFolder 客户端切层 + 管 currentFolder/inline 编辑态。
//   操作 emit 意图(open/rename/trash/newfolder/upload/signin/signout/refresh),宿主执行(碰 store)后回灌 props。
// 导航 = 面包屑钻入式(全家共识,扁平路径+切片,零 tree-sync bug)。无 expand/collapse 树。
// 滚动:.jrp-gallery 固定高 flex 列,唯一滚动体 = .jrp-gal-list(flex:1 overflow),head/crumbs 固定不 grow。
import { defineComponent, ref, computed, onMounted } from "../vendor/vue/vue.esm-browser.prod.js";
import { sliceFolder, breadcrumb, pathJoin } from "../gallery-model.ts";
import type { GalleryItem } from "../gallery-model.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SetupCtx { emit: (e: string, payload?: unknown) => void; }

// 通用文件名清洗(剥非法字符)——文件系统卫生,非 app-specific(扩展名/路径由宿主补)。
function sanitizeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "").replace(/^\.+/, "").replace(/\s+/g, " ").trim().slice(0, 200);
}

export const Gallery = defineComponent({
  name: "Gallery",
  props: {
    items: { type: Array, default: () => [] as GalleryItem[] },   // 全部 item(相对根路径);切片在组件内
    folders: { type: Array, default: () => [] as string[] },       // 全部真文件夹(含空夹)=空夹单一真相源
    signedIn: { type: Boolean, default: false },
    loading: { type: Boolean, default: false },
  },
  emits: ["open", "close", "toast", "rename", "trash", "newfolder", "upload", "signin", "signout", "refresh"],
  setup(props: any, ctx: SetupCtx) {
    const currentFolder = ref("");
    const menuFor = ref<string | null>(null);     // ⋯ 菜单开在哪个 item.path
    const editing = ref<string | null>(null);     // 哪个 item.path 在 inline 改名
    const editVal = ref("");
    const newFolderMode = ref(false);
    const newFolderVal = ref("");

    const sliced = computed(() => sliceFolder(props.items as GalleryItem[], props.folders as string[], currentFolder.value));
    const crumbs = computed(() => breadcrumb(currentFolder.value));

    function go(path: string): void { currentFolder.value = path; menuFor.value = null; }
    function enter(sub: string): void { currentFolder.value = pathJoin(currentFolder.value, sub); menuFor.value = null; }

    function toggleMenu(it: GalleryItem): void { menuFor.value = menuFor.value === it.path ? null : it.path; }
    function startRename(it: GalleryItem): void { editing.value = it.path; editVal.value = it.title; menuFor.value = null; }
    function cancelRename(): void { editing.value = null; }
    // 组件只清洗 + emit 意图(item + 干净显示名);扩展名/路径/store 由宿主处理(保持窄接口、零 app-specific)。
    function commitRename(it: GalleryItem): void {
      if (editing.value !== it.path) return;
      editing.value = null;
      const clean = sanitizeName(editVal.value);
      if (!clean) return;
      ctx.emit("rename", { item: it, name: clean });
    }
    function doTrash(it: GalleryItem): void { menuFor.value = null; ctx.emit("trash", it); }

    function openNewFolder(): void { newFolderMode.value = true; newFolderVal.value = ""; }
    function commitNewFolder(): void {
      newFolderMode.value = false;
      const clean = sanitizeName(newFolderVal.value);
      if (clean) ctx.emit("newfolder", { parent: currentFolder.value, name: clean });
    }
    function onUpload(e: Event): void {
      const input = e.target as HTMLInputElement;
      const files = input.files ? Array.from(input.files) : [];
      input.value = "";   // 清空,允许再传同一文件
      if (files.length) ctx.emit("upload", { folder: currentFolder.value, files });
    }

    onMounted(() => { ctx.emit("refresh"); });   // 挂载即请宿主灌数据

    return {
      currentFolder, sliced, crumbs, menuFor, editing, editVal, newFolderMode, newFolderVal,
      go, enter, toggleMenu, startRename, cancelRename, commitRename, doTrash, openNewFolder, commitNewFolder, onUpload,
      refresh: (): void => ctx.emit("refresh"),
      signIn: (): void => ctx.emit("signin"),
      signOut: (): void => ctx.emit("signout"),
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
        <label class="jrp-newfolder" v-if="signedIn" title="上传 PDF 到此文件夹">{{ loading ? '…' : '＋传' }}
          <input type="file" accept="application/pdf" multiple @change="onUpload" :disabled="loading" hidden></label>
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
