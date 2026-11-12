// FILE: zhCNChatSurfaces.ts
// Purpose: Simplified Chinese for the chat view and the surfaces it opens: side chats, hubs, the
//          library, the computer preview, the diff editor, and the toasts they raise.
// Layer: Pure localization data
// Exact phrases only. Names such as Hub, MCP and GitHub stay as they are.

import { lookupPhrase } from "./zhCNPhraseTable";

const CHAT_SURFACE_COPY: Readonly<Record<string, string>> = {
  // Questions and approvals
  "Questions from Codex": "来自 Codex 的问题",
  "Or type your own answer…": "或者输入你自己的回答…",
  "Type your answer…": "输入你的回答…",
  "Codex can keep working": "Codex 可以继续工作",
  "Send answer": "发送回答",
  "Suggested ·": "建议 ·",
  "Couldn't send your answer": "无法发送你的回答",
  "Try again from the thread.": "请在对话中重试。",
  "Loading approval…": "正在加载审批…",
  "No answer": "没有回答",
  "Sent by agent": "由智能体发送",

  // Composer status and context
  "Native API is unavailable.": "原生 API 不可用。",
  "Background task": "后台任务",
  "Continue in this thread": "在这个对话中继续",
  "Continue in a new thread": "在新对话中继续",
  "Toggle hub panel": "切换 Hub 面板",
  "Toggle library panel": "切换资料库面板",
  "Go to first message": "跳到第一条消息",
  "Claude prompt cache:": "Claude 提示词缓存：",
  "Cache lifetime is unavailable.": "无法获取缓存有效期。",
  "The next request may reprocess about": "下一次请求可能会重新处理约",
  "Last request · cache read": "上次请求 · 读取缓存",
  "Cache written": "已写入缓存",
  "Input outside cache": "缓存外的输入",
  "Cache state is estimated. It does not measure your plan's remaining usage.":
    "缓存状态是估算值，不代表你的方案剩余用量。",
  "Auto-compact target:": "自动压缩目标：",
  // Claude's window picker in the composer model menu.
  "Auto-compact": "自动压缩",
  "Auto (Moss decides)": "自动（由 Moss 决定）",
  "The session's auto-compact target can be lower than the model's supported window.":
    "会话的自动压缩目标可能低于模型支持的上下文窗口。",
  "Starting compaction...": "正在开始压缩…",
  "Checking Claude's available commands...": "正在检查 Claude 可用的命令…",
  "Compaction is unavailable for this Claude session.": "这个 Claude 会话无法压缩。",
  "Wait for Claude and its background tasks to finish.": "请等 Claude 和它的后台任务完成。",
  "Resolve the pending request before compacting.": "请先处理待处理的请求，再压缩。",
  "Choose how to resume the held message above.": "请先选择如何继续上方被暂存的消息。",
  "Wait for Claude to finish before compacting.": "请等 Claude 完成后再压缩。",
  "Compact now": "立即压缩",
  "Compaction processes this conversation and consumes usage. Later turns use its summary.":
    "压缩会处理这个对话并消耗用量。之后的回合会使用它的摘要。",
  "Open coordinator": "打开协调者",
  "Open source thread": "打开来源对话",
  "Next reply may use more Claude allowance.": "下一次回复可能消耗更多 Claude 额度。",
  "Chat context uses the new provider’s allowance.": "对话上下文会使用新服务商的额度。",
  "Still sending your last message": "仍在发送你的上一条消息",
  "Wait for it to show in the chat before sending again.": "请等它显示在对话中后再发送。",
  "The session is still starting": "会话仍在启动",
  "Send again once it is ready. Your message stays in the composer.":
    "就绪后请再次发送。你的消息会保留在输入框中。",
  "This chat has no project": "这个对话没有项目",
  "Choose a project for this chat, then send again.": "请为这个对话选择项目，然后再次发送。",
  "Continue in this local worktree": "在这个本地工作树中继续",
  "Continue in the current local thread": "在当前本地对话中继续",
  "Could not stop the current response": "无法停止当前回复",
  "The interrupt request failed. Try again in a moment.": "中断请求失败。请稍后重试。",
  "Could not stop the background task": "无法停止后台任务",
  "Try again in a moment.": "请稍后重试。",
  "Could not reference this chat": "无法引用这个对话",
  "This chat is unavailable or cannot be mentioned here.": "这个对话不可用，或不能在这里提及。",
  "Wait for the current turn to finish and answer any pending request, then send again.":
    "请等当前回合结束并回答待处理的请求，然后再次发送。",
  "Search models or providers": "搜索模型或服务商",
  "Edit queued follow-up": "编辑排队的后续消息",
  "Queued work": "排队的工作",
  "Queued work (": "排队的工作（",
  "Goal achieved": "目标已达成",
  "Switching to local...": "正在切换到本地…",
  "Work locally": "在本地工作",
  "Checking for models…": "正在检查模型…",
  "Couldn’t update models.": "无法更新模型。",
  "Couldn’t load OMP models. Check that omp is installed and authenticated.":
    "无法加载 OMP 模型。请确认 omp 已安装并已认证。",
  "Couldn’t load OMP models — check that omp is installed and authenticated":
    "无法加载 OMP 模型，请确认 omp 已安装并已认证",
  "Handoff failed": "移交失败",
  "Context handoff": "上下文移交",
  "Copy as markdown": "复制为 Markdown",

  // Computer preview
  "Computer control is on for this chat": "这个对话已开启电脑控制",
  "Computer control is off": "电脑控制已关闭",
  "Queued desktop turns stay cancelled — send a fresh message to continue.":
    "排队的桌面回合会保持取消状态。请发送新消息继续。",
  "Turn it on in Settings to let the agent use the desktop.":
    "请在设置中开启，让智能体可以使用桌面。",
  "Computer preview": "电脑预览",
  "Dock the preview back into the chat rail": "把预览停靠回对话侧栏",
  "Dock the computer preview back into the chat rail": "把电脑预览停靠回对话侧栏",
  "Float the preview as a draggable window": "把预览变成可拖动的浮动窗口",
  "Float the computer preview as a draggable window": "把电脑预览变成可拖动的浮动窗口",
  "Connecting to the desktop…": "正在连接桌面…",
  "This browser cannot decode desktop frames.": "这个浏览器无法解码桌面画面。",
  "Could not capture the window.": "无法截取窗口。",
  "Computer permission setup could not start": "无法开始设置电脑权限",

  // Side chats
  "Side chat is unavailable": "侧边对话不可用",
  "Open a server-backed main thread before starting a side chat.":
    "请先打开由服务器支持的主对话，再开始侧边对话。",
  "Open a server-backed main thread before starting a Side chat.":
    "请先打开由服务器支持的主对话，再开始侧边对话。",
  "Could not start side chat": "无法开始侧边对话",
  "Could not start Side chat": "无法开始侧边对话",
  "An error occurred while creating the side chat.": "创建侧边对话时出错。",
  "An error occurred while creating Side chat.": "创建侧边对话时出错。",
  "Could not delete side chat": "无法删除侧边对话",
  "An error occurred while deleting the side chat.": "删除侧边对话时出错。",
  "Side chats": "侧边对话",
  "Start side chat": "开始侧边对话",
  "Delete side chat": "删除侧边对话",
  "This side chat expired after a period of inactivity. Start a new side chat.":
    "这个侧边对话因长时间不活动已过期。请开始新的侧边对话。",
  "Start new": "新开始",
  "Continued from chat": "从对话继续",
  "Loading side chat...": "正在加载侧边对话…",
  "Open the item in Code review before starting a new side chat.":
    "请先在代码审查中打开这一项，再开始新的侧边对话。",
  "Open the parent chat before starting a replacement side chat.":
    "请先打开上级对话，再开始替代的侧边对话。",
  "Add to Chat": "添加到对话",
  "Add to Side": "添加到侧边对话",
  "Add to new Chat": "添加到新对话",
  "Could not add selection to Side": "无法把所选内容添加到侧边对话",
  "New chat from selection": "用所选内容新建对话",
  "Open in chat": "在对话中打开",
  "Message for new chat": "新对话的消息",
  "Ask about this selection…": "询问所选内容…",
  "Send to new chat": "发送到新对话",

  // Pull requests and CI
  "Start a fix turn in this chat when CI fails on this pull request":
    "这个拉取请求的 CI 失败时，在这个对话中开始修复回合",
  "Watching CI on this pull request": "正在关注这个拉取请求的 CI",
  "A fix turn is running for the failing checks": "正在运行修复回合，处理失败的检查",
  "The fix request was interrupted. Turn Auto-fix CI on again to resume.":
    "修复请求被中断。请重新开启 CI 自动修复以继续。",
  "Paused: the last fix turn did not push a commit. Turn it on again to retry.":
    "已暂停：上一个修复回合没有推送提交。请重新开启以重试。",
  "Merge conflicts": "合并冲突",
  "Couldn't update Auto-fix CI": "无法更新 CI 自动修复",
  "Could not open GitHub": "无法打开 GitHub",
  "The link could not be opened.": "无法打开这个链接。",
  "The in-app browser could not open GitHub.": "应用内浏览器无法打开 GitHub。",
  "Pull request added to merge queue": "拉取请求已加入合并队列",
  "Open in GitHub": "在 GitHub 中打开",
  "Open on GitHub": "在 GitHub 上打开",
  "Code changes": "代码更改",
  "Retry loading checks": "重试加载检查",
  "Retry loading comments": "重试加载评论",
  "Failing checks": "失败的检查",
  "No pull requests yet. PRs opened by hub threads land here.":
    "还没有拉取请求。Hub 对话打开的 PR 会显示在这里。",

  // Floating browser and generated files
  "Floating browser": "浮动浏览器",
  "Expand browser": "展开浏览器",
  "Drag to move, click for actions": "拖动可移动，点击查看操作",
  "Open browser in sidebar": "在侧边栏打开浏览器",
  "Could not open generated image": "无法打开生成的图片",
  "The file may be unavailable.": "这个文件可能不可用。",
  "This project is no longer available.": "这个项目已不可用。",
  "The project could not be opened.": "无法打开这个项目。",

  // Hub settings
  "Linking and unlinking apply immediately.": "关联和取消关联会立即生效。",
  "Hub folder": "Hub 文件夹",
  "No folder assigned": "未指定文件夹",
  "Worker environment": "工作环境",
  "Where worker threads run their tasks.": "工作对话运行任务的位置。",
  "Library hosting": "资料库托管",
  "Not set": "未设置",
  "Absolute path to the library folder.": "资料库文件夹的绝对路径。",
  "Library location": "资料库位置",
  "Git remote": "Git 远程仓库",
  "Remote the library pushes to.": "资料库推送到的远程仓库。",
  "Library git remote": "资料库 Git 远程仓库",
  "Push on change": "更改时推送",
  "Push library commits to the remote automatically.": "自动把资料库提交推送到远程仓库。",
  "The library is a git repository; every change is committed.":
    "资料库是一个 Git 仓库，每次更改都会提交。",
  "Unable to link repository": "无法关联仓库",
  "Unable to unlink repository": "无法取消关联仓库",
  "An unknown error occurred.": "发生未知错误。",
  "Linked repositories": "已关联的仓库",
  "Add repository": "添加仓库",
  "No linked repositories.": "没有已关联的仓库。",
  "What should this hub accomplish?": "这个 Hub 要完成什么？",
  "Hub goal": "Hub 目标",
  "Parallel threads": "并行对话",
  "Additional work waits in the queue until a slot is available.":
    "其余工作会在队列中等待，直到有空位。",
  "Coordinator model": "协调者模型",
  "Model for managing and creating threads.": "用于管理和创建对话的模型。",
  "Coordinator effort": "协调者思考强度",
  "Effort for managing and creating threads.": "管理和创建对话时使用的思考强度。",
  "Default model for new threads.": "新对话的默认模型。",
  "Default effort for new threads.": "新对话的默认思考强度。",
  "Use the default hub icon": "使用默认 Hub 图标",
  "Use default": "使用默认值",
  "Hub icon": "Hub 图标",
  "Hub icon color": "Hub 图标颜色",
  "Stops and restarts the coordinator's session. Transcript is kept.":
    "停止并重启协调者的会话。对话记录会保留。",
  "Archive hub": "归档 Hub",
  "Archives every thread and hides the hub in the sidebar until unarchived.":
    "归档所有对话，并在取消归档前从侧边栏隐藏这个 Hub。",
  "Danger zone": "危险操作",
  "Delete hub": "删除 Hub",
  "Type the hub name to confirm deletion": "输入 Hub 名称以确认删除",
  "Delete hub…": "删除 Hub…",
  "Unable to delete hub": "无法删除 Hub",
  "Hub deleted": "Hub 已删除",
  "Resume hub": "恢复 Hub",
  "Pause hub": "暂停 Hub",
  "Threads and automations are stopped until you resume.": "恢复之前，对话和自动化都会停止。",
  "Interrupts running threads and stops new coordinator wakes.":
    "中断正在运行的对话，并停止新的协调者唤醒。",
  "Link an existing project so the hub can work in its folder.":
    "关联现有项目，让 Hub 可以在它的文件夹中工作。",
  "Search projects to link": "搜索要关联的项目",
  "No matching projects.": "没有匹配的项目。",
  "No projects available to link.": "没有可关联的项目。",
  "Hub instructions": "Hub 说明",
  "Instructions every thread in this hub follows.": "这个 Hub 中每个对话都要遵循的说明。",
  "Applies immediately.": "立即生效。",
  "Auto memory": "自动记忆",
  "Write memory notes": "写入记忆笔记",
  "Notes the coordinator writes itself as it works in this hub.":
    "协调者在这个 Hub 中工作时自己写下的笔记。",
  "The coordinator's running memory for this hub.": "协调者在这个 Hub 中持续更新的记忆。",
  "Memory files": "记忆文件",
  "No memory files yet.": "还没有记忆文件。",
  "Note that releases go out on Tuesdays": "记住发布都在周二进行",
  "Add a memory note": "添加记忆笔记",
  "Save memory note": "保存记忆笔记",
  "Save note": "保存笔记",
  "Notes apply immediately.": "笔记会立即生效。",
  "This file is empty.": "这个文件是空的。",
  "Checking effort support…": "正在检查思考强度支持情况…",
  "This hub is paused.": "这个 Hub 已暂停。",
  "Plugins are discovered from this hub's folder.": "插件从这个 Hub 的文件夹中发现。",
  "Give the hub a name.": "请给 Hub 起个名字。",
  "Could not save the hub settings.": "无法保存 Hub 设置。",
  "Choose how the coordinator works with this hub.": "选择协调者如何与这个 Hub 协作。",
  "Coordinator settings for this hub.": "这个 Hub 的协调者设置。",
  "Hub settings sections": "Hub 设置分区",
  "Unsaved changes": "未保存的更改",
  "Loading hub settings": "正在加载 Hub 设置",
  "Create hub": "创建 Hub",
  "Discard this hub?": "放弃这个 Hub？",
  "Keep hub": "保留 Hub",
  "Discard hub": "放弃 Hub",
  "Hub settings": "Hub 设置",
  "Set up coordinator": "设置协调者",
  "New thread in this workspace": "在这个工作区新建对话",
  "Open in New Tab": "在新标签页打开",
  "Close Tabs to the Left": "关闭左侧标签页",
  "Close Tabs to the Right": "关闭右侧标签页",
  "Close Other Tabs": "关闭其他标签页",
  "Waiting on you": "等你处理",
  "Could not mark the task resolved.": "无法把任务标为已解决。",
  "Could not archive the thread.": "无法归档这个对话。",
  "Could not reopen the task.": "无法重新打开这个任务。",
  "Could not reopen the thread.": "无法重新打开这个对话。",
  "Mark resolved": "标为已解决",
  "Open in split view": "在分屏视图中打开",
  "Loading automations…": "正在加载自动化…",
  "No automations yet. Ask the coordinator to check something on a schedule.":
    "还没有自动化。可以让协调者按计划检查某些内容。",
  "Never run": "从未运行",
  "No threads yet. Ask the coordinator for work and it will start threads here.":
    "还没有对话。把工作交给协调者，它会在这里开始对话。",
  "Nothing here yet.": "这里还没有内容。",

  // Library
  "Upload here": "上传到这里",
  "Add files": "添加文件",
  "Library history": "资料库历史",
  "Collapse library": "收起资料库",
  "Expand library": "展开资料库",
  "Search library...": "搜索资料库…",
  "Search library": "搜索资料库",
  "View mode": "视图模式",
  "Upload files to the library": "把文件上传到资料库",
  "Not pushed yet": "尚未推送",
  "Push failed": "推送失败",
  "Back to library": "返回资料库",
  "Back to library from history": "从历史返回资料库",
  "Loading history…": "正在加载历史…",
  "No versions yet.": "还没有版本。",
  "No files match.": "没有匹配的文件。",
  "No files yet. Add documents or artifacts for this hub.":
    "还没有文件。请为这个 Hub 添加文档或产物。",
  "This removes it from the library. It can be restored from History.":
    "这会把它从资料库中移除。之后可以从历史中恢复。",

  // Automations, visuals and MCP apps
  'Add what it should do and how often, e.g. "every weekday at 9am, summarize my PRs".':
    "填写要做什么、多久做一次，例如“每个工作日上午 9 点总结我的 PR”。",
  "Visual unavailable.": "可视化内容不可用。",
  "This visual needs a newer Moss.": "这个可视化内容需要更新版本的 Moss。",
  "This visual stopped because it could not stay isolated.":
    "这个可视化内容无法保持隔离，已停止运行。",
  "Loading visual…": "正在加载可视化内容…",
  "HTML visuals are available in Moss desktop. Use native components in the browser.":
    "HTML 可视化内容只能在 Moss 桌面版中使用。在浏览器中请使用原生组件。",
  "Reload visual": "重新加载可视化内容",
  "Collapse changed files list": "收起已更改文件列表",
  "Expand changed files list": "展开已更改文件列表",

  // Realtime voice and appshots
  "Send a message during voice chat": "在语音对话中发送消息",
  "Type anything": "输入任意内容",
  "Press Enter to send. Press Shift and Enter for a new line.":
    "按 Enter 发送。按 Shift + Enter 换行。",
  "Realtime Voice session": "实时语音会话",
  "Moss will finish the current response before ending this voice chat.":
    "Moss 会先完成当前回复，再结束这次语音对话。",

  // Simulator and terminal
  "The simulator screenshot was skipped because this message is already at the attachment limit.":
    "这条消息已达到附件上限，已跳过模拟器截图。",
  "Couldn’t attach the simulator screen": "无法附加模拟器画面",
  "Loading simulator...": "正在加载模拟器…",
  "Unable to close terminal": "无法关闭终端",
  "Unable to close the tab": "无法关闭这个标签",
  "Please try again.": "请重试。",
  "Run in background (ctrl+b)": "在后台运行（ctrl+b）",
  "Stop all": "全部停止",

  // Subagents and workflows
  "Brief from": "任务说明来自",
  "Delivered to": "已交付给",
  "Subagent of": "上级智能体",
  "The subagent request failed. Try again.": "子智能体请求失败。请重试。",
  "Resume workflow": "恢复工作流",
  "Dismiss workflow panel": "关闭工作流面板",
  "Pause workflow": "暂停工作流",
  "Pause workflow (resume replays completed agents from cache)":
    "暂停工作流（恢复时会从缓存重放已完成的智能体）",
  "No agents yet": "还没有智能体",

  // Transcript
  "Loading conversation": "正在加载对话",
  "This conversation didn't load.": "这个对话没有加载出来。",
  "Earlier messages unavailable": "更早的消息不可用",
  "Searching earlier messages…": "正在搜索更早的消息…",
  "Task list": "任务列表",
  "Previous history": "之前的历史",
  "Session restarted": "会话已重启",
  "Summary included": "已包含摘要",
  "Summary preview": "摘要预览",
  "Showing a short preview of the summary sent with your message.":
    "这里显示随消息发送的摘要的简短预览。",
  "The session did not start.": "会话没有启动。",
  "Transferred context": "已转移的上下文",
  "Sent ahead of your next message so the new model can continue this thread.":
    "会在你的下一条消息之前发送，让新模型可以继续这个对话。",
  "Last activity": "最近活动",
  "Fast mode on": "快速模式已开启",
  "Fast mode off": "快速模式已关闭",
  "Nothing to commit or push.": "没有可提交或推送的内容。",
  "Moss is not connected to the server.": "Moss 没有连接到服务器。",
  "An error occurred while creating the new thread.": "创建新对话时出错。",

  // Diff and file editor
  "The base revision of this file is too large to load in full, so this diff is read-only.":
    "这个文件的基础版本太大，无法完整加载，所以这份差异是只读的。",
  "Loading diff...": "正在加载差异…",
  "Discard unsaved changes?": "放弃未保存的更改？",
  "Reloading replaces the editor contents with what is currently on disk.":
    "重新加载会用磁盘上的当前内容替换编辑器内容。",
  "Closing the diff editor drops the changes you have not saved yet.":
    "关闭差异编辑器会丢弃尚未保存的更改。",
  "Closing the editor drops the changes you have not saved yet.":
    "关闭编辑器会丢弃尚未保存的更改。",
  "Reload and discard": "重新加载并放弃",
  "Discard changes": "放弃更改",
  "Switch to inline diff": "切换到行内差异",
  "Switch to side-by-side diff": "切换到并排差异",
  "Reload from disk": "从磁盘重新加载",
  "Revert all changes": "撤销所有更改",
  "Edit file": "编辑文件",
  "Reload file from disk": "从磁盘重新加载文件",
  "Change markers": "更改标记",
  "Branch, tag, or commit": "分支、标签或提交",
  "Compare with": "比较对象",
  "Diff tools": "差异工具",
  "Reload diff": "重新加载差异",
  "Branch is behind upstream. Pull before creating a PR.": "分支落后于上游。请先拉取，再创建 PR。",
  "Git action failed": "Git 操作失败",
  "Git status refresh delayed.": "Git 状态刷新延迟。",
  "Git status refresh failed.": "Git 状态刷新失败。",
  "No GitHub repository detected for this project.": "这个项目没有检测到 GitHub 仓库。",

  // Slash commands, snooze and settings search
  "Moss stopped reading source-control changes at the diff size limit. Some files or changes may be missing; bulk actions only affect the files shown.":
    "差异大小已达上限，Moss 已停止读取源代码管理中的更改。部分文件或更改可能缺失；批量操作只影响显示的文件。",
  "Threads, context, and memory for the hub live in this folder after you set up the coordinator. Setup does not launch a model.":
    "设置协调者后，Hub 的对话、上下文和记忆都保存在这个文件夹中。设置过程不会启动模型。",
  "Send this follow-up now to redirect the current work. If native steering is unavailable, stop the current turn and start a new one.":
    "立即发送这条后续消息，以调整当前工作。如果不支持原生引导，请停止当前回合并开始新回合。",
  "Switch this thread into evidence-first debug mode": "把这个对话切换到证据优先的调试模式",
  "Open a guarded Side from this thread, optionally on another provider":
    "从这个对话打开受保护的侧边对话，可选择其他服务商",
  "Use Moss Computer for this request only": "仅在这次请求中使用 Moss 电脑控制",
  "Set, edit, pause, resume, or clear this thread's persistent goal":
    "设置、编辑、暂停、恢复或清除这个对话的持续目标",
  "Regenerate this thread title, or set an exact title": "重新生成这个对话的标题，或设置指定标题",
  "Import skills, settings, and recent chats from Claude Code or Cursor":
    "从 Claude Code 或 Cursor 导入技能、设置和最近的对话",
  "For 30 minutes": "30 分钟",
  "For 1 hour": "1 小时",
  "For 2 hours": "2 小时",
  "Until tomorrow at 9am": "到明天上午 9 点",
  "Unable to return thread": "无法恢复对话",
  "Unable to snooze thread": "无法设置稍后提醒",
  "Computer status": "电脑状态",
  "Always allowed": "始终允许",
  "Follow-up behavior": "后续消息处理",
  "Pull request diff colors": "拉取请求差异颜色",
  "Keep computer awake": "保持电脑唤醒",
  "Sidebar usage rings": "侧边栏用量圆环",
  "External MCP integrations": "外部 MCP 集成",

  // Window chrome
  "Moss window tabs": "Moss 窗口标签",
  "Moss features": "Moss 功能",
  "Right sidebar unavailable": "右侧边栏不可用",
  "Right sidebar": "右侧边栏",
};

export function translateZhCnChatSurfaceText(value: string): string {
  return lookupPhrase(CHAT_SURFACE_COPY, value) ?? value;
}
