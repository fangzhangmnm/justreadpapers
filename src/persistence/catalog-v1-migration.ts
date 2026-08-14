// 旧引擎 catalog.json（v1 信封）→ 新库 collection 种子（cutover 2026-08-14 一次性迁移）。
// 旧：approot /catalog.json，信封 { version:1, items:[{id,uat?,...payload内联}], trash:[{id,uat?}], resetAt }。
// 新：@internal/store collection（云端 .justreadpapers/catalog.json，信封 v2 {id,uat,value}+null 墓碑）。
// 本模块 = 纯解析器（零 IO，可单测）：把 v1 字节按 v1 自己的合并语义（resetAt 水位线 + trash edit-wins）
// 结算成活跃 item 列表，再映射成 getInitData 种子 [{id, value}]。种子 uat=1（库内定），任何真实编辑 /
// 别设备真数据经 LWW 必胜——这正是要的语义：迁移绝不压过迁移之后发生的阅读进度。
// 旧文件永远只读：不改写、不删除（可回捞）。

/** getInitData 种子项（对齐 @internal/store CollectionInitItem，type-only 免 import）。 */
export interface V1Seed { id: string; value: unknown; }

interface V1Item { id: string | number; uat?: number; [k: string]: unknown; }

/** 解析 v1 catalog 信封文本 → 种子列表。非 v1 / 损坏 → null（调用方当「没有可迁的」，绝不半截乱种）。 */
export function parseV1Catalog(text: string): V1Seed[] | null {
  let env: unknown;
  try { env = JSON.parse(text); } catch { return null; }
  if (!env || typeof env !== "object") return null;
  const e = env as { version?: unknown; items?: unknown; trash?: unknown; resetAt?: unknown };
  if (e.version !== 1) return null;   // 只认 v1；将来别的版本 = 不认识 = 不迁（保守）
  const resetAt = typeof e.resetAt === "number" ? e.resetAt : 0;
  const items = Array.isArray(e.items) ? (e.items as V1Item[]) : [];
  const trash = Array.isArray(e.trash) ? (e.trash as V1Item[]) : [];

  // v1 语义结算：① 丢 ≤ resetAt 的（恢复出厂水位线）；② 同 id 取 uat 大者；
  //   ③ trash edit-wins：item.uat > trash.uat → 留，否则删。
  const live = new Map<string, V1Item>();
  for (const it of items) {
    if (!it || it.id == null || (it.uat || 0) <= resetAt) continue;
    const cur = live.get(String(it.id));
    if (!cur || (it.uat || 0) > (cur.uat || 0)) live.set(String(it.id), it);
  }
  for (const t of trash) {
    if (!t || t.id == null || (t.uat || 0) <= resetAt) continue;
    const cur = live.get(String(t.id));
    if (cur && (cur.uat || 0) > (t.uat || 0)) continue;   // 编辑更晚 → 复活
    live.delete(String(t.id));
  }

  // 映射：payload = item 去掉信封字段（id/uat）。旧 payload 里 fileName/position/... 原样搬。
  const seeds: V1Seed[] = [];
  for (const [id, it] of live) {
    const { id: _i, uat: _u, ...payload } = it;
    seeds.push({ id, value: payload });
  }
  return seeds;
}

/** 迁移完成标记 item 的 id（存进 catalog collection 本体，跨设备随 collection 同步）。
 *  value 无 fileName 字段 → catalog 读面天然过滤，不会混进论文列表。 */
export const V1_MIGRATED_MARKER = "__v1migrated";
