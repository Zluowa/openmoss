import { showDiagnosticStartupDialog } from "./startupDiagnosticDialog";
import { createBundledMossCanvas, resolveBundledMossCanvasRoot } from "./mossCanvasRuntime";
import { BackendIssueDetector } from "./backendIssueDetector";
import { CuaDriverHost, sweepOrphanedCuaDrivers } from "./cuaDriverHost";
import { createLinuxCuaDriverHost } from "./linuxCuaDriverHost";
import { LinuxEscapeKillSwitchMonitor, linuxEscapeSession } from "./linuxEscapeKillSwitchMonitor";
import { ComputerFrameTap } from "./computerFrameTap";
import { ComputerShield } from "./computerShield";
import { registerComputerDesktopLifecycle } from "./computerDesktopLifecycle";
import { COMPUTER_PERMISSION_KINDS } from "@synara/shared/computerGrants";
import { MODEL_SCREEN_IMAGE_MAX_DIMENSION } from "@synara/shared/modelImageBudget";

// FILE: main.ts
// Purpose: Starts the Electron shell, backend process, native menus, IPC bridges, and updater.
// Layer: Desktop main process
// Depends on: Electron, backend startup helpers, browser manager, and update runtime.

import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
// Electron-only builtin that sees app.asar as a real file instead of a virtual
// directory — required to stat the archive itself for swap detection.
import * as OriginalFS from "original-fs";

import {
  app,
  BrowserWindow,
  clipboard,
  crashReporter,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  nativeTheme,
  protocol,
  powerMonitor,
  screen,
  session,
  shell,
  safeStorage,
  systemPreferences,
} from "electron";
import { configureElectronNetwork } from "betterwright/electron";
import type {
  BrowserWindowConstructorOptions,
  FileFilter,
  IpcMainEvent,
  MenuItemConstructorOptions,
  MessageBoxOptions,
} from "electron";
import * as Effect from "effect/Effect";
import type {
  DesktopAppIcon,
  DesktopDockIconPreference,
  DesktopPluginDeepLinkAudit,
  DesktopRealtimeVoiceOverlayCommand,
  DesktopRealtimeVoiceOverlayHandoff,
  DesktopTheme,
  DesktopUiLocale,
  ContextMenuIconKey,
  ContextMenuShortcutKey,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@synara/contracts";
import {
  autoUpdater,
  BaseUpdater,
  CancellationToken,
  type UpdateDownloadedEvent,
} from "electron-updater";

import { isKeyboardShortcutsHelpChord } from "@synara/shared/browserShortcuts";
import { getMacTrafficLightPosition } from "@synara/shared/desktopChrome";
import { DEVICE_HELPER_SOURCE_DIR_ENV } from "@synara/shared/deviceHelperCache";
import {
  desktopUpdateChannel,
  MOSS_SOURCE_DESKTOP_BUILD_MARKER,
  MOSS_DESKTOP_SMOKE_USER_DATA_ENV,
  MOSS_DESKTOP_BUNDLE_ID_ENV,
  canOverrideDesktopSmokeUserData,
  resolveMossDesktopRuntimeFlavor,
  mossDesktopIdentity,
} from "@synara/shared/desktopIdentity";
import { CUA_HOST_SOCKET_ENV } from "@synara/shared/cuaDriverProtocol";
import {
  MOSS_PRODUCTION_PUBLIC_CONFIG_FILE,
  type MossProductionPublicConfig,
} from "@synara/shared/mossProductionPublicConfig";
import { NetService } from "@synara/shared/Net";
import { applyShellEnvironmentHydrationMarker } from "@synara/shared/shell";
import { RotatingFileSink } from "@synara/shared/logging";
import {
  MIGRATION_DIVERGENCE_CONSENT_ENV,
  MIGRATION_RUNTIME_SOURCE_DIGEST_ENV,
  type MigrationRuntimeIdentityMismatch,
  type MigrationSchemaTooNewStartupBlock,
} from "@synara/shared/migrationRecovery";
import {
  ensureStaticSnapshot,
  findAsarArchivePath,
  pruneStaticSnapshotCache,
} from "@synara/shared/staticSnapshot";
import { isBackendReadinessAborted, waitForHttpReady } from "./backendReadiness";
import { resolveBackendNodeArgs, withBackendEnvProxyOptIn } from "./backendNodeOptions";
import { canonicalFilesystemHelperBackendEnv } from "./canonicalFilesystemHelperRuntime";
import {
  isBackendStartupReadyResponse,
  monitorBackendStartupHealth,
  waitForBackendStartupReady,
} from "./backendStartupReadiness";
import {
  retainLiveBackendAfterShutdownFailure,
  requireWindowsBackendExit,
  runAfterDesktopShutdown,
  shouldDeferDesktopWindowClose,
  startDesktopBackendShutdownRequest,
  stopPosixBackendAndWait,
  stopWindowsBackendAndWait,
} from "./backendShutdown";
import {
  bundleSignatureFromStats,
  isBundleStable,
  isBundleSwapped,
  isWatchableBundlePath,
  type BundleSignature,
} from "./bundleSwapDetection";
import { DesktopBetaChannel, readBetaImportResult, resolveBetaHomeDir } from "./betaChannel";
import type { ExpectedTeamId } from "./betaInstaller";
import {
  BetaDiagnostics,
  readLogTail,
  resolveBetaDiagnosticsEndpoint,
  type BetaDiagnosticsEventName,
} from "./betaDiagnostics";
import { attachBetaRendererDiagnostics } from "./betaRendererDiagnostics";
import { guardDesktopWindowClose, showDesktopConfirmDialog } from "./confirmDialog";
import { DesktopUiLocalePersistenceCoordinator } from "./desktopUiLocalePersistence";
import {
  buildContextMenuTemplate,
  createContextMenuOneShotResolver,
  normalizeContextMenuItems,
} from "./contextMenu";
import {
  desktopAppIconFromDockPreference,
  desktopAppIconResourceName,
  isDesktopAppIcon,
  readDesktopAppIconPreference,
  shouldUpdateDesktopAppIcon,
  usesMacBundleAppIcon,
  writeDesktopAppIconPreference,
} from "./desktopAppIcon";
import { createDesktopNotificationRetainer } from "./notificationRetention";
import {
  applyWindowsTaskbarIcon,
  collectWindowsShortcutPaths,
  nextWindowsShellIconCacheKey,
  resolveWindowsShellIconCacheDirectory,
  syncWindowsShortcutIcons,
  windowsShellIconContentKey,
  windowsShellIconCachePath,
} from "./windowsTaskbarIcon";
import {
  applyWindowsShellAppUserModel,
  ensureWindowsShellAppUserModelHelper,
  nativeWindowHandleToHwnd,
} from "./windowsShellAppUserModel";
import { createExclusiveApplyQueue } from "./exclusiveApplyQueue";
import { extractIcoPngImages, toWindowsShellIco } from "./windowsShellIco";
import {
  makeUpdateInstallPreparationCoordinator,
  type UpdateInstallPreparationAttempt,
} from "./updateInstallPreparation";
import {
  makeDeferredDesktopQuitIntentCoordinator,
  settleDeferredDesktopQuitAfterUpdaterFailure,
} from "./desktopQuitIntent";
import {
  makeRunningChatsQuitGuard,
  quitConfirmationPresentationForPlatform,
  shouldPromptForRunningChatsBeforeQuit,
} from "./runningChatsQuitGuard";
import { registerDesktopTerminationSignalHandlers } from "./processTerminationSignals";
import {
  hasVerifiedDesktopMigrationRestore,
  hasPendingDesktopMigrationRecovery,
  invalidMigrationStartupRecoveryChoices,
  requiresDesktopMigrationRecovery,
  recoverDesktopMigrationIfRequired,
  resolveDesktopMigrationRecoveryPaths,
  resolveDesktopMigrationRestoreCandidate,
  restoreDesktopMigrationBackup,
  type DesktopMigrationRecoveryDecision,
  type DesktopMigrationRecoveryOutcome,
  type DesktopMigrationRecoveryPaths,
} from "./desktopMigrationRecovery";
import {
  LSREGISTER_PATH,
  parseLastLaunchVersion,
  resolveLaunchVersionRecordPath,
  resolveMacAppBundlePath,
  serializeLaunchVersionRecord,
  shouldRefreshIconCache,
} from "./macIconCacheRefresh";
import { persistMacAppIcon } from "./macAppIcon";
import {
  MAC_WINDOW_VIBRANCY,
  createWindowMaterialApplier,
  parseDesktopWindowMaterial,
  type WindowMaterialAddon,
} from "./windowMaterial";
import { collectMacUpdateDiagnostics } from "./macUpdateDiagnostics";
import { openInitialBackendWindow } from "./initialBackendWindowOpen";
import {
  handleDesktopSecondInstance,
  isBackgroundDesktopLaunch,
  showDesktopQuitConfirmationWindow,
  showDesktopStartupWindow,
} from "./desktopStartupPolicy";
import {
  shouldAllowMediaPermissionCheck,
  shouldAllowMediaPermissionRequest,
} from "./mediaPermissions";
import { isClipboardWritePermission } from "./clipboardPermissions";
import { createRealtimeVoiceMediaRequestPolicy } from "./realtimeVoiceMediaRequestPolicy";
import {
  installResumableUpdateDownloader,
  type ResumableDownloaderTarget,
} from "./resumableUpdateDownload";
import { hardenElectronUpdater } from "./electronUpdaterSecurity";
import { ServerListeningDetector } from "./serverListeningDetector";
import { BackendStartupBlockDetector, type BackendStartupBlock } from "./backendStartupBlock";
import {
  BACKEND_MAX_CONSECUTIVE_START_FAILURES,
  BackendOutputTailDetector,
  BackendSupervisionPolicy,
  summarizeBackendFailureOutput,
} from "./backendSupervisionPolicy";
import { captureBackendProcessOutput } from "./backendProcessOutput";
import { syncShellEnvironment } from "./syncShellEnvironment";
import {
  embeddedDesktopMigrationRuntimeSourceDigest,
  inspectDesktopMigrationRuntimeIdentity,
} from "./migrationBundleIdentity";
import { MigrationConsentHandoff } from "./migrationConsentHandoff";
import {
  RENDERER_MAX_AUTOMATIC_RELOADS,
  RendererCrashPolicy,
  type RendererCrashResponse,
} from "./rendererCrashRecovery";
import {
  type DownloadProgressSample,
  getAutoUpdateDisabledReason,
  getDownloadStallTimeoutMessage,
  hasDownloadProgressAdvanced,
  isExpectedStalledDownloadCancellationError,
  isUpdateVersionAllowedForFlavor,
  isUpdateVersionNewer,
  shouldBroadcastDownloadProgress,
  shouldCheckForUpdatesOnForeground,
} from "./updateState";
import {
  registerDesktopVoiceTranscriptionHandler,
  requestDesktopBackendVoiceTranscription,
} from "./voiceTranscription";
import { isMossGoogleOAuthExternalUrl } from "./mossGoogleOAuthExternalUrl";
import { captureSentryException, flushSentry } from "./observability/sentry";
import {
  applyDesktopPhysicalZoomAction,
  DEFAULT_DESKTOP_MENU_ACCELERATORS,
  type DesktopMenuAccelerators,
  resolveDesktopMenuAccelerator,
  resolveDesktopPhysicalZoomAction,
  resolveDesktopZoomShortcutAction,
  resolveKeyboardShortcutsMenuAccelerator,
  resolveReportedMenuAccelerators,
  sameDesktopMenuAccelerators,
  shouldUseNativeZoomMenuRoles,
} from "./menuShortcuts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnCheckFailure,
  reduceDesktopUpdateStateOnCheckStart,
  reduceDesktopUpdateStateOnDownloadComplete,
  reduceDesktopUpdateStateOnDownloadFailure,
  reduceDesktopUpdateStateOnDownloadProgress,
  reduceDesktopUpdateStateOnDownloadStart,
  reduceDesktopUpdateStateOnInstallFailure,
  reduceDesktopUpdateStateOnInstallRestartFailure,
  reduceDesktopUpdateStateOnInstallStart,
  reduceDesktopUpdateStateOnNoUpdate,
  reduceDesktopUpdateStateOnUpdateAvailable,
} from "./updateMachine";
import {
  translateNativeAppSnapMessage,
  translateNativeMenuLabel,
  type NativeMenuLocale,
} from "./nativeMenuLocalization";
import {
  PendingUpdateCacheClearQueue,
  resolveElectronUpdaterCacheDirName,
  resolveElectronUpdaterLegacyZipPath,
  resolveElectronUpdaterPendingCacheDir,
} from "./updatePendingCache";
import {
  clearInstallMarker,
  createUpdateInstallMarker,
  markInstallHandoffSync,
  readInstallMarker,
  recordInstallMarkerFailureSync,
  resolveInstallMarkerOutcome,
  writeInstallMarker,
  type UpdateInstallHandoffExpectation,
  type UpdateInstallMarker,
} from "./updateInstallMarker";
import {
  fingerprintUpdateArtifact,
  verifyUpdateArtifactIdentity,
  type UpdateArtifactIdentity,
} from "./updateArtifactIdentity";
import { buildGitHubReleasesPageUrl, resolveGitHubUpdateSource } from "./githubUpdateFeed";
import { isArm64HostRunningIntelBuild, resolveDesktopRuntimeInfo } from "./runtimeArch";
import { BROWSER_SESSION_PARTITION, DesktopBrowserManager } from "./browserManager";
import { BrowserSessionRestore } from "./browserAutomation/browserSessionRestore";
import { createCookieSessionBackend } from "./browserAutomation/electronCookieSession";
import { BrowserVault } from "./browserAutomation/browserVault";
import { BrowserVaultCapture } from "./browserAutomation/browserVaultCapture";
import { registerBrowserVaultIpc } from "./browserVaultIpc";
import { registerSafariAccessIpc } from "./safariAccessIpc";
import { showInFileManager } from "./showInFileManager";
import { BrowserCookieImport } from "./browserAutomation/browserCookieImport";
import {
  registerBrowserIpcHandlers,
  sendBrowserAnnotationEvent,
  sendBrowserCopyLink,
  sendBrowserState,
} from "./browserIpc";
import {
  BrowserHostPipeServer,
  MOSS_BROWSER_HOST_PIPE_PATH,
  resolveBrowserHostPipeBackendEnv,
} from "./browserUsePipeServer";
import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";
import {
  repairBrowserProfileFromBridgeManifest,
  migrateRetiredBrowserPartitions,
  resolveDesktopAppDataBase,
  resolveDesktopUserDataPath,
} from "./desktopUserDataProfile";
import { handleDesktopStdioError, isBrokenPipeError } from "./desktopProcessErrors";
import { createDesktopStaticProtocolResolver } from "./desktopStaticProtocol";
import {
  readCustomTitleBarPreference,
  resolveDesktopCustomTitleBarState,
  resolveDesktopTitleBarFrameOptions,
  writeCustomTitleBarPreference,
} from "./desktopCustomTitleBar";
import {
  normalizeAgentCursorStylePreference,
  readAgentCursorPreference,
  writeAgentCursorPreference,
} from "./agentCursorPreference";
import {
  buildMossAuthProtocolClientArguments,
  buildMossAuthCallbackRendererUrl,
  isMossAuthProtocolRelayProcess,
  resolveMossAuthCallbackRoute,
  resolveMossAuthCallbackRouteFromArgv,
  shouldRegisterMossAuthCallbackProtocolClient,
} from "./mossAuthDeepLink";
import {
  loadMossProductionPublicConfig,
  mergeMossProductionPublicConfigIntoEnv,
} from "./mossProductionPublicConfig";
import {
  MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY,
  prepareBundledClaudeStartupVersion,
  resolveBundledClaudeBinary,
} from "./bundledClaude";
import {
  resolveBundledCodexBinary,
  resolveBundledCodexBinaryAsync,
  toBundledCodexBackendEnv,
} from "./bundledCodex";
import {
  readDesktopWindowState,
  resolveVisibleWindowBounds,
  writeDesktopWindowState,
} from "./windowState";
import {
  acknowledgeMossStorageSnapshot,
  readMossStorageSnapshot,
  resolveMossStorageSnapshotPath,
} from "./desktopStorageMigration";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
import { DesktopAppSnapManager } from "./appSnapManager";
import { notifyBackendComputerEmergencyStop } from "./computerEmergencyStopNotice";
import { EscapeKillSwitchMonitor } from "./escapeKillSwitchMonitor";
import {
  AudioLevelMonitor,
  listAudioInputDevices,
  MAX_MICROPHONE_ID_LENGTH,
} from "./audioLevelMonitor";
import { AUDIO_TRAIL_BETA_FEATURE, isBetaFeatureEnabled } from "@synara/shared/betaFeatures";
import { DesktopRealtimeVoiceShortcutManager } from "./realtimeVoiceShortcut";
import {
  buildDesktopRealtimeVoiceOverlayUrl,
  type DesktopRealtimeVoiceOverlayPlacement,
  type DesktopRealtimeVoiceOverlayPointerDragEvent,
  DesktopRealtimeVoiceOwnerMessageBuffer,
  DesktopRealtimeVoiceOverlayStateModel,
  isDesktopRealtimeVoiceOverlayInteractiveScreenPoint,
  isDesktopRealtimeVoiceOverlayCommandRequestCurrent,
  normalizeDesktopRealtimeVoiceOverlayPointerDragEvent,
  normalizeDesktopRealtimeVoiceOverlayCommandRequest,
  REALTIME_VOICE_OVERLAY_LAYOUT_CHANGED_TYPE,
  REALTIME_VOICE_OVERLAY_ORB_SIZE,
  REALTIME_VOICE_OVERLAY_PLACEMENT,
  REALTIME_VOICE_OVERLAY_PRELOAD_ARGUMENT,
  REALTIME_VOICE_OVERLAY_POINTER_DRAG_IPC_CHANNEL,
  REALTIME_VOICE_OVERLAY_SESSION_PARTITION,
  REALTIME_VOICE_OVERLAY_SIZE,
  resolveDesktopRealtimeVoiceOverlayBounds,
  resolveDesktopRealtimeVoiceOverlayDragLayout,
  resolveDesktopRealtimeVoiceOverlayGeometry,
  resolveDesktopRealtimeVoiceOverlayHandoffPosition,
  resolveDesktopRealtimeVoiceOverlayHandoffStartBounds,
  resolveDesktopRealtimeVoiceOverlayHandoffTargetBounds,
  shouldShowDesktopRealtimeVoiceOverlay,
  shouldThrottleDesktopRealtimeVoiceOwner,
} from "./realtimeVoiceOverlay";
import { hardenBrowserAnnotationWebviewPreferences } from "./browserAnnotations/webviewSecurity";
import { LOCAL_HTML_PREVIEW_SCHEME } from "./localHtmlPreviewProtocol";
import { McpAppSandboxRuntime } from "./mcpAppSandbox/runtime";
import { HtmlPreviewRuntime } from "./htmlPreview/runtime";
import {
  APP_SNAP_SETTINGS_PANE_URLS,
  registerAppSnapIpcHandlers,
  sendAppSnapCaptured,
  sendAppSnapError,
  sendAppSnapPermissionGuideState,
  sendAppSnapState,
} from "./appSnapIpc";
import {
  CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS,
  ConnectorOAuthCallbackInbox,
  type ConnectorOAuthCallbackAppEvents,
  type ConnectorOAuthProtocolClient,
  installConnectorOAuthCallbackAppEvents,
  registerConnectorOAuthProtocolClient,
} from "./connectorOAuthCallback";
import {
  MossPluginDeepLinkAckWatchdog,
  MossPluginDeepLinkNavigationQueue,
  installMossPluginDeepLinkAppEvents,
  isDesktopPluginDeepLinkNavigationResult,
  resolveMossPluginDeepLinkRetryDelay,
  type MossPluginDeepLinkAppEvents,
} from "./pluginDeepLink";

const requestedSourceBuildMarker = process.env.MOSS_SOURCE_DESKTOP_BUILD_MARKER;
if (
  requestedSourceBuildMarker !== undefined &&
  requestedSourceBuildMarker !== MOSS_SOURCE_DESKTOP_BUILD_MARKER
) {
  throw new Error("The source desktop launcher and built main are incompatible. Rebuild Moss.");
}

// Capture the real archive identity before any explicit app.asar lookup. Static
// snapshotting and the runtime watcher both use this same generation as their
// baseline, so a replacement during startup cannot silently become "normal."
const startupBundleIdentity = captureStartupBundleIdentity();

// Deliberately still on the pre-`whenReady()` path. On posix it is normally a cache read
// (see `createCachedLoginShellEnvironmentReader`); only a first launch, a changed shell
// startup file, or an aged-out entry pays the ~1s login-shell probe again.
// The reads a few lines below decide where this install's data lives, and two of them
// depend on what this probe brings in: `resolveUserDataPath()` takes the Electron profile
// directory from XDG_CONFIG_HOME on Linux, which the login-shell probe captures, and
// `BASE_DIR` prefers MOSS_HOME, which the Windows registry read hydrates whenever the
// user set it persistently. Resolving either against an unhydrated environment would
// silently relocate an existing user's profile and data directory.
// (The probe also carries PATH, SSH_AUTH_SOCK, HOMEBREW_*, and HTTP(S)/ALL/NO_PROXY
// for later provider spawns. Dock launches otherwise lose the login-shell proxy.
// APPDATA on Windows is inherited from the process env, not hydrated here.)
const shellEnvironmentSync = syncShellEnvironment();

const IPC = DESKTOP_IPC_CHANNELS;
const mcpAppSandboxRuntime = new McpAppSandboxRuntime();
const htmlPreviewRuntime = new HtmlPreviewRuntime();
const MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH = 16 * 1024 * 1024;
const packagedDesktopFlavor = app.isPackaged
  ? (
      JSON.parse(FS.readFileSync(Path.join(app.getAppPath(), "package.json"), "utf8")) as {
        mossDesktopFlavor?: unknown;
      }
    ).mossDesktopFlavor
  : undefined;
const isSourceDesktopBuild =
  requestedSourceBuildMarker === MOSS_SOURCE_DESKTOP_BUILD_MARKER &&
  packagedDesktopFlavor === undefined;
const isDevelopment =
  (!app.isPackaged || isSourceDesktopBuild) && Boolean(process.env.VITE_DEV_SERVER_URL);
const desktopFlavor = resolveMossDesktopRuntimeFlavor({
  isPackaged: app.isPackaged,
  isDevelopment,
  packagedFlavor: packagedDesktopFlavor,
  requestedFlavor: process.env.MOSS_DESKTOP_FLAVOR,
  allowDevelopmentOverride: isSourceDesktopBuild,
});
const desktopIdentity = mossDesktopIdentity(desktopFlavor);
// Beta never honors the stable home override: a globally exported stable home
// would make beta open (and migrate) stable's database. MOSS_HOME stays the
// branded stable override; MOSS_HOME is accepted as an upstream alias.
const BASE_DIR =
  (desktopFlavor === "beta"
    ? process.env.MOSS_BETA_HOME?.trim()
    : process.env.MOSS_HOME?.trim() || process.env.MOSS_HOME?.trim()) ||
  Path.join(OS.homedir(), desktopIdentity.defaultHomeDirectoryName);
const STATE_DIR = Path.join(BASE_DIR, "userdata");
const DESKTOP_WINDOW_STATE_PATH = Path.join(STATE_DIR, "desktop-window-state.json");
const DESKTOP_UI_LOCALE_PATH = Path.join(STATE_DIR, "desktop-ui-locale");
const DESKTOP_APP_ICON_PATH = Path.join(STATE_DIR, "desktop-app-icon");
const DESKTOP_CUSTOM_TITLE_BAR_PATH = Path.join(STATE_DIR, "desktop-custom-title-bar.json");
// Written by the renderer-mirrored agent cursor colors; read at each driver
// session open so a persisted custom cursor survives app restarts.
const AGENT_CURSOR_PREFERENCE_PATH = Path.join(STATE_DIR, "agent-cursor-colors.json");
const DESKTOP_SCHEME = desktopIdentity.scheme;
const ROOT_DIR = Path.resolve(__dirname, "../../..");
const APP_DISPLAY_NAME = desktopIdentity.displayName;
const APP_USER_MODEL_ID = desktopIdentity.bundleId;
const remoteDebuggingPort = process.env.MOSS_REMOTE_DEBUGGING_PORT?.trim();
if (
  isDevelopment &&
  remoteDebuggingPort &&
  /^\d+$/.test(remoteDebuggingPort) &&
  Number(remoteDebuggingPort) >= 1024 &&
  Number(remoteDebuggingPort) <= 65_535
) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", remoteDebuggingPort);
}
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const COMMIT_HASH_DISPLAY_LENGTH = 12;
const LOG_DIR = Path.join(STATE_DIR, "logs");
const DESKTOP_LOG_FILE_NAME = "desktop-main.log";
const BACKEND_LOG_FILE_NAME = "server-child.log";
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_FILE_MAX_FILES = 10;
const APP_RUN_ID = Crypto.randomBytes(6).toString("hex");
const DESKTOP_BACKEND_SHUTDOWN_TOKEN = Crypto.randomBytes(32).toString("hex");
const DESKTOP_BROWSER_HOST_CAPABILITY = Crypto.randomBytes(32).toString("base64url");
const DESKTOP_BROWSER_HOST_CAPABILITY_FD = 3;
// Electron's single-instance lock is scoped through userData on Windows/Linux.
// Set the flavor-specific profile first so Stable, Dev, and Canary never contend
// for the same lock even when they use the same Electron executable.
const mossAuthProtocolRelay = isMossAuthProtocolRelayProcess(process.argv);
const userDataPath = resolveUserDataPath();
app.setPath("userData", userDataPath);

// Beta-only diagnostics: constructed solely when the baked build flavor is
// "beta", so production binaries never run a collection path. The payload
// schema is an allowlist; error text may still contain fragments of user data,
// and Electron crash dumps are raw process memory.
const betaDiagnostics =
  desktopFlavor === "beta"
    ? new BetaDiagnostics({
        homeDir: BASE_DIR,
        appVersion: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        sampleMemory: () => {
          const counters = { mainRssMb: 0, rendererRssMb: 0, gpuRssMb: 0, utilityRssMb: 0 };
          for (const metric of app.getAppMetrics()) {
            const mib = metric.memory.workingSetSize / 1024;
            switch (metric.type) {
              case "Browser":
                counters.mainRssMb += mib;
                break;
              case "Tab":
                counters.rendererRssMb += mib;
                break;
              case "GPU":
                counters.gpuRssMb += mib;
                break;
              case "Utility":
                counters.utilityRssMb += mib;
                break;
            }
          }
          return counters;
        },
      })
    : null;

if (betaDiagnostics) {
  crashReporter.start({
    productName: APP_DISPLAY_NAME,
    companyName: "Moss",
    submitURL: `${resolveBetaDiagnosticsEndpoint(process.env)}/v1/crash`,
    uploadToServer: true,
    compress: true,
    globalExtra: {
      installId: betaDiagnostics.installId,
      flavor: "beta",
      appVersion: app.getVersion(),
    },
  });
}

const trackBetaDiagnostics = (
  event: BetaDiagnosticsEventName,
  payload: Parameters<BetaDiagnostics["track"]>[1],
): void => {
  betaDiagnostics?.track(event, payload);
};

// Handle launcher pipe failures at their source. The file log remains available
// after stdout/stderr closes; unrelated stream/process errors still propagate.
process.stdout.on("error", handleDesktopStdioError);
process.stderr.on("error", handleDesktopStdioError);

// Monitor-only: observes uncaught exceptions for diagnostics without changing
// Node's exit behavior — the POSIX EPIPE filter and the default crash path
// stay exactly as before.
process.on("uncaughtExceptionMonitor", (error: unknown) => {
  betaDiagnostics?.trackError("main", error);
});

const HOOLA_CANVAS_BRIDGE_DESCRIPTOR_PATH = Path.join(userDataPath, "hoola-canvas-bridge.json");
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const AUTO_UPDATE_STARTUP_DELAY_MS = 15_000;
const AUTO_UPDATE_POLL_INTERVAL_MS = 4 * 60 * 60 * 1000;
const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS = 30 * 1000;
const AUTO_UPDATE_CHECK_TIMEOUT_MS = 45 * 1000;
const AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS = 60 * 1000;
// Upper bound on how long we wait for electron-updater to release a cancelled
// download before allowing a retry, so a wedged updater promise can't block updates.
const AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS = 20 * 1000;
const AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS = 2 * 60 * 1000;
// How long we give quitAndInstall() to actually quit/relaunch the app before we
// conclude the OS installer never started (unsigned/quarantined build, read-only
// install dir, blocked NSIS run) and surface the manual-download fallback.
const AUTO_UPDATE_INSTALL_WATCHDOG_MS = 15 * 1000;
const AUTO_UPDATE_DIAGNOSTICS_TIMEOUT_MS = 2_800;
// The OS key store can pend forever on an unanswered securityd prompt (locked
// keychain, signature change, wedged SecurityAgent). Startup must not wait on
// it: session cookies are disposable, a bricked launch is not.
const BROWSER_SESSION_RESTORE_TIMEOUT_MS = 5_000;
// User-driven like the menu and renderer reasons, so it must not be filtered
// out by the automatic-activity suppression a previous install failure arms.
const UPDATE_CHECK_REASON_MIGRATION_RECOVERY = "migration recovery";
const UPDATE_INSTALL_MARKER_FILE_NAME = "pending-update-install.json";
const BACKEND_FORCE_KILL_DELAY_MS = 8_000;
const BACKEND_SHUTDOWN_TIMEOUT_MS = 10_000;
// Provider finalizers stop every owned runtime concurrently, but POSIX leaves
// extra headroom for the rest of the Effect scope to close cleanly.
const POSIX_BACKEND_TERMINATE_DELAY_MS = 15_000;
const POSIX_BACKEND_FORCE_KILL_DELAY_MS = 18_000;
const POSIX_BACKEND_SHUTDOWN_TIMEOUT_MS = 20_000;
const BACKEND_MAX_OLD_SPACE_ENV_KEYS = [
  "MOSS_BACKEND_MAX_OLD_SPACE_MB",
  "MOSS_BACKEND_MAX_OLD_SPACE_MB",
  "T3CODE_BACKEND_MAX_OLD_SPACE_MB",
  "DPCODE_BACKEND_MAX_OLD_SPACE_MB",
] as const;
const DESKTOP_UPDATE_ALLOW_PRERELEASE = desktopFlavor === "beta";
const BROWSER_PERF_SAMPLE_INTERVAL_MS = 5_000;
const DESKTOP_MENU_ZOOM_FACTOR_STEP = 1.1;
// User keybindings mirrored onto View menu items. Every window reports the same
// server-owned keybindings, so the latest report wins.
let desktopMenuAccelerators: DesktopMenuAccelerators = DEFAULT_DESKTOP_MENU_ACCELERATORS;
const DESKTOP_MENU_MIN_ZOOM_FACTOR = 0.25;
const DESKTOP_MENU_MAX_ZOOM_FACTOR = 5;
const MOSS_BROWSER_LABEL = "Moss browser";
const browserPerfLoggingEnabled =
  process.env.MOSS_BROWSER_PERF === "1" ||
  process.env.DPCODE_BROWSER_PERF === "1" ||
  process.env.T3CODE_BROWSER_PERF === "1";

type DesktopUpdateErrorContext = DesktopUpdateState["errorContext"];

let mainWindow: BrowserWindow | null = null;
const appContentLoadedWindows = new WeakSet<BrowserWindow>();
const appRendererReadyWindows = new WeakSet<BrowserWindow>();
let pendingMossAuthCallbackRoute: string | null = null;
let mossAuthCallbackNavigationInFlight: Promise<void> | null = null;
/** Whether the live BrowserWindow was created with `frame: false` (win32/linux). */
let customTitleBarActive = false;
let backendProcess: ChildProcess.ChildProcess | null = null;
let backendPort = 0;
let backendAuthToken = "";
let hoolaCanvasBridgeToken = "";
const bundledMossCanvas = createBundledMossCanvas(() => ({
  baseUrl: backendHttpUrl,
  token: backendAuthToken,
}));
let backendHttpUrl = "";
let backendWsUrl = "";
let backendReadinessAbortController: AbortController | null = null;
let backendInitialWindowOpenInFlight: Promise<void> | null = null;
// Guards every blocking backend-lifecycle dialog (startup block, give-up) so a
// crash loop can never stack modal windows on top of each other.
let backendLifecycleDialogInFlight: Promise<void> | null = null;
let backendListeningDetector: ServerListeningDetector | null = null;
const backendSupervision = new BackendSupervisionPolicy();
// Survives window recreation on purpose: a renderer that keeps dying must not refill
// its reload budget just because the crash produced a new window.
const rendererCrashPolicy = new RendererCrashPolicy();
let rendererCrashDialogInFlight: Promise<void> | null = null;
let lastBackendFailureDetail: string | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let isQuitting = false;
let isUpdaterInstallPreparing = false;
let isUpdaterQuitAndInstallInFlight = false;
const updateInstallPreparation = makeUpdateInstallPreparationCoordinator();
const deferredDesktopQuitIntent = makeDeferredDesktopQuitIntentCoordinator();
const runningChatsQuitGuard = makeRunningChatsQuitGuard();
let nativeQuitConfirmationPromise: Promise<boolean> | null = null;
let desktopShutdownPromise: Promise<void> | null = null;
let desktopStartupBlockedForDatabaseRestore = false;
const migrationConsentHandoff = new MigrationConsentHandoff();
let desktopShutdownComplete = false;
let desktopProtocolRegistered = false;
let aboutCommitHashCache: string | null | undefined;
let appUpdateYmlCache: Record<string, string> | null | undefined;
const contextMenuIconCache = new Map<ContextMenuIconKey, Electron.NativeImage | null>();
let desktopLogSink: RotatingFileSink | null = null;
let backendLogSink: RotatingFileSink | null = null;
let restoreStdIoCapture: (() => void) | null = null;
let unreadBackgroundNotificationCount = 0;
const desktopNotificationRetainer = createDesktopNotificationRetainer<Notification>();
let browserPerfInterval: ReturnType<typeof setInterval> | null = null;
let desktopUiLocale: NativeMenuLocale = readPersistedDesktopUiLocale();
const desktopUiLocalePersistence = new DesktopUiLocalePersistenceCoordinator({
  initialLocale: desktopUiLocale,
  onDisplayLocaleChange: (locale) => {
    desktopUiLocale = locale;
    configureApplicationMenu();
  },
  persistLocale: persistDesktopUiLocale,
});
const annotationGuestPreload = Path.join(__dirname, "guestPreload.js");
const browserOsKeyStore = {
  available: async () => {
    await app.whenReady();
    return (
      safeStorage.isEncryptionAvailable() &&
      (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text")
    );
  },
  encrypt: (value: string) => safeStorage.encryptString(value),
  decrypt: (value: Buffer) => safeStorage.decryptString(value),
};
const browserVault = new BrowserVault(Path.join(BASE_DIR, "browser-vault"), browserOsKeyStore);
let browserSessionRestore: BrowserSessionRestore | undefined;
const browserVaultCapture = new BrowserVaultCapture(browserVault);
const browserManager = new DesktopBrowserManager({
  onRuntimeReady: (runtime) => browserVaultCapture.register(runtime),
  onHumanControl: (threadId) => browserVaultCapture.noteHumanActivity(threadId),
  annotationPreloadPath: annotationGuestPreload,
  beforeInputEvent: (event, input) => {
    if (
      isKeyboardShortcutsHelpChord(
        {
          type: input.type,
          key: input.key,
          code: input.code,
          meta: input.meta,
          ctrl: input.control,
          shift: input.shift,
          alt: input.alt,
          repeat: input.isAutoRepeat,
        },
        {
          isMac: process.platform === "darwin",
          isWindows: process.platform === "win32",
        },
      )
    ) {
      event.preventDefault();
      dispatchMenuAction("show-shortcuts");
      return true;
    }

    const target = resolveMenuTargetWindow()?.webContents;
    if (!target) return false;
    return (
      handleDesktopPhysicalZoomShortcut(event, input, target) ||
      handleDesktopZoomShortcut(event, input, target)
    );
  },
});
let browserHostPipeServer: BrowserHostPipeServer | null = null;
let appSnapManager: DesktopAppSnapManager | null = null;
let realtimeVoiceShortcutManager: DesktopRealtimeVoiceShortcutManager | null = null;
let realtimeVoiceOverlayWindow: BrowserWindow | null = null;
let realtimeVoiceOverlayRendererReady = false;
let realtimeVoiceOverlayRecreateTimer: ReturnType<typeof setTimeout> | null = null;
let realtimeVoiceOverlayStabilityTimer: ReturnType<typeof setTimeout> | null = null;
let realtimeVoiceOverlayMotionTimer: ReturnType<typeof setTimeout> | null = null;
let realtimeVoiceOverlayFailureCount = 0;
let realtimeVoiceOverlayLastHandoffSequence = 0;
let realtimeVoiceOverlayPendingHandoff: DesktopRealtimeVoiceOverlayHandoff | null = null;
let realtimeVoiceOverlayVisibleRevisionFloor: number | null = null;
let realtimeVoiceOverlayPointerInteractive = false;
let realtimeVoiceOverlayPlacement: DesktopRealtimeVoiceOverlayPlacement =
  REALTIME_VOICE_OVERLAY_PLACEMENT;
let realtimeVoiceOverlayUserPositioned = false;
let realtimeVoiceOverlayPointerDrag: {
  readonly pointerId: number;
  readonly pointerOffsetInOrb: { readonly x: number; readonly y: number };
  hasMoved: boolean;
} | null = null;
const realtimeVoiceOverlayState = new DesktopRealtimeVoiceOverlayStateModel();
const realtimeVoiceOwnerMessages = new DesktopRealtimeVoiceOwnerMessageBuffer();
let configuredUpdaterCacheDirName: string | null = null;
const connectorOAuthCallbackInbox = new ConnectorOAuthCallbackInbox();
let connectorOAuthSubscriberWebContentsId: number | null = null;
const pluginDeepLinkNavigationQueue = new MossPluginDeepLinkNavigationQueue(DESKTOP_SCHEME);
let pluginDeepLinkSubscriberWebContentsId: number | null = null;
let pluginDeepLinkRetryTimer: ReturnType<typeof setTimeout> | null = null;
let pluginDeepLinkConsecutiveFailures = 0;
let lastPluginDeepLinkAudit: DesktopPluginDeepLinkAudit | null = null;
const pluginDeepLinkAckWatchdog = new MossPluginDeepLinkAckWatchdog((deliveryId) => {
  if (!pluginDeepLinkNavigationQueue.getInFlightDelivery(deliveryId)) {
    return;
  }
  pluginDeepLinkNavigationQueue.cancelInFlightDelivery();
  writeDesktopLogHeader("Moss plugin deep-link renderer acknowledgement timed out");
  schedulePluginDeepLinkRetry();
});

if (hasSingleInstanceLock) {
  installConnectorOAuthCallbackAppEvents({
    app: app as unknown as ConnectorOAuthCallbackAppEvents,
    inbox: connectorOAuthCallbackInbox,
    initialArgv: process.argv,
    onCallbackAccepted: () => {
      flushConnectorOAuthCallbacks();
      focusMainWindow();
    },
  });
  installMossPluginDeepLinkAppEvents({
    app: app as unknown as MossPluginDeepLinkAppEvents,
    queue: pluginDeepLinkNavigationQueue,
    initialArgv: process.argv,
    onDeepLinkRecognized: () => {
      writeDesktopLogHeader("Moss plugin deep link recognized");
      resetPluginDeepLinkRetry();
      flushPendingPluginDeepLinkNavigation();
      focusMainWindow();
    },
  });
}

browserManager.subscribe((state) => {
  sendBrowserState(mainWindow?.webContents, state);
});

browserManager.subscribeCopyLink((event) => {
  sendBrowserCopyLink(mainWindow?.webContents, event);
});

browserManager.subscribeAnnotationEvents((event) => {
  sendBrowserAnnotationEvent(mainWindow?.webContents, event);
});

function startBrowserPerformanceLogging(): void {
  if (browserPerfInterval || !browserPerfLoggingEnabled) {
    return;
  }

  browserPerfInterval = setInterval(() => {
    const snapshot = browserManager.getPerformanceSnapshot();
    const trackedProcessIds = new Set(snapshot.trackedProcessIds);
    const processMetrics = app
      .getAppMetrics()
      .filter((metric) => trackedProcessIds.has(metric.pid))
      .map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        cpu: Number(metric.cpu.percentCPUUsage.toFixed(1)),
        memMb: Math.round(metric.memory.workingSetSize / 1024),
        name: metric.name,
      }));

    console.info(`[${MOSS_BROWSER_LABEL} perf]`, {
      ...snapshot.counters,
      trackedProcessIds: snapshot.trackedProcessIds,
      processes: processMetrics,
    });
  }, BROWSER_PERF_SAMPLE_INTERVAL_MS);
  browserPerfInterval.unref();
}

