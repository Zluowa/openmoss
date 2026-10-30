// FILE: zhCNRuntimeUi.ts
// Purpose: Simplified-Chinese copy for presentation strings assembled by pure TypeScript
//          helpers, command definitions, notifications, and toast builders.
// Boundary: Only known UI chrome is translated. User text, prompts sent to providers,
//           paths, diagnostics, and unknown runtime values are returned unchanged.

type DynamicTranslation = readonly [pattern: RegExp, translate: (match: RegExpExecArray) => string];

const EXACT_TRANSLATIONS: Readonly<Record<string, string>> = {
  // Composer slash-command descriptions and feedback.
  "Start a fresh thread and clear the current conversation context":
    "开始新对话并清除当前对话上下文",
  "Compact the current thread context to free space": "压缩当前对话上下文以释放空间",
  "Context compacted": "上下文已压缩",
  "Context compacted manually": "已手动压缩上下文",
  "Context automatically compacted": "上下文已自动压缩",
  "Context compacted automatically": "已自动压缩上下文",
  "Manual context compaction failed": "手动压缩上下文失败",
  "Automatic context compaction failed": "自动压缩上下文失败",
  "Context compaction cancelled": "已取消压缩上下文",
  "Compacting context": "正在压缩上下文",
  "Compacting conversation...": "正在压缩对话上下文…",
  "Context automatically compacting": "正在自动压缩上下文",
  "Optimizing the conversation": "正在优化对话",
  "Optimized the conversation": "已优化对话",
  "Switch response model for this thread": "切换此对话使用的响应模型",
  "Switch this thread into plan mode": "将此对话切换到计划模式",
  "Switch this thread back to normal chat mode": "将此对话切回普通聊天模式",
  "Start a code review for current changes": "开始审阅当前代码更改",
  "Fork this thread into local or a new worktree": "将此对话派生到本地或新工作树",
  "Open a guarded Side from this thread": "从此对话打开受保护的 Side",
  "Show context usage and rate-limit status": "显示上下文用量和速率限制状态",
  "Insert a prompt that asks the assistant to delegate work": "插入一条请求助手委派工作的提示词",
  "Turn fast mode on or off for this thread": "开启或关闭此对话的快速模式",
  "Download this thread as a ZIP archive (thread.json + transcript.md)":
    "将此对话下载为 ZIP 归档（thread.json + transcript.md）",
  "Create a scheduled automation from this prompt": "根据此提示词创建定时自动化工作流",
  "Compact is unavailable": "无法压缩上下文",
  "Open an active supported server thread before compacting context.":
    "请先打开一个由服务器支持且处于活动状态的对话，再压缩上下文。",
  "Could not compact thread": "无法压缩对话",
  "An error occurred while compacting context.": "压缩上下文时发生错误。",
  "Fast mode is unavailable": "快速模式不可用",
  "The selected model does not support Fast mode.": "所选模型不支持快速模式。",
  "Invalid /fast command": "/fast 命令无效",
  "Use /fast, /fast on, /fast off, or /fast status.":
    "请使用 /fast、/fast on、/fast off 或 /fast status。",
  "Fast mode is on": "快速模式已开启",
  "Fast mode is off": "快速模式已关闭",
  "Fast mode enabled": "已开启快速模式",
  "Fast mode disabled": "已关闭快速模式",
  "Fork is unavailable": "无法派生对话",
  "Only existing server-backed threads can be forked right now.":
    "目前只能派生已有且由服务器支持的对话。",
  "Review is unavailable": "无法开始审阅",
  "Open a project thread before starting a native review.": "请先打开项目对话，再开始原生审阅。",
  "Base branch unavailable": "基准分支不可用",
  "Select or detect a base branch before starting this review.":
    "开始此审阅前，请先选择或检测基准分支。",
  "Could not start review": "无法开始审阅",
  "An error occurred while starting review.": "开始审阅时发生错误。",
  "Could not fork thread": "无法派生对话",
  "An error occurred while creating the forked thread.": "创建派生对话时发生错误。",
  "An error occurred while creating Side.": "创建 Side 时发生错误。",
  "Fast mode could not be checked": "无法检查快速模式",
  "Claude command discovery is unavailable right now.": "Claude 命令发现目前不可用。",
  "Claude command discovery failed. Please try again.": "Claude 命令发现失败，请重试。",
  "Claude did not expose /fast for this account or environment.":
    "Claude 未对此账号或环境提供 /fast。",
  "Open a server-backed thread and wait for the current turn to finish before exporting.":
    "请打开由服务器支持的对话，并等待当前轮次完成后再导出。",
  "Could not export thread": "无法导出对话",
  "An error occurred while exporting the thread.": "导出对话时发生错误。",
  "Invalid /review command": "/review 命令无效",
  "Use /review and then choose a review target.": "请使用 /review，然后选择审阅目标。",
  "Invalid /fork command": "/fork 命令无效",
  "Use /fork and then choose Local or New Worktree.":
    "请使用 /fork，然后选择“本地”或“新建工作树”。",

  // Keyboard-shortcut reference sheet.
  "Open the empty chat landing view.": "打开空白聊天首页。",
  "Quick Chat": "快速聊天",
  "Toggle Quick Chat without leaving the current task.": "无需离开当前任务即可切换快速聊天。",
  "New Claude thread": "新建 Claude 对话",
  "Start a fresh thread with Claude selected.": "新建对话并选择 Claude。",
  "New Codex thread": "新建 Codex 对话",
  "Start a fresh thread with Codex selected.": "新建对话并选择 Codex。",
  "New Cursor thread": "新建 Cursor 对话",
  "Start a fresh thread with Cursor selected.": "新建对话并选择 Cursor。",
  "New Gemini thread": "新建 Gemini 对话",
  "Start a fresh thread with Gemini selected.": "新建对话并选择 Gemini。",
  "Previous recent view": "上一个最近视图",
  "Cycle backward through recently opened primary views.": "向后切换最近打开的主视图。",
  "Next recent view": "下一个最近视图",
  "Cycle forward through recently opened primary views.": "向前切换最近打开的主视图。",
  "Next model": "下一个模型",
  "Cycle to the next model for the active provider (favorites first, then remaining models).":
    "切换到当前服务商的下一个模型（先收藏模型，再其他模型）。",
  "Previous model": "上一个模型",
  "Cycle to the previous model for the active provider (favorites first, then remaining models).":
    "切换到当前服务商的上一个模型（先收藏模型，再其他模型）。",
  "Open the composer reasoning and trait controls.": "打开输入框的推理与特性控件。",
  "Focus or blur the chat prompt composer.": "聚焦或取消聚焦聊天提示词输入框。",
  "Toggle terminal": "切换终端",
  "Show or hide the terminal surface for the active thread.": "显示或隐藏当前对话的终端界面。",
  "Toggle diff": "切换差异视图",
  "Open or close the working tree diff panel.": "打开或关闭工作树差异面板。",
  "Toggle browser": "切换浏览器",
  "Reveal the built-in browser panel for the active thread.": "显示当前对话的内置浏览器面板。",
  "Previous visible thread": "上一个可见对话",
  "Cycle to the previous thread that is currently visible in the sidebar.":
    "切换到侧边栏中上一个可见对话。",
  "Next visible thread": "下一个可见对话",
  "Cycle to the next thread that is currently visible in the sidebar.":
    "切换到侧边栏中下一个可见对话。",
  "Open in favorite editor": "在首选编辑器中打开",
  "Send the current thread or workspace target to your preferred editor.":
    "将当前对话或工作区目标发送到首选编辑器。",
  "Focus a visible thread directly from the sidebar number row.":
    "使用数字键直接聚焦侧边栏中的可见对话。",
  "Open full-width terminal workspace": "打开全宽终端工作区",
  "Expand the active thread into the workspace terminal layout.":
    "将当前对话展开为工作区终端布局。",
  "Focus terminal tab": "聚焦终端标签页",
  "Switch the workspace to the terminal tab.": "将工作区切换到终端标签页。",
  "Focus chat tab": "聚焦聊天标签页",
  "Switch the workspace back to the chat tab.": "将工作区切回聊天标签页。",
  "Available now": "当前可用",
  "These reflect the active workspace-terminal context.": "这些快捷键适用于当前工作区终端上下文。",
  "These reflect the current chat and sidebar context.": "这些快捷键适用于当前聊天和侧边栏上下文。",
  "Outside workspace mode": "工作区模式之外",
  "In workspace mode": "工作区模式中",
  "Number-row jumps return when the terminal workspace is closed.":
    "关闭终端工作区后，数字键跳转将恢复可用。",
  "These bindings take over when the terminal switches into workspace mode.":
    "终端切换到工作区模式后，将使用这些快捷键。",
  "Project scripts": "项目脚本",
  "Custom shortcuts defined for the active project's scripts.":
    "为当前项目脚本定义的自定义快捷键。",
  "Run the project setup script directly from the keyboard.": "直接使用键盘运行项目设置脚本。",
  "Run this project script without opening the scripts menu.":
    "无需打开脚本菜单即可运行此项目脚本。",
  Space: "空格",
  Esc: "Esc 键",
  Up: "上箭头",
  Down: "下箭头",
  Left: "左箭头",
  Right: "右箭头",

  // Git action menu, progress, and confirmation copy.
  "Commit & push": "提交并推送",
  "Create PR": "创建 PR",
  "Sync branch": "同步分支",
  "Commit, push & PR": "提交、推送并创建 PR",
  "View PR": "查看 PR",
  Push: "推送",
  "Push & create PR": "推送并创建 PR",
  "This action will commit and push changes.": "此操作会提交并推送更改。",
  "This action will push local commits.": "此操作会推送本地提交。",
  "Preparing feature branch...": "正在准备功能分支…",
  "Creating PR...": "正在创建 PR…",
  "Committing...": "正在提交…",
  "Generating commit message...": "正在生成提交信息…",
  "Pushing...": "正在推送…",
  "Committed changes": "已提交更改",

  // Thread import and automation warnings.
  "Session ID": "会话 ID",
  "Paste a Codex thread id": "粘贴 Codex 对话 ID",
  "Paste a Claude session id": "粘贴 Claude 会话 ID",
  "Paste a Cursor session id": "粘贴 Cursor 会话 ID",
  "Paste an OpenCode session id": "粘贴 OpenCode 会话 ID",
  "Paste a session id": "粘贴会话 ID",
  "Save additional Codex model slugs for the picker and `/model` command.":
    "保存额外的 Codex 模型标识，以便在选择器和 `/model` 命令中使用。",
  "Save additional Claude model slugs for the picker and `/model` command.":
    "保存额外的 Claude 模型标识，以便在选择器和 `/model` 命令中使用。",
  "Save additional Cursor model slugs for the picker and provider runtime.":
    "保存额外的 Cursor 模型标识，以便在选择器和服务商运行时中使用。",
  "Save additional Gemini model slugs for the picker and `/model` command.":
    "保存额外的 Gemini 模型标识，以便在选择器和 `/model` 命令中使用。",
  "Save additional Antigravity CLI base model names for the picker.":
    "保存额外的 Antigravity CLI 基础模型名称，以便在选择器中使用。",
  "Save additional Grok model slugs for the picker and `/model` command.":
    "保存额外的 Grok 模型标识，以便在选择器和 `/model` 命令中使用。",
  "Save additional OpenCode model slugs for the picker and provider runtime.":
    "保存额外的 OpenCode 模型标识，以便在选择器和服务商运行时中使用。",
  "Save additional Pi model slugs for the picker and provider runtime.":
    "保存额外的 Pi 模型标识，以便在选择器和服务商运行时中使用。",
  "Composer context is not persisted": "输入框上下文不会持久保存",
  "Attachments, provider mentions, pasted context, and terminal snippets will not be replayed on scheduled runs.":
    "附件、服务商提及、粘贴的上下文和终端片段不会在定时运行时重放。",
  "Fast recurring loop": "高频循环",
  "Intervals under one minute can create noisy unattended runs.":
    "小于一分钟的间隔可能产生频繁且无人值守的运行。",
  "Scheduled full-access runs can make changes without per-step approval.":
    "定时的完全访问运行可以在无需逐步批准的情况下进行更改。",
  "Local checkout": "本地检出",
  "Runs may edit files in the active project checkout.": "运行可能会编辑当前项目检出中的文件。",
  "Review generated fields": "检查生成的字段",
  "Moss was not fully confident about the parsed automation fields.":
    "Moss 对解析出的自动化工作流字段没有充分把握。",
  "Skill reference kept in prompt": "技能引用已保留在提示词中",
  "Skill tokens stay as prompt text unless the selected provider can resolve them at run time.":
    "技能标记会保留为提示词文本，除非所选服务商能在运行时解析它们。",
  "Not scheduled": "未安排",
  Sun: "周日",
  Mon: "周一",
  Tue: "周二",
  Wed: "周三",
  Thu: "周四",
  Fri: "周五",
  Sat: "周六",
  "Chat automation": "聊天自动化工作流",
  'Sure, what should this automation do, and how often should it run? For example: "every weekday at 9am, summarize my open PRs."':
    "好的，这个自动化工作流应该做什么，以及多久运行一次？例如：“每个工作日上午 9 点，总结我未关闭的 PR。”",
  "What should this automation do? For example: summarize my open PRs, or check the build.":
    "这个自动化工作流应该做什么？例如：总结我未关闭的 PR，或检查构建。",
  "How often should this automation run? For example: every 6 hours, weekdays at 9am, or daily at 18:00.":
    "这个自动化工作流应该多久运行一次？例如：每 6 小时、工作日上午 9 点或每天 18:00。",
  "A couple more details: what should this automation do, and how often should it run?":
    "还需要几个信息：这个自动化工作流应该做什么，以及多久运行一次？",

  // Toasts, status pills, and task notifications.
  "Path copied": "已复制路径",
  "Failed to copy path": "复制路径失败",
  "Failed to copy thread ID": "复制对话 ID 失败",
  "Unable to refresh provider status": "无法刷新服务商状态",
  "Unknown error refreshing provider status.": "刷新服务商状态时发生未知错误。",
  "Review updates": "查看更新",
  "Update all": "全部更新",
  "Task added to Drafts": "任务已添加到草稿",
  "Task started": "任务已开始",
  "Finish this task in the chat": "在聊天中完成此任务",
  "Worktree setup stays on the normal composer send path.":
    "工作树设置仍需通过常规输入框发送流程完成。",
  "The task was saved as a draft.": "任务已保存为草稿。",
  "Couldn't start the task": "无法启动任务",
  "The task was saved to Drafts instead. Open it to send manually.":
    "任务已改为保存到草稿；请打开后手动发送。",
  "Unexpected error.": "发生意外错误。",
  "Task didn't start": "任务未启动",
  "Could not hand off to worktree": "无法交接到工作树",
  "Could not hand off to local": "无法交接到本地",
  "An error occurred during the handoff.": "交接过程中发生错误。",
  "Failed to update pinned message": "更新固定消息失败",
  "The pinned message change could not be saved.": "无法保存固定消息的更改。",
  "Failed to save notes": "保存备注失败",
  "The note change could not be saved.": "无法保存备注更改。",
  "Pinned message limit reached": "已达到固定消息数量上限",
  "Selections can be up to 4,000 characters.": "所选内容最多可包含 4,000 个字符。",
  Selection: "所选内容",
  "1 referenced selection": "1 个已引用的所选内容",
  "Referenced selections": "已引用的所选内容",
  "Referenced assistant selection": "已引用助手所选内容",
  "Referenced assistant selections": "已引用助手所选内容",
  "Attached references": "已附加引用",
  "Untitled thread": "未命名对话",
  "Finished working.": "工作已完成。",
  "User input requested.": "需要用户输入。",
  "Input needed": "需要输入",
  "Command approval requested.": "需要批准命令。",
  "File-read approval requested.": "需要批准读取文件。",
  "File-change approval requested.": "需要批准更改文件。",
  "Awaiting Input": "等待输入",
  Working: "工作中",
  "Plan Ready": "计划已就绪",
  "Could not send the drafted prompt.": "无法发送草稿提示词。",
  "Plan preview unavailable.": "计划预览不可用。",
  "Implement plan": "实施计划",
  "Thinking On": "思考已开启",
  "Thinking Off": "思考已关闭",
  "In Progress": "进行中",
  "Thread archived": "对话已归档",
  "Thread deleted": "对话已删除",

  // Browser, recent-view, setup, and miscellaneous runtime chrome.
  "Terminal workspace": "终端工作区",
  "App settings": "应用设置",
  "Extensions and integrations": "扩展与集成",
  "Restoring tab...": "正在恢复标签页…",
  "No tabs open": "没有打开的标签页",
  "Starting browser...": "正在启动浏览器…",
  "Creating branch and worktree": "正在创建分支和工作树",
  "Linking thread workspace": "正在关联对话工作区",
  "Starting session": "正在启动会话",
  "Running setup action": "正在运行设置操作",
  "Worktree pending": "工作树待就绪",
  "New worktree (pending)": "新工作树（等待中）",
  "Diff and summary will be available once the worktree is ready for this chat.":
    "此对话的工作树就绪后，即可查看差异和摘要。",
  "Remove it or re-add it to include terminal output.": "请移除后重新添加，以包含终端输出。",
  "Re-add it if you want that terminal output included.": "如需包含该终端输出，请重新添加。",
  "Expired terminal context": "已过期的终端上下文",
  "Expired terminal contexts": "已过期的终端上下文",
  "New Chat": "新建对话",
  "The voice note could not be transcribed.": "无法转写语音备注。",
  "The microphone could not be opened.": "无法打开麦克风。",
  "Microphone access was denied. Enable it in macOS Privacy & Security > Microphone for Moss, then try again.":
    "麦克风访问被拒绝。请在 macOS 的“隐私与安全性”>“麦克风”中为 Moss 开启权限，然后重试。",
  "No microphone was found. Connect one and try again.": "未找到麦克风；请连接麦克风后重试。",
  "The microphone is busy or unavailable right now. Close other audio apps and try again.":
    "麦克风正被占用或当前不可用；请关闭其他音频应用后重试。",
  "Microphone access is blocked in this environment.": "当前环境阻止了麦克风访问。",
  "This usually means the folder is already linked to an existing project. On Windows, the same folder can arrive with a different path format, so it looks new even when it is not.":
    "这通常表示该文件夹已关联到现有项目。在 Windows 上，同一文件夹可能以不同路径格式出现，因此看起来像新文件夹。",
  "This is an absolute path from the filesystem root. If the folder is in your home directory, use ~/Developer/... or the full /Users/<name>/Developer/... path.":
    "这是从文件系统根目录开始的绝对路径。如果文件夹位于主目录中，请使用 ~/Developer/... 或完整的 /Users/<name>/Developer/... 路径。",
  "Browse folders on this computer": "浏览此电脑上的文件夹",
  "Folders on this PC": "这台 PC 上的文件夹",
  "Folders on this Mac": "这台 Mac 上的文件夹",
  "Folders on this System": "此系统上的文件夹",
  "Home folder is not available yet.": "主文件夹尚不可用。",
  "New project": "新建项目",
  "Add new project": "添加新项目",
  "Opening folder picker...": "正在打开文件夹选择器…",
  "Search projects": "搜索项目",
  "Unable to prepare a new chat.": "无法准备新对话。",
  "Unable to prepare a new Studio chat.": "无法准备新的 Studio 对话。",
  "Default app": "默认应用",
  "Pasted text": "粘贴的文本",
  "Marked text": "已标记文本",
  "File comment": "文件评论",
  "File comments": "文件评论",
  Handoff: "交接",
  Stopped: "已停止",
  "Reasoning trace": "推理轨迹",
  "Agent task": "智能体任务",
  "Agent activity": "智能体活动",
  "Ran command": "已运行命令",
  "Command run": "命令运行",
  Agent: "智能体",
  "By your workspace": "来自工作区",
  Favourites: "收藏",
  "Dock icon": "程序坞图标",
  Language: "语言",
  "Managed worktrees": "托管工作树",
  "Archived threads": "已归档对话",
  "Usage and billing": "用量与账单",
  "Your local activity, streaks, and a shareable stats card.":
    "查看本地活动、连续使用记录和可分享的统计卡片。",
  "Theme, typography, language, and timestamp formatting.":
    "设置主题、字体排版、语言和时间戳格式。",
  "Reference selection in chat": "在聊天中引用所选内容",
  "Sign in to ChatGPT again": "重新登录 ChatGPT",
  "Voice transcription failed": "语音转写失败",
  "Couldn't transcribe voice note": "无法转写语音备注",
  "Voice transcription is temporarily unavailable. Try again shortly.":
    "语音转写服务暂时不可用，请稍后重试。",
  "Voice transcription uses your ChatGPT session in Codex. That session was rejected, so sign in again there and retry.":
    "语音转写使用 Codex 中的 ChatGPT 会话。该会话已被拒绝，请在那里重新登录后重试。",
  Yesterday: "昨天",
  "Press both Option keys (⌥ ⌥) to snap any app’s window into the task you’re working in.":
    "同时按下两个 Option 键（⌥ ⌥），即可把任意应用窗口捕捉到当前任务中。",
  "The scan failed. Try refreshing.": "扫描失败，请尝试刷新。",
  "Local dev servers will appear here.": "本地开发服务器会显示在这里。",
  "Desktop app notifications use your operating system notification center.":
    "桌面应用通知使用操作系统通知中心。",
  "Browser notifications are enabled for this app.": "此应用已启用浏览器通知。",
  "Browser notifications are blocked. Re-enable them in your browser site settings.":
    "浏览器通知已被阻止，请在浏览器的网站设置中重新启用。",
  "Browser notifications need a secure context. Localhost works; plain HTTP does not.":
    "浏览器通知需要安全上下文；localhost 可以使用，普通 HTTP 不可以。",
  "This browser does not support desktop notifications.": "此浏览器不支持桌面通知。",
  "Allow browser notifications to get alerts when chats or terminal agents finish or need input in the background.":
    "允许浏览器通知，以便在聊天或终端智能体于后台完成或需要输入时收到提醒。",
  From: "来自",
  "Create and switch to a new branch from": "创建并切换到新分支，起点为",
  "e.g. npm run dev": "例如 npm run dev",
  "https://github.com/owner/repo/pull/42 or #42": "https://github.com/owner/repo/pull/42 或 #42",

  // Pure helper output for model effort, activity rows, and fallback/error surfaces.
  Minimal: "最低",
  "Extra High": "极高",
  Max: "最大",
  "Searched the web": "已搜索网页",
  "Generated image": "已生成图像",
  "Viewed image": "已查看图像",
  Reading: "正在读取",
  Searching: "正在搜索",
  Searched: "已搜索",
  Listing: "正在列出",
  Listed: "已列出",
  Finding: "正在查找",
  Found: "已找到",
  Creating: "正在创建",
  Removing: "正在移除",
  Removed: "已移除",
  Copying: "正在复制",
  Moving: "正在移动",
  Moved: "已移动",
  Ran: "已运行",
  Checked: "已检查",
  Comparing: "正在比较",
  Compared: "已比较",
  Inspecting: "正在检查",
  Inspected: "已检查",
  Reviewed: "已审阅",
  Staging: "正在暂存",
  Committing: "正在提交",
  Committed: "已提交",
  Pushing: "正在推送",
  Pulling: "正在拉取",
  Pulled: "已拉取",
  "Switching to": "正在切换到",
  "Switched to": "已切换到",
  "Unsupported diff format. Showing raw patch.": "不支持此差异格式，正在显示原始补丁。",
  "Failed to parse patch. Showing raw patch.": "无法解析补丁，正在显示原始补丁。",
  "Failed to load checkpoint diff.": "无法加载检查点差异。",
  "Provider status is still loading.": "服务商状态仍在加载。",
  "Git init is unavailable.": "Git 初始化不可用。",
  "Staging is unavailable.": "暂存不可用。",
  "Unstaging is unavailable.": "取消暂存不可用。",
  "Git checkout is unavailable.": "Git 检出不可用。",
  "Git action is unavailable.": "Git 操作不可用。",
  "Git pull is unavailable.": "Git 拉取不可用。",
  "Pull request thread preparation is unavailable.": "PR 对话准备不可用。",
  "Git handoff is unavailable.": "Git 交接不可用。",
  "This permanently clears the terminal history for this tab and deletes the empty terminal thread.":
    "这会永久清除此标签页的终端历史记录，并删除空的终端对话。",
  "This permanently clears the terminal history for this tab.":
    "这会永久清除此标签页的终端历史记录。",

  // Desktop update and theme-editor helper copy.
  "This install is using the correct architecture.": "当前安装使用了正确的系统架构。",
  "This Mac has Apple Silicon, but Moss is still running the Intel build under Rosetta. Moss is preparing the native Apple Silicon update.":
    "这台 Mac 使用 Apple 芯片，但 Moss 仍在 Rosetta 下运行 Intel 版本。Moss 正在准备原生 Apple 芯片更新。",
  "This Mac has Apple Silicon, but Moss is still running the Intel build under Rosetta. Click Update to restart into the native Apple Silicon build.":
    "这台 Mac 使用 Apple 芯片，但 Moss 仍在 Rosetta 下运行 Intel 版本。点击“更新”可重启并切换到原生 Apple 芯片版本。",
  "This Mac has Apple Silicon, but Moss is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.":
    "这台 Mac 使用 Apple 芯片，但 Moss 仍在 Rosetta 下运行 Intel 版本。下次应用更新会将其替换为原生 Apple 芯片版本。",
  "Applying update...": "正在应用更新…",
  "Check for updates": "检查更新",
  "Checking for updates...": "正在检查更新…",
  "Update check failed. Click to try again.": "检查更新失败；点击重试。",
  "Theme accent": "主题强调色",
  "Theme ink": "主题文字色",
  "Theme opaqueWindows": "主题不透明窗口",
  "Theme surface": "主题表面色",
  "Theme code font": "主题代码字体",
  "Theme UI font": "主题界面字体",
  "Theme diffAdded": "主题新增差异色",
  "Theme diffRemoved": "主题删除差异色",
  "Theme skill": "主题技能色",

  // Local debug UI. Sample task text, paths, branches, and diagnostics stay untouched.
  "Moss product shell default": "默认使用 Moss 产品外壳",
  "Use the Moss shell as the product-default placement for normal thread routes.":
    "在普通对话路由中默认使用 Moss 外壳布局。",
  "Trigger action failed toasts": "触发操作失败通知",
  "Show stacked Git action failure toasts for local UI testing.":
    "显示堆叠的 Git 操作失败通知，用于本地界面测试。",
  "Keep debug error toasts open": "保持调试错误通知开启",
  "Disable auto-dismiss for locally triggered error toasts.": "禁止自动关闭本地触发的错误通知。",
  "Keep a looping git progress toast visible for styling.":
    "保持循环 Git 进度通知可见，以便调试样式。",
  "Show debug task banner": "显示调试任务横幅",
  "Render a local sample active task banner for UI testing.":
    "渲染本地示例活动任务横幅，用于界面测试。",
  "Show Moss shell": "显示 Moss 外壳",
  "Chat completed": "聊天已完成",
  "Awaiting input": "等待输入",
  "Branch is behind upstream": "分支落后于上游",

  // Browser document titles for account routes.
  "Verify email · Moss": "验证邮箱 · Moss",
  "Reset password · Moss": "重置密码 · Moss",
  "Choose a new password · Moss": "设置新密码 · Moss",
  "Completing sign in · Moss": "正在完成登录 · Moss",
  "Create account · Moss": "创建账号 · Moss",
  "Account · Moss": "账号 · Moss",
  "Google sign in · Moss": "Google 登录 · Moss",
  "Moss Key · Moss": "Moss Key · Moss",
  "Sign in · Moss": "登录 · Moss",
};

