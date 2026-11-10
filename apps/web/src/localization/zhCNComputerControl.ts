// FILE: zhCNComputerControl.ts
// Purpose: Completes Simplified Chinese presentation copy for Computer control settings and toasts.
// Layer: Pure localization helper
// Boundary: Translate known chrome and host summaries; preserve backend names and unknown diagnostics.

import { COMPUTER_PERMISSION_LABELS } from "@moss/shared/computerGrants";

import { lookupPhrase } from "./zhCNPhraseTable";

const PROVISION_TRANSLATIONS: Readonly<Record<string, string>> = {
  "Moss needs a macOS privacy permission to control this Mac. Grant it in System Settings › Privacy & Security, then try again.":
    "Moss 需要一项 macOS 隐私权限才能控制这台 Mac。请在“系统设置 › 隐私与安全性”中授权，然后重试。",
  "Computer permissions are ready. Send a message to continue; no action is retried automatically.":
    "电脑权限已就绪。发送消息即可继续；不会自动重试任何操作。",
  "Computer control is paused until the Escape and human-input listener is ready. Moss reconnects it automatically; check Computer settings if it remains unavailable.":
    "在 Esc 键和人工输入监听就绪前，电脑控制已暂停。Moss 会自动重新连接；如果一直不可用，请检查电脑控制设置。",
  "Moss Computer Use is ready on macOS.": "Moss 电脑控制已在 macOS 上就绪。",
  "Moss Computer Use is enabled on macOS; the native helper will attach when available.":
    "Moss 电脑控制已在 macOS 上启用；原生辅助程序可用后将自动连接。",
  "Moss Computer Use is attached on macOS and is waiting for desktop permissions.":
    "Moss 电脑控制已在 macOS 上连接，正在等待桌面权限。",
  "Moss Computer Use is attached on macOS; permission status is unavailable.":
    "Moss 电脑控制已在 macOS 上连接；无法获取权限状态。",
  "Computer control is coming soon on Linux.": "电脑控制即将支持 Linux。",
  "Computer control is unavailable on this platform.": "此平台暂不支持电脑控制。",
  "Moss Computer Use is not available on this platform.": "此平台暂不支持 Moss 电脑控制。",
};