async function ensureBrowserHostPipeServer(): Promise<void> {
  if (browserHostPipeServer || !MOSS_BROWSER_HOST_PIPE_PATH) {
    return;
  }
  const server = new BrowserHostPipeServer(browserManager, {
    capability: DESKTOP_BROWSER_HOST_CAPABILITY,
    requestOpenPanel: (threadId) => {
      if (!threadId) return;
      mainWindow?.webContents.send(IPC.browser.requestOpenPanel, { threadId });
    },
  });
  await server.start();
  browserHostPipeServer = server;
}

let destructiveMenuIconCache: Electron.NativeImage | null | undefined;
const desktopRuntimeInfo = resolveDesktopRuntimeInfo({
  platform: process.platform,
  processArch: process.arch,
  runningUnderArm64Translation: app.runningUnderARM64Translation === true,
});
const initialUpdateState = (): DesktopUpdateState =>
  createInitialDesktopUpdateState(
    app.getVersion(),
    desktopRuntimeInfo,
    desktopFlavor === "development" ? "production" : desktopFlavor,
  );

function logTimestamp(): string {
  return new Date().toISOString();
}

function logScope(scope: string): string {
  return `${scope} run=${APP_RUN_ID}`;
}

function sanitizeLogValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function writeDesktopLogHeader(message: string): void {
  if (!desktopLogSink) return;
  desktopLogSink.write(`[${logTimestamp()}] [${logScope("desktop")}] ${message}\n`);
}

function writeBackendSessionBoundary(phase: "START" | "END", details: string): void {
  if (!backendLogSink) return;
  const normalizedDetails = sanitizeLogValue(details);
  backendLogSink.write(
    `[${logTimestamp()}] ---- APP SESSION ${phase} run=${APP_RUN_ID} ${normalizedDetails} ----\n`,
  );
}

function safeConsoleError(...args: Parameters<typeof console.error>): void {
  try {
    console.error(...args);
  } catch (error: unknown) {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function getSafeExternalUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    return null;
  }

  return parsedUrl.toString();
}

function getSafeTheme(rawTheme: unknown): DesktopTheme | null {
  if (rawTheme === "light" || rawTheme === "dark" || rawTheme === "system") {
    return rawTheme;
  }

  return null;
}

function getDesktopWindowState(window: BrowserWindow): {
  isMaximized: boolean;
  isFullscreen: boolean;
} {
  return {
    isMaximized: window.isMaximized(),
    isFullscreen: window.isFullScreen(),
  };
}

function emitDesktopWindowState(window: BrowserWindow | null = mainWindow): void {
  if (!window || window.isDestroyed()) return;
  window.webContents.send(IPC.windowState, getDesktopWindowState(window));
}

function isSaveFileInput(input: unknown): input is {
  defaultFilename: string;
  contents: string;
  filters?: FileFilter[];
} {
  if (!input || typeof input !== "object") {
    return false;
  }
  const record = input as Record<string, unknown>;
  if (typeof record.defaultFilename !== "string" || record.defaultFilename.trim().length === 0) {
    return false;
  }
  if (typeof record.contents !== "string") {
    return false;
  }
  if (record.filters === undefined) {
    return true;
  }
  if (!Array.isArray(record.filters)) {
    return false;
  }
  return record.filters.every((filter) => {
    if (!filter || typeof filter !== "object") return false;
    const filterRecord = filter as Record<string, unknown>;
    return (
      typeof filterRecord.name === "string" &&
      Array.isArray(filterRecord.extensions) &&
      filterRecord.extensions.every((extension) => typeof extension === "string")
    );
  });
}

async function waitForBackendHttpReady(
  baseUrl: string,
  options?: Parameters<typeof waitForHttpReady>[1],
): Promise<void> {
  cancelBackendReadinessWait();
  const controller = new AbortController();
  backendReadinessAbortController = controller;

  try {
    await waitForHttpReady(baseUrl, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    if (backendReadinessAbortController === controller) {
      backendReadinessAbortController = null;
    }
  }
}

function cancelBackendReadinessWait(): void {
  backendReadinessAbortController?.abort();
  backendReadinessAbortController = null;
}

async function reserveBackendEndpoint(reason: string): Promise<void> {
  backendPort = await Effect.service(NetService).pipe(
    Effect.flatMap((net) => net.reserveLoopbackPort()),
    Effect.provide(NetService.layer),
    Effect.runPromise,
  );
  backendHttpUrl = `http://127.0.0.1:${backendPort}`;
  backendWsUrl = `ws://127.0.0.1:${backendPort}/?token=${encodeURIComponent(backendAuthToken)}`;
  process.env.MOSS_DESKTOP_WS_URL = backendWsUrl;
  writeDesktopLogHeader(`${reason} resolved backend endpoint port=${backendPort}`);
}

async function waitForBackendWindowReady(baseUrl: string): Promise<"listening" | "http"> {
  return await waitForBackendStartupReady({
    listeningPromise: backendListeningDetector?.promise ?? null,
    waitForHttpReady: () =>
      waitForBackendHttpReady(baseUrl, {
        path: "/health",
        // The child supervisor, not elapsed wall time, owns the terminal
        // condition. Large projection catch-up can legitimately outlive a
        // minute; this observer is cancelled when that child exits or the app
        // shuts down.
        timeoutMs: null,
        isReady: isBackendStartupReadyResponse,
      }),
    cancelHttpWait: cancelBackendReadinessWait,
  });
}

function ensureInitialBackendWindowOpen(
  baseUrl: string,
  options: { readonly background?: boolean } = {},
): void {
  openInitialBackendWindow({
    isDevelopment,
    baseUrl,
    hasExistingWindow: () => resolveDesktopContentWindow() !== null,
    createWindow: () => {
      mainWindow = createWindow({ deferAppLoad: true, background: options.background ?? false });
    },
    loadWindowApp: () => {
      const window = resolveDesktopContentWindow();
      if (!window || window.isDestroyed() || isQuitting) {
        return;
      }
      loadWindowApp(window, options);
      writeDesktopLogHeader("bootstrap renderer load requested");
    },
    getReadinessInFlight: () => backendInitialWindowOpenInFlight,
    setReadinessInFlight: (promise) => {
      backendInitialWindowOpenInFlight = promise;
    },
    waitForBackendWindowReady,
    writeLog: writeDesktopLogHeader,
    isReadinessAborted: isBackendReadinessAborted,
    formatErrorMessage,
    warn: (message, error) => {
      console.warn(message, error);
    },
  });
}

function writeDesktopStreamChunk(
  streamName: "stdout" | "stderr",
  chunk: unknown,
  encoding: BufferEncoding | undefined,
): void {
  if (!desktopLogSink) return;
  const buffer = Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(String(chunk), typeof chunk === "string" ? encoding : undefined);
  desktopLogSink.write(`[${logTimestamp()}] [${logScope(streamName)}] `);
  desktopLogSink.write(buffer);
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    desktopLogSink.write("\n");
  }
}

function installStdIoCapture(): void {
  if (!app.isPackaged || desktopLogSink === null || restoreStdIoCapture !== null) {
    return;
  }

  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  const patchWrite =
    (streamName: "stdout" | "stderr", originalWrite: typeof process.stdout.write) =>
    (
      chunk: string | Uint8Array,
      encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
      callback?: (error?: Error | null) => void,
    ): boolean => {
      const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
      writeDesktopStreamChunk(streamName, chunk, encoding);
      if (typeof encodingOrCallback === "function") {
        return originalWrite(chunk, encodingOrCallback);
      }
      if (callback !== undefined) {
        return originalWrite(chunk, encoding, callback);
      }
      if (encoding !== undefined) {
        return originalWrite(chunk, encoding);
      }
      return originalWrite(chunk);
    };

  process.stdout.write = patchWrite("stdout", originalStdoutWrite);
  process.stderr.write = patchWrite("stderr", originalStderrWrite);

  restoreStdIoCapture = () => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    restoreStdIoCapture = null;
  };
}

function initializePackagedLogging(): void {
  if (!app.isPackaged) return;
  try {
    desktopLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
      keepFileOpen: true,
    });
    backendLogSink = new RotatingFileSink({
      filePath: Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME),
      maxBytes: LOG_FILE_MAX_BYTES,
      maxFiles: LOG_FILE_MAX_FILES,
      keepFileOpen: true,
    });
    installStdIoCapture();
    writeDesktopLogHeader(`runtime log capture enabled logDir=${LOG_DIR}`);
  } catch (error) {
    // Logging setup should never block app startup.
    console.error("[desktop] failed to initialize packaged logging", error);
  }
}

initializePackagedLogging();

function getDestructiveMenuIcon(): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (destructiveMenuIconCache !== undefined) {
    return destructiveMenuIconCache ?? undefined;
  }
  try {
    const icon = nativeImage.createFromNamedImage("NSTrashFull").resize({
      width: 14,
      height: 14,
    });
    if (icon.isEmpty()) {
      destructiveMenuIconCache = null;
      return undefined;
    }
    icon.setTemplateImage(true);
    destructiveMenuIconCache = icon;
    return icon;
  } catch {
    destructiveMenuIconCache = null;
    return undefined;
  }
}

// Context-menu artwork is selected by a closed semantic key from the renderer.
// These are macOS-owned template image names, never renderer-supplied paths or
// bytes. Keeping the lookup here also means browser payloads cannot influence
// native image decoding.
const CONTEXT_MENU_NATIVE_IMAGE_NAMES: Readonly<Record<ContextMenuIconKey, string>> = {
  pin: "NSBookmarksTemplate",
  rename: "NSTouchBarComposeTemplate",
  "mark-unread": "NSInfo",
  "clear-notification": "NSCaution",
  archive: "NSFolderBurnable",
  handoff: "NSShareTemplate",
  copy: "NSTouchBarFolderCopyToTemplate",
  "copy-path": "NSPathTemplate",
  "copy-thread-id": "NSTouchBarTextBoxTemplate",
  "open-with": "NSActionTemplate",
  "open-path-in-terminal": "NSComputer",
  "return-to-single-chat": "NSGoBackTemplate",
  delete: "NSTrashFull",
};

function resolveContextMenuIcon(iconKey: ContextMenuIconKey): Electron.NativeImage | undefined {
  if (process.platform !== "darwin") return undefined;
  if (contextMenuIconCache.has(iconKey)) {
    return contextMenuIconCache.get(iconKey) ?? undefined;
  }

  try {
    const image = nativeImage
      .createFromNamedImage(CONTEXT_MENU_NATIVE_IMAGE_NAMES[iconKey])
      .resize({
        width: 14,
        height: 14,
      });
    if (image.isEmpty()) {
      contextMenuIconCache.set(iconKey, null);
      return undefined;
    }
    image.setTemplateImage(true);
    contextMenuIconCache.set(iconKey, image);
    return image;
  } catch {
    contextMenuIconCache.set(iconKey, null);
    return undefined;
  }
}

const CONTEXT_MENU_NATIVE_SHORTCUTS: Readonly<Record<ContextMenuShortcutKey, string>> = {
  pin: "Alt+CmdOrCtrl+P",
  rename: "Alt+CmdOrCtrl+R",
  "mark-unread": "Shift+CmdOrCtrl+U",
  archive: "Shift+CmdOrCtrl+A",
};

function resolveContextMenuShortcut(shortcutKey: ContextMenuShortcutKey): string {
  return CONTEXT_MENU_NATIVE_SHORTCUTS[shortcutKey];
}
let updatePollTimer: ReturnType<typeof setInterval> | null = null;
let updateStartupTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckInFlight = false;
let updateDownloadInFlight = false;
let activeUpdateCheck: Promise<void> | null = null;
let settleActiveUpdateCheck: (() => void) | null = null;
let activeUpdatePreparation: Promise<void> | null = null;
let updaterConfigured = false;
let updateState: DesktopUpdateState = initialUpdateState();
let updateBackgroundedAtMs: number | null = null;
let updateBackgroundBlurTimer: ReturnType<typeof setTimeout> | null = null;
let updateCheckTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
let updateDownloadStallTimer: ReturnType<typeof setTimeout> | null = null;
let updateInstallWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let automaticUpdateActivitySuppressed = false;
let updateDownloadCancellationToken: CancellationToken | null = null;
let rejectUpdateDownloadStall: ((error: Error) => void) | null = null;
let lastUpdateDownloadProgressSample: DownloadProgressSample | null = null;
let stalledDownloadCancellationSuppressionsRemaining = 0;
let stalledDownloadCancellationSuppressionExpiresAtMs = 0;
let downloadedUpdateArtifact: {
  readonly version: string;
  readonly identity: UpdateArtifactIdentity;
} | null = null;
let downloadedUpdateIdentityTask: Promise<void> | null = null;
let activeUpdateInstallHandoff: UpdateInstallHandoffExpectation | null = null;
const pendingUpdateCacheClearQueue = new PendingUpdateCacheClearQueue();

function resolveUpdaterErrorContext(): DesktopUpdateErrorContext {
  if (isUpdaterInstallPreparing || isUpdaterQuitAndInstallInFlight) return "install";
  if (updateDownloadInFlight) return "download";
  if (updateCheckInFlight) return "check";
  return updateState.errorContext;
}

function clearUpdaterInstallInFlightAfterError(input?: {
  readonly preservePendingPreparation?: boolean;
}): boolean {
  const preparationCancelled = updateInstallPreparation.cancel();
  if (preparationCancelled && input?.preservePendingPreparation) {
    return true;
  }
  if (!isUpdaterInstallPreparing && !isUpdaterQuitAndInstallInFlight) {
    return preparationCancelled;
  }
  isUpdaterInstallPreparing = false;
  isUpdaterQuitAndInstallInFlight = false;
  activeUpdateInstallHandoff = null;
  isQuitting = false;
  return preparationCancelled;
}

function deferDesktopQuitUntilUpdaterSettles(reason: string): void {
  const deferred = deferredDesktopQuitIntent.defer(reason);
  writeDesktopLogHeader(
    deferred
      ? `${reason} deferred until updater install preparation settles`
      : `${reason} waiting for previously deferred quit after updater install preparation`,
  );
}

function replayDeferredDesktopQuitAfterUpdaterSettles(): boolean {
  const outcome = settleDeferredDesktopQuitAfterUpdaterFailure(deferredDesktopQuitIntent, {
    replayQuit: (intent) => {
      writeDesktopLogHeader(`${intent.reason} replaying deferred quit after updater settled`);
      requestGracefulAppQuit(intent.reason);
    },
    // Preflight callers only need to replay a pending quit. Full install
    // recovery separately decides whether the stopped backend must be resumed.
    resumeApp: () => undefined,
  });
  return outcome !== "resumed-app";
}

function recoverDesktopAfterUpdaterInstallFailure(): void {
  if (replayDeferredDesktopQuitAfterUpdaterSettles()) return;

  // A second updater failure signal can race the replay above (for example,
  // before-quit handoff validation followed by the cancelled preparation).
  // Once graceful shutdown owns the lifecycle, do not revive the backend or
  // enqueue another quit chain.
  if (desktopShutdownPromise !== null || isQuitting) {
    return;
  }

  // The backend was already stopped for install preparation. When no quit was
  // requested in the meantime, restore the live app and its update polling.
  startBackend();
  scheduleUpdatePoll();
}

function clearUpdateInstallWatchdogTimer(): void {
  if (updateInstallWatchdogTimer) {
    clearTimeout(updateInstallWatchdogTimer);
    updateInstallWatchdogTimer = null;
  }
}

function getUpdateInstallMarkerPath(): string {
  return Path.join(app.getPath("userData"), UPDATE_INSTALL_MARKER_FILE_NAME);
}

function recordInstallMarkerFailure(
  nowIso: string,
  expected: UpdateInstallHandoffExpectation | null,
): number {
  if (!expected) {
    console.error(
      "[desktop-updater] Could not record durable install failure without an exact active attempt.",
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  const result = recordInstallMarkerFailureSync(getUpdateInstallMarkerPath(), expected, nowIso);
  if (result.status === "missing" || result.status === "invalid") {
    console.error(
      `[desktop-updater] Could not record durable install failure: marker is ${result.status}${result.status === "invalid" ? ` (${result.error})` : ""}.`,
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  if (result.status === "mismatch") {
    console.error(
      "[desktop-updater] Refusing to record install failure against a different durable attempt.",
    );
    return Math.max(1, updateState.installFailureCount + 1);
  }
  if (result.status === "write-failed") {
    console.error(
      `[desktop-updater] Failed to persist install failure marker: ${formatErrorMessage(result.error)}`,
    );
  }
  return result.marker.consecutiveFailures;
}

async function logMacUpdateDiagnostics(context: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const diagnostics = await Promise.race([
      collectMacUpdateDiagnostics(APP_USER_MODEL_ID),
      new Promise<string>((resolve) => {
        timeout = setTimeout(
          () => resolve("Diagnostic collection timed out."),
          AUTO_UPDATE_DIAGNOSTICS_TIMEOUT_MS,
        );
      }),
    ]);
    if (diagnostics) {
      console.info(`[desktop-updater] diagnostics (${context})\n${diagnostics}`);
    }
  } catch (error) {
    console.info(
      `[desktop-updater] diagnostics (${context}) unavailable: ${formatErrorMessage(error)}`,
    );
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

// quitAndInstall() is a fire-and-forget void call with no success signal: when
// the OS installer silently fails the app never quits and the user is left with
// no feedback (the "update doesn't work for some people" report). If the process
// is still alive after the watchdog window, recover and surface an actionable
// install failure so the UI can offer the manual-download fallback.
function armInstallWatchdog(): void {
  clearUpdateInstallWatchdogTimer();
  updateInstallWatchdogTimer = setTimeout(() => {
    updateInstallWatchdogTimer = null;
    if (!isUpdaterQuitAndInstallInFlight) {
      return;
    }
    const failedHandoff = activeUpdateInstallHandoff;
    clearUpdaterInstallInFlightAfterError();
    const consecutiveFailures = recordInstallMarkerFailure(new Date().toISOString(), failedHandoff);
    setUpdateState({
      ...reduceDesktopUpdateStateOnInstallFailure(
        updateState,
        "The update couldn’t be installed automatically.",
      ),
      installFailureCount: consecutiveFailures,
    });
    console.error(
      "[desktop-updater] quitAndInstall did not exit the app within the watchdog window; surfacing manual-download fallback.",
    );
    recoverDesktopAfterUpdaterInstallFailure();
  }, AUTO_UPDATE_INSTALL_WATCHDOG_MS);
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "hoola-local",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: DESKTOP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      // Let V8 persist compiled bytecode for renderer bundles served over this scheme
      // (Chromium only code-caches http(s) by default), so cold launches skip
      // recompiling the multi-MB app bundle.
      codeCache: true,
    },
  },
  {
    scheme: LOCAL_HTML_PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
  {
    scheme: "moss-mcp-sandbox",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

function resolveAppRoot(): string {
  if (!app.isPackaged) {
    return ROOT_DIR;
  }
  return app.getAppPath();
}

/**
 * Read the baked-in app-update.yml config (if applicable). The file ships inside
 * the package and never changes at runtime, so the parsed result is cached to keep
 * repeated callers off the synchronous-FS path on the main thread.
 */
function readAppUpdateYml(): Record<string, string> | null {
  if (appUpdateYmlCache !== undefined) {
    return appUpdateYmlCache;
  }
  appUpdateYmlCache = parseAppUpdateYml();
  return appUpdateYmlCache;
}

function parseAppUpdateYml(): Record<string, string> | null {
  try {
    // electron-updater reads from process.resourcesPath in packaged builds,
    // or dev-app-update.yml via app.getAppPath() in dev.
    const ymlPath = app.isPackaged
      ? Path.join(process.resourcesPath, "app-update.yml")
      : Path.join(app.getAppPath(), "dev-app-update.yml");
    const raw = FS.readFileSync(ymlPath, "utf-8");
    // The YAML is simple key-value pairs — avoid pulling in a YAML parser by
    // doing a line-based parse (fields: provider, owner, repo, releaseType, …).
    const entries: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const match = line.match(/^(\w+):\s*(.+)$/);
      if (match?.[1] && match[2]) entries[match[1]] = match[2].trim();
    }
    return entries.provider ? entries : null;
  } catch {
    return null;
  }
}

function normalizeFullCommitHash(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!COMMIT_HASH_PATTERN.test(trimmed)) {
    return null;
  }
  return trimmed.toLowerCase();
}

function normalizeCommitHash(value: unknown): string | null {
  return normalizeFullCommitHash(value)?.slice(0, COMMIT_HASH_DISPLAY_LENGTH) ?? null;
}

function resolveEmbeddedFullCommitHash(): string | null {
  const packageJsonPath = Path.join(resolveAppRoot(), "package.json");
  if (!FS.existsSync(packageJsonPath)) {
    return null;
  }

  try {
    const raw = FS.readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { mossCommitHash?: unknown };
    return normalizeFullCommitHash(parsed.mossCommitHash);
  } catch {
    return null;
  }
}

function resolveEmbeddedCommitHash(): string | null {
  return normalizeCommitHash(resolveEmbeddedFullCommitHash());
}

function resolveBackendCommitHash(): string | null {
  if (app.isPackaged) return resolveEmbeddedFullCommitHash();
  return normalizeFullCommitHash(process.env.MOSS_COMMIT_HASH);
}

declare const __MOSS_WINDOWS_UPDATER_PUBLISHER__: string;

function resolveEmbeddedWindowsPublisherSubjects(): string[] {
  if (!app.isPackaged || process.platform !== "win32") {
    return [];
  }

  const subject = __MOSS_WINDOWS_UPDATER_PUBLISHER__.trim();
  return subject ? [subject] : [];
}

function resolveAboutCommitHash(): string | null {
  if (aboutCommitHashCache !== undefined) {
    return aboutCommitHashCache;
  }

  const envCommitHash = normalizeCommitHash(process.env.MOSS_COMMIT_HASH);
  if (envCommitHash) {
    aboutCommitHashCache = envCommitHash;
    return aboutCommitHashCache;
  }

  // Only packaged builds are required to expose commit metadata.
  if (!app.isPackaged) {
    aboutCommitHashCache = null;
    return aboutCommitHashCache;
  }

  aboutCommitHashCache = resolveEmbeddedCommitHash();

  return aboutCommitHashCache;
}

function resolveBackendEntry(): string {
  return Path.join(resolveAppRoot(), "apps/server/dist/index.mjs");
}

function resolveBackendCwd(): string {
  if (!app.isPackaged) {
    return resolveAppRoot();
  }
  return OS.homedir();
}

async function requireCurrentDesktopMigrationBundle(): Promise<boolean> {
  try {
    const mismatch = inspectDesktopMigrationRuntimeIdentity({
      appRoot: resolveAppRoot(),
      isPackaged: app.isPackaged,
      embeddedDigest: embeddedDesktopMigrationRuntimeSourceDigest(),
    });
    return mismatch ? rejectDesktopMigrationBundleMismatch(mismatch) : true;
  } catch (error) {
    return rejectUnverifiableDesktopMigrationBundle(error);
  }
}

async function rejectUnverifiableDesktopMigrationBundle(error: unknown): Promise<false> {
  const message = formatErrorMessage(error);
  writeDesktopLogHeader(`migration bundle source check failed message=${message}`);
  await dialog.showMessageBox({
    type: "error",
    title: "Moss could not verify its server build",
    message: "The migration source could not be checked safely.",
    detail: `${message}\n\nRebuild with bun run build:desktop before starting Moss. The database was not opened.`,
    buttons: ["Quit"],
    defaultId: 0,
    noLink: true,
  });
  requestGracefulAppQuit("migration bundle source check failed");
  return false;
}

async function rejectDesktopMigrationBundleMismatch(
  mismatch: MigrationRuntimeIdentityMismatch,
): Promise<false> {
  writeDesktopLogHeader(
    `migration bundle source mismatch expected=${mismatch.expectedDigest} actual=${mismatch.actualDigest}`,
  );
  await dialog.showMessageBox({
    type: "error",
    title: "Moss's server build is stale",
    message: "The built migration code does not match this checkout.",
    detail:
      `Expected ${mismatch.expectedDigest}, but the desktop bundle contains ` +
      `${mismatch.actualDigest}.\n\nRebuild with bun run build:desktop before starting Moss. The database was not opened.`,
    buttons: ["Quit"],
    defaultId: 0,
    noLink: true,
  });
  requestGracefulAppQuit("stale migration bundle");
  return false;
}

function desktopMigrationRecoveryPaths(): DesktopMigrationRecoveryPaths {
  return resolveDesktopMigrationRecoveryPaths({
    baseDir: BASE_DIR,
    appRoot: resolveAppRoot(),
    isDevelopment,
  });
}

function isDesktopMigrationRecoveryPending(): boolean {
  try {
    // Deliberately not "a marker exists": while the backend still has resume
    // attempts left, a failed start is an ordinary restart, not a recovery
    // prompt. Escalating early would bury the self-heal under a dialog.
    return requiresDesktopMigrationRecovery(desktopMigrationRecoveryPaths());
  } catch (error) {
    // An unreadable marker path must not break crash supervision.
    writeDesktopLogHeader(
      `migration recovery marker check failed message=${formatErrorMessage(error)}`,
    );
    return false;
  }
}

/** Joins user-facing options as "a, b or c". */
function formatRecoveryOptionList(options: ReadonlyArray<string>): string {
  if (options.length <= 1) return options[0] ?? "";
  return `${options.slice(0, -1).join(", ")} or ${options[options.length - 1]}`;
}

async function handleDesktopMigrationRecovery(): Promise<DesktopMigrationRecoveryOutcome> {
  const paths = desktopMigrationRecoveryPaths();
  desktopStartupBlockedForDatabaseRestore = true;
  const outcome = await recoverDesktopMigrationIfRequired({
    // The gate opens only once the backend has spent its resume budget, while
    // the post-restore verification checks the marker file itself.
    requiresRecovery: () => requiresDesktopMigrationRecovery(paths),
    markerRemains: () => hasPendingDesktopMigrationRecovery(paths),
    choose: async ({ previousFailure }) => {
      // The user is here because Moss cannot open its database, so the
      // in-app update button is unreachable by definition. A newer build is
      // often the actual fix, and this dialog is the only surface left to
      // offer it from: installing it in place when the updater can reach the
      // feed, and handing over the download page otherwise.
      const releaseUrl = updateState.releaseUrl;
      const canInstallUpdate = canInstallUpdateFromRecovery();
      const restoreFailed = previousFailure?.attempt === "restore";
      const choices: Array<{
        readonly label: string;
        readonly detail: string;
        readonly decision: DesktopMigrationRecoveryDecision;
      }> = [
        restoreFailed
          ? {
              label: "Try restore again",
              detail: "retry the verified backup restore",
              decision: "restore",
            }
          : {
              label: "Restore backup and restart",
              detail: "restore the verified pre-migration backup and restart",
              decision: "restore",
            },
      ];
      if (canInstallUpdate) {
        choices.push({
          label: "Update Moss and restart",
          detail: "install the newest Moss release, which may already contain the fix",
          decision: "install-update",
        });
      }
      if (releaseUrl !== null) {
        choices.push({
          label: "Download latest release",
          detail: `${canInstallUpdate ? "download that release" : "download the latest Moss release"} in a browser`,
          decision: "open-release-page",
        });
      }
      choices.push({
        label: "Quit",
        detail: "quit without opening the database",
        decision: "quit",
      });

      const options = formatRecoveryOptionList(choices.map((choice) => choice.detail));
      const result = await dialog.showMessageBox({
        type: previousFailure === null ? "warning" : "error",
        title:
          previousFailure === null
            ? "Moss needs to recover its database"
            : restoreFailed
              ? "Migration recovery failed"
              : "Moss could not update itself",
        message:
          previousFailure === null
            ? "Moss stopped a database migration before it could finish safely."
            : restoreFailed
              ? "The saved database backup could not be restored."
              : "The newest Moss release could not be installed.",
        detail: `${previousFailure === null ? "" : `${previousFailure.message}\n\n`}You can ${options}. No provider or chat process will start until recovery succeeds.`,
        buttons: choices.map((choice) => choice.label),
        defaultId: 0,
        cancelId: choices.length - 1,
        noLink: true,
      });
      return choices[result.response]?.decision ?? "quit";
    },
    installUpdate: installLatestUpdateForMigrationRecovery,
    openReleasePage: () => {
      const releaseUrl = updateState.releaseUrl;
      if (releaseUrl !== null) void shell.openExternal(releaseUrl);
    },
    restore: () =>
      restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: backendNodeArgs(),
        paths,
        cwd: resolveBackendCwd(),
        env: process.env,
      }),
    requestRestart: () => app.relaunch(),
    requestQuit: (reason) => requestGracefulAppQuit(reason),
    formatError: formatErrorMessage,
    log: writeDesktopLogHeader,
  });
  if (outcome === "continue") {
    desktopStartupBlockedForDatabaseRestore = false;
  }
  return outcome;
}

function resolveDesktopStaticDir(): string | null {
  const appRoot = resolveAppRoot();
  const candidates = [
    Path.join(appRoot, "apps/server/dist/client"),
    Path.join(appRoot, "apps/web/dist"),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(Path.join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return null;
}

interface ServedStaticRoot {
  readonly dir: string;
  /** True when serving a real-disk snapshot instead of reading through the asar. */
  readonly snapshotted: boolean;
}

interface BundleIdentity {
  readonly path: string;
  readonly signature: BundleSignature | null;
}

class BundleChangedDuringStartupError extends Error {
  readonly bundlePath: string;
  readonly baseline: BundleSignature | null;
  readonly current: BundleSignature | null;

  constructor(input: {
    bundlePath: string;
    baseline: BundleSignature | null;
    current: BundleSignature | null;
  }) {
    super("The packaged application changed while its static assets were being prepared.");
    this.name = "BundleChangedDuringStartupError";
    this.bundlePath = input.bundlePath;
    this.baseline = input.baseline;
    this.current = input.current;
  }
}

let servedStaticRootCache: ServedStaticRoot | null | undefined;

// Serving static assets straight out of app.asar is vulnerable to the archive
// being replaced beneath the running app (Electron caches the header per process,
// so every later read returns bytes from the wrong offsets). Extract the client
// to a per-archive snapshot on real disk and serve that instead — both for the
// moss:// protocol here and, via MOSS_STATIC_DIR, for the backend's HTTP static
// route. Memoized so one app run serves one coherent asset generation.
function resolveServedStaticRoot(): ServedStaticRoot | null {
  if (servedStaticRootCache === undefined) {
    servedStaticRootCache = computeServedStaticRoot();
  }
  return servedStaticRootCache;
}

function computeServedStaticRoot(): ServedStaticRoot | null {
  const sourceDir = resolveDesktopStaticDir();
  if (!sourceDir) {
    return null;
  }
  const archivePath = findAsarArchivePath(sourceDir);
  if (!archivePath) {
    // Plain-directory client (dev, unpacked build): real files already survive swaps.
    pruneStaticSnapshotCache(Path.join(app.getPath("userData"), "static-snapshots"));
    return { dir: sourceDir, snapshotted: false };
  }
  const startupArchiveSignature =
    startupBundleIdentity && Path.resolve(startupBundleIdentity.path) === Path.resolve(archivePath)
      ? startupBundleIdentity.signature
      : undefined;
  if (startupArchiveSignature === null) {
    throw new BundleChangedDuringStartupError({
      bundlePath: archivePath,
      baseline: null,
      current: readBundleSignature(archivePath),
    });
  }
  const archiveSignature = startupArchiveSignature ?? readBundleSignature(archivePath);
  if (!archiveSignature) {
    return { dir: sourceDir, snapshotted: false };
  }
  const startedAtMs = Date.now();
  let snapshot: ReturnType<typeof ensureStaticSnapshot>;
  try {
    snapshot = ensureStaticSnapshot({
      sourceDir,
      cacheRoot: Path.join(app.getPath("userData"), "static-snapshots"),
      signature: `${archiveSignature.size}-${archiveSignature.mtimeMs}-${archiveSignature.inode}`,
    });
  } catch (error) {
    const currentArchiveSignature = readBundleSignature(archivePath);
    if (!isBundleStable(archiveSignature, currentArchiveSignature)) {
      throw new BundleChangedDuringStartupError({
        bundlePath: archivePath,
        baseline: archiveSignature,
        current: currentArchiveSignature,
      });
    }
    console.warn(
      "[desktop] Failed to snapshot static assets; serving from the archive",
      formatErrorMessage(error),
    );
    return { dir: sourceDir, snapshotted: false };
  }

  const currentArchiveSignature = readBundleSignature(archivePath);
  if (!isBundleStable(archiveSignature, currentArchiveSignature)) {
    // A newly-created snapshot may contain reads from both archive generations.
    // Never leave it behind for a future launch to reuse.
    if (!snapshot.reused) {
      try {
        FS.rmSync(snapshot.dir, { recursive: true, force: true });
      } catch {
        // The signature changes the snapshot key, so failed cleanup is disk waste
        // rather than a path the replacement generation can accidentally reuse.
      }
    }
    throw new BundleChangedDuringStartupError({
      bundlePath: archivePath,
      baseline: archiveSignature,
      current: currentArchiveSignature,
    });
  }

  writeDesktopLogHeader(
    `static snapshot ${snapshot.reused ? "reused" : "created"} dir=${snapshot.dir} in ${Date.now() - startedAtMs}ms`,
  );
  return { dir: snapshot.dir, snapshotted: true };
}

function handleFatalStartupError(stage: string, error: unknown): void {
  const message = formatErrorMessage(error);
  const detail =
    error instanceof Error && typeof error.stack === "string" ? `\n${error.stack}` : "";
  writeDesktopLogHeader(`fatal startup error stage=${stage} message=${message}`);
  captureSentryException(new Error("Moss desktop startup failed"), {
    errorSource: "desktop-startup",
    stage: stage.slice(0, 96),
    errorClass: error instanceof Error ? error.name.slice(0, 96) : "UnknownError",
  });
  console.error(`[desktop] fatal startup error (${stage})`, error);
  if (!isQuitting) {
    isQuitting = true;
    dialog.showErrorBox(
      nativeText("Moss failed to start", "Moss 启动失败"),
      `${nativeText("Stage", "阶段")}: ${stage}\n${message}${detail}`,
    );
  }
  requestGracefulAppQuit(`fatal startup (${stage})`);
}

function registerDesktopProtocol(): void {
  if (isDevelopment || desktopProtocolRegistered) return;

  // An unreadable first observation cannot be replaced by a later baseline:
  // Electron may already hold the header for the generation that disappeared.
  if (startupBundleIdentity && !startupBundleIdentity.signature) {
    throw new BundleChangedDuringStartupError({
      bundlePath: startupBundleIdentity.path,
      baseline: null,
      current: readBundleSignature(startupBundleIdentity.path),
    });
  }

  const staticRoot = resolveServedStaticRoot()?.dir ?? null;
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const resolveStaticRequest = createDesktopStaticProtocolResolver(staticRoot);

  protocol.registerFileProtocol(DESKTOP_SCHEME, (request, callback) => {
    callback(resolveStaticRequest(request.url));
  });

  desktopProtocolRegistered = true;
}

function resolveDesktopContentWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return (
    BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && !isRealtimeVoiceOverlayWindow(window),
    ) ?? null
  );
}

function dispatchMenuAction(action: string): void {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const existingWindow =
    focusedWindow && !isRealtimeVoiceOverlayWindow(focusedWindow)
      ? focusedWindow
      : resolveDesktopContentWindow();
  const targetWindow = existingWindow ?? createWindow();
  if (!existingWindow) {
    mainWindow = targetWindow;
  }

  const send = () => {
    if (targetWindow.isDestroyed()) return;
    targetWindow.webContents.send(IPC.menuAction, action);
    if (!targetWindow.isVisible()) {
      targetWindow.show();
    }
    targetWindow.focus();
  };

  if (targetWindow.webContents.isLoadingMainFrame()) {
    targetWindow.webContents.once("did-finish-load", send);
    return;
  }

  send();
}

function resolveMenuTargetWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  return focusedWindow && !isRealtimeVoiceOverlayWindow(focusedWindow)
    ? focusedWindow
    : resolveDesktopContentWindow();
}

function sendDesktopZoomFactor(webContents: Electron.WebContents): void {
  if (webContents.isDestroyed()) return;
  webContents.send(IPC.zoomFactorChanged, webContents.getZoomFactor());
}

function attachDesktopZoomFactorSync(window: BrowserWindow): void {
  const notify = () => sendDesktopZoomFactor(window.webContents);
  window.webContents.on("zoom-changed", notify);
  window.webContents.on("did-finish-load", notify);
}

function adjustWebContentsZoom(webContents: Electron.WebContents, multiplier: number): void {
  const nextZoomFactor = Math.min(
    DESKTOP_MENU_MAX_ZOOM_FACTOR,
    Math.max(DESKTOP_MENU_MIN_ZOOM_FACTOR, webContents.getZoomFactor() * multiplier),
  );
  webContents.setZoomFactor(nextZoomFactor);
}

function handleDesktopPhysicalZoomShortcut(
  event: Electron.Event,
  input: Electron.Input,
  target: Electron.WebContents,
): boolean {
  const action = resolveDesktopPhysicalZoomAction(process.platform, input);
  if (!action || target.isDestroyed()) {
    return false;
  }

  event.preventDefault();
  applyDesktopPhysicalZoomAction(target, action);
  return true;
}

function attachDesktopPhysicalZoomShortcuts(window: BrowserWindow): void {
  window.webContents.on("before-input-event", (event, input) => {
    if (handleDesktopPhysicalZoomShortcut(event, input, window.webContents)) return;
    handleDesktopZoomShortcut(event, input, window.webContents);
  });
}

function handleDesktopZoomShortcut(
  event: Electron.Event,
  input: Electron.Input,
  target: Electron.WebContents,
): boolean {
  const action = resolveDesktopZoomShortcutAction(process.platform, input);
  if (!action || target.isDestroyed()) {
    return false;
  }

  event.preventDefault();
  if (action === "resetZoom") {
    target.setZoomFactor(1);
  } else {
    // Same 1.1 step as the View-menu click handlers so keyboard and menu
    // zoom can never drift apart.
    adjustWebContentsZoom(
      target,
      action === "zoomIn" ? DESKTOP_MENU_ZOOM_FACTOR_STEP : 1 / DESKTOP_MENU_ZOOM_FACTOR_STEP,
    );
  }
  return true;
}

function resetWindowZoomFromMenu(): void {
  resolveMenuTargetWindow()?.webContents.setZoomFactor(1);
}

function adjustWindowZoomFromMenu(multiplier: number): void {
  const webContents = resolveMenuTargetWindow()?.webContents;
  if (!webContents) return;
  adjustWebContentsZoom(webContents, multiplier);
}

function readPersistedDesktopUiLocale(): NativeMenuLocale {
  try {
    const locale = FS.readFileSync(DESKTOP_UI_LOCALE_PATH, "utf8").trim();
    if (locale === "en" || locale === "zh-CN") return locale;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      console.warn("[desktop] Could not read the saved UI locale; using Simplified Chinese.");
    }
  }
  return "zh-CN";
}

