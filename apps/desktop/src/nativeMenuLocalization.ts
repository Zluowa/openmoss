// FILE: nativeMenuLocalization.ts
// Purpose: Normalizes and translates Electron application/context-menu labels without
//          coupling the translation policy to Electron or forcing a process-wide locale.
// Layer: Desktop main-process helper (pure)
// Exports: native-menu locale and label normalization/translation helpers

export type NativeMenuLocale = "en" | "zh-CN";

interface NativeMenuLabelDefinition {
  readonly en: string;
  readonly zh: string;
  readonly enAliases?: readonly string[];
  readonly zhAliases?: readonly string[];
}

const NATIVE_MENU_LABELS: readonly NativeMenuLabelDefinition[] = [
  // Moss application menu.
  { en: "Moss", zh: "Moss" },
  { en: "About Moss", zh: "关于 Moss" },
  {
    en: "Check for Updates…",
    zh: "检查更新…",
    enAliases: ["Check for Updates..."],
    zhAliases: ["检查更新..."],
  },
  {
    en: "Settings…",
    zh: "设置…",
    enAliases: ["Settings...", "Preferences…", "Preferences..."],
    zhAliases: ["设置...", "偏好设置…", "偏好设置..."],
  },
  { en: "Services", zh: "服务" },
  { en: "Hide Moss", zh: "隐藏 Moss" },
  { en: "Hide Others", zh: "隐藏其他应用" },
  { en: "Show All", zh: "显示全部" },
  { en: "Quit Moss", zh: "退出 Moss" },

  // Top-level native menus.
  { en: "File", zh: "文件" },
  { en: "Edit", zh: "编辑" },
  { en: "View", zh: "视图" },
  { en: "Window", zh: "窗口" },
  { en: "Help", zh: "帮助" },

  // Electron role-provided Edit menu items.
  { en: "Undo", zh: "撤销" },
  { en: "Redo", zh: "重做" },
  { en: "Cut", zh: "剪切" },
  { en: "Copy", zh: "复制" },
  { en: "Paste", zh: "粘贴" },
  { en: "Paste and Match Style", zh: "粘贴并匹配样式" },
  { en: "Delete", zh: "删除" },
  { en: "Select All", zh: "全选" },
  { en: "Substitutions", zh: "替换" },
  { en: "Show Substitutions", zh: "显示替换…", zhAliases: ["显示替换"] },
  { en: "Smart Quotes", zh: "智能引号" },
  { en: "Smart Dashes", zh: "智能连字符" },
  { en: "Text Replacement", zh: "文本替换" },
  { en: "Transformations", zh: "转换" },
  { en: "Make Upper Case", zh: "转为大写" },
  { en: "Make Lower Case", zh: "转为小写" },
  { en: "Capitalize", zh: "首字母大写" },
  { en: "Speech", zh: "语音" },
  { en: "Start Speaking", zh: "开始朗读" },
  { en: "Stop Speaking", zh: "停止朗读" },
  {
    en: "Start Dictation…",
    zh: "开始听写…",
    enAliases: ["Start Dictation..."],
    zhAliases: ["开始听写..."],
  },
  { en: "Emoji & Symbols", zh: "表情与符号" },

  // File, View, and Window role/custom menu items.
  { en: "Close Window", zh: "关闭窗口" },
  { en: "Minimize", zh: "最小化" },
  { en: "Zoom", zh: "缩放" },
  { en: "Bring All to Front", zh: "全部置于前台" },
  { en: "New Terminal Tab", zh: "新建终端标签页" },
  { en: "Toggle Sidebar", zh: "切换侧边栏" },
  { en: "Toggle Browser", zh: "切换浏览器" },
  { en: "Reload", zh: "重新加载" },
  { en: "Force Reload", zh: "强制重新加载" },
  { en: "Toggle Developer Tools", zh: "切换开发者工具" },
  { en: "Actual Size", zh: "实际大小" },
  { en: "Reset Zoom", zh: "重置缩放" },
  { en: "Zoom In", zh: "放大" },
  { en: "Zoom Out", zh: "缩小" },
  {
    en: "Toggle Full Screen",
    zh: "切换全屏",
    enAliases: ["Toggle Fullscreen", "Enter Full Screen", "Exit Full Screen"],
    zhAliases: ["进入全屏", "退出全屏"],
  },
  { en: "Keyboard Shortcuts", zh: "键盘快捷键" },
  { en: "Activity Monitor", zh: "活动监视器" },
  { en: "Allocations & Leaks", zh: "分配与泄漏" },
  { en: "File Activity", zh: "文件活动" },
  { en: "System Trace", zh: "系统跟踪" },
  { en: "Time Profile Active Application", zh: "分析当前应用" },
  { en: "Time Profile App Under Mouse", zh: "分析鼠标下方应用" },
  { en: "Time Profile Entire System", zh: "分析整个系统" },
  { en: "Toggle Instruments Recording", zh: "切换 Instruments 录制" },

  // Chromium edit/spelling context menu items.
  { en: "No suggestions", zh: "没有建议" },
  { en: "Copy Image", zh: "复制图像" },

  // Renderer-provided thread, terminal, file, and diff context actions.
  { en: "Rename thread", zh: "重命名", zhAliases: ["重命名对话"] },
  { en: "Pin thread", zh: "置顶", zhAliases: ["固定对话"] },
  { en: "Unpin thread", zh: "取消置顶", zhAliases: ["取消固定对话"] },
  { en: "Pin project", zh: "固定项目" },
  { en: "Unpin project", zh: "取消固定项目" },
  { en: "Pin message", zh: "固定消息" },
  { en: "Unpin message", zh: "取消固定消息" },
  { en: "Clear notification", zh: "清除通知" },
  { en: "Mark unread", zh: "标记为未读" },
  { en: "Copy Path", zh: "复制路径", enAliases: ["Copy path"] },
  { en: "Copy Thread ID", zh: "复制对话 ID" },
  { en: "Open Path in Terminal", zh: "在终端中打开路径" },
  { en: "Handoff", zh: "移交" },
  { en: "Open with", zh: "打开方式" },
  { en: "Add to chat", zh: "添加到聊天" },
  { en: "Reveal in Finder", zh: "在 Finder 中显示" },
  { en: "Open in Explorer", zh: "在资源管理器中打开" },
  { en: "Show in folder", zh: "在文件夹中显示" },
  { en: "Download a copy", zh: "下载副本" },
  { en: "Reference selection in chat", zh: "在对话中引用所选内容" },
  { en: "Reference in chat", zh: "在对话中引用" },
  { en: "Reference diff in chat", zh: "在对话中引用差异" },
  { en: "Ask why this changed", zh: "询问为何发生此更改" },
  { en: "Copy diff", zh: "复制差异" },
  { en: "Copied diff", zh: "已复制差异" },
  { en: "Restore", zh: "恢复" },
  { en: "Unarchive", zh: "取消归档" },
  { en: "Archive", zh: "归档" },
  { en: "Archive threads", zh: "归档对话" },
  { en: "Delete threads", zh: "删除对话" },
  { en: "Delete draft", zh: "删除草稿" },
  { en: "Return to single chat", zh: "返回单对话" },
];

