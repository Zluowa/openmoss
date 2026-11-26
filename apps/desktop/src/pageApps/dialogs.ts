// FILE: dialogs.ts
// Purpose: Self-drawn frameless HTML/CSS modal dialogs (`partition: "moss-app-dialog"`) aligned
//          with Claude Desktop REA (`UJzilp8j`): autofocus, full 500ms cooldown, forced-colors,
//          trust-tier styling, bidirectional `data-follows` switches, and host suppression hooks.
// Layer: Desktop pageApps

import { BrowserWindow, nativeTheme, screen } from "electron";

import {
  PAGE_APP_DESKTOP_PERMISSIONS,
  PAGE_APP_DIALOG_COOLDOWN_MS,
  type DesktopPageAppPermission,
  type DesktopPageAppPermissionAnswer,
  type DesktopPageAppTrustKind,
} from "./types";

export const PAGE_APP_DIALOG_PARTITION = "moss-app-dialog";
const DIALOG_RESULT_TITLE_PREFIX = "__MOSS_DIALOG_RESULT__:";
const DIALOG_WIDTHS = { sm: 400, md: 480 } as const;
const DIALOG_MIN_HEIGHT = 120;
const DIALOG_MAX_HEIGHT = 640;
const DIALOG_MEASURE_MAX_PASSES = 4;
const DIALOG_SIZE_SANITY_DELTA = 200;

const SHIELD_WARNING_SVG =
  '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M14.652 3.99L10 2.62L5.348 3.99C4.73 4.18 4.421 4.27 4.192 4.45C3.99 4.61 3.832 4.82 3.735 5.06C3.625 5.33 3.625 5.65 3.625 6.3L3.625 9.5C3.625 13.5 6.6 15.68 10 17.38C13.4 15.68 16.375 13.5 16.375 9.5L16.375 6.3C16.375 5.65 16.375 5.33 16.265 5.06C16.168 4.82 16.01 4.61 15.808 4.45C15.579 4.27 15.27 4.18 14.652 3.99Z"/>' +
  '<line x1="10" y1="6.62" x2="10" y2="9.38"/>' +
  '<circle cx="10" cy="12" r="0.375"/>' +
  "</svg>";

const WARNING_TRIANGLE_SVG =
  '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M15.958 11.5L12.727 6.24C11.824 4.77 11.373 4.04 10.793 3.79C10.287 3.57 9.713 3.57 9.207 3.79C8.627 4.04 8.176 4.77 7.273 6.24L7.273 6.24L4.042 11.5C3.063 13.09 2.574 13.89 2.63 14.55C2.679 15.12 2.972 15.64 3.434 15.98C3.964 16.38 4.899 16.38 6.769 16.38L13.231 16.38C15.101 16.38 16.036 16.38 16.566 15.98C17.028 15.64 17.321 15.12 17.37 14.55C17.426 13.89 16.937 13.09 15.958 11.5Z"/>' +
  '<line x1="10" y1="7.62" x2="10" y2="10.38"/>' +
  '<circle cx="10" cy="13" r="0.375"/>' +
  "</svg>";

const TRASH_ICON_SVG =
  '<svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">' +
  '<path d="M3.625 5.62L16.375 5.62M4.625 5.62L5.571 14.51C5.678 15.52 5.732 16.03 5.964 16.41C6.168 16.75 6.467 17.02 6.823 17.18C7.227 17.38 7.735 17.38 8.753 17.38L11.247 17.38C12.265 17.38 12.773 17.38 13.177 17.18C13.533 17.02 13.832 16.75 14.036 16.41C14.268 16.03 14.322 15.52 14.429 14.51L15.375 5.62M6.8 5.62L7.396 3.74C7.523 3.34 7.587 3.14 7.708 2.99C7.816 2.86 7.955 2.76 8.112 2.7C8.29 2.62 8.501 2.62 8.922 2.62L11.078 2.62C11.499 2.62 11.71 2.62 11.888 2.7C12.045 2.76 12.184 2.86 12.292 2.99C12.413 3.14 12.477 3.34 12.604 3.74L13.2 5.62M8.38 9.62L8.38 13.38M11.63 9.62L11.63 13.38"/>' +
  "</svg>";

export interface PermissionDialogCopy {
  readonly name: string;
  readonly askVerb: string;
  readonly description: string;
}

export const PERMISSION_COPY_ZH: Readonly<Record<DesktopPageAppPermission, PermissionDialogCopy>> =
  {
    notifications: {
      name: "发送通知",
      askVerb: "发送系统通知",
      description: "允许此应用页在您使用其他应用时显示系统通知。",
    },
    shortcuts: {
      name: "全局快捷键",
      askVerb: "从任何应用响应快捷键",
      description: "允许此应用页在您使用其他应用时响应按键组合。",
    },
    overlay: {
      name: "悬浮在其他窗口之上",
      askVerb: "悬浮在其他窗口之上",
      description: "允许此应用页在其他窗口上方绘制内容，并读取屏幕上的鼠标位置。",
    },
    "menu-bar": {
      name: "系统托盘图标",
      askVerb: "在系统托盘添加图标",
      description:
        process.platform === "darwin"
          ? "允许此应用页在打开时向 macOS 菜单栏添加菜单项。"
          : "安装后，关闭窗口时它会在系统托盘中继续运行。",
    },
    "full-access": {
      name: "完全电脑访问权限",
      askVerb: "在此电脑上运行命令",
      description: "允许此应用页运行程序，并读取、修改或删除您电脑上的文件，无需再次询问。",
    },
  };

export interface InstallConfirmDialogInput {
  readonly appName: string;
}

export interface InstallCompleteDialogInput {
  readonly appName: string;
  readonly places?: readonly ("start-menu" | "desktop" | "applications")[];
}

export interface AlreadyInstalledDialogInput {
  readonly appName: string;
}

export interface PermissionRequestDialogInput {
  readonly appName: string;
  readonly permission: DesktopPageAppPermission;
  readonly isReapproval?: boolean;
  readonly trustKind?: DesktopPageAppTrustKind;
  readonly hasRefusedTier2?: boolean;
  readonly ownerName?: string;
}

export interface PermissionsManagerItem {
  readonly permission: DesktopPageAppPermission;
  readonly state: DesktopPageAppPermissionAnswer;
  readonly declared: boolean;
  readonly coveredByFullAccess?: boolean;
  readonly endsOverlay?: boolean;
}

