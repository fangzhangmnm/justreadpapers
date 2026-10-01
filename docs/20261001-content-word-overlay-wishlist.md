# Wishlist：实词 overlay 视图

> created 20261001 · by Claude Fable 5.1 · as-of 2026-10-01（JRP main，本文件之外一字未动）
> 出处：user 2026-10-01（PWAProjects 的朗读 session）「然后jrp可以看一下能不能做这个实词overlay视图，这个会非常酷」「myllama reborn, jrb jrp都记账」。
> **只是 wishlist，没经 user 拍板做不做、怎么做。** user 2026-09-19 说过「jrp先不动，jrp是一个独立的产品」，所以这里只记账、不动代码。正本在全局账本：`~/jupyter/20260813 MyLlamaReborn/20260913 记账 Wishlist 与 Research Ideas/` 的 wishlist **W-195** + research-ideas **R-086**。JRB 那份 = `../20260523 JustReadBooks/ai-docs/20261001-content-word-highlight-wishlist.md`。

## user 原话

- 「jrb读英文的时候可以实词高亮，然后需要想一个weight/stakes判断器。甚至可以看小模型topic分类器的attention看哪里」
- 「然后jrp可以看一下能不能做这个实词overlay视图，这个会非常酷」
- 「所以其实扫读的关键在于抓高weight实词。这么说再加一个，英语，只是你用词频或者别的方法把高weight 实词给变成背景不透明度highlight出来，看能不能到中文的效率」（同一晚在 Claude 网页版说的，user 贴进了会话）
- 起因之一：「也许以后读不进去的英文论文我也试一下」（和朋友聊天时说的，指把读不进去的英文论文也用「念出来 / 标出来」的办法试试）

## 是什么

看英文论文时，在页面上盖一层：实词按「权重」给背景色，权重越高越不透明。目的 = 扫读时直接抓高权重的词。

没定的：权重怎么算（词频 / 语言模型的 surprisal / 小模型 topic 分类器的 attention——都只是 user 点到的候选）、分几档、是常驻还是一个可切的视图。

## JRP 这边我看到的事实

- 页面是 pdf.js 画在 canvas 上的；`src/` 里搜不到文字层（textLayer）的渲染。所以 overlay 没有现成的 DOM 文字可挂，要自己从 pdf.js 的 `getTextContent()` 拿文字片段的坐标，在 canvas 上面叠一层。
- `getTextContent()` 给的是「一段文字 + 一个框」，不是一个词一个框；要按词拆框得自己量字宽。数学公式、双栏、页眉页脚会混在里面。这些都没试过。
- Quest 是这个 app 的一等公民：overlay 的重绘成本要在 Quest 上看。

## 相关

- 同一晚 user 在 Claude 网页版让它做了一个对比实验（原文 / 实词换汉字的「英文训读」/ 只高亮），结果不在本仓。
- 旧账：R-044（surprisal 找「猜不到的实词」）、W-192（实词频序）。
