// 极简测试 harness —— node 直跑(strip-types),零依赖。test() 入队,run() 顺序跑 + 汇总。
interface Case { name: string; fn: () => void | Promise<void>; }
const queue: Case[] = [];

export function test(name: string, fn: () => void | Promise<void>): void { queue.push({ name, fn }); }
export function assert(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
export function eq<X>(a: X, b: X, msg: string): void {
  if (a !== b) throw new Error(`${msg}: ${String(a)} !== ${String(b)}`);
}

export async function run(): Promise<void> {
  let pass = 0;
  const fails: string[] = [];
  for (const c of queue) {
    try { await c.fn(); pass++; console.log(`  ✓ ${c.name}`); }
    catch (e) { fails.push(c.name); console.log(`  ✗ ${c.name} — ${(e as Error).message}`); }
  }
  console.log(`\n${pass} passed, ${fails.length} failed`);
  if (fails.length) process.exitCode = 1;
}

/** 让 module 内挂起的 microtask/已 resolve 的 promise 链跑完(测异步 commit 用)。 */
export function tick(): Promise<void> { return new Promise<void>((r) => setTimeout(r, 0)); }
