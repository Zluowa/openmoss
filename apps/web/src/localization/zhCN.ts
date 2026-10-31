// FILE: zhCN.ts
// Purpose: Completes Simplified Chinese coverage for UI chrome that has not reached typed i18n yet.
// Boundary: This is a reversible presentation fallback. Runtime content, code, paths, URLs,
//           model names, and diagnostics remain untouched, and English mode stays available.

import { translateZhCnAppSnapFeedbackText } from "./zhCNAppSnapFeedback";
import { translateZhCnAccountSettingsText } from "./zhCNAccountSettings";
import { translateZhCnComputerControlText } from "./zhCNComputerControl";
import { translateZhCnPullRequestText } from "./zhCNPullRequests";
import { translateZhCnRuntimeUiText } from "./zhCNRuntimeUi";
import { translateZhCnSettingsCopyText } from "./zhCNSettingsCopy";
import { translateZhCnWhatsNewText } from "./zhCNWhatsNew";
import { translateZhCnWorkspaceUiText } from "./zhCNWorkspaceUi";

const UI_TEXT: Readonly<Record<string, string>> = {
  "Add action": "添加操作",
  "Add Action": "添加操作",
  "Add panel": "添加面板",
  "Add project": "添加项目",
  All: "全部",
  Retry: "重试",
  // Realtime Voice follows the source application's reviewed build 6119 copy while keeping
  // Moss branding. Voice/model names and provider/runtime content intentionally stay unmapped.
  "Meet Moss Voice": "认识 Moss 语音",
  "Work across projects": "跨项目工作",
  "Start new tasks, coordinate work in progress, and pick up where you left off—without micromanaging":
    "开启新任务、协调进行中的工作，并从上次停下的地方继续——无需事事盯着",
  "Work across your desktop": "在整个桌面上工作",
  "Use your files, apps, and connected tools—from Slack and GitHub to Notion and beyond":
    "使用你的文件、应用和已连接的工具——从 Slack、GitHub 到 Notion 等",
  "Explore, plan, and learn": "探索、规划和学习",
  "Talk through a PR, ask questions about a codebase, or learn a new topic through natural back-and-forth":
    "讨论 PR、询问代码库相关问题，或通过自然的来回交流学习新主题",
  "Bring your screen into the conversation": "让你的屏幕加入对话",
  "Appshots let Moss use the active window’s image and text when you ask about what’s on screen.":
    "当你询问屏幕上的内容时，Appshots 可让 Moss 使用当前窗口的图像和文本。",
  "Use Appshots": "使用 Appshots",
  "You can turn this off anytime in Settings": "你随时可在“设置”中将其关闭",
  "Saving Appshots preference": "正在保存 Appshots 偏好设置",
  "Appshots couldn’t be updated": "无法更新 Appshots",
  "Appshots aren’t available on this device": "此设备不支持 Appshots",
  "Set up voice chat": "设置语音聊天",
  "Close voice chat setup": "关闭语音聊天设置",
  "Choose your voice": "选择你的语音",
  "You can change this anytime in Settings": "你随时可在“设置”中对此进行更改",
  "Start voice chat": "开启语音聊天",
  "Start new voice chat": "开始新的语音聊天",
  "Resume voice chat": "继续语音聊天",
  "Stop voice chat": "停止语音聊天",
  "Open voice chat": "打开语音聊天",
  "Starting voice chat": "正在开启语音聊天",
  "Voice chat couldn't start": "无法开启语音聊天",
  "Voice chat couldn’t start": "无法开启语音聊天",
  "Try again, or go back": "重试，或返回",
  "Try again": "重试",
  "Try Moss Voice": "试试 Moss 语音",
  "Orchestrate tasks, connect tools, and explore code": "编排任务，连接工具，探索代码",
  "Start Voice": "开始语音",
  "Dismiss voice chat banner": "关闭语音聊天横幅",
  "No compatible voices are available": "没有可用的兼容语音",
  "Loading compatible voices…": "正在加载兼容语音…",
  "Loading preview…": "正在加载预览…",
  "Preview unavailable": "预览不可用",
  "Previous voice": "上一个语音",
  "Next voice": "下一个语音",
  "Choose a voice": "选择语音",
  "Unable to load voice settings": "无法加载语音设置",
  "Unable to save voice": "无法保存语音",
  "Loading…": "正在加载…",
  "Easygoing and versatile": "随和且百搭",
  "Animated and earnest": "生动而真诚",
  "Composed and direct": "沉稳而直接",
  "Confident and optimistic": "自信且乐观",
  "Open and upbeat": "开朗且乐观",
  "Cheerful and candid": "开朗而直率",
  "Savvy and relaxed": "聪慧而从容",
  "Calm and affirming": "平静而肯定",
  "Bright and inquisitive": "明快而好奇",
  "Realtime Voice": "语音聊天",
  "Realtime Voice controls": "语音聊天控制项",
  "Move voice chat to floating overlay": "将语音聊天移到浮动窗口",
  "Mute microphone": "将麦克风静音",
  "Unmute microphone": "取消麦克风静音",
  "Mute voice output": "将语音输出静音",
  "Unmute voice output": "取消语音输出静音",
  "Mute voice chat": "将语音聊天静音",
  "Unmute voice chat": "取消语音聊天静音",
  "End voice chat": "结束语音聊天",
  "Preparing voice chat": "正在准备语音聊天",
  "Connecting voice chat": "正在连接语音聊天",
  "Ending voice chat": "正在结束语音聊天",
  Speaking: "正在说话",
  Thinking: "正在思考",
  Listening: "正在聆听",
  Read: "已读",
  File: "文件",
  Panel: "面板",
  Source: "源码",
  Custom: "自定义",
  "Built-in": "内置",
  Plugins: "插件",
  Agents: "智能体",
  Personal: "个人",
  Other: "其他",
  Featured: "精选",
  Marketplace: "插件市场",
  Subagents: "子智能体",
  "Check updates": "检查更新",
  "Checking...": "正在检查…",
  Preparing: "正在准备",
  "Updating...": "正在更新…",
  "Saving...": "正在保存…",
  "Save changes": "保存更改",
  "Delete action": "删除操作",
  "Delete threads": "删除对话",
  "Delete draft": "删除草稿",
  Restore: "恢复",
  Maximize: "最大化",
  "Close panel": "关闭面板",
  "Close plan sidebar": "关闭计划侧边栏",
  "Close image preview": "关闭图片预览",
  "Close search (Esc)": "关闭搜索（Esc）",
  "Add to chat": "添加到对话",
  "Remove attachment": "移除附件",
  "Remove comments": "移除评论",
  "Remove selections": "移除所选内容",
  "Remove marker": "移除标记",
  "Cancel turn": "取消本轮",
  "Cancel voice note": "取消语音备注",
  "Transcribing voice note": "正在转写语音备注",
  "Full Plan": "完整计划",
  "Hide files sidebar": "隐藏文件侧边栏",
  "Hide search sidebar": "隐藏搜索侧边栏",
  "Review files": "审阅文件",
  "Filter files": "筛选文件",
  "Hide file tree": "隐藏文件树",
  "Show file tree": "显示文件树",
  "No matching files.": "没有匹配的文件。",
  "Previous page": "上一页",
  "Next page": "下一页",
  "Fit width": "适合宽度",
  "Fit page": "适合页面",
  "Current page": "当前页",
  "All turns": "所有轮次",
  Turns: "轮次",
  "Choose diff source": "选择差异来源",
  "Diff source": "差异来源",
  "Diff view options": "差异视图选项",
  "Copy diff": "复制差异",
  "Copied diff": "已复制差异",
  "Jump to file": "跳转到文件",
  "Git actions": "Git 操作",
  Commit: "提交",
  "Git action options": "Git 操作选项",
  "Choose turn diff": "选择轮次差异",
  "Move to its own terminal tab": "移到独立终端标签页",
  "Collapse terminal into chat drawer": "将终端收回对话抽屉",
  "Collapse side panel": "收起侧边面板",
  "Open side panel": "打开侧边面板",
  "Actions are project-scoped commands you can run from the top bar or keybindings.":
    "操作是项目级命令，可从顶部工具栏或快捷键运行。",
  Name: "名称",
  "Choose icon": "选择图标",
  "Press shortcut": "按下快捷键",
  "Press a shortcut. Use": "按下快捷键。使用",
  Backspace: "退格键",
  "to clear.": "以清除。",
  "Save action": "保存操作",
  "Run automatically on worktree creation": "创建工作树时自动运行",
  "Resize Sidebar": "调整侧边栏宽度",
  "Drag to resize sidebar": "拖动以调整侧边栏宽度",
  "Copy message": "复制消息",
  "Edit message": "编辑消息",
  "Pin message": "固定消息",
  "Change model and reasoning": "更改模型和推理强度",
  "Record voice note": "录制语音备注",
  "Toggle environment panel": "切换环境面板",
  "Toggle diff panel": "切换差异面板",
  "Collapse panel": "收起面板",
  "Toggle Sidebar": "切换侧边栏",
  Apply: "应用",
  Archive: "归档",
  Archived: "已归档",
  Automations: "自动化工作流",
  Back: "返回",
  Browse: "浏览",
  "Type path": "输入路径",
  "Cancel add project": "取消添加项目",
  "Edit project": "编辑项目",
  "Open in Finder": "在 Finder 中打开",
  "Open in Kanban": "在看板中打开",
  "Start dev": "启动开发",
  "Edit name": "编辑名称",
  "Pin project": "固定项目",
  Browser: "浏览器",
  Cancel: "取消",
  Chat: "对话",
  Chats: "对话",
  Section: "分区",
  "Edit section": "编辑分区",
  "Archive all chats": "归档所有对话",
  "Delete section": "删除分区",
  "New section": "新建分区",
  "Remove from section": "移出分区",
  "Default list": "默认列表",
  "No threads in this section": "此分区暂无对话",
  "Section name": "分区名称",
  "Group chats and projects however you like": "随心整理聊天和项目",
  "Create section": "创建分区",
  "Unable to update section": "无法更新分区",
  "The app server is unavailable.": "应用服务器不可用。",
  "The section change was rejected.": "分区更改被拒绝。",
  "Could not confirm archive": "无法确认归档",
  "Unable to confirm the archive.": "无法确认归档操作。",
  "Section name is required.": "分区名称不能为空。",
  "Section name is too long.": "分区名称过长。",
  "Choose Chat": "选择对话",
  Clear: "清除",
  Close: "关闭",
  Code: "代码",
  Collapse: "收起",
  "Command palette": "命令面板",
  "Composer extras": "输入框扩展功能",
  Confirm: "确认",
  Continue: "继续",
  Copy: "复制",
  "Copy Path": "复制路径",
  "Copy Thread ID": "复制对话 ID",
  Create: "创建",
  "Create handoff thread": "创建交接对话",
  Current: "当前",
  Dark: "深色",
  Day: "日期",
  "Default permissions": "默认权限",
  Delete: "删除",
  Details: "详情",
  Diff: "差异",
  Done: "已完成",
  "Download manually": "手动下载",
  Edit: "编辑",
  Editor: "编辑器",
  "Editor view": "编辑器视图",
  Every: "每隔",
  Expand: "展开",
  Explorer: "文件浏览",
  Export: "导出",
  Files: "文件",
  "Fork Into Local": "派生到本地",
  "Fork Into New Worktree": "派生到新工作树",
  Git: "Git",
  "Hand off thread": "交接对话",
  Hide: "隐藏",
  Home: "主页",
  // Codex rail destinations (Moss rail spec).
  Images: "图像",
  Implement: "实施",
  Import: "导入",
  "Import thread from...": "导入对话自…",
  Inbox: "收信箱",
  Kanban: "看板",
  Library: "资料库",
  Light: "浅色",
  "Loading...": "加载中…",
  Local: "本地",
  "Max iterations": "最大迭代次数",
  Model: "模型",
  More: "更多",
  "New chat": "新建对话",
  "New terminal": "新建终端",
  New: "新建",
  "New thread": "新建对话",
  Next: "下一步",
  "Next question": "下一题",
  "Next run": "下次运行",
  No: "否",
  "No automations yet": "还没有自动化工作流",
  "No runs yet.": "还没有运行记录。",
  "No unread runs.": "没有未读运行结果。",
  Notifications: "通知",
  Off: "关",
  On: "开",
  Open: "打开",
  "Open Path in Terminal": "在终端中打开路径",
  Pause: "暂停",
  Paused: "已暂停",
  Pinned: "已固定",
  Plan: "计划",
  "Plan mode": "计划模式",
  "Add image": "添加图片",
  "Plan details": "计划详情",
  Previous: "上一步",
  "Previous runs": "历史运行",
  Project: "项目",
  Projects: "项目",
  Refresh: "刷新",
  Remove: "移除",
  Rename: "重命名",
  "Rename thread": "重命名对话",
  "Share with guest…": "分享给访客…",
  Resume: "继续运行",
  Review: "审阅",
  "Review Against Base Branch": "与基准分支比较审阅",
  "Review Uncommitted Changes": "审阅未提交的修改",
  Run: "运行",
  "Run at": "运行时间",
  "Runs in": "运行位置",
  Save: "保存",
  Search: "搜索",
  "Search projects, threads, and actions": "搜索项目、对话和操作",
  Suggested: "推荐",
  Recent: "最近使用",
  "Usage settings": "用量设置",
  "Import chat from…": "从…导入对话",
  "Jump to threads, projects, actions, or appearance.": "跳转到对话、项目、操作或外观设置。",
  "Enter to open": "按 Enter 打开",
  "Select a chat": "选择一个对话",
  "Select a thread or create a new one to get started.": "请选择一个对话，或新建对话后开始。",
  Send: "发送",
  "No chats in this project yet": "此项目还没有对话",
  Settings: "设置",
  Show: "显示",
  "Show less": "收起",
  "Show more": "显示更多",
  Side: "侧边对话",
  "Sort chats": "排序对话",
  "Sort threads": "排序对话",
  "Sort projects": "排序项目",
  "Last user message": "最后一条用户消息",
  Standalone: "独立运行",
  Status: "状态",
  Stop: "停止",
  Studio: "工作室",
  "Submit answers": "提交答案",
  System: "系统",
  Tasks: "任务",
  Temporary: "临时",
  Terminal: "终端",
  Thread: "对话",
  Threads: "对话",
  Time: "时间",
  Timezone: "时区",
  Today: "今天",
  Undo: "撤销",
  Unarchive: "取消归档",
  Unknown: "未知",
  "Unknown project": "未知项目",
  Unread: "未读",
  Update: "更新",
  "Update available": "有可用更新",
  Usage: "用量",
  View: "查看",
  Workspace: "工作区",
  Yes: "是",

  "What should we build?": "我们要构建什么？",
  "Moss logo": "Moss 标志",
  "this folder": "这个文件夹",
  "Work in": "工作位置",
  "Ask for follow-up changes or attach images": "提出后续修改，或附加图片",
  "Ask anything, @tag files/folders, or use / to show available commands":
    "随便问，使用 @ 引用文件/文件夹，或输入 / 查看可用命令",
  "Default permissions — click to change permissions": "默认权限 — 点此修改权限",
  "Provider is disabled in Moss settings.": "此提供商已在 Moss 设置中禁用。",
  "Provider is disabled": "提供商已禁用",
  Provider: "提供商",
  Providers: "提供商",
  "Provider visibility": "提供商显示",
  "Provider installs": "提供商安装",
  "Provider update checks": "检查提供商更新",
  "Provider tools": "提供商工具",
  "Custom models": "自定义模型",
  "CLI docs": "CLI 文档",
  "from your PATH.": "（来自 PATH）。",
  Install: "安装",
  Config: "配置",
  Headless: "无界面模式",
  Quickstart: "快速开始",
  "Leave blank to use": "留空即可使用",
  "Cursor editor CLI paths are accepted too.": "也支持 Cursor 编辑器 CLI 路径。",
  "Cursor Agent or Cursor CLI path": "Cursor Agent 或 Cursor CLI 路径",
  "Cursor API endpoint": "Cursor API 端点",
  "Optional Cursor API endpoint override passed to `cursor-agent -e`.":
    "可选的 Cursor API 端点覆盖值，将传给 `cursor-agent -e`。",
  "OpenAI response WebSockets": "OpenAI 响应 WebSocket",
  "Use Opencode's experimental OpenAI response WebSocket transport for managed local servers.":
    "为托管的本地服务器使用 OpenCode 实验性的 OpenAI 响应 WebSocket 传输。",
  "Pi agent directory": "Pi 智能体目录",
  "Optional custom Pi agent directory for auth, models, skills, and commands.":
    "可选的自定义 Pi 智能体目录，用于认证、模型、技能和命令。",

  "Needs review": "需要审阅",
  "New result": "有新结果",
  Active: "运行中",
  Auto: "自动",
  Mode: "模式",
  "Created from": "创建来源",
  "Created at": "创建时间",
  "Last ran": "上次运行",
  Repeats: "重复方式",
  Cron: "Cron 表达式",
  Never: "从不",
  Heartbeat: "心跳",
  "Approve the automation first": "请先批准此自动化工作流",
  "Cancel run": "取消运行",
  "Delete automation": "删除自动化工作流",
  "Automation run": "自动化运行",
  "Automation created": "已创建自动化工作流",
  "Automation updated": "已更新自动化工作流",
  "Automation needs a bit more detail": "自动化工作流还需要补充一些细节",
  "Chat required": "需要先选择对话",

  Compact: "紧凑",
  Comfortable: "舒适",
  Spacious: "宽松",
  Theme: "主题",
  "UI density": "界面密度",
  "Time format": "时间格式",
  "System default": "跟随系统",
  "Recently active": "最近活跃",
  "Recently added": "最近添加",
  "Newest first": "最新优先",
  "Manual order": "手动排序",
  "Base font size": "基础字号",
  "Terminal font size": "终端字号",
  "Terminal font": "终端字体",
  "Font smoothing": "字体平滑",
  "Activity toasts": "活动通知条",
  "Desktop notifications": "桌面通知",
  "Assistant output": "助手输出",
  "Delete confirmation": "删除确认",
  "Archive confirmation": "归档确认",
  "Terminal close confirmation": "关闭终端确认",
  "Restore default settings?": "恢复默认设置？",
  "Restore defaults": "恢复默认设置",

  "Loading models": "正在加载模型",
  "Loading browser...": "正在加载浏览器…",
  "Loading diff viewer...": "正在加载差异查看器…",
  "Loading explorer...": "正在加载文件浏览…",
  "Loading file...": "正在加载文件…",
  "Loading Git...": "正在加载 Git…",
  "Loading terminal...": "正在加载终端…",
  "Connecting to Moss server...": "正在连接 Moss 服务…",
  Connecting: "连接中",
  "Sending...": "发送中…",
  "Submitting...": "提交中…",
  "Preparing update": "正在准备更新",
  "Update ready": "更新已准备就绪",
  Updating: "更新中",
  Updated: "已更新",
  "Update failed": "更新失败",
  "Update queued": "更新已排队",
  "Still outdated": "仍不是最新版本",
  "Couldn’t finish updating": "无法完成更新",
  "Couldn’t download the update": "无法下载更新",

  "Archive thread": "归档对话",
  "Clear notification": "清除通知",
  "Mark unread": "标记为未读",
  "Temporary chat": "临时对话",
  "Pending approval": "等待批准",
  "Terminal input needed": "终端需要输入",
  "Terminal process running": "终端进程运行中",
  "Terminal task completed": "终端任务已完成",
  "Terminal is sleeping. Restoring shortly.": "终端正在休眠，即将恢复。",
  "No active thread": "没有活跃对话",
  "Project instructions added to notepad.": "项目说明已添加到记事本。",
  "Temporary chat — deleted when you leave. Click to keep it.":
    "临时对话 — 离开后将删除。点击可保留。",
  "Make this a temporary chat (deleted when you leave)": "设为临时对话（离开后删除）",
  "Plan mode — click to return to normal build mode": "计划模式 — 点击返回常规执行模式",
  "Stop generation": "停止生成",
  "Stop the current response. On Mac, press Ctrl+C to interrupt.":
    "停止当前回复。在 Mac 上按 Ctrl+C 中断。",
  "Implementation actions": "实施操作",
  AppSnap: "应用截图",
  "Not now": "暂不设置",
  "Set up AppSnap": "设置应用截图",
  "Moss AppSnaps are live!": "应用截图已启用！",
  "Press both Option keys (⌥ ⌥) to snap any app’s window into the task you’re working in.":
    "同时按下两个 Option 键（⌥ ⌥），即可把任意应用窗口捕捉到当前任务中。",
  "Toggle thread sidebar": "切换对话侧边栏",
  Forward: "前进",
  "Loading projects": "正在加载项目",
  "Loading projects...": "正在加载项目…",
  "Expand all projects": "展开所有项目",
  "Pin Grok": "固定 Grok",
  "Create new terminal thread in Grok": "在 Grok 中新建终端对话",
  "Create new thread in Grok": "在 Grok 中新建对话",
  "Pin thread": "固定对话",
  "Worked for 7.8s": "已运行 7.8 秒",
  "Full access": "完全访问",
  "Full access — click to change permissions": "完全访问 — 点击修改权限",
  "Context window 4.7% used": "已使用上下文窗口 4.7%",
  "Send message": "发送消息",
  "Back to app": "返回应用",
  "Search settings": "搜索设置",
  "Search settings...": "搜索设置…",
  App: "应用",
  General: "通用",
  Profile: "个人资料",
  Appearance: "外观",
  Behavior: "行为",
  "Keyboard Shortcuts": "键盘快捷键",
  Worktrees: "工作树",
  Models: "模型",
  Skills: "技能",
  Advanced: "高级",
  "Default provider, thread mode, and sidebar organization.":
    "默认提供商、对话模式和侧边栏组织方式。",
  "Core defaults": "核心默认设置",
  "Default provider": "默认提供商",
  "default provider": "默认提供商",
  "chats section": "对话分区",
  "studio section": "工作室分区",
  "environment panel default open": "环境面板默认打开状态",
  "Reset default provider to default": "将默认提供商重置为默认值",
  "Choose the provider used for new chats.": "选择新建对话使用的提供商。",
  "New threads": "新建对话",
  "Pick the default workspace mode for newly created draft threads.":
    "选择新建草稿对话的默认工作区模式。",
  "Sidebar organization": "侧边栏组织",
  "Project order": "项目排序",
  "Controls how projects are arranged in the main sidebar.": "控制项目在主侧边栏中的排列方式。",
  "Thread order": "对话排序",
  "Controls how threads are arranged inside each project in the main sidebar.":
    "控制每个项目内对话的排列方式。",
  "Sidebar sections": "侧边栏分区",
  "Reset chats section to default": "将对话分区重置为默认值",
  "Show the standalone Chats list in the sidebar footer (chats not tied to a project).":
    "在侧边栏底部显示独立对话列表（未绑定项目的对话）。",
  "Reset studio section to default": "将工作室分区重置为默认值",
  "Show the Studio tab in the sidebar switcher.": "在侧边栏切换器中显示工作室标签。",
  "Show the Workspace tab in the sidebar switcher. The Threads tab always stays visible.":
    "在侧边栏切换器中显示工作区标签。对话标签始终可见。",
  "Environment panel": "环境面板",
  "Open by default": "默认打开",
  "Open the chat Environment panel automatically on normal threads. When off, the panel stays closed until you open it. Your last open/close also updates this preference.":
    "在普通对话中自动打开环境面板。关闭时，面板会保持收起，直到你手动打开；上次开关状态也会更新此偏好。",
  Repository: "仓库",
  "Pull request": "拉取请求",
  "Pull requests": "拉取请求",
  Recap: "摘要",
  "Pinned messages": "已固定消息",
  "Text markers": "文本标记",
  "Project instructions": "项目说明",
  Notepad: "记事本",
  "Default thread mode": "默认对话模式",
  "Project sort order": "项目排序",
  "Thread sort order": "对话排序",
  "Working and unread on top": "进行中和未读置顶",
  "With Recently active order, move working and unread threads above the rest. The list holds still while your pointer is over it.":
    "在“最近活跃”排序下，把进行中和未读的对话排到其余对话前面。指针悬停在列表上时，顺序保持不动。",
  "working and unread on top": "进行中和未读置顶",
  "Move working and unread threads to the top of the sidebar": "把进行中和未读的对话移到侧边栏顶部",
  "Show the Chats section in the sidebar": "在侧边栏显示对话分区",
  "Show the Studio section in the sidebar": "在侧边栏显示工作室分区",
  "Show the Workspace section in the sidebar": "在侧边栏显示工作区分区",
  "Open the Environment panel by default on normal threads": "在普通对话中默认打开环境面板",
  "Show the Usage section in the Environment panel": "在环境面板中显示用量分区",
  "Show the Repository section in the Environment panel": "在环境面板中显示仓库分区",
  "Show the Pull request section in the Environment panel": "在环境面板中显示拉取请求分区",
  "Show the Editor section in the Environment panel": "在环境面板中显示编辑器分区",
  "Show the Recap section in the Environment panel": "在环境面板中显示摘要分区",
  "Show the Pinned messages section in the Environment panel": "在环境面板中显示已固定消息分区",
  "Show the Text markers section in the Environment panel": "在环境面板中显示文本标记分区",
  "Show the Project instructions section in the Environment panel": "在环境面板中显示项目说明分区",
  "Show the Notepad section in the Environment panel": "在环境面板中显示记事本分区",
  "Show the provider usage row in the chat Environment panel.":
    "在对话环境面板中显示提供商用量行。",
  "Show the GitHub repository link in the chat Environment panel. The git block (Changes, Worktree, branch, Commit and Push) always stays visible.":
    "在对话环境面板中显示 GitHub 仓库链接。Git 区块（更改、工作树、分支、Commit 和 Push）始终可见。",
  "Show the open pull request (CI checks and review comments) for the current branch in the chat Environment panel.":
    "在对话环境面板中显示当前分支的拉取请求（CI 检查和审阅评论）。",
  "Show the Editor section (in-app editor view and Open in editor picker) in the chat Environment panel.":
    "在对话环境面板中显示编辑器分区（应用内编辑器视图及“在编辑器中打开”选择器）。",
  "Show the auto-generated chat recap in the Environment panel.":
    "在环境面板中显示自动生成的对话摘要。",
  "Show the pinned-messages checklist in the Environment panel.":
    "在环境面板中显示已固定消息清单。",
  "Show highlighted and underlined transcript text in the Environment panel.":
    "在环境面板中显示高亮和下划线的对话文本。",
  "Show project-level instructions in the Environment panel.": "在环境面板中显示项目级说明。",
  "Show the per-thread notepad in the Environment panel.": "在环境面板中显示每个对话的记事本。",

  // Welcome tour (feature tour dialog and its settings re-entry point).
  "A new home for your work": "你的工作新家",
  "A slimmer rail, open-chat tabs, and refreshed icons put your workspace within reach.":
    "更窄的导航栏、已打开对话的标签页和焕然一新的图标，让你的工作区触手可及。",
  "Customize the rail and keep your favorite tools close.": "自定义导航栏，让常用工具近在咫尺。",
  "Move between open chats or work in split panes.": "在已打开的对话之间切换，或使用分屏窗格工作。",
  "Make it yours with project icons, colors, and window appearance.":
    "通过项目图标、颜色和窗口外观，打造属于你的风格。",
  "Your agents, together": "你的智能体，齐聚一堂",
  "Use multiple accounts from the same provider and choose the right one for each chat.":
    "使用同一服务商的多个账号，并为每个对话选择合适的账号。",
  "Add and sign in to accounts from provider settings.": "在服务商设置中添加并登录账号。",
  "See account names in the model picker and track their usage.":
    "在模型选择器中查看账号名称并跟踪其用量。",
  "Hand work to another provider from the picker, in the same thread.":
    "在同一对话中通过选择器将工作交给另一个服务商。",
  "From review to the next change": "从审阅到下一个更改",
  "The redesigned Code review page brings pull requests, issues, and agent actions into one place.":
    "重新设计的代码审阅页将拉取请求、议题和智能体操作汇聚一处。",
  "Browse and sort the list, then inspect a pull request or issue.":
    "浏览并排序列表，然后查看拉取请求或议题。",
  "Discuss changes in a side chat beside the details.": "在详情旁的侧边对话中讨论更改。",
  "Ask an agent to review or continue the work.": "让智能体审阅或继续这项工作。",
  "Give bigger work a team": "给更大的工作配一个团队",
  "Hubs bring a coordinator and worker agents together around a shared project in Moss Beta.":
    "在 Moss Beta 中，Hubs 让协调者与工作智能体围绕共享项目协同工作。",
  "Keep shared context in the Hub Library and track delegated work.":
    "在 Hub Library 中保存共享上下文，并跟踪已委派的工作。",
  "Plan Tasks in a list or Kanban board and hand them to agents.":
    "在列表或看板中规划任务，并交给智能体执行。",
  "Open Inbox for today's tasks, review requests, and activity recap.":
    "打开收信箱，查看今日任务、审阅请求和活动摘要。",
  "Skip tour": "跳过导览",
  "Start exploring": "开始探索",
  "Welcome tour": "欢迎导览",
  "Replay the first-run setup: feature tour, provider selection, appearance, and first project.":
    "重玩首次启动设置：功能导览、服务商选择、外观和第一个项目。",
  "Open welcome tour": "打开欢迎导览",
  "Welcome to Moss": "欢迎使用 Moss",
  "A local-first workspace for coding agents. Setup takes about a minute.":
    "给编程智能体用的本地工作区。大约一分钟就能设好。",
  "Local-first": "本地优先",
  "Your own agents": "你自己的智能体",
  "Verify before done": "完成前先核对",
  "Skip setup": "跳过设置",
  "What Moss can do": "Moss 能做什么",
  "Choose your agents": "选择你的智能体",
  "Pick an appearance": "选一个外观",
  "You're all set": "都准备好了",
  "Replay feature tour": "重播功能导览",

  // Project import landing banner.
  "Import your Claude Code and Codex projects": "导入你的 Claude Code 和 Codex 项目",
  "Bring your chats and continue them in Moss": "带上你的聊天记录，在 Moss 中继续",

  // Inbox greeting, recap empty state, and tile copy.
  "Good morning": "早上好",
  "Good afternoon": "下午好",
  "Good evening": "晚上好",
  "Nothing ran yet today. This fills in as your agents work.":
    "今天还没有任何运行记录。随着智能体工作，这里会自动填充。",
  "Mark all read": "全部标为已读",
  "Your tightest limit": "你最紧的限额",
  "Cache reads included": "包含缓存读取",
  "Nothing failed": "没有失败",
  "Your best model was": "你的最佳模型是",
  "You worked most on": "你投入最多的是",
  "You used": "你使用了",
  "Yesterday you used": "昨天你使用了",
  "You sent": "你发送了",
  across: "，分布在",
  "Your automations and agents ran": "你的自动化工作流和智能体已运行",
  "so far today.": "（今天截至目前）。",
  "Most of it went into": "其中大部分用于",
  ", with": "，使用",
  carrying: "占",
  "of the tokens": "的 tokens",
  "the rest": "占其余部分",
  "doing most of the work": "完成了大部分工作",
  "did most of the work": "完成了大部分工作",
  "doing the work": "完成了这些工作",
  "did all the work": "完成了全部工作",
  "Your agents ran for": "你的智能体运行了",
  "Nothing ran yet today. Yesterday you sent": "今天还没有运行记录。昨天你发送了",
  "Nothing ran yet today. Yesterday your agents used": "今天还没有运行记录。昨天你的智能体使用了",
  "and used": "并使用了",
  ", mostly with": "，主要使用",
  ", and": "，其中",
  "than this time yesterday.": "（对比昨天同时段）。",
  "than this time yesterday": "（对比昨天同时段）",

  // Safari access onboarding dialog and its settings entry point.
  "Safari import setup": "Safari 导入设置",
  "Bring your Safari logins along?": "要把 Safari 的登录状态带过来吗？",
  "Moss's browser can pick up sites you're already signed into in Safari, so you don't have to log in twice. It's optional, and nothing is copied until you ask.":
    "Moss 的浏览器可以沿用你在 Safari 中已登录的网站，无需重复登录。这完全可选，在你主动要求之前不会复制任何内容。",
  "Full Disk Access is a broad macOS permission that reaches beyond Safari. If you'd rather not, that's fine. You can find this again under Settings › General.":
    "“完全磁盘访问”是一个范围很广的 macOS 权限，不仅限于 Safari。如果你不想开启也没关系，之后可以在“设置 › 通用”中再次找到此选项。",
  "System Settings": "系统设置",
  "Open System Settings": "打开系统设置",
  "› Privacy & Security › Full Disk Access.": "› 隐私与安全性 › 完全磁盘访问。",
  "Not listed?": "没列出？",
  "Show app in Finder": "在访达中显示应用",
  "and drag it in.": "并将其拖入。",
  "Quit and reopen Moss.": "退出并重新打开 Moss。",
  "System Settings is open. Once Moss is switched on, quit and reopen it.":
    "系统设置已打开。为 Moss 开启权限后，退出并重新打开它。",
  "Moss is selected in Finder. Drag it into the Full Disk Access list.":
    "已在访达中选中 Moss，请将其拖入“完全磁盘访问”列表。",
  "Couldn't open it automatically. It lives in System Settings › Privacy & Security.":
    "无法自动打开。它位于“系统设置 › 隐私与安全性”中。",

  // Settings navigation groups, section descriptions, and eyebrows.
  Integrations: "集成",
  Coding: "编码",
  "Chat behavior": "对话行为",
  "Usage & limits": "用量与限额",
  "Computer use": "电脑控制",
  "Computer History": "电脑历史",
  "MCP connections": "MCP 连接",
  "Agent providers": "智能体服务商",
  "Models & writing": "模型与写作",
  "Agent skills": "智能体技能",
  "System tools": "系统工具",
  "Workflow defaults": "工作流默认值",
  "Bring existing work": "带上现有工作",
  "Your stats": "你的统计",
  "Visual language": "视觉语言",
  Alerts: "提醒",
  "Interaction rules": "交互规则",
  "Key bindings": "按键绑定",
  "Provider limits": "服务商限额",
  "Screen capture": "屏幕捕捉",
  "Desktop control": "桌面控制",
  "Local timeline": "本地时间线",
  "Live conversation": "实时对话",
  "External agents": "外部智能体",
  "Coding agents": "编码智能体",
  "Model configuration": "模型配置",
  "Reusable workflows": "可复用工作流",
  "Workspace management": "工作区管理",
  "Thread management": "对话管理",
  "Choose defaults for new chats, navigation, and the Environment panel.":
    "为新对话、导航和环境面板选择默认设置。",
  "Import safe setup, projects, skills, and recent chats from supported AI apps.":
    "从受支持的 AI 应用导入安全设置、项目、技能和最近的对话。",
  "Customize the theme, typography, density, and time format.":
    "自定义主题、字体排版、密度和时间格式。",
  "Choose how Moss tells you when work finishes or needs attention.":
    "选择 Moss 在工作完成或需要关注时如何通知你。",
  "Control live responses, follow-ups, review defaults, and safety confirmations.":
    "控制实时回复、后续跟进、审阅默认值和安全确认。",
  "Change, add, or remove the shortcut for every Moss command.":
    "更改、添加或移除每个 Moss 命令的快捷键。",
  "See remaining quota and credits for every signed-in provider.":
    "查看每个已登录服务商的剩余配额和额度。",
  "Capture another app's frontmost window directly into a task.":
    "将其他应用的最前窗口直接捕捉到任务中。",
  "Let agents see and control this computer's desktop, and check backend status.":
    "让智能体查看并控制这台电脑的桌面，并检查后端状态。",
  "Review your encrypted local app and website timeline and privacy controls.":
    "查看加密的本地应用与网站时间线以及隐私控制。",
  "Realtime voice, microphone, shortcut, and privacy controls.":
    "实时语音、麦克风、快捷键和隐私控制。",
  "Give Codex, Claude, and other local agents scoped access to Moss tasks.":
    "让 Codex、Claude 和其他本地智能体按权限范围访问 Moss 任务。",
  "Choose visible coding agents and manage their installed CLI tools.":
    "选择可见的编码智能体，并管理其已安装的 CLI 工具。",
  "Choose the source control writing style, Git writing model, and custom model slugs.":
    "选择源码管理写作风格、Git 写作模型和自定义模型标识。",
  "Review reusable workflows discovered across all configured providers.":
    "查看在所有已配置服务商中发现的可复用工作流。",
  "Review and clean up isolated workspaces created by Moss.": "查看并清理 Moss 创建的隔离工作区。",
  "Manage sessions, recovery tools, low-level keybindings, and version details.":
    "管理会话、恢复工具、底层按键绑定和版本详情。",
  "Find and restore threads you previously archived.": "查找并恢复你之前归档的对话。",

  // General settings panel rows.
  "Provider used for new chats until you pick a model. New chats then reuse your most recent model and options.":
    "在你选择模型之前，新对话使用此服务商；之后新对话会沿用你最近使用的模型和选项。",
  "Delete worktree on archive": "归档时删除工作树",
  "delete worktree on archive": "归档时删除工作树",
  "After Archive's Undo period, remove a clean worktree only if the task has stopped and no other task uses it. Its branch remains available for recovery.":
    "归档的撤销期过后，仅当任务已停止且没有其他任务使用时，才移除干净的工作树；其分支仍会保留以便恢复。",
  "Move sent messages to top": "将已发送消息置顶",
  "move sent messages to top": "将已发送消息置顶",
  "Move each sent message to the top of the conversation. Turn off to keep it at the bottom and follow replies as they stream.":
    "将每条已发送消息移到对话顶部；关闭后消息保留在底部，可跟随回复流式滚动。",
  "new threads": "新建对话",

  // Moss Beta channel card, install flow, and leave-beta dialog.
  "Try new features before everyone else. Moss Beta is a separate app with its own data, and this app stays exactly as it is. Beta shares crash reports and anonymous usage stats to help us improve it.":
    "先于所有人体验新功能。Moss Beta 是独立的应用，拥有独立数据，此应用保持原样。Beta 会分享崩溃报告和匿名使用统计，以帮助我们改进。",
  "Beta runs next to Moss with its own data, so nothing here changes. Copy your data to bring over projects, settings, and provider sign-ins. Beta shares crash reports and anonymous usage stats.":
    "Beta 与 Moss 并行运行且数据独立，此处的任何内容都不会改变。复制你的数据即可迁移项目、设置和服务商登录状态。Beta 会分享崩溃报告和匿名使用统计。",
  "Install Moss Beta": "安装 Moss Beta",
  "Installing…": "正在安装…",
  "Copy my data and open": "复制我的数据并打开",
  "Re-copy my data and open": "重新复制我的数据并打开",
  "Copying…": "正在复制…",
  "Download page": "下载页面",
  "Get Moss Beta": "获取 Moss Beta",
  "Get Moss": "获取 Moss",
  "Open Beta": "打开 Beta",
  "Opening…": "正在打开…",
  installed: "已安装",
  "Downloading Moss Beta…": "正在下载 Moss Beta…",
  "Verifying the download…": "正在验证下载…",
  "Installing Moss Beta…": "正在安装 Moss Beta…",
  "Opening Moss Beta…": "正在打开 Moss Beta…",
  "Last copied your data": "上次复制数据时间：",
  "Could not start the beta handoff": "无法开始 Beta 交接",
  "Try again from Settings → General.": "请从“设置 → 通用”重试。",
  "Opening Moss Beta": "正在打开 Moss Beta",
  "Beta is copying your projects, settings, and provider sign-ins from stable on first launch.":
    "Beta 首次启动时会从正式版复制你的项目、设置和服务商登录状态。",
  "Could not open Moss Beta": "无法打开 Moss Beta",
  "The beta install was not found.": "未找到 Beta 安装。",
  "Could not install Moss Beta": "无法安装 Moss Beta",
  "Could not switch back to Moss": "无法切换回 Moss",
  "Open Moss from your Applications folder.": "请从“应用程序”文件夹打开 Moss。",
  "You're on Moss Beta": "你正在使用 Moss Beta",
  "To help us fix problems, Beta shares crash reports, app errors, and anonymous usage counts. Crash reports may include private information.":
    "为帮助我们修复问题，Beta 会分享崩溃报告、应用错误和匿名使用统计。崩溃报告可能包含隐私信息。",
  "What Beta shares": "Beta 分享的内容",
  Shared: "分享内容",
  "Not included in usage counts": "不计入使用统计",
  "A random ID for this install, not linked to you": "此安装的随机 ID，不关联你的身份",
  "When Beta opens, closes, installs, or is removed": "Beta 的打开、关闭、安装或移除时间",
  "Crashes and errors; error details are filtered": "崩溃和错误；错误详情已经过滤",
  "App version, OS version, and language": "应用版本、系统版本和语言",
  "Which providers you use, and how many projects, chats, and turns (just counts)":
    "你使用的服务商，以及项目、对话和轮次的数量（仅计数）",
  "Whether updates install correctly": "更新是否安装成功",
  "Your chats, prompts, or agent replies": "你的对话、提示词或智能体回复",
  "Your code, files, or project names": "你的代码、文件或项目名称",
  "Keys, passwords, or account details": "密钥、密码或账号详情",
  "Error details are filtered, but may still include private information. Crash dumps include app memory that can't be filtered. Reports and dumps are kept with no expiry date.":
    "错误详情会经过过滤，但仍可能包含隐私信息。崩溃转储包含无法过滤的应用内存。报告和转储将无限期保留。",
  "Switch back to Moss": "切换回 Moss",
  "Switch back to Moss?": "切换回 Moss？",
  "Moss opens with the chats and settings it had before you tried Beta. Beta closes, and any chats still running in Beta stop.":
    "Moss 会恢复到你试用 Beta 之前的对话和设置。Beta 将关闭，其中仍在运行的对话也会停止。",
  "Anything you did in Beta stays in Beta. It can't be moved into Moss, because Beta can include features Moss doesn't have yet.":
    "你在 Beta 中的任何操作都会留在 Beta，无法迁移到 Moss，因为 Beta 可能包含 Moss 尚未具备的功能。",
  "Move Moss Beta to the Trash": "将 Moss Beta 移到废纸篓",
  "Your Beta data is kept, so you can pick up where you left off if you come back.":
    "你的 Beta 数据会保留，以便你回来时从上次停下的地方继续。",
  "Stay on Beta": "继续使用 Beta",
  "Switching…": "正在切换…",
  "Switch to Moss": "切换到 Moss",
  "Replace Moss Beta data?": "替换 Moss Beta 数据？",
  "Copying from Moss replaces Beta chats and projects. Chats and projects created only in Beta will be lost. Matching settings and provider sign-ins are overwritten, but Beta-only sign-ins may remain. Your data in Moss will not change.":
    "从 Moss 复制会替换 Beta 的对话和项目。仅在 Beta 中创建的对话和项目将丢失。匹配的设置和服务商登录状态会被覆盖，但仅在 Beta 登录的账号可能保留。你在 Moss 中的数据不会改变。",
  "Keep Beta data": "保留 Beta 数据",
  "Replace Beta data and open": "替换 Beta 数据并打开",
  "Quit Moss Beta first so it can pick up the import on its next launch.":
    "请先退出 Moss Beta，以便它下次启动时接收导入。",

  // High-exposure settings, Inbox, Kanban, computer-control, and MCP-connect residuals.
  "Accent color": "强调色",
  "Access all of Moss": "访问 Moss 的全部功能",
  "Add a task for today, or press Tab to hand it to an agent":
    "为今天添加一项任务，或按 Tab 交给智能体",
  "Advanced permissions": "高级权限",
  "Alert once the agent and all of its background subagents have finished. Turn this off to be alerted each time the agent or one of its subagents stops.":
    "在智能体及其所有后台子智能体全部完成后提醒一次。关闭后，智能体或其任一子智能体每次停止时都会提醒。",
  "Allow background checks and new turns. Enabling a provider does not install it or sign it in. Disabling keeps existing threads and does not interrupt a running turn.":
    "允许后台检查和新轮次。启用服务商不会安装或登录它；停用会保留现有对话，也不会中断正在运行的轮次。",
  "Approve the task": "批准该任务",
  "Ask for a task": "请求一项任务",
  "Available CLIs": "可用的 CLI",
  "Back to all projects": "返回所有项目",
  "CLI update checks": "CLI 更新检查",
  "Chat width": "对话宽度",
  "Choose exactly two keys: one modifier and one other key. Moss checks its own bindings and asks macOS whether another app already owns the shortcut before saving it.":
    "请只选择两个键：一个修饰键和另一个键。保存前，Moss 会检查自己的按键绑定，并询问 macOS 该快捷键是否已被其他应用占用。",
  "Choose the icon Moss uses in the dock or taskbar.": "选择 Moss 在程序坞或任务栏中使用的图标。",
  "Choose the voice Moss uses for new voice chats": "选择 Moss 在新语音聊天中使用的语音",
  "Choose what Enter does while a voice note is recording: stop and transcribe into the composer, or stop and send the message once it is transcribed.":
    "选择录音时按 Enter 的行为：停止并转写到输入框，或停止并在转写完成后直接发送。",
  "Choose where a pull request or issue link in a chat opens: the built-in review view, the in-app browser, or your external browser. Ctrl/Cmd+click always opens the external browser.":
    "选择对话中的拉取请求或议题链接在哪里打开：内置审阅视图、应用内浏览器或外部浏览器。Ctrl/Cmd+点击始终使用外部浏览器。",
  "Code and status": "代码与状态",
  "Command override": "命令覆盖",
  "Connect Codex, Claude, or another local MCP agent to create and follow Moss tasks.":
    "连接 Codex、Claude 或其他本地 MCP 智能体，以创建和跟进 Moss 任务。",
  "Connect a coding agent": "连接编码智能体",
  "Connected agents": "已连接的智能体",
  "Context and notes": "上下文与备注",
  "Control how wide the chat column grows. Wide and Full give tables and wide content more room.":
    "控制对话栏的最大宽度。“宽”和“全宽”可为表格和宽内容提供更多空间。",
  Conversation: "对话",
  "Copy the prompt and paste it into the agent you want to connect (Codex, Claude Code, or any MCP-capable app). The agent pairs this computer, registers Moss in its own configuration, and verifies the connection by itself.":
    "复制提示词并粘贴到你想连接的智能体（Codex、Claude Code 或任何支持 MCP 的应用）中。该智能体会自行完成与这台电脑的配对、在其配置中注册 Moss 并验证连接。",
  "Create connection": "创建连接",
  "Cursor colors": "光标颜色",
  "Custom source control writing instructions": "自定义源码管理写作说明",
  "Dedicated thread": "独立对话",
  "Desktop abilities": "桌面能力",
  "Done today": "今日已完成",
  "Enabled providers": "已启用的服务商",
  "Enter while dictating": "听写时的 Enter 键",
  "Expire a side chat after it sits idle, unviewed and not running, for this long. Expired side chats are read-only and unload their provider session.":
    "侧边对话在闲置（未查看且未运行）超过此时长后过期。过期的侧边对话为只读，并会卸载其服务商会话。",
  "Explore the redesigned workspace, provider accounts, and Code review.":
    "探索重新设计的工作区、服务商账号和代码审阅。",
  "Failed runs only": "仅失败的运行",
  "Follow and stop": "跟进与停止",
  "For apps without a terminal or chat, like Claude Desktop: run the pairing command in Terminal, then add the JSON below to the app's MCP configuration.":
    "对于没有终端或聊天界面的应用（如 Claude Desktop）：在终端中运行配对命令，然后将下方 JSON 添加到该应用的 MCP 配置中。",
  "Getting started": "快速上手",
  "Grant each permission with the steps above. If you take longer than 10 minutes, press Set up again.":
    "按上述步骤授予各项权限。如果超过 10 分钟，请再次点击“设置”。",
  "How this connection appears in Moss. Works with Codex, Claude, and any other MCP-capable agent.":
    "此连接在 Moss 中的显示方式。支持 Codex、Claude 和任何其他支持 MCP 的智能体。",
  "If asked, approve Computer for the task. Use the permission guide when desktop access is missing. Moss may still ask before consequential actions.":
    "如有提示，请为该任务批准“电脑控制”。缺少桌面访问权限时，请使用权限指南。对于影响较大的操作，Moss 仍可能先行询问。",
  "In progress": "进行中",
  "Keep titles concise. Use short bullet points in descriptions.":
    "标题保持简洁，描述中使用简短的要点。",
  "Let Moss inspect the foreground app when you refer to what's on screen. macOS asks for access the first time Moss needs it":
    "当你提到屏幕上的内容时，允许 Moss 检查前台应用。首次需要时 macOS 会请求授权",
  "Let the agent use the desktop in any chat": "允许智能体在任意对话中使用桌面",
  "Loading connections...": "正在加载连接…",
  "Loading managed worktrees...": "正在加载托管工作树…",
  "Make the message marks on the left of long chats move with sound: what your Mac plays (a video, a meeting), your microphone, or whichever is louder. macOS asks for access the first time. Moss only reads how loud the sound is and never records it.":
    "让长对话左侧的消息标记随声音律动：可选择 Mac 播放的声音（视频、会议）、你的麦克风，或两者中较响者。首次使用时 macOS 会请求授权。Moss 只读取响度，绝不录音。",
  "Manual update": "手动更新",
  "Message trail microphone": "消息轨迹麦克风",
  "Message trail sound": "消息轨迹声音",
  Microphone: "麦克风",
  "Microphone the message trail listens to. Pick a built-in one if you use Bluetooth headphones: opening their microphone lowers their sound quality. If the chosen microphone is not connected, the trail ignores the microphone instead of falling back to another one.":
    "消息轨迹监听的麦克风。使用蓝牙耳机时请选择内置麦克风：开启蓝牙耳机会降低音质。如果所选麦克风未连接，消息轨迹会忽略麦克风，而不是回退到其他麦克风。",
  "Needs you": "需要你处理",
  "No connected agents": "没有已连接的智能体",
  "No matching suggested fonts.": "没有匹配的推荐字体。",
  "Nothing on the board yet": "看板上还没有卡片",
  "Open a new chat in the agent you just connected and send this editable example. You never need to copy project IDs, model IDs, or request IDs yourself.":
    "在刚连接的智能体中打开一个新对话，并发送这个可编辑的示例。你无需手动复制项目 ID、模型 ID 或请求 ID。",
  "Open pull requests and issues": "打开拉取请求和议题",
  "Optional access for existing tasks, shared checkouts, or execution without approvals. The safe defaults are recommended.":
    "可选权限：访问现有任务、共享检出或免批准执行。建议使用安全的默认值。",
  "Optional shared credential directory": "可选的共享凭据目录",
  "Permission granted.": "权限已授予。",
  "Provider account directory": "服务商账号目录",
  "Provider activity": "服务商活动",
  "Read other project tasks": "读取其他项目的任务",
  "Rebuild local project indexes without clearing existing chats when the local state gets out of sync.":
    "当本地状态不同步时，重建本地项目索引，且不清除现有对话。",
  "Recent Computer actions": "最近的电脑操作",
  "Record AppSnap shortcut": "录制 AppSnap 快捷键",
  "Revoke this browser session and close every live Moss connection it owns. A fresh pairing link is required to reconnect.":
    "撤销此浏览器会话，并关闭其拥有的所有活跃 Moss 连接。重新连接需要新的配对链接。",
  "Screen context": "屏幕上下文",
  "Set up by hand instead": "改为手动设置",
  "Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background.":
    "当应用处于后台时，若聊天或托管终端智能体完成或需要输入，显示系统通知。",
  "Show both limits as two rings, or a single ring for one of them.":
    "用两个圆环分别显示两种限额，或用一个圆环显示其中一种。",
  "Show or hide installed providers in the picker and drag them into your preferred order. Hiding a provider here does not disable its server activity.":
    "在选择器中显示或隐藏已安装的服务商，并拖动调整顺序。在此处隐藏不会停用其服务器活动。",
  "Show the computer preview automatically when an agent drives the desktop":
    "当智能体操控桌面时自动显示电脑预览",
  "Show the live preview the first time an agent acts on the desktop in a chat. Compact keeps it small and glanceable; Large gives it the full wide card.":
    "在智能体首次于对话中操控桌面时显示实时预览。“紧凑”保持小巧易扫视；“大”则展示完整宽卡片。",
  "Side chat expiry": "侧边对话过期",
  "Source control writing style": "源码管理写作风格",
  "Start voice chat from anywhere on desktop": "在桌面任意位置开始语音聊天",
  "Task details": "任务详情",
  "Terminal command": "终端命令",
  "The agent can discover and work in every project, including ones you add later. Turn off to pick specific projects.":
    "智能体可以发现并在所有项目中工作，包括你以后添加的项目。关闭后可选择特定项目。",
  "The agent pointer is stock monochrome by default — like a normal pointer. Custom colors apply to new computer sessions.":
    "智能体指针默认为标准单色，与普通指针相同。自定义颜色对新电脑会话生效。",
  "The connection lasts 30 days and can be revoked at any time. The next screen gives you one prompt to paste into your agent.":
    "连接有效期为 30 天，可随时撤销。下一屏会给你一条提示词，粘贴到你的智能体中即可。",
  "This browser": "此浏览器",
  "To do today": "今日待办",
  "Today’s tasks": "今日任务",
  "Type /computer-use followed by your task, for example: “/computer-use open Calculator and calculate 123 × 45.” This enables Computer for that request only. The default setting below can enable it on every turn.":
    "输入 /computer-use 后接你的任务，例如：“/computer-use 打开计算器并计算 123 × 45”。这仅对该请求启用电脑控制；下方的默认设置可在每一轮都启用。",
  "Type a shortcut": "输入快捷键",
  "Typography and spacing": "字体排版与间距",
  "Updating app icon": "正在更新应用图标",
  "Use custom title bar": "使用自定义标题栏",
  "Used for voice chat and dictation": "用于语音聊天和听写",
  "Voice chat": "语音聊天",
  "Voice chat hotkey": "语音聊天快捷键",
  "Voice chat hotkey capture": "录制语音聊天快捷键",
  "Wait for subagents": "等待子智能体",
  "Wait for subagents before alerting": "提醒前等待子智能体",
  "Watch the preview while the agent works. Use Stop in the chat to interrupt the task. Closing the preview only hides it.":
    "在智能体工作时观察预览。使用对话中的“停止”可中断任务；关闭预览只是将其隐藏。",
  "What’s new since 0.9.2": "自 0.9.2 以来的新变化",
  "Your day so far": "你今天到目前为止",

  // Beta welcome sheet and Spaces / Library residuals.
  "Welcome to Moss Beta": "欢迎使用 Moss Beta",
  "New features land here first, before they reach Moss.":
    "新功能会先在这里推出，然后再进入 Moss。",
  "Moss stays separate and untouched.": "Moss 保持独立，不受任何影响。",
  "Switch back to Moss any time in Settings.": "随时可在“设置”中切换回 Moss。",
  "Your chats and settings came over from Moss.": "你的对话和设置已从 Moss 迁移过来。",
  "Your Moss data couldn't be copied, so you're starting fresh.":
    "你的 Moss 数据无法复制，因此将从零开始。",
  "Starting fresh. Nothing was copied over.": "从零开始，未复制任何内容。",
  "Get started": "开始使用",
  "Delete space": "删除空间",
  "Space name": "空间名称",
  "Library sections": "资料库分区",

  // Project import dialog, announcement, and onboarding residuals.
  "Import projects": "导入项目",
  "Add projects from": "添加项目，来源：",
  "Added projects": "已添加的项目",
  "Bring your Claude Code and Codex projects into Moss and continue their chats right where you left off.":
    "将你的 Claude Code 和 Codex 项目带入 Moss，并从上次停下的地方继续对话。",
  "Dismiss project import banner": "关闭项目导入横幅",
  "Folder unavailable": "文件夹不可用",
  "Import failures": "导入失败",
  "Optional: existing folder path": "可选：现有文件夹路径",
  "Project folder path": "项目文件夹路径",
  "Projects available to import": "可导入的项目",
  "Search imported projects": "搜索已导入的项目",
  "Search projects or folders…": "搜索项目或文件夹…",
  "Setup progress": "设置进度",
  "Moss capabilities": "Moss 功能",

  // First-run "what Moss can do" tour cards.
  "Any agent": "任意智能体",
  "Run every coding agent in one workspace": "在一个工作区中运行所有编码智能体",
  "Moss sits around the agent runtimes you already trust: Claude Code, Codex, Cursor, Devin, Antigravity, Grok, Factory Droid, OpenCode, and Pi. The provider keeps its account, models, and limits. Moss owns the durable task, environment, transcript, and delivery workflow around it.":
    "Moss 围绕你已信赖的智能体运行时构建：Claude Code、Codex、Cursor、Devin、Antigravity、Grok、Factory Droid、OpenCode 和 Pi。服务商保留其账号、模型和限额；Moss 负责其外围的持久任务、环境、对话记录和交付工作流。",
  "Switch models mid-thread": "在对话中途切换模型",
  "Hand a thread to another provider": "将对话交给另一个服务商",
  "Usage for every provider": "查看每个服务商的用量",
  "Tasks & worktrees": "任务与工作树",
  "One task, one isolated environment": "一个任务，一个隔离环境",
  "Each task owns one body of work: its conversation, provider session, working environment, tool activity, and Git changes. Run tasks in parallel on managed Git worktrees so two agents never edit the same checkout.":
    "每个任务拥有一份完整的工作：对话、服务商会话、工作环境、工具活动和 Git 更改。在托管的 Git 工作树上并行运行任务，两个智能体绝不会编辑同一个检出。",
  "Forks from any message": "从任意消息派生",
  "Subagents and side chats": "子智能体与侧边对话",
  "Review & PRs": "审阅与 PR",
  "From objective to evidence": "从目标到实证",
  "A task is complete only after you understand and verify its result, not when the provider reports it is finished. Inspect diffs, run terminals, then commit, push, and open a pull request without leaving the workspace.":
    "只有当你理解并验证了结果，任务才算完成——而不是服务商报告完成就算。无需离开工作区，即可检查差异、运行终端，然后提交、推送并创建拉取请求。",
  "Diff review with file tree": "带文件树的差异审阅",
  "Commit → push → PR": "提交 → 推送 → PR",
  "Native pull-request workspace": "原生拉取请求工作区",
  "Browser & devices": "浏览器与设备",
  "Verify in a real browser or simulator": "在真实浏览器或模拟器中验证",
  "Agents drive a visible, task-owned browser you can watch and annotate. On macOS, an iOS Simulator pane streams the device so agents can build, launch, and tap through an app while you follow along.":
    "智能体驱动一个可见的、任务专属的浏览器，你可以观看并标注。在 macOS 上，iOS 模拟器窗格会串流设备画面，智能体可以构建、启动并点击操作应用，你全程跟进。",
  "Shared Chromium surface": "共享 Chromium 界面",
  "Element annotations": "元素标注",
  "iOS Simulator pane": "iOS 模拟器窗格",
  "Automations & goals": "自动化与目标",
  "Hand off work that should keep moving": "交接需要持续推进的工作",
  "Schedule recurring runs, attach a persistent goal to a thread so it keeps going after each clean turn, and let Moss bring you back when something needs attention. Scheduled does not mean autonomous approval.":
    "安排定时循环运行，为对话附加持久目标使其在每轮完成后继续前进，并在需要关注时让 Moss 提醒你。定时运行不等于自动批准。",
  "Interval, daily, cron schedules": "间隔、每天、cron 定时",
  "Natural-language stop conditions": "自然语言停止条件",
  "Thread goals": "对话目标",
  "Agent Gateway": "智能体网关",
  "Let agents operate Moss itself": "让智能体操作 Moss 本身",
  "A built-in MCP surface lets a supported provider session create tasks, wait on them, read transcripts, and steer other threads. Pair Codex, Claude Code, or Claude Desktop from outside with scoped, revocable credentials.":
    "内置的 MCP 接口让受支持的服务商会话可以创建任务、等待结果、读取对话记录并操控其他对话。使用限定范围、可撤销的凭据，从外部配对 Codex、Claude Code 或 Claude Desktop。",
  "Parallel task batches": "并行任务批次",
  "External MCP pairing": "外部 MCP 配对",
  "Approval boundaries": "批准边界",
  Shortcuts: "快捷键",
  "Keep your hands on the keyboard": "双手不离键盘",
  "Everything in the workspace has a shortcut, and the keymap is editable from Settings. A few worth learning on day one:":
    "工作区中的一切都有快捷键，键位映射可在“设置”中编辑。以下几个值得在第一天就记住：",
  "Search sidebar": "搜索侧边栏",
  "Add your first project": "添加你的第一个项目",
  "Could not add the project.": "无法添加该项目。",
  "Could not open the folder picker.": "无法打开文件夹选择器。",
  "Diff, terminal, browser and PR stay in one loop.": "差异、终端、浏览器和 PR 都在同一闭环中。",
  "Drives the CLIs, accounts and keys already set up here.": "驱动已在此设置好的 CLI、账号和密钥。",
  "No account. Workspace data stays on this machine.": "不需要账号。工作区数据留在这台电脑上。",
  "Check for outdated dependencies, bump the safe minor and patch versions, then run the tests.":
    "检查过时的依赖，升级安全的次版本和补丁版本，然后运行测试。",
  "Local folders unavailable": "本地文件夹不可用",
  "Stopped after a failed run": "因运行失败而停止",
  "Turn off Send as draft to send as goal.": "关闭“以草稿发送”即可作为目标发送。",
  Share: "分享",
  Activity: "活动",
  "Activity insights": "活动洞察",
  "Most used provider": "最常用提供商",
  "Most used reasoning": "最常用推理强度",
  "Most active hour": "最活跃时段",
  "Most worked project": "最常处理项目",
  "Skills explored": "已探索技能",
  "Total skills used": "已使用技能总数",
  "Total threads": "对话总数",
  "Most used plugins": "最常用插件",
  "No skills or agents used yet.": "尚未使用技能或智能体。",
  "Model usage": "模型用量",
  "Lifetime tokens": "累计 Token 数",
  "Peak day": "单日峰值",
  "Total prompts": "提示词总数",
  "Current streak": "当前连续天数",
  "Longest streak": "最长连续天数",
  "Share your activity": "分享你的活动",
  "Copy stat card": "复制统计卡片",
  "Share to X": "分享到 X",
  "Share to LinkedIn": "分享到 LinkedIn",
  "Share to Reddit": "分享到 Reddit",
  "Save stat card": "保存统计卡片",
  "Edit profile": "编辑个人资料",
  "Edit avatar": "编辑头像",
  "Upload photo": "上传照片",
  "Display name": "显示名称",
  "Your name": "你的名字",
  Username: "用户名",
  username: "用户名",
  "Theme, typography, and timestamp formatting.": "主题、排版与时间戳格式。",
  "Theme and typography": "主题与排版",
  "Reset theme to default": "将主题重置为默认值",
  "Choose how Moss looks across the app.": "选择 Moss 在整个应用中的外观。",
  "Theme preference": "主题偏好",
  theme: "主题",
  "base font size": "基础字号",
  "time format": "时间格式",
  "Dark theme": "深色主题",
  "Light theme": "浅色主题",
  Reset: "重置",
  Accent: "强调色",
  Background: "背景",
  Foreground: "前景",
  "UI font": "界面字体",
  "Code font": "代码字体",
  "Translucent sidebar": "半透明侧边栏",
  Contrast: "对比度",
  "This is the active theme right now.": "这是当前启用的主题。",
  "Inactive while the app is locked to dark.": "应用锁定为深色时不可用。",
  "Dark theme code theme": "深色主题代码配色",
  "Light theme code theme": "浅色主题代码配色",
  "Dark theme accent color": "深色主题强调色",
  "Dark theme background color": "深色主题背景色",
  "Dark theme foreground color": "深色主题前景色",
  "Light theme accent color": "浅色主题强调色",
  "Light theme background color": "浅色主题背景色",
  "Light theme foreground color": "浅色主题前景色",
  "Dark theme UI font": "深色主题界面字体",
  "Light theme UI font": "浅色主题界面字体",
  "Dark theme code font": "深色主题代码字体",
  "Light theme code font": "浅色主题代码字体",
  "Dark theme translucent sidebar": "深色主题半透明侧边栏",
  "Light theme translucent sidebar": "浅色主题半透明侧边栏",
  "Dark theme contrast": "深色主题对比度",
  "Light theme contrast": "浅色主题对比度",
  "深色主题 code theme": "深色主题代码配色",
  "浅色主题 code theme": "浅色主题代码配色",
  "深色主题 accent color": "深色主题强调色",
  "浅色主题 accent color": "浅色主题强调色",
  "深色主题 background color": "深色主题背景色",
  "浅色主题 background color": "浅色主题背景色",
  "深色主题 foreground color": "深色主题前景色",
  "浅色主题 foreground color": "浅色主题前景色",
  "深色主题 UI font": "深色主题界面字体",
  "浅色主题 UI font": "浅色主题界面字体",
  "深色主题 code font": "深色主题代码字体",
  "浅色主题 code font": "浅色主题代码字体",
  "深色主题 translucent sidebar": "深色主题半透明侧边栏",
  "浅色主题 translucent sidebar": "浅色主题半透明侧边栏",
  "深色主题 contrast": "深色主题对比度",
  "浅色主题 contrast": "浅色主题对比度",
  Color: "颜色",
  Hue: "色相",
  Saturation: "饱和度",
  Brightness: "亮度",
  "Reset to default": "恢复默认值",
  "Default (JetBrains Mono)": "默认（JetBrains Mono）",
  "Control spacing in the sidebar, composer, chat gutters, and settings rows without changing font size.":
    "在不改变字号的前提下，调整侧边栏、输入框、对话边距和设置行的间距。",
  "Reset base font size to default": "将基础字号恢复为默认值",
  "Adjust the app text base in pixels. Chat and UI typography scale proportionally from this value.":
    "以像素设置应用文字基础字号；对话和界面排版会按此值等比缩放。",
  "Base font size in pixels": "基础字号（像素）",
  "Adjust terminal text independently from the app and chat font size.":
    "独立调整终端文字，不影响应用和对话字号。",
  "Terminal font size in pixels": "终端字号（像素）",
  "Type any monospace font installed on this device (e.g. Fira Code). Leave empty for the default. Fonts that aren't installed fall back to the system monospace.":
    "输入本机已安装的任意等宽字体（如 Fira Code）。留空则使用默认字体；未安装的字体会回退到系统等宽字体。",
  "Terminal font family": "终端字体系列",
  "Enable font smoothing": "启用字体平滑",
  "Use macOS-style antialiasing for lighter, crisper text rendering.":
    "使用 macOS 风格抗锯齿，使文字更轻盈清晰。",
  "Time and reading": "时间与阅读",
  "Reset time format to default": "将时间格式恢复为默认值",
  "System default follows your browser or OS clock preference.": "跟随浏览器或操作系统的时钟偏好。",
  "Timestamp format": "时间戳格式",
  "12-hour": "12 小时制",
  "24-hour": "24 小时制",
  "In-app toasts and desktop alerts.": "应用内提示条与桌面提醒。",
  "Activity alerts": "活动提醒",
  "Show an in-app toast when a chat or managed terminal agent finishes or needs input.":
    "当对话或受管理终端智能体完成或需要输入时，显示应用内提示条。",
  "Activity toast notifications": "活动提示条通知",
  "Show an OS notification when a chat or managed terminal agent finishes or needs input while the app is in the background. Desktop app notifications use your operating system notification center.":
    "当应用处于后台且对话或受管理终端智能体完成或需要输入时，显示系统通知。桌面应用通知使用操作系统通知中心。",
  Test: "测试",
  "Desktop activity notifications": "桌面活动通知",
  "Snap another app's window straight into a task with one key chord.":
    "用一个组合键直接把其他应用的窗口捕捉到任务中。",
  "Take an AppSnap to show your agent another app's window": "使用应用截图向智能体展示其他应用窗口",
  "Press both  ⌥ Option  keys at once while any app is frontmost. Moss captures that window as an image, brings itself forward, and attaches the snap to a task composer — the capture stays on this device until you send the message.":
    "任意应用位于前台时，同时按下两个 ⌥ Option 键。Moss 会将该窗口捕获为图片、切换到前台并附加到任务输入框；在你发送消息前，捕获内容始终保留在此设备上。",
  Capture: "捕捉",
  "Enable AppSnap": "启用应用截图",
  "Reset AppSnap to default": "将应用截图重置为默认值",
  "Run the capture listener in the background while Moss is open.":
    "Moss 打开时在后台运行截图监听器。",
  "Allow Input Monitoring and Screen Recording in macOS System Settings, then try again.":
    "请在 macOS 系统设置中允许输入监控和屏幕录制，然后重试。",
  Shortcut: "快捷键",
  "Press the left and right Option keys at the same time. The chord works while any app is focused, and can't be remapped yet.":
    "同时按下左、右 Option 键。任何应用获得焦点时都可触发，当前尚不能重新映射。",
  Destination: "目标位置",
  "Snaps join the task you interacted with in the last minute, and consecutive snaps stay together. Otherwise Moss opens a fresh task with the capture attached.":
    "截图会附加到你最近一分钟操作过的任务，连续截图会保持在同一任务；否则 Moss 会新建任务并附上截图。",
  Automatic: "自动",
  "Capture sound": "截图提示音",
  "Play a short shutter cue when a window is captured.": "捕捉窗口时播放短促快门提示音。",
  Preview: "预览",
  "Play a sound when an AppSnap is captured": "捕捉应用截图时播放提示音",
  "macOS permissions": "macOS 权限",
  "Input Monitoring": "输入监控",
  "Lets Moss notice the double-Option chord while another app owns the keyboard. Nothing you type is recorded.":
    "允许 Moss 在其他应用占用键盘时识别双 Option 组合键；不会记录你输入的任何内容。",
  Denied: "已拒绝",
  "Screen Recording": "屏幕录制",
  "Lets Moss capture an image of the frontmost window. Only the single window you snap is captured, only at the moment you press the chord.":
    "允许 Moss 捕捉前台窗口图片；只会在你按下组合键的瞬间捕捉该单一窗口。",
  "Permission status": "权限状态",
  "Grant both permissions to Moss under System Settings → Privacy & Security, then recheck here. macOS may require relaunching the app after a change.":
    "请在“系统设置 → 隐私与安全性”中授予 Moss 两项权限，然后在此重新检查。macOS 在修改后可能要求重新启动应用。",
  "Recheck permissions": "重新检查权限",
  "Every keyboard shortcut available in Moss, grouped by context.":
    "Moss 的全部键盘快捷键，按使用场景分组。",
  "Search shortcuts": "搜索快捷键",
  "Search shortcuts...": "搜索快捷键…",
  Command: "命令",
  Keybinding: "按键",
  "Show keyboard shortcuts": "显示键盘快捷键",
  "Open this sheet from anywhere without leaving your current context.":
    "在任何位置打开此面板，无需离开当前上下文。",
  "Toggle sidebar": "切换侧边栏",
  "Collapse or reveal the sidebar shell.": "收起或展开侧边栏。",
  "Open the folder picker to import a local project into the sidebar.":
    "打开文件夹选择器，将本地项目导入侧边栏。",
  "Search projects and threads": "搜索项目和对话",
  "Open the sidebar search palette from anywhere in the app.": "在应用任意位置打开侧边栏搜索面板。",
  "Import thread": "导入对话",
  "Bring an existing conversation into the current workspace.": "将已有对话带入当前工作区。",
  "Start a fresh thread in the current project, or the most recent one.":
    "在当前项目或最近使用的项目中新建对话。",
  "New thread in latest project": "在最近项目中新建对话",
  "Jump back into the most recently used project with a new thread.":
    "回到最近使用的项目并新建对话。",
  "New terminal thread": "新建终端对话",
  "Create a thread that opens directly into terminal mode.": "创建直接进入终端模式的对话。",
  "Split chat": "拆分对话",
  "Open the current conversation in a second pane.": "在第二个面板中打开当前对话。",
  "Model picker": "模型选择器",
  "Open the composer provider and model picker.": "打开输入框的提供商和模型选择器。",
  "Reasoning picker": "推理选择器",
  "Focus composer": "聚焦输入框",
  "Choose visible providers, review CLI installs, and update provider tools.":
    "选择可见提供商、检查 CLI 安装并更新提供商工具。",
  Updates: "更新",
  "Automatic CLI update checks": "自动检查 CLI 更新",
  "Check Codex, Claude, and other provider CLIs for newer versions in the background.":
    "在后台检查 Codex、Claude 和其他提供商 CLI 的新版本。",
  "Provider updates": "提供商更新",
  "Review installed provider tools that Moss can safely update.":
    "检查 Moss 可以安全更新的已安装提供商工具。",
  "No provider updates detected": "未检测到提供商更新",
  "Provider picker": "提供商选择器",
  "provider picker": "提供商选择器",
  "provider tools": "提供商工具",
  "custom models": "自定义模型",
  "Visible providers": "可见提供商",
  "Drag providers into your preferred picker order and hide the ones you don't use. The provider you're currently using on a thread always stays visible.":
    "拖动提供商调整选择器排序，并隐藏不用的提供商；当前对话正在使用的提供商始终保持可见。",
  "All providers visible": "所有提供商均可见",
  "Installed CLIs": "已安装的 CLI",
  "Reset provider tools to default": "将提供商工具重置为默认值",
  "Review provider versions and update tools. Open a row only when you need binary overrides.":
    "检查提供商版本并更新工具。仅在需要二进制路径覆盖时展开条目。",
  "Codex binary path": "Codex 二进制路径",
  "CODEX_HOME path": "CODEX_HOME 路径",
  "Optional custom Codex home and config directory.": "可选的自定义 Codex 主目录和配置目录。",
  "Show Codex in the provider picker": "在提供商选择器中显示 Codex",
  "Show Claude in the provider picker": "在提供商选择器中显示 Claude",
  "Show Cursor in the provider picker": "在提供商选择器中显示 Cursor",
  "Show Gemini in the provider picker": "在提供商选择器中显示 Gemini",
  "Show Grok in the provider picker": "在提供商选择器中显示 Grok",
  "Show OpenCode in the provider picker": "在提供商选择器中显示 OpenCode",
  "Show Pi in the provider picker": "在提供商选择器中显示 Pi",
  "Git writing defaults and custom model slugs.": "Git 写作默认设置与自定义模型标识。",
  "Generation defaults": "生成默认设置",
  "Git writing model": "Git 写作模型",
  "Used for generated commit messages, PR titles, and branch names.":
    "用于生成提交信息、拉取请求标题和分支名称。",
  "Saved model slugs": "已保存模型标识",
  "Reset custom models to default": "将自定义模型重置为默认值",
  "Add custom model slugs for supported providers.": "为支持的提供商添加自定义模型标识。",
  "Custom model provider": "自定义模型提供商",
  Add: "添加",
  "Remove grok-4.5": "移除 grok-4.5",
  "Streaming, diff handling, and destructive confirmations.":
    "流式输出、差异处理和破坏性操作确认。",
  "Runtime behavior": "运行时行为",
  "Show token-by-token output while a response is in progress.": "响应生成期间按 Token 显示输出。",
  "Stream assistant messages": "流式显示助手消息",
  "Diff line wrapping": "差异行换行",
  "Set the default wrap state when the diff panel opens. The in-panel wrap toggle only affects the current diff session.":
    "设置差异面板打开时的默认换行状态；面板内换行开关只影响当前差异会话。",
  "Wrap diff lines by default": "默认换行显示差异行",
  "Safety confirmations": "安全确认",
  "Ask before deleting a thread and its chat history.": "删除对话及其聊天历史前询问。",
  "Confirm thread deletion": "确认删除对话",
  "Ask before archiving a thread.": "归档对话前询问。",
  "Confirm thread archive": "确认归档对话",
  "Ask before closing a terminal tab and clearing its history.": "关闭终端标签并清除其历史前询问。",
  "Confirm terminal tab close": "确认关闭终端标签",
  "Review and clean up the worktrees created by Moss.": "查看并清理由 Moss 创建的工作树。",
  "No app-managed worktrees found yet.": "暂未发现由应用管理的工作树。",
  "View and restore archived threads.": "查看并恢复已归档对话。",
  "No archived threads": "没有已归档对话",
  "Archived threads will appear here and can be restored to the sidebar.":
    "已归档对话将显示在这里，并可恢复到侧边栏。",
  "Every skill found across providers, with toggles to control availability.":
    "显示所有提供商发现的技能，并可用开关控制其可用性。",
  "Portable skills": "可移植技能",
  "Moss skills folder": "Moss 技能文件夹",
  "Skills placed here are available on every provider. When a provider already ships its own copy of a skill, that copy is used; otherwise Moss's copy is the fallback.":
    "放在此处的技能对所有提供商可用。提供商已有同名技能时优先使用其副本；否则使用 Moss 副本作为后备。",
  "Shared skills": "共享技能",
  "Provider copies": "提供商副本",
  "Provider copy": "提供商副本",
  "From Codex": "来自 Codex",
  "From Grok": "来自 Grok",
  "From Shared (.agents)": "来自共享目录（.agents）",
  "Remaining quota and credits for each signed-in provider.": "每个已登录提供商的剩余额度与积分。",
  "Provider usage": "提供商用量",
  "Loading provider usage…": "正在加载提供商用量…",
  "Usage is read locally from each provider CLI's stored credentials and fetched directly from the provider. OAuth providers may refresh short-lived tokens through their official token endpoint; if a provider shows “Not signed in”, re-authenticate with its CLI.":
    "用量从各提供商 CLI 本地保存的凭据读取，并直接向提供商获取。OAuth 提供商可能通过官方令牌端点刷新短期令牌；若显示“未登录”，请使用其 CLI 重新认证。",
  "Keybindings, recovery, and version info.": "按键绑定、恢复与版本信息。",
  "Developer tools": "开发者工具",
  Keybindings: "按键绑定",
  "Open the persisted `keybindings.json` file to edit advanced bindings directly.":
    "打开持久化的 `keybindings.json` 文件以直接编辑高级按键绑定。",
  "Opens in your preferred editor.": "会在首选编辑器中打开。",
  "Open file": "打开文件",
  "Recovery tools": "恢复工具",
  "Rebuild local project indexes without clearing existing chats when the local state gets out of sync. Shown automatically only when recovery actions are relevant.":
    "当本地状态不同步时，重建本地项目索引但不清除已有对话；仅在恢复操作相关时自动显示。",
  "Repair state": "修复状态",
  About: "关于",
  Version: "版本",
  "Current application version.": "当前应用版本。",
  "Release history": "发布历史",
  "A running log of every update, newest first. Same notes the post-update dialog shows, kept here so you can revisit them any time.":
    "按最新优先记录每次更新；与更新后弹窗相同的说明会保留在此，随时可回看。",
  "View release history": "查看发布历史",
  "Shown automatically only when recovery actions are relevant.": "仅在恢复操作相关时自动显示。",
  Environment: "环境",
  "Panel sections": "面板分区",
  "Initialize Git": "初始化 Git",
  "Local Servers": "本地服务器",
  "Open in Ghostty": "在 Ghostty 中打开",
  "Type here": "在此输入",
  "Close Git": "关闭 Git",
  "Source control": "源代码管理",
  "Refresh changes": "刷新更改",
  "Close source control": "关闭源代码管理",
  "No changes in the working tree. Select a file to view its diff.":
    "工作树没有更改。请选择文件以查看差异。",
  "Source control is unavailable for this thread.": "此对话无法使用源代码管理。",
  "Loading changes...": "正在加载更改…",
  Staged: "已暂存",
  Changes: "更改",
  "No staged changes.": "没有已暂存的更改。",
  "No unstaged changes.": "没有未暂存的更改。",
  "Select a file to view its diff.": "选择文件以查看差异。",
  "Unstage file": "取消暂存文件",
  "Unstage all": "全部取消暂存",
  "Stage file": "暂存文件",
  "Stage all": "全部暂存",
  "Working tree": "工作树",
  Unstaged: "未暂存",
  "Commit and Push unavailable; open Git actions menu": "提交并推送不可用；打开 Git 操作菜单",
  "Commit and Push unavailable. Open for more Git actions.":
    "提交并推送不可用。打开以查看更多 Git 操作。",
  "Switch project": "切换项目",
  "Hide chat panel": "隐藏对话面板",
  "Switch to chat view": "切换到对话视图",
  "Editor activity bar": "编辑器活动栏",
  "Hide diff sidebar": "隐藏差异侧边栏",
  "Changed files": "已更改文件",
  "Diff options": "差异选项",
  "File actions": "文件操作",
  "New editor rail item": "新建编辑器栏项目",
  "Chat history": "对话历史",
  "Reference in chat": "在对话中引用",
  "Ask why this changed": "询问为何发生此更改",
  "Copy path": "复制路径",
  "Resize chat panel": "调整对话面板宽度",
  "Drag to resize chat panel": "拖动以调整对话面板宽度",
  "Continue in": "继续在此处运行",
  "Local project": "本地项目",
  "New worktree": "新建工作树",
  "Rate limits remaining": "剩余额度",
  "No local usage data was found yet.": "暂未找到本地用量数据。",
  "No workspace": "没有工作区",
  "No workspace.": "没有工作区。",
  "No workspace is attached to this chat.": "此对话未关联工作区。",
  "No files in this diff.": "此差异中没有文件。",
  "This chat environment is still being prepared. Diffs will be available once the worktree is ready.":
    "此对话环境仍在准备中；工作树就绪后即可查看差异。",
  "Open in editor": "在编辑器中打开",
  "Editor options": "编辑器选项",
  "No installed editors found": "未找到已安装的编辑器",
  "Close Diff": "关闭差异",
  "Close file view": "关闭文件视图",
  "Turn diffs are unavailable because this project is not a git repository.":
    "当前项目不是 Git 仓库，无法查看对话差异。",
  "Close Explorer": "关闭文件浏览",
  "Search files": "搜索文件",
  "Search files...": "搜索文件…",
  "Select a file from the tree to view it.": "从文件树中选择文件以查看。",
  "Close Terminal": "关闭终端",
  "New terminal tab": "新建终端标签",
  "Split right": "向右拆分",
  "Split down": "向下拆分",
  "Close active terminal tab": "关闭当前终端标签",
  "Scroll to bottom": "滚动到底部",
  "Terminal input": "终端输入",
  "Close Browser": "关闭浏览器",
  "Go back": "后退",
  "Go forward": "前进",
  Reload: "重新加载",
  "Search or enter a URL": "搜索或输入 URL",
  "Copy screenshot": "复制截图",
  "Copy link": "复制链接",
  "Browser actions": "浏览器操作",
  "New tab": "新建标签页",
  "Close tab": "关闭标签页",
  "Refresh local servers": "刷新本地服务器",
  "No local servers": "没有本地服务器",
  "Try another browser URL": "尝试其他浏览器 URL",
  "Capture screenshot": "捕捉截图",
  "Open externally": "在外部打开",
  "Close browser panel": "关闭浏览器面板",
  "Close selected Side": "关闭选中的侧边对话",
  "Reset environment panel default open to default": "将环境面板默认打开状态重置为默认值",
  "New automation": "新建自动化工作流",
  "Automation title": "工作流标题",
  "About automations": "关于自动化工作流",
  "Automations run this prompt on a schedule and open the result as a thread.":
    "自动化工作流会按计划运行此提示词，并将结果作为对话打开。",
  "Use template": "使用模板",
  "Automation prompt": "工作流提示词",
  "Add prompt e.g. look for crashes in $sentry": "添加提示词，例如：检查 $sentry 中的崩溃",
  "Auto fallback may use local checkout": "自动回退可能使用本地检出",
  "If Moss cannot create a worktree, runs may fall back to editing the active project checkout.":
    "若 Moss 无法创建工作树，运行可能回退到编辑当前项目检出。",
  "Worktree cleanup": "工作树清理",
  "Generated worktrees or branches are kept after archiving until you remove them.":
    "生成的工作树或分支会在归档后保留，直到你手动移除。",
  "Auto fallback may use local checkout If Moss cannot create a worktree, runs may fall back to editing the active project checkout.":
    "自动回退可能使用本地检出：若 Moss 无法创建工作树，运行可能回退到编辑当前项目检出。",
  "Worktree cleanup Generated worktrees or branches are kept after archiving until you remove them.":
    "工作树清理：生成的工作树或分支会在归档后保留，直到你手动移除。",
  Schedule: "计划",
  Manual: "手动",
  Once: "一次",
  Hourly: "每小时",
  Daily: "每天",
  Weekdays: "工作日",
  Weekly: "每周",
  Unlimited: "不限次数",
  "Approval required": "需要批准",
  "Daily at 9:00": "每天 9:00",
  "Run mode": "运行模式",
  Permissions: "权限",
  "Triage new crashes": "分诊新的崩溃",
  "Update dependencies": "更新依赖",
  "Daily standup summary": "每日站会摘要",
  "Schedule needs review": "计划需要确认",
  "Choose when this automation should run before creating it.":
    "请先选择此自动化工作流的运行时间，再创建它。",
  "Schedule a prompt to run on its own, or wake an existing thread on a loop.":
    "让提示词按计划独立运行，或循环唤醒已有对话。",
  "New task": "新建任务",
  "New task in Grok": "在 Grok 中新建任务",
  "New task in Chats": "在对话中新建任务",
  "2 tasks": "2 个任务",
  "Choose the project for this task": "选择此任务所属项目",
  "Draft a prompt and place it in the board's Draft column. Drag it to In Progress to send it.":
    "编写提示词并放入看板的“草稿”列；拖到“进行中”即可发送。",
  "Describe the task, @tag files/folders, paste images, or use / for skills":
    "描述任务，使用 @ 引用文件/文件夹、粘贴图片，或输入 / 使用技能",
  "Task options": "任务选项",
  "Attach images": "附加图片",
  "Send as draft": "存为草稿",
  "Create task": "创建任务",
  "Do anything in Moss": "在 Moss 里做任何事",
  "Message this subagent": "给这个子代理发消息",
  "Ask for follow-up changes": "提出后续修改",
  "Resolve this approval request to continue": "处理此批准请求后继续",
  "Type your answer to continue": "输入你的回答以继续",
  "Type your own answer, or leave this blank to use the selected option":
    "输入你自己的回答，或留空以使用所选选项",
  "Add feedback to refine the plan, or leave this blank to implement it":
    "补充反馈来完善计划，或留空以开始实现",
  Priority: "优先",
  "All activity": "全部活动",
  "No activity yet": "暂无活动",
  "No activity in Moss chats": "Moss 对话中暂无活动",
  "No activity for this project": "此项目暂无活动",
  "Group by": "分组方式",
  "Mark all as read": "全部标记为已读",
  "Clear read from Priority": "把已读移出优先",
  "Activity scope": "活动范围",
  "Loading activity...": "正在加载活动…",
  Drafts: "草稿",
  Yesterday: "昨天",
  Earlier: "更早",
  Snoozed: "已暂停",
  "Return now": "立即返回",
  Scheduled: "已定时",
  Worktree: "工作树",
  Connectors: "连接器",
  "Remote MCP servers": "远程 MCP 服务",
  "Sign in to Supabase, Linear, Notion, and other services your agents can use.":
    "登录 Supabase、Linear、Notion 和其他服务，供智能体使用。",
  "Any remote MCP server. Moss signs in with OAuth when the server asks for it.":
    "任意远程 MCP 服务。需要登录时，Moss 会用 OAuth 完成授权。",
  "You're in control": "由你掌控",
  "Connectors may introduce elevated risk": "连接器可能带来更高风险",
  Popular: "常用",
  Productivity: "效率",
  "Search connectors": "搜索连接器",
  "Add custom": "添加自定义",
  Connected: "已连接",
  Reconnect: "重新连接",
  Disconnect: "断开",
  "Could not load connectors.": "无法加载连接器。",
  "Could not disconnect": "无法断开连接",
  "Try again.": "请再试一次。",
  "New chats can use its tools.": "新对话可以使用它的工具。",
  "Use Add custom to connect any MCP server by URL.":
    "用「添加自定义」，通过 URL 连接任意 MCP 服务。",
  "Agents in new chats can use the services you connect here. Pi, Devin, and Antigravity don't support connectors yet.":
    "你在这里连接的服务，新对话里的智能体都能用。Pi、Devin 和 Antigravity 目前还不支持连接器。",
  "Add a custom connector": "添加自定义连接器",
  "MCP server URL": "MCP 服务 URL",
  "Data shared with this connector": "会分享给这个连接器的数据",
  "Learn more": "了解更多",
  "Create an app": "创建应用",
  "Redirect URL": "重定向 URL",
  "Client ID": "客户端 ID",
  "Client secret": "客户端密钥",
  "Connecting…": "正在连接…",
  "Finish signing in in your browser. This updates on its own.":
    "请在浏览器里完成登录。这里会自己更新。",
  "Agents lose its tools, and Moss deletes its sign-in from this computer.":
    "智能体将失去它的工具，Moss 也会从这台电脑上删掉登录信息。",
  ", add this redirect URL to it, then paste its client ID and secret.":
    "，把这个重定向 URL 加进去，再粘贴客户端 ID 和密钥。",
  "Enter the server URL.": "请填写服务 URL。",
  "The URL is too long.": "这个 URL 太长了。",
  "Enter a full URL, like https://mcp.example.com/mcp.":
    "请填写完整 URL，例如 https://mcp.example.com/mcp。",
  "The URL must start with https://.": "URL 必须以 https:// 开头。",
  "Remove the user name or password from the URL.": "请去掉 URL 里的用户名或密码。",
  "Use the server's public address.": "请使用这个服务的公开地址。",
  "Query Postgres, manage projects, and deploy Edge Functions.":
    "查询 Postgres、管理项目，并部署 Edge Functions。",
  "Manage projects and deployments, and read deployment logs.": "管理项目和部署，并查看部署日志。",
  "Manage users, organizations, SSO, and AuthKit in your dashboard.":
    "在控制台里管理用户、组织、SSO 和 AuthKit。",
  "Start Convex apps and get setup and scaling guidance.":
    "开始搭建 Convex 应用，并获得配置和扩展建议。",
  "Build with Workers, KV, R2, and D1 on your account.": "在你的账号里使用 Workers、KV、R2 和 D1。",
  "Search, read, and post in your workspace. Needs your own Slack app.":
    "在工作区里搜索、阅读和发消息。需要你自己的 Slack 应用。",
  "Find, create, and update issues, projects, and comments.": "查找、创建和更新议题、项目和评论。",
  "Search, read, and edit pages and databases.": "搜索、阅读和编辑页面与数据库。",
  "Investigate errors, issues, and releases.": "排查错误、议题和发布。",
  "Work with customers, payments, and Stripe docs.": "处理客户、付款，并查阅 Stripe 文档。",
  "Manage serverless Postgres projects and branches.": "管理无服务器 Postgres 项目和分支。",
  "Work with Jira issues and Confluence pages.": "处理 Jira 议题和 Confluence 页面。",
  "Find, add, and complete tasks and projects.": "查找、添加和完成任务与项目。",
  "Query product analytics, feature flags, and errors.": "查询产品分析、功能开关和错误。",
  "Create, deploy, and manage Netlify sites.": "创建、部署和管理 Netlify 站点。",
  "Deploy and manage Railway projects and services.": "部署并管理 Railway 项目和服务。",
  "Manage Prisma Postgres databases and backups.": "管理 Prisma Postgres 数据库和备份。",
  "Search models, datasets, Spaces, and papers.": "搜索模型、数据集、Spaces 和论文。",
  Dashboard: "仪表盘",
  "API review": "API 审阅",
  "Dashboard polish": "打磨仪表盘",
  "+ Add the empty state": "+ 补上空状态",
  "− Remove the placeholder": "− 去掉占位",
  "Ask an agent to review": "让智能体审阅",
  Coordinator: "协调者",
  Frontend: "前端",
  "Next chat needing attention": "下一个需要关注的对话",
  "(next turn)": "（下一轮）",
  "Ask for approval": "需要批准",
  "Approve for me": "自动批准",
  "Claude asks before editing files, running commands, or using the web":
    "Claude 在编辑文件、运行命令或使用网络前会询问",
  "Claude Code's auto mode: a classifier approves or blocks each action and asks you when unsure":
    "Claude Code 的自动模式：分类器会批准或阻止每个操作，不确定时再询问你",
  "Claude runs every action without asking, with full access to your computer":
    "Claude 不询问就执行每个操作，并完全访问你的电脑",
  "Read-only sandbox: Codex asks before editing files or running commands":
    "只读沙箱：Codex 在编辑文件或运行命令前会询问",
  "Codex edits inside the project; its reviewer decides on anything that needs more access":
    "Codex 在项目内编辑；需要更多权限的操作由审查器决定",
  "No sandbox: Codex runs everything without asking, with full access to your computer":
    "无沙箱：Codex 不询问就执行所有操作，并完全访问你的电脑",
  "Click to change permissions.": "点击更改权限。",
  "Chat background": "对话背景",
  "ASCII background": "ASCII 背景",
  "Show the animated ASCII field on empty chats. Reduced motion keeps the field still.":
    "在空白对话上显示动态 ASCII 图案。减少动态效果时图案保持静止。",
  "Are you sure you want to quit?": "确定要退出吗？",
  Quit: "退出",
  "A chat is still running": "有一个对话正在运行",
  "Chats are still running": "有多个对话正在运行",
  "Resume chat automatically": "下次启动时自动继续这个对话",
  "Resume chats automatically": "下次启动时自动继续这些对话",
  "Spaces in the rail": "侧边栏中的空间",
  "Projects in the rail": "侧边栏中的项目",
  "No projects yet": "暂无项目",
  "Customize…": "自定义…",
  "Enable providers across Moss. Disabled providers are hidden from pickers and settings; their saved configuration and existing threads are kept, and running turns continue. Enabling does not install a CLI or sign it in.":
    "在 Moss 中启用服务商。已停用的服务商不会出现在选择器和设置里，但已保存的配置和现有对话都会保留，正在运行的回合也会继续。启用不会安装 CLI，也不会自动登录。",
  "Refresh status": "刷新状态",
  "Checking setup": "正在检查设置",
  "Setup guide": "设置指南",
  "Needs sign-in": "需要登录",
  "Installed · authentication managed by OpenCode": "已安装 · 登录由 OpenCode 管理",
  "Installed · sign-in not verified": "已安装 · 登录状态未验证",
  "Search models…": "搜索模型…",
  "Search starred…": "搜索已收藏…",
  "Search models": "搜索模型",
  "Select effort": "选择思考强度",
  "Share current app": "分享当前应用",
  "Repository conventions": "仓库约定",
  "In each project, matches recent change descriptions and change request titles.":
    "在每个项目中，参照最近的变更说明和变更请求标题。",
  "Use default UI font is on; theme fonts are not applied.":
    "已开启使用默认界面字体，主题字体不会生效。",
  "Accent preview": "强调色预览",
};

