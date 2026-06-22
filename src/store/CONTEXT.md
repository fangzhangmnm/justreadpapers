# sync-store —— domain glossary（架构用语 SSoT）

> 这个文件给 store 引擎里的概念**命名**。架构评审/重构按这里的词走，别漂成 "service / handler / manager"。
> 红线设计见 STORE.md（新 API SSoT）+ OLD-ENGINE.md（旧引擎 seam）。

## 版本谱系（git 心智模型）

云文件的历史是一条版本链，每版一个 **etag**（云盖的版本号，每次写都变）：`v1→v2→v3…`。本地编辑是挂在某个节点上的一枝；push = 把这枝嫁接回树，**只在分叉节点还是 tip 时**（If-Match）。

- **etag** — 云端给每个文件版本的不透明版本号。变 = 云端被写过。
- **`_base`（seen version）** — 本 tab 同步到/看到的云 tip（git HEAD）。每次看到云端（open/pull/push 成功）更新。
- **`_parent`（branch-point / parentBase）** — 本 tab **当前未推编辑**分叉自的云版（git merge-base）。在 clean→dirty 边沿从 `_base` 抓一次、冻住，直到这枝推上去。**push 的 If-Match 唯一来源。**
- **dirty** — 本文件有挂在 `_parent` 上、还没推成功的本地枝（git working-tree-dirty）。= 它守护的"未推字节"（已 durably 在本地 IDB cache）的旗子。
- **bypass** — 坏状态：dirty 却没 `_parent`（编辑没走标脏正门 → 不知分叉自哪 → push 无法定 If-Match）。**设计上做成不可表示**（见 local-head）。

## local-head（深模块）

> **职责**：追踪"**本 tab 对每个文件，相对云端站在哪**" = (`_base` 看到的版本, `_parent` 分叉点, dirty 有没未推枝)。= git 的 HEAD + merge-base + working-tree-dirty 三合一。

- **per-tab**：`_base`/`_parent` 是 `createStore` 闭包里的内存 Map → 天然 per-tab（每 tab 独立 JS 堆）。**绝不**放共享 kv（W2：别的 tab 改了共享 etag，本 tab 陈旧推会被误判无冲突 → 静默覆盖）。
- **dirty 双机制**：per-tab 内存活视图 + kv shared-durable（跨 reload/tab-close 兜底；寿命对齐 IDB 里的未推字节）。
- **`recordEdit(name)` 是唯一标脏入口**：原子地 set dirty + `_parent ← _base` → **dirty-without-parent 不可表示**（bypass 结构性消除，不是事后绊线）。
- **seenBase 回退**：`_base` 缺失时回退读 cloud kv etag——**仅**用于 open/refresh 的"云端动没动"比较（非破坏性），**永不**作 dirty 的 If-Match。local-head 是**唯一**碰这个回退的地方（两条 etag 轨道唯一接触点，可审计）。
- **两条 etag 轨道分开**：local-head 拥 per-tab `_base`/`_parent`；cloud-sync 拥 kv 持久 etag。只在 open/adopt 单向 seed（kv→`_base`），绝不反向。

## 红线优先级（取舍时按此排）

1. **绝不静默覆盖 / 绝不丢数据**（最高）——If-Match 用 `_parent` 不用 `_base`/共享 etag；陈旧 etag 当 If-Match 必 412 安全 surface。
2. **绝不让脏字节进 merge**（captive-portal HTML / 截断）。
3. **freshness / 别读陈旧**（较低，但**是 JRP 的命**："各端接着读"=新设备一开就要最新）——seenBase 回退服务这条。

## 相邻模块（已抽 / 待抽）

- **substrate**（已抽）：编辑游标 + push-serialize（serialize/serialize2）+ save 合流。local-head 与它并列为两根有状态脊椎。
- **cloud-sync**：CloudSync 层，拥 kv 持久 etag + 云操作（push/pull/fetchMeta/trash/…）。
- 待抽深模块：**seal**（加密透明）· **safe-resolve**（永不丢字节）· **push** · **freshness** · **delete** · **identity** · **trash**（见架构报告）。