export interface PermissionsManagerDialogInput {
  readonly appName: string;
  readonly items: readonly PermissionsManagerItem[];
  readonly hasActiveRunningApp?: boolean;
  readonly unavailableReason?: "none" | "unavailable" | "owned-elsewhere";
  readonly policyBlockedPermissions?: readonly DesktopPageAppPermission[];
}

export interface ReloadConfirmDialogInput {
  readonly appName: string;
}

export interface UnavailableDialogInput {
  readonly appName: string;
}

export interface UninstallConfirmDialogInput {
  readonly appName: string;
  readonly isOpen?: boolean;
}

export interface ErrorDialogInput {
  readonly title: string;
  readonly body: string;
  readonly size?: "sm" | "md";
}

export interface AboutDialogInput {
  readonly appName: string;
  readonly appId: string;
  readonly revision: number;
  readonly referenceText: string;
  readonly attribution?: string;
  readonly whenText?: string;
  readonly trustDisclaimer?: string;
  readonly gone?: boolean;
}

export interface DialogButtonSpec {
  readonly id: string;
  readonly label: string;
  readonly role: "cancel" | "primary" | "danger" | "secondary";
  readonly guarded?: boolean;
  readonly autofocus?: boolean;
}

export interface DialogSpec {
  readonly kind: string;
  readonly size?: "sm" | "md";
  readonly title: string;
  readonly badge?: string;
  readonly body: string;
  readonly tileIcon?: "trash" | "warning";
  readonly warningTone?: "yellow" | "red";
  readonly warningTitle?: string;
  readonly warningText?: string;
  readonly checkboxLabel?: string;
  readonly reapprovalBanner?: string;
  readonly permissionToggles?: readonly (PermissionsManagerItem & {
    readonly followsIndex?: number;
  })[];
  readonly reloadHint?: string;
  readonly detailMonospace?: string;
  readonly buttons: readonly DialogButtonSpec[];
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resolveInstallPlacesDetail(
  places?: readonly ("start-menu" | "desktop" | "applications")[],
): string {
  if (!places || places.length === 0) {
    return process.platform === "darwin"
      ? "现在可以在“应用程序 / Moss Apps”中打开它。"
      : "现在可以从“开始”菜单或桌面直接打开它。";
  }
  if (places.includes("start-menu") && places.includes("desktop")) {
    return "可以从“开始”菜单或桌面打开它。";
  }
  if (places.includes("desktop")) {
    return "可以从桌面打开它。";
  }
  if (places.includes("applications")) {
    return "可以从“应用程序 / Moss Apps”文件夹打开它。";
  }
  return "可以从“开始”菜单打开它。";
}

/** Builds the dialog spec for installing an app page as a standalone desktop app. */
export function buildInstallConfirmDialogSpec(input: InstallConfirmDialogInput): DialogSpec {
  return {
    kind: "install-confirm",
    size: "md",
    title: `将“${input.appName}”安装为应用？`,
    badge: "测试版",
    body: `如果继续，“${input.appName}”将作为独立程序安装，拥有独立窗口和用于打开它的快捷方式。未经您的允许，它无法访问您的文件或运行程序。`,
    buttons: [
      { id: "cancel", label: "取消", role: "cancel", autofocus: true },
      { id: "install", label: "安装", role: "primary", guarded: true },
    ],
  };
}

export function buildInstallCompleteDialogSpec(input: InstallCompleteDialogInput): DialogSpec {
  return {
    kind: "install-complete",
    size: "sm",
    title: `已安装 “${input.appName}”。`,
    body: resolveInstallPlacesDetail(input.places),
    buttons: [
      { id: "show-in-folder", label: "在文件夹中显示", role: "secondary" },
      { id: "ok", label: "好", role: "primary", autofocus: true },
    ],
  };
}

export function buildAlreadyInstalledDialogSpec(input: AlreadyInstalledDialogInput): DialogSpec {
  return {
    kind: "already-installed",
    size: "sm",
    title: `“${input.appName}” 已安装。`,
    body: "您可以直接打开此独立应用，或在文件夹中查看快捷方式。",
    buttons: [
      { id: "close", label: "关闭", role: "cancel", autofocus: true },
      { id: "show-in-folder", label: "在文件夹中显示", role: "secondary" },
      { id: "open", label: "打开应用", role: "primary" },
    ],
  };
}

/**
 * Builds Tier 2 / Tier 3 / update re-approval permission request dialog specs aligned with
 * Claude Desktop `Ns` / `Ms` / `js` in `UJzilp8j`.
 */
export function buildPermissionRequestDialogSpec(input: PermissionRequestDialogInput): DialogSpec {
  const copy = PERMISSION_COPY_ZH[input.permission];
  const isFullAccess = input.permission === "full-access";
  const trustKind: DesktopPageAppTrustKind = input.trustKind ?? "owner";
  const reapprovalBanner = input.isReapproval
    ? "自您授予此权限以来，此应用页已有更新，因此需要再次征求您的同意。"
    : undefined;
  const title = input.isReapproval
    ? `是否继续允许 “${input.appName}” ${copy.askVerb}？`
    : `允许 “${input.appName}” ${copy.askVerb}？`;

  if (isFullAccess) {
    if (trustKind === "untrusted") {
      return {
        kind: "permission-tier3-refused",
        size: "sm",
        title: `Moss 无法授予 “${input.appName}” 完全电脑访问权限`,
        body: "Moss 无法确认此应用页的创建者或组织归属，因此不能授予它完全电脑访问权限。您仍可在没有完全访问权限的情况下继续使用此应用。",
        buttons: [{ id: "ok", label: "好", role: "primary", autofocus: true }],
      };
    }

    const cascadeHint =
      "开启完全访问权限期间，此应用还可以发送通知、使用全局快捷键、悬浮在其他窗口之上以及添加系统托盘图标。";
    const refusedHint = input.hasRefusedTier2 ? "您此前拒绝的权限仍将保持关闭。" : "";
    const endableHint = "您可以随时在应用的“权限…”设置中关闭完全访问权限。";
    const fullBodyTail = [cascadeHint, refusedHint, endableHint].filter(Boolean).join(" ");

    if (trustKind === "owner") {
      return {
        kind: "permission-tier3",
        size: "sm",
        title,
        ...(reapprovalBanner ? { reapprovalBanner } : {}),
        body: `此应用由您创建。${copy.description}\n\n${fullBodyTail}`,
        buttons: [
          { id: "deny", label: "不允许", role: "cancel", autofocus: true },
          { id: "allow", label: "允许", role: "primary", guarded: true },
        ],
      };
    }

    if (trustKind === "workspace") {
      const ownership = input.ownerName
        ? `此应用归您所在组织中的 ${input.ownerName} 所有。`
        : "此应用归您所在组织成员所有，部分内容可能由协作人员贡献。";
      return {
        kind: "permission-tier3",
        size: "md",
        title,
        ...(reapprovalBanner ? { reapprovalBanner } : {}),
        body: fullBodyTail,
        warningTone: "yellow",
        warningTitle: "这将授予它对您电脑的完全访问权限",
        warningText: `${ownership}${copy.description} 仅当您信任此应用的贡献者与数据来源时再允许。`,
        buttons: [
          { id: "deny", label: "不允许", role: "cancel", autofocus: true },
          { id: "allow", label: "允许", role: "primary", guarded: true },
        ],
      };
    }

    // external -> red warning banner, danger button, mandatory confirmation switch
    return {
      kind: "permission-tier3",
      size: "md",
      title,
      ...(reapprovalBanner ? { reapprovalBanner } : {}),
      body: fullBodyTail,
      warningTone: "red",
      warningTitle: "警告：此应用来自外部或未经审核来源",
      warningText:
        "如果在此授予完全访问权限，此应用可运行任意程序并读取、修改或删除您的文件。仅当您信任此应用的作者时再允许。",
      checkboxLabel: "我了解此应用未经 Moss 审核。",
      buttons: [
        { id: "deny", label: "不允许", role: "cancel", autofocus: true },
        { id: "allow", label: "允许", role: "danger", guarded: true },
      ],
    };
  }

  // Tier 2 permissions
  const tier2Tail = "您可以随时在应用的“权限…”设置中更改此项。";

  if (trustKind === "external" || trustKind === "untrusted") {
    return {
      kind: "permission-tier2",
      size: "md",
      title,
      ...(reapprovalBanner ? { reapprovalBanner } : {}),
      body: tier2Tail,
      warningTone: "red",
      warningTitle:
        trustKind === "external"
          ? "警告：此应用来自外部或未经审核来源"
          : "警告：此应用来自未知来源",
      warningText: `${copy.description} 仅当您信任此应用的作者与来源时再允许。`,
      buttons: [
        { id: "deny", label: "不允许", role: "cancel", autofocus: true },
        { id: "allow", label: "允许", role: "danger", guarded: true },
      ],
    };
  }

  return {
    kind: "permission-tier2",
    size: "sm",
    title,
    ...(reapprovalBanner ? { reapprovalBanner } : {}),
    body: `${copy.description} ${tier2Tail}`,
    buttons: [
      { id: "deny", label: "不允许", role: "cancel", autofocus: true },
      { id: "allow", label: "允许", role: "primary", guarded: true },
    ],
  };
}

/**
 * Builds the Permissions Manager modal spec (`Us` in `UJzilp8j`): hides undeclared/unavailable
 * switches, supports bidirectional `data-follows` linkage with `full-access`, and renders a
 * single-button view when zero permissions are available to manage.
 */
export function buildPermissionsManagerDialogSpec(
  input: PermissionsManagerDialogInput,
): DialogSpec {
  const visibleItems = input.items.filter((item) => item.declared && item.state !== "unavailable");
  const fullIndex = visibleItems.findIndex((item) => item.permission === "full-access");
  const fullGranted = fullIndex >= 0 && visibleItems[fullIndex]?.state === "granted";

  const toggles = visibleItems.map((item, idx) => {
    const granted = item.state === "granted";
    const canFollow =
      fullIndex >= 0 &&
      idx !== fullIndex &&
      item.permission !== "full-access" &&
      item.state !== "denied" &&
      granted === fullGranted;
    return {
      ...item,
      ...(canFollow ? { followsIndex: fullIndex } : {}),
    };
  });

  const policyNames = (input.policyBlockedPermissions ?? []).map(
    (perm) => PERMISSION_COPY_ZH[perm].name,
  );
  let body = "";
  if (input.unavailableReason === "owned-elsewhere") {
    body =
      "另一个工作区或组织拥有此应用，因此当前无可用权限。您可以不使用权限继续使用，或在对应工作区重新安装。";
  } else if (policyNames.length > 0) {
    body = `您的组织策略不允许以下权限：${policyNames.join("、")}。`;
  } else if (visibleItems.length === 0) {
    body =
      input.unavailableReason === "unavailable"
        ? "此应用当前处于加载、未登录或版本更新状态，暂时无法更改权限。已授予的权限可能仍在生效。"
        : "此应用未请求任何可在此处更改的权限。";
  }

  const hasAny = visibleItems.length > 0;
  return {
    kind: "permissions-manager",
    size: "md",
    title: `“${input.appName}” 的权限`,
    body,
    permissionToggles: toggles,
    ...(hasAny && input.hasActiveRunningApp
      ? {
          reloadHint:
            "关闭悬浮窗或完全访问权限后，应用页窗口可能需要重新加载或关闭，未保存的工作可能会丢失。",
        }
      : {}),
    buttons: hasAny
      ? [
          { id: "cancel", label: "取消", role: "cancel", autofocus: true },
          { id: "save", label: "保存", role: "primary", guarded: true },
        ]
      : [{ id: "ok", label: "好", role: "primary", autofocus: true }],
  };
}

export function buildReloadConfirmDialogSpec(input: ReloadConfirmDialogInput): DialogSpec {
  return {
    kind: "reload-confirm",
    size: "sm",
    title: `要重新加载 “${input.appName}” 吗？`,
    body: "此应用页在打开期间已有更新，需要重新加载后才能使用已授予的权限。尚未保存的更改可能会丢失。",
    buttons: [
      { id: "later", label: "取消", role: "cancel", autofocus: true },
      { id: "reload", label: "重新加载", role: "primary", guarded: true },
    ],
  };
}

export function buildUnavailableDialogSpec(input: UnavailableDialogInput): DialogSpec {
  return {
    kind: "app-unavailable",
    size: "sm",
    title: `“${input.appName}” 已不可用`,
    body: "此应用页已被删除或不再对您分享，因此无法打开。卸载将移除其快捷方式并关闭此窗口。",
    tileIcon: "trash",
    buttons: [
      { id: "keep", label: "保留", role: "cancel", autofocus: true },
      { id: "uninstall", label: "卸载", role: "danger", guarded: true },
    ],
  };
}

export function buildUninstallConfirmDialogSpec(input: UninstallConfirmDialogInput): DialogSpec {
  const isOpen = input.isOpen ?? false;
  const body =
    process.platform === "darwin"
      ? isOpen
        ? "它将被移入废纸篓，此窗口也会随之关闭。如果它还在程序坞中，请一并拖出。"
        : "它将被移入废纸篓。如果它还在程序坞中，请一并拖出。"
      : isOpen
        ? "它的快捷方式将被移除，此窗口也会随之关闭。如果已固定到任务栏或“开始”菜单，也请一并取消固定。"
        : "它的快捷方式将被移除。如果已固定到任务栏或“开始”菜单，也请一并取消固定。";

  return {
    kind: "uninstall-confirm",
    size: "sm",
    title: `要卸载 “${input.appName}” 吗？`,
    body,
    tileIcon: "trash",
    buttons: [
      { id: "cancel", label: "取消", role: "cancel", autofocus: true },
      { id: "uninstall", label: "卸载", role: "danger", guarded: true },
    ],
  };
}

export function buildErrorDialogSpec(input: ErrorDialogInput): DialogSpec {
  return {
    kind: "error",
    size: input.size ?? "sm",
    title: input.title,
    body: input.body,
    tileIcon: "warning",
    buttons: [{ id: "ok", label: "好", role: "primary", autofocus: true }],
  };
}

export function buildAboutDialogSpec(input: AboutDialogInput): DialogSpec {
  const parts: string[] = [];
  if (input.gone) {
    parts.push("此应用页已不可用，无法获取其作者与归属信息。");
  } else {
    parts.push(input.attribution ?? `来自 Moss 的独立应用页（版本 r${input.revision}）。`);
    if (input.whenText) parts.push(input.whenText);
  }
  parts.push(
    input.trustDisclaimer ??
      `运行地址：${input.referenceText}。Moss 将其在独立窗口中显示，具体功能由应用页作者决定。`,
  );
  return {
    kind: "about-app",
    size: "md",
    title: `关于 “${input.appName}”`,
    body: parts.join("\n\n"),
    detailMonospace: input.referenceText,
    buttons: [{ id: "close", label: "好", role: "primary", autofocus: true }],
  };
}

const DIALOG_CSS = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #0b0b0b;
  --dim: #52514e;
  --tile: rgb(11 11 11 / 5%);
  --ring: rgb(11 11 11 / 10%);
  --second: #ffffff;
  --second-hover: rgb(11 11 11 / 5%);
  --primary: #0b0b0b;
  --primary-hover: #2c2c2a;
  --on-primary: #ffffff;
  --warn: #f9dca4;
  --warn-fg: #734500;
  --focus: #256abf;
  --danger: #fad6d6;
  --danger-fg: #8e2626;
  --danger-fill: #d03b3b;
  --danger-fill-hover: #e34948;
  --on-danger: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1a19;
    --fg: #f0efec;
    --dim: #c3c2b7;
    --tile: rgb(255 255 255 / 5%);
    --ring: rgb(255 255 255 / 12%);
    --second: rgb(255 255 255 / 10%);
    --second-hover: rgb(255 255 255 / 14%);
    --primary: #ffffff;
    --primary-hover: #e1e0d9;
    --on-primary: #0b0b0b;
    --warn: #311a00;
    --warn-fg: #db9300;
    --focus: #3987e5;
    --danger: #3c0e0e;
    --danger-fg: #ec7e7e;
  }
}
html.theme-dark {
  --bg: #1a1a19;
  --fg: #f0efec;
  --dim: #c3c2b7;
  --tile: rgb(255 255 255 / 5%);
  --ring: rgb(255 255 255 / 12%);
  --second: rgb(255 255 255 / 10%);
  --second-hover: rgb(255 255 255 / 14%);
  --primary: #ffffff;
  --primary-hover: #e1e0d9;
  --on-primary: #0b0b0b;
  --warn: #311a00;
  --warn-fg: #db9300;
  --focus: #3987e5;
  --danger: #3c0e0e;
  --danger-fg: #ec7e7e;
}
html { scrollbar-color: GrayText transparent; }
* { box-sizing: border-box; }
html, body { margin: 0; }
::-webkit-scrollbar { display: none; }
body {
  background: var(--bg);
  color: var(--fg);
  min-height: 100vh;
  padding: 20px 22px;
  box-shadow: inset 0 0 0 1px var(--ring);
  user-select: none;
  cursor: default;
  font: 400 13.5px/20px "Inter Variable", -apple-system, BlinkMacSystemFont, "Microsoft YaHei UI", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  overflow-wrap: anywhere;
}
[role="dialog"]:focus { outline: none; }
h1 {
  margin: 0 0 10px;
  font-size: 16px;
  line-height: 23px;
  font-weight: 560;
  app-region: drag;
}
.badge {
  display: inline-block;
  padding: 0 7px;
  margin-left: 4px;
  border-radius: 999px;
  background: var(--tile);
  color: var(--dim);
  font-size: 11px;
  line-height: 18px;
  font-weight: 500;
  white-space: nowrap;
  vertical-align: 1px;
}
p { margin: 0; }
.body { display: flex; flex-direction: column; gap: 20px; }
.row { display: flex; align-items: flex-start; gap: 12px; }
.tile {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  background: var(--tile);
  color: var(--dim);
}
.text { display: flex; flex-direction: column; gap: 8px; min-width: 0; color: var(--dim); }
.note { font-size: 12px; line-height: 15px; }
.warn { padding: 12px; border-radius: 8px; background: var(--warn); }
.warn svg { color: var(--warn-fg); }
.warn div { display: flex; flex-direction: column; gap: 4px; }
.warn b { font-size: 14px; line-height: 18px; font-weight: 580; color: var(--warn-fg); }
.warn span { color: var(--warn-fg); font-size: 12.5px; line-height: 18px; }
.danger {
  --warn: var(--danger);
  --warn-fg: var(--danger-fg);
  --primary: var(--danger-fill);
  --primary-hover: var(--danger-fill-hover);
  --on-primary: var(--on-danger);
}
svg {
  flex-shrink: 0;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.25;
  stroke-linecap: round;
  stroke-linejoin: round;
}
svg circle { fill: currentColor; }
.mono-box {
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--tile);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 17px;
  color: var(--dim);
  user-select: text;
  word-break: break-all;
}
.switches {
  display: flex;
  flex-direction: column;
  margin-top: 16px;
  border-top: 1px solid var(--tile);
}
.switch {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--tile);
  cursor: pointer;
}
.switch span {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  color: var(--dim);
  font-size: 12px;
  line-height: 15px;
}
.switch b {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  line-height: 19px;
  font-weight: 500;
  color: var(--fg);
}
.perm-tag {
  font-size: 11px;
  line-height: 16px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--tile);
  color: var(--dim);
  font-weight: 500;
}
.switch input {
  appearance: none;
  flex-shrink: 0;
  width: 32px;
  height: 18px;
  margin: 0;
  border-radius: 9px;
  background: rgb(11 11 11 / 20%);
  cursor: pointer;
  transition: background 0.15s;
  scroll-margin-bottom: 72px;
}
.switch input::before {
  content: "";
  display: block;
  width: 14px;
  height: 14px;
  margin: 2px;
  border-radius: 7px;
  background: #ffffff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
  transition: margin 0.15s;
}
.switch input:checked { background: var(--primary); }
.switch input:checked::before { margin-left: 16px; background: var(--on-primary); }
html.theme-dark .switch input { background: rgb(255 255 255 / 20%); }
@media (prefers-color-scheme: dark) {
  .switch input { background: rgb(255 255 255 / 20%); }
}
footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  position: sticky;
  bottom: 0;
  background: var(--bg);
  margin: 16px 0 -20px;
  padding: 10px 0 20px;
  animation: more linear both;
  animation-timeline: scroll();
}
@keyframes more {
  0%, 99% { box-shadow: 0 -1px var(--dim); }
}
button {
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
  height: 30px;
  padding: 0 14px;
  border: 0;
  border-radius: 8px;
  background: var(--second);
  box-shadow: inset 0 0 0 1px var(--ring);
  cursor: pointer;
}
button:hover { background: var(--second-hover); }
button.primary {
  background: var(--primary);
  color: var(--on-primary);
  box-shadow: none;
}
button.primary:hover { background: var(--primary-hover); }
button.danger {
  background: var(--danger-fill);
  color: var(--on-danger);
  box-shadow: none;
}
button.danger:hover { background: var(--danger-fill-hover); }
button:disabled { opacity: 0.4; pointer-events: none; }
button:focus:not(:focus-visible) { outline: none; }
button:focus-visible, .switch input:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
[data-waiting] button[data-guarded="1"],
[data-waiting] .switch input { opacity: 0.4; }
@media (forced-colors: active) {
  .badge { outline: 1px solid CanvasText; }
  button, .warn, .switch input { border: 1px solid ButtonText; }
  footer { border-top: 1px solid; }
  button:disabled { opacity: 1; border-color: GrayText; }
  .switch input::before { margin: 1px; background: ButtonText; }
  .switch input:checked { background: Highlight; border-color: Highlight; }
  .switch input:checked::before { margin-left: 15px; background: HighlightText; }
}
`;

function renderBodyParagraphs(body: string): string {
  return body
    .split(/\n\s*\n/u)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
}

/** Renders self-contained HTML/CSS/JS for a frameless modal dialog aligned with Claude REA `UJzilp8j`. */
export function renderPageAppDialogHtml(
  spec: DialogSpec,
  options: { readonly dark?: boolean; readonly cooldownMs?: number } = {},
): string {
  const cooldownMs = options.cooldownMs ?? PAGE_APP_DIALOG_COOLDOWN_MS;
  const themeClass = options.dark ? "theme-dark" : "theme-light";
  const bodyDangerClass = spec.warningTone === "red" ? ' class="danger"' : "";
  const cancelBtn = spec.buttons.find((b) => b.role === "cancel");
  const cancelId = cancelBtn?.id ?? spec.buttons[0]?.id ?? "cancel";
  const defaultBtnId =
    spec.buttons.find((b) => b.autofocus)?.id ?? cancelBtn?.id ?? spec.buttons[0]?.id ?? "";

  const badgeHtml = spec.badge ? `&ensp;<span class="badge">${escapeHtml(spec.badge)}</span>` : "";

  const bodyBlocks: string[] = [];
  if (spec.warningText) {
    const warnTitle =
      spec.warningTitle ?? (spec.warningTone === "red" ? "高危权限提示" : "安全提示");
    bodyBlocks.push(
      `<div class="row warn">${SHIELD_WARNING_SVG}<div><b>${escapeHtml(warnTitle)}</b><span>${escapeHtml(spec.warningText)}</span></div></div>`,
    );
  }
  if (spec.reapprovalBanner) {
    bodyBlocks.push(`<div class="text"><p>${escapeHtml(spec.reapprovalBanner)}</p></div>`);
  }
  const paragraphs = renderBodyParagraphs(spec.body);
  if (paragraphs) {
    if (spec.tileIcon === "trash" || spec.tileIcon === "warning") {
      const iconSvg = spec.tileIcon === "trash" ? TRASH_ICON_SVG : WARNING_TRIANGLE_SVG;
      bodyBlocks.push(
        `<div class="row"><div class="tile">${iconSvg}</div><div class="text">${paragraphs}</div></div>`,
      );
    } else {
      bodyBlocks.push(`<div class="text${spec.warningText ? " note" : ""}">${paragraphs}</div>`);
    }
  }
  if (spec.detailMonospace) {
    bodyBlocks.push(`<div class="mono-box">${escapeHtml(spec.detailMonospace)}</div>`);
  }
  if (spec.reloadHint) {
    bodyBlocks.push(`<div class="text note"><p>${escapeHtml(spec.reloadHint)}</p></div>`);
  }

  const hasBody = bodyBlocks.length > 0;
  const switchRows: string[] = [];
  if (spec.checkboxLabel) {
    switchRows.push(
      `<label class="switch"><span><b>${escapeHtml(spec.checkboxLabel)}</b></span><input id="ack-checkbox" type="checkbox" role="switch" required aria-invalid="false" /></label>`,
    );
  }
  if (spec.permissionToggles) {
    for (const item of spec.permissionToggles) {
      const copy = PERMISSION_COPY_ZH[item.permission];
      const checked = item.state === "granted" ? " checked" : "";
      const followsAttr =
        item.followsIndex !== undefined ? ` data-follows="${item.followsIndex}"` : "";
      const tag =
        item.state === "denied"
          ? '<span class="perm-tag">已拒绝</span>'
          : item.coveredByFullAccess
            ? '<span class="perm-tag">随完全访问开启</span>'
            : "";
      const desc = item.coveredByFullAccess
        ? `${copy.description}（当前由完全电脑访问权限覆盖）`
        : item.endsOverlay && item.permission === "full-access"
          ? `${copy.description} 关闭后可能使悬浮窗重载或关闭。`
          : copy.description;
      switchRows.push(
        `<label class="switch">` +
          `<span><b>${escapeHtml(copy.name)}${tag}</b>${escapeHtml(desc)}</span>` +
          `<input type="checkbox" role="switch" class="perm-switch" data-permission="${escapeHtml(item.permission)}" data-explicit-denied="${item.state === "denied" ? "1" : "0"}"${checked}${followsAttr} />` +
          `</label>`,
      );
    }
  }
  const switchesHtml =
    switchRows.length > 0 ? `<div class="switches">${switchRows.join("")}</div>` : "";

  const orderedButtons = cancelBtn
    ? [cancelBtn, ...spec.buttons.filter((b) => b !== cancelBtn)]
    : [...spec.buttons];

  const buttonsHtml = orderedButtons
    .map((btn) => {
      const roleClass =
        btn.role === "primary" ? "primary" : btn.role === "danger" ? "danger" : "secondary";
      const classes = [roleClass].filter(Boolean).join(" ");
      const isDefault = btn.id === defaultBtnId;
      const focusAttrs = isDefault ? ` autofocus${hasBody ? ' aria-describedby="body"' : ""}` : "";
      return `<button type="button" class="${classes}" data-button-id="${escapeHtml(btn.id)}" ${btn.guarded ? 'data-guarded="1"' : ""}${focusAttrs}>${escapeHtml(btn.label)}</button>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN" class="${themeClass}">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(spec.title)}</title>