async function persistDesktopUiLocale(locale: NativeMenuLocale): Promise<void> {
  await FS.promises.mkdir(Path.dirname(DESKTOP_UI_LOCALE_PATH), { recursive: true });
  await FS.promises.writeFile(DESKTOP_UI_LOCALE_PATH, `${locale}\n`, "utf8");
}

function nativeText(english: string, chinese: string): string {
  return desktopUiLocale === "zh-CN" ? chinese : english;
}

function localizeNativeMenu(menu: Menu): void {
  for (const item of menu.items) {
    if (item.label) {
      item.label = translateNativeMenuLabel(item.label, desktopUiLocale);
    }
    if (item.submenu) {
      localizeNativeMenu(item.submenu);
    }
  }
}

function buildLocalizedNativeMenu(template: readonly MenuItemConstructorOptions[]): Menu {
  const menu = Menu.buildFromTemplate([...template]);
  const refreshLabels = () => localizeNativeMenu(menu);
  refreshLabels();
  menu.on("menu-will-show", refreshLabels);
  return menu;
}

function localizeAutoUpdateDisabledReason(reason: string): string {
  if (desktopUiLocale !== "zh-CN") return reason;
  const messages: Readonly<Record<string, string>> = {
    "Automatic updates are not available because no update feed is configured.":
      "自动更新不可用，因为尚未配置更新源。",
    "Automatic updates are only available in packaged production builds.":
      "自动更新仅适用于已打包的正式版本。",
    "Automatic updates are disabled by the MOSS_DISABLE_AUTO_UPDATE setting.":
      "MOSS_DISABLE_AUTO_UPDATE 设置已禁用自动更新。",
    "Automatic updates on Linux require running the AppImage build.":
      "Linux 上的自动更新需要运行 AppImage 版本。",
  };
  return messages[reason] ?? reason;
}

// A configured app-update.yml (or the mock-updates flag) is the prerequisite for any
// auto-update activity; centralized so the menu and the enable check stay in lockstep.
function hasConfiguredUpdateFeed(): boolean {
  return readAppUpdateYml() !== null || Boolean(process.env.MOSS_DESKTOP_MOCK_UPDATES);
}

function resolveAutoUpdateDisabledReason(): string | null {
  return getAutoUpdateDisabledReason({
    isDevelopment,
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: process.env.APPIMAGE,
    disabledByEnv:
      desktopIdentity.usesScriptedUpdates || process.env.MOSS_DISABLE_AUTO_UPDATE === "1",
    hasUpdateFeedConfig: hasConfiguredUpdateFeed(),
  });
}

function handleCheckForUpdatesMenuClick(): void {
  const disabledReason = resolveAutoUpdateDisabledReason();
  if (disabledReason) {
    console.info("[desktop-updater] Manual update check requested, but updates are disabled.");
    void dialog.showMessageBox({
      type: "info",
      title: nativeText("Updates unavailable", "更新不可用"),
      message: nativeText("Automatic updates are not available right now.", "自动更新当前不可用。"),
      detail: localizeAutoUpdateDisabledReason(disabledReason),
      buttons: [nativeText("OK", "好")],
    });
    return;
  }

  if (!resolveDesktopContentWindow()) {
    mainWindow = createWindow();
  }
  void checkForUpdatesFromMenu();
}

async function checkForUpdatesFromMenu(): Promise<void> {
  await checkForUpdates("menu");

  if (updateState.status === "up-to-date") {
    void dialog.showMessageBox({
      type: "info",
      title: nativeText("You're up to date!", "已是最新版本"),
      message: nativeText(
        `Moss ${updateState.currentVersion} is currently the newest version available.`,
        `Moss ${updateState.currentVersion} 已是当前可用的最新版本。`,
      ),
      buttons: [nativeText("OK", "好")],
    });
  } else if (updateState.status === "downloading" || updateState.status === "available") {
    void dialog.showMessageBox({
      type: "info",
      title: nativeText("Update found", "发现更新"),
      message: nativeText(
        "Moss is preparing the update in the background.",
        "Moss 正在后台准备更新。",
      ),
      buttons: [nativeText("OK", "好")],
    });
  } else if (updateState.status === "downloaded") {
    void dialog.showMessageBox({
      type: "info",
      title: nativeText("Update ready", "更新已就绪"),
      message: nativeText(
        "Click Update in the sidebar when you’re ready to restart and install it.",
        "准备好重启并安装时，请点击侧边栏中的“更新”。",
      ),
      buttons: [nativeText("OK", "好")],
    });
  } else if (updateState.status === "error") {
    void dialog.showMessageBox({
      type: "warning",
      title: nativeText("Update check failed", "检查更新失败"),
      message: nativeText("Could not check for updates.", "无法检查更新。"),
      detail:
        updateState.message ??
        nativeText(
          "An unknown error occurred. Please try again later.",
          "发生未知错误，请稍后重试。",
        ),
      buttons: [nativeText("OK", "好")],
    });
  }
}

function configureApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [];
  const keyboardShortcutsAccelerator = resolveKeyboardShortcutsMenuAccelerator(process.platform);
  const acceleratorProps = (
    accelerator: MenuItemConstructorOptions["accelerator"] | null,
  ): Pick<MenuItemConstructorOptions, "accelerator"> => {
    if (!accelerator) return {};
    const resolved = resolveDesktopMenuAccelerator(process.platform, accelerator);
    return resolved ? { accelerator: resolved } : {};
  };
  const zoomMenuItems: MenuItemConstructorOptions[] = shouldUseNativeZoomMenuRoles(process.platform)
    ? [
        { role: "resetZoom" },
        { role: "zoomIn", ...acceleratorProps("CmdOrCtrl+=") },
        { role: "zoomIn", ...acceleratorProps("CmdOrCtrl+Plus"), visible: false },
        { role: "zoomOut" },
      ]
    : [
        { label: "Reset Zoom", click: () => resetWindowZoomFromMenu() },
        {
          label: "Zoom In",
          click: () => adjustWindowZoomFromMenu(DESKTOP_MENU_ZOOM_FACTOR_STEP),
        },
        {
          label: "Zoom Out",
          click: () => adjustWindowZoomFromMenu(1 / DESKTOP_MENU_ZOOM_FACTOR_STEP),
        },
      ];

  if (process.platform === "darwin") {
    template.push({
      label: app.name,
      submenu: [
        { role: "about" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => dispatchMenuAction("open-settings"),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      id: "moss-file",
      submenu: [
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: "Settings...",
                ...acceleratorProps("CmdOrCtrl+,"),
                click: () => dispatchMenuAction("open-settings"),
              },
              { type: "separator" as const },
            ]),
        { role: process.platform === "darwin" ? "close" : "quit" },
      ],
    },
    { id: "moss-edit", role: "editMenu" },
    {
      label: "View",
      id: "moss-view",
      submenu: [
        {
          label: "New Terminal Tab",
          ...acceleratorProps(desktopMenuAccelerators["terminal.new"]),
          click: () => dispatchMenuAction("new-terminal-tab"),
        },
        { type: "separator" },
        {
          label: "Toggle Sidebar",
          ...acceleratorProps(desktopMenuAccelerators["sidebar.toggle"]),
          click: () => dispatchMenuAction("toggle-sidebar"),
        },
        {
          label: "Toggle Browser",
          ...acceleratorProps(desktopMenuAccelerators["browser.toggle"]),
          click: () => dispatchMenuAction("toggle-browser"),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        ...zoomMenuItems,
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
    {
      role: "help",
      id: "moss-help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          ...(keyboardShortcutsAccelerator ? { accelerator: keyboardShortcutsAccelerator } : {}),
          click: () => dispatchMenuAction("show-shortcuts"),
        },
        { type: "separator" },
        {
          label: "Check for Updates...",
          click: () => handleCheckForUpdatesMenuClick(),
        },
      ],
    },
  );

  Menu.setApplicationMenu(buildLocalizedNativeMenu(template));
}

function resolveResourcePath(fileName: string): string | null {
  const candidates = [
    Path.join(__dirname, "../resources", fileName),
    Path.join(__dirname, "../prod-resources", fileName),
    Path.join(process.resourcesPath, "resources", fileName),
    Path.join(process.resourcesPath, fileName),
  ];

  for (const candidate of candidates) {
    if (FS.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function resolveIconPath(ext: "ico" | "icns" | "png"): string | null {
  return resolveResourcePath(`icon.${ext}`);
}

function resolveNotificationIconPath(): string | null {
  if (process.platform === "darwin") {
    return null;
  }
  if (process.platform === "win32") {
    return (
      resolveResourcePath("moss.png") ?? resolveResourcePath("moss.png") ?? resolveIconPath("ico")
    );
  }
  return (
    resolveResourcePath("moss.png") ?? resolveResourcePath("moss.png") ?? resolveIconPath("png")
  );
}

function loadWindowMaterialAddon(): WindowMaterialAddon | null {
  const addonPath = app.isPackaged
    ? Path.resolve(process.resourcesPath, "..", "Frameworks", "moss-window-material.node")
    : Path.resolve(
        __dirname,
        "..",
        ".electron-runtime",
        "window-material",
        "moss-window-material.node",
      );
  try {
    const addonModule: { exports: Partial<WindowMaterialAddon> } = { exports: {} };
    process.dlopen(addonModule, addonPath);
    const { setBackgroundBlurRadius } = addonModule.exports;
    if (typeof setBackgroundBlurRadius !== "function") {
      throw new Error("setBackgroundBlurRadius export is missing");
    }
    return { setBackgroundBlurRadius };
  } catch (error) {
    console.warn(
      `[desktop] Window blur addon unavailable, keeping vibrancy: ${formatErrorMessage(error)}`,
    );
    return null;
  }
}

const applyWindowMaterial = createWindowMaterialApplier(loadWindowMaterialAddon);

function resolveAppSnapHelperPath(): string {
  if (app.isPackaged) {
    return Path.resolve(process.resourcesPath, "..", "Helpers", "moss-appsnap-helper");
  }
  return Path.resolve(__dirname, "..", ".electron-runtime", "appsnap", "moss-appsnap-helper");
}

/// The .app bundle that owns this process; the permission guide drags this
/// bundle into the System Settings privacy lists.
function resolveAppSnapAppBundlePath(): string {
  let directory = Path.dirname(app.getPath("exe"));
  while (directory !== Path.dirname(directory)) {
    if (directory.endsWith(".app")) return directory;
    directory = Path.dirname(directory);
  }
  return app.getPath("exe");
}

function ensureMainWindowForAppSnap(): BrowserWindow | null {
  if (mainWindow?.isDestroyed()) {
    mainWindow = null;
  }
  if (!mainWindow && backendPort > 0 && !isQuitting) {
    mainWindow = createWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  focusMainWindow({ stealAppFocus: true });
  return mainWindow;
}

function ensureMainWindowForRealtimeVoice(): BrowserWindow | null {
  if (mainWindow?.isDestroyed()) {
    mainWindow = null;
  }
  if (!mainWindow && backendPort > 0 && !isQuitting) {
    // A global shortcut must have exactly one renderer/WebRTC owner, but it
    // should not pull the full task window over the user's current app.
    mainWindow = createWindow({ suppressInitialShow: true });
  }
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function isRealtimeVoiceOverlayWindow(window: BrowserWindow | null): boolean {
  return Boolean(window && realtimeVoiceOverlayWindow === window && !window.isDestroyed());
}

function clearRealtimeVoiceOverlayRecreateTimer(): void {
  if (!realtimeVoiceOverlayRecreateTimer) return;
  clearTimeout(realtimeVoiceOverlayRecreateTimer);
  realtimeVoiceOverlayRecreateTimer = null;
}

function initializeDesktopAppSnap(): void {
  if (appSnapManager) return;
  appSnapManager = new DesktopAppSnapManager({
    platform: process.platform,
    helperPath: resolveAppSnapHelperPath(),
    captureDirectory: Path.join(app.getPath("userData"), "appsnap", "tmp"),
    excludedBundleId: APP_USER_MODEL_ID,
    appDisplayName: APP_DISPLAY_NAME,
    appBundlePath: resolveAppSnapAppBundlePath(),
    shortcutRegistry: globalShortcut,
    openSettingsPane: (pane) => {
      const paneUrl = APP_SNAP_SETTINGS_PANE_URLS[pane];
      if (paneUrl) void shell.openExternal(paneUrl).catch(() => undefined);
    },
    // Best effort: quit System Settings after a permission setup session lands
    // every grant, so the user is not left staring at a pane they are done with.
    closeSettingsApp: () => {
      try {
        const child = ChildProcess.execFile("/usr/bin/osascript", [
          "-e",
          'tell application "System Settings" to quit',
          "-e",
          'tell application "System Preferences" to quit',
        ]);
        child.on("error", () => undefined);
      } catch {
        // Grants already landed; a lingering Settings window is not a failure.
      }
    },
    onState: (state) => {
      sendAppSnapEvent(mainWindow, (webContents) => sendAppSnapState(webContents, state));
    },
    onPermissionGuideState: (state) => {
      sendAppSnapEvent(mainWindow, (webContents) =>
        sendAppSnapPermissionGuideState(webContents, state),
      );
    },
    onCaptured: (capture) => {
      const window = ensureMainWindowForAppSnap();
      if (sendAppSnapEvent(window, (webContents) => sendAppSnapCaptured(webContents, capture))) {
        return;
      }
      // The renderer is still loading: replay the event once the main frame is
      // ready. The renderer dedupes by capture id, and the capture also stays
      // in the pending queue as a fallback for the next mount.
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.once("did-finish-load", () => {
          sendAppSnapEvent(window, (webContents) => sendAppSnapCaptured(webContents, capture));
        });
      }
    },
    onError: (error, focusApp) => {
      const window = focusApp ? ensureMainWindowForAppSnap() : mainWindow;
      if (!sendAppSnapEvent(window, (webContents) => sendAppSnapError(webContents, error))) {
        showDesktopNotification({
          title: error.code === "pending-capture-overflow" ? "AppSnap discarded" : "AppSnap failed",
          body: error.message,
        });
      }
    },
  });
}

function clearRealtimeVoiceOverlayStabilityTimer(): void {
  if (!realtimeVoiceOverlayStabilityTimer) return;
  clearTimeout(realtimeVoiceOverlayStabilityTimer);
  realtimeVoiceOverlayStabilityTimer = null;
}

function clearRealtimeVoiceOverlayMotionTimer(): void {
  if (!realtimeVoiceOverlayMotionTimer) return;
  clearTimeout(realtimeVoiceOverlayMotionTimer);
  realtimeVoiceOverlayMotionTimer = null;
}

function shouldReduceRealtimeVoiceOverlayMotion(): boolean {
  if (nativeTheme.shouldUseHighContrastColors) return true;
  if (process.platform !== "darwin") return false;
  try {
    return systemPreferences.getUserDefault("reduceMotion", "boolean") === true;
  } catch {
    return false;
  }
}

function queueRealtimeVoiceOverlayHandoff(
  handoff: DesktopRealtimeVoiceOverlayHandoff | null,
): void {
  if (
    !handoff ||
    handoff.from !== "main-thread" ||
    !handoff.origin ||
    handoff.sequence <= realtimeVoiceOverlayLastHandoffSequence
  ) {
    return;
  }
  realtimeVoiceOverlayPendingHandoff = handoff;
}

function animateRealtimeVoiceOverlayHandoff(window: BrowserWindow): void {
  const handoff = realtimeVoiceOverlayPendingHandoff;
  if (
    !handoff ||
    !handoff.origin ||
    window.isDestroyed() ||
    !realtimeVoiceOverlayRendererReady ||
    !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
  ) {
    return;
  }

  realtimeVoiceOverlayPendingHandoff = null;
  realtimeVoiceOverlayLastHandoffSequence = handoff.sequence;
  clearRealtimeVoiceOverlayMotionTimer();
  const generation = realtimeVoiceOverlayState.current.generation;
  const geometry = resolveDesktopRealtimeVoiceOverlayGeometry(
    REALTIME_VOICE_OVERLAY_SIZE,
    realtimeVoiceOverlayPlacement,
  );
  const start = resolveDesktopRealtimeVoiceOverlayHandoffStartBounds(
    handoff.origin,
    REALTIME_VOICE_OVERLAY_SIZE,
    geometry?.orbCenterOffset,
  );
  const target = resolveDesktopRealtimeVoiceOverlayHandoffTargetBounds(
    handoff.origin,
    (point) => screen.getDisplayNearestPoint(point).workArea,
  );
  if (shouldReduceRealtimeVoiceOverlayMotion()) {
    window.setBounds(target, false);
    if (!window.isVisible()) window.showInactive();
    syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window);
    return;
  }

  window.setBounds(start, false);
  if (!window.isVisible()) window.showInactive();
  syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window);

  const distance = Math.hypot(target.x - start.x, target.y - start.y);
  const durationMs = Math.min(650, Math.max(360, Math.round(360 + distance * 0.08)));
  const startedAt = Date.now();
  const advance = (): void => {
    realtimeVoiceOverlayMotionTimer = null;
    if (
      window.isDestroyed() ||
      realtimeVoiceOverlayState.current.generation !== generation ||
      !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
    ) {
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
    const position = resolveDesktopRealtimeVoiceOverlayHandoffPosition({
      from: start,
      to: target,
      velocity: handoff.velocity,
      progress,
      durationMs,
    });
    window.setBounds({ ...target, ...position }, false);
    syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window);
    if (progress >= 1) return;
    realtimeVoiceOverlayMotionTimer = setTimeout(advance, 16);
    realtimeVoiceOverlayMotionTimer.unref();
  };
  advance();
}

function realtimeVoiceOverlayRendererState(): typeof realtimeVoiceOverlayState.current & {
  readonly type: typeof REALTIME_VOICE_OVERLAY_LAYOUT_CHANGED_TYPE;
  readonly layout: { readonly placement: DesktopRealtimeVoiceOverlayPlacement };
} {
  return {
    ...realtimeVoiceOverlayState.current,
    type: REALTIME_VOICE_OVERLAY_LAYOUT_CHANGED_TYPE,
    layout: { placement: realtimeVoiceOverlayPlacement },
  };
}

function clearRealtimeVoiceOverlayPointerDrag(): void {
  realtimeVoiceOverlayPointerDrag = null;
}

function moveRealtimeVoiceOverlayPointerDrag(
  window: BrowserWindow,
  event: Extract<
    DesktopRealtimeVoiceOverlayPointerDragEvent,
    { readonly type: "avatar-overlay-drag-move" | "avatar-overlay-drag-end" }
  >,
): void {
  const drag = realtimeVoiceOverlayPointerDrag;
  if (!drag || drag.pointerId !== event.pointerId || window.isDestroyed()) return;
  const pointerScreenPoint = { x: event.pointerScreenX, y: event.pointerScreenY };
  const display = screen.getDisplayNearestPoint(pointerScreenPoint);
  const layout = resolveDesktopRealtimeVoiceOverlayDragLayout({
    pointerScreenPoint,
    pointerOffsetInOrb: drag.pointerOffsetInOrb,
    workArea: display.workArea,
  });
  drag.hasMoved = true;
  realtimeVoiceOverlayPlacement = layout.placement;
  realtimeVoiceOverlayUserPositioned = true;
  window.setBounds(layout.bounds, false);
  sendRealtimeVoiceOverlayState();
  syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window, true);
}

function startRealtimeVoiceOverlayReleaseMomentum(
  window: BrowserWindow,
  velocity: { readonly x: number; readonly y: number },
): void {
  clearRealtimeVoiceOverlayMotionTimer();
  let velocityX = velocity.x;
  let velocityY = velocity.y;
  const startedAt = Date.now();
  let previousAt = startedAt;
  const advance = (): void => {
    realtimeVoiceOverlayMotionTimer = null;
    if (
      window.isDestroyed() ||
      !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
    ) {
      return;
    }
    const now = Date.now();
    const elapsedMs = Math.min(32, Math.max(0, now - previousAt));
    previousAt = now;
    const geometry = resolveDesktopRealtimeVoiceOverlayGeometry(
      window.getBounds(),
      realtimeVoiceOverlayPlacement,
    );
    if (!geometry) return;
    const bounds = window.getBounds();
    const nextOrbTopLeft = {
      x: bounds.x + geometry.slot.left + (velocityX * elapsedMs) / 1_000,
      y: bounds.y + geometry.slot.top + (velocityY * elapsedMs) / 1_000,
    };
    const display = screen.getDisplayNearestPoint({
      x: Math.round(nextOrbTopLeft.x + REALTIME_VOICE_OVERLAY_ORB_SIZE.width / 2),
      y: Math.round(nextOrbTopLeft.y + REALTIME_VOICE_OVERLAY_ORB_SIZE.height / 2),
    });
    const layout = resolveDesktopRealtimeVoiceOverlayDragLayout({
      pointerScreenPoint: nextOrbTopLeft,
      pointerOffsetInOrb: { x: 0, y: 0 },
      workArea: display.workArea,
    });
    const placementChanged = realtimeVoiceOverlayPlacement !== layout.placement;
    realtimeVoiceOverlayPlacement = layout.placement;
    realtimeVoiceOverlayUserPositioned = true;
    window.setBounds(layout.bounds, false);
    if (placementChanged) sendRealtimeVoiceOverlayState();
    syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window, true);

    const damping = 0.88 ** (elapsedMs / 16);
    velocityX *= damping;
    velocityY *= damping;
    if (now - startedAt >= 900 || Math.hypot(velocityX, velocityY) < 65) return;
    realtimeVoiceOverlayMotionTimer = setTimeout(advance, 16);
    realtimeVoiceOverlayMotionTimer.unref();
  };
  realtimeVoiceOverlayMotionTimer = setTimeout(advance, 16);
  realtimeVoiceOverlayMotionTimer.unref();
}

function handleRealtimeVoiceOverlayPointerDrag(
  window: BrowserWindow,
  event: DesktopRealtimeVoiceOverlayPointerDragEvent,
): void {
  if (event.type === "avatar-overlay-drag-release") {
    if (realtimeVoiceOverlayPointerDrag !== null) return;
    startRealtimeVoiceOverlayReleaseMomentum(window, {
      x: event.velocityX,
      y: event.velocityY,
    });
    return;
  }
  if (event.type === "avatar-overlay-drag-start") {
    const geometry = resolveDesktopRealtimeVoiceOverlayGeometry(
      window.getContentBounds(),
      realtimeVoiceOverlayPlacement,
    );
    if (!geometry) return;
    const pointerOffsetInOrb = {
      x: event.pointerWindowX - geometry.slot.left,
      y: event.pointerWindowY - geometry.slot.top,
    };
    if (
      pointerOffsetInOrb.x < 0 ||
      pointerOffsetInOrb.y < 0 ||
      pointerOffsetInOrb.x > REALTIME_VOICE_OVERLAY_ORB_SIZE.width ||
      pointerOffsetInOrb.y > REALTIME_VOICE_OVERLAY_ORB_SIZE.height
    ) {
      return;
    }
    clearRealtimeVoiceOverlayMotionTimer();
    realtimeVoiceOverlayPendingHandoff = null;
    realtimeVoiceOverlayPointerDrag = {
      pointerId: event.pointerId,
      pointerOffsetInOrb,
      hasMoved: false,
    };
    setRealtimeVoiceOverlayPointerInteractivity(window, true, true, {
      x: event.pointerScreenX,
      y: event.pointerScreenY,
    });
    return;
  }
  const drag = realtimeVoiceOverlayPointerDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (event.type === "avatar-overlay-drag-move" || drag.hasMoved) {
    moveRealtimeVoiceOverlayPointerDrag(window, event);
  }
  if (event.type === "avatar-overlay-drag-end") {
    clearRealtimeVoiceOverlayPointerDrag();
    syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window, true);
  }
}

function sendRealtimeVoiceOverlayState(): void {
  const window = realtimeVoiceOverlayWindow;
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    !realtimeVoiceOverlayRendererReady
  ) {
    return;
  }
  window.webContents.send(IPC.realtimeVoice.overlayState, realtimeVoiceOverlayRendererState());
}

/**
 * Keep the transparent Codex-sized viewport click-through except while the
 * the shared geometry or renderer reports that the cursor/focus is inside the
 * orb/control hit regions. `forward: true` preserves renderer mousemove
 * delivery without blocking the desktop underneath.
 */
function setRealtimeVoiceOverlayPointerInteractivity(
  window: BrowserWindow,
  interactive: boolean,
  force = false,
  cursorScreenPoint?: { readonly x: number; readonly y: number },
): void {
  if (window.isDestroyed() || (!force && realtimeVoiceOverlayPointerInteractive === interactive)) {
    return;
  }
  realtimeVoiceOverlayPointerInteractive = interactive;
  if (!interactive) {
    window.setIgnoreMouseEvents(true, { forward: true });
    return;
  }
  window.setIgnoreMouseEvents(false);
  if (window.webContents.isDestroyed()) return;
  const bounds = window.getContentBounds();
  const cursor = cursorScreenPoint ?? screen.getCursorScreenPoint();
  const x = cursor.x - bounds.x;
  const y = cursor.y - bounds.y;
  if (x < 0 || y < 0 || x > bounds.width || y > bounds.height) return;
  window.webContents.sendInputEvent({ type: "mouseMove", x, y, movementX: 0, movementY: 0 });
}

function syncRealtimeVoiceOverlayPointerInteractivityAtCursor(
  window: BrowserWindow,
  force = false,
): void {
  if (window.isDestroyed()) return;
  const bounds = window.getContentBounds();
  const cursor = screen.getCursorScreenPoint();
  setRealtimeVoiceOverlayPointerInteractivity(
    window,
    isDesktopRealtimeVoiceOverlayInteractiveScreenPoint(
      cursor,
      bounds,
      realtimeVoiceOverlayPlacement,
    ),
    force,
    cursor,
  );
}

function repositionRealtimeVoiceOverlay(window: BrowserWindow, preserveDisplay = false): void {
  if (window.isDestroyed()) return;
  const display = preserveDisplay
    ? screen.getDisplayMatching(window.getBounds())
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  realtimeVoiceOverlayPlacement = REALTIME_VOICE_OVERLAY_PLACEMENT;
  realtimeVoiceOverlayUserPositioned = false;
  window.setBounds(resolveDesktopRealtimeVoiceOverlayBounds(display.workArea), false);
  sendRealtimeVoiceOverlayState();
  if (window.isVisible()) syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window);
}

function showRealtimeVoiceOverlay(window: BrowserWindow, forcePointerSync = false): void {
  if (
    window.isDestroyed() ||
    !realtimeVoiceOverlayRendererReady ||
    !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
  ) {
    return;
  }
  const wasVisible = window.isVisible();
  if (!wasVisible) {
    if (!realtimeVoiceOverlayUserPositioned) repositionRealtimeVoiceOverlay(window);
    // Showing status must not steal focus from the application the user was in
    // when they invoked the global shortcut. Clicking the accessible controls
    // still activates this focusable panel normally.
    window.showInactive();
  }
  syncRealtimeVoiceOverlayPointerInteractivityAtCursor(window, forcePointerSync || !wasVisible);
}

function scheduleRealtimeVoiceOverlayRecreate(): void {
  if (
    isQuitting ||
    realtimeVoiceOverlayRecreateTimer ||
    !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
  ) {
    return;
  }
  const delays = [100, 500, 2_000, 5_000] as const;
  const delay = delays[Math.min(realtimeVoiceOverlayFailureCount, delays.length - 1)] ?? 5_000;
  realtimeVoiceOverlayRecreateTimer = setTimeout(() => {
    realtimeVoiceOverlayRecreateTimer = null;
    ensureRealtimeVoiceOverlayWindow();
  }, delay);
  realtimeVoiceOverlayRecreateTimer.unref();
}

function createRealtimeVoiceOverlayWindow(): BrowserWindow {
  realtimeVoiceOverlayPlacement = REALTIME_VOICE_OVERLAY_PLACEMENT;
  realtimeVoiceOverlayUserPositioned = false;
  clearRealtimeVoiceOverlayPointerDrag();
  const overlayUrl = buildDesktopRealtimeVoiceOverlayUrl();
  const bounds = resolveDesktopRealtimeVoiceOverlayBounds(
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
  );
  const window = new BrowserWindow({
    ...bounds,
    acceptFirstMouse: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    focusable: true,
    frame: false,
    fullscreenable: false,
    hasShadow: false,
    maximizable: false,
    minimizable: false,
    movable: true,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: "Moss Realtime Voice",
    transparent: true,
    ...(process.platform === "darwin"
      ? { enableLargerThanScreen: true, hiddenInMissionControl: true, type: "panel" as const }
      : {}),
    webPreferences: {
      accessibleTitle: "Moss Realtime Voice",
      additionalArguments: [REALTIME_VOICE_OVERLAY_PRELOAD_ARGUMENT],
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      partition: REALTIME_VOICE_OVERLAY_SESSION_PARTITION,
      preload: Path.join(__dirname, "preload.js"),
      sandbox: true,
      spellcheck: false,
      webSecurity: true,
    },
  });
  window.accessibleTitle = "Moss Realtime Voice";
  realtimeVoiceOverlayWindow = window;
  realtimeVoiceOverlayRendererReady = false;
  setRealtimeVoiceOverlayPointerInteractivity(window, false, true);
  window.setAlwaysOnTop(true, "floating");
  try {
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch {
    // Some Linux window managers do not expose an all-workspaces primitive.
  }
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== overlayUrl) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.webContents.on("did-start-loading", () => {
    realtimeVoiceOverlayRendererReady = false;
    clearRealtimeVoiceOverlayStabilityTimer();
  });
  window.webContents.on("did-finish-load", () => {
    if (!isRealtimeVoiceOverlayWindow(window)) return;
    realtimeVoiceOverlayRendererReady = true;
    clearRealtimeVoiceOverlayStabilityTimer();
    realtimeVoiceOverlayStabilityTimer = setTimeout(() => {
      realtimeVoiceOverlayStabilityTimer = null;
      if (isRealtimeVoiceOverlayWindow(window)) realtimeVoiceOverlayFailureCount = 0;
    }, 10_000);
    realtimeVoiceOverlayStabilityTimer.unref();
    sendRealtimeVoiceOverlayState();
    animateRealtimeVoiceOverlayHandoff(window);
    showRealtimeVoiceOverlay(window, true);
  });
  const fail = (reason: string): void => {
    if (!isRealtimeVoiceOverlayWindow(window)) return;
    captureSentryException(new Error("Moss desktop realtime overlay failed"), {
      errorSource: "desktop-realtime-overlay",
      reason: reason.slice(0, 120),
    });
    writeDesktopLogHeader(
      `realtime voice overlay renderer failed reason=${sanitizeLogValue(reason)}`,
    );
    clearRealtimeVoiceOverlayStabilityTimer();
    clearRealtimeVoiceOverlayMotionTimer();
    realtimeVoiceOverlayFailureCount += 1;
    realtimeVoiceOverlayRendererReady = false;
    window.destroy();
  };
  window.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame) fail(`load code=${code} message=${description}`);
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    fail(`process reason=${details.reason} exitCode=${details.exitCode}`);
  });
  window.on("closed", () => {
    if (realtimeVoiceOverlayWindow === window) {
      clearRealtimeVoiceOverlayStabilityTimer();
      realtimeVoiceOverlayWindow = null;
      realtimeVoiceOverlayRendererReady = false;
      realtimeVoiceOverlayPointerInteractive = false;
      clearRealtimeVoiceOverlayPointerDrag();
      scheduleRealtimeVoiceOverlayRecreate();
    }
  });
  void window
    .loadURL(overlayUrl)
    .catch((error) => fail(`load promise message=${formatErrorMessage(error)}`));
  return window;
}

function ensureRealtimeVoiceOverlayWindow(): BrowserWindow | null {
  if (
    isQuitting ||
    !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
  ) {
    return null;
  }
  clearRealtimeVoiceOverlayRecreateTimer();
  const current = realtimeVoiceOverlayWindow;
  if (current && !current.isDestroyed()) {
    return current;
  }
  return createRealtimeVoiceOverlayWindow();
}

function applyRealtimeVoiceOverlayPresentation(): void {
  const presentation = realtimeVoiceOverlayState.current;
  const snapshot = presentation.snapshot;
  const shouldShow = shouldShowDesktopRealtimeVoiceOverlay(snapshot);
  if (shouldShow && realtimeVoiceOverlayVisibleRevisionFloor === null) {
    realtimeVoiceOverlayVisibleRevisionFloor = presentation.revision;
  }
  queueRealtimeVoiceOverlayHandoff(presentation.handoff);
  if (!presentation.mediaOwnerActive) realtimeVoiceOwnerMessages.clearOverlayCommands();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(
      shouldThrottleDesktopRealtimeVoiceOwner(presentation),
    );
  }
  if (!shouldShow) {
    realtimeVoiceOverlayVisibleRevisionFloor = null;
    clearRealtimeVoiceOverlayMotionTimer();
    realtimeVoiceOverlayPendingHandoff = null;
    if (!presentation.mediaOwnerActive) realtimeVoiceOverlayLastHandoffSequence = 0;
    realtimeVoiceOwnerMessages.clearOverlayCommands();
    clearRealtimeVoiceOverlayPointerDrag();
    clearRealtimeVoiceOverlayRecreateTimer();
    const window = realtimeVoiceOverlayWindow;
    if (window && !window.isDestroyed()) {
      setRealtimeVoiceOverlayPointerInteractivity(window, false);
      sendRealtimeVoiceOverlayState();
      window.hide();
    }
    return;
  }
  const window = ensureRealtimeVoiceOverlayWindow();
  if (!window) return;
  sendRealtimeVoiceOverlayState();
  animateRealtimeVoiceOverlayHandoff(window);
  showRealtimeVoiceOverlay(window);
}

function withdrawRealtimeVoiceOverlayForOwnerLoss(
  options: { readonly preservePendingToggle?: boolean } = {},
): void {
  realtimeVoiceOwnerMessages.resetForOwnerReload({
    preserveToggle: options.preservePendingToggle === true,
  });
  const current = realtimeVoiceOverlayState.current;
  if (current.snapshot === null && !current.mediaOwnerActive) return;
  realtimeVoiceOverlayState.update({ snapshot: null, mediaOwnerActive: false, handoff: null });
  applyRealtimeVoiceOverlayPresentation();
}

