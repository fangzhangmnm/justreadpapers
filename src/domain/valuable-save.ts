// ─────────────────────────────────────────────────────────────────────────
// "有价值的保存"调度器 —— 纯时间策略,零 IO / 零 store / 零 DOM。
// 看 ARCHIVE/session.js 的算法重写(不抄):决定"何时值得 commit 一次阅读位置",
// 吃掉鼠标 fidget / loitering,别把 OneDrive 版本史塞爆。真正落盘由注入的 commit 做
// (JRP 里 = catalog.commitNow → folder-store flush)。
//
// 机制(对应旧 session.js 的 scheduleWrite/flush/flushKeepalive):
//  - mark()           有意义改动 → 标脏 + 排防抖(每次重置 debounceMs)+ 从 firstDirty 起 ceilingMs 封顶
//                     (持续滚动也至少 ceilingMs 推一次)。
//  - markTrivial()    微动(同页小 yΔ)→ 只标脏不调度;等下次 mark 或 flushKeepalive 顺带带上。
//  - flush()          显式落盘(若脏):取消防抖、commit;inFlight 防重叠;失败保脏待重试。
//  - flushKeepalive() unload/hidden:同步 fire-and-forget(可丢 1 次,代价 < 阻塞 unload)。
//
// 时钟/定时器可注入 → 纯逻辑可单测,不靠真实时间。trivial 判定(位置比较)是域逻辑,留在调用方,
// 这里只管时间策略,保持泛型。

export interface ValuableSaveConfig {
  /** 真正落盘。返回 Promise(用于 inFlight 防重叠 + 失败保脏)。 */
  commit: () => Promise<void>;
  /** 同步 keepalive 落盘(unload/hidden)。不配则退化为 fire-and-forget commit()。 */
  keepalive?: () => void;
  /** 每次 mark 重置的防抖窗口。默认 10s。 */
  debounceMs?: number;
  /** 从 firstDirty 起的封顶:持续 mark 也保证这个 rate 至少推一次。默认 30s。 */
  ceilingMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface ValuableSave {
  /** 有意义改动:标脏 + 排防抖/ceiling。 */
  mark: () => void;
  /** 微动:标脏但不调度(trivial-skip)。 */
  markTrivial: () => void;
  /** 立即落盘(若脏)。 */
  flush: () => Promise<void>;
  /** keepalive 落盘(若脏,同步 fire-and-forget)。 */
  flushKeepalive: () => void;
  isDirty: () => boolean;
  /** 当前是否有 commit 在飞。 */
  isInFlight: () => boolean;
  dispose: () => void;
}

export function createValuableSave(cfg: ValuableSaveConfig): ValuableSave {
  const commit = cfg.commit;
  const keepalive = cfg.keepalive ?? ((): void => { void commit(); });
  const debounceMs = cfg.debounceMs ?? 10_000;
  const ceilingMs = cfg.ceilingMs ?? 30_000;
  const now = cfg.now ?? ((): number => Date.now());
  const setTimer = cfg.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = cfg.clearTimer ?? ((h: unknown): void => { clearTimeout(h as ReturnType<typeof setTimeout>); });

  let dirty = false;
  let firstDirtyAt = 0;       // 0 = 当前不脏的起点;>0 = 第一次变脏的时刻(ceiling 锚)
  let timer: unknown = null;
  let inFlight: Promise<void> | null = null;

  function touch(): void {
    if (!dirty) firstDirtyAt = now();   // 干净→脏的瞬间锚 ceiling(用 dirty 转变判定,避免 now()=0 撞 0 哨兵)
    dirty = true;
  }
  function clearPending(): void {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }
  function schedule(): void {
    clearPending();
    const t = now();
    // 防抖重置到 t+debounceMs,但封顶在 firstDirtyAt+ceilingMs(持续活动不至于永不推)。
    const target = Math.min(t + debounceMs, firstDirtyAt + ceilingMs);
    const wait = Math.max(0, target - t);
    timer = setTimer((): void => { timer = null; void flush().catch((): void => {}); }, wait);
  }

  function mark(): void { touch(); schedule(); }
  function markTrivial(): void { touch(); }

  async function flush(): Promise<void> {
    // 已有 commit 在飞 → 等它完,再看期间是否又脏。
    if (inFlight) {
      try { await inFlight; } catch { /* 上一轮的错由上一轮抛;这里只是等它让位 */ }
      if (!dirty) return;
    }
    if (!dirty) return;
    clearPending();
    // 把脏标移交给这次 commit:期间又 mark 会重新置脏 + 重起 ceiling。
    dirty = false;
    const ceilingMark = firstDirtyAt;
    firstDirtyAt = 0;
    inFlight = (async (): Promise<void> => {
      try {
        await commit();
      } catch (e) {
        // 失败保脏 + 恢复 ceiling 锚(期间没新 mark 才恢复;有新 mark 则保留其锚)→ 下次重试。
        if (!dirty) { dirty = true; firstDirtyAt = ceilingMark; }
        throw e;
      }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }

  function flushKeepalive(): void {
    if (!dirty) return;
    clearPending();
    keepalive();
  }

  return {
    mark, markTrivial, flush, flushKeepalive,
    isDirty: (): boolean => dirty,
    isInFlight: (): boolean => inFlight !== null,
    dispose: clearPending,
  };
}