const LOCALIZABLE_ATTRIBUTES = [
  "aria-label",
  "aria-valuetext",
  "title",
  "placeholder",
  "data-tooltip-content",
] as const;
const LOCALIZATION_BOUNDARY_ATTRIBUTES = [
  "contenteditable",
  "data-translation-skip",
  "data-localization-skip",
] as const;
const SKIPPED_TAGS = new Set(["CODE", "KBD", "PRE", "SAMP", "SCRIPT", "STYLE", "TEXTAREA"]);

const REALTIME_VOICE_DISPLAY_NAMES = new Set([
  "Arbor",
  "Breeze",
  "Cove",
  "Ember",
  "Juniper",
  "Maple",
  "Sol",
  "Spruce",
  "Vale",
]);
const REALTIME_VOICE_DESCRIPTIONS = new Set([
  "Easygoing and versatile",
  "Animated and earnest",
  "Composed and direct",
  "Confident and optimistic",
  "Open and upbeat",
  "Cheerful and candid",
  "Savvy and relaxed",
  "Calm and affirming",
  "Bright and inquisitive",
]);
const REALTIME_VOICE_PRIORITY_TEXT: Readonly<Record<string, string>> = {
  // These collide with broader runtime/workspace fallbacks, so the source application's more
  // specific Realtime Voice translation must win.
  "Close voice chat setup": "关闭语音聊天设置",
};