function disposeRealtimeVoiceOverlay(): void {
  clearRealtimeVoiceOverlayRecreateTimer();
  clearRealtimeVoiceOverlayStabilityTimer();
  clearRealtimeVoiceOverlayMotionTimer();
  realtimeVoiceOverlayPendingHandoff = null;
  realtimeVoiceOverlayLastHandoffSequence = 0;
  realtimeVoiceOverlayVisibleRevisionFloor = null;
  realtimeVoiceOwnerMessages.resetForOwnerReload();
  realtimeVoiceOverlayState.update({ snapshot: null, mediaOwnerActive: false, handoff: null });
  const window = realtimeVoiceOverlayWindow;
  realtimeVoiceOverlayWindow = null;
  realtimeVoiceOverlayRendererReady = false;
  realtimeVoiceOverlayPointerInteractive = false;
  realtimeVoiceOverlayPlacement = REALTIME_VOICE_OVERLAY_PLACEMENT;
  realtimeVoiceOverlayUserPositioned = false;
  clearRealtimeVoiceOverlayPointerDrag();
  if (window && !window.isDestroyed()) window.destroy();
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.setBackgroundThrottling(true);
  }
}

function flushPendingRealtimeVoiceOwnerMessages(): void {
  const window = mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    window.webContents.isLoadingMainFrame()
  ) {
    return;
  }
  const presentation = realtimeVoiceOverlayState.current;
  const visibleRevisionFloor = realtimeVoiceOverlayVisibleRevisionFloor;
  const pending = realtimeVoiceOwnerMessages.drain(
    presentation.generation,
    visibleRevisionFloor ?? presentation.revision + 1,
    presentation.revision,
  );
  if (pending.toggle) window.webContents.send(IPC.realtimeVoice.toggle);
  for (const { command, handoff } of pending.commands) {
    window.webContents.send(IPC.realtimeVoice.overlayCommand, command, handoff);
  }
}

function requestRealtimeVoiceOwnerToggle(): boolean {
  const window = ensureMainWindowForRealtimeVoice();
  if (!window || window.webContents.isDestroyed()) return false;
  if (
    realtimeVoiceOwnerMessages.hasSubscription("toggle") &&
    !window.webContents.isLoadingMainFrame()
  ) {
    window.webContents.send(IPC.realtimeVoice.toggle);
  } else {
    // Toggle parity avoids starting a call later after the user pressed the
    // shortcut twice while the owner renderer was reloading.
    realtimeVoiceOwnerMessages.queueToggle();
  }
  return true;
}

function dispatchRealtimeVoiceOverlayCommand(
  command: DesktopRealtimeVoiceOverlayCommand,
  generation: number,
  revision: number,
): boolean {
  const presentation = realtimeVoiceOverlayState.current;
  if (
    !isDesktopRealtimeVoiceOverlayCommandRequestCurrent(
      { command, generation, revision },
      presentation,
      realtimeVoiceOverlayVisibleRevisionFloor,
    )
  ) {
    return false;
  }
  const window = ensureMainWindowForRealtimeVoice();
  if (!window || window.webContents.isDestroyed()) return false;
  const overlay = realtimeVoiceOverlayWindow;
  const overlayBounds = overlay && !overlay.isDestroyed() ? overlay.getBounds() : null;
  const overlayGeometry = overlayBounds
    ? resolveDesktopRealtimeVoiceOverlayGeometry(overlayBounds, realtimeVoiceOverlayPlacement)
    : null;
  const handoff: DesktopRealtimeVoiceOverlayHandoff | null =
    command === "handoff"
      ? {
          sequence: revision,
          from: "global-overlay",
          origin:
            overlayBounds && overlayGeometry
              ? {
                  centerX: overlayBounds.x + overlayGeometry.orbCenterOffset.x,
                  centerY: overlayBounds.y + overlayGeometry.orbCenterOffset.y,
                  width: REALTIME_VOICE_OVERLAY_ORB_SIZE.width,
                  height: REALTIME_VOICE_OVERLAY_ORB_SIZE.height,
                }
              : null,
          velocity: { x: 0, y: 0 },
        }
      : null;
  if (command === "focus" || command === "handoff") {
    focusMainWindow({ stealAppFocus: true });
  }
  if (
    realtimeVoiceOwnerMessages.hasSubscription("command") &&
    !window.webContents.isLoadingMainFrame()
  ) {
    window.webContents.send(IPC.realtimeVoice.overlayCommand, command, handoff);
  } else if (presentation.mediaOwnerActive) {
    realtimeVoiceOwnerMessages.queueCommand(command, generation, revision, handoff);
  } else if (command === "focus" || command === "handoff") {
    // A failed surface must always offer a reliable path back to the main task,
    // even after media cleanup removed the command subscriber.
    return true;
  } else {
    return false;
  }
  return true;
}

function repositionRealtimeVoiceOverlayAfterDisplayChange(): void {
  const window = realtimeVoiceOverlayWindow;
  if (!window || window.isDestroyed()) return;
  clearRealtimeVoiceOverlayMotionTimer();
  realtimeVoiceOverlayPendingHandoff = null;
  repositionRealtimeVoiceOverlay(window, true);
}

function canSendAppSnapEvent(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(
    window &&
    !window.isDestroyed() &&
    !window.webContents.isDestroyed() &&
    !window.webContents.isLoadingMainFrame(),
  );
}

function sendAppSnapEvent(
  window: BrowserWindow | null,
  send: (webContents: BrowserWindow["webContents"]) => void,
): boolean {
  if (!canSendAppSnapEvent(window)) return false;
  send(window.webContents);
  return true;
}

function initializeRealtimeVoiceShortcut(): void {
  if (realtimeVoiceShortcutManager) return;
  realtimeVoiceShortcutManager = new DesktopRealtimeVoiceShortcutManager({
    registry: globalShortcut,
    platform: process.platform,
    onToggle: () => void requestRealtimeVoiceOwnerToggle(),
  });
}

// Keep the app badge aligned with desktop notifications that arrive off-focus.
function syncUnreadNotificationBadge(): void {
  app.setBadgeCount(unreadBackgroundNotificationCount);
}

// Count minimized, hidden, or unfocused windows as background notification targets.
function isMainWindowForeground(window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) {
    return false;
  }
  return window.isVisible() && !window.isMinimized() && window.isFocused();
}

function incrementUnreadNotificationBadge(): void {
  unreadBackgroundNotificationCount = Math.min(unreadBackgroundNotificationCount + 1, 99);
  syncUnreadNotificationBadge();
}

function clearUnreadNotificationBadge(): void {
  if (unreadBackgroundNotificationCount === 0) {
    return;
  }
  unreadBackgroundNotificationCount = 0;
  syncUnreadNotificationBadge();
}

function resolveRendererAppEntryUrl(): string {
  return isDevelopment ? (process.env.VITE_DEV_SERVER_URL as string) : desktopIdentity.entryUrl;
}

function focusDesktopWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!window.isVisible()) {
    window.show();
  }
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  window.focus();
}

function showDesktopWindowAtLaunchSize(
  window: BrowserWindow,
  options: { readonly background?: boolean } = {},
): void {
  if (window.isDestroyed() || window.isVisible()) {
    return;
  }
  showDesktopStartupWindow(window, {
    background: options.background ?? false,
    center: true,
    focus: () => focusDesktopWindow(window),
  });
  emitDesktopWindowState(window);
}

/**
 * Deliver a validated app route to the mounted renderer. The renderer performs
 * a TanStack PUSH and ACKs only after navigation succeeds, preserving Back.
 */
function flushPendingPluginDeepLinkNavigation(): void {
  const targetWindow = resolveDesktopContentWindow();
  if (
    !targetWindow ||
    targetWindow.isDestroyed() ||
    targetWindow.webContents.isDestroyed() ||
    !appRendererReadyWindows.has(targetWindow) ||
    pluginDeepLinkSubscriberWebContentsId !== targetWindow.webContents.id
  ) {
    return;
  }

  const navigation = pluginDeepLinkNavigationQueue.beginDelivery();
  if (!navigation) {
    return;
  }

  try {
    targetWindow.webContents.send(IPC.pluginDeepLinks.navigate, navigation);
    pluginDeepLinkAckWatchdog.arm(navigation.deliveryId);
    focusDesktopWindow(targetWindow);
  } catch {
    pluginDeepLinkAckWatchdog.clear();
    pluginDeepLinkNavigationQueue.cancelInFlightDelivery();
    pluginDeepLinkSubscriberWebContentsId = null;
    writeDesktopLogHeader("Moss plugin deep-link IPC delivery failed");
    console.warn("[desktop] Failed to deliver a Moss plugin deep link to the renderer.");
  }
}

function clearPluginDeepLinkRetryTimer(): void {
  if (!pluginDeepLinkRetryTimer) {
    return;
  }
  clearTimeout(pluginDeepLinkRetryTimer);
  pluginDeepLinkRetryTimer = null;
}

function resetPluginDeepLinkRetry(): void {
  clearPluginDeepLinkRetryTimer();
  pluginDeepLinkConsecutiveFailures = 0;
}

function schedulePluginDeepLinkRetry(): void {
  if (pluginDeepLinkRetryTimer || isQuitting) {
    return;
  }
  const delayMs = resolveMossPluginDeepLinkRetryDelay(pluginDeepLinkConsecutiveFailures);
  if (delayMs === null) {
    writeDesktopLogHeader("Moss plugin deep-link renderer navigation retained after retry limit");
    return;
  }
  pluginDeepLinkConsecutiveFailures += 1;
  pluginDeepLinkRetryTimer = setTimeout(() => {
    pluginDeepLinkRetryTimer = null;
    flushPendingPluginDeepLinkNavigation();
  }, delayMs);
  pluginDeepLinkRetryTimer.unref();
}

/**
 * Navigate only after the real renderer has loaded. Packaged startup first
 * shows a local splash while the backend becomes ready, so an OAuth callback
 * received during launch must remain queued instead of replacing that splash.
 */
function flushPendingMossAuthCallback(): void {
  if (mossAuthCallbackNavigationInFlight || !pendingMossAuthCallbackRoute) {
    return;
  }

  const targetWindow = resolveDesktopContentWindow();
  if (!targetWindow || targetWindow.isDestroyed() || !appRendererReadyWindows.has(targetWindow)) {
    return;
  }

  const route = pendingMossAuthCallbackRoute;
  pendingMossAuthCallbackRoute = null;
  const targetUrl = buildMossAuthCallbackRendererUrl(resolveRendererAppEntryUrl(), route);
  let navigationSucceeded = false;

  mossAuthCallbackNavigationInFlight = targetWindow
    .loadURL(targetUrl)
    .then(() => {
      navigationSucceeded = true;
      appRendererReadyWindows.add(targetWindow);
      focusDesktopWindow(targetWindow);
      flushPendingPluginDeepLinkNavigation();
    })
    .catch(() => {
      // Do not log the URL or Electron's error: either may contain the short-lived
      // authorization code. Keep it queued for the next safe navigation attempt.
      pendingMossAuthCallbackRoute ??= route;
      writeDesktopLogHeader("Moss auth callback renderer navigation failed");
      console.warn("[desktop] Failed to navigate to the Moss authentication callback.");
    })
    .finally(() => {
      mossAuthCallbackNavigationInFlight = null;
      if (navigationSucceeded && pendingMossAuthCallbackRoute) {
        flushPendingMossAuthCallback();
      }
    });
}

function queueMossAuthCallback(rawUrl: unknown): boolean {
  const route = resolveMossAuthCallbackRoute(rawUrl);
  if (!route) {
    return false;
  }
  pendingMossAuthCallbackRoute = route;
  writeDesktopLogHeader("Moss auth callback accepted");
  flushPendingMossAuthCallback();
  return true;
}

function queueMossAuthCallbackFromArgv(argv: ReadonlyArray<string>): boolean {
  const route = resolveMossAuthCallbackRouteFromArgv(argv);
  if (!route) {
    return false;
  }
  pendingMossAuthCallbackRoute = route;
  writeDesktopLogHeader("Moss auth callback accepted from process arguments");
  flushPendingMossAuthCallback();
  return true;
}

function registerMossAuthCallbackProtocolClient(): void {
  if (!shouldRegisterMossAuthCallbackProtocolClient(process.env)) return;
  let registered = false;
  try {
    if (!app.isPackaged && process.defaultApp) {
      const protocolClientArguments = buildMossAuthProtocolClientArguments(
        process.argv,
        userDataPath,
      );
      registered =
        protocolClientArguments !== null &&
        app.setAsDefaultProtocolClient(DESKTOP_SCHEME, process.execPath, protocolClientArguments);
    } else {
      registered = app.setAsDefaultProtocolClient(DESKTOP_SCHEME);
    }
  } catch {
    // Some development hosts cannot own a custom scheme until the app is
    // packaged; release artifacts also declare the scheme in their build config.
  }

  writeDesktopLogHeader(
    registered
      ? "Moss auth callback protocol client registered"
      : "Moss auth callback protocol client registration unavailable",
  );
}

// Reuse the existing desktop window when the app is launched again so users
// don't end up with multiple packaged instances racing the same local state.
function focusMainWindow(options: { stealAppFocus?: boolean } = {}): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = null;
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (process.platform === "darwin" && options.stealAppFocus === true) {
    // BrowserWindow.focus() alone does not activate an app while another macOS
    // application owns focus. Only AppSnap is an explicit global user gesture;
    // notification clicks and ordinary activation keep their existing focus policy.
    app.show();
    app.focus({ steal: true });
  }
  mainWindow.focus();
}

function flushConnectorOAuthCallbacks(): number {
  const window = mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    window.webContents.isDestroyed() ||
    connectorOAuthSubscriberWebContentsId !== window.webContents.id
  ) {
    return 0;
  }

  return connectorOAuthCallbackInbox.drain((callback) => {
    try {
      window.webContents.send(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.event, callback);
      return true;
    } catch {
      return false;
    }
  });
}

// Show a native OS notification and refocus the app window when the alert is clicked.
function showDesktopNotification(input: {
  title: string;
  body?: string;
  silent?: boolean;
  suppressWhenForeground?: boolean;
  threadId?: string;
}): boolean {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  const threadId = typeof input.threadId === "string" ? input.threadId.trim() : "";
  if (title.length === 0 || !Notification.isSupported()) {
    return false;
  }
  if (input.suppressWhenForeground === true && isMainWindowForeground(mainWindow)) {
    return false;
  }

  const iconPath = resolveNotificationIconPath();
  const notification = new Notification({
    title,
    body,
    silent: input.silent === true,
    ...(iconPath ? { icon: iconPath } : {}),
  });
  if (!isMainWindowForeground(mainWindow)) {
    incrementUnreadNotificationBadge();
  }

  notification.on("click", () => {
    clearUnreadNotificationBadge();
    focusMainWindow();
    if (!mainWindow) {
      return;
    }
    if (threadId.length > 0) {
      mainWindow.webContents.send(IPC.menuAction, `notification-open-thread:${threadId}`);
    }
  });

  desktopNotificationRetainer.retain(notification);
  notification.show();
  return true;
}

/**
 * Resolve the Electron userData directory path.
 *
 * Packaged Moss uses its own profile namespace so legacy Moss browser state,
 * cookies, and authentication cannot be imported implicitly.
 */
function resolveUserDataPath(): string {
  const appDataBase = resolveDesktopAppDataBase();
  return resolveDesktopUserDataPath({
    appDataBase,
    isDevelopment,
    userDataDirectoryName: desktopIdentity.userDataDirectoryName,
    testOverridePath: canOverrideDesktopSmokeUserData({
      packagedFlavor: packagedDesktopFlavor,
      sourceBuildMarker: requestedSourceBuildMarker,
    })
      ? process.env[MOSS_DESKTOP_SMOKE_USER_DATA_ENV]
      : undefined,
    overridePath: process.env.MOSS_DESKTOP_USER_DATA_DIR,
    commandLineOverridePath: app.commandLine.getSwitchValue("user-data-dir"),
  });
}

function repairBrowserProfileBeforeElectronReady(userDataPath: string): void {
  const browserProfileRepair = repairBrowserProfileFromBridgeManifest(userDataPath);
  if (browserProfileRepair.status === "repaired") {
    console.info("[desktop] Completed Moss browser profile bridge repair", {
      targetPath: browserProfileRepair.targetPath,
      copiedEntries: browserProfileRepair.copiedEntries,
    });
  } else if (browserProfileRepair.status === "repair-failed") {
    console.warn("[desktop] Failed to complete Moss browser profile bridge repair", {
      targetPath: browserProfileRepair.targetPath,
      error: browserProfileRepair.error,
    });
  }

  const retiredPartitionMigration = migrateRetiredBrowserPartitions(userDataPath);
  if (retiredPartitionMigration.status === "migrated") {
    console.info("[desktop] Retired predecessor browser partitions into recoverable archives", {
      targetPath: retiredPartitionMigration.targetPath,
      copiedEntries: retiredPartitionMigration.copiedEntries,
      retiredPartitionCount: retiredPartitionMigration.retiredPartitionCount,
    });
  } else if (retiredPartitionMigration.status === "migration-failed") {
    console.warn("[desktop] Failed to retire predecessor browser partitions", {
      targetPath: retiredPartitionMigration.targetPath,
      retiredPartitionCount: retiredPartitionMigration.retiredPartitionCount,
      error: retiredPartitionMigration.error,
    });
  }
}

function configureAppIdentity(): void {
  app.setName(APP_DISPLAY_NAME);
  const commitHash = resolveAboutCommitHash();
  app.setAboutPanelOptions({
    applicationName: APP_DISPLAY_NAME,
    applicationVersion: app.getVersion(),
    version: commitHash ?? "unknown",
    copyright: `© ${new Date().getFullYear()} Moss`,
  });

  if (process.platform === "win32") {
    app.setAppUserModelId(APP_USER_MODEL_ID);
  }
}

// Older macOS needs pre-rounded artwork as a runtime Dock override. macOS 26+
// renders the Icon Composer asset for Stable Default and Beta Beta choices.
const DESKTOP_DOCK_ICON_PREFERENCE_SET = new Set<DesktopDockIconPreference>([
  "app-default",
  "moss-black",
  "moss-coral",
]);

function normalizeDockIconPreference(value: unknown): DesktopDockIconPreference {
  return typeof value === "string" &&
    DESKTOP_DOCK_ICON_PREFERENCE_SET.has(value as DesktopDockIconPreference)
    ? (value as DesktopDockIconPreference)
    : "app-default";
}

// The packaged bundle icon is a solid, pre-rounded ICNS so Tahoe does not reinterpret
// the mark as Icon Composer glass. Older macOS gets the same literal rounded artwork as
// a runtime dock override because it does not apply the modern system mask itself.
function usesLegacyMacDockIcon(): boolean {
  if (process.platform !== "darwin") return false;
  const darwinMajor = Number.parseInt(OS.release().split(".")[0] ?? "", 10);
  return Number.isFinite(darwinMajor) && darwinMajor < 25;
}

function readDesktopAppIcon(): DesktopAppIcon {
  const requestedFallback = desktopFlavor === "beta" ? "beta" : "default";
  const fallbackIcon = isDesktopAppIcon(requestedFallback) ? requestedFallback : "default";
  return readDesktopAppIconPreference(DESKTOP_APP_ICON_PATH, {
    fallbackIcon,
    // Stable leaves a Beta choice inert. Builds without the Beta icon retain
    // the token too, so returning to a build that supports it restores it.
    inactiveIcons: desktopFlavor === "beta" && isDesktopAppIcon("beta") ? [] : ["beta"],
    onResetError: (error) => {
      safeConsoleError("[desktop] Failed to reset unrecognized app icon preference", error);
    },
  });
}

function persistDesktopAppIcon(icon: DesktopAppIcon): void {
  writeDesktopAppIconPreference(DESKTOP_APP_ICON_PATH, icon);
}

function windowsShortcutSearchDirectories(): string[] {
  const appData = process.env.APPDATA?.trim() ?? "";
  const programData =
    process.env.ProgramData?.trim() ?? Path.join(Path.parse(OS.homedir()).root, "ProgramData");
  return [
    Path.join(OS.homedir(), "Desktop"),
    Path.join(OS.homedir(), "OneDrive", "Desktop"),
    Path.join(programData, "Microsoft", "Windows", "Start Menu", "Programs"),
    Path.join(OS.homedir(), "..", "Public", "Desktop"),
    ...(appData.length > 0
      ? [
          Path.join(appData, "Microsoft", "Windows", "Start Menu", "Programs"),
          Path.join(
            appData,
            "Microsoft",
            "Internet Explorer",
            "Quick Launch",
            "User Pinned",
            "TaskBar",
          ),
        ]
      : []),
  ];
}

function syncWindowsTaskbarShortcuts(shellIconPath: string): string[] {
  // Always point shortcuts at the materialized ICO. Reverting to process.execPath
  // leaves Explorer serving the previous custom icon from its AUMID cache.
  const shortcutIconPath = shellIconPath;
  const shortcutPaths = collectWindowsShortcutPaths({
    directories: windowsShortcutSearchDirectories(),
    readdir: (directory) => FS.readdirSync(directory),
    isDirectory: (path) => {
      try {
        return FS.statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
  });
  const { matched } = syncWindowsShortcutIcons({
    iconPath: shortcutIconPath,
    iconIndex: 0,
    appId: APP_USER_MODEL_ID,
    executablePath: process.execPath,
    shortcutPaths,
    readShortcut: (shortcutPath) => {
      try {
        return shell.readShortcutLink(shortcutPath);
      } catch {
        return null;
      }
    },
    updateShortcut: (shortcutPath, iconPath, iconIndex) => {
      try {
        const current = shell.readShortcutLink(shortcutPath);
        return shell.writeShortcutLink(shortcutPath, "update", {
          ...current,
          icon: iconPath,
          iconIndex,
          appUserModelId: APP_USER_MODEL_ID,
        });
      } catch {
        return false;
      }
    },
  });
  return matched;
}

function materializeWindowsShellIcon(icon: DesktopAppIcon, sourcePath: string): string {
  const bytes = toWindowsTaskbarIcoBytes(sourcePath);
  const contentKey = windowsShellIconContentKey(icon, bytes);
  const cacheKey = nextWindowsShellIconCacheKey(contentKey);
  const fallbackDirectory = Path.join(STATE_DIR, "taskbar-icons");
  const directories = [
    ...new Set([
      resolveWindowsShellIconCacheDirectory({
        executablePath: process.execPath,
        fallbackDirectory,
      }),
      fallbackDirectory,
    ]),
  ];
  let lastError: unknown;
  for (const directory of directories) {
    try {
      FS.mkdirSync(directory, { recursive: true });
      const destinationPath = windowsShellIconCachePath(directory, cacheKey);
      if (FS.existsSync(destinationPath)) return destinationPath;
      try {
        FS.writeFileSync(destinationPath, bytes);
      } catch (error) {
        if (!FS.existsSync(destinationPath)) throw error;
      }
      return destinationPath;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Failed to materialize Windows shell icon");
}

const windowsTaskbarIcoBytesCache = new Map<string, Buffer>();

function toWindowsTaskbarIcoBytes(sourcePath: string): Buffer {
  const cached = windowsTaskbarIcoBytesCache.get(sourcePath);
  if (cached) return cached;
  const sourceBytes = FS.readFileSync(sourcePath);
  try {
    if (extractIcoPngImages(sourceBytes).length === 0) {
      windowsTaskbarIcoBytesCache.set(sourcePath, sourceBytes);
      return sourceBytes;
    }
    const converted = toWindowsShellIco(sourceBytes, (png, size) => {
      const image = nativeImage.createFromBuffer(png);
      if (image.isEmpty()) return null;
      const resized = image.resize({ width: size, height: size });
      const bgra = resized.toBitmap();
      if (bgra.length !== size * size * 4) return null;
      return { width: size, height: size, bgra };
    });
    windowsTaskbarIcoBytesCache.set(sourcePath, converted);
    return converted;
  } catch {
    return sourceBytes;
  }
}

let windowsShellStampTimer: ReturnType<typeof setImmediate> | null = null;
let windowsShellStampResolve: (() => void) | null = null;
let desktopAppIconApplyTail: Promise<void> = Promise.resolve();

async function syncMacAppBundleIcon(image: Electron.NativeImage | null): Promise<void> {
  // Do not customize the shared Electron executable used by development runs.
  if (!app.isPackaged) return;
  const bundlePath = resolveMacAppBundlePath(process.execPath, process.platform);
  if (!bundlePath) return;
  await persistMacAppIcon({
    bundlePath,
    cacheDirectory: Path.join(STATE_DIR, "mac-app-icons"),
    png: image?.toPNG() ?? null,
  });
}

function cancelDeferredWindowsShellStamp(): void {
  if (windowsShellStampTimer === null) return;
  clearImmediate(windowsShellStampTimer);
  windowsShellStampTimer = null;
  const resolve = windowsShellStampResolve;
  windowsShellStampResolve = null;
  resolve?.();
}

function stampWindowsShellAppUserModel(
  input: Parameters<typeof applyWindowsShellAppUserModel>[0],
  options?: {
    flush?: boolean;
  },
): void {
  try {
    applyWindowsShellAppUserModel(input, Path.join(STATE_DIR, "taskbar-icons"), options);
  } catch (error) {
    console.warn(
      `[desktop] Failed to stamp Windows AppUserModel icon properties: ${formatErrorMessage(error)}`,
    );
  }
}

function queueWindowsShellAppUserModelStamp(
  input: Parameters<typeof applyWindowsShellAppUserModel>[0],
  options?: {
    flush?: boolean;
    immediate?: boolean;
  },
): Promise<void> {
  cancelDeferredWindowsShellStamp();
  if (options?.immediate === true) {
    stampWindowsShellAppUserModel(input, options);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    windowsShellStampResolve = resolve;
    windowsShellStampTimer = setImmediate(() => {
      windowsShellStampTimer = null;
      windowsShellStampResolve = null;
      stampWindowsShellAppUserModel(input, options);
      resolve();
    });
  });
}

async function applyDesktopAppIcon(
  icon: DesktopAppIcon,
  window: BrowserWindow | null = mainWindow,
  options?: { reregisterTaskbarButton?: boolean; flushShellIconCache?: boolean },
): Promise<void> {
  return enqueueDesktopAppIconJob(() => applyDesktopAppIconUnlocked(icon, window, options));
}

function applyPersistedDesktopAppIcon(
  window: BrowserWindow | null = mainWindow,
  options?: { reregisterTaskbarButton?: boolean; flushShellIconCache?: boolean },
): Promise<void> {
  return enqueueDesktopAppIconJob(() =>
    applyDesktopAppIconUnlocked(readDesktopAppIcon(), window, options),
  );
}

function enqueueDesktopAppIconJob(job: () => Promise<void>): Promise<void> {
  const run = desktopAppIconApplyTail.then(job, job);
  desktopAppIconApplyTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function applyDesktopAppIconUnlocked(
  icon: DesktopAppIcon,
  window: BrowserWindow | null = mainWindow,
  options?: { reregisterTaskbarButton?: boolean; flushShellIconCache?: boolean },
): Promise<void> {
  if (
    process.platform !== "darwin" &&
    process.platform !== "linux" &&
    process.platform !== "win32"
  ) {
    return;
  }
  if (
    usesMacBundleAppIcon({
      icon,
      platform: process.platform,
      usesLegacyDockIcon: usesLegacyMacDockIcon(),
      isBetaFlavor: desktopFlavor === "beta",
    })
  ) {
    // Remove the persistent override before asking AppKit to reload the bundle
    // icon, otherwise it can read the previous custom artwork again.
    await syncMacAppBundleIcon(null);
    app.dock?.setIcon(null as unknown as Electron.NativeImage);
    return;
  }

  const resourceName = desktopAppIconResourceName({
    icon,
    platform: process.platform,
    isDarkAppearance: process.platform === "darwin" && nativeTheme.shouldUseDarkColors,
    isBetaFlavor: desktopFlavor === "beta",
  });
  const iconPath = resolveResourcePath(resourceName);
  if (!iconPath) return;

  const image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return;

  if (process.platform === "darwin") {
    app.dock?.setIcon(image);
    await syncMacAppBundleIcon(image);
    return;
  }
  if (process.platform === "win32") {
    let shellIconPath = iconPath;
    try {
      shellIconPath = materializeWindowsShellIcon(icon, iconPath);
    } catch (error) {
      console.warn(
        `[desktop] Failed to materialize Windows taskbar icon: ${formatErrorMessage(error)}`,
      );
    }
    let matchedShortcuts: string[] = [];
    try {
      matchedShortcuts = syncWindowsTaskbarShortcuts(shellIconPath);
    } catch (error) {
      console.warn(`[desktop] Failed to sync Windows shortcut icons: ${formatErrorMessage(error)}`);
    }
    let hwnd: bigint | null = null;
    try {
      const handle = window?.getNativeWindowHandle();
      if (handle) hwnd = nativeWindowHandleToHwnd(handle);
    } catch {
      hwnd = null;
    }
    // Never block window creation/show on Explorer COM. The helper used to
    // wait on a synchronous window icon message while Electron waited in
    // spawnSync — deadlock, no window. Stamp properties on the next turn.
    try {
      applyWindowsTaskbarIcon({
        window,
        iconPath: shellIconPath,
        identity: {
          appId: APP_USER_MODEL_ID,
          relaunchCommand: `"${process.execPath}"`,
          relaunchDisplayName: APP_DISPLAY_NAME,
        },
        reregisterTaskbarButton: false,
      });
    } catch (error) {
      console.warn(`[desktop] Failed to apply Windows taskbar icon: ${formatErrorMessage(error)}`);
      try {
        window?.setIcon(shellIconPath);
      } catch (iconError) {
        console.warn(
          `[desktop] Failed to set Windows window icon: ${formatErrorMessage(iconError)}`,
        );
      }
    }
    // User-initiated changes stamp immediately so Explorer can finish before
    // the next click. Startup still defers so window creation is not blocked.
    await queueWindowsShellAppUserModelStamp(
      {
        appId: APP_USER_MODEL_ID,
        iconPath: shellIconPath,
        relaunchCommand: `"${process.execPath}"`,
        displayName: APP_DISPLAY_NAME,
        shortcutPaths: matchedShortcuts,
        hwnd,
      },
      {
        flush: options?.flushShellIconCache === true,
        immediate: options?.flushShellIconCache === true,
      },
    );
    return;
  }
  window?.setIcon(image);
}

function updateDesktopAppIcon(icon: DesktopAppIcon): void {
  if (!shouldUpdateDesktopAppIcon(readDesktopAppIcon(), icon)) return;
  persistDesktopAppIcon(icon);
  void applyDesktopAppIcon(icon).catch((error) =>
    safeConsoleError("[desktop] Failed to apply the app icon", error),
  );
}

function applyInitialMacDockIcon(): void {
  if (process.platform !== "darwin" || !app.dock) {
    return;
  }
  void applyPersistedDesktopAppIcon().catch((error) => {
    safeConsoleError("[desktop] Failed to persist the macOS app icon", error);
  });
}

function registerMacAppearanceIconSync(): void {
  if (process.platform !== "darwin") {
    return;
  }
  // macOS does not swap a runtime dock image when the system appearance
  // changes, so re-apply the persisted preference. On macOS 26, Stable's
  // Default and Beta's Beta choices use the bundle icon, which adapts on its own.
  nativeTheme.on("updated", () => {
    void applyPersistedDesktopAppIcon().catch((error) => {
      safeConsoleError("[desktop] Failed to persist the macOS app icon", error);
    });
  });
}

function readLaunchVersionRecordContents(): string | null {
  try {
    return FS.readFileSync(resolveLaunchVersionRecordPath(app.getPath("userData")), "utf8");
  } catch {
    // No prior record (fresh profile) or an unreadable file.
    return null;
  }
}

function persistLastLaunchVersion(version: string): void {
  const recordPath = resolveLaunchVersionRecordPath(app.getPath("userData"));
  try {
    // The userData directory is not guaranteed to exist this early on a clean
    // first launch, so ensure it before writing or the record silently fails to
    // persist and the refresh re-runs on every launch.
    FS.mkdirSync(Path.dirname(recordPath), { recursive: true });
    FS.writeFileSync(recordPath, serializeLaunchVersionRecord(version));
  } catch (error) {
    console.warn("[desktop] Failed to persist last launch version", error);
  }
}

// macOS keeps an aggressive Launch Services / IconServices cache keyed by bundle
// path + identifier. electron-updater swaps the bundle in place, so after an
// update the refreshed icon.icns is already on disk while the dock and Finder
// keep painting the previous icon — most visibly on Tahoe. When the version
// changes across launches, force Launch Services to re-read the bundle so the
// new icon shows on every surface. Best-effort: never blocks startup.
function refreshMacIconCacheOnVersionChange(): void {
  if (process.platform !== "darwin" || !app.isPackaged) {
    return;
  }

  const currentVersion = app.getVersion();
  const previousVersion = parseLastLaunchVersion(readLaunchVersionRecordContents());
  if (!shouldRefreshIconCache(previousVersion, currentVersion)) {
    return;
  }

  // Record the new version before refreshing so a failed re-registration is not
  // retried on every launch; the icon then heals on the next version bump
  // instead of spawning lsregister each time.
  persistLastLaunchVersion(currentVersion);

  const bundlePath = resolveMacAppBundlePath(process.execPath, process.platform);
  if (!bundlePath || !FS.existsSync(LSREGISTER_PATH)) {
    return;
  }

  // Bump the bundle mtime so Launch Services notices the swap, then re-register
  // it. The codesign signature covers Contents, not the bundle directory mtime,
  // so this is signature-safe; the bundle may be read-only for this user, in
  // which case the re-registration below still nudges the cache.
  try {
    const now = new Date();
    FS.utimesSync(bundlePath, now, now);
  } catch {
    // Read-only bundle: fall through to lsregister.
  }

  const child = ChildProcess.spawn(LSREGISTER_PATH, ["-f", bundlePath], { stdio: "ignore" });
  child.unref();
  child.once("error", (error) => {
    console.warn("[desktop] Failed to refresh macOS icon cache after update", error);
  });
  child.once("exit", (code) => {
    console.info(
      `[desktop] Refreshed macOS icon registration after update ${previousVersion ?? "(none)"} -> ${currentVersion} (lsregister exit ${code ?? "unknown"}).`,
    );
  });
}

// How often the bundle-swap watcher stats app.asar. A stat is cheap; the cost of
// missing a swap is every subsequent asar read returning bytes from the wrong
// file (invisible icons, corrupted lazy-loaded route chunks), so poll briskly.
const BUNDLE_SWAP_POLL_INTERVAL_MS = 15_000;

let bundleSwapPollTimer: NodeJS.Timeout | null = null;
let bundleSwapPromptOpen = false;

function readBundleSignature(bundlePath: string): BundleSignature | null {
  try {
    return bundleSignatureFromStats(OriginalFS.statSync(bundlePath));
  } catch {
    return null;
  }
}

function captureStartupBundleIdentity(): BundleIdentity | null {
  if (!app.isPackaged) {
    return null;
  }
  const bundlePath = app.getAppPath();
  if (!isWatchableBundlePath(bundlePath)) {
    return null;
  }
  return { path: bundlePath, signature: readBundleSignature(bundlePath) };
}

function restartAfterStartupBundleSwap(error: BundleChangedDuringStartupError): void {
  const baselineSize = error.baseline?.size ?? "unreadable";
  const currentSize = error.current?.size ?? "unreadable";
  writeDesktopLogHeader(
    `bundle changed during startup path=${error.bundlePath} size=${baselineSize}->${currentSize}`,
  );
  console.warn("[desktop] Packaged application changed during startup; restarting", error);

  void dialog
    .showMessageBox({
      type: "warning",
      title: nativeText("Moss needs to restart", "Moss 需要重新启动"),
      message: nativeText("Moss changed while it was opening.", "Moss 在启动过程中发生了变化。"),
      detail: nativeText(
        "The current process cannot safely read the replaced application bundle. Restart Moss to finish opening with one consistent version.",
        "当前进程无法安全读取已替换的应用包。请重新启动 Moss，以同一版本完成启动。",
      ),
      buttons: [nativeText("Restart Moss", "重新启动 Moss")],
      defaultId: 0,
    })
    .catch(() => undefined)
    .then(() => {
      app.relaunch();
      requestGracefulAppQuit("startup-bundle-swap");
    });
}

// Electron caches the asar header per process, so once app.asar changes on disk
// (updater retry racing a relaunch, a reinstall, a build copied over the bundle)
// every archive read in this process — the moss:// protocol, the backend's static
// files, lazily-loaded renderer chunks — resolves to stale offsets and silently
// returns the wrong bytes. Detect the swap and offer a restart; continuing is
// never safe.
function startBundleSwapWatcher(): void {
  if (!app.isPackaged || bundleSwapPollTimer) {
    return;
  }
  const bundlePath = app.getAppPath();
  if (!isWatchableBundlePath(bundlePath)) {
    return;
  }
  let baseline =
    startupBundleIdentity && Path.resolve(startupBundleIdentity.path) === Path.resolve(bundlePath)
      ? (startupBundleIdentity.signature ?? readBundleSignature(bundlePath))
      : readBundleSignature(bundlePath);
  if (!baseline) {
    return;
  }

  bundleSwapPollTimer = setInterval(() => {
    // The updater owns the quit/relaunch during its own install handoff, and a
    // quitting app is about to re-read the new archive anyway.
    if (isQuitting || isUpdaterInstallPreparing || bundleSwapPromptOpen) {
      return;
    }
    const current = readBundleSignature(bundlePath);
    if (!baseline || !isBundleSwapped(baseline, current)) {
      return;
    }
    writeDesktopLogHeader(
      `bundle swap detected path=${bundlePath} size=${baseline.size}->${current?.size ?? "unknown"}`,
    );
    // Re-arm on the new identity so declining the restart still catches the
    // next replacement instead of re-prompting for the same one.
    baseline = current;
    bundleSwapPromptOpen = true;
    void dialog
      .showMessageBox({
        type: "warning",
        title: nativeText("Moss was replaced on disk", "磁盘上的 Moss 已被替换"),
        message: nativeText(
          "The installed Moss app changed while it was running.",
          "已安装的 Moss 应用在运行期间发生了变化。",
        ),
        detail: nativeText(
          "The interface keeps running from a safeguarded copy, but parts of the app loaded later can still read the replaced file. Restart now to pick up the new version safely.",
          "界面会继续从受保护的副本运行，但稍后加载的部分仍可能读取已替换的文件。请立即重启，以安全使用新版本。",
        ),
        buttons: [nativeText("Restart Now", "立即重启"), nativeText("Later", "稍后")],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        bundleSwapPromptOpen = false;
        if (response === 0) {
          app.relaunch();
          requestGracefulAppQuit("bundle-swap-restart");
        }
      })
      .catch(() => {
        bundleSwapPromptOpen = false;
      });
  }, BUNDLE_SWAP_POLL_INTERVAL_MS);
  bundleSwapPollTimer.unref();
}

function clearUpdatePollTimer(): void {
  if (updateStartupTimer) {
    clearTimeout(updateStartupTimer);
    updateStartupTimer = null;
  }
  if (updatePollTimer) {
    clearInterval(updatePollTimer);
    updatePollTimer = null;
  }
}

// Starts the periodic background update check. Used by configureAutoUpdater and
// by the install watchdog recovery so polling resumes after a silent install
// failure instead of staying off until the next app restart.
function scheduleUpdatePoll(): void {
  if (updatePollTimer || automaticUpdateActivitySuppressed) {
    return;
  }
  updatePollTimer = setInterval(() => {
    void checkForUpdates("poll");
  }, AUTO_UPDATE_POLL_INTERVAL_MS);
  updatePollTimer.unref();
}

function isExplicitUpdateCheckReason(reason: string): boolean {
  return (
    reason === "menu" || reason === "renderer" || reason === UPDATE_CHECK_REASON_MIGRATION_RECOVERY
  );
}

function emitUpdateState(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || isRealtimeVoiceOverlayWindow(window)) continue;
    window.webContents.send(IPC.updateState, updateState);
  }
}

function setUpdateState(patch: Partial<DesktopUpdateState>): void {
  const previous = updateState;
  updateState = { ...updateState, ...patch };
  emitUpdateState();
  betaDiagnostics?.trackUpdateStateChange(previous, updateState);
}

function shouldEnableAutoUpdates(): boolean {
  return resolveAutoUpdateDisabledReason() === null;
}

function isAcceptableUpdateVersion(version: string | null | undefined): boolean {
  return (
    typeof version === "string" &&
    isUpdateVersionAllowedForFlavor(version, desktopFlavor) &&
    isUpdateVersionNewer(app.getVersion(), version)
  );
}

function describeRejectedUpdateVersion(version: string): string {
  if (!isUpdateVersionAllowedForFlavor(version, desktopFlavor)) {
    return `version ${version} is not on the "${desktopFlavor}" flavor's update lane`;
  }
  return `version ${version} is not newer than current ${app.getVersion()}`;
}

function getUpdaterCachePathArgs(): {
  cacheDirName: string | null;
  platform: NodeJS.Platform;
  homeDir: string;
  localAppData: string | null;
  xdgCacheHome: string | null;
} {
  return {
    cacheDirName: configuredUpdaterCacheDirName,
    platform: process.platform,
    homeDir: OS.homedir(),
    localAppData: process.env.LOCALAPPDATA ?? null,
    xdgCacheHome: process.env.XDG_CACHE_HOME ?? null,
  };
}

function getPendingUpdateCacheDir(): string | null {
  return resolveElectronUpdaterPendingCacheDir(getUpdaterCachePathArgs());
}

function clearLegacyUpdaterZipAfterVerifiedInstall(): void {
  const legacyZipPath = resolveElectronUpdaterLegacyZipPath(getUpdaterCachePathArgs());
  if (!legacyZipPath) {
    return;
  }
  try {
    FS.rmSync(legacyZipPath, { force: true });
    console.info("[desktop-updater] Cleared legacy top-level update.zip after verified install.");
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to clear legacy top-level update.zip: ${formatErrorMessage(error)}`,
    );
  }
}

function quarantineInstallMarker(reason: string): void {
  console.warn(`[desktop-updater] Discarding update install marker (${reason}).`);
  try {
    clearInstallMarker(getUpdateInstallMarkerPath());
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to delete quarantined update install marker: ${formatErrorMessage(error)}`,
    );
  }
}

function processInstallMarkerOnStartup(): void {
  const filePath = getUpdateInstallMarkerPath();
  const readResult = readInstallMarker(filePath);
  if (readResult.status === "missing") {
    return;
  }
  if (readResult.status === "invalid") {
    quarantineInstallMarker(`invalid or unreadable: ${readResult.error}`);
    return;
  }

  const marker = readResult.marker;
  const nowIso = new Date().toISOString();
  const outcome = resolveInstallMarkerOutcome(marker, app.getVersion(), nowIso);
  if (outcome === "success") {
    console.info(
      `[desktop-updater] Update to ${marker.toVersion} installed successfully (from ${marker.fromVersion})`,
    );
    try {
      clearInstallMarker(filePath);
    } catch (error) {
      console.warn(
        `[desktop-updater] Failed to clear successful update install marker: ${formatErrorMessage(error)}`,
      );
    }
    clearLegacyUpdaterZipAfterVerifiedInstall();
    return;
  }
  if (outcome === "stale" || outcome === "invalid") {
    quarantineInstallMarker(outcome);
    return;
  }

  let consecutiveFailures = marker.consecutiveFailures;
  if (outcome === "failure") {
    consecutiveFailures += 1;
    const failedMarker: UpdateInstallMarker = {
      ...marker,
      phase: "failed",
      consecutiveFailures,
      lastFailureAt: nowIso,
    };
    try {
      writeInstallMarker(filePath, failedMarker);
    } catch (error) {
      console.error(
        `[desktop-updater] Failed to persist restart install failure: ${formatErrorMessage(error)}`,
      );
    }
  }

  automaticUpdateActivitySuppressed = true;
  const message = `Moss restarted, but update ${marker.toVersion} was not installed. Try again.`;
  setUpdateState(
    reduceDesktopUpdateStateOnInstallRestartFailure(
      updateState,
      marker.toVersion,
      consecutiveFailures,
      message,
    ),
  );
  console.error(
    `[desktop-updater] UPDATE INSTALL FAILED: still running ${app.getVersion()} after attempting ${marker.toVersion}; consecutive failures=${consecutiveFailures}. Automatic update checks are suppressed until the user retries.`,
  );
  void logMacUpdateDiagnostics("startup install verification failure");
}

// electron-updater can leave a same-version ZIP in `pending` after a restart or
// a failed install attempt. Clearing it prevents stale "ready" states.
async function clearPendingUpdateCache(reason: string): Promise<void> {
  const pendingDir = getPendingUpdateCacheDir();
  if (!pendingDir || updateDownloadInFlight) {
    return;
  }
  try {
    await FS.promises.rm(pendingDir, { recursive: true, force: true });
    console.info(`[desktop-updater] Cleared pending update cache (${reason}).`);
  } catch (error) {
    console.warn(
      `[desktop-updater] Failed to clear pending update cache (${reason}): ${formatErrorMessage(error)}`,
    );
  }
}

// Terminal updater events can arrive before downloadUpdate() settles; defer cache deletion
// until the updater has released its in-flight download bookkeeping.
function clearPendingUpdateCacheWhenSafe(reason: string): void {
  pendingUpdateCacheClearQueue.request(reason, updateDownloadInFlight, (safeReason) => {
    void clearPendingUpdateCache(safeReason);
  });
}

function clearUpdateBackgroundBlurTimer(): void {
  if (updateBackgroundBlurTimer) {
    clearTimeout(updateBackgroundBlurTimer);
    updateBackgroundBlurTimer = null;
  }
}

// Fail closed if electron-updater never emits a terminal check outcome.
function clearUpdateCheckTimeoutTimer(): void {
  if (updateCheckTimeoutTimer) {
    clearTimeout(updateCheckTimeoutTimer);
    updateCheckTimeoutTimer = null;
  }
}

function armUpdateCheckTimeout(reason: string): void {
  clearUpdateCheckTimeoutTimer();
  updateCheckTimeoutTimer = setTimeout(() => {
    updateCheckTimeoutTimer = null;
    if (updateState.status !== "checking") {
      return;
    }
    updateCheckInFlight = false;
    // electron-updater may never settle its own promise, so this is also where
    // anyone awaiting the check has to be released.
    settleActiveUpdateCheck?.();
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(
        updateState,
        "Timed out while checking for updates. Try again.",
        new Date().toISOString(),
      ),
    );
    console.error(`[desktop-updater] Update check timed out (${reason}).`);
  }, AUTO_UPDATE_CHECK_TIMEOUT_MS);
  updateCheckTimeoutTimer.unref();
}