<style>${DIALOG_CSS}</style>
</head>
<body data-cancel="${escapeHtml(cancelId)}"${bodyDangerClass}>
  <div role="dialog" aria-modal="true" aria-labelledby="dialog-title" data-dialog-kind="${escapeHtml(spec.kind)}">
    <h1 id="dialog-title">${escapeHtml(spec.title)}${badgeHtml}</h1>
    ${hasBody ? `<div class="body" id="body">${bodyBlocks.join("")}</div>` : ""}
    ${switchesHtml}
    <footer role="none">${buttonsHtml}</footer>
  </div>
<script>
(function () {
  var COOLDOWN_MS = ${Math.max(0, cooldownMs)};
  var submitNonce = 0;
  var cancelId = document.body.dataset.cancel || "cancel";
  var switches = Array.prototype.slice.call(document.querySelectorAll(".perm-switch"));
  var following = new Set(switches.filter(function (el) { return el.dataset.follows !== undefined; }));
  switches.forEach(function (box) {
    box.addEventListener("change", function () {
      if (box.dataset.follows !== undefined) {
        var leader = switches[Number(box.dataset.follows)];
        if (leader && leader.checked === box.checked) following.add(box);
        else following.delete(box);
      }
      following.forEach(function (other) {
        if (switches[Number(other.dataset.follows)] === box) {
          other.checked = box.checked;
        }
      });
    });
  });

  var required = Array.prototype.slice.call(document.querySelectorAll("input[required]"));
  var buttons = Array.prototype.slice.call(document.querySelectorAll("[data-button-id]"));
  var shownAt = Infinity;
  var settled = function (at) { return at - shownAt >= COOLDOWN_MS; };
  var dim = function (on) {
    document.body.toggleAttribute("data-waiting", Boolean(on && buttons.length > 1));
  };
  dim(true);
  var undimTimer = null;
  var wait = function (from, dims) {
    if (dims === void 0) dims = true;
    shownAt = from;
    if (dims) dim(true);
    clearTimeout(undimTimer);
    undimTimer = setTimeout(function () { dim(false); }, COOLDOWN_MS);
  };

  var pressedAt = null;
  var keyWentDownAt = -Infinity;
  addEventListener("pointerdown", function () {
    pressedAt = performance.now();
    if (shownAt !== Infinity && !settled(pressedAt)) wait(pressedAt, true);
  }, true);
  addEventListener("mousedown", function (event) {
    if (!settled(performance.now())) event.preventDefault();
  }, true);
  addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      event.preventDefault();
      submitResult(cancelId);
    } else if (event.key === "Tab") {
      if (shownAt !== Infinity) wait(performance.now(), false);
    } else if (event.key === "Enter" || event.key === " ") {
      if (!event.repeat) {
        keyWentDownAt = performance.now();
        if (shownAt !== Infinity && !settled(keyWentDownAt)) wait(keyWentDownAt, true);
      }
      pressedAt = keyWentDownAt;
    }
  }, true);

  function syncRequired() {
    var missingRequired = required.some(function (box) { return !box.checked; });
    buttons.forEach(function (btn) {
      if (btn.dataset.buttonId !== cancelId) {
        btn.disabled = missingRequired;
      }
    });
  }
  syncRequired();
  required.forEach(function (box) { box.addEventListener("change", syncRequired); });

  function submitResult(buttonId) {
    var grants = {};
    switches.forEach(function (el) {
      grants[el.getAttribute("data-permission")] = following.has(el) ? null : Boolean(el.checked);
    });
    var payload = {
      buttonId: buttonId,
      acknowledged: !required.some(function (box) { return !box.checked; }),
      grants: switches.length > 0 ? grants : undefined,
      nonce: ++submitNonce
    };
    document.title = "${DIALOG_RESULT_TITLE_PREFIX}" + JSON.stringify(payload);
  }

  buttons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      var isGuarded = btn.getAttribute("data-guarded") === "1";
      if (!isGuarded || settled(pressedAt !== null ? pressedAt : performance.now())) {
        submitResult(btn.getAttribute("data-button-id"));
      }
    });
  });
  Array.prototype.slice.call(document.querySelectorAll(".switch")).forEach(function (row) {
    row.addEventListener("click", function (event) {
      if (!settled(pressedAt !== null ? pressedAt : performance.now())) {
        event.preventDefault();
      }
    });
  });
  addEventListener("click", function (event) {
    var on = event.target instanceof Element ? event.target : null;
    if (!on || on.matches("input") || !on.closest(".switch")) pressedAt = null;
  });

  window.__resetMossDialogCooldown = function () {
    wait(performance.now(), true);
  };
  window.__measureMossDialog = function () {
    return {
      width: window.innerWidth,
      height: window.innerHeight,
      needed: Math.ceil(document.documentElement.getBoundingClientRect().height)
    };
  };
  wait(performance.now(), true);
})();
</script>
</body>
</html>`;
}

export interface DialogRawSubmission {
  readonly buttonId: string;
  readonly acknowledged: boolean;
  readonly grants?: Readonly<Record<string, boolean | null>>;
  readonly unanswered?: boolean;
}

export interface PermissionsManagerOutcome {
  readonly saved: boolean;
  readonly grants: Partial<Record<DesktopPageAppPermission, boolean | null>>;
}

export interface PageAppDialogHost {
  confirmInstall(input: InstallConfirmDialogInput, parent?: BrowserWindow | null): Promise<boolean>;
  showInstallComplete(
    input: InstallCompleteDialogInput,
    parent?: BrowserWindow | null,
  ): Promise<"ok" | "show-in-folder">;
  showAlreadyInstalled(
    input: AlreadyInstalledDialogInput,
    parent?: BrowserWindow | null,
  ): Promise<"open" | "show-in-folder" | "close">;
  confirmPermission(
    input: PermissionRequestDialogInput,
    parent?: BrowserWindow | null,
  ): Promise<boolean>;
  managePermissions(
    input: PermissionsManagerDialogInput,
    parent?: BrowserWindow | null,
  ): Promise<PermissionsManagerOutcome>;
  confirmReload(input: ReloadConfirmDialogInput, parent?: BrowserWindow | null): Promise<boolean>;
  showUnavailable(
    input: UnavailableDialogInput,
    parent?: BrowserWindow | null,
  ): Promise<"uninstall" | "keep">;
  confirmUninstall(
    input: UninstallConfirmDialogInput,
    parent?: BrowserWindow | null,
  ): Promise<boolean>;
  showAbout(input: AboutDialogInput, parent?: BrowserWindow | null): Promise<void>;
  showError?(input: ErrorDialogInput, parent?: BrowserWindow | null): Promise<void>;
}

interface MeasuredDialogSize {
  readonly width: number;
  readonly height: number;
  readonly needed: number;
}

async function fitDialogWindowToDom(
  modal: BrowserWindow,
  targetWidth: number,
  parentWindow: BrowserWindow | null,
): Promise<void> {
  if (modal.isDestroyed()) return;
  const referenceBounds =
    parentWindow && !parentWindow.isDestroyed() ? parentWindow.getBounds() : modal.getBounds();
  const workAreaHeight = screen.getDisplayMatching(referenceBounds).workArea.height || 800;

  let measured = (await modal.webContents
    .executeJavaScript("window.__measureMossDialog && window.__measureMossDialog()")
    .catch(() => null)) as MeasuredDialogSize | null;
  if (
    !measured ||
    !Number.isFinite(measured.width) ||
    !Number.isFinite(measured.height) ||
    !Number.isFinite(measured.needed)
  ) {
    return;
  }

  for (let pass = 0; pass < DIALOG_MEASURE_MAX_PASSES; pass += 1) {
    if (modal.isDestroyed()) return;
    const chromeHeight = Math.max(0, modal.getBounds().height - measured.height);
    const maxHeight = Math.max(
      DIALOG_MIN_HEIGHT,
      Math.min(DIALOG_MAX_HEIGHT, workAreaHeight - chromeHeight),
    );
    const targetHeight = Math.max(DIALOG_MIN_HEIGHT, Math.min(maxHeight, measured.needed));
    if (measured.width === targetWidth && measured.height === targetHeight) {
      break;
    }
    const [contentWidth = targetWidth, contentHeight = measured.height] = modal.getContentSize();
    const deltaW = contentWidth - measured.width;
    const deltaH = contentHeight - measured.height;
    if (
      Math.abs(deltaW) > DIALOG_SIZE_SANITY_DELTA ||
      Math.abs(deltaH) > DIALOG_SIZE_SANITY_DELTA
    ) {
      break;
    }
    modal.setContentSize(targetWidth + deltaW, targetHeight + deltaH);
    const nextMeasured = (await modal.webContents
      .executeJavaScript("window.__measureMossDialog && window.__measureMossDialog()")
      .catch(() => null)) as MeasuredDialogSize | null;
    if (!nextMeasured || !Number.isFinite(nextMeasured.needed)) break;
    measured = nextMeasured;
  }

  if (modal.isDestroyed()) return;
  if (parentWindow && !parentWindow.isDestroyed()) {
    const parentBounds = parentWindow.getBounds();
    const modalBounds = modal.getBounds();
    const x = Math.round(parentBounds.x + (parentBounds.width - modalBounds.width) / 2);
    const y = Math.round(parentBounds.y + (parentBounds.height - modalBounds.height) / 2);
    modal.setPosition(x, y);
  } else {
    modal.center();
  }
}

export interface PresentDialogOptions {
  readonly cooldownMs?: number;
  readonly onDialogVisibilityChange?: (
    visible: boolean,
    parentWindow: BrowserWindow | null,
  ) => void;
}

/**
 * Presents a frameless modal BrowserWindow (`partition: "moss-app-dialog"`), fits its height
 * dynamically to rendered DOM content, suppresses host alwaysOnTop/ignoreMouseEvents while open,
 * and enforces the 500ms anti-misclick cooldown.
 */
export function presentElectronPageAppDialog(
  spec: DialogSpec,
  parentWindow: BrowserWindow | null = null,
  options: PresentDialogOptions = {},
): Promise<DialogRawSubmission> {
  const cooldownMs = options.cooldownMs ?? PAGE_APP_DIALOG_COOLDOWN_MS;
  const dark = nativeTheme.shouldUseDarkColors;
  const targetWidth = DIALOG_WIDTHS[spec.size ?? "md"];
  const html = renderPageAppDialogHtml(spec, { dark, cooldownMs });
  const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;

  return new Promise<DialogRawSubmission>((resolve) => {
    let settled = false;
    let hasShown = false;
    let lastCooldownAt = Date.now();
    const cancelId =
      spec.buttons.find((b) => b.role === "cancel")?.id ?? spec.buttons[0]?.id ?? "cancel";
    const guardedIds = new Set(spec.buttons.filter((b) => b.guarded).map((b) => b.id));

    options.onDialogVisibilityChange?.(true, parentWindow);

    const modal = new BrowserWindow({
      width: targetWidth,
      height: DIALOG_MIN_HEIGHT,
      useContentSize: true,
      frame: false,
      roundedCorners: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      show: false,
      backgroundColor: dark ? "#1a1a19" : "#ffffff",
      ...(parentWindow && !parentWindow.isDestroyed()
        ? { modal: true, parent: parentWindow }
        : { modal: false, center: true }),
      alwaysOnTop: true,
      skipTaskbar: true,
      webPreferences: {
        partition: PAGE_APP_DIALOG_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        webviewTag: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    const resetCooldown = () => {
      lastCooldownAt = Date.now();
      if (!modal.isDestroyed()) {
        void modal.webContents
          .executeJavaScript(
            "window.__resetMossDialogCooldown && window.__resetMossDialogCooldown()",
          )
          .catch(() => undefined);
      }
    };

    const onParentClosed = () =>
      finish({ buttonId: cancelId, acknowledged: false, unanswered: true });
    const rearmListener = () => {
      if (hasShown) resetCooldown();
    };

    const detachLifecycle = () => {
      for (const win of parentWindow && !parentWindow.isDestroyed()
        ? [parentWindow, modal]
        : [modal]) {
        if (!win.isDestroyed()) {
          win.removeListener("move", rearmListener);
          win.removeListener("show", rearmListener);
          win.removeListener("restore", rearmListener);
        }
      }
      if (parentWindow && !parentWindow.isDestroyed()) {
        parentWindow.removeListener("closed", onParentClosed);
      }
    };

    const finish = (submission: DialogRawSubmission) => {
      if (settled) return;
      settled = true;
      detachLifecycle();
      if (!modal.isDestroyed()) {
        modal.destroy();
      }
      options.onDialogVisibilityChange?.(false, parentWindow);
      resolve(submission);
    };

    for (const win of parentWindow && !parentWindow.isDestroyed()
      ? [parentWindow, modal]
      : [modal]) {
      win.on("move", rearmListener);
      win.on("show", rearmListener);
      win.on("restore", rearmListener);
    }
    if (parentWindow && !parentWindow.isDestroyed()) {
      parentWindow.once("closed", onParentClosed);
    }

    modal.on("unresponsive", () =>
      finish({ buttonId: cancelId, acknowledged: false, unanswered: true }),
    );
    modal.webContents.on("render-process-gone", () =>
      finish({ buttonId: cancelId, acknowledged: false, unanswered: true }),
    );
    modal.on("closed", () =>
      finish({
        buttonId: cancelId,
        acknowledged: false,
        ...(parentWindow?.isDestroyed() ? { unanswered: true } : {}),
      }),
    );

    modal.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    modal.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("data:text/html")) {
        event.preventDefault();
      }
    });

    modal.webContents.on("page-title-updated", (event, title) => {
      if (!title.startsWith(DIALOG_RESULT_TITLE_PREFIX)) return;
      event.preventDefault();
      try {
        const raw = title.slice(DIALOG_RESULT_TITLE_PREFIX.length);
        const parsed = JSON.parse(raw) as DialogRawSubmission;
        if (!parsed || typeof parsed.buttonId !== "string") return;

        if (guardedIds.has(parsed.buttonId) && Date.now() - lastCooldownAt < cooldownMs) {
          resetCooldown();
          return;
        }
        if (spec.checkboxLabel && guardedIds.has(parsed.buttonId) && !parsed.acknowledged) {
          return;
        }
        finish(parsed);
      } catch {
        // Ignore malformed submission payloads.
      }
    });

    modal.webContents.once("did-finish-load", () => {
      void fitDialogWindowToDom(modal, targetWidth, parentWindow)
        .catch(() => undefined)
        .finally(() => {
          if (settled || modal.isDestroyed()) return;
          hasShown = true;
          lastCooldownAt = Date.now();
          modal.show();
          modal.setAlwaysOnTop(true, "modal-panel");
          modal.focus();
          resetCooldown();
        });
    });

    void modal
      .loadURL(dataUrl)
      .catch(() => finish({ buttonId: cancelId, acknowledged: false, unanswered: true }));
  });
}

export function createElectronPageAppDialogHost(
  hostOptions: {
    readonly onDialogVisibilityChange?: (
      visible: boolean,
      parentWindow: BrowserWindow | null,
    ) => void;
  } = {},
): PageAppDialogHost {
  const presentOpts: PresentDialogOptions = hostOptions.onDialogVisibilityChange
    ? { onDialogVisibilityChange: hostOptions.onDialogVisibilityChange }
    : {};

  return {
    async confirmInstall(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildInstallConfirmDialogSpec(input),
        parent,
        presentOpts,
      );
      return result.buttonId === "install";
    },
    async showInstallComplete(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildInstallCompleteDialogSpec(input),
        parent,
        presentOpts,
      );
      return result.buttonId === "show-in-folder" ? "show-in-folder" : "ok";
    },
    async showAlreadyInstalled(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildAlreadyInstalledDialogSpec(input),
        parent,
        presentOpts,
      );
      if (result.buttonId === "open") return "open";
      if (result.buttonId === "show-in-folder") return "show-in-folder";
      return "close";
    },
    async confirmPermission(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildPermissionRequestDialogSpec(input),
        parent,
        presentOpts,
      );
      return result.buttonId === "allow";
    },
    async managePermissions(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildPermissionsManagerDialogSpec(input),
        parent,
        presentOpts,
      );
      const grants: Partial<Record<DesktopPageAppPermission, boolean | null>> = {};
      if (result.grants) {
        for (const perm of PAGE_APP_DESKTOP_PERMISSIONS) {
          const val = result.grants[perm];
          if (typeof val === "boolean" || val === null) {
            grants[perm] = val;
          }
        }
      }
      return {
        saved: result.buttonId === "save",
        grants,
      };
    },
    async confirmReload(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildReloadConfirmDialogSpec(input),
        parent,
        presentOpts,
      );
      return result.buttonId === "reload";
    },
    async showUnavailable(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildUnavailableDialogSpec(input),
        parent,
        presentOpts,
      );
      return result.buttonId === "uninstall" ? "uninstall" : "keep";
    },
    async confirmUninstall(input, parent = null) {
      const result = await presentElectronPageAppDialog(
        buildUninstallConfirmDialogSpec(input),
        parent,
        presentOpts,
      );
      return result.buttonId === "uninstall";
    },
    async showAbout(input, parent = null) {
      await presentElectronPageAppDialog(buildAboutDialogSpec(input), parent, presentOpts);
    },
    async showError(input, parent = null) {
      await presentElectronPageAppDialog(buildErrorDialogSpec(input), parent, presentOpts);
    },
  };
}