const REALTIME_VOICE_LOCALIZATION_BOUNDARY = [
  '[data-moss-realtime-voice-stage="true"]',
  '[data-moss-realtime-voice-onboarding="true"]',
  '[data-moss-realtime-voice-viewport-layer="true"]',
  '[data-moss-realtime-voice-composer-controls="true"]',
].join(",");

function isInsideRealtimeVoiceLocalizationBoundary(node: Node): boolean {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  return Boolean(element?.closest(REALTIME_VOICE_LOCALIZATION_BOUNDARY));
}

function isInsideEmptyLandingHeroHeading(node: Node): boolean {
  for (
    let candidate: Element | null =
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    candidate;
    candidate = candidate.parentElement
  ) {
    if (candidate.getAttribute("data-hero-heading") === "true") return true;
  }
  return false;
}

function translateKnownUiText(value: string): string {
  return UI_TEXT[value] ?? value;
}

/** Composer permission button titles mix a localized label with English provider copy. */
function translateZhCnRuntimeModeTitle(value: string): string | null {
  const match =
    /^(.*?): (.*?)\.( Applies next turn\. This turn still uses ([^.]+)\.)? Click to change permissions\.$/.exec(
      value,
    );
  if (!match) return null;
  const label = translateKnownUiText(match[1] ?? "");
  const description = translateKnownUiText(match[2] ?? "");
  const pendingLabel = match[4] ? translateKnownUiText(match[4]) : null;
  const pending = pendingLabel ? `下一轮生效。本轮仍使用${pendingLabel}。` : "";
  return `${label}：${description}。${pending}点击更改权限。`;
}

