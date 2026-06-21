// Gallery 文件 sidebar(深模块 paradigm)。自包含:用 app-state 单例的 persistence,自己 listGallery +
// sliceFolder 切当前层,直调 content/flow(不重复 cloud)。cloud header(登录/登出/状态)**在 panel 内**
// (user 定:云管理跟文件 panel 一起)。emit "open"(item) 给 shell 去 viewer。
// 本轮(3b):header + 面包屑 + 文件夹导航 + 文件列表 + 打开。rename/trash/新建夹 + ⋯菜单 = 3c。
import { defineComponent, ref, computed, onMounted } from "../vendor/vue/vue.esm-browser.prod.js";
import { sliceFolder, breadcrumb } from "../gallery-model.ts";
import type { GalleryItem } from "../gallery-model.ts";
import { persistence } from "../app-state.ts";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface SetupCtx { emit: (e: string, payload?: unknown) => void; }

export const Gallery = defineComponent({
  name: "Gallery",
  emits: ["open", "close"],
  setup(_props: unknown, ctx: SetupCtx) {
    const items = ref<GalleryItem[]>([]);
    const folders = ref<string[]>([]);
    const currentFolder = ref("");
    const loading = ref(false);
    const signedIn = ref(false);
    const complete = ref(true);

    const sliced = computed(() => sliceFolder(items.value, folders.value, currentFolder.value));
    const crumbs = computed(() => breadcrumb(currentFolder.value));

    async function refresh(): Promise<void> {
      if (!signedIn.value) { items.value = []; folders.value = []; return; }
      loading.value = true;
      try {
        const g = await persistence().listGallery();
        items.value = g.items; folders.value = g.folders; complete.value = g.complete;
      } finally { loading.value = false; }
    }
    function go(path: string): void { currentFolder.value = path; }
    function enter(sub: string): void { currentFolder.value = currentFolder.value ? `${currentFolder.value}/${sub}` : sub; }

    onMounted(() => {
      const auth = persistence().auth;
      signedIn.value = auth.getAuthState().signedIn;
      auth.onAuthChanged((st: any) => { signedIn.value = !!st.signedIn; void refresh(); });
      void refresh();
    });

    return {
      items, folders, currentFolder, loading, signedIn, complete, sliced, crumbs,
      refresh, go, enter,
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
      </nav>
      <div class="jrp-gal-list">
        <div v-if="loading" class="jrp-gal-msg">加载中…</div>
        <template v-else>
          <div class="jrp-gal-folder" v-for="fd in sliced.subfolders" :key="'f'+fd" @click="enter(fd)">
            <span class="jrp-tri">▸</span>{{ fd }}
          </div>
          <div class="jrp-gal-file" :class="{ cached: it.cached }" v-for="it in sliced.files" :key="it.path" @click="open(it)">
            {{ it.title }}
          </div>
          <div v-if="!sliced.subfolders.length && !sliced.files.length" class="jrp-gal-msg">
            {{ signedIn ? '这个文件夹空空的' : '登录 OneDrive 看你的论文' }}
          </div>
        </template>
      </div>
    </aside>
  `,
});
