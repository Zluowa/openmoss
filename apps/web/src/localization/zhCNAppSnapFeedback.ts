// FILE: zhCNAppSnapFeedback.ts
// Purpose: Completes Simplified Chinese presentation copy for AppSnap and Feedback.
// Layer: Pure localization helper
//
// This module intentionally translates only known user-facing UI copy. App names,
// window titles, paths, native error details, and feedback report diagnostics are
// either captured and preserved by a narrow pattern or returned unchanged.

type DynamicTranslation = readonly [pattern: RegExp, translate: (match: RegExpExecArray) => string];

const EXACT_TRANSLATIONS: Readonly<Record<string, string>> = {
  // AppSnap settings navigation and search.
  AppSnap: "应用截图（AppSnap）",
  "Snap another app's window straight into a task with one key chord.":
    "同时按下两个 Option 键，即可将其他应用的窗口直接加入任务。",
  "Screen capture": "屏幕截图",
  "Enable AppSnap": "启用应用截图（AppSnap）",
  Shortcut: "快捷键",
  Destination: "发送位置",
  "Capture sound": "截图提示音",
  "Permission status": "权限状态",
  Capture: "截图",
  "Available on macOS only": "仅可在 macOS 上使用",
  "Listening — press both Option keys to snap": "正在监听 — 同时按下两个 Option 键即可截图",
  Off: "关闭",
  "Starting the capture listener…": "正在启动截图监听器…",
  "Starting the capture listener...": "正在启动截图监听器…",
  "Permission setup required": "需要完成权限设置",
  Granted: "已授权",
  Denied: "已拒绝",
  "Not requested yet": "尚未请求",
  Restricted: "受限制",
  Unknown: "未知",
  "AppSnap unavailable": "应用截图（AppSnap）不可用",
  "Finish AppSnap setup": "完成应用截图（AppSnap）设置",
  "Allow the required macOS permissions, then try again.": "请授予所需的 macOS 权限，然后重试。",
  "AppSnap setup failed": "应用截图（AppSnap）设置失败",
  "Could not configure AppSnap.": "无法配置应用截图（AppSnap）。",
  "Could not check AppSnap permissions": "无法检查应用截图（AppSnap）权限",
  "Permission check failed.": "权限检查失败。",
  "Take an AppSnap to show your agent another app's window":
    "使用应用截图（AppSnap）向智能体展示其他应用的窗口",
  "Press both": "同时按下",
  "keys at once while any app is frontmost.": "两个键；无论当前位于哪个应用都可使用。",
  "Capture the frontmost macOS app window with both Option keys and add it to a recent task. appshot screenshot snap window capture alt":
    "同时按下两个 Option 键截取最前方的 macOS 应用窗口，并加入最近的任务。应用截图 屏幕截图 窗口 截图 Option Alt",
  "Press the left and right Option keys at the same time. hotkey chord alt keys":
    "同时按下左、右 Option 键。快捷键 组合键 Alt",
  "Snaps join the task you interacted with in the last minute, otherwise a fresh task opens. automatic target composer":
    "截图会加入你在最近一分钟内操作过的任务，否则将新建任务。自动 目标 编辑器",
  "Play a short shutter cue when a window is captured. sound effect audio mute":
    "截取窗口时播放简短的快门提示音。声音 音效 静音",
  "Input Monitoring and Screen Recording permissions for AppSnap in macOS System Settings. privacy security recheck grant":
    "在 macOS 系统设置中管理应用截图（AppSnap）的输入监控与屏幕录制权限。隐私 安全 重新检查 授权",
  "AppSnap is available only in the macOS desktop app.":
    "应用截图（AppSnap）仅可在 macOS 桌面应用中使用。",
  "Run the capture listener in the background while Moss is open.":
    "Moss 打开时在后台运行截图监听器。",
  "Press the left and right Option keys at the same time. The chord works while any app is focused, and can't be remapped yet.":
    "同时按下左、右 Option 键。无论当前聚焦哪个应用，此组合键都有效，暂不支持重新映射。",
  "⌥ left": "⌥ 左",
  "⌥ right": "⌥ 右",
  Automatic: "自动",
  "Play a short shutter cue when a window is captured.": "截取窗口时播放简短的快门提示音。",
  "capture sound": "截图提示音",
  Preview: "试听",
  "Play a sound when an AppSnap is captured": "截取应用截图（AppSnap）时播放提示音",
  "macOS permissions": "macOS 权限",
  "Input Monitoring": "输入监控",
  "Screen Recording": "屏幕录制",
  "Recheck permissions": "重新检查权限",

  // First-run AppSnap introduction.
  "AppSnap is ready!": "应用截图（AppSnap）已就绪！",
  "Not now": "暂不设置",
  "Set up AppSnap": "设置应用截图（AppSnap）",

  // AppSnap composer coordination, toasts, and attachment affordances.
  "The captured AppSnap is empty.": "截取的应用截图（AppSnap）为空。",
  "The AppSnap was captured, but its draft metadata was rejected.":
    "应用截图（AppSnap）已截取，但其草稿元数据被拒绝。",
  "AppSnap added with a warning": "应用截图（AppSnap）已加入，但有一项警告",
  "AppSnap added": "应用截图（AppSnap）已加入",
  "The capture is attached, but Moss could not verify its draft metadata. If it is missing after a reload, Moss will attach it again.":
    "截图已附加，但 Moss 无法验证其草稿元数据。如果重新加载后截图缺失，Moss 会再次附加。",
  "The frontmost window was added to the composer.": "已将最前方窗口加入编辑器。",
  "The AppSnap composer is not ready yet.": "应用截图（AppSnap）编辑器尚未就绪。",
  "AppSnap could not be added": "无法加入应用截图（AppSnap）",
  "AppSnap capture failed.": "应用截图（AppSnap）失败。",
  Retry: "重试",
  "AppSnap failed": "应用截图（AppSnap）失败",
  Restart: "重新启动",
  "Captured app": "已截图的应用",
  IMG: "图片",
  "AppSnap discarded": "已丢弃应用截图（AppSnap）",

  // Desktop/AppSnap helper messages that are surfaced through renderer toasts.
  "Allow Input Monitoring in macOS System Settings, then try again.":
    "请在 macOS 系统设置中允许“输入监控”，然后重试。",
  "Allow Screen Recording in macOS System Settings, then try again.":
    "请在 macOS 系统设置中允许“屏幕录制”，然后重试。",
  "Allow Input Monitoring and Screen Recording in macOS System Settings, then try again.":
    "请在 macOS 系统设置中允许“输入监控”和“屏幕录制”，然后重试。",
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

  // Feedback entry points and dialog UI. The internal maintainer report remains English.
  "Feedback Moss": "向 Moss 反馈",
  "Send feedback to the Moss team": "向 Moss 团队发送反馈",
  "Send feedback or report an issue to the Moss team.": "向 Moss 团队发送反馈或报告问题。",
  "Share feedback": "分享反馈",
  "Feedback category": "反馈类别",
  Bug: "错误",
  Session: "会话",
  UI: "界面",
  Performance: "性能",
  Idea: "想法",
  Other: "其他",
  "Share details (required)": "请说明详情（必填）",
  "Feedback details": "反馈详情",
  "Diagnostics include app version, OS, provider/model, modes, and session state — never prompts, messages, paths, or logs.":
    "诊断信息仅包含应用版本、操作系统、服务商/模型、模式和会话状态，绝不包含提示词、消息、路径或日志。",
  "Feedback delivery is not configured for this Moss build.": "此 Moss 版本尚未配置反馈发送服务。",
  "Feedback sent": "反馈已发送",
  "Thanks for helping make Moss better.": "感谢你帮助 Moss 变得更好。",
  "Could not send feedback": "无法发送反馈",
  "An unexpected delivery error occurred.": "发生了意外的发送错误。",
  "Sending…": "发送中…",
  "Sending...": "发送中…",
  Submit: "提交",
  "Feedback delivery timed out. Please try again.": "反馈发送超时，请重试。",
};