const EXACT_TRANSLATIONS: Readonly<Record<string, string>> = {
  ...PROVISION_TRANSLATIONS,
  "Computer control": "电脑控制",
  "Checking status…": "正在检查状态…",
  "Checking status...": "正在检查状态…",
  "Asking the desktop helper for Computer control availability.":
    "正在向桌面辅助程序查询电脑控制的可用性。",
  "Desktop only": "仅限桌面应用",
  "Open the Moss desktop app to review Computer control.": "请打开 Moss 桌面应用查看电脑控制。",
  "On Windows, Moss works with your apps through UI Automation and screen capture. Allow any access Windows asks for, then refresh. Use Stop in the chat to interrupt the task.":
    "在 Windows 上，Moss 通过界面自动化和屏幕截图操作你的应用。Windows 请求权限时请允许，然后刷新。在对话中点击停止即可中断任务。",
  "Allow Moss the UI Automation and screen access Windows asks for, then refresh.":
    "请允许 Windows 为 Moss 请求的界面自动化和屏幕权限，然后刷新。",
  "Computer control is ready on Windows.": "电脑控制已可在 Windows 上使用。",
  "Moss's computer control is not running yet. Restart Moss, then refresh.":
    "Moss 的电脑控制还没有运行。请重新打开 Moss，然后刷新。",
  "The agent shares your Mac desktop and works in the background by default. It can bring a window forward when your task asks to watch. Background input may still affect focus. Use Stop in the chat to interrupt the task. Physical Escape interrupts the current action when Input Monitoring is granted; it does not disable future tasks.":
    "智能体与你共用这台 Mac 的桌面，默认在后台工作；任务需要你看着时会把窗口调到前面。后台输入仍可能影响焦点。在对话中点击停止即可中断任务。授予输入监控权限后，按 Esc 可中断当前动作，但不会关闭之后的任务。",
  "The agent shares this computer's desktop. Use Stop in the chat to interrupt the task.":
    "智能体与你共用这台电脑的桌面。在对话中点击停止即可中断任务。",
  "This backend can observe desktop windows, but native desktop input is unavailable. Isolated headless browser actions require a verified browser runtime and an available task-scoped Escape shortcut. Use Stop in the chat to interrupt the task.":
    "当前实例只能查看桌面窗口，不能直接操作桌面。独立的无界面浏览器操作需要已验证的浏览器运行环境和可用的任务级 Esc 快捷键。在对话中点击停止即可中断任务。",
  "The agent drives its own seat, so your cursor and focus stay untouched.":
    "智能体使用自己独立的桌面，不会动你的鼠标和焦点。",
  "Open Moss on macOS to review Computer control. Linux support is coming soon.":
    "请在 macOS 上打开 Moss 以查看电脑控制。即将支持 Linux。",
  "Status unavailable": "无法获取状态",
  "Could not read Computer control status.": "无法读取电脑控制状态。",
  Retry: "重试",
  Refresh: "刷新",
  Availability: "可用性",
  "Coming soon on Linux": "即将支持 Linux",
  "Unsupported on this platform": "此平台暂不支持",
  "Backend unavailable": "后端不可用",
  Unavailable: "不可用",
  "Permissions & helper": "权限与辅助程序",
  "Input helper ready": "输入辅助程序已就绪",
  "Input helper not ready": "输入辅助程序尚未就绪",
  "Capture attached": "屏幕捕获已连接",
  "Capture not attached": "屏幕捕获尚未连接",
  "cliclick mentioned in host status": "主机状态中提及 cliclick",
  "Desktop capture": "桌面捕获",
  "Desktop capture is ready for a Computer Use thread. Run /computer-use in chat to enable capture for the current thread; this panel does not render a live desktop preview.":
    "桌面捕获已就绪，可用于电脑控制对话。在聊天中运行 /computer-use 即可为当前对话启用捕获；此面板不显示实时桌面预览。",
  "Desktop capture becomes ready after Screen Recording permission and the native capture helper are ready; this panel does not render a live desktop preview.":
    "授予屏幕录制权限且原生捕获辅助程序就绪后，即可使用桌面捕获；此面板不显示实时桌面预览。",
  "macOS permissions": "macOS 权限",
  "Privacy panes": "隐私设置",
  "Grant Accessibility and Screen Recording to Moss, then refresh. In chat, run /computer-use to enable control for the current thread.":
    "请为 Moss 授予辅助功能和屏幕录制权限，然后刷新。在聊天中运行 /computer-use 即可为当前对话启用电脑控制。",
  Accessibility: "辅助功能",
  "Screen Recording": "屏幕录制",
  "Open System Settings": "打开系统设置",
  "System Settings → Privacy & Security → Accessibility → allow Moss.":
    "系统设置 → 隐私与安全性 → 辅助功能 → 允许 Moss。",
  "System Settings → Privacy & Security → Screen & System Audio Recording → allow Moss.":
    "系统设置 → 隐私与安全性 → 屏幕与系统音频录制 → 允许 Moss。",

  // /computer-use toasts use the same presentation fallback as settings.
  "Moss couldn't find its computer control component. Reinstall Moss to use computer control.":
    "Moss 找不到电脑控制组件。请重新安装 Moss 后再使用电脑控制。",
  // The permission flow, in the order a user meets it.
  Recheck: "重新检查",
  "Choose Set up to request missing permissions or open System Settings. Allow access for this Moss app, then return here to recheck.":
    "选择“设置”以请求缺少的权限或打开系统设置。为此 Moss 应用授权后，回到这里重新检查。",
  "Choose Set up to check permissions and prepare computer control.":
    "选择“设置”以检查权限并准备电脑控制。",
  "Computer control needs setup": "电脑控制需要设置",
  "Send a message and the agent will pick up where it left off.":
    "发送一条消息，智能体会从中断的地方继续。",
  "Screen capture is not allowed yet": "尚未允许屏幕捕获",
  "The agent can act on the desktop but cannot see it, so screenshots fail. Turn Moss on in System Settings › Privacy & Security › Screen Recording, then press Set up to reconnect.":
    "智能体可以操作桌面，但看不到画面，因此无法截图。请前往“系统设置 › 隐私与安全性 › 屏幕录制”打开 Moss，然后点按“设置”重新连接。",
  "The agent can act on the desktop but cannot see it, so screenshots fail. Press Set up to reconnect.":
    "智能体可以操作桌面，但看不到画面，因此无法截图。请点按“设置”重新连接。",
  "Computer Use is unavailable": "电脑控制不可用",
  "Open Moss on a supported desktop to use Computer Use.":
    "请在支持的桌面系统上打开 Moss 以使用电脑控制。",
  "Invalid /computer-use command": "/computer-use 命令无效",
  "Use /computer-use, /computer-use on, /computer-use off, or /computer-use status.":
    "请使用 /computer-use、/computer-use on、/computer-use off 或 /computer-use status。",
  "Computer Use is coming soon on Linux": "电脑控制即将支持 Linux",
  "Moss Computer Use currently supports macOS only.": "Moss 电脑控制目前仅支持 macOS。",
  "Computer control needs permissions": "电脑控制需要授权",
  "Grant Accessibility and Screen Recording to Moss in System Settings, then retry.":
    "请在系统设置中为 Moss 授予辅助功能和屏幕录制权限，然后重试。",
  "Computer control status": "电脑控制状态",
  "Computer control enabled": "电脑控制已启用",
  "Computer control disabled": "电脑控制已关闭",
  "Moss could not update desktop control status.": "Moss 无法更新桌面控制状态。",
};