function translateZhCnPresentationTextForNode(value: string, node: Node): string {
  // The generic workspace status intentionally uses `思考中`; build 6119 uses
  // the more active `正在思考` only inside Realtime Voice surfaces.
  if (value === "Thinking" && isInsideRealtimeVoiceLocalizationBoundary(node)) return "正在思考";
  // The Codex-style empty-landing hero splits its question around the inline project
  // select — ["What should we build in ", <select>, "?"] — so the fragments only
  // translate inside that heading (a bare "?" elsewhere must stay untouched).
  if (isInsideEmptyLandingHeroHeading(node)) {
    if (value === "What should we build in") return "你想让我们在";
    if (value === "?") return " 中构建什么？";
  }
  return translateZhCnPresentationText(value);
}

function translateZhCnRealtimeVoiceDynamicText(value: string): string {
  const optionMatch = /^([^:]+): (.+)$/.exec(value);
  if (
    optionMatch &&
    REALTIME_VOICE_DISPLAY_NAMES.has(optionMatch[1] ?? "") &&
    REALTIME_VOICE_DESCRIPTIONS.has(optionMatch[2] ?? "")
  ) {
    const name = optionMatch[1] ?? "";
    const description = optionMatch[2] ?? "";
    return `${name}：${UI_TEXT[description] ?? description}`;
  }

  const selectedMatch = /^Selected voice: ([^.]+)\. (.+)$/.exec(value);
  if (
    selectedMatch &&
    REALTIME_VOICE_DISPLAY_NAMES.has(selectedMatch[1] ?? "") &&
    REALTIME_VOICE_DESCRIPTIONS.has(selectedMatch[2] ?? "")
  ) {
    const name = selectedMatch[1] ?? "";
    const description = selectedMatch[2] ?? "";
    return `已选择语音：${name}。${UI_TEXT[description] ?? description}`;
  }

  const previewActionMatch = /^(Replay|Retry|Play|Pause) (.+) preview$/.exec(value);
  if (previewActionMatch && REALTIME_VOICE_DISPLAY_NAMES.has(previewActionMatch[2] ?? "")) {
    const action = previewActionMatch[1];
    const name = previewActionMatch[2] ?? "";
    if (action === "Replay") return `重播 ${name} 预览`;
    if (action === "Retry") return `重试 ${name} 预览`;
    if (action === "Pause") return `暂停 ${name} 试听`;
    return `播放 ${name} 预览`;
  }

  const previewStateMatch = /^(.+) preview (loading|unavailable)$/.exec(value);
  if (previewStateMatch && REALTIME_VOICE_DISPLAY_NAMES.has(previewStateMatch[1] ?? "")) {
    const name = previewStateMatch[1] ?? "";
    return previewStateMatch[2] === "loading" ? `正在加载 ${name} 预览` : `${name} 预览不可用`;
  }

  return value;
}

