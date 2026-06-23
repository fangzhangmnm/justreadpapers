// ⚠ 使用前必读 STORE.md。store 内部深模块——app 不直接 import，经 createStore 的 file.pin/unpin。
//
// pin-set（深模块）—— 追踪「本设备要离线常驻哪些文件」。pin = per-device、不同步（你在这台 pin 了
// 一本书要飞机上看，与别的设备无关）→ 住 kv（localStorage），不进同步 envelope。
// 红线（state-machine §1-2、potential-bugs I6）：pin 与冲突正交，只抬高可用性；**pinned 永不被驱逐**。
import type { Kv } from "./types.ts";

export interface PinSet {
  has(name: string): boolean;
  add(name: string): void;
  remove(name: string): void;
}

export function createPinSet(kv: Kv, prefix = "pin"): PinSet {
  const key = (n: string): string => `${prefix}:${n}`;
  return {
    has: (n) => kv.get(key(n)) === "1",
    add: (n) => kv.set(key(n), "1"),
    remove: (n) => kv.remove(key(n)),
  };
}
