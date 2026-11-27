// FILE: pageAppDesktop.ts
// Purpose: Shared contracts, permission tier model, schemas, IPC channels,
// and bridge interfaces for Moss 桌面独立应用页 (Desktop Page Apps).
// Layer: Shared contract

import { Schema } from "effect";

import { IsoDateTime, PositiveInt, SpaceId, TrimmedNonEmptyString } from "./baseSchemas";
import { PageAppCapabilities, PageAppId, PageAppPermissionState } from "./pageApps";

// ---------------------------------------------------------------------------
// Desktop Permissions & Tiers
// ---------------------------------------------------------------------------

/** 5 desktop permission names allowed inside a page app's manifest. */
export const PAGE_APP_DESKTOP_PERMISSIONS = [
  "notifications",
  "shortcuts",
  "overlay",
  "menu-bar",
  "full-access",
] as const;

export const PageAppDesktopPermission = Schema.Literals(PAGE_APP_DESKTOP_PERMISSIONS);
export type PageAppDesktopPermission = typeof PageAppDesktopPermission.Type;

export const PAGE_APP_DESKTOP_TIER1_CAPABILITIES = [
  "window.basic",
  "menu",
  "app.dock",
  "install",
  "permissions",
  "os.platform",
  "os.arch",
] as const;

export const PAGE_APP_DESKTOP_TIER2_PERMISSIONS = [
  "notifications",
  "shortcuts",
  "overlay",
  "menu-bar",
] as const;
export const PageAppDesktopTier2Permission = Schema.Literals(PAGE_APP_DESKTOP_TIER2_PERMISSIONS);
export type PageAppDesktopTier2Permission = typeof PageAppDesktopTier2Permission.Type;

export const PAGE_APP_DESKTOP_TIER3_PERMISSIONS = ["full-access"] as const;

export const PageAppDesktopPermissionTier = Schema.Literals([1, 2, 3]);
export type PageAppDesktopPermissionTier = typeof PageAppDesktopPermissionTier.Type;

export const PAGE_APP_DESKTOP_PERMISSION_TIERS: Readonly<
  Record<PageAppDesktopPermission, PageAppDesktopPermissionTier>
> = {
  notifications: 2,
  shortcuts: 2,
  overlay: 2,
  "menu-bar": 2,
  "full-access": 3,
};

export interface PageAppDesktopMethodTierSpec {
  readonly tier: PageAppDesktopPermissionTier;
  readonly permission?: PageAppDesktopPermission;
}

const METHOD_PERMISSION_TABLE: ReadonlyArray<
  readonly [
    PageAppDesktopPermissionTier,
    PageAppDesktopPermission | null,
    Readonly<Record<string, readonly string[]>>,
  ]
> = [
  [
    1,
    null,
    {
      window: [
        "setOptions",
        "getOptions",
        "place",
        "show",
        "hide",
        "focus",
        "close",
        "getBounds",
        "setBounds",
        "setDraggableRegions",
        "print",
      ],
      Menu: ["setApplicationMenu", "popup"],
      app: ["dock.setIcon", "dock.setBadge", "dock.setProgress", "dock.setMenu"],
      "app.dock": ["setIcon", "setBadge", "setProgress", "setMenu"],
      install: ["state", "status", "request"],
      os: ["platform", "arch"],
      permissions: ["state", "request", "manage", "declare"],
    },
  ],
  [
    2,
    "notifications",
    {
      notification: ["show"],
    },
  ],
  [
    2,
    "shortcuts",
    {
      globalShortcut: ["register"],
    },
  ],
  [
    2,
    null,
    {
      globalShortcut: ["unregister", "unregisterAll", "isRegistered"],
    },
  ],
  [
    2,
    "overlay",
    {
      window: ["setIgnoreMouseEvents", "setVisibleOnAllWorkspaces"],
      screen: [
        "getPrimaryDisplay",
        "getAllDisplays",
        "getDisplayNearestPoint",
        "getDisplayMatching",
        "getCursorScreenPoint",
      ],
    },
  ],
  [
    2,
    "menu-bar",
    {
      tray: ["set"],
    },
  ],
  [
    2,
    null,
    {
      tray: ["remove"],
    },
  ],
  [
    3,
    "full-access",
    {
      fs: [
        "readFile",
        "writeFile",
        "appendFile",
        "readdir",
        "stat",
        "lstat",
        "exists",
        "access",
        "mkdir",
        "rm",
        "rmdir",
        "rename",
        "copyFile",
        "realpath",
      ],
      os: ["info"],
      shell: ["openPath", "showItemInFolder", "trashItem", "openExternal"],
      childProcess: ["exec", "spawn", "write", "end", "endStdin", "kill"],
      pty: ["spawn", "write", "resize", "kill"],
    },
  ],
];

export const PAGE_APP_DESKTOP_METHOD_PERMISSIONS: ReadonlyMap<
  string,
  PageAppDesktopMethodTierSpec
> = new Map(
  METHOD_PERMISSION_TABLE.flatMap(([tier, permission, domains]) =>
    Object.entries(domains).flatMap(([namespace, methods]) =>
      methods.map((method) => [
        `${namespace}.${method}`,
        permission ? { tier, permission } : { tier },
      ]),
    ),
  ),
);

