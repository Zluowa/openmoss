// FILE: zhCNAccountSettings.ts
// Purpose: Simplified-Chinese presentation copy for authentication, account/profile,
//          settings, provider usage, theme editing, and workspace layout surfaces.
// Layer: Web localization
//
// Only known product copy is translated. Anchored dynamic patterns retain account
// emails, provider and skill names, paths, dates, identifiers, and quota values.
// Unknown strings (including server diagnostics and user-authored content) pass through.

type DynamicTranslation = readonly [pattern: RegExp, translate: (match: RegExpExecArray) => string];

const EXACT_TRANSLATIONS: Readonly<Record<string, string>> = {
  // Cloud-account entry.
  "Moss account required": "需要登录 Moss 账号",
  "Opening sign in…": "正在打开登录…",
  "Return to your": "返回你的",
  "Checking…": "正在检查…",
  "Couldn’t connect to Moss": "无法连接 Moss",
  "Restart Moss and try again.": "请重启 Moss 后重试。",
  "Checking account…": "正在检查账号…",
  "Account unavailable": "账号不可用",
  "Sign-in unavailable": "登录不可用",
  "Not signed in": "未登录",
  "Moss account": "Moss 账号",
  Manage: "管理",

  // Account forms, validation, and authentication status.
  Authentication: "身份验证",
  Email: "邮箱",
  Change: "更改",
  Password: "密码",
  "Forgot password?": "忘记密码？",
  Continue: "继续",
  "Signing in…": "正在登录…",
  "Signing in to Moss.": "正在登录 Moss。",
  "Name (optional)": "姓名（可选）",
  "Use 8–128 characters.": "请输入 8–128 个字符。",
  "Creating account…": "正在创建账号…",
  "Create account": "创建账号",
  "Creating your Moss account.": "正在创建你的 Moss 账号。",
  "Sending link…": "正在发送链接…",
  "Send reset link": "发送重置链接",
  "Requesting a password reset link.": "正在请求密码重置链接。",
  "New password": "新密码",
  "Confirm new password": "确认新密码",
  "Updating password…": "正在更新密码…",
  "Update password": "更新密码",
  "Updating your Moss password.": "正在更新你的 Moss 密码。",
  "Enter your email address.": "请输入邮箱地址。",
  "Enter a valid email address.": "请输入有效的邮箱地址。",
  "Enter your password.": "请输入密码。",
  "Passwords do not match.": "两次输入的密码不一致。",
  "Moss account sign-in isn’t available right now.": "Moss 账号登录当前不可用。",
  "Too many attempts. Wait a moment, then try again.": "尝试次数过多，请稍后重试。",
  "Couldn’t connect to Moss. Check your connection and try again.":
    "无法连接 Moss。请检查网络连接后重试。",
  "This account is disabled. Contact Moss support.": "此账号已停用，请联系 Moss 支持。",
  "Verify your email before signing in.": "请先验证邮箱再登录。",
  "Email or password is incorrect.": "邮箱或密码错误。",
  "This password reset link is invalid or has expired. Request a new link.":
    "此密码重置链接无效或已过期，请重新请求链接。",
  "Your Moss session has expired. Sign in again.": "Moss 会话已过期，请重新登录。",
  "Moss could not sign you in. Check your details and try again.":
    "Moss 无法完成登录。请检查输入后重试。",
  "Moss could not create the account. Try again in a moment.": "Moss 无法创建账号，请稍后重试。",
  "Moss could not update your password. Try again.": "Moss 无法更新密码，请重试。",
  "Moss could not load your account. Try again.": "Moss 无法加载账号，请重试。",
  "The sign-in could not be started.": "无法启动登录流程。",

  // Cloud authentication and account pages.
  "Add a Moss account": "添加 Moss 账号",
  "Sign in to Moss": "登录 Moss",
  "Sign in once, then start chatting. No setup required.": "登录一次即可开始对话，无需额外设置。",
  "Back to accounts": "返回账号列表",
  "New to Moss?": "初次使用 Moss？",
  "Create an account": "创建账号",
  "Checking your account…": "正在检查账号…",
  "Use phone instead": "改用手机号登录",
  "Codex and Claude work after sign-in. Add a key only for a separate key-backed profile.":
    "登录后即可使用 Codex 和 Claude。仅在需要独立 Key 配置时添加。",
  "Create your account": "创建你的账号",
  "Already have an account?": "已有账号？",
  "Reset your password": "重置密码",
  "We’ll email you a reset link.": "我们会通过邮件向你发送重置链接。",
  "Back to sign in": "返回登录",
  "Check your email": "请查收邮件",
  "If an account exists for": "如果以下邮箱存在账号：",
  ", you’ll receive a reset link.": "，你将收到重置链接。",
  "Checking email verification…": "正在检查邮箱验证状态…",
  "Verifying your email…": "正在验证邮箱…",
  "Verification link unavailable": "验证链接不可用",
  "Moss sent a verification link": "Moss 已发送验证链接",
  ". Open it on this device, then return to sign in.": "。请在此设备上打开链接，然后返回登录。",
  "Verify your email": "验证邮箱",
  "Open the link we sent to finish signing in.": "打开我们发送的链接以完成登录。",
  "Return to sign in": "返回登录",
  "Invalid account link": "账号链接无效",
  "This sign-in link is incomplete.": "此登录链接不完整。",
  "Account link unavailable": "账号链接不可用",
  "Account link rejected": "账号链接已被拒绝",
  "This link can’t be verified. Request a new one.": "无法验证此链接，请重新请求。",
  "Completing the email link…": "正在处理邮件链接…",
  "Signing you in": "正在为你登录",
  "Checking the password reset link…": "正在检查密码重置链接…",
  "Invalid password reset link": "密码重置链接无效",
  "Request a new link from the forgot-password page.": "请从“忘记密码”页面重新请求链接。",
  "Opening your secure password reset…": "正在打开安全的密码重置页面…",
  "Password reset link unavailable": "密码重置链接不可用",
  "Choose a new password": "设置新密码",
  "Request a new link": "重新请求链接",
  "Back to Moss chats": "返回 Moss 对话",
  Settings: "设置",
  "Loading your Moss account…": "正在加载 Moss 账号…",
  "Your accounts": "你的账号",
  Verified: "已验证",
  "Verification needed": "需要验证",
  "GPT‑5.6 ready": "GPT‑5.6 已就绪",
  "Signed in": "已登录",
  "Choose a saved account or add another one.": "选择已保存的账号，或添加另一个账号。",
  "Account action failed": "账号操作失败",
  "Saved accounts": "已保存的账号",
  "Switch without signing out.": "无需退出即可切换。",
  "Add account": "添加账号",
  "No saved Moss accounts.": "没有已保存的 Moss 账号。",
  Current: "当前",
  Ready: "就绪",
  "Sign in again": "重新登录",
  "Switching…": "正在切换…",
  Use: "使用",
  "Removing…": "正在移除…",
  Remove: "移除",
  "Signing out…": "正在退出…",
  "Sign out": "退出登录",
  Unknown: "未知",

  // Moss phone account and API users/keys.
  Never: "从未",
  "Default API user": "默认 API 用户",
  "Default key": "默认 key",
  "Signed in with your phone number. Provider account bindings stay in settings.":
    "已使用手机号登录。服务商账号绑定仍在设置中管理。",
  "Sign in with a phone verification code to use Moss account services.":
    "使用手机验证码登录，即可使用 Moss 账号服务。",
  "Signed out": "未登录",
  "Aliyun SMS configured": "已配置阿里云短信",
  "Development SMS active": "开发短信模式已启用",
  "Log out": "退出登录",
  "Send code": "发送验证码",
  "Verification code": "验证码",
  "Code expires at": "验证码有效期至",
  "API users": "API 用户",
  "Create API user": "创建 API 用户",
  "API users are for programmatic Moss access, separate from the signed-in phone account.":
    "API 用户用于以编程方式访问 Moss，与已登录的手机号账号相互独立。",
  Create: "创建",
  active: "有效",
  revoked: "已撤销",
  Revoke: "撤销",
  "API keys": "API key",
  "Create API key": "创建 API key",
  "The key secret is shown once. Existing keys are stored only as hashes.":
    "key 密钥仅显示一次；已有 key 仅以哈希形式存储。",
  "Create key": "创建 key",

  // Provider-account setup and isolated provider profiles.
  "Model accounts": "模型账号",
  "Connect the model accounts you want to use in Moss.": "连接你想在 Moss 中使用的模型账号。",
  "Sign in to Moss and start chatting right away. No setup or API key needed.":
    "登录 Moss 后即可直接对话，不需要配置，也不需要 API key。",
  "Moss sign-in is not configured or temporarily unavailable. Open sign-in to see available options.":
    "Moss 登录服务尚未配置或暂不可用，可打开登录页查看可用登录方式。",
  "Ready to use with your Moss account.": "Moss 账号已可直接使用。",
  "Your account is signed in, but Moss models are temporarily unavailable.":
    "账号已登录，但 Moss 模型目前暂不可用。",
  "Connect your ChatGPT or Codex account. Authorization opens in your browser.":
    "连接你的 ChatGPT 或 Codex 账号。授权页面会在浏览器中打开。",
  "Connect your Claude account. Authorization opens in your browser.":
    "连接你的 Claude 账号。授权页面会在浏览器中打开。",
  "Built-in Codex. Sign in to Moss to use it—no local installation required.":
    "内置 Codex。登录 Moss 后即可使用，无需本地安装。",
  "Built-in Claude Code. Sign in to Moss to use it—no local installation required.":
    "内置 Claude Code。登录 Moss 后即可使用，无需本地安装。",
  Connected: "已连接",
  "Temporarily unavailable": "暂不可用",
  Connect: "连接",
  "Cancel authorization": "取消授权",
  "Complete sign-in in your browser.": "请在浏览器中完成登录。",
  "Not checked yet": "尚未检查",
  "Sign in required": "需要登录",
  Unavailable: "不可用",
  Authenticated: "已通过身份验证",
  "Status unknown": "状态未知",
  "Sign-in cancelled": "已取消登录",
  "Unable to sign in": "无法登录",
  "Cancel sign-in": "取消登录",
  "Sign in with ChatGPT": "使用 ChatGPT 登录",
  "Sign in with Claude": "使用 Claude 登录",
  "Codex accounts": "Codex 账号",
  "Claude accounts": "Claude 账号",
  "Provider profiles": "服务商配置",
  "Add separate Codex accounts with their own home or shadow auth home.":
    "添加独立的 Codex 账号，并为每个账号设置自己的主目录或隔离身份验证主目录。",
  "Add separate Claude accounts with their own HOME directory.":
    "添加独立的 Claude 账号，并为每个账号设置自己的 HOME 目录。",
  "Add launch profiles for separate external servers or local runtime settings.":
    "为不同的外部服务器或本地运行时设置添加启动配置。",
  "Add Pi launch profiles. Use separate agent directories for separate Pi state.":
    "添加 Pi 启动配置。使用不同的智能体目录来隔离 Pi 状态。",
  "Add launch profiles for this provider. Account isolation depends on the provider CLI and configured paths.":
    "为此服务商添加启动配置。账号隔离取决于服务商 CLI 和已配置的路径。",
  Label: "标签",
  Work: "工作",
  "Binary path": "二进制路径",
  "API endpoint": "API 端点",
  "Server URL": "服务器 URL",
  "Server password": "服务器密码",
  "Secret saved — type to replace": "密钥已保存 — 输入新值即可替换",
  Clear: "清除",
  "Agent directory": "智能体目录",
  "Shadow auth home": "隔离身份验证主目录",
  "Experimental WebSockets": "实验性 WebSocket",
  "Claude HOME path": "Claude HOME 路径",
  "Unsupported driver": "不支持的驱动",
  Install: "安装",
  Update: "更新",
  Config: "配置",
  Headless: "无界面模式",
  Quickstart: "快速开始",
  "Cursor Agent or Cursor CLI path": "Cursor Agent 或 Cursor CLI 路径",
  "Optional custom Codex home and config directory.": "可选的自定义 Codex 主目录和配置目录。",
  "Optional HOME directory for this Claude account.": "此 Claude 账号的可选 HOME 目录。",
  "Optional Cursor API endpoint override passed to `cursor-agent -e`.":
    "传递给 `cursor-agent -e` 的可选 Cursor API 端点覆盖值。",
  "Optional custom Pi agent directory for auth, models, skills, and commands.":
    "用于身份验证、模型、技能和命令的可选自定义 Pi 智能体目录。",
  "Use Opencode's experimental OpenAI response WebSocket transport for managed local servers.":
    "为托管的本地服务器使用 OpenCode 实验性 OpenAI 响应 WebSocket 传输。",

  // Environment variables and skills.
  "Saved secrets keep their name. Remove the variable and add it again to rename it.":
    "已保存的密钥会保留变量名。如需重命名，请先移除变量再重新添加。",
  "Environment variables": "环境变量",
  "Applied only to this instance's processes. Mark credentials as secret to store them redacted on the server.":
    "仅应用于此实例的进程。将凭据标记为密钥后，服务器会以脱敏形式存储。",
  "Applied only to this instance&apos;s processes. Mark credentials as secret to store them redacted on the server.":
    "仅应用于此实例的进程。将凭据标记为密钥后，服务器会以脱敏形式存储。",
  value: "值",
  "Store new variable as a secret": "将新变量存为密钥",
  Add: "添加",
  "Portable skills": "可移植技能",
  "Moss skills folder": "Moss 技能文件夹",
  "Skills placed here are available on every provider. When a provider already ships its own copy of a skill, that copy is used; otherwise Moss's copy is the fallback.":
    "放在此处的技能可供所有服务商使用。若服务商已自带同名技能，则优先使用服务商副本；否则回退使用 Moss 副本。",
  "Scanning…": "正在扫描…",
  Skills: "技能",
  "Skill discovery failed": "技能发现失败",
  "Moss could not scan the skill folders. Retry after checking that the server is running.":
    "Moss 无法扫描技能文件夹。请确认服务器正在运行后重试。",
  "No skills found": "未找到技能",
  "Add a skill folder containing a SKILL.md to the Moss skills folder above, or install skills for any supported provider.":
    "请在上方 Moss 技能文件夹中添加包含 SKILL.md 的技能文件夹，或为任一受支持的服务商安装技能。",
  "Shared (.agents)": "共享（.agents）",
  Project: "项目",
  Personal: "个人",
  "Shared skills": "共享技能",
  "No description.": "暂无描述。",

  // Profile dashboard and profile editing/share dialogs.
  "Couldn’t load your local stats.": "无法加载本地统计数据。",
  "Try again": "重试",
  Share: "分享",
  Private: "私有",
  "Private profile": "私有个人资料",
  Edit: "编辑",
  "Profile statistics": "个人资料统计",
  "tokens activity": "Token 活动",
  "Token activity": "Token 活动",
  Cumulative: "累计",
  "Lifetime tokens": "累计 Token 数",
  "lifetime tokens": "累计 Token 数",
  "Peak tokens": "峰值 Token 数",
  "Peak day": "峰值日",
  "peak day": "峰值日",
  "Total prompts": "提示词总数",
  "Total chats": "对话总数",
  "Current streak": "当前连续天数",
  "current streak": "当前连续天数",
  "Longest streak": "最长连续天数",
  "longest streak": "最长连续天数",
  Activity: "活动",
  "Activity insights": "活动洞察",
  "Most used provider": "最常用服务商",
  "Most used reasoning": "最常用推理强度",
  "Most active hour": "最活跃时段",
  "Most worked project": "投入最多的项目",
  "Skills explored": "探索过的技能",
  "Total skills used": "使用过的技能总数",
  "Total threads": "对话总数",
  "Most used plugins": "最常用插件",
  "No skills or agents used yet.": "尚未使用技能或智能体。",
  runs: "次运行",
  "Model usage": "模型用量",
  "No model activity yet.": "尚无模型活动。",
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
  "Could not read the selected file.": "无法读取所选文件。",
  "That file isn't a readable image.": "该文件不是可读取的图像。",
  "Please choose an image file.": "请选择图像文件。",
  "That image has no pixels.": "该图像没有有效像素。",
  "Image compression isn't supported in this browser.": "此浏览器不支持图像压缩。",
  "That image is too large even after compression.": "该图像压缩后仍然过大。",
  "Could not process that image.": "无法处理该图像。",
  "Edit profile": "编辑个人资料",
  "Edit avatar": "编辑头像",
  "Processing…": "处理中…",
  "Replace photo": "替换照片",
  "Upload photo": "上传照片",
  "Colors apply when no photo is set.": "未设置照片时使用所选颜色。",
  "Display name": "显示名称",
  "Your name": "你的姓名",
  Username: "用户名",
  username: "用户名",
  Cancel: "取消",
  Save: "保存",
  "top provider": "最常用服务商",
  "Share your activity": "分享你的活动",
  Copy: "复制",
  "Copy stat card": "复制统计卡片",
  "Save stat card": "保存统计卡片",
  "Saved PNG to your downloads.": "PNG 已保存到下载文件夹。",
  "Could not render the image.": "无法生成图像。",
  "Copied image to clipboard.": "已将图像复制到剪贴板。",
  "Image copy unavailable. Use Save instead.": "无法复制图像，请改用“保存”。",
  "Image copied to clipboard — paste it into your post.": "图像已复制到剪贴板，请粘贴到帖子中。",
  "Composer opened. Use Save to attach the image.": "已打开发布编辑器，请使用“保存”附加图像。",
  "Composer opened. Image copy unavailable; use Save to attach.":
    "已打开发布编辑器，但无法复制图像；请使用“保存”附加图像。",

  // Keyboard shortcuts.
  "Search shortcuts...": "搜索快捷键…",
  "Search shortcuts": "搜索快捷键",
  Command: "命令",
  Keybinding: "按键绑定",
  "No shortcuts match “": "没有匹配“",
  "No shortcuts match &ldquo;": "没有匹配“",
  "”.": "”的快捷键。",
  "&rdquo;.": "”的快捷键。",

  // Usage cards and known rate-limit formatter output.
  Usage: "用量",
  "Remaining usage for Moss and connected model accounts.":
    "查看 Moss 和已连接模型账号的剩余用量。",
  Refresh: "刷新",
  "Loading connected account usage…": "正在加载已连接账号的用量…",
  "Connected Codex, Claude, Cursor, or Gemini accounts will appear here.":
    "已连接的 Codex、Claude、Cursor 或 Gemini 账号会显示在这里。",
  "Only connected model accounts are shown. Moss shows connection status only; no quota is estimated.":
    "这里只显示已连接的模型账号。Moss 仅显示连接状态，不会估算额度。",
  Available: "可用",
  Checking: "正在检查",
  Unsupported: "不支持",
  "No usage data is available to display yet.": "当前暂无可显示的用量数据。",
  "Sign in to this model account to view its usage.": "登录此模型账号后即可查看用量。",
  "This model account does not provide usage data.": "此模型账号不提供用量数据。",
  "Usage is temporarily unavailable. Try refreshing in a moment.": "暂时无法读取用量，请稍后刷新。",
  "Checking your Moss account…": "正在检查你的 Moss 账号…",
  "Moss is connected and ready to use. No quota data is available to display yet.":
    "Moss 已连接，可直接使用。当前暂无可显示的额度数据。",
  "Sign in to Moss to use the included models.": "登录 Moss 后即可使用内置模型。",
  "Moss model service is temporarily unavailable. Try again shortly.":
    "Moss 模型服务暂时不可用，请稍后再试。",
  "Rate limits remaining": "剩余额度",
  "5h": "5 小时",
  Weekly: "每周",
  "Resets soon": "即将重置",
  "Lasts until reset": "可用至重置",
  "Limit reached": "已达到额度上限",

  // General settings, appearance, and theme skin/editor.
  Compact: "紧凑",
  Comfortable: "舒适",
  Spacious: "宽松",
  "Tighter spacing in the sidebar, composer, and settings rows.":
    "侧边栏、编辑器和设置行采用更紧凑的间距。",
  "Balanced spacing for everyday use.": "适合日常使用的均衡间距。",
  "More breathing room across the main workspace surfaces.": "主工作区界面使用更宽松的间距。",
  Light: "浅色",
  Dark: "深色",
  System: "系统",
  "Always use the light theme.": "始终使用浅色主题。",
  "Always use the dark theme.": "始终使用深色主题。",
  "Match your OS appearance setting.": "跟随操作系统外观设置。",
  "Open by default": "默认打开",
  "Open the chat Environment panel automatically on normal threads. When off, the panel stays closed until you open it. Your last open/close also updates this preference.":
    "在普通对话中自动打开环境面板。关闭后，面板会保持关闭，直到你手动打开；最近一次打开或关闭也会更新此偏好。",
  "Use default UI font": "使用默认界面字体",
  "Ignore the theme's custom UI font and use Moss's default interface font (Inter, with your system's Chinese, Japanese and Korean fonts).":
    "忽略主题的自定义界面字体，改用 Moss 默认界面字体（Inter，中日韩文字使用系统字体）。",
  "Theme editor": "主题编辑器",
  "Color wheel": "色轮",
  "Toggle gradient mode": "切换渐变模式",
  "Apply solid": "应用纯色",
  "Apply gradient": "应用渐变",
  "Adjust saturation": "调整饱和度",
  "Randomize theme": "随机生成主题",
  "Surprise me": "给我惊喜",
  "Theme presets": "主题预设",
  "Theme controls": "主题控件",
  "Pattern opacity": "图案不透明度",
  "Edit theme skin": "编辑主题皮肤",

  // Per-workspace terminal layouts.
  "Workspace settings": "工作区设置",
  "Choose how terminals are arranged inside": "选择终端在以下工作区内的排列方式：",
  "Layout preset": "布局预设",
  "Changes apply immediately to this workspace. Extra terminals stay available as tabs.":
    "更改会立即应用到此工作区；其他终端仍可作为标签页使用。",
  Single: "单窗格",
  "One focused terminal.": "一个专注终端。",
  "Two Columns": "双列",
  "Two terminals side by side.": "两个终端并排显示。",
  "Two Rows": "双行",
  "Two terminals stacked vertically.": "两个终端上下排列。",
  "Top + Bottom": "上主下双",
  "One large terminal above two smaller panes.": "上方一个大终端，下方两个小窗格。",
  "Left + Stack": "左主右双",
  "One large pane on the left and two stacked on the right.":
    "左侧一个大窗格，右侧两个上下排列的窗格。",
  Quad: "四宫格",
  "Four equally visible terminals.": "四个终端等分显示。",
};

