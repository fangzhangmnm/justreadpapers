// ⚠ 使用前必读 STORE.md + MASTER.md §A。store 内部深模块——app 经 createStore 的 file.offload。
//
// offload（深模块）—— 移除本地副本（offload ≠ delete：只丢本地，云端不动）。红线守卫全在此一处：
//   只 offload **clean ∧ 在线 ∧ 云端仍有完整副本**；dirty / 离线 / 未登录 / cloud-gone 一律**保留**（不丢未推字节）。
//   离线/未登录 ⇒ 不可 re-fetch ⇒ 永不 offload（飞机 / 无账号恰恰是绝不能丢本地的地方）。
//   **无 LRU、无 pin flag**：本地副本本身 = "kept offline"，去留只由用户显式 offload 决定；本模块只守红线。
// 逻辑零新红线 = 组合现有 head.isDirty / cloud.fetchMeta / local.exists/hardDelete。
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";

export interface OffloadResult {
  status: "offloaded" | "kept";
  reason?: "dirty" | "offline" | "cloud-gone" | "not-cached";
}

export interface OffloadCfg {
  cloud: Pick<CloudSync, "fetchMeta">;
  local: Pick<LocalCache, "exists" | "hardDelete">;
  head: Pick<LocalHead, "isDirty" | "forget">;
  isOnline?: () => boolean;
}

export function createOffload(cfg: OffloadCfg) {
  const { cloud, local, head, isOnline } = cfg;
  // offload 永远是用户显式动作（无自动 LRU）→ 无 pin-protection 这一档；红线守卫（dirty/离线/cloud-gone）不可越。
  async function offload(name: string): Promise<OffloadResult> {
    if (!(await local.exists(name))) return { status: "kept", reason: "not-cached" };
    if (head.isDirty(name)) return { status: "kept", reason: "dirty" };            // 未推字节绝不丢
    if (isOnline && !isOnline()) return { status: "kept", reason: "offline" };      // 离线/未登录不可重取 → 不 offload
    const meta = await cloud.fetchMeta(name).catch(() => null);
    if (!meta) return { status: "kept", reason: "cloud-gone" };                     // 云端没了/未登录取不到 → 唯一好副本，保留
    await local.hardDelete(name);   // clean ∧ 在线 ∧ 云端有完整副本 → 安全丢本地副本
    head.forget(name);              // 清云端谱系（下次 open 重新 acquire）
    return { status: "offloaded" };
  }
  return { offload };
}