export function translateZhCnPresentationText(value: string): string {
  const priorityRealtimeVoiceText = REALTIME_VOICE_PRIORITY_TEXT[value];
  if (priorityRealtimeVoiceText) return priorityRealtimeVoiceText;

  for (const translateFeatureText of [
    translateZhCnSettingsCopyText,
    translateZhCnAccountSettingsText,
    translateZhCnRuntimeUiText,
    translateZhCnWorkspaceUiText,
    translateZhCnPullRequestText,
    translateZhCnAppSnapFeedbackText,
    translateZhCnComputerControlText,
    translateZhCnWhatsNewText,
  ]) {
    const translated = translateFeatureText(value);
    if (translated !== value) return translated;
  }

  const runtimeModeTitle = translateZhCnRuntimeModeTitle(value);
  if (runtimeModeTitle) return runtimeModeTitle;

  const realtimeVoiceText = translateZhCnRealtimeVoiceDynamicText(value);
  if (realtimeVoiceText !== value) return realtimeVoiceText;

  const projectPromptMatch = /^What should we build in (.+?)\s*\?$/.exec(value);
  if (projectPromptMatch) return `你想让我们在 ${projectPromptMatch[1]} 中构建什么？`;
  const resetSettingMatch = /^Reset (.+) to default$/.exec(value);
  if (resetSettingMatch) {
    const settingLabel = resetSettingMatch[1] ?? "";
    return `将${UI_TEXT[settingLabel] ?? settingLabel}恢复为默认值`;
  }
  if (value === "Pin project") return "固定项目";
  const quitAppMatch = /^Quit (.+)\?$/.exec(value);
  if (quitAppMatch) return `退出 ${quitAppMatch[1]}？`;
  const quitStopsWorkMatch = /^Work in progress will stop when (.+) is closed\.$/.exec(value);
  if (quitStopsWorkMatch) return `关闭 ${quitStopsWorkMatch[1]} 后，进行中的工作会停止。`;
  const enabledProvidersMatch = /^(\d+) of (\d+) enabled$/.exec(value);
  if (enabledProvidersMatch)
    return `已启用 ${enabledProvidersMatch[1]} / ${enabledProvidersMatch[2]} 个`;
  const themeSlotMatch = /^System is currently using this (light|dark) slot\.$/.exec(value);
  if (themeSlotMatch)
    return `系统当前正在使用这个${themeSlotMatch[1] === "light" ? "浅色" : "深色"}主题。`;
  const themeSlotUseMatch = /^Used when your system switches to (light|dark)\.$/.exec(value);
  if (themeSlotUseMatch)
    return `系统切换到${themeSlotUseMatch[1] === "light" ? "浅色" : "深色"}时使用。`;
  const handoffFromMatch = /^Handoff from (.+)$/.exec(value);
  if (handoffFromMatch) return `来自 ${handoffFromMatch[1]} 的交接`;
  const handoffToMatch = /^Handoff to (.+)$/.exec(value);
  if (handoffToMatch) return `交接给 ${handoffToMatch[1]}`;
  const reorderProviderMatch = /^Reorder (.+)$/.exec(value);
  if (reorderProviderMatch) return `调整 ${reorderProviderMatch[1]} 的顺序`;
  const currentVersionMatch = /^Current (v.+)$/.exec(value);
  if (currentVersionMatch) return `当前版本 ${currentVersionMatch[1]}`;
  const enabledSkillsMatch = /^(\d+) of (\d+) skills enabled$/.exec(value);
  if (enabledSkillsMatch)
    return `已启用 ${enabledSkillsMatch[1]} / ${enabledSkillsMatch[2]} 个技能`;
  const providerCopiesMatch = /^Provider copies: (.+)$/.exec(value);
  if (providerCopiesMatch) return `提供商副本：${providerCopiesMatch[1]}`;
  const providerCopyMatch = /^Provider copy: (.+)$/.exec(value);
  if (providerCopyMatch) return `提供商副本：${providerCopyMatch[1]}`;
  const enableSkillMatch = /^Enable the (.+) skill$/.exec(value);
  if (enableSkillMatch) return `启用 ${enableSkillMatch[1]} 技能`;
  const unavailableMatch = /^(.+) Unavailable$/.exec(value);
  if (unavailableMatch) return `${unavailableMatch[1]} 不可用`;
  const runCountMatch = /^(\d+) runs$/.exec(value);
  if (runCountMatch) return `${runCountMatch[1]} 次运行`;
  const useColorMatch = /^Use (#[0-9a-fA-F]{6})$/.exec(value);
  if (useColorMatch) return `使用颜色 ${useColorMatch[1]}`;
  const providerBinaryPathMatch = /^(.+) binary path$/.exec(value);
  if (providerBinaryPathMatch) return `${providerBinaryPathMatch[1]} 二进制路径`;
  const serverUrlMatch = /^(.+) server URL$/.exec(value);
  if (serverUrlMatch) return `${serverUrlMatch[1]} 服务器 URL`;
  const serverPasswordMatch = /^(.+) server password$/.exec(value);
  if (serverPasswordMatch) return `${serverPasswordMatch[1]} 服务器密码`;
  const existingServerMatch =
    /^Optional existing (.+) server URL\. Leave blank to spawn a local server\.$/.exec(value);
  if (existingServerMatch)
    return `可填写现有 ${existingServerMatch[1]} 服务器 URL；留空则启动本地服务器。`;
  const externalServerPasswordMatch =
    /^Optional password for an externally managed (.+) server\.$/.exec(value);
  if (externalServerPasswordMatch)
    return `外部管理的 ${externalServerPasswordMatch[1]} 服务器可选密码。`;
  const hexValueMatch = /^(.+) hex value$/.exec(value);
  if (hexValueMatch) {
    const colorLabel = hexValueMatch[1] ?? "";
    return `${UI_TEXT[colorLabel] ?? colorLabel} 十六进制值`;
  }
  const saturationBrightnessMatch = /^Saturation (\d+%), Brightness (\d+%)$/.exec(value);
  if (saturationBrightnessMatch)
    return `饱和度 ${saturationBrightnessMatch[1]}，亮度 ${saturationBrightnessMatch[2]}`;
  const pinProjectMatch = /^Pin (.+)$/.exec(value);
  if (pinProjectMatch) return `固定 ${pinProjectMatch[1]}`;
  const terminalThreadMatch = /^Create new terminal thread in (.+)$/.exec(value);
  if (terminalThreadMatch) return `在 ${terminalThreadMatch[1]} 中新建终端对话`;
  const newThreadMatch = /^Create new thread in (.+)$/.exec(value);
  if (newThreadMatch) return `在 ${newThreadMatch[1]} 中新建对话`;
  const stagedSummaryMatch = /^Staged (.+)$/.exec(value);
  if (stagedSummaryMatch) return `已暂存 ${stagedSummaryMatch[1]}`;
  const changesSummaryMatch = /^Changes (.+)$/.exec(value);
  if (changesSummaryMatch) return `更改 ${changesSummaryMatch[1]}`;
  const localServersMatch = /^Local servers (\d+)$/.exec(value);
  if (localServersMatch) return `本地服务器 ${localServersMatch[1]}`;
  const changedFilesMatch = /^Changed files (\d+)$/.exec(value);
  if (changedFilesMatch) return `已更改文件 ${changedFilesMatch[1]}`;
  const fromBranchMatch = /^From (.+)$/.exec(value);
  if (fromBranchMatch) return `来自 ${fromBranchMatch[1]}`;
  const chatCountMatch = /^(\d+)\s+chats?$/.exec(value);
  if (chatCountMatch) return `${chatCountMatch[1]} 个对话`;
  const unmodifiedLineMatch = /^(\d+)\s+unmodified lines?$/.exec(value);
  if (unmodifiedLineMatch) return `${unmodifiedLineMatch[1]} 行未修改`;
  const closeSidechatMatch = /^Close Sidechat: (.+)$/.exec(value);
  if (closeSidechatMatch) return `关闭侧边对话：${closeSidechatMatch[1]}`;
  const sidechatMatch = /^Sidechat: (.+)$/.exec(value);
  if (sidechatMatch) return `侧边对话：${sidechatMatch[1]}`;
  const closeTerminalMatch = /^Close Terminal (\d+)$/.exec(value);
  if (closeTerminalMatch) return `关闭终端 ${closeTerminalMatch[1]}`;
  const terminalMatch = /^Terminal (\d+)$/.exec(value);
  if (terminalMatch) return `终端 ${terminalMatch[1]}`;
  const taskCountMatch = /^(\d+)\s+tasks?$/.exec(value);
  if (taskCountMatch) return `${taskCountMatch[1]} 个任务`;

  // Inbox header summary: localized date label plus a caught-up / needs-you / to-do tail.
  const caughtUpMatch = /^(.+)\. You’re all caught up\.$/.exec(value);
  if (caughtUpMatch) return `${caughtUpMatch[1]}。一切都已处理完毕。`;
  const needsYouMatch =
    /^(.+)\. (\d+) (?:thing needs|things need) you\.(?: (\d+) tasks? to do\.)?$/.exec(value);
  if (needsYouMatch) {
    const tasksToDo = needsYouMatch[3] ? `还有 ${needsYouMatch[3]} 项任务待办。` : "";
    return `${needsYouMatch[1]}。有 ${needsYouMatch[2]} 件事需要你处理。${tasksToDo}`;
  }
  const tasksToDoMatch = /^(.+)\. (\d+) tasks? to do\.$/.exec(value);
  if (tasksToDoMatch) return `${tasksToDoMatch[1]}。有 ${tasksToDoMatch[2]} 项任务待办。`;

  // Inbox recap tiles: quota lead keeps the provider name and window label verbatim.
  const quotaLeadMatch = /^Left on (.+), (.+)$/.exec(value);
  if (quotaLeadMatch) return `${quotaLeadMatch[1]}（${quotaLeadMatch[2]}）剩余`;
  const tokenShareMatch = /^(\d+)% of tokens, (\d+) turns?$/.exec(value);
  if (tokenShareMatch) return `占 tokens 的 ${tokenShareMatch[1]}%，共 ${tokenShareMatch[2]} 轮`;
  const turnsThroughMatch = /^(\d+) turns? through (.+)$/.exec(value);
  if (turnsThroughMatch) return `通过 ${turnsThroughMatch[2]} 运行 ${turnsThroughMatch[1]} 轮`;
  const promptsThenMatch = /^(\d+) prompts?, then (.+)$/.exec(value);
  if (promptsThenMatch) return `${promptsThenMatch[1]} 条提示词，其次是 ${promptsThenMatch[2]}`;
  const promptsTokensMatch = /^(\d+) prompts?, (.+ tokens)$/.exec(value);
  if (promptsTokensMatch) return `${promptsTokensMatch[1]} 条提示词，${promptsTokensMatch[2]}`;
  const promptsCountMatch = /^(\d+) prompts?$/.exec(value);
  if (promptsCountMatch) return `${promptsCountMatch[1]} 条提示词`;
  const chatsCountMatch = /^(\d+) chats?$/.exec(value);
  if (chatsCountMatch) return `${chatsCountMatch[1]} 个对话`;
  const turnsFailedMatch = /^(\d+) turns? failed$/.exec(value);
  if (turnsFailedMatch) return `${turnsFailedMatch[1]} 轮失败`;
  const turnsCountMatch = /^(\d+) turns?$/.exec(value);
  if (turnsCountMatch) return `${turnsCountMatch[1]} 轮`;
  const overdueCountMatch = /^(\d+) overdue$/.exec(value);
  if (overdueCountMatch) return `${overdueCountMatch[1]} 项已逾期`;
  const toGoCountMatch = /^(\d+) to go$/.exec(value);
  if (toGoCountMatch) return `还剩 ${toGoCountMatch[1]} 项`;
  const moreChangeMatch = /^([\d.,]+[%kKmMbB]?) more$/.exec(value);
  if (moreChangeMatch) return `${moreChangeMatch[1]} 更多`;
  const fewerChangeMatch = /^([\d.,]+[%kKmMbB]?) (?:fewer|less)$/.exec(value);
  if (fewerChangeMatch) return `${fewerChangeMatch[1]} 更少`;
  const busiestSlotMatch = /^, mostly in the (.+)$/.exec(value);
  if (busiestSlotMatch) {
    const slotKey = busiestSlotMatch[1] as "morning" | "afternoon" | "evening";
    const slot =
      ({ morning: "上午", afternoon: "下午", evening: "晚上" } as const)[slotKey] ??
      busiestSlotMatch[1];
    return `，主要集中在${slot}`;
  }

  // Moss Beta install progress and import failure rows keep versions and diagnostics verbatim.
  const betaDownloadMatch = /^Downloading Moss Beta — (\d+)%$/.exec(value);
  if (betaDownloadMatch) return `正在下载 Moss Beta——${betaDownloadMatch[1]}%`;
  const betaImportFailedMatch = /^Last import failed: (.+)$/.exec(value);
  if (betaImportFailedMatch) return `上次导入失败：${betaImportFailedMatch[1]}`;
  const betaInstallFailedMatch = /^Install failed: (.+)$/.exec(value);
  if (betaInstallFailedMatch) return `安装失败：${betaInstallFailedMatch[1]}`;

  const exact = UI_TEXT[value];
  if (exact) return exact;

  // Connector names stay as the vendor wrote them. These only match a short name,
  // so longer "Connect …" sentences already stored above are left alone.
  const connectNameMatch = /^Connect ([^.\n,]{1,40})$/.exec(value);
  if (connectNameMatch) return `连接 ${connectNameMatch[1]}`;
  const continueToMatch = /^Continue to ([^.\n,]{1,40})$/.exec(value);
  if (continueToMatch) return `继续前往 ${continueToMatch[1]}`;
  const waitingForMatch = /^Waiting for ([^.\n,]{1,40})…$/.exec(value);
  if (waitingForMatch) return `正在等待 ${waitingForMatch[1]}…`;
  const signInTimeoutMatch = /^The sign-in to ([^.\n,]{1,40}) timed out\. Try again\.$/.exec(value);
  if (signInTimeoutMatch) return `登录 ${signInTimeoutMatch[1]} 超时了。请再试一次。`;
  const couldNotConnectMatch = /^Moss could not connect ([^.\n,]{1,40})\.$/.exec(value);
  if (couldNotConnectMatch) return `Moss 无法连接 ${couldNotConnectMatch[1]}。`;
  const connectedMatch = /^([^.\n,]{1,40}) connected$/.exec(value);
  if (connectedMatch) return `已连接 ${connectedMatch[1]}`;
  const disconnectMatch = /^Disconnect ([^.\n,]{1,40})\?$/.exec(value);
  if (disconnectMatch) return `断开 ${disconnectMatch[1]}？`;
  const noConnectorMatch = /^No connectors match “([^”]+)”\.$/.exec(value);
  if (noConnectorMatch) return `没有匹配「${noConnectorMatch[1]}」的连接器。`;
  const ownAppMatch = /^Use your own ([^.\n,]{1,40}) app$/.exec(value);
  if (ownAppMatch) return `使用你自己的 ${ownAppMatch[1]} 应用`;
  const registeredAppMatch = /^([^.\n,]{1,40}) only signs in apps registered with it\.$/.exec(
    value,
  );
  if (registeredAppMatch) return `${registeredAppMatch[1]} 只接受已在它那里注册的应用。`;
  const accessMatch =
    /^Agents get only the access ([^.\n,]{1,40}) grants Moss, and you can disconnect it anytime in Settings\.$/.exec(
      value,
    );
  if (accessMatch)
    return `智能体只能拿到 ${accessMatch[1]} 授权给 Moss 的权限，你也可以随时在设置里断开。`;
  const riskMatch =
    /^([^.\n,]{1,40}) is run by its own provider, not Moss\. Its tools can read and change data in your account, and content it returns could try to steer your agent\. Review tool calls before you approve them\.$/.exec(
      value,
    );
  if (riskMatch)
    return `${riskMatch[1]} 由它自己的服务商运营，不是 Moss。它的工具可以读取和修改你账号里的数据，返回的内容也可能试图引导智能体。批准工具调用前请先看一眼。`;
  const sharedMatch =
    /^When an agent uses ([^.\n,]{1,40}), its request and the context it needs are sent to \1, and the answers go to the AI provider running the chat\. \1's terms and privacy policy apply\. Your sign-in stays on this computer and is never shared with AI providers\.$/.exec(
      value,
    );
  if (sharedMatch)
    return `智能体使用 ${sharedMatch[1]} 时，请求和所需上下文会发给 ${sharedMatch[1]}，回答则回到正在跑这个对话的 AI 服务商。适用 ${sharedMatch[1]} 自己的条款和隐私政策。登录信息留在这台电脑上，不会分享给 AI 服务商。`;
  const showSlideMatch = /^Show (.+)$/.exec(value);
  const slideName = showSlideMatch?.[1];
  if (slideName) return `显示${UI_TEXT[slideName] ?? slideName}`;

  return value;
}

