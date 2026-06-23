// Gallery —— 文件库**窄接口展示组件**(folder-tree paradigm,可复用 standalone div)。
// 设计(2026-06-23 user 钉):一个独立 div,兄弟项目挂上去就能用。**零 store / 零 persistence / 零 app-specific 指令**。
//   数据注入(props: items/folders/signedIn/loading)→ 组件内 sliceFolder 客户端切层 + 管 currentFolder/inline 编辑态。
//   操作 emit 意图(open/rename/trash/newfolder/upload/signin/signout/refresh),宿主执行(碰 store)后回灌 props。
// 导航 = 面包屑钻入式(全家共识,扁平路径+切片,零 tree-sync bug)。无 expand/collapse 树。
// 滚动:.jrp-gallery 固定高 flex 列,唯一滚动体 = .jrp-gal-list(flex:1 overflow),head/crumbs 固定不 grow。
import { defineComponent, ref, computed, onMounted, onUnmounted } from "../vendor/vue/vue.esm-browser.prod.js";
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
    account: { type: String, default: "" },   // 已登录账号显示名（宿主从 auth 注入；窄接口先这样，folder-tree 后统一收）
  },
  emits: ["open", "close", "toast", "rename", "trash", "newfolder", "deletefolder", "upload", "signin", "signout", "refresh"],
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
    function toggleFolderMenu(fd: string): void { const k = "fd:" + fd; menuFor.value = menuFor.value === k ? null : k; }   // folder ⋯ 菜单(键加 fd: 前缀,不与文件 path 撞)

    // smart cloud 按钮（抄 WebPaint cloud-auth-ui）：点开**账号 popup**（账号 + 登录/登出/刷新），不直接登出。
    // icon：未登录=空心云、已登录=云+勾；颜色 data-cloud-state（已登录=accent，未登录=灰，离线=琥珀）。
    const online = ref(typeof navigator !== "undefined" ? navigator.onLine : true);
    function syncOnline(): void { online.value = navigator.onLine; }
    const accountOpen = ref(false);
    const cloudState = computed(() => props.loading ? "busy" : !props.signedIn ? "no-auth" : !online.value ? "offline" : "signedin");
    const accountInfo = computed(() => props.signedIn
      ? `云端：${props.account || "已登录"}${online.value ? "" : "（离线）"}`
      : (online.value ? "云端：未登录" : "云端：离线"));
    function toggleAccount(): void { accountOpen.value = !accountOpen.value; menuFor.value = null; }
    function doSignin(): void { accountOpen.value = false; ctx.emit("signin"); }
    function doSignout(): void { accountOpen.value = false; ctx.emit("signout"); }
    function doRefresh(): void { accountOpen.value = false; ctx.emit("refresh"); }
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

    function deleteFolder(fd: string): void {
      menuFor.value = null;
      ctx.emit("deletefolder", pathJoin(currentFolder.value, fd));   // 删空夹意图;非空由 store 拒(宿主 toast)
    }
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

    onMounted(() => { ctx.emit("refresh"); window.addEventListener("online", syncOnline); window.addEventListener("offline", syncOnline); });   // 挂载即请宿主灌数据 + 监听在线态
    onUnmounted(() => { window.removeEventListener("online", syncOnline); window.removeEventListener("offline", syncOnline); });

    return {
      currentFolder, sliced, crumbs, menuFor, editing, editVal, newFolderMode, newFolderVal,
      cloudState, accountOpen, accountInfo, toggleAccount, doSignin, doSignout, doRefresh, toggleFolderMenu,
      go, enter, toggleMenu, startRename, cancelRename, commitRename, doTrash, deleteFolder, openNewFolder, commitNewFolder, onUpload,
      refresh: (): void => ctx.emit("refresh"),
      open: (it: GalleryItem): void => ctx.emit("open", it),
      close: (): void => ctx.emit("close"),
    };
  },
  template: `
    <aside class="jrp-gallery">
      <div class="jrp-gal-head">
        <button class="jrp-icon jrp-cloud" :data-state="cloudState" @click="toggleAccount" title="云端账号">
          <svg v-if="!signedIn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/><polyline points="9 13 11 15 15 11"/></svg>
        </button>
        <template v-if="signedIn">
          <button class="jrp-icon" @click="openNewFolder" title="新建文件夹"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg></button>
          <label class="jrp-icon" :title="loading ? '上传中…' : '上传 PDF 到此文件夹'"><svg v-if="!loading" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span v-else>…</span>
            <input type="file" accept="application/pdf" multiple @change="onUpload" :disabled="loading" hidden></label>
        </template>
      </div>
      <template v-if="accountOpen">
        <div class="jrp-acct-backdrop" @click="accountOpen = false"></div>
        <div class="jrp-acct-pop">
          <div class="jrp-acct-info">{{ accountInfo }}</div>
          <button v-if="!signedIn" class="jrp-menu-item" @click="doSignin">登录 OneDrive</button>
          <template v-else>
            <button class="jrp-menu-item" @click="doRefresh">刷新云端列表</button>
            <button class="jrp-menu-item" @click="doSignout">退出登录</button>
          </template>
        </div>
      </template>
      <nav class="jrp-crumbs">
        <a @click="go('')">根目录</a>
        <template v-for="c in crumbs"><span class="jrp-crumb-sep">/</span><a @click="go(c.path)">{{ c.name }}</a></template>
      </nav>
      <div class="jrp-newfolder-row" v-if="newFolderMode">
        <input class="jrp-gal-edit" :value="newFolderVal" @input="newFolderVal = $event.target.value"
          @keydown.enter="commitNewFolder" @keydown.esc="newFolderMode = false" @blur="commitNewFolder"
          placeholder="文件夹名" autofocus>
      </div>
      <div class="jrp-gal-list">
        <div v-if="loading" class="jrp-gal-msg">加载中…</div>
        <template v-else>
          <div class="jrp-gal-file-row" v-for="fd in sliced.subfolders" :key="'f'+fd">
            <div class="jrp-gal-folder" @click="enter(fd)">
              <svg class="jrp-folder-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>{{ fd }}
            </div>
            <template v-if="menuFor === 'fd:'+fd">
              <button class="jrp-gal-act jrp-act-del" @click="deleteFolder(fd)" title="删除空文件夹"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
              <button class="jrp-gal-act" @click="toggleFolderMenu(fd)" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
            </template>
            <button v-else class="jrp-gal-dots" @click.stop="toggleFolderMenu(fd)" title="更多"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
          </div>
          <div class="jrp-gal-file-row" v-for="it in sliced.files" :key="it.path">
            <input v-if="editing === it.path" class="jrp-gal-edit" :value="editVal"
              @input="editVal = $event.target.value" @keydown.enter="commitRename(it)"
              @keydown.esc="cancelRename" @blur="commitRename(it)" autofocus>
            <template v-else>
              <div class="jrp-gal-file" :class="{ cached: it.cached }" @click="open(it)">{{ it.title }}</div>
              <template v-if="menuFor === it.path">
                <button class="jrp-gal-act" @click="startRename(it)" title="改名"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg></button>
                <button class="jrp-gal-act jrp-act-del" @click="doTrash(it)" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
                <button class="jrp-gal-act" @click="toggleMenu(it)" title="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
              </template>
              <button v-else class="jrp-gal-dots" @click.stop="toggleMenu(it)" title="更多"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg></button>
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