const CANONICAL_BY_LABEL = new Map<string, string>();
const DEFINITION_BY_CANONICAL = new Map<string, NativeMenuLabelDefinition>();

for (const definition of NATIVE_MENU_LABELS) {
  DEFINITION_BY_CANONICAL.set(definition.en, definition);
  CANONICAL_BY_LABEL.set(definition.en, definition.en);
  CANONICAL_BY_LABEL.set(definition.zh, definition.en);
  for (const alias of definition.enAliases ?? []) {
    CANONICAL_BY_LABEL.set(alias, definition.en);
  }
  for (const alias of definition.zhAliases ?? []) {
    CANONICAL_BY_LABEL.set(alias, definition.en);
  }
}

const ENGLISH_COUNTED_ACTION = /^(Mark unread|Archive|Delete|Restore) \((\d+)\)$/;
const CHINESE_COUNTED_ACTION = /^(标记为未读|归档|删除|恢复)\s*[（(](\d+)[）)]$/;

interface LineRange {
  readonly kind: "line" | "lines";
  readonly token: string;
}

function parseEnglishLineRange(value: string): LineRange | null {
  const match = /^(line|lines) (\d+(?::\d+)?(?:-\d+(?::\d+)?)?)$/.exec(value);
  if (!match) return null;

  const kind = match[1] as LineRange["kind"];
  const token = match[2] ?? "";
  const valid =
    kind === "line"
      ? /^\d+(?::\d+(?:-\d+)?)?$/.test(token)
      : /^\d+(?::\d+)?-\d+(?::\d+)?$/.test(token);
  return valid ? { kind, token } : null;
}