type TranslationRecord = Readonly<{ source: string; translated: string }>;

const translatedTextNodes = new Map<Text, TranslationRecord>();
const translatedAttributes = new Map<Element, Map<string, TranslationRecord>>();
let localizationInstalled = false;
let localizationObserver: MutationObserver | null = null;

function isZhCnActive(): boolean {
  const declaredLocale = document.documentElement.dataset.mossLocale;
  if (declaredLocale) return declaredLocale === "zh-CN";
  return document.documentElement.lang.toLowerCase().startsWith("zh");
}

function hasTranslationSkipAncestor(element: Element): boolean {
  for (let candidate: Element | null = element; candidate; candidate = candidate.parentElement) {
    if (
      candidate.getAttribute("data-translation-skip")?.toLowerCase() === "true" ||
      candidate.getAttribute("data-localization-skip")?.toLowerCase() === "true"
    ) {
      return true;
    }
  }
  return false;
}

function isInsideEditableRegion(element: Element): boolean {
  for (let candidate: Element | null = element; candidate; candidate = candidate.parentElement) {
    const value = candidate.getAttribute("contenteditable");
    if (value === null) continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === "false") return false;
    if (normalized === "" || normalized === "true" || normalized === "plaintext-only") {
      return true;
    }
  }
  return false;
}

