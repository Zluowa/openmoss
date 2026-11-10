// FILE: launchServers.logic.ts
// Purpose: One list of a project's servers, as the new tab and the Environment card show
//   it: its launch configurations (each with its run state), then servers found running
//   in the project that no configuration covers. Servers elsewhere on the computer are
//   returned apart.
// Layer: BrowserPanel logic (pure)

import type {
  ProjectDevServer,
  ProjectLaunchConfiguration,
  ServerLocalServerProcess,
} from "@moss/contracts";
import {
  localServerBelongsToWorkspace,
  localServerOpenUrl,
  localServerPrimaryLabel,
} from "@moss/shared/localServers";

export type LaunchServerState = "idle" | "starting" | "running";

export interface LaunchServerRow {
  readonly key: string;
  readonly name: string;
  readonly port: number | null;
  /** Where the row opens: the running server's address, else the configured one. */
  readonly url: string | null;
  readonly state: LaunchServerState;
  /** The launch configuration; null for a server found running that none covers. */
  readonly configuration: ProjectLaunchConfiguration | null;
  /** Moss runs it (started from a list): it can be stopped and its output read. */
  readonly run: ProjectDevServer | null;
  /** The running process found on this computer, when there is one. */
  readonly detected: ServerLocalServerProcess | null;
}

/** Rows shown before "See all". */
export const LAUNCH_SERVER_LIST_COLLAPSED_COUNT = 5;

function localUrl(port: number): string {
  return `http://localhost:${port}/`;
}

function runOwnsServer(run: ProjectDevServer, server: ServerLocalServerProcess): boolean {
  return run.pid !== null && (server.pid === run.pid || server.ppid === run.pid);
}

export function buildLaunchServerRows(input: {
  readonly configurations: readonly ProjectLaunchConfiguration[];
  /** This project's launch runs. */
  readonly launchRuns: readonly ProjectDevServer[];
  /** Every server found listening on this computer. */
  readonly detectedServers: readonly ServerLocalServerProcess[];
  readonly workspaceRoot: string | null | undefined;
}): {
  readonly rows: readonly LaunchServerRow[];
  /** Servers running elsewhere on the computer that no row covers. */
  readonly elsewhere: readonly ServerLocalServerProcess[];
} {
  const claimed = new Set<string>();
  const rows: LaunchServerRow[] = [];
  const findDetected = (port: number | null, run: ProjectDevServer | null) =>
    input.detectedServers.find(
      (server) =>
        !claimed.has(server.id) &&
        ((port !== null && server.ports.includes(port)) ||
          (run !== null && runOwnsServer(run, server))),
    ) ?? null;

  const rowForRun = (
    name: string,
    configuration: ProjectLaunchConfiguration | null,
    run: ProjectDevServer | null,
  ): LaunchServerRow => {
    const configuredPort = run?.port ?? configuration?.port ?? null;
    const detected = findDetected(configuredPort, run);
    if (detected) claimed.add(detected.id);
    const port = configuredPort ?? detected?.ports[0] ?? null;
    const state: LaunchServerState =
      run?.status === "running" || detected
        ? "running"
        : run?.status === "starting"
          ? "starting"
          : "idle";
    const url =
      run?.url ??
      (detected ? localServerOpenUrl(detected) : null) ??
      configuration?.url ??
      (port !== null ? localUrl(port) : null);
    return {
      key: `launch:${name}`,
      name,
      port,
      url,
      state,
      configuration,
      run,
      detected,
    };
  };

  for (const configuration of input.configurations) {
    const run = input.launchRuns.find((entry) => entry.launchName === configuration.name) ?? null;
    rows.push(rowForRun(configuration.name, configuration, run));
  }
  // A run whose entry left the file since it started can still be stopped.
  for (const run of input.launchRuns) {
    if (!run.launchName || rows.some((row) => row.name === run.launchName)) continue;
    rows.push(rowForRun(run.launchName, null, run));
  }

  const elsewhere: ServerLocalServerProcess[] = [];
  for (const server of input.detectedServers) {
    if (claimed.has(server.id)) continue;
    if (!localServerBelongsToWorkspace(server, input.workspaceRoot)) {
      elsewhere.push(server);
      continue;
    }
    const port = server.ports[0] ?? null;
    rows.push({
      key: `detected:${server.id}`,
      name: localServerPrimaryLabel(server),
      port,
      url: localServerOpenUrl(server),
      state: "running",
      configuration: null,
      run: null,
      detected: server,
    });
  }
  return { rows, elsewhere };
}

/** Whether pressing the row's button starts it (otherwise it opens or stops it). */
export function launchServerRowStartable(row: LaunchServerRow): boolean {
  return row.state === "idle" && Boolean(row.configuration?.command);
}

/** Whether the row can be stopped from the list. */
export function launchServerRowStoppable(row: LaunchServerRow): boolean {
  if (row.run) return true;
  return row.detected?.isStoppable === true;
}

// Terminal control sequences (colours, cursor moves, titles) do not belong in a plain log.
const ANSI_SEQUENCE_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;

// The shell Moss runs a server in says hello and echoes the command (PowerShell's banner
// and "PS …>" prompt); the server's own output is what the log is for.
const SHELL_NOISE_LINE_PATTERN =
  /^(?:Windows PowerShell|Copyright \(C\) Microsoft Corporation\b.*|PS [^>\n]*>.*)$/gm;

export function plainTerminalLog(raw: string): string {
  return (
    raw
      .replace(ANSI_SEQUENCE_PATTERN, "")
      // A backspace takes back the character before it (shells echo that way).
      // eslint-disable-next-line no-control-regex
      .replace(/[^\n]\u0008/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/^.*\r(?!\n)/gm, "")
      .replace(SHELL_NOISE_LINE_PATTERN, "")
      .replace(/^\n+/, "")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()
  );
}
