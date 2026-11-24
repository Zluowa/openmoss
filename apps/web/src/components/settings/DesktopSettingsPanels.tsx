// FILE: DesktopSettingsPanels.tsx
// Purpose: Own settings panels whose behavior depends on browser or desktop-native lifecycles.
// Layer: Settings UI components
// Exports: NotificationsSettingsPanel, AppSnapSettingsPanel, BetaChannelSettingsPanel,
//          PreviewChannelSettingsPanel

import {
  type DesktopAppSnapPlatform,
  type DesktopAppSnapSettingsPane,
  type DesktopAppSnapState,
  type DesktopBetaActionResult,
  type DesktopBetaChannelState,
  type ResolvedKeybindingsConfig,
} from "@moss/contracts";
import {
  appSnapShortcutStorageKey,
  normalizeAppSnapShortcutForPlatform,
} from "@moss/shared/appSnapShortcut";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";

import type { AppSettingsBinding } from "~/appSettings";
import { createLatestAppSnapRequestGuard } from "~/appSnap.logic";
import { useRefreshOnWindowReturn } from "~/hooks/useRefreshOnWindowReturn";
import { playAppSnapCaptureSound } from "~/lib/appSnapSound";
import { CentralIcon } from "~/lib/central-icons";
import { cn, getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { isElectron } from "~/env";
import {
  buildNotificationSettingsSupportText,
  readBrowserNotificationPermissionState,
  requestBrowserNotificationPermission,
} from "~/notifications/taskCompletion";
import {
  SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME,
  SETTINGS_CARD_ROW_TITLE_CLASS_NAME,
} from "~/settingsPanelStyles";
import {
  APP_SNAP_PERMISSION_PANES,
  AppSnapPermissionSection,
  useAppSnapPermissionGuideBridge,
} from "./AppSnapPermissionSection";
import { AppSnapIllustration } from "./AppSnapIllustration";
import { AppSnapShortcutControl } from "./AppSnapShortcutControl";
import { SettingResetButton } from "./SettingControls";
import { SettingsCard, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { MossLogo } from "~/components/MossLogo";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { StatusDot } from "~/components/ui/status-chip";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { serverConfigQueryOptions } from "~/lib/serverReactQuery";

interface AppSnapStatusInfo {
  readonly text: string;
  readonly tone: "muted" | "success" | "warning" | "danger";
}

/** One short line under the AppSnap switch; distinguishes Windows errors from macOS permissions. */
function appSnapStatusInfo(state: DesktopAppSnapState | null): AppSnapStatusInfo {
  if (!state || !state.supported) {
    return { text: "Works in the Moss desktop app", tone: "muted" };
  }
  if (state.status === "ready") {
    return { text: "On while Moss is open", tone: "success" };
  }
  if (state.status === "disabled") {
    return { text: "Off", tone: "muted" };
  }
  if (state.status === "starting") {
    return { text: "Starting…", tone: "warning" };
  }
  if (state.status === "permission-required") {
    return { text: "Needs your permission", tone: "warning" };
  }
  return {
    text: state.message?.trim() || "AppSnap needs attention",
    tone: "danger",
  };
}

function resolveAppSnapPlatform(state: DesktopAppSnapState | null): DesktopAppSnapPlatform {
  if (state?.platform) return state.platform;
  const nav = getNavigatorPlatform();
  if (isWindowsPlatform(nav)) return "windows";
  if (isMacPlatform(nav)) return "macos";
  return "other";
}

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];

export function NotificationsSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const [browserNotificationPermission, setBrowserNotificationPermission] = useState(
    readBrowserNotificationPermissionState(),
  );

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setBrowserNotificationPermission(readBrowserNotificationPermissionState());
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, []);

  async function setSystemNotificationsEnabled(nextEnabled: boolean) {
    if (!nextEnabled) {
      updateSettings({ enableSystemTaskCompletionNotifications: false });
      return;
    }

    if (isElectron) {
      updateSettings({ enableSystemTaskCompletionNotifications: true });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);

    if (permission === "granted") {
      updateSettings({ enableSystemTaskCompletionNotifications: true });
      return;
    }

    updateSettings({ enableSystemTaskCompletionNotifications: false });
    toastManager.add({
      type: permission === "denied" ? "warning" : "error",
      title: "Desktop notifications unavailable",
      description: buildNotificationSettingsSupportText(permission),
    });
  }

  async function sendTestNotification() {
    const title = "Activity notification";
    const body = "Notification test for chats and terminal agents.";

    if (window.desktopBridge) {
      const shown = await window.desktopBridge.notifications.show({ title, body, silent: false });
      toastManager.add({
        type: shown ? "success" : "warning",
        title: shown ? "Test notification sent" : "Notifications unavailable",
        description: shown
          ? "Your operating system should show the notification."
          : "Desktop notifications are not supported on this device.",
      });
      return;
    }

    const permission = await requestBrowserNotificationPermission();
    setBrowserNotificationPermission(permission);
    if (permission !== "granted") {
      toastManager.add({
        type: permission === "denied" ? "warning" : "error",
        title: "Desktop notifications unavailable",
        description: buildNotificationSettingsSupportText(permission),
      });
      return;
    }

    const notification = new Notification(title, { body, tag: "moss:test-notification" });
    notification.addEventListener("click", () => {
      window.focus();
    });
    toastManager.add({
      type: "success",
      title: "Test notification sent",
      description: "Your browser should show the notification.",
    });
  }

  if (!active) return null;

  return (
    <div className="space-y-6">
      <SettingsSection title="Activity alerts">
        <SettingsRow
          title="Activity toasts"
          description="Show a notice in Moss when a chat finishes or needs you."
          resetAction={
            settings.enableTaskCompletionToasts !== defaults.enableTaskCompletionToasts ? (
              <SettingResetButton
                label="activity toasts"
                onClick={() =>
                  updateSettings({
                    enableTaskCompletionToasts: defaults.enableTaskCompletionToasts,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.enableTaskCompletionToasts}
              onCheckedChange={(checked) =>
                updateSettings({ enableTaskCompletionToasts: Boolean(checked) })
              }
              aria-label="Activity toast notifications"
            />
          }
        />

        <SettingsRow
          title="Desktop notifications"
          description="Notify you when Moss is in the background."
          status={buildNotificationSettingsSupportText(browserNotificationPermission)}
          resetAction={
            settings.enableSystemTaskCompletionNotifications !==
            defaults.enableSystemTaskCompletionNotifications ? (
              <SettingResetButton
                label="desktop notifications"
                onClick={() =>
                  updateSettings({
                    enableSystemTaskCompletionNotifications:
                      defaults.enableSystemTaskCompletionNotifications,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-2 sm:w-auto sm:justify-end">
              <Button size="xs" variant="outline" onClick={() => void sendTestNotification()}>
                Test
              </Button>
              <Switch
                checked={settings.enableSystemTaskCompletionNotifications}
                onCheckedChange={(checked) => {
                  void setSystemNotificationsEnabled(Boolean(checked));
                }}
                aria-label="Desktop activity notifications"
              />
            </div>
          }
        />

        <SettingsRow
          title="Wait for subagents"
          description="Alert once, after every subagent is done too."
          resetAction={
            settings.notifyAfterSubagentsFinish !== defaults.notifyAfterSubagentsFinish ? (
              <SettingResetButton
                label="wait for subagents"
                onClick={() =>
                  updateSettings({
                    notifyAfterSubagentsFinish: defaults.notifyAfterSubagentsFinish,
                  })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.notifyAfterSubagentsFinish}
              onCheckedChange={(checked) =>
                updateSettings({ notifyAfterSubagentsFinish: Boolean(checked) })
              }
              aria-label="Wait for subagents before alerting"
            />
          }
        />
      </SettingsSection>
    </div>
  );
}

export function AppSnapSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const [appSnapState, setAppSnapState] = useState<DesktopAppSnapState | null>(null);
  const [openGuidePane, setOpenGuidePane] = useState<DesktopAppSnapSettingsPane | null>(null);
  const appSnapRequestGuardRef = useRef(createLatestAppSnapRequestGuard());
  const serverConfigQuery = useQuery({ ...serverConfigQueryOptions(), enabled: active });
  const keybindings = serverConfigQuery.data?.keybindings ?? EMPTY_KEYBINDINGS;

  // getState publishes through onState below. A passive refresh must not
  // invalidate an enable request that is waiting for the macOS permission dialog.
  useRefreshOnWindowReturn(() => window.desktopBridge?.appSnap?.getState(), active);

  // Panel-level on purpose: hooks above the `!active` return stay mounted while
  // the surface is hidden, so a dismissed coach still clears the remembered
  // pane instead of resurrecting the guide on return.
  useAppSnapPermissionGuideBridge({
    onStateChange: setAppSnapState,
    onGuidePaneChange: setOpenGuidePane,
  });

  useEffect(() => {
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onState((state) => {
      if (!disposed) setAppSnapState(state);
    });
    void bridge
      .getState()
      .then((state) => {
        if (!disposed) setAppSnapState(state);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  async function setAppSnapEnabled(nextEnabled: boolean) {
    const requestGuard = appSnapRequestGuardRef.current;
    const requestId = requestGuard.begin();
    const bridge = window.desktopBridge?.appSnap;
    if (!bridge) {
      toastManager.add({
        type: "warning",
        title: "AppSnap unavailable",
        description: "AppSnap requires the Moss desktop app.",
      });
      return;
    }

    try {
      if (nextEnabled && appSnapState?.platform !== "windows") {
        const permissionState = await bridge.requestPermissions();
        if (!requestGuard.isCurrent(requestId)) return;
        setAppSnapState(permissionState);
      }
      if (!requestGuard.isCurrent(requestId)) return;
      updateSettings({ enableAppSnap: nextEnabled });
      const state = await bridge.setEnabled(nextEnabled);
      if (!requestGuard.isCurrent(requestId)) return;
      setAppSnapState(state);
      if (nextEnabled && state.status === "permission-required") {
        if (state.inputMonitoringPermission !== "granted") {
          setOpenGuidePane("input-monitoring");
        } else if (state.screenRecordingPermission !== "granted") {
          setOpenGuidePane("screen-recording");
        }
      } else if (nextEnabled && state.status === "error") {
        toastManager.add({
          type: "warning",
          title: "Finish AppSnap setup",
          description:
            state.message ??
            (state.platform === "windows"
              ? "Choose an available shortcut in Settings, then try again."
              : "Allow the required macOS permissions, then try again."),
        });
      }
    } catch (error) {
      if (!requestGuard.isCurrent(requestId)) return;
      updateSettings({ enableAppSnap: false });
      toastManager.add({
        type: "error",
        title: "AppSnap setup failed",
        description: error instanceof Error ? error.message : "Could not configure AppSnap.",
      });
    }
  }

  const supported = appSnapState?.supported === true;
  const enabled = supported && settings.enableAppSnap;
  const platform = resolveAppSnapPlatform(appSnapState);
  const isWindows = platform === "windows";
  const effectiveShortcut = normalizeAppSnapShortcutForPlatform(settings.appSnapShortcut, platform);
  const statusInfo = appSnapStatusInfo(appSnapState);
  const shortcutError =
    enabled && appSnapState?.status === "error" ? (appSnapState.message ?? null) : null;

  if (!active) return null;

  return (
    <div className="space-y-4">
      <SettingsCard divided={false} className="flex items-start gap-3 px-4 py-3.5">
        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-control border border-[color:var(--color-border)] bg-[var(--color-background-control)] text-foreground">
          <CentralIcon name="screen-capture" className="size-5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>
            {isWindows ? "Capture any window with a shortcut" : "Show Moss the window in front"}
          </p>
          <p className={SETTINGS_CARD_ROW_DESCRIPTION_CLASS_NAME}>
            {!supported
              ? "AppSnap works in the Moss desktop app."
              : isWindows
                ? "Snap the window in front straight into your task without switching away first."
                : "Moss sees the window's picture and text, even the part you'd scroll to."}
          </p>
        </div>
      </SettingsCard>

      <div className="grid items-stretch gap-4 md:grid-cols-[minmax(0,1.35fr)_minmax(210px,0.85fr)]">
        <SettingsCard>
          <SettingsRow
            title="Turn on AppSnap"
            status={
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 text-ui-sm",
                  statusInfo.tone === "danger" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                <StatusDot
                  aria-hidden
                  pulse={statusInfo.tone === "warning" && appSnapState?.status === "starting"}
                  className={
                    statusInfo.tone === "success"
                      ? "bg-[var(--color-status-success)]"
                      : statusInfo.tone === "danger"
                        ? "bg-destructive"
                        : statusInfo.tone === "warning"
                          ? "bg-warning"
                          : "bg-[color:var(--color-border)]"
                  }
                />
                <span>{statusInfo.text}</span>
              </span>
            }
            resetAction={
              settings.enableAppSnap !== defaults.enableAppSnap ? (
                <SettingResetButton
                  label="AppSnap"
                  onClick={() => void setAppSnapEnabled(defaults.enableAppSnap)}
                />
              ) : null
            }
            control={
              <Switch
                checked={enabled}
                disabled={!supported}
                onCheckedChange={(checked) => void setAppSnapEnabled(Boolean(checked))}
                aria-label="Enable AppSnap"
              />
            }
          />
          <SettingsRow
            title="Shortcut"
            description={
              effectiveShortcut.kind === "both-option-keys"
                ? "Press both keys at once"
                : "Press this shortcut from any app"
            }
            control={
              <AppSnapShortcutControl
                key={`${platform}:${appSnapShortcutStorageKey(effectiveShortcut)}`}
                shortcut={effectiveShortcut}
                platform={platform}
                enabled={enabled}
                reserved={enabled && appSnapState?.status === "ready"}
                stateError={shortcutError}
                keybindings={keybindings}
                onSaved={(shortcut, state) => {
                  updateSettings({
                    appSnapShortcut: shortcut as typeof settings.appSnapShortcut,
                  });
                  setAppSnapState(state);
                }}
              />
            }
          />
          <SettingsRow
            title="Send to"
            description="The task you just used, or a new one"
            control={
              <span className="text-ui leading-snug font-medium text-muted-foreground">
                Automatic
              </span>
            }
          />
          <SettingsRow
            title="Play sound"
            resetAction={
              settings.appSnapPlaySound !== defaults.appSnapPlaySound ? (
                <SettingResetButton
                  label="capture sound"
                  onClick={() => updateSettings({ appSnapPlaySound: defaults.appSnapPlaySound })}
                />
              ) : null
            }
            control={
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => void playAppSnapCaptureSound()}
                >
                  Preview
                </Button>
                <Switch
                  checked={settings.appSnapPlaySound}
                  onCheckedChange={(checked) =>
                    updateSettings({ appSnapPlaySound: Boolean(checked) })
                  }
                  aria-label="Play a sound when an AppSnap is captured"
                />
              </div>
            }
          />
        </SettingsCard>
        <AppSnapIllustration
          className="text-foreground"
          shortcut={effectiveShortcut}
          platform={platform}
        />
      </div>

      {supported && appSnapState?.platform === "macos" ? (
        <AppSnapPermissionSection
          panes={APP_SNAP_PERMISSION_PANES}
          feature="AppSnap"
          state={appSnapState}
          onStateChange={setAppSnapState}
          guidePane={openGuidePane}
          onGuidePaneChange={setOpenGuidePane}
        />
      ) : null}
    </div>
  );
}

/**
 * Beta → stable: opens stable Moss and quits beta. Beta data is never copied
 * back because beta can hold data for features stable does not have yet.
 */
function LeaveBetaDialog({
  open,
  canMoveToTrash,
  onOpenChange,
  onLeave,
}: {
  readonly open: boolean;
  readonly canMoveToTrash: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onLeave: (moveToTrash: boolean) => Promise<DesktopBetaActionResult>;
}) {
  const [moveToTrash, setMoveToTrash] = useState(true);
  const [pending, setPending] = useState(false);
  const trashCheckboxId = useId();

  async function leave() {
    setPending(true);
    try {
      const result = await onLeave(canMoveToTrash && moveToTrash).catch(
        (error: unknown): DesktopBetaActionResult => ({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: "Could not switch back to Moss",
          description: result.message ?? "Open Moss from your Applications folder.",
        });
        onOpenChange(false);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Switch back to Moss?</AlertDialogTitle>
          <AlertDialogDescription>
            Moss opens with the chats and settings it had before you tried Beta. Beta closes, and
            any chats still running in Beta stop.
          </AlertDialogDescription>
          <AlertDialogDescription>
            Anything you did in Beta stays in Beta. It can't be moved into Moss, because Beta can
            include features Moss doesn't have yet.
          </AlertDialogDescription>
          {canMoveToTrash ? (
            <label
              htmlFor={trashCheckboxId}
              className="flex cursor-interaction select-none items-start gap-2 pt-2 text-ui text-foreground"
            >
              <Checkbox
                id={trashCheckboxId}
                className="mt-0.5"
                checked={moveToTrash}
                disabled={pending}
                onCheckedChange={(checked) => setMoveToTrash(checked === true)}
              />
              <span className="space-y-0.5">
                <span className="block">Move Moss Beta to the Trash</span>
                <span className="block text-ui-sm text-muted-foreground">
                  Your Beta data is kept, so you can pick up where you left off if you come back.
                </span>
              </span>
            </label>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="outline" size="sm" />}>
            Stay on Beta
          </AlertDialogClose>
          <Button size="sm" disabled={pending} onClick={() => void leave()}>
            {pending ? "Switching…" : "Switch to Moss"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function BetaChannelMark() {
  return <MossLogo alt="Moss Beta" className="mt-0.5 size-9 shrink-0" />;
}

/**
 * Stable → Moss Beta handoff. Rendered inside General settings; visible only
 * on desktop builds, with the full action card on production and a status card
 * (plus diagnostics disclosure) on beta.
 */
export function BetaChannelSettingsPanel({ active }: { readonly active: boolean }) {
  const betaBridge = isElectron ? window.desktopBridge?.beta : undefined;
  const betaStateQuery = useQuery({
    queryKey: ["desktop-beta-channel-state"],
    queryFn: () => betaBridge!.getState(),
    enabled: active && betaBridge !== undefined,
    // Poll fast while a download/install is in flight so the progress row moves.
    refetchInterval: (query) =>
      query.state.data?.install && query.state.data.install.phase !== "error" ? 500 : 30_000,
  });
  const [actionPending, setActionPending] = useState<"copy" | "open" | "install" | null>(null);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const state: DesktopBetaChannelState | null = betaStateQuery.data ?? null;

  if (!active || !betaBridge || !state?.supported) return null;

  const refresh = () => void betaStateQuery.refetch();

  async function copyDataAndLaunch() {
    setActionPending("copy");
    try {
      const result = await betaBridge!.importAndLaunch();
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: "Could not start the beta handoff",
          description: result.message ?? "Try again from Settings → General.",
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "Opening Moss Beta",
      });
      refresh();
    } finally {
      setActionPending(null);
    }
  }

  async function launchBeta() {
    setActionPending("open");
    try {
      const result = await betaBridge!.launch();
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: "Could not open Moss Beta",
          description: result.message ?? "The beta install was not found.",
        });
      }
      refresh();
    } finally {
      setActionPending(null);
    }
  }

  async function installBeta() {
    setActionPending("install");
    try {
      const result = await betaBridge!.install();
      if (!result.ok) {
        toastManager.add({
          type: "warning",
          title: "Could not install Moss Beta",
          description: result.message ?? "Try again from Settings → General.",
        });
      }
      refresh();
    } finally {
      setActionPending(null);
    }
  }

  async function openStableDownloadPage() {
    if (state?.stableDownloadUrl && window.desktopBridge?.openExternal) {
      await window.desktopBridge.openExternal(state.stableDownloadUrl);
    }
  }

  async function openDownloadPage() {
    if (state?.downloadUrl && window.desktopBridge?.openExternal) {
      await window.desktopBridge.openExternal(state.downloadUrl);
    }
  }

  if (state.flavor === "beta") {
    return (
      <SettingsCard divided={false} className="flex items-start gap-3 px-4 py-3.5">
        <BetaChannelMark />
        <div className="min-w-0 flex-1 space-y-1">
          <p className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>You're on Moss Beta</p>
          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            {state.stableInstalled ? (
              <Button size="xs" variant="outline" onClick={() => setLeaveDialogOpen(true)}>
                Switch back to Moss
              </Button>
            ) : (
              <Button size="xs" variant="outline" onClick={() => void openStableDownloadPage()}>
                Get Moss
              </Button>
            )}
          </div>
        </div>
        <LeaveBetaDialog
          open={leaveDialogOpen}
          canMoveToTrash={state.canMoveBetaToTrash}
          onOpenChange={setLeaveDialogOpen}
          onLeave={(moveToTrash) => betaBridge!.leave({ moveToTrash })}
        />
      </SettingsCard>
    );
  }

  // The stable build does not advertise Beta at the top of General (owner walk 2026-11-24, P-1):
  // updates arrive through the preview channel row instead.
  if (state.flavor !== "production" || !state.installed) return null;

  return (
    <SettingsCard divided={false} className="px-4 py-3.5">
      <div className="flex items-start gap-3">
        <BetaChannelMark />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <p className={SETTINGS_CARD_ROW_TITLE_CLASS_NAME}>Moss Beta</p>
            {state.installed && state.version ? (
              <span className="text-ui-xs text-muted-foreground">v{state.version} installed</span>
            ) : state.installed ? (
              <span className="text-ui-xs text-muted-foreground">Installed</span>
            ) : null}
          </div>
          {state.lastImportAt ? (
            <p className="text-ui-xs text-muted-foreground">
              Last copied your data {new Date(state.lastImportAt).toLocaleString()}.
            </p>
          ) : null}
          {state.lastImportError ? (
            <p className="text-ui-xs text-destructive">
              Last import failed: {state.lastImportError}
            </p>
          ) : null}
          {state.install?.phase === "error" ? (
            <p className="text-ui-xs text-destructive">
              Install failed: {state.install.message ?? "unknown error"}
            </p>
          ) : state.install ? (
            <p className="text-ui-xs text-muted-foreground">
              {state.install.phase === "downloading"
                ? `Downloading Moss Beta${state.install.percent !== null ? ` — ${state.install.percent}%` : "…"}`
                : state.install.phase === "verifying"
                  ? "Verifying the download…"
                  : state.install.phase === "installing"
                    ? "Installing Moss Beta…"
                    : "Opening Moss Beta…"}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 pt-1.5">
            {!state.installed ? (
              state.canInstall ? (
                <>
                  <Button
                    size="xs"
                    disabled={actionPending !== null}
                    onClick={() => void installBeta()}
                  >
                    {actionPending === "install" ? "Installing…" : "Install Moss Beta"}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={actionPending !== null}
                    onClick={() => setCopyDialogOpen(true)}
                  >
                    {actionPending === "copy" ? "Installing…" : "Copy my data and open"}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={actionPending !== null}
                    onClick={() => void openDownloadPage()}
                  >
                    Download page
                  </Button>
                </>
              ) : (
                <Button size="xs" onClick={() => void openDownloadPage()}>
                  Get Moss Beta
                </Button>
              )
            ) : (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={actionPending !== null || state.running}
                  title={
                    state.running
                      ? "Quit Moss Beta first so it can pick up the import on its next launch."
                      : undefined
                  }
                  onClick={() => setCopyDialogOpen(true)}
                >
                  {actionPending === "copy"
                    ? "Copying…"
                    : state.lastImportAt
                      ? "Re-copy my data and open"
                      : "Copy my data and open"}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={actionPending !== null}
                  onClick={() => void launchBeta()}
                >
                  {actionPending === "open" ? "Opening…" : "Open Beta"}
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
      <AlertDialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace Moss Beta data?</AlertDialogTitle>
            <AlertDialogDescription>
              Chats and projects created only in Beta will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              Keep Beta data
            </AlertDialogClose>
            <Button
              size="sm"
              disabled={actionPending !== null}
              onClick={() => {
                setCopyDialogOpen(false);
                void copyDataAndLaunch();
              }}
            >
              Replace Beta data and open
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsCard>
  );
}

/**
 * The preview channel switch (code updates): Moss gets new versions as small background updates
 * that start at the next launch. The desktop writes a marker the shell's boot reads, so the
 * change takes effect the next time Moss starts. Packaged Windows builds only.
 */
export function PreviewChannelSettingsPanel({ active }: { readonly active: boolean }) {
  const bridge = isElectron ? window.desktopBridge?.previewChannel : undefined;
  const stateQuery = useQuery({
    queryKey: ["desktop-preview-channel-state"],
    queryFn: () => bridge!.get(),
    enabled: active && bridge !== undefined,
  });
  const [pending, setPending] = useState(false);
  const state = stateQuery.data ?? null;
  if (!active || !bridge || !state?.supported) return null;

  const change = async (on: boolean) => {
    setPending(true);
    try {
      await bridge.set(on);
      await stateQuery.refetch();
    } catch {
      toastManager.add({ type: "error", title: "Couldn't change the preview channel. Try again." });
    } finally {
      setPending(false);
    }
  };
  const status =
    state.on === state.activeNow
      ? null
      : state.on
        ? "Starts the next time Moss opens."
        : "Stops the next time Moss opens.";

  return (
    <SettingsSection title="Updates">
      <SettingsRow
        title="Preview channel: get updates sooner"
        description="Downloads new versions in the background; rolls back if one doesn't start."
        status={status}
        control={
          <Switch
            checked={state.on}
            disabled={pending}
            onCheckedChange={(next) => void change(Boolean(next))}
            aria-label="Preview channel: get updates sooner"
          />
        }
      />
    </SettingsSection>
  );
}
