// FILE: zhCNComputerControl.ts
// Purpose: Completes Simplified Chinese presentation copy for Computer control settings and toasts.
// Layer: Pure localization helper
// Boundary: Translate known chrome and host summaries; preserve backend names and unknown diagnostics.

const PROVISION_TRANSLATIONS: Readonly<Record<string, string>> = {
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

function translateProvisionSummary(value: string): string {
  const exact = PROVISION_TRANSLATIONS[value];
  if (exact !== undefined) return exact;

  const permissions = /^Moss Computer Use needs permission: (.+)\. Then retry Computer Use\.$/.exec(
    value,
  );
  if (permissions) {
    const parts = permissions[1]!.split("; ");
    if (parts.every((part) => PERMISSION_GUIDANCE[part] !== undefined)) {
      return `Moss 电脑控制需要以下权限：${parts.map((part) => PERMISSION_GUIDANCE[part]).join("；")}。然后重试电脑控制。`;
    }
  }
  return value;
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
    .map((part) => EXACT_TRANSLATIONS[part])
    .join(" · ");
}

export function translateZhCnComputerControlText(value: string): string {
  const exact = EXACT_TRANSLATIONS[value];
  if (exact !== undefined) return exact;

  const availability =
    /^Available on macOS \(([^()\r\n]+)\)(; waiting for native capture helper)?$/.exec(value);
  if (availability) {
    return `可在 macOS 上使用（${availability[1]}）${availability[2] ? "；正在等待原生捕获辅助程序" : ""}`;
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
