// FILE: projectRunStore.ts
// Purpose: Client-side projection of the server-owned dev-server registry, keyed by project id.
// Layer: Web UI state
// Exports: useProjectRunStore plus helpers for syncing dev-server lifecycle events.

import type { ProjectDevServer, ProjectId } from "@moss/contracts";

/**
 * A tracked dev server as projected from the server. This mirrors the
 * `ProjectDevServer` contract exactly — the client no longer owns thread or
 * terminal identifiers, because dev servers are first-class server processes.
 */
export type ProjectRunState = ProjectDevServer;

interface ProjectRunStoreState {
  /** Each project's one sidebar run. */
  runsByProjectId: Record<ProjectId, ProjectRunState>;
  /** Runs of launch configurations (`.moss/launch.json`), by `launchRunKey`. */
  launchRunsByKey: Record<string, ProjectRunState>;
  /** What a launch run printed last before it exited on its own, by `launchRunKey`. */
  launchExitOutputByKey: Record<string, string>;
  /** Replace the entire registry from an authoritative server snapshot. */
  replaceAll: (servers: ReadonlyArray<ProjectDevServer>) => void;
  /** Insert or update a single tracked dev server. */
  upsertRun: (server: ProjectDevServer) => void;
  /** Drop a tracked dev server by project id (and launch name for a launch run). */
  removeRun: (projectId: ProjectId, launchName?: string, exitOutput?: string) => void;
}

/** Where a launch configuration's run is kept: its project and its name. */
export function launchRunKey(projectId: ProjectId, launchName: string): string {
  return `${projectId}\u0000${launchName}`;
}

import { create } from "zustand";

function splitRuns(servers: ReadonlyArray<ProjectDevServer>): {
  runsByProjectId: Record<ProjectId, ProjectRunState>;
  launchRunsByKey: Record<string, ProjectRunState>;
} {
  const runsByProjectId: Record<ProjectId, ProjectRunState> = {};
  const launchRunsByKey: Record<string, ProjectRunState> = {};
  for (const server of servers) {
    if (server.launchName) {
      launchRunsByKey[launchRunKey(server.projectId, server.launchName)] = server;
    } else {
      runsByProjectId[server.projectId] = server;
    }
  }
  return { runsByProjectId, launchRunsByKey };
}

export const useProjectRunStore = create<ProjectRunStoreState>((set) => ({
  runsByProjectId: {},
  launchRunsByKey: {},
  launchExitOutputByKey: {},
  replaceAll: (servers) => set(() => splitRuns(servers)),
  upsertRun: (server) =>
    set((state) =>
      server.launchName
        ? {
            launchRunsByKey: {
              ...state.launchRunsByKey,
              [launchRunKey(server.projectId, server.launchName)]: server,
            },
          }
        : {
            runsByProjectId: {
              ...state.runsByProjectId,
              [server.projectId]: server,
            },
          },
    ),
  removeRun: (projectId, launchName, exitOutput) =>
    set((state) => {
      if (launchName) {
        const key = launchRunKey(projectId, launchName);
        if (!state.launchRunsByKey[key]) return state;
        const nextLaunchRunsByKey = { ...state.launchRunsByKey };
        delete nextLaunchRunsByKey[key];
        const nextExitOutput = { ...state.launchExitOutputByKey };
        if (exitOutput) nextExitOutput[key] = exitOutput;
        else delete nextExitOutput[key];
        return { launchRunsByKey: nextLaunchRunsByKey, launchExitOutputByKey: nextExitOutput };
      }
      if (!state.runsByProjectId[projectId]) {
        return state;
      }
      const nextRunsByProjectId = { ...state.runsByProjectId };
      delete nextRunsByProjectId[projectId];
      return { runsByProjectId: nextRunsByProjectId };
    }),
}));
