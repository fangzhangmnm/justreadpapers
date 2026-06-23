// ⚠ 使用前必读 STORE.md + MASTER.md §A。store 内部深模块——app 经 createStore 的 file.evict/unpin。
//
// evict（深模块）—— 取消缓存：删本地副本但**不动云端**（evict ≠ delete）。红线守卫全在此一处：
//   只驱逐 **clean ∧ 在线 ∧ 云端仍有 ∧ !pinned**；dirty/离线/cloud-gone/pinned 一律**保留**（不丢未推字节）。
//   离线 ⇒ 不可 re-fetch ⇒ 永不 evict（potential-bugs J6：飞机上恰恰是 evict 必须不触发的地方）。
// 逻辑零新红线 = 组合现有 head.isDirty / cloud.fetchMeta / local.exists/hardDelete + pin-set。
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { PinSet } from "./pin-set.ts";

export interface EvictResult {
  status: "evicted" | "kept";
  reason?: "dirty" | "offline" | "cloud-gone" | "pinned" | "not-cached";
}

export interface EvictCfg {
  cloud: Pick<CloudSync, "fetchMeta">;
  local: Pick<LocalCache, "exists" | "hardDelete">;
  head: Pick<LocalHead, "isDirty" | "forget">;
  pins: PinSet;
  isOnline?: () => boolean;
}

export function createEvict(cfg: EvictCfg) {
  const { cloud, local, head, pins, isOnline } = cfg;
  // force=true：unpin 后的显式驱逐也得过红线（dirty/离线/cloud-gone 仍保留），只跳过 pinned 检查。
  async function evict(name: string, opts: { force?: boolean } = {}): Promise<EvictResult> {
    if (!(await local.exists(name))) return { status: "kept", reason: "not-cached" };
    if (!opts.force && pins.has(name)) return { status: "kept", reason: "pinned" };
    if (head.isDirty(name)) return { status: "kept", reason: "dirty" };           // 未推字节绝不丢
    if (isOnline && !isOnline()) return { status: "kept", reason: "offline" };     // 离线不可重取 → 不驱逐
    const meta = await cloud.fetchMeta(name).catch(() => null);
    if (!meta) return { status: "kept", reason: "cloud-gone" };                    // 云端没了 → 这是唯一好副本，保留
    await local.hardDelete(name);   // clean ∧ 在线 ∧ 云端在 ∧ !pinned → 安全丢本地副本
    head.forget(name);              // 清云端谱系（下次 open 重新 acquire）
    return { status: "evicted" };
  }
  return { evict };
}
