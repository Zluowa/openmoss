// FILE: EnvironmentLocalServersSection.tsx
// Purpose: Environment card row/menu for this chat's project servers, listed as the desktop
//          panel lists them: each launch configuration with its port and ▷ to start it
//          (Moss runs it and opens it in the browser panel once it answers), running ones
//          marked with ■ to stop, five rows then "See all", servers elsewhere on the
//          computer under their own label, and where the list is kept.
// Layer: Environment panel section
//
// Sources: `.moss/launch.json`, else `.claude/launch.json`, else package.json dev scripts
// (`apps/server/src/projectLaunchConfigurations.ts`), plus servers found listening
// (`apps/server/src/localServerMonitor.ts`). Both are read only while the card is open.

import type { ProjectId, ServerLocalServerProcess } from "@moss/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { GlobeIcon, RefreshCwIcon } from "~/lib/icons";
import { serverStopLocalServerMutationOptions } from "~/lib/serverReactQuery";
import { StatusDot } from "~/components/ui/status-chip";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { LaunchServerMenuRows } from "../../browser/LaunchServerList";
import { useProjectLaunchServers } from "../../browser/useProjectLaunchServers";
import { ComposerPickerMenuPopup } from "../ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../../ui/menu";
import {
  ENVIRONMENT_ROW_CLASS_NAME,
  ENVIRONMENT_ROW_ICON_CLASS_NAME,
  EnvironmentRowBody,
  EnvironmentRowChevron,
} from "./EnvironmentRow";

/** Compact, non-closing icon action used for the menu's Refresh affordance. */
function LocalServersRefreshButton({
  refreshing,
  onRefresh,
}: {
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <MenuItem
      closeOnClick={false}
      disabled={refreshing}
      onClick={onRefresh}
      aria-label={t("environment.localServers.refresh")}
      title={t("environment.localServers.refresh")}
      className="inline-flex size-5 items-center justify-center rounded-control p-0 text-muted-foreground/60 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-[var(--color-text-foreground)] data-highlighted:bg-[var(--color-background-button-secondary-hover)] data-highlighted:text-[var(--color-text-foreground)]"
    >
      <RefreshCwIcon className={cn("size-3", refreshing && "animate-spin")} />
    </MenuItem>
  );
}

/** Centered placeholder for the loading state inside the menu body. */
function LocalServersPlaceholder({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-3 text-center">
      <span className="text-muted-foreground/40">{icon}</span>
      <span className="text-ui text-muted-foreground">{title}</span>
    </div>
  );
}

export function EnvironmentLocalServersSection({
  enabled,
  workspaceRoot,
  projectId,
  onOpenServer,
}: {
  enabled: boolean;
  /** This chat's project folder: its launch file, and the servers running inside it. */
  workspaceRoot?: string | null | undefined;
  /** This chat's project: servers started here run as its dev servers. */
  projectId?: ProjectId | null | undefined;
  /** Opens a server's address in the browser panel. */
  onOpenServer?: ((url: string) => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const queryClient = useQueryClient();
  const [menuOpen, setMenuOpen] = useState(false);
  // A server opens in the browser panel, which the card and this menu would cover.
  const openServer = (url: string) => {
    setMenuOpen(false);
    onOpenServer?.(url);
  };
  const servers = useProjectLaunchServers({
    projectId,
    workspaceRoot,
    enabled: enabled || menuOpen,
    onOpen: openServer,
  });
  const stopLocalServerMutation = useMutation(
    serverStopLocalServerMutationOptions({ queryClient }),
  );
  const runningCount = servers.rows.filter((row) => row.state === "running").length;
  const starting = servers.rows.some((row) => row.state === "starting");
  const isBusy = servers.loading || stopLocalServerMutation.isPending || starting;
  const stopElsewhere = (server: ServerLocalServerProcess) =>
    stopLocalServerMutation.mutate({ pid: server.pid, port: server.ports[0] ?? 1 });
  const nothingListed = servers.rows.length === 0 && servers.elsewhere.length === 0;

  const trailing = (
    <>
      {isBusy ? (
        <RefreshCwIcon className="size-3 animate-spin text-[var(--color-text-foreground-secondary)]" />
      ) : (
        <span className="flex items-center gap-1.5">
          {runningCount > 0 ? <StatusDot className="bg-success" aria-hidden /> : null}
          <span className="text-ui-sm tabular-nums text-[var(--color-text-foreground-secondary)]">
            {runningCount}
          </span>
        </span>
      )}
      <EnvironmentRowChevron />
    </>
  );

  return (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <MenuTrigger render={<button type="button" className={ENVIRONMENT_ROW_CLASS_NAME} />}>
        <EnvironmentRowBody
          icon={<GlobeIcon className={ENVIRONMENT_ROW_ICON_CLASS_NAME} aria-hidden />}
          label={t("environment.localServers.label")}
          trailing={trailing}
        />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" side="bottom" className="w-80 min-w-80">
        <div className="flex items-center justify-between gap-2 pb-0.5 pl-2 pr-3 pt-px">
          <span className="truncate text-ui-xs font-normal text-muted-foreground/50">
            {servers.loading
              ? t("environment.localServers.scanning")
              : runningCount === 0
                ? t("environment.localServers.none")
                : format("environment.localServers.count", { count: runningCount })}
          </span>
          <LocalServersRefreshButton refreshing={servers.refreshing} onRefresh={servers.refresh} />
        </div>
        {servers.loading && nothingListed ? (
          <LocalServersPlaceholder
            icon={<RefreshCwIcon className="size-4 animate-spin" />}
            title={t("environment.localServers.scanningPorts")}
          />
        ) : null}
        <LaunchServerMenuRows
          servers={servers}
          onOpenUrl={openServer}
          onStopElsewhere={stopElsewhere}
        />
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