const DYNAMIC_TRANSLATIONS: ReadonlyArray<DynamicTranslation> = [
  // JSX splits the AppSnap setup paragraph around its keyboard badge and
  // dynamic app name. These narrow fragments cover the resulting text nodes.
  [/^keys at once while any app is\s+frontmost\.$/, () => "两个键；无论当前位于哪个应用都可使用。"],
  [
    /^captures that window as an image, brings itself forward,\s+and attaches the snap to a task composer — the capture stays on this device until you\s+send the message\.$/,
    () => "会将该窗口截为图像、切回前台并附加到任务编辑器；发送消息之前，截图仅保存在此设备上。",
  ],

  // App display names are preserved verbatim.
  [/^Available in the (.+) desktop app$/, (match) => `可在 ${match[1]} 桌面应用中使用`],
  [
    /^AppSnap requires the (.+) desktop app on macOS\.$/,
    (match) => `应用截图（AppSnap）需要在 macOS 上使用 ${match[1]} 桌面应用。`,
  ],
  [
    /^Run the capture listener in the background while (.+) is open\.$/,
    (match) => `${match[1]} 打开时在后台运行截图监听器。`,
  ],
  [
    /^Snaps join the task you interacted with in the last minute, and consecutive snaps stay together\. Otherwise (.+) opens a fresh task with the capture attached\.$/,
    (match) =>
      `截图会加入你在最近一分钟内操作过的任务，连续截图也会归入同一任务。否则 ${match[1]} 会新建任务并附上截图。`,
  ],
  [
    /^Lets (.+) notice the double-Option chord while another app owns the keyboard\. Nothing you type is recorded\.$/,
    (match) =>
      `允许 ${match[1]} 在其他应用接收键盘输入时识别双 Option 组合键。不会记录你输入的任何内容。`,
  ],
  [
    /^Lets (.+) capture an image of the frontmost window\. Only the single window you snap is captured, only at the moment you press the chord\.$/,
    (match) => `允许 ${match[1]} 截取最前方窗口。仅在你按下组合键的瞬间截取所选的单个窗口。`,
  ],
  [
    /^Grant both permissions to (.+) under System Settings → Privacy & Security, then recheck here\. macOS may require relaunching the app after a change\.$/,
    (match) =>
      `请在“系统设置”→“隐私与安全性”中为 ${match[1]} 授予这两项权限，然后在此重新检查。更改后，macOS 可能要求重新启动应用。`,
  ],
  [
    /^Press both\s+Option keys \(⌥\s*⌥\) to snap any app(?:'|’)s window into the task you(?:'|’)re working in\.$/,
    () => "同时按下两个 Option 键（⌥ ⌥），即可将任意应用的窗口截取到你正在处理的任务中。",
  ],
  [
    /^Press both ⌥ Option keys at once while any app is frontmost\. (.+) captures that window as an image, brings itself forward, and attaches the snap to a task composer — the capture stays on this device until you send the message\.$/,
    (match) =>
      `同时按下两个 ⌥ Option 键即可截取当前最前方应用。${match[1]} 会将该窗口截为图像、切回前台并附加到任务编辑器；发送消息之前，截图仅保存在此设备上。`,
  ],
  [
    /^(.+) captures that window as an image, brings itself forward,\s+and attaches the snap to a task composer — the capture stays on this device until you\s+send the message\.$/,
    (match) =>
      `${match[1]} 会将该窗口截为图像、切回前台并附加到任务编辑器；发送消息之前，截图仅保存在此设备上。`,
  ],
  [
    /^(.+) could not create a task for this AppSnap\.$/,
    (match) => `${match[1]} 无法为此应用截图（AppSnap）创建任务。`,
  ],
  [
    /^(.+) could not attach the captured AppSnap\.$/,
    (match) => `${match[1]} 无法附加截取的应用截图（AppSnap）。`,
  ],
  [
    /^Captured (.+) and added it to the composer\.$/,
    (match) => `已截取 ${match[1]} 并加入编辑器。`,
  ],
  [/^Preview AppSnap from (.+)$/, (match) => `预览来自 ${match[1]} 的应用截图（AppSnap）`],
  [/^Remove AppSnap from (.+)$/, (match) => `移除来自 ${match[1]} 的应用截图（AppSnap）`],

  // Native status/error details are preserved after a translated prefix.
  [/^Could not start AppSnap: (.+)$/s, (match) => `无法启动应用截图（AppSnap）：${match[1]}`],
  [
    /^Could not inspect AppSnap permissions: (.+)$/s,
    (match) => `无法检查应用截图（AppSnap）权限：${match[1]}`,
  ],
  [
    /^The AppSnap helper stopped unexpectedly \((.+)\)\.$/s,
    (match) => `应用截图（AppSnap）辅助程序意外停止（${match[1]}）。`,
  ],
  [
    /^Moss could retain only the latest (\d+) AppSnaps while the composer was unavailable\. The oldest capture was discarded\.$/,
    (match) =>
      `编辑器不可用期间，Moss 只能保留最近 ${match[1]} 张应用截图（AppSnap）。最早的截图已被丢弃。`,
  ],
  [/^Could not read shareable windows: (.+)$/s, (match) => `无法读取可共享窗口：${match[1]}`],
  [/^Could not configure window capture: (.+)$/s, (match) => `无法配置窗口截图：${match[1]}`],
  [/^Could not start window capture: (.+)$/s, (match) => `无法启动窗口截图：${match[1]}`],
  [/^Window capture stopped unexpectedly: (.+)$/s, (match) => `窗口截图意外停止：${match[1]}`],
  [
    /^Could not prepare the private capture directory: (.+)$/s,
    (match) => `无法准备私有截图目录：${match[1]}`,
  ],
  [/^Could not write the captured PNG: (.+)$/s, (match) => `无法写入截取的 PNG：${match[1]}`],
  [/^Could not process the captured window: (.+)$/s, (match) => `无法处理截取的窗口：${match[1]}`],
  [/^Unknown argument: (.+)$/s, (match) => `未知参数：${match[1]}`],

  // Only the local HTTP status wrapper is translated. Arbitrary server error
  // payloads deliberately miss this pattern and remain untouched.
  [/^Feedback could not be sent \((\d+)\)\.$/, (match) => `反馈无法发送（${match[1]}）。`],
];

/**
 * Returns the Simplified Chinese presentation for known AppSnap/Feedback UI
 * copy. Unknown input is returned byte-for-byte so runtime content and
 * diagnostics are never guessed at or translated.
 */
export function translateZhCnAppSnapFeedbackText(value: string): string {
  const exact = EXACT_TRANSLATIONS[value];
  if (exact !== undefined) return exact;

  for (const [pattern, translate] of DYNAMIC_TRANSLATIONS) {
    const match = pattern.exec(value);
    if (match) return translate(match);
  }

  return value;
}