function clearUpdateDownloadStallTimer(): void {
  if (updateDownloadStallTimer) {
    clearTimeout(updateDownloadStallTimer);
    updateDownloadStallTimer = null;
  }
}

function clearStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining = 0;
  stalledDownloadCancellationSuppressionExpiresAtMs = 0;
}

function armStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining += 1;
  stalledDownloadCancellationSuppressionExpiresAtMs =
    Date.now() + AUTO_UPDATE_STALLED_DOWNLOAD_CANCELLATION_SUPPRESSION_MS;
}

function isStalledDownloadCancellationSuppressionArmed(): boolean {
  if (stalledDownloadCancellationSuppressionsRemaining <= 0) {
    return false;
  }
  if (Date.now() <= stalledDownloadCancellationSuppressionExpiresAtMs) {
    return true;
  }
  clearStalledDownloadCancellationSuppression();
  return false;
}

function consumeStalledDownloadCancellationSuppression(): void {
  stalledDownloadCancellationSuppressionsRemaining = Math.max(
    0,
    stalledDownloadCancellationSuppressionsRemaining - 1,
  );
  if (stalledDownloadCancellationSuppressionsRemaining === 0) {
    stalledDownloadCancellationSuppressionExpiresAtMs = 0;
  }
}

// Bounds a silent updater download while allowing slow downloads that keep making progress.
function armUpdateDownloadStallTimer(reason: string): void {
  clearUpdateDownloadStallTimer();
  updateDownloadStallTimer = setTimeout(() => {
    updateDownloadStallTimer = null;
    if (!updateDownloadInFlight || updateState.status !== "downloading") {
      return;
    }

    const error = new Error(getDownloadStallTimeoutMessage(AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS));
    console.error(`[desktop-updater] ${error.message} (${reason}).`);
    armStalledDownloadCancellationSuppression();
    rejectUpdateDownloadStall?.(error);
    updateDownloadCancellationToken?.cancel();
  }, AUTO_UPDATE_DOWNLOAD_STALL_TIMEOUT_MS);
  updateDownloadStallTimer.unref();
}

function updateDownloadStallTimerOnProgress(progress: DownloadProgressSample): void {
  if (!updateDownloadInFlight) {
    return;
  }
  if (!hasDownloadProgressAdvanced(lastUpdateDownloadProgressSample, progress)) {
    return;
  }
  lastUpdateDownloadProgressSample = {
    percent: progress.percent ?? null,
    transferred: progress.transferred ?? null,
  };
  armUpdateDownloadStallTimer(`download progress ${Math.floor(progress.percent ?? 0)}%`);
}

function isDesktopAppForegrounded(): boolean {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

function markDesktopAppBackgrounded(): void {
  clearUpdateBackgroundBlurTimer();
  updateBackgroundBlurTimer = setTimeout(() => {
    updateBackgroundBlurTimer = null;
    if (isDesktopAppForegrounded()) {
      return;
    }
    updateBackgroundedAtMs = Date.now();
  }, 0);
}

function handleDesktopAppForegrounded(): void {
  clearUpdateBackgroundBlurTimer();
  clearUnreadNotificationBadge();
  const foregroundedAtMs = Date.now();
  const backgroundedAtMs = updateBackgroundedAtMs;
  updateBackgroundedAtMs = null;
  const shouldCheck = shouldCheckForUpdatesOnForeground({
    checkedAt: updateState.checkedAt,
    backgroundedAtMs,
    foregroundedAtMs,
    minBackgroundDurationMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_BACKGROUND_MS,
    minIntervalMs: AUTO_UPDATE_FOREGROUND_RECHECK_MIN_INTERVAL_MS,
  });
  if (!shouldCheck) {
    return;
  }
  void checkForUpdates("foreground");
}

/**
 * Publishes the running check so a caller that needs its *outcome* — migration
 * recovery — can join it. `checkForUpdates` is a deliberate no-op while another
 * check holds the lock, and without this the caller would read the intermediate
 * "checking" state as a failed download.
 *
 * The returned finish is idempotent and only clears state it still owns, so the
 * check-timeout path can settle a stuck check without stranding a later one.
 */
function beginActiveUpdateCheck(): () => void {
  // Assigned by the executor, which runs before the constructor returns.
  let settle!: () => void;
  const check = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const finish = (): void => {
    settle();
    if (activeUpdateCheck === check) {
      activeUpdateCheck = null;
      settleActiveUpdateCheck = null;
    }
  };
  activeUpdateCheck = check;
  settleActiveUpdateCheck = finish;
  return finish;
}

async function checkForUpdates(reason: string): Promise<void> {
  if (isQuitting || isUpdaterInstallPreparing || !updaterConfigured || updateCheckInFlight) return;
  if (automaticUpdateActivitySuppressed) {
    if (!isExplicitUpdateCheckReason(reason)) {
      console.info(
        `[desktop-updater] Skipping automatic update check (${reason}) after an unverified install failure.`,
      );
      return;
    }
    automaticUpdateActivitySuppressed = false;
    console.info(
      `[desktop-updater] User requested update recovery (${reason}); automatic checks are enabled for this session.`,
    );
    scheduleUpdatePoll();
  }
  if (
    updateState.status === "checking" ||
    updateState.status === "downloading" ||
    updateState.status === "downloaded"
  ) {
    console.info(
      `[desktop-updater] Skipping update check (${reason}) while status=${updateState.status}.`,
    );
    return;
  }
  updateCheckInFlight = true;
  const finishCheck = beginActiveUpdateCheck();
  setUpdateState(reduceDesktopUpdateStateOnCheckStart(updateState, new Date().toISOString()));
  armUpdateCheckTimeout(reason);
  console.info(`[desktop-updater] Checking for updates (${reason})...`);

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    clearUpdateCheckTimeoutTimer();
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(
      reduceDesktopUpdateStateOnCheckFailure(updateState, message, new Date().toISOString()),
    );
    console.error(`[desktop-updater] Failed to check for updates: ${message}`);
  } finally {
    updateCheckInFlight = false;
    finishCheck();
  }
}

async function downloadAvailableUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (
    updaterConfigured &&
    updateState.status === "error" &&
    updateState.errorContext === "install" &&
    updateState.downloadedVersion === null &&
    updateState.availableVersion !== null
  ) {
    await checkForUpdates("renderer");
    return { accepted: true, completed: false };
  }
  if (!updaterConfigured || updateDownloadInFlight || updateState.status !== "available") {
    return { accepted: false, completed: false };
  }
  if (!isAcceptableUpdateVersion(updateState.availableVersion)) {
    const rejected =
      typeof updateState.availableVersion === "string"
        ? describeRejectedUpdateVersion(updateState.availableVersion)
        : "no acceptable update version recorded";
    await clearPendingUpdateCache(`staged update rejected: ${rejected}`);
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(`[desktop-updater] Ignoring stale available update: ${rejected}.`);
    return { accepted: false, completed: false };
  }
  updateDownloadInFlight = true;
  downloadedUpdateArtifact = null;
  downloadedUpdateIdentityTask = null;
  setUpdateState(reduceDesktopUpdateStateOnDownloadStart(updateState));
  // Keep existing cancellation suppressions across immediate retries; the old
  // updater cancellation can arrive after a new download has already started.
  lastUpdateDownloadProgressSample = null;
  const cancellationToken = new CancellationToken();
  updateDownloadCancellationToken = cancellationToken;
  const downloadStalled = new Promise<never>((_, reject) => {
    rejectUpdateDownloadStall = reject;
  });
  armUpdateDownloadStallTimer("download start");
  console.info("[desktop-updater] Downloading update...");

  // Track electron-updater's own download promise separately from the stall race.
  // When the stall timer wins the race it cancels this promise, but the updater
  // keeps its internal download promise set until that cancellation unwinds. We
  // observe its settlement here (so a late rejection can't surface as an unhandled
  // rejection) and wait on it before releasing the in-flight flag below.
  let updaterDownloadSettled = false;
  const updaterDownloadPromise = autoUpdater.downloadUpdate(cancellationToken);
  const updaterDownloadSettledPromise = updaterDownloadPromise.then(
    () => {
      updaterDownloadSettled = true;
    },
    () => {
      updaterDownloadSettled = true;
    },
  );

  try {
    await Promise.race([updaterDownloadPromise, downloadStalled]);
    const identityTask = downloadedUpdateIdentityTask;
    if (identityTask) {
      await identityTask;
    }
    return {
      accepted: true,
      completed: downloadedUpdateArtifact !== null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Failed to download update: ${message}`);
    return { accepted: true, completed: false };
  } finally {
    clearUpdateDownloadStallTimer();
    // Hold the in-flight flag until the updater download actually settles, so an
    // immediate retry can't grab the still-cancelling promise (which would reject
    // as "cancelled"). Bounded so a stuck updater promise can't wedge updates.
    if (!updaterDownloadSettled) {
      await Promise.race([
        updaterDownloadSettledPromise,
        new Promise<void>((resolve) => {
          setTimeout(resolve, AUTO_UPDATE_DOWNLOAD_SETTLE_TIMEOUT_MS).unref();
        }),
      ]);
    }
    if (updateDownloadCancellationToken === cancellationToken) {
      updateDownloadCancellationToken = null;
    }
    rejectUpdateDownloadStall = null;
    lastUpdateDownloadProgressSample = null;
    updateDownloadInFlight = false;
    const pendingCacheClearReason = pendingUpdateCacheClearQueue.consumeAfterDownload();
    if (pendingCacheClearReason) {
      await clearPendingUpdateCache(pendingCacheClearReason);
    }
  }
}

// Starts the automatic prepare step after a successful update check; install
// stays user-controlled so active agent work is not interrupted by a restart.
function prepareAvailableUpdateInBackground(reason: string): void {
  if (updateDownloadInFlight || updateState.status !== "available") {
    return;
  }
  const preparation = downloadAvailableUpdate()
    .then((result) => {
      if (result.accepted && result.completed) {
        console.info(`[desktop-updater] Background update download completed (${reason}).`);
      }
    })
    .catch((error) => {
      console.error(
        `[desktop-updater] Background update download crashed (${reason}): ${formatErrorMessage(error)}`,
      );
    })
    .finally(() => {
      if (activeUpdatePreparation === preparation) {
        activeUpdatePreparation = null;
      }
    });
  // Published so a caller that needs the download finished — migration
  // recovery — can await this one instead of racing a second download
  // against it.
  activeUpdatePreparation = preparation;
}

/**
 * Whether the recovery prompt can offer an in-place update.
 *
 * Deliberately permissive about the current status: the check has usually not
 * run yet at this point in startup, so "we do not know of an update" is not a
 * reason to hide the option. Only a completed check that found nothing newer
 * is, because then updating provably cannot repair anything.
 */
function canInstallUpdateFromRecovery(): boolean {
  return updaterConfigured && updateState.status !== "up-to-date";
}

/**
 * Drives check → download → install for an install whose database is wedged.
 *
 * This is the only recovery option that needs nothing from the user afterwards,
 * so it runs the whole updater sequence rather than stopping at "an update is
 * available". Resolves to a message to show in the next prompt when the update
 * could not be installed, or to null once the install handoff has started.
 */
async function installLatestUpdateForMigrationRecovery(): Promise<string | null> {
  if (!updaterConfigured) {
    return resolveAutoUpdateDisabledReason() ?? "Automatic updates are not available.";
  }

  if (updateState.status !== "downloaded") {
    // The automatic startup check is armed before this prompt appears, so one
    // may already be running. Joining it is what gets a real answer: starting a
    // second check here would return without doing anything and leave the
    // status at "checking", which reads as a download failure below.
    const inFlightCheck = activeUpdateCheck;
    if (inFlightCheck === null) {
      await checkForUpdates(UPDATE_CHECK_REASON_MIGRATION_RECOVERY);
    } else {
      await inFlightCheck;
    }
    // A successful check starts the download itself; await that one rather
    // than starting a competing transfer.
    const preparation = activeUpdatePreparation;
    if (preparation !== null) {
      await preparation;
    } else if (updateState.status === "available") {
      await downloadAvailableUpdate();
    }
  }

  if (updateState.status === "up-to-date") {
    return `Moss ${app.getVersion()} is already the newest release, so updating cannot repair this database.`;
  }
  if (updateState.status !== "downloaded") {
    return updateState.message ?? "The update could not be downloaded.";
  }

  await installDownloadedUpdate();
  // quitAndInstall never resolves — the process exits under it. A handoff that
  // silently fails is cleared by the install watchdog instead, and waiting for
  // that verdict is what keeps a failed install from leaving a live app with
  // no window and no way back to this prompt.
  await waitForMigrationRecoveryInstallHandoff();
  if (isUpdaterQuitAndInstallInFlight) {
    return null;
  }
  return updateState.message ?? "The downloaded update could not be installed.";
}

/**
 * Waits out the install watchdog window, which is the earliest a failed handoff
 * can be known: nothing else clears `isUpdaterQuitAndInstallInFlight`, so there
 * is nothing to poll for. A successful handoff exits the process well before
 * this resolves.
 */
async function waitForMigrationRecoveryInstallHandoff(): Promise<void> {
  if (!isUpdaterQuitAndInstallInFlight) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, AUTO_UPDATE_INSTALL_WATCHDOG_MS + 2_000).unref();
  });
}

async function runDownloadedUpdateInstall(
  preparationAttempt: UpdateInstallPreparationAttempt,
): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  const versionToInstall = updateState.downloadedVersion ?? updateState.availableVersion;
  if (!versionToInstall || !isAcceptableUpdateVersion(versionToInstall)) {
    const rejected = versionToInstall
      ? describeRejectedUpdateVersion(versionToInstall)
      : "no update version recorded";
    await clearPendingUpdateCache(`downloaded update rejected: ${rejected}`);
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(`[desktop-updater] Ignoring stale downloaded update: ${rejected}.`);
    return { accepted: false, completed: false };
  }

  const artifact =
    downloadedUpdateArtifact?.version === versionToInstall
      ? downloadedUpdateArtifact.identity
      : null;
  if (!artifact || !(await verifyUpdateArtifactIdentity(artifact))) {
    downloadedUpdateArtifact = null;
    await clearPendingUpdateCache("downloaded artifact identity is missing or changed");
    const message = "The downloaded update could not be reverified. Download it again.";
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] Refusing install handoff: ${message}`);
    return { accepted: false, completed: false };
  }
  updateInstallPreparation.requireActive(preparationAttempt);

  const markerPath = getUpdateInstallMarkerPath();
  const existingMarkerResult = readInstallMarker(markerPath);
  const existingMarker =
    existingMarkerResult.status === "valid" &&
    existingMarkerResult.marker.toVersion === versionToInstall
      ? existingMarkerResult.marker
      : null;
  const marker = createUpdateInstallMarker({
    fromVersion: app.getVersion(),
    toVersion: versionToInstall,
    requestedAt: new Date().toISOString(),
    consecutiveFailures: existingMarker?.consecutiveFailures ?? 0,
    lastFailureAt: existingMarker?.lastFailureAt ?? null,
    artifact,
  });
  const handoffExpectation: UpdateInstallHandoffExpectation = {
    attemptId: marker.attemptId,
    artifact,
  };
  let markerWritten = false;
  let artifactInvalidated = false;
  try {
    isQuitting = true;
    clearUpdatePollTimer();
    await stopBackendAndWaitForExit();
    updateInstallPreparation.requireActive(preparationAttempt);
    await logMacUpdateDiagnostics("before install handoff");
    updateInstallPreparation.requireActive(preparationAttempt);
    if (!(await verifyUpdateArtifactIdentity(artifact))) {
      artifactInvalidated = true;
      downloadedUpdateArtifact = null;
      await clearPendingUpdateCache("downloaded artifact changed during install preparation");
      throw new Error(
        "The downloaded update changed during install preparation. Download it again.",
      );
    }
    updateInstallPreparation.requireActive(preparationAttempt);
    writeInstallMarker(markerPath, marker);
    markerWritten = true;
    if (!markInstallHandoffSync(markerPath, handoffExpectation)) {
      throw new Error("Durable update install marker changed before install handoff.");
    }
    activeUpdateInstallHandoff = handoffExpectation;
    isUpdaterQuitAndInstallInFlight = true;
    autoUpdater.quitAndInstall();
    updateInstallPreparation.requireActive(preparationAttempt);
    armInstallWatchdog();
    return { accepted: true, completed: false };
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    clearUpdaterInstallInFlightAfterError();
    const consecutiveFailures = markerWritten
      ? recordInstallMarkerFailure(new Date().toISOString(), handoffExpectation)
      : updateState.installFailureCount;
    setUpdateState({
      ...(artifactInvalidated
        ? reduceDesktopUpdateStateOnDownloadFailure(updateState, message)
        : reduceDesktopUpdateStateOnInstallFailure(updateState, message)),
      installFailureCount: consecutiveFailures,
    });
    console.error(`[desktop-updater] Failed to install update: ${message}`);
    recoverDesktopAfterUpdaterInstallFailure();
    return { accepted: true, completed: false };
  }
}

async function installDownloadedUpdate(): Promise<{
  accepted: boolean;
  completed: boolean;
}> {
  if (isQuitting || !updaterConfigured || updateState.status !== "downloaded") {
    return { accepted: false, completed: false };
  }
  const preparationAttempt = updateInstallPreparation.begin();
  if (preparationAttempt === null) {
    return { accepted: false, completed: false };
  }
  isUpdaterInstallPreparing = true;
  try {
    // A retry must not retain the last failure while the new handoff is pending.
    setUpdateState(reduceDesktopUpdateStateOnInstallStart(updateState));
    return await runDownloadedUpdateInstall(preparationAttempt);
  } finally {
    if (!isUpdaterQuitAndInstallInFlight && isUpdaterInstallPreparing) {
      clearUpdaterInstallInFlightAfterError();
      // Validation can reject a stale or changed artifact before the backend is
      // stopped and before the main install try/catch starts. A quit deferred
      // during that asynchronous validation still has to be replayed.
      replayDeferredDesktopQuitAfterUpdaterSettles();
    }
    updateInstallPreparation.release(preparationAttempt);
  }
}

async function recordDownloadedUpdateIdentity(info: UpdateDownloadedEvent): Promise<void> {
  clearUpdateDownloadStallTimer();
  if (!isAcceptableUpdateVersion(info.version)) {
    downloadedUpdateArtifact = null;
    clearPendingUpdateCacheWhenSafe(
      `downloaded update rejected: ${describeRejectedUpdateVersion(info.version)}`,
    );
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    console.info(
      `[desktop-updater] Ignoring downloaded update: ${describeRejectedUpdateVersion(info.version)}.`,
    );
    return;
  }

  try {
    const identity = await fingerprintUpdateArtifact(info.downloadedFile);
    if (!isAcceptableUpdateVersion(info.version)) {
      downloadedUpdateArtifact = null;
      clearPendingUpdateCacheWhenSafe(
        `downloaded update rejected after fingerprinting: ${describeRejectedUpdateVersion(info.version)}`,
      );
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      return;
    }
    downloadedUpdateArtifact = { version: info.version, identity };
    setUpdateState(reduceDesktopUpdateStateOnDownloadComplete(updateState, info.version));
    console.info(
      `[desktop-updater] Update downloaded and fingerprinted: ${info.version} (${identity.size} bytes, sha512=${identity.sha512.slice(0, 16)}…).`,
    );
  } catch (error) {
    downloadedUpdateArtifact = null;
    clearPendingUpdateCacheWhenSafe("downloaded artifact fingerprint failed");
    const message = `The downloaded update could not be verified: ${formatErrorMessage(error)}`;
    setUpdateState(reduceDesktopUpdateStateOnDownloadFailure(updateState, message));
    console.error(`[desktop-updater] ${message}`);
  }
}

function configureAutoUpdater(): void {
  const appUpdateYml = readAppUpdateYml();
  configuredUpdaterCacheDirName = resolveElectronUpdaterCacheDirName(appUpdateYml, app.getName());
  const githubUpdateSource = resolveGitHubUpdateSource(appUpdateYml);
  const releaseUrl =
    githubUpdateSource === null ? null : buildGitHubReleasesPageUrl(githubUpdateSource);
  const enabled = shouldEnableAutoUpdates();
  setUpdateState({
    ...createInitialDesktopUpdateState(
      app.getVersion(),
      desktopRuntimeInfo,
      desktopFlavor === "development" ? "production" : desktopFlavor,
    ),
    enabled,
    status: enabled ? "idle" : "disabled",
    releaseUrl,
  });
  processInstallMarkerOnStartup();
  if (!enabled) {
    configuredUpdaterCacheDirName = null;
    return;
  }
  updaterConfigured = true;
  hardenElectronUpdater(
    { BaseUpdater },
    autoUpdater,
    process.platform,
    app.isPackaged ? resolveEmbeddedWindowsPublisherSubjects() : null,
  );

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // The dedicated channel keeps the permanent compatibility release on the
  // default feed while Moss versions advance independently.
  autoUpdater.channel = desktopUpdateChannel(desktopFlavor);
  autoUpdater.allowPrerelease = DESKTOP_UPDATE_ALLOW_PRERELEASE;
  autoUpdater.allowDowngrade = false;
  // Match electron-updater's native GitHub provider path; the packaged
  // app-update.yml owns the production feed, and generic feeds stay mock-only.
  // macOS release builds repack and validate the Squirrel update zip, then omit
  // the stale zip blockmap so ShipIt always installs the exact signed payload.
  autoUpdater.disableDifferentialDownload =
    process.platform === "darwin" || isArm64HostRunningIntelBuild(desktopRuntimeInfo);
  // electron-updater has no working idle timeout on macOS (its socket timeout is
  // wired to a `socket` event Electron's net.request never emits) and never
  // resumes from a byte offset, so a stalled CDN transfer hangs for minutes
  // until TCP recovers on its own. installResumableUpdateDownloader replaces the
  // download transfer with a stall-aware, resumable one and installs a real idle
  // timeout, so an intermittent stall becomes a brief reconnect-and-resume
  // instead of a multi-minute freeze. Independent of the zip-validation fix.
  if (!installResumableUpdateDownloader(autoUpdater as unknown as ResumableDownloaderTarget)) {
    console.warn(
      "[desktop-updater] Could not install resumable update downloader; falling back to default transfer.",
    );
  }
  let lastLoggedDownloadMilestone = -1;

  if (isArm64HostRunningIntelBuild(desktopRuntimeInfo)) {
    console.info(
      "[desktop-updater] Apple Silicon host detected while running Intel build; updates will switch to arm64 packages.",
    );
  }

  autoUpdater.on("checking-for-update", () => {
    console.info("[desktop-updater] Looking for updates...");
  });
  autoUpdater.on("update-available", (info) => {
    clearUpdateCheckTimeoutTimer();
    downloadedUpdateArtifact = null;
    if (!isAcceptableUpdateVersion(info.version)) {
      void clearPendingUpdateCache(
        `available update rejected: ${describeRejectedUpdateVersion(info.version)}`,
      );
      setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
      lastLoggedDownloadMilestone = -1;
      console.info(
        `[desktop-updater] Ignoring available update: ${describeRejectedUpdateVersion(info.version)}.`,
      );
      return;
    }
    setUpdateState(
      reduceDesktopUpdateStateOnUpdateAvailable(
        updateState,
        info.version,
        new Date().toISOString(),
      ),
    );
    lastLoggedDownloadMilestone = -1;
    console.info(`[desktop-updater] Update available: ${info.version}`);
    prepareAvailableUpdateInBackground(`available ${info.version}`);
  });
  autoUpdater.on("update-not-available", () => {
    clearUpdateCheckTimeoutTimer();
    downloadedUpdateArtifact = null;
    void clearPendingUpdateCache("no newer update available");
    setUpdateState(reduceDesktopUpdateStateOnNoUpdate(updateState, new Date().toISOString()));
    lastLoggedDownloadMilestone = -1;
    console.info("[desktop-updater] No updates available.");
  });
  autoUpdater.on("error", (error) => {
    clearUpdateCheckTimeoutTimer();
    const message = formatErrorMessage(error);
    const errorContext = resolveUpdaterErrorContext();
    if (
      isExpectedStalledDownloadCancellationError({
        suppressionArmed: isStalledDownloadCancellationSuppressionArmed(),
        errorContext,
        message,
      })
    ) {
      consumeStalledDownloadCancellationSuppression();
      console.warn("[desktop-updater] Ignored expected cancellation after stalled download.");
      return;
    }
    const failedHandoff = activeUpdateInstallHandoff;
    const installPreparationPending = clearUpdaterInstallInFlightAfterError({
      preservePendingPreparation: true,
    });
    if (errorContext === "download") {
      downloadedUpdateArtifact = null;
    }
    const installFailureCount =
      errorContext === "install"
        ? recordInstallMarkerFailure(new Date().toISOString(), failedHandoff)
        : updateState.installFailureCount;
    if (!updateCheckInFlight && !updateDownloadInFlight) {
      setUpdateState({
        status: "error",
        message,
        checkedAt: new Date().toISOString(),
        downloadPercent: null,
        errorContext,
        canRetry: updateState.availableVersion !== null || updateState.downloadedVersion !== null,
        installFailureCount,
      });
    }
    console.error(`[desktop-updater] Updater error: ${message}`);
    if (errorContext === "install" && !installPreparationPending) {
      recoverDesktopAfterUpdaterInstallFailure();
    }
  });
  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.floor(progress.percent);
    updateDownloadStallTimerOnProgress(progress);
    if (
      shouldBroadcastDownloadProgress(updateState, progress.percent) ||
      updateState.message !== null
    ) {
      setUpdateState(reduceDesktopUpdateStateOnDownloadProgress(updateState, progress.percent));
    }
    const milestone = percent - (percent % 10);
    if (milestone > lastLoggedDownloadMilestone) {
      lastLoggedDownloadMilestone = milestone;
      console.info(`[desktop-updater] Download progress: ${percent}%`);
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    const task = recordDownloadedUpdateIdentity(info);
    downloadedUpdateIdentityTask = task;
    const clearTask = () => {
      if (downloadedUpdateIdentityTask === task) downloadedUpdateIdentityTask = null;
    };
    void task.then(clearTask, clearTask);
  });

  clearUpdatePollTimer();

  if (automaticUpdateActivitySuppressed) {
    console.info(
      "[desktop-updater] Startup and periodic update checks suppressed after failed install verification.",
    );
    return;
  }

  updateStartupTimer = setTimeout(() => {
    updateStartupTimer = null;
    void checkForUpdates("startup");
  }, AUTO_UPDATE_STARTUP_DELAY_MS);
  updateStartupTimer.unref();

  scheduleUpdatePoll();
}
// Builds process-local Node args so provider/tool children do not inherit Moss's heap guard.
function backendNodeArgs(): string[] {
  const configuredMaxOldSpaceMb =
    BACKEND_MAX_OLD_SPACE_ENV_KEYS.map((key) => process.env[key]).find(
      (value) => value !== undefined && value.trim().length > 0,
    ) ?? null;
  return resolveBackendNodeArgs({
    configuredMaxOldSpaceMb,
    existingNodeOptions: process.env.NODE_OPTIONS,
    totalMemoryBytes: OS.totalmem(),
  });
}

let bundledCodexBackendEnvCache: NodeJS.ProcessEnv | null = null;
let productionPublicConfigLoaded = false;
let productionPublicConfigCache: MossProductionPublicConfig | null = null;

/**
 * Dev convenience: packaged builds read the bundled resource, while source-tree
 * dev launches pick up the repo-root config when it exists, so account flows
 * (phone OTP / Google OAuth / managed cloud routing) stay testable without
 * hand-exporting the env projection. Missing file keeps cloud auth disabled.
 */
function resolveDevProductionPublicConfigPath(): string | null {
  if (app.isPackaged) return null;
  const candidate = Path.resolve(__dirname, "../../..", MOSS_PRODUCTION_PUBLIC_CONFIG_FILE);
  return FS.existsSync(candidate) ? candidate : null;
}

function desktopProductionPublicConfig(): MossProductionPublicConfig | null {
  if (productionPublicConfigLoaded) {
    return productionPublicConfigCache;
  }
  productionPublicConfigLoaded = true;
  const devResourcePath = resolveDevProductionPublicConfigPath();
  productionPublicConfigCache = loadMossProductionPublicConfig({
    isPackaged: app.isPackaged || devResourcePath !== null,
    resourcePath: app.isPackaged
      ? resolveResourcePath(MOSS_PRODUCTION_PUBLIC_CONFIG_FILE)
      : devResourcePath,
  });
  return productionPublicConfigCache;
}

function bundledCodexBackendEnv(): NodeJS.ProcessEnv {
  if (!app.isPackaged) return {};
  if (bundledCodexBackendEnvCache) return bundledCodexBackendEnvCache;

  const resolution = resolveBundledCodexBinary({
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    arch: process.arch,
  });
  if (!resolution.ok) {
    safeConsoleError(`[desktop] ${resolution.message}`);
  }

  bundledCodexBackendEnvCache = toBundledCodexBackendEnv(resolution);
  return bundledCodexBackendEnvCache;
}
let cuaDriverHost: CuaDriverHost | undefined;
let disposeComputerDesktopLifecycle: (() => void) | undefined;
let cuaHostEndpoint: string | undefined;
let escapeKillSwitchMonitor: EscapeKillSwitchMonitor | undefined;
let audioLevelMonitor: AudioLevelMonitor | undefined;
// Renderers currently subscribed to audio levels, keyed by webContents id.
const audioLevelSubscribers = new Map<
  number,
  { readonly contents: Electron.WebContents; readonly release: () => void }
>();
let linuxEscapeKillSwitchMonitor: LinuxEscapeKillSwitchMonitor | undefined;
let computerFrameTap: ComputerFrameTap | undefined;
// Main-window renderers whose preview currently wants tap frames, keyed by
// webContents id. The native capture helper runs only while this is non-empty.
const computerPreviewSubscribers = new Map<number, () => void>();