function inferChineseLineRange(token: string): LineRange | null {
  if (!/^\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/.test(token)) return null;
  const separatorIndex = token.indexOf("-");
  if (separatorIndex === -1) return { kind: "line", token };

  const left = token.slice(0, separatorIndex);
  const right = token.slice(separatorIndex + 1);
  // A single-line column range is `21:5-12`; a multi-line range either has no
  // columns (`3-9`) or has columns at both ends (`21:5-23:8`).
  const kind = left.includes(":") && !right.includes(":") ? "line" : "lines";
  return parseEnglishLineRange(`${kind} ${token}`);
}

function normalizeDynamicNativeMenuLabel(label: string): string | null {
  const englishCount = ENGLISH_COUNTED_ACTION.exec(label);
  if (englishCount) {
    return `${englishCount[1]} (${englishCount[2]})`;
  }

  const chineseCount = CHINESE_COUNTED_ACTION.exec(label);
  if (chineseCount) {
    const action = CANONICAL_BY_LABEL.get(chineseCount[1] ?? "");
    return action ? `${action} (${chineseCount[2]})` : null;
  }

  const englishReference = /^Reference (.+) in chat$/.exec(label);
  if (englishReference) {
    const range = parseEnglishLineRange(englishReference[1] ?? "");
    if (range) return `Reference ${range.kind} ${range.token} in chat`;
  }

  const englishAskWhy = /^Ask why (.+) changed$/.exec(label);
  if (englishAskWhy) {
    const range = parseEnglishLineRange(englishAskWhy[1] ?? "");
    if (range) return `Ask why ${range.kind} ${range.token} changed`;
  }

  const chineseReference = /^在对话中引用第\s*(\S+)\s*行$/.exec(label);
  if (chineseReference) {
    const range = inferChineseLineRange(chineseReference[1] ?? "");
    if (range) return `Reference ${range.kind} ${range.token} in chat`;
  }

  const chineseAskWhy = /^询问第\s*(\S+)\s*行为何发生更改$/.exec(label);
  if (chineseAskWhy) {
    const range = inferChineseLineRange(chineseAskWhy[1] ?? "");
    if (range) return `Ask why ${range.kind} ${range.token} changed`;
  }

  // Accept labels emitted by the first upstream Chinese implementation so an
  // already-localized menu can still switch back to English deterministically.
  const legacyChineseReference = /^在对话中引用 (.+)$/.exec(label);
  if (legacyChineseReference) {
    const range = parseEnglishLineRange(legacyChineseReference[1] ?? "");
    if (range) return `Reference ${range.kind} ${range.token} in chat`;
  }

  const legacyChineseAskWhy = /^询问为何 (.+) 发生更改$/.exec(label);
  if (legacyChineseAskWhy) {
    const range = parseEnglishLineRange(legacyChineseAskWhy[1] ?? "");
    if (range) return `Ask why ${range.kind} ${range.token} changed`;
  }

  const englishHandoff = /^Handoff to (.+)$/.exec(label);
  if (englishHandoff) return `Handoff to ${englishHandoff[1]}`;

  const chineseHandoff = /^移交给 (.+)$/.exec(label);
  if (chineseHandoff) return `Handoff to ${chineseHandoff[1]}`;

  return null;
}

/**
 * Reduces renderer/system locale strings to the two locales supported by the
 * desktop menu. Unknown and Traditional Chinese locales deliberately fall back
 * to English instead of silently forcing Simplified Chinese.
 */
export function normalizeNativeMenuLocale(locale: string | null | undefined): NativeMenuLocale {
  if (typeof locale !== "string") return "en";
  const normalized = locale.trim().replaceAll("_", "-").toLowerCase();
  return normalized === "zh" ||
    normalized === "zh-cn" ||
    normalized.startsWith("zh-cn-") ||
    normalized === "zh-sg" ||
    normalized.startsWith("zh-sg-") ||
    normalized === "zh-hans" ||
    normalized.startsWith("zh-hans-")
    ? "zh-CN"
    : "en";
}