const PROVIDER_NAME =
  "(?:Codex|Claude|Cursor|Gemini|Antigravity|Grok|Droid|Kilo|OpenCode|Pi|Kimi Code|MiniMax Code|ZCode)";
const THEME_TITLE = "(?:Light theme|Dark theme|浅色主题|深色主题)";

function capture(match: RegExpExecArray, index: number): string {
  return match[index] ?? "";
}

function translatedThemeTitle(value: string): string {
  if (value === "Light theme" || value === "浅色主题") return "浅色主题";
  return "深色主题";
}

function translatedThemeControl(value: string): string {
  const controls: Readonly<Record<string, string>> = {
    "accent color": "强调色",
    "background color": "背景色",
    "foreground color": "前景色",
    "UI font": "界面字体",
    "code font": "代码字体",
    "translucent sidebar": "半透明侧边栏",
    contrast: "对比度",
  };
  return controls[value] ?? value;
}

function translatedPattern(value: string): string {
  const patterns: Readonly<Record<string, string>> = {
    none: "无",
    stripe: "条纹",
    liquid: "液态",
    warp: "扭曲",
    noise: "噪点",
    starlight: "星光",
    dots: "点阵",
    "dots-2": "双点阵",
    define: "轮廓",
  };
  return patterns[value] ?? value;
}