export function getPageAppDesktopMethodTier(
  namespace: string,
  method: string,
): PageAppDesktopMethodTierSpec | null {
  return PAGE_APP_DESKTOP_METHOD_PERMISSIONS.get(`${namespace}.${method}`) ?? null;
}

export interface PageAppDesktopPermissionMeta {
  readonly permission: PageAppDesktopPermission;
  readonly tier: PageAppDesktopPermissionTier;
  readonly label: string;
  readonly description: string;
  readonly cascadesTo?: readonly PageAppDesktopTier2Permission[];
}

export const PAGE_APP_DESKTOP_PERMISSION_META: Readonly<
  Record<PageAppDesktopPermission, PageAppDesktopPermissionMeta>
> = {
  notifications: {
    permission: "notifications",
    tier: 2,
    label: "系统通知",
    description: "允许此应用页发送桌面通知。",
  },
  shortcuts: {
    permission: "shortcuts",
    tier: 2,
    label: "全局快捷键",
    description: "允许此应用页注册全局快捷键。",
  },
  overlay: {
    permission: "overlay",
    tier: 2,
    label: "悬浮与置顶窗口",
    description: "允许此应用页使用无边框、透明、置顶与鼠标穿透窗口，并读取屏幕与光标位置。",
  },
  "menu-bar": {
    permission: "menu-bar",
    tier: 2,
    label: "菜单栏与系统托盘",
    description: "允许此应用页在系统托盘或菜单栏常驻图标与菜单。",
  },
  "full-access": {
    permission: "full-access",
    tier: 3,
    label: "完全电脑访问",
    description: "允许此应用页访问本地文件系统、系统环境信息、打开本地项目及运行本机命令与终端。",
    cascadesTo: PAGE_APP_DESKTOP_TIER2_PERMISSIONS,
  },
};

export const PageAppDesktopSourceTrust = Schema.Literals([
  "owner",
  "workspace",
  "external",
  "untrusted",
]);
export type PageAppDesktopSourceTrust = typeof PageAppDesktopSourceTrust.Type;

// ---------------------------------------------------------------------------
// Limits, Constants & IPC Channels
// ---------------------------------------------------------------------------

export const PAGE_APP_MANIFEST_MAX_JSON_CHARS = 16_000;
export const PAGE_APP_MANIFEST_MAX_DESKTOP_PERMISSIONS = 32;
export const PAGE_APP_MANIFEST_MAX_PERMISSION_CHARS = 64;

export const PAGE_APP_DESKTOP_MAX_WINDOWS = 10;
export const PAGE_APP_DESKTOP_MIN_WINDOW_WIDTH = 200;
export const PAGE_APP_DESKTOP_MIN_WINDOW_HEIGHT = 120;
export const PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE = 40;
export const PAGE_APP_DESKTOP_MAX_DRAG_REGIONS = 64;
export const PAGE_APP_DESKTOP_MIN_DRAG_HEIGHT = 12;
export const PAGE_APP_DESKTOP_MAX_DRAG_HEIGHT = 64;
export const PAGE_APP_DESKTOP_MENU_MAX_DEPTH = 4;
export const PAGE_APP_DESKTOP_MENU_MAX_ITEMS = 500;
export const PAGE_APP_DESKTOP_TRAY_MENU_COLLAPSE_THRESHOLD = 10;
export const PAGE_APP_DESKTOP_TRAY_ICON_MIN_PX = 16;
export const PAGE_APP_DESKTOP_TRAY_ICON_MAX_PX = 1024;
export const PAGE_APP_DESKTOP_TRAY_ICON_MAX_BYTES = 256 * 1024;
export const PAGE_APP_DESKTOP_TRAY_ICON_MIN_OPAQUE_RATIO = 0.04;
export const PAGE_APP_DESKTOP_NOTIFICATION_MAX_CHARS = 300;
export const PAGE_APP_DESKTOP_NOTIFICATION_MAX_RAW_CHARS = 2_000;
export const PAGE_APP_DESKTOP_FS_MAX_READ_BYTES = 256 * 1024 * 1024;
export const PAGE_APP_DESKTOP_EXEC_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
export const PAGE_APP_DESKTOP_MAX_PROCESSES = 32;
export const PAGE_APP_DESKTOP_CONFIRM_COOLDOWN_MS = 500;
export const PAGE_APP_DESKTOP_OFFER_MENU_MAX_ITEMS = 50;
export const PAGE_APP_DESKTOP_SHELL_OPEN_COOLDOWN_MS = 1_000;
export const PAGE_APP_DESKTOP_EVENT_BACKLOG_LIMIT = 2_000;

export const PAGE_APP_DESKTOP_INSTALL_ID_PATTERN = /^[a-f0-9]{32}$/u;
export const PAGE_APP_DESKTOP_LAUNCH_ARG_PREFIX = "--moss-app=" as const;
export const PAGE_APP_DESKTOP_AUMID_PREFIX = "Moss.PageApp." as const;
export const PAGE_APP_DESKTOP_DIALOG_PARTITION = "moss-app-dialog" as const;
export const PAGE_APP_DESKTOP_PANE_GLOBAL = "mossDesktopAppPane" as const;
export const PAGE_APP_DESKTOP_SHORTCUT_DIR_ENV = "MOSS_APPS_SHORTCUT_DIR" as const;

export const PAGE_APP_DESKTOP_POLICY_ENV_KEYS = {
  enabled: "MOSS_POLICY_PAGE_APPS_ENABLED",
  permissions: "MOSS_POLICY_PAGE_APPS_PERMISSIONS",
  fullAccess: "MOSS_POLICY_PAGE_APPS_FULL_ACCESS",
} as const;