/** Converts a known English or Chinese label to its stable English key. */
export function normalizeNativeMenuLabel(label: string): string {
  return CANONICAL_BY_LABEL.get(label) ?? normalizeDynamicNativeMenuLabel(label) ?? label;
}

/**
 * Translates only known menu chrome. Dynamic wrappers retain provider names and
 * line/column numbers, while unknown project names, paths, and user content are
 * returned byte-for-byte unchanged.
 */
export function translateNativeMenuLabel(label: string, locale: string | null | undefined): string {
  const targetLocale = normalizeNativeMenuLocale(locale);
  // Generated-image context actions intentionally keep their reference labels
  // (`Copy image` / `Show in Finder`) distinct from Chromium's `Copy Image` and
  // the file-reference `Reveal in Finder`. These exact labels are already
  // localized by the renderer/native action contract, so do not canonicalize
  // them to the older menu keys in English mode.
  if (label === "Copy image") {
    return targetLocale === "zh-CN" ? "复制图像" : "Copy image";
  }
  if (label === "Show in Finder") {
    return targetLocale === "zh-CN" ? "在 Finder 中显示" : "Show in Finder";
  }
  const directCanonical = CANONICAL_BY_LABEL.get(label);
  const dynamicCanonical = normalizeDynamicNativeMenuLabel(label);
  const canonical = directCanonical ?? dynamicCanonical ?? label;
  const definition = DEFINITION_BY_CANONICAL.get(canonical);
  if (definition) return targetLocale === "zh-CN" ? definition.zh : definition.en;
  if (!dynamicCanonical) return label;
  if (targetLocale === "en") return canonical;

  const countedAction = ENGLISH_COUNTED_ACTION.exec(canonical);
  if (countedAction) {
    const actionDefinition = DEFINITION_BY_CANONICAL.get(countedAction[1] ?? "");
    return actionDefinition ? `${actionDefinition.zh}（${countedAction[2]}）` : label;
  }

  const reference = /^Reference (line|lines) (\S+) in chat$/.exec(canonical);
  if (reference) return `在对话中引用第 ${reference[2]} 行`;

  const askWhy = /^Ask why (line|lines) (\S+) changed$/.exec(canonical);
  if (askWhy) return `询问第 ${askWhy[2]} 行为何发生更改`;

  const handoff = /^Handoff to (.+)$/.exec(canonical);
  if (handoff) return `移交给 ${handoff[1]}`;

  return label;
}

