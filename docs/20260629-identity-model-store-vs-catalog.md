# 身份建模：store 的 path/name vs catalog 的内容哈希（双 SSoT 诊断 + 交接）

> as-of 2026-06-28 · 起因：用户问「内容哈希 docId 是谁的、调用它的那层是不是越权」。
> 结论：**store 没问题**（身份=path/name 单一 SSoT）；**双 SSoT + 静默身份裁决在 catalog/folder 层**，交下一个 agent。

## 1. store 里的身份是怎么建模的（回答「store 里身份的建模是什么」）

**身份 = path/name。单一 SSoT。** store 对一个文件只认「它叫什么路径」。

| 概念 | 在 store 里是什么 | 不是什么 |
|---|---|---|
| **身份**（which file） | `path/name`（`papers/A.pdf`）。cache/etag/dirty/conflict/move-aside/reconcile **全部 key off 路径** | 不是内容哈希、不是 GUID、不是 etag |
| **版本**（which revision） | `etag`（云端给的；If-Match 用） | 不是身份（同一文件多版本，身份不变） |
| **本地状态** | per-tab `_base`/`_parent`/dirty（local-head） | 不是持久身份 |

- **没有内容知识**：store 格式盲，从不算内容哈希、从不解析文件。（`_confirmOurUpload` 的 size+尾字节是**一次性**「这是不是我刚推的字节」核验，不是持久身份 key。）
- **GUID-in-content 被否决**：ADR-0011 把 GUID 塞进文件内容当身份 → 2026-06-07 真机后 **rollback**（store 不该解析/改内容）。**这正是「身份就是路径、别靠内容」的拍板。**
- **移动/改名**：路径变 = 旧路径没了 + 新路径冒出来。store 不追踪「这是同一个文件搬了家」（跨设备 rename-split = wart E，已接受的 UX 小疵，**非数据丢失**，re-sync 收敛）。

**→ store 的身份模型干净、单一、已静态验证（红线 SAFE）。store 没问题，本轮不动它。**

## 2. 双 SSoT 的来源：catalog 的内容哈希 docId（旧代码遗留）

JRP 的 catalog（阅读态 collection）引入了**第二个身份**：

- `domain/doc-id.ts` `contentDocId(bytes)` = 整块字节 SHA-256（内容盲，不解析 PDF）→ `c-<16hex>`。
- catalog item 的 key = docId（**不是路径**）。catalog 存 `docId → { fileName(当前路径), position, title }`。
- 理由（doc-id.ts 注释）：docId 不变 → 阅读位置扛改名/重传/跨设备 → 位置不脱链。

**于是同一篇论文有两个身份**：
- **文件身份** = `papers/A.pdf`（store 拥有）。
- **文档身份** = `c-3f9a…`（catalog 拥有）。
- catalog 维护 `docId → 当前 fileName` 的**桥**，每次 openPaper 重绑。

这就是用户说的**「旧代码 hash 的双重 SSoT」**：两套身份并存，要靠 app 层桥接对齐。

## 3. 「太监 silent running」：双 SSoT 衍生的静默裁决（病在 folder 层，不在 store）

身份裁决目前 **inline 在 `ui/app.ts` openPaper（210-235）**，静默做了几桩大事，app/用户不知情（违反 store 自己的 Model-B「决策必 surface」纪律）：

- **同内容两份 → 同 docId** → 打开 B 副本静默给 A 的阅读位置（两份共位置）。
- **内容变了（损坏/截断/HTML）→ 哈希变 → 静默当新文档** + 往 catalog 塞幽灵 entry（**字面狸猫换太子**；validateAdopt 已堵字节层，但「静默裁决」本身没堵）。
- **外部移动 → 静默 re-bind 路径**（多数对，但是身份事件，没人听见）。
- **太监比皇上先知道**：身份生在 open 流程最深处的局部副作用里，app 域没有「文档诞生/搬家/被认出」的一等事件。

## 4. 给下一个 agent 的交接（folder / reader 域的活，**不是 store 的活**）

> 前提：store 已收口、单一 path/name 身份、红线验过。**别动 store。** 下面是 catalog/folder 层的设计债。

**核心决策（先定这个）**：JRP 到底**需不需要**内容哈希文档身份？
- **选项 A — 砍掉双 SSoT，身份就是路径**（对齐 store）：catalog 改 key by 路径。JRP 内改名时 app 已更新 fileName（位置不丢）；**只有外部 OneDrive 移动**才丢位置（= 把 wart E 接受到阅读位置上）。最简单、单 SSoT、无静默裁决。代价：用户在 OneDrive 里整理后，被移动的论文位置重置。
- **选项 B — 保留内容哈希文档身份，但做成有纪律的层**：承认双 SSoT，但①文档身份是一等概念（reader 域服务，不在 UI）②裁决显式/surface（同内容多份共位置？内容变=新文档？——该问的问、该 surface 的 surface，套 store 的 Model-B 纪律）③openPaper 退回纯 UI（调 `library.open(path)` 拿 `{blob, docId, position, 身份事件}`）。代价：复杂度、要维护桥。

**这套（doc-id + catalog + valuable-save + 打开-解析-绑态 编排）应抽成「读者域共享层」**——store 的兄弟库，给 JRP / JustReadBooks / 音频位置 复用，**不进 cloud-store**（内容哈希身份编辑器用不了：可变内容每改一笔哈希就变，WebPaint 用不了；store 只能管通用的 path/name）。

**与「folder UI 抽象」那一轮一起做**（用户方向：WebPaint+JRP 抽 folder UI，拉上 webxiaoheiwu/RealHome）。catalog/文档身份属 folder/library 模块，正好同批。

**别忘的具体点**：
- 砍/留双 SSoT 是先决决策，定了再动代码。
- openPaper 的静默裁决清单（§3）逐条决定：surface / 记账 / 接受。
- 损坏内容→幽灵 entry：validateAdopt 堵了字节，但身份层仍应防「垃圾哈希污染 catalog」。
- catalog 是 store `collection`（store 提供机制，**key 由 app 定**——这是对的，store 不规定 key）。

## 5. 一句话

**store 身份 = path/name，单一 SSoT，没问题。** 双 SSoT 和静默身份裁决是 **catalog/folder 层**的事（旧代码内容哈希遗留）。本轮**不动 store**；folder/reader 域的重整 + 「砍还是留内容哈希」的决策，**交下一个 agent，与 folder UI 抽象同批**。
</content>
