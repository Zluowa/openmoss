// FILE: useProjectLaunchServers.ts
// Purpose: A project's servers for the new tab, the Environment card and the browser's
//   servers button: its launch configurations with their run state, servers found running,
//   and the actions behind ▷ (start, then open once the port answers), open and stop.
// Layer: BrowserPanel hook
//
// Reads are on demand: the launch file and the port scan only run while a list is on
// screen (`enabled`). A run Moss starts is a dev server of the project's (see
// `apps/server/src/devServerManager.ts`), so its output feeds "Show dev server logs".

import { PROJECT_DEV_SERVER_PROGRAM_NOT_FOUND_CODE, type ProjectId } from "@moss/contracts";
import {
  classifyLaunchRunFailure,
  commandProgram,
  launchProgramProduct,
} from "@moss/shared/launchRunFailure";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { projectLaunchConfigurationsQueryOptions } from "~/lib/projectReactQuery";
import { serverLocalServersQueryOptions, serverQueryKeys } from "~/lib/serverReactQuery";
import { useTranslation } from "~/localization";
import { readNativeApi } from "~/nativeApi";
import { launchRunKey, useProjectRunStore } from "~/projectRunStore";
import { projectScriptRuntimeEnv } from "~/projectScripts";

import { toastManager } from "../ui/toast";
import { useLaunchRunExitLogStore } from "./BrowserDevServerLogsDialog";
import {
  buildLaunchServerRows,
  launchServerRowStartable,
  type LaunchServerRow,
} from "./launchServers.logic";

const LAUNCH_READY_TIMEOUT_MS = 120_000;
const pendingOpenCancels = new Map<string, () => void>();

/**
 * Calls `open` with the run's address once Moss sees its port answer. Gives up when the
 * run stops first (`onStopped`) or after two minutes. A newer wait for the same run
 * replaces an older one, so a double click opens one page.
 */
export function openWhenLaunchRunReady(input: {
  readonly projectId: ProjectId;
  readonly launchName: string;
  readonly open: (url: string) => void;
  /** The run ended before it answered; `output` is what it printed last, when known. */
  readonly onStopped?: (output: string | null) => void;
}): () => void {
  const key = launchRunKey(input.projectId, input.launchName);
  pendingOpenCancels.get(key)?.();
  let finished = false;
  let unsubscribe: (() => void) | null = null;
  const finish = () => {
    if (finished) return;
    finished = true;
    unsubscribe?.();
    window.clearTimeout(timer);
    if (pendingOpenCancels.get(key) === finish) pendingOpenCancels.delete(key);
  };
  const check = () => {
    if (finished) return;
    const state = useProjectRunStore.getState();
    const run = state.launchRunsByKey[key];
    if (!run) {
      finish();
      input.onStopped?.(state.launchExitOutputByKey[key] ?? null);
      return;
    }
    if (run.status === "running" && run.url) {
      finish();
      input.open(run.url);
    }
  };
  const timer = window.setTimeout(finish, LAUNCH_READY_TIMEOUT_MS);
  pendingOpenCancels.set(key, finish);
  unsubscribe = useProjectRunStore.subscribe(check);
  check();
  return finish;
}

export interface ProjectLaunchServers {
  readonly rows: readonly LaunchServerRow[];
  readonly elsewhere: ReturnType<typeof buildLaunchServerRows>["elsewhere"];
  /** The launch file has been read (until then the footer does not name a source). */
  readonly loaded: boolean;
  readonly source: "moss" | "claude" | "packageScripts" | "none";
  /** The file the list is edited in, relative to the project. */
  readonly editFile: string;
  /** Its absolute path when it exists. */
  readonly editFilePath: string | null;
  readonly problems: readonly string[];
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  /** Opens a running row, or starts it and opens it once its port answers. */
  readonly openOrStart: (row: LaunchServerRow) => void;
  readonly stop: (row: LaunchServerRow) => void;
}

