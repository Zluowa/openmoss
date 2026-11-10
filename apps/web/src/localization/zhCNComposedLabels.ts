// FILE: zhCNComposedLabels.ts
// Purpose: Simplified Chinese for labels assembled around another label, mostly the hidden
//          accessible names of settings and sidebar controls. The inner label goes back through
//          the full chain, so "Set a shortcut for Jump to file" reads as one Chinese sentence.
// Layer: Pure localization rules
// Runs before the feature translators: a word-level rule such as `Show <name>` would otherwise
// claim the whole string and leave the English sentence inside it.

import { lookupPhrase } from "./zhCNPhraseTable";

type Translate = (value: string) => string;
type ComposedRule = readonly [
  pattern: RegExp,
  compose: (slots: readonly string[], translate: Translate) => string,
];

const THEME_VARIANT: Readonly<Record<string, string>> = { light: "浅色", dark: "深色" };

function themeVariant(value: string): string {
  return lookupPhrase(THEME_VARIANT, value) ?? value;
}

// `fixedShortcuts.ts` reasons, which `keybindingEditor.ts` prefixes with the pressed keys.
const FIXED_SHORTCUT_REASONS: Readonly<Record<string, string>> = {
  "is reserved for Copy": "已保留给“复制”",
  "is reserved for Paste": "已保留给“粘贴”",
  "is reserved for Cut": "已保留给“剪切”",
  "is reserved for Select All": "已保留给“全选”",
  "is reserved for Undo": "已保留给“撤销”",
  "is reserved for Redo": "已保留给“重做”",
  "moves to the start of a line": "用于移到行首",
  "moves to the end of a line": "用于移到行尾",
  "moves to the start of a field": "用于移到输入框开头",
  "moves to the end of a field": "用于移到输入框末尾",
  "deletes to the start of a line": "用于删除到行首",
  "moves back one word": "用于后退一个单词",
  "moves forward one word": "用于前进一个单词",
  "deletes the previous word": "用于删除上一个单词",
  "is reserved by macOS for Quit": "已被 macOS 保留用于“退出”",
  "is reserved by macOS for Hide": "已被 macOS 保留用于“隐藏”",
  "is reserved by macOS for Minimize": "已被 macOS 保留用于“最小化”",
  "always opens Settings": "固定用于打开设置",
  "always opens the keybindings sheet": "固定用于打开按键绑定列表",
  "always goes back in the desktop app": "固定用于在桌面应用中后退",
  "always goes forward in the desktop app": "固定用于在桌面应用中前进",
  "searches the terminal while it has focus": "在终端获得焦点时用于搜索终端",
};

// `capabilitySummary` in `ComputerSettingsPanel.tsx` joins these into one comma-separated line.
const COMPUTER_CAPABILITIES: Readonly<Record<string, string>> = {
  "screen capture": "屏幕截图",
  input: "输入",
  "window listing": "窗口列表",
  "window geometry": "窗口位置与大小",
  "stacking order": "窗口层级",
  "keyboard focus": "键盘焦点",
  "window raising": "窗口置顶",
  clipboard: "剪贴板",
  "ghost cursor": "虚拟光标",
};
const COMPUTER_CAPABILITY = Object.keys(COMPUTER_CAPABILITIES).join("|");
// A capability can stand alone in the summary; "input" and "clipboard" are too plain to match there.
const COMPUTER_CAPABILITY_PHRASE = Object.keys(COMPUTER_CAPABILITIES)
  .filter((capability) => capability.includes(" "))
  .join("|");

// `formatRelativeTime` writes these short units; "5m ago" reads 5 分钟前.
const RELATIVE_UNITS: Readonly<Record<string, string>> = {
  m: "分钟",
  h: "小时",
  d: "天",
  w: "周",
  mo: "个月",
  y: "年",
};

function relativeSpan(count: string, unit: string): string {
  return `${count} ${lookupPhrase(RELATIVE_UNITS, unit) ?? unit}`;
}

function subagentMeta(meta: string): string {
  return meta
    .split(" · ")
    .map((part) =>
      part === "background" ? "后台" : part.replace(/^(\d+) tool calls?$/, "$1 次工具调用"),
    )
    .join(" · ");
}

