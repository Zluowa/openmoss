/**
 * Real native CLI acceptance for the managed plugin lifecycle; no model turns.
 *
 * bun scripts/moss-managed-plugin-smoke.ts --codex /absolute/path/to/codex
 * MOSS_PLUGIN_SMOKE_CODEX_BINARY is an alternative to --codex.
 *
 * By default this uses production process-tree teardown. Restricted sandboxes
 * without process enumeration may explicitly opt into --allow-root-exit-only.
 * That mode proves ONLY native root exit, never production teardown safety.
 * All state lives in a fresh temporary directory; no personal CLI home is used.
 */
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@synara/contracts";
import { readManagedCodexHomeAuthority } from "../apps/server/src/account/mossManagedHomeAuthority.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";

import { CodexAppServerManager } from "../apps/server/src/codexAppServerManager.ts";
import {
  buildMossManagedCodexConfig,
  MOSS_MANAGED_DEFAULT_MODEL,
} from "../apps/server/src/account/Layers/MossManagedProvider.ts";
import { materializeMossBundledPluginMarketplace } from "../apps/server/src/account/mossBundledPluginMarketplace.ts";
import { writeMossManagedPluginConfig } from "../apps/server/src/account/mossManagedPluginConfig.ts";
import { resolveActiveCodexHomeWritePath } from "../apps/server/src/codexHomePaths.ts";
import {
  finalizeManagedPluginSmoke,
  ManagedPluginSmokeFinalizationError,
} from "./moss-managed-plugin-smoke-cleanup.ts";

const { values } = parseArgs({
  options: {
    codex: { type: "string" },
    output: { type: "string" },
    "keep-workspace": { type: "boolean", default: false },
    "allow-root-exit-only": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: bun scripts/moss-managed-plugin-smoke.ts [--codex PATH] [--output REPORT.json] [--keep-workspace] [--allow-root-exit-only]",
  );
  process.exit(0);
}

const binaryPath = values.codex ?? process.env.MOSS_PLUGIN_SMOKE_CODEX_BINARY ?? "codex";
const allowRootExitOnly = values["allow-root-exit-only"];
const root = await mkdtemp(path.join(tmpdir(), "moss-managed-plugin-smoke-"));
const home = path.join(root, "moss-codex-home");
const runtimeRoot = path.join(root, "runtime");
const ownershipNonce = randomUUID();
const managedSettings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    ...DEFAULT_SERVER_SETTINGS.providers,
    codex: {
      ...DEFAULT_SERVER_SETTINGS.providers.codex,
      accounts: [{ id: "moss", label: "Moss", homePath: home, shadowHomePath: "" }],
    },
  },
  providerInstances: {
    codex_moss: {
      driver: "codex",
      enabled: true,
      config: {
        managed: true,
        accountId: "moss",
        homePath: home,
        homeOwnershipNonce: ownershipNonce,
      },
    },
  },
};
const configPath = path.join(home, "config.toml");
const teardownVerification = allowRootExitOnly
  ? "test-only root exit; full production process-tree teardown NOT verified"
  : "production process-tree teardown";