export function useProjectLaunchServers(input: {
  readonly projectId: ProjectId | null | undefined;
  readonly workspaceRoot: string | null | undefined;
  /** Read the launch file and scan ports only while a list is on screen. */
  readonly enabled: boolean;
  /** Shows an address in the browser panel. */
  readonly onOpen: (url: string) => void;
}): ProjectLaunchServers {
  const { t, format } = useTranslation();
  const queryClient = useQueryClient();
  const projectId = input.projectId ?? null;
  const workspaceRoot = input.workspaceRoot ?? null;
  const launchQuery = useQuery(
    projectLaunchConfigurationsQueryOptions({ cwd: workspaceRoot, enabled: input.enabled }),
  );
  const localServersQuery = useQuery(serverLocalServersQueryOptions(input.enabled));
  const launchRuns = useProjectRunStore(
    useShallow((state) =>
      projectId
        ? Object.values(state.launchRunsByKey).filter((run) => run.projectId === projectId)
        : [],
    ),
  );
  const configurations = launchQuery.data?.configurations;
  const detectedServers = localServersQuery.data?.servers;
  const { rows, elsewhere } = useMemo(
    () =>
      buildLaunchServerRows({
        configurations: configurations ?? [],
        launchRuns,
        detectedServers: detectedServers ?? [],
        workspaceRoot,
      }),
    [configurations, detectedServers, launchRuns, workspaceRoot],
  );

  const reportError = (title: string, cause: unknown) => {
    toastManager.add({
      type: "error",
      title,
      description: cause instanceof Error ? cause.message : undefined,
    });
  };

  // One plain sentence for a missing program: "找不到 python，请先安装 Python".
  const programMissingMessage = (program: string) => {
    const product = launchProgramProduct(program);
    return product
      ? format("browser.servers.programMissing", { program, product })
      : format("browser.servers.programMissingUnknown", { program });
  };

  // A run that ended before it answered: say why in one sentence, never the shell's text,
  // and offer what it printed behind "View log".
  const reportStopped = (row: LaunchServerRow, output: string | null) => {
    const configuration = row.configuration;
    const failure = classifyLaunchRunFailure({
      output,
      program: configuration?.command ? commandProgram(configuration.command) : null,
      port: configuration?.port ?? null,
    });
    const title =
      failure.kind === "program-missing"
        ? programMissingMessage(failure.program)
        : failure.kind === "port-in-use" && failure.port !== null
          ? format("browser.servers.portInUse", { name: row.name, port: String(failure.port) })
          : format("browser.servers.didNotStart", { name: row.name });
    const log = output?.trim() ?? "";
    toastManager.add({
      type: "error",
      title,
      ...(log.length > 0
        ? {
            actionProps: {
              children: t("browser.servers.viewLog"),
              onClick: () => useLaunchRunExitLogStore.getState().show({ name: row.name, log }),
            },
          }
        : {}),
    });
  };

  const start = (row: LaunchServerRow) => {
    const api = readNativeApi();
    const configuration = row.configuration;
    if (!api || !configuration?.command) return;
    if (!projectId || !workspaceRoot) {
      reportError(format("browser.servers.startFailed", { name: row.name }), null);
      return;
    }
    const store = useProjectRunStore.getState();
    const startedAt = new Date().toISOString();
    store.upsertRun({
      projectId,
      command: configuration.command,
      cwd: configuration.cwd,
      pid: null,
      startedAt,
      status: "starting",
      launchName: configuration.name,
      ...(configuration.port !== null ? { port: configuration.port } : {}),
    });
    openWhenLaunchRunReady({
      projectId,
      launchName: configuration.name,
      open: input.onOpen,
      onStopped: (output) => reportStopped(row, output),
    });
    void api.projects
      .runDevServer({
        projectId,
        command: configuration.command,
        cwd: configuration.cwd,
        env: {
          ...projectScriptRuntimeEnv({ project: { cwd: workspaceRoot }, worktreePath: null }),
          ...configuration.env,
        },
        launchName: configuration.name,
        ...(configuration.port !== null ? { port: configuration.port } : {}),
      })
      .then(
        ({ server }) => {
          // The event stream may already have moved the run on (ready, or gone).
          const current =
            useProjectRunStore.getState().launchRunsByKey[
              launchRunKey(projectId, configuration.name)
            ];
          if (!current || current.startedAt === startedAt) {
            useProjectRunStore.getState().upsertRun(server);
          }
          void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
        },
        (cause: unknown) => {
          // Cancel the wait first: this failure is reported once, here.
          pendingOpenCancels.get(launchRunKey(projectId, configuration.name))?.();
          useProjectRunStore.getState().removeRun(projectId, configuration.name);
          const code = (cause as { readonly code?: unknown } | null)?.code;
          const program = cause instanceof Error ? cause.message.trim() : "";
          if (code === PROJECT_DEV_SERVER_PROGRAM_NOT_FOUND_CODE && program) {
            toastManager.add({ type: "error", title: programMissingMessage(program) });
            return;
          }
          toastManager.add({
            type: "error",
            title: format("browser.servers.startFailed", { name: row.name }),
          });
        },
      );
  };

  const openOrStart = (row: LaunchServerRow) => {
    if (row.state === "running" && row.url) {
      input.onOpen(row.url);
      return;
    }
    if (launchServerRowStartable(row)) {
      start(row);
      return;
    }
    if (row.state === "starting" && projectId && row.configuration) {
      openWhenLaunchRunReady({
        projectId,
        launchName: row.configuration.name,
        open: input.onOpen,
      });
      return;
    }
    if (row.url) input.onOpen(row.url);
  };

  const stop = (row: LaunchServerRow) => {
    const api = readNativeApi();
    if (!api) return;
    if (row.run && projectId && row.run.launchName) {
      const launchName = row.run.launchName;
      pendingOpenCancels.get(launchRunKey(projectId, launchName))?.();
      useProjectRunStore.getState().removeRun(projectId, launchName);
      void api.projects
        .stopDevServer({ projectId, launchName })
        .catch((cause: unknown) =>
          reportError(format("browser.servers.stopFailed", { name: row.name }), cause),
        )
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
        });
      return;
    }
    const detected = row.detected;
    if (detected?.isStoppable) {
      void api.server
        .stopLocalServer({ pid: detected.pid, port: detected.ports[0] ?? 1 })
        .catch((cause: unknown) =>
          reportError(format("browser.servers.stopFailed", { name: row.name }), cause),
        )
        .finally(() => {
          void queryClient.invalidateQueries({ queryKey: serverQueryKeys.localServers() });
        });
    }
  };

  return {
    rows,
    elsewhere,
    loaded: launchQuery.data !== undefined,
    source: launchQuery.data?.source ?? "none",
    editFile: launchQuery.data?.editFile ?? ".moss/launch.json",
    editFilePath: launchQuery.data?.editFilePath ?? null,
    problems: launchQuery.data?.problems ?? [],
    loading: launchQuery.isLoading || (localServersQuery.isLoading && rows.length === 0),
    refreshing: launchQuery.isFetching || localServersQuery.isFetching,
    refresh: () => {
      void launchQuery.refetch();
      void localServersQuery.refetch();
    },
    openOrStart,
    stop,
  };
}