export const PAGE_APP_DESKTOP_ERROR_CODES = [
  "not_installed",
  "unsupported",
  "policy_blocked",
  "version_mismatch",
  "process_limit",
  "too_large",
] as const;
export type PageAppDesktopErrorCode = (typeof PAGE_APP_DESKTOP_ERROR_CODES)[number];

export const PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL = "moss-app:node-apis-call" as const;
export const PAGE_APP_DESKTOP_NODE_API_EVENT_CHANNEL = "moss-app:node-apis-event" as const;
export const PAGE_APP_DESKTOP_DRAG_REGIONS_CHANNEL = "moss-app:drag-regions" as const;
export const PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL = "moss-app:permissions-declare" as const;

export const PAGE_APP_DESKTOP_SCREEN_DISPLAY_FIELDS = [
  "id",
  "label",
  "bounds",
  "workArea",
  "size",
  "workAreaSize",
  "scaleFactor",
  "rotation",
  "internal",
] as const;

export const PAGE_APP_DESKTOP_IPC_CHANNELS = {
  isAvailable: "desktop:page-apps-is-available",
  getPolicyState: "desktop:page-apps-get-policy-state",
  installFromPage: "desktop:page-apps-install-from-page",
  requestInstall: "desktop:page-apps-request-install",
  isInstalled: "desktop:page-apps-is-installed",
  getInstalled: "desktop:page-apps-get-installed",
  listInstalled: "desktop:page-apps-list-installed",
  openInstalled: "desktop:page-apps-open-installed",
  uninstall: "desktop:page-apps-uninstall",
  setDesktopShortcut: "desktop:page-apps-set-desktop-shortcut",
  showInFolder: "desktop:page-apps-show-in-folder",
  openPermissions: "desktop:page-apps-open-permissions",
  getPermissions: "desktop:page-apps-get-permissions",
  requestPermissions: "desktop:page-apps-request-permissions",
  setPermission: "desktop:page-apps-set-permission",
  syncAppVersion: "desktop:page-apps-sync-app-version",
  reportAppGone: "desktop:page-apps-report-app-gone",
  offerInMenu: "desktop:page-apps-offer-in-menu",
  pickedInMenu: "desktop:page-apps-picked-in-menu",
  installedChanged: "desktop:page-apps-installed-changed",
  permissionsChanged: "desktop:page-apps-permissions-changed",
  invokeDesktopApi: "desktop:page-apps-invoke-desktop-api",
  desktopApiEvent: "desktop:page-apps-desktop-api-event",
} as const;
export type PageAppDesktopIpcChannels = typeof PAGE_APP_DESKTOP_IPC_CHANNELS;
export type PageAppDesktopApiEventChannel = PageAppDesktopIpcChannels["desktopApiEvent"];

// ---------------------------------------------------------------------------
// Installation & Permission State Schemas
// ---------------------------------------------------------------------------

export const DesktopPageAppInstallPlace = Schema.Literals([
  "start-menu",
  "desktop",
  "applications",
]);
export type DesktopPageAppInstallPlace = typeof DesktopPageAppInstallPlace.Type;

const BoundedInstallId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
const BoundedHash = Schema.String.check(Schema.isMaxLength(128));
const BoundedTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const BoundedPath = Schema.String.check(Schema.isMaxLength(1024));

export const InstalledDesktopPageApp = Schema.Struct({
  installId: BoundedInstallId,
  appId: PageAppId,
  scopeSpaceId: Schema.optional(Schema.NullOr(SpaceId)),
  name: BoundedTitle,
  rawTitle: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  revision: PositiveInt,
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  declaredPermissions: Schema.optional(Schema.Array(PageAppDesktopPermission)),
  places: Schema.Array(DesktopPageAppInstallPlace),
  kind: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  iconPath: Schema.optional(Schema.NullOr(BoundedPath)),
  iconSlot: Schema.optional(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(7)),
  ),
  aumid: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(256)))),
  shortcutPaths: Schema.optional(Schema.Array(BoundedPath)),
  bundlePath: Schema.optional(Schema.NullOr(BoundedPath)),
  installedAt: IsoDateTime,
  updatedAt: Schema.optional(IsoDateTime),
});
export type InstalledDesktopPageApp = typeof InstalledDesktopPageApp.Type;

export const DesktopPageAppPermissionAnswer = Schema.Literals(["granted", "denied"]);
export type DesktopPageAppPermissionAnswer = typeof DesktopPageAppPermissionAnswer.Type;

export const DesktopPageAppPermissionState = Schema.Struct({
  permission: PageAppDesktopPermission,
  tier: PageAppDesktopPermissionTier,
  state: PageAppPermissionState,
  answer: Schema.optional(Schema.NullOr(DesktopPageAppPermissionAnswer)),
  revision: PositiveInt,
  contentHash: Schema.NullOr(BoundedHash),
  coversTier2: Schema.optional(Schema.Boolean),
  runsOn: Schema.optional(Schema.Array(Schema.String.check(Schema.isMaxLength(32)))),
  held: Schema.optional(Schema.Boolean),
  stale: Schema.optional(Schema.Boolean),
  updatedAt: Schema.optional(IsoDateTime),
});
export type DesktopPageAppPermissionState = typeof DesktopPageAppPermissionState.Type;