function syncComputerFrameTapDemand(): void {
  computerFrameTap?.setSubscribed(computerPreviewSubscribers.size > 0);
}

function stopComputerInputFromEscape(): void {
  // Native interruption owns the drain. The backend notice only relays the
  // interrupted state; a slow provider must not delay the local stop.
  if (!cuaDriverHost?.emergencyStopInput()) return;
  notifyBackendComputerEmergencyStop({
    backendHttpUrl,
    shutdownToken: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
    onError: (message) => safeConsoleError(`[desktop] ${message}`),
  });
}

async function attachCuaHost(host: CuaDriverHost): Promise<void> {
  cuaHostEndpoint = await host.listen();
  cuaDriverHost = host;
  disposeComputerDesktopLifecycle = registerComputerDesktopLifecycle(powerMonitor, host, (error) =>
    safeConsoleError("[desktop] computer input pause failed", error),
  );
}

async function startCuaHost(): Promise<void> {
  if ((process.platform !== "darwin" && process.platform !== "linux") || cuaDriverHost) return;
  sweepOrphanedCuaDrivers();
  if (process.platform === "linux") {
    linuxEscapeKillSwitchMonitor ??= new LinuxEscapeKillSwitchMonitor({
      shortcutRegistry: globalShortcut,
      sessionType: linuxEscapeSession(
        app.commandLine.getSwitchValue("ozone-platform") ||
          app.commandLine.getSwitchValue("ozone-platform-hint") ||
          process.env.ELECTRON_OZONE_PLATFORM_HINT,
      ),
      onEscape: stopComputerInputFromEscape,
      onStateChange: (state) => cuaDriverHost?.inputMonitorStateChanged(state),
      onError: (message) => safeConsoleError(`[desktop] Escape monitor: ${message}`),
    });
    await attachCuaHost(
      createLinuxCuaDriverHost({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appRoot: resolveAppRoot(),
        bundleId: desktopIdentity.bundleId,
        capability: DESKTOP_BROWSER_HOST_CAPABILITY,
        inputMonitor: linuxEscapeKillSwitchMonitor,
        ownPids: () => new Set([process.pid, ...app.getAppMetrics().map((metric) => metric.pid)]),
      }),
    );
    return;
  }
  const frameTap = new ComputerFrameTap({
    helperPath: resolveAppSnapHelperPath(),
    send: (channel, frame) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send(channel, frame);
      }
    },
    onError: (error) => safeConsoleError("[desktop] computer frame tap failed", error),
  });
  computerFrameTap = frameTap;
  syncComputerFrameTapDemand();
  const host = new CuaDriverHost({
    onInputMonitorArmedChange: (armed) => escapeKillSwitchMonitor?.setArmed(armed),
    inputMonitorState: () =>
      escapeKillSwitchMonitor?.state ?? { ready: false, error: "input_monitor_starting" },
    activateInputMonitor: async () => {
      await escapeKillSwitchMonitor?.activate();
    },
    binaryPath: app.isPackaged
      ? Path.join(process.resourcesPath, "cua-driver", "cua-driver")
      : Path.join(resolveAppRoot(), "apps/desktop/resources/cua-driver/cua-driver"),
    bundleId: desktopIdentity.bundleId,
    capability: DESKTOP_BROWSER_HOST_CAPABILITY,
    // Computer use must never bind the app hosting it: the integrated
    // browser's webviews live in this app's own renderer pids.
    ownPids: () => new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]),
    // Stock by default: a missing preference file reads as null and the host
    // sends no style call at all.
    cursorStyle: () => readAgentCursorPreference(AGENT_CURSOR_PREFERENCE_PATH),
    checkPermissions: async (options) => {
      // The AppSnap manager owns the shared native permission helper; lazily
      // starting it here keeps the CUA host working even when AppSnap itself is
      // still disabled.
      initializeDesktopAppSnap();
      const state = await appSnapManager!.refreshState(COMPUTER_PERMISSION_KINDS, {
        force: options?.force === true,
      });
      if (
        state.status === "error" &&
        (state.accessibilityPermission === "unknown" ||
          state.inputMonitoringPermission === "unknown" ||
          state.screenRecordingPermission === "unknown")
      ) {
        throw new Error(state.message ?? "The native helper could not verify macOS permissions.");
      }
      if (
        host.isInputMonitorRequested &&
        state.inputMonitoringPermission === "granted" &&
        escapeKillSwitchMonitor?.state.error === "input-monitoring-required"
      ) {
        await escapeKillSwitchMonitor.activate(true);
      }
      return {
        accessibility: state.accessibilityPermission === "granted",
        inputMonitoring: state.inputMonitoringPermission === "granted",
        screenRecording: state.screenRecordingPermission === "granted",
      };
    },
    setup: async () => {
      initializeDesktopAppSnap();
      await appSnapManager!.startPermissionSetup(COMPUTER_PERMISSION_KINDS);
    },
    releaseHeldInput: async () => {
      // Same lazily-started shared helper as the permission checks: the AppSnap
      // binary posts the releases, and it exists whether or not AppSnap itself
      // is enabled.
      initializeDesktopAppSnap();
      await appSnapManager!.releaseHeldInput();
    },
    frameTap,
    // The masked-activation shield host: same AppSnap helper binary, its own
    // long-lived process, lazily spawned on the first engage. Always wired —
    // the server decides per call whether the armed flag + per-app opt-in
    // name a masked activation, and a missing surface must fail closed there
    // rather than degrade to an unmasked raise.
    shield: new ComputerShield({
      helperPath: resolveAppSnapHelperPath(),
      onError: (error) => safeConsoleError("[desktop] computer shield failed", error),
    }),
    normalizeOverview: (result) => {
      const image = result.content?.find((part) => part.type === "image" && part.data);
      if (!image?.data) return result;
      const native = nativeImage.createFromBuffer(Buffer.from(image.data, "base64"));
      const size = native.getSize();
      if (Math.max(size.width, size.height) <= MODEL_SCREEN_IMAGE_MAX_DIMENSION) return result;
      const ratio = MODEL_SCREEN_IMAGE_MAX_DIMENSION / Math.max(size.width, size.height);
      const scaled = native.resize({
        width: Math.round(size.width * ratio),
        height: Math.round(size.height * ratio),
        quality: "best",
      });
      image.data = scaled.toPNG().toString("base64");
      return result;
    },
  });
  await attachCuaHost(host);
  // The physical Escape kill switch lives in a dedicated helper process: its
  // listen-only event tap can report a hardware Escape even while Electron's
  // main process is busy. Readiness is exposed through Computer status and
  // gates input until Input Monitoring and the listener are both healthy.
  if (!escapeKillSwitchMonitor) {
    escapeKillSwitchMonitor = new EscapeKillSwitchMonitor({
      helperPath: resolveAppSnapHelperPath(),
      onPhysicalInput: (event) => {
        cuaDriverHost?.physicalInput(event);
      },
      onStateChange: (state) => cuaDriverHost?.inputMonitorStateChanged(state),
      onEscape: stopComputerInputFromEscape,
      onError: (message) => safeConsoleError(`[desktop] Escape monitor: ${message}`),
    });
  }
}

function backendEnv(): NodeJS.ProcessEnv {
  const servedStaticRoot = resolveServedStaticRoot();
  const migrationSourceDigest = embeddedDesktopMigrationRuntimeSourceDigest();
  const migrationDivergenceConsent = migrationConsentHandoff.take();
  const bundledClaudePath = resolveBundledClaudeBinary({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  const productionPublicConfig = desktopProductionPublicConfig();
  const commitHash = resolveBackendCommitHash();
  const env = resolveBrowserHostPipeBackendEnv(
    mergeMossProductionPublicConfigIntoEnv(
      {
        ...canonicalFilesystemHelperBackendEnv({
          inheritedEnv: process.env,
          platform: process.platform,
          isPackaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          desktopMainDirname: __dirname,
        }),
        // Keep HTTP static assets on the same swap-immune snapshot as the
        // desktop protocol so an in-place update cannot split versions.
        ...(servedStaticRoot?.snapshotted ? { MOSS_STATIC_DIR: servedStaticRoot.dir } : {}),
        ...(app.isPackaged
          ? { [DEVICE_HELPER_SOURCE_DIR_ENV]: Path.join(process.resourcesPath, "device-helper") }
          : {}),
        ...(migrationSourceDigest
          ? { [MIGRATION_RUNTIME_SOURCE_DIGEST_ENV]: migrationSourceDigest }
          : {}),
        ...(migrationDivergenceConsent
          ? { [MIGRATION_DIVERGENCE_CONSENT_ENV]: migrationDivergenceConsent }
          : {}),
        MOSS_MODE: "desktop",
        MOSS_DESKTOP_VERSION: app.getVersion(),
        ...(commitHash ? { MOSS_COMMIT_HASH: commitHash } : {}),
        MOSS_NO_BROWSER: "1",
        MOSS_PORT: String(backendPort),
        MOSS_HOME: BASE_DIR,
        MOSS_AUTH_TOKEN: backendAuthToken,
        MOSS_HOOLA_CANVAS_BRIDGE_TOKEN: hoolaCanvasBridgeToken,
        MOSS_DESKTOP_SHUTDOWN_TOKEN: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
        MOSS_APPSNAP_HELPER_PATH: resolveAppSnapHelperPath(),
        ...(bundledClaudePath ? { [MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY]: bundledClaudePath } : {}),
        ...bundledCodexBackendEnv(),
        ...(cuaHostEndpoint ? { [CUA_HOST_SOCKET_ENV]: cuaHostEndpoint } : {}),
        [MOSS_DESKTOP_BUNDLE_ID_ENV]: desktopIdentity.bundleId,
      },
      productionPublicConfig,
      { isPackaged: app.isPackaged },
    ),
    browserHostPipeServer ? MOSS_BROWSER_HOST_PIPE_PATH : null,
    browserHostPipeServer ? DESKTOP_BROWSER_HOST_CAPABILITY_FD : null,
  );

  if (!isDevelopment || env.VITE_DEV_SERVER_URL?.trim().length === 0) {
    delete env.VITE_DEV_SERVER_URL;
  }

  // Mark the child only when the desktop probe really hydrated PATH. A failed
  // desktop probe must still allow the backend to recover independently.
  return withBackendEnvProxyOptIn(
    applyShellEnvironmentHydrationMarker(env, shellEnvironmentSync.pathHydrated),
  );
}

function removeHoolaCanvasBridgeDescriptor(): void {
  try {
    FS.unlinkSync(HOOLA_CANVAS_BRIDGE_DESCRIPTOR_PATH);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      console.warn("[desktop] Failed to remove Hoola canvas bridge descriptor");
    }
  }
}

function publishHoolaCanvasBridgeDescriptor(): void {
  if (
    !Number.isInteger(backendPort) ||
    backendPort < 1 ||
    backendPort > 65_535 ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(hoolaCanvasBridgeToken)
  ) {
    throw new Error("Hoola canvas bridge endpoint is not ready.");
  }
  FS.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
  const temporaryPath = `${HOOLA_CANVAS_BRIDGE_DESCRIPTOR_PATH}.${process.pid}.tmp`;
  const issuedAt = Date.now();
  const descriptor = {
    version: 1,
    pid: process.pid,
    port: backendPort,
    baseUrl: `http://127.0.0.1:${backendPort}/hoola-canvas-bridge`,
    // Canvas account/session calls use Moss' canonical native WebSocket RPC.
    // Keep this in the private descriptor so a separate Moss Canvas window can
    // reuse the already logged-in Moss process without a second account or a
    // Hoola web fallback. The bearer never reaches a renderer.
    wsUrl: backendWsUrl,
    token: hoolaCanvasBridgeToken,
    issuedAt,
    expiresAt: issuedAt + 12 * 60 * 60_000,
  };
  try {
    FS.writeFileSync(temporaryPath, `${JSON.stringify(descriptor)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    FS.chmodSync(temporaryPath, 0o600);
    FS.renameSync(temporaryPath, HOOLA_CANVAS_BRIDGE_DESCRIPTOR_PATH);
  } catch (error) {
    try {
      FS.unlinkSync(temporaryPath);
    } catch {
      // The atomic temp was never created or was already renamed.
    }
    throw error;
  }
}

function scheduleBackendRestart(reason: string): void {
  const response = backendSupervision.respondToStartFailure({
    quitting: isQuitting,
    restartPending: restartTimer !== null,
    migrationRecoveryMarkerPresent: isDesktopMigrationRecoveryPending(),
  });

  switch (response.kind) {
    case "ignore":
      return;
    case "recover-migration":
      // The marker is written mid-session by the migration that just killed the
      // backend, so bootstrap's one-shot check never saw it. Recovery owns the
      // process from here; respawning would only repeat the failed migration.
      writeDesktopLogHeader(
        `migration recovery marker detected after backend failure reason=${sanitizeLogValue(reason)}`,
      );
      safeConsoleError(
        `[desktop] backend failed with a pending migration recovery (${reason}); opening recovery`,
      );
      void runMidSessionMigrationRecovery(reason);
      return;
    case "give-up":
      writeDesktopLogHeader(
        `backend supervision gave up failures=${response.failures} reason=${sanitizeLogValue(reason)}`,
      );
      safeConsoleError(
        `[desktop] backend failed to start ${response.failures} times in a row (${reason}); no further restarts will be attempted`,
      );
      presentBackendStartupGiveUp(reason);
      return;
    case "retry":
      safeConsoleError(
        `[desktop] backend exited unexpectedly (${reason}); restarting in ${response.delayMs}ms (attempt ${response.attempt}/${BACKEND_MAX_CONSECUTIVE_START_FAILURES})`,
      );
      restartTimer = setTimeout(() => {
        restartTimer = null;
        void restartBackendAfterCrash(reason);
      }, response.delayMs);
      return;
  }
}

// Runs the same recovery flow bootstrap uses, but for a marker that appeared while
// the app was already running. Shown once per app run — the policy owns that latch.
async function runMidSessionMigrationRecovery(reason: string): Promise<void> {
  const outcome = await handleDesktopMigrationRecovery();
  if (outcome !== "continue") return;

  // The marker vanished between the crash check and the recovery run (another
  // process cleared it), so fall back to the normal supervised restart.
  await restartBackendAfterCrash(reason);
}

function backendFailureDialogDetail(reason: string): string {
  const summary = summarizeBackendFailureOutput(lastBackendFailureDetail ?? "");
  const cause = summary.length > 0 ? summary : reason;
  return [
    cause,
    "Moss paused automatic restarts so a failing backend can't keep respawning in the background.",
    `Log file:\n${Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME)}`,
  ].join("\n\n");
}

async function openDesktopLogDirectory(): Promise<void> {
  try {
    await FS.promises.mkdir(LOG_DIR, { recursive: true });
    const errorMessage = await shell.openPath(LOG_DIR);
    if (errorMessage.trim().length > 0) {
      throw new Error(errorMessage);
    }
  } catch (error) {
    safeConsoleError(`[desktop] failed to open log directory: ${formatErrorMessage(error)}`);
  }
}

/**
 * Replaces the eternal loading skeleton with a blocking, actionable window once
 * supervision stops respawning the backend.
 */
function presentBackendStartupGiveUp(reason: string): void {
  if (isQuitting || backendLifecycleDialogInFlight) return;

  const detail = backendFailureDialogDetail(reason);
  const task = (async () => {
    for (;;) {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Moss's backend didn't start",
        message: `Moss's backend failed to start ${BACKEND_MAX_CONSECUTIVE_START_FAILURES} times in a row.`,
        detail,
        buttons: ["Try again", "Open logs", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });

      if (result.response === 1) {
        await openDesktopLogDirectory();
        continue;
      }

      if (result.response === 0) {
        // A user-driven retry is a fresh lifecycle start, not another crash cycle.
        backendLifecycleDialogInFlight = null;
        await restartBackendAfterCrash("manual retry after backend startup failure", "lifecycle");
        return;
      }

      requestGracefulAppQuit("backend failed to start");
      return;
    }
  })().finally(() => {
    if (backendLifecycleDialogInFlight === task) {
      backendLifecycleDialogInFlight = null;
    }
  });
  backendLifecycleDialogInFlight = task;
}

function schemaTooNewRestoreDetail(
  block: MigrationSchemaTooNewStartupBlock,
  restoreCandidate: ReturnType<typeof resolveDesktopMigrationRestoreCandidate>,
): string {
  if (restoreCandidate) {
    return (
      `Moss verified the exact pre-migration backup at:\n${restoreCandidate.backupPath}\n\n` +
      `Its tracker ends at migration ${restoreCandidate.backupMigrationId}; its shared lineage is compatible ` +
      "with this build, and it passed SQLite integrity checking."
    );
  }

  if (block.recovery.kind === "restore-available") {
    return "The recorded backup does not match this desktop database exactly, so Moss will not restore it.";
  }

  switch (block.recovery.reason) {
    case "missing-provenance":
      return "No completed migration backup record exists for this database, so Moss cannot choose a backup safely.";
    case "invalid-provenance":
      return "The completed migration backup record does not describe this exact database state.";
    case "invalid-backup":
      return "The exact recorded backup is missing, unreadable, or failed SQLite integrity checking.";
    case "incompatible-backup":
      return "The exact recorded backup has a schema or migration lineage this Moss build cannot open safely.";
  }
}

async function handleDesktopSchemaTooNewRecovery(
  block: MigrationSchemaTooNewStartupBlock,
  diagnosticId: string | null = null,
): Promise<void> {
  const paths = desktopMigrationRecoveryPaths();
  const restoreCandidate = resolveDesktopMigrationRestoreCandidate(paths, block);
  desktopStartupBlockedForDatabaseRestore = true;

  await recoverDesktopMigrationIfRequired({
    requiresRecovery: () => true,
    markerRemains: () =>
      restoreCandidate === null ||
      !hasVerifiedDesktopMigrationRestore(paths, restoreCandidate.backupPath),
    choose: async ({ previousFailure }) => {
      const restoreFailed = previousFailure?.attempt === "restore";
      const canInstallUpdate = canInstallUpdateFromRecovery();
      const releaseUrl = updateState.releaseUrl;
      const choices: Array<{
        readonly label: string;
        readonly decision: DesktopMigrationRecoveryDecision;
      }> = [];

      if (restoreCandidate) {
        choices.push({
          label: restoreFailed ? "Try restore again" : "Restore backup and restart",
          decision: "restore",
        });
      }
      if (canInstallUpdate) {
        choices.push({ label: "Update Moss and restart", decision: "install-update" });
      }
      if (releaseUrl !== null) {
        choices.push({ label: "Download latest release", decision: "open-release-page" });
      }
      choices.push(
        { label: "Open logs", decision: "open-logs" },
        { label: "Quit", decision: "quit" },
      );

      const result = await showDiagnosticStartupDialog(
        {
          type: previousFailure === null ? "warning" : "error",
          title:
            previousFailure === null
              ? "This database is newer than Moss"
              : restoreFailed
                ? "Database restore failed"
                : "Moss could not update itself",
          message:
            previousFailure === null
              ? `Database migration ${block.databaseMigrationId} is newer than this build supports (${block.latestSupportedMigrationId}).`
              : restoreFailed
                ? "The verified database backup could not be restored."
                : "The newest Moss release could not be installed.",
          detail:
            `${previousFailure === null ? "" : `${previousFailure.message}\n\n`}` +
            `${schemaTooNewRestoreDetail(block, restoreCandidate)}\n\n` +
            "The backend and provider processes will remain stopped until you update, restore, or quit.",
          buttons: choices.map((choice) => choice.label),
          defaultId: 0,
          cancelId: choices.length - 1,
          noLink: true,
        },
        diagnosticId,
        betaDiagnostics,
      );
      return choices[result.response]?.decision ?? "quit";
    },
    installUpdate: installLatestUpdateForMigrationRecovery,
    openReleasePage: () => {
      const releaseUrl = updateState.releaseUrl;
      if (releaseUrl !== null) void shell.openExternal(releaseUrl);
    },
    openLogs: openDesktopLogDirectory,
    restore: async () => {
      if (!restoreCandidate) {
        throw new Error("No exact compatible migration backup is available.");
      }
      await restoreDesktopMigrationBackup({
        executablePath: process.execPath,
        nodeArgs: backendNodeArgs(),
        paths,
        cwd: resolveBackendCwd(),
        env: process.env,
        expectedBackupPath: restoreCandidate.backupPath,
        expectedProvenancePath: restoreCandidate.provenancePath,
        verifyRestore: () => hasVerifiedDesktopMigrationRestore(paths, restoreCandidate.backupPath),
        restoreVerificationFailure:
          "Migration restore completed without exact completed-provenance verification.",
      });
    },
    requestRestart: () => app.relaunch(),
    requestQuit: (reason) => requestGracefulAppQuit(reason),
    formatError: formatErrorMessage,
    log: writeDesktopLogHeader,
  });
}