function isInsideSkippedTag(element: Element): boolean {
  for (let candidate: Element | null = element; candidate; candidate = candidate.parentElement) {
    if (SKIPPED_TAGS.has(candidate.tagName)) return true;
  }
  return false;
}

function isInsideLocalizationBoundary(element: Element): boolean {
  return (
    hasTranslationSkipAncestor(element) ||
    isInsideEditableRegion(element) ||
    isInsideSkippedTag(element)
  );
}

function isUiNode(node: Node): boolean {
  const parent = node.parentElement;
  return Boolean(parent && !isInsideLocalizationBoundary(parent));
}

function forgetExternallyReusedTranslation(record: MutationRecord): void {
  if (record.type === "characterData") {
    const node = record.target as Text;
    const existing = translatedTextNodes.get(node);
    if (existing && node.nodeValue === existing.translated && record.oldValue !== existing.source) {
      translatedTextNodes.delete(node);
    }
    return;
  }

  if (
    record.type !== "attributes" ||
    !(record.target instanceof Element) ||
    !record.attributeName
  ) {
    return;
  }
  const records = translatedAttributes.get(record.target);
  const existing = records?.get(record.attributeName);
  if (
    existing &&
    record.target.getAttribute(record.attributeName) === existing.translated &&
    record.oldValue !== existing.source
  ) {
    records?.delete(record.attributeName);
    if (records?.size === 0) translatedAttributes.delete(record.target);
  }
}

