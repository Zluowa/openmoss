import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager.ts";

const pluginName = "abrupt-reconcile-fixture";
const marketplaceName = "abrupt-reconcile-marketplace";
const pluginId = `${pluginName}@${marketplaceName}`;
const marketplacePath = "/fixtures/abrupt-reconcile-marketplace.json";

type ManagerInternals = {
  readonly discoverySessions: Map<string, unknown>;
  readonly pluginsCache: Map<string, unknown>;
  readonly pluginDetailCache: Map<string, unknown>;
  readonly skillsCache: Map<string, unknown>;
  readonly appListCache: Map<string, unknown>;
  readonly pluginMutationLocks: Map<string, Promise<void>>;
};

type CapturedRequest = {
  readonly method: string;
  readonly params: unknown;
};

type AuthoritativeObservation = {
  readonly codexHome: string;
  readonly statePath: string;
  readonly state: PluginTruth;
};

type PluginTruth = {
  readonly installed: boolean;
  readonly enabled: boolean;
};

type MutationCase = {
  readonly name: string;
  readonly method: "plugin/install" | "config/batchWrite" | "plugin/uninstall";
  readonly prepareInstalled: boolean;
  readonly expected: PluginTruth;
  readonly mutate: (manager: CodexAppServerManager, codexOptions: CodexOptions) => Promise<unknown>;
};

type CodexOptions = NonNullable<
  Parameters<CodexAppServerManager["listPlugins"]>[0]["codexOptions"]
>;

const fixturePath = fileURLToPath(
  new URL("../../../scripts/fixtures/fake-codex-plugin-abrupt-exit.mjs", import.meta.url),
);

function makeExecutable(root: string): string {
  const executablePath = path.join(root, "fake-codex-plugin-abrupt-exit.mjs");
  writeFileSync(
    executablePath,
    `#!/usr/bin/env node\nimport ${JSON.stringify(pathToFileURL(fixturePath).href)};\n`,
    "utf8",
  );
  chmodSync(executablePath, 0o755);
  return executablePath;
}

function readRequests(requestsPath: string): CapturedRequest[] {
  if (!existsSync(requestsPath)) return [];
  return readFileSync(requestsPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CapturedRequest);
}

async function settle(promise: Promise<unknown>) {
  try {
    return { status: "fulfilled" as const, value: await promise };
  } catch (reason) {
    return { status: "rejected" as const, reason };
  }
}

async function readTruth(manager: CodexAppServerManager, codexOptions: CodexOptions) {
  const listed = await manager.listPlugins({
    cwd: process.cwd(),
    forceReload: true,
    codexOptions,
  });
  const detail = await manager.readPlugin({
    marketplacePath,
    pluginName,
    cwd: process.cwd(),
    codexOptions,
  });
  const summary = listed.marketplaces[0]?.plugins[0];
  return {
    listed: { installed: summary?.installed, enabled: summary?.enabled },
    read: {
      installed: detail.plugin.summary.installed,
      enabled: detail.plugin.summary.enabled,
    },
    listCached: listed.cached,
    readCached: detail.cached,
  };
}

const mutationCases: readonly MutationCase[] = [
  {
    name: "install",
    method: "plugin/install",
    prepareInstalled: false,
    expected: { installed: true, enabled: true },
    mutate: (manager, codexOptions) =>
      manager.installPlugin({ marketplacePath, pluginName, cwd: process.cwd(), codexOptions }),
  },
  {
    name: "config toggle",
    method: "config/batchWrite",
    prepareInstalled: true,
    expected: { installed: true, enabled: false },
    mutate: (manager, codexOptions) =>
      manager.setPluginEnabled({
        pluginId,
        enabled: false,
        cwd: process.cwd(),
        codexOptions,
      }),
  },
  {
    name: "uninstall",
    method: "plugin/uninstall",
    prepareInstalled: true,
    expected: { installed: false, enabled: false },
    mutate: (manager, codexOptions) =>
      manager.uninstallPlugin({ pluginId, cwd: process.cwd(), codexOptions }),
  },
];

describe.each(mutationCases)(
  "authoritative reconcile after abrupt $name termination",
  (testCase) => {
    it.runIf(process.platform !== "win32")(
      "does not retry the ambiguous write and rebuilds truth with a new manager",
      async () => {
        const root = mkdtempSync(path.join(os.tmpdir(), "moss-plugin-reconcile-"));
        const sourceHome = path.join(root, "codex-home");
        const requestsPath = path.join(root, "requests.jsonl");
        const observationPath = path.join(root, "authoritative-observation.json");
        const crashPath = path.join(root, "crash-next.txt");
        mkdirSync(sourceHome, { recursive: true });
        writeFileSync(path.join(sourceHome, "config.toml"), "", "utf8");
        const binaryPath = makeExecutable(root);
        const codexOptions = {
          binaryPath,
          homePath: sourceHome,
          environment: {
            HOME: root,
            PLUGIN_RECONCILE_TEST_REQUESTS_PATH: requestsPath,
            PLUGIN_RECONCILE_TEST_OBSERVATION_PATH: observationPath,
            PLUGIN_RECONCILE_TEST_CRASH_PATH: crashPath,
          },
        } satisfies CodexOptions;
        const manager = new CodexAppServerManager();
        const restartedManager = new CodexAppServerManager();

        try {
          if (testCase.prepareInstalled) {
            await manager.installPlugin({
              marketplacePath,
              pluginName,
              cwd: process.cwd(),
              codexOptions,
            });
          }
          await readTruth(manager, codexOptions);
          const internals = manager as unknown as ManagerInternals;
          internals.skillsCache.set("stale-skills", {});
          internals.appListCache.set("stale-apps", {});
          expect(internals.pluginsCache.size).toBe(1);
          expect(internals.pluginDetailCache.size).toBe(1);

          const writesBefore = readRequests(requestsPath).filter(
            ({ method }) => method === testCase.method,
          ).length;
          writeFileSync(crashPath, testCase.method, "utf8");
          const mutation = await settle(testCase.mutate(manager, codexOptions));

          expect(mutation.status).toBe("rejected");
          if (mutation.status === "rejected") {
            expect(String(mutation.reason)).toContain("codex app-server exited");
            expect(String(mutation.reason)).toContain("signal=SIGKILL");
          }
          const writesAfter = readRequests(requestsPath).filter(
            ({ method }) => method === testCase.method,
          ).length;
          expect(writesAfter - writesBefore).toBe(1);

          expect(internals.discoverySessions.size).toBe(0);
          expect(internals.pluginMutationLocks.size).toBe(0);
          expect(internals.pluginsCache.size).toBe(0);
          expect(internals.pluginDetailCache.size).toBe(0);
          expect(internals.skillsCache.size).toBe(0);
          expect(internals.appListCache.size).toBe(0);

          const observation = JSON.parse(
            readFileSync(observationPath, "utf8"),
          ) as AuthoritativeObservation;
          expect(observation.state).toEqual(testCase.expected);
          expect(path.dirname(observation.statePath)).toBe(observation.codexHome);
          expect(observation.statePath.startsWith(`${observation.codexHome}${path.sep}`)).toBe(
            true,
          );

          await expect(readTruth(restartedManager, codexOptions)).resolves.toEqual({
            listed: testCase.expected,
            read: testCase.expected,
            listCached: false,
            readCached: false,
          });
          expect(
            readRequests(requestsPath).filter(({ method }) => method === testCase.method).length,
          ).toBe(writesAfter);
        } finally {
          manager.stopAll();
          restartedManager.stopAll();
          rmSync(root, { recursive: true, force: true });
        }
      },
      20_000,
    );
  },
);
