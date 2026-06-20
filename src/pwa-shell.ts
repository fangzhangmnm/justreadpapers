// 页面侧 PWA shell:注册 service worker + 4 路更新检测,把"有新版本"事件交给 UI(回调驱动)。
// framework-agnostic —— Vue Toasts 组件订阅 onUpdateAvailable、点"刷新"时调 reload()。
// 抄 WebPaint 的 4 路检测(path 4 前台 poke = iPad 命门:iOS PWA 不会自己 updatefound),
// 但 greenfield 写法。/dev/ 与 localhost 不注册 SW(dev 改完即见;deploy 也从 /dev/ 删 SW)。

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

export interface PwaShellOptions {
  /** 检测到新版本(任一路径)→ 通知 UI 弹 toast。可能多次,UI 自己去重。 */
  onUpdateAvailable: () => void;
  /** 回前台(visibility/focus)→ app 可借机 reconcile 云端。 */
  onForeground?: () => void;
  /** 点"刷新"后、真 reload 前:app 落盘 / keepalive flush。 */
  onBeforeReload?: () => void | Promise<void>;
}

export interface PwaShell {
  /** dev 路由(/dev/ 或 localhost):UI 可据此显示 DEV 标。 */
  readonly isDevRoute: boolean;
  /** 应用等待中的新 SW 并 reload(toast"刷新"按钮调)。 */
  reload: () => Promise<void>;
}

export function initPwaShell(opts: PwaShellOptions): PwaShell {
  const isDevRoute = location.pathname.includes("/dev/") || LOCAL_HOSTS.has(location.hostname);
  let registration: ServiceWorkerRegistration | null = null;

  async function reload(): Promise<void> {
    try { await opts.onBeforeReload?.(); } catch { /* 落盘失败也得让用户能刷 */ }
    const reg = registration ?? (await navigator.serviceWorker?.getRegistration()) ?? null;
    if (!reg || !reg.waiting) { location.reload(); return; }
    const doReload = (): void => { location.reload(); };
    navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
    reg.waiting.postMessage({ type: "skip-waiting" });
    setTimeout(doReload, 5000);   // controllerchange 没来的兜底
  }

  if ("serviceWorker" in navigator && !isDevRoute) {
    // path 3:SW 后台 revalidate 检测到资源变化 → postMessage "asset-updated"
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
      if ((e.data as { type?: string } | null)?.type === "asset-updated") opts.onUpdateAvailable();
    });
    window.addEventListener("load", () => {
      void navigator.serviceWorker.register("./service-worker.js").then((reg) => {
        registration = reg;
        // path 1:注册时已有 waiting(冷启动遇到 registration.waiting)
        if (reg.waiting && navigator.serviceWorker.controller) opts.onUpdateAvailable();
        // path 2:updatefound → 新 worker installed(且已有 controller = 是更新不是首装)
        reg.addEventListener("updatefound", () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", () => {
            if (sw.state === "installed" && navigator.serviceWorker.controller) opts.onUpdateAvailable();
          });
        });
        // path 4(iPad 命门):回前台 poke reg.update() + 10min 轮询
        const poke = (): void => { void reg.update().catch(() => {}); };
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") { poke(); opts.onForeground?.(); }
        });
        window.addEventListener("focus", () => { poke(); opts.onForeground?.(); });
        setInterval(poke, 10 * 60 * 1000);
      }).catch((err: unknown) => { console.warn("[pwa] SW 注册失败", err); });
    });
  }

  return { isDevRoute, reload };
}
