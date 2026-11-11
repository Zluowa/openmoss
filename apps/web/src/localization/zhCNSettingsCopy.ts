// FILE: zhCNSettingsCopy.ts
// Purpose: Simplified Chinese for settings pages, keyboard shortcuts, and desktop status copy
//          that the packaged client still showed in English or half translated.
// Layer: Pure localization data
// Runs first in the presentation chain, so a whole sentence never falls through to a
// word-level rule such as `Show <label>`.

import { lookupPhrase } from "./zhCNPhraseTable";

const SETTINGS_COPY: Readonly<Record<string, string>> = {
  Connections: "连接",
  "Manage this computer, other devices, and SSH connections.": "管理此电脑、其他设备和 SSH 连接。",
  // Error reports
  Privacy: "隐私",
  "Send error reports": "发送错误报告",
  "When Moss hits an error, it sends a report so the problem can be fixed. Reports go to Sentry, a service in the United States.":
    "Moss 出错时会发送一份报告，以便修复问题。报告会发送到位于美国的 Sentry 服务。",
  "Changes apply right away. While this is off, nothing is sent.":
    "更改立即生效。关闭期间不会发送任何内容。",
  "What a report contains": "报告包含什么",
  Included: "包含",
  "Removed before sending": "发送前会移除",
  "The type of error and where in Moss's code it happened":
    "错误类型，以及它发生在 Moss 代码中的位置",
  "Fixed status details, such as which operation failed and its status code":
    "固定的状态信息，例如哪项操作失败及其状态码",
  "App version, operating system, language, and time zone": "应用版本、操作系统、语言和时区",
  "Device details such as processor, memory, and graphics": "设备信息，例如处理器、内存和显卡",
  "Whether an app session hit an error": "某次使用应用时是否出错",
  "Recent app events, such as a window opening": "最近的应用事件，例如打开窗口",
  "Your chats, prompts, and agent replies": "你的对话、提示词和智能体回复",
  "Your code, files, and project names": "你的代码、文件和项目名称",
  "Keys, passwords, tokens, and account details": "密钥、密码、令牌和账号详情",
  "The text of error messages, unless it's a known message with no personal content":
    "错误信息的文字，除非是不含个人内容的已知信息",
  "Your computer's name and your system username": "你的电脑名称和系统用户名",
  "Sentry sees your IP address when a report arrives, as with any web request, and is set not to store it. Sentry may retain a coarse region inferred from the connection.":
    "和任何网络请求一样，报告到达时 Sentry 能看到你的 IP 地址，但已设置为不保存。Sentry 仍可能保留根据连接推断的大致地区。",
  "Moss Beta works like Moss here: it sends error reports only while Send error reports is on in Settings, and it doesn't send usage counts or crash dumps.":
    "Moss Beta 在这方面与 Moss 相同：只有设置中的“发送错误报告”开启时才会发送错误报告，也不会发送使用统计或崩溃转储。",
  "Error reports follow the same setting as Moss, and you can turn them off in Settings.":
    "错误报告与 Moss 使用同一项设置，你可以在设置中关闭。",
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
  "Moss uses the selected program, then the installed CLI, then its bundled copy. Program changes take effect after restarting Moss.":
    "Moss 优先使用你指定的程序；未指定时，先查找已安装的 CLI，再使用内置版本。更换程序后请重启 Moss。",
  "Codex home directory. When history sharing is enabled, this is the shared history source; each account needs a separate private config and sign-in directory.":
    "启用历史共享后，这个 Codex 目录提供共享历史；每个账号仍需使用单独的目录保存配置和登录信息。",
  "Share Codex history across accounts": "在账号之间共享 Codex 历史",
  "New chats use the selected history source with private account credentials and configuration. Existing chats keep their original history source. No history is moved or merged.":
    "新对话使用所选历史目录，凭据和配置仍按账号独立保存。已有对话继续使用原目录，不会移动或合并历史记录。",
  "Shared Claude projects directory": "共享的 Claude projects 目录",
  "Absolute projects directory": "projects 目录的绝对路径",
  "Choose the existing projects directory to share. Each account needs an explicit, separate private HOME and config directory.":
    "选择要共享的现有 projects 目录，并为每个自有账号指定独立的 HOME 和配置目录。",
  "Share Claude history across accounts": "在账号之间共享 Claude 历史",
  "New chats use this projects directory. Existing chats keep their original source. A newly shared Moss account starts with fresh user settings, home plugins and caches; workspace configuration still applies.":
    "新对话使用这个 projects 目录；已有对话仍使用原目录。首次共享的 Moss 账号使用新的用户设置、个人插件目录和缓存，工作区设置仍然生效。",
  "Private config and sign-in directory": "私有配置和登录目录",
  "Shadow auth home": "独立登录目录",
  "Absolute private directory": "私有目录的绝对路径",
  "Choose folder": "选择文件夹",
  "Directory selection is available in the Moss desktop app.": "可在 Moss 桌面应用中选择文件夹。",
  "Use a separate private directory for this account. The shared history directory is selected on the default account.":
    "请为这个账号指定独立的私有目录。共享历史目录在默认账号的设置中选择。",
  "Choose a private HOME for this account. The config directory defaults to .claude inside that HOME.":
    "请为这个账号指定私有 HOME。配置目录默认为该 HOME 下的 .claude。",
  "Each account signs in separately. Chats created with shared history keep their selected source when you switch accounts.":
    "每个账号单独登录。启用共享历史后创建的对话，在切换账号时仍使用原先选定的历史目录。",
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
    "直接切换到空间切换器的某个标签。1 始终是未归类。",
  "Assign a shortcut to this built-in command.": "为这个内置命令分配快捷键。",
  "In composer": "在输入框中",
  "Available while the prompt composer or its effort picker has focus.":
    "在输入框或其思考强度选择器获得焦点时可用。",
  Spaces: "空间",
  "Show keybindings": "显示按键绑定",
  "Jump to Void": "跳转到未归类",
  "Switch straight to the Void tab of the space switcher.": "直接切换到空间切换器的“未归类”标签。",
  "Switch straight to this tab of the space switcher.": "直接切换到空间切换器的这个标签。",
  "Hold the modifiers and press a number key.": "按住修饰键，再按一个数字键。",
  "Use Ctrl or Alt with any key, or an F-key on its own.":
    "任意键搭配 Ctrl 或 Alt 使用，或者单独使用 F 键。",
  "Use ⌘, ⌥ or ⌃ with any key, or an F-key on its own.":
    "任意键搭配 ⌘、⌥ 或 ⌃ 使用，或者单独使用 F 键。",
  "Hold the modifiers, then press any number key.": "按住修饰键，再按任意数字键。",
  "Add ⌘, ⌥ or ⌃ to that key, or use an F-key on its own.":
    "给这个键加上 ⌘、⌥ 或 ⌃，或者单独使用 F 键。",
  "Add Ctrl or Alt to that key, or use an F-key on its own.":
    "给这个键加上 Ctrl 或 Alt，或者单独使用 F 键。",
  "Press new keys to change its shortcut.": "按下新的按键来更改它的快捷键。",
  "Choose the keys that run it.": "选择运行它的按键。",
  "Reset anyway": "仍要重置",
  "Press shortcut…": "按下快捷键…",

  // Reset button labels, which `SettingResetButton` places inside "将…重置为默认值"
  "keep computer awake": "保持电脑唤醒",
  "computer control": "电脑控制",
  "cursor colors": "光标颜色",
  "activity toasts": "活动提示",
  "desktop notifications": "桌面通知",
  "wait for subagents": "等待子智能体",
  "git writing model": "Git 写作模型",
  "source control writing style": "源代码管理写作风格",
  "enabled providers": "已启用的服务商",
  "app icon": "应用图标",
  "custom title bar": "自定义标题栏",
  "chat width": "对话宽度",
  "terminal font size": "终端字号",
  "terminal font": "终端字体",
  "side chat expiry": "侧边对话有效期",
  "enter while dictating": "听写时按 Enter",
  "message trail sound": "消息轨迹声音",
  "message trail microphone": "消息轨迹麦克风",
  "diff layout": "差异布局",
  "open pull requests and issues": "打开拉取请求和议题",
  "project order": "项目排序",
  "thread order": "对话排序",

  // Profile, usage and limits
  "Claude token totals use verifiable records. Older history and unfinished turns may be incomplete.":
    "Claude 的 token 总量来自可核实的记录。较早的历史和未完成的回合可能不完整。",
  "Share of tracked tokens.": "已统计 token 的占比。",
  "Share of turns.": "回合占比。",
  // ProfileUsageCoverage renders the provider list as its own text node, so the sentence
  // after it arrives starting with the period that closes that list.
  ". Percentages reflect tracked tokens only. Their turns still count toward activity totals.":
    "。百分比只按已统计的 token 计算，这些服务商的回合仍计入活动总数。",
  "Sidebar usage ring": "侧边栏用量圆环",
  "No usage data reported yet.": "还没有上报用量数据。",
  "Open the details below the limits. When off, they stay behind the Details toggle; your last toggle also updates this preference.":
    "在限额下方展开详情。关闭时，详情收在“详情”开关后面；你最后一次切换也会更新这个偏好。",
  "Usage is read locally from each provider CLI's stored credentials and fetched directly from the provider. The list follows whatever you are signed into; unsigned providers stay visible until any account is connected, then drop away. Short-lived tokens are refreshed through the provider's own CLI or official token endpoint.":
    "用量通过各服务商 CLI 在本地保存的凭据读取，并直接从服务商获取。列表跟随你已登录的账号；未登录的服务商会一直显示，直到连接了任意账号后才隐藏。短期 token 通过服务商自己的 CLI 或官方 token 端点刷新。",
  "Codex account usage requires a compatible app-server runtime.":
    "查看 Codex 账号用量需要兼容的 app-server 运行时。",
  Free: "免费版",
  Enterprise: "企业版",
  Account: "账号",
  "A previous reset is unconfirmed. Retry checks the same attempt.":
    "上一次重置尚未确认。重试会检查同一次尝试。",
  "Use when your 5-hour or weekly limit has 10% or less remaining.":
    "当 5 小时或每周限额剩余 10% 或更少时使用。",
  "Next available reset": "下一次可用重置",
  "Applying…": "正在应用…",
  "Retry reset": "重试重置",
  "Use reset": "使用重置",
  "Reset result not confirmed": "重置结果未确认",
  "Retry this reset to check the same attempt.": "重试这次重置，以检查同一次尝试。",

  // Conversation behaviour
  "In Moss": "在 Moss 中",
  "Include fork upstreams in code review": "代码审查时包含复刻的上游仓库",

  // Appearance and theme editor
  "Unavailable, use Auto": "不可用，请使用自动",
  "Paste a": "粘贴一个",

  // AppSnap and computer control
  "Press your two-key shortcut while any app is frontmost. Moss captures that window as an image, brings itself forward, and attaches the snap to a task composer — the capture stays on this device until you send the message.":
    "在任意应用位于最前方时，按下你设置的双键快捷键。Moss 会将该窗口截为图像、切回前台并附加到任务输入框；发送消息之前，截图仅保存在此设备上。",
  "Current shortcut": "当前快捷键",
  "AppSnap shortcut saved": "应用截图快捷键已保存",
  "AppSnap shortcut saved, but unavailable": "应用截图快捷键已保存，但暂不可用",
  "The shortcut is reserved while AppSnap is enabled.": "启用应用截图时，这个快捷键会被保留。",
  "The shortcut will be reserved when you enable AppSnap.": "启用应用截图后，这个快捷键会被保留。",
  "Still denied after an update or rebuild? Remove this app from the list and add this copy again. Complete any macOS authentication, and restart if macOS asks you to quit and reopen.":
    "更新或重新构建后仍被拒绝？请把这个应用从列表中移除，再重新添加这个副本。完成 macOS 要求的身份验证；如果 macOS 要求退出并重新打开，请重启。",
  Grant: "授权",
  "AppSnap is separate: it attaches a window image without giving the agent control.":
    "应用截图是单独的功能：它只附加窗口图像，不会把控制权交给智能体。",
  "Check again": "再次检查",
  "Enable Computer by default in any chat. Leave this off and use /computer-use for one request without adding Computer tools to ordinary turns.":
    "在任何对话中默认启用电脑控制。保持关闭时，可用 /computer-use 发起单次请求，不会把电脑工具加到普通回合中。",
  "Agent cursor colors": "智能体光标颜色",
  "In-chat computer preview size": "对话内电脑预览大小",
  "Load older actions": "加载更早的操作",
  "Computer action": "电脑操作",
  "Action history is not enabled on this server.": "这台服务器没有启用操作历史。",
  "Older retained actions are no longer available. Refresh to see recent actions.":
    "更早保留的操作已不可用。刷新可查看最近的操作。",
  "No recorded actions yet.": "还没有记录到操作。",
  "Showing the latest": "显示最近的",
  "loaded actions.": "条已加载操作。",
  "Recent actions across chats on this server. Read-only observations, typed text, page contents, and file paths are not included.":
    "这台服务器上各对话最近的操作。只读观察、输入的文字、页面内容和文件路径不会记录。",

  // Notifications and Moss Beta
  "Notifications unavailable": "通知不可用",
  "Your operating system should show the notification.": "你的操作系统应该会显示这条通知。",
  "Desktop notifications are not supported on this device.": "这台设备不支持桌面通知。",
  "Last import failed:": "上次导入失败：",
  "Install failed:": "安装失败：",
  "unknown error": "未知错误",

  // MCP connections
  "High impact. Tasks may modify the checkout you are actively using instead of an isolated worktree.":
    "影响较大。任务可能修改你正在使用的检出目录，而不是隔离的工作树。",
  "High impact. The external agent may start full-access execution without asking you to approve tool actions.":
    "影响较大。外部智能体可能以完全访问权限运行，不会请你批准工具操作。",
  "High impact. Tasks may drive this computer's screen — observe, click, type, menus, clipboard. Every computer action still asks for your approval.":
    "影响较大。任务可能操作这台电脑的屏幕：查看、点击、输入、菜单和剪贴板。每个电脑操作仍会请你批准。",
  "This connection has been revoked and can no longer access Moss.":
    "这个连接已被撤销，不能再访问 Moss。",
  "This connection has expired and can no longer access Moss.": "这个连接已过期，不能再访问 Moss。",
  "Moss received a request from this agent. Setup is complete.":
    "Moss 已收到这个智能体的请求。设置完成。",
  "The private credential is stored locally. If the agent has not registered Moss yet, give it the setup prompt below.":
    "私密凭据保存在本地。如果智能体还没有注册 Moss，请把下面的设置提示词发给它。",
  "The one-time pairing code was not used in time. Resume pairing to issue a fresh code without replacing this connection.":
    "一次性配对码未及时使用。恢复配对可以签发新的配对码，不会替换这个连接。",
  "Paste the setup prompt into your agent. This page updates automatically when pairing succeeds.":
    "把设置提示词粘贴到智能体中。配对成功后，这个页面会自动更新。",
  "Resuming...": "正在恢复…",
  "Resume pairing": "恢复配对",
  "1. Give your agent this prompt": "1. 把这段提示词发给智能体",
  "2. Try it": "2. 试一试",
  "Projects:": "项目：",
  "Permissions:": "权限：",
  "Waiting for pairing": "等待配对",
  "Paired — waiting for first use": "已配对，等待首次使用",
  "Paired — not used yet": "已配对，尚未使用",
  "Pairing code expired": "配对码已过期",
  Revoked: "已撤销",
  "All projects, including future ones": "所有项目，包括以后新建的",
  "No projects": "没有项目",
  "Create and follow its own tasks": "创建并跟进自己的任务",
  "Read other tasks in selected projects": "读取所选项目中的其他任务",
  "Read redacted desktop diagnostics": "读取已脱敏的桌面诊断信息",
  "Control this computer (per-action approval still applies)": "控制这台电脑（每个操作仍需批准）",
  "· Last used": "· 上次使用",
  "· Expires": "· 到期",
  "Continue setup": "继续设置",

  // Models and provider accounts
  "Model Name": "模型名称",
  "Git text generation model": "Git 文本生成模型",
  "Enter a model slug.": "请输入模型标识。",
  "That model is already built in.": "这个模型已经内置。",
  "That custom model is already saved.": "这个自定义模型已经保存。",
  "e.g. Work": "例如：工作",
  "Routing key used by threads and sessions. Letters, digits, '-', or '_'.":
    "对话和会话使用的路由键。可用字母、数字、“-”或“_”。",
  "Optional. Shows as a dot on the account's icon in the picker.":
    "可选。在选择器中显示为账号图标上的圆点。",
  "This runs on the Moss server machine for the selected account.":
    "这会在 Moss 服务器所在的机器上，为所选账号运行。",
  "Unable to connect to the Moss server.": "无法连接到 Moss 服务器。",
  "Sign-in could not start. Check the terminal error, close this window and retry.":
    "无法开始登录。请查看终端错误，关闭此窗口后重试。",
  "Follow the provider's prompts. Opening the browser does not confirm authentication.":
    "请按服务商的提示操作。打开浏览器并不代表已完成认证。",
  "Check authentication": "检查认证状态",
  "Closing…": "正在关闭…",
  "Cancel / close": "取消 / 关闭",
  "Moss references the selected directory; no files were moved or copied.":
    "Moss 引用所选目录，不会移动或复制任何文件。",
  "Use 1–64 letters, numbers, dashes, or underscores; bare provider commands are reserved.":
    "请使用 1–64 个字母、数字、短横线或下划线；不带后缀的服务商命令已被保留。",
  "This command is already assigned to another account. Choose a unique override.":
    "这个命令已分配给其他账号。请另选一个不重复的命令。",
  "Available in Moss terminals for zsh, bash, fish, and scripts.":
    "可在 Moss 终端的 zsh、bash、fish 和脚本中使用。",
  "Use Sign in to authenticate this account, then complete the provider's prompts.":
    "使用“登录”认证这个账号，然后完成服务商的提示步骤。",
  "Each account signs in on its own and gets its own tab in the model picker. A thread stays on the account it started with.":
    "每个账号单独登录，并在模型选择器中有自己的标签。对话会一直使用开始时的账号。",
  "Directory import is available in the Moss desktop app.": "目录导入仅在 Moss 桌面应用中可用。",
  "A newer version is available, but Moss could not identify a safe one-click update command for this installation.":
    "有新版本可用，但 Moss 无法为这个安装方式确定安全的一键更新命令。",
  "manages its own releases, so Moss cannot tell whether a newer version exists. Run the update to be sure.":
    "自行管理发布，Moss 无法判断是否有新版本。运行更新即可确认。",
  "Applies to newly launched agent processes. Restart existing sessions to apply consistently.":
    "只对新启动的智能体进程生效。请重启现有会话，让设置统一生效。",
  "Claude Code keeps Artifacts off in embedded sessions. Turn this on so":
    "Claude Code 在嵌入式会话中默认关闭 Artifacts。开启后，",
  "publish to claude.ai. Needs a claude.ai login on a Pro, Max, Team or Enterprise plan, and applies to new sessions.":
    "可以发布到 claude.ai。需要已登录 Pro、Max、Team 或 Enterprise 方案的 claude.ai 账号，并且只对新会话生效。",
  "from your PATH. Authenticate with": "（来自 PATH）。认证方式：运行",
  "or set WINDSURF_API_KEY.": "或设置 WINDSURF_API_KEY。",
  "Configured — enter a replacement or leave blank": "已配置。输入新值替换，或留空保持不变",
  "ZCode bridge binary path": "ZCode 桥接程序路径",

  // System tools
  "Signing out...": "正在退出登录…",
  "Resolving keybindings path...": "正在解析快捷键配置路径…",
  "Opening...": "正在打开…",
  "Repairing...": "正在修复…",
  "Rebuilds local project indexes and refreshes project snapshots. Existing chats stay in place.":
    "重建本地项目索引并刷新项目快照。现有对话不受影响。",
  "Visible because projects exist but no chat history is currently available.":
    "因为存在项目但当前没有可用的对话记录，所以显示。",

  // Voice
  "Check microphone access": "检查麦克风权限",
  "Selected voice:": "已选语音：",

  // Navigation, fragments and hidden accessible names seen in the sweep
  "No matching settings.": "没有匹配的设置。",
  "Settings search results": "设置搜索结果",
  "Manage plugins, apps, skills, and MCP servers for every agent.":
    "为所有智能体管理插件、应用、技能和 MCP 服务器。",
  "Token usage is unavailable or zero for": "以下服务商的 Token 用量不可用或为零：",
  "Refresh microphones": "刷新麦克风",
  "Sign in to": "登录",
  Primary: "主导航",
  "Settings sections": "设置分区",
  turns: "回合",
  "tracked tokens": "已统计 token",
  "prompts activity": "提示词活动",
  dark: "深色",
  light: "浅色",
  "share string. The embedded variant must match": "分享字符串。其中内嵌的变体必须是",
  ", and the selected code theme must exist for that variant.":
    "，所选代码主题也必须适用于这个变体。",
  Dismiss: "关闭",
  "External browser": "外部浏览器",
  "In-app browser": "应用内浏览器",
  "Retry microphone access": "重试麦克风权限",
  "Close tab": "关闭标签",
  "Close terminal": "关闭终端",
  "Close find (Esc)": "关闭查找（Esc）",
  "Disabled · enable to check setup": "已停用 · 启用后可检查设置",
  "Not authenticated": "未认证",
  accounts: "账号",
  and: "和",
  "Coding agent": "编程智能体",
  Unsupported: "不支持",
  "Open threads": "打开的对话",
  "Search chat...": "搜索对话…",
  "Moss logo": "Moss 标志",

  // Short status words that also appear outside settings
  "Saving…": "正在保存…",
  "Set up": "设置",
  "Setting up…": "正在设置…",
  "1 hour": "1 小时",
  "24 hours": "24 小时",
  // Settings dialog redesign (2026-11-10): short Codex-style rows.
  "Let another agent use Moss": "让其他智能体使用 Moss",
  "How this connection shows up in Moss.": "这个连接在 Moss 中显示的名字。",
  "Work in every project, including new ones.": "可以在所有项目中工作，包括以后新建的。",
  "Extra access. The defaults are safest.": "额外的权限，默认设置最安全。",
  "Lasts 30 days. You can revoke it any time.": "有效期 30 天，随时可以撤销。",
  "Agents you connect show up here.": "连接的智能体会显示在这里。",
  "Fold each finished turn into one line.": "把完成的回合折叠成一行。",
  "Control apps": "控制",
  "Any app": "任意应用",
  "Let Moss use the apps on your computer": "允许 Moss 使用你电脑上的应用",
  "While Moss works": "Moss 操控时",
  "Pointer color": "指针颜色",
  "Looks like a normal pointer by default": "默认和普通指针一样",
  "Live preview": "实时预览",
  "Show what Moss sees in the chat": "在对话里显示 Moss 看到的画面",
  "Moss can't reach computer use right now": "暂时连不上电脑操控",
  "Computer use isn't available on this computer yet": "这台电脑暂不支持电脑操控",
  "Moss needs your permission to use other apps": "需要你允许 Moss 使用其他应用",
  "Moss can't see the screen yet": "Moss 还看不到屏幕",
  "Computer use isn't working right now": "电脑操控暂时无法使用",
  "Reconnecting…": "正在重新连接…",
  "Allow access": "允许访问",
  "Show Moss the window in front": "把最前面的窗口给 Moss 看",
  "Moss sees the window's picture and text, even the part you'd scroll to.":
    "快照包含窗口的画面和文字，连要滚动才能看到的部分也在内。",
  "AppSnap works in the Moss desktop app.": "应用快照只能在 Moss 桌面版中使用。",
  "Turn on AppSnap": "开启应用快照",
  "Works in the Moss desktop app": "在 Moss 桌面版中可用",
  "On while Moss is open": "Moss 打开时可用",
  "Needs your permission": "需要你的允许",
  "Press both keys at once": "同时按下两个键",
  "Send to": "发送到",
  "The task you just used, or a new one": "刚用过的任务，或新建一个",
  "Play sound": "播放音效",
  "Current version": "当前版本",
  "Release notes": "更新记录",
  "What changed in each update.": "每次更新改了什么。",
  "Feature tour": "功能导览",
  "A short look at what Moss can do.": "快速看看 Moss 能做什么。",
  Replay: "重新播放",
  "Repair local data": "修复本地数据",
  "Use this if your chats don't show up. Your chats stay.": "对话不显示时使用，不会删除对话。",
  "Repairing…": "正在修复…",
  "Sign out and close this browser's connection.": "退出登录并断开此浏览器的连接。",
  "Local data repaired": "本地数据已修复",
  "Couldn't repair local data. Try again.": "无法修复本地数据，请重试。",
  "Couldn't sign out. Try again.": "无法退出登录，请重试。",
  "Keybindings file": "快捷键配置文件",
  "Edit every shortcut in a text editor.": "在文本编辑器里修改所有快捷键。",
  "No editor found to open the file.": "没有找到可以打开此文件的编辑器。",
  "Couldn't open the file. Try again.": "无法打开文件，请重试。",
  "Repair local data?": "修复本地数据？",
  "Moss rebuilds its project index. Your chats stay.": "Moss 会重建项目索引，不会删除对话。",
  "Sign out this browser?": "退出此浏览器的登录？",
  "Tighter spacing everywhere.": "间距更紧凑。",
  "More room around everything.": "间距更宽松。",
  "The usual reading width.": "常规阅读宽度。",
  "The microphone the message marks listen to.": "消息标记跟随的麦克风。",
  "Applies the next time Moss opens.": "下次打开 Moss 时生效。",
  "Used for new chats until you pick a model.": "选择模型前，新对话默认使用它。",
  "Where new chats work by default.": "新对话默认在哪里工作。",
  "Remove an unused worktree after archiving. The branch stays.":
    "归档后移除不再使用的工作树，分支会保留。",
  "Scroll each message you send to the top.": "发送的消息滚动到顶部。",
  "Go through first-time setup again.": "重新走一遍首次设置。",
  "How projects are sorted in the sidebar.": "侧边栏中项目的排序方式。",
  "How chats are sorted in each project.": "每个项目中对话的排序方式。",
  "Keep chats that are working or unread at the top.": "进行中和未读的对话排在最前。",
  "Show chats outside projects.": "显示不属于任何项目的对话。",
  "Show the chat each automation run creates.": "显示每次自动化运行创建的对话。",
  "Open the Environment panel in new chats.": "新对话中自动打开环境面板。",
  "Show the chat's subagents.": "显示对话的子智能体。",
  "Show account usage.": "显示账号用量。",
  "Show the GitHub repository link.": "显示 GitHub 仓库链接。",
  "Show the branch's open pull request.": "显示当前分支的拉取请求。",
  "Show the editor and Open in editor.": "显示编辑器和“在编辑器中打开”。",
  "Show the chat recap.": "显示对话摘要。",
  "Show pinned messages.": "显示置顶消息。",
  "Show the project's instructions.": "显示项目说明。",
  "Show the chat's notepad.": "显示对话记事本。",
  "The icon in the dock or taskbar.": "程序坞或任务栏中的图标。",
  "Use Moss's default font instead of the theme's.": "使用 Moss 默认字体，而不是主题字体。",
  "How much space sits around things.": "界面元素之间的留白。",
  "How wide the chat can grow.": "对话区域最宽可以多宽。",
  "The base text size for Moss.": "Moss 的基础字号。",
  "Text size in the terminal.": "终端中的字号。",
  "Any monospace font on this computer.": "这台电脑上的任意等宽字体。",
  "Lighter, crisper text.": "更轻、更清晰的文字。",
  "12- or 24-hour time.": "12 小时制或 24 小时制。",
  "Close side chats that sit unused this long.": "侧边对话闲置这么久后关闭。",
  "What Enter does while you dictate.": "听写时按 Enter 的作用。",
  "Show replies as they are written.": "边写边显示回复。",
  "Pick thinking effort with a slider.": "用滑块选择思考强度。",
  "Let the message marks move with sound.": "让消息标记随声音律动。",
  "Open the Simulator pane when an agent uses it.": "智能体使用模拟器时打开模拟器面板。",
  "Stacked or side by side.": "上下排列或左右并排。",
  "Where pull request and issue links open.": "拉取请求和议题链接在哪里打开。",
  "Include the repository a fork came from.": "同时包括复刻来源的仓库。",
  "Wrap long lines in diffs.": "差异视图中长行自动换行。",
  "Show a notice in Moss when a chat finishes or needs you.": "对话完成或需要你时在 Moss 中提示。",
  "Notify you when Moss is in the background.": "Moss 在后台时发送系统通知。",
  "Alert once, after every subagent is done too.": "所有子智能体完成后只提醒一次。",
  "Matches each project's recent commits.": "跟随每个项目最近的提交风格。",
  "Conventional Commit prefixes, short text.": "Conventional Commit 前缀，文字简短。",
  "Your own instructions, in every project.": "在所有项目中使用你自己的说明。",
  "Writes commit messages, PR titles and branch names.": "用来写提交说明、PR 标题和分支名。",
  "Let Moss look at the app in front when you ask.": "你提到屏幕内容时，允许 Moss 查看最前面的应用",
  "Send a report when Moss hits an error, so it can be fixed.":
    "Moss 出错时发送报告，帮助修复问题。",
};

