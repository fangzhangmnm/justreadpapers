# JustReadPapers —— 功能还原清单 (feature parity + 新功能)

> as-of 2026-06-19 · 从 `ARCHIVE/{app.js,index.html,viewer.js,styles.css}` 逐项扒出。
> 重写要达到的 parity baseline。`[模块]` = 落到 PLAN.md 哪个模块。`[STORE]` = 旧码直接碰 OneDrive/IDB/localStorage，重写必须改走 store 接缝。
> ☑=必还原 · ✚=新增 · 🐞=已知 bug 要修 · ⚙=有意保留的微妙正确性 · ✂=废弃别还原。

## 1. 启动 / resume（产品心脏）[resume]
- ☑ silent MSAL → 并行 initSession + list papers → jumpscare（直开 lastActive 那篇那页，无 library 落地屏）
- ☑ lastActive 解析链：已列表里找 → getItemMeta → 否则 landing "上次的论文不见了/可能被另一台设备删除"（**不** forgetDoc，可能只是 trashed）⚙
- ☑ 多种 landing 态：没论文/未登录/需要授权/已登出/加载失败/已移到垃圾箱（部分带"上传 PDF"按钮）
- ☑ 离线韧性：session 先从 localStorage backup hydrate [STORE]，文件列表 fallback 到 IDB 缓存 [STORE]

## 2. Viewer [ui/viewer + domain/viewer-geometry]
- ☑ 全屏连续竖向滚动（pdf.js PDFViewer，全页）
- ☑ reading-line 锚 viewport 25%；position=`{pageIndex,yFraction}` PDF 文档坐标；复位含 2-rAF re-nudge ⚙
- ⚙ `currentPosition()` 全页高 0 时返 null（不猜）——防 teardown/reload 把"文末"写进 session 跳末页
- ☑ 顶栏 `p.<n>` 实时（rAF 节流，纯显示不持久化）
- ☑ zoom：±按钮 ×1.15/÷1.15（clamp[0.1,8]）；**Ctrl/Cmd+滚轮**=缩放，裸滚轮=滚动；"适配宽度"清 per-doc 缩放重 auto-fit
- ☑ auto-fit "cozy"：页宽=min(容器宽, 9inch×每行页数)；宽屏页面封顶 9" 留边
- ☑ [STORE] 缩放偏好 = **per-doc per-spread-mode 的"相对 cozy 的 factor"**（`jrp.zoomf:<docId>:<mode>`）——"比适配大 20%"跨窗口尺寸保持；旧绝对 `jrp.zoom:` 忽略
- ☑ spread 0/1/2 = 单页/odd(封面单独,后 2-up)/even(1+2,3+4)；[STORE] `jrp.spread` device-wide；切换后重应用缩放+复位（2 rAF）
- 🐞 **双页 bug**：切换按钮硬写死 0↔2（跳过 odd）；**mode 1（封面单独,后 2+3/4+5）已实现但 UI 够不到** → 修=暴露 mode 1（或 3-way 切换），引擎 `setSpreadMode(1)` 现成
- ☑ 中键拖拽 pan（左键留给选字；触控/笔用裸滚动）；3px 死区；吞掉尾随 click ⚙
- ☑ outline/TOC drawer：pdf.js 书签树+twisty 折叠+样式+深度缩进；点→goToDestination+高亮；无 outline 时按钮隐藏；跳转排 800ms 延迟 flush ⚙
- ☑ ResizeObserver+window.resize 重 auto-fit（仅用户未手动缩放时）⚙
- ☑ cmaps+standard_fonts（CJK/嵌入字体）
- ✂ 无 pinch-zoom、无 swipe 翻页（触控=裸滚动）；键位只有 Esc（退出 overview）

## 3. Library / 文件面板 [ui/library-panel + persistence.catalog/content]
- ☑ hamburger 开（**无 edge-swipe**）；backdrop/关闭键关；与 outline drawer 互斥单开
- ☑ 列表：list papers 过滤 `.pdf`；每行 缓存点+标题(去.pdf)+日期+hover 动作；当前篇左accent高亮
- ☑ [STORE] 排序切换 modified↔name（`jrp.sort`）；刷新=重 list cloud
- ☑ 点行开篇（trash 行不响应点击,只 restore/purge 按钮）
- ☑ [STORE] 改名：inline 编辑（Enter 提交/Esc 取消/blur 提交）；sanitize 文件名（去 `\/:*?"<>|`、前导点、collapse 空格、≤200、补 .pdf）；If-Match eTag；同步顶栏标题
- ☑ [STORE] trash（移 `/trash/`）：确认→move→删本地缓存→若当前篇:teardown viewer+清标题/outline+forgetDoc+"已移到垃圾箱"landing
- ☑ [STORE] trash 视图：列 `/trash/`；逐行 restore（移回,ensureFolder）/purge（永删,确认,清缓存）；清空垃圾箱（danger 样式,loop 删）
- ☑ 各空/错态文案
- ☑ 缓存 footer：显示 IDB 总缓存大小"缓存 X MB" [STORE]
- ✂ footer 缓存按钮无 handler（纯显示）；✚ 重写时给它接"清缓存/缓存管理"

