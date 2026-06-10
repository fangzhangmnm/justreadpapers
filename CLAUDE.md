# JustReadPapers（家族总规则见上级 CLAUDE.md）

pdf.js 论文阅读器：手机端随手存网盘 → 各端（含 Quest、4K 屏）接着读。UI 中文。

- 数据：PDF 平铺于 OneDrive AppFolder；同步的只有阅读位置 `{pageIndex, yFraction}`（10s debounce + 过滤无价值 loitering——"有价值的保存"理论）；缩放/双页是 device-local。
- 云姿态：只读镜像 + 进度回写；自动 pull 安全。
- Quest 工作流：截图当前页到剪贴板拿去问 AI 是核心场景；滚动条宽度等 Quest 怪癖是一等公民问题。
- 注意：pin 离线模型要对齐家族教义（"用户 pin 了之后飞机上要能看"）；聊天末尾有一个 agent 弄坏 pdfjsLib 的 regression 待查。
