// FILE: ComputerSettingsPanel.tsx
// Purpose: Settings › Computer use (Codex's 电脑操控 page): the "any app" switch, one plain
//          status line with one action when computer use can't work, the pointer and
//          preview preferences, and the recent-actions log.
// Layer: Settings UI components
// Exports: ComputerSettingsPanel

import type { ComputerPermission } from "@moss/contracts";
import {
  COMPUTER_PERMISSION_KINDS,
  computerPermissionSetupMessage,
  missingComputerAppSnapPermissions,
} from "@moss/shared/computerGrants";
import {
  computerPermissionSetupSupported,
  readLocalComputerPermissionBridge,
} from "~/lib/computerProvisioning";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_AGENT_CURSOR_COLOR_MODE,
  normalizeCursorHexColor,
  type AgentCursorColorMode,
  type AppSettingsBinding,
  type ComputerPreviewSize,
} from "~/appSettings";
import type { DesktopAppSnapSettingsPane, DesktopAppSnapState } from "@moss/contracts";
import {
  computerStatusNeedsSetup,
  resolveComputerAvailabilityView,
} from "~/components/ComputerPanel.logic";
import { CentralIcon } from "~/lib/central-icons";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { useProvisionComputer } from "~/hooks/useProvisionComputer";
import { useRefreshOnWindowReturn } from "~/hooks/useRefreshOnWindowReturn";
import {
  AppSnapPermissionSection,
  COMPUTER_PERMISSION_PANES,
  useAppSnapPermissionGuideBridge,
} from "./AppSnapPermissionSection";
import {
  COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS,
  computerStatusQueryOptions,
} from "~/lib/serverReactQuery";
import { cn } from "~/lib/utils";
import { settingRowAnchorId } from "~/settingsNavigation";
import { useAgentCursorDesktopSync } from "./agentCursorDesktopSync";
import { SettingResetButton, SettingsSegmentedControl } from "./SettingControls";
import { SettingsCard, SettingsRow, SettingsSectionShell } from "./SettingsPanelPrimitives";
import { ComputerAuditHistorySection } from "./ComputerAuditHistorySection";

/** Stable identity, so the provision hook's toast copy is not rebuilt every render. */
const EMPTY_PERMISSIONS: readonly ComputerPermission[] = [];

/**
 * One agent-cursor color field: a validated hex input and the swatch it
 * resolves to. Only a complete `#rrggbb` (or an intentional clear) commits to
 * settings, so a half-typed value never reaches the stored preference.
 */
function CursorColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Follow a committed value that landed from elsewhere (Reset, another
  // window) instead of stranding the field on the old draft.
  useEffect(() => setDraft(value), [value]);
  const resolved = normalizeCursorHexColor(value);
  const draftIsValid = draft.trim() === "" || normalizeCursorHexColor(draft) !== "";
  return (
    <label className="flex items-center gap-2">
      <span className="w-7 shrink-0 text-ui text-muted-foreground">{label}</span>
      <span
        aria-hidden
        data-swatch={resolved || "stock"}
        className={cn(
          "size-4 shrink-0 rounded-full border border-[color:var(--color-border)]",
          !resolved && "bg-transparent",
        )}
        style={resolved ? { backgroundColor: resolved } : undefined}
      />
      <Input
        size="sm"
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") {
            onChange("");
            return;
          }
          const normalized = normalizeCursorHexColor(next);
          if (normalized) onChange(normalized);
        }}
        onBlur={() => setDraft(value)}
        placeholder="#rrggbb"
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${label} color`}
        aria-invalid={!draftIsValid}
        className="w-24"
      />
    </label>
  );
}

export function ComputerSettingsPanel({
  settings,
  defaults,
  updateSettings,
  active,
}: AppSettingsBinding & { readonly active: boolean }) {
  const statusQuery = useQuery({
    ...computerStatusQueryOptions(),
    enabled: active,
    // Health can flip (reconnecting, recovered) while the panel is open.
    refetchInterval: active ? COMPUTER_STATUS_VISIBLE_REFETCH_INTERVAL_MS : false,
  });

  const status = statusQuery.data;
  const [appSnapState, setAppSnapState] = useState<DesktopAppSnapState | null>(null);
  const [guidePane, setGuidePane] = useState<DesktopAppSnapSettingsPane | null>(null);
  // The native permission surface is the AppSnap helper: the same coach that
  // AppSnap's own settings drive, asked about the computer-use grant set.
  const localPermissionBridge = readLocalComputerPermissionBridge();
  const hasNativePermissionSetup =
    localPermissionBridge !== null && computerPermissionSetupSupported(appSnapState);
  const nativePermissionSetupError =
    hasNativePermissionSetup && appSnapState?.permissionSetupErrorCode
      ? appSnapState.message
      : null;
  // Returning from System Settings must re-pull both the server status and the
  // native grant snapshot — the toggle the user just flipped lives in the
  // second one.
  const refreshPermissionState = useCallback(() => {
    const bridge = readLocalComputerPermissionBridge();
    if (!bridge) return;
    void bridge
      .getState(COMPUTER_PERMISSION_KINDS)
      .then((next) => setAppSnapState(next))
      .catch(() => undefined);
  }, []);
  useRefreshOnWindowReturn(() => {
    void statusQuery.refetch({ cancelRefetch: false });
    refreshPermissionState();
  }, active);

  // Mirror the cursor colors to the desktop app on mount and on every change,
  // including while this panel is not the active section (the hooks above the
  // `!active` return stay mounted). A plain browser has no bridge: no-op.
  useAgentCursorDesktopSync(settings);

  // Panel-level on purpose: hooks above the `!active` return stay mounted while
  // the surface is hidden, so a dismissed coach still clears the remembered
  // pane instead of resurrecting the guide on return.
  useAppSnapPermissionGuideBridge({
    permissionKinds: COMPUTER_PERMISSION_KINDS,
    onStateChange: setAppSnapState,
    onGuidePaneChange: setGuidePane,
  });

  useEffect(() => {
    const bridge = readLocalComputerPermissionBridge();
    if (!bridge || !active) return;
    let disposed = false;
    const unsubscribe = bridge.onState((state) => {
      if (!disposed) setAppSnapState(state);
    });
    void bridge
      .getState(COMPUTER_PERMISSION_KINDS)
      .then((next) => {
        if (!disposed) setAppSnapState(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [active]);
  /**
   * The grants the OS is withholding, named. The availability message already
   * explains what to do; the attention row below names them, and the native
   * checklist in Advanced is the per-grant walkthrough.
   */
  const nativeMissingPermissions =
    hasNativePermissionSetup && appSnapState
      ? missingComputerAppSnapPermissions(appSnapState)
      : EMPTY_PERMISSIONS;
  const missingPermissions =
    nativeMissingPermissions.length > 0
      ? nativeMissingPermissions
      : status?.availability.kind === "permission-required"
        ? status.availability.missing
        : EMPTY_PERMISSIONS;
  // macOS itself says every grant is in place. This is what lets an idle
  // backend, which has checked nothing since launch, still show as ready.
  const grantsConfirmed =
    hasNativePermissionSetup &&
    appSnapState !== null &&
    nativePermissionSetupError === null &&
    nativeMissingPermissions.length === 0;
  // Idle status is intentionally side-effect-free. Fresh local grant evidence
  // can reveal setup needs without starting Computer or its input listener.
  const availability =
    nativeMissingPermissions.length > 0 && status?.availability.kind === "available"
      ? {
          kind: "permission-required" as const,
          missing: nativeMissingPermissions,
          buildSignature: "unknown" as const,
          message: computerPermissionSetupMessage(nativeMissingPermissions, "unknown"),
        }
      : status?.availability;
  // The same provision the chat's setup card runs, through the same hook: one
  // call in flight at a time whichever surface started it, and one account of
  // what happened. This surface keeps that account inline rather than as a
  // toast, because it has room for it and is where the user is already looking.
  const setup = useProvisionComputer({ missing: missingPermissions });

  if (!active) return null;

  const availabilityView = statusQuery.isError
    ? { kind: "blocked" as const, title: "", description: "" }
    : resolveComputerAvailabilityView(availability, status?.health, grantsConfirmed);
  const backend =
    status?.availability.kind === "available" ? (status.availability.backend ?? null) : null;
  const health = status?.health;
  const captureBlocked = health?.captureAvailable === false && health?.status === "connected";
  const localPlatformUnsupported =
    localPermissionBridge !== null &&
    appSnapState !== null &&
    appSnapState.platform !== "macos" &&
    appSnapState.platform !== "windows";
  const needsSetup =
    !localPlatformUnsupported &&
    (nativePermissionSetupError !== null ||
      nativeMissingPermissions.length > 0 ||
      computerStatusNeedsSetup(status, grantsConfirmed));
  const statusLine = resolveComputerUseStatusLine({
    queryFailed: statusQuery.isError,
    availabilityKind: status?.availability.kind ?? null,
    viewKind: availabilityView.kind,
    reconnecting: health?.status === "reconnecting",
    missingPermissions: missingPermissions.length > 0 || nativePermissionSetupError !== null,
    captureBlocked,
    needsSetup,
  });
  const statusBusy = setup.isPending || statusQuery.isFetching;
  const statusAction =
    statusLine?.action === "grant" || statusLine?.action === "retry" ? (
      <Button
        size="xs"
        variant="outline"
        disabled={statusBusy}
        onClick={() => {
          if (statusQuery.isError) {
            void statusQuery.refetch();
            refreshPermissionState();
            return;
          }
          setup.provision();
        }}
      >
        {statusBusy ? "Checking…" : statusLine.action === "grant" ? "Allow access" : "Try again"}
      </Button>
    ) : null;
  // Stock is the default and stores no override; only an explicit Custom
  // choice can differ from the default state.
  const cursorColorMode = settings.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE;
  const cursorColorsDirty =
    cursorColorMode !== (defaults.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE) ||
    (settings.agentCursorFillColor ?? "") !== (defaults.agentCursorFillColor ?? "") ||
    (settings.agentCursorRimColor ?? "") !== (defaults.agentCursorRimColor ?? "");
  const previewDirty =
    settings.autoOpenComputerPane !== defaults.autoOpenComputerPane ||
    settings.computerPreviewSize !== defaults.computerPreviewSize;
  const showMacPermissionChecklist =
    hasNativePermissionSetup &&
    appSnapState !== null &&
    (nativeMissingPermissions.length > 0 || nativePermissionSetupError !== null);

  return (
    <div className="space-y-8" data-computer-backend={backend ?? undefined}>
      <SettingsSectionShell id={settingRowAnchorId("Computer control")} title="Control apps">
        <SettingsCard>
          <SettingsRow
            leading={<ComputerUseAppTile />}
            title="Any app"
            description="Let Moss use the apps on your computer"
            control={
              <Switch
                checked={settings.computerControlEnabled}
                onCheckedChange={(checked) =>
                  updateSettings({
                    computerControlEnabled: Boolean(checked),
                    computerControlPreferenceSaved: true,
                  })
                }
                aria-label="Let Moss use the apps on your computer"
              />
            }
          />
          {statusLine ? (
            <div
              className="flex min-h-12 items-center justify-between gap-3 px-4 py-2.5"
              data-testid="computer-use-status"
              role="status"
            >
              <span className="flex min-w-0 items-center gap-2 text-ui text-muted-foreground">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    statusLine.tone === "warning" ? "bg-amber-500" : "bg-red-500",
                  )}
                />
                <span className="truncate">{statusLine.text}</span>
              </span>
              {statusAction}
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSectionShell>

      {showMacPermissionChecklist && appSnapState ? (
        // macOS asks for each grant separately; the checklist names the missing ones.
        <AppSnapPermissionSection
          panes={COMPUTER_PERMISSION_PANES}
          permissionKinds={COMPUTER_PERMISSION_KINDS}
          feature="Computer control"
          state={appSnapState}
          onStateChange={setAppSnapState}
          guidePane={guidePane}
          onGuidePaneChange={setGuidePane}
          showRecheck={false}
        />
      ) : null}

      <SettingsSectionShell title="While Moss works">
        <SettingsCard>
          {/* The agent's on-screen pointer. Stock keeps the driver's monochrome
              cursor and stores nothing beyond the default; Custom is the only
              state that carries fill/rim overrides to the desktop cursor host. */}
          <SettingsRow
            title="Pointer color"
            description="Looks like a normal pointer by default"
            resetAction={
              cursorColorsDirty ? (
                <SettingResetButton
                  label="cursor colors"
                  onClick={() =>
                    updateSettings({
                      agentCursorColorMode:
                        defaults.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE,
                      agentCursorFillColor: defaults.agentCursorFillColor ?? "",
                      agentCursorRimColor: defaults.agentCursorRimColor ?? "",
                    })
                  }
                />
              ) : null
            }
            control={
              <SettingsSegmentedControl<AgentCursorColorMode>
                value={cursorColorMode}
                onValueChange={(value) => updateSettings({ agentCursorColorMode: value })}
                options={[
                  { value: "stock", label: "Default" },
                  { value: "custom", label: "Custom" },
                ]}
                ariaLabel="Agent cursor colors"
              />
            }
          >
            {cursorColorMode === "custom" ? (
              <div className="flex flex-col gap-2 pt-3 sm:flex-row sm:gap-4">
                <CursorColorField
                  label="Fill"
                  value={settings.agentCursorFillColor ?? ""}
                  onChange={(value) => updateSettings({ agentCursorFillColor: value })}
                />
                <CursorColorField
                  label="Rim"
                  value={settings.agentCursorRimColor ?? ""}
                  onChange={(value) => updateSettings({ agentCursorRimColor: value })}
                />
              </div>
            ) : null}
          </SettingsRow>
          <SettingsRow
            title="Live preview"
            description="Show what Moss sees in the chat"
            resetAction={
              previewDirty ? (
                <SettingResetButton
                  label="preview"
                  onClick={() =>
                    updateSettings({
                      autoOpenComputerPane: defaults.autoOpenComputerPane,
                      computerPreviewSize: defaults.computerPreviewSize,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="flex w-full items-center gap-3 sm:w-auto sm:justify-end">
                <SettingsSegmentedControl<ComputerPreviewSize>
                  value={settings.computerPreviewSize}
                  onValueChange={(value) => updateSettings({ computerPreviewSize: value })}
                  options={[
                    { value: "compact", label: "Compact" },
                    { value: "large", label: "Large" },
                  ]}
                  ariaLabel="In-chat computer preview size"
                />
                <Switch
                  checked={settings.autoOpenComputerPane}
                  onCheckedChange={(checked) =>
                    updateSettings({ autoOpenComputerPane: Boolean(checked) })
                  }
                  aria-label="Show the computer preview automatically when an agent drives the desktop"
                />
              </div>
            }
          />
        </SettingsCard>
      </SettingsSectionShell>

      <ComputerAuditHistorySection />
    </div>
  );
}

/** Moss's own tile for "Any app": the pointer glyph on a soft control fill. */
function ComputerUseAppTile() {
  return (
    <span
      aria-hidden
      className="flex size-9 items-center justify-center rounded-[10px] border border-[color:var(--color-border)] bg-[var(--color-background-control)] text-foreground"
    >
      <CentralIcon name="cursor-3" className="size-5" />
    </span>
  );
}

export type ComputerUseStatusLine = {
  readonly text: string;
  readonly tone: "warning" | "error";
  readonly action: "grant" | "retry" | null;
};

/**
 * The one line the page shows when computer use cannot work right now, in plain words,
 * with at most one action. Ready, idle (not started yet) and checking states show
 * nothing: computer use starts by itself the first time a chat needs it. Raw driver,
 * provisioning or effect messages are never shown here.
 */
export function resolveComputerUseStatusLine(input: {
  readonly queryFailed: boolean;
  readonly availabilityKind: string | null;
  readonly viewKind: "ready" | "checking" | "blocked";
  readonly reconnecting: boolean;
  readonly missingPermissions: boolean;
  readonly captureBlocked: boolean;
  readonly needsSetup: boolean;
}): ComputerUseStatusLine | null {
  if (input.queryFailed) {
    return { text: "Moss can't reach computer use right now", tone: "error", action: "retry" };
  }
  if (input.availabilityKind === "unsupported-platform") {
    return {
      text: "Computer use isn't available on this computer yet",
      tone: "warning",
      action: null,
    };
  }
  if (input.missingPermissions || input.availabilityKind === "permission-required") {
    return {
      text: "Moss needs your permission to use other apps",
      tone: "warning",
      action: "grant",
    };
  }
  if (input.captureBlocked) {
    return { text: "Moss can't see the screen yet", tone: "warning", action: "grant" };
  }
  if (input.availabilityKind === "backend-unavailable") {
    return { text: "Computer use isn't working right now", tone: "error", action: "retry" };
  }
  if (input.reconnecting) {
    return { text: "Reconnecting…", tone: "warning", action: null };
  }
  if (input.viewKind === "blocked" && input.needsSetup) {
    return { text: "Computer use isn't working right now", tone: "error", action: "retry" };
  }
  return null;
}