const DYNAMIC_TRANSLATIONS: ReadonlyArray<DynamicTranslation> = [
  // Numeric UI limits and compact relative dates contain no user-authored slots.
  [
    /^You can keep up to (\d+) pinned messages in a thread\.$/,
    (match) => `每个对话最多可固定 ${match[1]} 条消息。`,
  ],
  [
    /^You can attach up to (\d+) references per message\.$/,
    (match) => `每条消息最多可附加 ${match[1]} 个引用。`,
  ],
  [/^(\d+)d$/, (match) => `${match[1]} 天`],
  [/^([\d,]+) days?$/, (match) => `${match[1]} 天`],
  [/^(-?\d+(?:\.\d+)?)bn$/, (match) => `${match[1]} 十亿`],
  [/^([\d,]+) lines?$/, (match) => `${match[1]} 行`],
  [/^([\d,]+) chars?$/, (match) => `${match[1]} 个字符`],
  [/^Jump to visible thread ([1-9])$/, (match) => `跳转到可见对话 ${match[1]}`],

  // Provider-update toast titles and descriptions retain provider names verbatim.
  [/^(\d+) provider updates available$/, (match) => `${match[1]} 个服务商有可用更新`],
  [/^(.+) update available$/, (match) => `${match[1]} 有可用更新`],
  [/^(.+) has a newer version available\.$/, (match) => `${match[1]} 有新版本可用。`],
  [
    /^(.+) and (\d+) more providers? have newer versions available\.$/,
    (match) => `${match[1]} 和另外 ${match[2]} 个服务商有新版本可用。`,
  ],

  // Runtime status wrappers retain server names, elapsed values, and provider previews verbatim.
  [/^(\d+) servers? running$/, (match) => `${match[1]} 个服务器正在运行`],
  [/^Stop ([^\r\n]+)$/, (match) => `停止 ${match[1]}`],
  [
    /^Worked for (\d+(?:\.\d+)?(?:ms|s)|\d+m(?: \d+s)?|\d+h(?: \d+m)?)$/,
    (match) => `已运行 ${match[1]}`,
  ],
  [/^(\d+) updates - ([\s\S]+)$/, (match) => `${match[1]} 次更新 - ${match[2]}`],

  // Native and fallback bulk dialogs arrive as complete newline-delimited messages.
  [
    /^Archive (\d+) threads? in "([\s\S]+)"\?\nArchived threads are hidden from the sidebar but can be restored later\.(?:\n\n(\d+) running threads? (?:is|are) currently active and will be skipped\.)?$/,
    (match) =>
      `归档“${match[2]}”中的 ${match[1]} 个对话？\n已归档对话会从侧边栏隐藏，但之后仍可恢复。${match[3] ? `\n\n${match[3]} 个对话正在运行，将被跳过。` : ""}`,
  ],
  [
    /^Failed to archive (\d+) threads?\. Skipped (\d+) running threads?\.$/,
    (match) => `归档 ${match[1]} 个对话失败。已跳过 ${match[2]} 个正在运行的对话。`,
  ],
  [
    /^Delete (\d+) threads? in "([\s\S]+)"\?\nThis permanently clears conversation history for these threads\.$/,
    (match) => `删除“${match[2]}”中的 ${match[1]} 个对话？\n这会永久清除这些对话的聊天记录。`,
  ],

  // Desktop-update versions and percentages are runtime values and stay byte-for-byte intact.
  [
    /^You're up to date on ([^\r\n]+)\. Click to check again\.$/,
    (match) => `当前已是 ${match[1]} 最新版本。点击可再次检查。`,
  ],
  [
    /^Moss restarted, but update ([^\r\n]+) was not installed\. Click to try again\.$/,
    (match) => `Moss 已重启，但未安装 ${match[1]} 更新。点击可重试。`,
  ],
  [
    /^Could not prepare update ([^\r\n]+)\. Click to retry\.$/,
    (match) => `无法准备 ${match[1]} 更新。点击可重试。`,
  ],
  [
    /^Could not install update ([^\r\n]+)\. Click to retry\.$/,
    (match) => `无法安装 ${match[1]} 更新。点击可重试。`,
  ],
  [/^Preparing update \((\d+)%\)$/, (match) => `正在准备更新（${match[1]}%）`],
  [/^Preparing update ([^\r\n]+)$/, (match) => `正在准备更新 ${match[1]}`],
  [
    /^Update ([^\r\n]+) is ready\. Click to restart and install\.$/,
    (match) => `${match[1]} 更新已就绪。点击可重启并安装。`,
  ],

  // Profile summaries keep the localized date/unit values emitted by their formatters.
  // Keep the units explicit: an open noun also rewrote ordinary sentences such as
  // "No account. Workspace data stays on this machine."
  [/^No (tokens?|prompts?) on ([^\r\n]+)$/, (match) => `${match[2]} 没有 ${match[1]}`],

  // Runtime-generated agent activity retains only a numeric count.
  [/^Spawning (\d+) agents?$/, (match) => `正在启动 ${match[1]} 个智能体`],
  [/^Waiting on (\d+) agents?$/, (match) => `正在等待 ${match[1]} 个智能体`],
  [/^Closing (\d+) agents?$/, (match) => `正在关闭 ${match[1]} 个智能体`],
  [/^Resuming (\d+) agents?$/, (match) => `正在恢复 ${match[1]} 个智能体`],
  [/^Updating (\d+) agents?$/, (match) => `正在更新 ${match[1]} 个智能体`],
  [/^Agent activity \((\d+)\)$/, (match) => `智能体活动（${match[1]}）`],

  // Provider-update lifecycle messages are emitted by the server. Translate only the exact
  // timeout shape while retaining the measured duration.
  [
    /^Update timed out after (\d+(?:\.\d+)?) (millisecond|milliseconds|second|seconds|minute|minutes)\. The provider process was stopped\.$/,
    (match) => {
      const unit = match[2]?.startsWith("millisecond")
        ? "毫秒"
        : match[2]?.startsWith("minute")
          ? "分钟"
          : "秒";
      return `更新等待 ${match[1]} ${unit}后超时，服务商进程已停止。`;
    },
  ],

  // User/provider titles, paths, branches, and setup-action values are reinserted byte-for-byte.
  [
    /^Could not read '(.+)'\. Paths with spaces or special characters may need a path mention \(@"…"\) instead of a file attachment\.$/,
    (match) =>
      `无法读取“${match[1]}”。包含空格或特殊字符的路径可能需要改用路径提及（@"…"），而不是文件附件。`,
  ],
  [/^Implement (.+)$/, (match) => `实施计划：${match[1]}`],
  [/^Pushing to (.+)\.\.\.$/, (match) => `正在推送到 ${match[1]}…`],
  [/^Commit & push to (.+)$/, (match) => `提交并推送到 ${match[1]}`],
  [/^Push to (.+)$/, (match) => `推送到 ${match[1]}`],
  [/^Running setup action: (.+)$/, (match) => `正在运行设置操作：${match[1]}`],
  [
    /^Run (codex|claudeAgent|cursor|gemini|antigravity|grok|droid|kilo|opencode|pi) native command$/,
    (match) => `运行 ${match[1]} 原生命令`,
  ],
  [/^Reference line (\d+(?::\d+(?:-\d+)?)?) in chat$/, (match) => `在聊天中引用第 ${match[1]} 行`],
  [
    /^Reference lines (\d+(?::\d+)?-\d+(?::\d+)?) in chat$/,
    (match) => `在聊天中引用第 ${match[1]} 行`,
  ],
  [/^Ask why line (\d+(?::\d+(?:-\d+)?)?) changed$/, (match) => `询问第 ${match[1]} 行为何更改`],
  [
    /^Ask why lines (\d+(?::\d+)?-\d+(?::\d+)?) changed$/,
    (match) => `询问第 ${match[1]} 行为何更改`,
  ],
  [/^(.+) line (\d+)$/, (match) => `${match[1]} 第 ${match[2]} 行`],
  [/^(.+) lines (\d+)-(\d+)$/, (match) => `${match[1]} 第 ${match[2]}–${match[3]} 行`],
  [
    /^Close terminal "([\s\S]+)"\?\nThis permanently clears the terminal history for this tab\.$/,
    (match) => `关闭终端“${match[1]}”？\n这会永久清除此标签页的终端历史记录。`,
  ],
  [
    /^Close terminal "([\s\S]+)"\?\nThis permanently clears the terminal history for this tab and deletes the empty terminal thread\.$/,
    (match) => `关闭终端“${match[1]}”？\n这会永久清除此标签页的终端历史记录，并删除空的终端对话。`,
  ],
  [
    /^Close this terminal\?\nThis permanently clears the terminal history for this tab\.$/,
    () => "关闭此终端？\n这会永久清除此标签页的终端历史记录。",
  ],
  [
    /^Close this terminal\?\nThis permanently clears the terminal history for this tab and deletes the empty terminal thread\.$/,
    () => "关闭此终端？\n这会永久清除此标签页的终端历史记录，并删除空的终端对话。",
  ],
  [
    /^This action will commit and push changes on "(.+)"\. You can continue on this branch or create a feature branch and run the same action there\.$/,
    (match) =>
      `此操作会在“${match[1]}”上提交并推送更改。你可以继续使用此分支，也可以创建功能分支并在那里执行相同操作。`,
  ],
  [
    /^This action will push local commits on "(.+)"\. You can continue on this branch or create a feature branch and run the same action there\.$/,
    (match) =>
      `此操作会在“${match[1]}”上推送本地提交。你可以继续使用此分支，也可以创建功能分支并在那里执行相同操作。`,
  ],
  [
    /^Pull requests can't be opened from "(.+)" into itself\. This action will create a feature branch, commit your changes there, push it, and create the PR\.$/,
    (match) =>
      `无法从“${match[1]}”向自身创建 PR。此操作会创建功能分支，在其中提交更改、推送并创建 PR。`,
  ],
  [
    /^Pull requests can't be opened from "(.+)" into itself\. This action will create a feature branch from your current commits, push it, and create the PR\.$/,
    (match) =>
      `无法从“${match[1]}”向自身创建 PR。此操作会基于当前提交创建功能分支、推送并创建 PR。`,
  ],
];

/** Translates known runtime-built UI chrome while preserving unknown/runtime text. */
export function translateZhCnRuntimeUiText(value: string): string {
  const exact = EXACT_TRANSLATIONS[value];
  if (exact !== undefined) return exact;

  for (const [pattern, translate] of DYNAMIC_TRANSLATIONS) {
    const match = pattern.exec(value);
    if (match) return translate(match);
  }

  return value;
}