export const DesktopPageAppPermissionsSummary = Schema.Struct({
  appId: PageAppId,
  revision: PositiveInt,
  contentHash: Schema.NullOr(BoundedHash),
  declared: Schema.Array(PageAppDesktopPermission),
  states: Schema.Record(Schema.String, PageAppPermissionState),
  details: Schema.Record(Schema.String, DesktopPageAppPermissionState),
});
export type DesktopPageAppPermissionsSummary = typeof DesktopPageAppPermissionsSummary.Type;

export const DesktopPageAppPolicyState = Schema.Struct({
  enabled: Schema.Boolean,
  permissionsEnabled: Schema.Boolean,
  fullAccessEnabled: Schema.Boolean,
});
export type DesktopPageAppPolicyState = typeof DesktopPageAppPolicyState.Type;

export const DesktopPageAppInstallState = Schema.Struct({
  installed: Schema.Boolean,
  available: Schema.Boolean,
  installId: Schema.NullOr(BoundedInstallId),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  places: Schema.Array(DesktopPageAppInstallPlace),
  app: Schema.NullOr(InstalledDesktopPageApp),
  policy: Schema.optional(DesktopPageAppPolicyState),
});
export type DesktopPageAppInstallState = typeof DesktopPageAppInstallState.Type;

// ---------------------------------------------------------------------------
// Window, Menu, Tray & Notification Schemas
// ---------------------------------------------------------------------------

const FiniteNumber = Schema.Number.check(Schema.isFinite());

export const DesktopPageAppWindowBounds = Schema.Struct({
  x: FiniteNumber,
  y: FiniteNumber,
  width: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
  height: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
});
export type DesktopPageAppWindowBounds = typeof DesktopPageAppWindowBounds.Type;

export const DesktopPageAppDraggableRegion = Schema.Struct({
  x: FiniteNumber,
  y: FiniteNumber,
  width: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)),
  height: FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)),
  drag: Schema.Boolean,
});
export type DesktopPageAppDraggableRegion = typeof DesktopPageAppDraggableRegion.Type;

export const DesktopPageAppTitleBarStyle = Schema.Literals(["default", "hidden", "hiddenInset"]);
export type DesktopPageAppTitleBarStyle = typeof DesktopPageAppTitleBarStyle.Type;

export const DesktopPageAppWindowOptions = Schema.Struct({
  width: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_WINDOW_WIDTH)),
  ),
  height: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_WINDOW_HEIGHT)),
  ),
  minWidth: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
  ),
  minHeight: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
  ),
  maxWidth: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
  ),
  maxHeight: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
  ),
  x: Schema.optional(FiniteNumber),
  y: Schema.optional(FiniteNumber),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  titleBarStyle: Schema.optional(DesktopPageAppTitleBarStyle),
  frame: Schema.optional(Schema.Boolean),
  transparent: Schema.optional(Schema.Boolean),
  alwaysOnTop: Schema.optional(Schema.Boolean),
  resizable: Schema.optional(Schema.Boolean),
  maximizable: Schema.optional(Schema.Boolean),
  minimizable: Schema.optional(Schema.Boolean),
  closable: Schema.optional(Schema.Boolean),
  skipTaskbar: Schema.optional(Schema.Boolean),
  hasShadow: Schema.optional(Schema.Boolean),
  roundedCorners: Schema.optional(Schema.Boolean),
  movable: Schema.optional(Schema.Boolean),
  fullscreenable: Schema.optional(Schema.Boolean),
  dragHeight: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)).check(
      Schema.isLessThanOrEqualTo(PAGE_APP_DESKTOP_MAX_DRAG_HEIGHT),
    ),
  ),
  vibrancy: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(64)))),
  backgroundColor: Schema.optional(Schema.String.check(Schema.isMaxLength(32))),
  aspectRatio: Schema.optional(FiniteNumber.check(Schema.isGreaterThan(0))),
  ignoreMouseEvents: Schema.optional(Schema.Boolean),
  visibleOnAllWorkspaces: Schema.optional(Schema.Boolean),
});
export type DesktopPageAppWindowOptions = typeof DesktopPageAppWindowOptions.Type;

export const DesktopPageAppWindowSetOptionsResult = Schema.Struct({
  applied: Schema.Literals(["now", "next_open"]),
  reloading: Schema.Boolean,
  options: DesktopPageAppWindowOptions,
});
export type DesktopPageAppWindowSetOptionsResult = typeof DesktopPageAppWindowSetOptionsResult.Type;

export interface DesktopPageAppWindowGetOptionsResult {
  readonly options: DesktopPageAppWindowOptions;
  readonly applied: DesktopPageAppWindowOptions;
}

export const DesktopPageAppWindowPlaceAnchor = Schema.Literals([
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
  "center",
]);
export type DesktopPageAppWindowPlaceAnchor = typeof DesktopPageAppWindowPlaceAnchor.Type;

export const DesktopPageAppWindowPlacePin = Schema.Literals([
  "top_left",
  "top_right",
  "bottom_left",
  "bottom_right",
]);
export type DesktopPageAppWindowPlacePin = typeof DesktopPageAppWindowPlacePin.Type;

export const DesktopPageAppWindowPlacePosition = Schema.Literals([
  "center",
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "left",
  "right",
  "top",
  "bottom",
]);
export type DesktopPageAppWindowPlacePosition = typeof DesktopPageAppWindowPlacePosition.Type;

