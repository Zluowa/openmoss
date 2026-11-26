// FILE: windowManager.ts
// Purpose: Manages standalone BrowserWindow + WebContentsView instances for Page Apps:
//          full-width frameless top drag strip (frameless_painted), transparent rendering,
//          hot rebuildWindowForStyle, view & system context menus, 5s takeGesture tracking,
//          per-app granular permission teardown, blur/will-prevent-unload reload flow,
//          per-webContentsId Permissions-Policy routing, and standInForQuit lifecycle.
// Layer: Desktop pageApps

import * as Path from "node:path";

import {
  BrowserWindow,
  Menu,
  nativeTheme,
  screen,
  shell,
  WebContentsView,
  type MenuItemConstructorOptions,
  type OnHeadersReceivedListenerDetails,
} from "electron";

import { type PageAppDialogHost } from "./dialogs";
import {
  clampBoundsToWorkArea,
  PageAppNodeApiExecutor,
  teardownOverlayForSession,
  teardownProcessesForSession,
  teardownSessionPrivilegedResources,
  teardownShortcutsForSession,
  teardownTrayForSession,
  type DraggableRegion,
  type NodeApiWindowSession,
} from "./nodeApis";
import { buildPageAppAumid, buildPageAppLaunchArg } from "./osInstall";
import { DesktopPageAppPermissionEngine } from "./permissions";
import { DesktopPageAppStore } from "./store";
import {
  PAGE_APP_MAX_STANDALONE_WINDOWS,
  type DesktopPageAppPermission,
  type DesktopPageAppTrustKind,
  type InstalledDesktopPageApp,
  type StoredDesktopPageAppWindowStyle,
} from "./types";

export interface OpenStandalonePageAppInput {
  readonly appId: string;
  readonly installId: string | null;
  readonly accountId: string;
  readonly orgId: string;
  readonly appName: string;
  readonly isInstalled: boolean;
  readonly revision: number;
  readonly contentHash: string | null;
  readonly declaredPermissions: readonly DesktopPageAppPermission[];
  readonly trustKind: DesktopPageAppTrustKind;
  readonly targetUrl: string;
  readonly expectedFrameOrigin: string;
  readonly iconPath: string | null;
  readonly referenceText: string;
  readonly executablePath: string;
  readonly initialBounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly hidden?: boolean;
}

export interface PageAppHeaderPolicy {
  readonly transparent: boolean;
}

const headerPoliciesByWebContentsId = new Map<number, PageAppHeaderPolicy>();

/** Registers per-WebContentsId response header policy for `main.ts` single-hook routing. */
export function registerPageAppHeaderPolicy(
  webContentsId: number,
  policy: PageAppHeaderPolicy,
): void {
  headerPoliciesByWebContentsId.set(webContentsId, policy);
}

/** Unregisters response header policy when a Page App view is destroyed. */
export function unregisterPageAppHeaderPolicy(webContentsId: number): void {
  headerPoliciesByWebContentsId.delete(webContentsId);
}

/**
 * Applies Page App `Permissions-Policy` restrictions for registered `webContentsId`s while
 * strictly preserving upstream server `Permissions-Policy` directives.
 */
export function applyPageAppPermissionsPolicyHeaders(
  details: Pick<OnHeadersReceivedListenerDetails, "webContentsId" | "responseHeaders">,
): Record<string, string[]> | null {
  if (typeof details.webContentsId !== "number") return null;
  const policy = headerPoliciesByWebContentsId.get(details.webContentsId);
  if (!policy) return null;

  const headers: Record<string, string[]> = { ...details.responseHeaders };
  let existingRaw = "";
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "permissions-policy") {
      existingRaw = headers[key]?.join(", ") ?? "";
      delete headers[key];
    }
  }

  const directives = new Map<string, string>();
  for (const part of existingRaw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    directives.set(trimmed.slice(0, eqIdx).trim().toLowerCase(), trimmed.slice(eqIdx + 1).trim());
  }

  if (!directives.has("picture-in-picture")) {
    directives.set("picture-in-picture", "(self)");
  }
  directives.set("geolocation", "()");
  if (policy.transparent) {
    directives.set("camera", "()");
    directives.set("microphone", "()");
  }

  headers["Permissions-Policy"] = [
    Array.from(directives.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join(", "),
  ];
  return headers;
}

type ExtendedWindowStyle = StoredDesktopPageAppWindowStyle & {
  readonly dragHeight?: number;
  readonly movable?: boolean;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly hasShadow?: boolean;
  readonly roundedCorners?: boolean;
  readonly fullscreenable?: boolean;
  readonly backgroundColor?: string;
};

interface TopEdgeStripHandle {
  layout(): void;
  refresh(expand?: boolean): void;
  yieldDrag(yieldToApp: boolean): void;
  destroy(): void;
}

const STRIP_EXPANDED_HEIGHT = 28;
const STRIP_COLLAPSED_HEIGHT = 8;
const STRIP_COLLAPSE_DELAY_MS = 3_000;
const APP_DRAG_YIELD_MIN_W = 64;
const APP_DRAG_YIELD_MIN_H = 12;

const TRANSPARENT_FRAME_CSS = [
  "html, body, main, #top-edge, #frame-slot, #frame-slot > iframe, #frame-content,",
  "#loading { background: transparent !important; background-color: transparent !important; }",
  "#frame-slot > iframe, #frame-content { color-scheme: normal !important; }",
].join("\n");