const PERMISSION_GUIDANCE: Readonly<Record<string, string>> = {
  "Accessibility (System Settings → Privacy & Security → Accessibility → allow Moss)":
    "辅助功能（系统设置 → 隐私与安全性 → 辅助功能 → 允许 Moss）",
  "Screen Recording (System Settings → Privacy & Security → Screen & System Audio Recording → allow Moss)":
    "屏幕录制（系统设置 → 隐私与安全性 → 屏幕与系统音频录制 → 允许 Moss）",
};

const ZH_PERMISSION_LABELS: Readonly<Record<string, string>> = {
  [COMPUTER_PERMISSION_LABELS.accessibility]: "辅助功能",
  [COMPUTER_PERMISSION_LABELS.screenRecording]: "屏幕录制",
  [COMPUTER_PERMISSION_LABELS.inputMonitoring]: "输入监控",
};

const STALE_GRANT_ADVICE =
  "This is a locally built copy of Moss, so macOS may already list it with the switch on from an earlier build. Remove this app from the permission list, add the current build again, then fully quit and reopen it.";
const ZH_STALE_GRANT_ADVICE =
  "这是本地构建的 Moss，macOS 可能仍显示着之前版本打开的开关。请从权限列表中移除此应用，重新添加当前版本，然后完全退出并重新打开。";

/** "A", "A and B" or "A, B and C", the form `listComputerPermissions` writes. */
function translatePermissionList(value: string): string | null {
  const labels: string[] = [];
  for (const label of value.split(/, | and /)) {
    const translated = lookupPhrase(ZH_PERMISSION_LABELS, label);
    if (translated === undefined) return null;
    labels.push(translated);
  }
  return labels.length > 1
    ? `${labels.slice(0, -1).join("、")}和${labels.at(-1)}`
    : (labels[0] ?? null);
}

/** `computerStaleGrantAdvice`. The tccutil commands stay exactly as they must be typed. */
function translateStaleGrantAdvice(value: string): string | null {
  if (!value.startsWith(STALE_GRANT_ADVICE)) return null;
  const rest = value.slice(STALE_GRANT_ADVICE.length);
  if (rest === "") return ZH_STALE_GRANT_ADVICE;
  const reset =
    /^ To clear only this app's old grant, run `([^`]+)` in Terminal and grant access again\.$/.exec(
      rest,
    );
  if (!reset) return null;
  const commands = reset[1]!
    .split(", then ")
    .map((command) => `\`${command}\``)
    .join("，然后运行 ");
  return `${ZH_STALE_GRANT_ADVICE}如只想清除此应用的旧授权，请在终端运行 ${commands}，然后重新授权。`;
}