export const DesktopPageAppWindowPlaceInput = Schema.Struct({
  anchor: Schema.optional(DesktopPageAppWindowPlaceAnchor),
  pin: Schema.optional(DesktopPageAppWindowPlacePin),
  position: Schema.optional(DesktopPageAppWindowPlacePosition),
  displayId: Schema.optional(FiniteNumber),
  x: Schema.optional(FiniteNumber),
  y: Schema.optional(FiniteNumber),
  width: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
  ),
  height: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(PAGE_APP_DESKTOP_MIN_BOUNDS_SIZE)),
  ),
  margin: Schema.optional(
    FiniteNumber.check(Schema.isGreaterThanOrEqualTo(0)).check(Schema.isLessThanOrEqualTo(200)),
  ),
});
export type DesktopPageAppWindowPlaceInput = typeof DesktopPageAppWindowPlaceInput.Type;

export interface DesktopPageAppMenuItem {
  readonly id?: string;
  readonly label?: string;
  readonly type?: "normal" | "separator" | "checkbox" | "radio" | "submenu";
  readonly checked?: boolean;
  readonly enabled?: boolean;
  readonly accelerator?: string;
  readonly submenu?: readonly DesktopPageAppMenuItem[];
}

export const DesktopPageAppMenuItemBase = Schema.Struct({
  id: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  label: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  type: Schema.optional(Schema.Literals(["normal", "separator", "checkbox", "radio", "submenu"])),
  checked: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
  accelerator: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  submenu: Schema.optional(Schema.Array(Schema.Unknown)),
});

export const DesktopPageAppTrayOptions = Schema.Struct({
  icon: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(400_000))),
  iconIsTemplate: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  toolTip: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  menu: Schema.optional(Schema.NullOr(Schema.Array(DesktopPageAppMenuItemBase))),
  hasClickHandler: Schema.optional(Schema.Boolean),
});
export type DesktopPageAppTrayOptions = typeof DesktopPageAppTrayOptions.Type;

export const DesktopPageAppNotificationInput = Schema.Struct({
  body: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PAGE_APP_DESKTOP_NOTIFICATION_MAX_RAW_CHARS),
  ),
});
export type DesktopPageAppNotificationInput = typeof DesktopPageAppNotificationInput.Type;

export interface DesktopPageAppScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DesktopPageAppScreenSize {
  readonly width: number;
  readonly height: number;
}

export interface DesktopPageAppScreenDisplay {
  readonly id: number;
  readonly label: string;
  readonly bounds: DesktopPageAppScreenRect;
  readonly workArea: DesktopPageAppScreenRect;
  readonly size: DesktopPageAppScreenSize;
  readonly workAreaSize: DesktopPageAppScreenSize;
  readonly scaleFactor: number;
  readonly rotation: number;
  readonly internal: boolean;
}

export interface DesktopPageAppScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface DesktopPageAppOsInfo {
  readonly platform: string;
  readonly arch: string;
  readonly release: string;
  readonly hostname: string;
  readonly homedir: string;
  readonly tmpdir: string;
  readonly username: string;
  readonly cpus: number;
  readonly totalmem: number;
  readonly freemem?: number;
  readonly uptime: number;
}

export interface DesktopPageAppFileStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly mode?: number;
  readonly mtimeMs: number;
  readonly ctimeMs?: number;
  readonly birthtimeMs: number;
}

export interface DesktopPageAppDirent {
  readonly name: string;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
}

export interface DesktopPageAppExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | null;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly truncated: boolean;
}

// ---------------------------------------------------------------------------
// Install / Open / Uninstall / Permissions / Menu Offer Action Schemas
// ---------------------------------------------------------------------------

export const DesktopPageAppInstallInput = Schema.Struct({
  appId: PageAppId,
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  revision: Schema.optional(PositiveInt),
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  scopeSpaceId: Schema.optional(Schema.NullOr(SpaceId)),
  thumbnail: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(400_000)))),
  iconDataUrl: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(400_000)))),
  frameUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  capabilities: Schema.optional(PageAppCapabilities),
  sourceTrust: Schema.optional(PageAppDesktopSourceTrust),
  sourceRect: Schema.optional(
    Schema.Struct({
      x: FiniteNumber,
      y: FiniteNumber,
      width: FiniteNumber,
      height: FiniteNumber,
    }),
  ),
});
export type DesktopPageAppInstallInput = typeof DesktopPageAppInstallInput.Type;

export const DesktopPageAppInstallStatus = Schema.Literals([
  "installed",
  "already-installed",
  "cancelled",
  "disabled",
]);
export type DesktopPageAppInstallStatus = typeof DesktopPageAppInstallStatus.Type;

export const DesktopPageAppInstallResult = Schema.Struct({
  status: DesktopPageAppInstallStatus,
  app: Schema.optional(InstalledDesktopPageApp),
  opened: Schema.optional(Schema.Boolean),
});
export type DesktopPageAppInstallResult = typeof DesktopPageAppInstallResult.Type;

export const DesktopPageAppOpenInput = Schema.Struct({
  appId: Schema.optional(PageAppId),
  installId: Schema.optional(BoundedInstallId),
  frameUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  revision: Schema.optional(PositiveInt),
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  capabilities: Schema.optional(PageAppCapabilities),
  sourceTrust: Schema.optional(PageAppDesktopSourceTrust),
});
export type DesktopPageAppOpenInput = typeof DesktopPageAppOpenInput.Type;