type ManagerOptions = NonNullable<ConstructorParameters<typeof CodexAppServerManager>[1]>;
const rootExitOnly: NonNullable<ManagerOptions["teardownProcessTree"]> = async ({
  rootPid,
  rootExited,
}) => {
  assert(Number.isSafeInteger(rootPid) && rootPid > 1 && rootPid !== process.pid);
  try {
    process.kill(rootPid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      rootExited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native root did not exit within 10 seconds.")),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { escalated: false, signalErrors: [], capturedBeforeRootExit: false };
};

const createManager = () =>
  new CodexAppServerManager(undefined, {
    managedCodexHomePath: home,
    readManagedHomeAuthority: (options) =>
      readManagedCodexHomeAuthority({
        stateDir: root,
        readSettings: async () => managedSettings,
        readSettingsSync: () => managedSettings,
        input: { ...options, env: { ...process.env, ...options?.environment } },
      }),
    mossSkillsDir: path.join(root, "skills"),
    ...(allowRootExitOnly ? { teardownProcessTree: rootExitOnly } : {}),
  });
type PluginList = Awaited<ReturnType<CodexAppServerManager["listPlugins"]>>;
const plugin = (list: PluginList, name: string) =>
  list.marketplaces.flatMap((market) => market.plugins).find((item) => item.name === name);
let manager: CodexAppServerManager | undefined;
let teardownComplete = false;

try {
  const version = (
    await promisify(execFile)(binaryPath, ["--version"], { timeout: 15_000, maxBuffer: 4096 })
  ).stdout.trim();
  await mkdir(home, { mode: 0o700 });
  await writeFile(
    path.join(home, ".moss-managed-home"),
    `moss-managed-codex-home-v2:${ownershipNonce}\n`,
    { mode: 0o600 },
  );
  const marketplace = materializeMossBundledPluginMarketplace(home);
  // The normal service builder is used, but there is deliberately no credential
  // or reachable billing endpoint. This probe never starts an inference turn.
  const generatedConfig = buildMossManagedCodexConfig({
    gatewayBaseUrl: "https://gateway.example.invalid",
    defaultModel: MOSS_MANAGED_DEFAULT_MODEL,
    credentialEnvKey: "MOSS_PLUGIN_SMOKE_UNUSED_TOKEN",
    bundledPluginMarketplaceRoot: marketplace.root,
  });
  const refreshConfig = () =>
    writeMossManagedPluginConfig({ managedHomePath: home, configPath, generatedConfig });
  await refreshConfig();
  const discovery = {
    cwd: root,
    forceReload: true,
    codexOptions: {
      homePath: home,
      accountId: "moss",
      binaryPath,
      environment: { MOSS_HOME: runtimeRoot },
    },
  };

  manager = createManager();
  const first = await manager.listPlugins(discovery);
  assert.equal(plugin(first, "moss-imagegen")?.installed, true);
  assert.equal(plugin(first, "moss-plugin-creator")?.installed, true);
  const skills = await manager.listSkills(discovery);
  assert(skills.skills.some((skill) => skill.name === "moss-imagegen:moss-imagegen"));
  assert(skills.skills.some((skill) => skill.name === "moss-plugin-creator:plugin-creator"));

  const runtimeHome = resolveActiveCodexHomeWritePath({
    homePath: home,
    accountId: "moss",
    env: { ...process.env, MOSS_HOME: runtimeRoot },
  });
  if (process.platform === "win32") assert.equal(runtimeHome, home);
  else assert.notEqual(runtimeHome, home);
  assert.equal(
    await realpath(path.join(runtimeHome, "plugins")),
    await realpath(path.join(home, "plugins")),
  );
  await manager.installPlugin({
    ...discovery,
    marketplacePath: marketplace.manifestPath,
    pluginName: "moss-kling",
  });
  await manager.setPluginEnabled({
    ...discovery,
    pluginId: "moss-kling@moss-bundled",
    enabled: false,
  });
  await manager.stopAll();
  await refreshConfig();

  manager = createManager();
  const restarted = await manager.listPlugins(discovery);
  assert.equal(plugin(restarted, "moss-imagegen")?.installed, true);
  assert.equal(plugin(restarted, "moss-kling")?.installed, true);
  assert.equal(plugin(restarted, "moss-kling")?.enabled, false);
  await manager.uninstallPlugin({ ...discovery, pluginId: "moss-imagegen@moss-bundled" });
  await manager.stopAll();
  await rm(runtimeRoot, { recursive: true, force: true });
  await refreshConfig();

  manager = createManager();
  const recreated = await manager.listPlugins(discovery);
  assert.equal(plugin(recreated, "moss-imagegen")?.installed, false);
  assert.equal(plugin(recreated, "moss-plugin-creator")?.installed, true);
  assert.equal(plugin(recreated, "moss-kling")?.installed, true);
  assert.equal(plugin(recreated, "moss-kling")?.enabled, false);
  await manager.stopAll();
  teardownComplete = true;

  const report = {
    status: "passed",
    cli: version,
    actualManager: true,
    teardownVerification,
    productionTeardownVerified: !allowRootExitOnly,
    defaultPluginsInstalled: ["moss-imagegen", "moss-plugin-creator"],
    skillsVisible: true,
    cacheBoundToManagedSource: true,
    canonicalWindowsHome: process.platform === "win32",
    optionalDisableSurvivesRestart: true,
    defaultUninstallSurvivesOverlayRecreation: true,
    otherPluginsSurviveOverlayRecreation: true,
    // Plugin choices belong to this local managed installation. Cloud account
    // credentials and realm isolation are separate service/gateway checks.
    scope:
      "local managed plugin lifecycle; no model generation, billing, or cloud tenant isolation assertion",
  };
  await finalizeManagedPluginSmoke(report, {
    root,
    keepWorkspace: values["keep-workspace"],
    ...(values.output ? { output: values.output } : {}),
  });
} catch (error) {
  console.error(
    JSON.stringify(
      {
        status: "failed",
        stage: error instanceof ManagedPluginSmokeFinalizationError ? error.stage : "lifecycle",
        teardownVerification,
        workspace: root,
        error: String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  if (!teardownComplete && manager) {
    try {
      await manager.stopAll();
      teardownComplete = true;
    } catch (error) {
      console.error(`Native teardown failed; workspace retained at ${root}: ${String(error)}`);
      process.exitCode = 1;
    }
  }
}
