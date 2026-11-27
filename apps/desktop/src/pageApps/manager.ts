// FILE: manager.ts
// Purpose: Top-level orchestrator for Moss Desktop Page Apps (install/uninstall/open/menu/IPC/policy),
//          aligning fail-closed trust & declaredPermissions=[], WebGL2 materialization,
//          late-icon shortcut rotation, Tier 3 manager secondary confirmation, debounced
//          reportAppGone with flashFrame/abort, and standalone/main IPC state broadcast.
// Layer: Desktop pageApps

import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";

import {
  filterDeclaredDesktopPermissions,
  PAGE_APP_DESKTOP_IPC_CHANNELS,
  PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL,
  PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL,
  type DesktopPageAppGetPermissionsInput,
  type DesktopPageAppGoneInput,
  type DesktopPageAppInstallInput,
  type DesktopPageAppInstallResult,
  type DesktopPageAppMenuOffer,
  type DesktopPageAppNodeApiCallInput,
  type DesktopPageAppOpenInput,
  type DesktopPageAppOpenPermissionsInput,
  type DesktopPageAppOpenResult,
  type DesktopPageAppPermissionsSummary,
  type DesktopPageAppRequestPermissionsInput,
  type DesktopPageAppSetDesktopShortcutInput,
  type DesktopPageAppSetDesktopShortcutResult,
  type DesktopPageAppSetPermissionInput,
  type DesktopPageAppShowInFolderInput,
  type DesktopPageAppSyncVersionInput,
  type DesktopPageAppSyncVersionResult,
  type DesktopPageAppUninstallInput,
  type DesktopPageAppUninstallResult,
  type PageAppId,
  type PageAppPermissionState,
} from "@moss/contracts";
import { app, BrowserWindow, ipcMain, nativeImage, shell, type IpcMainInvokeEvent } from "electron";

import { createElectronPageAppDialogHost, type PageAppDialogHost } from "./dialogs";
import {
  buildPageAppIconsWithRace,
  pollWebContentsAppleTouchIconDataUrl,
  type BuiltPageAppIcons,
} from "./iconBuilder";
import { startInstallMaterializeEffect, warmMaterializeOverlay } from "./materializeOverlay";
import { createGestureTracker, PageAppNodeApiExecutor } from "./nodeApis";
import {
  buildPageAppAumid,
  collectExistingProgramNames,
  extractPageAppInstallIdFromArgv,
  findStaleInstalledApps,
  installOsArtifacts,
  removeOsArtifacts,
  resolvePageAppShortcutDirectories,
  sanitizePageAppInstallName,
  setDesktopShortcutArtifact,
} from "./osInstall";
import {
  DesktopPageAppPermissionEngine,
  DesktopPageAppPolicyWatcher,
  isDesktopPageAppPermission,
} from "./permissions";
import { DesktopPageAppStore } from "./store";
import {
  PAGE_APP_DESKTOP_PERMISSIONS,
  type DesktopPageAppInstallPlace,
  type DesktopPageAppPermission,
  type DesktopPageAppTrustKind,
  type InstalledDesktopPageApp,
} from "./types";
import {
  buildFileAppsMenuItem,
  resolveStandaloneWindowPreloadPath,
  StandalonePageAppWindowManager,
} from "./windowManager";

export interface DesktopPageAppsManagerOptions {
  readonly userDataDir: string;
  readonly stateDir: string;
  readonly executablePath: string;
  readonly resolveAppRouteUrl: (appId: string) => string;
  readonly resolveFrameOrigin: (appId: string) => string;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly resolveAccountContext?: () => {
    readonly accountId?: string | null;
    readonly orgId?: string | null;
  };
  readonly onApplicationMenuRefresh?: () => void;
  readonly onQuitAfterStandIn?: () => void;
  readonly onReportApp?: (appId: string) => void;
  readonly dialogs?: PageAppDialogHost;
}

function createInstallIdHex(): string {
  return Crypto.randomBytes(16).toString("hex");
}

function decodeThumbnailDataUrlToBgra(dataUrl: string, size: number): Buffer | null {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) return null;
    const resized = img.resize({ width: size, height: size, quality: "best" });
    const bitmap = resized.toBitmap();
    return bitmap.length === size * size * 4 ? bitmap : null;
  } catch {
    return null;
  }
}

function extractDeclaredPermissionsFromCapabilities(
  capabilities: Record<string, unknown> | undefined,
): DesktopPageAppPermission[] {
  if (!capabilities) return [];
  const desktop = capabilities.desktop;
  if (!desktop || typeof desktop !== "object" || Array.isArray(desktop)) return [];
  return filterDeclaredDesktopPermissions((desktop as { permissions?: unknown }).permissions);
}

const VALID_TRUST_KINDS = new Set<string>(["owner", "workspace", "external", "untrusted"]);

function resolveFailClosedTrust(
  explicit: unknown,
  stored: DesktopPageAppTrustKind | undefined,
  fallback: DesktopPageAppTrustKind,
): DesktopPageAppTrustKind {
  if (explicit !== undefined) {
    return typeof explicit === "string" && VALID_TRUST_KINDS.has(explicit)
      ? (explicit as DesktopPageAppTrustKind)
      : "untrusted";
  }
  if (stored !== undefined) {
    return VALID_TRUST_KINDS.has(stored) ? stored : "untrusted";
  }
  return fallback;
}

export class DesktopPageAppsManager {
  readonly store: DesktopPageAppStore;
  readonly permissions: DesktopPageAppPermissionEngine;
  readonly dialogs: PageAppDialogHost;
  readonly executor: PageAppNodeApiExecutor;
  readonly windowManager: StandalonePageAppWindowManager;
  readonly policyWatcher: DesktopPageAppPolicyWatcher;

  private readonly executablePath: string;
  private readonly aumidHelperCacheDir: string;
  private readonly resolveAppRouteUrl: (appId: string) => string;
  private readonly resolveFrameOrigin: (appId: string) => string;
  private readonly getMainWindow: () => BrowserWindow | null;
  private readonly resolveAccountContext?:
    | (() => { readonly accountId?: string | null; readonly orgId?: string | null })
    | undefined;
  private readonly onApplicationMenuRefresh?: (() => void) | undefined;
  private readonly onReportAppCallback?: ((appId: string) => void) | undefined;
  private readonly pendingGoneByAppId = new Map<
    string,
    { timer: ReturnType<typeof setTimeout> | null; abort: AbortController }
  >();
  private readonly mainGestureTrackers = new WeakMap<
    Electron.WebContents,
    ReturnType<typeof createGestureTracker>
  >();
  private menuOffers: DesktopPageAppMenuOffer[] = [];
  private policyPollTimer: ReturnType<typeof setInterval> | null = null;
  private pendingColdStartInstallId: string | null = null;