function handleBackendStartupBlock(block: BackendStartupBlock): void {
  if (isQuitting || backendLifecycleDialogInFlight) return;

  const diagnosticId =
    betaDiagnostics?.trackIssue("main", {
      code: `startup.${block.kind}`,
      ...(block.kind === "database-locked"
        ? { reason: block.ownerPid === null ? "unknown-owner" : "live-owner" }
        : {}),
    }) ?? null;
  const showBlockDialog = (options: MessageBoxOptions) =>
    showDiagnosticStartupDialog(options, diagnosticId, betaDiagnostics);
  const task = (async () => {
    if (block.kind === "migration-schema-too-new") {
      await handleDesktopSchemaTooNewRecovery(block.block, diagnosticId);
      return;
    }

    if (block.kind === "migration-startup-block-invalid") {
      desktopStartupBlockedForDatabaseRestore = true;
      await recoverDesktopMigrationIfRequired({
        requiresRecovery: () => true,
        markerRemains: () => true,
        choose: async ({ previousFailure }) => {
          const releaseUrl = updateState.releaseUrl;
          const choices = invalidMigrationStartupRecoveryChoices({
            canInstallUpdate: canInstallUpdateFromRecovery(),
            canOpenReleasePage: releaseUrl !== null,
          });
          const result = await showBlockDialog({
            type: "error",
            title:
              previousFailure === null
                ? "Moss could not verify migration recovery"
                : "Moss could not update itself",
            message:
              previousFailure === null
                ? "The backend stopped for database safety, but its recovery details were invalid."
                : "The newest Moss release could not be installed.",
            detail:
              `${previousFailure === null ? "" : `${previousFailure.message}\n\n`}` +
              "Moss will keep the backend and provider processes stopped. The recovery record is not trusted, so restoring from it is disabled; choose one of the safe actions below.",
            buttons: choices.map((choice) => choice.label),
            defaultId: 0,
            cancelId: choices.length - 1,
            noLink: true,
          });
          return choices[result.response]?.decision ?? "quit";
        },
        installUpdate: installLatestUpdateForMigrationRecovery,
        openReleasePage: () => {
          const releaseUrl = updateState.releaseUrl;
          if (releaseUrl !== null) void shell.openExternal(releaseUrl);
        },
        openLogs: openDesktopLogDirectory,
        restore: async () => {
          throw new Error("Invalid migration recovery details cannot authorize a restore.");
        },
        requestRestart: () => undefined,
        requestQuit: (reason) => requestGracefulAppQuit(reason),
        formatError: formatErrorMessage,
        log: writeDesktopLogHeader,
      });
      return;
    }

    if (block.kind === "migration-divergence-consent-required") {
      const challenge = block.challenge;
      const result = await showBlockDialog({
        type: "warning",
        title: "Moss found a different database migration history",
        message: `Migration ${challenge.firstDivergedId} does not match this build.`,
        detail:
          `The database records "${challenge.recordedName}", while this build expects ` +
          `"${challenge.expectedName}". Continuing will first save an exact backup in:\n` +
          `${challenge.backupDirectory}\n\nMoss will then rewrite tracker rows from migration ` +
          `${challenge.firstDivergedId} and replay through ${challenge.targetVersion}. ` +
          "Older builds may no longer be able to open the upgraded database. No provider or chat process will start until you choose.",
        buttons: ["Back up and continue", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        migrationConsentHandoff.approve(challenge.consentToken);
        backendLifecycleDialogInFlight = null;
        await restartBackendAfterCrash("approved migration lineage repair", "lifecycle");
      } else {
        requestGracefulAppQuit("migration lineage repair declined");
      }
      return;
    }

    if (block.kind === "migration-runtime-identity-mismatch") {
      await showBlockDialog({
        type: "error",
        title: "Moss's server build does not match",
        message: "The desktop and server migration code came from different builds.",
        detail: app.isPackaged
          ? "Update or reinstall Moss before starting it again. The database was not opened."
          : "Rebuild with bun run build:desktop before starting Moss again. The database was not opened.",
        buttons: ["Quit"],
        defaultId: 0,
        noLink: true,
      });
      requestGracefulAppQuit("migration bundle identity mismatch");
      return;
    }

    if (block.kind === "migration-recovery-required") {
      const result = await showBlockDialog({
        type: "warning",
        title: "Moss needs to recover its database",
        message: "A database migration did not finish safely.",
        detail:
          "Restart Moss to open the verified backup recovery flow. Provider and chat processes will remain stopped until recovery completes.",
        buttons: ["Restart and recover", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) {
        app.relaunch();
        requestGracefulAppQuit("migration recovery required");
      } else {
        requestGracefulAppQuit("migration recovery declined");
      }
      return;
    }

    const processDetail =
      block.ownerPid === null
        ? "Moss could not verify the database lock. The lock may be left over from an interrupted startup, or another server may still be using it."
        : `Another Moss server (process ${block.ownerPid}) is already using this database.`;
    for (;;) {
      const result = await showBlockDialog({
        type: "warning",
        title:
          block.ownerPid === null
            ? "Moss could not verify database ownership"
            : "Moss is already running elsewhere",
        message:
          block.ownerPid === null
            ? "Moss could not safely open your local data."
            : "Your local Moss data is in use by another process.",
        detail:
          `${processDetail}\n\nClose any other Moss app or development server using this data, then try again. ` +
          "If this keeps happening, open the logs to see the underlying lock error. Your data has not been changed.\n\n" +
          `Log file:\n${Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME)}`,
        buttons: ["Try again", "Open logs", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (result.response === 1) {
        await openDesktopLogDirectory();
        continue;
      }
      if (result.response === 0) {
        // Let a fast failed retry present the block again instead of racing this
        // dialog task's finalizer and leaving the window inert.
        backendLifecycleDialogInFlight = null;
        await restartBackendAfterCrash("database lifecycle lock retry", "lifecycle");
      } else {
        requestGracefulAppQuit("database lifecycle lock");
      }
      return;
    }
  })().finally(() => {
    if (backendLifecycleDialogInFlight === task) {
      backendLifecycleDialogInFlight = null;
    }
  });
  backendLifecycleDialogInFlight = task;
}

async function restartBackendAfterCrash(
  reason: string,
  trigger: BackendStartTrigger = "crash-restart",
): Promise<void> {
  if (isQuitting || backendProcess) {
    return;
  }

  if (trigger === "lifecycle") {
    // Reset before reserving the port so a user-driven retry gets a full restart
    // budget even when the retry itself fails before the process is spawned.
    backendSupervision.reset();
  }

  cancelBackendReadinessWait();
  // The aborted observer settles on a later microtask. Clear its identity now
  // so the replacement child always gets a fresh readiness observation even
  // when the renderer window survived the crash.
  backendInitialWindowOpenInFlight = null;
  try {
    await reserveBackendEndpoint("backend restart");
  } catch (error) {
    scheduleBackendRestart(
      `failed to reserve restart port after ${reason}: ${formatErrorMessage(error)}`,
    );
    return;
  }

  startBackend(trigger);
  ensureInitialBackendWindowOpen(backendHttpUrl);
}

/**
 * "lifecycle" covers every deliberate start — bootstrap, a failed update install
 * handing the backend back, or a user-driven retry — and clears the crash backoff
 * and circuit breaker. Only the supervised crash path keeps the failure count.
 */
type BackendStartTrigger = "lifecycle" | "crash-restart";

/**
 * Emits beta.installed once, on the first backend readiness while the
 * install-pending marker exists. The marker is written when the install id is
 * created, so a first launch whose backend never came up reports on the next
 * launch instead. The server consumes any pending import marker before it
 * listens, so import-result.json is final at this point.
 */
let betaInstalledEventEmitted = false;
function maybeTrackBetaInstalled(): void {
  if (!betaDiagnostics || betaInstalledEventEmitted || !betaDiagnostics.hasInstallPending()) {
    return;
  }
  betaInstalledEventEmitted = true;
  const result = readBetaImportResult(BASE_DIR);
  trackBetaDiagnostics("beta.installed", {
    kind: "beta",
    outcome: result === null ? "fresh" : result.ok ? "imported" : "import-failed",
  });
  betaDiagnostics.clearInstallPending();
}

function startBackend(trigger: BackendStartTrigger = "lifecycle"): void {
  if (isQuitting || backendProcess) return;
  // Recovery owns the database until it clears the marker. Callers that restart
  // the backend after an unrelated failure — a given-up update install, say —
  // must not hand it a database the user is being asked how to repair.
  if (desktopStartupBlockedForDatabaseRestore) {
    writeDesktopLogHeader("backend start suppressed while migration recovery is pending");
    return;
  }

  if (trigger === "lifecycle") {
    backendSupervision.reset();
  }

  const backendEntry = resolveBackendEntry();
  if (!FS.existsSync(backendEntry)) {
    scheduleBackendRestart(`missing server entry at ${backendEntry}`);
    return;
  }

  const child = ChildProcess.spawn(process.execPath, [...backendNodeArgs(), backendEntry], {
    cwd: resolveBackendCwd(),
    // In Electron main, process.execPath points to the Electron binary.
    // Run the child in Node mode so this backend process does not become a GUI app instance.
    env: {
      ...backendEnv(),
      ELECTRON_RUN_AS_NODE: "1",
      MOSS_DESKTOP_PARENT_STDIN: "1",
      MOSS_SERVER_ENTRY: backendEntry,
      MOSS_CANVAS_BUNDLE_DIR: resolveBundledMossCanvasRoot(),
      MOSS_CANVAS_STATIC_DIR: app.isPackaged
        ? Path.join(resolveBundledMossCanvasRoot(), "apps", "codex-canvas", "dist")
        : process.env.MOSS_CANVAS_STATIC_DIR ||
          Path.join(resolveBundledMossCanvasRoot(), "apps", "codex-canvas", "dist"),
    },
    // On Windows, a non-detached Node child causes libuv to put the Electron
    // main process into its global kill-on-close Job. Keep the backend in its
    // own process group; shutdown still owns and waits for this ChildProcess.
    detached: process.platform === "win32",
    // Keep stdin open for the desktop lifetime so a detached backend can release
    // its database and provider children after the desktop crashes.
    // Keep output piped in every environment so startup blockers and readiness
    // are observable even when packaged log setup is unavailable. The fourth
    // pipe carries the browser-host capability and must never be inherited.
    stdio: ["pipe", "pipe", "pipe", "pipe"],
  });
  child.stdin.on("error", (error) => {
    if (!isBrokenPipeError(error)) {
      safeConsoleError("[desktop] backend owner pipe failed", error);
    }
  });
  const capabilityPipe = child.stdio[DESKTOP_BROWSER_HOST_CAPABILITY_FD];
  if (capabilityPipe && "end" in capabilityPipe) {
    capabilityPipe.on("error", (error) => {
      if (!isBrokenPipeError(error)) {
        safeConsoleError("[desktop] failed to deliver browser host capability", error);
      }
    });
    capabilityPipe.end(DESKTOP_BROWSER_HOST_CAPABILITY);
  } else {
    child.kill();
    scheduleBackendRestart("browser host capability pipe was unavailable");
    return;
  }
  const listeningDetector = new ServerListeningDetector();
  const startupBlockDetector = new BackendStartupBlockDetector();
  const outputTailDetector = new BackendOutputTailDetector();
  backendListeningDetector = listeningDetector;
  backendProcess = child;
  cuaDriverHost?.resume();
  try {
    publishHoolaCanvasBridgeDescriptor();
  } catch {
    removeHoolaCanvasBridgeDescriptor();
    console.warn("[desktop] Failed to publish Hoola canvas bridge descriptor");
  }
  const backendBaseUrl = backendHttpUrl;
  let backendSessionClosed = false;
  const closeBackendSession = (details: string) => {
    if (backendSessionClosed) return;
    backendSessionClosed = true;
    writeBackendSessionBoundary("END", details);
  };
  writeBackendSessionBoundary(
    "START",
    `pid=${child.pid ?? "unknown"} port=${backendPort} cwd=${resolveBackendCwd()}`,
  );
  const backendLogDestination = backendLogSink;
  const backendOutputCapture = captureBackendProcessOutput({
    stdout: child.stdout,
    stderr: child.stderr,
    ...(backendLogDestination ? { writeLog: (chunk) => backendLogDestination.write(chunk) } : {}),
    writeStdout: (chunk) => {
      process.stdout.write(chunk);
    },
    writeStderr: (chunk) => {
      process.stderr.write(chunk);
    },
    detectors: [
      listeningDetector,
      startupBlockDetector,
      outputTailDetector,
      ...(betaDiagnostics
        ? [
            new BackendIssueDetector((issue) => {
              betaDiagnostics.trackIssue("main", issue);
            }),
          ]
        : []),
    ],
  });

  // Readiness is authoritative even when the optional log marker is delayed or
  // absent. A successful spawn alone must never reset crash supervision.
  const startupHealthMonitor = monitorBackendStartupHealth({
    waitUntilReady: (signal) =>
      waitForHttpReady(backendBaseUrl, {
        path: "/health",
        timeoutMs: null,
        signal,
        isReady: isBackendStartupReadyResponse,
      }),
    isCurrent: () => backendProcess === child,
    onReady: () => {
      backendSupervision.recordReadiness();
      // Startup blocks are classified only before readiness; stop scanning
      // every later output chunk for the rest of this backend's life.
      startupBlockDetector.freeze();
      maybeTrackBetaInstalled();
    },
  });

  child.on("error", (error) => {
    startupHealthMonitor.abort();
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(error);
      backendListeningDetector = null;
    }
    if (backendProcess === child) {
      backendProcess = null;
    }
    closeBackendSession(`pid=${child.pid ?? "unknown"} error=${error.message}`);
    lastBackendFailureDetail = error.message;
    scheduleBackendRestart(error.message);
  });

  child.on("exit", (code, signal) => {
    startupHealthMonitor.abort();
    // Output can drain after a failed stop has restored the app's running state.
    const expectedExit = isQuitting;
    if (backendListeningDetector === listeningDetector) {
      listeningDetector.fail(
        new Error(
          `backend exited before logging readiness (code=${code ?? "null"} signal=${signal ?? "null"})`,
        ),
      );
      backendListeningDetector = null;
    }
    if (backendProcess === child) {
      backendProcess = null;
    }
    void backendOutputCapture.drained.then(() => {
      closeBackendSession(
        `pid=${child.pid ?? "unknown"} code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (isQuitting) return;
      const startupBlock = startupBlockDetector.read();
      if (startupBlock) {
        handleBackendStartupBlock(startupBlock);
        return;
      }
      const reason = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      lastBackendFailureDetail = outputTailDetector.read();
      if (!expectedExit)
        trackBetaDiagnostics("app.child-process-crash", {
          kind: "crash",
          processType: "backend",
          reason,
          // Guarded explicitly: on stable builds betaDiagnostics is null and the
          // log file must not be touched at all.
          logTail: betaDiagnostics
            ? readLogTail(Path.join(LOG_DIR, BACKEND_LOG_FILE_NAME))
            : undefined,
        });
      scheduleBackendRestart(reason);
    });
  });
}

function takeBackendProcessForShutdown(): ChildProcess.ChildProcess | null {
  cancelBackendReadinessWait();
  backendListeningDetector = null;
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  const child = backendProcess;
  backendProcess = null;
  return child;
}

async function stopBackendAndWaitForExit(): Promise<void> {
  await cuaDriverHost?.suspend();
  const child = takeBackendProcessForShutdown();
  if (!child) return;
  const backendChild = child;
  if (backendChild.exitCode !== null || backendChild.signalCode !== null) return;

  if (process.platform === "win32") {
    // Keep only fixed lifecycle categories here: never log the loopback URL,
    // shutdown credential, or arbitrary transport errors.
    const logShutdown = (detail: string) => {
      try {
        writeDesktopLogHeader(`Windows backend shutdown ${detail}`);
      } catch {
        // Diagnostics cannot change the owned child's shutdown outcome.
      }
    };
    try {
      const result = await stopWindowsBackendAndWait({
        child: backendChild,
        backendHttpUrl,
        shutdownToken: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
        forceKillDelayMs: BACKEND_FORCE_KILL_DELAY_MS,
        timeoutMs: BACKEND_SHUTDOWN_TIMEOUT_MS,
        startRequest: (input) => {
          logShutdown("request started");
          try {
            const request = startDesktopBackendShutdownRequest(input);
            void request.outcome.then(
              (outcome) =>
                logShutdown(
                  outcome.type === "response"
                    ? `request response status=${outcome.statusCode}`
                    : `request ${outcome.type}`,
                ),
              () => logShutdown("request rejected"),
            );
            return request;
          } catch (error) {
            logShutdown("request construction failed");
            throw error;
          }
        },
        forceTerminate: (ownedChild) => {
          logShutdown("fallback requested");
          try {
            logShutdown(`fallback sent=${ownedChild.kill("SIGTERM")}`);
          } catch (error) {
            logShutdown("fallback failed");
            throw error;
          }
        },
      });
      logShutdown(
        `result=${result.type} forced=${result.forced} exitCode=${backendChild.exitCode} signal=${backendChild.signalCode}`,
      );
      requireWindowsBackendExit(result);
    } catch (error) {
      backendProcess = retainLiveBackendAfterShutdownFailure(backendProcess, backendChild);
      throw error;
    }
    return;
  }

  try {
    await stopPosixBackendAndWait({
      child: backendChild,
      backendHttpUrl,
      shutdownToken: DESKTOP_BACKEND_SHUTDOWN_TOKEN,
      terminateDelayMs: POSIX_BACKEND_TERMINATE_DELAY_MS,
      forceKillDelayMs: POSIX_BACKEND_FORCE_KILL_DELAY_MS,
      timeoutMs: POSIX_BACKEND_SHUTDOWN_TIMEOUT_MS,
    });
  } catch (error) {
    backendProcess = retainLiveBackendAfterShutdownFailure(backendProcess, backendChild);
    throw error;
  }
}

async function disposeBrowserHostPipeServerForShutdown(reason: string): Promise<void> {
  disposeComputerDesktopLifecycle?.();
  disposeComputerDesktopLifecycle = undefined;
  escapeKillSwitchMonitor?.dispose();
  escapeKillSwitchMonitor = undefined;
  audioLevelMonitor?.dispose();
  audioLevelMonitor = undefined;
  audioLevelSubscribers.clear();
  linuxEscapeKillSwitchMonitor?.dispose();
  linuxEscapeKillSwitchMonitor = undefined;
  await cuaDriverHost?.dispose();
  cuaDriverHost = undefined;
  computerFrameTap = undefined;
  cuaHostEndpoint = undefined;
  const pipeServer = browserHostPipeServer;
  browserHostPipeServer = null;
  if (!pipeServer) return;

  try {
    await pipeServer.dispose();
  } catch (error: unknown) {
    const message = formatErrorMessage(error);
    writeDesktopLogHeader(`${reason} browser host pipe dispose failed message=${message}`);
    console.warn(`[desktop] Failed to dispose browser host pipe during ${reason}: ${message}`);
  }
}

function hideDesktopWindowForImmediateQuit(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed()) {
    return;
  }
  try {
    if (process.platform === "win32") {
      window.setSkipTaskbar(true);
    }
    window.hide();
  } catch (error: unknown) {
    writeDesktopLogHeader(`hide window for quit failed message=${formatErrorMessage(error)}`);
  }
}

// Keeps Electron alive long enough for backend finalizers to reap provider child processes.
async function shutdownDesktopRuntime(reason: string): Promise<void> {
  if (desktopShutdownPromise) {
    return desktopShutdownPromise;
  }

  isQuitting = true;
  hideDesktopWindowForImmediateQuit();
  writeDesktopLogHeader(`${reason} shutdown start`);
  const shutdown = runAfterDesktopShutdown(
    stopBackendAndWaitForExit(),
    async () => {
      clearUpdateBackgroundBlurTimer();
      clearUpdateCheckTimeoutTimer();
      clearUpdatePollTimer();
      cancelBackendReadinessWait();
      appSnapManager?.dispose();
      appSnapManager = null;
      realtimeVoiceShortcutManager?.dispose();
      realtimeVoiceShortcutManager = null;
      screen.removeListener("display-added", repositionRealtimeVoiceOverlayAfterDisplayChange);
      screen.removeListener("display-removed", repositionRealtimeVoiceOverlayAfterDisplayChange);
      screen.removeListener(
        "display-metrics-changed",
        repositionRealtimeVoiceOverlayAfterDisplayChange,
      );
      disposeRealtimeVoiceOverlay();
      await bundledMossCanvas.shutdown();
      await disposeBrowserHostPipeServerForShutdown(reason);
      browserManager.dispose();
      await browserVaultCapture.dispose();
      await browserSessionRestore?.shutdown();
      browserVault.dispose();
      restoreStdIoCapture?.();
      if (betaDiagnostics) {
        trackBetaDiagnostics("app.exit", { kind: "lifecycle" });
        await betaDiagnostics.dispose().catch(() => undefined);
      }
      desktopShutdownComplete = true;
      writeDesktopLogHeader(`${reason} shutdown cleanup complete`);
    },
    { runAfterShutdownFailure: true },
  );
  desktopShutdownPromise = shutdown;

  try {
    await shutdown;
    writeDesktopLogHeader(`${reason} shutdown complete`);
  } catch (error) {
    if (desktopShutdownPromise === shutdown) {
      desktopShutdownPromise = null;
    }
    throw error;
  } finally {
    // Release the persistent log descriptors after the final shutdown log.
    // A later quit-path write simply reopens the file; close() is idempotent.
    backendLogSink?.close();
    desktopLogSink?.close();
  }
}

function isMainRendererAvailable(): boolean {
  return Boolean(
    mainWindow &&
    !mainWindow.isDestroyed() &&
    !mainWindow.webContents.isDestroyed() &&
    !mainWindow.webContents.isCrashed(),
  );
}

async function confirmRunningChatsThenQuit(reason: string): Promise<void> {
  if (
    !shouldPromptForRunningChatsBeforeQuit(reason) ||
    runningChatsQuitGuard.hasAllowedQuit() ||
    isQuitting ||
    desktopShutdownPromise !== null ||
    desktopShutdownComplete
  ) {
    requestGracefulAppQuit(reason);
    return;
  }

  const window = mainWindow;
  if (!isMainRendererAvailable()) {
    nativeQuitConfirmationPromise ??= showDesktopConfirmDialog(`Quit ${APP_DISPLAY_NAME}?`, null)
      .catch((error) => {
        console.warn("[desktop] Failed to confirm app quit", error);
        return false;
      })
      .finally(() => {
        nativeQuitConfirmationPromise = null;
      });
    if (await nativeQuitConfirmationPromise) requestGracefulAppQuit(reason);
    return;
  }
  const presentation = quitConfirmationPresentationForPlatform();
  const allowed = await runningChatsQuitGuard.askRenderer({
    send: (request) => {
      if (!isMainRendererAvailable() || !window) {
        throw new Error("Renderer unavailable.");
      }
      showDesktopQuitConfirmationWindow(window, {
        background: isBackgroundDesktopLaunch(process.argv),
      });
      window.webContents.send(IPC.quitConfirmationRequest, request);
    },
    isRendererAvailable: isMainRendererAvailable,
    presentation,
  });
  if (!allowed) {
    writeDesktopLogHeader(`${reason} stayed because chats are still running`);
    return;
  }
  requestGracefulAppQuit(reason);
}

function ownMacAppBundlePath(): string {
  return Path.resolve(process.execPath, "..", "..", "..");
}

/**
 * Team id of the running app's signature, used to verify a downloaded beta
 * bundle before it is installed. Unsigned builds (dev, local, demo) yield
 * "not set" or a "not signed" exit — the install then skips the check. Any
 * other lookup failure on a packaged app resolves to "unavailable" so the
 * installer fails closed instead of silently skipping verification; a lookup
 * failure must never break startup.
 */
function ownAppTeamId(): ExpectedTeamId {
  if (process.platform !== "darwin" || !app.isPackaged) return null;
  try {
    const result = ChildProcess.spawnSync(
      "codesign",
      ["-dv", "--verbose=4", ownMacAppBundlePath()],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
      return /not signed|unsigned/i.test(output) ? null : "unavailable";
    }
    const teamId = /^TeamIdentifier=(\S+)$/m.exec(result.stderr ?? "")?.[1];
    if (teamId === undefined) return "unavailable";
    return teamId === "not set" ? null : teamId;
  } catch {
    return "unavailable";
  }
}

/** Only ever trash the packaged beta bundle this process runs from. */
function isTrashableBetaBundle(): boolean {
  return (
    desktopFlavor === "beta" &&
    process.platform === "darwin" &&
    app.isPackaged &&
    Path.basename(ownMacAppBundlePath()) === `${APP_DISPLAY_NAME}.app`
  );
}

function requestGracefulAppQuit(reason: string): void {
  if (isUpdaterInstallPreparing) {
    deferDesktopQuitUntilUpdaterSettles(reason);
    return;
  }

  void runAfterDesktopShutdown(shutdownDesktopRuntime(reason), () => app.quit()).catch(
    (error: unknown) => {
      captureSentryException(new Error("Moss desktop shutdown failed"), {
        errorSource: "desktop-shutdown",
        reason: reason.slice(0, 120),
        errorClass: error instanceof Error ? error.name.slice(0, 96) : "UnknownError",
      });
      void flushSentry();
      const message = formatErrorMessage(error);
      writeDesktopLogHeader(`${reason} shutdown failed message=${message}`);
      console.warn(`[desktop] Shutdown failed during ${reason}: ${message}`);
      app.exit(1);
    },
  );
}

function registerIpcHandlers(): void {
  const registerIpcHandle = (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown,
  ): void => {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return await handler(event, ...args);
      } catch (error) {
        // IPC handlers intentionally rethrow so the renderer keeps its native
        // rejection contract; the static event gives Sentry a safe signal for
        // failures that callers handle instead of letting them escape globally.
        captureSentryException(new Error("Moss desktop IPC handler failed"), {
          errorSource: "desktop-ipc",
          channel: channel.slice(0, 120),
          errorClass: error instanceof Error ? error.name.slice(0, 96) : "UnknownError",
        });
        throw error;
      }
    });
  };

  const storageSnapshotPath = resolveMossStorageSnapshotPath(app.getPath("userData"));

  ipcMain.removeAllListeners(IPC.betaDiagnostics.enabled);
  ipcMain.on(IPC.betaDiagnostics.enabled, (event: IpcMainEvent) => {
    event.returnValue = Boolean(
      betaDiagnostics &&
      event.sender === mainWindow?.webContents &&
      event.senderFrame === event.sender.mainFrame,
    );
  });

  ipcMain.removeAllListeners(IPC.browser.webMcpCompatibilityPolicy);
  ipcMain.on(IPC.browser.webMcpCompatibilityPolicy, (event: IpcMainEvent) => {
    event.returnValue = browserManager.isWebMcpCompatibilityAllowed(event.sender.id);
  });

  ipcMain.removeAllListeners(IPC.storageMigration.read);
  ipcMain.on(IPC.storageMigration.read, (event: IpcMainEvent) => {
    event.returnValue = readMossStorageSnapshot(storageSnapshotPath);
  });

  ipcMain.removeHandler(IPC.storageMigration.acknowledge);
  registerIpcHandle(IPC.storageMigration.acknowledge, async () => {
    await acknowledgeMossStorageSnapshot(storageSnapshotPath);
  });

  ipcMain.removeAllListeners(IPC.wsUrl);
  ipcMain.on(IPC.wsUrl, (event: IpcMainEvent) => {
    // The backend port is reserved at runtime, so preload asks main for the
    // live URL instead of trusting build-time or inherited renderer env.
    event.returnValue =
      normalizeDesktopWsUrl(backendWsUrl) ?? resolveDesktopWsUrlFromEnv(process.env);
  });

  ipcMain.removeAllListeners(IPC.zoomFactor);
  ipcMain.on(IPC.zoomFactor, (event: IpcMainEvent) => {
    event.returnValue = event.sender.getZoomFactor();
  });

  ipcMain.removeAllListeners(IPC.pluginDeepLinks.subscribe);
  ipcMain.on(IPC.pluginDeepLinks.subscribe, (event: IpcMainEvent) => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender.id !== window.webContents.id
    ) {
      return;
    }

    // A new preload/router subscription supersedes an attempt that may have
    // been lost during reload. The canonical route remains queued.
    pluginDeepLinkAckWatchdog.clear();
    pluginDeepLinkNavigationQueue.cancelInFlightDelivery();
    pluginDeepLinkSubscriberWebContentsId = event.sender.id;
    resetPluginDeepLinkRetry();
    flushPendingPluginDeepLinkNavigation();
  });

  ipcMain.removeAllListeners(IPC.pluginDeepLinks.unsubscribe);
  ipcMain.on(IPC.pluginDeepLinks.unsubscribe, (event: IpcMainEvent) => {
    if (pluginDeepLinkSubscriberWebContentsId !== event.sender.id) {
      return;
    }
    pluginDeepLinkSubscriberWebContentsId = null;
    pluginDeepLinkAckWatchdog.clear();
    pluginDeepLinkNavigationQueue.cancelInFlightDelivery();
    clearPluginDeepLinkRetryTimer();
  });

  ipcMain.removeAllListeners(IPC.pluginDeepLinks.result);
  ipcMain.on(IPC.pluginDeepLinks.result, (event: IpcMainEvent, value: unknown) => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender.id !== window.webContents.id ||
      pluginDeepLinkSubscriberWebContentsId !== event.sender.id ||
      !isDesktopPluginDeepLinkNavigationResult(value)
    ) {
      return;
    }

    const delivery = pluginDeepLinkNavigationQueue.getInFlightDelivery(value.deliveryId);
    if (!delivery) {
      return;
    }
    pluginDeepLinkAckWatchdog.clear(value.deliveryId);
    if (!pluginDeepLinkNavigationQueue.settleDelivery(value.deliveryId, value.accepted)) {
      return;
    }
    lastPluginDeepLinkAudit = {
      deliveryIdSha256: Crypto.createHash("sha256").update(delivery.deliveryId).digest("hex"),
      coldStart: delivery.coldStart,
      source: delivery.source,
      rendererAcknowledged: value.accepted,
    };
    writeDesktopLogHeader(
      `Moss plugin deep-link renderer result source=${delivery.source} coldStart=${delivery.coldStart} accepted=${value.accepted} deliverySha256=${lastPluginDeepLinkAudit.deliveryIdSha256}`,
    );
    if (!value.accepted) {
      writeDesktopLogHeader("Moss plugin deep-link renderer navigation deferred for retry");
      schedulePluginDeepLinkRetry();
      return;
    }

    resetPluginDeepLinkRetry();
    writeDesktopLogHeader("Moss plugin deep-link renderer navigation acknowledged");
    focusDesktopWindow(window);
    flushPendingPluginDeepLinkNavigation();
  });

  ipcMain.removeHandler(IPC.pluginDeepLinks.getLastAudit);
  registerIpcHandle(IPC.pluginDeepLinks.getLastAudit, (event) => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender.id !== window.webContents.id
    ) {
      return null;
    }
    return lastPluginDeepLinkAudit;
  });

  ipcMain.removeAllListeners(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.subscribe);
  ipcMain.on(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.subscribe, (event: IpcMainEvent) => {
    const window = mainWindow;
    if (
      !window ||
      window.isDestroyed() ||
      window.webContents.isDestroyed() ||
      event.sender.id !== window.webContents.id
    ) {
      return;
    }

    connectorOAuthSubscriberWebContentsId = event.sender.id;
    flushConnectorOAuthCallbacks();
  });

  ipcMain.removeAllListeners(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.unsubscribe);
  ipcMain.on(CONNECTOR_OAUTH_CALLBACK_IPC_CHANNELS.unsubscribe, (event: IpcMainEvent) => {
    if (connectorOAuthSubscriberWebContentsId === event.sender.id) {
      connectorOAuthSubscriberWebContentsId = null;
    }
  });

  ipcMain.removeHandler(IPC.pickFolder);
  registerIpcHandle(IPC.pickFolder, async () => {
    const owner = resolveMenuTargetWindow();
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          properties: ["openDirectory", "createDirectory"],
        })
      : await dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.removeHandler(IPC.saveFile);
  registerIpcHandle(IPC.saveFile, async (_event, input: unknown) => {
    if (!isSaveFileInput(input)) {
      throw new Error("Invalid save file input.");
    }

    const owner = resolveMenuTargetWindow();
    const options = {
      defaultPath: input.defaultFilename,
      ...(input.filters ? { filters: input.filters } : {}),
    };
    const result = owner
      ? await dialog.showSaveDialog(owner, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    await FS.promises.writeFile(result.filePath, input.contents, "utf8");
    return result.filePath;
  });

  ipcMain.removeHandler(IPC.confirm);
  registerIpcHandle(IPC.confirm, async (_event, message: unknown) => {
    if (typeof message !== "string") {
      return false;
    }

    const owner = resolveMenuTargetWindow();
    return showDesktopConfirmDialog(message, owner, desktopUiLocale);
  });

  ipcMain.removeAllListeners(IPC.quitConfirmationResponse);
  ipcMain.on(IPC.quitConfirmationResponse, (_event, payload: unknown) => {
    runningChatsQuitGuard.receiveResponse(payload);
  });

  ipcMain.removeHandler(IPC.setMenuShortcuts);
  ipcMain.handle(IPC.setMenuShortcuts, (_event, rawShortcuts: unknown) => {
    const accelerators = resolveReportedMenuAccelerators(rawShortcuts, process.platform);
    if (!accelerators || sameDesktopMenuAccelerators(accelerators, desktopMenuAccelerators)) return;
    desktopMenuAccelerators = accelerators;
    if (app.isReady()) configureApplicationMenu();
  });

  ipcMain.removeHandler(IPC.setTheme);
  registerIpcHandle(IPC.setTheme, async (_event, rawTheme: unknown) => {
    const theme = getSafeTheme(rawTheme);
    if (!theme) {
      return;
    }

    nativeTheme.themeSource = theme;
  });

  ipcMain.removeHandler(IPC.setWindowMaterial);
  ipcMain.handle(IPC.setWindowMaterial, (event, rawInput: unknown) => {
    const input = parseDesktopWindowMaterial(rawInput);
    const window = BrowserWindow.fromWebContents(event.sender);
    if (process.platform !== "darwin" || !input || !window) return false;
    return applyWindowMaterial(window, input);
  });
  ipcMain.removeHandler(IPC.setUiLocale);
  registerIpcHandle(IPC.setUiLocale, async (_event, rawLocale: unknown) => {
    if (rawLocale !== "en" && rawLocale !== "zh-CN") {
      return;
    }
    const locale: DesktopUiLocale = rawLocale;
    try {
      await desktopUiLocalePersistence.update(locale);
    } catch {
      console.warn("[desktop] Could not save the UI locale for the next launch.");
    }
  });

  ipcMain.removeHandler(IPC.setDockIconPreference);
  registerIpcHandle(IPC.setDockIconPreference, async (_event, rawPreference: unknown) => {
    // Older renderers still call this macOS-only bridge. Converge that choice
    // into the same durable authority used by get/setAppIcon so restart behavior
    // is deterministic and the two IPC paths cannot drift.
    const preference = normalizeDockIconPreference(rawPreference);
    updateDesktopAppIcon(desktopAppIconFromDockPreference(preference));
  });

  ipcMain.removeHandler(IPC.getAppIcon);
  registerIpcHandle(IPC.getAppIcon, () => readDesktopAppIcon());

  ipcMain.removeHandler(IPC.setAppIcon);
  const enqueueDesktopAppIconApply = createExclusiveApplyQueue(async (icon: DesktopAppIcon) => {
    const shouldPersist = shouldUpdateDesktopAppIcon(readDesktopAppIcon(), icon);
    if (shouldPersist) persistDesktopAppIcon(icon);
    // Renderer hydration mirrors this native preference. Explicit clicks on
    // macOS/Windows can retry a failed shell update even if the choice is saved.
    if (!shouldPersist && process.platform !== "win32" && process.platform !== "darwin") return;
    await applyDesktopAppIcon(icon, mainWindow, { flushShellIconCache: true });
  });
  ipcMain.handle(IPC.setAppIcon, async (_event, rawIcon: unknown) => {
    if (!isDesktopAppIcon(rawIcon) || (rawIcon === "beta" && desktopFlavor !== "beta")) return;
    await enqueueDesktopAppIconApply(rawIcon);
  });

  ipcMain.removeHandler(IPC.applicationMenu);
  registerIpcHandle(IPC.applicationMenu, async (event, menuId: unknown, position: unknown) => {
    const target = mainWindow;
    if (
      !target ||
      target.isDestroyed() ||
      event.sender !== target.webContents ||
      typeof menuId !== "string" ||
      !["file", "edit", "view", "help"].includes(menuId) ||
      !position ||
      typeof position !== "object" ||
      !("x" in position) ||
      !("y" in position) ||
      typeof position.x !== "number" ||
      typeof position.y !== "number" ||
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.y)
    )
      return;
    const menu = Menu.getApplicationMenu()?.getMenuItemById(`moss-${menuId}`)?.submenu;
    if (!menu) return;
    const [width = 0, height = 0] = target.getContentSize();
    const zoom = target.webContents.getZoomFactor();
    const x = Math.min(width, Math.max(0, Math.floor(position.x * zoom)));
    const y = Math.min(height, Math.max(0, Math.floor(position.y * zoom)));
    await new Promise<void>((resolve) =>
      menu.popup({
        window: target,
        x,
        y,
        callback: resolve,
      }),
    );
  });

  ipcMain.removeHandler(IPC.contextMenu);
  registerIpcHandle(
    IPC.contextMenu,
    async (_event, items: unknown, position?: { x: number; y: number }) => {
      const normalizedItems = normalizeContextMenuItems(items);
      if (normalizedItems.length === 0) {
        return null;
      }

      const popupPosition =
        position &&
        Number.isFinite(position.x) &&
        Number.isFinite(position.y) &&
        position.x >= 0 &&
        position.y >= 0
          ? {
              x: Math.floor(position.x),
              y: Math.floor(position.y),
            }
          : null;

      const window = resolveMenuTargetWindow();
      if (!window) return null;

      return new Promise<string | null>((resolve) => {
        const settle = createContextMenuOneShotResolver(resolve);
        const template = buildContextMenuTemplate(normalizedItems, {
          translateLabel: (label) => translateNativeMenuLabel(label, desktopUiLocale),
          onLeafSelected: settle,
          destructiveIcon: getDestructiveMenuIcon(),
          resolveIcon: resolveContextMenuIcon,
          resolveShortcut: resolveContextMenuShortcut,
        });
        if (template.length === 0) {
          settle(null);
          return;
        }

        try {
          const menu = buildLocalizedNativeMenu(template);
          menu.popup({
            window,
            ...popupPosition,
            callback: () => settle(null),
          });
        } catch {
          settle(null);
        }
      });
    },
  );

  async function openMossCanvasDesktopApp(): Promise<boolean> {
    try {
      return await bundledMossCanvas.open();
    } catch {
      writeDesktopLogHeader("Moss Canvas workspace could not be opened");
      return false;
    }
  }

  ipcMain.removeHandler(IPC.openExternal);
  registerIpcHandle(IPC.openExternal, async (_event, rawUrl: unknown) => {
    const externalUrl = getSafeExternalUrl(rawUrl);
    if (!externalUrl) {
      return false;
    }

    try {
      if (isMossGoogleOAuthExternalUrl(externalUrl, process.env.MOSS_SUPABASE_GOOGLE_URL)) {
        // Development builds can coexist with another Moss (Dev), and macOS
        // lets the most recently registered bundle steal the shared `moss:`
        // callback. Refresh this exact app's claim immediately before opening
        // the verified Moss Google authorization URL.
        registerMossAuthCallbackProtocolClient();
      }
      await shell.openExternal(externalUrl);
      return true;
    } catch {
      return false;
    }
  });

  ipcMain.removeHandler(IPC.openMossCanvasApp);
  registerIpcHandle(IPC.openMossCanvasApp, async (_event, _input: unknown) => {
    return await openMossCanvasDesktopApp();
  });

  ipcMain.removeHandler(IPC.clipboardWriteImage);
  registerIpcHandle(IPC.clipboardWriteImage, async (_event, rawDataUrl: unknown) => {
    if (typeof rawDataUrl !== "string") {
      return false;
    }
    if (rawDataUrl.length > MAX_CLIPBOARD_IMAGE_DATA_URL_LENGTH) {
      return false;
    }

    const dataUrl = rawDataUrl.trim();
    if (!dataUrl.startsWith("data:image/png;base64,")) {
      return false;
    }

    const image = nativeImage.createFromDataURL(dataUrl);
    if (image.isEmpty()) {
      return false;
    }

    clipboard.writeImage(image);
    return true;
  });

  ipcMain.removeHandler(IPC.showInFolder);
  registerIpcHandle(IPC.showInFolder, async (_event, rawPath: unknown) => {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new Error("Missing folder path.");
    }
    const resolvedPath = Path.resolve(rawPath);

    let stats: FS.Stats;
    try {
      stats = await FS.promises.stat(resolvedPath);
    } catch {
      throw new Error(`Folder not found: ${resolvedPath}`);
    }

    await showInFileManager(resolvedPath, stats.isDirectory(), process.platform, shell);
  });

  ipcMain.removeHandler(IPC.windowMinimize);
  registerIpcHandle(IPC.windowMinimize, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    window?.minimize();
  });

  ipcMain.removeHandler(IPC.windowToggleMaximize);
  registerIpcHandle(IPC.windowToggleMaximize, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    if (!window) {
      return { isMaximized: false, isFullscreen: false };
    }
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    const state = getDesktopWindowState(window);
    window.webContents.send(IPC.windowState, state);
    return state;
  });

  ipcMain.removeHandler(IPC.windowClose);
  registerIpcHandle(IPC.windowClose, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    window?.close();
  });

  ipcMain.removeHandler(IPC.windowGetState);
  registerIpcHandle(IPC.windowGetState, async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
    return window ? getDesktopWindowState(window) : { isMaximized: false, isFullscreen: false };
  });

  ipcMain.removeHandler(IPC.customTitleBarGetState);
  registerIpcHandle(IPC.customTitleBarGetState, async () => getDesktopCustomTitleBarState());

  ipcMain.removeHandler(IPC.customTitleBarSetPreference);
  registerIpcHandle(IPC.customTitleBarSetPreference, async (_event, rawEnabled: unknown) => {
    if (typeof rawEnabled !== "boolean") {
      return getDesktopCustomTitleBarState();
    }
    const state = getDesktopCustomTitleBarState();
    if (!state.supported) {
      return state;
    }
    writeCustomTitleBarPreference(DESKTOP_CUSTOM_TITLE_BAR_PATH, rawEnabled);
    return getDesktopCustomTitleBarState();
  });

  ipcMain.removeHandler(IPC.customTitleBarRelaunch);
  registerIpcHandle(IPC.customTitleBarRelaunch, async () => {
    app.relaunch();
    requestGracefulAppQuit("custom-title-bar-relaunch");
  });

  ipcMain.removeHandler(IPC.computerSetCursorStyle);
  ipcMain.handle(IPC.computerSetCursorStyle, async (_event, rawStyle: unknown) => {
    // The renderer's mirrored value is the authority for this preference: the
    // normalized style is persisted first, so even a failed live push leaves
    // the next generation correct. Stock removes the stored override.
    const style = normalizeAgentCursorStylePreference(rawStyle);
    writeAgentCursorPreference(AGENT_CURSOR_PREFERENCE_PATH, style);
    if (cuaDriverHost) {
      await cuaDriverHost.setCursorStyle(style).catch((error: unknown) => {
        safeConsoleError("[desktop] live cursor style push failed", error);
      });
    }
  });

  ipcMain.removeAllListeners(IPC.computerPreviewSubscribe);
  ipcMain.on(IPC.computerPreviewSubscribe, (event: IpcMainEvent) => {
    const sender = event.sender;
    // Frames are only ever sent to the main window; other renderers cannot
    // consume them and must not keep the capture helper alive.
    if (
      computerPreviewSubscribers.has(sender.id) ||
      !mainWindow ||
      mainWindow.isDestroyed() ||
      mainWindow.webContents.id !== sender.id
    ) {
      return;
    }
    // A closed or reloaded window must not keep the capture helper alive.
    const release = () => {
      sender.off("destroyed", release);
      sender.off("did-navigate", release);
      if (computerPreviewSubscribers.get(sender.id) !== release) return;
      computerPreviewSubscribers.delete(sender.id);
      syncComputerFrameTapDemand();
    };
    sender.once("destroyed", release);
    sender.once("did-navigate", release);
    computerPreviewSubscribers.set(sender.id, release);
    syncComputerFrameTapDemand();
  });
  ipcMain.removeAllListeners(IPC.computerPreviewUnsubscribe);
  ipcMain.on(IPC.computerPreviewUnsubscribe, (event: IpcMainEvent) => {
    computerPreviewSubscribers.get(event.sender.id)?.();
  });

  ipcMain.removeHandler(IPC.audioLevel.setSource);
  ipcMain.handle(
    IPC.audioLevel.setSource,
    async (event, rawSource: unknown, rawMicrophoneId: unknown) => {
      // Authoritative gate: macOS only; channel availability follows the shared feature list.
      if (
        process.platform !== "darwin" ||
        !isBetaFeatureEnabled(AUDIO_TRAIL_BETA_FEATURE, desktopFlavor)
      ) {
        return "unsupported";
      }
      const sender = event.sender;
      const source =
        rawSource === "system" || rawSource === "microphone" || rawSource === "both"
          ? rawSource
          : null;
      const microphoneId =
        typeof rawMicrophoneId === "string" &&
        rawMicrophoneId.length > 0 &&
        rawMicrophoneId.length <= MAX_MICROPHONE_ID_LENGTH
          ? rawMicrophoneId
          : null;
      audioLevelMonitor ??= new AudioLevelMonitor({
        helperPath: resolveAppSnapHelperPath(),
        onLevel: (level) => {
          for (const { contents } of audioLevelSubscribers.values()) {
            if (!contents.isDestroyed()) contents.send(IPC.audioLevel.level, level);
          }
        },
        onError: (message) => safeConsoleError(`[desktop] Audio level: ${message}`),
      });
      if (source && !audioLevelSubscribers.has(sender.id)) {
        // A closed or reloaded window must not keep the audio tap or microphone alive.
        const release = () => {
          sender.off("destroyed", release);
          sender.off("did-navigate", release);
          audioLevelSubscribers.delete(sender.id);
          audioLevelMonitor?.setSubscription(sender.id, null);
        };
        sender.once("destroyed", release);
        sender.once("did-navigate", release);
        audioLevelSubscribers.set(sender.id, { contents: sender, release });
      } else if (!source) {
        audioLevelSubscribers.get(sender.id)?.release();
      }
      return audioLevelMonitor.setSubscription(sender.id, source, microphoneId);
    },
  );

  ipcMain.removeHandler(IPC.audioLevel.listMicrophones);
  ipcMain.handle(IPC.audioLevel.listMicrophones, async () => {
    if (
      process.platform !== "darwin" ||
      !isBetaFeatureEnabled(AUDIO_TRAIL_BETA_FEATURE, desktopFlavor)
    ) {
      return [];
    }
    return listAudioInputDevices(resolveAppSnapHelperPath());
  });

  const betaChannel = new DesktopBetaChannel({
    platform: process.platform,
    homeDir: OS.homedir(),
    betaHomeDir: resolveBetaHomeDir(),
    flavor:
      desktopFlavor === "beta"
        ? "beta"
        : desktopFlavor === "canary"
          ? "canary"
          : desktopFlavor === "cua"
            ? "cua"
            : "production",
    feedUrlOverride: process.env.MOSS_BETA_FEED_URL,
    installDirOverride: process.env.MOSS_BETA_INSTALL_DIR,
    expectedTeamId: ownAppTeamId(),
    betaUserDataDir: process.env.MOSS_BETA_USER_DATA,
    stableExecutablePath: desktopFlavor === "production" ? process.execPath : undefined,
    stableHomeDir: desktopFlavor === "production" ? BASE_DIR : undefined,
    canTrashOwnBundle: isTrashableBetaBundle(),
  });

  ipcMain.removeHandler(IPC.beta.getState);
  ipcMain.handle(IPC.beta.getState, async () => betaChannel.getState());

  ipcMain.removeHandler(IPC.beta.install);
  ipcMain.handle(IPC.beta.install, async () => betaChannel.install());

  ipcMain.removeHandler(IPC.beta.launch);
  ipcMain.handle(IPC.beta.launch, async () => betaChannel.launch());

  ipcMain.removeHandler(IPC.beta.importAndLaunch);
  ipcMain.handle(IPC.beta.importAndLaunch, async () => betaChannel.importAndLaunch(BASE_DIR));

  ipcMain.removeHandler(IPC.beta.leave);
  ipcMain.handle(IPC.beta.leave, async (_event, rawInput: unknown) => {
    const result = await betaChannel.leave();
    if (!result.ok) return result;
    const moveToTrash =
      typeof rawInput === "object" &&
      rawInput !== null &&
      (rawInput as { moveToTrash?: unknown }).moveToTrash === true;
    if (moveToTrash && isTrashableBetaBundle()) {
      try {
        await shell.trashItem(ownMacAppBundlePath());
      } catch (error) {
        return {
          ok: false,
          error: "internal" as const,
          message: `Moss is open, but Moss Beta could not be moved to the Trash: ${formatErrorMessage(error)}`,
        };
      }
    }
    trackBetaDiagnostics("beta.left", {
      kind: "beta",
      outcome: moveToTrash && isTrashableBetaBundle() ? "trash" : "keep",
    });
    // The quit path flushes queued events via dispose() with the bounded
    // timeout; the event above is already queued by then.
    setImmediate(() => requestGracefulAppQuit("beta-leave"));
    return result;
  });

  ipcMain.removeHandler(IPC.updateGetState);
  registerIpcHandle(IPC.updateGetState, async () => updateState);

  ipcMain.removeHandler(IPC.updateCheck);
  registerIpcHandle(IPC.updateCheck, async () => {
    await checkForUpdates("renderer");
    return updateState;
  });

  ipcMain.removeHandler(IPC.updateDownload);
  registerIpcHandle(IPC.updateDownload, async () => {
    const result = await downloadAvailableUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(IPC.updateInstall);
  registerIpcHandle(IPC.updateInstall, async () => {
    if (isQuitting) {
      return {
        accepted: false,
        completed: false,
        state: updateState,
      } satisfies DesktopUpdateActionResult;
    }
    const result = await installDownloadedUpdate();
    return {
      accepted: result.accepted,
      completed: result.completed,
      state: updateState,
    } satisfies DesktopUpdateActionResult;
  });

  ipcMain.removeHandler(IPC.notificationsIsSupported);
  registerIpcHandle(IPC.notificationsIsSupported, async () => Notification.isSupported());

  ipcMain.removeHandler(IPC.notificationsShow);
  registerIpcHandle(
    IPC.notificationsShow,
    async (
      _event,
      input:
        | {
            title?: unknown;
            body?: unknown;
            silent?: unknown;
            suppressWhenForeground?: unknown;
            threadId?: unknown;
          }
        | null
        | undefined,
    ) =>
      showDesktopNotification({
        title: typeof input?.title === "string" ? input.title : "",
        body: typeof input?.body === "string" ? input.body : "",
        silent: input?.silent === true,
        suppressWhenForeground: input?.suppressWhenForeground === true,
        ...(typeof input?.threadId === "string" ? { threadId: input.threadId } : {}),
      }),
  );
  if (appSnapManager) {
    registerAppSnapIpcHandlers(ipcMain, appSnapManager, {
      openPermissionSettingsPane: (pane) => {
        const paneUrl = APP_SNAP_SETTINGS_PANE_URLS[pane];
        if (!paneUrl) return Promise.resolve(false);
        return shell
          .openExternal(paneUrl)
          .then(() => true)
          .catch(() => false);
      },
      restartApp: () => {
        app.relaunch();
        requestGracefulAppQuit("appsnap-permission-relaunch");
      },
    });
  }
  ipcMain.removeHandler(IPC.realtimeVoice.setGlobalShortcut);
  registerIpcHandle(
    IPC.realtimeVoice.setGlobalShortcut,
    async (_event, shortcut: unknown) =>
      realtimeVoiceShortcutManager?.setShortcut(shortcut) ?? {
        registered: false,
        shortcut: null,
        reason: "Global shortcut registration is unavailable.",
      },
  );
  ipcMain.removeHandler(IPC.realtimeVoice.captureScreenContext);
  registerIpcHandle(IPC.realtimeVoice.captureScreenContext, async () => {
    if (!appSnapManager) throw new Error("Screen context is unavailable in this desktop build.");
    return appSnapManager.captureNow();
  });
  ipcMain.removeAllListeners(IPC.realtimeVoice.ownerSubscribe);
  ipcMain.on(IPC.realtimeVoice.ownerSubscribe, (event, kind: unknown) => {
    const owner = mainWindow;
    if (
      !owner ||
      owner.isDestroyed() ||
      owner.webContents.isDestroyed() ||
      event.sender.id !== owner.webContents.id ||
      (kind !== "toggle" && kind !== "command")
    ) {
      return;
    }
    realtimeVoiceOwnerMessages.subscribe(kind);
    flushPendingRealtimeVoiceOwnerMessages();
  });
  ipcMain.removeAllListeners(IPC.realtimeVoice.ownerUnsubscribe);
  ipcMain.on(IPC.realtimeVoice.ownerUnsubscribe, (event, kind: unknown) => {
    const owner = mainWindow;
    if (
      !owner ||
      owner.isDestroyed() ||
      owner.webContents.isDestroyed() ||
      event.sender.id !== owner.webContents.id ||
      (kind !== "toggle" && kind !== "command")
    ) {
      return;
    }
    realtimeVoiceOwnerMessages.unsubscribe(kind);
  });
  ipcMain.removeHandler(IPC.realtimeVoice.overlayPublish);
  registerIpcHandle(IPC.realtimeVoice.overlayPublish, async (event, publication: unknown) => {
    const owner = mainWindow;
    if (
      !owner ||
      owner.isDestroyed() ||
      owner.webContents.isDestroyed() ||
      event.sender.id !== owner.webContents.id
    ) {
      throw new Error("Only the main Realtime Voice renderer may publish overlay state.");
    }
    if (!realtimeVoiceOverlayState.update(publication)) {
      throw new Error("Invalid Realtime Voice overlay state.");
    }
    applyRealtimeVoiceOverlayPresentation();
  });
  ipcMain.removeHandler(IPC.realtimeVoice.overlayGetState);
  registerIpcHandle(IPC.realtimeVoice.overlayGetState, async (event) => {
    const overlay = realtimeVoiceOverlayWindow;
    if (
      !overlay ||
      overlay.isDestroyed() ||
      overlay.webContents.isDestroyed() ||
      event.sender.id !== overlay.webContents.id
    ) {
      throw new Error("Realtime Voice overlay state is unavailable to this renderer.");
    }
    return realtimeVoiceOverlayRendererState();
  });
  ipcMain.removeHandler(IPC.realtimeVoice.overlaySendCommand);
  registerIpcHandle(IPC.realtimeVoice.overlaySendCommand, async (event, request: unknown) => {
    const overlay = realtimeVoiceOverlayWindow;
    const commandRequest = normalizeDesktopRealtimeVoiceOverlayCommandRequest(request);
    const presentation = realtimeVoiceOverlayState.current;
    if (
      !overlay ||
      overlay.isDestroyed() ||
      overlay.webContents.isDestroyed() ||
      event.sender.id !== overlay.webContents.id ||
      !commandRequest ||
      (commandRequest.command === "handoff" &&
        realtimeVoiceOverlayPointerDrag?.hasMoved === true) ||
      !isDesktopRealtimeVoiceOverlayCommandRequestCurrent(
        commandRequest,
        presentation,
        realtimeVoiceOverlayVisibleRevisionFloor,
      ) ||
      !shouldShowDesktopRealtimeVoiceOverlay(presentation.snapshot)
    ) {
      return false;
    }
    if (commandRequest.command === "handoff") clearRealtimeVoiceOverlayPointerDrag();
    return dispatchRealtimeVoiceOverlayCommand(
      commandRequest.command,
      commandRequest.generation,
      commandRequest.revision,
    );
  });
  ipcMain.removeAllListeners(REALTIME_VOICE_OVERLAY_POINTER_DRAG_IPC_CHANNEL);
  ipcMain.on(REALTIME_VOICE_OVERLAY_POINTER_DRAG_IPC_CHANNEL, (event, value: unknown) => {
    const overlay = realtimeVoiceOverlayWindow;
    const pointerDragEvent = normalizeDesktopRealtimeVoiceOverlayPointerDragEvent(value);
    if (
      !pointerDragEvent ||
      !overlay ||
      overlay.isDestroyed() ||
      overlay.webContents.isDestroyed() ||
      event.sender.id !== overlay.webContents.id ||
      !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
    ) {
      return;
    }
    handleRealtimeVoiceOverlayPointerDrag(overlay, pointerDragEvent);
  });
  ipcMain.removeAllListeners(IPC.realtimeVoice.overlayPointerInteractivity);
  ipcMain.on(IPC.realtimeVoice.overlayPointerInteractivity, (event, interactive: unknown) => {
    const overlay = realtimeVoiceOverlayWindow;
    if (
      typeof interactive !== "boolean" ||
      !overlay ||
      overlay.isDestroyed() ||
      overlay.webContents.isDestroyed() ||
      event.sender.id !== overlay.webContents.id ||
      !shouldShowDesktopRealtimeVoiceOverlay(realtimeVoiceOverlayState.current.snapshot)
    ) {
      return;
    }
    // Renderer pointer transitions are already edge-triggered. Force each of
    // those transitions through to the native window because the main process
    // also performs stationary-cursor synchronization; otherwise the two
    // caches can disagree and leave the first control click passing through.
    setRealtimeVoiceOverlayPointerInteractivity(overlay, interactive, true);
  });
  registerDesktopVoiceTranscriptionHandler(
    {
      ...process.env,
      ...bundledCodexBackendEnv(),
    },
    {
      transcribeViaMossBackend: (input) =>
        requestDesktopBackendVoiceTranscription(input, {
          backendHttpUrl,
          backendAuthToken,
          locale: app.getLocale(),
        }),
    },
  );
  startBrowserPerformanceLogging();
  registerBrowserIpcHandlers(ipcMain, browserManager);
  registerSafariAccessIpc(ipcMain, {
    platform: process.platform,
    systemVersion: process.getSystemVersion(),
    execPath: process.execPath,
    appName: app.getName(),
    isTrustedRenderer: (id) => browserManager.isTrustedRenderer(id),
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (path) => shell.showItemInFolder(path),
  });
  registerBrowserVaultIpc(
    ipcMain,
    browserManager,
    browserVault,
    () => mainWindow?.webContents.send(IPC.browser.vault.changed),
    new BrowserCookieImport(
      Path.join(BASE_DIR, "browser-engine"),
      browserManager,
      async () => browserHostPipeServer?.waitForIdle(),
      async (domains) => {
        if (!browserSessionRestore) throw new Error("Browser session restoration is unavailable.");
        await browserSessionRestore.rememberImport(domains);
      },
    ),
  );
}

function getIconOption(): { icon: string } | Record<string, never> {
  if (process.platform === "darwin") return {}; // macOS uses .icns from app bundle
  if (process.platform !== "linux" && process.platform !== "win32") return {};
  const icon = readDesktopAppIcon();
  const resourceName = desktopAppIconResourceName({
    icon,
    platform: process.platform,
    isDarkAppearance: false,
    isBetaFlavor: desktopFlavor === "beta",
  });
  const iconPath = resolveResourcePath(resourceName);
  if (!iconPath) return {};
  if (process.platform !== "win32") return { icon: iconPath };
  try {
    return { icon: materializeWindowsShellIcon(icon, iconPath) };
  } catch (error) {
    console.warn(
      `[desktop] Failed to materialize Windows window icon: ${formatErrorMessage(error)}`,
    );
    return { icon: iconPath };
  }
}

// macOS backs the shell with window vibrancy, so the window is created transparent
// (`#00000000`) over the vibrancy material. The renderer's translucency settings then swap
// vibrancy for an adjustable desktop blur (see windowMaterial.ts). Windows/Linux have no vibrancy:
// a transparent window there leaves backdrop-filter surfaces bleeding through and, on
// fractional DPI, rendering blurry. So off macOS we create an opaque window and skip the
// macOS-only options. The background tracks the OS light/dark appearance purely to avoid
// a bright flash before the renderer paints — the window is shown only after first paint
// (`show: false`), so this color is not expected to match a custom in-app theme exactly.
function getWindowMaterialOptions(): BrowserWindowConstructorOptions {
  if (process.platform !== "darwin") {
    return { backgroundColor: nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff" };
  }
  return {
    vibrancy: MAC_WINDOW_VIBRANCY,
    // "followWindow" lets macOS drop vibrancy blending to inactive when the
    // window is backgrounded, so WindowServer stops continuously recompositing
    // it. "active" forced full-cost blending even when the app was unfocused.
    visualEffectState: "followWindow",
    backgroundColor: "#00000000",
  };
}

// macOS keeps native traffic lights inset into the renderer's top chrome. Windows and
// Linux can use a frameless shell with renderer-owned minimize/maximize/close controls
// (see Settings → Appearance → Use custom title bar). `frame` is fixed at construction.
function getTitleBarOptions(): BrowserWindowConstructorOptions {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      // Derived from the shared chat-surface header geometry (@synara/shared/desktopChrome)
      // so the native lights and the renderer's leading toggle/arrow controls always share
      // the same vertical center. Tune the height/radius there, never the raw px here.
      trafficLightPosition: getMacTrafficLightPosition(),
    };
  }
  const preference = readCustomTitleBarPreference(DESKTOP_CUSTOM_TITLE_BAR_PATH);
  const frameOptions = resolveDesktopTitleBarFrameOptions({
    platform: process.platform,
    preference,
  });
  customTitleBarActive = "frame" in frameOptions && frameOptions.frame === false;
  return frameOptions;
}

function getDesktopCustomTitleBarState() {
  return resolveDesktopCustomTitleBarState({
    platform: process.platform,
    preference: readCustomTitleBarPreference(DESKTOP_CUSTOM_TITLE_BAR_PATH),
    active: customTitleBarActive,
  });
}

function resolveStartupWindowUrl(): string {
  const background = nativeTheme.shouldUseDarkColors ? "#181818" : "#ffffff";
  const fallbackColor = nativeTheme.shouldUseDarkColors ? "#f5f5f5" : "#262626";
  const iconPath = resolveResourcePath("moss.png");
  const iconDataUrl = iconPath
    ? nativeImage.createFromPath(iconPath).resize({ width: 72, height: 72 }).toDataURL()
    : null;
  const mark = iconDataUrl
    ? `<img src="${iconDataUrl}" width="72" height="72" alt="Moss" />`
    : `<span>Moss</span>`;
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />
    <meta name="color-scheme" content="light dark" />
    <title>${APP_DISPLAY_NAME}</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; }
      body { display: grid; place-items: center; background: ${background}; color: ${fallbackColor}; font: 600 20px -apple-system, BlinkMacSystemFont, sans-serif; }
      img { display: block; border-radius: 16px; }
    </style>
  </head>
  <body>${mark}</body>
</html>`;
  return `data:text/html;charset=UTF-8,${encodeURIComponent(html)}`;
}

function loadWindowApp(
  window: BrowserWindow,
  options: { readonly suppressInitialShow?: boolean; readonly background?: boolean } = {},
): void {
  if (window.isDestroyed() || appContentLoadedWindows.has(window)) {
    return;
  }
  appContentLoadedWindows.add(window);

  const callbackRouteAtLoadStart = pendingMossAuthCallbackRoute;
  const appUrl = callbackRouteAtLoadStart
    ? buildMossAuthCallbackRendererUrl(resolveRendererAppEntryUrl(), callbackRouteAtLoadStart)
    : resolveRendererAppEntryUrl();
  void window
    .loadURL(appUrl)
    .then(() => {
      appRendererReadyWindows.add(window);
      // `ready-to-show` can be missed by a dev restart while Vite and the
      // backend become ready independently. Once the renderer is confirmed
      // loaded, make the same launch geometry visible as a safe fallback.
      if (!options.suppressInitialShow) {
        showDesktopWindowAtLaunchSize(window, options);
      }
      if (callbackRouteAtLoadStart && pendingMossAuthCallbackRoute === callbackRouteAtLoadStart) {
        pendingMossAuthCallbackRoute = null;
        focusDesktopWindow(window);
      }
      flushPendingMossAuthCallback();
      flushPendingPluginDeepLinkNavigation();
    })
    .catch((error) => {
      appContentLoadedWindows.delete(window);
      if (!window.isDestroyed() && !isQuitting) {
        if (callbackRouteAtLoadStart) {
          // Avoid including the callback target (and its authorization code) in logs.
          console.warn("[desktop] Failed to load the renderer authentication callback.");
        } else {
          console.warn(`[desktop] Failed to load renderer at ${appUrl}`, error);
        }
      }
    });
  if (isDevelopment && process.env.MOSS_OPEN_DEVTOOLS === "1") {
    window.webContents.openDevTools({ mode: "detach" });
  }
}

function createWindow(
  options: {
    readonly deferAppLoad?: boolean;
    readonly suppressInitialShow?: boolean;
    readonly background?: boolean;
  } = {},
): BrowserWindow {
  let hasFinishedInitialLoad = false;
  const savedWindowState = readDesktopWindowState(DESKTOP_WINDOW_STATE_PATH);
  const primaryDisplay = screen.getPrimaryDisplay();
  const restoredBounds = savedWindowState
    ? resolveVisibleWindowBounds({
        savedBounds: savedWindowState.bounds,
        displayWorkAreas: [
          primaryDisplay.workArea,
          ...screen
            .getAllDisplays()
            .filter((display) => display.id !== primaryDisplay.id)
            .map((display) => display.workArea),
        ],
        minimumWidth: 840,
        minimumHeight: 620,
      })
    : { width: 1100, height: 780 };
  const window = new BrowserWindow({
    ...restoredBounds,
    minWidth: 840,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    ...getIconOption(),
    title: APP_DISPLAY_NAME,
    ...getTitleBarOptions(),
    ...getWindowMaterialOptions(),
    webPreferences: {
      preload: Path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      // Let Chromium throttle renderer timers/rAF when the window is hidden.
      backgroundThrottling: true,
    },
  });
  const windowWebContentsId = window.webContents.id;
  mcpAppSandboxRuntime.attachOwner(window);
  htmlPreviewRuntime.attachOwner(window);
  browserManager.setWindow(window);
  attachDesktopZoomFactorSync(window);
  attachRendererCrashRecovery(window);
  attachDesktopPhysicalZoomShortcuts(window);
  if (betaDiagnostics) {
    attachBetaRendererDiagnostics(window.webContents, betaDiagnostics);
  }

  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (
      htmlPreviewRuntime.handleWillAttachWebview(windowWebContentsId, event, webPreferences, params)
    )
      return;
    if (
      mcpAppSandboxRuntime.handleWillAttachWebview(
        windowWebContentsId,
        event,
        webPreferences,
        params,
        Path.join(__dirname, "mcpSandboxPreload.js"),
      )
    ) {
      return;
    }
    const partition = params.partition;
    if (
      partition === undefined ||
      !hardenBrowserAnnotationWebviewPreferences({
        partition,
        expectedPartition: BROWSER_SESSION_PARTITION,
        preloadPath: annotationGuestPreload,
        webPreferences,
      })
    ) {
      event.preventDefault();
    }
  });

  window.webContents.on("did-attach-webview", (_event, guest) => {
    if (htmlPreviewRuntime.handleDidAttachWebview(windowWebContentsId, guest)) return;
    mcpAppSandboxRuntime.handleDidAttachWebview(windowWebContentsId, guest);
  });

  window.webContents.on("context-menu", (event, params) => {
    event.preventDefault();

    const menuTemplate: MenuItemConstructorOptions[] = [];

    if (params.misspelledWord) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        menuTemplate.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (params.dictionarySuggestions.length === 0) {
        menuTemplate.push({ label: "No suggestions", enabled: false });
      }
      menuTemplate.push({ type: "separator" });
    }

    if (params.mediaType === "image") {
      menuTemplate.push({
        label: "Copy Image",
        click: () => window.webContents.copyImageAt(params.x, params.y),
      });
      menuTemplate.push({ type: "separator" });
    }

    menuTemplate.push(
      { role: "cut", enabled: params.editFlags.canCut },
      { role: "copy", enabled: params.editFlags.canCopy },
      { role: "paste", enabled: params.editFlags.canPaste },
      { role: "selectAll", enabled: params.editFlags.canSelectAll },
    );

    buildLocalizedNativeMenu(menuTemplate).popup({ window });
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = getSafeExternalUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });

  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(APP_DISPLAY_NAME);
  });
  window.webContents.on("did-finish-load", () => {
    hasFinishedInitialLoad = true;
    window.setTitle(APP_DISPLAY_NAME);
    emitUpdateState();
    if (mainWindow === window) flushPendingRealtimeVoiceOwnerMessages();
  });
  window.webContents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument && mainWindow === window) {
      // Navigation destroys the AudioWorklet/WebRTC owner. Never leave a stale
      // auxiliary status surface claiming that the call is still connected.
      // The first hidden load may already have a shortcut toggle queued by the
      // caller that created this owner; later navigations must drop old input.
      withdrawRealtimeVoiceOverlayForOwnerLoss({
        preservePendingToggle: !hasFinishedInitialLoad,
      });
    }
  });
  window.webContents.on("did-start-loading", () => {
    if (pluginDeepLinkSubscriberWebContentsId === window.webContents.id) {
      pluginDeepLinkSubscriberWebContentsId = null;
      pluginDeepLinkAckWatchdog.clear();
      pluginDeepLinkNavigationQueue.cancelInFlightDelivery();
      clearPluginDeepLinkRetryTimer();
    }
  });
  window.once("ready-to-show", () => {
    if (options.suppressInitialShow) {
      if (savedWindowState?.isMaximized) window.maximize();
      return;
    }
    // Preserve Moss's deliberate 1100x780 first-launch geometry, while restoring
    // subsequent window bounds and maximized state from the upstream state store.
    if (!savedWindowState) {
      showDesktopWindowAtLaunchSize(window, options);
      return;
    }
    showDesktopStartupWindow(window, {
      background: options.background ?? false,
      maximized: savedWindowState.isMaximized,
    });
    if (process.platform === "win32") {
      void applyPersistedDesktopAppIcon(window);
    }
    emitDesktopWindowState(window);
  });

  window.on("maximize", () => emitDesktopWindowState(window));
  window.on("unmaximize", () => emitDesktopWindowState(window));
  window.on("enter-full-screen", () => emitDesktopWindowState(window));
  window.on("leave-full-screen", () => emitDesktopWindowState(window));
  if (process.platform === "darwin") {
    guardDesktopWindowClose(
      window,
      `Close the ${APP_DISPLAY_NAME} window?`,
      () =>
        !isQuitting &&
        !desktopShutdownComplete &&
        !isUpdaterQuitAndInstallInFlight &&
        !isUpdaterInstallPreparing,
    );
  }
  window.on("close", (event) => {
    try {
      writeDesktopWindowState(DESKTOP_WINDOW_STATE_PATH, {
        version: 1,
        bounds: window.getNormalBounds(),
        isMaximized: window.isMaximized(),
      });
    } catch (error) {
      console.warn(`[desktop] Failed to persist window state: ${formatErrorMessage(error)}`);
    }

    if (
      shouldDeferDesktopWindowClose({
        platform: process.platform,
        shutdownComplete: desktopShutdownComplete,
        updaterHandoffActive: isUpdaterQuitAndInstallInFlight,
      })
    ) {
      event.preventDefault();
      void confirmRunningChatsThenQuit("window-close");
      return;
    }

    if (
      process.platform === "linux" &&
      !desktopShutdownComplete &&
      !isUpdaterQuitAndInstallInFlight
    ) {
      event.preventDefault();
      void confirmRunningChatsThenQuit("window-close");
    }
  });

  if (options.deferAppLoad) {
    void window.loadURL(resolveStartupWindowUrl());
  } else {
    loadWindowApp(window, options);
  }

  if (process.platform === "linux" || process.platform === "win32") {
    try {
      void applyPersistedDesktopAppIcon(window, { reregisterTaskbarButton: false });
    } catch (error) {
      console.warn(`[desktop] Failed to apply startup app icon: ${formatErrorMessage(error)}`);
    }
  }

  window.on("closed", () => {
    if (connectorOAuthSubscriberWebContentsId === windowWebContentsId) {
      connectorOAuthSubscriberWebContentsId = null;
    }
    if (pluginDeepLinkSubscriberWebContentsId === windowWebContentsId) {
      pluginDeepLinkSubscriberWebContentsId = null;
      pluginDeepLinkAckWatchdog.clear();
      pluginDeepLinkNavigationQueue.cancelInFlightDelivery();
      clearPluginDeepLinkRetryTimer();
    }
    runningChatsQuitGuard.cancelPending();
    if (mainWindow === window) {
      mainWindow = null;
      realtimeVoiceOwnerMessages.resetForOwnerReload();
      // The auxiliary surface never outlives its sole media-owner renderer.
      disposeRealtimeVoiceOverlay();
    }
    browserManager.setWindow(null);
  });

  return window;
}

/**
 * Renderer crashes used to be entirely invisible to the main process: no listener, no
 * log line, no telemetry, and no way back — a renderer OOM kill just left the user
 * staring at a blank window. Recovery is deliberately narrow: only reasons the renderer
 * can actually come back from reload, and only a few times, because a deterministic
 * crash reloading forever is worse than one blank window.
 */
function attachRendererCrashRecovery(window: BrowserWindow): void {
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const clearReloadTimer = (): void => {
    if (reloadTimer === null) return;
    clearTimeout(reloadTimer);
    reloadTimer = null;
  };

  window.webContents.on("render-process-gone", (_event, details) => {
    const description = `reason=${details.reason} exitCode=${details.exitCode}`;
    writeDesktopLogHeader(`renderer process gone ${description}`);
    safeConsoleError(`[desktop] renderer process gone (${description})`);
    // A renderer that dies while hosting the quit-confirmation ask can never
    // answer it — declining would abandon a requested quit and (worse) show
    // the recovery prompt below, leaving a dead-UI app alive forever. Allow
    // the pending ask and count it as quitting for the crash policy.
    const quitAskPending = runningChatsQuitGuard.hasPendingAsk();
    runningChatsQuitGuard.allowPending();
    // A pending quit ask has not started shutdown: an unexpected crash while
    // that ask is open still belongs in diagnostics, even though recovery quits.
    if (!isQuitting && details.reason !== "clean-exit")
      trackBetaDiagnostics("app.renderer-crash", {
        kind: "crash",
        processType: "renderer",
        reason: details.reason,
        // Guarded explicitly: on stable builds betaDiagnostics is null and the
        // log file must not be touched at all.
        logTail: betaDiagnostics
          ? readLogTail(Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME))
          : undefined,
      });
    captureSentryException(new Error("Moss desktop renderer process gone"), {
      errorSource: "desktop-renderer",
      reason: String(details.reason).slice(0, 64),
      exitCode: details.exitCode ?? "none",
    });
    if (mainWindow === window) withdrawRealtimeVoiceOverlayForOwnerLoss();

    const response = rendererCrashPolicy.respondToCrash({
      reason: details.reason,
      quitting: isQuitting || quitAskPending,
      nowMs: Date.now(),
    });

    switch (response.kind) {
      case "ignore":
        return;
      case "reload":
        writeDesktopLogHeader(
          `renderer reload scheduled attempt=${response.attempt}/${RENDERER_MAX_AUTOMATIC_RELOADS} delayMs=${response.delayMs}`,
        );
        clearReloadTimer();
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          if (isQuitting || window.isDestroyed()) return;
          window.webContents.reload();
        }, response.delayMs);
        return;
      case "prompt":
        writeDesktopLogHeader(
          `renderer recovery prompt cause=${response.cause} crashes=${response.crashes}`,
        );
        presentRendererCrashRecovery(window, details.reason, response);
        return;
    }
  });

  // A hung renderer is not a crash — Chromium keeps the process alive — so it never
  // reaches the listener above. Logging both edges makes a freeze that the user
  // reports as "the app died" distinguishable from an actual crash in the same log.
  window.webContents.on("unresponsive", () => {
    captureSentryException(new Error("Moss desktop renderer unresponsive"), {
      errorSource: "desktop-renderer",
      boundary: "unresponsive",
    });
    writeDesktopLogHeader("renderer unresponsive");
  });
  window.webContents.on("responsive", () => {
    writeDesktopLogHeader("renderer responsive");
  });

  window.webContents.on("did-start-loading", () => {
    runningChatsQuitGuard.cancelPending();
  });

  window.on("closed", clearReloadTimer);
}

/**
 * Replaces the blank window with a blocking, actionable one once automatic recovery
 * stops (or was never allowed for this crash reason).
 */
function presentRendererCrashRecovery(
  window: BrowserWindow,
  reason: string,
  response: Extract<RendererCrashResponse, { kind: "prompt" }>,
): void {
  if (isQuitting || rendererCrashDialogInFlight) return;

  const message =
    response.cause === "reload-budget-exhausted"
      ? `Moss's window crashed ${response.crashes} times in a row.`
      : "Moss's window stopped unexpectedly.";
  const detail = [
    `The window's renderer process exited (${reason}).`,
    response.cause === "reload-budget-exhausted"
      ? "Moss paused automatic reloads so a repeating crash can't keep reloading in the background."
      : "This exit reason repeats on reload, so Moss did not retry automatically.",
    `Log file:\n${Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME)}`,
  ].join("\n\n");

  const task = (async () => {
    for (;;) {
      const result = await dialog.showMessageBox({
        type: "error",
        title: "Moss's window stopped",
        message,
        detail,
        buttons: ["Reload", "Open logs", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });

      if (result.response === 1) {
        await openDesktopLogDirectory();
        continue;
      }

      if (result.response === 0) {
        // A user-driven reload is a fresh start, not a continuation of the streak.
        rendererCrashPolicy.reset();
        if (!window.isDestroyed()) {
          window.webContents.reload();
        }
        return;
      }

      requestGracefulAppQuit("renderer crashed");
      return;
    }
  })().finally(() => {
    if (rendererCrashDialogInFlight === task) {
      rendererCrashDialogInFlight = null;
    }
  });
  rendererCrashDialogInFlight = task;
}

function configureMediaPermissions(): void {
  const trustedRendererUrl = resolveRendererAppEntryUrl();
  const resolveTrustedWebContents = () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return null;
    }
    return mainWindow.webContents;
  };

  for (const targetSession of [
    session.defaultSession,
    session.fromPartition(BROWSER_SESSION_PARTITION),
    session.fromPartition(REALTIME_VOICE_OVERLAY_SESSION_PARTITION),
  ]) {
    if (!targetSession) continue;

    targetSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin, details) => {
        if (isClipboardWritePermission(webContents, permission, details, requestingOrigin)) {
          return true;
        }
        if (
          !shouldAllowMediaPermissionCheck({
            permission,
            webContents,
            trustedWebContents: resolveTrustedWebContents(),
            trustedRendererUrl,
            requestingOrigin,
            details,
          })
        ) {
          return false;
        }

        return (
          process.platform !== "darwin" ||
          systemPreferences.getMediaAccessStatus("microphone") === "granted"
        );
      },
    );

    targetSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      if (isClipboardWritePermission(webContents, permission, details)) {
        callback(true);
        return;
      }
      if (
        !shouldAllowMediaPermissionRequest({
          permission,
          webContents,
          trustedWebContents: resolveTrustedWebContents(),
          trustedRendererUrl,
          details,
        })
      ) {
        callback(false);
        return;
      }

      if (process.platform === "darwin") {
        const status = systemPreferences.getMediaAccessStatus("microphone");
        if (status === "granted") {
          callback(true);
          return;
        }

        void systemPreferences
          .askForMediaAccess("microphone")
          .then(callback, () => callback(false));
        return;
      }

      callback(true);
    });
  }
}

function configureRealtimeVoiceMediaRequests(): void {
  const productionPublicConfig = desktopProductionPublicConfig();
  const realtimeRelayUrl = app.isPackaged
    ? productionPublicConfig?.authRealms["memfire-phone"].realtimeRelayUrl
    : process.env.MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL;
  const policy = createRealtimeVoiceMediaRequestPolicy({
    realtimeRelayUrl,
    trustedRendererUrl: resolveRendererAppEntryUrl(),
  });
  if (policy === null) {
    return;
  }

  for (const targetSession of [
    session.defaultSession,
    session.fromPartition(REALTIME_VOICE_OVERLAY_SESSION_PARTITION),
  ]) {
    targetSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: policy(details) });
    });
  }
}

// Override Electron's userData path before the `ready` event so that
// Chromium session data uses a filesystem-friendly directory name.
// Must be called synchronously at the top level — before `app.whenReady()`.
if (hasSingleInstanceLock && !mossAuthProtocolRelay) {
  repairBrowserProfileBeforeElectronReady(userDataPath);
}

configureAppIdentity();
configureElectronNetwork();

if (!hasSingleInstanceLock || mossAuthProtocolRelay) {
  app.quit();
} else {
  if (shouldRegisterMossAuthCallbackProtocolClient(process.env)) {
    registerMossAuthCallbackProtocolClient();
  } else {
    writeDesktopLogHeader("Moss auth callback protocol client registration disabled");
  }
  queueMossAuthCallbackFromArgv(process.argv);

  // macOS delivers custom-scheme launches through open-url, including during
  // startup before app.whenReady() has resolved.
  app.on("open-url", (event, url) => {
    if (queueMossAuthCallback(url)) {
      event.preventDefault();
    }
  });

  // Windows and Linux pass a protocol activation to the primary process via
  // second-instance argv. Ordinary launches retain refocus; an explicit
  // --background launch only queues callbacks and leaves the foreground alone.
  app.on("second-instance", (_event, argv) => {
    handleDesktopSecondInstance(argv, {
      queueAuthCallback: queueMossAuthCallbackFromArgv,
      focusWindow: focusMainWindow,
    });
  });
}

async function bootstrap(): Promise<void> {
  writeDesktopLogHeader("bootstrap start");
  const background = isBackgroundDesktopLaunch(process.argv);
  if (!(await requireCurrentDesktopMigrationBundle())) {
    return;
  }
  // Ahead of the recovery gate on purpose. A startup that blocks below returns
  // early, and every path that could ship the fix for whatever blocked it lives
  // after that return: an install wedged on a bad migration would be unable to
  // update out of it, which is exactly how 0.6.0 stranded its users. The
  // updater touches no database state, so configuring it first is safe.
  configureAutoUpdater();

  const migrationRecoveryOutcome = await handleDesktopMigrationRecovery();
  if (migrationRecoveryOutcome !== "continue") {
    return;
  }

  // The packaged runtime is byte-pinned at build time. Its first Windows start
  // can still take longer than a warm synchronous --version check. Validate
  // asynchronously before backendEnv consumes it, retaining version drift guards.
  await prepareBundledClaudeStartupVersion({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  });
  if (app.isPackaged) {
    const codex = await resolveBundledCodexBinaryAsync({
      resourcesPath: process.resourcesPath,
      platform: process.platform,
      arch: process.arch,
    });
    if (!codex.ok) safeConsoleError(`[desktop] ${codex.message}`);
    bundledCodexBackendEnvCache = toBundledCodexBackendEnv(codex);
  }

  backendAuthToken = Crypto.randomBytes(24).toString("hex");
  hoolaCanvasBridgeToken = Crypto.randomBytes(32).toString("base64url");
  await reserveBackendEndpoint("bootstrap");

  browserSessionRestore = new BrowserSessionRestore(
    Path.join(BASE_DIR, "browser-session-restore"),
    createCookieSessionBackend(BROWSER_SESSION_PARTITION),
    browserOsKeyStore,
  );
  try {
    let restoreTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        browserSessionRestore.initialize().finally(() => clearTimeout(restoreTimer)),
        new Promise<never>((_, reject) => {
          restoreTimer = setTimeout(
            () => reject(new Error("Browser session restoration timed out.")),
            BROWSER_SESSION_RESTORE_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(restoreTimer);
    }
  } catch {
    console.warn(
      "[Moss browser] Secure session restoration is unavailable; no saved session cookies were restored.",
    );
  }

  registerIpcHandlers();
  mcpAppSandboxRuntime.registerIpcHandlers();
  htmlPreviewRuntime.registerIpcHandlers();
  writeDesktopLogHeader("bootstrap ipc handlers registered");
  try {
    await ensureBrowserHostPipeServer();
  } catch (error) {
    console.warn("[Moss browser] Failed to start browser host pipe", error);
  }
  await startCuaHost();
  startBackend();
  writeDesktopLogHeader("bootstrap backend start requested");

  if (isDevelopment) {
    void waitForBackendWindowReady(backendHttpUrl)
      .then((source) => {
        writeDesktopLogHeader(`bootstrap backend ready source=${source}`);
        if (!mainWindow) {
          mainWindow = createWindow({ background });
          writeDesktopLogHeader("bootstrap main window created");
        }
      })
      .catch((error) => {
        if (isBackendReadinessAborted(error)) {
          return;
        }
        writeDesktopLogHeader(
          `bootstrap backend readiness warning message=${formatErrorMessage(error)}`,
        );
        console.warn("[desktop] backend readiness check timed out during dev bootstrap", error);
        if (!mainWindow) {
          mainWindow = createWindow({ background });
          writeDesktopLogHeader("bootstrap main window created after readiness warning");
        }
      });
    return;
  }

  ensureInitialBackendWindowOpen(backendHttpUrl, { background });
}

app.on("before-quit", (event) => {
  writeDesktopLogHeader("before-quit received");
  if (desktopShutdownComplete) {
    return;
  }

  if (isUpdaterQuitAndInstallInFlight) {
    // Electron's updater owns this quit; canceling it would turn install into a plain app quit.
    try {
      if (
        !activeUpdateInstallHandoff ||
        !markInstallHandoffSync(getUpdateInstallMarkerPath(), activeUpdateInstallHandoff)
      ) {
        throw new Error("Durable update install handoff no longer matches the active attempt.");
      }
    } catch (error) {
      event.preventDefault();
      const failedHandoff = activeUpdateInstallHandoff;
      clearUpdaterInstallInFlightAfterError();
      const consecutiveFailures = recordInstallMarkerFailure(
        new Date().toISOString(),
        failedHandoff,
      );
      setUpdateState({
        ...reduceDesktopUpdateStateOnInstallFailure(
          updateState,
          "The downloaded update could not be handed to the installer safely.",
        ),
        installFailureCount: consecutiveFailures,
      });
      console.error(
        `[desktop-updater] Refused mismatched install handoff during quit: ${formatErrorMessage(error)}`,
      );
      recoverDesktopAfterUpdaterInstallFailure();
      return;
    }
    // Keep any deferred plain-quit intent until the process actually exits.
    // before-quit is not proof of a successful updater handoff: the watchdog
    // can still discover that quitAndInstall left this process alive.
    if (deferredDesktopQuitIntent.observeUpdaterQuitAttempt()) {
      writeDesktopLogHeader("deferred quit preserved through updater quit-and-install attempt");
    }
    writeDesktopLogHeader("before-quit allowing updater quit-and-install");
    return;
  }

  if (isUpdaterInstallPreparing) {
    // Keep user/system quits from preempting the pending updater install with a plain app.quit().
    deferDesktopQuitUntilUpdaterSettles("before-quit");
    event.preventDefault();
    return;
  }

  event.preventDefault();
  void confirmRunningChatsThenQuit("before-quit");
});

app.on("will-quit", () => {
  removeHoolaCanvasBridgeDescriptor();
});

if (hasSingleInstanceLock) {
  app
    .whenReady()
    .then(() => {
      writeDesktopLogHeader("app ready");
      if (betaDiagnostics) {
        betaDiagnostics.start();
        const previousLaunchVersion = parseLastLaunchVersion(readLaunchVersionRecordContents());
        trackBetaDiagnostics("app.start", {
          kind: "lifecycle",
          osVersion: process.getSystemVersion(),
          locale: app.getLocale(),
        });
        if (previousLaunchVersion !== null && previousLaunchVersion !== app.getVersion()) {
          // A version change across launches means an update install landed.
          trackBetaDiagnostics("update.installed", {
            kind: "update",
            outcome: "ok",
            targetVersion: app.getVersion(),
          });
        }
      }
      configureAppIdentity();
      if (process.platform === "win32") {
        try {
          ensureWindowsShellAppUserModelHelper(Path.join(STATE_DIR, "taskbar-icons"));
        } catch (error) {
          console.warn(
            `[desktop] Failed to prepare Windows shell icon helper: ${formatErrorMessage(error)}`,
          );
        }
      }
      applyInitialMacDockIcon();
      registerMacAppearanceIconSync();
      refreshMacIconCacheOnVersionChange();
      configureMediaPermissions();
      configureRealtimeVoiceMediaRequests();
      initializeDesktopAppSnap();
      initializeRealtimeVoiceShortcut();
      screen.on("display-added", repositionRealtimeVoiceOverlayAfterDisplayChange);
      screen.on("display-removed", repositionRealtimeVoiceOverlayAfterDisplayChange);
      screen.on("display-metrics-changed", repositionRealtimeVoiceOverlayAfterDisplayChange);
      configureApplicationMenu();
      if (
        registerConnectorOAuthProtocolClient(app as unknown as ConnectorOAuthProtocolClient) ===
        "failed"
      ) {
        console.warn("[desktop] Failed to register the connector OAuth callback protocol.");
      }
      try {
        mcpAppSandboxRuntime.registerProtocol();
        registerDesktopProtocol();
      } catch (error) {
        if (error instanceof BundleChangedDuringStartupError) {
          restartAfterStartupBundleSwap(error);
          return;
        }
        throw error;
      }
      startBundleSwapWatcher();
      void bootstrap().catch((error) => {
        handleFatalStartupError("bootstrap", error);
      });

      app.on("browser-window-blur", () => {
        markDesktopAppBackgrounded();
      });

      if (betaDiagnostics) {
        app.on("child-process-gone", (_event, details) => {
          // GPU/utility process crashes; details.reason is a fixed Electron enum.
          if (isQuitting || details.reason === "clean-exit") return;
          trackBetaDiagnostics("app.child-process-crash", {
            kind: "crash",
            processType: details.type,
            reason: details.reason,
            logTail: readLogTail(Path.join(LOG_DIR, DESKTOP_LOG_FILE_NAME)),
          });
        });
      }

      app.on("browser-window-focus", () => {
        handleDesktopAppForegrounded();
      });

      app.on("activate", () => {
        if (desktopStartupBlockedForDatabaseRestore || isQuitting) {
          return;
        }
        handleDesktopAppForegrounded();
        // Auxiliary always-on-top surfaces never satisfy the app's content
        // window lifecycle. Dock activation must recreate/focus the real owner.
        if (!resolveDesktopContentWindow()) {
          if (!isDevelopment) {
            ensureInitialBackendWindowOpen(backendHttpUrl);
            return;
          }
          void waitForBackendWindowReady(backendHttpUrl)
            .catch((error) => {
              if (isBackendReadinessAborted(error)) {
                return;
              }
              console.warn(
                "[desktop] backend readiness check timed out during dev activate",
                error,
              );
            })
            .finally(() => {
              if (!mainWindow) {
                mainWindow = createWindow();
              }
            });
          return;
        }
        focusMainWindow();
      });
    })
    .catch((error) => {
      handleFatalStartupError("whenReady", error);
    });
}

// GPU, utility, and pepper process failures never reach the window's renderer listener,
// so without this they are invisible too. Chromium respawns these itself — the value is
// the log line that explains a sudden loss of GPU acceleration or a dead audio/network
// service. Clean exits are routine teardown, so they stay out of the log.
app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit") return;
  captureSentryException(new Error("Moss desktop child process gone"), {
    errorSource: "desktop-child-process",
    processType: String(details.type).slice(0, 64),
    reason: String(details.reason).slice(0, 64),
    exitCode: details.exitCode ?? "none",
  });
  const attributes = [
    `type=${details.type}`,
    `reason=${details.reason}`,
    `exitCode=${details.exitCode}`,
    ...(details.serviceName ? [`service=${details.serviceName}`] : []),
    ...(details.name ? [`name=${sanitizeLogValue(details.name)}`] : []),
  ].join(" ");
  writeDesktopLogHeader(`child process gone ${attributes}`);
  safeConsoleError(`[desktop] child process gone (${attributes})`);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

if (process.platform !== "win32") {
  process.on("uncaughtException", (error: unknown) => {
    if (!isBrokenPipeError(error)) {
      captureSentryException(new Error("Moss desktop uncaught exception"), {
        errorSource: "desktop-process",
        boundary: "uncaught-exception",
        errorClass: error instanceof Error ? error.name.slice(0, 96) : "UnknownError",
      });
      void flushSentry();
      throw error;
    }
    if (desktopShutdownPromise) return;
    writeDesktopLogHeader("EPIPE received");
    requestGracefulAppQuit("EPIPE");
  });

  registerDesktopTerminationSignalHandlers({
    ready: app.whenReady(),
    source: process,
    isShutdownStarted: () => desktopShutdownPromise !== null,
    onSignal: (signal) => {
      writeDesktopLogHeader(`${signal} received`);
      requestGracefulAppQuit(signal);
    },
  });
}