export const DesktopPageAppOpenResult = Schema.Struct({
  opened: Schema.Boolean,
  windowId: Schema.optional(Schema.Int),
  installId: Schema.optional(BoundedInstallId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type DesktopPageAppOpenResult = typeof DesktopPageAppOpenResult.Type;

export const DesktopPageAppUninstallInput = Schema.Struct({
  appId: Schema.optional(PageAppId),
  installId: Schema.optional(BoundedInstallId),
  skipConfirm: Schema.optional(Schema.Boolean),
});
export type DesktopPageAppUninstallInput = typeof DesktopPageAppUninstallInput.Type;

export const DesktopPageAppUninstallResult = Schema.Struct({
  uninstalled: Schema.Boolean,
  removedAppIds: Schema.Array(Schema.String),
  removedInstallIds: Schema.Array(Schema.String),
});
export type DesktopPageAppUninstallResult = typeof DesktopPageAppUninstallResult.Type;

export const DesktopPageAppSetDesktopShortcutInput = Schema.Struct({
  appId: Schema.optional(PageAppId),
  installId: Schema.optional(BoundedInstallId),
  enabled: Schema.Boolean,
});
export type DesktopPageAppSetDesktopShortcutInput =
  typeof DesktopPageAppSetDesktopShortcutInput.Type;

export const DesktopPageAppSetDesktopShortcutResult = Schema.Struct({
  updated: Schema.Boolean,
  app: Schema.NullOr(InstalledDesktopPageApp),
  desktopShortcutEnabled: Schema.Boolean,
});
export type DesktopPageAppSetDesktopShortcutResult =
  typeof DesktopPageAppSetDesktopShortcutResult.Type;

export const DesktopPageAppOpenPermissionsInput = Schema.Struct({
  appId: PageAppId,
  installId: Schema.optional(BoundedInstallId),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  revision: Schema.optional(PositiveInt),
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  permissions: Schema.optional(Schema.Array(PageAppDesktopPermission)),
  sourceTrust: Schema.optional(PageAppDesktopSourceTrust),
});
export type DesktopPageAppOpenPermissionsInput = typeof DesktopPageAppOpenPermissionsInput.Type;

export const DesktopPageAppGetPermissionsInput = Schema.Struct({
  appId: PageAppId,
  revision: Schema.optional(PositiveInt),
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  declared: Schema.optional(Schema.Array(PageAppDesktopPermission)),
});
export type DesktopPageAppGetPermissionsInput = typeof DesktopPageAppGetPermissionsInput.Type;

export const DesktopPageAppRequestPermissionsInput = Schema.Struct({
  appId: PageAppId,
  permissions: Schema.optional(Schema.Array(PageAppDesktopPermission)),
  revision: Schema.optional(PositiveInt),
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  sourceTrust: Schema.optional(PageAppDesktopSourceTrust),
});
export type DesktopPageAppRequestPermissionsInput =
  typeof DesktopPageAppRequestPermissionsInput.Type;

export const DesktopPageAppSetPermissionInput = Schema.Struct({
  appId: PageAppId,
  permission: PageAppDesktopPermission,
  answer: Schema.NullOr(DesktopPageAppPermissionAnswer),
  revision: Schema.optional(PositiveInt),
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  coversTier2: Schema.optional(Schema.Boolean),
});
export type DesktopPageAppSetPermissionInput = typeof DesktopPageAppSetPermissionInput.Type;

export const DesktopPageAppDeclarePermissionsInput = Schema.Struct({
  appId: PageAppId,
  revision: Schema.optional(PositiveInt),
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  manifestJson: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(PAGE_APP_MANIFEST_MAX_JSON_CHARS))),
  ),
  permissions: Schema.optional(Schema.Array(PageAppDesktopPermission)),
});
export type DesktopPageAppDeclarePermissionsInput =
  typeof DesktopPageAppDeclarePermissionsInput.Type;

export const DesktopPageAppSyncVersionInput = Schema.Struct({
  appId: PageAppId,
  revision: PositiveInt,
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  capabilities: Schema.optional(PageAppCapabilities),
});
export type DesktopPageAppSyncVersionInput = typeof DesktopPageAppSyncVersionInput.Type;

export const DesktopPageAppSyncVersionResult = Schema.Struct({
  invalidated: Schema.Boolean,
  reloaded: Schema.Boolean,
});
export type DesktopPageAppSyncVersionResult = typeof DesktopPageAppSyncVersionResult.Type;

export const DesktopPageAppGoneInput = Schema.Struct({
  appId: PageAppId,
  gone: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
});
export type DesktopPageAppGoneInput = typeof DesktopPageAppGoneInput.Type;

export const DesktopPageAppMenuOffer = Schema.Struct({
  appId: PageAppId,
  title: BoundedTitle,
  revision: Schema.optional(PositiveInt),
  isInstalled: Schema.optional(Schema.Boolean),
  thumbnail: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMaxLength(400_000)))),
});
export type DesktopPageAppMenuOffer = typeof DesktopPageAppMenuOffer.Type;

export const DesktopPageAppPickedInMenuEvent = Schema.Struct({
  appId: PageAppId,
  action: Schema.optional(Schema.Literals(["install", "open"])),
});
export type DesktopPageAppPickedInMenuEvent = typeof DesktopPageAppPickedInMenuEvent.Type;