  constructor(options: DesktopPageAppsManagerOptions) {
    this.store = new DesktopPageAppStore(options.userDataDir);
    this.permissions = new DesktopPageAppPermissionEngine(this.store);
    this.policyWatcher = new DesktopPageAppPolicyWatcher();
    this.executablePath = options.executablePath;
    this.aumidHelperCacheDir = Path.join(options.stateDir, "taskbar-icons");
    this.resolveAppRouteUrl = options.resolveAppRouteUrl;
    this.resolveFrameOrigin = options.resolveFrameOrigin;
    this.getMainWindow = options.getMainWindow;
    this.resolveAccountContext = options.resolveAccountContext;
    this.onApplicationMenuRefresh = options.onApplicationMenuRefresh;
    this.onReportAppCallback = options.onReportApp;

    this.executor = new PageAppNodeApiExecutor({
      store: this.store,
      permissions: this.permissions,
      dialogs: undefined as unknown as PageAppDialogHost,
    });

    // Build windowManager first so dialog visibility hook can reference it cleanly.
    const placeholderDialogs = options.dialogs;
    this.dialogs =
      placeholderDialogs ??
      createElectronPageAppDialogHost({
        onDialogVisibilityChange: (visible, parent) =>
          this.windowManager.suppressHostForDialogs(visible, parent),
      });
    (this.executor as unknown as { dialogs: PageAppDialogHost }).dialogs = this.dialogs;

    this.windowManager = new StandalonePageAppWindowManager({
      store: this.store,
      permissions: this.permissions,
      dialogs: this.dialogs,
      executor: this.executor,
      preloadPath: resolveStandaloneWindowPreloadPath(),
      onAllClosedAfterStandInQuit: options.onQuitAfterStandIn,
      onTriggerInstall: async (appId) => {
        const open = this.windowManager.getOpenEntries().find((e) => e.appId === appId);
        return this.requestInstall(
          {
            appId: appId as PageAppId,
            title: open?.session.appName ?? "应用页",
            revision: open?.session.revision ?? 1,
            contentHash: open?.session.contentHash ?? null,
            capabilities: {
              desktop: { permissions: [...(open?.session.declaredPermissions ?? [])] },
            },
            sourceTrust: open?.session.trustKind ?? "untrusted",
          },
          open?.browserWindow ?? null,
        );
      },
      onManagePermissions: async (appId, parent) => {
        await this.openPermissionsDialog({ appId: appId as PageAppId }, parent);
      },
      onUninstallRequest: async (appId, parent) => {
        await this.uninstallWithConfirm({ appId: appId as PageAppId }, parent);
      },
      onReportApp: (appId) => this.handleReportApp(appId),
      onShowInFolder: (entry) => this.revealInstalledAppInFolder(entry),
    });
  }

  private getCurrentAccountOrg(): { readonly accountId: string; readonly orgId: string } {
    const ctx = this.resolveAccountContext?.();
    return {
      accountId: ctx?.accountId?.trim() || "local",
      orgId: ctx?.orgId?.trim() || "local",
    };
  }