function replaceTextNode(node: Text): void {
  const current = node.nodeValue;
  if (!current) return;
  const existing = translatedTextNodes.get(node);

  if (!isZhCnActive()) {
    if (existing && current === existing.translated) node.nodeValue = existing.source;
    translatedTextNodes.delete(node);
    return;
  }

  if (existing && current === existing.translated) return;
  const allowDiffSeparator = /^\s*\d+\s+unmodified lines?\s*$/.test(current);
  if (!isUiNode(node) && !allowDiffSeparator) {
    translatedTextNodes.delete(node);
    return;
  }
  const leading = current.match(/^\s*/)?.[0] ?? "";
  const trailing = current.match(/\s*$/)?.[0] ?? "";
  const translated = translateZhCnPresentationTextForNode(current.trim(), node);
  if (translated === current.trim()) {
    translatedTextNodes.delete(node);
    return;
  }
  const next = `${leading}${translated}${trailing}`;
  translatedTextNodes.set(node, { source: current, translated: next });
  node.nodeValue = next;
}

function replaceElementAttributes(element: Element): void {
  const skipped = isInsideLocalizationBoundary(element);
  for (const attribute of LOCALIZABLE_ATTRIBUTES) {
    const current = element.getAttribute(attribute);
    const records = translatedAttributes.get(element);
    const existing = records?.get(attribute);

    if (!isZhCnActive() || skipped) {
      if (existing && current === existing.translated) {
        element.setAttribute(attribute, existing.source);
      }
      records?.delete(attribute);
      continue;
    }

    if (!current || (existing && current === existing.translated)) continue;
    const translated = translateZhCnPresentationTextForNode(current, element);
    if (translated === current) {
      records?.delete(attribute);
      continue;
    }
    const nextRecords = records ?? new Map<string, TranslationRecord>();
    nextRecords.set(attribute, { source: current, translated });
    translatedAttributes.set(element, nextRecords);
    element.setAttribute(attribute, translated);
  }
  if (translatedAttributes.get(element)?.size === 0) translatedAttributes.delete(element);
}

function localizeSubtree(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) return replaceTextNode(node as Text);
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const element = node as Element;
  replaceElementAttributes(element);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode())
    replaceTextNode(textNode as Text);
  for (const descendant of element.querySelectorAll(
    "[aria-label], [aria-valuetext], [title], [placeholder], [data-tooltip-content]",
  ))
    replaceElementAttributes(descendant);
}

function forgetTranslatedSubtree(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const textNode = node as Text;
    const record = translatedTextNodes.get(textNode);
    if (record && textNode.nodeValue === record.translated) textNode.nodeValue = record.source;
    translatedTextNodes.delete(textNode);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const element = node as Element;
  const restoreAttributes = (candidate: Element) => {
    const records = translatedAttributes.get(candidate);
    if (!records) return;
    for (const [attribute, record] of records) {
      if (candidate.getAttribute(attribute) === record.translated) {
        candidate.setAttribute(attribute, record.source);
      }
    }
    translatedAttributes.delete(candidate);
  };

  restoreAttributes(element);
  for (const descendant of element.querySelectorAll("*")) restoreAttributes(descendant);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
    const record = translatedTextNodes.get(textNode as Text);
    if (record && textNode.nodeValue === record.translated) textNode.nodeValue = record.source;
    translatedTextNodes.delete(textNode as Text);
  }
}

function restoreEnglishPresentation(): void {
  for (const [node, record] of translatedTextNodes) {
    if (node.nodeValue === record.translated) node.nodeValue = record.source;
  }
  translatedTextNodes.clear();
  for (const [element, records] of translatedAttributes) {
    for (const [attribute, record] of records) {
      if (element.getAttribute(attribute) === record.translated) {
        element.setAttribute(attribute, record.source);
      }
    }
  }
  translatedAttributes.clear();
}

function synchronizePresentationLocale(): void {
  if (isZhCnActive()) localizeSubtree(document.documentElement);
  else restoreEnglishPresentation();
}

/** Covers normal DOM plus portalled menus, dialogs, and toasts without touching runtime content. */
export function installZhCnUiLocalization(): () => void {
  if (localizationInstalled) return uninstallZhCnUiLocalization;
  localizationInstalled = true;
  synchronizePresentationLocale();
  localizationObserver = new MutationObserver((records) => {
    // A framework can reuse the same Text/Element and assign a legitimate source value that is
    // byte-for-byte equal to our previous translation. Mutation oldValue distinguishes that write
    // from the localization write itself, so a later English switch cannot restore stale source.
    for (const record of records) forgetExternallyReusedTranslation(record);

    for (const record of records) {
      if (
        record.type === "attributes" &&
        record.target === document.documentElement &&
        (record.attributeName === "lang" || record.attributeName === "data-moss-locale")
      ) {
        synchronizePresentationLocale();
        continue;
      }
      if (
        record.type === "attributes" &&
        record.target instanceof Element &&
        LOCALIZATION_BOUNDARY_ATTRIBUTES.includes(
          record.attributeName as (typeof LOCALIZATION_BOUNDARY_ATTRIBUTES)[number],
        )
      ) {
        if (isInsideLocalizationBoundary(record.target)) forgetTranslatedSubtree(record.target);
        else localizeSubtree(record.target);
        continue;
      }
      if (record.type === "characterData") replaceTextNode(record.target as Text);
      else if (record.type === "attributes" && record.target instanceof Element)
        replaceElementAttributes(record.target);
      else {
        for (const node of record.removedNodes) forgetTranslatedSubtree(node);
        for (const node of record.addedNodes) localizeSubtree(node);
      }
    }
  });
  localizationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      ...LOCALIZABLE_ATTRIBUTES,
      ...LOCALIZATION_BOUNDARY_ATTRIBUTES,
      "lang",
      "data-moss-locale",
    ],
  });
  return uninstallZhCnUiLocalization;
}

/** Primarily used by browser tests and HMR so observers never leak across renderer lifecycles. */
export function uninstallZhCnUiLocalization(): void {
  localizationObserver?.disconnect();
  localizationObserver = null;
  restoreEnglishPresentation();
  localizationInstalled = false;
}
