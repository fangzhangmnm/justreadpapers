# JustReadPapers（家族总规则见上级 CLAUDE.md）

pdf.js 论文阅读器：手机端随手存网盘 → 各端（含 Quest、4K 屏）接着读。UI 中文。

- **store 引擎已分仓（cutover 2026-08-14）**：`src/store/` 已删，引擎 = `@internal/store` 包（`../20260813 internal-store/` 仓，tgz 走 `vendor-pkgs/` file: 依赖）。改引擎去库仓（红线区，改前 escalate + pwa-cloud-store skill）；升级 = 本仓根跑 `bash "../20260813 internal-store/scripts/pull-package.sh" [版本]`。接缝 = `src/persistence/`（唯一值级 import 点，build.sh lint 守着）。缺接口 escalate 改库 API，绝不在 app 端绕（家规）。旧引擎的云端 `/catalog.json`（v1 信封，阅读位置）是迁移源——**只读不改不删**（getInitData 种子 + marker 兜底，见 `src/persistence/catalog-v1-migration.ts`）。

- 数据：PDF 平铺于 OneDrive AppFolder；同步的只有阅读位置 `{pageIndex, yFraction}`（10s debounce + 过滤无价值 loitering——"有价值的保存"理论）；缩放/双页是 device-local。
- 云姿态：只读镜像 + 进度回写；自动 pull 安全。
- Quest 工作流：截图当前页到剪贴板拿去问 AI 是核心场景；滚动条宽度等 Quest 怪癖是一等公民问题。
- 注意：pin 离线模型要对齐家族教义（"用户 pin 了之后飞机上要能看"）；聊天末尾有一个 agent 弄坏 pdfjsLib 的 regression 待查。

## 地址（2026-10-18 起）

- 正式版 `https://papers.weebpaint.com/`（仍是 05-27 旧 JS app）、开发版 `/dev/`（TS 重写）；仓库 Pages 挂自定义域名（Actions 部署，无 CNAME 文件），强制 HTTPS，证书只管 `papers`（到 2027-01-16）。旧 `fangzhangmnm.github.io/justreadpapers/`（含 `/dev/`）301 到这里。user 2026-10-18「jrp: 域名改成papers.weebpaint.com/dev/」；家族背景与搬家清单 = 家族根 `ai-docs/20261011-family-domain-subdomains.md`。
- 新地址 = 新箱子：旧 github.io 箱子的本机数据不会带过来（PDF 与阅读位置都在 OneDrive，登录后回来；本机缓存的 PDF 要重下）。
- Azure SPA 回调要有 `https://papers.weebpaint.com/`、`/dev/`；旧 github.io 两条保留给旧主屏图标。
- 旧正式版主屏图标：离线壳是缓存优先、不重建跳转响应（没有 MoonSinger W-21 那个报错），按代码推断（未真机验）会继续打开旧箱子里缓存的旧版。`/dev/` 本来就没有离线壳。edited by Claude Opus 5.5 2026-10-18