const SETTINGS_COPY_PATTERNS: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> =
  [
    [
      /^(.+) is not authenticated\. Run `([^`]+)` and try again\.$/,
      (match) => `${match[1]} 尚未登录。请运行 \`${match[2]}\` 后重试。`,
    ],
    [/^(.+) is not installed or not on PATH\.$/, (match) => `${match[1]} 未安装，或不在 PATH 中。`],
    // dnd-kit's screen reader instructions keep the line breaks of its source.
    [
      /^To pick up a draggable item, press the space bar\.\s+While dragging, use the arrow keys to move the item\.\s+Press space again to drop the item in its new position, or press escape to cancel\.$/,
      () =>
        "要拿起可拖动的项目，请按空格键。拖动时，用方向键移动项目。再按一次空格键可放到新位置，按 Esc 键取消。",
    ],
    [/^(\d+) updates? available$/, (match) => `${match[1]} 个更新可用`],
    [/^(\d+) installed$/, (match) => `已安装 ${match[1]} 个`],
    // One text node, so both brackets come out full width.
    [/^Disabled providers \((\d+)\)$/, (match) => `已停用的服务商（${match[1]}）`],
    // Profile "Most used provider": `${provider} · ${percent}% of ${basis}`.
    [
      /^(.+) · (\d+(?:\.\d+)?)% of (tracked tokens|turns)$/,
      (match) =>
        `${match[1]} · 占${match[3] === "turns" ? "回合的" : "已统计 token 的"} ${match[2]}%`,
    ],
    [/^(.+) · Shared \(\.agents\)$/, (match) => `${match[1]} · 共享（.agents）`],
    [/^From Shared \(\.agents\)$/, () => "来自共享（.agents）"],
    // External agent permissions are one " · " list built in externalMcpSetup.ts.
    [
      /^Create and follow its own tasks(?: · .+)?$/,
      (match) =>
        match[0]
          .split(" · ")
          .map((part) => lookupPhrase(SETTINGS_COPY, part) ?? part)
          .join(" · "),
    ],
  ];

export function translateZhCnSettingsCopyText(value: string): string {
  const exact = lookupPhrase(SETTINGS_COPY, value);
  if (exact) return exact;
  for (const [pattern, translate] of SETTINGS_COPY_PATTERNS) {
    const match = pattern.exec(value);
    if (match) return translate(match);
  }
  return value;
}
