// FILE: localization/zhCNWhatsNew.ts
// Purpose: Exact Simplified Chinese copy for the curated release-history data.
// Boundary: Unknown/runtime text is returned unchanged; product and technical names stay verbatim.

const WHATS_NEW_TEXT: Readonly<Record<string, string>> = {
  "Follow subagents without losing the conversation": "查看子智能体进展，同时留在当前对话",
  "Claude and Codex child agents now have their own conversations, with compact launch cards and a roster in Environment and the right dock.":
    "Claude 和 Codex 子智能体现在拥有独立对话，启动卡片更紧凑，可在环境面板和右侧停靠栏查看列表。",
  "Inspect each brief, current step, elapsed time and result; open, message, background or stop supported runs. Nested and repeated invocations keep their own identity. Background results remain visible after the parent finishes; stopped work is shown as stopped rather than completed.":
    "查看任务摘要、当前步骤、耗时和结果；对受支持的运行可打开对话、发消息、转入后台或停止。嵌套和重复调用分别保留自己的身份。父智能体结束后仍能查看后台结果；已停止的工作会明确标为已停止。",
  "A clearer record of each turn": "每个回合的记录更清晰",
  "Turn headers and compact work groups make long conversations easier to scan, including interrupted turns and background tasks.":
    "回合标题和紧凑的工作分组让长对话更容易浏览，也能清楚查看被打断的回合与后台任务。",
  "Claude Monitor wake-ups appear as compact disclosures. Tool groups use clearer action summaries and icons, while assistant text and activity retain their chronological order. Live follow survives layout changes and thread switches; scrolling away keeps you in control.":
    "Claude Monitor 唤醒以紧凑的可展开条目显示。工具分组采用更清晰的动作摘要和图标，同时保持文字与活动的时间顺序。布局变化或切换会话后仍可跟随实时输出；向上滚动后由你掌控位置。",
  "Reopen long conversations faster": "更快重新打开长对话",
  "Recent messages load first, with Load earlier messages for older history and a private local cache for quicker reopening.":
    "优先加载最近消息；用「加载更早消息」查看旧记录，私有本地缓存让再次打开更快。",
  "Search, pinned messages and message links load the pages they need. Cached approvals, questions and queued sends wait for authoritative synchronization. Paging does not truncate saved history or exports; unavailable browser storage falls back to normal loading.":
    "搜索、置顶消息和消息链接会加载所需的历史页。缓存中的审批、问题和排队发送会等待权威同步。分页不会截断已保存的历史或导出；浏览器存储不可用时恢复普通加载。",
  "Stop also pauses your queued follow-ups": "停止也会暂停排队的后续消息",
  "Queued messages stay put after you stop a turn, encounter an error or hit a usage limit.":
    "停止回合、发生错误或达到用量限制后，排队消息会留在原处。",
  "Use Resume when you are ready. The pause survives reload, and an older rate-limit event does not pause an unrelated turn. Draft edits, attachments and failed sends remain recoverable instead of disappearing during thread creation or synchronization.":
    "准备好后使用「继续」。暂停状态在重新加载后保留，旧的限流事件不会暂停无关回合。草稿修改、附件和发送失败的内容都可恢复，不会在创建或同步会话时消失。",
  "Ask your agent to maintain Tasks": "让智能体维护 Tasks 待办",
  "Supported agent sessions can create, list and update the to-dos in your Tasks list directly from a chat.":
    "受支持的智能体会话可直接在对话中创建、列出和更新 Tasks 列表里的待办。",
  "Set notes, priority, due date and project, mark a to-do complete or reopen it. Retried creates use a request ID to avoid duplicates. These tools maintain the list; they do not dispatch the to-do to an agent. Moss permissions still apply.":
    "设置备注、优先级、截止时间和项目，完成或重新打开待办。重试创建会使用请求 ID 避免重复。这些工具只维护列表，不会把待办派给智能体；仍遵循 Moss 权限。",
  "Resolve Hub worker approvals in one place": "集中处理 Hub 工作智能体审批",
  "In Moss Beta, pending worker approvals appear above the coordinator composer, with links to the worker conversation.":
    "Moss Beta 的待处理工作智能体审批显示在协调智能体输入框上方，并附工作智能体对话链接。",
  "Approve once, allow the session when supported, decline or cancel the worker turn. Answering in either conversation clears the request in both. Only you can approve; the coordinator has no approval tool. Queued Hub tasks inherit the coordinator access mode unless explicitly overridden.":
    "可批准一次、在受支持时允许整个会话、拒绝或取消工作智能体回合。在任一对话答复都会清除两处请求。只有你能批准，协调智能体没有审批工具。排队的 Hub 任务默认继承协调智能体的访问模式，除非明确指定。",
  "Branch from the message you chose": "从你选择的消息分支",
  "Provider session forks now respect the selected message, and each chat remembers its own stacked or split diff layout.":
    "服务商会话分支现在遵循所选消息，每个对话分别记住堆叠或分屏的差异布局。",
  "Choose a default Diff layout in Settings without overwriting existing chat choices. Checkpoint initialization survives restart; Undo refuses to run while another chat is editing the same workspace. Detached Git status and automatic branch publication are handled more reliably.":
    "在设置中选择默认差异布局，不会覆盖已有会话的选择。检查点初始化可跨重启恢复；同一工作区有其他会话正在编辑时，撤销会拒绝执行。分离状态的 Git 检查和自动发布分支也更可靠。",
  "More dependable provider sessions": "服务商会话更可靠",
  "OpenCode v2 reconnects avoid duplicate text, Pi gets more time for its first startup, and Claude shows whether Fast mode is actually serving.":
    "OpenCode v2 重连避免重复文字，Pi 首次启动有更长等待时间，Claude 会显示 Fast 模式是否真正生效。",
  "Oh My Pi preserves explicit model choices and hides internal roles. Droid custom answers, Cursor prompt usage and completed OpenCode reasoning are retained. Antigravity preserves quota and OAuth failures, bounds helper cleanup and chooses effort only from discovered capabilities.":
    "Oh My Pi 保留明确选择的模型并隐藏内部角色。Droid 自定义回答、Cursor 提示用量和已完成的 OpenCode 推理都会保留。Antigravity 保留配额与 OAuth 错误，限制辅助进程清理，并只从已发现的能力中选择思考档位。",
  "Small improvements throughout the workspace": "工作区各处的细节改进",
  "Readable chat tabs, higher-contrast light terminals, a steadier context gauge and a working Create project action improve everyday use.":
    "更易读的会话标签、更高对比度的浅色终端、更稳定的上下文指示和可用的创建项目操作，让日常使用更顺畅。",
  "Composer panels no longer cover the transcript on glass. Linked right-to-left text keeps its direction, the voice waveform fills wide tracks, and hidden browser panels release stale bounds. Beta data import preserves this installation’s runtime identity.":
    "玻璃模式的输入框面板不再遮挡对话。带链接的从右向左文字保留方向，语音波形填满宽轨道，隐藏的浏览器面板会释放旧边界。Beta 数据导入会保留当前安装的运行身份。",
  "One terminal pane per chat": "每个会话一个终端窗格",
  "Use a single terminal in the main workspace or right dock, with no nested terminal tabs, groups, splits or bottom drawer.":
    "在主工作区或右侧停靠栏使用单个终端，不再有嵌套终端标签、分组、分屏或底部抽屉。",
  "Opening it again focuses the existing session. Project actions reuse an idle terminal; busy or unverifiable sessions are protected. Upgrading keeps the last active session and retires old nested sessions only after an idle check. Failed closes leave the terminal usable.":
    "再次打开会聚焦已有会话。项目操作会复用空闲终端；繁忙或无法确认的会话会受到保护。升级会保留最近活动的会话，只有通过空闲检查后才会退役旧的嵌套会话。关闭失败时终端仍可使用。",
  "Oh My Pi comes to Stable": "Oh My Pi 登陆 Stable",
  "Use Oh My Pi alongside the other supported coding providers in the Stable app.":
    "在 Stable 应用中，Oh My Pi 可与其他受支持的编程服务商一同使用。",
  "Configure the OMP executable and account, sign in from provider settings, and choose models and thinking levels advertised by its runtime.":
    "配置 OMP 可执行文件和账号，从服务商设置登录，并选择其运行时公布的模型和思考档位。",
  "See running work, chats needing attention, review requests and a daily activity recap together in Stable.":
    "在 Stable 中集中查看运行中的工作、需要关注的会话、审阅请求和每日活动回顾。",
  "Recaps use recorded local activity and provider-attributed usage; missing token data is not invented. The separate Tasks to-do list and its Inbox task cards remain Beta-only.":
    "回顾基于已记录的本地活动和按服务商归因的用量，不会编造缺失的 token 数据。独立的 Tasks 待办列表及其 Inbox 任务卡片仍为 Beta 专属。",
  "Tabs remain scrollable while chats stream. Unsent new-chat drafts stay out of the strip. Use Cmd+Ctrl+Left/Right on macOS, or Ctrl+PageUp/PageDown on other platforms outside terminal focus. Small vertical trackpad movements no longer reorder tabs.":
    "会话流式输出时标签仍可滚动。未发送的新会话草稿不会进入标签条。macOS 上用 Cmd+Ctrl+Left/Right，其它平台在终端焦点外用 Ctrl+PageUp/PageDown。触控板的轻微垂直滑动不再会重排标签。",
  "This opt-in feature waits for active work, approvals and questions, respects chat permissions, and limits retries. Uncertain dispatch or lack of progress pauses the watcher with an explanation. It does not automatically merge.":
    "这个可选功能会等待进行中的工作、审批和提问，尊重会话权限，并限制重试。投递不确定或没有进展时，监视器会暂停并说明原因。它不会自动合并。",
  "Choose 30 minutes, one hour, two hours, tomorrow at 9am or a custom time. Reminders persist across restart; Return now cancels the snooze. Running work continues. Snoozed chats are excluded from inactivity cleanup and are marked seen when opened after returning.":
    "可选 30 分钟、一小时、两小时、明天上午 9 点或自定义时间。提醒跨重启保留；「立即返回」取消休眠。运行中的工作不受影响。休眠的会话不参与不活跃清理，返回后打开时会标记为已读。",
  "Chats stay mounted across single/split transitions and rearrangements, preserving the split tree, focus and conversation state. Closing a split keeps the surviving chat; closing the last open tab returns to the unsent draft.":
    "会话在单屏/分屏切换和重排中保持挂载，分屏树、焦点和会话状态都被保留。关闭一个分屏会保留存活的会话；关闭最后一个打开的标签会回到未发送的草稿。",
  "Capture waits for real microphone audio before proceeding. ChatGPT login detection accepts Codex plain-text status; invalid transcription responses produce a useful error.":
    "采集会先等到真实的麦克风音频再继续。ChatGPT 登录检测接受 Codex 的纯文本状态；无效的转写响应会给出有用的错误。",
  "Choose whether finished turns fold and whether sending anchors the new message at the top. Wide code blocks scroll horizontally without widening the transcript. Full error, approval, progress and warning details remain available. Clearer thinking and startup icons distinguish activity states. Message navigation stays clear of the text, and batched updates no longer leave overlapping rows.":
    "可选已完成的回合是否折叠、发送后新消息是否锚定在顶部。宽代码块横向滚动而不撑宽会话。完整的错误、审批、进度和警告详情仍然可用。更清晰的思考与启动图标区分不同的活动状态。消息导航不会遮挡文本，批量更新也不再留下重叠的行。",
  "Native compaction waits for initialization; prompt-cache warnings avoid false expiry reports. Account-specific CLI paths are retained when Artifacts is enabled. Cache-recovery answers remain pending through slow compaction, with visible delivery status and retry after failure.":
    "原生压缩等待初始化完成；提示缓存警告避免误报过期。启用 Artifacts 时保留按账号划分的 CLI 路径。缓存恢复的回答在缓慢压缩期间保持待处理，投递状态可见，失败后可重试。",
  "Accepted commands are not blindly resent; rejected commands restore the draft. Delivery settlement requires a compatible server. HTTP fallback failures now settle and surface useful errors. Blocked provider delivery now includes the reason when a chat is quarantined, and its unblock action works reliably.":
    "已接受的命令不会被盲目重发；被拒绝的命令会还原草稿。投递结算需要兼容的服务器。HTTP 回退失败现在会正常落地并给出有用的错误。被阻止的服务商投递现在会在会话被隔离时附带原因，解除阻止的操作稳定可用。",
  "Browser tabs support middle-click close, address suggestions stay visible and navigation preserves composer focus. Unicode image downloads, deleted-file search results, profile dates, notification clicks and app-icon persistence are corrected. Sidebar hover flicker, native sidebar-toggle hit testing and overflowing side-panel content are fixed.":
    "浏览器标签支持中键关闭，地址建议保持可见，导航保留输入框焦点。Unicode 图片下载、已删除文件的搜索结果、资料页日期、通知点击和应用图标持久化都已修正。侧边栏悬停闪烁、原生侧边栏开关的命中判定和侧面板内容溢出问题也已修复。",
  "A feature tour introduces the new workspace, provider accounts and review workflow.":
    "功能导览介绍新工作区、服务商账号和审阅流程。",
  "Upstream release history: Synara 1.0.0 is a Stable release. Hubs and the Tasks to-do list remain exclusive to Synara Beta, with separate data and update feeds. Stable does not send Beta diagnostics.":
    "上游发布历史：Synara 1.0.0 是 Stable 版本。Hubs 和 Tasks 待办列表仍为 Synara Beta 专属，数据和更新源各自独立。Stable 不会发送 Beta 诊断数据。",
  "Choose how Git changes are written": "选择 Git 改动的书写方式",
  "Use repository conventions, Conventional Commits or your own instructions for generated commit messages and pull requests.":
    "生成的提交信息和拉取请求可遵循仓库惯例、Conventional Commits 或你的自定义说明。",
  "Set Source control writing style in Settings → Models & writing. The preference applies across projects and retains your custom instructions when switching styles.":
    "在「设置 → Models & writing」中设置源代码管理的书写风格。该偏好跨项目生效，切换风格时会保留你的自定义说明。",
  "Large Git actions survive reconnects": "大型 Git 操作在重连后继续运行",
  "Keep long pushes and other Git actions running while Moss reconnects, then resume their progress without launching them twice.":
    "Moss 重连期间，长时间推送和其他 Git 操作会继续运行，随后直接恢复进度，不会重复启动。",
  "Git transfer progress remains visible. Recovery requires the same running server; if the result is unavailable after a restart, Moss asks you to check the repository before retrying.":
    "Git 传输进度保持可见。恢复需要同一个仍在运行的服务器；如果重启后结果不可用，Moss 会要求你先检查仓库再重试。",
  "Clearer close and quit confirmation": "更清晰的关闭与退出确认",
  "Confirm closing the desktop window or quitting Moss, with running work shown before you leave.":
    "关闭桌面窗口或退出 Moss 前需要确认，并会先列出仍在运行的工作。",
  "Startup also recovers stale database lock directories that contain only Finder metadata; a live database owner is still protected.":
    "启动时还会回收只含 Finder 元数据的残留数据库锁目录；仍有活动属主的数据库依然受到保护。",
  "Update Moss from inside the app": "在应用内直接更新 Moss",
  "When a newer signed release is published, Moss downloads it in the background and shows an Update button in the sidebar; one click installs it and restarts.":
    "发布更新的签名版本后，Moss 会在后台自动下载，并在侧边栏显示“更新”按钮；点击一次即可安装并重新启动。",
  "Every packaged production build now carries the public Moss release feed, checks it shortly after launch and every four hours afterwards, prepares the download automatically, and only installs when you choose to. Builds that were packaged without a feed never showed this button, so this is the first Moss release that can announce the next one.":
    "现在每个正式打包版本都内置公开的 Moss 发布源：启动后不久会检查一次，之后每四小时再检查一次，自动准备好下载，只有在你确认时才安装。此前未内置发布源的版本从不会显示这个按钮，因此这是第一个能够提示下一版本的 Moss 版本。",
  "One Moss account, every model": "一个 Moss 账户，用遍所有模型",
  "Sign in with Moss and use GPT-5.5, GPT-5.6 Sol, Terra, and Luna, plus DeepSeek V4 Pro and Flash in Codex without an API key of your own.":
    "登录 Moss 账户，即可在 Codex 中使用 GPT-5.5、GPT-5.6 Sol、Terra、Luna，以及 DeepSeek V4 Pro 和 Flash，无需自备 API 密钥。",
  "Moss managed models share your membership quota across Codex, Claude, and OpenCode: Codex gets the GPT-5.6 family with low, medium, high, and extra-high reasoning plus fast mode, Claude gets the Moss Claude lineup, and DeepSeek and Kimi chat models run through OpenCode. Requests travel through the regional Moss gateway, so mainland users are served from the Guangzhou entry point instead of reaching overseas model endpoints directly.":
    "Moss 托管模型让 Codex、Claude 和 OpenCode 共用同一份会员额度：Codex 可使用 GPT-5.6 系列，支持低、中、高、超高推理强度和快速模式；Claude 使用 Moss Claude 系列；DeepSeek 与 Kimi 的对话模型则通过 OpenCode 运行。请求统一经由 Moss 区域网关转发，国内用户从广州入口接入，无需直接连接海外模型服务。",
  "Model, reasoning, and speed in one compact picker": "模型、推理强度和速度合并到一个紧凑选择器",
  "The Codex picker now folds model, reasoning effort, and speed into one menu that matches the current Codex desktop.":
    "Codex 选择器现在把模型、推理强度和速度收进同一个菜单，与当前 Codex 桌面版保持一致。",
  "Reasoning levels follow each model's live ladder, fast mode appears only where the model supports it, and the composer footer shows the selected model, its source, and effort at a glance. Interrupted Codex turns can be resumed, capacity errors retry with a visible countdown, and automatic approval reviews line up with Codex 0.151.":
    "推理档位跟随每个模型的实时可选范围，快速模式只在模型支持时出现，输入区底部一眼即可看到所选模型、来源和推理强度。被中断的 Codex 轮次可以继续执行，容量不足的错误会显示倒计时并自动重试，自动批准检查也与 Codex 0.151 对齐。",
  "Organize chats into your own sidebar sections": "用自定义分组整理侧边栏对话",
  "Create, rename, reorder, and archive custom sections so long-running projects stay grouped the way you think about them.":
    "创建、重命名、排序和归档自定义分组，让长期项目按你自己的思路归类。",
  "Sections and their order are stored durably and survive restarts, mixed project and chat ordering is preserved exactly, archived section chats can be restored safely, and agents can read the section layout through a sidebar tool so they file new work where it belongs.":
    "分组及其顺序会持久保存并在重启后保留，项目与对话混合排列的顺序完全不变，已归档分组中的对话可以安全恢复；智能体还能通过侧边栏工具读取分组结构，把新任务放到正确的位置。",
  "Generated images stay inside the conversation": "生成的图片留在对话中",
  "Images an agent generates now appear in an inline gallery with a preview pane, a Canvas preview, and right-click actions.":
    "智能体生成的图片现在会以内嵌图库形式显示，并提供预览面板、Canvas 预览和右键操作。",
  "Open, copy, save, or send a generated image to Canvas without leaving the chat. Codex image generation limits are shown before you reach them, and the nested context menu behind these actions is shared with other transcript items.":
    "无需离开对话即可打开、复制、保存生成的图片，或将其发送到 Canvas。Codex 的图片生成额度会在用尽之前提前显示，这些操作背后的多级右键菜单也与其他对话记录条目共用。",
  "MCP apps run in an isolated sandbox": "MCP 应用在独立沙箱中运行",
  "Interactive MCP apps open in a dedicated sandboxed surface with fullscreen docking and history navigation.":
    "可交互的 MCP 应用会在专用的沙箱界面中打开，支持全屏停靠和历史记录导航。",
  "Binary and media tool results are persisted locally and rendered in place, raw MCP output is one click away, authenticated app resources are read through the desktop, and WebMCP child activities are shown alongside the parent turn.":
    "二进制和媒体类工具结果会保存在本地并就地渲染，原始 MCP 输出一键可见，需要登录的应用资源由桌面端代为读取，WebMCP 的子活动也会与所属轮次一同显示。",
  "See what every subagent is doing": "看清每个子智能体在做什么",
  "Inline activity chips and a right-dock subagents panel keep child agents visible while the main conversation continues.":
    "内嵌活动标签和右侧子智能体面板让子智能体始终可见，同时主对话可以继续进行。",
  "Reasoning, worked-for, plan, model-rerouted, and user-stopped rows use typed transcript building blocks that match Codex desktop, selection stays continuous when you jump between a subagent and its parent, and typed stream retries and terminal system errors appear on the timeline instead of disappearing into logs.":
    "推理、耗时、计划、模型改道和用户停止等条目都使用与 Codex 桌面版一致的类型化对话记录组件，在子智能体与其父对话之间跳转时选中状态保持连续，类型化的流式重试和终端系统错误也会出现在时间线上，而不是只留在日志里。",
  "Mainland membership checkout with WeChat Pay": "国内会员支持微信支付开通",
  "Phone-number accounts in mainland China can activate a Moss membership through a native WeChat Pay checkout.":
    "中国大陆的手机号账户可以通过微信支付原生收银台开通 Moss 会员。",
  "Checkout runs on the Guangzhou origin so payment never shares the model gateway, membership activates as soon as the order settles, and managed quota refreshes automatically so the Moss model source is ready right after payment.":
    "收银流程运行在广州源站，支付链路与模型网关完全分离；订单完成后会员立即生效，托管额度自动刷新，付款后 Moss 模型来源即可直接使用。",
  "Work with Devin from the same Moss workspace": "在同一个 Moss 工作区中使用 Devin",
  "Devin CLI joins Moss as a first-class ACP provider with its own models, commands, modes, usage, attachments, and MCP configuration.":
    "Devin CLI 作为原生 ACP 服务商加入 Moss，拥有独立的模型、命令、模式、用量、附件和 MCP 配置。",
  "Moss can start and resume Devin ACP sessions, discover the models and slash commands exposed by the installed CLI, switch Plan mode, compact long conversations, attach files and images, pass compatible MCP servers, and show account usage. Authentication remains owned by Devin through `devin auth login` or its supported API-key environment variables, and provider capabilities are gated so unsupported active-turn steering is never implied.":
    "Moss 可以启动并恢复 Devin ACP 会话，发现已安装 CLI 暴露的模型和 slash commands，切换 Plan 模式，压缩过长对话，附加文件和图片，传递兼容的 MCP 服务器，并显示账户用量。身份验证仍由 Devin 通过 `devin auth login` 或其支持的 API-key 环境变量负责；服务商能力会经过严格检查，因此不会暗示不支持的活动轮次引导。",
  "Give any capable provider the live browser tools": "让任何具备能力的服务商使用实时浏览器工具",
  "WebMCP browser tools are now provider-neutral instead of being tied to one agent runtime.":
    "WebMCP 浏览器工具现在与服务商无关，不再绑定于某个智能体运行时。",
  "Browser sessions expose the same bounded, task-owned WebMCP surface to supported providers, with consistent tool discovery, invocation, timeouts, result shaping, tab ownership, and lifecycle cleanup. This keeps browser work attached to the correct task while allowing more agents to inspect and operate the page Moss is already showing.":
    "浏览器会话向受支持的服务商提供相同的有界、任务专属 WebMCP 界面，并统一工具发现、调用、超时、结果整形、标签页归属和生命周期清理。这样浏览器工作始终绑定到正确任务，同时允许更多智能体检查和操作 Moss 当前展示的页面。",
  "Find anything inside a long conversation": "在长对话中查找任何内容",
  "Press Cmd/Ctrl+F to search the current transcript from a compact floating panel.":
    "按下 Cmd/Ctrl+F，即可从紧凑的浮动面板搜索当前 transcript。",
  "The search walks real transcript messages, highlights matching text, reports the active result and total count, supports previous/next navigation and keyboard shortcuts, and follows matches without confusing tool-only rows with new assistant output. Closing the panel clears the temporary highlights without changing the conversation.":
    "搜索会遍历真实 transcript 消息，高亮匹配文本，报告当前结果和总数，支持上一个/下一个导航及键盘快捷键，并跟随匹配项，不会把仅含工具的行误认为新的助手输出。关闭面板会清除临时高亮，不改变对话。",
  "Models, sidebars, and live replies react faster": "模型、侧边栏和实时回复响应更快",
  "A focused performance pass reduces model-loading delay, sidebar work, toggle churn, and streaming update cost.":
    "一次针对性的性能优化减少了模型加载延迟、侧边栏工作量、开关抖动和流式更新开销。",
  "Available models are ready sooner, sidebar projections do less repeated work, visibility changes avoid unnecessary updates, and assistant text follows a simpler live-output path. Auto-scroll now responds to real transcript messages rather than buffering, reconnecting, approvals, or tool-only activity, which avoids feedback loops and unwanted jumps while work is merely pending.":
    "可用模型更快准备就绪，侧边栏状态映射减少重复工作，可见性变化避免不必要的更新，助手文本也采用更简单的 live-output 路径。Auto-scroll 现在响应真实 transcript 消息，而不是缓冲、重连、审批或仅含工具的活动；任务仍在等待时，这能避免反馈循环和不必要的跳动。",
  "Queued follow-ups wait, dispatch, and recover predictably":
    "排队的后续消息会按预期等待、派发并恢复",
  "Follow-ups no longer race the turn ahead of them or strand work when a task is in the background.":
    "后续消息不再抢跑到前一个轮次之前，也不会在任务转入后台时让工作停滞。",
  "Moss holds a queued follow-up until the previous turn has actually started, promotes work for backgrounded tasks, preserves preview contents while capacity is constrained, resumes from the durable cursor after an idle stop, and prevents duplicated streamed replies. Reconnect and settlement paths converge on the same turn instead of replaying visible text twice.":
    "Moss 会将排队的后续消息保留到前一个轮次真正开始，提升后台任务的优先级，在容量受限时保留预览内容，在空闲停止后从 durable cursor 恢复，并避免流式回复重复。Reconnect 和 settlement 路径会汇聚到同一个轮次，而不是把可见文本重放两遍。",
  "Database upgrades fail safely and explain recovery": "数据库升级会安全失败并说明恢复方式",
  "Schema migrations now verify runtime identity, ask before risky recovery, and keep source builds isolated from installed app data.":
    "Schema migration 现在会验证运行时身份，在有风险的恢复前征求确认，并让源码构建与已安装应用的数据彼此隔离。",
  "A source checkout uses its own development home by default instead of silently opening Stable or Canary state. Migration startup verifies that the launcher and database belong together, creates recoverable backups, records recovery state, and presents deliberate restore or retry choices when an upgrade cannot complete. Existing Stable, Canary, and explicit home-directory behavior remains intact.":
    "源码 checkout 默认使用独立的开发 home，不会悄然打开 Stable 或 Canary 状态。Migration 启动时会验证启动器与数据库是否属于同一套环境，创建可恢复的备份，记录恢复状态，并在升级无法完成时提供明确的还原或重试选项。现有的 Stable、Canary 以及显式 home-directory 行为保持不变。",
  "Provider state is controlled by the server and visible in context":
    "服务商状态由服务器控制，并在上下文中可见",
  "Settings, usage, context changes, update notices, and enabled-provider behavior now agree on what the runtime can actually do.":
    "设置、用量、上下文变化、更新提示和启用服务商的行为，现在会一致反映运行时实际能够执行的操作。",
  "Disabling a provider now prevents server lifecycle execution instead of only hiding it in the interface. Usage is available for every enabled provider Moss can verify, provider-driven context changes appear in the conversation, routine lifecycle hooks stay out of the transcript, and update notices recover when availability checks overlap or temporarily fail.":
    "禁用服务商现在会阻止服务器执行其生命周期，而不只是将其从界面隐藏。Moss 能验证的每个已启用服务商都可查看用量，服务商驱动的上下文变化会出现在对话中，常规生命周期 hook 不会进入 transcript；可用性检查重叠或暂时失败时，更新提示也能恢复。",
  "Side chats keep their place and relationship": "侧聊会保留原有位置与关系",
  "Parent-linked side chats now survive refreshes and expiry without losing the pane you were working in.":
    "与父对话关联的侧聊现在能经受刷新和过期，不会丢失你正在使用的面板。",
  "Side-chat leases and parent relationships are stored durably, docked panes restore against the correct task, and archiving or unarchiving no longer discards an active lease. Expired transient state is reclaimed without confusing a regular child task for a disposable side chat.":
    "侧聊租约和父子关系会持久保存，停靠面板会恢复到正确任务，归档或取消归档也不再丢弃活动租约。过期的临时状态会被回收，同时不会把普通子任务误认为可丢弃的侧聊。",
  "Arrange the sidebar around your workflow": "按你的工作流安排侧边栏",
  "The main navigation groups can now be reordered and keep that order across windows and restarts.":
    "现在可以重新排列主导航分组，并让顺序跨窗口和重启保持不变。",
  "Drag the configurable sidebar destinations into the order that suits you. The preference synchronizes through shared local storage, tolerates additions and older saved values, and preserves sensible defaults when stored data is incomplete or invalid.":
    "将可配置的侧边栏目标拖到适合你的顺序。该偏好会通过共享 local storage 同步，兼容新增项目和旧版保存值；保存数据不完整或无效时，也会保留合理的默认顺序。",
  "Files open, reveal, copy, and preview more reliably": "文件打开、显示、复制和预览更加可靠",
  "Edited-file cards and workspace references have clearer actions and better path handling.":
    "已编辑文件卡片和工作区引用现在有更清晰的操作，以及更完善的路径处理。",
  "macOS users can reveal a file in Finder, every platform can copy its path, and Open actions are separated from file management. Missing relative references no longer become misleading chips, valid absolute paths render as badges, dot-prefixed images and attachments are accepted, preview contents survive constrained queues, and numeric PDF destinations resolve to the intended page.":
    "macOS 用户可以在 Finder 中显示文件，所有平台都能复制路径，Open 操作也与文件管理分开。缺失的相对引用不再变成误导性的标签，有效绝对路径会显示为徽章，以点开头的图片和附件也会被接受；预览内容能在受限队列中保留，数字形式的 PDF 目标会解析到预期页面。",
  "Kilo Code data moves safely to OpenCode": "Kilo Code 数据安全迁移到 OpenCode",
  "The retired Kilo Code provider has been removed, with existing Kilo tasks and preferences migrated to OpenCode.":
    "已退役的 Kilo Code 服务商已移除，现有 Kilo 任务和偏好设置会迁移到 OpenCode。",
  "The database migration preserves provider sessions and task history while translating the provider kind. Follow-up compatibility handling also moves favorite providers and saved editor-tab state, so older installations do not retain broken Kilo selections after upgrading.":
    "数据库迁移会保留服务商会话和任务历史，同时转换 provider kind。后续兼容处理还会迁移收藏的服务商和已保存的编辑器标签页状态，确保旧安装升级后不会留下失效的 Kilo 选择。",
  "Git, terminal shortcuts, and task metadata stay attached":
    "Git、终端快捷键和任务元数据始终归属正确",
  "Pull-request attribution, creation time, terminal numbering, and final replies now resolve against the correct task.":
    "拉取请求归属、创建时间、终端编号和最终回复现在都会对应正确的任务。",
  "Pull requests are attributed to the owning thread rather than a neighboring checkout, created-at ordering remains stable, numbered terminal shortcuts select the intended tab, and the final assistant response remains self-contained after segmented or folded output. Factory Droid can also generate Git commit and pull-request text through the shared action flow.":
    "拉取请求会归属拥有它的 thread，而不是相邻的 checkout；创建时间排序保持稳定，带编号的终端快捷键会选择预期标签页，分段或折叠输出后最终助手回复仍保持完整自洽。Factory Droid 还可以通过共享操作流程生成 Git commit 和拉取请求文本。",
  "Paths, networks, payloads, and credentials fail closed": "路径、网络、负载和凭据默认安全拒绝",
  "A broad boundary audit closes prototype, path, byte-limit, loopback, retry, and temporary-credential edge cases.":
    "一次全面的边界审计补上了 prototype、路径、字节限制、loopback、重试和临时凭据等边界情况。",
  "Untrusted object keys cannot mutate prototypes, Windows drive-relative paths are rejected while drive roots remain valid, UTF-8 limits count bytes without splitting characters, IPv4-mapped addresses cannot bypass network policy, Retry-After values are validated and bounded, empty streamed chunks settle correctly at limits, and provider credential files use isolated temporary locations.":
    "不受信任的对象键无法修改 prototype；Windows 驱动器相对路径会被拒绝，而驱动器根路径仍然有效；UTF-8 限制按字节计数且不会拆分字符；IPv4-mapped 地址无法绕过网络策略；Retry-After 值会经过验证并限制范围；空的流式数据块会在达到上限时正确收敛；服务商凭据文件使用隔离的临时位置。",
  "Desktop updates and platform paths are safer": "桌面更新和平台路径更加安全",
  "Electron, backend shutdown, Windows home paths, and source-launch identity received release-focused fixes.":
    "Electron、后端关闭、Windows home 路径和源码启动身份都获得了面向发布的修复。",
  "Electron is upgraded to 43.4.1 to include the fix for CVE-2026-70608. POSIX desktop updates now shut the backend down gracefully before replacement, Windows home paths abbreviate consistently, and source validation uses the working directory only when no stronger launcher digest is available.":
    "Electron 已升级到 43.4.1，以包含 CVE-2026-70608 的修复。POSIX 桌面更新现在会在替换前优雅关闭后端，Windows home 路径会统一缩写；只有在没有更可靠的启动器摘要时，源码校验才会使用工作目录。",
  "Provider resumes, compaction, and versions keep their identity":
    "服务商恢复、压缩和版本信息保持身份一致",
  "Replay gates and exact provider metadata prevent stale lifecycle work from appearing as new activity.":
    "重放限制和精确的服务商元数据可防止过期的生命周期工作伪装成新活动。",
  "ACP load replay is suppressed until the restored session is ready, native resume is gated by the provider's real capability, Claude Auto variants match exact context limits and fail closed, compaction refreshes usage from the new boundary, long-message pagination is lossless and Unicode-safe, and prerelease provider versions retain their complete identifiers.":
    "ACP load 重放会抑制到恢复的会话准备就绪之后；原生恢复由服务商的真实能力检查约束；Claude Auto 变体会匹配精确的上下文限制并在不满足时安全拒绝；压缩会从新的边界刷新用量；长消息分页无损且兼容 Unicode；预发布服务商版本会保留完整标识符。",
  "Quit without silently abandoning running chats": "退出时不再悄然放弃仍在运行的对话",
  "Moss now shows every chat still working before the desktop app closes and can continue eligible work on the next launch.":
    "Moss 现在会在桌面应用关闭前列出所有仍在工作的对话，并可在下次启动时继续符合条件的任务。",
  "The quit dialog lists live chats and remembers whether automatic resume is enabled. When you confirm, Moss records the exact in-flight turns before interrupting them, then starts one guarded continuation per unchanged chat after restart. Completed, archived, deleted, replaced, or otherwise advanced work is skipped, and a bounded fallback still lets the app quit if the local server cannot acknowledge the resume record.":
    "退出对话框会列出活动对话，并记住是否启用自动继续。确认退出后，Moss 会先记录每个进行中轮次的精确标识，再中断任务；重启后，只为状态未变化的合格对话发起一次受保护的继续执行。已完成、已归档、已删除、已替换或已有后续进展的任务都会跳过；若本地服务器未能确认续跑记录，有界回退仍会保证应用可以退出。",
  "Keep the browser over the conversation": "让浏览器悬浮在对话上方",
  "The task browser can now float inside the chat instead of taking over the right sidebar.":
    "任务浏览器现在可以悬浮在对话内，不再必须占用右侧边栏。",
  "The floating panel shares the task's existing browser tabs and session, opens automatically when an agent requests the browser, and can be dragged, resized from every edge, closed, or returned to the sidebar. Its bounds stay inside the visible chat surface, new tabs use the current page's context more predictably, and the hidden dock remains preview-only so one live browser guest is never driven by two surfaces.":
    "悬浮面板会共享任务现有的浏览器标签页和会话，在智能体请求浏览器时自动打开，并支持拖动、从任意边缘调整大小、关闭或放回侧边栏。面板始终限制在可见对话区域内，新标签页会更稳定地继承当前页面上下文；隐藏的 Dock 只保留预览状态，避免两个界面同时控制同一个实时浏览器实例。",
  "See usage for every signed-in provider": "查看每个已登录服务商的用量",
  "Provider usage is no longer limited to Codex and Claude; Settings and in-context meters now cover every authenticated runtime Moss can verify.":
    "服务商用量不再局限于 Codex 和 Claude；设置页与上下文内的用量指示现在覆盖 Moss 能够验证的每个已认证运行时。",
  "Moss adds account or quota views for Antigravity, Cursor, Grok, OpenCode, and locally authenticated providers, while keeping Codex and Claude's detailed windows. Provider-specific adapters use local credentials or documented account endpoints, share cached snapshots, retain useful stale data through transient failures, apply bounded cooldowns after rate limiting, and explain when a provider exposes sign-in state but no machine-readable quota.":
    "Moss 为 Antigravity、Cursor、Grok、OpenCode 和本地认证的服务商增加账户或额度视图，同时保留 Codex 与 Claude 的详细窗口。各服务商适配器使用本地凭据或公开的账户接口，共享缓存快照，在短暂故障期间保留仍有价值的旧数据，并在限流后执行有界冷却；当服务商只暴露登录状态而没有机器可读的额度时，界面也会明确说明。",
  "Lower CPU, GPU, memory, and Git overhead": "降低 CPU、GPU、内存和 Git 开销",
  "A measured performance pass cuts work in the renderer, sidebar, Git statistics, runtime-event pipeline, and idle provider discovery.":
    "一次基于实测的性能优化减少了渲染器、侧边栏、Git 统计、运行时事件管线和空闲服务商发现的工作量。",
  "Streaming updates avoid repeated full-array scans and unnecessary visual effects, Git diff statistics are aggregated in one pass, runtime-event handling performs fewer repeated traversals, sidebar spinners pause when hidden, and animated translucency costs less. The server also trims idle Codex discovery sessions sooner while extending the grace period when real requests arrive, reducing process-tree memory without interrupting active model discovery.":
    "流式更新不再反复遍历完整数组，也会避开不必要的视觉效果；Git diff 统计一次完成聚合，运行时事件减少重复遍历，侧边栏加载动画在隐藏时暂停，动态半透明效果的开销也更低。服务器还会更早结束空闲的 Codex 发现会话，并在真实请求到达时延长宽限期，从而在不中断模型发现的前提下降低进程树内存占用。",
  "Windows and Linux workspaces feel more native": "让 Windows 与 Linux 工作区更贴近原生体验",
  "WSL repositories, UNC paths, taskbar icons, and desktop chrome now behave like first-class platform paths and controls.":
    "WSL 仓库、UNC 路径、任务栏图标和桌面窗口外观现在都按原生平台路径与控件处理。",
  "On Windows, a project opened through \\\\wsl.localhost or \\\\wsl$ launches provider commands inside the selected distribution with a Linux cwd, while local-folder mentions and the project browser recognize UNC and Windows home paths. Runtime icon changes now refresh the shell-visible taskbar icon. Windows and Linux users can also switch between Moss's custom title bar and the system title bar from Appearance, with an explicit restart to apply the frame change.":
    "在 Windows 上，通过 \\\\wsl.localhost 或 \\\\wsl$ 打开的项目会在所选发行版内启动服务商命令，并使用 Linux cwd；本地文件夹引用和项目浏览器也能识别 UNC 与 Windows 主目录路径。运行时图标变化现在会刷新系统外壳可见的任务栏图标。Windows 与 Linux 用户还可以在“外观”中切换 Moss 自定义标题栏和系统标题栏，并通过明确的重启操作应用窗口边框变化。",
  "Run and inspect Moss without the desktop shell": "无需桌面外壳也能运行和检查 Moss",
  "GitHub releases now include a versioned headless server tarball, and the CLI can verify whether a server is reachable and ready.":
    "GitHub 发布现在包含带版本号的无界面服务器压缩包，CLI 也能验证服务器是否可访问并已就绪。",
  "The release pipeline builds moss-server-<version>.tar.gz from the same source and web client as the desktop release. The new `moss server status` command discovers the persisted local runtime or accepts an explicit HTTP(S) URL, verifies the runtime identity, probes `/health`, reports projection readiness, supports JSON output, and exits non-zero when the server is unreachable or not ready.":
    "发布管线会使用与桌面版相同的源码和 Web 客户端构建 moss-server-<version>.tar.gz。新的 `moss server status` 命令可以发现已保存的本地运行时，也可接收明确的 HTTP(S) URL；它会验证运行时身份、检查 `/health`、报告状态映射是否就绪、支持 JSON 输出，并在服务器不可访问或尚未就绪时以非零状态退出。",
  "Send a side chat to another provider": "把侧聊发送给另一个服务商",
  "`/side` can now target a different installed provider without moving the main conversation.":
    "`/side` 现在可以指定另一个已安装的服务商，而无需移动主对话。",
  "Use `/side <provider> <prompt>` with a provider kind or display name. Moss validates the requested provider against the runtimes currently available to the task, removes the provider token from the child prompt, and keeps the existing guarded side-chat creation and source relationship. Omitting the provider continues to open the side chat on the current runtime.":
    "使用 `/side <provider> <prompt>` 并填写服务商类型或显示名称。Moss 会根据任务当前可用的运行时验证目标服务商，从子任务提示中移除服务商标记，并保留现有的受保护侧聊创建流程与来源关系。省略服务商时，侧聊仍会在当前运行时中打开。",
  "Provider turns keep their real text, tools, and children":
    "服务商轮次会保留真实文本、工具和子任务",
  "Antigravity, OpenCode, Cursor, and Grok received focused lifecycle and option fixes.":
    "Antigravity、OpenCode、Cursor 和 Grok 获得了针对生命周期与选项的修复。",
  "Antigravity now streams tool cards, settles completed turns, routes subagents into child threads, and keeps background task turns alive instead of killing the CLI. OpenCode preserves raw streamed assistant text. Cursor no longer leaves fast mode or Grok HIGH reasoning stuck after their controls are disabled, preserves fallback model options, and Grok's effort picker follows the live CLI model ladders.":
    "Antigravity 现在会流式显示工具卡片、正确结束已完成轮次、把子智能体活动送入子对话，并让后台任务轮次保持运行而不是提前终止 CLI。OpenCode 会保留原始的流式助手文本。Cursor 在相关控件关闭后不再残留快速模式或 Grok HIGH 推理状态，也会保留回退模型选项；Grok 的推理强度选择会跟随实时 CLI 模型档位。",
  "Diagnostics reveal less and reject ambiguous input": "诊断信息暴露更少，并拒绝歧义输入",
  "Process, provider, environment, URL, and fixture diagnostics now apply a broader fail-closed credential policy.":
    "进程、服务商、环境、URL 和测试数据的诊断现在采用覆盖更广、默认拒绝的凭据策略。",
  "Moss redacts quoted, wrapped, truncated, serialized, reordered, compact, URL-embedded, and shell-composed secret forms; bounds sanitizer traversal; preserves safe numeric diagnostic tokens; and keeps OpenAI credentials out of restricted provider children. Duplicate Origin headers, off-origin WebSocket token injection, high-water cursor violations, unterminated credentials, and ambiguous command substitutions are rejected instead of being interpreted optimistically.":
    "Moss 会遮盖被引号包裹、再次封装、截断、序列化、重排、压缩、嵌入 URL 或由 shell 拼接的敏感值；限制清理器的遍历范围；保留安全的数字诊断标记；并阻止受限服务商子任务继承 OpenAI 凭据。重复的 Origin 请求头、跨来源 WebSocket 凭据注入、超过高水位的游标、未终止的凭据以及有歧义的命令替换都会被拒绝，不再作乐观解释。",
  "Find files and start work with fewer corrective clicks": "减少来回修正，更快找到文件并开始工作",
  "Workspace search ranks and presents results more clearly, while project scripts are available again from the empty landing view.":
    "工作区搜索会更清晰地排序和呈现结果，项目脚本也重新出现在空白启动页中。",
  "File search now emphasizes fuzzy matches, keeps the most useful parent path visible, limits mounted rows, debounces server work, and opens directories directly in Explorer. The landing composer and project controls share a flatter, more consistent visual treatment, muted labels and disclosure contrast are normalized, and project script shortcuts remain accessible before a chat exists.":
    "文件搜索现在会突出模糊匹配，保留最有用的父路径，限制实际挂载的结果行，对服务器请求执行防抖，并可在 Explorer 中直接打开目录。启动页输入区和项目控件采用更扁平一致的视觉样式，弱化标签与展开区域的对比度得到统一，而且在尚未创建对话时仍可使用项目脚本快捷入口。",
  "Repeated actions and restored state converge safely": "重复操作与恢复状态会安全收敛",
  "Approvals, managed worktrees, feature flags, and route restoration now have stronger replay and ownership fences.":
    "审批、托管 worktree、功能开关和页面恢复现在具备更强的重放与归属边界。",
  "Duplicate approval responses are rejected durably at the serialized decider. Permanent deletion reclaims only Moss-owned managed worktrees and preserves unowned paths. Malformed cached feature flags reset instead of leaving stale values, route restoration ignores snapshots from superseded refreshes, and large projection repair stops thrashing when the state is already being repaired.":
    "重复的审批响应会在串行决策器中被持久拒绝。永久删除只回收 Moss 所有的托管 worktree，并保留不归 Moss 所有的路径。格式错误的功能开关缓存会重置，而不是留下过期值；页面恢复会忽略已被新刷新取代的快照；当状态已经处于修复中时，大型状态修复也不会反复抖动。",
  "Text, paths, attachments, and origins survive edge cases":
    "文本、路径、附件和来源在边界情况下保持完整",
  "Several low-level boundaries now preserve exact data instead of corrupting, truncating, or misclassifying it.":
    "多个底层边界现在会保留精确数据，不再造成损坏、截断或错误分类。",
  "Process output and bounded runtime text preserve UTF-8 characters split across chunks, multi-dot attachments keep their final extension, Windows workspace comparisons ignore case, Codex prerelease versions retain every hyphenated segment, malformed Claude auth JSON fails closed, missing provider commands are classified consistently, and duplicate HTTP Origin headers are refused.":
    "进程输出和有界运行时文本会保留跨数据块拆分的 UTF-8 字符；包含多个点的附件名会保留最终扩展名；Windows 工作区比较会忽略大小写；Codex 预发布版本会保留每个连字符片段；格式错误的 Claude 认证 JSON 会默认拒绝；缺失的服务商命令会得到一致分类；重复的 HTTP Origin 请求头则会被拒绝。",
  "Desktop replies and simulator support recover more cleanly": "桌面回复与模拟器支持恢复得更稳",
  "Background completions appear without reloads, terminal fences settle at the right reply, and Xcode 27 beta remains usable.":
    "后台完成的回复无需重新加载即可出现，terminal fence 会在正确的回复处收敛，Xcode 27 beta 也仍可使用。",
  "The web client keeps a completed assistant reply attached to its terminal fence until the final post-settle text arrives, including work that finishes in the background. Xcode 27 beta's relocated SimulatorKit framework is discovered by the iOS device helper, and browser navigation guidance now accurately distinguishes supported localhost and file behavior from genuinely blocked destinations.":
    "Web 客户端会让已完成的助手回复继续关联其 terminal fence，直到收敛后的最终文本到达，这也覆盖在后台完成的工作。iOS 设备辅助程序能够发现 Xcode 27 beta 中已迁移位置的 SimulatorKit 框架；浏览器导航说明也会准确区分受支持的 localhost 与文件行为，以及真正被阻止的目标。",
  "A calmer shell with clearer model choices": "更安静的界面，更清晰的模型选择",
  "Sidebar surfaces, the landing composer, quit confirmation, and provider pickers received a cohesive visual and interaction pass.":
    "侧边栏界面、启动页输入区、退出确认和服务商选择器完成了一轮统一的视觉与交互优化。",
  "Translucent surfaces have fewer seams and better light/dark contrast, the quit dialog now matches the command palette, and empty-landing controls sit flush with the composer. Claude models sort by their live catalogue order, picker menus have more room for full names, and provider metadata is enforced exhaustively so new runtimes cannot silently miss required UI descriptions.":
    "半透明界面的接缝更少，明暗主题对比更自然；退出对话框现在与命令面板一致，空白启动页控件也与输入区齐平。Claude 模型会按实时目录顺序排列，选择菜单为完整名称留出更多空间；服务商元数据还会进行穷尽校验，避免新运行时悄然缺少必要的界面说明。",
  "Build and test iOS apps beside the conversation": "在对话旁构建并测试 iOS 应用",
  "The new iOS Simulator pane gives you and supported agents one live, interactive device surface inside Moss.":
    "全新的 iOS 模拟器面板在 Moss 内提供一个实时可交互的设备界面，让你和受支持的智能体共同使用。",
  "On macOS, Moss can boot and attach simulators, stream their display, install and launch apps, tap, swipe, type, press hardware controls, save screenshots, record the view, and inspect accessibility elements. The source-shipped helper compiles with your selected Xcode, runs in a constrained sandbox, drops slow frames instead of blocking RPC traffic, and reclaims Moss-owned devices after crashes.":
    "在 macOS 上，Moss 可以启动并连接模拟器，传输其画面，安装并启动应用，执行点击、滑动、输入和硬件控制，保存截图、录制画面并检查无障碍元素。随源码提供的辅助程序会使用你选择的 Xcode 编译，在受限沙箱中运行；它会丢弃过慢的帧而不是阻塞 RPC 流量，并在崩溃后回收 Moss 所有的设备。",
  "Give a thread a goal and let it keep going": "让对话设定目标并持续推进",
  "Persistent goals stay visible, timed, and active across turns, with pause, resume, achievement, and recovery controls.":
    "持久目标会在多轮之间保持可见、计时和活动状态，并提供暂停、继续、达成与恢复控件。",
  "Use /goal or the stacked composer panel to set an objective. Moss carries it through provider turns, restarts, retries, and subagent steering, records completed goals, and can automatically start the next continuation after clean completion. Queued user work, approvals, Plan mode, interrupts, failures, timeouts, and repeated blockers all have explicit priority and pause rules so autonomy does not become an uncontrolled loop.":
    "使用 /goal 或堆叠式输入框面板设置目标。Moss 会让目标贯穿服务商轮次、重启、重试和子智能体引导，记录已完成目标，并可在正常完成后自动启动下一次继续执行。用户排队工作、审批、Plan 模式、中断、失败、超时和重复阻塞都有明确的优先级与暂停规则，确保自主运行不会变成失控循环。",
  "See and manage the whole pull-request stack": "查看并管理完整的拉取请求堆栈",
  "Pull-request rows and details now understand stack position, order, readiness, navigation, and merge outcomes.":
    "拉取请求行和详情现在能够理解堆栈位置、顺序、就绪状态、导航和合并结果。",
  "Stack badges show where each PR sits, the detail view opens an ordered navigator, and merge copy accounts for drafts, conflicts, and incomplete stack data. Moss uses GitHub's asynchronous merge path when available, falls back safely where needed, and refreshes repository-wide PR state after a stack mutation.":
    "堆栈标记显示每个 PR 所处的位置；详情视图打开有序导航器；合并文案会考虑草稿、冲突和不完整的堆栈数据。Moss 在可用时采用 GitHub 的异步合并路径，必要时安全回退，并在堆栈变更后刷新整个仓库的 PR 状态。",
  "Debug with an evidence-first workflow": "用证据优先的工作流调试",
  "A new Debug mode guides the selected agent through observe, reproduce, investigate, fix, and verify.":
    "新的 Debug 模式会引导所选智能体依次观察、复现、调查、修复和验证。",
  "Debug is available from the mode menu and /debug, persists across drafts, turns, forks, handoffs, queues, and restarts, and keeps the current runtime permissions. It budgets its instructions across providers, asks structured reproduction questions where supported, and explicitly prevents unverified success claims or invisible assumptions about external state.":
    "Debug 可从模式菜单和 /debug 使用，并会跨草稿、轮次、派生、交接、排队和重启保持状态，同时保留当前运行时权限。它会在各服务商之间分配指令预算，在支持时提出结构化复现问题，并明确阻止未经验证的成功声明或对外部状态的无形假设。",
  "Search files and code across the workspace": "跨工作区搜索文件和代码",
  "Open files by name with Cmd/Ctrl+P or search matching source lines with Cmd/Ctrl+Shift+F.":
    "使用 Cmd/Ctrl+P 按名称打开文件，或使用 Cmd/Ctrl+Shift+F 搜索匹配的源代码行。",
  "The new command palette ranks file-name matches and provides bounded, grep-style content results with path, line number, and matching text. Search respects the workspace index and ignored files, skips binary content, stays scoped to the active project, and opens the selected result in the right-dock file pane.":
    "全新的命令面板会为文件名匹配排序，并提供有界、类似 grep 的内容结果，包含路径、行号和匹配文本。搜索遵循工作区索引和忽略文件规则，跳过二进制内容，只在当前项目范围内执行，并将选定结果打开在右侧 Dock 文件面板中。",
  "Fork from the exact message across more providers": "在更多服务商中从精确消息派生",
  "Message-level forks now preserve their source visually and use native provider forks wherever the runtime supports them.":
    "消息级派生现在会在视觉上保留来源，并在运行时支持时使用服务商原生派生。",
  "Claude, Cursor, Droid, Grok, and OpenCode join Codex with centralized capability checks, timeouts, cleanup, cursor handling, and in-flight-turn protection. A source divider links back to the original conversation, turn counts and resumability metadata survive, and retained transcript reconstruction remains the safe fallback when native forking is unavailable.":
    "Claude、Cursor、Droid、Grok 和 OpenCode 现在与 Codex 一样，统一使用能力检查、超时、清理、游标处理和进行中轮次保护。来源分隔线会链接回原始对话，轮次计数和可恢复元数据会保留；当原生派生不可用时，保留的对话记录重建仍是安全回退方案。",
  "Automations explain failures and stop on your terms": "自动化会解释失败，并按你的方式停止",
  "Choose how many consecutive failures an automation should tolerate, or let it keep retrying indefinitely.":
    "选择自动化应容忍的连续失败次数，或让它无限重试。",
  "Failure counts, disable reasons, and timestamps are now durable; a successful run resets the count, hitting the threshold requires an explicit re-enable, and manual reruns keep the evidence intact. Inline creation and editing fields, clearer risk confirmation, optimistic concurrency, and visible disabled-state explanations make the policy easier to understand and safer to change.":
    "失败计数、禁用原因和时间戳现在会持久保存；成功运行会重置计数，达到阈值后必须明确重新启用，手动重跑会保留证据。内联创建与编辑字段、更清晰的风险确认、乐观并发以及可见的禁用状态说明，让策略更易理解，也更安全地调整。",
  "Large histories start faster and live output does less work":
    "大型历史记录启动更快，实时输出占用更少资源",
  "Projector replay and the visible streaming pipeline received a measured performance pass.":
    "状态重放和可见的流式处理管线都完成了有实测依据的性能优化。",
  "SQLite replay now keeps its primary-key range scan and uses bounded cache and memory-map settings; on the documented 2.9 GB fixture, a lagging replay fell from several minutes to about 24 seconds. Streaming text commits are batched, bottom-follow keys stay stable, layout reads and scroll work are coalesced, store selectors are narrower, and a production-path benchmark now covers the complete event-to-transcript pipeline.":
    "SQLite 重放现在保留主键范围读取，并使用有界的缓存和内存映射设置；在文档记录的 2.9 GB fixture 上，落后的重放从数分钟降至约 24 秒。流式文本提交会批量处理，底部跟随键保持稳定，布局读取与滚动操作会合并，store selector 更精简，生产路径基准测试现在覆盖完整的事件到对话记录流程。",
  "Provider activity stays visible even when it is unfamiliar":
    "即使不熟悉，服务商活动也会持续可见",
  "Oversized and previously unmapped runtime events no longer disappear or quarantine an otherwise healthy session.":
    "过大的和此前未映射的运行时事件不再消失，也不会隔离原本健康的会话。",
  "Large event payloads are bounded and truncated while retaining their diagnostic meaning, unknown events surface through a safe fallback row, stale-generation terminal events settle the owning turn, and OpenCode tool titles and lifecycle detail parsing are normalized before persistence.":
    "大事件负载会在保留诊断含义的同时进行有界截断；未知事件会通过安全的回退行显示；过期代次的终止事件会收敛所属轮次；OpenCode 工具标题和生命周期详情解析会在持久化前规范化。",
  "Transcript progress reads in the order it happened": "对话进度按实际发生顺序呈现",
  "Assistant text, tools, reasoning, task progress, change summaries, and footer actions now form a clearer sequence.":
    "助手文本、工具、推理、任务进度、变更摘要和底部操作现在组成更清晰的顺序。",
  "Text segments interleave with tool rows using provider event order, compacted reasoning stays anchored to its first update, repeated task-list updates collapse into one progressing row, the turn changes card appears before footer actions, and streamed text no longer repeatedly re-arms bottom-stick or redundant highlight scrolling.":
    "文本片段会按服务商事件顺序与工具行交错显示；压缩后的推理会锚定在首次更新处；重复的任务列表更新会合并为一个进度行；轮次变更卡片会出现在底部操作之前；流式文本不再反复重新启用底部跟随或多余的高亮滚动。",
  "Drafts, branches, diffs, and Git actions keep their context":
    "草稿、分支、diff 和 Git 操作会保留上下文",
  "Switching tasks or repositories is less likely to lose a draft, branch, diff selection, or action explanation.":
    "切换任务或仓库时，不易再丢失草稿、分支、diff 选择或操作说明。",
  "New-chat drafts survive thread switches, local branches remain attached during resume, branch mismatches settle before send, Pull appears when upstream is ahead, Git diff previews follow the selected file, worktree cancellation stays durable, and the shared commit/push/PR dialog keeps disabled reasons while presenting more direct primary actions.":
    "新聊天草稿会跨对话切换保留；本地分支在恢复期间仍保持关联；分支不匹配会在发送前收敛；上游领先时会显示 Pull；Git diff 预览会跟随所选文件；worktree 取消状态会持久保存；共享的 commit/push/PR 对话框会保留禁用原因，同时提供更直接的主要操作。",
  "Model and usage discovery fails smaller": "模型与用量发现即使出错也影响更小",
  "One malformed model or very large local Codex archive no longer destabilizes an entire catalogue or usage refresh.":
    "单个格式错误的模型或超大的本地 Codex archive 不再让整个目录或用量刷新失稳。",
  "Moss isolates invalid descriptors, warms every available provider catalogue for new threads, shows installed providers, exposes Pi's maximum thinking level, and turns unknown rate-limit windows into readable labels. Codex usage scans now read archives backward in bounded 64 KiB chunks and skip oversized records without loading entire session files into memory.":
    "Moss 会隔离无效描述，给新对话预热所有可用服务商的目录，显示已安装服务商，暴露 Pi 的最高思考级别，并将未知的 rate-limit 窗口转成易读标签。Codex 用量读取现在会以有界的 64 KiB 分块从后向前读取 archive，并跳过过大的记录，不把整个会话文件载入内存。",
  "Tune the reading width and act on file links": "调整阅读宽度，并直接处理文件链接",
  "Choose a focused, standard, or wide chat column and use context actions directly from file references.":
    "选择聚焦、标准或宽屏对话列，并直接从文件引用使用上下文操作。",
  "Chat width is persisted as a visual preference, while Markdown file links can copy their path, open in Moss, or reveal supported workspace references. File and snippet search use the same direct-to-file workflow for a more consistent navigation path.":
    "对话宽度会作为视觉偏好持久保存；Markdown 文件链接可以复制路径、在 Moss 中打开或显示受支持的工作区引用。文件和片段搜索使用同一套直达文件工作流，让导航更加一致。",
  "Desktop behavior is more native across macOS and Windows": "macOS 与 Windows 上的桌面行为更原生",
  "Dock and taskbar icons, terminal startup, updater shutdown, timestamps, and action glyphs received a platform-focused pass.":
    "Dock 和任务栏图标、终端启动、更新器退出、时间戳和操作图标都完成了面向平台的优化。",
  "macOS can follow appearance with a dark dock icon, Windows refreshes its taskbar icon after runtime changes and starts Bun PTYs reliably, updater failures no longer erase quit intent, and message metadata now adds day or date context when a time alone would be ambiguous. Sidebar and turn-action icons were simplified and aligned.":
    "macOS 可根据外观模式使用深色 Dock 图标；Windows 会在运行时变化后刷新任务栏图标，并可靠启动 Bun PTY；更新失败不再清除退出意图；消息元数据会在单独显示时间不够明确时补充日期或星期信息。侧边栏和轮次操作图标也已简化并对齐。",
  "Interrupted and replayed work converges more reliably": "中断和重放的工作更可靠地收敛",
  "Queue promotion, snapshot replay, terminal settlement, and goal recovery now preserve durable ordering through restarts and races.":
    "队列提升、快照重放、终止收尾和目标恢复现在会在重启与竞态中保持持久顺序。",
  "Queued turns can be promoted replay-safely, stalled projection cursors escape permanent resnapshot loops, superseded projections retain retry backoff, terminal sessions can retry eligible goals, and pause or blocked transitions fence automatic continuation before user interrupts or newer work can be overtaken.":
    "排队轮次可以安全地提升并支持重放；停滞的重放游标会摆脱永久重新获取快照循环；被取代的状态会保留重试退避；终止中的会话可以重试符合条件的目标；暂停或阻塞转换会在用户中断或更新工作抢先之前，阻止自动继续执行。",
  "Release publication has stricter, clearer gates": "发布流程拥有更严格、更清晰的门禁",
  "The release workflow now uses least-privilege permissions, clean-lane checks, deterministic Windows setup, and scoped unsigned exceptions.":
    "发布工作流现在采用最小权限、干净通道检查、确定性的 Windows 设置和有范围的未签名例外。",
  "Publication policy is explicit about when a release can proceed, Windows dependency installation is stabilized, and an unsigned Windows build must still pass packaging, provenance, startup smoke, and artifact-upload checks under an exact version-scoped exception.":
    "发布政策明确何时可以继续；Windows 依赖安装更加稳定；未签名的 Windows 构建仍必须在精确版本范围的例外下通过打包、来源证明、启动 smoke 和 artifact 上传检查。",
  "Large histories start and reconnect without a fixed deadline":
    "大型历史记录加载与重连不再受固定时限限制",
  "Moss now keeps waiting for a healthy backend and recovers late connections instead of giving up while a large history is still loading.":
    "即使大型历史记录仍在加载，Moss 现在也会持续等待后端恢复正常，并在连接较晚建立时继续恢复，不会提前放弃。",
  "Desktop readiness is cancellable but no longer capped by a fixed timeout, WebSocket reconnects use bounded backoff, and orchestration replay filters irrelevant events before decoding them. Startup, resume, and late-event handling now converge without turning a slow database into a false failure.":
    "桌面端就绪等待可取消，但不再受固定超时限制；WebSocket 重连采用有上限的退避策略；编排重放会在解码前过滤无关事件。启动、续接与延迟事件处理现在能够最终收敛，不会再把数据库响应缓慢误判为故障。",
  "Branches and pull requests stay in sync while agents work":
    "智能体工作期间，分支与拉取请求保持同步",
  "Task metadata now follows branch, worktree, push, and pull-request changes as they happen.":
    "任务元数据现在会实时跟随分支、worktree、推送及拉取请求的变化。",
  "A dedicated Git metadata reactor propagates mid-turn repository changes, recognizes task branches and pull requests more reliably, and repairs stale merged-PR badges. Refresh work is serialized and coalesced so commit, push, and PR actions are not blocked by competing background reads.":
    "专用的 Git 元数据响应器会传播轮次进行中的仓库变更，更可靠地识别任务分支和拉取请求，并修复过期的已合并 PR 标记。刷新操作会串行执行并合并重复请求，避免后台读取相互争用而阻塞提交、推送和 PR 操作。",
  "Create PR can finish the whole publishing flow": "“创建 PR”可以完成整个发布流程",
  "The PR dialog can commit the intended changes, push the branch, and open the pull request as one guided action.":
    "“创建 PR”对话框现在可通过一次引导操作提交预期变更、推送分支并打开拉取请求。",
  "The flow has clearer draft and ready-for-review actions, safer branch and upstream handling, progress-aware controls, and refresh behavior that detaches after the terminal Git action succeeds instead of leaving the UI stuck while metadata catches up.":
    "该流程提供更清晰的草稿与“准备审阅”操作、更安全的分支及上游处理、可反映进度的控件；最后一项 Git 操作成功后，刷新会转为后台跟进，不再因等待元数据更新而让界面卡住。",
  "Edit and save files directly from Explorer": "直接在 Explorer 中编辑并保存文件",
  "Workspace previews are now useful for small code and text edits without leaving Moss.":
    "无需离开 Moss，即可通过工作区预览完成小范围的代码和文本编辑。",
  "Explorer file previews support editing, dirty-state tracking, guarded saves, clearer breadcrumbs, and safer path validation. Image overlays and preview layering were also corrected so file inspection remains usable beside the native browser and docked tools.":
    "Explorer 文件预览现在支持编辑、未保存状态跟踪、受保护的保存操作、更清晰的面包屑导航与更安全的路径校验。图片浮层和预览层级也已修正，确保在原生浏览器与 Dock 工具旁检查文件时依然顺手。",
  "Usage limits load faster and survive transient failures": "用量限制加载更快，短暂故障后仍会保留",
  "Provider usage is fetched once on the server and shared consistently across the sidebar and Settings.":
    "服务商用量现在由服务器统一获取一次，并在侧边栏与“设置”中一致共享。",
  "Claude and Codex credential refresh, keychain fallback, request joining, identity-scoped caching, throttling, and stale-but-healthy snapshot retention were hardened. A temporary provider or network failure no longer wipes a previously verified usage view.":
    "Claude 与 Codex 的凭证刷新、钥匙串回退、请求合并、按身份划分的缓存、限流，以及保留虽已过期但状态正常的快照等路径均已强化。服务商或网络暂时故障时，不再清空此前已验证的用量视图。",
  "Provider sessions recover from more real-world failures": "服务商会话可从更多真实故障中恢复",
  "Codex, Claude, OpenCode, Grok, Kilo, Antigravity, and ACP sessions now settle and resume more predictably.":
    "Codex、Claude、OpenCode、Grok、Kilo、Antigravity 与 ACP 会话现在能够更可靠地收尾和续接。",
  "This release adds focused recovery for transient Grok storage and Kilo credential failures, OpenCode host-policy reinjection and Windows launching, Antigravity cancellation, AskUserQuestion replies, handoff eligibility, inline API keys, model discovery, and late terminal events.":
    "本次发布针对 Grok 存储与 Kilo 凭证的短暂故障、OpenCode 主机策略重新注入及 Windows 启动、Antigravity 取消、AskUserQuestion 回复、交接条件判定、内联 API 密钥、模型发现和延迟到达的终态事件，新增了专门的恢复处理。",
  "Long and streaming conversations do less unnecessary work": "长对话与流式输出减少不必要的开销",
  "Live output remains visible while background polling, subscriptions, and timeline layout are more selective.":
    "实时输出持续可见，后台轮询、订阅和时间线布局则只在需要时更新。",
  "Runtime polling adapts to activity, thread subscriptions are retained only where needed, replay avoids duplicate persistence, and timeline rows guard against painted overlap. Loading and Working labels now follow the real send and stream lifecycle instead of sticking after acknowledgements are lost or a live turn is taken over.":
    "运行时轮询会根据活动状态调整频率；只在确有需要的位置保留对话订阅；重放会避免重复持久化；时间线行也会防止绘制内容重叠。“正在加载”和“工作中”标签现在会跟随真实的发送与流式生命周期，不会再因确认消息丢失或实时轮次被接管而滞留。",
  "Worktree setup is visible, cancellable, and easier to recover":
    "worktree 设置过程可见、可取消，也更易恢复",
  "See setup progress, cancel before dispatch, or open a local checkout when that is the better path.":
    "可查看设置进度、在分发前取消，或在本地检出更合适时直接打开它。",
  "Automatic branch creation and attachment were restored, setup races were closed, worktree activity is easier to identify, and imported Codex history can now create a real fork while preserving the source relationship. The configured Git model is also used when naming new worktree branches.":
    "自动创建与附加分支的能力已经恢复，设置竞态得到消除，worktree 活动更易识别；导入的 Codex 历史记录现在也能创建真实的派生任务，并保留与来源任务的关系。为新 worktree 分支命名时，还会使用已配置的 Git 模型。",
  "Choose the desktop icon and preview themes visually": "选择桌面图标，并直观预览主题",
  "Settings now includes native-style app icon choices and a compact theme mockup picker.":
    "“设置”现在提供原生风格的应用图标选项和紧凑的主题效果选择器。",
  "Desktop icon selection persists through renderer startup and updates the packaged macOS presentation. Theme, shortcut, sidebar, composer glass, and translucent surface layouts were tightened, including production-safe backdrop filtering and better fallbacks where native transparency is unavailable.":
    "桌面图标选择会在渲染进程启动后继续保留，并更新打包后 macOS 应用的外观。主题、快捷键、侧边栏、输入框玻璃效果和半透明界面布局均已收紧，包括适用于生产环境的背景滤镜，以及原生透明效果不可用时更好的回退方案。",
  "Project and keyboard workflows need fewer corrective clicks": "项目与键盘操作不再需要反复修正",
  "Project search focuses immediately, and terminal and side-chat shortcuts behave more predictably.":
    "项目搜索会立即获得焦点，终端与辅助对话快捷键的行为也更可预期。",
  "The shared project picker keeps its existing shell while focusing its search field on open. Conditional shortcut edits, keybinding capture, side-chat terminal exits, and shortcut settings were hardened so platform-specific combinations do not silently replace unrelated bindings.":
    "共享项目选择器在保留现有界面的同时，会在打开时自动聚焦搜索框。条件式快捷键编辑、按键绑定捕获、辅助对话终端退出及快捷键设置均已强化，避免平台特定组合在无提示的情况下替换无关绑定。",
  "Errors, confirmations, and release notes are easier to find":
    "错误、确认信息和发布说明更容易找到",
  "Task errors now appear as toasts, routine notices remain visible longer, and past releases are available from Help.":
    "任务错误现在会以浮层通知显示，常规通知会保留更久，历史版本可从“帮助”中查看。",
  "Shared toast providers now default to a 10-second dismissal while preserving explicitly persistent notices. Error banners moved into the common toast path, copying the active task ID has a dedicated shortcut, and the sidebar Help menu now opens the complete in-app release history.":
    "共享浮层通知现在默认 10 秒后消失，同时仍会保留显式设为常驻的通知。错误横幅已统一接入公共浮层通知路径，复制当前任务 ID 也有了专用快捷键；侧边栏“帮助”菜单现在可以打开完整的应用内发布历史。",
  "Windows, Markdown, images, and pull-request views are sturdier":
    "Windows、Markdown、图片和拉取请求视图更加稳固",
  "Several small but disruptive platform and rendering failures have been removed.":
    "若干虽小却影响使用的平台与渲染故障已经消除。",
  "Windows OpenCode shim spawning and terminal activity detection were corrected, malformed GitHub-flavored Markdown tables are repaired before rendering, image overlays stack above the browser correctly, PR comments parse more consistently, and diff statistics can use an optional red/green presentation.":
    "已修正 Windows 上 OpenCode shim 的启动与终端活动检测；格式异常的 GitHub-flavored Markdown 表格会在渲染前修复；图片浮层会正确显示在浏览器上方；PR 评论解析更加一致；diff 统计也可选择红/绿配色。",
  "A review of the Moss codebase found an analytics configuration inherited from the original T3 Code codebase when Moss was created as a clone in March.":
    "对 Moss 代码库的检查发现，Moss 于三月作为克隆版本创建时，沿用了原始 T3 Code 代码库中的一项分析配置。",
  "We did not add it, and we had no access to the PostHog project receiving the events.":
    "这不是我们添加的，而且我们无法访问接收这些事件的 PostHog 项目。",
  "The configuration has been removed. Moss no longer sends remote product analytics. The events did not include prompts, source code, filenames, or file contents. We're sorry this wasn't caught earlier":
    "该配置已移除。Moss 不再发送远程产品分析数据。这些事件不包含提示词、源代码、文件名或文件内容。很抱歉我们之前没有发现这一点。",
  "Start directly from a GitHub repository": "直接从 GitHub 仓库开始",
  "Create a project from a GitHub URL or repository name and let Moss prepare the local checkout for you.":
    "使用 GitHub URL 或仓库名称创建项目，Moss 会为你准备本地检出。",
  "The new GitHub source in the project dialog validates repository and folder names, uses your GitHub CLI access, reports clone progress, reuses compatible checkouts, and recovers safely from cancellation or a failed registration without leaving an ambiguous project behind.":
    "项目对话框新增 GitHub 来源，会校验仓库与文件夹名称，使用你的 GitHub CLI 访问权限，显示克隆进度，复用兼容的现有检出，并能在取消或注册失败后安全恢复，不会留下状态不明的项目。",
  "Side chats stay focused and dependable": "辅助对话保持聚焦且可靠",
  "Opening a side chat is more reliable, and moving between its tab, dock, and source task keeps the right conversation in view.":
    "打开辅助对话更加可靠；在其标签页、Dock 与来源任务之间切换时，界面始终显示正确的对话。",
  "Side-chat creation now has one shared path with prompt deduplication, safer snapshot retention, and clearer recovery when activation races the new task. Dock navigation and tab presentation were simplified, while temporary user messages keep a distinct dashed treatment until the task becomes permanent.":
    "辅助对话创建现在统一走同一条路径，可去除重复提示词、更安全地保留快照，并在新任务激活发生竞态时提供更清晰的恢复。Dock 导航与标签页呈现得到简化；临时用户消息会持续采用虚线样式，直到任务正式保存。",
  "Interrupted work settles more cleanly": "中断的工作可更干净地收尾",
  "Tasks are less likely to remain stuck or replay the wrong command after a provider restart, delayed event, or partial failure.":
    "服务商重启、事件延迟或部分失败后，任务更少出现卡住或重放错误命令的情况。",
  "Unreplayable runtime commands are quarantined instead of being dispatched again, terminal provider events reconcile against durable turn state, pending interactions settle against the owning request, and stale lifecycle updates are fenced before they can overwrite newer task state.":
    "无法安全重放的运行时命令会被隔离而非再次分发；终端服务商事件会根据持久轮次状态进行校准；待处理交互只与所属请求结算；过期的生命周期更新会在覆盖较新任务状态前被拦截。",
  "Terminal context goes to the right chat": "终端上下文会送到正确的对话",
  "Add to chat now targets the composer beside the terminal you used, and a normal shell exit closes only that finished tab.":
    "“添加到对话”现在会定位到所用终端旁的输入框；Shell 正常退出时，只关闭已经结束的标签页。",
  "Terminal selection actions use a scoped composer registry across the drawer and right dock. Naturally exited sessions clear their activity without a destructive-close prompt, placeholder cleanup, or a duplicate fallback exit command, while live tabs remain untouched.":
    "终端选区操作通过局部输入框注册表在抽屉与右侧 Dock 之间准确路由。自然退出的会话会清除活动状态，不再弹出破坏性关闭确认、清理占位项或重复发送兜底退出命令，同时不会影响仍在运行的标签页。",
  "Open work stays visible with less background churn": "已打开的工作保持可见，后台负担更低",
  "File previews and task details now survive more project-path changes while inactive conversations consume less subscription work.":
    "即使项目路径发生更多变化，文件预览与任务详情仍能保留；非活动对话则减少不必要的订阅工作。",
  "Image, PDF, and workspace previews can relocate safe out-of-root references back into the active project, visible transcript state is retained through overlapping refreshes, and thread-detail subscriptions are narrowed to the conversations that actually need live detail.":
    "图片、PDF 与工作区预览可将安全但位于项目外的引用重新定位到活动项目；重叠刷新期间会保留可见的对话记录状态；对话详情订阅则收窄到确实需要实时详情的对话。",
  "Notifications respect where your attention is": "通知会顾及你的注意力所在",
  "Completion alerts stay quiet while Moss is in front of you, and provider update notices refresh more reliably when you return.":
    "当 Moss 位于前台时，完成提醒会保持安静；你返回后，服务商更新提示也能更可靠地刷新。",
  "Foreground detection now includes the native browser pane, toast visibility follows side-chat dock and split routes, and provider update checks retry on focus with fresher scheduling so stale availability does not linger in the sidebar.":
    "前台检测现已覆盖原生浏览器面板；通知浮层会跟随辅助对话 Dock 与分屏页面的可见状态；服务商更新检查会在聚焦时按更及时的调度重试，避免过期的可用性状态滞留在侧边栏。",
  "Point at exactly what should change": "精准指明需要修改的位置",
  "The visible-browser annotation tool can now inspect page elements and keeps your markers stable while you navigate and refine a request.":
    "可见浏览器的标注工具现在可以检查页面元素；在你浏览页面并完善请求时，标记也会保持稳定。",
  "Element inspection captures clearer geometry and presentation context, markers survive hash navigation and compatible document-key changes, and collapsed or invalid targets are handled safely. The overlay, inspector radii, annotation action, and review labels were polished so selecting and sending precise page feedback feels more dependable.":
    "元素检查会记录更清晰的几何信息与呈现上下文；页面 hash 导航及兼容的文档键变化不会丢失标记；折叠或失效的目标也会得到安全处理。标注浮层、检查范围、标注操作和审阅标签均经过细化，让选择并发送精准的页面反馈更加可靠。",
  "Mic mode starts faster and stops cleanly": "麦克风模式启动更快，停止更干净",
  "Voice capture now does less work on the main thread, warms the transcription path earlier, and behaves predictably when you stop or cancel.":
    "语音采集现在会减少界面运行负担，提前预热语音转文字链路，并在停止或取消时保持行为明确、可预期。",
  "Recording uses a streamlined encoding path with measured performance coverage, safer startup and shutdown races, guarded authentication and upload admission, and a clearer send-style stop control. Cancel now discards the recording, while fallback transcription remains available when the preferred path cannot be used.":
    "录音采用更精简的编码链路，并以实际性能测试覆盖关键路径；启动与关闭竞态更安全，认证和上传接入受到严格保护，发送式停止控件也更加清晰。取消操作会直接丢弃录音；首选链路不可用时，仍可回退到备用语音转文字能力。",
  "Approvals and questions settle once": "审批与提问只会结算一次",
  "Permission prompts and other requests for your input are less likely to linger, reappear, or acknowledge the wrong task.":
    "权限提示和其他输入请求不再容易滞留、重复出现或错误确认到其他任务。",
  "Human interactions are now fenced to the owning provider request and turn across Claude and OpenCode. Resolved guards remain resolved, stale cross-turn requests are ignored, retryable interactions stay visible, and OpenCode permission replies wait for a real acknowledgement before Moss clears them.":
    "Claude 与 OpenCode 的人工交互现在会严格绑定到所属的服务商请求和轮次。已解决的保护状态不会反复，跨轮次的过期请求会被忽略，可重试的交互会继续显示；OpenCode 的权限回复必须收到真实确认后，Moss 才会将其清除。",
  "Installed skills and favourite models stay discoverable": "已安装技能与收藏模型始终可发现",
  "Moss now finds installed Claude plugin skills and keeps similarly named favourite models tied to the correct provider.":
    "Moss 现在可以发现已安装的 Claude 插件技能，并确保同名或近似名称的收藏模型始终关联到正确的服务商。",
  "Claude plugin discovery respects install precedence and Windows path boundaries. Model metadata from Pi extensions is normalized without losing resolvable identities, favourite entries distinguish providers, and model-cost context remains accessible in the picker.":
    "Claude 插件发现会遵循安装优先级和 Windows 路径边界。来自 Pi 扩展的模型元数据会在保留可解析身份的前提下统一规范；收藏项会明确区分服务商，模型成本信息也仍可在选择器中查看。",
  "New messages arrive with less visual churn": "新消息到达时画面更加平稳",
  "Opening a conversation is bounded even when deferred work stalls, and a sent message now glides to its reading anchor instead of teleporting.":
    "即使延迟任务卡住，打开对话也有明确的等待上限；消息发送后会平滑移动到阅读锚点，不再瞬间跳位。",
  "Deferred chat mounting has a tested maximum delay. Transcript anchoring uses one monotonic animation clock and a fixed ease-out path, preserves the common non-virtualized route, refreshes recent activity more reliably, and avoids measurement or sidebar updates turning into scroll feedback.":
    "延迟挂载对话设有经过测试的最长等待时间。对话锚定统一采用单调递增的动画时钟和固定缓出路径，保留常见的非虚拟化渲染方式，更可靠地刷新最近活动，并避免尺寸测量或侧边栏更新形成滚动反馈。",
  "Completion alerts mean the task really completed": "完成提醒只在任务真正完成时出现",
  "Moss no longer treats interrupted or errored work as a successful completion or repeats an alert as timestamps change.":
    "Moss 不再把中断或出错的工作误判为成功完成，也不会因时间戳变化而重复提醒。",
  "Completion identity is now tied to the turn rather than mutable session fields, stale snapshots cannot settle the active turn, and notification deduplication remains stable as status projections converge.":
    "完成身份现在绑定到具体轮次，而不是可变的会话字段；过期快照无法错误收尾当前轮次，状态映射逐步收敛时，提醒去重也会保持稳定。",
  "See what needs attention from one Activity view": "在一个 Activity 视图中掌握所有待办",
  "Switch the sidebar to a compact task inbox that keeps running work, input requests, failures, and recently finished tasks easy to scan.":
    "将侧边栏切换为紧凑的任务收件箱，便于快速查看运行中的工作、输入请求、失败项和最近完成的任务。",
  "Activity groups tasks by urgency and recency, keeps important pinned work visible, supports project-scoped filtering, and opens new chats in the latest relevant project. Status indicators settle predictably, stale filters recover to all projects, and the selected view stays in sync across tabs.":
    "Activity 会按紧急程度和时间整理任务，持续显示重要的置顶工作，支持按项目筛选，并在最近相关项目中打开新对话。状态指示会稳定收敛，失效筛选会恢复为全部项目，所选视图也会在不同标签页之间保持同步。",
  "Tasks settle and recover more reliably": "任务收尾与恢复更加可靠",
  "Conversation state now stays closer to the provider's real lifecycle through starts, reconnects, handoffs, and delayed events.":
    "在启动、重连、交接和延迟事件期间，对话状态会更贴近服务商的真实生命周期。",
  "Session orchestration now fences more stale updates, repairs workspace metadata immediately after a worktree handoff, keeps runtime activity attributed to the correct task, and strengthens recovery when provider or projection state arrives out of order.":
    "会话编排现在会隔离更多过期更新，在 worktree 交接后立即修复工作区元数据，确保运行活动归属于正确任务，并在服务商或状态映射乱序到达时加强恢复。",
  "Take back scroll control instantly": "立即夺回滚动控制",
  "Touching the transcript during an automatic jump now stops smooth scrolling at the current position instead of fighting your input.":
    "自动跳转期间一旦操作对话记录，平滑滚动会立即停在当前位置，不再与你的输入争抢控制权。",
  "The transcript cancels both native and virtual-list scroll state at the visible offset, guards late tail-settle work after user takeover or task replacement, and preserves the simpler non-virtualized path for ordinary conversation sizes.":
    "对话记录会在当前可见偏移处同时取消原生与虚拟列表的滚动状态，并在用户接管或任务替换后拦截迟到的末尾定位操作；普通长度的对话仍保留更简单的非虚拟化路径。",
  "Image attachments fail more safely": "图片附件失败时更加安全",
  "Large or awkward images are prepared more defensively before they enter a prompt, with clearer limits and fewer browser-worker edge cases.":
    "大型或特殊格式的图片在进入提示词前会经过更稳健的处理，限制更加明确，也减少了浏览器 Worker 的边界问题。",
  "Composer image handling now bounds resize attempts, keeps worker communication scoped correctly, and hardens attachment intake so unsupported or oversized payloads fail predictably instead of destabilizing the draft.":
    "输入框的图片处理现在会限制缩放尝试次数，确保 Worker 通信范围正确，并强化附件接入；不受支持或过大的内容会以可预期方式失败，而不会破坏草稿。",
  "Sidebar and tool details are easier to read": "侧边栏与工具详情更易阅读",
  "Surface switching, task hover cards, browser tool rows, and active states received a focused visual and accessibility pass.":
    "界面切换、任务悬停卡片、浏览器工具行和活动状态均完成了针对性的视觉与无障碍优化。",
  "The sidebar surface picker has calmer styling, thread cards keep their active state while hovered, browser actions use clearer presentation, Search is located by its accessible name, and urgent or completed states stay legible in dense task lists.":
    "侧边栏界面选择器采用更克制的样式；对话卡片悬停时仍保留活动状态；浏览器操作呈现更清晰；搜索可通过无障碍名称准确定位；紧急与已完成状态在密集任务列表中也保持易读。",
  "Agents can use the visible browser": "智能体可直接操作眼前的浏览器",
  "Let supported agents navigate and operate the same browser surface you can see, with tabs, snapshots, screenshots, input, dialogs, and workspace-safe file transfer.":
    "让受支持的智能体在你看到的同一浏览器界面中导航和操作，并使用标签页、页面快照、截图、输入、对话框，以及仅限项目范围的安全文件传输。",
  "The browser bridge is provider-agnostic and session-scoped: it reuses Moss's visible Electron WebView, cookies, and authenticated state instead of creating a hidden browser. Agents get bounded semantic snapshots, trusted clicks, typing, key presses, scrolling, selection, dragging, waits, and page diagnostics, while navigation, target refs, timeouts, popup sign-in, uploads, and download approval boundaries stay explicit.":
    "浏览器桥接层不依赖特定服务商，并严格限定在当前会话内：它会复用 Moss 中可见的 Electron WebView、Cookie 和已认证状态，而不是另行创建隐藏浏览器。智能体可以获取范围受限的语义快照，并执行可信点击、输入、按键、滚动、选择、拖动、等待和页面诊断；导航、目标 ref、超时、弹窗登录、上传与下载审批的边界始终清晰可控。",
  "Annotate the page before you ask": "提问前先标注页面",
  "Select elements in the visible browser and send compact, redacted annotations with your message so an agent knows exactly what you mean.":
    "选择可见浏览器中的元素，并随消息发送精简、已脱敏的标注，让智能体准确理解你的指代。",
  "Annotations preserve bounded element role, name, text, selector, and page context, support multiple marks with a compact overflow row, survive drafts and transcript rendering, and keep exact-page affinity local. Untrusted page data is clearly separated from user instructions and document-only metadata is removed before provider injection.":
    "标注会在限定范围内保留元素的 role、name、text、selector 及页面上下文；支持同时标记多处，并以精简的汇总行收纳其余标记；草稿和对话呈现过程中都会保留标注，且精确的页面关联只存于本地。不受信任的页面数据会与用户指令明确分离，送入服务商前也会移除仅供文档使用的元数据。",
  "Choose how much autonomy each run has": "选择每次运行的自主程度",
  "Pick Approval required, Auto, or Full access when the selected provider and model support it, with clearer model, effort, and approval controls.":
    "当所选服务商和模型支持时，可选择“需要批准”“自动”或“完全访问”，并使用更清晰的模型、推理强度和审批控件。",
  "Runtime mode is validated before dispatch, and automation or delegated work cannot silently escalate its privilege. Codex and Claude Code expose Auto only when capability is confirmed; unsupported or unknown capabilities fail closed to approval-required. The composer and model pickers now explain the effective mode and pending approvals more clearly.":
    "运行模式会在分发前校验，自动化或委派任务无法暗中提升权限。只有确认具备相应能力时，Codex 和 Claude Code 才会提供“自动”模式；能力不受支持或无法确认时，将按安全原则采用“需要批准”。输入框和模型选择器现在会更清楚地说明实际生效的模式与待处理的审批。",
  "Steer live turns without breaking the transcript": "实时引导当前轮次，不打乱对话记录",
  "Send guidance into a running Codex or Claude turn, or keep follow-ups queued, while the current task remains correctly attributed.":
    "可向正在运行的 Codex 或 Claude 轮次发送引导，也可以让后续消息继续排队，当前任务的归属始终准确。",
  "Native steer calls travel through provider-aware command handling, runtime activity projection, and lifecycle fencing. Sent user messages, live assistant answers, child work, and terminal events stay attached to the right turn across late or replayed updates, interruptions, and provider restarts.":
    "原生引导调用会经过按服务商区分的命令处理、运行时活动状态整理和生命周期隔离。已发送的用户消息、智能体实时回复、子任务和终端事件，即使遇到延迟或重放的更新、中断及服务商重启，也会始终关联到正确轮次。",
  "Streaming conversations stay anchored": "流式对话始终稳住阅读位置",
  "Long or fast responses no longer yank the viewport away from the point you are reading.":
    "长回复或快速输出不再让视口偏离你正在阅读的位置。",
  "Tail following now uses one shared anchor path across estimated and virtualized rows, sent-message reveals, and native browser end-space. New real transcript messages drive auto-follow; tool rows, buffering, measurements, and reconnect-only updates no longer impersonate user-visible message arrivals.":
    "末尾跟随现在对预估高度行与虚拟列表行、已发送消息的定位显示，以及浏览器原生的底部留白采用统一的锚点逻辑。只有对话中真正新增的消息才会触发自动跟随；工具行、缓冲状态、尺寸测量及仅由重连产生的更新，不会再被误判为用户可见的新消息。",
  "Reconnects use less bandwidth and recover more state": "重连更省带宽，也能恢复更多状态",
  "Moss negotiates one authenticated connection, compresses large traffic, and resumes thread detail from a cursor when possible.":
    "Moss 只建立一条认证连接、压缩大体量传输，并在条件允许时从游标续接对话详情。",
  "A single handshake negotiates compatibility and permessage-deflate; delta-capable subscriptions replay from safe cursors with conservative snapshot fallback; precompressed web assets and cache headers speed first loads. Hydration also reads durable projections directly, retries missing snapshots after timed-out starts, and keeps provider notification drains alive until sessions settle.":
    "单次握手会协商兼容性与 permessage-deflate；支持增量更新的订阅会从可靠游标开始重放，并在必要时稳妥回退到完整快照；预压缩的网页资源和缓存响应头会加快首次加载。状态载入还会直接读取持久状态映射，在启动超时后再次请求缺失快照，并让服务商通知队列持续运转至会话收尾完毕。",
  "Open workspace tools from one right dock": "在右侧 Dock 集中打开项目工具",
  "A new launcher puts review, terminal, browser, files, side chat, and source control one click away without crowding the composer.":
    "新的启动器将审阅、终端、浏览器、文件、辅助对话和源代码管理集中到一处，一次点击即可打开，又不会挤占输入框空间。",
  "Dock panes open at a stable half-shell split, keep live terminal state mounted when switching, and gate tools on the current project and repository. Missed draft promotions are recovered during event routing, so a message is less likely to disappear when the dock or task changes.":
    "Dock 面板会以稳定的半屏分栏展开；切换工具时，实时终端仍会保持挂载；工具也会根据当前项目和仓库决定是否可用。遗漏的草稿转正状态会在事件分发过程中补齐，因此切换 Dock 或任务时，消息不易再丢失。",
  "Provider choices show their real capabilities": "服务商选项如实展示能力",
  "Model discovery and runtime menus stay useful across cold starts, Claude capabilities, and mixed provider sessions.":
    "无论是冷启动、Claude 能力还是混合服务商会话，模型发现和运行时菜单都能保持实用、准确。",
  "Claude models can be discovered on a cold start, model and effort options use capability-aware ordering and labels, and thread hover cards expose the active provider and model context. Unknown provider update statuses no longer break self-update flows, and Antigravity returns a decision for inactive hook requests instead of launching Moss.":
    "冷启动时也可发现 Claude 模型；模型与推理强度选项会根据能力排序并标注；任务悬停卡片则会显示当前服务商和模型信息。未知的服务商更新状态不再中断自动更新流程；Antigravity 也会为未激活的 hook 请求返回明确决定，而不会启动 Moss。",
  "Git workflows explain what needs attention": "Git 工作流清楚提示待处理事项",
  "When a branch is behind upstream, Environment surfaces Pull before risky actions, and generated PR bodies can follow repository templates.":
    "当分支落后于上游时，“环境”面板会在高风险操作前显示“拉取”；生成的 PR 正文也可遵循仓库模板。",
  "Git action availability now uses one consistent upstream and working-tree state model. PR generation discovers applicable `.github` templates, removes boilerplate instructions, and asks the selected provider to fill the repository's own sections while preserving the fallback body when none exists.":
    "Git 操作是否可用现在统一依据同一套上游与工作树状态模型。生成 PR 时会查找适用的 `.github` 模板、移除模板中的说明文字，并让所选服务商按仓库原有结构填写各部分；如果没有模板，则保留默认正文。",
  "Stop stays responsive under load": "高负载下仍能及时停止",
  "Interrupt and stop actions now take priority over new work, even when a busy Moss server has filled its ordinary command queue.":
    "即使繁忙的 Moss 服务器已占满常规命令队列，中断与停止操作也会优先于新任务执行。",
  "Control, user, and background commands now use separate admission priorities while preserving reserved capacity for recovery. Provider calls and lifecycle locks are bounded too, so one wedged session cannot hold every other task hostage, and failed stop requests now surface an actionable error instead of silently leaving the UI spinning.":
    "控制命令、用户命令与后台命令现在采用独立的接入优先级，并为故障恢复预留处理能力。服务商调用和生命周期锁也设有明确边界，因此单个卡死会话无法阻塞其他所有任务；停止失败时，界面会给出可采取行动的错误提示，不再无休止地等待。",
  "Undo can recover from a partial failure": "撤销遇到部分失败时也能恢复",
  "File and conversation reverts now preserve a rescue snapshot before changing your worktree and restore it if the provider rollback fails.":
    "文件与对话回退会在更改 worktree 前保留救援快照；如果服务商回滚失败，Moss 会用该快照恢复现场。",
  "Reverts validate checkpoints before mutation, work without a live provider session, retry their deterministic completion step, and clean up managed refs only after the operation commits. Grouped file-change cards undo newest-first, while failures identify any retained rescue ref so recovery remains explicit.":
    "回退会在写入前校验检查点，即使没有在线的服务商会话也能执行；确定性的收尾步骤支持重试，且仅在操作提交后才清理托管 ref。成组的文件变更卡片会从最新变更开始撤销；若操作失败，提示中会标明保留的救援 ref，让后续恢复路径清晰可查。",
  "Interrupted sessions settle cleanly": "中断的会话可正常收尾",
  "Turns are less likely to remain stuck as running after terminal provider events, restarts, stale resumes, or delayed lifecycle updates.":
    "服务商发出终止事件、应用重启、恢复请求过期或生命周期更新延迟后，任务轮次不再容易卡在运行状态。",
  "Moss retains enough turn identity to settle late Claude results, fences stale lifecycle generations, reconciles durable provider commands and runtime events, and aligns Codex, Claude, Cursor, and ACP session ownership through start, stop, reconnect, and restart boundaries.":
    "Moss 会保留足够的轮次身份信息，以便妥善收尾迟到的 Claude 结果；同时隔离过期的生命周期代次，并校准持久化服务商命令与运行时事件。Codex、Claude、Cursor 和 ACP 的会话归属也会在启动、停止、重新连接和重启等边界保持一致。",
  "Follow-ups no longer disappear into stale queues": "后续消息不会再消失在失效队列中",
  "A thread that looks busy but has no real active turn keeps the composer available instead of accepting a message that cannot be dispatched.":
    "如果对话看似忙碌、实际却没有活跃轮次，输入框会保持可用，而不会接收一条注定无法分发的消息。",
  "Queue draining now requires a queueable live turn, the transcript keeps the newest answer open while terminal state converges, and visible stop failures are reported immediately. These safeguards keep the conversation usable while server-side recovery repairs stale session state.":
    "只有存在可接收排队消息的实时轮次时，队列才会开始分发；终止状态逐步收敛期间，对话记录会继续展开最新回复；可见的停止失败也会立即报告。这些保护措施让服务端修复过期会话状态时，对话依然可用。",
  "Open tasks stay present during refreshes": "刷新期间打开的任务保持可见",
  "Visible task details are retained and re-requested across overlapping snapshot, subscription, and eviction work instead of briefly rendering as an empty conversation.":
    "快照、订阅与缓存淘汰操作重叠时，当前可见的任务详情会被保留并重新请求，不会短暂显示为空对话。",
  "Thread-detail retention now understands what is on screen, re-arms refreshes that race an in-flight snapshot, and normalizes projections more defensively. Cleanup also preserves archived tasks, newly forked or handed-off tasks, and soft-deleted history without proven manual-delete provenance.":
    "对话详情保留机制现在会识别屏幕上实际可见的内容；当刷新与进行中的快照发生竞态时，会重新安排刷新，并以更稳健的方式规范状态映射。清理过程也会保留已归档任务、刚刚派生或交接的任务，以及无法确认由用户手动删除的软删除历史。",
  "Every agent's live tool work is visible": "所有智能体的实时工具操作均清晰可见",
  "Follow tools as they start, update, and finish across supported providers, with consistent labels and details directly in the transcript.":
    "在所有受支持的服务商中，都能直接从对话记录查看工具的启动、更新与完成过程，并获得一致的标签和详情。",
  "Moss now normalizes live and settled tool activity into one presentation model, preserves expandable tool details and interactions, and reconciles terminal states without leaving duplicate or permanently running work rows behind.":
    "Moss 现在以统一方式呈现进行中与已结束的工具活动，保留可展开的工具详情和交互，并准确校准终止状态，不再留下重复或永久显示为运行中的任务行。",
  "Live tasks recover after reconnects": "实时任务在重新连接后自动恢复",
  "Provider status, active turns, and thread details converge back to the server's real state after dropped connections or delayed events.":
    "连接中断或事件延迟后，服务商状态、活跃轮次与对话详情会重新与服务器的真实状态保持一致。",
  "Reconnect refreshes preserve useful status while new data arrives, stale live projections are fenced and repaired, settled turns stop polling, and thread-detail ownership is reconciled across lease, snapshot, and subscription races.":
    "重新连接后的刷新会在新数据到达前保留有用状态，同时隔离并修复过期的实时状态；已收尾的轮次会停止轮询，对话详情的归属也会在租约、快照与订阅的竞态中得到正确校准。",
  "Choose whether follow-ups queue or steer": "选择后续消息排队或立即引导",
  "Set new messages sent during active work to wait their turn or steer the current agent immediately.":
    "可以让任务运行期间发送的新消息排队等待，也可以立即引导当前智能体调整方向。",
  "The new conversation setting is searchable in Settings and is applied consistently by the composer while a task is running, with Queue as the predictable default and Steer available for more interactive workflows.":
    "这项新的对话设置可在“设置”中搜索，并会在任务运行期间由输入框一致执行。默认采用行为可预期的“排队”，需要更强互动时则可选择“引导”。",
  "Blocked threads can be recovered": "受阻对话可安全恢复",
  "When an uncertain provider delivery quarantines a thread, the error banner now offers a safe Unblock thread action.":
    "当无法确认服务商是否成功送达消息而隔离对话时，错误提示现在会提供安全的“解除对话阻塞”操作。",
  "Moss abandons ambiguous blockers oldest-first, then replays only the skipped turn starts. This restores the conversation without risking a duplicate resend of the command whose delivery could not be proven.":
    "Moss 会从最早的记录开始放弃状态不明的阻塞项，随后仅重放被跳过的轮次启动。这样既能恢复对话，又不会冒险重复发送一条无法确认是否已送达的命令。",
  "Automations and desktop recovery are tougher": "自动化与桌面恢复更加可靠",
  "Dedicated automation runs, clearer completion policies, and bounded desktop crash recovery make unattended work more dependable.":
    "独立的自动化运行、更加明确的完成策略，以及设有边界的桌面崩溃恢复，让无人值守任务更加可靠。",
  "Automation self-cancellation is explicitly authorized, run state and completion policies persist more reliably, renderer crashes use bounded reload recovery with actionable prompts, and process supervision, executable lookup, terminal wrappers, worktrees, and Git status broadcasting handle failure boundaries more carefully.":
    "自动化自行取消现在需要明确授权，运行状态与完成策略也能更可靠地持久保存。渲染进程崩溃后会执行次数受限的重新载入恢复，并显示可采取行动的提示；进程监督、可执行文件查找、终端包装层、worktree 与 Git 状态广播也会更谨慎地处理故障边界。",
  "Startup and large diffs do less work": "启动与大型 diff 更轻量",
  "Moss loads expensive provider and diff machinery only when needed and computes working-tree statistics without transferring full patches.":
    "Moss 只在需要时才载入开销较高的服务商与 diff 模块，并且无需传输完整补丁即可计算工作树统计信息。",
  "Shell environment probes and orchestration startup state are reused, route chunks are preloaded selectively, supervised process scans are throttled, and React Compiler coverage protects chat, picker, hook, and UI hot paths.":
    "Shell 环境探测结果与编排启动状态会被复用，页面代码会按需预载，受监督的进程检查也会限制频率；React Compiler 覆盖则保护聊天、选择器、hook 与界面高频路径。",
  "Local state stays safer": "本地状态更安全",
  "Exclusive SQLite locking and stricter migration-artifact cleanup reduce the chance of competing writers or abandoned update files.":
    "SQLite 独占锁与更严格的迁移产物清理，可降低多个写入方相互竞争或遗留更新文件的风险。",
  "Database access now proves exclusive ownership, migration backups and resumable artifacts receive broader retention and reclamation coverage, and orphan cleanup stays bounded to verified Moss-owned paths.":
    "数据库访问现在会先确认独占所有权；迁移备份与可续接产物具备更完整的保留和回收保障；孤立文件清理也严格限定在已确认归 Moss 所有的路径中。",
  "Make the Void space your own": "按你的方式定制 Void 空间",
  "Rename Void and choose its icon so unassigned projects fit the way you organize your workspace.":
    "可以重命名 Void 并选择图标，让未分配项目更符合你的组织方式。",
  "The custom presentation is stored locally and appears consistently in the sidebar, Space switcher, project pickers, and creation flows, with validation and a one-step reset to the default.":
    "自定义名称与图标会保存在本地，并一致显示在侧边栏、Space 切换器、项目选择器和创建流程中；输入会经过校验，也可一步恢复默认设置。",
  "Small details are calmer and clearer": "细节更从容，信息更清晰",
  "Completion notifications retain useful Markdown context, command menus explain loading and empty states, and Settings are organized around user intent.":
    "完成通知会保留有用的 Markdown 上下文，命令菜单会说明加载中与空状态，而“设置”则会按照用户意图组织。",
  "This release also standardizes settings cards and elevated hover surfaces, simplifies subagent transcript rows, preserves the landing project color, keeps Ctrl-minus zoom working on Windows and browser guests, improves diff and composer hot paths, and makes fenced code, references, nested Markdown, and technical completion summaries safer and easier to read.":
    "本次更新还统一了设置卡片与悬停浮层，简化了子智能体对话记录行，保留落地页项目颜色，并确保 Ctrl-minus 缩放在 Windows 与浏览器访客环境中正常工作。同时优化了 diff 与输入框的高频路径，让围栏代码块、引用、嵌套 Markdown 和技术性完成摘要更安全、更易阅读。",
  "Updates recover safely from interrupted migrations": "迁移中断后，更新可安全恢复",
  "Moss now detects and repairs the database state that could leave some 0.6.0 installations stuck during startup.":
    "Moss 现在会检测并修复可能导致部分 0.6.0 安装在启动时卡住的数据库状态。",
  "Migration lineage is validated before launch, recovery uses verified backups and resumable markers, and the desktop supervisor distinguishes recoverable migration failures from ordinary backend exits. The recovery path is covered on macOS, Linux, and Windows, including Windows-specific process and filesystem behavior.":
    "启动前会先校验迁移谱系；恢复过程使用经过验证的备份与可续接标记；桌面监督程序也能区分可恢复的迁移故障和普通后端退出。恢复路径已覆盖 macOS、Linux 与 Windows，包括 Windows 特有的进程和文件系统行为。",
  "Projects are easier to enter and switch": "进入和切换项目更加便捷",
  "Start from the project you want directly in the new-task heading, with fewer intermediate workspace screens and steadier navigation state.":
    "可直接从新任务标题选择目标项目，减少中间工作区页面，并让导航状态更加稳定。",
  "The project name in the empty-chat heading is now a picker trigger, Space navigation is normalized through one shared path, and Studio workspace metadata is repaired during migration so restored tasks open in the right place.":
    "空白对话标题中的项目名称现在可直接打开选择器；Space 导航统一通过一条共享路径处理；迁移时还会修复 Studio 工作区元数据，确保恢复的任务在正确位置打开。",
  "Diff and Git tools stay in sync": "差异与 Git 工具保持同步",
  "Switch diff views, refresh repository state, and copy large virtualized changes without stale controls or missing content.":
    "切换差异视图、刷新仓库状态或复制大型虚拟化变更时，控件不会过期，内容也不会缺失。",
  "The diff toolbar now derives its mode and selection consistently, Select All copies the complete virtualized diff, Git status refreshes after actions, and branch controls handle repository and worktree state more predictably.":
    "差异工具栏现在会一致地计算模式与选中项；“全选”可复制完整的虚拟化差异；执行操作后会刷新 Git 状态；分支控件处理仓库与 worktree 状态时也更加可靠。",
  "Agent sessions settle and recover more cleanly": "智能体会话结束与恢复更加干净",
  "Claude, OpenCode, Pi, Codex, and other providers keep their model choices, runtime state, and shutdown boundaries aligned through reconnects and failures.":
    "Claude、OpenCode、Pi、Codex 及其他服务商在重连与故障期间会保持模型选择、运行状态和关闭边界一致。",
  "This release fixes Pi model discovery against the current runtime SDK, ignores stale OpenCode plan agents, hardens Claude resume and permission handling, preserves WebSocket requests across reconnect boundaries, and proves process-tree teardown before replacing desktop or provider backends.":
    "本次发布修复了 Pi 针对当前运行时 SDK 的模型发现，忽略过期的 OpenCode 计划智能体，强化 Claude 续接与权限处理，在重连边界间保留 WebSocket 请求，并在替换桌面或服务商后端前确认整个进程树已经停止。",
  "Live work is easier to read": "实时工作状态更易读",
  "Automation rows show state-specific icons, task hydration is calmer, and active conversations avoid unnecessary projection and subscription churn.":
    "自动化条目会显示对应状态的图标，任务载入更加平稳，活跃对话也会避免不必要的状态整理与订阅抖动。",
  "Automation status now distinguishes running, attention, failure, and settled states at a glance. Store projection, thread-detail retention, terminal cleanup, and sidebar updates were tightened so busy workspaces remain responsive and predictable.":
    "自动化状态现在可一眼区分运行中、需要关注、失败与已结束。状态整理、对话详情保留、终端清理和侧边栏更新均已收紧，使繁忙的工作区依然响应迅速、行为可靠。",
  "Bring Moss to any MCP-capable agent": "将 Moss 接入任意支持 MCP 的智能体",
  "Connect Codex, Claude Code, Claude Desktop, or another local MCP app, then let it discover your Moss workspace, launch isolated tasks, wait for results, and bring the answer back.":
    "连接 Codex、Claude Code、Claude Desktop 或其他本地 MCP 应用，即可发现 Moss 工作区、启动隔离任务、等待结果并取回答案。",
  "Settings → Integrations now provides a copy-ready guided prompt for agentic clients, manual JSON configuration for Claude Desktop and other non-agentic clients, resumable pairing, all-or-selected project access, provider and model discovery, connection status, and immediate revocation. Connections expire, are rate-limited and capability-scoped, and default new work to managed worktrees with approval-required execution; local-checkout, full-access, and project-wide task reading stay behind explicit advanced permissions.":
    "“设置 → 集成”现在为智能体客户端提供可直接复制的引导提示，为 Claude Desktop 等非智能体客户端提供手动 JSON 配置，并支持可续接配对、全部或指定项目访问、服务商与模型发现、连接状态查看及即时撤销。连接具有有效期、速率限制和能力范围；新任务默认使用受管 worktree，并在执行前要求批准。本地检出、完全访问和项目级任务读取仍需显式开启高级权限。",
  "Moss agents can now operate Moss": "Moss 智能体现在可以操作 Moss",
  "Every supported agent running inside Moss receives built-in tools to understand the app, delegate work, coordinate parallel tasks, inspect failures, and manage automations.":
    "在 Moss 中运行的每个受支持智能体都会获得内置工具，可了解应用、委派工作、协调并行任务、检查故障并管理自动化。",
  "The new Moss Agent Gateway can list and read projects and tasks, create one task or an exact multi-agent batch across providers and models, wait for every result, continue or interrupt work, rename or archive tasks, inspect runtime diagnostics, and manage automation lifecycles. Thread-bound authority, privilege caps, idempotent creation, isolated worktrees, and restart recovery keep delegated work visible and contained.":
    "新的 Moss Agent Gateway 可列出并读取项目与任务，跨服务商和模型创建单个任务或精确的多智能体批次，等待全部结果，继续或中断工作，重命名或归档任务，检查运行诊断，并管理自动化生命周期。与对话绑定的权限、权限上限、幂等创建、隔离 worktree 和重启恢复机制，让委派工作始终可见且范围受控。",
  "Organize projects into Spaces": "使用 Space 整理项目",
  "Create named, icon-based Spaces for the parts of your work that belong together, while unassigned projects remain easy to find in Void.":
    "可用名称和图标创建 Space，将相关工作归为一组；未分配的项目仍可在 Void 中轻松找到。",
  "Spaces support persisted ordering, project assignment, drag-and-drop movement, bulk moves, activity indicators, inline creation while adding a project, and numbered keyboard shortcuts for direct switching.":
    "Space 支持持久排序、项目分配、拖放移动、批量移动、活动指示、添加项目时就地创建，以及通过数字快捷键直接切换。",
  "Automations become long-running collaborators": "自动化成为长期协作者",
  "Ask an agent to suggest or create scheduled and heartbeat automations with memory, limits, notifications, and clear review states.":
    "可让智能体建议或创建定时与心跳自动化，并配置记忆、限制、通知及清晰的复核状态。",
  "Automations now support standalone and heartbeat modes, persistent memory, cooldowns, maximum runs, notification and completion policies, pause and resume, proposal review, run reconciliation after interruptions, and richer list rows for unread results, failures, approvals, and changes that need attention.":
    "自动化现在支持独立与心跳模式、持久记忆、冷却时间、最大运行次数、通知与完成策略、暂停与继续、方案复核、中断后的运行状态协调，以及更丰富的列表条目，用于呈现未读结果、失败、审批和需要关注的变更。",
  "Claude subagents and workflows are first-class": "原生支持 Claude 子智能体与工作流",
  "Follow Claude's native subagents and dynamic workflows as real Moss work, with live status, phases, tools, usage, steering, and background controls.":
    "可将 Claude 原生子智能体与动态工作流作为真实的 Moss 工作进行跟踪，并查看实时状态、阶段、工具、用量、引导与后台控制。",
  "Child tasks are navigable and independently visible, workflow cards show every phase and agent by default, model and effort stay live, and pause, resume, stop, foreground, and background actions remain synchronized through late events and provider restarts.":
    "子任务可导航并独立查看；工作流卡片默认展示每个阶段与智能体；模型和推理强度保持实时；即使出现延迟事件或服务商重启，暂停、继续、停止、转前台与转后台操作也会保持同步。",
  "Bring another task into the conversation": "将另一项任务带入当前对话",
  "Mention an existing Moss task from the composer to give the current agent the right recent context without copying a transcript by hand.":
    "在编辑器中提及已有 Moss 任务，即可为当前智能体提供恰当的近期上下文，无需手动复制对话记录。",
  "Cross-task mentions include bounded recent conversation context together with the source project and provider identity, and disambiguate tasks that share the same title.":
    "跨任务提及会附带有界的近期对话上下文、来源项目和服务商身份，并能区分标题相同的任务。",
  "New work starts faster and streams lighter": "新任务启动更快，流式更新更轻量",
  "New chats paint sooner, model choices arrive earlier, and active turns spend less time on repeated setup, storage, and rendering work.":
    "新对话更快显示，模型选项更早到达，活跃轮次也会减少重复初始化、存储与渲染开销。",
  "Moss prefetches provider models before the composer opens, avoids a redundant first-turn Claude permission wait, prepares Codex overlays without blocking, parallelizes independent turn-start I/O, reduces streaming SQL work, and expands React Compiler coverage across the web app.":
    "Moss 会在编辑器打开前预取服务商模型，省去 Claude 首轮中一次重复的权限等待，以非阻塞方式准备 Codex 覆盖层，并行处理轮次启动时互不依赖的 I/O，减少流式 SQL 工作，同时扩大 React Compiler 在 Web 应用中的覆盖范围。",
  "Provider sessions stay truer to their capabilities": "服务商会话更准确地遵循自身能力",
  "Claude, Codex, Cursor, Droid, Grok, OpenCode, Kilo, Pi, and Antigravity receive a broad round of model, permission, resume, child-event, and completion fixes.":
    "Claude、Codex、Cursor、Droid、Grok、OpenCode、Kilo、Pi 与 Antigravity 获得了一轮覆盖模型、权限、续接、子事件与完成状态的全面修复。",
  "Highlights include Fable 5 and Opus 4.8 in Pi, namespaced Cursor and Grok model support, accurate Claude context windows, official ACP SDK handling, app-owned OpenCode review commands, isolated Codex child events, safer provider updates, preserved blank PATH defaults, and an Antigravity hook that no longer launches Moss unexpectedly.":
    "重点包括 Pi 中的 Fable 5 与 Opus 4.8、带命名空间的 Cursor 和 Grok 模型支持、准确的 Claude 上下文窗口、官方 ACP SDK 处理、由应用管理的 OpenCode 复核命令、相互隔离的 Codex 子事件、更安全的服务商更新、保留空白 PATH 默认值，以及不再意外启动 Moss 的 Antigravity hook。",
  "Desktop and browser lifecycles recover cleanly": "桌面与浏览器生命周期可干净恢复",
  "Browser control, Windows shutdown, managed worktrees, durable secrets, thread deletion, and macOS release finalization now fail and recover more predictably.":
    "浏览器控制、Windows 关闭、受管 worktree、持久密钥、对话删除和 macOS 发布收尾在失败与恢复时都更加可靠。",
  "The desktop browser bridge restores discovery, ownership, teardown, and reconnect behavior; Windows waits for the backend to stop; interrupted worktree cleanup resumes safely; deleted work cannot resurrect queued turns; credential writes survive interruption; and universal macOS releases preserve the correct update metadata.":
    "桌面浏览器桥接恢复了发现、归属、停止与重连行为；Windows 会等待后端停止；中断的 worktree 清理可安全续接；已删除的工作不会让排队轮次复活；凭据写入可承受中断；通用 macOS 发布也会保留正确的更新元数据。",
  "Hundreds of small edges feel calmer": "数百处细节更加从容",
  "Sharper Markdown hierarchy, steadier pickers, better composer spacing, smarter sidebar priority, clearer Studio Git controls, and new shortcuts make daily work easier to scan.":
    "更清晰的 Markdown 层级、更稳定的选择器、更合理的编辑器间距、更智能的侧边栏优先级、更明确的 Studio Git 控件和新快捷键，让日常工作更易浏览。",
  "This release also adds Commit and Push from the active task, configurable AppSnap shortcuts, a folder opener in Studio, a slimmer running indicator, reliable Cmd+K search on macOS, fixed PR review counts, safer file-icon lookup, cleaner stacked composer panels, and a global new-task flow that uses the latest project state.":
    "本次发布还支持从当前任务执行 Commit 与 Push、可配置的 AppSnap 快捷键、Studio 文件夹打开按钮、更精简的运行指示、macOS 上可靠的 Cmd+K 搜索、修正后的 PR 复核计数、更安全的文件图标查找、更整洁的编辑器堆叠面板，以及始终使用最新项目状态的全局新任务流程。",
  "Antigravity joins Moss": "Antigravity 正式加入 Moss",
  "Connect the Antigravity CLI as a first-class coding agent, with discovered models, reasoning controls, streaming activity, approvals, and resumable conversations.":
    "将 Antigravity CLI 作为原生编程智能体接入，支持模型发现、推理控制、流式活动、审批与可续接对话。",
  "The new provider adapter covers installation and authentication guidance, model and effort discovery, session creation and resume, tool and plan events, permission requests, usage reporting, cancellation, and restart recovery. Moss also includes dedicated Antigravity branding throughout provider setup and selection.":
    "新的服务商适配器涵盖安装与认证指引、模型和推理强度发现、会话创建与续接、工具和计划事件、权限请求、用量报告、取消以及重启恢复；Moss 也在服务商设置与选择界面中加入了专属 Antigravity 品牌元素。",
  "Live turns settle cleanly": "实时轮次可可靠结束",
  "Working indicators and streamed turn chrome no longer linger after the underlying provider session has already finished.":
    "底层服务商会话结束后，工作状态指示与流式轮次界面不再滞留。",
  "Turn settlement now follows the owning session lifecycle, while WebSocket RPC requests resolve or reject across close, timeout, send failure, and reconnect paths. This keeps pending UI state from becoming stuck during partial streams or interrupted connections.":
    "轮次结束现在跟随所属会话的生命周期；WebSocket RPC 请求在关闭、超时、发送失败与重连路径中都会明确完成或拒绝，避免界面等待状态因不完整流或连接中断而卡住。",
  "Active chats stay lighter": "活跃对话运行更轻快",
  "Conversation updates do less repeated reconciliation work, keeping busy transcripts and sidebar-driven changes more responsive.":
    "对话更新减少了重复的状态协调工作，让繁忙的对话记录与侧边栏触发的变更响应更快。",
  "Chat state now avoids redundant scans and projections during live updates, bundled theme seeds reset consistently, and common transcript behavior remains on the simpler rendering path without introducing new measurement loops.":
    "实时更新期间，对话状态会减少重复检查与整理；内置主题种子可一致重置，常用对话记录行为继续采用更简单的渲染路径，不会引入新的测量循环。",
  "Dropped paths become reliable mentions": "拖入路径可可靠转换为提及",
  "Drop files and folders whose names contain spaces or parentheses into the composer without losing or mangling the path.":
    "可将名称含空格或括号的文件与文件夹拖入编辑器，路径不会丢失或损坏。",
  "Desktop path payloads are parsed and normalized through shared composer logic, then preserved as mentions across chat and Kanban task creation. Focused coverage includes encoded paths, multiple drops, punctuation, send normalization, and unsupported payloads.":
    "桌面路径数据会通过共享编辑器逻辑解析并规范化，并在对话与看板任务创建中保留为提及；专项测试覆盖编码路径、多项拖入、标点、发送规范化与不支持的数据。",
  "Provider failures stay contained": "单个服务商故障会被隔离",
  "A failed Cursor model refresh no longer takes down the model picker or discards usable choices from other discovery sources.":
    "Cursor 模型刷新失败时，不再导致模型选择器不可用，也不会丢弃其他发现来源中的可用选项。",
  "Model-catalog queries retain successful and cached data when one Cursor discovery path fails, while pull-request data is coalesced through shared list logic and picker popups use a unified interaction model. Diff headers now use Moss's own visual chrome for a more consistent workspace.":
    "当某条 Cursor 发现路径失败时，模型目录查询仍会保留成功结果与缓存数据；拉取请求数据通过共享列表逻辑合并，选择器弹层采用统一交互模型，差异标题也改用 Moss 自有视觉样式，使工作区更加一致。",
  "Mainland phone login completes reliably": "中国大陆手机号登录更稳定",
  "Moss now accepts the canonical phone identity returned after SMS verification and keeps the signed-in session stable across restarts.":
    "Moss 现在会正确接收短信验证后返回的标准手机标识，并在重启后继续保持登录状态。",
  "The authentication boundary normalizes GoTrue phone values consistently for verification, refresh, and user lookup. Failed codes are cleared before retry, and account errors are presented in Chinese without exposing service internals.":
    "认证层会统一规范 GoTrue 手机号，用于验证、刷新和用户查询；重试前会清除失败的验证码，账户错误也会以中文友好展示，不再暴露服务内部信息。",
  "Moss starts with its own local workspace": "Moss 拥有独立的本地工作区",
  "Packaged Moss installations no longer inherit projects, chats, cookies, or account state from a retired legacy profile.":
    "安装版 Moss 不再继承旧版应用配置中的项目、对话、Cookie 或账户状态。",
  "Electron profile data now lives under the Moss application namespace and backend state under ~/.moss. Existing legacy data remains untouched and is not imported automatically.":
    "Electron 用户数据现归入 Moss 应用命名空间，后端状态保存在 ~/.moss；原有旧版数据保持不变，也不会被自动导入。",
  "Review pull requests without leaving Moss": "无需离开 Moss 即可审阅拉取请求",
  "Browse, search, and filter pull requests across your projects, then open a complete review workspace beside the conversation.":
    "可跨项目浏览、搜索和筛选拉取请求，并在对话旁打开完整的审阅工作区。",
  "The new GitHub CLI-backed Pull Requests view groups work by involvement and state, supports project-scoped discovery, and opens summary, code, and timeline views with checks, reviewers, commits, file changes, and discussion context.":
    "新的“拉取请求”视图由 GitHub CLI 提供支持，可按参与关系和状态分组、按项目发现 PR，并在摘要、代码和时间线中查看检查结果、审阅者、提交记录、文件变更与讨论上下文。",
  "Take action from the review workspace": "直接在审阅工作区处理 PR",
  "Comment, merge, close, reopen, and pin pull requests while keeping the latest repository state close at hand.":
    "可直接评论、合并、关闭、重新打开或固定拉取请求，并随时掌握仓库的最新状态。",
  "Mutations use shared cache coordination, single-flight refreshes, guarded optimistic state, and recovery paths so overlapping actions and refreshes remain predictable. Pinned pull requests stay easy to return to from the project workspace.":
    "写操作通过共享缓存协调、合并重复刷新请求、受控的乐观更新与恢复路径保持一致，即使操作和刷新重叠也能得到可预测的结果；固定的拉取请求可从项目工作区快速返回。",
  "Repository failures stay contained": "单个仓库故障不再影响全局",
  "One unavailable repository no longer prevents useful pull-request results from the rest of your workspace.":
    "即使某个仓库暂时不可用，工作区中的其他仓库仍能正常返回拉取请求结果。",
  "GitHub CLI availability, authentication, repository discovery, partial-result errors, stale cached data, and retry recovery now have explicit states. Per-repository failures remain visible without discarding successful results.":
    "GitHub CLI 可用性、认证、仓库发现、部分结果错误、过期缓存与重试恢复现在都有明确状态；每个仓库的失败会单独显示，不会丢弃已经成功取得的结果。",
  "Send feedback from anywhere": "随时随地发送反馈",
  "Open the new feedback dialog from the command menu or with /feedback whenever an idea or problem comes up.":
    "遇到想法或问题时，可从命令菜单或输入 /feedback 随时打开新的反馈对话框。",
  "Feedback is now a global workflow rather than a settings-only destination, with consistent command routing and a focused dialog that keeps the current task in place.":
    "反馈现已成为全局工作流，不再局限于设置页；统一的命令入口与专注对话框可让当前任务保持原位。",
  "Desktop windows reopen where you left them": "桌面窗口会恢复到上次的位置",
  "Moss restores the previous desktop window size, position, and maximized state while keeping reopened windows on a visible display.":
    "Moss 会恢复上次的窗口大小、位置与最大化状态，同时确保重新打开的窗口位于可见显示器内。",
  "Window state is persisted across launches and validated against the current monitor layout, avoiding off-screen restoration when displays have changed.":
    "窗口状态会跨启动保存，并依据当前显示器布局校验；即使显示器发生变化，也不会把窗口恢复到屏幕之外。",
  "Model and session behavior is more predictable": "模型与会话行为更加稳定一致",
  "Agent sessions, transcript rendering, model discovery, and reasoning controls now stay aligned across more providers.":
    "智能体会话、对话记录渲染、模型发现与推理控制现在可在更多服务商之间保持一致。",
  "Session orchestration and transcript rendering share a cleaner lifecycle, Pi custom-provider authentication follows auth.json semantics, Cursor transport-only variants stay out of the picker, and Grok reasoning-effort options match provider capabilities. The interface also adopts the system UI font more consistently.":
    "会话编排与对话记录渲染采用更清晰的生命周期；Pi 自定义服务商认证遵循 auth.json 语义；Cursor 仅用于传输的变体不会出现在选择器中；Grok 的推理强度选项也会匹配服务商能力。界面同时更一致地采用系统 UI 字体。",
  "Capture any Mac app straight into your task": "把任意 Mac 应用窗口直接捕获到任务中",
  "Press both Option keys to capture the window you are using and attach it to your current task.":
    "同时按下左右两个 Option 键，即可捕获当前窗口并附加到正在进行的任务。",
  "AppSnap is an opt-in macOS workflow with a dedicated setup panel, permission guidance, capture feedback, app icons, and a first-run introduction. Captures stay tied to the active task without stealing focus, and the desktop helper is included in packaged Mac builds.":
    "AppSnap 是可选择启用的 macOS 工作流，配有专属设置面板、权限指引、捕获反馈、应用图标和首次使用介绍。截图会绑定到当前任务且不会抢走焦点，安装版 Mac 应用也已包含桌面辅助程序。",
  "AppSnaps wait safely until you send": "AppSnap 截图会安全保留到发送时",
  "Captured windows remain available through navigation, restarts, retries, and manual attachment flows.":
    "无论切换页面、重启、重试还是手动添加附件，已捕获的窗口都会继续保留。",
  "Pending image blobs are persisted outside the lightweight draft record, restored into the composer on startup, counted against attachment limits, deduplicated across retry paths, and hydrated immediately before send. Failed or overlapping captures recover without duplicating attachments or replaying feedback sounds.":
    "待发送的图像数据会独立于轻量草稿持久保存，启动时恢复到编辑器，计入附件上限，并在不同重试路径间去重，发送前再即时载入。捕获失败或重叠时也能恢复，不会重复添加附件或重复播放提示音。",
  "Long messages are easier to scan": "长消息更容易快速浏览",
  "Large user messages collapse into a focused preview while rich markdown and attachment chips remain readable.":
    "较长的用户消息会折叠为精简预览，同时保留清晰的 Markdown 内容和附件标签。",
  "Transcript measurement, overflow detection, markdown chip rendering, and the simple non-virtualized timeline path now work together more predictably, reducing layout churn without losing the full message on demand.":
    "对话记录测量、溢出检测、Markdown 标签渲染与非虚拟化时间线现在能更稳定地协作，减少布局跳动，同时仍可按需查看完整消息。",
  "Agent sessions fail more clearly": "智能体会话出错时提示更清晰",
  "ACP errors preserve more useful detail, and session and transcript state stay steadier during active work.":
    "ACP 错误会保留更多有用细节，任务进行时的会话和对话记录状态也更加稳定。",
  "ACP request failures now retain structured provider context, while session orchestration and transcript handling avoid redundant state transitions and keep live output presentation predictable.":
    "ACP 请求失败时会保留结构化的服务商上下文；会话编排和对话记录处理会避免重复状态切换，让实时输出稳定呈现。",
  "Factory Droid is now a first-class provider": "Factory Droid 成为原生支持的服务商",
  "Droid is now available alongside Moss's other agents, with runtime model discovery, session import, token multipliers, and resilient resume and recovery.":
    "Droid 现可与 Moss 的其他智能体并列使用，支持运行时模型发现、会话导入、用量倍率，以及可靠的续接与故障恢复。",
  "Moss now connects to Factory Droid through ACP, discovers models and their switching capabilities at runtime, imports existing Droid sessions, carries context across forks and restarts, and keeps bootstrap, configuration, and turn teardown state coherent. The release also adds the Factory logo and richer Droid token reporting.":
    "Moss 现通过 ACP 连接 Factory Droid，可在运行时发现模型及其切换能力、导入已有 Droid 会话，并在分支与重启之间延续上下文，同时保持初始化、配置和轮次结束状态一致。本次还加入 Factory 标志和更完整的 Droid 用量报告。",
  "Large conversation histories start reliably": "大型对话历史也能可靠启动",
  "Moss now upgrades large local histories without leaving the project list stuck on its loading screen.":
    "Moss 现在可以顺利升级大型本地历史数据，不会再让项目列表一直卡在加载界面。",
  "The activity-sequence backfill now builds one indexed lookup instead of repeatedly scanning the entire event history. A database with more than 180,000 activities completes the recovery in seconds while preserving every project, thread, message, and activity.":
    "活动序列回填改为一次构建索引查询，不再反复遍历完整事件历史。即使数据库包含超过 18 万条活动，也能在数秒内完成恢复，并保留每个项目、对话、消息和活动。",
  "Switch models from the keyboard": "用键盘快捷切换模型",
  "Use Alt+] and Alt+[ to cycle through available models without leaving the conversation.":
    "使用 Alt+] 和 Alt+[ 即可在可用模型间循环切换，无需离开当前对话。",
  "The shortcuts use the active provider's available model options and keep model selection quick during an ongoing workflow.":
    "快捷键会读取当前服务商提供的模型选项，让你在任务进行中也能快速切换模型。",
  "Unfinished task lists stay visible": "未完成的任务列表会继续显示",
  "Task lists now remain in the transcript after a turn completes, making follow-up work easier to resume.":
    "一个轮次结束后，任务列表仍会保留在对话记录中，便于继续后续工作。",
  "Runtime task projections preserve unfinished items after completion while keeping finished and resumed task state consistent.":
    "运行时任务视图会在轮次完成后保留未完成事项，并确保已完成与重新继续的任务状态一致。",
  "File undo leaves chat history intact": "撤销文件变更时保留对话历史",
  "Undoing an agent turn now rolls back its files without deleting the conversation that explains the change.":
    "撤销智能体轮次时只会回滚文件，不会删除用于说明这些改动的对话。",
  "Turn-scoped checkpoints restore workspace state while preserving transcript history and provider conversation state.":
    "按轮次创建的检查点会恢复工作区状态，同时保留对话记录和服务商会话状态。",
  "Smoother cross-platform agent workflows": "跨平台智能体工作流更顺畅",
  "Codex model options, Windows launching, project folder labels, and Git status checks now behave more predictably across platforms.":
    "Codex 模型选项、Windows 启动、项目文件夹标签与 Git 状态检查现在可在不同平台上保持更一致的行为。",
  "Runtime-discovered Codex reasoning efforts map correctly, the Windows CLI path forwards arguments reliably, project picker labels match the host OS, and Git status handles directories outside repositories gracefully.":
    "运行时发现的 Codex 推理强度可正确映射，Windows CLI 路径能可靠转发参数，项目选择器标签会匹配当前操作系统，Git 状态检查也能妥善处理仓库之外的目录。",
  "File changes are calmer to scan": "文件变更列表更清爽易读",
  "File-change headers use a softer visual treatment, keeping active work readable without competing with the diff itself.":
    "文件变更标题采用更柔和的视觉样式，既保持任务信息清晰，也不会抢过差异内容本身的视觉重点。",
  "Moss, all the way through": "从内到外，全面统一为 Moss",
  "The app now uses one identity everywhere, from its desktop installation and command line to packages, settings, diagnostics, and release artifacts.":
    "从桌面安装和命令行，到软件包、设置、诊断与发布产物，应用现在统一使用同一个 Moss 品牌标识。",
  "The desktop bundle, renderer origin, update channel, icons, and visible product surfaces now use the Moss identity. The 0.4.2 bridge preserves renderer state during the origin change.":
    "桌面应用包、渲染器来源、更新通道、图标和所有可见产品界面现已统一为 Moss；0.4.2 过渡版本会在来源切换时保留渲染器状态。",
  "Claude keeps context under control": "Claude 上下文管理更稳健",
  "Claude sessions now report live context usage, warn before compaction, switch model and context settings in place, and resume with their safeguards intact.":
    "Claude 会话现在会实时显示上下文用量、在压缩前预警，并可在会话内切换模型和上下文设置；恢复会话时各项保护机制也会继续生效。",
  "The adapter combines SDK context controls with accumulated token usage, preserves the effective context window across responses, keeps fallback reroutes pinned until you choose another model, and stores resume state without forcing unnecessary provider restarts.":
    "适配器会结合 SDK 上下文控制与累计用量，在多次响应间保持有效上下文窗口；触发保护性切换后会固定备用模型，直到你主动选择其他模型，并在无需重启服务商进程的情况下保存续接状态。",
  "Agent task progress stays visible": "智能体任务进度持续可见",
  "Claude task tools and Codex task events now appear through one shared progress stream, so resumable work is easier to follow while it runs.":
    "Claude 任务工具与 Codex 任务事件现统一显示在同一条进度流中，让可续接任务在运行时更容易追踪。",
  "Claude TaskCreate, TaskUpdate, TaskGet, TaskList, and TodoWrite results are normalized into the shared runtime task list and persisted in the resume cursor. Codex task events and provider summaries use the same projection, with coverage for reconnects and resumed sessions.":
    "Claude 的 TaskCreate、TaskUpdate、TaskGet、TaskList 与 TodoWrite 结果会统一写入共享的运行时任务列表，并保存在续接游标中；Codex 任务事件和服务商摘要也使用同一套任务视图，并覆盖重连与恢复会话场景。",
  "Codex reasoning and streams are easier to trust": "Codex 推理与流式输出更加可靠",
  "Codex reasoning summaries, context compaction, task updates, and noisy app-server output are handled more reliably, keeping live transcripts clearer during long turns.":
    "Codex 推理摘要、上下文压缩、任务更新以及 app-server 的杂项输出现在会被更可靠地处理，让长轮次中的实时对话记录保持清晰。",
  "The app-server bridge now ignores non-protocol stdout safely, preserves provider-authored reasoning summaries, normalizes runtime events, and hardens resume and ingestion paths so progress is not lost between streamed updates.":
    "app-server 桥接层会安全忽略非协议标准输出，保留服务商生成的推理摘要，统一运行时事件，并强化续接与事件接收路径，避免进度在流式更新之间丢失。",
  "Chat startup and recovery are lighter": "对话启动与恢复更加轻量",
  "Chat dock panels load on demand, deleted projects remain safe client tombstones, and browser profile migrations repair database sidecars transactionally instead of leaving partial state behind.":
    "对话停靠面板改为按需加载；已删除项目会保留安全的客户端删除标记；浏览器配置迁移也会以事务方式修复数据库附属文件，不再留下不完整状态。",
  "The chat route measures LCP while deferring secondary panels, while project deletion and desktop profile repair now preserve predictable local state through reloads, retries, and interrupted migrations.":
    "对话路由会在延后加载次要面板的同时测量 LCP；项目删除与桌面配置修复也能在重新加载、重试和迁移中断后保持可预测的本地状态。",
  "Desktop updates have stronger guardrails": "桌面更新增加了更严密的保护",
  "Release automation now validates compatibility-feed manifests and protects the packaged desktop from unsafe bundle swaps across update and startup paths.":
    "发布自动化现在会校验兼容更新源清单，并在更新与启动流程中阻止安装版桌面应用执行不安全的软件包替换。",
  "The release workflow verifies the pinned updater lane, keeps clean releases off the compatibility channel, repairs update-feed metadata, and hardens desktop startup when an app.asar swap is detected.":
    "发布流程会验证固定的更新通道，让正常版本避开兼容通道，修复更新源元数据，并在检测到 app.asar 被替换时加强桌面启动保护。",
  "Moss preserves your workspace across upgrades": "升级 Moss 时完整保留工作区",
  "Launch this version at least once before installing the next Moss release so your drafts, pins, theme, browser state, and other local interface preferences move with you.":
    "安装下一个 Moss 版本前，请至少启动一次当前版本，以便草稿、固定项、主题、浏览器状态和其他本地界面偏好随升级一同迁移。",
  "This bridge writes a validated local snapshot of renderer state, keeps existing project and thread data intact, and prepares database and checkpoint metadata for future desktop-origin upgrades.":
    "该过渡版本会写入经过校验的渲染器状态快照，完整保留现有项目与对话数据，并为后续桌面来源升级准备数据库和检查点元数据。",
  "Claude threads use far fewer tokens and restart less": "Claude 对话用量更低、重启更少",
  "Long Claude conversations now track their 1M-token context window per thread, compact automatically, and switch models without restarting the session — ending runaway usage.":
    "长时间 Claude 对话现在会按对话追踪 100 万 token 上下文窗口，自动压缩，并能在不重启会话的情况下切换模型，避免用量失控。",
  "Each thread tracks its own context window and warns as usage approaches the limit. After a safeguard reroute, the fallback model stays pinned until you explicitly pick another model, and model or context-window changes apply in-session instead of tearing the session down.":
    "每个对话都会独立追踪上下文窗口，并在接近上限时提醒。触发保护性切换后，备用模型会保持选中，直到你主动选择其他模型；模型或上下文窗口变更也会直接在当前会话内生效。",
  "Desktop updates now verify their own installs": "桌面更新会自行验证安装结果",
  "Moss checks that an update actually installed after restart, detects failed installs, and recovers instead of silently staying on the old version.":
    "重启后 Moss 会确认更新是否真正安装成功；若安装失败，会检测并执行恢复，不再悄悄停留在旧版本。",
  "A durable install marker survives restarts and tracks handoff state, an install watchdog recovers from hung installs, and on macOS dedicated diagnostics capture updater state to make failures actionable.":
    "持久化安装标记会跨重启追踪交接状态；安装看护程序可从卡住的安装中恢复；macOS 上的专用诊断还会记录更新器状态，让故障更容易定位和处理。",
  "Studio shortcut and migration fixes": "Studio 快捷键与迁移问题修复",
  "The new-chat keyboard shortcut now routes correctly inside Studio, composer drafts survive the storage migration, and incomplete legacy home imports repair themselves.":
    "新建对话快捷键现在能在 Studio 中正确跳转，编辑器草稿可在存储迁移后保留，未完成的旧版首页导入也会自动修复。",
  "Renderer storage migration is guaranteed to run before app hydration, the legacy environment identity is restored from the bridge marker, and checkpoint metadata is canonicalized while keeping existing persisted refs readable.":
    "渲染器存储迁移会确保在应用状态载入前完成；旧环境标识会从过渡标记中恢复；检查点元数据也会统一规范，同时继续兼容已有的持久化引用。",
  "A dedicated Studio workspace for agent-led work": "面向智能体任务的专属 Studio 工作区",
  "Studio gives long-running, agent-led work its own focused space, keeping it distinct from your regular chats while making it quick to start or revisit.":
    "Studio 为长时间运行的智能体任务提供独立而专注的空间，既与普通对话清楚区分，又能快速开始或返回查看。",
  "Studio projects, threads, routing, sidebar rows, empty-state entry points, and restore behavior now share a clear workspace boundary. The release also hardens cross-kind project ownership so a regular chat and a Studio thread cannot accidentally reuse the same container.":
    "Studio 的项目、对话、路由、侧边栏条目、空状态入口与恢复行为现在遵循清晰的工作区边界；不同类型项目的归属规则也更严格，普通对话和 Studio 对话不会再意外共用同一容器。",
  "Studio outputs are collected where you need them": "Studio 产物集中展示在需要的位置",
  "Files, generated images, and other agent outputs from Studio are surfaced in the Environment panel so finished work is easier to find and open.":
    "Studio 生成的文件、图像和其他智能体产物会显示在“环境”面板中，完成后的成果更容易查找和打开。",
  "The server records Studio output activity and generated-image metadata, then projects it into a dedicated Environment section with resilient display helpers and targeted coverage for output ordering and presentation.":
    "服务器会记录 Studio 产物活动与生成图像的元数据，并将其整理到“环境”面板的专属区域；显示逻辑更加稳健，产物排序与展示也有针对性测试保障。",
  "Starting work in a worktree is more transparent": "在工作树中启动任务的过程更加透明",
  "Project actions now make worktree setup visible, so you can understand what is being prepared before a new workspace-backed thread starts.":
    "项目操作现在会显示工作树准备过程，让你在新的工作区对话开始前清楚了解正在进行的设置。",
  "New setup steps and timeline states expose progress and failure more clearly, while the underlying scaffold path self-heals and keeps project/worktree ownership consistent through retries and restores.":
    "新增的设置步骤和时间线状态会更清楚地展示进度与失败信息；底层初始化流程可自动修复，并在重试和恢复期间保持项目与工作树归属一致。",
  "Returning to a chat or Studio is more reliable": "返回对话或 Studio 更加可靠",
  "Moss is more careful about restoring the right destination after reloads, segment switches, reconnects, and partially completed project creation.":
    "在重新加载、区域切换、重新连接或项目尚未完全创建时，Moss 会更准确地恢复到正确位置。",
  "Routing now prefers canonical containers, waits for snapshot hydration where needed, fails closed on ambiguous thread kinds, and guards against overlapping fresh-chat creation so drafts and active work land in the intended surface.":
    "路由会优先使用标准容器，在需要时等待快照载入；遇到不明确的对话类型会安全停止，并避免重复创建新对话，确保草稿和当前任务落在预期界面。",
  "Live transcripts stay steadier during active work": "任务进行时，对话记录更加稳定",
  "Transcript rendering and active-turn behavior have been refined to keep ongoing agent work easier to follow without needless scroll or layout churn.":
    "对话记录渲染和当前轮次行为经过优化，让进行中的智能体任务更容易跟随，同时减少不必要的滚动与布局跳动。",
  "The session orchestration and timeline paths were refactored with focused coverage for worktree setup, transcript rows, sidebar visibility, and workspace handoffs, preserving predictable behavior as sessions stream and reconnect.":
    "会话编排与时间线流程已重构，并针对工作树设置、对话记录行、侧边栏可见性和工作区交接增加测试，确保会话在流式输出与重连时行为稳定。",
  "Safer provider startup and Windows launching": "服务商启动与 Windows 拉起更安全",
  "Authentication preparation and provider launch handling are more robust, including a fix for launching Codex on Windows.":
    "认证准备和服务商启动处理更加稳健，同时修复了在 Windows 上启动 Codex 的问题。",
  "The release prepares the Codex auth overlay before dependent startup paths run, hardens process environment handling, and includes the Windows launcher repair alongside broader orchestration and projection reliability work.":
    "依赖启动流程运行前会先准备 Codex 认证覆盖配置，并加强进程环境处理；本次还包含 Windows 启动器修复，以及更广泛的编排与状态视图可靠性改进。",
  "Prompt history keeps drafts and attachments together": "提示词历史会连同草稿附件一起保留",
  "Browsing your previous prompts no longer strips the attachments from the draft you are building, so history navigation is safer for image- and file-heavy follow-ups.":
    "浏览以往提示词时，不会再移除当前草稿中的附件；对于包含大量图片或文件的后续任务，历史导航更加安全。",
  "Composer draft history now preserves attachment state while you move through previous prompts, resets stale navigation state more carefully, and avoids duplicate optimistic history entries after sends.":
    "在历史提示词间切换时，编辑器草稿会保留附件状态，并更谨慎地重置过期的导航状态；发送后也不会重复写入临时历史记录。",
  "Pull request context is clearer in the Environment panel": "“环境”面板中的拉取请求上下文更清晰",
  "Threads attached to GitHub pull requests now surface richer PR context, including merged-state handling and more readable review/check previews.":
    "关联 GitHub 拉取请求的对话现在会展示更丰富的 PR 上下文，包括已合并状态，以及更易读的审阅与检查预览。",
  "The PR snapshot path now captures pull request data for the Environment panel, handles merged PRs more predictably, trims long review previews, dedupes GitHub field requests, and tightens merge-head formatting.":
    "PR 快照流程会为“环境”面板采集拉取请求数据，更稳定地处理已合并 PR，缩短过长的审阅预览，合并重复的 GitHub 字段请求，并优化合并提交头的格式。",
  "Claude rate limits fail more gracefully": "Claude 用量限制提示更加友好",
  "When Claude reports usage or rate-limit trouble, Moss now presents the condition more calmly instead of turning it into a generic provider failure.":
    "Claude 报告用量或速率限制问题时，Moss 会平和、明确地展示当前状态，不再将其笼统归为服务商故障。",
  "Provider usage handling now narrows usage summary types more safely and treats Claude usage limit responses as a recoverable, user-facing state with focused parser and resilience coverage.":
    "服务商用量处理会更安全地识别摘要类型，并将 Claude 用量限制响应作为可恢复、面向用户的状态处理，同时通过专项解析与稳定性测试保障。",
  "Desktop restarts handle broken stderr pipes": "桌面重启可妥善处理中断的 stderr 管道",
  "The desktop app is less likely to crash or get noisy when a restarted child process loses its stderr pipe during shutdown or relaunch.":
    "子进程在关闭或重新拉起时丢失 stderr 管道，也不易再导致桌面应用崩溃或产生大量无效日志。",
  "Desktop process restart handling now tolerates broken stderr writes, including the EPIPE path that could appear while the app was restarting provider or server processes.":
    "桌面进程重启逻辑现在可容忍 stderr 写入中断，包括应用重启服务商或服务器进程时可能出现的 EPIPE 情况。",
  "Small reliability fixes across agents and PR flows": "智能体与 PR 流程的多项稳定性修复",
  "This release rounds off recent agent-session and pull-request work with tighter assertions, safer formatting, and cleaner edge-case behavior.":
    "本次通过更严格的断言、更安全的格式化和更清晰的边界处理，完善近期的智能体会话与拉取请求功能。",
  "The release includes automation migration lineage assertion fixes, PR snapshot review follow-up fixes, provider usage type narrowing, and general cleanup from the prompt-history and PR environment-panel review loops.":
    "本次包含自动化迁移链路断言修复、PR 快照审阅后续修复、服务商用量类型收窄，以及提示词历史与 PR 环境面板审阅中发现的常规清理项。",
  "Export a thread as a ZIP": "将对话导出为 ZIP",
  "Type `/export` in a saved, idle chat to download a portable archive with the full thread projection and a readable Markdown transcript.":
    "在已保存且空闲的对话中输入 `/export`，即可下载便携式归档，其中包含完整的对话状态映射和易读的 Markdown 对话记录。",
  "The export route streams `thread.json` and `transcript.md` through the server with shared eligibility checks, desktop-friendly CORS/error handling, large-thread history hydration, and browser download support from both typed slash commands and the command menu.":
    "导出路由通过服务器以流式方式传输 `thread.json` 和 `transcript.md`，统一执行导出资格检查，提供适合桌面端的 CORS 与错误处理、长对话历史状态载入，并支持通过斜杠命令和命令菜单在浏览器中下载。",
  "Archived stats survive cleanup": "清理后仍保留历史统计",
  "Deleting or purging old threads no longer erases their lifetime contribution to profile stats, so cleanup keeps your usage history intact.":
    "删除或清除旧对话不再抹去它们对个人资料累计统计的贡献，因此清理数据也能完整保留使用历史。",
  "Thread deletion now snapshots profile aggregates before purging rows, merges archived stats back into profile queries, preserves command receipts, cleans checkpoint refs carefully, and includes a migration plus purge/retention regression coverage.":
    "删除对话时会先保存个人资料汇总数据，再清除相关数据行；个人资料查询会合并已归档的统计数据，同时保留命令回执、谨慎清理 checkpoint 引用，并加入数据迁移以及清除与保留策略的回归测试。",
  "Active turns show steady work timing": "进行中的轮次稳定显示耗时",
  "While an agent is working, the transcript now keeps a stable 'Working for' header at the top of the active turn instead of relying only on a transient shimmer row.":
    "智能体工作时，对话记录会在当前轮次顶部持续显示稳定的“已工作”标题，不再只依赖短暂的微光提示行。",
  "MessagesTimeline now inserts a stable active-turn header for duration display while preserving the existing setup shimmer, making live turns easier to scan and less jumpy during layout updates.":
    "MessagesTimeline 现在会为当前轮次插入稳定的耗时标题，同时保留现有的准备阶段微光提示，让实时轮次更易浏览，并减少布局更新时的跳动。",
  "Terminal shutdown is more reliable": "终端关闭更可靠",
  "Moss is better at shutting down stubborn terminal process trees without returning early while child processes are still alive.":
    "Moss 现在能更可靠地关闭顽固的终端进程树，不会在子进程仍存活时提前返回。",
  "TerminalManager now routes shutdown through a dedicated process-tree killer with SIGTERM-to-SIGKILL escalation, cancellation when processes exit cleanly, nested process activity coverage, and tests for disposal timing.":
    "TerminalManager 现在通过专用的进程树终止器执行关闭操作，支持从 SIGTERM 升级到 SIGKILL、进程正常退出时取消后续操作，并覆盖嵌套进程活动以及释放时序测试。",
  "Resumed ACP replies stay distinct": "恢复后的 ACP 回复不再混淆",
  "ACP-backed sessions are less likely to lose assistant replies after a restart or resume because fallback assistant message IDs no longer collide across runtime instances.":
    "基于 ACP 的会话在重启或恢复后更不容易丢失智能体回复，因为备用的智能体消息 ID 不再跨运行时实例冲突。",
  "A per-runtime instance ID is included in fallback ACP assistant item IDs, preventing resumed sessions with the same provider session ID and segment index from overwriting earlier transcript messages.":
    "备用 ACP 智能体项目 ID 现在包含每个运行时的实例 ID，避免恢复会话时，相同服务商会话 ID 和分段索引覆盖较早的对话记录消息。",
  "Git writing respects OpenCode and Kilo models": "Git 文案生成遵循 OpenCode 和 Kilo 模型设置",
  "Git commit, diff summary, and PR text generation now honor runtime-discovered OpenCode and Kilo model selections from Settings.":
    "Git 提交信息、差异摘要和 PR 文案生成现在会采用“设置”中由运行时发现的 OpenCode 与 Kilo 模型选项。",
  "Settings now persists discovered Git-writing model options, git actions pass the chosen provider/model through the shared contracts, and query cache keys include the text-generation selection so generated commit/PR text routes to the intended backend.":
    "“设置”现在会持久保存发现的 Git 文案生成模型选项；Git 操作通过共享契约传递所选服务商和模型，查询缓存键也会包含文本生成选项，确保生成的提交与 PR 文案发送到预期后端。",
  "Grok resume handles long sessions more safely": "Grok 可更安全地恢复长会话",
  "Grok and other ACP-backed sessions are better at resuming after compaction or reconnects without replaying messages into the wrong runtime or growing memory unexpectedly.":
    "Grok 及其他基于 ACP 的会话在压缩或重新连接后能更可靠地恢复，避免将消息重放到错误的运行时或导致内存意外增长。",
  "ACP resume now drops replay before the event consumer is attached, seeds compaction quiet windows from response timing, hardens provider/runtime ingestion, and covers JSON-RPC/session-runtime edge cases that previously made resume replay fragile.":
    "ACP 恢复现在会在事件消费者挂载前丢弃重放内容，根据响应时序设定压缩静默窗口，增强服务商与运行时的数据接收处理，并覆盖此前容易导致恢复重放不稳定的 JSON-RPC 和会话运行时边界情况。",
  "Worktree setup failures recover cleanly": "工作树设置失败后可顺利恢复",
  "When a worktree setup step fails, Moss now shows the failed setup state, keeps the timeline from looking stuck, and resets the local dispatch when you send again.":
    "工作树设置步骤失败时，Moss 现在会显示失败状态，避免时间线看起来卡住，并在你再次发送时重置本地分发状态。",
  "ChatView and timeline setup snapshots now carry explicit setup step status, targeted cleanup for failed local dispatches, and focused browser/unit coverage for new-turn reset and setup rows.":
    "ChatView 和时间线设置快照现在会携带明确的设置步骤状态，针对失败的本地分发执行清理，并通过专项浏览器与单元测试覆盖新轮次重置和设置行。",
  "Automation messages are labeled": "自动化消息现有明确标识",
  "Prompts sent by an automation now carry a lightweight 'Sent via Automation' label above the bubble, so you can tell at a glance which turns you typed and which a scheduled or heartbeat run kicked off.":
    "自动化任务发送的提示词现在会在气泡上方显示轻量的“由自动化发送”标签，让你一眼分辨哪些轮次由你输入，哪些由定时任务或心跳运行触发。",
  "User turns dispatched by the automation engine now persist a `dispatchOrigin` on the message end to end (command → event → projection → snapshot), and the transcript renders a clock-marked chip that mirrors the existing steering label.":
    "自动化引擎分发的用户轮次现在会在消息全链路中持久保留 `dispatchOrigin`（命令 → 事件 → 状态映射 → 快照），对话记录则会显示带时钟图标的标签，与现有的引导标签保持一致。",
  "Approval prompts are easier to answer": "审批提示更易操作",
  "Pending approvals now use a clearer shared choice-row layout, with steadier panel behavior and browser coverage for allow/deny decisions.":
    "待处理审批现在采用更清晰的共用选项行布局，面板表现更加稳定，并加入允许与拒绝操作的浏览器测试。",
  "ComposerPendingApprovalPanel now shares ComposerChoiceRow structure with pending inputs, tracks decision actions in browser tests, and trims duplicated action styling.":
    "ComposerPendingApprovalPanel 现在与待处理输入共用 ComposerChoiceRow 结构，通过浏览器测试跟踪决策操作，并精简重复的操作样式。",
  "Startup does less surprise work": "启动时减少意外操作",
  "Moss avoids unnecessary provider refresh work during startup and gates Claude keepalive behavior more carefully, so opening the app is calmer and less likely to fight credential checks.":
    "Moss 启动时会避免不必要的服务商刷新，并更谨慎地控制 Claude 保活行为，让应用打开过程更稳定，也更少干扰凭据检查。",
  "Server startup no longer runs provider refresh eagerly, Claude keepalive respects auth-state timing, provider usage hooks handle inactive summaries more predictably, and related settings/server query invalidation paths have tests.":
    "服务器启动时不再立即刷新服务商；Claude 保活会遵循认证状态的时序，服务商用量 hooks 能更可预测地处理非活动摘要，相关设置与服务器查询缓存失效路径也已加入测试。",
  "Folded work rows report time more accurately": "折叠工作行的耗时更准确",
  "Collapsed transcript segments now show a 'Worked for' duration that spans the whole folded section, not just a single row inside it.":
    "折叠后的对话记录片段现在会显示覆盖整个折叠区段的“工作耗时”，而非只计算其中某一行。",
  "Timeline duration grouping now tracks folded row boundaries and tests the aggregate timing behavior so compact transcripts better match what actually happened.":
    "时间线耗时分组现在会跟踪折叠行的边界，并测试汇总计时行为，使紧凑的对话记录更准确地反映实际过程。",
  "Update downloads show their progress": "更新下载会显示进度",
  "When Moss is downloading a desktop update, the sidebar update button now shows a live percent badge so you can tell whether it is moving or nearly ready.":
    "Moss 下载桌面端更新时，侧边栏的更新按钮现在会实时显示百分比徽标，方便判断下载是否在推进或即将完成。",
  "The desktop update helper now clamps reported download percentages, hides them outside active downloads, and covers edge cases for null, negative, oversized, and fractional progress values.":
    "桌面端更新辅助模块现在会将上报的下载百分比限制在有效范围内，在非下载状态下隐藏进度，并覆盖 null、负数、超出范围及小数进度值等边界情况。",
  "Claude auth checks are less jumpy": "Claude 认证检查更加稳定",
  "Claude sessions are less likely to be marked logged out during refresh-token races, especially when health checks and the macOS credential keepalive run near the same time.":
    "Claude 会话在刷新 token 竞争期间更不容易被误判为已退出，尤其是健康检查与 macOS 凭据保活几乎同时运行时。",
  "`claude auth status` is now serialized through a shared lock, retried once for structured false negatives, and can fall back to verified local credential metadata before showing an unauthenticated state.":
    "`claude auth status` 现在通过共享锁串行执行；遇到结构化的误判结果时会重试一次，并可在显示未认证状态前回退检查已验证的本地凭据元数据。",
  "Turn checkpoints are harder to confuse": "轮次 checkpoint 更不易混淆",
  "Moss preserves the first pre-turn snapshot more carefully, so transcript diffs and restore points better match what was on disk when you pressed send.":
    "Moss 会更谨慎地保留轮次开始前的首个快照，使对话记录差异和还原点更贴近按下发送时的磁盘内容。",
  "Checkpoint capture now has single-flight behavior per repo/ref, a bounded capture timeout, first-writer-wins `skipIfExists` baselines, and extra recovery when a startup or backup path missed the original message baseline.":
    "现在每个仓库与引用的 checkpoint 捕获都采用 single-flight 机制，设置有界的捕获超时，并使用先写入者生效的 `skipIfExists` 基线；当启动或备份路径遗漏原始消息基线时，也会执行额外恢复。",
  "The sidebar chat list behaves more naturally": "侧边栏对话列表更自然",
  "The Chats section now lives with the rest of the scrollable sidebar content, has a familiar disclosure chevron, and keeps the footer focused on account/update controls.":
    "“对话”区域现在与侧边栏其余可滚动内容放在一起，使用熟悉的展开箭头，并让底部区域专注于账户和更新控件。",
  "Sidebar chat collapse state now exposes `aria-expanded`, reuses the shared disclosure chevron, and separates chat rows from the footer while preserving sort and new-chat actions.":
    "侧边栏的对话折叠状态现在会公开 `aria-expanded`，复用共享的展开箭头，并将对话行与底部区域分开，同时保留排序和新建对话操作。",
  "First sends keep the workspace calm": "首次发送时工作区保持稳定",
  "Starting from an empty chat no longer opens the Environment panel by surprise after the first message turns the landing view into a transcript.":
    "从空白对话开始时，首条消息将落地页切换为对话记录后，不会再意外打开“环境”面板。",
  "ChatView now records a closed environment-panel preference when sending from the centered empty landing, preventing the default-open policy from popping the panel into a just-started conversation.":
    "从居中的空白落地页发送消息时，ChatView 现在会记录“环境”面板已关闭的偏好，避免默认开启策略让面板突然出现在刚开始的对话中。",
  "Provider health parsing is easier to trust": "服务商健康状态解析更可信",
  "Provider CLI output handling and Claude auth interpretation now have clearer, isolated parsing paths with more focused tests around failure and metadata cases.":
    "服务商 CLI 输出处理和 Claude 认证结果解释现在采用更清晰、相互隔离的解析路径，并针对失败及元数据情况提供更聚焦的测试。",
  "Generic CLI-output helpers moved out of ProviderHealth, Claude auth parsing moved into a pure module, and new tests cover auth JSON markers, credential summaries, the auth-status lock, checkpoint single-flight behavior, and provider health edge cases.":
    "通用 CLI 输出辅助函数已从 ProviderHealth 移出，Claude 认证解析也已迁移到纯函数模块；新增测试覆盖认证 JSON 标记、凭据摘要、认证状态锁、checkpoint single-flight 行为及服务商健康状态边界情况。",
  "Cursor launch fallback is much sturdier": "Cursor 启动回退机制更加可靠",
  "Moss now finds Cursor agent commands across more install layouts, including bundled sibling shims and legacy shim locations, while rejecting unsafe fallbacks.":
    "Moss 现在能在更多安装布局中找到 Cursor 智能体命令，包括随应用提供的同级 shim 和旧版 shim 位置，同时拒绝不安全的回退路径。",
  "Cursor ACP command discovery now resolves safer CLI paths, honors bundled sibling launchers, preserves legacy shim coverage, and avoids falling back to paths that do not match the expected Cursor agent shape.":
    "Cursor ACP 命令发现现在会解析更安全的 CLI 路径，支持随应用提供的同级启动器，保留旧版 shim 覆盖，并避免回退到不符合预期 Cursor 智能体结构的路径。",
  "Muxy can open from Moss": "可从 Moss 打开 Muxy",
  "Open-in support now recognizes Muxy, so editor/open buttons can hand files to the right desktop target when Muxy is part of your workflow.":
    "“打开方式”现已支持 Muxy，因此当工作流程中使用 Muxy 时，编辑器与打开按钮能将文件交给正确的桌面端应用。",
  "Editor metadata, open-route handling, and focused coverage were extended so Muxy is treated as a supported external app alongside the existing editor launch targets.":
    "编辑器元数据、打开路由处理及专项测试均已扩展，使 Muxy 与现有编辑器启动目标一样，成为受支持的外部应用。",
  "Live chats leave a clearer message trail": "实时对话的消息轨迹更清晰",
  "Active replies now expose a calmer live trail through the transcript, making long-running turns easier to follow while new work arrives.":
    "进行中的回复现在会在对话记录中显示更稳定的实时轨迹，让长时间运行的轮次在新内容不断到达时更容易跟进。",
  "The transcript gained MessageTrail rendering, shared message-trail logic, browser coverage, and timeline integration so live assistant activity can stay visible without fighting the normal message rows.":
    "对话记录新增 MessageTrail 渲染和共享消息轨迹逻辑，并加入浏览器测试及时间线集成，使智能体的实时活动保持可见，同时不干扰常规消息行。",
  "Image sharing works better on desktop": "桌面端图片分享体验更好",
  "Share cards and exported profile visuals can now use the desktop clipboard image path, making it easier to paste polished snapshots elsewhere.":
    "分享卡片和导出的个人资料图片现在可使用桌面端剪贴板图片通道，更方便将精美快照粘贴到其他位置。",
  "The web share-card export path now cooperates with desktop clipboard IPC, including preload contracts and browser-side helpers for copying generated image blobs.":
    "网页端分享卡片导出流程现在可配合桌面端剪贴板 IPC 使用，包括 preload 契约以及用于复制生成图片 blob 的浏览器端辅助函数。",
  "Claude credentials stay fresh longer": "Claude 凭据可更久保持有效",
  "Moss refreshes Claude credential freshness on macOS so long sessions are less likely to hit the familiar stale-token sign-in failure.":
    "Moss 会在 macOS 上维持 Claude 凭据的有效状态，降低长会话遇到常见的 token 过期登录失败问题的概率。",
  "A Claude credential keepalive helper, adapter integration, and focused tests now keep the OAuth token file active enough to avoid the roughly eight-hour stale credential path.":
    "新增 Claude 凭据保活辅助模块、适配器集成及专项测试，使 OAuth token 文件保持足够活跃，避免大约八小时后出现凭据失效的问题。",
  "Models, command rows, and status icons got a polish pass": "模型、命令行和状态图标全面优化",
  "Sonnet 5 variants, sidebar status icons, branded command rows, chat bubble padding, and tool labels were tightened for a more readable daily workspace.":
    "Sonnet 5 变体、侧边栏状态图标、品牌化命令行、对话气泡内边距和工具标签均已优化，让日常工作区更易读。",
  "The release adds Sonnet 5 model variant metadata, refines sidebar status presentation, brands command/tool rows more clearly, and trims chat typography spacing in dense transcript areas.":
    "此版本新增 Sonnet 5 模型变体元数据，优化侧边栏状态呈现，强化命令行与工具行的品牌辨识度，并收紧密集对话记录区域的文字间距。",
  "Temporary chats graduate more naturally": "临时对话更自然地转为正式对话",
  "Draft and temporary threads now promote into the main chat flow more predictably, with clearer naming and steadier routing once work becomes real.":
    "草稿和临时对话现在能更稳定地进入主聊天流程；当工作转为正式任务后，命名更清晰，路由也更稳定。",
  "Disposable-thread helpers were renamed around temporary-thread behavior, ChatView and sidebar state now share the promotion path, and timeline coverage guards the new handoff from temporary work into durable chat rows.":
    "一次性对话相关辅助函数已按临时对话行为重新命名；ChatView 与侧边栏状态现在共用同一套转正式流程，并通过时间线测试保障临时工作顺利交接为持久聊天行。",
  "Archived chats are easier to recover": "已归档对话更容易恢复",
  "Archive actions now use an undo toast instead of an interrupting confirmation dialog, so cleaning up threads is faster while still giving you a quick escape hatch.":
    "归档操作现在使用可撤销的提示消息，不再弹出打断操作的确认对话框，让整理对话更快捷，同时保留快速撤销的机会。",
  "The sidebar archive flow, shared toast primitive, settings surfaces, environment panel hints, and threadArchive helper now cooperate around immediate archive plus undo behavior.":
    "侧边栏归档流程、共享提示基础组件、设置界面、环境面板提示和 threadArchive 辅助函数现已协同支持立即归档与撤销。",
  "Pending inputs and work rows feel calmer": "待处理输入和工作行更稳定",
  "User-input prompts, queued composer state, work rows, tool details, markdown spacing, and composer preview surfaces were tightened so active sessions scan better.":
    "用户输入提示、排队中的输入框状态、工作行、工具详情、Markdown 间距和输入框预览界面均得到收紧优化，让活跃会话更易浏览。",
  "Composer pending-input panels now float more cleanly in the stack, queued headers and work rows have focused coverage, and shared rendering helpers reduce small inconsistencies across tool and diff displays.":
    "输入框的待处理输入面板现在能更清爽地浮于内容堆栈中；排队状态标题和工作行获得了针对性测试，共享渲染辅助函数也减少了工具与差异视图之间的细微不一致。",
  "macOS icon refreshes after app updates": "应用更新后会刷新 macOS 图标",
  "The desktop app now refreshes macOS icon caches on startup/update paths so Dock and Finder icons are less likely to stay stale after an icon change.":
    "桌面应用现在会在启动和更新流程中刷新 macOS 图标缓存，降低图标变更后 Dock 与 Finder 仍显示旧图标的概率。",
  "A dedicated macOS icon-cache refresh helper was added to the desktop main process with coverage for the app-support marker, cache invalidation command, and platform gating.":
    "桌面端主进程新增了专用的 macOS 图标缓存刷新辅助函数，并覆盖应用支持目录标记、缓存失效命令和平台限制测试。",
  "Settings, heatmaps, and labels got a tidy pass": "设置、热力图和标签更加整洁",
  "The settings route, activity heatmap export, share cards, model/traits pickers, sidebar labels, and dark-mode composer border all received small polish fixes.":
    "设置路由、活动热力图导出、分享卡片、模型与特征选择器、侧边栏标签以及深色模式下的输入框边框均获得了细节优化。",
  "This release cleans up settings panel primitives, aligns heatmap and diff-rendering helpers, restores a dark-mode composer input border, simplifies repeated labels, and trims a handful of dense UI edges.":
    "此版本整理了设置面板基础组件，统一热力图与差异渲染辅助函数，恢复深色模式下的输入框边框，精简重复标签，并改善了若干过于拥挤的界面细节。",
  "Assistant streaming is on by default": "默认启用智能体回复流式输出",
  "New installs now start with assistant streaming enabled, so replies feel live immediately without needing a settings pass first.":
    "新安装现在默认启用智能体回复流式输出，无需先调整设置，即可立即看到实时生成的回复。",
  "The default app settings and shared settings schema now agree on streamed assistant output, keeping fresh web and server state aligned.":
    "默认应用设置与共享设置 schema 现已统一采用智能体回复流式输出，确保新建的 Web 端与服务端状态保持一致。",
  "Live transcript follow feels smoother": "实时对话记录跟随更顺畅",
  "Streaming replies, optimistic sends, tool details, and message entry animations now keep the transcript pinned more predictably while work is active.":
    "流式回复、乐观发送、工具详情和消息入场动画现在能在工作进行时更稳定地让对话记录保持在底部。",
  "ChatView, ChatTranscriptPane, MessagesTimeline, smooth streamed text, and browser regression coverage were tightened so live assistant text and tool rows do not fight the scroll position.":
    "ChatView、ChatTranscriptPane、MessagesTimeline、流畅流式文本和浏览器回归测试均得到强化，避免实时智能体文本与工具行争抢滚动位置。",
  "Provider health handles more real-world CLI states": "服务商健康检查可应对更多真实 CLI 状态",
  "Claude, Cursor, and OpenCode status checks are sturdier around credentials, headless environments, model probes, and transient command failures.":
    "Claude、Cursor 和 OpenCode 的状态检查现在能更稳健地处理凭据、无界面环境、模型探测及临时命令失败。",
  "Provider health now detects usable local Claude CLI credentials before passing process env through, runs Cursor ACP probes with a safer headless env, handles model-probe failures without marking an authenticated provider unusable, and expands focused provider-health coverage.":
    "服务商健康检查现在会先确认本地 Claude CLI 凭据可用，再传递进程环境变量；Cursor ACP 探测会使用更安全的无界面环境；模型探测失败时，不再将已认证服务商标记为不可用；同时扩充了针对性的服务商健康检查测试。",
  "OpenCode retry warnings are easier to follow": "OpenCode 重试警告更易理解",
  "Retry warnings from OpenCode now stay in the work-log flow and collapse consistently across turns instead of cluttering the main conversation.":
    "OpenCode 的重试警告现在会保留在工作日志流程中，并能跨轮次一致折叠，不再干扰主对话。",
  "Provider runtime ingestion and session logic now preserve OpenCode retry-warning metadata, keep it attached to work rows, and cover repeated warning behavior in both server and web tests.":
    "服务商运行时事件接入与会话逻辑现在会保留 OpenCode 重试警告元数据，将其关联到工作行，并在服务端和 Web 端测试中覆盖警告重复出现的行为。",
  "Tool rows and agent markers are cleaner": "工具行和智能体标记更清爽",
  "Agent mentions, task rows, tool labels, file-change rows, chat seams, and switches received a small polish pass that makes dense chats easier to scan.":
    "智能体提及、任务行、工具标签、文件变更行、聊天衔接处和开关获得了细节优化，让信息密集的聊天更易浏览。",
  "Moss now reuses the central robot glyph for agent chips, improves file-change and tool-call labels, refines chat card contrast, and tightens shared switch sizing, thumb travel, and animation.":
    "Moss 现在为智能体标签复用中央机器人图标，改进文件变更与工具调用标签，优化聊天卡片对比度，并统一收紧共享开关的尺寸、滑块行程和动画。",
  "Release gates tightened browser and provider tests": "发布检查强化了浏览器与服务商测试",
  "The v0.3.4 deep release pass fixed exact-optional type drift in transcript browser coverage and provider health checks before publishing.":
    "v0.3.4 深度发布检查在发布前修复了对话记录浏览器测试和服务商健康检查中的精确可选类型偏差。",
  "The release pass corrected a browser `scrollTo` test helper so it no longer passes explicit `undefined` optional fields, fixed a Claude health env call the same way, and updated a ProviderHealth test to use the Effect platform error tag supported by this workspace.":
    "此次发布检查修正了浏览器 `scrollTo` 测试辅助函数，使其不再显式传入值为 `undefined` 的可选字段；以相同方式修复了 Claude 健康检查的环境调用，并更新 ProviderHealth 测试，使其采用当前工作区支持的 Effect 平台错误标签。",
  "VS Code from the Microsoft Store opens correctly on Windows":
    "Windows 上可正确打开 Microsoft Store 版 VS Code",
  "Moss can now launch VS Code Store installs through the right Windows app identity and URI fallback, so editor buttons work even when the normal `code` command is unavailable.":
    "Moss 现在能通过正确的 Windows 应用标识和 URI 回退方式启动 Microsoft Store 版 VS Code，即使常规 `code` 命令不可用，编辑器按钮也能正常工作。",
  "Editor launch discovery now understands Windows packaged app metadata, adds VS Code and VS Code Insiders Store coverage, falls back from command launch to URI activation, and keeps file-manager launches isolated from editor-specific behavior.":
    "编辑器启动发现逻辑现在支持 Windows 打包应用元数据，新增 VS Code 与 VS Code Insiders 商店版测试覆盖，可在命令启动失败后回退到 URI 激活，并确保文件管理器启动逻辑不受编辑器专用行为影响。",
  "Provider update checks are now optional": "服务商更新检查现在可关闭",
  "A new settings toggle lets you disable provider update checks when you want Moss to stay quieter about external CLI versions.":
    "设置中新增开关；如果你不希望 Moss 提示外部 CLI 版本，可以关闭服务商更新检查。",
  "Provider health, server settings, app settings migration, settings search, root notifications, and provider update filtering now share the same `enableProviderUpdateChecks` flag so background update notices respect the user's preference.":
    "服务商健康检查、服务端设置、应用设置迁移、设置搜索、根级通知和服务商更新筛选现在共用 `enableProviderUpdateChecks` 标志，让后台更新通知遵循用户偏好。",
  "The app icon and Moss mark look cleaner": "应用图标和 Moss 标志更清晰",
  "The desktop, web, marketing, and release assets were refreshed so the Moss icon renders more consistently across macOS, Windows, browser favicons, and update artifacts.":
    "桌面端、Web 端、营销页面和发布资源均已更新，使 Moss 图标在 macOS、Windows、浏览器 favicon 和更新产物中的呈现更加一致。",
  "This release refreshes the inline Moss logo path, replaces generated icon assets from the full source image, corrects macOS bundle icon handling after the rounded-icon Ventura pass, and removes a literal Dock-icon workaround that was not the final direction.":
    "此版本更新了内嵌 Moss 标志路径，使用完整源图重新生成图标资源，修正 Ventura 圆角图标调整后的 macOS 应用包图标处理，并移除了并非最终方案的 Dock 图标硬编码变通处理。",
  "Workspace browsing feels more unified": "工作区浏览体验更加统一",
  "Workspace explorer navigation, file-row presentation, diff stat labels, and shortcut settings now use more shared behavior, making file browsing and review surfaces easier to scan.":
    "工作区资源管理器导航、文件行样式、差异统计标签和快捷键设置现在复用了更多共享行为，让文件浏览与审阅界面更易浏览。",
  "Explorer keyboard navigation moved into shared logic with coverage, DockExplorerPane and workspaceExplorer were simplified, keyboard shortcut settings gained a clearer panel, and file/diff row styling now lines up with the rest of the workspace UI.":
    "资源管理器键盘导航已迁移至共享逻辑并添加测试；DockExplorerPane 与 workspaceExplorer 得到简化；键盘快捷键设置新增更清晰的面板；文件与差异行样式也与工作区其他界面保持一致。",
  "Idle server polling is lighter": "空闲时服务端轮询更轻量",
  "Moss polls local server state less aggressively while idle, reducing background work without changing the active-session refresh path.":
    "Moss 在空闲时会降低本地服务端状态的轮询频率，减少后台工作，同时不改变活跃会话的刷新流程。",
  "The server React Query helper now separates active and idle refresh intervals, the sidebar uses the calmer idle cadence, and focused tests cover the interval behavior.":
    "服务端 React Query 辅助函数现在区分活跃与空闲刷新间隔，侧边栏在空闲时采用更稳定的刷新节奏，并通过针对性测试覆盖间隔行为。",
  "Release gates caught a few small compatibility fixes": "发布检查发现并修复了若干小型兼容性问题",
  "The v0.3.3 release pass tightened formatting, settings test coverage, and Effect API compatibility before publishing.":
    "v0.3.3 发布检查在发布前进一步完善了格式、设置测试覆盖和 Effect API 兼容性。",
  "The release check formatted recent Windows editor-launch and desktop artifact code, updated the web settings push fixture for provider update checks, and switched one editor fallback path from `Effect.catchAll` to the Effect API used by this workspace.":
    "此次发布检查格式化了近期的 Windows 编辑器启动与桌面端产物代码，更新了 Web 设置推送测试夹具以覆盖服务商更新检查，并将一处编辑器回退路径从 `Effect.catchAll` 改为当前工作区采用的 Effect API。",
  "Project switching moved closer to your branch work": "项目切换与分支工作衔接更紧密",
  "The branch toolbar can now show and change the active project, so project, branch, and worktree context are easier to keep aligned while you move around Moss.":
    "分支工具栏现在可以显示和切换当前项目，让你在 Moss 中移动时更容易保持项目、分支和工作树上下文一致。",
  "This release teaches the branch toolbar about project selection, shared home-chat containers, draft-thread mapping, project creation recovery, and project picker state so navigation does not depend only on the sidebar.":
    "此版本为分支工具栏加入项目选择能力，并完善共享主聊天容器、草稿对话映射、项目创建恢复和项目选择器状态，让导航不再仅依赖侧边栏。",
  "Local previews can open more real files": "本地预览可打开更多实际文件",
  "Absolute local file paths now get preview grants, making image, PDF, and workspace previews more reliable when agent output points at files on disk.":
    "绝对本地文件路径现在可以获得预览授权；当智能体输出指向磁盘文件时，图片、PDF 和工作区预览会更可靠。",
  "The server now grants and validates local preview access more carefully, including trusted-origin checks, local image route coverage, workspace file-system normalization, and web-side preview/download handling for absolute paths.":
    "服务端现在会更谨慎地授予和验证本地预览访问权限，包括可信来源检查、本地图片路由测试、工作区文件系统路径规范化，以及 Web 端对绝对路径的预览与下载处理。",
  "Review diffs have a collapsible file tree": "审阅差异新增可折叠文件树",
  "The diff panel now has a review file tree, giving larger review batches a clearer outline before you dive into individual patches.":
    "差异面板现在提供审阅文件树，可在查看各个补丁前，为较大的审阅批次呈现更清晰的结构。",
  "Moss now builds file diff trees, renders a collapsible review panel with shared disclosure motion, and reuses file-row styling so review navigation feels closer to the rest of the workspace.":
    "Moss 现在会构建文件差异树，使用共享展开收起动效渲染可折叠审阅面板，并复用文件行样式，让审阅导航更贴近工作区其他界面。",
  "The workspace explorer is tidier": "工作区资源管理器更加整洁",
  "The right-side workspace explorer and preview header were split into cleaner pieces, reducing composer chrome churn and making file browsing steadier.":
    "右侧工作区资源管理器与预览标题栏已拆分为更清晰的组件，减少输入框界面频繁变化，让文件浏览更稳定。",
  "Workspace browsing now lives behind a reusable dock explorer pane and workspace explorer helpers, with tighter right-dock activation metadata, preview header behavior, and composer measurement boundaries.":
    "工作区浏览现在由可复用的 Dock 资源管理器面板和工作区资源管理器辅助函数承载，并收紧了右侧 Dock 激活元数据、预览标题栏行为及输入框测量边界。",
  "Send actions check provider readiness first": "发送操作会先检查服务商就绪状态",
  "Starting a chat, Kanban task, or handoff now refreshes provider availability before sending and returns focus to the composer more consistently.":
    "开始聊天、提交看板任务或执行交接前，现在会刷新服务商可用性；发送后也能更稳定地将焦点返回输入框。",
  "Provider availability refresh has dedicated helpers and coverage, while ChatView, Kanban submit flows, thread handoff, and route startup paths now share more predictable send-readiness behavior.":
    "服务商可用性刷新现已拥有专用辅助函数和测试；ChatView、看板提交流程、对话交接及路由启动路径也共用更可预测的发送就绪逻辑。",
  "Explorer icons and working states feel more coherent": "资源管理器图标和工作状态更加协调",
  "File explorer icons, working shimmers, route inset surfaces, composer pickers, and sidebar details received a focused visual cleanup pass.":
    "文件资源管理器图标、工作中微光效果、路由内嵌界面、输入框选择器和侧边栏细节获得了一轮集中视觉优化。",
  "This release unifies more icon choices through central icon helpers, refines shimmer styling, tightens compact route surfaces, and keeps repeated explorer/sidebar affordances closer to the same visual language.":
    "此版本通过中央图标辅助函数统一了更多图标选择，优化微光样式，收紧紧凑型路由界面，并让资源管理器与侧边栏中重复出现的交互元素采用更一致的视觉语言。",
  "Long sessions keep their footing better": "长时间会话更加稳健",
  "Transcript scrolling, session state, sidebar routing, and draft equality checks were refactored so active work stays calmer across thread and project changes.":
    "对话记录滚动、会话状态、侧边栏路由和草稿相等性检查均已重构，让活跃工作在对话与项目切换期间保持更稳定。",
  "ChatView now separates more browser-specific behavior, route inset layout has focused coverage, draft-thread comparisons are stricter, and project/chat container helpers handle exact optional state more safely.":
    "ChatView 现在进一步分离浏览器专用行为；路由内嵌布局新增针对性测试；草稿对话比较更加严格；项目与聊天容器辅助函数也能更安全地处理精确可选状态。",
  "Tool calls are easier to inspect": "工具调用更易检查",
  "Transcript tool calls now expose clearer detail dialogs for shell commands, patches, file changes, and tool output, so review-heavy chats are easier to audit.":
    "对话记录中的工具调用现在会为 shell 命令、补丁、文件变更和工具输出提供更清晰的详情对话框，让需要大量审阅的聊天更易核查。",
  "Moss now formats tool command transcripts, normalizes patch/change output, labels more tool kinds consistently, preserves structured work metadata through the timeline, and adds focused coverage for tool-call labels and formatting.":
    "Moss 现在会格式化工具命令记录、规范补丁与变更输出、统一更多工具类型的标签、在时间线中保留结构化工作元数据，并新增针对工具调用标签和格式的专项测试。",
  "Long chats stay calmer while work is running": "长对话在工作期间更稳定",
  "Transcript grouping and scroll behavior were refined so live assistant text, collapsed work rows, sidechat panes, and tool-only activity behave more predictably.":
    "对话记录的分组与滚动行为经过优化，让实时智能体文本、折叠的工作行、侧边聊天窗格及仅含工具的活动表现得更可预测。",
  "This release tightens message timeline derivation, keeps real assistant text separate from tool/work rows, improves collapsed-turn signatures, preserves assistant selection actions, and adds focused tests for timeline rows and ChatView state.":
    "本次发布改进了消息时间线的派生逻辑，将真实的智能体文本与工具及工作行分开，优化折叠轮次的特征标识，保留智能体文本选择操作，并新增时间线行与 ChatView 状态的专项测试。",
  "Multi-pane work is quicker to navigate": "多窗格工作导航更快捷",
  "Recent views, split chats, pinned threads, hover cards, and project sidebar actions received a round of smaller navigation polish.":
    "最近视图、拆分聊天、置顶对话、悬浮卡片和项目侧边栏操作获得了一系列细节优化。",
  "Recent view switching, sidebar hover-card anchors, thread/project hover content, pin toggles, chat header actions, project shortcut targets, and split/sidechat affordances now share more predictable state and keyboard routing.":
    "最近视图切换、侧边栏悬浮卡片锚点、对话与项目悬浮内容、置顶开关、聊天标题栏操作、项目快捷入口，以及拆分聊天与侧边聊天入口，现在拥有更可预测的状态和键盘导航。",
  "Keyboard shortcuts got stricter": "键盘快捷键更严谨",
  "Shortcut defaults and migrations are now safer, with better handling for chat creation, terminal actions, navigation, and stale keybinding rows.":
    "快捷键默认值与迁移流程现在更安全，并更妥善地处理新建聊天、终端操作、导航和过期的快捷键绑定记录。",
  "Server and web keybinding logic now validates persisted bindings more carefully, avoids carrying conflicting defaults forward, improves new-chat/new-terminal command resolution, and has expanded regression coverage.":
    "服务端和 Web 端的快捷键绑定逻辑现在会更严格地验证已保存的绑定，避免沿用冲突的默认值，改进新建聊天与新建终端命令的解析，并扩充回归测试覆盖。",
  "Providers recover from more edge cases": "服务商可从更多边缘情况中恢复",
  "Codex, Gemini, Grok, Cursor, OpenCode, and provider health paths are sturdier around runtime events, discovery, process cleanup, and idle sessions.":
    "Codex、Gemini、Grok、Cursor、OpenCode 及服务商健康检查流程，在运行时事件、发现、进程清理和空闲会话方面更加稳健。",
  "Provider runtime ingestion now handles more canonical event shapes, Gemini ACP probing is more defensive, provider service behavior has broader coverage, idle runtime cleanup was tightened, process runner handling is safer, and Codex review/compaction progress is easier to reconcile.":
    "服务商运行时事件接入现在可处理更多标准事件结构；Gemini ACP 探测更加谨慎；服务商服务行为获得更广泛的测试覆盖；空闲运行时清理更加严格；进程运行器处理更安全；Codex 审阅与压缩进度也更易核对。",
  "Automation setup asks for the right approval": "自动化设置会请求正确的批准",
  "Automation creation and updates now separate setup prompts, update-only flows, approval fallbacks, and risk acknowledgement more carefully.":
    "创建和更新自动化时，现在会更谨慎地区分设置提示、仅更新流程、批准后备路径与风险确认。",
  "This release hardens conversational automation setup, preserves update-only approval paths, restores the approval fallback, strips carried setup filler from prompts, and keeps the risk acknowledgement gate attached to dispatch.":
    "本次发布增强了对话式自动化设置，保留仅更新流程的批准路径，恢复批准后备机制，移除提示中沿用的冗余设置内容，并确保风险确认始终关联到任务派发。",
  "Desktop updates and startup are quieter": "桌面端更新与启动更安静",
  "The desktop shell now suppresses noisy Node warnings in more places and hardens electron-updater command handling on Windows.":
    "桌面外壳现在会在更多位置抑制干扰性的 Node 警告，并增强 Windows 上 electron-updater 命令的处理安全性。",
  "Desktop startup applies safer warning handling, voice transcription edge cases were tightened, and electron updater command construction now has dedicated security coverage around Windows process spawning.":
    "桌面端启动采用更安全的警告处理方式，完善语音转写的边缘情况，并为 electron 更新器的命令构造新增针对 Windows 进程启动的专项安全测试。",
  "The interface has more useful visual signals": "界面提供更多实用的视觉提示",
  "Provider icons, central icon assets, model pickers, composer controls, automation banners, Kanban cards, preview cards, and tooltips were cleaned up in small but visible ways.":
    "服务商图标、中央图标资源、模型选择器、输入框控件、自动化横幅、看板卡片、预览卡片和工具提示都获得了细微但清晰可见的改进。",
  "Moss now ships a curated central-icons set, improves provider/model picker presentation, refines composer picker and automation banners, adds better project/thread hover details, and keeps repeated UI surfaces closer to the same visual language.":
    "Moss 现在内置精选的 central-icons 集合，改善服务商与模型选择器的呈现，优化输入框选择器和自动化横幅，补充更丰富的项目与对话悬浮信息，并让重复出现的界面区域采用更统一的视觉语言。",
  "Automations are a real workspace surface": "自动化成为正式的工作区功能",
  "Moss now has first-class Automations for scheduled agent work, with sidebar navigation, list/detail pages, run history, triage actions, and inline editing.":
    "Moss 现已提供一等的 Automations 功能，用于定时执行智能体工作，并配有侧边栏导航、列表与详情页、运行历史、分流操作和行内编辑。",
  "This release wires automation contracts, persistence, scheduler leases, run tracking, RPC methods, sidebar badges, Current/Paused views, detail routes, editable fields, previous-run history, and result triage so scheduled work lives inside the same thread/provider/worktree pipeline as normal chat work.":
    "本次发布接通了自动化契约、持久化、调度器租约、运行追踪、RPC 方法、侧边栏徽标、Current 与 Paused 视图、详情路由、可编辑字段、历史运行记录和结果分流，让定时工作与普通聊天任务共用同一套对话、服务商和工作树处理流程。",
  "Heartbeat automations can stop when the goal is met": "Heartbeat 自动化可在目标达成后停止",
  "Heartbeat automations can store an AI-evaluated stop clause, evaluate it after successful runs, and disable themselves with a recorded reason when the condition is satisfied.":
    "Heartbeat 自动化可以保存由 AI 评估的停止条件，在成功运行后进行判断，并在条件满足时自动停用，同时记录原因。",
  "Completion policies now support natural-language stop conditions, dedicated background evaluation, visible completion results, timeout handling, stale-result guards, legacy-row defaults, and archive/read preservation so a stop check cannot silently undo user triage state.":
    "完成策略现在支持自然语言停止条件、独立的后台评估、可见的完成结果、超时处理、过期结果保护、旧记录默认值，以及归档和已读状态保护，避免停止检查在无提示的情况下撤销用户的分流状态。",
  "Automation creation understands natural prompts": "创建自动化时可理解自然语言提示",
  "The composer can turn automation-style prompts into scheduled drafts, including intervals, daily/weekly timing, cron-like schedules, heartbeat targets, and review dialogs.":
    "输入框可以将自动化风格的提示转换为定时草稿，支持间隔执行、每日或每周时间、类似 cron 的计划、Heartbeat 目标和确认对话框。",
  "Automation intent parsing now covers explicit and generated prompts, English and Italian stop/schedule phrasing, bounded fast-loop safety, draft review, source-thread handling, restored plan source metadata, inline editing from composer text, and stricter confirmation for LLM-generated automations.":
    "自动化意图解析现在覆盖明确输入和生成式提示、英语及意大利语的停止与计划表达、受限的快速循环安全机制、草稿确认、来源对话处理、恢复的计划来源元数据、根据输入框文本进行行内编辑，以及对 LLM 生成自动化更严格的确认。",
  "Scheduled runs are harder to lose or corrupt": "定时运行更不易丢失或损坏",
  "Automation scheduling, recovery, and run reconciliation were hardened so crashes, duplicate wakes, approval waits, stale cache updates, and cleanup failures are handled more predictably.":
    "自动化调度、恢复和运行核对机制已经增强，可更可预测地处理崩溃、重复唤醒、等待批准、过期缓存更新及清理失败。",
  "The automation service now has occurrence dedupe, scheduler leases, crash replay, failed-run rollback, startup recovery, bounded completion-evaluation queues, recovery/lease observability, approval ownership re-checks, standalone worktree cleanup, equal-timestamp cache merging, and DST/long-downtime schedule coverage.":
    "自动化服务现在具备执行时点去重、调度器租约、崩溃重放、失败运行回滚、启动恢复、有限容量的完成评估队列、恢复与租约可观测性、批准归属复查、独立工作树清理、相同时间戳的缓存合并，并覆盖夏令时和长时间停机后的计划测试。",
  "Files attach, preview, and download more reliably": "文件附加、预览与下载更可靠",
  "Chat now supports generic file attachments alongside images, with better chips/cards, safer upload normalization, worktree-aware previews, and in-app local image downloads.":
    "聊天现在除图片外还支持通用文件附件，并提供更完善的标签和卡片、更安全的上传规范化、可感知工作树的预览，以及应用内本地图片下载。",
  "File attachments now flow through contracts, upload storage, composer paste/drop, provider prompts, Kanban dispatch, recap/bootstrap surfaces, optimistic timeline rendering, caps/rollback, attachment-bearing plan follow-ups, explicit unsupported-file rejection, worktree-backed file preview roots, and blob-based download handling that keeps failed local image downloads inside Moss.":
    "文件附件现在贯通契约、上传存储、输入框粘贴与拖放、服务商提示、看板派发、回顾与初始化界面、乐观时间线渲染、上限与回滚、含附件的计划后续消息、明确拒绝不支持的文件、基于工作树的文件预览根目录，以及基于 blob 的下载处理；本地图片下载失败时仍会留在 Moss 内。",
  "Providers and models stay scoped to the right project": "服务商与模型会限定在正确的项目中",
  "OpenCode and Claude startup paths are more careful about cwd, model discovery, config scope, and sticky plan mode so new threads inherit less accidental state.":
    "OpenCode 和 Claude 的启动流程现在会更谨慎地处理 cwd、模型发现、配置作用域和持续生效的计划模式，减少新对话意外继承状态的情况。",
  "OpenCode model discovery can fall back to `opencode models --verbose`, managed OpenCode/Kilo paths run in the request/session cwd, warm server reuse is scoped, file config is no longer replaced with synthetic empty config, OpenCode resume preserves cwd, and fresh Claude threads avoid inheriting plan mode from the previous active thread.":
    "OpenCode 模型发现现在可回退到 `opencode models --verbose`；受管的 OpenCode/Kilo 路径会在请求或会话的 cwd 中运行；热服务器复用受到作用域限制；文件配置不再被合成的空配置替换；OpenCode 恢复时会保留 cwd；新建 Claude 对话也不会继承上一个活跃对话的计划模式。",
  "Chats and side panels stay in sync": "聊天与侧边面板保持同步",
  "Deleted chats disappear immediately, the Environment panel behaves better in constrained layouts, automation cards show up in the transcript, and file previews avoid extra full-thread subscriptions.":
    "已删除的聊天会立即消失；Environment 面板在受限布局中表现更好；自动化卡片会显示在对话记录中；文件预览也会避免额外订阅完整对话。",
  "Client projections now use delete tombstones and responsive archived bulk-delete updates, environment-panel open/close preferences survive chat switches, constrained/floating layouts stay calmer by default, thread automation summaries appear in the environment panel, created automation cards render in chat, and file preview routing avoids unnecessary full thread subscriptions.":
    "客户端状态映射现在使用删除墓碑，并支持响应式的归档批量删除更新；Environment 面板的开关偏好会在切换聊天后保留；受限或浮动布局默认更稳定；对话自动化摘要会显示在 Environment 面板中；新建自动化卡片会呈现在聊天内；文件预览路由也会避免不必要的完整对话订阅。",
  "Profile skill counts reflect more real work": "个人资料中的技能统计更贴近实际使用",
  "Profile stats now count repeated `/skill` and `$skill` usage more accurately, including retained history that should still contribute to your local activity picture.":
    "个人资料统计现在能更准确地计算重复使用 `/skill` 和 `$skill` 的次数，包括仍应计入本地活动概况的保留历史。",
  "Skill aggregation now includes retention-hidden threads while still excluding manually deleted data, counts repeated slash/dollar skill tokens inside one prompt, avoids double-counting structured references, and has regression coverage for retained threads and repeated skill invocation.":
    "技能汇总现在会纳入因保留策略而隐藏的对话，同时继续排除手动删除的数据；可统计同一提示中重复出现的斜杠或美元符号技能 token；避免重复计算结构化引用；并新增针对保留对话和重复调用技能的回归测试。",
  "Hand off chats from the header again": "再次可从标题栏移交聊天",
  "The chat header now has a compact Hand off menu, so you can start a provider handoff without hunting through the rest of the workspace.":
    "聊天标题栏现在提供紧凑的 Hand off 菜单，无需在工作区其他位置寻找即可发起服务商移交。",
  "The header handoff action now offers only usable target providers, checks provider availability before creating the handoff thread, and keeps the action disabled while the current thread is busy or waiting on approvals/input.":
    "标题栏中的移交操作只会列出可用的目标服务商，在创建移交对话前检查服务商可用性，并在当前对话忙碌或等待批准与输入时保持禁用。",
  "Project scripts stay out of the way": "项目脚本不再妨碍操作",
  "Project action dialogs remain available, but the old inline script runner no longer crowds the chat header controls.":
    "项目操作对话框仍然可用，但旧的行内脚本运行器不再占用聊天标题栏控件空间。",
  "Project script controls stay mounted for the shared Open-in/project-action dialog path, while the visible header play/chevron runner is hidden to keep the top bar focused.":
    "项目脚本控件仍会挂载，以支持共用的 Open-in 与项目操作对话框路径；可见的标题栏播放及箭头运行器则会隐藏，让顶部栏更专注。",
  "Restarts bring you back to the right chat": "重启后回到正确的聊天",
  "Moss now waits for one fresh server snapshot before giving up on a remembered chat route, so app restarts are less likely to dump you onto an empty fallback screen.":
    "Moss 现在会等待一次新的服务端快照，再放弃记住的聊天路由，因此应用重启后不易跳转到空白的后备页面。",
  "Chat route restore now validates remembered thread/split routes against refreshed orchestration state, holds fallback while startup data is still empty, and has focused coverage for missing-thread and empty-startup recovery paths.":
    "聊天路由恢复现在会依据刷新后的编排状态验证记住的对话与拆分路由；启动数据仍为空时会暂缓启用后备页面；并新增针对对话缺失和启动数据为空这两类恢复路径的专项测试。",
  "Disabled providers recover more predictably": "已禁用的服务商恢复更可预测",
  "Provider health refreshes now have regression coverage around re-enabling disabled providers, making settings changes less likely to leave stale unavailable states behind.":
    "服务商健康状态刷新现在增加了重新启用已禁用服务商的回归测试，降低设置变更后残留过期不可用状态的概率。",
  "Provider health and Pi adapter paths were tightened with coverage for disabled-provider re-enable behavior, while provider badges and menu icons were kept aligned with the refreshed availability state.":
    "服务商健康检查和 Pi 适配器路径得到强化，并覆盖已禁用服务商重新启用的行为；服务商徽标与菜单图标也会和刷新后的可用状态保持一致。",
  "The chat header is quieter": "聊天标题栏更清爽",
  "The old handoff shortcut has been removed from the chat header, leaving the main conversation controls easier to scan during active work.":
    "旧的移交快捷入口已从聊天标题栏移除，让进行工作时的主要对话控件更易浏览。",
  "The chat header no longer renders the handoff action path, reducing duplicate top-bar controls and keeping project/thread actions focused on the surfaces that still own them.":
    "聊天标题栏不再呈现移交操作路径，减少顶部栏的重复控件，并让项目与对话操作集中在仍负责这些功能的界面区域。",
  "Your profile understands more of your work": "个人资料更了解你的工作方式",
  "Moss now tracks richer local profile stats, including your most worked project, skill and agent usage, active hours, provider/model mix, and prompt activity.":
    "Moss 现在会追踪更丰富的本地个人资料统计，包括投入最多的项目、技能与智能体使用情况、活跃时段、服务商与模型分布，以及提示活动。",
  "Profile stats now derive more signal from Moss's local projection database: most-worked project, prompt/thread activity, skill and agent usage, provider/model usage, reasoning patterns, active-hour windows, and token heatmap data are all represented in the profile contract and settings panel.":
    "个人资料统计现在会从 Moss 的本地数据视图中提取更多信息：投入最多的项目、提示与对话活动、技能与智能体使用情况、服务商与模型使用情况、推理模式、活跃时段窗口及 token 热力图数据，均已纳入个人资料契约和设置面板。",
  "Large pastes become cleaner composer cards": "大段粘贴内容会变成整洁的输入框卡片",
  "Big pasted blocks now collapse into tidy attachment-style cards, keeping the composer readable while still letting you restore or remove the full text.":
    "较大的粘贴文本块现在会折叠为简洁的附件式卡片，在保持输入框清爽的同时，仍可恢复或移除完整文本。",
  "Large pasted text blocks are serialized separately from the visible prompt, shown as compact cards in the composer, expandable in sent messages, and counted with line/character metadata so long prompts are easier to review.":
    "大段粘贴文本现在与可见提示分开序列化，在输入框中显示为紧凑卡片，在已发送消息中可以展开，并附带行数与字符数元数据，让长提示更易审阅。",
  "Pasted text survives message edits": "编辑消息时保留粘贴文本",
  "Editing a message now preserves pasted text blocks instead of dropping or flattening them, so larger prompts stay intact when you refine them.":
    "编辑消息现在会保留粘贴文本块，不再将其丢弃或展平，因此调整较长提示时内容仍能保持完整。",
  "The composer draft, edit, assistant-selection, terminal-context, and WebSocket send paths now preserve structured pasted text blocks instead of folding them into fragile plain text. Focused tests cover pasted text, draft persistence, terminal context, timeline height, and edit behavior.":
    "输入框草稿、编辑、智能体文本选择、终端上下文和 WebSocket 发送路径现在都会保留结构化粘贴文本块，不再将其合并为脆弱的纯文本。专项测试覆盖粘贴文本、草稿持久化、终端上下文、时间线高度和编辑行为。",
  "Your Moss profile has more personality": "让你的 Moss 个人资料更具个性",
  "Profile settings now include richer identity details, activity stats, and a cleaner editing flow so Moss feels more like your own workspace.":
    "个人资料设置现已提供更丰富的身份信息、活动统计和更清爽的编辑流程，让 Moss 更像你的专属工作区。",
  "This release adds profile stats aggregation, profile settings UI polish, activity heatmap refinements, avatar/profile editing updates, and focused coverage for the new profile data paths.":
    "本次发布新增个人资料统计汇总，优化个人资料设置界面和活动热力图，并更新头像与个人资料编辑体验，同时为新的个人资料数据路径补充了针对性测试。",
  "Deleted threads get a safer recovery window": "删除对话后拥有更安全的恢复期",
  "Thread deletion now keeps soft-deleted data around long enough to avoid accidental loss while still letting cleanup happen predictably.":
    "删除对话后，软删除数据会保留足够长的时间，以避免意外丢失，同时仍能按预期完成清理。",
  "Moss now tracks thread retention state explicitly, covers soft-delete cleanup behavior with server tests, and keeps deletion/recovery semantics more predictable for early WIP data.":
    "Moss 现在会明确跟踪对话的保留状态，通过服务端测试覆盖软删除清理行为，让早期开发阶段数据的删除与恢复规则更加可预测。",
  "Live composer edits stay visible per turn": "每个轮次中的实时输入框编辑都保持可见",
  "Composer changes made while a turn is running now stay attached to the right turn, reducing confusing stale text or hidden edits during active work.":
    "轮次运行期间对输入框所做的修改现在会关联到正确的轮次，减少工作过程中出现过期文本或编辑内容被隐藏的困扰。",
  "The chat route and composer state handling were tightened so live edits remain visible in the correct turn lifecycle without bleeding into unrelated transcript updates.":
    "我们强化了聊天路由和输入框状态处理，确保实时编辑在正确的轮次生命周期内保持可见，且不会混入无关的对话记录更新。",
  "Release checks are steadier": "发布检查更加稳定",
  "The release test path now avoids known teardown and child-process timing traps, making full validation less likely to stall after tests have passed.":
    "发布测试流程现在可避开已知的收尾和子进程时序问题，降低测试通过后完整验证仍陷入停滞的概率。",
  "Effect ACP child-process fixture tests now have explicit timeouts, and the server test script runs its Vitest files serially so the root Turbo test gate exits cleanly during release validation.":
    "Effect ACP 子进程测试夹具现在设有明确的超时时间，服务端测试脚本也会串行运行 Vitest 文件，让根级 Turbo 测试关卡能够在发布验证期间正常退出。",
  "File comments can ride along with your next message": "文件评论可随下一条消息一起发送",
  "You can now leave focused line comments from composer and preview surfaces, then send them with the prompt so agents get clearer file-specific context.":
    "现在可以从输入框和预览界面添加精确到行的评论，并随提示词一同发送，让智能体获得更清晰、针对具体文件的上下文。",
  "This release adds file-line comment boxes, summary chips, draft persistence, reference attachment handling, preview/editor entry points, chat timeline support, and focused tests for comment parsing, composer drafts, terminal context, kanban dispatch, and chat-view logic.":
    "本次发布新增文件行评论框、摘要标签、草稿持久化、引用附件处理、预览与编辑器入口及聊天时间线支持，并针对评论解析、输入框草稿、终端上下文、看板分发和聊天视图逻辑补充了专项测试。",
  "Live file changes stay scoped to the active turn": "实时文件改动仅关联当前活动轮次",
  "The live changed-files panel now follows the turn that is actually running, avoiding stale or unrelated file edits when sessions overlap or recover.":
    "实时文件变更面板现在会跟随真正正在运行的轮次，避免会话重叠或恢复时显示过期或无关的文件修改。",
  "Provider runtime ingestion now carries active turn identity through Codex, Claude, checkpoint, and live-change paths. Chat selectors and composer change headers were tightened so tool/file rows from older turns do not masquerade as current live output.":
    "服务商运行时数据接入现在会在 Codex、Claude、检查点和实时变更路径中携带活动轮次标识。我们还强化了聊天选择器和输入框变更标题，防止旧轮次的工具或文件行被误认为当前实时输出。",
  "Partial workspace file references resolve more reliably":
    "不完整的工作区文件引用也能更可靠地定位",
  "Opening files from shortened or partial references is more forgiving, especially when assistant output mentions a file path without the full workspace prefix.":
    "通过缩短或不完整的引用打开文件时更加宽容，尤其适用于智能体输出中提到文件路径却未包含完整工作区前缀的情况。",
  "Workspace file-system lookup now searches entries more deliberately, exposes shared server helpers, improves opener behavior, and adds coverage around partial references so previewing referenced files lands on the intended workspace item.":
    "工作区文件系统查询现在会更有针对性地查找条目，并提供共享服务端辅助函数、改进文件打开行为，同时补充不完整引用的测试，确保预览引用文件时定位到预期的工作区项目。",
  "Restarted sessions are less likely to leave turns hanging": "会话重启后轮次不易再悬而未决",
  "After provider restarts, reconnects, or quiet ACP sessions, Moss does a better job of reconciling active turns and finishing idle work instead of getting stuck.":
    "服务商重启、重新连接或 ACP 会话长时间无活动后，Moss 现在能更好地协调活动轮次并结束空闲工作，避免一直卡住。",
  "Startup turn reconciliation, ACP idle watchdog handling, provider runtime ingestion, Cursor/Grok/OpenCode adapter event paths, command reactor cleanup, and shared thread summaries now work together to recover unfinished turns and surface stale runtime state more predictably.":
    "启动时的轮次协调、ACP 空闲监控处理、服务商运行时数据接入、Cursor/Grok/OpenCode 适配器事件路径、命令响应器清理和共享对话摘要现已协同工作，可恢复未完成的轮次，并更可预测地呈现过期运行时状态。",
  "PDFs open safely inside Moss": "PDF 可在 Moss 内安全打开",
  "Local PDFs can now be previewed directly in the workspace pane with page navigation, zoom controls, selection-safe rendering, and hardened link handling.":
    "现在可以直接在工作区窗格中预览本地 PDF，并使用页面导航和缩放控件；渲染不会干扰文本选择，链接处理也更加安全。",
  "This release replaces browser iframe PDF handling with a pdf.js-powered viewer, authenticated local preview routes, workspace/scratch allowlists, sanitized annotation links, page reset behavior when switching files, fresh page proxies per document, and focused server/web tests for local image/PDF access and PDF navigation helpers.":
    "本次发布以基于 pdf.js 的查看器取代浏览器 iframe PDF 处理，并新增需身份验证的本地预览路由、工作区与暂存区允许列表、安全处理后的注释链接、切换文件时的页码重置、每份文档独立的页面对象，以及针对本地图像与 PDF 访问和 PDF 导航辅助函数的服务端与 Web 专项测试。",
  "File preview is shared across chat and editor workspaces": "聊天与编辑器工作区共享文件预览",
  "The right dock and editor workspace now use the same richer file preview surface, so browsing files, images, markdown, and PDFs feels more consistent.":
    "右侧停靠区与编辑器工作区现在使用同一套更丰富的文件预览界面，让文件、图像、Markdown 和 PDF 的浏览体验更加一致。",
  "Moss now routes file preview through `WorkspaceFilePreview`, `PdfFilePreview`, shared preview headers, markdown/source selection references, workspace file openers, dock pane activation metadata, local preview URL helpers, and tighter file reference context-menu behavior.":
    "Moss 现在统一通过 `WorkspaceFilePreview`、`PdfFilePreview`、共享预览标题栏、Markdown/源码选择引用、工作区文件打开器、停靠窗格激活元数据和本地预览 URL 辅助函数处理文件预览，并强化了文件引用上下文菜单的行为。",
  "Pi plugin sessions start in the right place": "Pi 插件会话从正确位置启动",
  "Pi-backed plugin flows now route through Moss more reliably, discover model support better, and keep startup prompts attached to the correct provider session.":
    "由 Pi 支持的插件流程现在可以更可靠地通过 Moss 路由，更准确地发现模型支持情况，并将启动提示词关联到正确的服务商会话。",
  "The Pi adapter gained richer ACP handling, extension model discovery, cwd/session wiring, startup prompt routing, provider command reactor coverage, provider service safeguards, and an ACP mock agent so plugin startup, prompt forwarding, and provider state transitions are covered more directly.":
    "Pi 适配器新增更完整的 ACP 处理、扩展模型发现、当前工作目录与会话连接、启动提示词路由、服务商命令响应器测试、服务商服务保护机制和 ACP 模拟智能体，从而更直接地覆盖插件启动、提示词转发及服务商状态转换。",
  "Chat startup and timelines do less unnecessary work": "聊天启动和时间线减少了不必要的工作",
  "Opening busy chats should feel calmer: timeline ordering, transcript selection, collapsed turns, and sidebar-driven updates were tightened for the common path.":
    "打开繁忙聊天时体验会更稳定：我们优化了常用路径中的时间线排序、对话记录选择、折叠轮次和侧边栏触发的更新。",
  "This release optimizes chat view startup selectors, timeline ordering, settled-turn collapse fallback, message timeline height logic, transcript tail behavior, right-dock runtime activation, and route-level chat restoration with additional selector, timeline, and browser coverage.":
    "本次发布优化了聊天视图启动选择器、时间线排序、已结束轮次折叠的回退逻辑、消息时间线高度计算、对话记录末尾行为、右侧停靠区运行时激活，以及路由级聊天恢复，并补充了选择器、时间线和浏览器测试。",
  "Composer and markdown interactions picked up useful polish": "输入框与 Markdown 交互更精致实用",
  "Cmd+L now focuses the composer, markdown task lists render cleanly, inline mentions behave more predictably, and pending user-input panels are easier to scan.":
    "现在按 Cmd+L 可聚焦输入框，Markdown 任务列表显示更整洁，行内提及行为更加可预测，待处理的用户输入面板也更易浏览。",
  "New keybinding metadata and tests cover the composer focus shortcut, while markdown task-list parsing, chat references, inline mention chips, composer banners, pending user-input panels, and shortcut-sheet entries received focused fixes.":
    "新增的快捷键元数据和测试覆盖输入框聚焦快捷键；Markdown 任务列表解析、聊天引用、行内提及标签、输入框横幅、待处理用户输入面板和快捷键列表也获得了针对性修复。",
  "Cursor and changed-file views are easier to trust": "Cursor 与变更文件视图更值得信赖",
  "Cursor message ids are handled more carefully, changed files moved to a flatter UI path, and stale plan/sidebar indicators were cleaned up.":
    "Cursor 消息 ID 的处理更加谨慎，变更文件采用更扁平的界面路径，过期的计划与侧边栏指示状态也已清理。",
  "Moss now preserves Cursor message identity more reliably, removes the older turn diff tree path, refines changed-file file-list rendering, fixes duplicate plan-mode icons and stale plan sidebar state, and hides inline project actions from the chat header where they created noise.":
    "Moss 现在能更可靠地保留 Cursor 消息标识，移除了旧版轮次差异树路径，优化变更文件列表的渲染，修复重复的计划模式图标和过期的计划侧边栏状态，并隐藏聊天标题栏中造成干扰的行内项目操作。",
  "Local previews have tighter safety rails": "本地预览拥有更严格的安全边界",
  "Local image/PDF preview routes are more explicit about what can be opened, how auth applies, and when unsafe paths or URLs should be rejected.":
    "本地图像与 PDF 预览路由现在会更明确地限制可打开的内容、身份验证的应用方式，以及应拒绝不安全路径或 URL 的情况。",
  "Server-side local preview handling now shares local preview file helpers, narrows CORS behavior for preview responses, covers local image routes, hardens scratch workspace path generation, and keeps external PDF links on an allowlisted path instead of trusting unsafe annotation URLs.":
    "服务端本地预览处理现在共享本地预览文件辅助函数，收紧预览响应的 CORS 行为，覆盖本地图像路由，加强暂存工作区路径生成，并通过允许列表处理外部 PDF 链接，不再信任不安全的注释 URL。",
  "Chats get Codex-style workspace folders": "聊天获得 Codex 风格的工作区文件夹",
  "Project chats now keep their generated files in clearer chat-specific workspace folders, making it easier to understand what belongs to each conversation.":
    "项目聊天现在会将生成的文件保存在更清晰的聊天专属工作区文件夹中，让每段对话所属的内容更容易辨认。",
  "This release adds Codex-like workspace folder creation, associated worktree metadata handling, file-only workspace search, settings search deep links, and harder Gemini probe handling so workspace state stays more predictable across chat and editor surfaces.":
    "本次发布新增 Codex 风格的工作区文件夹创建、关联工作树元数据处理、仅文件工作区搜索、设置搜索深层链接，并强化 Gemini 探测处理，使聊天与编辑器界面中的工作区状态更加可预测。",
  "Transcript turns collapse more reliably": "对话记录中的轮次折叠更加可靠",
  "Long-running assistant work, collapsed turn rows, and transcript tail-follow behavior are steadier during active output and after reconnects.":
    "在实时输出及重新连接后，长时间运行的智能体工作、折叠轮次行和对话记录末尾跟随行为都更加稳定。",
  "The timeline now falls back to the latest turn when visible turn ids are empty, fixes collapsed-turn and tail-jitter edge cases, and keeps scroll-follow logic scoped to real transcript messages instead of tool-only churn.":
    "当可见轮次 ID 为空时，时间线现在会回退到最新轮次；同时修复折叠轮次和末尾抖动的边缘情况，并确保滚动跟随逻辑只响应真实的对话记录消息，不受纯工具活动反复干扰。",
  "Browser sessions and copy links feel smoother": "浏览器会话与复制链接体验更流畅",
  "In-app browser sessions recover better, and copy-link flows now have cleaner behavior when moving between browser and chat contexts.":
    "应用内浏览器会话恢复更加可靠，在浏览器与聊天上下文之间切换时，复制链接流程也更加清爽。",
  "Browser session handling, copy-link actions, local image preview state, and shared error-card behavior were tightened so browsing, previewing, and moving references into prompts produce fewer stale or duplicated states.":
    "我们强化了浏览器会话处理、复制链接操作、本地图像预览状态和共享错误卡片行为，让浏览、预览及将引用加入提示词时更少出现过期或重复状态。",
  "Settings open faster and density is easier to tune": "设置打开更快，界面密度更易调整",
  "Settings navigation, sidebar search, and UI density controls picked up polish so repeated configuration work feels lighter.":
    "设置导航、侧边栏搜索和界面密度控制均得到优化，让频繁配置变得更轻松。",
  "Settings page open avoids extra streaming-tick re-renders, sidebar search deep links can jump directly to matching settings, UI density follow-ups refine sidebar and composer spacing, and shared project menus replace older bespoke editor picker code.":
    "设置页面打开时可避免流式更新节拍导致的额外重新渲染；侧边栏搜索深层链接可直接跳转到匹配的设置；后续界面密度调整优化了侧边栏和输入框间距，共享项目菜单也取代了旧版专用编辑器选择器代码。",
  "Editor and kanban workflows are cleaner": "编辑器与看板流程更加清爽",
  "Editor mode feedback, project picker reuse, kanban composer menus, and image preview handling all received focused follow-ups.":
    "编辑器模式反馈、项目选择器复用、看板输入框菜单和图像预览处理均获得了针对性改进。",
  "This release fixes editor-mode production feedback, shares project menu picker behavior, splits kanban composer menu discovery from editor logic, and consolidates local image preview state across chat and editor views.":
    "本次发布修复编辑器模式的生产环境反馈，共享项目菜单选择行为，将看板输入框菜单发现逻辑与编辑器逻辑拆分，并统一聊天和编辑器视图中的本地图像预览状态。",
  "Editor workspace is built into chat": "聊天内置编辑器工作区",
  "You can now keep a project file workspace beside the conversation, inspect files, and move references into prompts without bouncing between tools.":
    "现在可以在对话旁保留项目文件工作区，查看文件并将引用加入提示词，无需在不同工具之间来回切换。",
  "This release adds the editor workspace view, file reference selection state, syntax highlighting, project file-system APIs, and focused coverage for workspace entries, path containment, editor view state, and chat reference parsing.":
    "本次发布新增编辑器工作区视图、文件引用选择状态、语法高亮、项目文件系统 API，并针对工作区条目、路径范围限制、编辑器视图状态和聊天引用解析补充了专项测试。",
  "Open-in editor support is broader and prettier": "“在编辑器中打开”支持更广，视觉效果也更精致",
  "Ghostty, Terminal, JetBrains, Xcode, Zed, Cursor, VS Code, and other editor launchers now have better discovery, icons, and platform-specific launch behavior.":
    "Ghostty、Terminal、JetBrains、Xcode、Zed、Cursor、VS Code 及其他编辑器启动器现在拥有更完善的发现能力、图标和平台专属启动行为。",
  "Moss now discovers native editor apps and icons, caches icon assets server-side, exposes authenticated icon routes, and tightens macOS/Linux/Windows launcher handling, including Ghostty working-directory behavior and Linux desktop-entry matching.":
    "Moss 现在会发现原生编辑器应用及其图标，在服务端缓存图标资源，提供需身份验证的图标路由，并强化 macOS、Linux 和 Windows 上的启动器处理，包括 Ghostty 工作目录行为和 Linux 桌面条目匹配。",
  "Skills are unified across providers": "不同服务商的技能现已统一",
  "The settings skill catalog now understands provider roots and shared skill copies, so Codex, Claude, Cursor, and compatible providers show cleaner ownership instead of duplicate noise.":
    "设置中的技能目录现在能识别服务商根目录和共享技能副本，让 Codex、Claude、Cursor 及兼容服务商更清晰地显示归属，减少重复干扰。",
  "A shared server-side skills catalog, provider prompt injection, provider discovery service updates, settings model, and provider icon chips now keep provider-specific and portable skills aligned across the UI.":
    "共享的服务端技能目录、服务商提示词注入、服务商发现服务更新、设置模型和服务商图标标签，现在能让服务商专属技能与可移植技能在整个界面中保持一致。",
  "Composer, references, and diffs feel steadier": "输入框、引用和差异视图更加稳定",
  "Composer controls, inline chips, file references, markdown rendering, and diff navigation picked up tighter layout and interaction polish.":
    "输入框控件、行内标签、文件引用、Markdown 渲染和差异导航采用了更紧凑的布局，并优化了交互细节。",
  "The chat view now shares composer footer layout helpers, richer file-entry icons, code-selection actions, syntax highlighting, diff route search, improved diff toolbar/list behavior, and cleaner picker layout for model, trait, and open-in controls.":
    "聊天视图现已共用输入框底栏布局辅助工具，并加入更丰富的文件条目图标、代码选择操作、语法高亮、差异路由搜索，改进了差异工具栏和列表行为，同时让模型、特性及打开方式选择器的布局更清爽。",
  "Provider status refreshes are less stale": "服务商状态刷新更加及时",
  "Codex auth overlays, provider status refreshes, and provider discovery invalidation now recover better after focus changes, settings updates, and native provider checks.":
    "Codex 身份验证浮层、服务商状态刷新和服务商发现缓存失效机制现可在焦点变化、设置更新及原生服务商检查后更好地恢复。",
  "The web app now refreshes provider auth/status on focus and root events, while the server-side provider discovery layer handles native skill and capability fallbacks more predictably.":
    "Web 应用现在会在获得焦点和根级事件发生时刷新服务商的身份验证与状态；服务器端服务商发现层也能更可预测地处理原生技能和能力的回退逻辑。",
  "Older data and terminals recover more predictably": "旧数据与终端恢复更加可靠",
  "Legacy migration trackers, pinned/sidechat reconciliation, terminal environment handling, and workspace path checks were tightened for early-WIP installs.":
    "针对早期开发版本，完善了旧版迁移追踪、置顶与侧边聊天数据协调、终端环境处理及工作区路径检查。",
  "Moss now reconciles legacy migration bookkeeping before running migrations, expands migration coverage, validates workspace real-path containment, and carries terminal environment updates through shared server and web contracts.":
    "Moss 现在会在执行迁移前校正旧版迁移记录，扩大迁移覆盖范围，验证工作区真实路径是否位于允许范围内，并通过服务器与 Web 端的共享协议同步终端环境更新。",
  "Claude Fable 5 available to Claude and Cursor": "Claude 和 Cursor 现已支持 Claude Fable 5",
  "Claude Fable 5 now appears across the Claude and Cursor model paths, so you can pick the new model without hand-editing provider settings.":
    "Claude Fable 5 现已加入 Claude 和 Cursor 的模型选项，无需手动编辑服务商设置即可选择新模型。",
  "The shared model contract, Cursor variant list, keybinding metadata, provider discovery invalidation, and model-picker coverage were updated so Claude and Cursor stay in sync when new supported models land.":
    "共享模型协议、Cursor 变体列表、快捷键元数据、服务商发现缓存失效机制及模型选择器覆盖范围均已更新，确保新增受支持模型时 Claude 与 Cursor 保持同步。",
  "Cursor model discovery is smarter": "Cursor 模型发现更加智能",
  "Cursor-backed sessions now discover ACP model support more reliably, refresh stale model lists, and recover better when the provider reports partial or invalid state.":
    "基于 Cursor 的会话现在能更可靠地发现 ACP 模型支持、刷新过期模型列表，并在服务商返回不完整或无效状态时更好地恢复。",
  "Cursor ACP support now has stronger parsing, refresh, health, and adapter handling, with tests for discovery fallbacks, stale cache invalidation, and provider health behavior.":
    "Cursor ACP 支持现已强化解析、刷新、健康检查和适配器处理，并新增测试以覆盖发现回退、过期缓存失效及服务商健康状态行为。",
  "Provider usage is visible where you work": "随时查看服务商用量",
  "Usage limits and pace now show up in the chat environment, settings, and compact controls for Codex, Claude, Cursor, and Gemini.":
    "Codex、Claude、Cursor 和 Gemini 的用量限制与使用节奏现已显示在聊天环境、设置和紧凑控件中。",
  "Moss now reads provider credentials and usage data through shared server parsers, normalizes snapshots, stores cached values in SQLite, and renders reusable usage rows, progress tracks, line lists, and settings panels in the web app.":
    "Moss 现在通过服务器共享解析器读取服务商凭据和用量数据，对快照进行标准化处理，将缓存值存入 SQLite，并在 Web 应用中呈现可复用的用量行、进度条、明细列表和设置面板。",
  "Composer controls are easier to scan": "输入框控件更易浏览",
  "Model and options pickers are split more cleanly, empty threads keep the focused picker layout, and stacked composer panels have steadier sizing.":
    "模型与选项选择器的划分更加清晰，空白对话保留聚焦式选择器布局，层叠输入框面板的尺寸也更加稳定。",
  "The composer stack now uses shared panel content and sizing helpers, refreshed trait-picker behavior, tighter queued/live-change headers, and extra browser/unit coverage for compact controls and panel styles.":
    "输入框面板组现已采用共享的面板内容与尺寸辅助工具，更新了特性选择器行为，收紧了队列与实时变更标题的布局，并为紧凑控件和面板样式补充浏览器及单元测试。",
  "Desktop chrome and installers got sturdier": "桌面界面与安装包更加可靠",
  "Windows desktop builds now use a more reliable custom titlebar path, and Linux download metadata matches the current AppImage asset naming.":
    "Windows 桌面版现采用更可靠的自定义标题栏方案，Linux 下载元数据也已与当前 AppImage 产物命名保持一致。",
  "The desktop app gained centralized Windows caption controls, top-bar gutter handling, preload IPC support, font-family cleanup, and backend Node option tests, while the marketing download page now points at the `-x64` AppImage naming used by current releases.":
    "桌面应用新增统一管理的 Windows 窗口标题控件、顶部栏间距处理、预加载 IPC 支持、字体族清理及后端 Node 选项测试；营销下载页现已指向当前版本使用的 `-x64` AppImage 命名。",
  "Long-running sessions recover under pressure": "长时间运行的会话在高负载下也能恢复",
  "Backend memory diagnostics, WebSocket backpressure handling, and live stream recovery were tightened so heavy sessions stay predictable.":
    "后端内存诊断、WebSocket 背压处理及实时流恢复机制得到强化，让高负载会话仍保持可预测。",
  "This release adds memory diagnostics, stream backpressure guards, buffered provider-runtime ingestion coverage, and Codex app-server recovery fixes to keep partial streams and reconnects from leaving the UI stale.":
    "本次更新加入内存诊断、流背压防护、服务商运行时缓冲接入测试，以及 Codex app-server 恢复修复，避免不完整数据流和重连导致界面状态过期。",
  "Small UI fixes landed across chat and navigation": "聊天与导航迎来多项界面修复",
  "Plugin mention icons stay correct after sending, sidebars and search palettes have sharper state, and chat/task rows picked up focused polish.":
    "发送后插件提及图标仍能正确显示，侧边栏与搜索面板的状态更加明确，聊天行和任务行也获得了针对性优化。",
  "Mention-chip icon logic, composer mention parsing, sidebar route metadata, search palette tests, active task cards, right-dock layout, root route chrome, and settings navigation all received focused fixes.":
    "提及标签图标逻辑、输入框提及解析、侧边栏路由元数据、搜索面板测试、活动任务卡片、右侧停靠区布局、根路由界面框架及设置导航均已完成针对性修复。",
  "Transcript markers make long chats easier to navigate": "对话记录标记让长对话更易导航",
  "You can now mark important transcript moments, jump back to them, and manage them from the Environment panel without losing your place in busy threads.":
    "现在可以标记对话记录中的重要时刻、快速返回，并在“环境”面板中管理这些标记，即使对话繁忙也不会丢失当前位置。",
  "Markers now round-trip through orchestration events, projection storage, migrations, shared validation helpers, transcript selection actions, highlighted markdown spans, marker-aware scrolling, and focused browser/unit coverage.":
    "标记现可完整贯通编排事件、状态映射存储、迁移、共享校验辅助工具、对话记录选择操作、Markdown 高亮片段及感知标记的滚动逻辑，并补充了针对性的浏览器与单元测试。",
  "Links show real site identity": "链接展示真实网站标识",
  "AI response links, source lists, composer chips, and sent user bubbles now share the same link parsing path with website favicons instead of generic globe icons.":
    "AI 回复链接、来源列表、输入框标签和已发送的用户气泡现已共用同一套链接解析流程，并以网站 favicon 取代通用地球图标。",
  "Moss now caches site favicons server-side, serves authenticated favicon image URLs, recognizes bare domains in composer text, and keeps markdown link text aligned with the same medium-weight chip styling used while composing.":
    "Moss 现在会在服务器端缓存网站 favicon，提供需身份验证的 favicon 图片 URL，识别输入框文本中的裸域名，并让 Markdown 链接文本与编辑时使用的中等字重标签样式保持一致。",
  "Local dev servers are easier to spot": "本地开发服务器更易识别",
  "The Environment panel can now show local servers tied to the current project, with clearer browser/terminal identity and controls for tracked project runs.":
    "“环境”面板现在可以显示与当前项目关联的本地服务器，并为已追踪的项目运行提供更清晰的浏览器与终端标识及控制项。",
  "The server now monitors listening processes with address-family metadata, tracks project-run ownership, syncs local server state over WebSocket/RPC contracts, and adds sidebar/project-run affordances for starting, viewing, and stopping dev servers.":
    "服务器现在会监控监听中的进程并记录地址族元数据、追踪项目运行归属，通过 WebSocket/RPC 协议同步本地服务器状态，同时在侧边栏和项目运行界面中加入启动、查看及停止开发服务器的操作入口。",
  "Transcript scrolling is calmer": "对话记录滚动更加稳定",
  "Collapsed work sections no longer drag the transcript tail, marker navigation is more predictable, and thread rendering does less surprising work while sessions update.":
    "折叠的工作区段不再拖动对话记录末尾，标记导航更加可预测，会话更新期间的对话渲染也减少了意外行为。",
  "The timeline path now separates marker scroll behavior from live-output sticking, avoids retriggering tail scrolls for collapsed work disclosure changes, and has extra coverage around marker selection, rendering, and scrolling.":
    "时间线逻辑现已将标记滚动与实时输出跟随分离，避免折叠工作区段的展开状态变化再次触发末尾滚动，并补充了标记选择、渲染和滚动相关测试。",
  "Small orchestration and shortcut fixes landed too": "编排与快捷键也迎来多项修复",
  "Thread orchestration, terminal identity, recent view switching, retired-model shortcuts, and local-server cleanup picked up focused reliability fixes.":
    "对话编排、终端标识、最近视图切换、已停用模型快捷键及本地服务器清理均获得针对性的可靠性改进。",
  "This release tightens provider/runtime event projection, terminal visual identity, local-server process cleanup, recent-view key handling, and retired model picker shortcuts, with new tests for the affected contracts and stores.":
    "本次更新强化了服务商与运行时事件的状态映射、终端视觉标识、本地服务器进程清理、最近视图按键处理及已停用模型的选择器快捷键，并为受影响的协议和状态存储新增测试。",
  "Desktop updates are packaged more reliably": "桌面更新打包更加可靠",
  "The macOS release path now has stronger artifact smoke checks, zip finalization helpers, and updater download coverage so new builds are easier to trust before they ship.":
    "macOS 发布流程现已加强构建产物冒烟检查、zip 收尾辅助工具和更新程序下载测试，让新版本在发布前更值得信赖。",
  "Release tooling now validates Mac update artifacts, parses boolean environment flags consistently, and tests the resumable update downloader without the older update-feed cache layer. The README and release docs were refreshed around the current Moss desktop flow too.":
    "发布工具现在会验证 Mac 更新产物、统一解析布尔型环境标志，并在不使用旧版更新源缓存层的情况下测试可续传更新下载器。README 和发布文档也已按当前 Moss 桌面流程更新。",
  "The diff panel is easier to navigate": "差异面板更易导航",
  "Diff review now has a cleaner toolbar, file list, jump menu, and patch viewport so repository and turn changes are easier to scan without losing context.":
    "差异审阅现拥有更清爽的工具栏、文件列表、跳转菜单和补丁视口，让仓库及轮次变更更易浏览，同时不会丢失上下文。",
  "The large diff panel was split into focused components with explicit repo-vs-turn view logic, shared selectors, searchable file filtering, and tests for the new source-resolution behavior.":
    "大型差异面板已拆分为职责明确的组件，加入清晰的仓库与轮次视图逻辑、共享选择器、可搜索的文件筛选，并为新的来源解析行为补充测试。",
  "Queued chat turns stay chat turns": "排队的聊天轮次仍保持聊天模式",
  "Queued follow-ups now preserve their own mode and attachments even when the live composer is sitting in a plan follow-up state.":
    "排队的后续消息现在会保留各自的模式和附件，即使当前输入框正处于计划后续状态也不受影响。",
  "Queue draining now dispatches the queued turn payload directly, keeps in-progress composer drafts intact, and has browser coverage for plan-mode threads with pending follow-ups and image attachments.":
    "队列处理现在会直接分派排队轮次的载荷，保留正在编辑的输入框草稿，并新增浏览器测试，覆盖存在待处理后续消息和图片附件的计划模式对话。",
  "Composer panels line up cleanly": "输入框面板整齐对齐",
  "Plan activity, queued follow-ups, and live file-change panels now share one frame style above the composer, with consistent width, borders, radius, and dark-mode opacity.":
    "计划活动、排队的后续消息和实时文件变更面板现在共用输入框上方的统一框架样式，宽度、边框、圆角及深色模式透明度均保持一致。",
  "The stacked composer chrome now flows through a shared panel wrapper and rail sizing token, while the file-change strip only appears for active turns that actually contain provider file edits.":
    "层叠输入框界面现统一采用共享面板容器和轨道尺寸 token；文件变更栏仅在活动轮次确实包含服务商文件编辑时显示。",
  "Markdown and mention menus got sharper": "Markdown 与提及菜单更加精致",
  "Chat markdown spacing, composer command selection, plugin discovery, file icons, and mention rendering were tightened so selected references look the same before and after sending.":
    "聊天 Markdown 间距、输入框命令选择、插件发现、文件图标及提及渲染均已优化，让选中的引用在发送前后保持一致。",
  "Provider discovery now normalizes aliases and built-in metadata more carefully, command menu grouping is simpler, markdown blocks have better visual rhythm, and sent user bubbles preserve the selected file/plugin icon instead of falling back to generic text.":
    "服务商发现现在会更谨慎地标准化别名和内置元数据，命令菜单分组更加简洁，Markdown 区块的视觉节奏更佳，已发送的用户气泡也会保留所选文件或插件图标，不再退回通用文本样式。",
  "Important work can stay pinned": "重要内容可以持续置顶",
  "Projects, threads, and specific transcript messages can now be pinned so the context you keep returning to stays close at hand across sessions.":
    "现在可以置顶项目、对话及特定对话记录消息，让经常查看的上下文在不同会话中始终触手可及。",
  "Pin state is now projected through the orchestration model, stored in dedicated persistence columns, reconciled for older databases, and shared with focused client stores so sidebar ordering, project rows, and thread detail all agree after reloads.":
    "置顶状态现已贯通编排模型的状态映射，存入专用持久化字段，并与旧数据库数据进行协调；同时通过专用客户端状态存储共享，确保重新载入后侧边栏排序、项目行和对话详情保持一致。",
  "Thread context has a memory shelf": "对话上下文新增记忆区",
  "The environment panel now carries pinned messages and editable notes, giving long-running chats a durable place for decisions, constraints, and useful references.":
    "“环境”面板现在包含置顶消息和可编辑笔记，为长时间运行的聊天提供长期保存决策、约束及实用引用的位置。",
  "Pinned message actions round-trip through server commands and snapshots, while thread notes autosave through the same projected thread detail path. This keeps the side panel useful without turning the transcript itself into a scratchpad.":
    "置顶消息操作现可通过服务器命令和快照完整同步，对话笔记则通过同一套状态映射后的对话详情流程自动保存。这样既能保持侧边面板实用，也无需将对话记录当作临时记事区。",
  "Jump between recent views faster": "更快切换最近视图",
  "A new recent-view switcher lets you move through recent chats, terminals, and workspace surfaces with keyboard-first navigation and visible keycap hints.":
    "全新的最近视图切换器支持通过键盘优先的导航方式，在最近聊天、终端和工作区界面之间移动，并显示清晰的键帽提示。",
  "Recent views are tracked in a dedicated store, activated through shared route logic, and covered by browser and unit tests so switching does not lose terminal/workspace state or collide with existing global shortcuts.":
    "最近视图由专用状态存储追踪，通过共享路由逻辑激活，并由浏览器和单元测试覆盖，确保切换时不会丢失终端或工作区状态，也不会与现有全局快捷键冲突。",
  "Recent views are tracked in a dedicated store, activated through shared route logic, and covered by browser and unit tests so switching does not lose terminal state or collide with existing global shortcuts.":
    "最近视图由专用状态存储追踪，通过共享路由逻辑激活，并由浏览器和单元测试覆盖，确保切换时不会丢失终端状态，也不会与现有全局快捷键冲突。",
  "Composer references behave better": "输入框引用表现更佳",
  "Mention chips, draft restoration, queued composer headers, picker sizing, and empty-chat controls were cleaned up so references stay readable while you build prompts.":
    "提及标签、草稿恢复、队列输入框标题、选择器尺寸及空白聊天控件均已优化，让构建提示词时引用内容始终清晰易读。",
  "Mention parsing now has shared helpers and tests, composer drafts keep stronger thread/project references, and compact controls use consistent iconography across the empty state and active chat surface.":
    "提及解析现已配备共享辅助工具和测试，输入框草稿可更稳妥地保留对话与项目引用，紧凑控件也在空白状态和活动聊天界面中采用一致的图标体系。",
  "Desktop updates can resume": "桌面更新支持续传",
  "The desktop updater now has resumable download infrastructure with coverage for partial files, retries, checksum-style state, and release browser test fixes.":
    "桌面更新器现已具备断点续传下载基础设施，涵盖不完整文件处理、重试、校验和式状态管理，并修复了发布版本的浏览器测试。",
  "The update downloader writes through a dedicated resumable path, validates persisted metadata, handles interrupted ranges, and is tested separately from the Electron main process wiring so future updater changes have a sturdier base.":
    "更新下载器通过专用的断点续传路径写入数据，会验证持久化元数据并处理中断的分段下载；相关逻辑与 Electron 主进程接线分开测试，为后续更新器改动打下更稳固的基础。",
  "Git actions know when pull is available": "Git 操作会准确判断能否拉取",
  "Git action controls now surface pull availability more accurately and avoid offering branch actions that cannot safely run for the current repository state.":
    "Git 操作控件现在能更准确地显示拉取是否可用，并避免提供在仓库当前状态下无法安全执行的分支操作。",
  "The Git core contract, broadcaster, React query helpers, and UI control logic now carry pull availability together, so action buttons line up with upstream/behind checks instead of guessing locally in the component.":
    "Git 核心契约、广播器、React 查询辅助函数和 UI 控制逻辑现在会一并传递拉取可用性，让操作按钮依据上游和落后状态检查显示，不再由组件自行猜测。",
  "Runtime failures are easier to survive": "运行时故障后更易恢复",
  "External Claude shutdowns, terminal cleanup, websocket RPC errors, and provider session recovery picked up extra guards for reconnects and interrupted work.":
    "针对外部 Claude 关闭、终端清理、WebSocket RPC 错误和服务商会话恢复，新增了更多重连和工作中断保护。",
  "Claude SIGTERM from outside Moss is treated as a benign suspend path, terminal process cleanup has stronger tests, and websocket RPC failure handling is less likely to leave the UI believing a request is still in flight.":
    "从 Moss 外部向 Claude 发送的 SIGTERM 现在会被视为正常的挂起流程；终端进程清理测试更加完善，WebSocket RPC 故障处理也更不易让 UI 误以为请求仍在进行。",
  "Migrations and release checks got sharper": "迁移与发布检查更加严谨",
  "Pinned-state migrations, snapshot projection tests, browser release tests, shortcut tests, and shared pinning logic were expanded to keep this deeper state model predictable.":
    "扩充了置顶状态迁移、快照状态映射测试、浏览器发布测试、快捷键测试和共享置顶逻辑，确保更深入的状态模型仍然可预测。",
  "New migrations cover pinned messages, thread notes, and project pins; legacy pinned-thread reconciliation was tightened; and the release suite now exercises the new state through contracts, server projection, shared helpers, and web UI logic.":
    "新增迁移涵盖置顶消息、对话备注和项目置顶；进一步收紧了旧版置顶对话的协调逻辑；发布测试套件现在会通过契约、服务端状态映射、共享辅助函数和 Web UI 逻辑检验新状态。",
  "The chat side panel is clearer": "聊天侧边面板更清晰",
  "Thread activity, agent detail rows, environment controls, Git actions, branch controls, and queued composer state were tightened so the main chat and side panel stay easier to scan during busy sessions.":
    "优化了对话活动、智能体详情行、环境控件、Git 操作、分支控件和排队中的输入框状态，让繁忙会话中的主聊天区与侧边面板更易浏览。",
  "Long chats can be recapped in place": "长对话可就地生成摘要",
  "Moss can now generate and cache thread recaps, show current-state context in the chat environment, and reuse provider-backed recap generation without making the transcript harder to follow.":
    "Moss 现在可以生成并缓存对话摘要，在聊天环境中显示当前状态上下文，还能复用由服务商支持的摘要生成能力，同时保持对话记录清晰易读。",
  "Large diffs do less duplicate work": "大型差异减少重复计算",
  "Repo diff totals are computed once for the active chat and shared between the header and environment panel, with memoized patch stats to avoid re-parsing the same large diff during live updates.":
    "当前聊天的仓库差异总量现在只计算一次，并在标题栏与环境面板之间共享；补丁统计也已加入记忆化处理，避免实时更新时重复解析同一份大型差异。",
  "Archived cleanup is more immediate": "归档清理即时生效",
  "Deleting archived threads now goes through one shared client path, removes rows optimistically, batches worktree-linked deletes, and reconciles once with the latest server snapshot.":
    "删除已归档对话现在统一通过一条客户端路径执行：先以乐观方式移除列表行，批量处理关联工作树的删除操作，再与服务端最新快照统一协调一次。",
  "Terminals and transcripts are safer under load": "终端与对话记录在高负载下更安全",
  "Terminal runtime cleanup, provider activity ingestion, transcript rendering, and session handoff logic picked up extra safeguards for reconnects, shell summaries, agent activity, and active task rendering.":
    "终端运行时清理、服务商活动接入、对话记录渲染和会话移交逻辑新增了更多保护，可更稳妥地处理重连、Shell 摘要、智能体活动和进行中任务的渲染。",
  "Desktop update prompts are quieter": "桌面更新提示更安静",
  "Background update polling no longer exposes a manual check button at the wrong time, update state is restored more predictably, and production builds keep source maps off unless a diagnostic release opts in.":
    "后台更新轮询不再在不合适的时机显示手动检查按钮，更新状态恢复更加可预测；生产构建默认关闭 source map，除非诊断版本明确启用。",
  "Small release-readiness fixes landed too": "其他发布就绪细节也已修复",
  "Image attachment expectations, optional callback typing, recap test doubles, composer spacing, reference chips, and queued row styling were aligned with the current UI so the final check suite stays green.":
    "图片附件预期、可选回调类型、摘要测试替身、输入框间距、引用标签和排队行样式均已与当前 UI 对齐，确保最终检查套件持续通过。",
  "Terminals are lighter": "终端运行更轻快",
  "Terminal output now does less work end-to-end: batching, renderer acknowledgements, smarter backpressure, cheaper history updates, and more faithful reconnect replay keep busy terminals lighter under noisy commands and long-running TUIs.":
    "终端输出现在全链路减少了处理开销：批处理、渲染器确认、更智能的背压、更低成本的历史记录更新，以及更忠实的重连回放，让繁忙终端在高输出命令和长时间运行的 TUI 下依然轻快。",
  "Terminal workspaces feel cleaner": "终端工作区更清爽",
  "Terminal-only workspaces skip hidden chat work, panes move between layouts without remount churn, close prompts only appear when a tab is active or needs attention, and terminal font/color settings now follow the active theme.":
    "纯终端工作区会跳过隐藏的聊天处理；面板可在不同布局间移动而无需反复重新挂载；关闭提示仅在标签页处于活动状态或需要关注时出现；终端字体和颜色设置现在也会跟随当前主题。",
  "OpenCode starts faster and fails louder": "OpenCode 启动更快，故障信息更明确",
  "Local OpenCode servers are pooled for recent sessions, startup waits longer before timing out, session creation runs alongside inventory discovery, and failure details now include redacted command output instead of vague startup errors.":
    "近期会话会复用本地 OpenCode 服务；启动超时时间有所延长；会话创建与清单发现并行进行；故障详情现在会包含已脱敏的命令输出，不再只有含糊的启动错误。",
  "Provider health checks are less jumpy": "服务商健康检查更稳定",
  "Slow Claude and OpenCode probes get longer timeouts, transient command timeouts no longer make a previously ready provider look broken, and Claude auth refreshes invalidate cached subscription state.":
    "较慢的 Claude 和 OpenCode 探测获得了更长的超时时间；临时命令超时不再让此前已就绪的服务商显示为故障；Claude 身份验证刷新也会使缓存的订阅状态失效。",
  "Claude resumes recover from stale native sessions": "Claude 可从失效的原生会话中恢复",
  "When Claude reports a missing conversation id, Moss clears the stale resume cursor, recreates the provider session, and retries with transcript context instead of leaving the turn failed.":
    "当 Claude 报告 conversation id 不存在时，Moss 会清除失效的续接游标，重新创建服务商会话，并携带对话记录上下文重试，避免该轮次直接失败。",
  "Desktop updates now have a manual escape hatch": "桌面更新新增手动备用方案",
  "If an in-app install silently fails, Moss restarts the backend, resumes update polling, deduplicates error toasts, and points you at the exact GitHub release page for a manual download.":
    "如果应用内安装无提示失败，Moss 会重启后端、恢复更新轮询、合并重复的错误提示，并提供对应 GitHub 发布页面的准确链接，方便手动下载。",
  "macOS desktop chrome stays aligned": "macOS 桌面框架保持对齐",
  "Traffic-light placement and renderer gutter spacing now share one geometry helper and react to Electron zoom changes, keeping top-bar controls lined up across chat, settings, and workspace views.":
    "红黄绿窗口按钮的位置与渲染器边距现在共用同一个几何辅助函数，并会响应 Electron 缩放变化，让聊天、设置和工作区视图的顶部栏控件始终对齐。",
  "Settings and appearance controls are easier to scan": "设置与外观控件更易浏览",
  "Theme selection moved to a segmented control, settings rows share tighter typography, provider update failures can expose a copyable manual command, and custom binary-path confirmations survive restarts.":
    "主题选择改用分段控件，设置行采用更紧凑统一的排版；服务商更新失败时可显示一条可复制的手动命令；自定义二进制路径确认状态也能在重启后保留。",
  "Agent task activity is easier to follow": "智能体任务活动更易追踪",
  "OpenCode task child sessions and newer shell-step events now flow into Moss's activity timeline, while generic agent task rows keep their useful prompt and result text instead of disappearing or showing wrapper noise.":
    "OpenCode 任务子会话和新版 Shell 步骤事件现在会进入 Moss 活动时间线；通用智能体任务行会保留有用的提示词和结果文本，不再消失或显示外层封装杂音。",
  "Reconnect state is visible to UI runtimes": "UI 运行时可感知重连状态",
  "The web transport now publishes local WebSocket state changes, giving terminal recovery and other renderer code a cleaner signal when the server reconnects or closes.":
    "Web 传输层现在会发布本地 WebSocket 状态变化，为终端恢复和其他渲染器代码提供更清晰的信号，以判断服务端何时重连或关闭连接。",
  "OpenCode support is much deeper": "OpenCode 支持大幅增强",
  "OpenCode startup, model discovery, command discovery, server connection options, and experimental WebSocket mode now flow through the same settings and runtime paths as the rest of Moss.":
    "OpenCode 启动、模型发现、命令发现、服务连接选项和实验性 WebSocket 模式现在都与 Moss 其他功能共用相同的设置与运行时路径。",
  "Slash commands respect your OpenCode setup": "斜杠命令会遵循 OpenCode 配置",
  "Composer slash-command discovery now uses the configured OpenCode binary, server URL, password state, and WebSocket mode, so command lists match the runtime you actually selected.":
    "输入框的斜杠命令发现现在会使用已配置的 OpenCode 二进制文件、服务 URL、密码状态和 WebSocket 模式，因此命令列表会与实际选择的运行时一致。",
  "Desktop updates are harder to get stuck": "桌面更新更不易卡住",
  "The updater now caches GitHub release metadata, preserves actionable update state across transient failures, detects stalled downloads, and clears stale same-version update payloads more deliberately.":
    "更新器现在会缓存 GitHub 发布元数据，在临时故障期间保留可操作的更新状态，检测停滞的下载，并更审慎地清理同版本的过期更新数据。",
  "The chat surface feels tighter": "聊天界面更紧凑",
  "Composer padding, button spacing, picker sizing, panel headers, banners, dock surfaces, and chat chrome were tuned so the main workspace reads cleaner without losing controls.":
    "调整了输入框内边距、按钮间距、选择器尺寸、面板标题栏、横幅、停靠区域和聊天框架，让主工作区更清爽，同时保留完整控件。",
  "Desktop chrome fits the OS better": "桌面框架更贴合操作系统",
  "macOS traffic-light spacing, sidebar seams, Electron card borders, motion, and titlebar controls were refined so the app frame feels more native on desktop.":
    "优化了 macOS 红黄绿窗口按钮间距、侧边栏接缝、Electron 卡片边框、动效和标题栏控件，让应用框架在桌面端更具原生质感。",
  "Large chats do less unnecessary work": "大型对话减少无效处理",
  "Markdown parsing is deferred more carefully, pending-interaction state is derived in one place, and transcript/session rendering avoids extra churn during busy or long-running chats.":
    "Markdown 解析会更谨慎地延后执行；待处理交互状态统一在一处派生；对话记录和会话渲染也会避免在繁忙或长时间运行的聊天中产生额外抖动。",
  "Settings back navigation lands in the right place": "从设置返回时定位正确",
  "The Settings sidebar back button now restores the last valid chat route, falls back to the newest live thread when needed, and drops stale split-view routes before navigating.":
    "设置侧边栏的返回按钮现在会恢复上一个有效的聊天路由；必要时回退到最新的活动对话；导航前还会移除失效的分屏视图路由。",
  "Chats and Workspace can be hidden": "可隐藏聊天与工作区",
  "New sidebar section toggles let you hide the standalone Chats footer list or the Workspace tab while keeping Threads always available.":
    "新增侧边栏区段开关，可隐藏独立的聊天底部列表或工作区标签页，同时始终保留对话列表。",
  "Chats can be hidden": "可隐藏聊天列表",
  "A new sidebar section toggle lets you hide the standalone Chats footer list while keeping Projects available.":
    "新增侧边栏区段开关，可隐藏独立的聊天底部列表，同时保留项目列表。",
  "Imported legacy databases recover missing columns": "导入的旧版数据库可补齐缺失列",
  "Fresh repair migrations reconcile older imported migration trackers that skipped Moss's sidechat-source or pinned-thread columns, preventing startup crashes in those upgraded histories.":
    "新增修复迁移会协调较旧的导入迁移记录，补上此前遗漏的 Moss sidechat-source 或 pinned-thread 列，防止这些升级后的历史数据导致启动崩溃。",
  "OpenCode looks better in dark mode": "OpenCode 深色模式显示更清晰",
  "The OpenCode provider icon now switches to a clearer reversed asset in dark mode, with sidebar and provider picker styling adjusted around it.":
    "OpenCode 服务商图标现在会在深色模式下切换为更清晰的反色资源，侧边栏和服务商选择器样式也已相应调整。",
  "Settings are easier to scan": "设置页面更易浏览",
  "Repeated boolean settings were consolidated into a shared row pattern, provider install rows got cleaner reset behavior, and OpenCode-specific controls sit with the rest of provider tools.":
    "重复的布尔设置已整合为共享行模式；服务商安装行的重置行为更加清晰；OpenCode 专属控件也已与其他服务商工具归为一处。",
  "Moss is now the default home": "Moss 现为默认主目录",
  "The app now starts from `~/.moss`, carries the Moss environment variables through the desktop and server runtime, and safely imports existing `~/.dpcode` or `~/.t3` data on first launch.":
    "应用现在从 `~/.moss` 启动，会在桌面端和服务端运行时中传递 Moss 环境变量，并在首次启动时安全导入已有的 `~/.dpcode` 或 `~/.t3` 数据。",
  "Desktop startup feels more native": "桌面启动更具原生体验",
  "Windows now hydrates the desktop environment from the registry so provider CLIs are found reliably, macOS keeps Liquid Glass styling only where it belongs, and older Macs get a rounded dock icon without breaking Tahoe.":
    "Windows 现在会从注册表载入桌面环境，确保可靠找到服务商 CLI；macOS 仅在合适的位置保留 Liquid Glass 样式；旧款 Mac 也会获得圆角 Dock 图标，同时不影响 Tahoe。",
  "Right dock and saved UI state are sturdier": "右侧停靠栏与已保存的界面状态更可靠",
  "Recovered browser, dock, sidechat, split-view, and panel state is now validated before use, preventing stale or corrupted localStorage from crashing the workspace.":
    "恢复浏览器、停靠栏、侧边聊天、分屏视图和面板状态前，现会先进行校验，避免过期或损坏的 localStorage 导致工作区崩溃。",
  "Composer pickers are cleaner": "输入框选择器更清爽",
  "The traits picker and shared menu styling were refreshed with a tighter layout, clearer selection states, and a calmer feel across model and composer controls.":
    "特性选择器和共享菜单样式已更新，布局更紧凑、选中状态更清晰，模型与输入框控件的整体体验也更稳定。",
  "Provider runtime noise is reduced": "服务商运行时干扰更少",
  "Claude thinking-token telemetry no longer floods the timeline, provider task warnings are deduplicated more carefully, and Codex home overlays avoid stale SQLite sidecar files during startup.":
    "Claude 的思考 token 遥测信息不再充斥时间线，服务商任务警告的去重更加严谨，Codex 主目录覆盖层启动时也会避开过期的 SQLite 附属文件。",
  "Small workflow details got sharper": "工作流细节更完善",
  "Context meter labels, edit actions, completion separators, Git controls, diff routing, desktop update retry state, and shortcut handling all picked up focused fixes for smoother day-to-day sessions.":
    "上下文用量标签、编辑操作、完成分隔线、Git 控件、diff 路由、桌面端更新重试状态和快捷键处理均获得针对性修复，让日常会话更加顺畅。",
  "Claude Opus 4.8 is available": "Claude Opus 4.8 现已可用",
  "Moss now includes Claude Opus 4.8 in the Claude model picker.":
    "Moss 的 Claude 模型选择器现已加入 Claude Opus 4.8。",
  "Grok Build models stay current": "Grok Build 模型保持最新",
  "Grok model discovery now combines the CLI with xAI language-model metadata, including API aliases, so Grok Build and code-fast variants appear in the picker without waiting for another manual app update.":
    "Grok 模型发现现会结合 CLI 与 xAI 语言模型元数据（包括 API 别名），让 Grok Build 和 code-fast 变体无需等待下一次手动应用更新即可出现在选择器中。",
  "Provider choices wait for real readiness": "服务商选项会等待真正就绪",
  "The provider picker no longer treats unknown provider status as usable. Providers stay in a checking state until Moss has confirmed that the local runtime is available and authenticated.":
    "服务商选择器不再将状态未知的服务商视为可用。只有 Moss 确认本地运行时可用且已通过身份验证后，服务商才会结束检查状态。",
  "Desktop shutdown is calmer": "桌面端退出更稳定",
  "The desktop backend now shuts down more deliberately on quit, reducing noisy restarts and preserving a cleaner thread sync path when the app is closing.":
    "桌面端后端现在会在退出时更有序地关闭，减少不必要的重启，并在应用关闭期间保持更清晰的对话同步路径。",
  "Large histories sync with less work": "大型历史记录同步更省资源",
  "Snapshot queries, checkpoint reads, and transcript updates picked up more focused data paths, keeping busy workspaces lighter when sessions reconnect or histories grow.":
    "快照查询、检查点读取和对话记录更新采用了更聚焦的数据路径，在会话重连或历史记录增长时减轻繁忙工作区的负担。",
  "Diffs and transcripts feel steadier": "Diff 与对话记录更加稳定",
  "Whitespace diff controls, thread title updates, copy metadata, and live transcript rows received targeted fixes so common review and resume flows update more predictably.":
    "空白字符 diff 控件、对话标题更新、复制元数据和实时对话记录行均获得针对性修复，让常见的审阅与恢复流程更新得更可预测。",
  "Grok joins Moss": "Grok 加入 Moss",
  "Pick Grok as a first-class coding provider with ACP-backed sessions, model selection, approval handling, resume support, provider health checks, settings, icons, and handoff wired through the same app surfaces as the rest of your agents.":
    "现在可将 Grok 作为一等编码服务商使用，并通过 ACP 支持会话、模型选择、批准处理、恢复、服务商健康检查、设置、图标和交接；这些能力与其他智能体共用相同的应用界面。",
  "Provider fallbacks and desktop menus behave better": "服务商回退与桌面菜单表现更好",
  "Provider startup and recovery paths are more forgiving when preferred runtimes are unavailable, and desktop menu shortcuts now line up more reliably with the active workspace.":
    "首选运行时不可用时，服务商启动和恢复路径现在更具容错性；桌面菜单快捷键也能更可靠地与当前工作区保持一致。",
  "Large histories stay lighter": "大型历史记录保持轻量",
  "Snapshot hydration, diagnostics, and capped history paths now do less unnecessary work, reducing memory pressure when busy sessions or large workspaces reconnect.":
    "快照状态载入、诊断和设有上限的历史记录路径现已减少不必要的处理，降低繁忙会话或大型工作区重连时的内存压力。",
  "Pi and OpenCode edge cases are smoother": "Pi 与 OpenCode 的边缘情况更顺畅",
  "Pi aborts now read as interruptions, thinking levels are clamped more safely, live sidebar updates are steadier, and OpenCode/provider update handling picked up targeted reliability fixes.":
    "Pi 的中止操作现在会显示为中断，思考级别的限制更安全，侧边栏实时更新更稳定，OpenCode 与服务商更新处理也获得了针对性的可靠性修复。",
  "Answers survive the RPC hop": "回答可完整通过 RPC",
  "User-input answers are preserved through the JSON-RPC codec, which keeps pending provider questions from losing their payload as they move between the app and server.":
    "用户输入的回答现会完整保留在 JSON-RPC 编解码过程中，避免待处理的服务商问题在应用与服务器之间传递时丢失内容。",
  "Pi gets a much sturdier seat at the table": "Pi 的服务商支持更加可靠",
  "Pi provider sessions now benefit from tighter lifecycle handling, clearer extension-limit warnings, and provider probes that respect the binaries configured in settings.":
    "Pi 服务商会话现拥有更严密的生命周期处理、更清晰的扩展限制警告，并且服务商探测会遵循设置中配置的可执行文件。",
  "Providers can keep themselves fresher": "服务商可自动保持更新",
  "Provider auto-update plumbing landed across the app, making it easier to keep agent runtimes current without turning setup and maintenance into a separate chore.":
    "服务商自动更新能力现已贯通整个应用，无需将配置和维护变成额外负担，也能更轻松地让智能体运行时保持最新。",
  "Create PR only appears when it can actually work": "仅在确实可用时显示“创建 PR”",
  "Create-PR actions now check upstream branch and availability state more carefully, so the UI is quieter until the repository is ready for a real pull request.":
    "“创建 PR”操作现在会更严格地检查上游分支和可用状态；在仓库真正可以创建拉取请求前，界面会保持简洁。",
  "Pending questions stop advancing at the wrong time": "待处理问题不再错误推进",
  "Pending user-input auto-advance now cancels on question changes and in-flight responses, reducing stale answers and empty submissions in interrupted provider flows.":
    "当问题发生变化或回答仍在传输时，待处理用户输入的自动推进会取消，减少服务商流程中断后提交过期回答或空内容的情况。",
  "Git status and provider transcripts read cleaner": "Git 状态与服务商对话记录更清晰",
  "Git status refreshes, pull-error messaging, Kilo/OpenCode transcript handling, repo diff scopes, and provider install docs links all picked up focused reliability polish.":
    "Git 状态刷新、拉取错误提示、Kilo/OpenCode 对话记录处理、仓库 diff 范围和服务商安装文档链接均获得了针对性的可靠性优化。",
  "Image attachments stay visible after sending": "图片附件发送后仍保持可见",
  "Persisted image previews now load through the same reliable byte-serving path as local generated images, fixing the brief preview flash followed by broken attachment thumbnails.":
    "持久化图片预览现在与本地生成图片共用可靠的字节内容服务路径，修复预览短暂出现后附件缩略图随即损坏的问题。",
  "Kilo Code joins the provider lineup": "Kilo Code 加入服务商阵容",
  "Moss can now launch and monitor Kilo Code sessions alongside Codex, Claude, Cursor, OpenCode, and Gemini, with health checks, settings, mentions, handoff, and model compatibility wired through the app.":
    "Moss 现在可与 Codex、Claude、Cursor、OpenCode 和 Gemini 一同启动并监控 Kilo Code 会话，同时支持健康检查、设置、提及、交接和模型兼容性。",
  "Provider order is now yours to arrange": "服务商顺序可自由调整",
  "The settings screen now lets you drag providers into the order that fits your workflow, and the composer, sidebar, search palette, and plugin surfaces follow the same custom ordering.":
    "现在可在设置页面拖动服务商，按工作流需要排列顺序；输入框、侧边栏、搜索面板和插件界面也会遵循同一套自定义排序。",
  "Cleaner OpenCode and Kilo transcript updates": "OpenCode 与 Kilo 的对话记录更新更清晰",
  "Synthetic snapshot progress is filtered more carefully, so restored or refreshed provider output avoids repeating internal progress text while keeping real assistant activity intact.":
    "合成快照进度现在会经过更严格的过滤，避免恢复或刷新的服务商输出重复显示内部进度文本，同时完整保留智能体的真实活动。",
  "Diff totals are easier to trust at a glance": "Diff 汇总数据一目了然且更可信",
  "The chat header now owns unified diff totals, keeping added and removed line counts consistent between the header and diff panel as content refreshes.":
    "聊天标题栏现在统一管理 diff 汇总数据，内容刷新时，新增与删除行数会在标题栏和 diff 面板之间保持一致。",
  "OpenCode sessions understand the latest event stream": "OpenCode 会话支持最新事件流",
  "Moss now tracks the newer OpenCode SDK session events, keeps titles fresher, and has much deeper coverage around OpenCode startup, output, and recovery flows.":
    "Moss 现在会跟踪新版 OpenCode SDK 会话事件，及时更新标题，并大幅加强 OpenCode 启动、输出和恢复流程的覆盖。",
  "Interrupted turns recover more predictably": "中断的轮次恢复更可预测",
  "Ready and idle transitions now clear or restore turn state more carefully, reducing stuck busy states after reconnects, restarts, and partial provider streams.":
    "进入就绪和空闲状态时，现在会更谨慎地清除或恢复轮次状态，减少重连、重启及服务商流不完整后卡在忙碌状态的情况。",
  "Cursor model choices follow live ACP metadata": "Cursor 模型选项跟随实时 ACP 元数据",
  "Cursor model selection now normalizes against the provider's current ACP options instead of relying on stale context traits, so the composer better matches what Cursor can actually run.":
    "Cursor 模型选择现在会根据服务商当前的 ACP 选项进行规范化，不再依赖过期的上下文特性，因此输入框能更准确地反映 Cursor 实际可运行的模型。",
  "Diff and pinned-thread state stay in sync": "Diff 与置顶对话状态保持同步",
  "Projection, sidebar, and store updates now carry pinned-thread metadata through the app, while the diff panel handles refreshed content with fewer display glitches.":
    "状态映射、侧边栏和存储更新现在会在应用内完整传递对话置顶元数据；diff 面板处理刷新内容时也减少了显示异常。",
  "Small workflow polish for Git and keybindings": "Git 与快捷键工作流细节优化",
  "Git summaries are clearer for rename-like moves into untracked folders, and routine keybinding reloads no longer pop a success toast every time they quietly refresh.":
    "对于文件移动到未跟踪目录等类似重命名的情况，Git 摘要现在更清晰；日常快捷键配置静默刷新时，也不会再反复弹出成功提示。",
  "Codex image generation now renders in chat": "Codex 生成的图片现可在聊天中显示",
  "Generated images from Codex are captured as local artifacts, rendered inline in assistant messages, and include expand and download controls without dragging bulky base64 payloads through the transcript.":
    "Codex 生成的图片会作为本地产物保存并内嵌显示在智能体消息中，同时提供展开和下载控件，无需在对话记录中传输庞大的 base64 内容。",
  "Generated images use a safer local route": "生成图片使用更安全的本地路径",
  "Moss now serves generated files through a dedicated local-image endpoint with MIME checks, workspace-aware path resolution, and Codex generated_images allowlists for both the normal home and desktop overlay home.":
    "Moss 现在通过专用的本地图片端点提供生成文件，并加入 MIME 检查、基于工作区的路径解析，以及同时适用于普通主目录和桌面端覆盖主目录的 Codex generated_images 允许列表。",
  "Provider favorites are quicker to manage": "服务商收藏管理更快捷",
  "The provider model picker gained native favorite toggles and cleaner context-menu separators, making large Codex, Cursor, and OpenCode model lists easier to shape around the models you actually use.":
    "服务商模型选择器新增原生收藏开关和更清晰的上下文菜单分隔线，让庞大的 Codex、Cursor 和 OpenCode 模型列表更容易围绕常用模型进行整理。",
  "Old inactive threads hide after seven days": "超过七天未活动的旧对话将自动隐藏",
  "The retention job now hides stale inactive threads from the app in batches, publishes maintenance progress, and protects running work and approvals while keeping database history available for long-term stats.":
    "保留任务现在会分批在应用中隐藏长期未活动的对话、发布维护进度，并保护正在运行的工作和待批准事项，同时继续保留数据库历史记录以供长期统计。",
  "Transport and server edges are steadier": "传输与服务器边缘流程更稳定",
  "WebSocket HTTP URL helpers, lifecycle events, provider runtime ingestion, and chat-route plumbing were tightened so generated artifacts and cleanup events move through the app more predictably.":
    "WebSocket HTTP URL 辅助函数、生命周期事件、服务商运行时数据接入和聊天路由已得到强化，让生成产物与清理事件在应用中的传递更加可预测。",
  "Cursor is now a first-class Moss provider": "Cursor 现已成为 Moss 的一等服务商",
  "Run Cursor CLI sessions directly from Moss with ACP-backed startup, model discovery, existing-chat resume, handoff, and provider health checks alongside Codex and OpenCode.":
    "现在可直接在 Moss 中运行 Cursor CLI 会话，并通过 ACP 支持启动、模型发现、现有聊天恢复、交接和服务商健康检查，与 Codex 和 OpenCode 并列使用。",
  "New Effect TS ACP runtime": "新增 Effect TS ACP 运行时",
  "The new Effect TS ACP package owns generated schemas, JSON-RPC transport, client and agent helpers, terminal release handling, and protocol tests so provider integrations have a sturdier core.":
    "新的 Effect TS ACP 包统一管理生成的 schema、JSON-RPC 传输、客户端与智能体辅助功能、终端释放处理和协议测试，为服务商集成提供更稳固的核心。",
  "The server moved onto Effect RPC": "服务端迁移至 Effect RPC",
  "WebSocket routing, auth, readiness, settings, environment, git status, and orchestration flows were rebuilt around Effect services so reconnects and failure paths stay more predictable.":
    "WebSocket 路由、身份验证、就绪状态、设置、环境、Git 状态和编排流程已围绕 Effect 服务重构，让重连和故障处理更加可预测。",
  "Cursor output is easier to read and resume": "Cursor 输出更易阅读和续接",
  "Cursor reasoning, tool progress, usage events, plan updates, composer behavior, and model-selection compatibility now render more consistently across fresh and resumed threads.":
    "无论是新建还是恢复的对话，Cursor 的推理内容、工具进度、用量事件、计划更新、输入框行为和模型选择兼容性现在都能以更一致的方式呈现。",
  "Busy sessions stay calmer": "繁忙会话更稳定",
  "Sidebar project recovery, visible-thread PR lookups, task banner resizing, stale target repair, sidechat split handling, and compact chat controls were tightened for heavier day-to-day use.":
    "优化了侧边栏项目恢复、可见对话的 PR 查询、任务横幅尺寸调整、失效目标修复、侧聊分屏处理和紧凑型聊天控件，更从容地应对高强度日常使用。",
  "Sidechat threads are easier to track": "侧聊对话更易追踪",
  "Sidechat source metadata now flows through projections, filters, and snapshots so secondary threads stay easier to separate from the main conversation.":
    "侧聊来源元数据现已贯通状态映射、筛选器和快照，让次要对话更容易与主对话区分。",
  "Desktop startup feels faster": "桌面端启动更快",
  "Packaged desktop builds now open the app window before backend readiness finishes, reducing the blank-start feeling while services come online.":
    "打包后的桌面版现在会在后端就绪前先打开应用窗口，减少服务启动期间面对空白窗口的等待感。",
  "Git gained commit and push": "Git 新增提交与推送",
  "The Git actions menu can now commit current work and push it from Moss, keeping the common release and handoff flow closer to the chat.":
    "Git 操作菜单现在可直接在 Moss 中提交当前工作并推送，让常用的发布与交接流程更贴近聊天体验。",
  "Task controls are clearer": "任务控件更清晰",
  "Active task controls were tightened, and approval counts are now separated from user input requests so pending work is easier to read at a glance.":
    "优化了进行中任务的控件，并将审批数量与用户输入请求分开显示，待处理工作一眼即可看清。",
  "Browser-use now drives the visible browser": "browser-use 现可操控可见浏览器",
  "The desktop browser and browser-use tools now share the same visible webview, so automation, screenshots, navigation, and manual browsing stay in sync instead of racing separate hidden pages.":
    "桌面浏览器与 browser-use 工具现在共用同一个可见 webview，使自动化、截图、导航和手动浏览保持同步，避免多个隐藏页面相互争用。",
  "The browser panel is steadier": "浏览器面板更稳定",
  "Browser resizing, overlay handling, tab controls, screenshot actions, and browser-use panel requests were tightened while keeping the browser from reopening by default.":
    "优化了浏览器尺寸调整、浮层处理、标签页控件、截图操作和 browser-use 面板请求，同时默认不再重新打开浏览器。",
  "Plans are easier to export": "计划导出更方便",
  "Proposed plans now share one compact action set for copying markdown, saving into a `.plan` workspace folder, or exporting a markdown file through the desktop save dialog.":
    "提议的计划现在共用一组紧凑操作，可复制 Markdown、保存至工作区的 `.plan` 文件夹，或通过桌面端保存对话框导出 Markdown 文件。",
  "Split panes expand predictably": "分屏窗格展开更可预测",
  "Expanding a chat pane now opens that selected chat as the single full-screen surface, closing the rest of the split layout.":
    "展开聊天窗格时，所选聊天现在会作为唯一的全屏界面打开，同时关闭其余分屏布局。",
  "Git flows are smoother": "Git 流程更顺畅",
  "The Git menu now includes branch creation with Moss-style names, and PR creation can recover from GitHub duplicate-PR responses by reusing the existing open pull request.":
    "Git 菜单现在支持使用 Moss 风格的名称创建分支；创建 PR 遇到 GitHub 返回重复 PR 时，也可复用现有的开放拉取请求完成恢复。",
  "Legacy imports heal themselves": "旧版导入可自动修复",
  "A new migration reconciles older imported T3 Code databases whose migration history skipped Moss schema changes, preventing missing-column crashes after import.":
    "新增迁移会校正旧版导入的 T3 Code 数据库，处理其迁移历史遗漏 Moss schema 变更的问题，避免导入后因缺少列而崩溃。",
  "Idle sessions clean up after themselves": "空闲会话会自动清理",
  "Provider runtimes and Codex discovery sessions now stop after idle periods, while active turns and pending approvals remain protected from premature shutdown.":
    "服务商运行时和 Codex 发现会话现在会在空闲一段时间后停止，同时进行中的轮次和待审批事项不会被过早关闭。",
  "Streaming output lands in the right message": "流式输出会写入正确消息",
  "Assistant turn ingestion now prefers existing completed item IDs when possible, reducing placeholder duplication and keeping streamed assistant text attached to the intended message.":
    "智能体轮次的数据接收现在会尽可能优先使用已有的已完成项目 ID，减少占位消息重复，并确保流式智能体文本归入预期消息。",
  "Small workflow polish landed": "多项工作流细节优化",
  "Diff views can copy the full patch directly, terminal-started chats get a clearer header icon, sidebar titles truncate more cleanly, and long transcripts cap normalized messages for lighter rendering.":
    "差异视图现在可直接复制完整补丁；从终端启动的聊天拥有更清晰的标题栏图标；侧边栏标题截断更整洁；较长的对话记录会限制标准化消息数量，以减轻渲染负担。",
  "Split chats are easier to arrange": "分屏聊天更易排列",
  "Split chat panes now support direct drag-and-drop, cross-project drops, and safer orphan handling so multi-chat layouts stay easier to build and recover.":
    "分屏聊天窗格现在支持直接拖放、跨项目放置和更安全的无归属项处理，让多聊天布局更容易搭建和恢复。",
  "Split chat navigation is steadier": "分屏聊天导航更稳定",
  "Split chat activation, route restore, sidebar grouping, and thread subscriptions were tightened so opening and switching chats feels more predictable.":
    "优化了分屏聊天激活、路由恢复、侧边栏分组和对话订阅，让打开和切换聊天更加可预测。",
  "OpenCode tasks show live progress": "OpenCode 任务显示实时进度",
  "OpenCode todo events now flow into Moss as active task updates, with a compact banner option for keeping current work visible without taking over the chat.":
    "OpenCode 待办事件现在会作为进行中任务更新流入 Moss，并提供紧凑型横幅选项，无需占据聊天区域也能持续显示当前工作。",
  "OpenCode models can be favourited": "OpenCode 模型可收藏",
  "The model picker now supports OpenCode favourites, making preferred models quicker to find across larger provider model lists.":
    "模型选择器现在支持收藏 OpenCode 模型，在较长的服务商模型列表中也能更快找到常用模型。",
  "OpenCode context usage is tracked": "OpenCode 上下文用量可追踪",
  "OpenCode sessions now report context usage more consistently, giving Moss better runtime visibility as conversations grow.":
    "OpenCode 会话现在能更一致地报告上下文用量，让 Moss 在对话不断增长时更清楚地掌握运行时状态。",
  "Debug controls stay out of production": "调试控件不再出现在生产环境",
  "Debug feature flags are now hidden behind local opt-in behavior, keeping production sidebars cleaner while preserving developer-only controls.":
    "调试功能开关现在仅在本地主动启用后显示，使生产环境的侧边栏更清爽，同时保留开发者专用控件。",
  "Cursor CLI support landed": "新增 Cursor CLI 支持",
  "Cursor is now available as a provider, with ACP sessions, model discovery, existing chats, handoff, shortcuts, and git text generation wired into Moss.":
    "Cursor 现已可作为服务商使用，Moss 已接入 ACP 会话、模型发现、现有聊天、交接、快捷键和 Git 文本生成。",
  "Voice transcription is scoped more carefully": "语音转写适用范围更明确",
  "Voice transcription now stays on ChatGPT sessions, avoiding confusing provider mismatches while keeping dictation available where it is supported.":
    "语音转写现在仅用于 ChatGPT 会话，避免服务商不匹配带来的困惑，同时在受支持的场景中继续提供语音输入。",
  "Voice transcription setup is smoother": "语音转写设置更顺畅",
  "Voice transcription setup was tightened so spoken prompts can flow into the composer more reliably in supported ChatGPT sessions.":
    "优化了语音转写设置，使口述提示在受支持的 ChatGPT 会话中能更可靠地进入输入框。",
  "Mentions keep their names": "提及内容保留名称",
  "Composer replacements now preserve mention labels, so referenced files, apps, and tools remain readable after the prompt text is normalized.":
    "输入框替换现在会保留提及标签，因此提示文本经过标准化处理后，被引用的文件、应用和工具仍然清晰可读。",
  "Plugin mentions are handled in prompts": "提示中可正确处理插件提及",
  "Plugin references can now flow through composer prompts cleanly, making connected-tool context less brittle when you hand work to an agent.":
    "插件引用现在可顺畅传入输入框提示，让你把工作交给智能体时，已连接工具的上下文更加可靠。",
  "Toast behavior can be feature-flagged": "轻提示行为可通过功能开关控制",
  "Toast notifications picked up feature-flag wiring, giving Moss a safer way to roll notification changes forward or back.":
    "轻提示通知现已接入功能开关，让 Moss 能以更安全的方式上线或回退通知变更。",
  "Desktop reconnects are steadier": "桌面端重连更稳定",
  "The desktop bridge now refreshes reconnects more reliably and preserves the workspace home directory, reducing drift after desktop runtime restarts.":
    "桌面桥接现在能更可靠地刷新重连并保留工作区主目录，减少桌面运行时重启后的状态偏移。",
  "Branch switching is much safer": "分支切换更加安全",
  "Moss now handles messy branch switches with clearer recovery actions, recreated stashes, unpublished branch publishing, and stronger checks around conflicts and local work.":
    "Moss 现在能以更清晰的恢复操作应对复杂的分支切换，包括重新创建暂存内容、发布尚未公开的分支，以及更严格地检查冲突和本地工作。",
  "Plan mode proposals show up properly": "计划模式提案可正确显示",
  "Proposed plans from providers are now parsed and surfaced as first-class UI state, so planning turns feel more predictable instead of blending into ordinary assistant output.":
    "服务商提出的计划现在会被解析并作为独立的 UI 状态呈现，使规划轮次更加可预测，不再混入普通的智能体输出。",
  "Desktop navigation controls landed": "新增桌面端导航控件",
  "The desktop app now has app-level back and forward navigation controls, making it easier to move around Moss without losing your place.":
    "桌面应用现在提供应用级后退和前进控件，让你在 Moss 中移动时更容易保留当前位置。",
  "Sidebar ordering stays put": "侧边栏排序保持不变",
  "Stored sidebar sort preferences are preserved on load, fixing cases where project and thread ordering could unexpectedly reset.":
    "载入时会保留已存储的侧边栏排序偏好，修复项目和对话顺序意外重置的问题。",
  "Fonts are more consistent": "字体表现更一致",
  "Theme and chat font handling now share one normalization path, tightening up typography across the chat UI, model controls, and theme settings.":
    "主题与聊天字体现在共用同一套标准化处理，使聊天 UI、模型控件和主题设置中的排版更加统一。",
  "GPT-5.5 is available": "GPT-5.5 现已可用",
  "GPT-5.5 is now in the model picker with the right default reasoning behavior, so you can move new Codex sessions onto the latest model directly from Moss.":
    "GPT-5.5 现已加入模型选择器，并采用正确的默认推理行为，你可以直接在 Moss 中将新的 Codex 会话切换到最新模型。",
  "OpenCode support is here": "OpenCode 支持现已推出",
  "OpenCode is now available as a provider, with runtime model discovery, session handling, provider settings, model search, variants, agents, and git text generation wired into the app.":
    "OpenCode 现已可作为服务商使用，应用内已接入运行时模型发现、会话处理、服务商设置、模型搜索、变体、智能体和 Git 文本生成。",
  "Model search feels faster": "模型搜索更快捷",
  "Large OpenCode model lists now get provider-aware search, clearer labels, automatic search focus, arrow-key navigation, and tighter picker clipping.":
    "针对 OpenCode 的大量模型列表，现已提供感知服务商的搜索、更清晰的标签、自动聚焦搜索框、方向键导航，以及更紧凑的选择器边界处理。",
  "Diffs now start from the turn": "差异对比现在从本轮次开始",
  "Turn diffs use turn-start checkpoints, making changed-file views line up more closely with what the agent actually changed in the current turn.":
    "轮次差异对比现在使用轮次开始时的检查点，让变更文件视图更准确地呈现智能体在当前轮次中实际修改的内容。",
  "Chat markdown is smarter": "聊天 Markdown 更智能",
  "Math rendering was added to chat markdown, while literal dollar amounts stay intact so normal prices and currency snippets do not get misread as formulas.":
    "聊天 Markdown 现已支持数学公式渲染，同时会完整保留表示金额的美元符号，避免将常规价格和货币片段误判为公式。",
  "More polish around search and releases": "搜索与发布流程更完善",
  "Sidebar theme search, release verification, Windows signing config, and a handful of provider/model edge cases were tightened up for a smoother build and update path.":
    "侧边栏主题搜索、发布验证、Windows 签名配置，以及若干服务商和模型的边缘情况均已优化，让构建与更新流程更加顺畅。",
  "🗂️ Project import browsing got smarter": "🗂️ 项目导入浏览更智能",
  "The import palette can now browse nearby paths more directly, helping you find and open the right project location with less guesswork.":
    "导入面板现在可以更直接地浏览附近路径，减少猜测，更轻松地找到并打开正确的项目位置。",
  "📊 Provider usage is visible in-context": "📊 在当前界面即可查看服务商用量",
  "The branch toolbar now surfaces provider usage snapshots, making it easier to keep an eye on current usage without leaving your working view.":
    "分支工具栏现在会显示服务商用量快照，无需离开当前工作界面即可轻松掌握用量。",
  "🚀 Desktop startup feels clearer": "🚀 桌面端启动过程更清晰",
  "Moss now shows a proper splash screen while the desktop backend spins up, so launch feels intentional instead of looking briefly stalled.":
    "桌面端后端启动期间，Moss 现在会显示完整的启动画面，让启动过程更明确，不再像是短暂无响应。",
  "🎛️ Better provider and theme polish": "🎛️ 服务商与主题体验更精致",
  "Model capability handling, theme editing, and related picker behavior were tightened up so settings feel more consistent and trustworthy.":
    "优化了模型能力处理、主题编辑及相关选择器行为，让设置体验更加一致、可靠。",
  "🛠️ Desktop release plumbing is sturdier": "🛠️ 桌面端发布流程更稳健",
  "Startup readiness checks, desktop packaging config, and platform entitlements were refined to make desktop builds and app boot more reliable.":
    "优化了启动就绪检查、桌面端打包配置和平台权限，让桌面端构建与应用启动更加可靠。",
  "🎨 Theme packs are editable": "🎨 主题包现可编辑",
  "The new theme pack editor lets you tune UI colors directly in Moss, with shared theme tokens keeping the sidebar, composer, transcript, and controls in sync.":
    "新的主题包编辑器支持直接在 Moss 中调整界面颜色，并通过共享主题 token 让侧边栏、输入框、对话记录和控件保持一致。",
  "🔔 Sidebar notifications are easier to read": "🔔 侧边栏通知更易读",
  "Thread activity now surfaces more clearly in the sidebar, so updates, background work, and attention states are easier to spot without opening every conversation.":
    "侧边栏现在会更清晰地呈现对话活动，无需逐一打开每个对话，也能轻松发现更新、后台任务和需要关注的状态。",
  "🧵 Steadier transcripts under load": "🧵 高负载下的对话记录更稳定",
  "Transcript rendering and sidebar-owned state were separated more cleanly, reducing unnecessary churn while long conversations and live agent output are moving.":
    "进一步分离了对话记录渲染与侧边栏管理的状态，减少长对话和智能体实时输出期间不必要的更新。",
  "🛡️ Safer runtime-mode recovery": "🛡️ 运行时模式恢复更安全",
  "Codex runtime permissions now propagate more reliably across resumed sessions and provider restarts, keeping the app closer to the mode you actually selected.":
    "Codex 运行时权限现在能在恢复会话和服务商重启后更可靠地传递，使应用始终更贴近你实际选择的模式。",
  "✨ Cleaner composer and picker styling": "✨ 输入框与选择器样式更清爽",
  "Composer chrome, picker hover states, runtime controls, and changed-file rows picked up a more consistent visual pass across light and dark themes.":
    "统一优化了浅色和深色主题下的输入框外观、选择器悬停状态、运行时控件和变更文件行。",
  "📂 Browse local folders right from the composer": "📂 直接从输入框浏览本地文件夹",
  "Folder mentions now open a real local directory picker, so you can drill into nearby files and attach the right path without leaving the chat flow.":
    "提及文件夹时现在可打开真正的本地目录选择器，让你无需离开聊天流程，即可浏览附近文件并附加正确路径。",
  "🗂️ Cleaner file and folder mentions": "🗂️ 文件与文件夹提及更清爽",
  "Mention chips, file trees, and changed-file rows now use a lighter shared icon system that keeps paths easier to scan across the app.":
    "提及标签、文件树和变更文件行现在采用更轻盈的共享图标体系，让应用各处的路径更易浏览。",
  "🌐 Stronger desktop browser runtime": "🌐 更强大的桌面端浏览器运行时",
  "The desktop browser path picked up better IPC plumbing, screenshots, clipboard support, and more efficient state syncing for browser-driven tasks.":
    "桌面端浏览器路径现已具备更完善的 IPC 支持、截图与剪贴板功能，并能更高效地同步浏览器任务状态。",
  "🛟 Smoother startup and provider recovery": "🛟 启动与服务商恢复更顺畅",
  "Project hydration, desktop startup, auth visibility, and aborted-turn cleanup were tightened up so sessions recover more predictably after interruptions.":
    "优化了项目状态载入、桌面端启动、认证状态显示和中止轮次清理，让会话在中断后能够更稳定地恢复。",
  "↪︎ Steering messages are clearly marked": "↪︎ 引导消息现有清晰标记",
  "Messages sent with steering now keep a lightweight 'Steering conversation' label above the bubble, even after the app reconciles with the server.":
    "通过引导功能发送的消息现在会在气泡上方保留轻量的“正在引导对话”标签，即使应用与服务器完成状态同步后也不会消失。",
  "🚦 Less aggressive background return checks": "🚦 后台返回检查不再过于频繁",
  "Desktop update checks now wait for a real background return instead of reacting to every tiny blur/focus bounce.":
    "桌面端更新检查现在会等待应用真正从后台返回，不再因每次短暂的失焦与聚焦而触发。",
  "🛟 No more stuck checking state": "🛟 不再卡在检查状态",
  "If the updater never answers, Moss now times out and recovers instead of hanging on a permanent Checking status.":
    "如果更新服务迟迟没有响应，Moss 现在会在超时后自动恢复，不会永久停留在“正在检查”状态。",
  "♊ Gemini support is here": "♊ Gemini 支持现已推出",
  "Use Gemini alongside Codex and Claude Agent, with provider-aware models and handoff support built into the app.":
    "现在可将 Gemini 与 Codex、Claude Agent 搭配使用，应用内已集成感知服务商的模型和任务交接支持。",
  "🛠️ Custom binary paths for every provider": "🛠️ 每个服务商均可自定义可执行文件路径",
  "Point Moss at your own Codex, Claude, or Gemini binary when your setup lives outside the default install path.":
    "如果 Codex、Claude 或 Gemini 安装在默认路径之外，现在可以让 Moss 使用你指定的可执行文件。",
  "📎 Reuse assistant replies as attachments": "📎 将智能体回复复用为附件",
  "Select parts of an assistant response and send them back as structured context in your next prompt.":
    "选取智能体回复中的部分内容，即可在下一条提示中将其作为结构化上下文再次发送。",
  "🧵 Better thread continuity": "🧵 对话衔接更顺畅",
  "The app now remembers your last open thread, carries pull request context into draft threads, and keeps sidebar state more stable.":
    "应用现在会记住你最后打开的对话，将拉取请求上下文带入草稿对话，并让侧边栏状态更加稳定。",
  "🩹 Smoother recovery and update checks": "🩹 恢复与更新检查更顺畅",
  "Project creation recovery, foreground update checks, and a few rough edges around long messages and download state have been tightened up.":
    "优化了项目创建恢复、前台更新检查，以及长消息和下载状态相关的若干体验问题。",
  "💬 Chats are now available!": "💬 聊天功能现已推出！",
  "Write without a selected project, or create threads from there.":
    "无需选择项目即可开始输入，也可以从这里创建对话。",
  "⌨️ New shortcuts": "⌨️ 新增快捷键",
  "Quickly open a new chat or jump to your latest project thread with dedicated shortcuts.":
    "使用专用快捷键快速新建聊天，或跳转到最近的项目对话。",
  "🧠 Claude 1M context support": "🧠 支持 Claude 1M 上下文",
  "Take full advantage of Claude's 1M-token context window for long conversations and large codebases.":
    "充分利用 Claude 的 100 万 token 上下文窗口，轻松处理长对话和大型代码库。",
  "📁 Bulk thread actions": "📁 批量处理对话",
  "Select multiple threads at once and act on them together.": "一次选择多个对话并统一执行操作。",
  "✨ Cleaner reasoning picker order": "✨ 推理选项排序更清晰",
  "The reasoning picker has been reordered to make the most common choices quicker to reach.":
    "推理选择器现已重新排序，更常用的选项可以更快选到。",
  "💻 New polished UI/UX": "💻 全新精致 UI/UX",
  "A round of visual and interaction polish across the app.": "全面优化了应用的视觉与交互体验。",
  "🆕 What's new, inline": "🆕 更新内容，直接呈现",
  "Every update now opens a one-time dialog highlighting the latest changes, so you don't have to hunt through a changelog to know what shipped.":
    "每次更新后都会显示一次性对话框，重点介绍最新变化，无需翻找更新日志即可了解本次发布内容。",
  "The dialog only shows up once per release — dismiss it and it stays out of your way until the next version.":
    "每个版本只会显示一次该对话框；关闭后，它会保持隐藏，直到下一个版本发布。",
  "📚 Release history in Settings": "📚 设置中新增发布历史",
  "A full changelog lives under Settings → Release history, grouped by version in a collapsible accordion.":
    "完整更新日志现位于“设置 → 发布历史”，按版本分组并以可折叠列表呈现。",
  "Revisit any past release at any time. The same notes as the post-update dialog, nothing to hunt for.":
    "你可以随时回顾任一历史版本，其中包含与更新后对话框相同的说明，无需再四处查找。",
  // __APPEND_TRANSLATIONS__

  // v1.0.0-beta.1 (上游发布说明，随 46 个提交并入)
  "Hubs: give larger work a team": "Hubs：给大任务配一个团队",
  "Bring a coordinator and worker agents together around shared instructions, linked projects and a versioned Library in Moss Beta.":
    "在 Moss Beta 中，让协调者与多个 worker 智能体围绕共享指令、关联项目和带版本库的 Library 协同工作。",
  "Delegate independent work, preserve the original request and attachments, follow durable work cards and checklists, and receive a combined completion summary. The queue supports 1–8 parallel workers (3 by default), with visible waiting, failure and recovery states. New repository work defaults to isolated worktrees; explicit environment choices are respected.":
    "委派彼此独立的工作，保留原始请求和附件，跟踪持久的工作卡片与清单，并收到合并后的完成摘要。队列支持 1–8 个并行 worker（默认 3 个），等待、失败和恢复状态均可见。新的仓库工作默认在隔离 worktree 中进行；显式的环境选择会被尊重。",
  "Tasks: a backlog you can hand to an agent": "Tasks：可以直接交给智能体的待办列表",
  "Create to-dos with notes, priority, project and due date, then start work in a new or existing chat from the task card.":
    "创建带备注、优先级、项目和截止日期的待办，然后从任务卡片在新会话或现有会话中开工。",
  "Choose the Tasks list or Kanban. Follow running, needs-you, review and failed work beside the list. Saved ownership and reconnect reconciliation keep pending edits and uncertain delegation visible.":
    "可选 Tasks 列表或 Kanban 看板。在列表旁跟踪运行中、需要你、待审阅和失败的工作。已保存的归属关系与重连对账让待定的编辑和不确定的委派保持可见。",
  "Inbox: today’s work in one place": "Inbox：今天的工作集中在一处",
  "See today’s tasks, work needing attention, review requests and an activity recap together.":
    "今天的任务、需要关注的工作、审阅请求和活动回顾集中呈现。",
  "Create a task due today, open its card, or return to the full backlog. Recaps use recorded local activity and provider-attributed usage; they do not invent missing token data.":
    "创建一个今天截止的任务、打开它的卡片，或回到完整待办列表。回顾使用记录在案的本地活动和按 provider 归因的用量；不会虚构缺失的 token 数据。",
  "Multiple accounts, clearly separated": "多账号，清晰隔离",
  "Name and configure several accounts for the same provider, then choose their models from separate account tabs.":
    "为同一 provider 命名并配置多个账号，在各自的账号页签下分别选择模型。",
  "Provider account identity follows supported sessions, favorites, imports, forks and handoffs. Account-specific executable paths and environments keep the selected runtime and credentials together.":
    "provider 账号身份跟随受支持的会话、收藏、导入、分叉和交接。按账号划分的可执行路径与环境，让所选运行时和凭据始终配对。",
  "Sign in from provider settings": "从 provider 设置里登录",
  "Open the provider’s native sign-in flow in a managed terminal using the selected account’s environment.":
    "在受管终端中、使用所选账号的环境打开 provider 的原生登录流程。",
  "Check authentication before starting work. Pi and Oh My Pi offer their native login choices; external OpenCode servers must be authenticated on that server. Closing sign-in stops its terminal; credentials already saved by the provider remain.":
    "开工前先检查认证状态。Pi 和 Oh My Pi 提供各自的原生登录选项；外部 OpenCode 服务器必须在该服务器上完成认证。关闭登录即停止其终端；provider 已保存的凭据会保留。",
  "Usage for each account": "按账号查看用量",
  "Inspect usage for the active provider’s enabled accounts separately, and choose which provider rings appear in the rail.":
    "分别查看当前 provider 各启用账号的用量，并选择导航栏上显示哪些 provider 的额度环。",
  "Expandable details keep the compact view readable. Codex credits are shown as a count, not a dollar amount; missing account telemetry is not replaced with another account’s figures.":
    "可展开的详情让紧凑视图保持易读。Codex 额度按次数而非美元金额显示；账号遥测缺失时不会用别的账号的数据顶替。",
  "Change providers in the same conversation": "在同一会话中切换 provider",
  "Use the model picker to hand work to another supported provider while keeping the same chat and workspace context.":
    "用模型选择器把工作交给另一个受支持的 provider，同时保留同一会话与工作区上下文。",
  "A divider marks the handoff. Available targets respect account availability, and a failed transition is not reported as successful. Separate-thread handoff remains available.":
    "分界线标记交接位置。可用目标遵守账号可用性，失败的切换不会被误报为成功。仍可选择交接给独立会话。",
  "A new workspace rail": "全新的工作区导航栏",
  "Reach chats, projects and tools from a compact rail with independently customizable destinations.":
    "通过紧凑的导航栏直达会话、项目和工具，每个入口都可独立自定义。",
  "Show, hide and reorder rail items; Customize also works on narrow screens. The update action shows download progress, and project icons make recent work easier to recognize.":
    "导航栏项目可显示、隐藏和重排；窄屏下也能自定义。更新操作会显示下载进度，项目图标让近期工作更易辨认。",
  "Keep open chats within reach": "打开的会话触手可及",
  "Move between open-chat tabs with provider icons, running indicators, context menus and keyboard navigation.":
    "在打开的会话标签间切换，带 provider 图标、运行指示、右键菜单和键盘导航。",
  "Tabs remain scrollable while chats stream. Unsent new-chat drafts stay out of the strip. Use Cmd+Ctrl+Left/Right on macOS, or Ctrl+PageUp/PageDown on other platforms outside terminal focus.":
    "会话流式输出时标签仍可滚动。未发送的新会话草稿不会进入标签条。macOS 上用 Cmd+Ctrl+Left/Right，其它平台在终端焦点外用 Ctrl+PageUp/PageDown。",
  "Make the workspace yours": "把工作区调成你的样子",
  "Choose full-window or sidebar-only translucency, adjust blur and opacity, and customize project names, icons and colors.":
    "可选全窗口或仅侧栏半透明，调节模糊与不透明度，并自定义项目名称、图标和颜色。",
  "Supported desktop materials extend through editors, panes, menus and dialogs. The new appearance default uses full-window glass, blur 64 and 90% opacity. Native glass availability depends on platform.":
    "支持的桌面材质延伸到编辑器、分屏、菜单和对话框。新的默认外观为全窗口玻璃、模糊 64、不透明度 90%。原生玻璃可用性取决于平台。",
  "Code review, issues and agents together": "代码审阅、issue 与智能体聚在一起",
  "Browse pull requests and issues in a redesigned list, inspect details, and discuss the item in a side chat.":
    "在重新设计的列表中浏览拉取请求和 issue，查看详情，并在旁挂会话中讨论。",
  "Remember filters and sorting, include merged PRs, preview images fullscreen, and send an item to an agent in the correct project and environment. GitHub links have configurable destinations and their own context menu.":
    "记住过滤器和排序，包含已合并的 PR，全屏预览图片，并把条目交给正确项目和环境中的智能体。GitHub 链接目的地可配置，并有独立右键菜单。",
  "Auto-fix CI": "自动修复 CI",
  "Enable Auto-fix CI on an open pull request to ask its chat to address failing checks.":
    "在打开的拉取请求上启用 Auto-fix CI，让对应会话处理失败的检查。",
  "This opt-in Beta feature waits for active work, approvals and questions, respects chat permissions, and limits retries. Uncertain dispatch or lack of progress pauses the watcher with an explanation. It does not automatically merge.":
    "这个可选 Beta 功能会等待进行中的工作、审批和提问，尊重会话权限，并限制重试。投递不确定或没有进展时，监视器会暂停并说明原因。它不会自动合并。",
  "A more actionable Kanban board": "更可操作的 Kanban 看板",
  "Choose an Attention board with Draft, In Progress, Awaiting you and Done columns, or retain Classic.":
    "选择带 Draft、In Progress、Awaiting you、Done 列的 Attention 看板，或保留经典布局。",
  "See failed, stuck, approval, input and review attention; reorder drafts and send work as a persistent goal. Agents gain eight scoped board tools for durable chat cards. These tools do not expose unsent local drafts or manipulate Tasks to-do records.":
    "集中查看失败、卡住、待审批、待输入和待审阅事项；重排草稿并把工作设为持久目标。智能体获得八个限域看板工具来操作持久会话卡片。这些工具不会暴露未发送的本地草稿，也不会改动 Tasks 待办记录。",
  "Send work as a goal": "把工作设为目标发出",
  "Start a Kanban task as a persistent goal or set a goal on an existing chat card.":
    "把 Kanban 任务作为持久目标发起，或在既有会话卡片上设定目标。",
  "Long goals are delivered through managed file references instead of being silently truncated. Shared send ownership preserves account choice, attachments and edits when work is dispatched.":
    "长目标通过受管文件引用传递，不再被静默截断。共享的发送归属关系在派发工作时保留账号选择、附件和编辑。",
  "Snooze a chat until you need it": "会话休眠到你需要它为止",
  "Hide a chat from ordinary activity until a preset or custom reminder time, then bring it back automatically.":
    "把会话从日常活动中收起，到预设或自定义提醒时间后自动带回。",
  "Choose 30 minutes, one hour, two hours, tomorrow at 9am or a custom time. Reminders persist across restart; Return now cancels the snooze. Running work continues.":
    "可选 30 分钟、一小时、两小时、明天上午 9 点或自定义时间。提醒跨重启保留；「立即返回」取消休眠。运行中的工作不受影响。",
  "Smoother split-pane work": "更顺滑的分屏协作",
  "Resize panes continuously, close each pane directly, and spot the focused composer at a glance.":
    "分屏可连续调整大小、逐屏直接关闭，聚焦的输入框一眼可辨。",
  "Chats stay mounted across single/split transitions and rearrangements, preserving the split tree, focus and conversation state.":
    "会话在单屏/分屏切换和重排中保持挂载，分屏树、焦点和会话状态都被保留。",
  "Side chats that keep their context": "保留上下文的旁挂会话",
  "Side chats inherit the primary workspace, and GitHub discussions stay discoverable across checkouts.":
    "旁挂会话继承主工作区，GitHub 讨论跨检出保持可发现。",
  "Choose an inactivity expiry of one hour, 24 hours or never. Idle expired side chats become read-only and release their provider session. Cmd+Option+S toggles Side chat on macOS.":
    "可选一小时、24 小时或永不闲置过期。闲置过期的旁挂会话变为只读并释放其 provider 会话。macOS 上 Cmd+Option+S 切换旁挂会话。",
  "Edit shortcuts individually": "逐个编辑快捷键",
  "Record and edit shortcuts in a searchable command list with conflict handling.":
    "在可搜索的命令列表中录制和编辑快捷键，并处理冲突。",
  "Shift+Tab cycles the selected model’s supported reasoning effort. Thread menus group related handoff, fork and copy actions into compact submenus.":
    "Shift+Tab 在所选模型支持的推理档位间循环。会话菜单把相关的交接、分叉和复制动作收进紧凑的子菜单。",
  "Dictation that fits the conversation": "贴合会话节奏的听写",
  "Use Enter to stop/transcribe or stop/send, and dictate while an agent is working.":
    "Enter 键可选停止/转写或停止/发送，智能体工作时也能听写。",
  "Capture waits for real microphone audio before proceeding.":
    "采集会先等到真实的麦克风音频再继续。",
  "Let the message trail follow sound": "让消息流随声音律动",
  "On supported macOS desktops, animate the trail from system audio, a selected microphone, or both.":
    "在支持的 macOS 桌面上，消息流可随系统音频、所选麦克风或两者律动。",
  "The opt-in feature uses loudness levels rather than recording audio. System-audio levels require macOS 14.2+; microphone access requires permission. Choose a built-in microphone while using Bluetooth headphones; an unavailable selected device does not silently switch to another input.":
    "这个可选功能使用响度电平而不是录制音频。系统音频电平需要 macOS 14.2+；麦克风需要授权。使用蓝牙耳机时可以选择内置麦克风；所选设备不可用时不会静默切换到别的输入。",
  "Clearer long-running conversations": "更清晰的长时间会话",
  "Keep background subagent replies visible and wait for all workers before showing completion.":
    "后台子智能体的回复保持可见，等所有 worker 完成后才显示完成。",
  "Choose whether finished turns fold and whether sending anchors the new message at the top. Wide code blocks scroll horizontally without widening the transcript. Full error, approval, progress and warning details remain available.":
    "可选已完成的回合是否折叠、发送后新消息是否锚定在顶部。宽代码块横向滚动而不撑宽会话。完整的错误、审批、进度和警告详情仍然可用。",
  "More useful Claude progress": "更有用的 Claude 进度呈现",
  "See provider-supplied reasoning, tool summaries and execution status in the transcript.":
    "在会话记录中查看 provider 提供的推理、工具摘要与执行状态。",
  "Native compaction waits for initialization; prompt-cache warnings avoid false expiry reports. Account-specific CLI paths are retained when Artifacts is enabled.":
    "原生压缩等待初始化完成；提示缓存警告避免误报过期。启用 Artifacts 时保留按账号划分的 CLI 路径。",
  "Current models without disruptive refreshes": "模型列表即时刷新，不再打断选择",
  "Model catalogs refresh on demand for the account you are viewing while keeping usable choices visible.":
    "按你正在查看的账号按需刷新模型目录，同时保留可用的现有选择。",
  "Interactive requests take priority, actionable failures offer retry, Claude catalog changes follow CLI updates, and OpenCode custom-provider models remain selectable.":
    "交互式请求优先，可操作的失败提供重试，Claude 目录变化跟随 CLI 更新，OpenCode 自定义 provider 的模型保持可选。",
  "Better import recovery and history browsing": "导入恢复与历史浏览更可靠",
  "Import conversations from supported Codex and Claude accounts with clearer diagnostics, bounded history pages and recovery for interrupted work.":
    "从支持的 Codex 和 Claude 账号导入会话，诊断更清晰、历史分页有界、中断的工作可恢复。",
  "Original provider context remains in independent session copies. Earlier text loads on demand; historical tools, reasoning and attachments are not reconstructed as live messages. New ordinary chats skip imported-history requests.":
    "原始 provider 上下文保留在独立的会话副本中。更早的文本按需加载；历史工具、推理和附件不会被重构成实时消息。新的普通会话跳过导入历史请求。",
  "Recover message delivery after disconnects": "断线后恢复消息投递",
  "Moss checks whether an interrupted send was accepted before deciding what happens next.":
    "Moss 会先确认中断的发送是否已被接受，再决定下一步。",
  "Accepted commands are not blindly resent; rejected commands restore the draft. Delivery settlement requires a compatible server. HTTP fallback failures now settle and surface useful errors.":
    "已接受的命令不会被盲目重发；被拒绝的命令会还原草稿。投递结算需要兼容的服务器。HTTP 回退失败现在会正常落地并给出有用的错误。",
  "Recover Codex gateway sessions after watchdog aborts, support current Codex rewind, and retain OpenCode background work.":
    "看门狗中止后可恢复 Codex 网关会话，支持当前的 Codex rewind，并保留 OpenCode 后台工作。",
  "Cursor and Droid avoid repeated OAuth prompts, cached Grok login is recognized, and desktop ACP tool proxies start in the correct runtime mode.":
    "Cursor 和 Droid 不再重复弹出 OAuth 登录，缓存的 Grok 登录可被识别，桌面 ACP 工具桥以正确的运行时模式启动。",
  "Less repeated rendering and fetching": "更少重复渲染与拉取",
  "Streaming and typing avoid repeated shell, header and composer work; GitHub reads share a queue and rate-limit pause.":
    "流式输出与输入避免重复的 shell、头部和输入区工作；GitHub 读取共享队列并遵守限流暂停。",
  "These are targeted changes, not a universal speed or battery-life claim. PR preparation retains the intended environment and unrelated worktrees; Git failures identify the action that failed.":
    "这些是针对性改动，不是全面的速度或续航承诺。PR 准备保留预期的环境和无关的 worktree；Git 失败会指明失败的操作。",
  "Small fixes throughout the workspace": "工作区各处的小修复",
  "Keep unread chats unread across reloads, preserve drafts while browsing history, and remember Markdown preview per file.":
    "重新加载后未读会话保持未读，浏览历史时保留草稿，并记住每个文件的 Markdown 预览状态。",
  "Browser tabs support middle-click close, address suggestions stay visible and navigation preserves composer focus. Unicode image downloads, deleted-file search results, profile dates, notification clicks and app-icon persistence are corrected.":
    "浏览器标签支持中键关闭，地址建议保持可见，导航保留输入框焦点。Unicode 图片下载、已删除文件的搜索结果、资料页日期、通知点击和应用图标持久化都已修正。",
  "Quieter Windows sessions": "更安静的 Windows 会话",
  "Provider updates handle Windows PATH and stdin correctly, and process cleanup avoids flashing command windows.":
    "provider 更新正确处理 Windows PATH 与 stdin，进程清理不再闪现命令行窗口。",
  "Capture fallback produces valid JSON. Release installers must pass the new Defender scan as well as packaging, provenance and startup checks; Windows installers remain unsigned under the version-scoped release policy.":
    "采集回退产生合法 JSON。发布安装包必须通过新的 Defender 检查以及打包、来源和启动验证；Windows 安装包按版本作用域的发布策略保持未签名。",
  "A tour of what changed": "一览本次更新",
  "A feature tour introduces the new workspace, accounts, review workflow and Beta Hubs.":
    "功能导览介绍新工作区、账号、审阅流程和 Beta 版 Hubs。",
  "This release is Moss Beta only. Stable remains at 0.9.2 with its existing features and separate data and update feed.":
    "本版本仅限 Moss Beta。Stable 保持在 0.9.2，功能与数据和更新源均独立。",
};

const MONTHS: Readonly<Record<string, string>> = {
  Jan: "1月",
  Feb: "2月",
  Mar: "3月",
  Apr: "4月",
  May: "5月",
  Jun: "6月",
  Jul: "7月",
  Aug: "8月",
  Sep: "9月",
  Oct: "10月",
  Nov: "11月",
  Dec: "12月",
};

const CHROME_TEXT: Readonly<Record<string, string>> = {
  "What's New": "新功能",
  "What’s New": "新功能",
  "Release history": "发布历史",
  "Every curated release, newest first.": "所有精选版本，按时间从新到旧排列。",
  "No release notes yet — check back after the next update.":
    "暂时还没有发布说明，请在下次更新后再来查看。",

  // v1.0.1 (Oct 8) entries.
  "OpenCode v2": "OpenCode v2 登场",
  "Connect the new OpenCode v2 runtime while retaining support for existing v1 servers.":
    "接入全新的 OpenCode v2 运行时，同时保留对现有 v1 服务器的支持。",
  "Moss detects the server API before sending work and uses the v2 client for models, agents, sessions, streaming, approvals, attachments, forks, rollback and compaction. Keep your OpenCode account and data when migrating. Standard questions appear in Moss; complex forms must be completed in OpenCode. Task-scoped MCP readiness is checked after registration.":
    "Moss 会在发送工作前探测服务器 API，并使用 v2 客户端处理模型、智能体、会话、流式输出、审批、附件、分叉、回滚和压缩。迁移时保留你的 OpenCode 账号和数据。标准提问在 Moss 中完成；复杂表单需在 OpenCode 中填写。任务级 MCP 就绪情况在注册后检查。",
  "Multiple folders in one project": "一个项目，多个文件夹",
  "Bring a frontend, API and shared package together under one project and let the agent work across them.":
    "把前端、API 和共享包归入同一个项目，让智能体跨文件夹工作。",
  "Choose Source folders when creating a project, mark one as Primary and remove folders you do not need. Multi-folder chats currently require Local mode and Codex or Claude. The folder set is fixed at creation; Git actions, checkpoints and file undo cover the primary folder only. Review and recover extra-folder edits separately.":
    "创建项目时可选择多个源文件夹，标记一个为主文件夹，并移除不需要的文件夹。多文件夹会话目前要求 Local 模式和 Codex 或 Claude。文件夹组合在创建时固定；Git 操作、检查点和文件撤销只覆盖主文件夹。额外文件夹的改动请分别审阅和恢复。",
  "Tasks comes to Stable": "Tasks 登陆 Stable",
  "Keep to-dos in one list, plan your day in Inbox and hand a task to an agent when you are ready.":
    "在一个列表中管理待办，在 Inbox 里规划你的一天，准备好后把任务交给智能体。",
  "Edit notes, due dates, priority and project, then choose a provider, model, effort and a new or existing chat. Task cards show activity, questions, approvals and the reply to review. The List / Kanban switch keeps the board accessible, and a one-time navigation tip introduces Tasks. Older servers without Tasks fall back to Kanban. Hubs remain Beta-only.":
    "编辑备注、截止日期、优先级和项目，然后选择服务商、模型、强度以及新会话或已有会话。任务卡片会显示活动、提问、审批和待审阅的回复。List / Kanban 开关让看板保持可用，一次性的导航提示会介绍 Tasks。没有 Tasks 的旧服务器回退到 Kanban。Hubs 仍为 Beta 专属。",
  "Find more with workspace search": "工作区搜索更强大",
  "Find conversations by their saved message text and use the palette to navigate or open settings.":
    "按已保存的消息内容查找会话，也可以用命令面板导航或打开设置。",
  "Search reaches persisted messages beyond recently opened chats. File results resolve safely in the active workspace, including registered dot-folder projects. Workspace search can be remapped; shortcuts update without restarting and respect focused terminals.":
    "搜索范围覆盖已持久化的消息，不限于最近打开的会话。文件结果在当前工作区安全解析，包括已注册的点文件夹项目。工作区搜索可以重映射；快捷键无需重启即生效，并尊重焦点中的终端。",
  "Faster chat actions": "会话操作更快捷",
  "Archive, snooze or mark the active chat unread with configurable shortcuts, and undo marking a chat done.":
    "用可配置的快捷键归档、休眠当前会话或标为未读，还可以撤销「标记完成」。",
  "Thread hovers preview unsent drafts and show current effort and Fast status. Mark all read includes chats returned from snooze. New threads created from older drafts receive their creation time instead of the draft’s old timestamp.":
    "会话悬停预览未发送的草稿，并显示当前强度和 Fast 状态。「全部已读」包含休眠后返回的会话。从旧草稿新建的讨论会以创建时间为准，不再沿用草稿的旧时间戳。",
  "Keep answered questions in view": "已回答的问题保持可见",
  "Review the agent’s questions and your answers directly in the conversation after responding.":
    "回答之后，可以直接在会话中回顾智能体的问题和你的答案。",
  "Press Enter to submit async answers. Stale provider questions settle durably so they do not keep chats waiting. Queued follow-ups explain their available actions, and a Claude tip explains model changes and provider handoffs during active work.":
    "按 Enter 提交异步回答。过期的服务商提问会持久地了结，不再让会话空等。排队的追问会说明可用的操作，Claude 提示会在工作期间解释模型变更和服务商交接。",
  "Understand interrupted work": "看懂被中断的工作",
  "Open and copy thread error details, with failed-turn feedback preserved after recovery.":
    "打开并复制会话的错误详情，失败回合的反馈在恢复后仍然保留。",
  "Reconnecting and busy waits use clearer shared status messages. Server stalls are monitored, buffering stays enabled during turns longer than an hour, and uncertain side effects are not silently replayed as successes.":
    "重连和忙碌等待使用更清晰的共享状态文案。服务器卡顿会被监控，超过一小时的回合仍保持缓冲，不确定的副作用不会被静默地当作成功重放。",
  "Choose accounts for usage rings": "自选用量圆环的账号",
  "Pick the individual provider accounts shown in your sidebar usage rings.":
    "选择侧边栏用量圆环中显示的具体服务商账号。",
  "Saved account-ring choices survive temporarily disabling an account. Disabled providers disappear from selectable surfaces; existing conversations remain readable. Provider sign-in actions open the appropriate settings, and OMP’s internal roles stay out of the model picker.":
    "已保存的圆环账号选择在临时停用账号后依然保留。被停用的服务商从各选择界面消失；已有会话仍可读。服务商登录操作会打开对应的设置，OMP 的内部角色不会出现在模型选择器中。",
  "Keep macOS awake during agent work": "智能体工作时保持 macOS 唤醒",
  "Choose whether to keep your Mac awake during agent work, all the time, or let it sleep normally.":
    "选择仅在智能体工作时保持 Mac 唤醒、始终唤醒，或正常休眠。",
  "Settings → System → Keep computer awake offers On, Agent and Off, defaulting to Off. Agent mode releases its assertion when work settles, its owner exits or the thread is deleted; On mode lasts while the server runs. This macOS feature does not promise uninterrupted work with the lid closed.":
    "设置 → 系统 → 保持电脑唤醒提供「开」「智能体工作时」「关」三个选项，默认为「关」。智能体模式会在工作落定、持有方退出或讨论被删除时解除唤醒；「开」模式在服务器运行期间持续。这项 macOS 功能不承诺合盖后工作不中断。",
  "Keep your place in files and tabs": "文件与标签保持原位",
  "File tabs remember scroll positions, the dock Explorer keeps its open file across chat switches, and horizontal tabs scroll with the mouse wheel.":
    "文件标签记住滚动位置，停靠栏的资源管理器在切换会话后保留打开的文件，横向标签条支持滚轮滚动。",
  "Markdown file previews render sanitized HTML, assistant line breaks display correctly, and Markdown follows the selected typography. Project actions open in right-side terminals; independent right-dock terminal tabs are restored.":
    "Markdown 文件预览会渲染经过消毒的 HTML，助手消息中的换行正确显示，Markdown 跟随所选字体排版。项目操作在右侧终端中打开；右侧停靠栏的独立终端标签也已恢复。",
  "Clearer Git and Kanban actions": "更清晰的 Git 与 Kanban 操作",
  "Move Kanban cards from their context menu and use the full commit-and-push row to open Git actions.":
    "可以从右键菜单移动 Kanban 卡片，也可以用完整的「提交并推送」行打开 Git 操作。",
  "Git dialogs expose their submit shortcuts. Branch creation avoids namespace conflicts, and checkpoint scheduling reserves capacity for reads and checkpoint work so unrelated workspaces can advance.":
    "Git 对话框会展示提交快捷键。创建分支避免命名空间冲突，检查点调度为读取和检查点工作预留容量，互不相关的工作区可以各自推进。",
  "Moss is the default theme": "Moss 成为默认主题",
  "New installations start with the complete Moss theme, including the matching controls and workspace styling.":
    "新安装默认启用完整的 Moss 主题，包括配套的控件与工作区样式。",
  "Sidebar text stays sharp after display changes, metadata glyphs align consistently, and the chat header remains draggable. Embedded browser pages retain an opaque backdrop and remain visible behind toolbar overlays.":
    "显示器变化后侧栏文字保持清晰，元数据图标对齐一致，会话头部仍可拖动。内嵌浏览器页面保留不透明底色，在工具栏浮层后面依然可见。",
  "Smoother streaming and recovery": "更顺滑的流式输出与恢复",
  "Reduce idle chat repaints, reopen flicker and repeated provider work while keeping cancellation and recovery predictable.":
    "减少空闲会话的重绘、重开闪烁和重复的服务商工作，同时保持取消与恢复的可预期性。",
  "Codex reuses its app-server between completed turns. Independent sessions and workspaces no longer share avoidable delivery bottlenecks; replaceable progress is coalesced. Transcript follow survives turn updates, detached readers keep their place, and Pi assistant messages split at message_end.":
    "Codex 在回合之间复用 app-server。相互独立的会话和工作区不再共享可避免的投递瓶颈；可替换的进度会被合并。会话跟随在回合更新后保持，离开底部的读者位置不受影响，Pi 的助手消息在 message_end 处正确切分。",
  "More reliable provider setup": "更可靠的服务商配置",
  "Provider discovery checks executable candidates and uses the selected account’s environment.":
    "服务商发现会校验可执行文件候选，并使用所选账号的环境。",
  "Claude accounts remain isolated without breaking macOS Keychain, idle Claude sessions stop without waiting for the SDK stream, and Computer-off restarts wait for background work. Codex continuation imports retain verified generation, managed MCP names avoid collisions, and provider usage works with compatible fake-IP DNS responses. Health probes do not auto-update Antigravity.":
    "Claude 账号保持隔离且不破坏 macOS 钥匙串，空闲的 Claude 会话无需等待 SDK 流即可停止，Computer 关闭后的重启会等待后台工作。Codex 续聊导入保留已验证的代数，托管 MCP 名称避免冲突，服务商用量兼容 fake-IP DNS 应答。健康检查不会触发 Antigravity 的自动更新。",
  "More predictable startup and shutdown": "更可预期的启动与退出",
  "Startup announcements appear one at a time, application bundles reveal in Finder, and signal-driven shutdown skips the interactive quit confirmation.":
    "启动公告一次只出现一条，应用包在 Finder 中显示而不是启动，信号驱动的退出跳过交互式退出确认。",
  "Keybindings load and watch at startup, with recovery after transient filesystem failures. Skills read YAML frontmatter correctly. Beta upload diagnostics and writable-failure handling are hardened with privacy redaction; Stable does not send Beta diagnostics.":
    "快捷键在启动时加载并监听变更，瞬时文件系统故障后会自动恢复。技能正确读取 YAML frontmatter。Beta 的上传诊断和可写失败处理带隐私脱敏并更稳固；Stable 不发送 Beta 诊断。",
};

/** Translate only known release-history presentation text into Simplified Chinese. */
export function translateZhCnWhatsNewText(value: string): string {
  const exact = CHROME_TEXT[value] ?? WHATS_NEW_TEXT[value];
  if (exact) return exact;

  const date = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})$/.exec(value);
  if (date) {
    const month = date[1];
    const day = date[2];
    if (month && day) return `${MONTHS[month]}${day}日`;
  }

  const updates = /^(\d+) updates?$/.exec(value);
  if (updates) return `${updates[1]} 项更新`;

  return value;
}
