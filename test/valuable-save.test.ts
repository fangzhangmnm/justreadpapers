import { test, eq, assert, tick } from "./_harness.ts";
import { createValuableSave } from "../src/domain/valuable-save.ts";

// 假时钟 + 假定时器:手动 advance,定时器到点同步触发。
function fakeClock() {
  let t = 0;
  let nextId = 1;
  let timers: { id: number; fn: () => void; at: number }[] = [];
  return {
    now: (): number => t,
    setTimer: (fn: () => void, ms: number): unknown => { const id = nextId++; timers.push({ id, fn, at: t + ms }); return id; },
    clearTimer: (h: unknown): void => { timers = timers.filter((x) => x.id !== h); },
    advance: (ms: number): void => {
      t += ms;
      const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at);
      timers = timers.filter((x) => x.at > t);
      for (const d of due) d.fn();
    },
    pending: (): number => timers.length,
  };
}

test("mark → 防抖窗口满才 commit 一次", async () => {
  const c = fakeClock();
  let commits = 0;
  const vs = createValuableSave({
    commit: async () => { commits++; },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    debounceMs: 10_000, ceilingMs: 30_000,
  });
  vs.mark();
  assert(vs.isDirty(), "mark 后应脏");
  c.advance(9_999);
  eq(commits, 0, "防抖未满不 commit");
  c.advance(1);
  await tick();
  eq(commits, 1, "10s 后 commit 一次");
  assert(!vs.isDirty(), "commit 后不脏");
});

test("连续 mark 重置防抖,但 ceiling 封顶保证至少推一次", async () => {
  const c = fakeClock();
  let commits = 0;
  const vs = createValuableSave({
    commit: async () => { commits++; },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
    debounceMs: 10_000, ceilingMs: 30_000,
  });
  // 每 5s mark 一次(防抖永不自然到点),到 30s ceiling 应强推。
  for (let i = 0; i < 6; i++) { vs.mark(); c.advance(5_000); }
  await tick();
  eq(commits, 1, "ceiling 30s 处强推一次");
});

test("markTrivial 不调度定时器,但标脏 → flush 顺带带上", async () => {
  const c = fakeClock();
  let commits = 0;
  const vs = createValuableSave({
    commit: async () => { commits++; },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  vs.markTrivial();
  assert(vs.isDirty(), "trivial 也标脏");
  eq(c.pending(), 0, "trivial 不排定时器");
  c.advance(60_000);
  eq(commits, 0, "trivial 永不自己触发 commit");
  await vs.flush();
  eq(commits, 1, "flush 把 trivial 改动带上");
});

test("flush 立即 commit 并清脏", async () => {
  const c = fakeClock();
  let commits = 0;
  const vs = createValuableSave({
    commit: async () => { commits++; },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  vs.mark();
  await vs.flush();
  eq(commits, 1, "flush 立即 commit");
  assert(!vs.isDirty(), "flush 后不脏");
  eq(c.pending(), 0, "flush 取消了防抖定时器");
});

test("commit 失败 → 保脏待重试", async () => {
  const c = fakeClock();
  let fail = true;
  let commits = 0;
  const vs = createValuableSave({
    commit: async () => { commits++; if (fail) throw new Error("boom"); },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  vs.mark();
  try { await vs.flush(); } catch { /* expected */ }
  assert(vs.isDirty(), "commit 失败应保脏");
  fail = false;
  await vs.flush();
  eq(commits, 2, "第二次 flush 重试成功");
  assert(!vs.isDirty(), "重试成功后不脏");
});

test("不脏时 flush / flushKeepalive 是 noop", async () => {
  const c = fakeClock();
  let commits = 0; let keepalives = 0;
  const vs = createValuableSave({
    commit: async () => { commits++; },
    keepalive: () => { keepalives++; },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  await vs.flush();
  vs.flushKeepalive();
  eq(commits, 0, "不脏不 commit");
  eq(keepalives, 0, "不脏不 keepalive");
});

test("flushKeepalive 脏时同步触发 keepalive", () => {
  const c = fakeClock();
  let keepalives = 0;
  const vs = createValuableSave({
    commit: async () => {},
    keepalive: () => { keepalives++; },
    now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer,
  });
  vs.mark();
  vs.flushKeepalive();
  eq(keepalives, 1, "脏时 keepalive 一次");
  eq(c.pending(), 0, "keepalive 取消了防抖");
});