const TASK_COUNT_PARTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(\d+) (?:thing needs|things need) you$/, "$1 件事需要你处理"],
  [/^(\d+) working$/, "$1 个进行中"],
  [/^(\d+) to do$/, "$1 个待办"],
];

const CHECK_COUNT_PARTS: Readonly<Record<string, string>> = {
  failing: "失败",
  pending: "进行中",
  successful: "成功",
};

const COMPOSED_RULES: ReadonlyArray<ComposedRule> = [
  // Tasks
  [
    /^Due (Today|Tomorrow|Yesterday|Mon|Tue|Wed|Thu|Fri|Sat|Sun|周[一二三四五六日]|[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?|(?:\d{4}年)?\d{1,2}月\d{1,2}日)$/,
    ([when = ""], t) => `截止：${t(when)}`,
  ],
  [
    /^(Mark as done|Mark as not done): (.+) \((.+)\)$/,
    ([action = "", title = "", status = ""], t) => `${t(action)}：${title}（${t(status)}）`,
  ],
  [/^Priority: (.+)$/, ([label = ""], t) => `优先级：${t(label)}`],
  [/^Project: (.+)$/, ([name = ""]) => `项目：${name}`],
  [
    /^(\d+ (?:thing needs|things need) you|\d+ working|\d+ to do)((?: · \d+ (?:working|to do))*)$/,
    ([first = "", rest = ""]) =>
      [first, ...rest.split(" · ").filter(Boolean)]
        .map((part) => {
          const rule = TASK_COUNT_PARTS.find(([pattern]) => pattern.test(part));
          return rule ? part.replace(rule[0], rule[1]) : part;
        })
        .join(" · "),
  ],
  [
    /^Working · (\d+)(m|h|d|w|mo|y)$/,
    ([count = "", unit = ""]) => `工作中 · ${relativeSpan(count, unit)}`,
  ],
  [
    /^(Finished|Plan ready) (\d+)(m|h|d|w|mo|y) ago$/,
    ([detail = "", count = "", unit = ""], t) => `${t(detail)} · ${relativeSpan(count, unit)}前`,
  ],
  [/^(Finished|Plan ready) just now$/, ([detail = ""], t) => `${t(detail)} · 刚刚`],

  // Code review
  [
    /^#(\d+) (PR open|PR closed|PR merged|PR draft|PR has conflicts): (.+)$/,
    ([number = "", state = "", title = ""], t) => `#${number} ${t(state)}：${title}`,
  ],
  [/^(All|Pull requests|Issues), (\d+)$/, ([label = "", count = ""], t) => `${t(label)}，${count}`],
  [/^Remove filter: (.+)$/, ([label = ""], t) => `移除筛选条件：${t(label)}`],
  [/^Sort: (.+)$/, ([label = ""], t) => `排序：${t(label)}`],
  [/^State: (.+)\. Change state$/, ([state = ""], t) => `状态：${t(state)}。更改状态`],
  [/^(\d+)(m|h|d|w|mo|y) ago$/, ([count = "", unit = ""]) => `${relativeSpan(count, unit)}前`],
  [
    /^(\d+ (?:failing|pending|successful)(?:, \d+ (?:failing|pending|successful))*)$/,
    ([list = ""]) =>
      list
        .split(", ")
        .map((part) => {
          const [count = "", state = ""] = part.split(" ");
          return `${count} 项${lookupPhrase(CHECK_COUNT_PARTS, state) ?? state}`;
        })
        .join("，"),
  ],

  // Previews
  [
    /^(.+), cell (\d+) of (\d+)$/,
    ([title = "", index = "", total = ""], t) =>
      `${t(title)}，第 ${index} 个单元格（共 ${total} 个）`,
  ],

  // Automations
  [/^Next run (.+)$/, ([when = ""], t) => `下次运行 ${t(when)}`],

  // Simulators
  [
    /^(.+) · (Shut down|Booting|Booted|Shutting down)$/,
    ([runtime = "", state = ""], t) => `${runtime} · ${t(state)}`,
  ],

  // Computer control
  [
    new RegExp(`^((?:${COMPUTER_CAPABILITY})(?:, (?:${COMPUTER_CAPABILITY}))+)$`),
    ([list = ""]) =>
      list
        .split(", ")
        .map((capability) => lookupPhrase(COMPUTER_CAPABILITIES, capability) ?? capability)
        .join("、"),
  ],
  [
    new RegExp(`^(${COMPUTER_CAPABILITY_PHRASE})$`),
    ([capability = ""]) => COMPUTER_CAPABILITIES[capability] ?? capability,
  ],
  [
    /^This server is running on (\S+)\. Computer control needs macOS, or a Wayland desktop on Linux — KWin or Hyprland, or Moss's own nested desktop\.$/,
    ([platform = ""]) =>
      `这台服务器运行在 ${platform} 上。电脑控制需要 macOS，或 Linux 上的 Wayland 桌面（KWin、Hyprland 或 Moss 自带的嵌套桌面）。`,
  ],
  [/^(Fill|Rim) color$/, ([part = ""]) => `${part === "Fill" ? "填充" : "描边"}颜色`],

  // Keyboard shortcut editor
  [
    /^Change the shortcut (.+) for (.+)$/,
    ([keys = "", label = ""], t) => `更改“${t(label)}”的快捷键 ${keys}`,
  ],
  [/^Add another shortcut for (.+)$/, ([label = ""], t) => `为“${t(label)}”添加另一个快捷键`],
  [
    /^Remove the shortcut (.+) from (.+)$/,
    ([keys = "", label = ""], t) => `移除“${t(label)}”的快捷键 ${keys}`,
  ],
  [/^Set a shortcut for (.+)$/, ([label = ""], t) => `为“${t(label)}”设置快捷键`],
  [
    /^(\S+) already runs (.+)\. Saving moves it here\.$/,
    ([keys = "", label = ""], t) => `${keys} 已用于“${t(label)}”。保存后会移到这里。`,
  ],
  [/^(\S+) is available\.$/, ([keys = ""]) => `${keys} 可用。`],
  [
    /^(\S+) is already a shortcut for this command\.$/,
    ([keys = ""]) => `${keys} 已经是这个命令的快捷键。`,
  ],
  [
    /^(\S+) already runs a project script\. Change it from the project's scripts first\.$/,
    ([keys = ""]) => `${keys} 已用于运行项目脚本。请先在项目脚本中更改。`,
  ],
  [
    /^(\S+) (.+)\. Try another\.$/,
    ([keys = "", reason = ""]) => {
      const translated = lookupPhrase(FIXED_SHORTCUT_REASONS, reason);
      return translated ? `${keys} ${translated}。请换一个。` : `${keys} ${reason}. Try another.`;
    },
  ],

  // Sidebar and picker visibility
  [/^Show the (.+) section in the sidebar$/, ([label = ""], t) => `在侧边栏显示“${t(label)}”分区`],
  [
    /^Show the (.+) section in the Environment panel$/,
    ([label = ""], t) => `在环境面板中显示“${t(label)}”分区`,
  ],
  [/^Show (.+) in the sidebar$/, ([label = ""], t) => `在侧边栏显示“${t(label)}”`],
  [/^Hide (.+) from the sidebar$/, ([label = ""], t) => `从侧边栏隐藏“${t(label)}”`],
  [/^(.+) is always shown$/, ([label = ""], t) => `“${t(label)}”始终显示`],
  [/^Show (.+) in the provider picker$/, ([label = ""]) => `在服务商选择器中显示 ${label}`],
  [/^Hide (.+) from the provider picker$/, ([label = ""]) => `从服务商选择器中隐藏 ${label}`],
  [
    /^(.+) is unavailable in the provider picker$/,
    ([label = ""]) => `${label} 在服务商选择器中不可用`,
  ],
  [
    /^Show (.+) usage at the bottom of the sidebar$/,
    ([label = ""]) => `在侧边栏底部显示 ${label} 的用量`,
  ],

  // Provider accounts
  [/^Accent color (.+) for (.+)$/, ([color = "", label = ""]) => `${label} 的强调色 ${color}`],
  // The on/off options in `ProvidersSettingsPanel.tsx`, named for the account they belong to.
  [
    /^(Artifacts, \/design and \/slides|OpenAI response WebSockets) for (.+)$/,
    ([field = "", account = ""], t) => `${account} 的 ${t(field)}`,
  ],
  [/^(.+) usage: (.+)$/, ([name = "", state = ""], t) => `${name} 用量：${t(state)}`],
  [
    /^(.+) account '(.+)' was added\.$/,
    ([name = "", label = ""]) => `已添加 ${name} 账号“${label}”。`,
  ],
  [/^(.+) account imported$/, ([name = ""]) => `已导入 ${name} 账号`],
  [
    /^Clear saved (.+) for (.+)$/,
    ([field = "", label = ""], t) => `清除 ${label} 已保存的${t(field)}`,
  ],
  [
    /^Use an existing (.+) directory as a new account, without moving it\.$/,
    ([name = ""]) => `把现有的 ${name} 目录用作新账号，不会移动它。`,
  ],
  [/^Could not update ([A-Z].*)$/, ([name = ""]) => `无法更新 ${name}`],
  [
    /^([\s\S]+)\n\nCopy the command below to update manually in a terminal\.$/,
    ([detail = ""], t) => `${t(detail)}\n\n请复制下面的命令，在终端中手动更新。`,
  ],
  [/^(.+) setup guide$/, ([name = ""]) => `${name} 设置指南`],
  [/^Checking (.+) CLI availability$/, ([name = ""]) => `正在检查 ${name} CLI 是否可用`],
  [
    /^Save additional (.+) model (?:slugs|ids) for the picker and provider runtime\.$/,
    ([name = ""]) => `保存额外的 ${name} 模型标识，用于模型选择器和服务商运行时。`,
  ],
  [
    /^Save additional (.+) model (?:slugs|ids) for the picker and `\/model` command\.$/,
    ([name = ""]) => `保存额外的 ${name} 模型标识，用于模型选择器和 \`/model\` 命令。`,
  ],
  [
    /^Model slugs must be (\d+) characters or less\.$/,
    ([max = ""]) => `模型标识不能超过 ${max} 个字符。`,
  ],

  // Chat
  [/^(.+), needs attention$/, ([label = ""], t) => `${t(label)}，需要关注`],
  [
    /^Open subagent (.+) \((.+)\)$/,
    ([name = "", status = ""], t) => `打开子智能体 ${name}（${t(status)}）`,
  ],
  [/^Open subagent (.+)$/, ([name = ""]) => `打开子智能体 ${name}`],
  [
    /^Open subagents: (.+)$/,
    ([summary = ""], t) =>
      `打开子智能体：${summary
        .split(", ")
        .map((part) => t(part))
        .join("，")}`,
  ],
  [/^(Allow|Approve|Deny) permission$/, ([action = ""], t) => `${t(action)}权限`],
  // `formatEnvironmentSubagentMeta`: "background · Bash · 1.2k tokens · 3 tool calls".
  [
    /^((?:· )?)(.*(?:^| · )(?:background|[\d.,]+[kKmMbB]? tokens|\d+ tool calls?))$/,
    ([lead = "", meta = ""]) => `${lead}${subagentMeta(meta)}`,
  ],
  [/^Handoff to (.+) in this thread$/, ([name = ""]) => `在当前对话中交接给 ${name}`],
  [/^Hide progress for (.+)$/, ([title = ""]) => `隐藏 ${title} 的进度`],
  [/^Show progress for (.+)$/, ([title = ""]) => `显示 ${title} 的进度`],

  [
    /^(.+) · (Minimal|Low|Medium|High|Extra High|Max)$/,
    ([model = "", effort = ""], t) => `${model} · ${t(effort)}`,
  ],
  [/^Hide threads in (.+)$/, ([name = ""]) => `隐藏 ${name} 中的对话`],
  [/^Show threads in (.+)$/, ([name = ""]) => `显示 ${name} 中的对话`],

  // Search palette rows, named for a rail destination
  [/^Go to (Inbox|Kanban|Automations|[一-鿿][^.]*)$/, ([label = ""], t) => `前往${t(label)}`],
  [/^Open (Inbox|Kanban|Automations|[一-鿿][^.]*)\.$/, ([label = ""], t) => `打开${t(label)}。`],

  // Sidebar, library and profile
  [
    /^Returns (.+) · (.+)$/,
    ([deadline = "", remaining = ""], t) => `恢复时间：${deadline} · ${t(remaining)}`,
  ],
  [/^Sort by (Name|Date modified)$/, ([label = ""], t) => `按${t(label)}排序`],
  [/^(\S+ (?:B|KB|MB|GB)) · now$/, ([size = ""]) => `${size} · 刚刚`],
  [
    /^(\S+ (?:B|KB|MB|GB)) · (\d+)(m|h|d|w|mo|y)$/,
    ([size = "", count = "", unit = ""]) => `${size} · ${relativeSpan(count, unit)}前`,
  ],
  [/^Last run now$/, () => "上次运行：刚刚"],
  [
    /^Last run (\d+)(m|h|d|w|mo|y)$/,
    ([count = "", unit = ""]) => `上次运行：${relativeSpan(count, unit)}前`,
  ],
  [
    /^(Verified|Verification needed) · (.+)$/,
    ([state = "", lane = ""], t) => `${t(state)} · ${t(lane)}`,
  ],

  // Permissions and storage
  [/^Open (.+) settings$/, ([name = ""], t) => `打开${t(name)}设置`],
  [
    /^([^.]+) is ready for (\S+)\.$/,
    ([pane = "", feature = ""], t) => `${t(pane)}权限已可用于${t(feature)}。`,
  ],
  [
    /^(.+) was removed and (\d+) archived conversations? were deleted\.$/,
    ([name = "", count = ""]) => `已移除 ${name}，并删除了 ${count} 个已归档的对话。`,
  ],
  [/^(.+) was removed\.$/, ([name = ""]) => `已移除 ${name}。`],
  [
    /^(\d+) archived (?:thread was|threads were) permanently removed\.$/,
    ([count = ""]) => `已永久移除 ${count} 个已归档的对话。`,
  ],

  // Theme editor
  [
    /^Inactive while the app is locked to (light|dark)\.$/,
    ([variant = ""]) => `应用锁定为${themeVariant(variant)}时不生效。`,
  ],
  [
    /^Copied the (light|dark) theme share string\.$/,
    ([variant = ""]) => `已复制${themeVariant(variant)}主题分享字符串。`,
  ],
  [
    /^Updated the (light|dark) theme pack\.$/,
    ([variant = ""]) => `已更新${themeVariant(variant)}主题包。`,
  ],

  // Shortcut sheet, profile and project scripts
  [/^Jump to space ([1-9])$/, ([slot = ""]) => `跳转到空间 ${slot}`],
  [/^(.+) setup script$/, ([name = ""]) => `${name} 设置脚本`],
  [/^Run (.+) native command$/, ([name = ""]) => `运行 ${name} 原生命令`],
  [/^Shortcut (\S+)$/, ([keys = ""]) => `快捷键 ${keys}`],
  [/^Reset (\d+)$/, ([slot = ""]) => `重置 ${slot}`],
  [/^Show more \((\d+)\)$/, ([count = ""]) => `显示更多（${count}）`],
  [/^top provider · (.+)$/, ([basis = ""], t) => `最常用服务商 · ${t(basis)}`],
  [/^Archived now$/, () => "归档于 刚刚"],
  [/^Archived (.*(?:ago|前|now|刚刚).*)$/, ([when = ""]) => `归档于 ${when}`],
  // `formatRelativeTime` leaves "ago" off, in English and in Chinese.
  [
    /^Archived (\d+)(m|h|d|w|mo|y)$/,
    ([count = "", unit = ""]) => `归档于 ${relativeSpan(count, unit)}前`,
  ],
  [/^Archived (\d+ (?:分钟|小时|天|周|个月|年))$/, ([when = ""]) => `归档于 ${when}前`],
  [/^Preview AppSnap from (.+)$/, ([name = ""]) => `预览来自 ${name} 的应用截图`],
  [/^Thread actions for (.+)$/, ([title = ""]) => `“${title}”的对话操作`],
];

export function translateZhCnComposedLabelText(value: string, translate: Translate): string {
  for (const [pattern, compose] of COMPOSED_RULES) {
    const match = pattern.exec(value);
    if (match) return compose(match.slice(1), translate);
  }
  return value;
}