export const DesktopPageAppShowInFolderInput = Schema.Struct({
  appId: Schema.optional(PageAppId),
  installId: Schema.optional(BoundedInstallId),
});
export type DesktopPageAppShowInFolderInput = typeof DesktopPageAppShowInFolderInput.Type;

export const DesktopPageAppNodeApiCallInput = Schema.Struct({
  appId: PageAppId,
  installId: Schema.optional(BoundedInstallId),
  revision: PositiveInt,
  contentHash: Schema.optional(Schema.NullOr(BoundedHash)),
  namespace: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  method: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  args: Schema.Unknown,
});
export type DesktopPageAppNodeApiCallInput = typeof DesktopPageAppNodeApiCallInput.Type;

export interface DesktopPageAppNodeApiEvent {
  readonly appId?: string;
  readonly namespace: string;
  readonly event: string;
  readonly targetId?: string;
  readonly payload: unknown;
}

// ---------------------------------------------------------------------------
// Manifest & Preload Interfaces
// ---------------------------------------------------------------------------

export interface PageAppDesktopManifestConfig {
  readonly permissions?: readonly PageAppDesktopPermission[];
  readonly window?: DesktopPageAppWindowOptions;
}

export interface DesktopPageAppPaneInfo {
  readonly embedded: true;
  readonly platform: "desktop";
  readonly chrome: "none";
}

export interface DesktopPageAppNativeGlobal {
  readonly isDesktopApp?: boolean;
  readonly invoke: (namespace: string, method: string, args?: unknown) => Promise<unknown>;
  readonly subscribe?: (listener: (event: DesktopPageAppNodeApiEvent) => void) => () => void;
  readonly onEvent?: (listener: (event: DesktopPageAppNodeApiEvent) => void) => () => void;
}

// ---------------------------------------------------------------------------
// Main-window Bridge Interface (`desktopBridge.pageApps`)
// ---------------------------------------------------------------------------

export interface DesktopPageAppsBridge {
  readonly isAvailable: () => Promise<boolean>;
  readonly getPolicyState?: () => Promise<DesktopPageAppPolicyState>;
  readonly installFromPage: (
    input: DesktopPageAppInstallInput,
  ) => Promise<DesktopPageAppInstallResult>;
  readonly requestInstall: (
    input: DesktopPageAppInstallInput,
  ) => Promise<DesktopPageAppInstallResult>;
  readonly isInstalled: (appId: PageAppId) => Promise<boolean>;
  readonly getInstalled: (appId: PageAppId) => Promise<InstalledDesktopPageApp | null>;
  readonly listInstalled: () => Promise<readonly InstalledDesktopPageApp[]>;
  readonly openInstalled: (input: DesktopPageAppOpenInput) => Promise<DesktopPageAppOpenResult>;
  readonly uninstall: (
    input: DesktopPageAppUninstallInput,
  ) => Promise<DesktopPageAppUninstallResult>;
  readonly setDesktopShortcut?: (
    input: DesktopPageAppSetDesktopShortcutInput,
  ) => Promise<DesktopPageAppSetDesktopShortcutResult>;
  readonly showInFolder: (input: DesktopPageAppShowInFolderInput) => Promise<boolean>;
  readonly openPermissions: (input: DesktopPageAppOpenPermissionsInput) => Promise<void>;
  readonly getPermissions: (
    input: DesktopPageAppGetPermissionsInput,
  ) => Promise<DesktopPageAppPermissionsSummary>;
  readonly requestPermissions: (
    input: DesktopPageAppRequestPermissionsInput,
  ) => Promise<Record<string, PageAppPermissionState>>;
  readonly setPermission: (
    input: DesktopPageAppSetPermissionInput,
  ) => Promise<DesktopPageAppPermissionsSummary>;
  readonly declarePermissions?: (
    input: DesktopPageAppDeclarePermissionsInput,
  ) => Promise<DesktopPageAppPermissionsSummary>;
  readonly syncAppVersion: (
    input: DesktopPageAppSyncVersionInput,
  ) => Promise<DesktopPageAppSyncVersionResult>;
  readonly reportAppGone: (input: DesktopPageAppGoneInput) => Promise<void>;
  readonly offerInMenu: (offers: readonly DesktopPageAppMenuOffer[]) => Promise<void>;
  readonly onPickedInMenu: (
    listener: (event: DesktopPageAppPickedInMenuEvent) => void,
  ) => () => void;
  readonly onInstalledChanged: (
    listener: (apps: readonly InstalledDesktopPageApp[]) => void,
  ) => () => void;
  readonly onPermissionsChanged?: (
    listener: (event: {
      readonly appId: PageAppId;
      readonly permissions: DesktopPageAppPermissionsSummary;
    }) => void,
  ) => () => void;
  readonly invokeDesktopApi: (input: DesktopPageAppNodeApiCallInput) => Promise<unknown>;
  readonly onDesktopApiEvent?: (
    listener: (event: DesktopPageAppNodeApiEvent) => void,
  ) => () => void;
}

// ---------------------------------------------------------------------------
// Pure Helpers (whitelist, tier lookup, permission state resolution)
// ---------------------------------------------------------------------------

const PERMISSION_SET = new Set<string>(PAGE_APP_DESKTOP_PERMISSIONS);

