# JRP 真机验证清单（release-to-prod 前）

> as-of 2026-06-28 · 本 session 海量 store 改动 + 此前全部**未真机验**。prod（提升 /dev/→/）前必须真机过一遍。
> 在 `/dev/`（fangzhangmnm.github.io/justreadpapers/dev/）上测。每条：通过打 ✓，坏了记现象。

## A. Boot / resume（产品心脏）
- [ ] **新设备/未登录**：打开 /dev/ → 不卡转圈 → 进得了图库 → 能点登录（0caf386 修的「未登录卡锁屏」）。
- [ ] **登录态 resume**：开 /dev/ → 自动开 lastActive 那篇那页（jumpscare），只转一次、不双开（0caf386 修的双 resume）。
- [ ] **离线 boot**：断网开 /dev/ → 从本地缓存续读 lastActive，不卡。
- [ ] lastActive 已被删/移走 → landing「上次的论文不见了/可能被另一台设备删除」（不崩，不 forgetDoc）。

## B. 核心阅读环
- [ ] 登录 → 列论文 → 开一篇 → 复位到上次位置（pageIndex+yFraction 准）。
- [ ] 读到中间 → 切后台/关 → 重开 → 位置续上（valuable-save 落盘）。
- [ ] 缩放 ±/适配宽度、双页切换、Ctrl+滚轮缩放、中键 pan、outline 抽屉、页面总览。
- [ ] 截图当前页到剪贴板（Quest 核心场景）。

## C. 图库文件操作（store 写流）
- [ ] 改名（inline）→ 顶栏标题同步、位置不脱链（再开还在原页）。
- [ ] 删（移回收站）→ 回收站能看到、能 restore、能 purge、能清空。
- [ ] 移到文件夹、新建文件夹、上传 PDF（拖拽 + ＋传，含阅读模式拖拽落点）。
- [ ] **skip-to-offline（本 session 新）**：登录态若云检查卡住 → busy 遮罩上出现「跳过到离线」按钮 → 点了立即读本地。（难复现；iOS 老 token 时才触发。至少确认正常开篇时按钮**不乱冒**。）

## D. 离线 / 重连（数据安全红线，肉眼验）
- [ ] 离线读已缓存的论文 → 秒开、不卡。
- [ ] 离线删一篇 → 重连 → 云端那篇也没了（离线删队列重放，本 session 修的）。
- [ ] 离线删一篇、同时另一设备改了同名 → 重连不盲删（edit-wins）。难造，尽力。
- [ ] **冲突 sheet**（本 session resolveConflict 改必传）：JRP 只读镜像基本不写冲突，但若触发 → 弹真 sheet（不静默）。
- [ ] **错误 toast**（reportError 必传）：同步出错 → 出 toast，不吞。

## E. ★ OneDrive 直接整理（你问的 meta 场景）
- [ ] 上传读 5 篇 → 去 OneDrive 网页/app 把这 5 篇**拖到另一个文件夹** → 重开 JRP：
  - [ ] 5 篇出现在**新文件夹下**（不在旧位置）——无重复卡、无第二份。
  - [ ] 移动后的卡**暂时显示成光秃 basename（无标题/无已读徽标）**，像没读过——**点开任一篇 → 阅读位置正确续上**（docId=内容哈希，路径无关）→ 之后刷新该卡标题/徽标回来（catalog fileName 自愈）。
  - [ ] jumpscare 若 lastActive 是被移走的那篇 → 仍能从本地缓存开（按旧路径）；**若本地缓存也被清过** → 可能误报「上次的论文不见了/可能被删除」（其实只是被移走）——记下是否遇到。
  - 详见本仓 chat 里的分析：**无丢位置、无 duplicate、无真鬼；只有列表暂时「不认得」+ 一处误报风险**。

## F. validateAdopt（本 session 新，难真机触发）
- [ ] 正常阅读不受影响（%PDF- 校验只在采纳云端覆盖本地时跑）。
- [ ] （可选硬造）机场/captive-portal 网下开一篇没缓存的 → 不会拿登录页 HTML 当 PDF 存（开篇失败/报错，而非缓存被毁）。

## G. 回归（确认没弄坏）
- [ ] 主题切换、☰ 菜单、build 版本号显示、PWA 更新检测（☰ 强制更新）。
- [ ] 加密相关 UI **应当看不到**（JRP 不加密；本 session 删了死的密码 sheet）——确认没有残留密码弹窗。

> 加密功能本身 JRP **不验**（不注入 codec=dormant）；加密只在回传 WebPaint 后于 WebPaint 真机验。
</content>
