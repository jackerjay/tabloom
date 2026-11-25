/* ==========================================================================
 * 织页 TabLoom · 双语国际化系统（中文 zh / English en）
 * 真值存 chrome.storage.sync.uiLang，localStorage.uiLang 存镜像供首帧读取，
 * chrome.storage.onChanged 自动在工作台、侧边栏、弹窗、搜索窗之间实时同步。
 * ========================================================================== */
(() => {
  const LANG_MODES = [
    { id: 'zh', label: '中文', title: '简体中文界面' },
    { id: 'en', label: 'English', title: 'English UI' },
  ];

  let uiLang = 'zh';
  try {
    const cached = localStorage.getItem('uiLang') || document.documentElement?.dataset?.lang;
    if (cached === 'en' || cached === 'zh') uiLang = cached;
  } catch { /* ignore */ }

  /** Exact UI dictionary: Chinese source string -> English translation. */
  const DICT = new Map([
    // Brand & Page Titles
    ['工作台 · 织页 TabLoom', 'Workbench · TabLoom'],
    ['织页 TabLoom · 侧边栏', 'TabLoom · Side Panel'],
    ['织页 TabLoom', 'TabLoom'],
    ['快速搜索', 'Quick Search'],
    ['AI 语义分组工作台 · 实时防重 · 全局秒搜', 'AI Tab Workbench · Dedup Guard · Instant Search'],
    ['开发者模式 · 实时分组与防重', 'Dev Mode · Live Grouping & Dedup Guard'],
    ['本地 AI 标签织理', 'Local AI Tab Loom'],

    // Topbar & Hero
    ['守护服务已连接', 'Daemon Online'],
    ['服务未启动', 'Service Offline'],
    ['检测中…', 'Checking…'],
    ['点击一键启动本机守护服务', 'Click to start local daemon'],
    ['上次整理 --', 'Last run --'],
    ['工作标签', 'Workspace Tabs'],
    ['搜索已开标签、书签（b 关键词）或 Google（g 关键词）…', 'Search tabs, bookmarks (b query), or Google (g query)…'],
    ['搜索标签、书签（b 关键词）、历史（h 关键词）或 Google（g 关键词）…', 'Search tabs, bookmarks (b), history (h), or Google (g)…'],
    ['搜索标签、书签、浏览历史或网页', 'Search tabs, bookmarks, browsing history, or web'],
    ['按标题、文件夹或网址搜索书签…', 'Search bookmarks by title, folder, or URL…'],
    ['按关键字或网址搜索浏览历史…', 'Search browsing history by keyword or URL…'],
    ['搜索标签、书签、浏览历史或网页…', 'Search tabs, bookmarks, history, or web…'],
    ['搜索标签、书签或浏览历史…', 'Search tabs, bookmarks, or history…'],
    ['搜索标签、分组或命令…', 'Search tabs, groups, or commands…'],
    ['搜索书签…', 'Search bookmarks…'],
    ['搜索浏览历史…', 'Search browsing history…'],
    ['执行搜索', 'Run Search'],
    ['搜索', 'Search'],
    ['综合', 'All'],
    ['标签', 'Tabs'],
    ['书签', 'Bookmarks'],
    ['历史', 'History'],
    ['标签：', 'Tabs:'],
    ['唤起综合搜索（⌘K）', 'Open Quick Search (⌘K)'],
    ['唤起综合搜索', 'Open Quick Search'],
    ['打开设置（优先在右侧扩展侧边栏中打开）', 'Open Settings (Side Panel preferred)'],
    ['打开设置', 'Open Settings'],
    ['关闭整理设置', 'Close Settings'],
    ['打开整理设置', 'Open Settings'],

    // Stats & Toolbar
    ['分组', 'Groups'],
    ['存量重复', 'Duplicates'],
    ['窗口', 'Windows'],
    ['立即整理', 'Organize Now'],
    ['AI 整理中…', 'Organizing…'],
    ['整理范围与模式', 'Organize Scope & Mode'],
    ['整理范围与模式（浮动菜单）', 'Organize Scope & Mode'],
    ['整理范围与视图选项', 'Scope & View Options'],
    ['整理与看板范围', 'Scope & Board'],
    ['窗口范围', 'Window Scope'],
    ['全部窗口', 'All Windows'],
    ['当前工作分组', 'Active Work Group'],
    ['在视图中置顶', 'Pin to Top'],
    ['取消置顶', 'Unpin'],
    ['批量勾选全部分组', 'Select All Groups'],
    ['清理存量重复', 'Deduplicate'],
    ['关闭存量重复网址标签，保留活跃或最左一个', 'Close duplicate tabs, keeping active or leftmost'],
    ['撤销去重', 'Undo Dedup'],
    ['释放内存', 'Free Memory'],
    ['将非活跃的后台标签置入 Chrome 原生休眠状态以立即释放内存（保留标签位与标题）', 'Discard inactive background tabs to free RAM immediately'],
    ['已关闭分组 / 空间', 'Archives / Spaces'],
    ['查看已关闭分组与空间快照', 'View archived groups & window spaces'],
    ['折叠全部', 'Collapse All'],
    ['展开全部', 'Expand All'],
    ['全部折叠', 'Collapse All'],
    ['全部展开', 'Expand All'],

    // Banners & Suggestions
    ['正在调用本机 CLI 模型分析归组…', 'Running local CLI model to organize tabs…'],
    ['防重已拦截', 'Dup Blocked'],
    ['已拦截重复新开标签并跳转至已打开页', 'Duplicate tab blocked; switched to existing tab'],
    ['仍要新开一份', 'Open Anyway'],
    ['域名加白名单', 'Whitelist Host'],
    ['关闭提示', 'Dismiss'],
    ['置顶收藏', 'Pinned Favorites'],
    ['加入置顶收藏', 'Pin to favorites'],
    ['加入置顶收藏，方便快速切换', 'Pin to favorites for quick switch'],
    ['取消置顶收藏', 'Unpin favorite'],
    ['已加入置顶收藏', 'Pinned to favorites'],
    ['已取消置顶收藏', 'Removed from favorites'],
    ['未打开 · 点击重开', 'Closed · Click to reopen'],
    ['刚刚', 'just now'],
    ['未选择分组', 'No groups selected'],
    ['先将完整链接与分组写入本机归档，再关闭标签。', 'Links and group metadata are saved locally before closing tabs.'],
    ['保存并关闭所选分组', 'Archive & Close Selected'],
    ['取消选择', 'Clear Selection'],
    ['查看清单', 'View List'],
    ['收起清单', 'Hide List'],
    ['一键休眠', 'Hibernate All'],
    ['一键清理', 'Clean Up All'],
    ['不关闭标签，仅将闲置候选置入休眠以释放内存', 'Discard idle candidates without closing tabs'],
    ['一键关闭所有超过 7 天未访问的候选标签（固定/活动/有声标签已排除）', 'Close all candidate tabs idle > 7 days (pinned/active/audible excluded)'],
    ['没有匹配的标签页', 'No matching tabs'],
    ['尝试缩短搜索词，或使用上方搜索框直接检索书签与 Google', 'Try shorter keywords, or search Bookmarks / Google above'],

    // Archives & Spaces Modal
    ['已关闭分组与工作空间', 'Archived Groups & Spaces'],
    ['只保存链接与分组结构，可跨浏览器重启恢复', 'Stores URLs & group structure across browser restarts'],
    ['关闭', 'Close'],
    ['已关闭分组', 'Archived Groups'],
    ['快速关闭或保存分组', 'Quick close or save group'],
    ['关闭或保护分组', 'Close or Protect Group'],
    ['已加锁', 'Locked'],
    ['已加锁保护（禁止自动清理/去重）；点击解锁', 'Locked (protected from auto-cleanup & dedup); click to unlock'],
    ['加锁保护分组（禁止自动清理该分组标签）', 'Lock group (prevent auto-cleanup of its tabs)'],
    ['关闭分组（保留可重新打开）', 'Close Group (Keep to Reopen)'],
    ['关闭当前标签并保留分组与链接，可随时从「已关闭分组」一键重开', 'Close tabs & save group structure to reopen anytime from Archives'],
    ['解散并关闭所有标签页', 'Dissolve & Close All Tabs'],
    ['分组已加锁，解锁后才可彻底关闭', 'Group is locked; unlock before permanently closing'],
    ['解锁分组', 'Unlock Group'],
    ['加锁保护分组', 'Lock Group'],
    ['解除加锁，允许自动清理、去重与彻底关闭', 'Allow auto-cleanup, dedup, and closing'],
    ['锁定后不允许自动清理、去重关闭或自动移出组内标签', 'Block auto-cleanup, dedup closing, and AI regrouping'],
    ['重命名分组（固定名称）', 'Rename Group (Pin Name)'],
    ['已手动固定名称，AI 整理不再自动改名；点击可修改', 'Name manually pinned; AI organize will preserve it'],
    ['自定义分组名称，后续 AI 整理不再自动修改', 'Set a custom name preserved across future AI organizes'],
    ['输入分组名称', 'Group name'],
    ['输入分组名称…', 'Enter group name…'],
    ['输入标签名称', 'Enter tab name'],
    ['输入标签名称…', 'Enter tab name…'],
    ['重命名标签', 'Rename tab'],
    ['点击切换 · 右侧铅笔或双击可重命名', 'Click to switch · Pencil or double-click to rename'],
    ['双击可重命名标签', 'Double-click to rename tab'],
    ['已固定', 'Pinned'],
    ['重命名分组并固定名称', 'Rename & pin group name'],
    ['已手动固定分组名称，AI 不再自动改名；点击修改', 'Name pinned (AI will not rename); click to edit'],
    ['已手动命名，AI 自动整理不再更改名称', 'Custom name pinned; AI will not alter it'],
    ['还没有保存并关闭的分组', 'No archived groups yet'],
    ['整窗空间快照', 'Window Spaces'],
    ['空间名称，如：大促作战布局…', 'Space name, e.g. Release Sprint…'],
    ['保存当前布局', 'Save Workspace'],
    ['还没有保存的空间', 'No saved spaces yet'],
    ['存量重复标签清单', 'Duplicate Tabs List'],
    ['一键关闭重复项', 'Close All Duplicates'],
    ['去重白名单（点击 × 移除）', 'Dedup Whitelist (click × to remove)'],

    // Group Cards & Tabs
    ['当前工作分组 · 已在视图置顶', 'Active Group · Pinned at Top'],
    ['当前浏览标签所属分组（仅调整视图展示顺序，不移动原生标签条）', 'Group of your active tab (view order only; browser strip unchanged)'],
    ['当前', 'Active'],
    ['最近浏览', 'Recent'],
    ['已休眠', 'Sleeping'],
    ['该标签已休眠释放内存，点击切换时自动唤醒', 'Tab discarded to save memory; reloads automatically when selected'],
    ['移动', 'Move'],
    ['移出分组', 'Ungroup'],
    ['搜索目标分组…', 'Search target group…'],
    ['移动到同窗口的其他分组', 'Move to another group in this window'],
    ['关闭标签', 'Close Tab'],
    ['点击折叠/展开；拖动标题区域调整 Chrome 分组顺序', 'Click to collapse/expand; drag header to reorder group'],
    ['未分组', 'Ungrouped'],
    ['未命名组', 'Untitled Group'],
    ['整理此窗口', 'Organize Window'],
    ['忽略此组重复（加入白名单）', 'Ignore duplicates for this URL'],

    // Settings Drawer & Sidepanel
    ['工作台设置', 'Workbench Settings'],
    ['多 Agent CLI 通道 · 实时防重复 · 守护与热升级', 'Multi-Agent CLIs · Dedup Guard · Daemon & Updates'],
    ['常驻', 'Pin'],
    ['收起设置栏', 'Close Settings'],
    ['设置模式 · 唯一设置归宿', 'Settings Mode'],
    ['当前在主页，侧边栏展示完整设置；切到普通网页时自动变为 Tab List', 'Full settings shown on Home; switches to Tab List on normal pages'],
    ['标签列表 · 当前窗口', 'Tab List · Current Window'],
    ['标签列表', 'Tab List'],
    ['AI 引擎通道（本机多 Agent CLI 直调）', 'AI Engine (Local Multi-Agent CLIs)'],
    ['体检 CLI', 'Check CLIs'],
    ['加载中…', 'Loading…'],
    ['搜索可用选项…', 'Search options…'],
    ['未找到匹配项', 'No matches found'],
    ['本机服务守护与自动升级', 'Local Daemon & Auto Update'],
    ['检查更新', 'Check Updates'],
    ['正在检测本机服务…', 'Checking local daemon…'],
    ['正在检查 LaunchAgent 常驻与 Native 唤醒状态…', 'Checking LaunchAgent & Native Host status…'],
    ['检测本地守护服务与版本状态…', 'Checking daemon & version status…'],
    ['▶ 一键启动服务', '▶ Start Service'],
    ['首次使用需在终端执行一次安装，之后即可在浏览器内一键唤醒或开机自启：', 'First-time setup requires running this command once; afterwards browser wake works automatically:'],
    ['复制安装并启动命令', 'Copy Install & Start Command'],
    ['重新检测', 'Recheck'],
    ['↑ 立即拉取更新并热重载扩展', '↑ Pull Update & Reload Extension'],
    ['↑ 立即拉取更新并重启重载', '↑ Pull Update & Restart Extension'],
    ['查看最新安装包说明', 'View Latest Installer Guide'],
    ['拉取更新中…', 'Pulling Update…'],
    ['发现新版本，点击检查并一键升级', 'Update available — click to check & apply'],
    ['发现新版本，可点击一键拉取更新', 'Update available — click to pull & restart'],
    ['当前已是最新版本', 'Already up to date'],
    ['立即拉取并热重载', 'Pull Update & Reload'],
    ['防止重复标签与去重白名单', 'Duplicate Guard & Whitelist'],
    ['AI 建议', 'AI Suggest'],
    ['一键采纳', 'Apply All'],
    ['叠加更新', 'Apply Refinement'],
    ['叠加优化规则', 'Layered Refinement'],
    ['分析当前页面内容与 URL 参数，推荐聚合标识层级规则', 'Analyze page content & URL params to suggest aggregation rules'],
    ['优化已有聚合规则', 'Refine Existing Rule'],
    ['新增聚合标识规则', 'New Aggregation Rule'],
    ['预览拆分', 'Preview Buckets'],
    ['内容分析', 'Content Analysis'],
    ['搜索 Path 层级…', 'Search path depth…'],
    ['Path 自动', 'Auto Path'],
    ['1 级', 'Depth 1'],
    ['2 级', 'Depth 2'],
    ['3 级', 'Depth 3'],
    ['4 级', 'Depth 4'],
    ['5 级', 'Depth 5'],
    ['仅域名', 'Host Only'],
    ['新开重复标签时实时拦截并跳转', 'Intercept & Switch on Duplicate Tabs'],
    ['打开已存在的 URL（忽略锚点）时，立即关闭新标签并激活跳转到已有标签页', 'Auto-close newly opened duplicate URLs and switch to existing tab'],
    ['打开已存在的 URL 时自动切回已有标签页并关闭重复新页', 'Auto-close duplicate URLs and jump to existing tab'],
    ['去重白名单（以下域名允许同时多开，不触发实时拦截）：', 'Whitelist (these domains allow multiple tabs):'],
    ['去重白名单（支持域名、通配 https://host/path/* 或正则 /.../）：', 'Whitelist (domain, https://host/path/*, or /regex/):'],
    ['去重白名单（支持域名、通配 https://host/path/* 或正则 /.../，匹配页可多开）：', 'Whitelist (domain, https://host/path/*, or /regex/ — matching pages allow multi-open):'],
    ['添加允许重复打开的域名，如 github.com', 'Add whitelisted host, e.g. github.com'],
    ['添加允许双开的域名，如 localhost:3000', 'Add whitelisted host, e.g. localhost:3000'],
    ['域名、路径通配 */path/* 或 /正则/', 'Domain, */path/* or /regex/'],
    ['添加去重白名单规则', 'Add whitelist rule'],
    ['请输入域名、通配路径或正则规则', 'Enter a domain, wildcard path, or regex rule'],
    ['请输入测试规则，或先添加至少一条白名单规则', 'Enter a test rule or add at least one whitelist rule first'],
    ['对照当前已打开的页面测试匹配情况', 'Test against currently open tabs'],
    ['当前已打开页面中暂无命中项', 'No currently open tabs match this rule'],
    ['收起测试结果', 'Dismiss test results'],
    ['测试', 'Test'],
    ['添加', 'Add'],
    ['搜索与常规页面入口', 'Search & Web Page Entry'],
    ['普通网页右侧显示悬浮搜索胶囊', 'Show Floating Search Pill on Web Pages'],
    ['在常规网页右侧边缘贴附轻量 ⌘K 胶囊（Shadow DOM 隔离，支持拖拽与单站点隐藏）', 'Attach lightweight ⌘K pill on web pages (Shadow DOM isolated, draggable)'],
    ['在常规网页右侧边缘贴附轻量 ⌘K 胶囊', 'Attach lightweight ⌘K pill on web pages'],
    ['⌘K 全局综合搜索', '⌘K Global Quick Search'],
    ['快捷键设置', 'Shortcuts'],
    ['正在检查搜索快捷键…', 'Checking search shortcut…'],
    ['绑定「打开搜索（标签 / 书签 / Google）」命令', 'Bound to Quick Search command'],
    ['本地书签与历史实时检索', 'Local Bookmarks & History Search'],
    ['读取浏览器本地书签与历史记录，纯离线毫秒响应。', 'Uses local Chrome bookmarks & history with instant response.'],
    ['读取浏览器本地书签与历史，支持 b / h / g 前缀直搜', 'Uses local Chrome bookmarks & history (b / h / g prefixes)'],
    ['刷新统计', 'Refresh Count'],
    ['统计中…', 'Counting…'],
    ['新标签页接管', 'New Tab Override'],
    ['已接管 chrome://newtab', 'Handling chrome://newtab'],
    ['自检', 'Verify'],
    ['检测中…', 'Checking…'],
    ['自动整理与外观', 'Auto-Organize & Appearance'],
    ['新标签自动归组', 'Auto-Group New Tabs'],
    ['自动整理防抖等待', 'Auto-Organize Debounce'],
    ['页面加载后按窗口合并计时（支持 5 秒~60 分钟自定义）', 'Batched per window after load (5s ~ 60m custom supported)'],
    ['按窗口合并新标签分析（支持 5 秒~60 分钟自定义）', 'Batched per window (5s ~ 60m custom supported)'],
    ['搜索等待时长…', 'Search delay…'],
    ['自定义时长…', 'Custom duration…'],
    ['秒', 'sec'],
    ['分钟', 'min'],
    ['小时', 'hr'],
    ['应用', 'Apply'],
    ['取消', 'Cancel'],
    ['支持范围：5 秒 ~ 3600 秒（60 分钟）', 'Range: 5 sec ~ 3600 sec (60 min)'],
    ['打开首页时自动整理未分组标签', 'Auto-Organize Ungrouped Tabs on Home Open'],
    ['紧凑卡片密度', 'Compact Card Density'],
    ['外观主题', 'Appearance Theme'],
    ['自动', 'Auto'],
    ['浅色', 'Light'],
    ['深色', 'Dark'],
    ['跟随系统外观', 'Follow system theme'],
    ['始终浅色', 'Always light'],
    ['始终深色', 'Always dark'],
    ['界面语言', 'Language'],
    ['内存释放与空闲休眠', 'Memory Saver & Idle Sleep'],
    ['一键释放内存', 'Free Memory Now'],
    ['立即休眠当前窗口的非活跃后台标签', 'Discard inactive background tabs in current window'],
    ['立即休眠非活跃标签释放内存', 'Discard inactive tabs immediately'],
    ['空闲标签自动进入休眠模式', 'Auto-Sleep Idle Tabs'],
    ['定时将长时间未访问的后台标签置入休眠以降低内存占用（排除固定、活动、有声页）', 'Automatically discard inactive tabs over threshold (pinned/active/audible excluded)'],
    ['排除活动、固定与有声页；保留标签位置与标题，点开即秒级恢复', 'Excludes active, pinned & audible tabs; instant wake on click'],
    ['未访问多久进入休眠', 'Sleep After Inactivity'],
    ['支持 5 分钟 ~ 30 天自定义阈值', 'Custom threshold: 5 min ~ 30 days'],
    ['支持 5 分钟 ~ 30 天自定义', '5 min ~ 30 days supported'],
    ['搜索休眠阈值…', 'Search sleep threshold…'],
    ['支持范围：5 分钟 ~ 720 小时（30 天）', 'Range: 5 min ~ 720 hr (30 days)'],
    ['记录与回滚', 'History & Rollback'],
    ['还没有整理记录', 'No organize runs yet'],
    ['按页面内容生成短标题，已分析结果保存在本地。', 'Short titles & summaries cached locally.'],
    ['在当前页打开综合搜索浮层', 'Open Quick Search Overlay'],
    ['定位当前', 'Locate'],
    ['一键定位到当前激活标签', 'Locate Active Tab'],
    ['一键定位并滚动到当前激活标签', 'Scroll to Active Tab'],
    ['当前窗口暂无可定位的活动标签', 'No active webpage tab in this window'],
    ['当前活动标签未在列表中显示', 'Active tab not shown in list'],
    ['去重', 'Dedup'],
    ['展开完整设置（CLI 引擎 / 白名单 / 守护）', 'Show Full Settings (CLIs / Whitelist / Daemon)'],
    ['收起完整设置', 'Hide Full Settings'],
    ['按标题或域名过滤标签…', 'Filter tabs by title or host…'],
    ['分组保存与恢复', 'Group Archive & Restore'],
    ['清除选择', 'Clear'],
    ['保存链接与分组，不保存未提交内容', 'Saves links & groups (unsaved form input is not preserved)'],
    ['本机保存，恢复到当前窗口。仅恢复链接与分组。', 'Saved locally; restores URLs & groups to this window.'],
    ['刷新记录', 'Refresh'],
    ['按 Chrome 最近访问时间建议；排除活动、固定和有声标签。', 'Based on last access time; active, pinned & audible tabs excluded.'],
    ['刷新建议', 'Refresh'],

    // Popup
    ['整理当前窗口', 'Organize Current Window'],
    ['AI 语义分组，预览后应用', 'AI semantic grouping with preview'],
    ['一键去重', 'Deduplicate'],
    ['恢复', 'Restore'],
    ['分组预览', 'Group Preview'],
    ['应用分组', 'Apply Groups'],
    ['应用中…', 'Applying…'],
    ['重新生成', 'Regenerate'],
    ['撤销', 'Undo'],
    ['再整理一次', 'Organize Again'],
    ['模型', 'Model'],
    ['服务地址', 'Service URL'],
    ['自动整理新标签（30s 防抖）', 'Auto-group new tabs (30s debounce)'],
    ['打开首页工作台', 'Open TabLoom Workbench'],
    ['打开 AI 侧边栏', 'Open TabLoom Side Panel'],
    ['快速搜索历史 (h)', 'Quick History Search (h)'],
    ['输入 /h 或 h 空格 搜索浏览历史与近期关闭', 'Type /h or h + space for browsing history & recently closed'],
    ['请输入历史搜索词', 'Enter history search keywords'],

    // Command+K Palette
    ['网址直达', 'Direct URL'],
    ['已打开直达', 'Open Tab'],
    ['最近打开', 'Recent'],
    ['最近关闭', 'Recently Closed'],
    ['最近关闭 · 点击恢复', 'Recently closed · Click to reopen'],
    ['近期关闭', 'Recently closed'],
    ['收起', 'Dismiss'],
    ['加载中…', 'Loading…'],
    ['标签页', 'Tabs'],
    ['浏览历史', 'Browsing History'],
    ['网页搜索', 'Web Search'],
    ['选择', 'Navigate'],
    ['打开', 'Open'],
    ['复制', 'Copy'],
    ['复制链接', 'Copy URL'],
    ['已复制', 'Copied'],
    ['复制失败，请手动复制', 'Copy failed, please copy manually'],
    ['关闭', 'Close'],
    ['没有匹配的结果', 'No matching results'],
    ['正在加载标签和分组…', 'Loading tabs and groups…'],
    ['正在加载…', 'Loading…'],
    ['加载失败，请关闭后重新打开重试', 'Load failed, close and reopen to retry'],
    ['标签加载失败，请关闭后重试', 'Tab load failed, close and try again'],
    ['撤销上次整理', 'Undo Last Organize'],
    ['恢复到整理前', 'Revert previous group changes'],
    ['关闭重复标签，可恢复', 'Close duplicate tabs (undoable)'],
    ['循环切换主题', 'Cycle Theme'],
    ['自动 → 浅色 → 深色', 'Auto → Light → Dark'],
    ['切换语言（中文 / English）', 'Switch Language (中文 / English)'],
    ['实时切换中英文界面', 'Toggle Chinese / English UI'],
    ['全窗口标签聚合', 'All-window tab hub'],
    ['实时分组视图', 'Live side panel view'],
    ['定位到该分组', 'Focus this group'],
    ['按 Enter 在新标签页搜索网页', 'Press Enter to search web in new tab'],
    ['就绪', 'Ready'],
    ['未安装', 'Not Installed'],
    ['已切换为简体中文', 'Switched to Simplified Chinese'],
    ['分组顺序已调整', 'Group order updated'],
    ['已关闭分组与空间快照', 'Archived Groups & Spaces'],
    ['搜索已绑定 ⌘K；全局范围请在 Chrome 设置中确认。', 'Shortcut bound to ⌘K; manage global scope in chrome://extensions/shortcuts.'],
    ['开发者模式已加载 · 守护进程 127.0.0.1:8787', 'Dev Mode Active · Daemon 127.0.0.1:8787'],
    ['页面摘要经本机服务发往所选 Agent CLI 模型；标签、书签与历史检索完全在浏览器本地完成。', 'Page summaries are routed locally to your selected Agent CLI; tab, bookmark & history search stays 100% local.'],
    ['选择模型…', 'Search models…'],
    ['选择窗口范围…', 'Search window scope…'],
  ]);

  const PATTERNS = [
    [/^(\d+)\s*秒$/, (_, n) => `${n}s`],
    [/^(\d+)\s*分钟$/, (_, n) => `${n}m`],
    [/^(\d+)\s*小时$/, (_, n) => `${n}h`],
    [/^(\d+)\s*天$/, (_, n) => `${n}d`],
    [/^(\d+)\s*(秒|分钟|小时)[（(]自定义[）)]$/, (_, n, u) => `${n} ${u === '秒' ? 'sec' : u === '分钟' ? 'min' : 'hr'} (Custom)`],
    [/^已拦截重复新开标签并跳转至已打开页：(.+)$/, (_, t) => `Blocked duplicate tab & switched to: ${t}`],
    [/^搜索已绑定\s*([^\s；;]+)[；;].*$/, (_, key) => `Shortcut bound to ${key}; configure in chrome://extensions/shortcuts`],
    [/^(\d+)\s*标签$/, (_, n) => `${n} ${Number(n) === 1 ? 'tab' : 'tabs'}`],
    [/^(\d+)\s*天未访问$/, (_, n) => `${n}d idle`],
    [/^保存并关闭\s*(\d+)\s*组$/, (_, n) => `Archive & Close (${n})`],
    [/^展开其余\s*(\d+)\s*个标签$/, (_, n) => `Show ${n} more tabs`],
    [/^共\s*(\d+)\s*个标签\s*·\s*收起其余标签$/, (_, n) => `${n} tabs · Collapse extra`],
    [/^上次整理\s*(.+)$/, (_, t) => `Last run ${t}`],
    [/^全部窗口\s*\((\d+)\)$/, (_, n) => `All Windows (${n})`],
    [/^当前窗口（(\d+)\s*标签）$/, (_, n) => `Current Window (${n} tabs)`],
    [/^窗口\s*(\d+)（(\d+)\s*标签）$/, (_, id, n) => `Window ${id} (${n} tabs)`],
    [/^清理建议：暂未发现超过\s*7\s*天未访问的可清理标签$/, () => 'Cleanup Advice: No background tabs idle > 7 days'],
    [/^清理建议：(\d+)\s*个标签超过\s*7\s*天未访问$/, (_, n) => `Cleanup Advice: ${n} tabs idle > 7 days`],
    [/^依据最近访问时间，不代表真实打开时长；不会自动关闭，可手动一键清理或先休眠释放内存。固定、活动和播放声音的标签已排除。$/, () => 'Based on last access time; never auto-closes. Pinned, active, and audible tabs are excluded.'],
    [/^依据最近访问时间，不代表真实打开时长；不会自动关闭。固定、活动和播放声音的标签已排除。$/, () => 'Based on last access time; never auto-closes. Pinned, active & audible tabs excluded.'],
    [/^(\d+)\s*组、(\d+)\s*标签$/, (_, g, t) => `${g} groups · ${t} tabs`],
    [/^(\d+)\s*标签、(\d+)\s*分组(.*)$/, (_, t, g, rest) => `${t} tabs · ${g} groups${rest.replace('、匹配 ', ' · Matched ')}`],
    [/^已选\s*(\d+)\s*个\s*Chrome\s*分组、(\d+)\s*个标签（整组）$/, (_, g, t) => `Selected ${g} groups (${t} tabs)`],
    [/^(\d+)\s*项$/, (_, n) => `${n} items`],
    [/^来源：(.+)$/, (_, s) => `Source: ${s === '全部' ? 'All' : s === '标签' ? 'Tabs' : s === '历史' ? 'History' : s === '书签' ? 'Bookmarks' : s}`],
    [/^Google 搜索「(.+)」$/, (_, q) => `Google Search "${q}"`],
    [/^请输入(.+)搜索词$/, (_, s) => `Enter ${s === '书签' ? 'bookmark' : s === '历史' ? 'history' : s} search query`],
    [/^输入(.+)搜索词…$/, (_, s) => `Enter ${s === '书签' ? 'bookmark' : s === '历史' ? 'history' : s} query…`],
    [/^已切换为(.+)$/, (_, x) => `Language: ${x}`],
    [/^主题：跟随系统（当前(深色|浅色)）$/, (_, t) => `Theme: Auto (${t === '深色' ? 'Dark' : 'Light'})`],
    [/^主题：(自动|浅色|深色)$/, (_, t) => `Theme: ${t === '浅色' ? 'Light' : t === '深色' ? 'Dark' : 'Auto'}`],
    [/^已将\s*(\d+)\s*个非活跃标签置入休眠以释放内存$/, (_, n) => `Put ${n} inactive tabs to sleep to free RAM`],
    [/^当前窗口暂无可休眠的后台标签$/, () => 'No eligible background tabs to sleep'],
    [/^自动整理等待：(.+)$/, (_, v) => `Auto-organize delay: ${v}`],
    [/^空闲自动休眠阈值：(.+)$/, (_, v) => `Idle sleep threshold: ${v}`],
    [/^LaunchAgent 常驻 \+ Native 唤醒已就绪$/, () => 'LaunchAgent + Native Wake Ready'],
    [/^已连接本机守护服务$/, () => 'Daemon Connected'],
    [/^当前版本\s*(v[\d.]+)\s*·\s*开发者模式本地目录（守护服务\s*在线）$/, (_, v) => `Version ${v} · Dev Mode Local (Daemon Online)`],
    [/^检查\s*(\d+)\s*个已打开页面，命中\s*(\d+)\s*个（(.+)）$/, (_, total, matched, label) => `Checked ${total} open tabs, ${matched} matched (${label})`],
    [/^仅展示前\s*20\s*项，共命中\s*(\d+)\s*个页面$/, (_, total) => `Showing first 20 of ${total} matched tabs`],
    [/^点击对照当前已打开页面测试：(.+)$/, (_, rule) => `Click to test against open tabs: ${rule}`],
    [/^已切换到：(.+)$/, (_, t) => `Switched to: ${t}`],
    [/^已打开收藏：(.+)$/, (_, t) => `Opened favorite: ${t}`],
    [/^已重命名标签为「(.+)」$/, (_, name) => `Renamed tab to "${name}"`],
    [/^(\d+)\s*秒前$/, (_, n) => `${n}s ago`],
    [/^(\d+)\s*分钟前$/, (_, n) => `${n}m ago`],
    [/^(\d+)\s*小时前$/, (_, n) => `${n}h ago`],
    [/^(\d+)\s*天前$/, (_, n) => `${n}d ago`],
  ];

  function getUiLang() {
    return uiLang;
  }

  function translateText(input) {
    if (uiLang !== 'en' || input == null) return input;
    const raw = String(input);
    const leading = raw.match(/^\s*/)[0];
    const trailing = raw.match(/\s*$/)[0];
    const core = raw.trim();
    if (!core) return raw;
    if (DICT.has(core)) return leading + DICT.get(core) + trailing;
    for (const [re, fmt] of PATTERNS) {
      const m = core.match(re);
      if (m) return leading + fmt(...m) + trailing;
    }
    return raw;
  }

  let applying = false;
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'TEXTAREA']);
  const SKIP_CLOSEST = 'code, pre, script, style, .t, .tab-domain, .tab-summary, .gname, .dup-title, .palette-title, .palette-sub, .archive-summary, .space-name, #svcCmd, #model-meta, .cli-card-name, .cli-card-sub, .pill-cli, .pill-model, .last-sub, #contextStatus, .wl-chip > span, .wl-item > span, .wl-test-title, .wl-test-url, .fav-title';

  function applySpecialDomBlocks() {
    const ledeTabs = document.getElementById('ledeTabs');
    const lede = ledeTabs?.parentElement;
    if (lede?.classList?.contains('lede') && lede.dataset.i18nLang !== uiLang) {
      lede.dataset.i18nLang = uiLang;
      const tabsCount = ledeTabs.textContent || '0';
      const groupsCount = document.getElementById('ledeGroups')?.textContent || '0';
      lede.innerHTML = uiLang === 'en'
        ? `<span id="ledeTabs">${tabsCount}</span> tabs organized by AI into <span id="ledeGroups">${groupsCount}</span> groups · <b>Auto duplicate-tab guard active</b>`
        : `<span id="ledeTabs">${tabsCount}</span> 个标签已由 AI 归入 <span id="ledeGroups">${groupsCount}</span> 个分组 · <b>新开重复标签已开启自动拦截跳转</b>`;
    }
    const hint = document.getElementById('searchPrefixHint');
    if (hint && hint.dataset.i18nLang !== uiLang) {
      hint.dataset.i18nLang = uiLang;
      hint.innerHTML = uiLang === 'en'
        ? 'Prefix <kbd>b</kbd> Bookmarks · <kbd>h</kbd> History · <kbd>g</kbd> Google · <kbd>/</kbd> Tabs'
        : '句首 <kbd>b</kbd> 书签 · <kbd>h</kbd> 历史 · <kbd>g</kbd> Google · <kbd>/</kbd> 标签';
    }
  }

  function processElement(el) {
    if (!el || el.nodeType !== 1 || SKIP_TAGS.has(el.tagName)) return;
    if (el.matches?.(SKIP_CLOSEST)) return;

    // Attributes: placeholder, title, aria-label (never mutates child DOM during TreeWalker)
    for (const [attr, cacheKey] of [['placeholder', 'zhPlaceholder'], ['title', 'zhTitle'], ['aria-label', 'zhAriaLabel']]) {
      const cur = el.getAttribute(attr);
      if (!cur) continue;
      if (!el.dataset[cacheKey]) el.dataset[cacheKey] = cur;
      const base = el.dataset[cacheKey];
      const target = uiLang === 'en' ? translateText(base) : base;
      if (cur !== target) el.setAttribute(attr, target);
    }
  }

  function applyDomI18n(root = document.body || document.documentElement) {
    if (!root || applying) return;
    applying = true;
    try {
      if (!document._zhTitle) document._zhTitle = document.title;
      const targetTitle = uiLang === 'en' ? translateText(document._zhTitle) : document._zhTitle;
      if (document.title !== targetTitle) document.title = targetTitle;

      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.nodeType === 1) {
          processElement(node);
        } else if (node.nodeType === 3) {
          const parent = node.parentElement;
          if (!parent || SKIP_TAGS.has(parent.tagName) || parent.closest(SKIP_CLOSEST)) continue;
          if (parent.closest('.lede') || parent.closest('#searchPrefixHint')) continue;
          const cur = node.nodeValue;
          if (!cur || !cur.trim()) continue;
          if (node._zhSource == null || (uiLang === 'zh' && cur !== node._zhSource && DICT.has(cur.trim()))) {
            node._zhSource = cur;
          }
          const base = node._zhSource;
          const next = uiLang === 'en' ? translateText(base) : base;
          if (next !== cur) {
            if (uiLang === 'en' && next === base) {
              // If DOM was overwritten by JS with a fresh Chinese string while in EN mode, refresh _zhSource and translate it!
              const retried = translateText(cur);
              if (retried !== cur) {
                node._zhSource = cur;
                node.nodeValue = retried;
              }
            } else {
              node.nodeValue = next;
            }
          } else if (uiLang === 'en') {
            const retried = translateText(cur);
            if (retried !== cur) {
              node._zhSource = cur;
              node.nodeValue = retried;
            }
          }
        }
      }
      applySpecialDomBlocks();
      paintLangSeg();
    } finally {
      applying = false;
    }
  }

  function paintLangSeg() {
    document.querySelectorAll('[data-lang-seg]').forEach(seg => {
      for (const b of seg.querySelectorAll('button')) {
        const on = b.dataset.langMode === uiLang;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    });
  }

  function buildLangSegs() {
    document.querySelectorAll('[data-lang-seg]').forEach(seg => {
      if (seg.dataset.langBound) return;
      seg.dataset.langBound = '1';
      seg.innerHTML = LANG_MODES.map(m =>
        `<button type="button" role="radio" aria-checked="false" data-lang-mode="${m.id}" title="${m.title}">${m.label}</button>`
      ).join('');
      seg.addEventListener('click', e => {
        const b = e.target.closest('button[data-lang-mode]');
        if (b) setUiLang(b.dataset.langMode);
      });
      seg.addEventListener('keydown', e => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const i = LANG_MODES.findIndex(m => m.id === uiLang);
        const d = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
        const next = LANG_MODES[(i + d + LANG_MODES.length) % LANG_MODES.length];
        setUiLang(next.id);
        seg.querySelector(`button[data-lang-mode="${next.id}"]`)?.focus();
      });
    });
    paintLangSeg();
  }

  function applyLangState({ notify = false, announce = false } = {}) {
    document.documentElement.dataset.lang = uiLang;
    document.documentElement.lang = uiLang === 'en' ? 'en' : 'zh-CN';
    try { localStorage.setItem('uiLang', uiLang); } catch { /* ignore */ }
    applyDomI18n();
    if (notify) document.dispatchEvent(new CustomEvent('tt-lang-change', { detail: { lang: uiLang } }));
    if (announce && typeof toast === 'function') {
      toast(uiLang === 'en' ? 'Switched to English' : '已切换为简体中文', 'ok');
    }
  }

  async function setUiLang(next) {
    const mode = next === 'en' ? 'en' : 'zh';
    if (mode === uiLang) return;
    uiLang = mode;
    applyLangState({ notify: true, announce: true });
    try { await chrome.storage.sync.set({ uiLang: mode }); } catch { /* ignore */ }
  }

  let observerTimer = null;
  function startObserver() {
    if (typeof MutationObserver !== 'function') return;
    const obs = new MutationObserver(() => {
      if (applying || uiLang !== 'en') return;
      if (observerTimer) return;
      observerTimer = requestAnimationFrame(() => {
        observerTimer = null;
        if (uiLang === 'en') applyDomI18n();
      });
    });
    const root = document.body || document.documentElement;
    if (root) obs.observe(root, { childList: true, subtree: true, characterData: true });
  }

  async function initLang() {
    buildLangSegs();
    try {
      const res = await chrome.storage?.sync?.get?.('uiLang');
      if (res?.uiLang === 'en' || res?.uiLang === 'zh') uiLang = res.uiLang;
    } catch { /* ignore */ }
    applyLangState({ notify: true, announce: false });
    startObserver();
    chrome.storage?.onChanged?.addListener?.((changes, area) => {
      if (area === 'sync' && changes.uiLang) {
        const next = changes.uiLang.newValue === 'en' ? 'en' : 'zh';
        if (next !== uiLang) {
          uiLang = next;
          applyLangState({ notify: true, announce: false });
        }
      }
    });
  }

  window.getUiLang = getUiLang;
  window.setUiLang = setUiLang;
  window.translateUiText = translateText;
  window.applyDomI18n = applyDomI18n;
  window.tt = (zh, en) => (uiLang === 'en' ? en : zh);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initLang(), { once: true });
  } else {
    initLang();
  }
})();
