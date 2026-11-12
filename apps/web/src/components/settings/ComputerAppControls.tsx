// FILE: ComputerAppControls.tsx
// Purpose: Settings › Computer use per-app controls (Codex's 电脑操控 page): one row per app
//          Moss has used, with its icon and an on/off switch, and the "always allowed" list.
//          The choices are server settings: the server refuses turned-off apps and skips the
//          approval prompt for always-allowed ones.
// Layer: Settings UI components
// Exports: ComputerAppRows, ComputerAlwaysAllowedSection, useComputerAppControls

import type { ComputerServerSettings, ServerSettings } from "@moss/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuTrigger } from "~/components/ui/menu";
import { Switch } from "~/components/ui/switch";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { ensureNativeApi } from "~/nativeApi";
import {
  alwaysAllowCandidates,
  buildComputerAppRows,
  nextComputerAppPolicy,
  type ComputerAppRow,
} from "./ComputerAppControls.logic";
import {
  SettingsCard,
  SettingsEmptyState,
  SettingsRow,
  SettingsSectionShell,
} from "./SettingsPanelPrimitives";

const EMPTY_POLICY: ComputerServerSettings = { blockedApps: [], alwaysAllowedApps: [] };

export interface ComputerAppControls {
  readonly rows: readonly ComputerAppRow[];
  readonly loaded: boolean;
  readonly setBlocked: (app: string, blocked: boolean) => void;
  readonly setAlwaysAllowed: (app: string, allowed: boolean) => void;
}

/** The rows and the two writes, shared by both sections of the page. */
export function useComputerAppControls(active: boolean): ComputerAppControls {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(serverSettingsQueryOptions());
  const usedAppsQuery = useQuery({
    queryKey: serverQueryKeys.computerUsedApps(),
    queryFn: () => ensureNativeApi().computer.listUsedApps({}),
    enabled: active,
    retry: false,
    refetchOnWindowFocus: active,
  });
  const policy = settingsQuery.data?.computer ?? EMPTY_POLICY;
  const usedApps = usedAppsQuery.data?.apps;
  const rows = useMemo(() => buildComputerAppRows(usedApps ?? [], policy), [usedApps, policy]);

  const write = (change: Parameters<typeof nextComputerAppPolicy>[1]) => {
    // Build on the cache, not the render closure, so quick taps stack up
    // instead of the second one undoing the first.
    const latest = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
    const next = nextComputerAppPolicy(latest?.computer ?? policy, change);
    if (latest) queryClient.setQueryData(serverQueryKeys.settings(), { ...latest, computer: next });
    void ensureNativeApi()
      .server.updateSettings({ computer: next })
      .then((saved) => queryClient.setQueryData(serverQueryKeys.settings(), saved))
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: serverQueryKeys.settings() });
      });
  };

  return {
    rows,
    loaded: settingsQuery.data !== undefined && usedAppsQuery.isFetched,
    setBlocked: (app, blocked) => write({ kind: "blocked", app, value: blocked }),
    setAlwaysAllowed: (app, allowed) => write({ kind: "always-allowed", app, value: allowed }),
  };
}

/** The app's own icon from the desktop app, or its first letter on a soft tile. */
function ComputerAppIcon({ name, iconPath }: { name: string; iconPath?: string | undefined }) {
  const getAppFileIcon =
    typeof window === "undefined" ? undefined : window.desktopBridge?.getAppFileIcon;
  const iconQuery = useQuery({
    queryKey: ["desktop", "appFileIcon", iconPath ?? null],
    queryFn: () => getAppFileIcon!(iconPath!),
    enabled: getAppFileIcon !== undefined && iconPath !== undefined,
    staleTime: Infinity,
    retry: false,
  });
  const icon = iconQuery.data ?? null;
  return (
    <span
      aria-hidden
      className="flex size-9 items-center justify-center overflow-hidden rounded-control border border-[color:var(--color-border)] bg-[var(--color-background-control)] text-ui font-medium text-muted-foreground"
      data-app-icon={icon ? "system" : "letter"}
    >
      {icon ? (
        <img src={icon} alt="" className="size-6" draggable={false} />
      ) : (
        (Array.from(name.trim())[0] ?? "?").toUpperCase()
      )}
    </span>
  );
}

/** App names are the app's own words: never run them through translation. */
function AppName({ name }: { name: string }) {
  return (
    <span data-localization-skip="true" className="truncate">
      {name}
    </span>
  );
}

/**
 * The per-app rows inside the "Control apps" card, under "Any app". While the
 * master switch is off every app is off, so the switches show that and wait.
 */
export function ComputerAppRows({
  controls,
  masterEnabled,
}: {
  controls: ComputerAppControls;
  masterEnabled: boolean;
}) {
  if (!controls.loaded) return null;
  if (controls.rows.length === 0) {
    return (
      <div
        className="flex min-h-12 items-center px-4 py-2.5 text-ui text-muted-foreground"
        data-testid="computer-apps-empty"
      >
        Apps Moss uses will show up here
      </div>
    );
  }
  return (
    <>
      {controls.rows.map((row) => {
        const on = masterEnabled && !row.blocked;
        return (
          <div key={row.key} data-testid="computer-app-row" data-app={row.name}>
            <SettingsRow
              leading={<ComputerAppIcon name={row.name} iconPath={row.iconPath} />}
              title={<AppName name={row.name} />}
              description={
                !masterEnabled
                  ? "Off while Any app is off"
                  : row.blocked
                    ? "Moss won't use this app"
                    : row.alwaysAllowed
                      ? "Moss uses it without asking"
                      : "Moss asks before using it"
              }
              control={
                <Switch
                  checked={on}
                  disabled={!masterEnabled}
                  onCheckedChange={(checked) => controls.setBlocked(row.name, !checked)}
                  aria-label={`Let Moss use ${row.name}`}
                />
              }
            />
          </div>
        );
      })}
    </>
  );
}

/** "Always allowed": apps Moss may use without the approval prompt. */
export function ComputerAlwaysAllowedSection({ controls }: { controls: ComputerAppControls }) {
  const allowed = controls.rows.filter((row) => row.alwaysAllowed && !row.blocked);
  const candidates = alwaysAllowCandidates(controls.rows);
  return (
    <SettingsSectionShell
      title="Always allowed apps"
      action={
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={candidates.length === 0}
                aria-label="Add an always allowed app"
              />
            }
          >
            Add
          </MenuTrigger>
          <ComposerPickerMenuPopup align="end" className="min-w-48">
            {candidates.map((row) => (
              <MenuItem key={row.key} onClick={() => controls.setAlwaysAllowed(row.name, true)}>
                <AppName name={row.name} />
              </MenuItem>
            ))}
          </ComposerPickerMenuPopup>
        </Menu>
      }
    >
      {allowed.length === 0 ? (
        <SettingsEmptyState>
          <span data-testid="computer-always-allowed-empty">No apps yet</span>
        </SettingsEmptyState>
      ) : (
        <SettingsCard>
          {allowed.map((row) => (
            <div key={row.key} data-testid="computer-always-allowed-row" data-app={row.name}>
              <SettingsRow
                leading={<ComputerAppIcon name={row.name} iconPath={row.iconPath} />}
                title={<AppName name={row.name} />}
                description="Moss uses it without asking"
                control={
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => controls.setAlwaysAllowed(row.name, false)}
                    aria-label={`Stop always allowing ${row.name}`}
                  >
                    Remove
                  </Button>
                }
              />
            </div>
          ))}
        </SettingsCard>
      )}
    </SettingsSectionShell>
  );
}