function buildTopEdgeStripHtml(
  mode: "frameless" | "frameless_painted",
  title: string,
  showPill: boolean,
): string {
  const escaped = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const label = escaped ? `应用页 · ${escaped}` : "应用页";
  const paintedCss =
    mode === "frameless_painted"
      ? "background:rgba(60,60,60,.6);outline:1px solid rgba(255,255,255,.5);outline-offset:-1px;"
      : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent;-webkit-user-select:none;user-select:none;cursor:default}.s{position:fixed;inset:0;-webkit-app-region:drag;app-region:drag;display:flex;align-items:center;justify-content:center;${paintedCss}}.p{font:12px -apple-system,"Microsoft YaHei UI",system-ui,sans-serif;max-width:calc(100% - 180px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(0,0,0,.72);color:#fff;border-radius:10px;padding:2px 10px;}</style></head><body><div class="s">${showPill ? `<span class="p">${label}</span>` : ""}</div></body></html>`;
}

function createTopEdgeDragStrip(
  browserWindow: BrowserWindow,
  mode: "frameless" | "frameless_painted",
  getTitle: () => string,
  expandedHeight = STRIP_EXPANDED_HEIGHT,
): TopEdgeStripHandle {
  const stripView = new WebContentsView({
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: false,
      webviewTag: false,
      spellcheck: false,
      devTools: false,
      focusOnNavigation: false,
      partition: "moss-app-strip",
    },
  });
  const wc = stripView.webContents;
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e) => e.preventDefault());
  stripView.setBackgroundColor("#00000000");
  browserWindow.contentView.addChildView(stripView);

  let expandedUntil = 0;
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHtml = "";
  let loadSeq = 0;
  let yielded = false;

  const isExpanded = () => Date.now() < expandedUntil;
  const currentHeight = () => {
    if (browserWindow.isDestroyed() || browserWindow.isFullScreen()) return 0;
    if (yielded) return 0;
    return isExpanded() ? expandedHeight : STRIP_COLLAPSED_HEIGHT;
  };

  const layout = () => {
    if (browserWindow.isDestroyed()) return;
    const { width } = browserWindow.getContentBounds();
    stripView.setBounds({ x: 0, y: 0, width, height: currentHeight() });
  };

  const render = () => {
    if (wc.isDestroyed()) return;
    const html = buildTopEdgeStripHtml(mode, getTitle(), isExpanded());
    if (html !== lastHtml) {
      lastHtml = html;
      const seq = ++loadSeq;
      const dataUrl = `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
      void wc.loadURL(dataUrl).catch(() => {
        if (seq === loadSeq) lastHtml = "";
      });
    }
    layout();
  };

  const refresh = (expand = false) => {
    if (expand) {
      expandedUntil = Date.now() + STRIP_COLLAPSE_DELAY_MS;
      if (collapseTimer) clearTimeout(collapseTimer);
      collapseTimer = setTimeout(render, STRIP_COLLAPSE_DELAY_MS + 16);
    }
    render();
  };

  const destroy = () => {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    if (!browserWindow.isDestroyed()) {
      try {
        browserWindow.contentView.removeChildView(stripView);
      } catch {
        // Ignore.
      }
    }
    if (!wc.isDestroyed()) {
      wc.close();
    }
  };

  browserWindow.on("show", () => refresh(true));
  browserWindow.on("focus", () => refresh(true));
  browserWindow.once("closed", destroy);
  render();

  return {
    layout,
    refresh,
    yieldDrag: (shouldYield: boolean) => {
      yielded = shouldYield;
      layout();
    },
    destroy,
  };
}

export interface StandaloneWindowEntry {
  readonly appId: string;
  readonly installId: string | null;
  readonly browserWindow: BrowserWindow;
  readonly view: WebContentsView;
  readonly session: NodeApiWindowSession;
  readonly deviationTimestamps: number[];
  readonly reloadTimestamps: number[];
  lastAutoReloadAt: number;
  pendingRevision: number;
  pendingContentHash: string | null;
  lastInputAt: number;
  lastConsumedInputAt: number;
  away: boolean;
  backAt: number | undefined;
  retired: boolean;
  destroyed: boolean;
  style: ExtendedWindowStyle;
  topStrip: TopEdgeStripHandle | null;
  powerHoldCount: number;
  setThrottling(throttled: boolean): void;
  holdBackgroundPower(): () => void;
  takeGesture(): boolean;
  forgetInput(): void;
  isAttended(): boolean;
  isAway(): boolean;
  isJustBack(): boolean;
  notJustBack(): void;
  needsOneVersion(): void;
  rebuildForStyle(): void;
  applyDragRegions(regions: DraggableRegion[]): void;
}

export interface FileAppsMenuHandlers {
  readonly onOpen: (app: InstalledDesktopPageApp) => void;
  readonly onShowInFolder: (app: InstalledDesktopPageApp) => void;
  readonly onAbout: (app: InstalledDesktopPageApp) => void;
  readonly onPermissions: (app: InstalledDesktopPageApp) => void;
  readonly onReport: (app: InstalledDesktopPageApp) => void;
  readonly onUninstall: (app: InstalledDesktopPageApp) => void;
}

/**
 * Pure policy check for `standInForQuit`: if the main app receives quit while installed
 * standalone Page App windows remain open, hide main windows and stay alive until the last closes.
 */
export function shouldStandInForQuit(input: {
  readonly openStandaloneCount: number;
  readonly updaterQuitAndInstall: boolean;
  readonly desktopShutdownComplete: boolean;
  readonly forceExitAll?: boolean;
}): boolean {
  if (input.updaterQuitAndInstall || input.desktopShutdownComplete || input.forceExitAll) {
    return false;
  }
  return input.openStandaloneCount > 0;
}

/** Checks for FQDN trailing-dot bypass or malformed URLs. */
export function isSuspiciousNavigationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.endsWith(".")) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

export function buildFileAppsMenuItem(
  apps: readonly InstalledDesktopPageApp[],
  handlers: FileAppsMenuHandlers,
  locale: "zh-CN" | "en" = "zh-CN",
): MenuItemConstructorOptions | null {
  if (apps.length === 0) return null;
  const isZh = locale === "zh-CN";
  return {
    id: "moss-file-apps",
    label: isZh ? "应用" : "Apps",
    submenu: apps.map((entry) => ({
      label: entry.name,
      submenu: [
        { label: isZh ? "打开" : "Open", click: () => handlers.onOpen(entry) },
        {
          label:
            process.platform === "darwin"
              ? isZh
                ? "在 Finder 中显示"
                : "Reveal in Finder"
              : isZh
                ? "在资源管理器中打开"
                : "Show in Explorer",
          click: () => handlers.onShowInFolder(entry),
        },
        { type: "separator" },
        {
          label: isZh ? `关于 “${entry.name}”` : `About “${entry.name}”`,
          click: () => handlers.onAbout(entry),
        },
        { label: isZh ? "权限…" : "Permissions…", click: () => handlers.onPermissions(entry) },
        { label: isZh ? "报告应用页…" : "Report Page App…", click: () => handlers.onReport(entry) },
        { type: "separator" },
        { label: isZh ? "卸载…" : "Uninstall…", click: () => handlers.onUninstall(entry) },
      ],
    })),
  };
}

export class StandalonePageAppWindowManager {
  private readonly store: DesktopPageAppStore;
  private readonly permissions: DesktopPageAppPermissionEngine;
  private readonly dialogs: PageAppDialogHost;
  private readonly executor: PageAppNodeApiExecutor;
  private readonly preloadPath: string;
  private readonly windowsByAppId = new Map<string, StandaloneWindowEntry>();
  private readonly rebuildsByAppId = new Map<
    string,
    { readonly next: StandaloneWindowEntry; readonly drop: () => void }
  >();
  private readonly suppressedDialogCount = new WeakMap<BrowserWindow, number>();
  private globalDialogSuppressCount = 0;
  private standInQuitActive = false;
  private onAllClosedAfterStandInQuit?: (() => void) | undefined;
  private onTriggerInstall?: ((appId: string) => Promise<unknown>) | undefined;
  private onManagePermissions?:
    | ((appId: string, parent: BrowserWindow | null) => Promise<void>)
    | undefined;
  private onUninstallRequest?:
    | ((appId: string, parent: BrowserWindow | null) => Promise<void>)
    | undefined;
  private onReportApp?: ((appId: string) => void) | undefined;
  private onShowInFolder?: ((entry: InstalledDesktopPageApp) => void) | undefined;

  constructor(options: {
    readonly store: DesktopPageAppStore;
    readonly permissions: DesktopPageAppPermissionEngine;
    readonly dialogs: PageAppDialogHost;
    readonly executor: PageAppNodeApiExecutor;
    readonly preloadPath: string;
    readonly onAllClosedAfterStandInQuit?: (() => void) | undefined;
    readonly onTriggerInstall?: ((appId: string) => Promise<unknown>) | undefined;
    readonly onManagePermissions?:
      | ((appId: string, parent: BrowserWindow | null) => Promise<void>)
      | undefined;
    readonly onUninstallRequest?:
      | ((appId: string, parent: BrowserWindow | null) => Promise<void>)
      | undefined;
    readonly onReportApp?: ((appId: string) => void) | undefined;
    readonly onShowInFolder?: ((entry: InstalledDesktopPageApp) => void) | undefined;
  }) {
    this.store = options.store;
    this.permissions = options.permissions;
    this.dialogs = options.dialogs;
    this.executor = options.executor;
    this.preloadPath = options.preloadPath;
    this.onAllClosedAfterStandInQuit = options.onAllClosedAfterStandInQuit;
    this.onTriggerInstall = options.onTriggerInstall;
    this.onManagePermissions = options.onManagePermissions;
    this.onUninstallRequest = options.onUninstallRequest;
    this.onReportApp = options.onReportApp;
    this.onShowInFolder = options.onShowInFolder;
  }

  getOpenCount(): number {
    return this.windowsByAppId.size;
  }

  /** Counts only installed standalone windows (used by `standInForQuit`). */
  getInstalledOpenCount(): number {
    let count = 0;
    for (const entry of this.windowsByAppId.values()) {
      if (entry.session.isInstalled && !entry.destroyed && !entry.browserWindow.isDestroyed()) {
        count += 1;
      }
    }
    return count;
  }

  getOpenEntries(): StandaloneWindowEntry[] {
    return [...this.windowsByAppId.values()];
  }

  getWindowByAppId(appId: string): BrowserWindow | null {
    const entry = this.windowsByAppId.get(appId);
    if (!entry || entry.destroyed || entry.browserWindow.isDestroyed()) return null;
    return entry.browserWindow;
  }

  isStandInForQuitActive(): boolean {
    return this.standInQuitActive;
  }

  enterStandInForQuit(): void {
    this.standInQuitActive = true;
    // Close any non-installed preview windows when entering stand-in keep-alive.
    for (const entry of Array.from(this.windowsByAppId.values())) {
      if (!entry.session.isInstalled && !entry.browserWindow.isDestroyed()) {
        entry.retired = true;
        teardownSessionPrivilegedResources(entry.session);
        entry.browserWindow.destroy();
      }
    }
  }

  leaveStandInForQuit(): void {
    this.standInQuitActive = false;
  }

  /** Temporarily suppresses `alwaysOnTop` / `ignoreMouseEvents` while a modal dialog is shown. */
  suppressHostForDialogs = (visible: boolean, targetWindow: BrowserWindow | null): void => {
    if (targetWindow && !targetWindow.isDestroyed()) {
      const prev = this.suppressedDialogCount.get(targetWindow) ?? 0;
      const next = Math.max(0, prev + (visible ? 1 : -1));
      this.suppressedDialogCount.set(targetWindow, next);
    } else {
      this.globalDialogSuppressCount = Math.max(
        0,
        this.globalDialogSuppressCount + (visible ? 1 : -1),
      );
    }
    for (const entry of this.windowsByAppId.values()) {
      if (entry.browserWindow.isDestroyed()) continue;
      const suppressed =
        this.globalDialogSuppressCount > 0 ||
        (this.suppressedDialogCount.get(entry.browserWindow) ?? 0) > 0;
      entry.session.hasActiveDialog = suppressed;
      if (suppressed) {
        entry.browserWindow.setAlwaysOnTop(false);
        entry.browserWindow.setIgnoreMouseEvents(false);
      } else {
        const allowOverlay = this.isOverlayEffective(entry.session);
        entry.browserWindow.setAlwaysOnTop(
          allowOverlay && entry.style.alwaysOnTop === true,
          "floating",
        );
        if (allowOverlay && entry.style.ignoreMouseEvents) {
          entry.browserWindow.setIgnoreMouseEvents(true, { forward: true });
        }
      }
    }
  };

  private isOverlayEffective(session: NodeApiWindowSession): boolean {
    const evalRes = this.permissions.evaluate({
      accountId: session.accountId,
      orgId: session.orgId,
      appId: session.appId,
      permission: "overlay",
      declaredPermissions: session.declaredPermissions,
      currentRevision: session.revision,
      currentContentHash: session.contentHash,
      trustKind: session.trustKind,
    });
    return evalRes.state === "granted" && (process.platform !== "win32" || session.isInstalled);
  }

  openOrFocus(input: OpenStandalonePageAppInput): StandaloneWindowEntry {
    const existing = this.windowsByAppId.get(input.appId);
    if (existing && !existing.destroyed && !existing.browserWindow.isDestroyed()) {
      if (existing.browserWindow.isMinimized()) existing.browserWindow.restore();
      existing.browserWindow.show();
      existing.browserWindow.focus();
      return existing;
    }

    if (this.windowsByAppId.size >= PAGE_APP_MAX_STANDALONE_WINDOWS) {
      throw new Error(`最多同时打开 ${PAGE_APP_MAX_STANDALONE_WINDOWS} 个独立应用页窗口。`);
    }

    const entry = this.createWindowEntry(input, { registerInMap: true });
    return entry;
  }

  private createWindowEntry(
    input: OpenStandalonePageAppInput,
    opts: { readonly registerInMap: boolean },
  ): StandaloneWindowEntry {
    const styleKey = input.installId ?? input.appId;
    const savedStyle = (this.store.getWindowStyle(styleKey) ?? {}) as ExtendedWindowStyle;
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    const seedBounds = input.initialBounds ?? savedStyle.bounds;
    const initialBounds = clampBoundsToWorkArea(
      {
        ...(seedBounds?.x !== undefined ? { x: seedBounds.x } : {}),
        ...(seedBounds?.y !== undefined ? { y: seedBounds.y } : {}),
        width: seedBounds?.width ?? 980,
        height: seedBounds?.height ?? 720,
      },
      200,
      120,
      workAreas,
    );

    const overlayPerm = this.permissions.evaluate({
      accountId: input.accountId,
      orgId: input.orgId,
      appId: input.appId,
      permission: "overlay",
      declaredPermissions: input.declaredPermissions,
      currentRevision: input.revision,
      currentContentHash: input.contentHash,
      trustKind: input.trustKind,
    });
    const allowOverlay =
      overlayPerm.state === "granted" && (process.platform !== "win32" || input.isInstalled);

    const frameless = allowOverlay && savedStyle.frame === false;
    const transparent = allowOverlay && savedStyle.transparent === true;
    const alwaysOnTop = allowOverlay && savedStyle.alwaysOnTop === true;
    const defaultWindowBg = nativeTheme.shouldUseDarkColors ? "#1a1a19" : "#ffffff";

    const browserWindow = new BrowserWindow({
      ...initialBounds,
      minWidth: savedStyle.minWidth ?? 200,
      minHeight: savedStyle.minHeight ?? 120,
      ...(savedStyle.maxWidth !== undefined ? { maxWidth: savedStyle.maxWidth } : {}),
      ...(savedStyle.maxHeight !== undefined ? { maxHeight: savedStyle.maxHeight } : {}),
      show: false,
      autoHideMenuBar: true,
      frame: !frameless,
      transparent,
      alwaysOnTop,
      maximizable: !transparent,
      fullscreenable: transparent ? false : (savedStyle.fullscreenable ?? true),
      ...(savedStyle.hasShadow !== undefined ? { hasShadow: savedStyle.hasShadow } : {}),
      ...(savedStyle.roundedCorners !== undefined
        ? { roundedCorners: savedStyle.roundedCorners }
        : {}),
      ...(savedStyle.movable !== undefined ? { movable: savedStyle.movable } : {}),
      ...(transparent
        ? { backgroundColor: "#00000000" }
        : { backgroundColor: savedStyle.backgroundColor ?? defaultWindowBg }),
      title: input.appName,
      ...(input.iconPath ? { icon: input.iconPath } : {}),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: false,
        spellcheck: false,
      },
    });
    browserWindow.setMenuBarVisibility(false);

    if (process.platform === "win32" && input.isInstalled && input.installId) {
      try {
        const aumid = buildPageAppAumid(input.installId);
        const launchArg = buildPageAppLaunchArg(input.installId);
        browserWindow.setAppDetails({
          appId: aumid,
          ...(input.iconPath ? { appIconPath: input.iconPath, appIconIndex: 0 } : {}),
          relaunchCommand: `"${input.executablePath}" ${launchArg}`,
          relaunchDisplayName: input.appName,
        });
      } catch {
        // setAppDetails can fail before window realization.
      }
    }

    const view = new WebContentsView({
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        devTools: false,
        nodeIntegrationInSubFrames: true,
        focusOnNavigation: false,
      },
    });

    view.setBackgroundColor(
      transparent ? "#00000000" : (savedStyle.backgroundColor ?? defaultWindowBg),
    );
    registerPageAppHeaderPolicy(view.webContents.id, { transparent });
    browserWindow.contentView.addChildView(view);

    if (transparent) {
      view.webContents.on("dom-ready", () => {
        if (!view.webContents.isDestroyed()) {
          void view.webContents
            .insertCSS(TRANSPARENT_FRAME_CSS, { cssOrigin: "user" })
            .catch(() => undefined);
        }
      });
    }

    const dragStrip =
      frameless && savedStyle.movable !== false
        ? createTopEdgeDragStrip(
            browserWindow,
            transparent || alwaysOnTop ? "frameless_painted" : "frameless",
            () =>
              view.webContents.isDestroyed()
                ? input.appName
                : view.webContents.getTitle() || input.appName,
            savedStyle.dragHeight === 0
              ? STRIP_EXPANDED_HEIGHT
              : (savedStyle.dragHeight ?? STRIP_EXPANDED_HEIGHT),
          )
        : null;

    const syncBounds = () => {
      if (browserWindow.isDestroyed()) return;
      const content = browserWindow.getContentBounds();
      view.setBounds({ x: 0, y: 0, width: content.width, height: content.height });
      dragStrip?.layout();
    };

    const session: NodeApiWindowSession & {
      onRebuildWindowForStyle?: () => void;
    } = {
      appId: input.appId,
      installId: input.installId,
      accountId: input.accountId,
      orgId: input.orgId,
      appName: input.appName,
      isInstalled: input.isInstalled,
      revision: input.revision,
      contentHash: input.contentHash,
      declaredPermissions: input.declaredPermissions,
      trustKind: input.trustKind,
      hasMixedVersions: false,
      expectedFrameOrigin: input.expectedFrameOrigin,
      browserWindow,
      contentWebContents: view.webContents,
      iconPath: input.iconPath,
      referenceText: input.referenceText,
      registeredShortcuts: new Set(),
      childProcesses: new Map(),
      ptyProcesses: new Map(),
      lastShellOpenAt: 0,
      draggableRegions: [],
      onTriggerInstall: () =>
        this.onTriggerInstall ? this.onTriggerInstall(input.appId) : Promise.resolve(null),
      onOpenPermissionsWindow: () =>
        this.onManagePermissions
          ? this.onManagePermissions(input.appId, browserWindow)
          : Promise.resolve(),
      onShowAppWindow: () => {
        if (!browserWindow.isDestroyed()) {
          entry.away = false;
          if (browserWindow.isMinimized()) browserWindow.restore();
          browserWindow.show();
          browserWindow.focus();
        }
      },
      onRequestExitApp: () => {
        if (!browserWindow.isDestroyed()) {
          entry.retired = true;
          teardownSessionPrivilegedResources(session);
          browserWindow.destroy();
        }
      },
      onOverlayChanged: () => {
        this.rebuildWindowForStyle(input.appId);
      },
      onRebuildWindowForStyle: () => {
        this.rebuildWindowForStyle(input.appId);
      },
      takeGesture: () => entry.takeGesture(),
    };

    let autoReloadTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingReloadReason: "away" | "permission" = "away";
    let unloadPrevented = false;
    let allowForcedReload = false;
    let reloadDialogOpen = false;
    let navigatedAwayRecoveryCount = 0;

    const entry: StandaloneWindowEntry = {
      appId: input.appId,
      installId: input.installId,
      browserWindow,
      view,
      session,
      deviationTimestamps: [],
      reloadTimestamps: [],
      lastAutoReloadAt: 0,
      pendingRevision: input.revision,
      pendingContentHash: input.contentHash,
      lastInputAt: 0,
      lastConsumedInputAt: 0,
      away: false,
      backAt: undefined,
      retired: false,
      destroyed: false,
      style: savedStyle,
      topStrip: dragStrip,
      powerHoldCount: 0,
      setThrottling: (throttled: boolean) => {
        if (!view.webContents.isDestroyed()) {
          view.webContents.setBackgroundThrottling(throttled && entry.powerHoldCount === 0);
        }
      },
      holdBackgroundPower: () => {
        entry.powerHoldCount += 1;
        entry.setThrottling(false);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          entry.powerHoldCount = Math.max(0, entry.powerHoldCount - 1);
          entry.setThrottling(true);
        };
      },
      takeGesture: () => {
        if (
          entry.destroyed ||
          browserWindow.isDestroyed() ||
          !browserWindow.isVisible() ||
          browserWindow.isMinimized() ||
          (this.suppressedDialogCount.get(browserWindow) ?? 0) > 0
        ) {
          return false;
        }
        const now = Date.now();
        if (entry.lastInputAt <= entry.lastConsumedInputAt || now - entry.lastInputAt >= 5_000) {
          return false;
        }
        entry.lastConsumedInputAt = entry.lastInputAt;
        return true;
      },
      forgetInput: () => {
        entry.lastConsumedInputAt = entry.lastInputAt;
      },
      isAttended: () => !browserWindow.isDestroyed() && browserWindow.isFocused(),
      isAway: () => entry.away,
      isJustBack: () =>
        entry.backAt !== undefined &&
        Date.now() - entry.backAt < (browserWindow.isFocused() ? 5_000 : 1_000),
      notJustBack: () => {
        entry.backAt = undefined;
      },
      needsOneVersion: () => {
        pendingReloadReason = "permission";
        scheduleAutoReload("permission");
      },
      rebuildForStyle: () => {
        this.rebuildWindowForStyle(input.appId);
      },
      applyDragRegions: (regions: DraggableRegion[]) => {
        session.draggableRegions = regions;
        if (!dragStrip) return;
        const { width, height } = browserWindow.isDestroyed()
          ? { width: 0, height: 0 }
          : browserWindow.getContentBounds();
        const shouldYield =
          savedStyle.dragHeight === 0 &&
          regions.some(
            (r) =>
              r.drag &&
              r.width >= APP_DRAG_YIELD_MIN_W &&
              r.height >= APP_DRAG_YIELD_MIN_H &&
              r.x + APP_DRAG_YIELD_MIN_W <= width &&
              r.y + APP_DRAG_YIELD_MIN_H <= height,
          );
        dragStrip.yieldDrag(shouldYield);
      },
    };

    const scheduleAutoReload = (reason: "away" | "permission") => {
      if (!session.hasMixedVersions || reloadDialogOpen || view.webContents.isDestroyed()) return;
      if (reason !== "away") pendingReloadReason = reason;
      if (autoReloadTimer) return;
      const canTriggerNow =
        pendingReloadReason !== "away" || (!browserWindow.isFocused() && !unloadPrevented);
      if (!canTriggerNow) return;

      const now = Date.now();
      const recent = entry.reloadTimestamps.filter((t) => now - t <= 10 * 60_000);
      entry.reloadTimestamps.length = 0;
      entry.reloadTimestamps.push(...recent);
      const nextAllowedAt = Math.max(
        entry.lastAutoReloadAt + 20_000,
        recent.length >= 3 ? (recent.at(-3) ?? 0) + 10 * 60_000 : 0,
      );
      autoReloadTimer = setTimeout(
        () => {
          autoReloadTimer = null;
          if (entry.destroyed || view.webContents.isDestroyed() || !session.hasMixedVersions)
            return;
          if (pendingReloadReason === "away" && (browserWindow.isFocused() || unloadPrevented))
            return;
          entry.lastAutoReloadAt = Date.now();
          entry.reloadTimestamps.push(entry.lastAutoReloadAt);
          view.webContents.reload();
        },
        Math.max(0, nextAllowedAt - now),
      );
    };

    if (opts.registerInMap) {
      this.executor.registerSession(session);
      this.windowsByAppId.set(input.appId, entry);
    }

    // Gesture & focus input tracking
    const recordInput = () => {
      entry.lastInputAt = Date.now();
      entry.notJustBack();
    };
    view.webContents.on("before-mouse-event", (_e, mouse) => {
      if (
        (this.suppressedDialogCount.get(browserWindow) ?? 0) === 0 &&
        mouse.type === "mouseDown"
      ) {
        recordInput();
      }
    });
    view.webContents.on("before-input-event", (event, keyInput) => {
      if (
        keyInput.type === "keyDown" &&
        keyInput.key === "F4" &&
        keyInput.alt &&
        !keyInput.control
      ) {
        event.preventDefault();
        browserWindow.close();
        return;
      }
      if ((this.suppressedDialogCount.get(browserWindow) ?? 0) > 0) {
        if (
          keyInput.type === "keyDown" &&
          !(
            (keyInput.control && keyInput.key.toLowerCase() === "w") ||
            (keyInput.alt && keyInput.key === "F4")
          )
        ) {
          event.preventDefault();
        }
        return;
      }
      if (keyInput.type === "keyDown" && !keyInput.isAutoRepeat) {
        recordInput();
      }
    });
    view.webContents.on("input-event", (_e, ev) => {
      if (ev.type === "gestureTap" && (this.suppressedDialogCount.get(browserWindow) ?? 0) === 0) {
        recordInput();
      }
    });

    // Security & navigation fences
    view.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url);
        if (parsed.protocol === "https:" || parsed.protocol === "http:") {
          if (entry.takeGesture()) {
            void shell.openExternal(url);
          }
        }
      } catch {
        // Ignore invalid URLs.
      }
      return { action: "deny" };
    });
    view.webContents.on("will-attach-webview", (event) => event.preventDefault());

    const expectedShellOrigin = (() => {
      try {
        const u = new URL(input.targetUrl);
        return u.origin === "null" ? `${u.protocol}//${u.host}` : u.origin;
      } catch {
        return "";
      }
    })();
    let lastKnownSafeUrl = input.targetUrl;

    const recoverDeviation = () => {
      const now = Date.now();
      entry.deviationTimestamps.push(now);
      const recent = entry.deviationTimestamps.filter((ts) => now - ts <= 10_000);
      entry.deviationTimestamps.length = 0;
      entry.deviationTimestamps.push(...recent);
      const target = recent.length > 3 ? "about:blank" : lastKnownSafeUrl;
      navigatedAwayRecoveryCount += 1;
      void view.webContents.loadURL(target).catch(() => undefined);
    };

    const isAllowedUrl = (targetUrl: string, isMainFrame: boolean): boolean => {
      if (targetUrl === "about:blank") return true;
      if (isSuspiciousNavigationUrl(targetUrl)) return false;
      try {
        const u = new URL(targetUrl);
        const targetOrigin = u.origin === "null" ? `${u.protocol}//${u.host}` : u.origin;
        return isMainFrame
          ? targetOrigin === expectedShellOrigin
          : targetOrigin === expectedShellOrigin || targetOrigin === input.expectedFrameOrigin;
      } catch {
        return false;
      }
    };

    const handleNavigationCheck = (
      event: Electron.Event,
      targetUrl: string,
      isMainFrame: boolean,
    ) => {
      if (!isAllowedUrl(targetUrl, isMainFrame)) {
        event.preventDefault();
        recoverDeviation();
      }
    };

    view.webContents.on("will-navigate", (event, url) => handleNavigationCheck(event, url, true));
    view.webContents.on("will-redirect", (event, url, _isInPlace, isMainFrame) =>
      handleNavigationCheck(event, url, isMainFrame),
    );
    view.webContents.on("will-frame-navigate", (event) =>
      handleNavigationCheck(event, event.url, event.isMainFrame),
    );

    view.webContents.on("will-prevent-unload", (event) => {
      if (allowForcedReload) {
        event.preventDefault();
        return;
      }
      unloadPrevented = true;
      const reason = pendingReloadReason;
      pendingReloadReason = "away";
      if (session.hasMixedVersions && reason === "permission") {
        reloadDialogOpen = true;
        void this.dialogs
          .confirmReload({ appName: session.appName }, browserWindow)
          .finally(() => {
            reloadDialogOpen = false;
          })
          .then((shouldReload) => {
            if (shouldReload && session.hasMixedVersions && !view.webContents.isDestroyed()) {
              allowForcedReload = true;
              view.webContents.reload();
            }
          })
          .catch(() => undefined);
      }
    });

    view.webContents.on("did-fail-load", (_e, errorCode, _desc, _url, isMainFrame) => {
      if (isMainFrame) allowForcedReload = false;
      void errorCode;
    });

    view.webContents.on("did-navigate", (_event, url) => {
      if (isAllowedUrl(url, true)) {
        if (url !== "about:blank") lastKnownSafeUrl = url;
        if (navigatedAwayRecoveryCount > 0) {
          navigatedAwayRecoveryCount = 0;
          try {
            view.webContents.navigationHistory.clear();
          } catch {
            // Ignore.
          }
        }
      } else {
        recoverDeviation();
        return;
      }

      // Clear mixed-version state only after real main-frame navigation completes.
      (session as { revision: number }).revision = entry.pendingRevision;
      (session as { contentHash: string | null }).contentHash = entry.pendingContentHash;
      (session as { hasMixedVersions: boolean }).hasMixedVersions = false;
      unloadPrevented = false;
      allowForcedReload = false;
      pendingReloadReason = "away";
      if (autoReloadTimer) {
        clearTimeout(autoReloadTimer);
        autoReloadTimer = null;
      }
      session.draggableRegions = [];
      dragStrip?.yieldDrag(false);
      if (!browserWindow.isDestroyed()) {
        browserWindow.setIgnoreMouseEvents(false);
        if (this.isOverlayEffective(session) && savedStyle.alwaysOnTop) {
          browserWindow.setAlwaysOnTop(true, "floating");
        }
      }
    });

    view.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (isMainFrame && !isAllowedUrl(url, true)) {
        recoverDeviation();
      } else if (isMainFrame && url !== "about:blank") {
        lastKnownSafeUrl = url;
      }
    });

    view.webContents.on("page-title-updated", (_e, title, explicitSet) => {
      if (!browserWindow.isDestroyed() && explicitSet && title.trim()) {
        browserWindow.setTitle(title.trim());
      }
      dragStrip?.refresh(false);
    });

    view.webContents.once("did-finish-load", () => {
      dragStrip?.refresh(true);
    });

    // View content right-click menu
    view.webContents.on("context-menu", (event, params) => {
      if (browserWindow.isDestroyed() || (this.suppressedDialogCount.get(browserWindow) ?? 0) > 0) {
        return;
      }
      event.preventDefault();
      const installedRecord = input.installId
        ? this.store.findInstalledByInstallId(input.installId)
        : this.store.findInstalledByAppId(input.appId);
      const menuTemplate: MenuItemConstructorOptions[] = [];
      if (params.mediaType === "image") {
        menuTemplate.push(
          { label: "复制图片", click: () => view.webContents.copyImageAt(params.x, params.y) },
          { type: "separator" },
        );
      }
      menuTemplate.push(
        { role: "cut", label: "剪切", enabled: params.editFlags.canCut },
        { role: "copy", label: "复制", enabled: params.editFlags.canCopy },
        { role: "paste", label: "粘贴", enabled: params.editFlags.canPaste },
        { role: "selectAll", label: "全选", enabled: params.editFlags.canSelectAll },
        { type: "separator" },
      );

      if (installedRecord) {
        menuTemplate.push(
          {
            label: `关于 “${input.appName}”`,
            click: () =>
              void this.dialogs.showAbout(
                {
                  appName: input.appName,
                  appId: input.appId,
                  revision: session.revision,
                  referenceText: input.referenceText,
                },
                browserWindow,
              ),
          },
          {
            label: process.platform === "darwin" ? "在 Finder 中显示" : "在资源管理器中打开",
            click: () => {
              if (this.onShowInFolder) this.onShowInFolder(installedRecord);
              else if (installedRecord.shortcutPaths?.[0]) {
                shell.showItemInFolder(installedRecord.shortcutPaths[0]);
              }
            },
          },
          {
            label: "权限…",
            click: () => void this.onManagePermissions?.(input.appId, browserWindow),
          },
          {
            label: "报告应用页…",
            click: () => this.onReportApp?.(input.appId),
          },
          { type: "separator" },
          {
            label: "卸载应用…",
            click: () => void this.onUninstallRequest?.(input.appId, browserWindow),
          },
        );
      } else {
        menuTemplate.push({
          label: "安装为应用…",
          click: () => void this.onTriggerInstall?.(input.appId),
        });
      }
      Menu.buildFromTemplate(menuTemplate).popup({ window: browserWindow });
    });

    // Title bar right-click system-context-menu
    browserWindow.on("system-context-menu", (event) => {
      if ((this.suppressedDialogCount.get(browserWindow) ?? 0) > 0) return;
      event.preventDefault();
      const cursor = screen.getCursorScreenPoint();
      const wb = browserWindow.getBounds();
      const cursorInside =
        cursor.x >= wb.x &&
        cursor.x < wb.x + wb.width &&
        cursor.y >= wb.y &&
        cursor.y < wb.y + wb.height;

      const installedRecord = input.installId
        ? this.store.findInstalledByInstallId(input.installId)
        : this.store.findInstalledByAppId(input.appId);
      const hasTray = Boolean(installedRecord && session.tray && !session.tray.isDestroyed());
      const menuTemplate: MenuItemConstructorOptions[] = [
        {
          label: "还原",
          enabled: browserWindow.isMaximized() || browserWindow.isMinimized(),
          click: () => {
            if (browserWindow.isMinimized()) browserWindow.restore();
            else if (browserWindow.isMaximized()) browserWindow.unmaximize();
          },
        },
        {
          label: "最小化",
          enabled: browserWindow.isMinimizable(),
          click: () => browserWindow.minimize(),
        },
        {
          label: browserWindow.isMaximized() ? "向下还原" : "最大化",
          enabled: !browserWindow.isMaximized() && browserWindow.isMaximizable(),
          click: () => browserWindow.maximize(),
        },
        { type: "separator" },
        {
          label: `关于 “${input.appName}”`,
          click: () =>
            void this.dialogs.showAbout(
              {
                appName: input.appName,
                appId: input.appId,
                revision: session.revision,
                referenceText: input.referenceText,
              },
              browserWindow,
            ),
        },
        ...(installedRecord
          ? [
              {
                label: process.platform === "darwin" ? "在 Finder 中显示" : "在资源管理器中打开",
                click: () => {
                  if (this.onShowInFolder) this.onShowInFolder(installedRecord);
                  else if (installedRecord.shortcutPaths?.[0]) {
                    shell.showItemInFolder(installedRecord.shortcutPaths[0]);
                  }
                },
              },
            ]
          : [
              {
                label: "安装为应用…",
                click: () => void this.onTriggerInstall?.(input.appId),
              },
            ]),
        {
          label: "权限…",
          click: () => void this.onManagePermissions?.(input.appId, browserWindow),
        },
        {
          label: "报告应用页…",
          click: () => this.onReportApp?.(input.appId),
        },
        ...(installedRecord
          ? [
              { type: "separator" as const },
              {
                label: "卸载应用…",
                click: () => void this.onUninstallRequest?.(input.appId, browserWindow),
              },
            ]
          : []),
        { type: "separator" },
        {
          label: "关闭",
          click: () => browserWindow.close(),
        },
        ...(hasTray
          ? [
              {
                label: "退出",
                click: () => session.onRequestExitApp?.(),
              },
            ]
          : []),
      ];
      Menu.buildFromTemplate(menuTemplate).popup({
        window: browserWindow,
        ...(!cursorInside ? { x: 0, y: 0 } : {}),
      });
    });

    browserWindow.on("focus", () => {
      entry.away = false;
      entry.backAt = Date.now();
    });
    browserWindow.on("blur", () => {
      entry.backAt = undefined;
      scheduleAutoReload("away");
    });
    browserWindow.on("resize", syncBounds);
    browserWindow.on("move", () => {
      if (browserWindow.isDestroyed() || entry.retired) return;
      const existingStyle = this.store.getWindowStyle(styleKey);
      this.store.setWindowStyle(styleKey, {
        ...existingStyle,
        bounds: browserWindow.getBounds(),
        updatedAt: new Date().toISOString(),
      });
    });

    browserWindow.on("close", (event) => {
      // Only installed apps with active tray hide on close; preview windows always close.
      if (session.isInstalled && session.tray && !session.tray.isDestroyed() && !entry.retired) {
        event.preventDefault();
        entry.away = true;
        browserWindow.hide();
      }
    });

    let shown = false;
    let showFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const revealWindow = () => {
      if (shown || entry.destroyed || browserWindow.isDestroyed()) return;
      shown = true;
      if (showFallbackTimer) {
        clearTimeout(showFallbackTimer);
        showFallbackTimer = null;
      }
      syncBounds();
      if (!input.hidden) {
        browserWindow.show();
        browserWindow.focus();
        if (frameless) dragStrip?.refresh(true);
      }
    };

    browserWindow.on("closed", () => {
      entry.destroyed = true;
      if (showFallbackTimer) {
        clearTimeout(showFallbackTimer);
        showFallbackTimer = null;
      }
      if (autoReloadTimer) {
        clearTimeout(autoReloadTimer);
        autoReloadTimer = null;
      }
      unregisterPageAppHeaderPolicy(view.webContents.id);
      if (this.windowsByAppId.get(input.appId) === entry) {
        this.executor.unregisterSession(view.webContents.id);
        this.windowsByAppId.delete(input.appId);
      }
      if (this.standInQuitActive && this.getInstalledOpenCount() === 0) {
        this.standInQuitActive = false;
        this.onAllClosedAfterStandInQuit?.();
      }
    });

    syncBounds();
    if (!input.hidden) {
      browserWindow.once("ready-to-show", revealWindow);
      view.webContents.once("dom-ready", revealWindow);
      view.webContents.once("did-finish-load", revealWindow);
      showFallbackTimer = setTimeout(revealWindow, 1_500);
    }

    void view.webContents.loadURL(input.targetUrl);
    return entry;
  }

  /**
   * Hot-rebuilds a standalone window when `frame`, `transparent`, `alwaysOnTop`, or overlay
   * permissions change (`Lg` in `UJzilp8j`), preserving bounds/focus/away state atomically.
   */
  rebuildWindowForStyle(appId: string): boolean {
    const current = this.windowsByAppId.get(appId);
    if (!current || current.destroyed || current.browserWindow.isDestroyed()) return false;

    this.rebuildsByAppId.get(appId)?.drop();

    const s = current.session;
    const nextEntry = this.createWindowEntry(
      {
        appId: s.appId,
        installId: s.installId,
        accountId: s.accountId,
        orgId: s.orgId,
        appName: s.appName,
        isInstalled: s.isInstalled,
        revision: s.revision,
        contentHash: s.contentHash,
        declaredPermissions: s.declaredPermissions,
        trustKind: s.trustKind,
        targetUrl: s.referenceText,
        expectedFrameOrigin: s.expectedFrameOrigin,
        iconPath: s.iconPath,
        referenceText: s.referenceText,
        executablePath: process.execPath,
        initialBounds: current.browserWindow.getBounds(),
        hidden: true,
      },
      { registerInMap: false },
    );

    let swapTimer: ReturnType<typeof setTimeout> | null = null;
    let dropped = false;
    const isCurrentRebuild = () => !dropped && this.rebuildsByAppId.get(appId)?.next === nextEntry;

    const drop = () => {
      if (dropped) return;
      dropped = true;
      if (swapTimer) {
        clearTimeout(swapTimer);
        swapTimer = null;
      }
      if (this.rebuildsByAppId.get(appId)?.next === nextEntry) {
        this.rebuildsByAppId.delete(appId);
      }
      nextEntry.retired = true;
      unregisterPageAppHeaderPolicy(nextEntry.view.webContents.id);
      if (!nextEntry.browserWindow.isDestroyed()) {
        nextEntry.browserWindow.destroy();
      }
    };

    const performSwap = () => {
      if (!isCurrentRebuild()) return;
      if (
        (this.suppressedDialogCount.get(current.browserWindow) ?? 0) > 0 ||
        this.globalDialogSuppressCount > 0
      ) {
        swapTimer = setTimeout(performSwap, 500);
        return;
      }
      if (current.browserWindow.isDestroyed() || nextEntry.browserWindow.isDestroyed()) {
        drop();
        return;
      }
      dropped = true;
      if (swapTimer) {
        clearTimeout(swapTimer);
        swapTimer = null;
      }
      this.rebuildsByAppId.delete(appId);

      const wasFocused = current.browserWindow.isFocused();
      const wasMinimized = current.browserWindow.isMinimized();
      const wasAway = current.away;

      // Transfer active privileged handles before destroying the old window
      nextEntry.session.tray = s.tray;
      s.tray = null;
      nextEntry.session.powerBlockerId = s.powerBlockerId ?? null;
      s.powerBlockerId = null;
      if (s.dragRegionsTtlTimer) {
        clearTimeout(s.dragRegionsTtlTimer);
        s.dragRegionsTtlTimer = null;
      }
      for (const acc of s.registeredShortcuts) nextEntry.session.registeredShortcuts.add(acc);
      s.registeredShortcuts.clear();
      for (const [k, v] of s.childProcesses) nextEntry.session.childProcesses.set(k, v);
      s.childProcesses.clear();
      for (const [k, v] of s.ptyProcesses) nextEntry.session.ptyProcesses.set(k, v);
      s.ptyProcesses.clear();

      current.retired = true;
      this.executor.unregisterSession(current.view.webContents.id);
      this.executor.registerSession(nextEntry.session);
      this.windowsByAppId.set(appId, nextEntry);

      if (wasAway) {
        nextEntry.away = true;
        nextEntry.browserWindow.hide();
      } else if (wasMinimized) {
        nextEntry.browserWindow.showInactive();
        nextEntry.browserWindow.minimize();
      } else if (wasFocused) {
        nextEntry.browserWindow.show();
        nextEntry.browserWindow.focus();
      } else {
        nextEntry.browserWindow.showInactive();
      }
      nextEntry.topStrip?.refresh(true);
      current.browserWindow.destroy();
    };

    this.rebuildsByAppId.set(appId, { next: nextEntry, drop });
    swapTimer = setTimeout(performSwap, 3_000);
    current.browserWindow.once("closed", drop);
    nextEntry.browserWindow.once("closed", drop);
    nextEntry.view.webContents.once("did-finish-load", performSwap);
    nextEntry.view.webContents.once("render-process-gone", drop);
    return true;
  }

  /**
   * Granularly tears down a single revoked permission on ONE specific `appId` without disturbing
   * any other running Page App window (`t.Y` in `cNx1mZp_`).
   */
  teardownAppPermission(appId: string, permission: DesktopPageAppPermission): void {
    const entry = this.windowsByAppId.get(appId);
    if (!entry || entry.destroyed) return;
    const session = entry.session;

    const clearOverlay = () => {
      teardownOverlayForSession(session);
      entry.topStrip?.yieldDrag(false);
      if (entry.style.frame === false || entry.style.transparent === true) {
        this.rebuildWindowForStyle(appId);
      }
    };

    if (permission === "shortcuts") {
      teardownShortcutsForSession(session);
    } else if (permission === "menu-bar") {
      teardownTrayForSession(session);
    } else if (permission === "overlay") {
      clearOverlay();
    } else if (permission === "full-access") {
      teardownProcessesForSession(session);
      // Only tear down Tier 2 capabilities if they are no longer effectively granted.
      const checkStillGranted = (tier2: DesktopPageAppPermission) =>
        this.permissions.evaluate({
          accountId: session.accountId,
          orgId: session.orgId,
          appId: session.appId,
          permission: tier2,
          declaredPermissions: session.declaredPermissions,
          currentRevision: session.revision,
          currentContentHash: session.contentHash,
          hasMixedVersions: session.hasMixedVersions,
          trustKind: session.trustKind,
        }).state === "granted";

      if (!checkStillGranted("shortcuts")) teardownShortcutsForSession(session);
      if (!checkStillGranted("menu-bar")) teardownTrayForSession(session);
      if (!checkStillGranted("overlay")) clearOverlay();
    }
  }

  /**
   * Handles detection of an updated app revision while a standalone window is running:
   * marks mixed versions, kills active child/PTY processes for that app, clears alwaysOnTop,
   * and defers auto-reload until `blur` (`20s` cooldown / max `3` per `10min`), prompting via
   * `will-prevent-unload` if blocked by unsaved page state.
   */
  async handleAppRevisionChanged(
    appId: string,
    nextRevision: number,
    nextContentHash: string,
  ): Promise<void> {
    const entry = this.windowsByAppId.get(appId);
    if (!entry || entry.destroyed || entry.browserWindow.isDestroyed()) return;
    if (
      entry.pendingRevision === nextRevision &&
      entry.pendingContentHash === (nextContentHash || null) &&
      entry.session.revision === nextRevision
    ) {
      return;
    }

    entry.pendingRevision = nextRevision;
    entry.pendingContentHash = nextContentHash || null;
    (entry.session as { hasMixedVersions: boolean }).hasMixedVersions = true;
    this.teardownAppPermission(appId, "full-access");
    if (!entry.browserWindow.isDestroyed() && entry.style.alwaysOnTop) {
      entry.browserWindow.setAlwaysOnTop(false);
    }

    if (!entry.browserWindow.isFocused()) {
      const now = Date.now();
      const recent = entry.reloadTimestamps.filter((t) => now - t <= 10 * 60_000);
      entry.reloadTimestamps.length = 0;
      entry.reloadTimestamps.push(...recent);
      if (now - entry.lastAutoReloadAt >= 20_000 && recent.length < 3) {
        entry.lastAutoReloadAt = now;
        entry.reloadTimestamps.push(now);
        entry.view.webContents.reload();
      }
    }
  }

  closeAllWindows(): void {
    for (const rebuild of Array.from(this.rebuildsByAppId.values())) {
      rebuild.drop();
    }
    this.rebuildsByAppId.clear();
    for (const entry of Array.from(this.windowsByAppId.values())) {
      entry.retired = true;
      teardownSessionPrivilegedResources(entry.session);
      unregisterPageAppHeaderPolicy(entry.view.webContents.id);
      if (!entry.browserWindow.isDestroyed()) {
        entry.browserWindow.destroy();
      }
    }
    this.windowsByAppId.clear();
  }

  closeAppsRequiringFullAccess(): void {
    for (const entry of Array.from(this.windowsByAppId.values())) {
      if (entry.session.declaredPermissions.includes("full-access")) {
        this.teardownAppPermission(entry.appId, "full-access");
      }
    }
  }

  teardownAllPermissions(): void {
    for (const entry of Array.from(this.windowsByAppId.values())) {
      teardownSessionPrivilegedResources(entry.session);
    }
  }
}

export function resolveStandaloneWindowPreloadPath(baseDir: string = __dirname): string {
  return Path.join(baseDir, "pageAppWindowPreload.js");
}