## 4. 摄入 ingest [ingest + persistence.content]
- ☑ [STORE] 上传：文件选择（multi,accept PDF）或拖放；每文件 deriveFileName→sanitize→补.pdf→upload approot/papers（简单 PUT ≤4MB 否则 chunked 5MB；conflictBehavior=rename 防覆盖）；进度条；上传后自动开最后一份
- ☑ auto-rename from PDF `/Title`：cleanPdfTitle（去"Microsoft Word -"前缀+尾源扩展名）过 isUsableTitle 质量门（拒空/<5字/Untitled/无空格带点像文件名）；fallback 原名去.pdf
- ☑ 元数据：仅 derived 文件名 + addedAt（旧码没存 author/abstract）
- ✚ **下载（重构跑通后的高优，非本轮；本轮只留接缝）**：**单一输入入口**，app **自动判断** arxiv（多格式：abs/pdf 链接、export 子域、`1102.5064v2`、老式 `hep-th/9901001`、带/不带版本）vs **任意 PDF 直链** → 拉进 library。**需 CORS proxy（那时再建，守 anti-abandonware ADR-0006，proxy 不成单点故障）**。
- ✚ arxiv metadata（title/authors/year）抓取——命中 arxiv 时顺带，随下载一起（非本轮）

## 5. 同步 / 冲突 / 状态 [persistence.catalog + ui/status]（旧全 [STORE]）
- ☑ 状态行（500ms tick）：未登录/就绪/同步中…(金)/未同步(accent)/同步失败·重试中(红)/已同步 HH:MM；transient 覆盖(1.8s/错误5s)；⚙ **永不闪烁/动画**（阅读不分心）
- ☑ 写调度：debounce 10s + ceiling 30s from first-dirty；lastActive/forgetDoc 立即写 [domain/valuable-save]
- ⚙ trivial-skip：同页 + |yΔ|<0.5 vs 上次推 → 标脏不调度 PUT（吃掉 fidget/loitering 刷版本史）[domain/valuable-save]
- ☑ 冲突 If-Match→412→重拉+merge（remote 为 base,本地 lastActive+活跃篇 position 胜）+重试一次 → 二次 412 标脏下轮（**folder-store 已自带这套**）
- ☑ [STORE] localStorage backup（每次 mutation + 每次成功 PUT）→ 冷启动 hydrate + 离线
- ☑ window-focus reconcile：只比 eTag（不下载）→变了弹"云端有更新"toast；应用=先 flush 本地再切/复位
- ☑ flush 触发：beforeunload/pagehide/visibilitychange→hidden 全调 flush+keepalive PUT；⚙ keepalive 用 If-Match 但 fire-and-forget,412 丢 1 次位置(可接受)
- ☑ online 事件重 flush+重列表；离线 list 失败→从 IDB 缓存 meta 建列表（_offlineStub）

## 6. 缩略图总览 [ui/thumbnails]
- ☑ overview 全屏 CSS-grid 全页（手搓,pdfjs v4 无 ThumbnailViewer）；骨架卡 A4 占位
- ☑ IntersectionObserver（rootMargin 400px）只渲可见；DPR 封顶 2 控内存；当前页金框+自动滚到；点缩略图→退 overview+goToPage（2 rAF 后,否则 scrollIntoView no-op）⚙；Esc 退
- ✂ "缩略图暂时禁用"是**过时注释**（实际手搓重实现了,可用）——别被它误导隐藏按钮

## 7. Quest / 平台 [ui/quest]
- ☑ 截图当前页 canvas→PNG ClipboardItem→toast"已截图到剪贴板"（tooltip"粘贴给 AI 问"）
- ☑ 复制当页文本→getTextContent→normalize→writeText→toast"已复制 N 字"（tooltip 警告公式出 glyph 非源码）
- ☑ ⚙ 滚动条宽度：detectScrollbarWidth 量 classic vs overlay，cozy-fit 里预留宽度防 jitter；CSS 强制 `overflow-y:scroll`+自定义滚动条 24px(Quest 默认太细)/drawer 18px/overview 14px
- ☑ DPI thumbnails 封顶 dpr 2；safe-area inset 全套；viewport-fit=cover；init 时记设备诊断日志
- ✂ 无显式 fullscreen API（靠 PWA standalone）

