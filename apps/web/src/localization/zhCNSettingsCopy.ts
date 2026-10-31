// FILE: zhCNSettingsCopy.ts
// Purpose: Simplified Chinese for settings pages, keyboard shortcuts, and desktop status copy
//          that the packaged client still showed in English or half translated.
// Layer: Pure localization data
// Runs first in the presentation chain, so a whole sentence never falls through to a
// word-level rule such as `Show <label>`.

const SETTINGS_COPY: Readonly<Record<string, string>> = {
  // Appearance and theme editor
  Standard: "标准",
  "Keeps the chat column at the default reading width (46rem).":
    "对话栏保持默认阅读宽度（46rem）。",
  Wide: "宽",
  "Gives tables and wide content more room (72rem).": "为表格和较宽的内容留出更多空间（72rem）。",
  Full: "全宽",
  "Lets the chat column use the full window width.": "对话栏使用整个窗口的宽度。",
  "Restart to apply title bar": "重启后应用标题栏",
  "The window frame updates the next time Moss launches.": "下次启动 Moss 时更新窗口边框。",
  "Could not update title bar": "无法更新标题栏",
  "Restart required": "需要重启",
  "Restart Moss to apply. Some Linux window managers work better with the system title bar.":
    "重启 Moss 后生效。部分 Linux 窗口管理器使用系统标题栏效果更好。",
  "Replace the system title bar with Moss's frameless chrome and window controls. Restart required to apply.":
    "用 Moss 的无边框外观和窗口控件替换系统标题栏。需要重启才能生效。",
  "App icon": "应用图标",
  Solid: "不透明",
  Translucent: "半透明",
  "Theme copied": "主题已复制",
  "Copy failed": "复制失败",
  "Unable to copy the theme share string.": "无法复制主题分享字符串。",
  "Sidebar only": "仅侧边栏",
  Opacity: "不透明度",
  Blur: "模糊",
  "Theme imported": "主题已导入",
  "Unable to import that theme string.": "无法导入这个主题字符串。",
  "Theme share string": "主题分享字符串",
  "Default icon": "默认图标",
  Icon: "图标",
  "Dark icon": "深色图标",
  "Beta icon": "Beta 图标",

  // General and conversation behaviour
  "Mac audio": "Mac 音频",
  Both: "两者都显示",
  "Stop and send": "停止并发送",
  "Show the Hubs tab in the sidebar switcher.": "在侧边栏切换器中显示 Hubs 标签。",
  "Thread order": "对话排序",
  "Project order": "项目排序",
  "Automation runs": "自动化运行",
  "Show the thread each standalone automation run creates. Runs stay listed on the automation's page either way; threads owned by dedicated or heartbeat automations always stay visible.":
    "显示每次独立自动化运行创建的对话。无论是否显示，运行记录都会保留在自动化页面上；专用自动化和心跳自动化的对话始终可见。",
  "Show a compact summary of the chat's subagents in the Environment panel. Click it to open the full list, running and done, in the right dock.":
    "在环境面板中显示对话子智能体的简要汇总。点击可在右侧栏打开完整列表，包括运行中和已完成的子智能体。",
  "Show subagents for the current chat in the Environment panel. Opening the row lists them in the right dock.":
    "在环境面板中显示当前对话的子智能体。打开这一行后，会在右侧栏列出它们。",
  "Fold finished turns": "折叠已完成的回合",
  'Hide a finished turn\'s tool calls and intermediate messages behind a single "Worked for…" line. A turn stays open while it runs or while its background subagents are still working. Turn this off to keep every step visible.':
    "把已完成回合的工具调用和中间消息折叠到一行“已工作…”里。回合运行时，或后台子智能体还在工作时，回合保持展开。关闭后每一步都会显示。",
  "Effort slider": "思考强度滑块",
  "Show effort as a slider at the bottom of the composer's model picker, with fast mode and reset alongside it, instead of separate Effort and Speed rows.":
    "在输入框模型选择器底部用滑块显示思考强度，并把快速模式和重置放在旁边，不再分成思考强度和速度两行。",
  "Automatically open simulator": "自动打开模拟器",
  "Open the iOS Simulator pane when an agent uses a device. Turn this off to use Simulator.app without the mirrored pane reopening. You can still open the pane manually.":
    "智能体使用设备时打开 iOS 模拟器面板。关闭后可以单独使用 Simulator.app，镜像面板不会再自动打开，你仍可手动打开它。",
  "Diff layout": "差异布局",
  "Default stacked or split layout for threads without a saved choice. Each thread remembers its review-panel changes independently.":
    "没有保存过选择的对话默认使用的堆叠或分栏布局。每个对话会单独记住审查面板中的更改。",
  "Include fork upstreams": "包含复刻的上游仓库",
  "Also list pull requests and issues from each project's other GitHub remotes, such as the repository a fork was made from. Off reads only the project's own repository.":
    "同时列出项目其他 GitHub 远程仓库（例如复刻来源仓库）的拉取请求和议题。关闭后只读取项目自己的仓库。",
  Conversations: "对话",

  // Desktop and computer control
  "Reconnecting to the desktop": "正在重新连接桌面",
  "Checking computer availability": "正在检查电脑是否可用",
  "Waiting for the desktop backend.": "正在等待桌面后端。",
  "All permissions granted": "已授予所有权限",
  "Moss connects to the desktop the next time an agent uses it.":
    "下次智能体使用桌面时，Moss 会连接桌面。",
  "Computer access has not been checked": "尚未检查电脑访问权限",
  "Choose Set up to check that Moss can see and control the desktop.":
    "选择“设置”以检查 Moss 能否查看和控制桌面。",
  "Screen capture is unavailable": "屏幕捕获不可用",
  "Desktop input is connected, but Moss cannot take screenshots. Choose Set up to check access.":
    "桌面输入已连接，但 Moss 无法截图。选择“设置”以检查访问权限。",
  "Connected to the desktop": "已连接桌面",
  "Moss can see and control the desktop through its computer tools.":
    "Moss 可以通过电脑工具查看和控制桌面。",
  "Computer control is unavailable": "电脑控制不可用",
  "Show guide": "显示指南",
  "Hide guide": "隐藏指南",
  "Show history": "显示历史记录",
  "Hide history": "隐藏历史记录",
  "Watching for the change — this page updates automatically.": "正在等待更改，此页面会自动更新。",
  "Lets Moss move the pointer, click, and type on your behalf. Nothing is driven unless you authorize a Computer task.":
    "允许 Moss 代你移动指针、点击和输入。只有你授权电脑任务后才会操作。",
  "Lets Moss capture windows and the desktop so the agent can see what it is driving.":
    "允许 Moss 捕获窗口和桌面，让智能体能看到它正在操作的内容。",
  "Lets Moss detect Escape and pause when you take over during a Computer task. This does not enable the AppSnap shortcut.":
    "允许 Moss 检测 Esc 键，在你接管电脑任务时暂停。这不会启用应用截图快捷键。",
  "Permission granted": "已授予权限",
  "Permissions unchanged": "权限没有变化",
  "Use Grant next to a permission to walk through setup.": "点击权限旁边的“授予”，按步骤完成设置。",
  "Could not check permissions": "无法检查权限",
  "Rechecking…": "正在重新检查…",
  "Could not check this shortcut.": "无法检查这个快捷键。",
  "That key isn't supported — try another.": "不支持这个按键，请换一个。",
  "Hold ⌘, ⌃, ⌥ or ⇧ first, then press the other key.": "先按住 ⌘、⌃、⌥ 或 ⇧，再按另一个键。",
  "Hold only one modifier.": "只按住一个修饰键。",
  "Press two keys…": "请按两个键…",
  "Loading recent actions…": "正在加载最近的操作…",
  "Could not load recent actions. Refresh to try again.": "无法加载最近的操作。请刷新后重试。",
  "Refresh history": "刷新历史记录",
  "Some earlier actions are unavailable. This is not a complete history.":
    "部分较早的操作不可用，这不是完整的历史记录。",
  "Computer status is unavailable": "无法获取电脑状态",
  "The server could not be reached.": "无法连接服务器。",
  Stock: "默认",
  Fill: "填充",
  Rim: "描边",
  Large: "大",

  // Microphone and voice
  Voice: "语音",
  "This environment cannot list microphone inputs.": "当前环境无法列出麦克风输入。",
  "Microphone access is blocked. Enable Moss in macOS Privacy & Security > Microphone, then retry.":
    "麦克风访问被阻止。请在 macOS 隐私与安全性 > 麦克风中启用 Moss，然后重试。",
  "No microphone is connected. Connect one, then retry.": "没有连接麦克风。请连接后重试。",
  "Microphones could not be checked. Close other audio apps, then retry.":
    "无法检查麦克风。请关闭其他音频应用后重试。",
  "Allow microphone access to discover available inputs.": "允许访问麦克风以发现可用的输入设备。",
  "Enable screen context for voice chat": "为语音对话启用屏幕上下文",
  "Loading microphones": "正在加载麦克风",
  "Unable to load microphones": "无法加载麦克风",

  // Providers and accounts
  "Each account signs in on its own and gets its own tab in the model picker.":
    "每个账号单独登录，并在模型选择器中有自己的标签。",
  "Shown in the account list and the model picker. Optional.":
    "显示在账号列表和模型选择器中。可选。",
  "Account ID": "账号 ID",
  "Sign-in expired. Reconnect to keep using it.": "登录已过期。请重新连接以继续使用。",
  "Enable a provider in Settings → Providers to add custom models.":
    "请先在“设置 → 服务商”中启用服务商，才能添加自定义模型。",
  "Replace or remove the saved secret before renaming it.":
    "重命名前，请先替换或移除已保存的密钥。",
  "Unable to stop sign-in. Retry closing this window.": "无法停止登录。请重试关闭此窗口。",
  "Unable to open sign-in options.": "无法打开登录选项。",
  "Sign-in options": "登录选项",
  "Artifacts, /design and /slides": "Artifacts、/design 和 /slides",
  "Optional Cursor API endpoint override passed to `cursor-agent -e`.":
    "可选的 Cursor API 端点覆盖值，会传给 `cursor-agent -e`。",
  Reference: "参考",
  Docs: "文档",
  "Oh My Pi agent directory": "Oh My Pi 智能体目录",
  "Optional custom Oh My Pi agent directory for auth, models, skills, and commands.":
    "可选的自定义 Oh My Pi 智能体目录，用于认证、模型、技能和命令。",
  "Leave blank and Moss keeps this account's sign-in in its own folder.":
    "留空时，Moss 会把这个账号的登录信息保存在单独的文件夹中。",
  "Claude config directory": "Claude 配置目录",
  "Profile directory": "配置文件目录",
  "Used as this account's provider config root without changing your shell files.":
    "用作这个账号的服务商配置根目录，不会更改你的 shell 文件。",
  "Unable to start sign-in": "无法开始登录",
  "Unable to save provider settings.": "无法保存服务商设置。",
  "Account added": "账号已添加",
  Identity: "身份",
  "The provider update failed.": "服务商更新失败。",
  "Keep Moss responsive": "保持 Moss 流畅",
  "Give agent processes and their commands a moderately lower CPU priority when the machine is busy.":
    "电脑繁忙时，适度降低智能体进程及其命令的 CPU 优先级。",
  "Codex account for new threads": "新对话使用的 Codex 账号",
  "Used until you pick another account in the model picker.":
    "在你从模型选择器中选择其他账号之前，一直使用这个账号。",
  "Claude credential directory": "Claude 凭据目录",
  "Leave blank unless your setup already uses a separate secure-storage directory.":
    "除非你的环境已经使用单独的安全存储目录，否则请留空。",
  "Import directory": "导入目录",
  "Opening sign-in…": "正在打开登录…",
  "Command:": "命令：",
  "No providers enabled. Open Disabled providers below to enable one.":
    "没有启用任何服务商。请打开下方的“已停用的服务商”来启用。",
  "Disabled providers (": "已停用的服务商（",
  "Conventional Commits": "约定式提交",
  "Use Conventional Commit prefixes and keep change request text concise.":
    "使用约定式提交前缀，并保持变更请求的文字简洁。",
  "Custom instructions": "自定义指令",
  "Use your instructions for change descriptions and change requests in every project.":
    "在每个项目的变更说明和变更请求中都使用你的指令。",

  // Usage
  Ring: "圆环",
  "Usage popovers": "用量浮窗",
  "Show details by default": "默认显示详情",
  "Show usage details by default in usage popovers": "在用量浮窗中默认显示用量详情",
  "Banked resets": "累积的重置次数",
  "Include Codex banked resets in the details.": "在详情中包含 Codex 累积的重置次数。",
  "Show banked resets in usage popovers": "在用量浮窗中显示累积的重置次数",
  "Credits and token totals": "额度和令牌总量",
  "Include credit balances and recent token totals (24h, 7d, 30d) in the details.":
    "在详情中包含额度余额和最近的令牌总量（24 小时、7 天、30 天）。",
  "Show credits and token totals in usage popovers": "在用量浮窗中显示额度和令牌总量",

  // Local state, worktrees, and archives
  "Unable to open keybindings file.": "无法打开快捷键文件。",
  "Local state repaired": "本地状态已修复",
  "Project indexes were rebuilt without clearing existing chats.":
    "项目索引已重建，现有对话没有被清除。",
  "Repair failed": "修复失败",
  "Unable to repair local state.": "无法修复本地状态。",
  "Sign out failed": "退出登录失败",
  "Unable to revoke this session.": "无法撤销这个会话。",
  "Open the persisted `keybindings.json` file to edit advanced bindings directly.":
    "打开已保存的 `keybindings.json` 文件，直接编辑高级快捷键。",
  "What this does": "这有什么作用",
  "Could not verify linked conversations": "无法验证关联的对话",
  "Retry once the app reconnects to the server.": "请在应用重新连接服务器后重试。",
  "Worktree deleted": "工作树已删除",
  "Could not delete worktree": "无法删除工作树",
  "Unable to delete the worktree.": "无法删除这个工作树。",
  "Unable to load worktrees.": "无法加载工作树。",
  "The thread has been moved back to the sidebar.": "对话已移回侧边栏。",
  "The archived thread has been permanently removed.": "已归档的对话已被永久删除。",
  "Could not delete thread": "无法删除对话",
  "Unable to delete the thread.": "无法删除这个对话。",
  "Archived threads deleted": "已归档的对话已删除",
  "Could not delete all archived threads": "无法删除所有已归档的对话",
  "Unable to delete the threads.": "无法删除这些对话。",
  "No conversations linked to this worktree.": "没有对话关联到这个工作树。",
  "Linked conversations exist. Deleting will ask for confirmation.":
    "存在关联的对话。删除时会先请你确认。",
  "Delete all": "全部删除",
  "Desktop notifications unavailable": "桌面通知不可用",
  "Activity notification": "活动通知",
  "Test notification sent": "测试通知已发送",
  "Your browser should show the notification.": "你的浏览器应该会显示这条通知。",

  // MCP connections
  "Could not copy": "无法复制",
  "Connection ready": "连接已就绪",
  "Give your agent the setup prompt before the one-time code expires.":
    "请在一次性代码过期前，把设置提示发给你的智能体。",
  "Could not create connection": "无法创建连接",
  "External MCP setup failed.": "外部 MCP 设置失败。",
  "Connection revoked": "连接已撤销",
  "Its credential stops working immediately.": "它的凭据会立即失效。",
  "Could not revoke connection": "无法撤销连接",
  "Revocation failed.": "撤销失败。",
  "New pairing code ready": "新的配对码已就绪",
  "Copy the refreshed setup prompt. The new one-time code lasts 10 minutes.":
    "请复制更新后的设置提示。新的一次性代码有效期为 10 分钟。",
  "Could not resume pairing": "无法继续配对",
  "Pairing refresh failed.": "配对刷新失败。",
  "No projects are available.": "没有可用的项目。",
  "Without this permission, the agent can read only tasks it creates.":
    "没有这项权限时，智能体只能读取它自己创建的任务。",
  "Use the shared local checkout": "使用共享的本地检出",
  "Run without approval prompts": "运行时不弹出审批提示",
  "Revoke and start over": "撤销并重新开始",
  "Copy setup prompt": "复制设置提示",
  "Pairing command (run in Terminal)": "配对命令（在终端中运行）",
  "MCP configuration (JSON)": "MCP 配置（JSON）",
  "Copy example prompt": "复制示例提示",
  "Add Moss to Codex with one terminal command.": "用一条终端命令把 Moss 添加到 Codex。",
  "Add Moss to Claude Code for your user account.": "为你的用户账号把 Moss 添加到 Claude Code。",
  "Copy a ready-to-paste local MCP configuration.": "复制可直接粘贴的本地 MCP 配置。",
  "Other MCP app": "其他 MCP 应用",
  "Use the standard stdio MCP configuration.": "使用标准的 stdio MCP 配置。",

  // Keyboard shortcuts
  "Could not change shortcuts": "无法更改快捷键",
  "Shortcuts reset to defaults": "快捷键已恢复默认",
  "Change shortcut": "更改快捷键",
  "Add another shortcut": "添加另一个快捷键",
  "Set shortcut": "设置快捷键",
  "Reset all to defaults": "全部恢复默认",
  "Loading shortcuts…": "正在加载快捷键…",
  Unassigned: "未分配",
  "Next model effort": "下一个模型思考强度",
  "Cycle the model's available effort levels and briefly show the selected level.":
    "循环切换模型可用的思考强度，并短暂显示所选强度。",
  "Open the Create project dialog to import a local folder.":
    "打开创建项目对话框，导入本地文件夹。",
  "Toggle Activity": "切换活动",
  "Show or hide running tasks, completed work, and items that need attention.":
    "显示或隐藏运行中的任务、已完成的工作和需要处理的事项。",
  "Float or dock the sidebar": "浮动或停靠侧边栏",
  "Float the sidebar over the chat or dock it back into the shell.":
    "让侧边栏浮在对话上方，或停靠回窗口中。",
  "Toggle right sidebar": "切换右侧栏",
  "Show or hide the right-hand dock for the active thread.": "显示或隐藏当前对话的右侧栏。",
  "Previous space": "上一个空间",
  "Switch to the previous project space and restore its last working context.":
    "切换到上一个项目空间，并恢复它上次的工作内容。",
  "Next space": "下一个空间",
  "Switch to the next project space and restore its last working context.":
    "切换到下一个项目空间，并恢复它上次的工作内容。",
  "New Antigravity thread": "新建 Antigravity 对话",
  "Start a fresh thread with Antigravity selected.": "新建一个选中 Antigravity 的对话。",
  "Open usage settings": "打开用量设置",
  "Open Settings → Usage for provider quota and token totals.":
    "打开“设置 → 用量”，查看服务商配额和令牌总量。",
  "Find in thread": "在对话中查找",
  "Search the current transcript and jump to each matching message.":
    "搜索当前对话记录，并跳转到每条匹配的消息。",
  "Open the workspace file-name search palette.": "打开工作区文件名搜索面板。",
  "Search snippets": "搜索片段",
  "Open the workspace content search palette across file snippets.":
    "打开工作区内容搜索面板，搜索文件片段。",
  "Focus terminal": "聚焦终端",
  "Open or focus the terminal panel for this thread.": "打开或聚焦这个对话的终端面板。",
  "Close the terminal session for this thread.": "关闭这个对话的终端会话。",
  "Next change": "下一处更改",
  "Jump the diff viewport to the next changed file.": "把差异视图跳转到下一个已更改的文件。",
  "Previous change": "上一处更改",
  "Jump the diff viewport to the previous changed file.": "把差异视图跳转到上一个已更改的文件。",
  "Toggle side chat": "切换侧边对话",
  "Open or hide a side chat beside the main conversation.": "在主对话旁打开或隐藏侧边对话。",
  "Toggle preview": "切换预览",
  "Show or hide the preview pane for the active thread.": "显示或隐藏当前对话的预览面板。",
  "Refresh preview": "刷新预览",
  "Reload the content in the preview pane.": "重新加载预览面板中的内容。",
  "Focus preview URL": "聚焦预览地址",
  "Move keyboard focus to the preview pane's address field.": "把键盘焦点移到预览面板的地址栏。",
  "Zoom in preview": "放大预览",
  "Increase the preview pane's zoom level.": "提高预览面板的缩放比例。",
  "Zoom out preview": "缩小预览",
  "Decrease the preview pane's zoom level.": "降低预览面板的缩放比例。",
  "Reset preview zoom": "重置预览缩放",
  "Return the preview pane to the default zoom level.": "把预览面板恢复为默认缩放比例。",
  "Toggle iOS Simulator": "切换 iOS 模拟器",
  "Reveal the iOS Simulator panel for the active thread. macOS servers only.":
    "显示当前对话的 iOS 模拟器面板。仅限 macOS 服务器。",
  "Copy thread ID": "复制对话 ID",
  "Copy the active thread's ID to the clipboard.": "把当前对话的 ID 复制到剪贴板。",
  "Archive the active chat, with the same confirmation and undo as the thread menu.":
    "归档当前对话，确认和撤销方式与对话菜单相同。",
  "Snooze thread": "稍后提醒对话",
  "Open the snooze date and time picker for the active chat.":
    "打开当前对话的稍后提醒日期和时间选择器。",
  "Mark thread unread": "将对话标为未读",
  "Mark the active chat unread and restore its dismissed notification.":
    "把当前对话标为未读，并恢复已关闭的通知。",
  "Open the most urgent other chat: one waiting on you first, then unseen work, as Activity's Priority ranks them.":
    "打开最紧急的其他对话：先是等你处理的，然后是未查看的工作，排序与活动的优先级一致。",
  "Previous tab": "上一个标签",
  "Switch to the open thread tab on the left of the active one.": "切换到当前标签左侧的对话标签。",
  "Next tab": "下一个标签",
  "Switch to the open thread tab on the right of the active one.": "切换到当前标签右侧的对话标签。",
  "Close the active open thread tab.": "关闭当前打开的对话标签。",
  "Save file": "保存文件",
  "Write the focused editor's unsaved changes back to disk.":
    "把当前编辑器中未保存的更改写入磁盘。",
  "Commit and push": "提交并推送",
  "Commit pending changes and push the active thread's repo.":
    "提交待处理的更改，并推送当前对话的仓库。",
  "Close active workspace panel": "关闭当前工作区面板",
  "Close the currently focused workspace panel or tab.": "关闭当前聚焦的工作区面板或标签。",
  "Jump to visible thread 1–9": "跳转到可见对话 1–9",
  "Jump to space 1–9": "跳转到空间 1–9",
  "Switch straight to a tab of the space switcher. 1 is always Void.":
    "直接切换到空间切换器的某个标签。1 始终是 Void。",
  "Assign a shortcut to this built-in command.": "为这个内置命令分配快捷键。",
  "In composer": "在输入框中",
  "Available while the prompt composer or its effort picker has focus.":
    "在输入框或其思考强度选择器获得焦点时可用。",
  Spaces: "空间",
};

const SETTINGS_COPY_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> =
  [
    [
      /^(.+) is not authenticated\. Run `([^`]+)` and try again\.$/,
      (match) => `${match[1]} 尚未登录。请运行 \`${match[2]}\` 后重试。`,
    ],
    [/^(.+) is not installed or not on PATH\.$/, (match) => `${match[1]} 未安装，或不在 PATH 中。`],
  ];

export function translateZhCnSettingsCopyText(value: string): string {
  const exact = SETTINGS_COPY[value];
  if (exact) return exact;
  for (const [pattern, translate] of SETTINGS_COPY_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return translate(match);
  }
  return value;
}
