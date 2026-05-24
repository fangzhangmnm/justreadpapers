# 跟这个用户协作的风格(meta lessons)

跟同一个 fz 合作过 webxiaoheiwu + justreadpapers 两个项目。这里记一下他的沟通 / 决策风格,以后 AI 接手类似项目快速对齐。

## 1. 节奏快,期望 commit-push 立刻

不要写完憋着等 "review approval",**改完 commit 立刻 push**,他立马在 Quest / iPhone 上测,反馈再改下一版。

例外:**大动作 / 不可逆操作前问**(创建公共 repo、删数据、修 hooks、reset --hard)。

## 2. 用户读 commit message 当 changelog

每条 commit message **写人话**,前几个词概括做了什么 + 为什么。
- ❌ "fix bug"、"updated viewer.js"
- ✅ "fix the off-by-96/72 unit bug in computeCozyScale (page was 33% too big)"

我有几次 commit 写得长(包含 root cause + symptom + 方案),用户后来直接引用这些信息描述问题。

## 3. 问问题的时候希望选项 + tradeoff,**不要替决定**

写 `AskUserQuestion` 时:
- 提 2-4 个选项,每个写 description 含 tradeoff
- 加 "(Recommended)" 在我推荐的选项 label 末尾
- 用户经常选 "Other" 给一个我没想到的方案

例子他喜欢的问法:
```
arxiv 摄入这一块,MVP 怎么走?
[选项 1] Cloudflare Worker proxy 一并做  description: ...
[选项 2] 先只本地上传,arxiv 延后        description: 最快闭环...
[选项 3] 本地上传 + arxiv ID 手填        description: ...
```

## 4. 直接说"反了 / 不对",不解释具体怎么不对

短反馈是常态:
- "fit to width 一直不对!"
- "min 和 max 给反了"
- "DPI 不标准"

第一反应:先**别按字面意思改**(用户的 hypothesis 可能不对)。问自己:他观察到的症状是什么?然后从那个症状反推根因。

我多次按用户 hypothesis 改(min↔max、加 UA 因子、改 cap),都是猜偏。最后他一句 "**每次计算的大小确实差了一个常数倍**" 才定位到 96/72 单位 bug。

**听症状,猜根因,再验证。** 不要从"用户说反了"直接 `Math.max ↔ Math.min` 互换。

## 5. 喜欢"自己 think from scratch"

```
用户:从头想!
```

意思是 "你绕远了,重新捋逻辑,别打补丁"。出现这句话 = 我刚才几条改动都是错的方向。立刻 stop coding,先用 plain language 把核心机制想一遍,再列出可能的根因清单。

## 6. 偏好 "极简 + 一致 + 可逆"

UI 偏好:
- 顶栏越窄越好(24-36px)
- 按钮能塞 drawer 就别放顶栏
- 主题三态(日 / 夜 / 跟系统),不要花哨配色
- 不要动画 / 闪烁(我加过 "同步中…" 脉动,被骂"干扰读论文")

行为偏好:
- 永不强制 reload(用户可能正读)
- 永不静默覆盖远端(冲突要让用户感知)
- 永不无 UI feedback 的 long-running 操作(optimistic UI 必备)

## 7. 设计文档:他写 spec,我跟

`journals/20260518 proposal.md` 是项目北极星,**任何决策不确定就回看**。spec 里的:
- 1-click resume
- session 是 SSOT,PDF 是 cache
- 没 library 落地屏
- 单表面 ZEN
- 跨设备 position {pageIndex, yFraction} 不是像素

这些在整个迭代里反复用来 "对路 / 跑偏" 检查。

他经常写第二版 spec / 提示新方向("加一个上次未做的功能"),也常常用 IDE 选中文本指代具体讨论的代码。

## 8. 不喜欢 over-engineering

我加过的几次 over-engineering 都被推回:
- ResizeObserver 加复杂 detection (scrollbar showing / not) → 用户接受了但说"防御性太多"
- Frecency cache 加复杂 score 公式 → 用户说"简单 LRU 也行,你已经写了就留着"
- TOC click + setTimeout flush + dedup → 已成习惯

判断 over: 如果在解释代码的时候用了 "防御性" / "兜底" / "为了万一"超过 1 次,可能是 over。

## 9. 用中文对话,代码英文,commit message 英文

prose 全中文 / 中英混。**变量名 / 函数名 / commit / README / 注释一定英文**(后来者 AI 阅读多用英文 corpus)。

example 注释:
```js
// trivial-skip:跟"上次成功推到 OneDrive"的位置比,同页 + |yFrac Δ| < 0.5 → 只更新内存
// 专门吃掉鼠标 fidget / loitering
```

中文写人类 reasoning,英文写代码 token。

## 10. 喜欢"先讨论再 ship",但 ship 后期望立刻测

新 feature 用 `AskUserQuestion` 列 tradeoffs → 用户选 → 我 ship。中间他不要看 plan,直接 ship。

例外:**deferred 队列**。某些 feature 用户说"先记着",我就放 todo 不做。

## 11. 不要 commit 没问过

`memory/feedback_commit_cadence.md` (从 webxiaoheiwu 期间):
> "你以后问过我之后再commit"

但 justreadpapers 期间用户改了节奏,**改完 push 立刻** 是默认。
不一致时:看最近的对话怎么说。**实在拿不准就一句 `要 commit 吗?` 问**。

## 12. ShellHook / 系统行为按用户配置走

`/loop`、各种 hooks、`CLAUDE.md` —— 用户配的就听用户的,**不要建议改他的环境**。

## 一句话总结

**short, blunt, fast iter, no fluff**。回应风格也得这样:1-2 句 + 代码 / diff,不要 essay。
