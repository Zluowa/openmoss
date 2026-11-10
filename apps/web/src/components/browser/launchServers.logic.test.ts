import {
  ProjectId,
  type ProjectDevServer,
  type ProjectLaunchConfiguration,
  type ServerLocalServerProcess,
} from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  buildLaunchServerRows,
  launchServerRowStartable,
  launchServerRowStoppable,
  plainTerminalLog,
} from "./launchServers.logic";

const ROOT = "D:\\work\\shop";

// What a launch run's PowerShell window really prints (title, colours, a backspaced echo).
const POWERSHELL_RUN_OUTPUT =
  "\u001b[mWindows PowerShell\r\nCopyright (C) Microsoft Corporation. All rights reserved." +
  "\u001b]0;C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\u0007" +
  "PS C:\\site> \u001b[93mn\u001b[m\u001b[93m\bnode \u001b[37mserver.js\r\n" +
  "\u001b[m  VITE fixture ready at http://localhost:5941/\r\n";

describe("dev server output", () => {
  it("keeps only what the server printed", () => {
    expect(plainTerminalLog(POWERSHELL_RUN_OUTPUT)).toBe(
      "  VITE fixture ready at http://localhost:5941/",
    );
  });
});
const projectId = ProjectId.makeUnsafe("project-1");

function config(
  name: string,
  port: number | null,
  command: string | null = "npm run dev",
): ProjectLaunchConfiguration {
  return {
    name,
    command,
    cwd: ROOT,
    port,
    url: port ? `http://localhost:${port}/` : null,
  };
}

function run(overrides: Partial<ProjectDevServer>): ProjectDevServer {
  return {
    projectId,
    command: "npm run dev",
    cwd: ROOT,
    pid: 400,
    startedAt: "2026-11-04T10:00:00.000Z",
    status: "starting",
    ...overrides,
  };
}

function server(
  id: string,
  port: number,
  overrides: Partial<ServerLocalServerProcess> = {},
): ServerLocalServerProcess {
  return {
    id,
    pid: Number(id),
    command: "node",
    args: "node server.js",
    displayName: `Server ${id}`,
    ports: [port],
    addresses: [{ host: "127.0.0.1", port, url: `http://127.0.0.1:${port}/`, family: "tcp4" }],
    isStoppable: true,
    cwd: ROOT,
    ...overrides,
  };
}

describe("buildLaunchServerRows", () => {
  it("lists configurations in file order, idle until something answers", () => {
    const { rows } = buildLaunchServerRows({
      configurations: [config("web", 5173), config("docs", 3000)],
      launchRuns: [],
      detectedServers: [],
      workspaceRoot: ROOT,
    });
    expect(rows.map((row) => [row.name, row.port, row.state])).toEqual([
      ["web", 5173, "idle"],
      ["docs", 3000, "idle"],
    ]);
    expect(launchServerRowStartable(rows[0]!)).toBe(true);
    expect(launchServerRowStoppable(rows[0]!)).toBe(false);
  });

  it("marks a configuration running when its port is already served, wherever from", () => {
    const { rows, elsewhere } = buildLaunchServerRows({
      configurations: [config("web", 5173)],
      launchRuns: [],
      detectedServers: [server("10", 5173, { cwd: "C:\\elsewhere" })],
      workspaceRoot: ROOT,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "running", url: "http://127.0.0.1:5173/" });
    expect(elsewhere).toEqual([]);
  });

  it("follows a Moss run from starting to running, at the port it printed", () => {
    const starting = buildLaunchServerRows({
      configurations: [config("web", null)],
      launchRuns: [run({ launchName: "web" })],
      detectedServers: [],
      workspaceRoot: ROOT,
    });
    expect(starting.rows[0]).toMatchObject({ state: "starting", port: null });

    const ready = buildLaunchServerRows({
      configurations: [config("web", null)],
      launchRuns: [
        run({ launchName: "web", status: "running", port: 5174, url: "http://localhost:5174/" }),
      ],
      detectedServers: [server("401", 5174, { ppid: 400 })],
      workspaceRoot: ROOT,
    });
    expect(ready.rows).toHaveLength(1);
    expect(ready.rows[0]).toMatchObject({
      state: "running",
      port: 5174,
      url: "http://localhost:5174/",
    });
    expect(launchServerRowStoppable(ready.rows[0]!)).toBe(true);
  });

  it("adds project servers no configuration covers, and keeps the rest apart", () => {
    // Folder unknown, but Moss started it: it counts as the project's.
    const { cwd: _unknownFolder, ...startedByMoss } = server("40", 7000, { launchedByMoss: true });
    const { rows, elsewhere } = buildLaunchServerRows({
      configurations: [config("web", 5173)],
      launchRuns: [],
      detectedServers: [
        server("20", 8080),
        server("30", 9000, { cwd: "C:\\other" }),
        startedByMoss,
      ],
      workspaceRoot: ROOT,
    });
    expect(rows.map((row) => [row.key, row.state])).toEqual([
      ["launch:web", "idle"],
      ["detected:20", "running"],
      ["detected:40", "running"],
    ]);
    expect(elsewhere.map((entry) => entry.id)).toEqual(["30"]);
  });

  it("keeps a run whose entry left the file, so it can still be stopped", () => {
    const { rows } = buildLaunchServerRows({
      configurations: [],
      launchRuns: [run({ launchName: "old", status: "running", port: 4000 })],
      detectedServers: [],
      workspaceRoot: ROOT,
    });
    expect(rows[0]).toMatchObject({ name: "old", state: "running", configuration: null });
    expect(launchServerRowStoppable(rows[0]!)).toBe(true);
  });

  it("only opens an entry that has an address and no command", () => {
    const { rows } = buildLaunchServerRows({
      configurations: [{ ...config("staging", null, null), url: "https://staging.test/" }],
      launchRuns: [],
      detectedServers: [],
      workspaceRoot: ROOT,
    });
    expect(launchServerRowStartable(rows[0]!)).toBe(false);
    expect(rows[0]?.url).toBe("https://staging.test/");
  });
});
