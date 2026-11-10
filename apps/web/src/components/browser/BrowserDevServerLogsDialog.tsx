// FILE: BrowserDevServerLogsDialog.tsx
// Purpose: "Show dev server logs": the recent output of a dev server Moss runs for this
//   chat's project (a launch configuration started from a server list, or the sidebar's
//   Run), read without attaching to its terminal.
// Layer: BrowserPanel UI

import type { ProjectDevServer } from "@moss/contracts";
import { isWorkspaceRootWithin } from "@moss/shared/threadWorkspace";
import { useQuery } from "@tanstack/react-query";

import { RefreshCwIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { readNativeApi } from "~/nativeApi";

import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import { useProjectRunStore } from "../../projectRunStore";
import { plainTerminalLog } from "./launchServers.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

function runBelongsToWorkspace(run: ProjectDevServer, workspaceRoot: string): boolean {
  return (
    isWorkspaceRootWithin(run.cwd, workspaceRoot) || isWorkspaceRootWithin(workspaceRoot, run.cwd)
  );
}

/** The dev servers Moss runs for the project at `workspaceRoot`: launch runs first. */
export function useBrowserDevServerRuns(
  workspaceRoot: string | null | undefined,
): readonly ProjectDevServer[] {
  return useProjectRunStore(
    useShallow((state) => {
      if (!workspaceRoot) return [];
      return [
        ...Object.values(state.launchRunsByKey),
        ...Object.values(state.runsByProjectId),
      ].filter((run) => runBelongsToWorkspace(run, workspaceRoot));
    }),
  );
}

/** A run's name in lists: its launch configuration, else its command. */
export function devServerRunLabel(run: ProjectDevServer): string {
  return run.launchName ?? run.command;
}

export function BrowserDevServerLogsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly run: ProjectDevServer;
}) {
  const { t } = useTranslation();
  const api = readNativeApi();
  const logQuery = useQuery({
    queryKey: [
      "browser-panel",
      "dev-server-log",
      props.run.projectId,
      props.run.launchName ?? null,
      props.run.startedAt,
    ],
    queryFn: async () => {
      const result = await api?.projects.readDevServerLog?.({
        projectId: props.run.projectId,
        ...(props.run.launchName ? { launchName: props.run.launchName } : {}),
      });
      return plainTerminalLog(result?.log ?? "");
    },
    enabled: props.open && api !== null,
    refetchInterval: props.open ? 2_000 : false,
  });
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl" data-browser-dev-server-logs="">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{t("browser.devLogs.title")}</span>
            {props.run.launchName ? (
              <span className="min-w-0 truncate text-ui font-normal" data-translation-skip="true">
                {props.run.launchName}
              </span>
            ) : null}
            <span
              className="min-w-0 truncate font-mono text-ui-sm font-normal text-muted-foreground"
              data-translation-skip="true"
            >
              {props.run.command}
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <pre
            className="m-0 h-[min(60vh,28rem)] overflow-auto rounded-card bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-3 font-mono text-chat-code whitespace-pre-wrap break-words"
            data-translation-skip="true"
          >
            {logQuery.data && logQuery.data.length > 0 ? logQuery.data : t("browser.devLogs.empty")}
          </pre>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={() => void logQuery.refetch()}>
            <RefreshCwIcon className={logQuery.isFetching ? "size-4 animate-spin" : "size-4"} />
            {t("browser.devLogs.refresh")}
          </Button>
          <Button variant="outline" onClick={() => props.onOpenChange(false)}>
            {t("browser.devLogs.close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

interface LaunchRunExitLog {
  readonly name: string;
  readonly log: string;
}

/** The last output of a run that stopped before it answered, opened from its failure toast. */
export const useLaunchRunExitLogStore = create<{
  readonly entry: LaunchRunExitLog | null;
  readonly show: (entry: LaunchRunExitLog) => void;
  readonly close: () => void;
}>((set) => ({
  entry: null,
  show: (entry) => set({ entry }),
  close: () => set({ entry: null }),
}));

/** Mounted once at the app root: shows a stopped run's last output ("View log"). */
export function LaunchRunExitLogDialogHost() {
  const { t } = useTranslation();
  const entry = useLaunchRunExitLogStore((state) => state.entry);
  const close = useLaunchRunExitLogStore((state) => state.close);
  const log = entry ? plainTerminalLog(entry.log) : "";
  return (
    <Dialog open={entry !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="max-w-3xl" data-launch-run-exit-log="">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>{t("browser.devLogs.title")}</span>
            {entry ? (
              <span className="min-w-0 truncate text-ui font-normal" data-translation-skip="true">
                {entry.name}
              </span>
            ) : null}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <pre
            className="m-0 h-[min(60vh,28rem)] overflow-auto rounded-card bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] p-3 font-mono text-chat-code whitespace-pre-wrap break-words"
            data-translation-skip="true"
          >
            {log.length > 0 ? log : t("browser.devLogs.empty")}
          </pre>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t("browser.devLogs.close")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
