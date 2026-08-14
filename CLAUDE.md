# JustReadPapers（家族总规则见上级 CLAUDE.md）

pdf.js 论文阅读器：手机端随手存网盘 → 各端（含 Quest、4K 屏）接着读。UI 中文。

- **store 引擎已分仓（cutover 2026-08-14）**：`src/store/` 已删，引擎 = `@internal/store` 包（`../20260813 internal-store/` 仓，tgz 走 `vendor-pkgs/` file: 依赖）。改引擎去库仓（红线区，改前 escalate + pwa-cloud-store skill）；升级 = 本仓根跑 `bash "../20260813 internal-store/scripts/pull-package.sh" [版本]`。接缝 = `src/persistence/`（唯一值级 import 点，build.sh lint 守着）。缺接口 escalate 改库 API，绝不在 app 端绕（家规）。旧引擎的云端 `/catalog.json`（v1 信封，阅读位置）是迁移源——**只读不改不删**（getInitData 种子 + marker 兜底，见 `src/persistence/catalog-v1-migration.ts`）。

- 数据：PDF 平铺于 OneDrive AppFolder；同步的只有阅读位置 `{pageIndex, yFraction}`（10s debounce + 过滤无价值 loitering——"有价值的保存"理论）；缩放/双页是 device-local。
- 云姿态：只读镜像 + 进度回写；自动 pull 安全。
- Quest 工作流：截图当前页到剪贴板拿去问 AI 是核心场景；滚动条宽度等 Quest 怪癖是一等公民问题。
- 注意：pin 离线模型要对齐家族教义（"用户 pin 了之后飞机上要能看"）；聊天末尾有一个 agent 弄坏 pdfjsLib 的 regression 待查。