/** The messages built from a list of missing grants, from `computerGrants` and the backend. */
function translatePermissionSetupText(value: string): string {
  const advice = translateStaleGrantAdvice(value);
  if (advice !== null) return advice;

  const setup =
    /^Moss needs (.+?) to control this Mac\. Turn Moss on in System Settings › Privacy & Security › (.+?), then try again\.(?: ([\s\S]+))?$/.exec(
      value,
    );
  if (setup && setup[1] === setup[2]) {
    const list = translatePermissionList(setup[1]!);
    const setupAdvice = setup[3] === undefined ? "" : translateStaleGrantAdvice(setup[3]);
    if (list !== null && setupAdvice !== null) {
      return `Moss 需要${list}权限才能控制这台 Mac。请前往“系统设置 › 隐私与安全性 › ${list}”打开 Moss，然后重试。${setupAdvice}`;
    }
  }

  const title = /^Computer control needs (.+)$/.exec(value);
  const titleList = title ? translatePermissionList(title[1]!) : null;
  if (titleList !== null) return `电脑控制需要${titleList}权限`;

  const prompt = /^macOS may ask to allow (.+) for Moss\.$/.exec(value);
  const promptList = prompt ? translatePermissionList(prompt[1]!) : null;
  if (promptList !== null) return `macOS 可能会请求为 Moss 允许${promptList}权限。`;

  const summary =
    /^Allow (.+) for this copy of Moss in System Settings\. Return here to check again; if macOS asks you to quit and reopen the app, do so\.$/.exec(
      value,
    );
  const summaryList = summary ? translatePermissionList(summary[1]!) : null;
  if (summaryList !== null) {
    return `请在系统设置中为此 Moss 应用允许${summaryList}权限。回到这里重新检查；如果 macOS 要求退出并重新打开应用，请照做。`;
  }
  return value;
}

function translateProvisionSummary(value: string): string {
  const exact = lookupPhrase(PROVISION_TRANSLATIONS, value);
  if (exact !== undefined) return exact;

  const permissions = /^Moss Computer Use needs permission: (.+)\. Then retry Computer Use\.$/.exec(
    value,
  );
  if (permissions) {
    const parts = permissions[1]!.split("; ");
    if (parts.every((part) => lookupPhrase(PERMISSION_GUIDANCE, part) !== undefined)) {
      return `Moss 电脑控制需要以下权限：${parts.map((part) => lookupPhrase(PERMISSION_GUIDANCE, part)).join("；")}。然后重试电脑控制。`;
    }
  }
  return translatePermissionSetupText(value);
}

function translateHelperStatus(value: string): string {
  if (
    !/^Input helper (?:not )?ready · Capture (?:not )?attached(?: · cliclick mentioned in host status)?$/.test(
      value,
    )
  ) {
    return value;
  }
  return value
    .split(" · ")
    .map((part) => lookupPhrase(EXACT_TRANSLATIONS, part))
    .join(" · ");
}

export function translateZhCnComputerControlText(value: string): string {
  const exact = lookupPhrase(EXACT_TRANSLATIONS, value);
  if (exact !== undefined) return exact;

  const availability =
    /^Available on (macOS|Windows|Linux|this computer) \(([^()\r\n]+)\)(; waiting for native capture helper)?$/.exec(
      value,
    );
  if (availability) {
    const where = availability[1] === "this computer" ? "这台电脑" : ` ${availability[1]} `;
    return `可在${where}上使用（${availability[2]}）${availability[3] ? "；正在等待原生捕获辅助程序" : ""}`;
  }

  const windowsAccess = /^Allow Moss (.+) access in Windows, then refresh\.$/.exec(value);
  if (windowsAccess) {
    const list = translatePermissionList(windowsAccess[1]!);
    if (list !== null) return `请在 Windows 中为 Moss 允许${list}权限，然后刷新。`;
  }

  const provision = translateProvisionSummary(value);
  if (provision !== value) return provision;

  const helper = translateHelperStatus(value);
  if (helper !== value) return helper;

  // The panel emits the entire provision summary + helper status as one text node.
  const helperRow = /^([\s\S]+) \((Input helper .+)\)$/.exec(value);
  if (helperRow) {
    const status = translateHelperStatus(helperRow[2]!);
    if (status !== helperRow[2]) {
      return `${translateProvisionSummary(helperRow[1]!)}（${status}）`;
    }
  }

  const toast =
    /^Computer control (enabled for|is off for) this chat \(([^();\r\n]+); input (ready|unavailable), capture (ready|unavailable)\)\.(?: ([\s\S]+))?$/.exec(
      value,
    );
  if (toast) {
    const state = toast[1] === "enabled for" ? "已为此对话启用电脑控制" : "此对话的电脑控制已关闭";
    const input = toast[3] === "ready" ? "输入已就绪" : "输入不可用";
    const capture = toast[4] === "ready" ? "屏幕捕获已就绪" : "屏幕捕获不可用";
    const summary = toast[5] ? ` ${translateProvisionSummary(toast[5])}` : "";
    return `${state}（${toast[2]}；${input}，${capture}）。${summary}`;
  }

  return value;
}