  private handleReportApp(appId: string): void {
    if (this.onReportAppCallback) {
      this.onReportAppCallback(appId);
      return;
    }
    this.windowManager.leaveStandInForQuit();
    const mainWin = this.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      if (process.platform === "win32") mainWin.setSkipTaskbar(false);
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      this.emitPickedInMenu(appId, "open");
      return;
    }
    const installed = this.store.findInstalledByAppId(appId);
    const parent = this.windowManager.getWindowByAppId(appId);
    if (installed) {
      void this.dialogs.showAbout(
        {
          appName: installed.name,
          appId: installed.appId,
          revision: installed.revision,
          referenceText: installed.sourceUrl || this.resolveAppRouteUrl(installed.appId),
          trustDisclaimer: "如需举报或反馈此应用页问题，请在 Moss 主窗口中查看对应对话或分享来源。",
        },
        parent,
      );
    }
  }

  inspectInitialArgv(argv: readonly string[]): string | null {
    const installId = extractPageAppInstallIdFromArgv(argv);
    this.pendingColdStartInstallId = installId;
    return installId;
  }

  hasPendingColdStartApp(): boolean {
    return this.pendingColdStartInstallId !== null;
  }

  launchPendingColdStartApp(): boolean {
    const installId = this.pendingColdStartInstallId;
    if (!installId) return false;
    this.pendingColdStartInstallId = null;
    return this.openByInstallId(installId) !== null;
  }

  handleSecondInstanceArgv(argv: readonly string[]): boolean {
    const installId = extractPageAppInstallIdFromArgv(argv);
    if (!installId) return false;
    this.openByInstallId(installId);
    return true;
  }

  startPolicyPolling(intervalMs = 30_000): void {
    if (this.policyPollTimer) return;
    this.policyPollTimer = setInterval(() => {
      const transition = this.policyWatcher.poll();
      if (!transition) return;
      if (transition.appFeatureDisabled) {
        this.windowManager.closeAllWindows();
      } else if (transition.permissionsDisabled) {
        this.windowManager.teardownAllPermissions();
      } else if (transition.fullAccessDisabled) {
        this.windowManager.closeAppsRequiringFullAccess();
      }
    }, intervalMs);
  }

  dispose(): void {
    if (this.policyPollTimer) {
      clearInterval(this.policyPollTimer);
      this.policyPollTimer = null;
    }
    for (const pending of this.pendingGoneByAppId.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.abort.abort();
    }
    this.pendingGoneByAppId.clear();
    this.windowManager.closeAllWindows();
  }

  pruneStaleInstalled(): InstalledDesktopPageApp[] {
    const current = this.store.listInstalled();
    const { active, stale } = findStaleInstalledApps(current);
    if (stale.length > 0) {
      this.store.saveInstalledList(active);
      for (const item of stale) {
        this.store.removeAllIconSlots(item.installId);
        this.store.removePermissionsForApp(item.appId);
        this.store.setWindowStyle(item.installId, null);
      }
      this.notifyInstalledChanged(active);
      this.onApplicationMenuRefresh?.();
    }
    return active;
  }

  listInstalled(): InstalledDesktopPageApp[] {
    return this.pruneStaleInstalled();
  }

  isInstalled(appId: string): boolean {
    return this.pruneStaleInstalled().some((entry) => entry.appId === appId);
  }

  getInstalled(appId: string): InstalledDesktopPageApp | null {
    return this.pruneStaleInstalled().find((entry) => entry.appId === appId) ?? null;
  }

  setMenuOffers(offers: readonly DesktopPageAppMenuOffer[]): void {
    this.menuOffers = offers.slice(0, 50);
  }

  getMenuOffers(): readonly DesktopPageAppMenuOffer[] {
    return this.menuOffers;
  }

  emitPickedInMenu(appId: string, action: "install" | "open" = "open"): void {
    const mainWin = this.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      this.ensureMainGestureTracker(mainWin.webContents).recordGesture();
      mainWin.webContents.send(PAGE_APP_DESKTOP_IPC_CHANNELS.pickedInMenu, {
        appId,
        action,
      });
    }
  }

  private ensureMainGestureTracker(
    wc: Electron.WebContents,
  ): ReturnType<typeof createGestureTracker> {
    const existing = this.mainGestureTrackers.get(wc);
    if (existing) return existing;
    const tracker = createGestureTracker();
    this.mainGestureTrackers.set(wc, tracker);
    if (typeof wc.on === "function") {
      wc.on("before-mouse-event", (_e, mouse) => {
        if (mouse.type === "mouseDown") tracker.recordGesture();
      });
      wc.on("before-input-event", (_e, key) => {
        if (key.type === "keyDown" && !key.isAutoRepeat) tracker.recordGesture();
      });
      wc.on("input-event", (_e, ev) => {
        if (ev.type === "gestureTap") tracker.recordGesture();
      });
    }
    return tracker;
  }

  buildFileAppsMenu(locale: "zh-CN" | "en" = "zh-CN") {
    const installed = this.pruneStaleInstalled();
    return buildFileAppsMenuItem(
      installed,
      {
        onOpen: (entry) => {
          this.openByInstallId(entry.installId);
        },
        onShowInFolder: (entry) => this.revealInstalledAppInFolder(entry),
        onAbout: (entry) => {
          void this.dialogs.showAbout(
            {
              appName: entry.name,
              appId: entry.appId,
              revision: entry.revision,
              referenceText: entry.sourceUrl || `moss://apps/${entry.appId}`,
            },
            this.windowManager.getWindowByAppId(entry.appId) ?? this.getMainWindow(),
          );
        },
        onPermissions: (entry) => {
          void this.openPermissionsDialog(
            { appId: entry.appId },
            this.windowManager.getWindowByAppId(entry.appId) ?? this.getMainWindow(),
          );
        },
        onReport: (entry) => {
          this.handleReportApp(entry.appId);
        },
        onUninstall: (entry) => {
          void this.uninstallWithConfirm(
            { appId: entry.appId },
            this.windowManager.getWindowByAppId(entry.appId) ?? this.getMainWindow(),
          );
        },
      },
      locale,
    );
  }

  async requestInstall(
    input: DesktopPageAppInstallInput,
    parentWindow: BrowserWindow | null = this.getMainWindow(),
  ): Promise<DesktopPageAppInstallResult> {
    const policy = this.permissions.getPolicyState();
    if (!policy.enabled) {
      return { status: "disabled" };
    }

    const existing = this.pruneStaleInstalled().find((e) => e.appId === input.appId);
    if (existing) {
      const action = await this.dialogs.showAlreadyInstalled(
        { appName: existing.name },
        parentWindow,
      );
      let opened = false;
      if (action === "open") {
        opened = this.openInstalled(existing) !== null;
      } else if (action === "show-in-folder") {
        this.revealInstalledAppInFolder(existing);
      }
      return { status: "already-installed", app: existing, opened };
    }

    const rawTitle = input.title?.trim() || "未命名应用";
    const dirs = resolvePageAppShortcutDirectories();
    const existingProgramNames = collectExistingProgramNames(dirs.scanDirsForCollisions);
    const sanitizedName = sanitizePageAppInstallName(rawTitle, existingProgramNames);

    warmMaterializeOverlay();

    const confirmed = await this.dialogs.confirmInstall({ appName: sanitizedName }, parentWindow);
    if (!confirmed) {
      return { status: "cancelled" };
    }

    const mainWin = this.getMainWindow();
    const isMainOrigin = Boolean(parentWindow && mainWin && parentWindow === mainWin);
    const { accountId, orgId } = this.getCurrentAccountOrg();
    const declaredPermissions = extractDeclaredPermissionsFromCapabilities(
      input.capabilities as Record<string, unknown> | undefined,
    );
    const effectiveTrust = resolveFailClosedTrust(
      input.sourceTrust,
      undefined,
      isMainOrigin ? "owner" : "untrusted",
    );

    const installId = createInstallIdHex();
    const places: readonly DesktopPageAppInstallPlace[] =
      process.platform === "darwin" ? ["applications"] : ["start-menu", "desktop"];

    const pageIconPromise =
      parentWindow && !parentWindow.isDestroyed()
        ? pollWebContentsAppleTouchIconDataUrl(parentWindow.webContents, 10_000)
        : null;

    const persistIconsAndShortcuts = (
      icons: BuiltPageAppIcons,
      prevSlot?: number,
    ): {
      iconPath: string;
      iconSlot: number;
      shortcutPaths: string[];
      bundlePath: string | null;
    } => {
      const isDarwin = process.platform === "darwin";
      const writtenIcon = this.store.writeRotatedIcon(
        installId,
        isDarwin ? icons.png256 : icons.ico,
        prevSlot,
        isDarwin ? "png" : "ico",
      );
      const osArtifacts = installOsArtifacts({
        installId,
        name: sanitizedName,
        description: sanitizedName,
        executablePath: this.executablePath,
        iconPath: writtenIcon.iconPath,
        png256: icons.png256,
        places,
        aumidHelperCacheDir: this.aumidHelperCacheDir,
        ops: {
          writeWindowsShortcut: (lnkPath, opts) =>
            shell.writeShortcutLink(lnkPath, "create", {
              target: opts.target,
              args: opts.args,
              icon: opts.icon,
              iconIndex: opts.iconIndex,
              description: opts.description,
              appUserModelId: opts.appUserModelId,
            }),
        },
      });
      return {
        iconPath: writtenIcon.iconPath,
        iconSlot: writtenIcon.iconSlot,
        shortcutPaths: [...osArtifacts.shortcutPaths],
        bundlePath: osArtifacts.bundlePath,
      };
    };

    const icons = await buildPageAppIconsWithRace({
      title: sanitizedName,
      seedUuid: input.appId,
      thumbnailDataUrl: input.iconDataUrl ?? input.thumbnail ?? null,
      decodeThumbnailToBgra: decodeThumbnailDataUrlToBgra,
      pageIconPromise,
      timeoutMs: 5_000,
      onLateArrival: (lateIcons) => {
        const currentInstalled = this.store.findInstalledByInstallId(installId);
        if (!currentInstalled) return;
        const rotated = persistIconsAndShortcuts(lateIcons, currentInstalled.iconSlot);
        const updatedRecord: InstalledDesktopPageApp = {
          ...currentInstalled,
          iconPath: rotated.iconPath,
          iconSlot: rotated.iconSlot,
          shortcutPaths: rotated.shortcutPaths,
          bundlePath: rotated.bundlePath,
          updatedAt: new Date().toISOString(),
        };
        const updatedList = this.store.upsertInstalled(updatedRecord);
        this.notifyInstalledChanged(updatedList);
        const openWin = this.windowManager.getWindowByAppId(input.appId);
        if (openWin && !openWin.isDestroyed() && process.platform === "win32") {
          try {
            openWin.setIcon(rotated.iconPath);
            openWin.setAppDetails({
              appId: buildPageAppAumid(installId),
              appIconPath: rotated.iconPath,
              appIconIndex: 0,
              relaunchCommand: `"${this.executablePath}" --moss-app=${installId}`,
              relaunchDisplayName: sanitizedName,
            });
          } catch {
            // Ignore transient window realization error.
          }
        }
      },
    });

    const initialArtifacts = persistIconsAndShortcuts(icons);

    const now = new Date().toISOString();
    const revision = input.revision ?? 1;
    const record: InstalledDesktopPageApp = {
      installId,
      appId: input.appId,
      ...(input.scopeSpaceId !== undefined ? { scopeSpaceId: input.scopeSpaceId } : {}),
      name: sanitizedName,
      rawTitle,
      revision,
      contentHash: input.contentHash ?? null,
      places: [...places],
      kind: "page-app",
      iconPath: initialArtifacts.iconPath,
      iconSlot: initialArtifacts.iconSlot,
      aumid: buildPageAppAumid(installId),
      shortcutPaths: initialArtifacts.shortcutPaths,
      bundlePath: initialArtifacts.bundlePath,
      ...(declaredPermissions.length > 0 ? { declaredPermissions } : {}),
      installedAt: now,
      updatedAt: now,
      accountId,
      orgId,
      sourceUrl: this.resolveAppRouteUrl(input.appId),
      sourceTrust: effectiveTrust,
    };

    const nextList = this.store.upsertInstalled(record);
    this.notifyInstalledChanged(nextList);
    this.onApplicationMenuRefresh?.();

    const openedWin = this.openInstalled(record, {
      declaredPermissions,
      trustKind: effectiveTrust,
      hidden: Boolean(parentWindow && !parentWindow.isDestroyed()),
    });

    let sourceCovered = false;
    if (openedWin && parentWindow && !parentWindow.isDestroyed()) {
      const materialize = startInstallMaterializeEffect({
        targetWindow: openedWin,
        hostWindow: parentWindow,
        hiddenTarget: true,
        sourceRect: input.sourceRect ?? parentWindow.getBounds(),
        iconDataUrl: `data:image/png;base64,${icons.png256.toString("base64")}`,
      });
      materialize.reveal();
      const [covered] = await Promise.all([materialize.sourceCovered, materialize.finished]);
      sourceCovered = covered;
    }

    if (!sourceCovered) {
      const completeChoice = await this.dialogs.showInstallComplete(
        { appName: record.name, places },
        openedWin && !openedWin.isDestroyed() ? openedWin : parentWindow,
      );
      if (completeChoice === "show-in-folder") {
        this.revealInstalledAppInFolder(record);
      }
    }

    return { status: "installed", app: record, opened: openedWin !== null };
  }

  openByInstallId(installId: string): BrowserWindow | null {
    const installed = this.pruneStaleInstalled().find((e) => e.installId === installId);
    if (!installed) return null;
    return this.openInstalled(installed);
  }

  openInstalled(
    installed: InstalledDesktopPageApp,
    overrides?: {
      readonly declaredPermissions?: readonly DesktopPageAppPermission[] | undefined;
      readonly trustKind?: DesktopPageAppTrustKind | undefined;
      readonly hidden?: boolean | undefined;
    },
  ): BrowserWindow | null {
    if (!this.permissions.getPolicyState().enabled) return null;
    const ctx = this.getCurrentAccountOrg();
    const declaredPermissions =
      overrides?.declaredPermissions ??
      (
        installed as InstalledDesktopPageApp & {
          declaredPermissions?: readonly DesktopPageAppPermission[];
        }
      ).declaredPermissions ??
      [];
    const trustKind = resolveFailClosedTrust(
      overrides?.trustKind,
      installed.sourceTrust,
      "untrusted",
    );
    const entry = this.windowManager.openOrFocus({
      appId: installed.appId,
      installId: installed.installId,
      accountId: installed.accountId ?? ctx.accountId,
      orgId: installed.orgId ?? ctx.orgId,
      appName: installed.name,
      isInstalled: true,
      revision: installed.revision,
      contentHash: installed.contentHash ?? null,
      declaredPermissions,
      trustKind,
      targetUrl: this.resolveAppRouteUrl(installed.appId),
      expectedFrameOrigin: this.resolveFrameOrigin(installed.appId),
      iconPath: installed.iconPath ?? null,
      referenceText: installed.sourceUrl ?? this.resolveAppRouteUrl(installed.appId),
      executablePath: this.executablePath,
      ...(overrides?.hidden !== undefined ? { hidden: overrides.hidden } : {}),
    });
    return entry.browserWindow;
  }

  openStandalone(input: DesktopPageAppOpenInput, callerIsMain = true): DesktopPageAppOpenResult {
    if (!this.permissions.getPolicyState().enabled) {
      return { opened: false, reason: "policy_blocked" };
    }
    const ctx = this.getCurrentAccountOrg();

    if (input.installId) {
      const installed = this.pruneStaleInstalled().find((e) => e.installId === input.installId);
      if (installed) {
        const declared = extractDeclaredPermissionsFromCapabilities(
          input.capabilities as Record<string, unknown> | undefined,
        );
        const win = this.openInstalled(installed, {
          ...(declared.length > 0 ? { declaredPermissions: declared } : {}),
          ...(input.sourceTrust !== undefined ? { trustKind: input.sourceTrust } : {}),
        });
        return {
          opened: win !== null,
          ...(win ? { windowId: win.id } : {}),
          installId: installed.installId,
        };
      }
    }
    if (input.appId) {
      const installed = this.pruneStaleInstalled().find((e) => e.appId === input.appId);
      if (installed) {
        const declared = extractDeclaredPermissionsFromCapabilities(
          input.capabilities as Record<string, unknown> | undefined,
        );
        const win = this.openInstalled(installed, {
          ...(declared.length > 0 ? { declaredPermissions: declared } : {}),
          ...(input.sourceTrust !== undefined ? { trustKind: input.sourceTrust } : {}),
        });
        return {
          opened: win !== null,
          ...(win ? { windowId: win.id } : {}),
          installId: installed.installId,
        };
      }
      const declared = extractDeclaredPermissionsFromCapabilities(
        input.capabilities as Record<string, unknown> | undefined,
      );
      const trustKind = resolveFailClosedTrust(
        input.sourceTrust,
        undefined,
        callerIsMain ? "owner" : "untrusted",
      );
      const entry = this.windowManager.openOrFocus({
        appId: input.appId,
        installId: null,
        accountId: ctx.accountId,
        orgId: ctx.orgId,
        appName: input.title ?? "应用页",
        isInstalled: false,
        revision: input.revision ?? 1,
        contentHash: input.contentHash ?? null,
        declaredPermissions: declared,
        trustKind,
        targetUrl: this.resolveAppRouteUrl(input.appId),
        expectedFrameOrigin: this.resolveFrameOrigin(input.appId),
        iconPath: null,
        referenceText: this.resolveAppRouteUrl(input.appId),
        executablePath: this.executablePath,
      });
      return { opened: true, windowId: entry.browserWindow.id };
    }
    return { opened: false, reason: "not_found" };
  }

  getPermissionsSummary(
    input: DesktopPageAppGetPermissionsInput,
  ): DesktopPageAppPermissionsSummary {
    const installed = this.store.findInstalledByAppId(input.appId);
    const open = this.windowManager.getOpenEntries().find((e) => e.appId === input.appId);
    const ctx = this.getCurrentAccountOrg();
    const installedDeclared =
      (
        installed as
          | (InstalledDesktopPageApp & {
              declaredPermissions?: readonly DesktopPageAppPermission[];
            })
          | null
      )?.declaredPermissions ?? [];
    const declared =
      input.declared && input.declared.length > 0
        ? input.declared
        : (open?.session.declaredPermissions ?? installedDeclared);
    return this.permissions.summarize({
      accountId: open?.session.accountId ?? installed?.accountId ?? ctx.accountId,
      orgId: open?.session.orgId ?? installed?.orgId ?? ctx.orgId,
      appId: input.appId,
      declaredPermissions: declared,
      currentRevision: input.revision ?? open?.session.revision ?? installed?.revision ?? 1,
      currentContentHash:
        input.contentHash !== undefined
          ? input.contentHash
          : (open?.session.contentHash ?? installed?.contentHash ?? null),
      hasMixedVersions: Boolean(open?.session.hasMixedVersions),
      trustKind: resolveFailClosedTrust(
        undefined,
        open?.session.trustKind ?? installed?.sourceTrust,
        "untrusted",
      ),
    });
  }

  async requestPermissions(
    input: DesktopPageAppRequestPermissionsInput,
    parentWindow: BrowserWindow | null = this.getMainWindow(),
  ): Promise<Record<string, PageAppPermissionState>> {
    const installed = this.store.findInstalledByAppId(input.appId);
    const open = this.windowManager.getOpenEntries().find((e) => e.appId === input.appId);
    const ctx = this.getCurrentAccountOrg();
    const accountId = open?.session.accountId ?? installed?.accountId ?? ctx.accountId;
    const orgId = open?.session.orgId ?? installed?.orgId ?? ctx.orgId;
    const revision = input.revision ?? open?.session.revision ?? installed?.revision ?? 1;
    const contentHash =
      input.contentHash !== undefined
        ? input.contentHash
        : (open?.session.contentHash ?? installed?.contentHash ?? null);
    const installedDeclared =
      (
        installed as
          | (InstalledDesktopPageApp & {
              declaredPermissions?: readonly DesktopPageAppPermission[];
            })
          | null
      )?.declaredPermissions ?? [];
    const declared =
      input.permissions && input.permissions.length > 0
        ? input.permissions
        : (open?.session.declaredPermissions ?? installedDeclared);
    const trustKind = resolveFailClosedTrust(
      input.sourceTrust,
      open?.session.trustKind ?? installed?.sourceTrust,
      "untrusted",
    );
    const appName = input.title ?? open?.session.appName ?? installed?.name ?? "应用页";

    const sortedPerms = [...declared].toSorted(
      (a, b) => Number(b === "full-access") - Number(a === "full-access"),
    );

    for (const perm of sortedPerms) {
      const current = this.permissions.evaluateAll({
        accountId,
        orgId,
        appId: input.appId,
        declaredPermissions: declared,
        currentRevision: revision,
        currentContentHash: contentHash,
        hasMixedVersions: Boolean(open?.session.hasMixedVersions),
        trustKind,
      });
      const ev = current[perm];
      if (!ev || ev.state !== "prompt") continue;
      const hasRefusedTier2 = PAGE_APP_DESKTOP_PERMISSIONS.some(
        (p) => p !== "full-access" && current[p]?.state === "denied",
      );
      const allowed = await this.dialogs.confirmPermission(
        {
          appName,
          permission: perm,
          isReapproval: ev.isReapproval,
          trustKind,
          hasRefusedTier2,
        },
        parentWindow,
      );
      if (perm === "full-access" && trustKind === "untrusted") {
        continue;
      }
      this.permissions.setPermission({
        accountId,
        orgId,
        appId: input.appId,
        permission: perm,
        answer: allowed ? "granted" : "denied",
        revision,
        contentHash,
        declaredPermissions: declared,
      });
    }

    const summary = this.getPermissionsSummary({
      appId: input.appId,
      revision,
      contentHash,
      declared: [...declared],
    });
    this.notifyPermissionsChanged(input.appId, summary);
    return summary.states;
  }

  setPermission(input: DesktopPageAppSetPermissionInput): DesktopPageAppPermissionsSummary {
    const installed = this.store.findInstalledByAppId(input.appId);
    const open = this.windowManager.getOpenEntries().find((e) => e.appId === input.appId);
    const ctx = this.getCurrentAccountOrg();
    const accountId = open?.session.accountId ?? installed?.accountId ?? ctx.accountId;
    const orgId = open?.session.orgId ?? installed?.orgId ?? ctx.orgId;
    const revision = input.revision ?? open?.session.revision ?? installed?.revision ?? 1;
    const contentHash =
      input.contentHash !== undefined
        ? input.contentHash
        : (open?.session.contentHash ?? installed?.contentHash ?? null);
    const installedDeclared =
      (
        installed as
          | (InstalledDesktopPageApp & {
              declaredPermissions?: readonly DesktopPageAppPermission[];
            })
          | null
      )?.declaredPermissions ?? [];
    const declared = open?.session.declaredPermissions ?? installedDeclared;

    const result = this.permissions.setPermission({
      accountId,
      orgId,
      appId: input.appId,
      permission: input.permission,
      answer: input.answer,
      revision,
      contentHash,
      declaredPermissions: declared,
      ...(input.coversTier2 !== undefined ? { coversTier2: input.coversTier2 } : {}),
    });
    if (result.revokedPermissions.length > 0) {
      for (const revokedPerm of result.revokedPermissions) {
        this.windowManager.teardownAppPermission(input.appId, revokedPerm);
      }
    }
    const summary = this.getPermissionsSummary({
      appId: input.appId,
      revision,
      contentHash,
      declared: [...declared],
    });
    this.notifyPermissionsChanged(input.appId, summary);
    return summary;
  }

  async openPermissionsDialog(
    input: DesktopPageAppOpenPermissionsInput,
    parentWindow: BrowserWindow | null = this.getMainWindow(),
  ): Promise<void> {
    const installed = this.store.findInstalledByAppId(input.appId);
    const open = this.windowManager.getOpenEntries().find((e) => e.appId === input.appId);
    const ctx = this.getCurrentAccountOrg();
    const accountId = open?.session.accountId ?? installed?.accountId ?? ctx.accountId;
    const orgId = open?.session.orgId ?? installed?.orgId ?? ctx.orgId;
    const revision = input.revision ?? open?.session.revision ?? installed?.revision ?? 1;
    const contentHash =
      input.contentHash !== undefined
        ? input.contentHash
        : (open?.session.contentHash ?? installed?.contentHash ?? null);
    const installedDeclared =
      (
        installed as
          | (InstalledDesktopPageApp & {
              declaredPermissions?: readonly DesktopPageAppPermission[];
            })
          | null
      )?.declaredPermissions ?? [];
    const declared =
      input.permissions && input.permissions.length > 0
        ? input.permissions
        : (open?.session.declaredPermissions ?? installedDeclared);
    const mainWin = this.getMainWindow();
    const isMainOrigin = Boolean(parentWindow && mainWin && parentWindow === mainWin);
    const trustKind = resolveFailClosedTrust(
      input.sourceTrust,
      open?.session.trustKind ?? installed?.sourceTrust,
      isMainOrigin ? "owner" : "untrusted",
    );
    const appName = input.title ?? open?.session.appName ?? installed?.name ?? "应用页";

    const currentStates = this.permissions.evaluateAll({
      accountId,
      orgId,
      appId: input.appId,
      declaredPermissions: declared,
      currentRevision: revision,
      currentContentHash: contentHash,
      hasMixedVersions: Boolean(open?.session.hasMixedVersions),
      trustKind,
    });
    const policy = this.permissions.getPolicyState();
    const policyBlockedPermissions = declared.filter((perm) =>
      perm === "full-access" ? !policy.fullAccessEnabled : !policy.permissionsEnabled,
    );

    const result = await this.dialogs.managePermissions(
      {
        appName,
        hasActiveRunningApp: Boolean(open),
        unavailableReason: open?.session.hasMixedVersions ? "unavailable" : "none",
        policyBlockedPermissions,
        items: PAGE_APP_DESKTOP_PERMISSIONS.map((perm) => ({
          permission: perm,
          state: currentStates[perm].state,
          declared: currentStates[perm].declared,
          coveredByFullAccess: currentStates[perm].coveredByFullAccess,
          endsOverlay: Boolean(
            open &&
            (open.style.frame === false || open.style.transparent === true) &&
            currentStates.overlay.state === "granted",
          ),
        })),
      },
      parentWindow,
    );

    if (!result.saved) return;

    const nextFullDesired = result.grants["full-access"];
    const nextFullEnabled =
      typeof nextFullDesired === "boolean"
        ? nextFullDesired
        : currentStates["full-access"].state === "granted";

    // Pass 1: apply explicit revocations immediately and tear down ONLY for this app.
    for (const perm of PAGE_APP_DESKTOP_PERMISSIONS) {
      if (!currentStates[perm].declared || currentStates[perm].state === "unavailable") continue;
      const desired = result.grants[perm];
      if (desired === false || (desired === null && !nextFullEnabled)) {
        if (currentStates[perm].state === "granted" || desired === false) {
          const setResult = this.permissions.setPermission({
            accountId,
            orgId,
            appId: input.appId,
            permission: perm,
            answer: "denied",
            revision,
            contentHash,
            declaredPermissions: declared,
          });
          for (const revoked of setResult.revokedPermissions) {
            this.windowManager.teardownAppPermission(input.appId, revoked);
          }
          if (desired === false) {
            this.windowManager.teardownAppPermission(input.appId, perm);
          }
        }
      }
    }

    // Pass 2: process grants (full-access first; secondary confirmation for full-access or external/workspace Tier 2)
    const toEnable = PAGE_APP_DESKTOP_PERMISSIONS.filter((perm) => {
      if (!currentStates[perm].declared || currentStates[perm].state === "unavailable")
        return false;
      const desired = result.grants[perm];
      return desired === true && currentStates[perm].state !== "granted";
    }).toSorted((a, b) => Number(b === "full-access") - Number(a === "full-access"));

    const hasRefusedTier2 = PAGE_APP_DESKTOP_PERMISSIONS.some(
      (p) =>
        p !== "full-access" && (result.grants[p] === false || currentStates[p].state === "denied"),
    );

    for (const perm of toEnable) {
      const needsSecondaryConfirm =
        perm === "full-access" || trustKind === "external" || trustKind === "untrusted";
      if (needsSecondaryConfirm) {
        const confirmed = await this.dialogs.confirmPermission(
          {
            appName,
            permission: perm,
            trustKind,
            hasRefusedTier2,
          },
          parentWindow,
        );
        if (!confirmed || (perm === "full-access" && trustKind === "untrusted")) {
          continue;
        }
      }
      this.permissions.setPermission({
        accountId,
        orgId,
        appId: input.appId,
        permission: perm,
        answer: "granted",
        revision,
        contentHash,
        declaredPermissions: declared,
      });
    }

    const summary = this.getPermissionsSummary({
      appId: input.appId,
      revision,
      contentHash,
      declared: [...declared],
    });
    this.notifyPermissionsChanged(input.appId, summary);
  }

  async syncAppVersion(
    input: DesktopPageAppSyncVersionInput,
  ): Promise<DesktopPageAppSyncVersionResult> {
    const installed = this.store.findInstalledByAppId(input.appId);
    const open = this.windowManager.getOpenEntries().find((e) => e.appId === input.appId);
    const nextHash = input.contentHash ?? null;
    const prevRevision = open?.session.revision ?? installed?.revision ?? input.revision;
    const prevHash = open?.session.contentHash ?? installed?.contentHash ?? null;
    const changed = prevRevision !== input.revision || prevHash !== nextHash;
    const updatedDeclared = extractDeclaredPermissionsFromCapabilities(
      input.capabilities as Record<string, unknown> | undefined,
    );
    const trimmedTitle = input.title?.trim();
    const titleChanged =
      Boolean(installed) &&
      Boolean(trimmedTitle) &&
      trimmedTitle !== (installed?.rawTitle ?? installed?.name);

    if (installed && (changed || updatedDeclared.length > 0 || titleChanged)) {
      let nextName = installed.name;
      let nextShortcutPaths = [...(installed.shortcutPaths ?? [])];
      let nextBundlePath = installed.bundlePath ?? null;
      if (titleChanged && trimmedTitle) {
        const dirs = resolvePageAppShortcutDirectories();
        const existingNames = new Set<string>();
        for (const dir of dirs.scanDirsForCollisions) {
          try {
            if (!FS.existsSync(dir)) continue;
            for (const entry of FS.readdirSync(dir)) {
              const lower = entry.toLowerCase();
              const base =
                lower.endsWith(".lnk") || lower.endsWith(".app") ? entry.slice(0, -4) : entry;
              if (base.toLowerCase() !== installed.name.toLowerCase()) {
                existingNames.add(base.toLowerCase());
              }
            }
          } catch {
            // Ignore directory read error.
          }
        }
        const candidateName = sanitizePageAppInstallName(trimmedTitle, existingNames);
        if (candidateName !== installed.name) {
          removeOsArtifacts(installed);
          const png256 =
            installed.iconPath && FS.existsSync(installed.iconPath)
              ? FS.readFileSync(installed.iconPath)
              : undefined;
          const rebuilt = installOsArtifacts({
            installId: installed.installId,
            name: candidateName,
            description: trimmedTitle,
            executablePath: this.executablePath,
            iconPath: installed.iconPath ?? "",
            ...(png256 ? { png256 } : {}),
            places: installed.places,
            aumidHelperCacheDir: this.aumidHelperCacheDir,
            ops: {
              writeWindowsShortcut: (lnkPath, opts) =>
                shell.writeShortcutLink(lnkPath, "create", {
                  target: opts.target,
                  args: opts.args,
                  icon: opts.icon,
                  iconIndex: opts.iconIndex,
                  description: opts.description,
                  appUserModelId: opts.appUserModelId,
                }),
            },
          });
          nextName = candidateName;
          nextShortcutPaths = [...rebuilt.shortcutPaths];
          nextBundlePath = rebuilt.bundlePath;
        }
      }

      const updatedList = this.store.upsertInstalled({
        ...installed,
        name: nextName,
        shortcutPaths: nextShortcutPaths,
        bundlePath: nextBundlePath,
        revision: input.revision,
        contentHash: nextHash,
        ...(trimmedTitle ? { rawTitle: trimmedTitle } : {}),
        ...(updatedDeclared.length > 0 ? { declaredPermissions: updatedDeclared } : {}),
        updatedAt: new Date().toISOString(),
      });
      if (titleChanged) {
        this.notifyInstalledChanged(updatedList);
        const openWin = this.windowManager.getWindowByAppId(input.appId);
        if (openWin && !openWin.isDestroyed()) {
          try {
            openWin.setTitle(nextName);
            if (process.platform === "win32") {
              openWin.setAppDetails({
                appId: buildPageAppAumid(installed.installId),
                ...(installed.iconPath ? { appIconPath: installed.iconPath, appIconIndex: 0 } : {}),
                relaunchCommand: `"${this.executablePath}" --moss-app=${installed.installId}`,
                relaunchDisplayName: nextName,
              });
            }
          } catch {
            // Ignore window title error.
          }
        }
      }
    }

    let reloaded = false;
    if (open && changed) {
      await this.windowManager.handleAppRevisionChanged(
        input.appId,
        input.revision,
        nextHash ?? "",
      );
      reloaded = !open.session.hasMixedVersions;
    }

    return { invalidated: changed, reloaded };
  }

  setDesktopShortcut(
    input: DesktopPageAppSetDesktopShortcutInput,
  ): DesktopPageAppSetDesktopShortcutResult {
    const installed = input.installId
      ? this.store.findInstalledByInstallId(input.installId)
      : input.appId
        ? this.store.findInstalledByAppId(input.appId)
        : undefined;
    if (!installed) {
      return { updated: false, app: null, desktopShortcutEnabled: false };
    }
    const png256 =
      installed.iconPath && FS.existsSync(installed.iconPath)
        ? FS.readFileSync(installed.iconPath)
        : undefined;
    const result = setDesktopShortcutArtifact({
      entry: installed,
      enabled: Boolean(input.enabled),
      executablePath: this.executablePath,
      ...(png256 ? { png256 } : {}),
      aumidHelperCacheDir: this.aumidHelperCacheDir,
      ops: {
        writeWindowsShortcut: (lnkPath, opts) =>
          shell.writeShortcutLink(lnkPath, "create", {
            target: opts.target,
            args: opts.args,
            icon: opts.icon,
            iconIndex: opts.iconIndex,
            description: opts.description,
            appUserModelId: opts.appUserModelId,
          }),
      },
    });
    const updatedRecord: InstalledDesktopPageApp = {
      ...installed,
      places: result.places,
      shortcutPaths: result.shortcutPaths,
      updatedAt: new Date().toISOString(),
    };
    const updatedList = this.store.upsertInstalled(updatedRecord);
    this.notifyInstalledChanged(updatedList);
    return {
      updated: true,
      app: updatedRecord,
      desktopShortcutEnabled: result.desktopShortcutEnabled,
    };
  }

  async reportAppGone(
    input: DesktopPageAppGoneInput,
    parentWindow: BrowserWindow | null = this.getMainWindow(),
  ): Promise<void> {
    const existing = this.pendingGoneByAppId.get(input.appId);
    if (input.gone === false) {
      if (existing) {
        if (existing.timer) clearTimeout(existing.timer);
        existing.abort.abort();
        this.pendingGoneByAppId.delete(input.appId);
      }
      return;
    }

    if (existing) {
      if (existing.timer) clearTimeout(existing.timer);
      existing.abort.abort();
      this.pendingGoneByAppId.delete(input.appId);
    }

    const abort = new AbortController();
    const record: { timer: ReturnType<typeof setTimeout> | null; abort: AbortController } = {
      timer: null,
      abort,
    };
    this.pendingGoneByAppId.set(input.appId, record);

    const aborted = await new Promise<boolean>((resolve) => {
      const finish = (wasAborted: boolean) => {
        if (record.timer) {
          clearTimeout(record.timer);
          record.timer = null;
        }
        abort.signal.removeEventListener("abort", onAbort);
        resolve(wasAborted);
      };
      const onAbort = () => finish(true);
      abort.signal.addEventListener("abort", onAbort);
      record.timer = setTimeout(() => finish(false), 3_000);
    });

    if (aborted || abort.signal.aborted) return;

    // Stop active privileged processes for this unavailable app.
    this.windowManager.teardownAppPermission(input.appId, "full-access");

    const installed = this.store.findInstalledByAppId(input.appId);
    const open = this.windowManager.getOpenEntries().find((e) => e.appId === input.appId);
    const appName = input.title ?? open?.session.appName ?? installed?.name ?? "应用页";

    if (open && !open.browserWindow.isDestroyed() && !open.browserWindow.isFocused()) {
      open.browserWindow.flashFrame(true);
      const focusedOrAborted = await new Promise<"focused" | "aborted" | "closed">((resolve) => {
        const win = open.browserWindow;
        const cleanup = () => {
          win.removeListener("focus", onFocus);
          win.removeListener("closed", onClosed);
          abort.signal.removeEventListener("abort", onAbort);
        };
        const onFocus = () => {
          cleanup();
          resolve("focused");
        };
        const onClosed = () => {
          cleanup();
          resolve("closed");
        };
        const onAbort = () => {
          cleanup();
          resolve("aborted");
        };
        win.once("focus", onFocus);
        win.once("closed", onClosed);
        abort.signal.addEventListener("abort", onAbort);
      });
      if (!open.browserWindow.isDestroyed()) {
        open.browserWindow.flashFrame(false);
      }
      if (focusedOrAborted !== "focused") {
        this.pendingGoneByAppId.delete(input.appId);
        return;
      }
    }

    if (abort.signal.aborted) return;

    const action = await this.dialogs.showUnavailable(
      { appName },
      open?.browserWindow ?? parentWindow,
    );
    this.pendingGoneByAppId.delete(input.appId);
    if (!abort.signal.aborted && action === "uninstall") {
      this.uninstall({ appId: input.appId, skipConfirm: true });
    }
  }

  async uninstallWithConfirm(
    input: DesktopPageAppUninstallInput,
    parentWindow: BrowserWindow | null = this.getMainWindow(),
  ): Promise<DesktopPageAppUninstallResult> {
    const installed =
      (input.installId ? this.store.findInstalledByInstallId(input.installId) : null) ??
      (input.appId ? this.store.findInstalledByAppId(input.appId) : null);
    if (!installed) {
      return { uninstalled: false, removedAppIds: [], removedInstallIds: [] };
    }
    const isOpen = Boolean(this.windowManager.getWindowByAppId(installed.appId));
    if (!input.skipConfirm) {
      const ok = await this.dialogs.confirmUninstall(
        { appName: installed.name, isOpen },
        parentWindow,
      );
      if (!ok) {
        return { uninstalled: false, removedAppIds: [], removedInstallIds: [] };
      }
    }
    return this.uninstall({ ...input, skipConfirm: true });
  }

  uninstall(input: DesktopPageAppUninstallInput): DesktopPageAppUninstallResult {
    const installed =
      (input.installId ? this.store.findInstalledByInstallId(input.installId) : null) ??
      (input.appId ? this.store.findInstalledByAppId(input.appId) : null);
    if (!installed) {
      return { uninstalled: false, removedAppIds: [], removedInstallIds: [] };
    }

    const openWindow = this.windowManager.getWindowByAppId(installed.appId);
    if (openWindow && !openWindow.isDestroyed()) {
      openWindow.destroy();
    }
    removeOsArtifacts(installed);
    this.store.removeAllIconSlots(installed.installId);
    this.store.removeInstalledByInstallId(installed.installId);
    this.store.removePermissionsForApp(installed.appId);
    this.store.setWindowStyle(installed.installId, null);

    const remaining = this.store.listInstalled();
    this.notifyInstalledChanged(remaining);
    this.onApplicationMenuRefresh?.();
    return {
      uninstalled: true,
      removedAppIds: [installed.appId],
      removedInstallIds: [installed.installId],
    };
  }

  revealInstalledAppInFolder(entry: InstalledDesktopPageApp): boolean {
    const target = entry.shortcutPaths?.[0] ?? entry.bundlePath ?? entry.iconPath;
    if (target) {
      shell.showItemInFolder(target);
      return true;
    }
    return false;
  }

  showInFolderByQuery(input: DesktopPageAppShowInFolderInput): boolean {
    const installed =
      (input.installId ? this.store.findInstalledByInstallId(input.installId) : null) ??
      (input.appId ? this.store.findInstalledByAppId(input.appId) : null);
    if (!installed) return false;
    return this.revealInstalledAppInFolder(installed);
  }

  private notifyInstalledChanged(apps: readonly InstalledDesktopPageApp[]): void {
    const mainWin = this.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(PAGE_APP_DESKTOP_IPC_CHANNELS.installedChanged, apps);
    }
    for (const entry of this.windowManager.getOpenEntries()) {
      if (!entry.destroyed && !entry.view.webContents.isDestroyed()) {
        entry.view.webContents.send(PAGE_APP_DESKTOP_IPC_CHANNELS.installedChanged, apps);
      }
    }
  }

  private notifyPermissionsChanged(
    appId: PageAppId,
    permissions: DesktopPageAppPermissionsSummary,
  ): void {
    const payload = { appId, permissions };
    const mainWin = this.getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.webContents.send(PAGE_APP_DESKTOP_IPC_CHANNELS.permissionsChanged, payload);
    }
    const open = this.windowManager.getOpenEntries().find((e) => e.appId === appId);
    if (open && !open.destroyed && !open.view.webContents.isDestroyed()) {
      open.view.webContents.send(PAGE_APP_DESKTOP_IPC_CHANNELS.permissionsChanged, payload);
    }
  }

  registerIpcHandlers(
    registerMainOnlyHandle?: (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ) => void,
  ): void {
    const C = PAGE_APP_DESKTOP_IPC_CHANNELS;
    const assertTrustedTopFrame = (event: IpcMainInvokeEvent) => {
      if (event.senderFrame !== event.sender.mainFrame) {
        throw new Error("Page Apps IPC requires a top-level Moss frame.");
      }
      const mainWin = this.getMainWindow();
      const isMain = Boolean(
        mainWin && !mainWin.isDestroyed() && event.sender === mainWin.webContents,
      );
      const isStandalone = this.executor.getSession(event.sender.id) !== null;
      if (!isMain && !isStandalone) {
        throw new Error("Unauthorized Page Apps IPC sender.");
      }
    };
    const handle =
      registerMainOnlyHandle ??
      ((channel, fn) => {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, (event, ...args) => {
          assertTrustedTopFrame(event);
          return fn(event, ...args);
        });
      });

    ipcMain.removeHandler(PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL);
    ipcMain.handle(PAGE_APP_DESKTOP_NODE_API_CALL_CHANNEL, (event, payload: unknown) =>
      this.executor.execute(
        event,
        (payload && typeof payload === "object" ? payload : {}) as {
          namespace?: unknown;
          domain?: unknown;
          method?: unknown;
          args?: unknown;
        },
      ),
    );

    ipcMain.removeHandler(PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL);
    ipcMain.handle(PAGE_APP_DESKTOP_PERMISSIONS_DECLARE_CHANNEL, (event, payload: unknown) => {
      const session = this.executor.verifyCaller(event);
      const rawPermissions =
        payload && typeof payload === "object"
          ? (payload as { permissions?: unknown }).permissions
          : undefined;
      const declared = this.executor.declarePermissionsForSession(session, rawPermissions);
      const installed = this.store.findInstalledByAppId(session.appId);
      if (installed) {
        this.store.upsertInstalled({
          ...installed,
          declaredPermissions: declared as DesktopPageAppPermission[],
          updatedAt: new Date().toISOString(),
        });
      }
      return declared;
    });

    handle(C.isAvailable, () => this.permissions.getPolicyState().enabled);
    handle(C.getPolicyState, () => this.permissions.getPolicyState());
    handle(C.installFromPage, (event, input) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? this.getMainWindow();
      return this.requestInstall(input as DesktopPageAppInstallInput, win);
    });
    handle(C.requestInstall, (event, input) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? this.getMainWindow();
      return this.requestInstall(input as DesktopPageAppInstallInput, win);
    });
    handle(C.isInstalled, (_event, appId) =>
      typeof appId === "string" ? this.isInstalled(appId) : false,
    );
    handle(C.getInstalled, (_event, appId) =>
      typeof appId === "string" ? this.getInstalled(appId) : null,
    );
    handle(C.listInstalled, () => this.listInstalled());
    handle(C.openInstalled, (event, input) => {
      const mainWin = this.getMainWindow();
      const isMain = Boolean(
        mainWin && !mainWin.isDestroyed() && event.sender === mainWin.webContents,
      );
      return this.openStandalone((input ?? {}) as DesktopPageAppOpenInput, isMain);
    });
    handle(C.uninstall, (event, input) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? this.getMainWindow();
      return this.uninstallWithConfirm((input ?? {}) as DesktopPageAppUninstallInput, win);
    });
    handle(C.setDesktopShortcut, (_event, input) =>
      this.setDesktopShortcut((input ?? {}) as DesktopPageAppSetDesktopShortcutInput),
    );
    handle(C.showInFolder, (_event, input) =>
      this.showInFolderByQuery((input ?? {}) as DesktopPageAppShowInFolderInput),
    );
    handle(C.openPermissions, (event, input) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? this.getMainWindow();
      return this.openPermissionsDialog(input as DesktopPageAppOpenPermissionsInput, win);
    });
    handle(C.getPermissions, (_event, input) =>
      this.getPermissionsSummary(input as DesktopPageAppGetPermissionsInput),
    );
    handle(C.requestPermissions, (event, input) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? this.getMainWindow();
      return this.requestPermissions(input as DesktopPageAppRequestPermissionsInput, win);
    });
    handle(C.setPermission, (_event, input) =>
      this.setPermission(input as DesktopPageAppSetPermissionInput),
    );
    handle(C.syncAppVersion, (_event, input) =>
      this.syncAppVersion(input as DesktopPageAppSyncVersionInput),
    );
    handle(C.reportAppGone, (event, input) => {
      const win = BrowserWindow.fromWebContents(event.sender) ?? this.getMainWindow();
      return this.reportAppGone(input as DesktopPageAppGoneInput, win);
    });
    handle(C.offerInMenu, (_event, offers) => {
      if (Array.isArray(offers)) {
        this.setMenuOffers(offers as DesktopPageAppMenuOffer[]);
      }
    });
    handle(C.invokeDesktopApi, async (event, input) => {
      const call = input as DesktopPageAppNodeApiCallInput;
      const win = BrowserWindow.fromWebContents(event.sender) ?? this.getMainWindow();
      const installed = this.store.findInstalledByAppId(call.appId);
      const open = this.windowManager.getOpenEntries().find((e) => e.appId === call.appId);
      const ctx = this.getCurrentAccountOrg();
      const installedDeclared =
        (
          installed as
            | (InstalledDesktopPageApp & {
                declaredPermissions?: readonly DesktopPageAppPermission[];
              })
            | null
        )?.declaredPermissions ?? [];
      const tracker =
        win && !win.isDestroyed() ? this.ensureMainGestureTracker(win.webContents) : null;
      return this.executor.executeFromMainBridge(call, win, {
        accountId: open?.session.accountId ?? installed?.accountId ?? ctx.accountId,
        orgId: open?.session.orgId ?? installed?.orgId ?? ctx.orgId,
        appName: open?.session.appName ?? installed?.name ?? "应用页",
        declaredPermissions: open?.session.declaredPermissions ?? installedDeclared,
        trustKind: resolveFailClosedTrust(
          undefined,
          open?.session.trustKind ?? installed?.sourceTrust,
          "untrusted",
        ),
        ...(tracker ? { takeGesture: () => tracker.takeGesture() } : {}),
        onTriggerInstall: () =>
          this.requestInstall(
            {
              appId: call.appId,
              revision: call.revision,
              ...(installedDeclared.length > 0
                ? { capabilities: { desktop: { permissions: [...installedDeclared] } } }
                : {}),
            },
            win,
          ),
        onOpenPermissionsWindow: () =>
          this.openPermissionsDialog({ appId: call.appId, revision: call.revision }, win),
      });
    });
  }
}

export { app, isDesktopPageAppPermission };