function translatedCompactDuration(value: string): string {
  return value
    .replace(/(\d+)d\b/g, "$1 天")
    .replace(/(\d+)h\b/g, "$1 小时")
    .replace(/(\d+)m\b/g, "$1 分钟")
    .replace(/^<1 分钟$/, "不足 1 分钟");
}

const DYNAMIC_TRANSLATIONS: ReadonlyArray<DynamicTranslation> = [
  // Account counts, fields, emails, and sessions. Email slots are retained verbatim.
  [/^(\d+) saved accounts?$/, (match) => `已保存 ${capture(match, 1)} 个账号`],
  [/^Email: ([^\s@]+@[^\s@]+\.[^\s@]+)$/, (match) => `邮箱：${capture(match, 1)}`],
  [
    /^Change email from ([^\s@]+@[^\s@]+\.[^\s@]+)$/,
    (match) => `更改邮箱（当前为 ${capture(match, 1)}）`,
  ],
  [/^Use at least (\d+) characters\.$/, (match) => `请至少输入 ${capture(match, 1)} 个字符。`],
  [/^Use no more than (\d+) characters\.$/, (match) => `请勿超过 ${capture(match, 1)} 个字符。`],
  [/^to ([^\s@]+@[^\s@]+\.[^\s@]+)$/, (match) => `至 ${capture(match, 1)}`],
  [/^Use ([^\s@]+@[^\s@]+\.[^\s@]+)$/, (match) => `使用 ${capture(match, 1)}`],
  [/^Remove ([^\s@]+@[^\s@]+\.[^\s@]+)$/, (match) => `移除 ${capture(match, 1)}`],
  [/^Session expires (.+)$/, (match) => `会话有效期至 ${capture(match, 1)}`],

  // API user/key metadata retains role, prefix, and locale-formatted dates.
  [
    /^(.+?) · (\d+) active keys? · created (.+)$/,
    (match) =>
      `${capture(match, 1)} · ${capture(match, 2)} 个有效 key · 创建于 ${capture(match, 3)}`,
  ],
  [
    /^(.+?)\.\.\. · created (.+?) · last used (.+)$/,
    (match) =>
      `${capture(match, 1)}... · 创建于 ${capture(match, 2)} · 最近使用于 ${capture(match, 3)}`,
  ],

  // Provider profiles and environment-variable controls retain generated names/IDs.
  [/^Stopped sign-in for (.+)\.$/, (match) => `已停止 ${capture(match, 1)} 的登录。`],
  [
    /^Clear saved server password for (.+)$/,
    (match) => `清除为 ${capture(match, 1)} 保存的服务器密码`,
  ],
  [
    /^Enable experimental WebSockets for (.+)$/,
    (match) => `为 ${capture(match, 1)} 启用实验性 WebSocket`,
  ],
  [new RegExp(`^(${PROVIDER_NAME}) binary path$`), (match) => `${capture(match, 1)} 二进制路径`],
  [new RegExp(`^(${PROVIDER_NAME}) server URL$`), (match) => `${capture(match, 1)} 服务器 URL`],
  [
    new RegExp(`^(${PROVIDER_NAME}) server password$`),
    (match) => `${capture(match, 1)} 服务器密码`,
  ],
  [
    new RegExp(
      `^Optional existing (${PROVIDER_NAME}) server URL\\. Leave blank to spawn a local server\\.$`,
    ),
    (match) => `可填写现有 ${capture(match, 1)} 服务器 URL；留空则启动本地服务器。`,
  ],
  [
    new RegExp(`^Optional password for an externally managed (${PROVIDER_NAME}) server\\.$`),
    (match) => `外部管理的 ${capture(match, 1)} 服务器可选密码。`,
  ],
  [/^Store ([A-Za-z_][A-Za-z0-9_]*) as a secret$/, (match) => `将 ${capture(match, 1)} 存为密钥`],
  [/^Remove ([A-Za-z_][A-Za-z0-9_]*)$/, (match) => `移除 ${capture(match, 1)}`],

  // Skills retain provider and skill display names.
  [
    new RegExp(`^Provider (?:copy|copies): (${PROVIDER_NAME}(?:, ${PROVIDER_NAME})*)$`),
    (match) => `服务商副本：${capture(match, 1)}`,
  ],
  [
    /^(\d+) of (\d+) skills? enabled$/,
    (match) => `已启用 ${capture(match, 1)} / ${capture(match, 2)} 个技能`,
  ],
  [/^Enable the (.+) skill$/, (match) => `启用 ${capture(match, 1)} 技能`],
  // Short labels only: a whole sentence must not come out half translated.
  [/^Enable ([^.]+)$/, (match) => `启用 ${capture(match, 1)}`],
  [/^From (.+)$/, (match) => `来自 ${capture(match, 1)}`],

  // Profile values retain project names, counts, dates, models, and provider labels.
  [/^([\d,]+) runs$/, (match) => `${capture(match, 1)} 次运行`],
  [/^(.+) · ([\d,]+) prompts?$/, (match) => `${capture(match, 1)} · ${capture(match, 2)} 条提示词`],
  [/^([\d,]+) days?$/, (match) => `${capture(match, 1)} 天`],
  [/^12 AM$/, () => "上午 12:00"],
  [/^12 PM$/, () => "中午 12:00"],
  [/^(\d{1,2}) AM$/, (match) => `上午 ${capture(match, 1)}:00`],
  [/^(\d{1,2}) PM$/, (match) => `下午 ${capture(match, 1)}:00`],
  [
    /^No (tokens?|prompts?) on (.+)$/,
    (match) =>
      `${capture(match, 2)}：无${capture(match, 1).startsWith("token") ? " token" : "提示词"}`,
  ],
  [
    /^([\d.,]+(?:bn|[km])?) (tokens?|prompts?) on (.+)$/,
    (match) =>
      `${capture(match, 3)}：${capture(match, 1)}${
        capture(match, 2).startsWith("token") ? " 个 token" : " 条提示词"
      }`,
  ],
  [/^Use (#[0-9a-fA-F]{6})$/, (match) => `使用颜色 ${capture(match, 1)}`],
  [/^Share to (X|LinkedIn|Reddit)$/, (match) => `分享到 ${capture(match, 1)}`],

  // Provider usage/rate-limit formatter output. Values and reset durations are retained.
  [/^(\d+)% left$/, (match) => `剩余 ${capture(match, 1)}%`],
  [
    /^(5h|Weekly|Current|Sonnet|Opus) remaining$/,
    (match) => {
      const label = capture(match, 1);
      const translated =
        label === "5h"
          ? "5 小时"
          : label === "Weekly"
            ? "每周"
            : label === "Current"
              ? "当前"
              : label;
      return `${translated}剩余额度`;
    },
  ],
  [
    /^Resets in ((?:\d+d )?(?:\d+h )?\d+m|\d+d \d+h|\d+h \d+m)$/,
    (match) => `将在 ${translatedCompactDuration(capture(match, 1))}后重置`,
  ],
  [
    /^(\d+)% in (deficit|reserve)$/,
    (match) =>
      capture(match, 2) === "deficit"
        ? `超出预期 ${capture(match, 1)}%`
        : `保留余量 ${capture(match, 1)}%`,
  ],
  [
    /^Runs out in ((?:\d+d )?(?:\d+h )?\d+m|\d+d \d+h|\d+h \d+m|<1m)$/,
    (match) => `预计 ${translatedCompactDuration(capture(match, 1))}后用尽`,
  ],
  [
    /^Usage pace: (ahead|on-track|behind)$/,
    (match) => {
      const labels = { ahead: "充足", "on-track": "符合预期", behind: "超出预期" } as const;
      return `用量进度：${labels[capture(match, 1) as keyof typeof labels]}`;
    },
  ],

  // Theme-editor attributes combine an already-localized title with static English suffixes.
  [
    new RegExp(`^(${THEME_TITLE}) code theme$`),
    (match) => `${translatedThemeTitle(capture(match, 1)).replace(/主题$/, "")}代码主题`,
  ],
  [
    new RegExp(
      `^(${THEME_TITLE}) (accent color|background color|foreground color|UI font|code font|translucent sidebar|contrast)$`,
    ),
    (match) =>
      `${translatedThemeTitle(capture(match, 1))}${translatedThemeControl(capture(match, 2))}`,
  ],
  [
    new RegExp(
      `^Reset (${THEME_TITLE}) (accent color|background color|foreground color|UI font|code font|translucent sidebar|contrast)$`,
    ),
    (match) =>
      `重置${translatedThemeTitle(capture(match, 1))}${translatedThemeControl(capture(match, 2))}`,
  ],
  [
    new RegExp(`^(${THEME_TITLE}) (accent color|background color|foreground color) hex value$`),
    (match) =>
      `${translatedThemeTitle(capture(match, 1))}${translatedThemeControl(capture(match, 2))}十六进制值`,
  ],
  [
    /^Select next texture\. Current texture: (none|stripe|liquid|warp|noise|starlight|dots|dots-2|define)$/,
    (match) => `选择下一个纹理。当前纹理：${translatedPattern(capture(match, 1))}`,
  ],

  // Workspace layout count retains the numeric slot count.
  [/^(\d+) panes?$/, (match) => `${capture(match, 1)} 个窗格`],
];

export function translateZhCnAccountSettingsText(value: string): string {
  const exact = EXACT_TRANSLATIONS[value];
  if (exact !== undefined) return exact;

  for (const [pattern, translate] of DYNAMIC_TRANSLATIONS) {
    const match = pattern.exec(value);
    if (match) return translate(match);
  }

  return value;
}