export function isPageAppDesktopPermission(value: unknown): value is PageAppDesktopPermission {
  return typeof value === "string" && PERMISSION_SET.has(value);
}

export function getPageAppDesktopPermissionTier(
  permission: PageAppDesktopPermission,
): PageAppDesktopPermissionTier {
  return PAGE_APP_DESKTOP_PERMISSION_TIERS[permission];
}

/** Filters an Electron Display down to the 9 safe fields exposed to page apps. */
export function sanitizeDesktopScreenDisplay(
  display: Partial<DesktopPageAppScreenDisplay> & { readonly id: number },
): DesktopPageAppScreenDisplay {
  return {
    id: display.id,
    label: typeof display.label === "string" ? display.label : "",
    bounds: {
      x: display.bounds?.x ?? 0,
      y: display.bounds?.y ?? 0,
      width: display.bounds?.width ?? 0,
      height: display.bounds?.height ?? 0,
    },
    workArea: {
      x: display.workArea?.x ?? 0,
      y: display.workArea?.y ?? 0,
      width: display.workArea?.width ?? 0,
      height: display.workArea?.height ?? 0,
    },
    size: {
      width: display.size?.width ?? display.bounds?.width ?? 0,
      height: display.size?.height ?? display.bounds?.height ?? 0,
    },
    workAreaSize: {
      width: display.workAreaSize?.width ?? display.workArea?.width ?? 0,
      height: display.workAreaSize?.height ?? display.workArea?.height ?? 0,
    },
    scaleFactor: typeof display.scaleFactor === "number" ? display.scaleFactor : 1,
    rotation: typeof display.rotation === "number" ? display.rotation : 0,
    internal: Boolean(display.internal),
  };
}

/**
 * Normalizes a raw manifest `permissions` value: keeps at most 32 entries,
 * checks each string is <= 64 chars, filters to the 5-item whitelist, and
 * deduplicates while preserving declaration order.
 */
export function filterDeclaredDesktopPermissions(raw: unknown): PageAppDesktopPermission[] {
  if (!Array.isArray(raw)) return [];
  const out: PageAppDesktopPermission[] = [];
  const seen = new Set<PageAppDesktopPermission>();
  const bounded = raw.slice(0, PAGE_APP_MANIFEST_MAX_DESKTOP_PERMISSIONS);
  for (const item of bounded) {
    if (typeof item !== "string") continue;
    if (item.length > PAGE_APP_MANIFEST_MAX_PERMISSION_CHARS) continue;
    if (!isPageAppDesktopPermission(item) || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function makeDesktopPageAppPermissionKey(scope: {
  readonly accountId: string;
  readonly orgId: string;
  readonly appId: string;
  readonly permission: PageAppDesktopPermission;
}): string {
  return `${scope.accountId}|${scope.orgId}|${scope.appId}|${scope.permission}`.toLowerCase();
}

export interface StoredDesktopPermissionLookup {
  readonly answer: DesktopPageAppPermissionAnswer;
  readonly revision: number;
  readonly contentHash?: string | null;
  readonly coversTier2?: boolean;
}

export function isStoredDesktopPermissionVersionValid(
  record: StoredDesktopPermissionLookup,
  currentRevision: number,
  currentContentHash?: string | null,
): boolean {
  if (record.revision !== currentRevision) return false;
  const expectedHash = currentContentHash ?? null;
  const storedHash = record.contentHash ?? null;
  return storedHash === expectedHash;
}

/**
 * Resolves the effective permission state for one desktop permission:
 * - Undeclared permissions or policy-blocked tiers -> "unavailable"
 * - Explicit "denied" persists across version/contentHash updates -> "denied"
 * - "granted" requires matching revision & contentHash, else degrades to "prompt"
 * - Tier 3 "full-access" granted cascades to Tier 2 unless explicitly "denied"
 */
export function resolveDesktopPermissionState(input: {
  readonly permission: PageAppDesktopPermission;
  readonly declared: ReadonlySet<PageAppDesktopPermission>;
  readonly currentRevision: number;
  readonly currentContentHash?: string | null;
  readonly records: Readonly<Record<string, StoredDesktopPermissionLookup | undefined>>;
  readonly policy?: DesktopPageAppPolicyState;
}): PageAppPermissionState {
  const { permission, declared, currentRevision, currentContentHash, records, policy } = input;
  if (!declared.has(permission)) return "unavailable";
  if (policy) {
    if (!policy.enabled || !policy.permissionsEnabled) return "unavailable";
    if (permission === "full-access" && !policy.fullAccessEnabled) return "unavailable";
  }

  const direct = records[permission];
  if (direct?.answer === "denied") return "denied";
  if (
    direct?.answer === "granted" &&
    isStoredDesktopPermissionVersionValid(direct, currentRevision, currentContentHash)
  ) {
    return "granted";
  }

  if (getPageAppDesktopPermissionTier(permission) === 2) {
    const fullAccess = records["full-access"];
    const fullAccessAllowedByPolicy = policy ? policy.fullAccessEnabled : true;
    if (
      fullAccessAllowedByPolicy &&
      declared.has("full-access") &&
      fullAccess?.answer === "granted" &&
      fullAccess.coversTier2 !== false &&
      isStoredDesktopPermissionVersionValid(fullAccess, currentRevision, currentContentHash)
    ) {
      return "granted";
    }
  }

  return "prompt";
}