const NATIVE_APPSNAP_MESSAGES: Readonly<Record<string, string>> = {
  "The AppSnap native helper is missing from this desktop build.":
    "此桌面版本缺少应用截图（AppSnap）原生辅助程序。",
  "The AppSnap helper did not report its permission state.":
    "应用截图（AppSnap）辅助程序未报告权限状态。",
  "Could not read the captured AppSnap.": "无法读取截取的应用截图（AppSnap）。",
  "The AppSnap helper returned a capture outside its private directory.":
    "应用截图（AppSnap）辅助程序返回了其私有目录之外的截图。",
  "Pending AppSnap metadata is invalid.": "待处理应用截图（AppSnap）的元数据无效。",
  "Pending AppSnap metadata exceeds its storage limit.":
    "待处理应用截图（AppSnap）的元数据超出存储限制。",
  "Expected a regular file.": "应为普通文件。",
  "The file is empty.": "文件为空。",
  "The file is larger than allowed.": "文件大小超出允许范围。",
  "The file size does not match its metadata.": "文件大小与其元数据不一致。",
  "The file changed while it was read.": "读取期间文件发生了变化。",
  "The file is not a valid PNG image.": "文件不是有效的 PNG 图像。",
  "There is no frontmost application to capture.": "没有可供截图的最前方应用。",
  "Moss cannot capture its own window.": "Moss 无法截取自己的窗口。",
  "macOS did not provide a window list.": "macOS 未提供窗口列表。",
  "The frontmost application has no visible, shareable layer-0 window.":
    "最前方应用没有可见且可共享的第 0 层窗口。",
  "Timed out while preparing or capturing the window.": "准备或截取窗口时超时。",
  "The selected window disappeared before it could be captured.": "所选窗口在截取前已消失。",
  "The selected window has invalid capture dimensions.": "所选窗口的截图尺寸无效。",
  "Could not convert the captured frame into an image.": "无法将截取的画面转换为图像。",
  "Could not encode the captured window as PNG.": "无法将截取的窗口编码为 PNG。",
  "The captured window could not be reduced below the 10 MiB image limit.":
    "无法将截取的窗口压缩到 10 MiB 图像限制以内。",
  "A previous AppSnap capture is still in progress.": "上一次应用截图（AppSnap）仍在进行中。",
  "Screen Recording permission is required to capture a window.": "截取窗口需要“屏幕录制”权限。",
  "Input Monitoring permission is required to watch both Option keys.":
    "监听两个 Option 键需要“输入监控”权限。",
  "macOS could not create the passive Option-key listener.": "macOS 无法创建被动 Option 键监听器。",
  "macOS could not attach the Option-key listener to the run loop.":
    "macOS 无法将 Option 键监听器附加到运行循环。",
  "macOS disabled the Option-key listener; the helper re-enabled it.":
    "macOS 已停用 Option 键监听器；辅助程序已重新启用。",
  "Choose exactly one helper mode.": "请只选择一种辅助程序模式。",
  "--output-dir requires a path.": "--output-dir 需要提供路径。",
  "--excluded-bundle-id requires a bundle identifier.": "--excluded-bundle-id 需要提供包标识符。",
  "Permission checks do not accept watch arguments.": "权限检查不接受监听参数。",
  "Permission requests do not accept watch arguments.": "权限请求不接受监听参数。",
  "--watch requires --output-dir.": "--watch 需要 --output-dir。",
  "--watch requires --excluded-bundle-id.": "--watch 需要 --excluded-bundle-id。",
  "Expected --check-permissions, --request-permissions, or --watch.":
    "应使用 --check-permissions、--request-permissions 或 --watch。",
  "AppSnap capture failed.": "应用截图（AppSnap）失败。",
};

const NATIVE_APPSNAP_DYNAMIC_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/^Could not start AppSnap: (.+)$/s, "无法启动应用截图（AppSnap）：$1"],
  [/^Could not inspect AppSnap permissions: (.+)$/s, "无法检查应用截图（AppSnap）权限：$1"],
  [
    /^The AppSnap helper stopped unexpectedly \((.+)\)\.$/s,
    "应用截图（AppSnap）辅助程序意外停止（$1）。",
  ],
  [
    /^Moss could retain only the latest (\d+) AppSnaps while the composer was unavailable\. The oldest capture was discarded\.$/,
    "编辑器不可用期间，Moss 只能保留最近 $1 张应用截图（AppSnap）。最早的截图已被丢弃。",
  ],
  [/^Could not read shareable windows: (.+)$/s, "无法读取可共享窗口：$1"],
  [/^Could not configure window capture: (.+)$/s, "无法配置窗口截图：$1"],
  [/^Could not start window capture: (.+)$/s, "无法启动窗口截图：$1"],
  [/^Window capture stopped unexpectedly: (.+)$/s, "窗口截图意外停止：$1"],
  [/^Could not prepare the private capture directory: (.+)$/s, "无法准备私有截图目录：$1"],
  [/^Could not write the captured PNG: (.+)$/s, "无法写入截取的 PNG：$1"],
  [/^Could not process the captured window: (.+)$/s, "无法处理截取的窗口：$1"],
  [/^Unknown argument: (.+)$/s, "未知参数：$1"],
];

/** Localizes known native AppSnap failures while preserving OS diagnostics verbatim. */
export function translateNativeAppSnapMessage(
  message: string,
  locale: string | null | undefined,
): string {
  if (normalizeNativeMenuLocale(locale) !== "zh-CN") return message;
  const exact = NATIVE_APPSNAP_MESSAGES[message];
  if (exact) return exact;
  for (const [pattern, replacement] of NATIVE_APPSNAP_DYNAMIC_MESSAGES) {
    if (pattern.test(message)) return message.replace(pattern, replacement);
  }
  return message;
}
