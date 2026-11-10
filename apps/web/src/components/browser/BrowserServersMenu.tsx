// FILE: BrowserServersMenu.tsx
// Purpose: The servers button in the browser panel's header: the project's servers (start,
//   open, stop), their output ("Show dev server logs"), and the launch file to edit them.
// Layer: BrowserPanel UI

import type { ProjectDevServer, ProjectId } from "@moss/contracts";
import { useState } from "react";

import { ServerIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { DOCK_HEADER_ICON_BUTTON_CLASS } from "../chat/chatHeaderControls";
import { IconButton } from "../ui/icon-button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import {
  BrowserDevServerLogsDialog,
  devServerRunLabel,
  useBrowserDevServerRuns,
} from "./BrowserDevServerLogsDialog";
import { LaunchServerMenuRows } from "./LaunchServerList";
import { useProjectLaunchServers } from "./useProjectLaunchServers";

function devServerRunKey(run: ProjectDevServer): string {
  return `${run.launchName ?? ""}|${run.startedAt}`;
}

export function BrowserServersMenu(props: {
  readonly projectId: ProjectId | null | undefined;
  readonly workspaceRoot: string | null | undefined;
  /** Shows an address in the browser panel. */
  readonly onOpen: (url: string) => void;
  /** Opens a file of the project (the launch file) in the file panel. */
  readonly onEditFile?: ((absolutePath: string) => void) | undefined;
}) {
  const { t, format } = useTranslation();
  const [open, setOpen] = useState(false);
  const [logsRunKey, setLogsRunKey] = useState<string | null>(null);
  const servers = useProjectLaunchServers({
    projectId: props.projectId,
    workspaceRoot: props.workspaceRoot,
    enabled: open,
    onOpen: props.onOpen,
  });
  const runs = useBrowserDevServerRuns(props.workspaceRoot);
  const logsRun = runs.find((run) => devServerRunKey(run) === logsRunKey) ?? null;
  const editFilePath = servers.editFilePath;

  return (
    <>
      <Menu modal={false} open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <IconButton
              variant="chrome"
              size="icon-xs"
              label={t("browser.servers.button")}
              tooltip={t("browser.servers.button")}
              tooltipSide="bottom"
              data-browser-servers-menu=""
              className={DOCK_HEADER_ICON_BUTTON_CLASS}
            >
              <ServerIcon className="size-4" />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="end" side="bottom" className="w-80 min-w-80">
          <LaunchServerMenuRows
            servers={servers}
            onOpenUrl={props.onOpen}
            showElsewhere={false}
            showFooter={!(editFilePath && props.onEditFile)}
          />
          {runs.length > 0 || (editFilePath && props.onEditFile) ? <MenuSeparator /> : null}
          {runs.length === 1 ? (
            <MenuItem onClick={() => setLogsRunKey(devServerRunKey(runs[0]!))}>
              {t("browser.menu.devServerLogs")}
            </MenuItem>
          ) : runs.length > 1 ? (
            <MenuSub>
              <MenuSubTrigger>{t("browser.menu.devServerLogs")}</MenuSubTrigger>
              <MenuSubPopup surface="composer" className="w-60">
                {runs.map((run) => (
                  <MenuItem
                    key={devServerRunKey(run)}
                    onClick={() => setLogsRunKey(devServerRunKey(run))}
                  >
                    <span className="truncate" data-translation-skip="true">
                      {devServerRunLabel(run)}
                    </span>
                  </MenuItem>
                ))}
              </MenuSubPopup>
            </MenuSub>
          ) : null}
          {editFilePath && props.onEditFile ? (
            <MenuItem onClick={() => props.onEditFile?.(editFilePath)}>
              {format("browser.servers.editFile", { file: servers.editFile })}
            </MenuItem>
          ) : null}
        </ComposerPickerMenuPopup>
      </Menu>
      {logsRun ? (
        <BrowserDevServerLogsDialog
          open
          onOpenChange={(next) => {
            if (!next) setLogsRunKey(null);
          }}
          run={logsRun}
        />
      ) : null}
    </>
  );
}