## 8. 设置（device-local，全 [STORE] localStorage → 改走 persistence.settings）[ui/reading-controls + settings]
- ☑ 主题 day/night/auto（`jrp.theme`,循环 auto→day→night,`<head>` inline 防 FOUC）
- ☑ 缩放 factor `jrp.zoomf:<docId>:<mode>`；spread `jrp.spread`；排序 `jrp.sort`；session backup `jrp.session.backup`；MSAL token cache(localStorage)
- ✂ 无设置面板——设置散在 toggle 按钮（主题/排序/spread）+隐式（缩放）。重写可不必造面板,保持散置即可

## 9. PWA / SW [service-worker + shell]
- ☑ install：manifest+apple-touch；app-shell precache（html/css/全 src js/pdf.js/MSAL）；cmaps/fonts 按需
- ☑ 策略：同源 cache-first+后台 revalidate；跨源(Graph/login/downloadUrl) passthrough 永不缓（SSOT 完整性）
- ☑ 更新检测 3 路（后台 revalidate eTag/len 差 / updatefound / 冷启动 registration.waiting）→"本站有新版本"toast+刷新键；⚙ 永不自动 reload（可能在读）；刷新=keepalive flush+skip-waiting+reload
- ☑ 离线 shell：navigate fallback 缓存 index.html；否则 503
- ☑ ⚙ localhost 不注册 SW（避开发缓存坑）；bump CACHE_VERSION 失效
- 注：bundle 名 `jrp-`，SW precache regex 必须跟它一致（build.sh 已定）

## 10. Misc / overlay / toast [ui/* + shell]
- ☑ 主题 Ivory-Platinum(day)/Black-Gold(night)，不纯黑白，金/铂仅 accent；theme-color media-aware
- ☑ idle overlay：30min 无输入→"已闲置/点击同步云端最新版"→点=applyRemoteUpdate+重置
- ☑ 拖放上传：window dragenter/over/leave/drop+depth 计数（dragleave 子元素误触）；dropOverlay"松手即上传"；过滤 PDF（非 PDF→"不是 PDF,忽略"）；overlay pointer-events:none
- ☑ update/conflict toast 双模（session 变 vs 新部署）+dismiss
- ☑ 下载进度条（顶栏下 2px）
- ☑ 键位全集：Esc / Ctrl-Cmd+滚轮 / rename Enter-Esc / pdf.js 原生滚动键

## 11. Auth [persistence（MSAL 经 store provider）]
- ☑ MSAL `common`,scopes `Files.ReadWrite.AppFolder`+`offline_access`(approot sandbox)；redirect 登录
- ☑ ⚙ "probed-but-unauthorized"态：有缓存账号但 silent 失败→**不**称已登录→"需要授权/检测到账号 X 点登录授权本 app"（区别于"请登录"）
- ☑ ⚙ 登出仅 clearCache(本 app)，**不** logoutRedirect（不杀用户 Outlook/他 tab session）
- ☑ getToken silent-first，失败 acquireTokenRedirect

## ⚙ 必须保留的微妙正确性（重写别丢）
currentPosition null 守卫 · trivial-skip · 状态行不闪 · keepalive LWW 接受丢 1 次 · probed-but-unauthorized 态 · 登出 clearCache 不 logout · reading-line 25% · zoom 相对 cozy factor · cross-origin 永不缓

## ✂ 别还原（废弃/dead）
footer 缓存按钮无 handler（→ 接清缓存）· overview-disabled 过时注释 · getPdfMetadata/getNumPages 未用 · restorePaper 的 getApprootId 死调用 · 旧 `jrp.zoom:` 绝对键

## ✚ 新功能汇总
1. **下载（URL 摄入）= 重构跑通后高优，非本轮**：单一入口自动判断 arxiv(多格式) | 任意 PDF 直链 → 进 library；需 CORS proxy（那时建，anti-abandonware-safe）；命中 arxiv 顺带抓 metadata。本轮**只留接缝不实现**。
2. footer 缓存按钮接"清缓存/缓存管理"（本轮可做）。
3. 🐞 双页 odd 模式暴露（修 bug，本轮）。

> 本轮专注：**还原既有功能（上面 ☑ 全部）+ 修 🐞 + 接死按钮**。下载/arxiv 留到重构跑通后。

## 🔧 旧码直碰存储、重写必经 store（汇总）
- OneDrive/Graph（graph.js，app.js+session.js 直调；keepalive PUT+checkRemoteChanged 在 session.js 里裸拼 Graph URL 绕过 graph.js）→ 全经 `persistence.content`/`catalog`
- IndexedDB（cache.js，frecency 250MB/24h；兼做离线列表 fallback）→ 见 PLAN 开放问题（Cache API vs store）
- localStorage（jrp.theme/sort/spread/zoomf/session.backup + MSAL token cache + index.html 里 FOUC 重复读）→ 全经 `persistence.settings`，集中
- graph.js 内存 folder-id 缓存（approot/subfolder/trash id memo）→ 重建
