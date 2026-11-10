import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as OS from "node:os";
import { rm as removeDirectory, chmod as changeMode } from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join, win32 } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderInstanceId, ServerProviderStatus } from "@moss/contracts";
import { DEFAULT_SERVER_SETTINGS, ServerProviderUpdateError } from "@moss/contracts";
import { MOSS_BUNDLED_CODEX_VERSION } from "@moss/shared/codexRuntime";
import { resetLocalAgentPathLookupCache } from "@moss/shared/localAgentExecutable";
import { resolveCodexExecutable } from "@moss/shared/codexExecutable";
import * as ProcessRuntime from "@moss/shared/processRuntime";
import { agentProgramsForServer } from "../agentProgramOwnership.ts";
import * as ProviderLoginManagerModule from "../providerLoginManager.ts";
import * as ManagedProviderInstallationModule from "../managedProviderInstallation.ts";
import * as ProviderInstallModule from "../providerInstall.ts";
import * as AgentInstallRuntimeModule from "../agentInstallRuntime.ts";
import { describe, it, assert } from "@effect/vitest";
import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Path,
  Ref,
  Sink,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vitest";

import { MOSS_CODEX_HOME_OVERLAY_DIR, resolveActiveCodexHomeWritePath } from "../../codexHomePaths";
import { CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE } from "../codexCliVersion.ts";
import { claudeIsolatedHomePath, resolveClaudeCodeRuntime } from "../claudeEnvironment";
import { ServerConfig } from "../../config";
import { ServerSecretStoreLive } from "../../auth/Layers/ServerSecretStore.ts";
import { canonicalizeCodexHomeIdentityPath } from "../../codexHomeIdentity.ts";
import { ServerSettingsService } from "../../serverSettings";
import {
  buildMossManagedHomeOwnershipMarker,
  readManagedCodexHomeAuthority,
} from "../../account/mossManagedHomeAuthority.ts";
import { ProviderHealth } from "../Services/ProviderHealth";
import {
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";
import {
  checkClaudeProviderStatus,
  runsMossBundledAgentRuntime,
  checkAntigravityProviderStatus,
  checkCodexProviderStatus,
  checkCursorProviderStatus,
  checkDevinProviderStatus,
  checkGrokProviderStatus,
  checkOpenCodeProviderStatus,
  checkAcpAgentProviderStatus,
  checkOmpProviderStatus,
  checkPiProviderStatus,
  makeCheckClaudeProviderStatus,
  makeCheckCodexProviderStatus,
  makeCheckCursorProviderStatus,
  makeCheckDevinProviderStatus,
  makeCheckGrokProviderStatus,
  makeClaudeProbeEnv,
  makeCheckOpenCodeProviderStatus,
  makeDisabledProviderStatus,
  makeProviderHealthLive,
  PROVIDER_UPDATES_DISABLED_ENV,
  parseAuthStatusFromOutput,
  parseClaudeAuthStatusFromOutput,
  PACKAGE_MANAGED_PROVIDER_UPDATES,
  prependPathEntry,
  PROVIDER_HEALTH_PROBE_CONCURRENCY,
  providerStatusesEqual,
  ProviderHealthLive,
  projectProviderStatusesForSettings,
  readCodexConfigModelProviderForEnv,
  runProviderHealthProbes,
  stabilizeProviderStatusesAgainstTransientTimeouts,
  makeProviderUpdateEnv,
} from "./ProviderHealth";
import {
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
} from "../acp/AcpAgentSpec";
import { buildMossManagedAcpAgentProviderInstance } from "../mossManagedAcpAgentEnvironment";
import { resolvePackageManagedProviderMaintenance } from "../providerMaintenance";
import { providerIsolatedHomePath } from "../providerProcessEnv.ts";
import { PROVIDER_NOT_INSTALLED_READINESS } from "../providerReadiness.ts";
import * as AgentCliPathFloor from "../agentCliPathFloor.ts";

// ── Test helpers ────────────────────────────────────────────────────

const encoder = new TextEncoder();

function assertProviderInstanceEnv(
  env: NodeJS.ProcessEnv | undefined,
  name: string,
  expected: string,
) {
  assert.strictEqual(env?.[name], expected);
}

function mockHandle(
  result: { stdout: string; stderr: string; code: number },
  options?: { readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode> },
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0x7ff_f_fffe),

    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(result.stdout)),
    stderr: Stream.make(encoder.encode(result.stderr)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function providerInvocationForTest(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options?: { readonly windowsVerbatimArguments?: boolean };
}): { readonly command: string; readonly args: ReadonlyArray<string> } {
  if (win32.basename(input.command).toLowerCase() !== "cmd.exe") return input;
  // Business handlers receive CLI arguments after the real Windows planner has wrapped them.
  // Keep the native boundary strict; the dedicated verbatim test receives the raw command.
  assert.isTrue(input.options?.windowsVerbatimArguments ?? false);
  assert.deepEqual(input.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.strictEqual(input.args.length, 5);
  const line = input.args[4]!;
  assert.match(line, /^call "(?:[^"]|"")*"(?: "(?:[^"]|"")*")*$/u);
  const tokens = [...line.slice(5).matchAll(/"((?:[^"]|"")*)"/gu)].map((match) =>
    match[1]!.replaceAll('""', '"'),
  );
  return {
    command: win32.basename(tokens[0]!).replace(/\.(?:cmd|bat)$/iu, ""),
    args: tokens.slice(1),
  };
}

function mockSpawnerLayer(
  handler: (
    args: ReadonlyArray<string>,
    command: string,
    env: NodeJS.ProcessEnv | undefined,
    options:
      | {
          readonly env?: NodeJS.ProcessEnv;
          readonly cwd?: string;
          readonly windowsVerbatimArguments?: boolean;
          readonly stdin?: "pipe" | "ignore" | "inherit";
        }
      | undefined,
  ) => {
    stdout: string;
    stderr: string;
    code: number;
  },
  { rawCommand = false }: { readonly rawCommand?: boolean } = {},
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options?: {
          env?: NodeJS.ProcessEnv;
          cwd?: string;
          windowsVerbatimArguments?: boolean;
          stdin?: "pipe" | "ignore" | "inherit";
        };
      };
      const invocation = rawCommand ? cmd : providerInvocationForTest(cmd);
      return Effect.succeed(
        mockHandle(handler(invocation.args, invocation.command, cmd.options?.env, cmd.options)),
      );
    }),
  );
}

function failingSpawnerLayer(description: string) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description,
        }),
      ),
    ),
  );
}

function hangingSpawnerLayer(input: {
  readonly onKill: () => void;
  readonly onHang?: () => void;
  readonly shouldHang: (args: ReadonlyArray<string>, command: string) => boolean;
  /** What a non-hanging `--version` probe prints; the update path needs a verified floor. */
  readonly versionOutput?: string;
}) {
  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(0x7fff_fffe),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.sync(input.onKill),
    stdin: Sink.drain,
    stdout: Stream.never,
    stderr: Stream.never,
    all: Stream.never,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.never,
  });
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const cmd = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options?: { readonly windowsVerbatimArguments?: boolean };
      };
      const invocation = providerInvocationForTest(cmd);
      if (!input.shouldHang(invocation.args, invocation.command)) {
        const stdout =
          input.versionOutput && invocation.args.includes("--version") ? input.versionOutput : "";
        return Effect.succeed(mockHandle({ stdout, stderr: "", code: 0 }));
      }
      input.onHang?.();
      return Effect.succeed(handle);
    }),
  );
}

/**
 * One-click npm updates now need the official registry's latest version (#449). Answer it
 * offline so update tests never reach the network or depend on a real release number.
 */
const stubNpmLatestVersion = (versions: Readonly<Record<string, string>>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        for (const [packageName, version] of Object.entries(versions)) {
          if (url.endsWith(`/${encodeURIComponent(packageName)}/latest`)) {
            return Response.json({ version });
          }
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      return realFetch;
    }),
    (realFetch) => Effect.sync(() => (globalThis.fetch = realFetch)),
  );

const CODEX_UPDATE_INSTALLED_VERSION = "7.3.46";
const CODEX_UPDATE_LATEST_VERSION = "7.3.47";
const CODEX_UPDATE_PINNED_INSTALL = `install -g --prefix /Users/test/.nvm/versions/node/v24.13.0 @openai/codex@${CODEX_UPDATE_LATEST_VERSION}`;

function withProcessPlatform<T, E, R>(
  platform: NodeJS.Platform,
  effect: Effect.Effect<T, E, R>,
): Effect.Effect<T, E, R> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: platform });
      return descriptor;
    }),
    () => effect,
    (descriptor) =>
      Effect.sync(() => {
        if (descriptor) {
          Object.defineProperty(process, "platform", descriptor);
        }
      }),
  );
}

const allProvidersDisabledSettings = {
  providers: {
    codex: { enabled: false },
    claudeAgent: { enabled: false },
    cursor: { enabled: false },
    gemini: { enabled: false },
    hermes: { enabled: false },
    devin: { enabled: false },
    antigravity: { enabled: false },
    grok: { enabled: false },
    droid: { enabled: false },
    opencode: { enabled: false },
    pi: { enabled: false },
    omp: { enabled: false },
    kimi: { enabled: false },
    minimax: { enabled: false },
    zcode: { enabled: false },
  },
} as const;

const allProvidersDisabledServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providers: {
    codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
    claudeAgent: { ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent, enabled: false },
    cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, enabled: false },
    gemini: { ...DEFAULT_SERVER_SETTINGS.providers.gemini, enabled: false },
    hermes: { ...DEFAULT_SERVER_SETTINGS.providers.hermes, enabled: false },
    devin: { ...DEFAULT_SERVER_SETTINGS.providers.devin, enabled: false },
    antigravity: { ...DEFAULT_SERVER_SETTINGS.providers.antigravity, enabled: false },
    grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, enabled: false },
    droid: { ...DEFAULT_SERVER_SETTINGS.providers.droid, enabled: false },
    opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: false },
    pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, enabled: false },
    omp: { ...DEFAULT_SERVER_SETTINGS.providers.omp, enabled: false },
    kimi: { ...DEFAULT_SERVER_SETTINGS.providers.kimi, enabled: false },
    minimax: { ...DEFAULT_SERVER_SETTINGS.providers.minimax, enabled: false },
    zcode: { ...DEFAULT_SERVER_SETTINGS.providers.zcode, enabled: false },
  },
} satisfies typeof DEFAULT_SERVER_SETTINGS;

function removalTestDirectory(fs: FileSystem.FileSystem, prefix: string) {
  return Effect.acquireRelease(fs.makeTempDirectory({ prefix }), (directory) =>
    Effect.promise(async () => {
      if (!directory.startsWith(join(OS.tmpdir(), "agent-removal-")))
        throw new Error("Unexpected removal-test cleanup target.");
      await removeDirectory(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 10,
      });
    }),
  );
}

describe("provider health probe concurrency", () => {
  it.effect("bounds concurrent probes while preserving every result", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const atLimit = yield* Deferred.make<void>();
      const active = yield* Ref.make(0);
      const peak = yield* Ref.make(0);
      const count = PROVIDER_HEALTH_PROBE_CONCURRENCY + 3;
      const probes = Array.from({ length: count }, (_, index) =>
        Effect.gen(function* () {
          const current = yield* Ref.updateAndGet(active, (value) => value + 1);
          yield* Ref.update(peak, (value) => Math.max(value, current));
          if (current === PROVIDER_HEALTH_PROBE_CONCURRENCY) {
            yield* Deferred.succeed(atLimit, undefined);
          }
          yield* Deferred.await(release);
          yield* Ref.update(active, (value) => value - 1);
          return index;
        }),
      );

      const fiber = yield* runProviderHealthProbes(probes).pipe(Effect.forkChild);
      yield* Deferred.await(atLimit);
      assert.strictEqual(yield* Ref.get(peak), PROVIDER_HEALTH_PROBE_CONCURRENCY);
      yield* Deferred.succeed(release, undefined);

      const results = yield* Fiber.join(fiber);
      assert.deepStrictEqual(
        results,
        Array.from({ length: count }, (_, index) => index),
      );
      assert.ok((yield* Ref.get(peak)) <= PROVIDER_HEALTH_PROBE_CONCURRENCY);
    }),
  );
});

describe("provider update environment isolation", () => {
  it("scrubs ambient aliases before applying a selected provider update environment", () => {
    const previousXaiApiKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "ambient-account-a";
    try {
      const env = makeProviderUpdateEnv({
        instanceId: "grok_work" as ProviderInstanceId,
        driver: "grok",
        displayName: "Grok Work",
        enabled: true,
        isDefault: false,
        config: {},
        environment: { GROK_CODE_XAI_API_KEY: "selected-account-b" },
        raw: { driver: "grok" },
      });

      assert.strictEqual(env.XAI_API_KEY, undefined);
      assert.strictEqual(env.GROK_CODE_XAI_API_KEY, "selected-account-b");
      assert.strictEqual(env.PATH, process.env.PATH);
    } finally {
      if (previousXaiApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousXaiApiKey;
    }
  });

  it("honors an explicitly empty environment for a default-instance update", () => {
    const previousXaiApiKey = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "ambient-account-a";
    try {
      const env = makeProviderUpdateEnv({
        instanceId: "grok" as ProviderInstanceId,
        driver: "grok",
        displayName: "Grok",
        enabled: true,
        isDefault: true,
        config: {},
        environment: {},
        raw: { driver: "grok", environment: [] },
      });

      assert.strictEqual(env.XAI_API_KEY, undefined);
      assert.strictEqual(env.PATH, process.env.PATH);
    } finally {
      if (previousXaiApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousXaiApiKey;
    }
  });
});

const disabledProviderHealthLayer = ProviderHealthLive.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest(allProvidersDisabledSettings)),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "provider-health-disabled-" }),
  ),
);

const cachedReadyCodexStatus = {
  provider: "codex" as const,
  instanceId: "codex" as const,
  driver: "codex" as const,
  status: "ready" as const,
  available: true,
  authStatus: "authenticated" as const,
  checkedAt: "2026-06-16T12:00:00.000Z",
  message: "Codex CLI is installed and authenticated.",
} satisfies ServerProviderStatus;

/**
 * Create a temporary CODEX_HOME scoped to the current Effect test.
 * Cleanup is registered in the test scope rather than via Vitest hooks.
 */
function withTempCodexHome(configContent?: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tmpDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "moss-test-codex-" });
    const runtimeDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "moss-test-runtime-",
    });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        // Override the runtime and source homes so ambient state cannot skew
        // the resolved CODEX_HOME during this test.
        const overrides: Record<string, string> = {
          CODEX_HOME: tmpDir,
          MOSS_HOME: runtimeDir,
        };
        const restore: Record<string, string | undefined> = {};
        for (const [key, value] of Object.entries(overrides)) {
          restore[key] = process.env[key];
          process.env[key] = value;
        }
        const originalPortkeyApiKey = process.env.PORTKEY_API_KEY;
        process.env.PORTKEY_API_KEY ??= "test-portkey-key";
        return { restore, originalPortkeyApiKey };
      }),
      ({ restore, originalPortkeyApiKey }) =>
        Effect.sync(() => {
          for (const [key, value] of Object.entries(restore)) {
            if (value !== undefined) {
              process.env[key] = value;
            } else {
              delete process.env[key];
            }
          }
          if (originalPortkeyApiKey !== undefined) {
            process.env.PORTKEY_API_KEY = originalPortkeyApiKey;
          } else {
            delete process.env.PORTKEY_API_KEY;
          }
        }),
    );

    if (configContent !== undefined) {
      yield* fileSystem.writeFileString(path.join(tmpDir, "config.toml"), configContent);
    }

    return { tmpDir, runtimeDir } as const;
  });
}

function withPackagedRuntimeEnv(overrides: Readonly<Record<string, string>>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const previous: NodeJS.ProcessEnv = {};
      for (const key of [
        "MOSS_BUNDLED_CODEX_PATH",
        "MOSS_BUNDLED_CODEX_ERROR",
        "MOSS_BUNDLED_CLAUDE_PATH",
      ]) {
        previous[key] = process.env[key];
        if (overrides[key] === undefined) delete process.env[key];
        else process.env[key] = overrides[key];
      }
      return previous;
    }),
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );
}

/** PATH holding only fake shims for `commands`, so "own install on PATH" is deterministic. */
function withFakePath(commands: ReadonlyArray<string>) {
  return Effect.acquireRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(join(OS.tmpdir(), "moss-fake-path-"));
      for (const command of commands) {
        const name = process.platform === "win32" ? `${command}.cmd` : command;
        writeFileSync(join(directory, name), "", { mode: 0o755 });
      }
      const previous = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT };
      process.env.PATH = directory;
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";
      resetLocalAgentPathLookupCache();
      return { directory, previous };
    }),
    ({ directory, previous }) =>
      Effect.sync(() => {
        process.env.PATH = previous.PATH;
        if (previous.PATHEXT === undefined) delete process.env.PATHEXT;
        else process.env.PATHEXT = previous.PATHEXT;
        resetLocalAgentPathLookupCache();
        rmSync(directory, { recursive: true, force: true });
      }),
  );
}

function withManagedProbeHome() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { tmpDir } = yield* withTempCodexHome();
    const stateDir = join(tmpDir, "state");
    const homePath = join(stateDir, "moss-codex-home");
    const nonce = "4495cd76-4720-4f61-8e2a-f0acbd59aee2";
    yield* fs.makeDirectory(homePath, { recursive: true });
    yield* fs.writeFileString(
      join(homePath, ".moss-managed-home"),
      buildMossManagedHomeOwnershipMarker(nonce),
    );
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          accounts: [{ id: "moss", label: "Moss", homePath, shadowHomePath: "" }],
        },
      },
      providerInstances: {
        codex_moss: {
          driver: "codex" as const,
          enabled: true,
          config: { managed: true, accountId: "moss", homePath, homeOwnershipNonce: nonce },
        },
      },
    };
    return {
      homePath,
      stateDir,
      settings,
      issue: () =>
        readManagedCodexHomeAuthority({
          stateDir,
          readSettings: async () => settings,
          readSettingsSync: () => settings,
          input: { homePath, accountId: "moss", env: process.env },
        }),
    };
  });
}

it.layer(NodeServices.layer)("ProviderHealth", (it) => {
  it.effect(
    "keeps disabled Pi installation evidence across independent health restarts without running the CLI",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* removalTestDirectory(fs, "agent-removal-disabled-pi-");
        const binary = join(baseDir, process.platform === "win32" ? "pi.cmd" : "pi");
        yield* fs.writeFileString(binary, "owned-fixture-pi");
        yield* Effect.promise(() => changeMode(binary, 0o755));
        const cachePath = resolveProviderStatusCachePath({ stateDir: baseDir, provider: "pi" });
        yield* writeProviderStatusCache({
          filePath: cachePath,
          provider: {
            provider: "pi",
            driver: "pi",
            instanceId: "pi",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            version: "1.5.0",
            checkedAt: "2026-11-06T12:00:00Z",
          },
        });
        const commands: string[] = [];
        for (let restart = 0; restart < 2; restart++) {
          const layer = makeProviderHealthLive().pipe(
            Layer.provideMerge(
              ServerSettingsService.layerTest({
                ...allProvidersDisabledServerSettings,
                enableProviderUpdateChecks: false,
                providers: {
                  ...allProvidersDisabledServerSettings.providers,
                  pi: {
                    ...allProvidersDisabledServerSettings.providers.pi,
                    binaryPath: binary,
                  },
                },
              }),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), baseDir, {
                homeDir: baseDir,
                stateDir: baseDir,
              }),
            ),
            Layer.provideMerge(
              mockSpawnerLayer((_args, command) => {
                commands.push(command);
                return { stdout: "", stderr: "", code: 0 };
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const health = yield* ProviderHealth;
            yield* health.refresh;
            const status = (yield* health.getStatuses).find((entry) => entry.instanceId === "pi");
            assert.strictEqual(status?.version, "1.5.0");
            assert.strictEqual(status?.enabled, false);
            assert.strictEqual(status?.available, false);
          }).pipe(Effect.provide(layer));
        }
        assert.strictEqual((yield* readProviderStatusCache(cachePath))?.version, "1.5.0");
        assert.strictEqual(commands.length, 0);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "keeps the selected external Codex version and program epoch when removing an idle Moss copy",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* removalTestDirectory(fs, "agent-removal-external-");
        const previous = process.env[PROVIDER_UPDATES_DISABLED_ENV];
        delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
            else process.env[PROVIDER_UPDATES_DISABLED_ENV] = previous;
          }),
        );
        const external = join(
          baseDir,
          process.platform === "win32" ? "external-codex.cmd" : "external-codex",
        );
        yield* fs.writeFileString(external, "external-user-owned-fixture");
        yield* Effect.promise(() => changeMode(external, 0o755));
        const prefix = join(baseDir, "agents");
        const packageRoot = join(prefix, "node_modules", "@openai", "codex");
        const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
        yield* fs.makeDirectory(packageRoot, { recursive: true });
        yield* fs.makeDirectory(bin, { recursive: true });
        yield* fs.writeFileString(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
        );
        const shim = join(bin, process.platform === "win32" ? "codex.cmd" : "codex");
        yield* fs.writeFileString(shim, "node_modules/@openai/codex/bin/codex.js");
        const cachePath = resolveProviderStatusCachePath({ stateDir: baseDir, provider: "codex" });
        yield* writeProviderStatusCache({
          filePath: cachePath,
          provider: {
            provider: "codex",
            driver: "codex",
            instanceId: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            version: "0.166.0",
            checkedAt: "2026-11-06T12:00:00Z",
          },
        });
        const commands: string[] = [];
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              ...allProvidersDisabledServerSettings,
              enableProviderUpdateChecks: false,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                codex: {
                  ...allProvidersDisabledServerSettings.providers.codex,
                  binaryPath: external,
                },
              },
            }),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), baseDir, { homeDir: baseDir, stateDir: baseDir }),
          ),
          Layer.provideMerge(
            mockSpawnerLayer((_args, command) => {
              commands.push(command);
              return { stdout: "", stderr: "", code: 0 };
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const health = yield* ProviderHealth;
          const result = yield* health.manageProviderInstallation!({
            provider: "codex",
            action: "uninstall",
          });
          assert.strictEqual(result.source, "external");
          assert.strictEqual(result.path, external);
          assert.strictEqual(result.removed, true);
          assert.strictEqual(result.canUninstall, false);
          const status = (yield* health.getStatuses).find((entry) => entry.instanceId === "codex");
          assert.strictEqual(status?.version, "0.166.0");
          const config = yield* ServerConfig;
          agentProgramsForServer(config, "codex").assertCompatible({
            binaryPath: external,
            sourceHomePath: baseDir,
          });
        }).pipe(Effect.provide(layer));
        assert.strictEqual((yield* readProviderStatusCache(cachePath))?.version, "0.166.0");
        assert.strictEqual(yield* fs.readFileString(external), "external-user-owned-fixture");
        assert.strictEqual(yield* fs.exists(packageRoot), false);
        assert.strictEqual(yield* fs.exists(shim), false);
        assert.strictEqual(commands.length, 0);
      }).pipe(Effect.scoped),
  );
  it.effect("refuses removal while any additional account remains enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* removalTestDirectory(fs, "agent-removal-enabled-");
      const previous = process.env[PROVIDER_UPDATES_DISABLED_ENV];
      delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
      const remove = vi
        .spyOn(ManagedProviderInstallationModule, "removeManagedProviderInstallation")
        .mockResolvedValue(false);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          remove.mockRestore();
          if (previous === undefined) delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
          else process.env[PROVIDER_UPDATES_DISABLED_ENV] = previous;
        }),
      );
      const layer = makeProviderHealthLive().pipe(
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            ...allProvidersDisabledServerSettings,
            providerInstances: { opencode_work: { driver: "opencode", enabled: true, config: {} } },
          }),
        ),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), baseDir, { homeDir: baseDir, stateDir: baseDir }),
        ),
        Layer.provideMerge(mockSpawnerLayer(() => ({ stdout: "", stderr: "", code: 0 }))),
      );
      const error = yield* Effect.gen(function* () {
        const health = yield* ProviderHealth;
        return yield* Effect.flip(
          health.manageProviderInstallation!({ provider: "opencode", action: "uninstall" }),
        );
      }).pipe(Effect.provide(layer));
      assert.match(error.reason, /Turn this agent off/u);
      assert.strictEqual(remove.mock.calls.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "serializes removal and another agent installation through the shared install lock",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* removalTestDirectory(fs, "agent-removal-lock-");
        const previous = process.env[PROVIDER_UPDATES_DISABLED_ENV];
        const previousPath = process.env.PATH;
        delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
        let release!: () => void;
        let started!: () => void;
        const began = new Promise<void>((resolve) => {
          started = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          release = resolve;
        });
        const remove = vi
          .spyOn(ManagedProviderInstallationModule, "removeManagedProviderInstallation")
          .mockImplementation(async () => {
            started();
            await blocked;
            return true;
          });
        const inspect = vi
          .spyOn(ManagedProviderInstallationModule, "inspectProviderInstallation")
          .mockResolvedValue({
            provider: "opencode",
            source: "missing",
            path: null,
            managedPath: null,
            canUninstall: false,
            removed: false,
          });
        const install = vi
          .spyOn(ProviderInstallModule, "runOneClickAgentInstall")
          .mockImplementation(() =>
            Effect.succeed({
              ok: true as const,
              version: "1.5.0",
              source: "official" as const,
              binDirectory: join(baseDir, "agents"),
            }),
          );
        const runtime = vi
          .spyOn(AgentInstallRuntimeModule, "resolveMossNodeRuntime")
          .mockReturnValue(null);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            release();
            remove.mockRestore();
            inspect.mockRestore();
            install.mockRestore();
            runtime.mockRestore();
            if (previous === undefined) delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
            else process.env[PROVIDER_UPDATES_DISABLED_ENV] = previous;
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            resetLocalAgentPathLookupCache();
          }),
        );
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              ...allProvidersDisabledServerSettings,
              enableProviderUpdateChecks: false,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, enabled: true },
              },
            }),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), baseDir, { homeDir: baseDir, stateDir: baseDir }),
          ),
          Layer.provideMerge(mockSpawnerLayer(() => ({ stdout: "", stderr: "", code: 0 }))),
        );
        yield* Effect.gen(function* () {
          const health = yield* ProviderHealth;
          yield* health.refresh;
          const removing = yield* health.manageProviderInstallation!({
            provider: "opencode",
            action: "uninstall",
          }).pipe(Effect.forkChild);
          yield* Effect.promise(() => began);
          const installing = yield* health
            .installProvider({ provider: "pi" })
            .pipe(Effect.forkChild);
          let queued = false;
          for (let attempt = 0; attempt < 30; attempt++) {
            yield* Effect.yieldNow;
            queued = (yield* health.getStatuses).some(
              (status) => status.provider === "pi" && status.installState?.status === "queued",
            );
            if (queued) break;
          }
          assert.strictEqual(queued, true);
          assert.strictEqual(install.mock.calls.length, 0);
          release();
          assert.strictEqual((yield* Fiber.join(removing)).removed, true);
          yield* Fiber.join(installing);
          assert.strictEqual(install.mock.calls.length, 1);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );
  it.effect("uses bound private Claude state for health and login and rechecks each probe", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "health-claude-bound-" });
      const source = join(baseDir, "projects");
      const privateHome = join(baseDir, "private");
      const configDir = join(privateHome, ".claude");
      const binary = join(baseDir, "claude.exe");
      for (const directory of [source, configDir])
        yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(binary, "fixture-program");
      const authFile = join(configDir, ".credentials.json");
      yield* fs.writeFileString(authFile, '{"fixture":"private"}');
      yield* fs.writeFileString(join(source, "history-marker"), "preserved");
      const probeEnvs: NodeJS.ProcessEnv[] = [];
      let invalidate = false;
      let invalidated = false;
      let loginTarget: ProviderLoginManagerModule.ProviderLoginProcessRunnerInput | undefined;
      let finishLogin:
        | ((result: ProviderLoginManagerModule.ProviderLoginCompletion) => void)
        | undefined;
      const originalManager = ProviderLoginManagerModule.makeProviderLoginManager;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi
            .spyOn(ProviderLoginManagerModule, "makeProviderLoginManager")
            .mockImplementation((dependencies) =>
              originalManager({
                ...dependencies,
                runClaude: (input) => {
                  loginTarget = input;
                  return {
                    completion: new Promise((resolve) => {
                      finishLogin = resolve;
                    }),
                    cancel: () => finishLogin?.({ status: "cancelled" }),
                  };
                },
              }),
            ),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      );
      const layer = ProviderHealthLive.pipe(
        Layer.provideMerge(ServerSecretStoreLive),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: false,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              claudeAgent: {
                ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
                enabled: true,
                shareStateAcrossAccounts: true,
                sharedProjectsPath: source,
              },
            },
            providerInstances: {
              claudeAgent: { driver: "claudeAgent", enabled: false },
              claude_work: {
                driver: "claudeAgent",
                config: { binaryPath: binary, homePath: privateHome },
                environment: [{ name: "ANTHROPIC_API_KEY", value: "fixture-key", sensitive: true }],
              },
            },
          }),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provideMerge(
          mockSpawnerLayer((args, _command, env) => {
            probeEnvs.push(env!);
            if (invalidate && !invalidated && args.includes("--version")) {
              invalidated = true;
              writeFileSync(authFile, '{"fixture":"rotated"}');
            }
            return {
              stdout: args.includes("--version")
                ? "2.1.318"
                : JSON.stringify({
                    loggedIn: true,
                    authMethod: "claude.ai",
                    subscriptionType: "max",
                  }),
              stderr: "",
              code: 0,
            };
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const health = yield* ProviderHealth;
        assert.strictEqual(
          (yield* health.refresh).find((status) => status.instanceId === "claude_work")?.status,
          "ready",
        );
        for (const env of probeEnvs) {
          assert.strictEqual(env.HOME, canonicalizeCodexHomeIdentityPath(privateHome));
          assert.strictEqual(env.CLAUDE_CONFIG_DIR, canonicalizeCodexHomeIdentityPath(configDir));
          assert.strictEqual(env.ANTHROPIC_API_KEY, "fixture-key");
        }
        yield* health.startLogin({ provider: "claudeAgent", instanceId: "claude_work" });
        assert.isDefined(loginTarget);
        assert.strictEqual(loginTarget!.env.HOME, canonicalizeCodexHomeIdentityPath(privateHome));
        assert.strictEqual(
          loginTarget!.env.CLAUDE_CONFIG_DIR,
          canonicalizeCodexHomeIdentityPath(configDir),
        );
        assert.isUndefined(loginTarget!.env.ANTHROPIC_API_KEY);
        assert.isUndefined(loginTarget!.env.ANTHROPIC_AUTH_TOKEN);
        assert.doesNotThrow(() => loginTarget!.assertStateBindingCurrent!());
        finishLogin?.({ status: "cancelled" });
        yield* Effect.promise(() => Promise.resolve());
        const before = probeEnvs.length;
        invalidate = true;
        const revoked = (yield* health.refresh).find(
          (status) => status.instanceId === "claude_work",
        );
        assert.strictEqual(probeEnvs.length, before + 1);
        assert.notEqual(revoked?.status, "ready");
        assert.throws(() => loginTarget!.assertStateBindingCurrent!(), /绑定已更换/);
        assert.strictEqual(readFileSync(join(source, "history-marker"), "utf8"), "preserved");
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.effect("shares the bound program epoch across health and private-only Codex sign-in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "health-shared-state-" });
      const source = join(baseDir, "history");
      const privateHome = join(baseDir, "private");
      const first = join(baseDir, "first.exe");
      const second = join(baseDir, "second.exe");
      for (const directory of [source, privateHome]) yield* fs.makeDirectory(directory);
      yield* fs.writeFileString(first, "synthetic-program-one");
      yield* fs.writeFileString(second, "synthetic-program-two");
      yield* fs.writeFileString(join(source, "config.toml"), 'model_provider = "wrong-source"\n');
      yield* fs.writeFileString(join(source, "auth.json"), '{"account":"untouched-source"}');
      yield* fs.writeFileString(
        join(privateHome, "config.toml"),
        'model_provider = "openai"\n# private-config\n',
      );
      yield* fs.writeFileString(join(privateHome, "auth.json"), '{"account":"synthetic-private"}');
      const probeEnvs: NodeJS.ProcessEnv[] = [];
      const loginChild = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
      let loginEnv: NodeJS.ProcessEnv | undefined;
      const loginSpawn = yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi
            .spyOn(ProcessRuntime, "spawnProcess")
            .mockImplementation((_command, _args, options) => {
              loginEnv = options?.env;
              return loginChild as unknown as ChildProcess;
            }),
        ),
        (mock) => Effect.sync(() => mock.mockRestore()),
      );
      const layer = ProviderHealthLive.pipe(
        Layer.provideMerge(ServerSecretStoreLive),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: false,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              codex: {
                ...DEFAULT_SERVER_SETTINGS.providers.codex,
                enabled: true,
                homePath: source,
                shareStateAcrossAccounts: true,
              },
            },
            providerInstances: {
              codex: { driver: "codex", enabled: false },
              codex_work: {
                driver: "codex",
                config: { binaryPath: first, homePath: privateHome, accountId: "work" },
              },
            },
          }),
        ),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        Layer.provideMerge(
          mockSpawnerLayer((args, _command, env) => {
            probeEnvs.push(env!);
            return {
              stdout: args.includes("--version") ? "codex-cli 0.166.0" : "Logged in using ChatGPT",
              stderr: "",
              code: 0,
            };
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const health = yield* ProviderHealth;
        const config = yield* ServerConfig;
        const statuses = yield* health.refresh;
        assert.strictEqual(
          statuses.find((row) => row.instanceId === "codex_work")?.status,
          "ready",
        );
        assert.isAbove(probeEnvs.length, 0);
        for (const env of probeEnvs) {
          assert.strictEqual(env.CODEX_SQLITE_HOME, canonicalizeCodexHomeIdentityPath(source));
          assert.include(
            readFileSync(join(env.CODEX_HOME!, "config.toml"), "utf8"),
            "private-config",
          );
          assert.include(
            readFileSync(join(env.CODEX_HOME!, "auth.json"), "utf8"),
            "synthetic-private",
          );
        }
        yield* health.startLogin({ provider: "codex", instanceId: "codex_work" });
        assert.strictEqual(loginSpawn.mock.calls.length, 1);
        assert.strictEqual(loginEnv?.CODEX_HOME, canonicalizeCodexHomeIdentityPath(privateHome));
        assert.strictEqual(
          loginEnv?.CODEX_SQLITE_HOME,
          canonicalizeCodexHomeIdentityPath(privateHome),
        );
        assert.strictEqual(loginEnv?.OPENAI_API_KEY, undefined);
        const programs = agentProgramsForServer(config, "codex");
        assert.throws(
          () => programs.assertCompatible({ binaryPath: second, sourceHomePath: source }),
          /Restart Moss/,
        );
        assert.doesNotThrow(() =>
          programs.assertCompatible({ binaryPath: second, sourceHomePath: privateHome }),
        );
        assert.include(readFileSync(join(source, "auth.json"), "utf8"), "untouched-source");
        loginChild.emit("exit", 0);
        loginChild.emit("close", 0);
        yield* Effect.promise(() => Promise.resolve());
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "refreshes the own Codex release advisory for local and managed accounts without updating",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const fixture = yield* withManagedProbeHome();
        const { runtimeDir } = yield* withTempCodexHome();
        yield* withFakePath(["codex"]);
        yield* withPackagedRuntimeEnv({
          MOSS_BUNDLED_CODEX_PATH: join(runtimeDir, "bundled", "codex.exe"),
        });
        yield* fs.writeFileString(
          join(fixture.homePath, "config.toml"),
          'model_provider = "moss"\n',
        );
        const requestedUrls: string[] = [];
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
              const url = String(input);
              requestedUrls.push(url);
              assert.match(url, /\/%40openai%2Fcodex\/latest$/iu);
              return Response.json({ version: "0.999.0" });
            }),
          ),
          (mock) => Effect.sync(() => mock.mockRestore()),
        );
        const invocations: string[][] = [];
        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              ...fixture.settings,
              enableProviderUpdateChecks: true,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                codex: { ...fixture.settings.providers.codex, enabled: true },
              },
            }),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), runtimeDir, {
              stateDir: fixture.stateDir,
              homeDir: runtimeDir,
            }),
          ),
          Layer.provideMerge(
            mockSpawnerLayer((args) => {
              invocations.push([...args]);
              return {
                stdout: args.includes("--version")
                  ? "codex 0.160.0\n"
                  : "Logged in using ChatGPT\n",
                stderr: "",
                code: 0,
              };
            }),
          ),
        );
        yield* Effect.gen(function* () {
          const health = yield* ProviderHealth;
          const settings = yield* ServerSettingsService;
          const statuses = yield* health.refresh;
          for (const instanceId of ["codex", "codex_moss"]) {
            const status = statuses.find((row) => row.instanceId === instanceId);
            assert.strictEqual(status?.version, "0.160.0");
            assert.strictEqual(status?.versionAdvisory?.latestVersion, "0.999.0");
            assert.strictEqual(status?.versionAdvisory?.status, "behind_latest");
          }
          assert.ok(requestedUrls.length > 0);
          assert.ok(
            invocations.every((args) => args.includes("--version") || args.includes("login")),
          );
          const requestsBeforeDisabled = requestedUrls.length;
          yield* settings.updateSettings({ enableProviderUpdateChecks: false });
          const disabled = yield* health.refresh;
          assert.strictEqual(
            disabled.find((row) => row.instanceId === "codex")?.versionAdvisory?.latestVersion,
            null,
          );
          assert.strictEqual(requestedUrls.length, requestsBeforeDisabled);
        }).pipe(Effect.provide(layer));
      }),
  );

  describe("packaged runtime health", () => {
    const codexBinary = join(OS.tmpdir(), "Moss packaged runtime", "codex.exe");
    const claudeBinary = join(OS.tmpdir(), "Moss packaged runtime", "claude.exe");

    it.effect(
      "refreshes managed instances using trusted runtime paths and real home authority",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const fixture = yield* withManagedProbeHome();
          yield* withFakePath([]);
          yield* fs.writeFileString(
            join(fixture.homePath, "config.toml"),
            'model_provider = "moss"\n',
          );
          yield* withPackagedRuntimeEnv({
            MOSS_BUNDLED_CODEX_PATH: codexBinary,
            MOSS_BUNDLED_CLAUDE_PATH: claudeBinary,
          });
          const commands: string[] = [];
          const layer = ProviderHealthLive.pipe(
            Layer.provideMerge(
              ServerSettingsService.layerTest({
                ...fixture.settings,
                enableProviderUpdateChecks: false,
                providers: {
                  ...allProvidersDisabledServerSettings.providers,
                  codex: { ...fixture.settings.providers.codex, enabled: false },
                },
                providerInstances: {
                  codex_moss: {
                    ...fixture.settings.providerInstances.codex_moss,
                    config: {
                      ...fixture.settings.providerInstances.codex_moss.config,
                      binaryPath: "/untrusted/persisted/codex",
                    },
                  },
                  claude_moss: {
                    driver: "claudeAgent",
                    enabled: true,
                    config: { managed: true, binaryPath: "/untrusted/persisted/claude" },
                  },
                },
              }),
            ),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), fixture.stateDir, {
                stateDir: fixture.stateDir,
                homeDir: fixture.stateDir,
              }),
            ),
            Layer.provideMerge(
              mockSpawnerLayer((args, command) => {
                assert.ok(command === codexBinary || command === claudeBinary);
                commands.push(command);
                if (args.includes("--version"))
                  return {
                    stdout:
                      command === codexBinary
                        ? `codex ${MOSS_BUNDLED_CODEX_VERSION}\n`
                        : "2.1.263\n",
                    stderr: "",
                    code: 0,
                  };
                assert.strictEqual(command, claudeBinary);
                assert.deepStrictEqual(args, ["auth", "status"]);
                return {
                  stdout: '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\n',
                  stderr: "",
                  code: 0,
                };
              }),
            ),
          );
          const statuses = yield* Effect.gen(function* () {
            return yield* (yield* ProviderHealth).refresh;
          }).pipe(Effect.provide(layer));
          for (const id of ["codex_moss", "claude_moss"]) {
            const status = statuses.find((row) => row.instanceId === id);
            assert.strictEqual(status?.status, "ready");
            assert.strictEqual(status?.available, true);
            assert.strictEqual(
              status?.autoRuntimeModeBinaryPath,
              id === "codex_moss" ? codexBinary : claudeBinary,
            );
          }
          const managedCodex = statuses.find((row) => row.instanceId === "codex_moss");
          assert.strictEqual(managedCodex?.message, "Using the Moss managed gateway.");
          assert.strictEqual(managedCodex?.authStatus, "authenticated");
          assert.ok(commands.includes(codexBinary));
          assert.ok(commands.includes(claudeBinary));
        }),
    );

    for (const configuredBinary of [undefined, "codex", "/custom/bin/codex"]) {
      it.effect(`resolves packaged Codex with configured ${String(configuredBinary)}`, () => {
        const expectedBinary = configuredBinary?.startsWith("/custom/")
          ? configuredBinary
          : codexBinary;
        const commands: string[] = [];
        return Effect.gen(function* () {
          const { homePath, issue } = yield* withManagedProbeHome();
          yield* withFakePath([]);
          yield* withPackagedRuntimeEnv({ MOSS_BUNDLED_CODEX_PATH: codexBinary });
          const status = yield* makeCheckCodexProviderStatus(
            configuredBinary,
            homePath,
            undefined,
            "moss",
            {
              MOSS_BUNDLED_CODEX_PATH: "/untrusted/instance/codex",
            },
            issue,
          );
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.autoRuntimeModeBinaryPath, expectedBinary);
          assert.deepStrictEqual(commands, [expectedBinary, expectedBinary]);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, command) => {
              commands.push(command);
              return {
                stdout: args.join(" ").includes("--version")
                  ? `codex ${MOSS_BUNDLED_CODEX_VERSION}\n`
                  : "Logged in\n",
                stderr: "",
                code: 0,
              };
            }),
          ),
        );
      });
    }

    it.effect("fails closed on a damaged bundle when no own Codex is installed", () => {
      let spawns = 0;
      return Effect.gen(function* () {
        const { homePath, issue } = yield* withManagedProbeHome();
        yield* withFakePath([]);
        yield* withPackagedRuntimeEnv({
          MOSS_BUNDLED_CODEX_ERROR: "Bundled Codex is damaged. Reinstall Moss.",
        });
        const status = yield* makeCheckCodexProviderStatus(
          undefined,
          homePath,
          undefined,
          "moss",
          undefined,
          issue,
        );
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.match(status.message ?? "", /damaged/);
        assert.strictEqual(spawns, 0);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer(() => {
            spawns += 1;
            return { stdout: "codex 0.153.4\n", stderr: "", code: 0 };
          }),
        ),
      );
    });

    it.effect("rejects a packaged Codex version mismatch before any auth probe", () => {
      const calls: string[] = [];
      return Effect.gen(function* () {
        const { homePath, issue } = yield* withManagedProbeHome();
        yield* withFakePath([]);
        yield* withPackagedRuntimeEnv({ MOSS_BUNDLED_CODEX_PATH: codexBinary });
        const status = yield* makeCheckCodexProviderStatus(
          undefined,
          homePath,
          undefined,
          "moss",
          undefined,
          issue,
        );
        assert.strictEqual(status.available, false);
        assert.match(status.message ?? "", /version mismatch/);
        assert.deepStrictEqual(calls, ["--version"]);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            calls.push(args.join(" "));
            return {
              stdout: args.join(" ").includes("--version") ? "codex 0.153.3\n" : "Logged in\n",
              stderr: "",
              code: 0,
            };
          }),
        ),
      );
    });

    for (const configuredBinary of [undefined, "/user/configured/claude"]) {
      it.effect(
        `resolves managed packaged Claude with configured ${String(configuredBinary)}`,
        () => {
          const commands: string[] = [];
          return Effect.gen(function* () {
            const { tmpDir } = yield* withTempCodexHome();
            yield* withFakePath([]);
            yield* withPackagedRuntimeEnv({ MOSS_BUNDLED_CLAUDE_PATH: claudeBinary });
            const status = yield* makeCheckClaudeProviderStatus(
              undefined,
              configuredBinary,
              tmpDir,
              {
                providerInstanceId: "claude_moss",
                isolationRootDir: tmpDir,
                fallbackHomeDir: tmpDir,
              },
              { MOSS_BUNDLED_CLAUDE_PATH: "/untrusted/instance/claude" },
            );
            assert.strictEqual(status.status, "ready");
            const expected = configuredBinary ?? claudeBinary;
            assert.strictEqual(status.autoRuntimeModeBinaryPath, expected);
            assert.deepStrictEqual(commands, [expected, expected]);
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args, command) => {
                commands.push(command);
                return {
                  stdout: args.join(" ").includes("--version")
                    ? "2.1.263\n"
                    : '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              }),
            ),
          );
        },
      );
    }

    for (const configuredBinary of [undefined, "/custom/bin/claude"]) {
      it.effect(
        `preserves ordinary Claude configured ${String(configuredBinary)} with a managed bundle present`,
        () =>
          Effect.gen(function* () {
            const { tmpDir } = yield* withTempCodexHome();
            yield* withPackagedRuntimeEnv({ MOSS_BUNDLED_CLAUDE_PATH: claudeBinary });
            // The person has their own Claude; it wins over the shipped one.
            const fakePath = yield* withFakePath(["claude"]);
            const status = yield* makeCheckClaudeProviderStatus(
              undefined,
              configuredBinary,
              tmpDir,
            );
            assert.strictEqual(status.status, "ready");
            assert.strictEqual(
              status.autoRuntimeModeBinaryPath,
              configuredBinary ??
                join(fakePath.directory, process.platform === "win32" ? "claude.CMD" : "claude"),
            );
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args, command) => {
                if (configuredBinary) assert.strictEqual(command, configuredBinary);
                else assert.notStrictEqual(command, claudeBinary);
                return {
                  stdout: args.join(" ").includes("--version")
                    ? "2.1.263\n"
                    : '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                  stderr: "",
                  code: 0,
                };
              }),
            ),
          ),
      );
    }
  });

  describe("shipped runtimes on a computer without agent CLIs", () => {
    const codexBinary = join(OS.tmpdir(), "Moss packaged runtime", "codex.exe");
    const claudeBinary = join(OS.tmpdir(), "Moss packaged runtime", "claude.exe");

    it.effect("runs the shipped Claude Code for a person's own Claude instance", () => {
      const commands: string[] = [];
      return Effect.gen(function* () {
        const { tmpDir } = yield* withTempCodexHome();
        yield* withPackagedRuntimeEnv({ MOSS_BUNDLED_CLAUDE_PATH: claudeBinary });
        yield* withFakePath([]);
        const status = yield* makeCheckClaudeProviderStatus(undefined, undefined, tmpDir, {
          falseNegativeRetryDelayMs: 0,
        });
        assert.strictEqual(status.autoRuntimeModeBinaryPath, claudeBinary);
        assert.ok(commands.length >= 2 && commands.every((command) => command === claudeBinary));
        // Not signed in yet: available, but asks for a sign-in instead of "not installed".
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(status.readiness, undefined);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            commands.push(command);
            return {
              stdout: args.join(" ").includes("--version") ? "2.1.285\n" : '{"loggedIn":false}\n',
              stderr: "",
              code: 0,
            };
          }),
        ),
      );
    });

    for (const ownCodex of [true, false]) {
      it.effect(
        `runs ${ownCodex ? "the person's own" : "the shipped"} Codex for a local instance`,
        () => {
          const commands: string[] = [];
          return Effect.gen(function* () {
            const { tmpDir } = yield* withTempCodexHome();
            yield* withPackagedRuntimeEnv({ MOSS_BUNDLED_CODEX_PATH: codexBinary });
            const fakePath = yield* withFakePath(ownCodex ? ["codex"] : []);
            const status = yield* makeCheckCodexProviderStatus(undefined, tmpDir);
            const expected = ownCodex
              ? join(fakePath.directory, process.platform === "win32" ? "codex.CMD" : "codex")
              : codexBinary;
            assert.strictEqual(status.autoRuntimeModeBinaryPath, expected);
            assert.strictEqual(status.status, "ready");
            assert.ok(
              commands.every(
                (command) =>
                  command === (ownCodex && process.platform === "win32" ? "codex" : expected),
              ),
            );
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args, command) => {
                commands.push(command);
                return {
                  stdout: args.join(" ").includes("--version")
                    ? `codex ${MOSS_BUNDLED_CODEX_VERSION}\n`
                    : "Logged in using ChatGPT\n",
                  stderr: "",
                  code: 0,
                };
              }),
            ),
          );
        },
      );
    }

    it("never offers an npm update for the shipped runtimes", () => {
      const previous = {
        codex: process.env.MOSS_BUNDLED_CODEX_PATH,
        claude: process.env.MOSS_BUNDLED_CLAUDE_PATH,
      };
      process.env.MOSS_BUNDLED_CODEX_PATH = codexBinary;
      process.env.MOSS_BUNDLED_CLAUDE_PATH = claudeBinary;
      try {
        assert.strictEqual(
          runsMossBundledAgentRuntime("codex", codexBinary, "codex_moss", "moss"),
          true,
        );
        assert.strictEqual(
          runsMossBundledAgentRuntime("claudeAgent", claudeBinary, "claude_moss"),
          true,
        );
        assert.strictEqual(
          runsMossBundledAgentRuntime("claudeAgent", "/custom/claude", "claudeAgent"),
          false,
        );
      } finally {
        for (const [key, value] of [
          ["MOSS_BUNDLED_CODEX_PATH", previous.codex],
          ["MOSS_BUNDLED_CLAUDE_PATH", previous.claude],
        ] as const) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  describe("provider update commands", () => {
    it("delegates native Claude release-channel truth to Claude", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.claudeAgent;
      assert.ok(definition);

      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: "claude",
        realCommandPath: "/Users/test/.local/share/claude/versions/2.1.100/claude",
      });

      assert.strictEqual(capabilities.latestVersionSource, null);
      assert.deepStrictEqual(capabilities.update, {
        command: "claude update",
        executable: "claude",
        args: ["update"],
        lockKey: "claude-native",
      });
    });

    it("keeps Claude's latest Homebrew cask source and command aligned", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.claudeAgent;
      assert.ok(definition);

      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: "/opt/homebrew/bin/claude",
        realCommandPath: "/opt/homebrew/Caskroom/claude-code@latest/2.1.100/claude",
      });

      assert.deepStrictEqual(capabilities.latestVersionSource, {
        kind: "homebrew",
        name: "claude-code@latest",
        homebrewKind: "cask",
      });
      assert.deepStrictEqual(capabilities.update, {
        command: "brew upgrade --cask claude-code@latest",
        executable: "brew",
        args: ["upgrade", "--cask", "claude-code@latest"],
        lockKey: "homebrew",
      });
    });

    it("registers Antigravity's native updater", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.antigravity;
      assert.ok(definition);

      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: "agy",
        realCommandPath: "/Users/test/.local/bin/agy",
        commandDirectory: "/Users/test/.local/bin",
      });

      assert.deepStrictEqual(capabilities.update, {
        command: "agy update",
        executable: "agy",
        args: ["update"],
        lockKey: "antigravity-native",
        pathPrepend: "/Users/test/.local/bin",
      });
    });

    it("updates npm-managed Codex through its matching package manager and PATH", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.codex;
      assert.ok(definition);

      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: "codex",
        realCommandPath:
          "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex",
        commandDirectory: "/Users/test/.nvm/versions/node/v24.13.0/bin",
      });

      assert.deepStrictEqual(capabilities.update, {
        command:
          "npm install -g --prefix /Users/test/.nvm/versions/node/v24.13.0 @openai/codex@latest",
        executable: "npm",
        args: [
          "install",
          "-g",
          "--prefix",
          "/Users/test/.nvm/versions/node/v24.13.0",
          "@openai/codex@latest",
        ],
        lockKey: "npm-global",
        pathPrepend: "/Users/test/.nvm/versions/node/v24.13.0/bin",
      });
    });

    it.effect(
      "blocks update while another account still owns the program, then requires restart after update",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* stubNpmLatestVersion({ "@openai/codex": "0.167.0" });
          const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "provider-update-owner-" });
          const configuredBinaryPath =
            "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex";
          const binaryPath = resolveCodexExecutable({
            configuredBinaryPath,
            env: process.env,
          }).binaryPath;
          let updates = 0;
          const settings = {
            ...allProvidersDisabledServerSettings,
            enableProviderUpdateChecks: false,
            providers: {
              ...allProvidersDisabledServerSettings.providers,
              codex: {
                ...DEFAULT_SERVER_SETTINGS.providers.codex,
                enabled: true,
                binaryPath: configuredBinaryPath,
              },
            },
          } satisfies typeof DEFAULT_SERVER_SETTINGS;
          const layer = makeProviderHealthLive().pipe(
            Layer.provideMerge(ServerSettingsService.layerTest(settings)),
            Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
            Layer.provideMerge(
              mockSpawnerLayer((args, command) => {
                if (command === "npm" && args[0] === "install") updates++;
                return {
                  stdout: args.includes("--version")
                    ? "codex-cli 0.166.0"
                    : "Logged in using ChatGPT",
                  stderr: "",
                  code: 0,
                };
              }),
            ),
          );
          yield* Effect.gen(function* () {
            const health = yield* ProviderHealth;
            const config = yield* ServerConfig;
            const programs = agentProgramsForServer(config, "codex");
            const child = programs.spawn({
              binaryPath,
              sourceHomePath: join(baseDir, "other-account"),
              spawn: () => new EventEmitter(),
            });
            const busy = yield* Effect.flip(health.updateProvider({ provider: "codex" }));
            assert.include(busy.reason, "still in use");
            assert.strictEqual(updates, 0);
            child.emit("exit");
            assert.include(
              (yield* Effect.flip(health.updateProvider({ provider: "codex" }))).reason,
              "still in use",
            );
            child.emit("close");
            const result = yield* health.updateProvider({ provider: "codex" });
            assert.strictEqual(updates, 1);
            assert.include(
              result.providers.find((status) => status.provider === "codex")?.updateState
                ?.message ?? "",
              "Restart Moss",
            );
            assert.throws(
              () =>
                programs.beginOperation({
                  binaryPath,
                  sourceHomePath: join(baseDir, "new-account"),
                }),
              /Restart Moss/,
            );
          }).pipe(Effect.provide(layer));
        }).pipe(Effect.scoped),
    );

    it("prepends update PATH entries under one Windows path key", () => {
      assert.deepStrictEqual(
        prependPathEntry({ Path: "C:\\Windows", HOME: "home" }, "C:\\npm", "win32"),
        { Path: "C:\\npm;C:\\Windows", HOME: "home" },
      );
      // An already duplicated environment collapses to the key Node would keep.
      assert.deepStrictEqual(
        prependPathEntry({ Path: "C:\\Windows", PATH: "C:\\short" }, "C:\\npm", "win32"),
        { PATH: "C:\\npm;C:\\short;C:\\Windows" },
      );
      assert.deepStrictEqual(prependPathEntry({ HOME: "home" }, "C:\\npm", "win32"), {
        HOME: "home",
        PATH: "C:\\npm",
      });
    });

    it("prepends update PATH entries under PATH on POSIX", () => {
      assert.deepStrictEqual(
        prependPathEntry({ PATH: "/usr/bin:/opt/bin", path: "ignored" }, "/opt/bin", "linux"),
        { PATH: "/opt/bin:/usr/bin", path: "ignored" },
      );
    });

    it.effect("runs provider updates with one prepended path key and stdin closed", () =>
      Effect.gen(function* () {
        let updateOptions: { env?: NodeJS.ProcessEnv; stdin?: string } | undefined;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-update-env-",
        });
        const binDir = path.join(baseDir, "bin");
        yield* fileSystem.makeDirectory(binDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(binDir, OS.platform() === "win32" ? "agy.exe" : "agy"),
          "",
        );
        const delimiter = OS.platform() === "win32" ? ";" : ":";
        // Packaged Windows servers inherit the native "Path" casing; reproduce it here.
        const inheritedPath = process.env.PATH;
        const pathKey = OS.platform() === "win32" ? "Path" : "PATH";
        delete process.env.PATH;
        process.env[pathKey] = [binDir, inheritedPath].filter(Boolean).join(delimiter);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            delete process.env[pathKey];
            process.env.PATH = inheritedPath;
          }),
        );
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            antigravity: { ...DEFAULT_SERVER_SETTINGS.providers.antigravity, enabled: true },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(settings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args, command, _env, options) => {
              if (path.basename(command).toLowerCase().startsWith("agy") && args[0] === "update") {
                updateOptions = options;
              }
              return { stdout: "", stderr: "", code: 0 };
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.updateProvider({ provider: "antigravity" });
        }).pipe(Effect.provide(layer));

        assert.strictEqual(updateOptions?.stdin, "ignore");
        const env = updateOptions?.env ?? {};
        const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
        assert.strictEqual(pathKeys.length, 1);
        assert.strictEqual(env[pathKeys[0]!]?.split(delimiter)[0], binDir);
      }).pipe(Effect.scoped),
    );

    it.effect("stops a hung provider process and persists a failed update state", () =>
      Effect.gen(function* () {
        yield* stubNpmLatestVersion({ "@openai/codex": CODEX_UPDATE_LATEST_VERSION });
        let killed = false;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-update-timeout-",
        });
        yield* writeProviderStatusCache({
          filePath: resolveProviderStatusCachePath({
            stateDir: path.join(baseDir, "userdata"),
            provider: "codex",
          }),
          provider: {
            provider: "codex",
            instanceId: "codex",
            driver: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: "2026-07-15T12:00:00.000Z",
            message: "Codex CLI is installed and authenticated.",
            version: "7.3.46",
          },
        });
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              enabled: true,
              binaryPath:
                "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex",
            },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        const layer = makeProviderHealthLive({ providerUpdateTimeoutMs: 20 }).pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(settings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            hangingSpawnerLayer({
              onKill: () => (killed = true),
              shouldHang: (args, command) =>
                command === "npm" && args.join(" ") === CODEX_UPDATE_PINNED_INSTALL,
              versionOutput: `codex-cli ${CODEX_UPDATE_INSTALLED_VERSION}`,
            }),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* TestClock.withLive(providerHealth.updateProvider({ provider: "codex" }));
        }).pipe(Effect.provide(layer));
        const codex = result.providers.find((provider) => provider.provider === "codex");

        assert.strictEqual(killed, true);
        assert.strictEqual(codex?.updateState?.status, "failed");
        assert.strictEqual(
          codex?.updateState?.message,
          "Update timed out after 20 milliseconds. The provider process was stopped.",
        );
      }),
    );

    it.effect("says why a failed update failed, in the updater's own words", () =>
      Effect.gen(function* () {
        yield* stubNpmLatestVersion({ "@openai/codex": CODEX_UPDATE_LATEST_VERSION });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-update-failure-",
        });
        yield* writeProviderStatusCache({
          filePath: resolveProviderStatusCachePath({
            stateDir: path.join(baseDir, "userdata"),
            provider: "codex",
          }),
          provider: {
            provider: "codex",
            instanceId: "codex",
            driver: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: "2026-07-15T12:00:00.000Z",
            message: "Codex CLI is installed and authenticated.",
            version: "7.3.46",
          },
        });
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              enabled: true,
              binaryPath:
                "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex",
            },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        // A fake npm: nothing here installs anything.
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(settings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args, command) =>
              command === "npm" && args[0] === "install"
                ? {
                    stdout: "",
                    stderr:
                      "npm error code EACCES\nnpm error A complete log of this run can be found in: /tmp/npm.log\n",
                    code: 1,
                  }
                : {
                    stdout: args.includes("--version")
                      ? `codex-cli ${CODEX_UPDATE_INSTALLED_VERSION}`
                      : "",
                    stderr: "",
                    code: 0,
                  },
            ),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.updateProvider({ provider: "codex" });
        }).pipe(Effect.provide(layer));
        const codex = result.providers.find((provider) => provider.provider === "codex");

        assert.strictEqual(codex?.updateState?.status, "failed");
        assert.strictEqual(
          codex?.updateState?.message,
          "Update command exited with code 1: npm error code EACCES",
        );
      }).pipe(Effect.scoped),
    );

    it.effect("installs from the other registry when the first one cannot serve the update", () =>
      Effect.gen(function* () {
        yield* stubNpmLatestVersion({ "@openai/codex": CODEX_UPDATE_LATEST_VERSION });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-update-registry-fallback-",
        });
        yield* writeProviderStatusCache({
          filePath: resolveProviderStatusCachePath({
            stateDir: path.join(baseDir, "userdata"),
            provider: "codex",
          }),
          provider: {
            provider: "codex",
            instanceId: "codex",
            driver: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: "2026-07-15T12:00:00.000Z",
            message: "Codex CLI is installed and authenticated.",
            version: "7.3.46",
          },
        });
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              enabled: true,
              binaryPath:
                "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex",
            },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        const installs: string[] = [];
        // A fake npm whose first registry times out and whose mirror works.
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(settings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args, command) => {
              if (command === "npm" && args[0] === "install") {
                installs.push(args.join(" "));
                return args.some((argument) => argument.startsWith("--registry="))
                  ? { stdout: "added 1 package", stderr: "", code: 0 }
                  : {
                      stdout: "",
                      stderr:
                        "npm error code ETIMEDOUT\nnpm error network request to https://registry.npmjs.org/@openai%2fcodex failed\n",
                      code: 1,
                    };
              }
              return {
                stdout: args.includes("--version")
                  ? `codex-cli ${CODEX_UPDATE_INSTALLED_VERSION}`
                  : "",
                stderr: "",
                code: 0,
              };
            }),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.updateProvider({ provider: "codex" });
        }).pipe(Effect.provide(layer));
        const codex = result.providers.find((provider) => provider.provider === "codex");

        assert.deepStrictEqual(installs, [
          CODEX_UPDATE_PINNED_INSTALL,
          `install -g --registry=https://registry.npmmirror.com --prefix /Users/test/.nvm/versions/node/v24.13.0 @openai/codex@${CODEX_UPDATE_LATEST_VERSION}`,
        ]);
        assert.strictEqual(codex?.updateState?.status, "succeeded");
      }).pipe(Effect.scoped),
    );

    it.effect("does not retry another registry for an error that is not the registry's", () =>
      Effect.gen(function* () {
        yield* stubNpmLatestVersion({ "@openai/codex": CODEX_UPDATE_LATEST_VERSION });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-update-no-fallback-",
        });
        yield* writeProviderStatusCache({
          filePath: resolveProviderStatusCachePath({
            stateDir: path.join(baseDir, "userdata"),
            provider: "codex",
          }),
          provider: {
            provider: "codex",
            instanceId: "codex",
            driver: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: "2026-07-15T12:00:00.000Z",
            message: "Codex CLI is installed and authenticated.",
            version: "7.3.46",
          },
        });
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              enabled: true,
              binaryPath:
                "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex",
            },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        let installs = 0;
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(settings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args, command) => {
              if (command === "npm" && args[0] === "install") {
                installs += 1;
                return { stdout: "", stderr: "npm error code EACCES\n", code: 1 };
              }
              return {
                stdout: args.includes("--version")
                  ? `codex-cli ${CODEX_UPDATE_INSTALLED_VERSION}`
                  : "",
                stderr: "",
                code: 0,
              };
            }),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.updateProvider({ provider: "codex" });
        }).pipe(Effect.provide(layer));
        const codex = result.providers.find((provider) => provider.provider === "codex");

        assert.strictEqual(installs, 1);
        assert.strictEqual(codex?.updateState?.status, "failed");
      }).pipe(Effect.scoped),
    );

    it("updates npm-managed Pi with npm at the prefix that owns it, never with pi update", () => {
      const definition = PACKAGE_MANAGED_PROVIDER_UPDATES.pi;
      assert.ok(definition);

      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: "pi",
        realCommandPath:
          "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
        commandDirectory: "/Users/test/.nvm/versions/node/v24.13.0/bin",
      });

      assert.deepStrictEqual(capabilities.update, {
        command:
          "npm install -g --prefix /Users/test/.nvm/versions/node/v24.13.0 @earendil-works/pi-coding-agent@latest",
        executable: "npm",
        args: [
          "install",
          "-g",
          "--prefix",
          "/Users/test/.nvm/versions/node/v24.13.0",
          "@earendil-works/pi-coding-agent@latest",
        ],
        lockKey: "npm-global",
        pathPrepend: "/Users/test/.nvm/versions/node/v24.13.0/bin",
      });
    });

    it.effect("refuses one-click updates when MOSS_DISABLE_PROVIDER_UPDATES=1", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-update-disabled-env-",
        });
        const previous = process.env[PROVIDER_UPDATES_DISABLED_ENV];
        process.env[PROVIDER_UPDATES_DISABLED_ENV] = "1";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
            else process.env[PROVIDER_UPDATES_DISABLED_ENV] = previous;
          }),
        );
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: true },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        const spawned: string[] = [];
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(settings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args, command) => {
              spawned.push([command, ...args].join(" "));
              return { stdout: "", stderr: "", code: 0 };
            }),
          ),
        );

        const error = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* Effect.flip(providerHealth.updateProvider({ provider: "codex" }));
        }).pipe(Effect.provide(layer));

        assert.ok(error instanceof ServerProviderUpdateError);
        assert.match(error.reason, /MOSS_DISABLE_PROVIDER_UPDATES=1/);
        assert.ok(!spawned.some((command) => /\bupdate\b|\binstall\b/.test(command)));
      }).pipe(Effect.scoped),
    );

    it.effect("refuses one-click installs and removals when MOSS_DISABLE_PROVIDER_UPDATES=1", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-install-disabled-env-",
        });
        const previous = process.env[PROVIDER_UPDATES_DISABLED_ENV];
        process.env[PROVIDER_UPDATES_DISABLED_ENV] = "1";
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env[PROVIDER_UPDATES_DISABLED_ENV];
            else process.env[PROVIDER_UPDATES_DISABLED_ENV] = previous;
          }),
        );
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            pi: { ...DEFAULT_SERVER_SETTINGS.providers.pi, enabled: true },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        const spawned: string[] = [];
        const layer = makeProviderHealthLive().pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(settings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args, command) => {
              spawned.push([command, ...args].join(" "));
              return { stdout: "", stderr: "", code: 0 };
            }),
          ),
        );

        const errors = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          const providers: Array<"pi" | "cursor"> = ["pi"];
          if (process.platform === "win32" && ["x64", "arm64"].includes(process.arch))
            providers.push("cursor");
          const errors = [];
          for (const provider of providers) {
            errors.push(yield* Effect.flip(providerHealth.installProvider({ provider })));
            errors.push(
              yield* Effect.flip(
                providerHealth.manageProviderInstallation!({ provider, action: "uninstall" }),
              ),
            );
          }
          return errors;
        }).pipe(Effect.provide(layer));

        for (const error of errors) assert.match(error.reason, /MOSS_DISABLE_PROVIDER_UPDATES=1/);
        assert.ok(!spawned.some((command) => /\binstall\b/u.test(command)));
        assert.ok(!spawned.some((command) => /Get-CimInstance|\.partial-/u.test(command)));
      }).pipe(Effect.scoped),
    );

    it.effect("stops a running provider update when the provider is disabled", () =>
      Effect.gen(function* () {
        yield* stubNpmLatestVersion({ "@openai/codex": CODEX_UPDATE_LATEST_VERSION });
        let killed = false;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-update-disable-",
        });
        yield* writeProviderStatusCache({
          filePath: resolveProviderStatusCachePath({
            stateDir: path.join(baseDir, "userdata"),
            provider: "codex",
          }),
          provider: {
            provider: "codex",
            instanceId: "codex",
            driver: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: "2026-07-15T12:00:00.000Z",
            message: "Codex CLI is installed and authenticated.",
            version: "7.3.46",
          },
        });
        const settings = {
          ...allProvidersDisabledServerSettings,
          providers: {
            ...allProvidersDisabledServerSettings.providers,
            codex: {
              ...DEFAULT_SERVER_SETTINGS.providers.codex,
              enabled: true,
              binaryPath:
                "/Users/test/.nvm/versions/node/v24.13.0/lib/node_modules/@openai/codex/bin/codex",
            },
          },
        } satisfies typeof DEFAULT_SERVER_SETTINGS;
        const serverSettingsLayer = ServerSettingsService.layerTest(settings);
        const layer = makeProviderHealthLive({ providerUpdateTimeoutMs: 10_000 }).pipe(
          Layer.provideMerge(serverSettingsLayer),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            hangingSpawnerLayer({
              onKill: () => (killed = true),
              onHang: markStarted,
              shouldHang: (args, command) =>
                command === "npm" && args.join(" ") === CODEX_UPDATE_PINNED_INSTALL,
              versionOutput: `codex-cli ${CODEX_UPDATE_INSTALLED_VERSION}`,
            }),
          ),
        );

        const result = yield* TestClock.withLive(
          Effect.gen(function* () {
            const providerHealth = yield* ProviderHealth;
            const serverSettings = yield* ServerSettingsService;
            const updateFiber = yield* providerHealth
              .updateProvider({ provider: "codex" })
              .pipe(Effect.forkChild);
            yield* Effect.promise(() => started);
            yield* serverSettings.updateSettings({ providers: { codex: { enabled: false } } });
            return yield* Fiber.join(updateFiber);
          }).pipe(Effect.provide(layer)),
        );
        const codex = result.providers.find((provider) => provider.provider === "codex");

        assert.strictEqual(killed, true);
        assert.strictEqual(codex?.updateState?.status, "failed");
        assert.strictEqual(
          codex?.updateState?.message,
          "Update stopped because the provider was disabled.",
        );
      }),
    );
  });

  describe("disabled provider handling", () => {
    it("builds an inert status for disabled providers", () => {
      assert.deepStrictEqual(makeDisabledProviderStatus("opencode", "2026-06-16T12:00:00.000Z"), {
        provider: "opencode",
        instanceId: "opencode",
        driver: "opencode",
        status: "warning",
        available: false,
        authStatus: "unknown",
        checkedAt: "2026-06-16T12:00:00.000Z",
        message: "Provider is disabled in Moss settings.",
      });
    });

    it("projects disabled settings over cached ready statuses", () => {
      const statuses = projectProviderStatusesForSettings(
        [cachedReadyCodexStatus],
        allProvidersDisabledServerSettings,
        "2026-06-16T12:05:00.000Z",
      );
      const codex = statuses.find((status) => status.provider === "codex");

      // Every built-in driver (14 supported plus legacy Droid settings) gets an inert status.
      assert.strictEqual(statuses.length, 15);
      assert.strictEqual(codex?.available, false);
      assert.strictEqual(codex?.message, "Provider is disabled in Moss settings.");
    });

    it("changes projected statuses for settings-only instance updates", () => {
      const previousStatuses = projectProviderStatusesForSettings(
        [cachedReadyCodexStatus],
        {
          ...allProvidersDisabledServerSettings,
          providerInstances: {
            codex_work: {
              driver: "codex",
              displayName: "Work Codex",
              enabled: false,
            },
          },
        },
        "2026-06-16T12:05:00.000Z",
      );
      const nextStatuses = projectProviderStatusesForSettings(
        [cachedReadyCodexStatus],
        {
          ...allProvidersDisabledServerSettings,
          providerInstances: {
            codex_work: {
              driver: "codex",
              displayName: "Renamed Codex",
              enabled: false,
            },
          },
        },
        "2026-06-16T12:05:00.000Z",
      );

      const previousWork = previousStatuses.find((status) => status.instanceId === "codex_work");
      const nextWork = nextStatuses.find((status) => status.instanceId === "codex_work");
      assert.strictEqual(previousWork?.displayName, "Work Codex");
      assert.strictEqual(nextWork?.displayName, "Renamed Codex");
      assert.strictEqual(nextWork?.available, false);
      assert.strictEqual(nextWork?.message, "Provider is disabled in Moss settings.");
      assert.strictEqual(providerStatusesEqual(previousStatuses, nextStatuses), false);
    });

    it("suppresses cached update advisories when automatic update checks are disabled", () => {
      const statuses = projectProviderStatusesForSettings(
        [
          {
            ...cachedReadyCodexStatus,
            version: "0.129.0",
            versionAdvisory: {
              status: "behind_latest",
              currentVersion: "0.129.0",
              latestVersion: "0.130.0",
              updateCommand: "npm install -g @openai/codex@latest",
              canUpdate: true,
              checkedAt: "2026-06-16T12:00:00.000Z",
              message: "Update available.",
            },
          },
        ],
        { ...DEFAULT_SERVER_SETTINGS, enableProviderUpdateChecks: false },
        "2026-06-16T12:05:00.000Z",
      );
      const codex = statuses.find((status) => status.provider === "codex");

      assert.strictEqual(codex?.available, true);
      assert.strictEqual(codex?.version, "0.129.0");
      assert.strictEqual(codex?.versionAdvisory?.status, "unknown");
      assert.strictEqual(codex?.versionAdvisory?.latestVersion, null);
      assert.strictEqual(codex?.versionAdvisory?.canUpdate, false);
      assert.strictEqual(codex?.versionAdvisory?.updateCommand, null);
    });

    it("does not copy one authenticated status onto every provider instance", () => {
      const statuses = projectProviderStatusesForSettings(
        [
          {
            ...cachedReadyCodexStatus,
            authType: "chatgpt",
            authLabel: "Default Account",
          },
        ],
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            codex_work: {
              driver: "codex",
              displayName: "Codex Work",
              config: {
                accountId: "work",
              },
            },
          },
        },
        "2026-06-16T12:05:00.000Z",
      );

      const defaultCodex = statuses.find((status) => status.instanceId === "codex");
      const workCodex = statuses.find((status) => status.instanceId === "codex_work");
      assert.strictEqual(defaultCodex?.authStatus, "authenticated");
      assert.strictEqual(defaultCodex?.authLabel, "Default Account");
      assert.strictEqual(workCodex?.status, "warning");
      assert.strictEqual(workCodex?.authStatus, "unknown");
      assert.strictEqual(workCodex?.authLabel, undefined);
    });

    it("does not project a custom instance status onto the default account", () => {
      const statuses = projectProviderStatusesForSettings(
        [
          {
            ...cachedReadyCodexStatus,
            instanceId: "codex_work",
            displayName: "Codex Work",
            authType: "chatgpt",
            authLabel: "Work Account",
          },
        ],
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            codex_work: {
              driver: "codex",
              displayName: "Codex Work",
              config: {
                accountId: "work",
              },
            },
          },
        },
        "2026-06-16T12:05:00.000Z",
      );

      const defaultCodex = statuses.find((status) => status.instanceId === "codex");
      const workCodex = statuses.find((status) => status.instanceId === "codex_work");
      assert.strictEqual(defaultCodex?.status, "warning");
      assert.strictEqual(defaultCodex?.authStatus, "unknown");
      assert.strictEqual(defaultCodex?.authLabel, undefined);
      assert.strictEqual(workCodex?.authStatus, "authenticated");
      assert.strictEqual(workCodex?.authLabel, "Work Account");
    });

    it("does not project a cached status after its instance id changes drivers", () => {
      const statuses = projectProviderStatusesForSettings(
        [
          {
            ...cachedReadyCodexStatus,
            instanceId: "work",
            displayName: "Codex Work",
            authType: "chatgpt",
            authLabel: "Old Codex Account",
          },
        ],
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            work: {
              driver: "claudeAgent",
              displayName: "Claude Work",
            },
          },
        },
        "2026-06-16T12:05:00.000Z",
      );

      const work = statuses.find((status) => status.instanceId === "work");
      assert.strictEqual(work?.provider, "claudeAgent");
      assert.strictEqual(work?.driver, "claudeAgent");
      assert.strictEqual(work?.status, "warning");
      assert.strictEqual(work?.available, false);
      assert.strictEqual(work?.authStatus, "unknown");
      assert.strictEqual(work?.authLabel, undefined);
      assert.strictEqual(work?.message, "Provider instance has not been checked yet.");
    });

    it("projects unsupported provider instances as unavailable shadows", () => {
      const statuses = projectProviderStatusesForSettings(
        [cachedReadyCodexStatus],
        {
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            fork_work: {
              driver: "customFork",
              displayName: "Fork Work",
              enabled: true,
            },
          },
        },
        "2026-06-16T12:05:00.000Z",
      );

      const unsupported = statuses.find((status) => status.instanceId === "fork_work");
      assert.strictEqual(unsupported?.provider, "customFork");
      assert.strictEqual(unsupported?.driver, "customFork");
      assert.strictEqual(unsupported?.displayName, "Fork Work");
      assert.strictEqual(unsupported?.enabled, false);
      assert.strictEqual(unsupported?.available, false);
      assert.strictEqual(unsupported?.availability, "unavailable");
      assert.strictEqual(
        unsupported?.unavailableReason,
        "Provider driver 'customFork' is not supported by this Moss build.",
      );
    });

    it.effect("does not expose cached ready statuses for disabled providers", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-disabled-cache-",
        });
        const cachePath = resolveProviderStatusCachePath({
          stateDir: path.join(baseDir, "userdata"),
          provider: "codex",
        });
        yield* writeProviderStatusCache({
          filePath: cachePath,
          provider: cachedReadyCodexStatus,
        });

        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(allProvidersDisabledSettings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
        );
        const statuses = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.getStatuses;
        }).pipe(Effect.provide(layer));
        const codex = statuses.find((status) => status.provider === "codex");
        const cachedCodex = yield* readProviderStatusCache(cachePath);

        assert.strictEqual(codex?.available, false);
        assert.strictEqual(codex?.message, "Provider is disabled in Moss settings.");
        assert.deepStrictEqual(cachedCodex, cachedReadyCodexStatus);
      }),
    );

    it.effect("projects cached ready status when a disabled provider is re-enabled", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-enable-cache-",
        });
        const cachePath = resolveProviderStatusCachePath({
          stateDir: path.join(baseDir, "userdata"),
          provider: "codex",
        });
        yield* writeProviderStatusCache({
          filePath: cachePath,
          provider: cachedReadyCodexStatus,
        });

        let spawnCount = 0;
        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(allProvidersDisabledSettings)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer((args) => {
              spawnCount += 1;
              const joined = args.join(" ");
              if (joined === "--version") {
                return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              }
              if (joined === "-c mcp_servers={} login status") {
                return { stdout: '{"authenticated":true}\n', stderr: "", code: 0 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );

        yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          const serverSettings = yield* ServerSettingsService;
          const disabledStatuses = yield* providerHealth.getStatuses;
          const disabledCodex = disabledStatuses.find((status) => status.provider === "codex");

          assert.strictEqual(disabledCodex?.available, false);
          assert.strictEqual(disabledCodex?.message, "Provider is disabled in Moss settings.");

          yield* serverSettings.updateSettings({
            providers: {
              codex: {
                enabled: true,
              },
            },
          });

          const currentStatuses = yield* providerHealth.getStatuses;
          const currentCodex = currentStatuses.find((status) => status.provider === "codex");
          assert.strictEqual(currentCodex?.available, true);
          assert.strictEqual(currentCodex?.authStatus, "authenticated");
          assert.notStrictEqual(currentCodex?.message, "Provider is disabled in Moss settings.");
          assert.strictEqual(spawnCount, 0);
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("does not offer updates for disabled providers", () =>
      Effect.gen(function* () {
        const providerHealth = yield* ProviderHealth;
        const statuses = yield* providerHealth.refresh;

        assert.strictEqual(statuses.length, 15);
        for (const status of statuses) {
          assert.strictEqual(status.available, false);
          assert.strictEqual(status.message, "Provider is disabled in Moss settings.");
          assert.strictEqual(status.versionAdvisory?.status, "unknown");
          assert.strictEqual(status.versionAdvisory?.canUpdate, false);
          assert.strictEqual(status.versionAdvisory?.updateCommand, null);
        }
      }).pipe(Effect.provide(disabledProviderHealthLayer)),
    );

    it.effect("queues another bounded refresh when the follow-up also becomes stale", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-enable-race-",
        });
        const commands: string[] = [];
        const makeProbeGate = () => {
          let release!: () => void;
          let markStarted!: () => void;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          const started = new Promise<void>((resolve) => {
            markStarted = resolve;
          });
          return { release, released, markStarted, started };
        };
        const probeGates = Array.from({ length: 5 }, makeProbeGate);
        let codexVersionAttempts = 0;
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const input = command as unknown as {
              readonly command: string;
              readonly args: ReadonlyArray<string>;
              readonly options?: { readonly windowsVerbatimArguments?: boolean };
            };
            const invocation = providerInvocationForTest(input);
            const commandName = win32.basename(invocation.command).replace(/\.exe$/iu, "");
            commands.push(invocation.command);
            const result = invocation.args.includes("--version")
              ? { stdout: `${commandName} 1.0.0\n`, stderr: "", code: 0 }
              : { stdout: '{"authenticated":true}\n', stderr: "", code: 0 };
            if (commandName !== "codex" || !invocation.args.includes("--version")) {
              return Effect.succeed(mockHandle(result));
            }
            const attemptIndex = codexVersionAttempts;
            codexVersionAttempts += 1;
            const gate = probeGates[attemptIndex];
            gate?.markStarted();
            if (!gate || attemptIndex >= 4) {
              return Effect.succeed(mockHandle(result));
            }
            return Effect.succeed(
              mockHandle(result, {
                exitCode: Effect.promise(() => gate.released).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              }),
            );
          }),
        );
        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              ...allProvidersDisabledSettings,
              // This race test only exercises refresh serialization. Keep it hermetic so
              // provider-maintenance advisory lookups cannot consume the test deadline.
              enableProviderUpdateChecks: false,
              providers: {
                ...allProvidersDisabledSettings.providers,
                codex: { enabled: true },
              },
            }),
          ),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(spawnerLayer),
        );

        yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          const serverSettings = yield* ServerSettingsService;
          const firstRefresh = yield* providerHealth.refresh.pipe(Effect.forkChild);
          yield* Effect.promise(() => probeGates[0]!.started);
          yield* serverSettings.updateSettings({ providers: { opencode: { enabled: true } } });
          const joinedRefresh = yield* providerHealth.refresh.pipe(Effect.forkChild);
          probeGates[0]!.release();
          yield* Effect.promise(() => probeGates[1]!.started);
          yield* serverSettings.updateSettings({ providers: { pi: { enabled: true } } });
          probeGates[1]!.release();
          yield* Effect.promise(() => probeGates[2]!.started);
          yield* serverSettings.updateSettings({ providers: { grok: { enabled: true } } });
          probeGates[2]!.release();
          yield* Effect.promise(() => probeGates[3]!.started);
          yield* serverSettings.updateSettings({ providers: { droid: { enabled: true } } });
          probeGates[3]!.release();
          yield* Fiber.join(joinedRefresh);
          yield* Fiber.join(firstRefresh);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(Duration.millis(100));
          yield* Effect.promise(() => probeGates[4]!.started);
          const statuses = yield* providerHealth.refresh;

          assert.ok(commands.some((command) => command.includes("opencode")));
          assert.ok(commands.some((command) => command.includes("pi")));
          assert.ok(commands.some((command) => command.includes("grok")));
          assert.ok(commands.some((command) => command.includes("droid")));
          assert.notStrictEqual(
            statuses.find((status) => status.provider === "opencode")?.message,
            "Provider is disabled in Moss settings.",
          );
          assert.notStrictEqual(
            statuses.find((status) => status.provider === "pi")?.message,
            "Provider is disabled in Moss settings.",
          );
          assert.notStrictEqual(
            statuses.find((status) => status.provider === "droid")?.message,
            "Provider is disabled in Moss settings.",
          );
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect("rejects one-click updates for disabled providers", () =>
      Effect.gen(function* () {
        const providerHealth = yield* ProviderHealth;
        const error = yield* Effect.flip(providerHealth.updateProvider({ provider: "opencode" }));

        assert.ok(error instanceof ServerProviderUpdateError);
        assert.strictEqual(error.provider, "opencode");
        assert.strictEqual(error.reason, "Provider is disabled in Moss settings.");
      }).pipe(Effect.provide(disabledProviderHealthLayer)),
    );

    it.effect("rejects one-click updates for missing explicit provider instances", () =>
      Effect.gen(function* () {
        const providerHealth = yield* ProviderHealth;
        const error = yield* Effect.flip(
          providerHealth.updateProvider({ provider: "codex", instanceId: "codex_missing" }),
        );

        assert.ok(error instanceof ServerProviderUpdateError);
        assert.strictEqual(error.provider, "codex");
        assert.strictEqual(error.instanceId, "codex_missing");
        assert.strictEqual(error.reason, "Provider instance is not configured.");
      }).pipe(
        Effect.provide(
          ProviderHealthLive.pipe(
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "provider-health-missing-" }),
            ),
          ),
        ),
      ),
    );
  });

  describe("startup refresh behavior", () => {
    it.effect("re-probes when Re-detect joins a health check already past CLI discovery", () =>
      Effect.gen(function* () {
        yield* withFakePath(["opencode"]);
        let release!: () => void;
        let markStarted!: () => void;
        let markForcedAgain!: () => void;
        const released = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const forcedAgain = new Promise<void>((resolve) => {
          markForcedAgain = resolve;
        });
        let version = "1.0.0";
        let forceCount = 0;
        let probes = 0;
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(AgentCliPathFloor, "ensureAgentCliPath")
              .mockImplementation(async (_home, options) => {
                if (options?.force && ++forceCount === 2) {
                  version = "2.0.0";
                  markForcedAgain();
                }
                return [];
              }),
          ),
          (mock) => Effect.sync(() => mock.mockRestore()),
        );
        const spawner = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => {
            probes += 1;
            const result = { stdout: version, stderr: "", code: 0 };
            if (probes !== 1) return Effect.succeed(mockHandle(result));
            markStarted();
            return Effect.succeed(
              mockHandle(result, {
                exitCode: Effect.promise(() => released).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
              }),
            );
          }),
        );
        const layer = makeProviderHealthLive({ maintainAgentCliPath: true }).pipe(
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              ...allProvidersDisabledServerSettings,
              enableProviderUpdateChecks: false,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: true },
              },
            }),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "provider-redetect-race-" }),
          ),
          Layer.provideMerge(spawner),
        );
        yield* Effect.gen(function* () {
          const health = yield* ProviderHealth;
          const first = yield* health.refresh.pipe(Effect.forkChild);
          yield* Effect.promise(() => started);
          const second = yield* health.refresh.pipe(Effect.forkChild);
          yield* Effect.promise(() => forcedAgain);
          yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
          release();
          const statuses = yield* Fiber.join(second);
          yield* Fiber.join(first);
          assert.strictEqual(statuses.find((row) => row.provider === "opencode")?.version, "2.0.0");
          assert.strictEqual(probes, 2);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
    );

    it.effect("forces CLI discovery before an explicit re-detect probes existing tools", () =>
      Effect.gen(function* () {
        yield* withFakePath(["opencode"]);
        const scans: boolean[] = [];
        const scanner = yield* Effect.acquireRelease(
          Effect.sync(() =>
            vi
              .spyOn(AgentCliPathFloor, "ensureAgentCliPath")
              .mockImplementation(async (_home, options) => {
                scans.push(options?.force === true);
                return [];
              }),
          ),
          (mock) => Effect.sync(() => mock.mockRestore()),
        );
        let probes = 0;
        const layer = makeProviderHealthLive({ maintainAgentCliPath: true }).pipe(
          Layer.provideMerge(
            ServerSettingsService.layerTest({
              ...allProvidersDisabledServerSettings,
              enableProviderUpdateChecks: false,
              providers: {
                ...allProvidersDisabledServerSettings.providers,
                opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, enabled: true },
              },
            }),
          ),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "provider-redetect-" }),
          ),
          Layer.provideMerge(
            mockSpawnerLayer((args) => {
              assert.isTrue(scans.includes(true));
              probes += 1;
              return { stdout: args.includes("--version") ? "1.18.31" : "{}", stderr: "", code: 0 };
            }),
          ),
        );
        const statuses = yield* Effect.gen(function* () {
          return yield* (yield* ProviderHealth).refresh;
        }).pipe(Effect.provide(layer));
        assert.isTrue(scanner.mock.calls.some(([, options]) => options?.force === true));
        assert.isAbove(probes, 0);
        assert.isTrue(statuses.find((row) => row.provider === "opencode")?.available);
      }).pipe(Effect.scoped),
    );

    it.effect("serves cached statuses without spawning provider CLIs on layer startup", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-no-boot-refresh-",
        });
        let spawnCount = 0;
        const layer = ProviderHealthLive.pipe(
          Layer.provideMerge(ServerSettingsService.layerTest(DEFAULT_SERVER_SETTINGS)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(
            mockSpawnerLayer(() => {
              spawnCount += 1;
              return { stdout: "", stderr: "", code: 0 };
            }),
          ),
        );

        const statuses = yield* Effect.gen(function* () {
          const providerHealth = yield* ProviderHealth;
          return yield* providerHealth.getStatuses;
        }).pipe(Effect.provide(layer));

        // Gemini, Hermes, and the ACP agent drivers are built-in but disabled by
        // default, so they are projected as inert settings statuses; nothing is
        // probed or cached.
        assert.deepStrictEqual(
          statuses
            .map(({ provider, available, message }) => ({ provider, available, message }))
            .toSorted((left, right) => left.provider.localeCompare(right.provider)),
          ["gemini", "hermes", "kimi", "minimax", "zcode"].map((provider) => ({
            provider,
            available: false,
            message: "Provider is disabled in Moss settings.",
          })),
        );
        assert.strictEqual(spawnCount, 0);
      }),
    );
  });

  describe("stabilizeProviderStatusesAgainstTransientTimeouts", () => {
    const previousReadyOpenCode = {
      provider: "opencode",
      instanceId: "opencode",
      driver: "opencode",
      status: "ready",
      available: true,
      authStatus: "unknown",
      version: "1.15.13",
      checkedAt: "2026-06-04T17:00:00.000Z",
      message:
        "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
    } satisfies ServerProviderStatus;

    it("keeps an already usable provider available after a transient command timeout", () => {
      const result = stabilizeProviderStatusesAgainstTransientTimeouts(
        [previousReadyOpenCode],
        [
          {
            provider: "opencode",
            instanceId: "opencode",
            driver: "opencode",
            status: "error",
            available: false,
            authStatus: "unknown",
            checkedAt: "2026-06-04T17:01:00.000Z",
            message:
              "OpenCode CLI is installed but failed to run. Timed out while running command.",
          },
        ],
      );

      assert.deepStrictEqual(result, [
        {
          ...previousReadyOpenCode,
          checkedAt: "2026-06-04T17:01:00.000Z",
        },
      ]);
    });

    it("drops a cached update advisory when a transient timeout prevents verification", () => {
      const previousWithUpdate = {
        ...previousReadyOpenCode,
        versionAdvisory: {
          status: "behind_latest",
          currentVersion: "1.15.13",
          latestVersion: "1.16.0",
          updateCommand: "npm install -g opencode-ai@latest",
          canUpdate: true,
          checkedAt: "2026-06-04T17:00:00.000Z",
          message: "Update available.",
        },
      } satisfies ServerProviderStatus;

      const [result] = stabilizeProviderStatusesAgainstTransientTimeouts(
        [previousWithUpdate],
        [
          {
            provider: "opencode",
            instanceId: "opencode",
            driver: "opencode",
            status: "error",
            available: false,
            authStatus: "unknown",
            checkedAt: "2026-06-04T17:01:00.000Z",
            message:
              "OpenCode CLI is installed but failed to run. Timed out while running command.",
          },
        ],
      );

      assert.strictEqual(result?.status, "ready");
      assert.strictEqual(result?.available, true);
      assert.deepStrictEqual(result?.versionAdvisory, {
        status: "unknown",
        currentVersion: "1.15.13",
        latestVersion: null,
        updateCommand: null,
        canUpdate: false,
        checkedAt: "2026-06-04T17:01:00.000Z",
        message: null,
      });
    });

    it("does not hide non-timeout provider failures", () => {
      const unavailableStatus = {
        provider: "opencode",
        instanceId: "opencode",
        driver: "opencode",
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt: "2026-06-04T17:01:00.000Z",
        message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
      } satisfies ServerProviderStatus;

      assert.deepStrictEqual(
        stabilizeProviderStatusesAgainstTransientTimeouts(
          [previousReadyOpenCode],
          [unavailableStatus],
        ),
        [unavailableStatus],
      );
    });

    it("does not stabilize a reused instance id against another driver's status", () => {
      const previousCodex = {
        ...cachedReadyCodexStatus,
        instanceId: "work",
      } satisfies ServerProviderStatus;
      const claudeTimeout = {
        provider: "claudeAgent",
        instanceId: "work",
        driver: "claudeAgent",
        status: "warning",
        available: true,
        authStatus: "unknown",
        checkedAt: "2026-06-04T17:01:00.000Z",
        message: "Could not verify Claude authentication status. Timed out while running command.",
      } satisfies ServerProviderStatus;

      assert.deepStrictEqual(
        stabilizeProviderStatusesAgainstTransientTimeouts([previousCodex], [claudeTimeout]),
        [claudeTimeout],
      );
    });

    it("keeps an already usable provider ready after a transient auth timeout warning", () => {
      const previousReadyClaude = {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        version: "2.1.162",
        checkedAt: "2026-06-04T17:00:00.000Z",
      } satisfies ServerProviderStatus;

      const result = stabilizeProviderStatusesAgainstTransientTimeouts(
        [previousReadyClaude],
        [
          {
            provider: "claudeAgent",
            instanceId: "claudeAgent",
            driver: "claudeAgent",
            status: "warning",
            available: true,
            authStatus: "unknown",
            version: "2.1.162",
            checkedAt: "2026-06-04T17:01:00.000Z",
            message:
              "Could not verify Claude authentication status. Timed out while running command.",
          },
        ],
      );

      assert.deepStrictEqual(result, [
        {
          ...previousReadyClaude,
          checkedAt: "2026-06-04T17:01:00.000Z",
        },
      ]);
    });

    it("keeps an already usable Pi provider ready after its advisory timeout wording", () => {
      const previousReadyPi = {
        provider: "pi",
        instanceId: "pi",
        driver: "pi",
        status: "ready",
        available: true,
        authStatus: "unknown",
        version: "0.84.4",
        checkedAt: "2026-09-04T01:03:00.000Z",
        message: "Pi CLI is installed. Configure provider credentials inside Pi as needed.",
      } satisfies ServerProviderStatus;
      const piTimeout = {
        provider: "pi",
        instanceId: "pi",
        driver: "pi",
        status: "warning",
        available: true,
        authStatus: "unknown",
        checkedAt: "2026-09-04T01:04:00.000Z",
        message:
          "Pi SDK is bundled, but the CLI health check timed out before Moss could verify the installed version.",
      } satisfies ServerProviderStatus;

      assert.deepStrictEqual(
        stabilizeProviderStatusesAgainstTransientTimeouts([previousReadyPi], [piTimeout]),
        [
          {
            ...previousReadyPi,
            checkedAt: "2026-09-04T01:04:00.000Z",
          },
        ],
      );
    });

    it("does not keep a stale Claude auth error after a transient auth timeout", () => {
      const previousUnauthenticatedClaude = {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        status: "error",
        available: true,
        authStatus: "unauthenticated",
        version: "2.1.162",
        checkedAt: "2026-06-04T17:00:00.000Z",
        message: "Claude is not authenticated. Run `claude auth login` and try again.",
      } satisfies ServerProviderStatus;
      const authTimeoutWarning = {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        status: "warning",
        available: true,
        authStatus: "unknown",
        version: "2.1.162",
        checkedAt: "2026-06-04T17:01:00.000Z",
        message: "Could not verify Claude authentication status. Timed out while running command.",
      } satisfies ServerProviderStatus;

      assert.deepStrictEqual(
        stabilizeProviderStatusesAgainstTransientTimeouts(
          [previousUnauthenticatedClaude],
          [authTimeoutWarning],
        ),
        [authTimeoutWarning],
      );
    });
  });

  describe("providerStatusesEqual", () => {
    const readyCursor = {
      provider: "cursor",
      instanceId: "cursor",
      driver: "cursor",
      status: "ready",
      available: true,
      authStatus: "unknown",
      version: "2026.06.04-8f81907",
      checkedAt: "2026-06-04T17:00:00.000Z",
      message:
        "Cursor Agent CLI is installed. Sign in with Cursor if a session prompts for authentication.",
      versionAdvisory: {
        status: "current",
        currentVersion: "2026.06.04-8f81907",
        latestVersion: "2026.06.04-8f81907",
        updateCommand: null,
        canUpdate: true,
        checkedAt: "2026-06-04T17:00:00.000Z",
        message: null,
      },
    } satisfies ServerProviderStatus;

    it("ignores top-level and version-advisory checkedAt churn", () => {
      assert.strictEqual(
        providerStatusesEqual(
          [readyCursor],
          [
            {
              ...readyCursor,
              checkedAt: "2026-06-04T17:01:00.000Z",
              versionAdvisory: {
                ...readyCursor.versionAdvisory,
                checkedAt: "2026-06-04T17:01:00.000Z",
              },
            },
          ],
        ),
        true,
      );
    });

    it("detects meaningful version-advisory changes", () => {
      assert.strictEqual(
        providerStatusesEqual(
          [readyCursor],
          [
            {
              ...readyCursor,
              versionAdvisory: {
                ...readyCursor.versionAdvisory,
                status: "behind_latest",
                latestVersion: "2026.06.05-a1b2c3d",
              },
            },
          ],
        ),
        false,
      );
    });

    it("detects Auto capability and probe-binary changes", () => {
      const readyCodex = {
        ...readyCursor,
        provider: "codex",
        supportsAutoRuntimeMode: true,
        autoRuntimeModeBinaryPath: "codex",
      } satisfies ServerProviderStatus;

      assert.strictEqual(
        providerStatusesEqual([readyCodex], [{ ...readyCodex, supportsAutoRuntimeMode: false }]),
        false,
      );
      assert.strictEqual(
        providerStatusesEqual(
          [readyCodex],
          [{ ...readyCodex, autoRuntimeModeBinaryPath: "/custom/bin/codex" }],
        ),
        false,
      );
    });
  });

  // ── checkCodexProviderStatus tests ────────────────────────────────
  //
  // These tests control CODEX_HOME to ensure the custom-provider detection
  // in checkCodexProviderStatus does not interfere with the auth-probe
  // path being tested.

  describe("checkCodexProviderStatus", () => {
    it.effect("returns ready when codex is installed and authenticated", () =>
      Effect.gen(function* () {
        // Point CODEX_HOME at an empty tmp dir (no config.toml) so the
        // default code path (OpenAI provider, auth probe runs) is exercised.
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "-c mcp_servers={} login status")
              return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses configured codex binary for version and auth probes", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* makeCheckCodexProviderStatus("/custom/bin/codex");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "/custom/bin/codex");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "-c mcp_servers={} login status")
              return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("propagates verbatim Windows arguments through the Effect command", () => {
      const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      return Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* makeCheckCodexProviderStatus("C:\\tools(x86)\\codex.cmd");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer(
            (args, command, _env, options) => {
              assert.strictEqual(command.toLowerCase(), "c:\\windows\\system32\\cmd.exe");
              assert.strictEqual(options?.windowsVerbatimArguments, true);
              const commandLine = args.at(-1) ?? "";
              if (commandLine.includes('"--version"')) {
                return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
              }
              if (commandLine.includes('"-c" "mcp_servers={}" "login" "status"')) {
                return { stdout: "Logged in\n", stderr: "", code: 0 };
              }
              throw new Error(`Unexpected args: ${args.join(" ")}`);
            },
            { rawCommand: true },
          ),
        ),
        Effect.ensuring(Effect.sync(() => platform.mockRestore())),
      );
    });

    it.effect("uses configured codex home for version, config, and auth probes", () => {
      let sawLoginStatusProbe = false;
      let expectedCodexHome: string | undefined;
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { tmpDir, runtimeDir } = yield* withTempCodexHome();
        yield* fileSystem.writeFileString(
          path.join(tmpDir, "config.toml"),
          'model_provider = "portkey"\n',
        );
        const configuredHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "moss-configured-codex-",
        });
        yield* fileSystem.writeFileString(
          path.join(configuredHome, "config.toml"),
          'model_provider = "openai"\n',
        );
        expectedCodexHome = resolveActiveCodexHomeWritePath({
          env: { MOSS_HOME: runtimeDir },
          homePath: configuredHome,
        });

        const status = yield* makeCheckCodexProviderStatus("codex", configuredHome);
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.message, undefined);
        assert.strictEqual(sawLoginStatusProbe, true);
        assert.notStrictEqual(configuredHome, tmpDir);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, _command, env, options) => {
            assert.strictEqual(env?.CODEX_HOME, expectedCodexHome);
            assert.strictEqual(options?.cwd, expectedCodexHome);
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "-c mcp_servers={} login status") {
              sawLoginStatusProbe = true;
              return { stdout: "Logged in\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      );
    });

    it.effect("reports misconfigured account shadow homes as an error status", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { tmpDir } = yield* withTempCodexHome();
        const shadowHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "moss-codex-shadow-",
        });
        yield* fileSystem.writeFileString(path.join(tmpDir, "auth.json"), "{}");
        yield* Effect.sync(() => {
          if (OS.platform() === "win32") {
            // A real directory junction exercises the no-follow rejection without file-link privilege.
            symlinkSync(tmpDir, path.join(shadowHome, "auth.json"), "junction");
            assert.strictEqual(
              readFileSync(path.join(shadowHome, "auth.json", "auth.json"), "utf8"),
              "{}",
            );
          } else {
            symlinkSync(path.join(tmpDir, "auth.json"), path.join(shadowHome, "auth.json"));
          }
        });

        const status = yield* makeCheckCodexProviderStatus("codex", tmpDir, shadowHome, "work");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.match(status.message ?? "", /symlink/);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer(() => {
            throw new Error("no probes should run for a misconfigured account home");
          }),
        ),
      ),
    );

    it.effect("returns unavailable when codex is missing", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.message, "Codex CLI (`codex`) is not installed or not on PATH.");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );

    it.effect("returns unavailable when codex is below the minimum supported version", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI v0.104.0 is too old for Moss. Upgrade to v0.105.0 or newer and restart Moss.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 0.104.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when the Codex version cannot be verified", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.message, CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "codex development build\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("reports Auto unavailable for a supported but older Codex CLI", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.supportsAutoRuntimeMode, false);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 0.123.0\n", stderr: "", code: 0 };
            if (joined === "-c mcp_servers={} login status")
              return { stdout: "Logged in\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth probe reports login required", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Codex CLI is not authenticated. Run `codex login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "-c mcp_servers={} login status") {
              return { stdout: "", stderr: "Not logged in. Run codex login.", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when login status command is unsupported", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome();
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Codex CLI authentication status command is unavailable in this Codex version.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "-c mcp_servers={} login status") {
              return { stdout: "", stderr: "error: unknown command 'login'", code: 2 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── Custom model provider: checkCodexProviderStatus integration ───

  describe("checkCodexProviderStatus with custom model provider", () => {
    it.effect(
      "probes the canonical managed home only with a current server-issued authority",
      () => {
        const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let expectedHome: string | undefined;
        return Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { tmpDir } = yield* withTempCodexHome();
          const stateDir = path.join(tmpDir, "state");
          const homePath = path.join(stateDir, "moss-codex-home");
          expectedHome = homePath;
          yield* fileSystem.makeDirectory(homePath, { recursive: true });
          const nonce = "4495cd76-4720-4f61-8e2a-f0acbd59aee2";
          yield* fileSystem.writeFileString(
            path.join(homePath, ".moss-managed-home"),
            buildMossManagedHomeOwnershipMarker(nonce),
          );
          yield* fileSystem.writeFileString(
            path.join(homePath, "config.toml"),
            'model_provider = "moss"\n',
          );
          const settings = {
            ...DEFAULT_SERVER_SETTINGS,
            providers: {
              ...DEFAULT_SERVER_SETTINGS.providers,
              codex: {
                ...DEFAULT_SERVER_SETTINGS.providers.codex,
                accounts: [{ id: "moss", label: "Moss", homePath, shadowHomePath: "" }],
              },
            },
            providerInstances: {
              codex_moss: {
                driver: "codex" as const,
                enabled: true,
                config: { managed: true, accountId: "moss", homePath, homeOwnershipNonce: nonce },
              },
            },
          };
          const issue = () =>
            readManagedCodexHomeAuthority({
              stateDir,
              readSettings: async () => settings,
              readSettingsSync: () => settings,
              input: { homePath, accountId: "moss", env: process.env },
            });
          const status = yield* makeCheckCodexProviderStatus(
            process.execPath,
            homePath,
            undefined,
            "moss",
            undefined,
            issue,
          );
          assert.strictEqual(status.status, "ready");
          yield* fileSystem.writeFileString(
            path.join(homePath, ".moss-managed-home"),
            "moss-managed-codex-home-v1\n",
          );
          const revoked = yield* makeCheckCodexProviderStatus(
            process.execPath,
            homePath,
            undefined,
            "moss",
            undefined,
            issue,
          );
          assert.strictEqual(revoked.status, "error");
          assert.strictEqual(revoked.available, false);
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, _command, env) => {
              assert.strictEqual(env?.CODEX_HOME, expectedHome);
              assert.strictEqual(args.join(" "), "--version");
              return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            }),
          ),
          Effect.ensuring(Effect.sync(() => platform.mockRestore())),
        );
      },
    );

    it.effect("skips auth probe and returns ready when a custom model provider is configured", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.provider, "codex");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Using a custom Codex model provider; OpenAI login check skipped.",
        );
      }).pipe(
        Effect.provide(
          // The spawner only handles --version; if the test attempts
          // "login status" the throw proves the auth probe was NOT skipped.
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            throw new Error(`Auth probe should have been skipped but got args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("still reports error when codex CLI is missing even with custom provider", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            'model_provider = "portkey"',
            "",
            "[model_providers.portkey]",
            'base_url = "https://api.portkey.ai/v1"',
            'env_key = "PORTKEY_API_KEY"',
          ].join("\n"),
        );
        const status = yield* checkCodexProviderStatus;
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
      }).pipe(Effect.provide(failingSpawnerLayer("spawn codex ENOENT"))),
    );
  });

  describe("checkCodexProviderStatus with openai model provider", () => {
    it.effect("still runs auth probe when model_provider is openai", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome('model_provider = "openai"\n');
        const status = yield* checkCodexProviderStatus;
        // The auth probe runs and sees "not logged in" → error
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "codex 1.0.0\n", stderr: "", code: 0 };
            if (joined === "-c mcp_servers={} login status")
              return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  // ── parseAuthStatusFromOutput pure tests ──────────────────────────

  describe("parseAuthStatusFromOutput", () => {
    it("recognizes the Codex CLI ChatGPT login status on stderr as voice capable", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: "",
        stderr: "Logged in using ChatGPT\n",
        code: 0,
      });
      assert.strictEqual(parsed.authStatus, "authenticated");
      assert.strictEqual(parsed.voiceTranscriptionAvailable, true);
    });

    it("recognizes the Codex CLI API key login status without enabling voice", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: "Logged in using an API key - sk-…\n",
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.authStatus, "authenticated");
      assert.strictEqual(parsed.voiceTranscriptionAvailable, false);
    });

    it("does not infer voice capability from an unknown successful login response", () => {
      const parsed = parseAuthStatusFromOutput({ stdout: "OK\n", stderr: "", code: 0 });
      assert.strictEqual(parsed.voiceTranscriptionAvailable, undefined);
    });

    it("does not enable voice from ChatGPT login text when the command fails", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: "",
        stderr: "Logged in using ChatGPT\n",
        code: 1,
      });
      assert.notStrictEqual(parsed.authStatus, "authenticated");
      assert.notStrictEqual(parsed.voiceTranscriptionAvailable, true);
    });

    it("JSON with authenticated=false is unauthenticated", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"authenticated":false}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "error");
      assert.strictEqual(parsed.authStatus, "unauthenticated");
    });

    it("JSON without auth marker is warning", () => {
      const parsed = parseAuthStatusFromOutput({
        stdout: '[{"ok":true}]\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.authStatus, "unknown");
    });
  });

  // ── readCodexConfigModelProviderForEnv tests ─────────────────────────────

  describe("readCodexConfigModelProviderForEnv", () => {
    it.effect("handles comments and whitespace", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome(
          [
            "# This is a comment",
            "",
            '  model_provider = "azure"  ',
            "",
            "[profiles.deep-review]",
            'model = "gpt-5-pro"',
          ].join("\n"),
        );
        assert.strictEqual(yield* readCodexConfigModelProviderForEnv(process.env), "azure");
      }),
    );

    it.effect("handles single-quoted values in TOML", () =>
      Effect.gen(function* () {
        yield* withTempCodexHome("model_provider = 'mistral'\n");
        assert.strictEqual(yield* readCodexConfigModelProviderForEnv(process.env), "mistral");
      }),
    );
  });

  // ── checkClaudeProviderStatus tests ──────────────────────────

  describe("checkClaudeProviderStatus", () => {
    it.effect("returns ready when claude is installed and authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("fails closed for Auto when the Claude CLI version is unparseable", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.supportsAutoRuntimeMode, false);
        assert.strictEqual(status.autoRuntimeModeBinaryPath, resolveClaudeCodeRuntime().binaryPath);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "Claude Code development build\n", stderr: "", code: 0 };
            }
            if (joined === "auth status") {
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses configured claude binary for version and auth probes", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckClaudeProviderStatus(undefined, "/custom/bin/claude");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.autoRuntimeModeBinaryPath, "/custom/bin/claude");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "/custom/bin/claude");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("passes configured Windows profile HOME and environment to Claude probes", () =>
      withProcessPlatform(
        "win32",
        Effect.gen(function* () {
          const status = yield* makeCheckClaudeProviderStatus(
            undefined,
            "/custom/bin/claude",
            "C:\\Users\\work\\.claude-work",
            undefined,
            { PROVIDER_TEST_INSTANCE: "claude-work" },
          );
          assert.strictEqual(status.status, "ready");
        }),
      ).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/claude");
            assert.strictEqual(env?.HOME, "C:\\Users\\work\\.claude-work");
            assert.strictEqual(env?.USERPROFILE, "C:\\Users\\work\\.claude-work");
            assert.strictEqual(env?.APPDATA, "C:\\Users\\work\\.claude-work\\AppData\\Roaming");
            assert.strictEqual(env?.LOCALAPPDATA, "C:\\Users\\work\\.claude-work\\AppData\\Local");
            assert.strictEqual(env?.HOMEDRIVE, "C:");
            assert.strictEqual(env?.HOMEPATH, "\\Users\\work\\.claude-work");
            assertProviderInstanceEnv(env, "PROVIDER_TEST_INSTANCE", "claude-work");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect(
      "strips stale direct Claude credentials from health probes when local OAuth is usable",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-home-",
          });
          const claudeDir = path.join(homeDir, ".claude");
          yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "local-access-token",
                expiresAt: Date.now() + 60_000,
              },
            }),
          );

          const envKeys = [
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_ANTHROPIC_AWS",
          ] as const;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const previous = new Map<string, string | undefined>();
              for (const key of envKeys) {
                previous.set(key, process.env[key]);
                delete process.env[key];
              }
              process.env.ANTHROPIC_API_KEY = "stale-api-key";
              process.env.ANTHROPIC_AUTH_TOKEN = "stale-auth-token";
              process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth-token";
              return previous;
            }),
            (previous) =>
              Effect.sync(() => {
                for (const [key, value] of previous) {
                  if (value === undefined) {
                    delete process.env[key];
                  } else {
                    process.env[key] = value;
                  }
                }
              }),
          );

          // The program Moss picks for the explicit "claude" selection: a real `claude` on PATH
          // where there is one, otherwise the bundled Claude Agent SDK binary (isolated runs).
          // The spawner reports Windows .cmd/.bat shims by their bare name.
          const selectedClaude = resolveClaudeCodeRuntime({ binaryPath: "claude" }).binaryPath;
          assert.ok(selectedClaude);
          const expectedCommand = /\.(?:cmd|bat)$/iu.test(selectedClaude)
            ? win32.basename(selectedClaude).replace(/\.(?:cmd|bat)$/iu, "")
            : selectedClaude;
          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir).pipe(
            Effect.provide(
              mockSpawnerLayer((args, command, env) => {
                assert.strictEqual(command, expectedCommand);
                assert.strictEqual(env?.ANTHROPIC_API_KEY, undefined);
                assert.strictEqual(env?.ANTHROPIC_AUTH_TOKEN, undefined);
                assert.strictEqual(env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);

                const joined = args.join(" ");
                if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                    stderr: "",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.authStatus, "authenticated");
        }),
    );

    it("builds Claude SDK probe environments in the configured server home", () => {
      const env = makeClaudeProbeEnv(
        "~/.claude-work",
        { PROVIDER_TEST_INSTANCE: "claude-work" },
        "/tmp/moss-test-home",
      );

      assert.strictEqual(env.HOME, join("/tmp/moss-test-home", ".claude-work"));
      assert.strictEqual(env.PROVIDER_TEST_INSTANCE, "claude-work");
    });

    it.effect("scopes environment-only Claude health probes to the selected instance", () => {
      const isolationRootDir = "/tmp/moss-provider-health-state";
      const providerInstanceId = "claude_work" as ProviderInstanceId;
      return makeCheckClaudeProviderStatus(
        undefined,
        "claude",
        undefined,
        {
          providerInstanceId,
          isolationRootDir,
          fallbackHomeDir: "/tmp/server-home",
        },
        { ANTHROPIC_AUTH_TOKEN: "work-token" },
      ).pipe(
        Effect.tap((status) => Effect.sync(() => assert.strictEqual(status.status, "ready"))),
        Effect.provide(
          mockSpawnerLayer((args, _command, env) => {
            const accountHome = claudeIsolatedHomePath({ isolationRootDir, providerInstanceId });
            if (process.platform === "darwin") {
              assert.strictEqual(env?.HOME, "/tmp/server-home");
              assert.strictEqual(env?.CLAUDE_CONFIG_DIR, join(accountHome, ".claude"));
              assert.strictEqual(env?.CLAUDE_SECURESTORAGE_CONFIG_DIR, env?.CLAUDE_CONFIG_DIR);
            } else {
              assert.strictEqual(env?.HOME, accountHome);
            }
            assert.strictEqual(env?.ANTHROPIC_AUTH_TOKEN, "work-token");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "1.0.0\n", stderr: "", code: 0 };
            }
            if (joined === "auth status") {
              return {
                stdout: '{"loggedIn":true,"authMethod":"claude.ai"}\n',
                stderr: "",
                code: 0,
              };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      );
    });

    it.effect("trusts usable Claude OAuth credentials after the SDK probe validates them", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-claude-auth-fallback-",
        });
        const claudeDir = path.join(homeDir, ".claude");
        yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(claudeDir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "expired-access-token",
              refreshToken: "refresh-token",
              expiresAt: Date.now() - 60_000,
              subscriptionType: "max",
            },
          }),
        );

        let sdkProbeCalls = 0;
        const status = yield* makeCheckClaudeProviderStatus(
          Effect.sync(() => {
            sdkProbeCalls += 1;
            return "max";
          }),
          "claude",
          homeDir,
        ).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") {
                return { stdout: "2.1.197\n", stderr: "", code: 0 };
              }
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );

        assert.strictEqual(sdkProbeCalls, 1);
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "max");
        assert.strictEqual(status.authLabel, "Claude Max Subscription");
        assert.strictEqual(status.message, undefined);
      }),
    );

    it.effect("does not trust local Claude OAuth token strings without a live SDK validation", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "provider-health-claude-auth-fallback-no-probe-",
        });
        const claudeDir = path.join(homeDir, ".claude");
        yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(claudeDir, ".credentials.json"),
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "expired-access-token",
              refreshToken: "stale-refresh-token",
              expiresAt: Date.now() - 60_000,
              subscriptionType: "max",
            },
          }),
        );

        const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir).pipe(
          Effect.provide(
            mockSpawnerLayer((args) => {
              const joined = args.join(" ");
              if (joined === "--version") {
                return { stdout: "2.1.197\n", stderr: "", code: 0 };
              }
              if (joined === "auth status")
                return {
                  stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
                  stderr: "",
                  code: 0,
                };
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        );

        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(status.authType, undefined);
        assert.strictEqual(status.authLabel, undefined);
      }),
    );

    it.effect(
      "keeps Claude unauthenticated when auth status includes a textual login failure",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-auth-text-failure-",
          });
          const claudeDir = path.join(homeDir, ".claude");
          yield* fileSystem.makeDirectory(claudeDir, { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(claudeDir, ".credentials.json"),
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "expired-access-token",
                refreshToken: "refresh-token",
                expiresAt: Date.now() - 60_000,
                subscriptionType: "max",
              },
            }),
          );

          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "2.1.197\n", stderr: "", code: 0 };
                }
                if (joined === "auth status")
                  return {
                    stdout: '{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}\n',
                    stderr: "Not logged in. Please run /login.\n",
                    code: 0,
                  };
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.authStatus, "unauthenticated");
          assert.strictEqual(status.authType, undefined);
          assert.strictEqual(status.authLabel, undefined);
          assert.match(status.message ?? "", /not authenticated/i);
        }),
    );

    it.effect(
      "re-probes auth status once when a structured false negative has no credential file to rescue it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-auth-retry-",
          });

          let authStatusCalls = 0;
          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir, {
            falseNegativeRetryDelayMs: 0,
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "2.1.197\n", stderr: "", code: 0 };
                }
                if (joined === "auth status") {
                  authStatusCalls += 1;
                  // First probe loses a refresh-token rotation race; the retry
                  // observes the settled, rotated token.
                  return authStatusCalls === 1
                    ? {
                        stdout: '{"loggedIn":false,"authMethod":"none"}\n',
                        stderr: "",
                        code: 0,
                      }
                    : {
                        stdout:
                          '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}\n',
                        stderr: "",
                        code: 0,
                      };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(authStatusCalls, 2);
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.authStatus, "authenticated");
          assert.strictEqual(status.authType, "max");
        }),
    );

    it.effect(
      "stays unauthenticated when the structured false negative persists across the retry",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const homeDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "provider-health-claude-auth-retry-persist-",
          });

          let authStatusCalls = 0;
          const status = yield* makeCheckClaudeProviderStatus(undefined, "claude", homeDir, {
            falseNegativeRetryDelayMs: 0,
          }).pipe(
            Effect.provide(
              mockSpawnerLayer((args) => {
                const joined = args.join(" ");
                if (joined === "--version") {
                  return { stdout: "2.1.197\n", stderr: "", code: 0 };
                }
                if (joined === "auth status") {
                  authStatusCalls += 1;
                  return {
                    stdout: '{"loggedIn":false,"authMethod":"none"}\n',
                    stderr: "",
                    code: 0,
                  };
                }
                throw new Error(`Unexpected args: ${joined}`);
              }),
            ),
          );

          assert.strictEqual(authStatusCalls, 2);
          assert.strictEqual(status.provider, "claudeAgent");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.authStatus, "unauthenticated");
          assert.match(status.message ?? "", /not authenticated/i);
        }),
    );

    it.effect("returns unavailable when claude is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Claude Agent CLI (`claude`) is not installed or not on PATH.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn claude ENOENT"))),
    );

    it.effect("returns error when version check fails with non-zero exit code", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version")
              return { stdout: "", stderr: "Something went wrong", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when auth status reports not logged in", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Claude is not authenticated. Run `claude auth login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return {
                stdout: '{"loggedIn":false}\n',
                stderr: "",
                code: 1,
              };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when output includes 'not logged in'", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status") return { stdout: "Not logged in\n", stderr: "", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when auth status command is unsupported", () =>
      Effect.gen(function* () {
        const status = yield* checkClaudeProviderStatus;
        assert.strictEqual(status.provider, "claudeAgent");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Claude Agent authentication status command is unavailable in this version of Claude.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "1.0.0\n", stderr: "", code: 0 };
            if (joined === "auth status")
              return { stdout: "", stderr: "error: unknown command 'auth'", code: 2 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("checkAntigravityProviderStatus", () => {
    it.effect("passes configured instance environment to the Antigravity version probe", () =>
      Effect.gen(function* () {
        const status = yield* checkAntigravityProviderStatus("/custom/bin/agy", {
          PROVIDER_TEST_INSTANCE: "antigravity-work",
        });
        assert.strictEqual(status.provider, "antigravity");
        assert.strictEqual(status.status, "error");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/agy");
            assertProviderInstanceEnv(env, "PROVIDER_TEST_INSTANCE", "antigravity-work");
            assert.strictEqual(env?.NO_BROWSER, "true");
            assert.strictEqual(env?.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "", stderr: "version failed", code: 1 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("checkOpenCodeProviderStatus", () => {
    it.effect("returns ready when opencode is installed", () =>
      Effect.gen(function* () {
        const status = yield* checkOpenCodeProviderStatus;
        assert.strictEqual(status.provider, "opencode");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "opencode 1.3.17\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("expands a tilde opencode binary path for the version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckOpenCodeProviderStatus("~/bin/opencode");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, join(OS.homedir(), "bin/opencode"));
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "opencode 1.3.17\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("passes configured instance environment to the OpenCode version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckOpenCodeProviderStatus("/custom/bin/opencode", {
          PROVIDER_TEST_INSTANCE: "opencode-work",
        });
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/opencode");
            assertProviderInstanceEnv(env, "PROVIDER_TEST_INSTANCE", "opencode-work");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "opencode 1.3.17\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("accepts a configured external OpenCode server without probing the CLI", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckOpenCodeProviderStatus(undefined, undefined, {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "secret",
          experimentalWebSockets: true,
        });
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authType, "serverPassword");
        assert.match(status.message ?? "", /experimental WebSockets enabled/);
      }).pipe(Effect.provide(failingSpawnerLayer("OpenCode CLI must not be probed"))),
    );

    it.effect("returns unavailable when opencode is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkOpenCodeProviderStatus;
        assert.strictEqual(status.provider, "opencode");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "OpenCode CLI (`opencode`) is not installed or not on PATH. Install it with `npm install -g opencode-ai`.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn opencode ENOENT"))),
    );
  });

  describe("checkPiProviderStatus", () => {
    it.effect("allows a cold Pi CLI to finish its first version probe", () =>
      Effect.gen(function* () {
        const probe = yield* checkPiProviderStatus().pipe(
          Effect.provide(
            Layer.succeed(
              ChildProcessSpawner.ChildProcessSpawner,
              ChildProcessSpawner.make(() =>
                Effect.succeed(
                  mockHandle(
                    { stdout: "pi 1.5.0\n", stderr: "", code: 0 },
                    {
                      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)).pipe(
                        Effect.delay(Duration.seconds(12)),
                      ),
                    },
                  ),
                ),
              ),
            ),
          ),
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(12));
        const status = yield* Fiber.join(probe);
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.version, "1.5.0");
      }),
    );

    it.effect("keeps the first Pi CLI probe bounded when it never finishes", () =>
      Effect.gen(function* () {
        const probe = yield* checkPiProviderStatus().pipe(
          Effect.provide(hangingSpawnerLayer({ shouldHang: () => true, onKill: () => {} })),
          Effect.forkChild,
        );
        yield* TestClock.adjust(Duration.seconds(20));
        const status = yield* Fiber.join(probe);
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.match(status.message ?? "", /health check timed out/);
      }),
    );

    it.effect("returns ready using only the Pi CLI version probe", () =>
      Effect.gen(function* () {
        const status = yield* checkPiProviderStatus();
        assert.strictEqual(status.provider, "pi");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Pi CLI is installed. Configure provider credentials inside Pi as needed.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(win32.basename(command).replace(/\.exe$/iu, ""), "pi");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "pi 1.5.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses the configured Pi binary and agent dir", () =>
      Effect.gen(function* () {
        const status = yield* checkPiProviderStatus("/tmp/pi-agent", "/custom/bin/pi");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(
          status.message,
          "Pi CLI is installed. Moss will use Pi agent dir /tmp/pi-agent.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "/custom/bin/pi");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "pi 1.5.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("passes configured instance environment to the Pi version probe", () =>
      Effect.gen(function* () {
        const status = yield* checkPiProviderStatus("/tmp/pi-agent", "/custom/bin/pi", {
          PROVIDER_TEST_INSTANCE: "pi-work",
        });
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/pi");
            assertProviderInstanceEnv(env, "PROVIDER_TEST_INSTANCE", "pi-work");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "pi 1.5.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("asks for an update when the Pi CLI is older than Moss supports", () =>
      Effect.gen(function* () {
        const status = yield* checkPiProviderStatus();
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.version, "0.87.1");
        assert.strictEqual(
          status.message,
          "Pi CLI 0.87.1 is too old for Moss. Upgrade to 1.5.0 or newer.",
        );
      }).pipe(
        Effect.provide(mockSpawnerLayer(() => ({ stdout: "pi 0.87.1\n", stderr: "", code: 0 }))),
      ),
    );

    it.effect(
      "offers the Pi install when there is no Pi CLI, because Moss runs the person's Pi",
      () =>
        Effect.gen(function* () {
          const status = yield* checkPiProviderStatus();
          assert.strictEqual(status.provider, "pi");
          assert.strictEqual(status.status, "error");
          assert.strictEqual(status.available, false);
          assert.deepStrictEqual(status.readiness, PROVIDER_NOT_INSTALLED_READINESS);
          assert.strictEqual(
            status.message,
            "Pi CLI (`pi`) is not on PATH. Install it to use the Pi provider.",
          );
        }).pipe(Effect.provide(failingSpawnerLayer("spawn pi ENOENT"))),
    );
  });

  describe("checkOmpProviderStatus", () => {
    it.effect("probes the selected instance environment instead of ambient OMP", () => {
      const isolationRoot = mkdtempSync(join(OS.tmpdir(), "synara-omp-health-"));
      const binaryDir = join(isolationRoot, "bin");
      mkdirSync(binaryDir, { recursive: true });
      const binaryPath = join(binaryDir, OS.platform() === "win32" ? "omp.exe" : "omp");
      writeFileSync(binaryPath, OS.platform() === "win32" ? "" : "#!/bin/sh\n");
      if (OS.platform() !== "win32") chmodSync(binaryPath, 0o755);
      return Effect.gen(function* () {
        try {
          const status = yield* checkOmpProviderStatus(
            "/tmp/omp-agent",
            undefined,
            { PATH: binaryDir, PROVIDER_TEST_INSTANCE: "omp-work" },
            "omp_work",
            { homeDir: OS.homedir(), isolationRootDir: isolationRoot },
          );
          assert.strictEqual(status.provider, "omp");
          assert.strictEqual(status.status, "ready");
          assert.strictEqual(status.available, true);
        } finally {
          rmSync(isolationRoot, { recursive: true, force: true });
        }
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(
              OS.platform() === "win32" ? command.toLowerCase() : command,
              OS.platform() === "win32" ? binaryPath.toLowerCase() : binaryPath,
            );
            assertProviderInstanceEnv(env, "PATH", binaryDir);
            assertProviderInstanceEnv(env, "PROVIDER_TEST_INSTANCE", "omp-work");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "omp 0.5.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      );
    });
  });

  describe("checkAcpAgentProviderStatus", () => {
    it.effect("reports the installed CLI version with its sign-in hint", () =>
      Effect.gen(function* () {
        const status = yield* checkAcpAgentProviderStatus(KIMI_ACP_AGENT_SPEC, undefined, {
          KIMI_SHELL_PATH: process.execPath,
        });
        assert.strictEqual(status.provider, "kimi");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.version, "2.4.0");
        assert.include(status.message, "kimi login");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "kimi");
            assert.deepStrictEqual(args, ["--version"]);
            return { stdout: "2.4.0\n", stderr: "", code: 0 };
          }),
        ),
      ),
    );

    it.effect("probes the configured ZCode bridge binary and parses its version", () =>
      Effect.gen(function* () {
        const status = yield* checkAcpAgentProviderStatus(
          ZCODE_ACP_AGENT_SPEC,
          "/opt/zcode-acp/dist/cli.js",
          { ZCODE_BIN: process.execPath },
        );
        assert.strictEqual(status.provider, "zcode");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.version, "0.80.0");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/opt/zcode-acp/dist/cli.js");
            assert.deepStrictEqual(args, ["--version"]);
            assertProviderInstanceEnv(env, "ZCODE_BIN", process.execPath);
            return { stdout: "0.80.0\n", stderr: "", code: 0 };
          }),
        ),
      ),
    );

    it.effect("is not ready when the bridge is installed but the ZCode CLI is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkAcpAgentProviderStatus(ZCODE_ACP_AGENT_SPEC, undefined, {
          ZCODE_BIN: join(OS.tmpdir(), "moss-health-no-such-zcode.cjs"),
        });
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.version, "0.80.0");
        assert.include(status.message, "Install the ZCode desktop app");
      }).pipe(
        Effect.provide(mockSpawnerLayer(() => ({ stdout: "0.80.0\n", stderr: "", code: 0 }))),
      ),
    );

    it.effect("authenticates only the reserved instance carrying a verified managed catalog", () =>
      Effect.gen(function* () {
        const gateway = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
        vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gateway);
        const instance = buildMossManagedAcpAgentProviderInstance(KIMI_ACP_AGENT_SPEC, {
          accessToken: "managed-token",
          gatewayBaseUrl: gateway,
          runtimeGeneration: "generation",
          homePath: join(OS.tmpdir(), "moss-health", "provider-homes", "kimi", "cn"),
          realm: "cn",
        });
        const environment = Object.fromEntries(
          instance.environment.map((entry) => [entry.name, entry.value]),
        );
        // The mocked probe never starts a shell; do not depend on a host Git install.
        environment.KIMI_SHELL_PATH = process.execPath;
        const managed = yield* checkAcpAgentProviderStatus(
          KIMI_ACP_AGENT_SPEC,
          undefined,
          environment,
          "kimi_moss",
        );
        assert.strictEqual(managed.status, "ready");
        assert.strictEqual(managed.authStatus, "authenticated");
        assert.include(managed.message, "Moss managed gateway");
        const personal = yield* checkAcpAgentProviderStatus(
          KIMI_ACP_AGENT_SPEC,
          undefined,
          environment,
          "kimi",
        );
        assert.strictEqual(personal.authStatus, "unknown");
        const untrusted = yield* checkAcpAgentProviderStatus(
          KIMI_ACP_AGENT_SPEC,
          undefined,
          { ...environment, MOSS_ACCESS_TOKEN: "" },
          "kimi_moss",
        );
        assert.strictEqual(untrusted.authStatus, "unknown");
      }).pipe(
        Effect.ensuring(Effect.sync(() => vi.unstubAllEnvs())),
        Effect.provide(mockSpawnerLayer(() => ({ stdout: "2.4.0\n", stderr: "", code: 0 }))),
      ),
    );

    it.effect("names the npm package when the CLI is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkAcpAgentProviderStatus(MINIMAX_ACP_AGENT_SPEC);
        assert.strictEqual(status.provider, "minimax");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.include(status.message, "`mcode`");
        assert.include(status.message, "@minimax-ai/code");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn mcode ENOENT"))),
    );
  });

  describe("checkAntigravityProviderStatus", () => {
    it.effect("rejects versions that predate --new-project support", () =>
      Effect.gen(function* () {
        const status = yield* checkAntigravityProviderStatus();
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.version, "1.0.11");
        assert.strictEqual(
          status.message,
          "Antigravity CLI 1.0.11 is too old for Moss. Upgrade to 1.0.12 or newer.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "Antigravity CLI 1.0.11\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns ready when Antigravity lists authenticated models", () =>
      Effect.gen(function* () {
        const status = yield* checkAntigravityProviderStatus();
        assert.strictEqual(status.provider, "antigravity");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.version, "1.1.2");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "agy");
            assert.strictEqual(env?.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "Antigravity CLI 1.1.2\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return {
                stdout: "Gemini 3.5 Flash (Medium)\nClaude Sonnet 4.6 (Thinking)\n",
                stderr: "",
                code: 0,
              };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses the configured Antigravity binary", () =>
      Effect.gen(function* () {
        const status = yield* checkAntigravityProviderStatus("/custom/bin/agy");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/agy");
            assert.strictEqual(env?.AGY_CLI_DISABLE_AUTO_UPDATE, "true");
            return args.join(" ") === "--version"
              ? { stdout: "1.1.2\n", stderr: "", code: 0 }
              : { stdout: "GPT-OSS 120B (Medium)\n", stderr: "", code: 0 };
          }),
        ),
      ),
    );
  });

  describe("checkGrokProviderStatus", () => {
    it.effect("reports Grok not signed in when it has no API key or cached login", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_CODE_XAI_API_KEY;
      return Effect.gen(function* () {
        const status = yield* makeCheckGrokProviderStatus(
          undefined,
          undefined,
          undefined,
          undefined,
          async () => null,
        );
        assert.strictEqual(status.provider, "grok");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(status.version, "0.1.0");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) {
              delete process.env.XAI_API_KEY;
            } else {
              process.env.XAI_API_KEY = previousXaiApiKey;
            }
            if (previousApiKey === undefined) {
              delete process.env.GROK_CODE_XAI_API_KEY;
            } else {
              process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
            }
          }),
        ),
      );
    });

    it.effect("treats a Moss-managed Grok as signed in without a personal login", () =>
      Effect.gen(function* () {
        let lookedUpPersonalLogin = false;
        const status = yield* makeCheckGrokProviderStatus(
          undefined,
          { MOSS_GROK_CONFIG_CONTENT: "{}" },
          "grok_moss",
          { homeDir: OS.tmpdir(), isolationRootDir: OS.tmpdir() },
          async () => {
            lookedUpPersonalLogin = true;
            return null;
          },
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(lookedUpPersonalLogin, false);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) =>
            args.join(" ") === "--version"
              ? { stdout: "grok 0.1.0\n", stderr: "", code: 0 }
              : { stdout: "", stderr: `Unexpected args: ${args.join(" ")}`, code: 1 },
          ),
        ),
      ),
    );

    it.effect("marks Grok authenticated when XAI_API_KEY is present", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;
      process.env.XAI_API_KEY = "xai-test-key";
      delete process.env.GROK_CODE_XAI_API_KEY;
      return Effect.gen(function* () {
        const status = yield* checkGrokProviderStatus;
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "apiKey");
        assert.strictEqual(status.authLabel, "xAI API Key");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) {
              delete process.env.XAI_API_KEY;
            } else {
              process.env.XAI_API_KEY = previousXaiApiKey;
            }
            if (previousApiKey === undefined) {
              delete process.env.GROK_CODE_XAI_API_KEY;
            } else {
              process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
            }
          }),
        ),
      );
    });

    it.effect("marks Grok authenticated from a cached grok login", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_CODE_XAI_API_KEY;
      return Effect.gen(function* () {
        const status = yield* makeCheckGrokProviderStatus(
          undefined,
          undefined,
          undefined,
          undefined,
          async () => ({
            accessToken: "cached-token",
          }),
        );
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "grokLogin");
        assert.strictEqual(status.authLabel, "Grok Account");
        assert.strictEqual(status.message, undefined);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) {
              delete process.env.XAI_API_KEY;
            } else {
              process.env.XAI_API_KEY = previousXaiApiKey;
            }
            if (previousApiKey === undefined) {
              delete process.env.GROK_CODE_XAI_API_KEY;
            } else {
              process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
            }
          }),
        ),
      );
    });

    it.effect("uses configured Grok binary for version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckGrokProviderStatus(
          "/custom/bin/grok",
          undefined,
          undefined,
          undefined,
          async () => ({ accessToken: "cached-token" }),
        );
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "/custom/bin/grok");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("passes the isolated Grok account environment to cached-login lookup", () =>
      Effect.gen(function* () {
        let cachedLoginHome: string | undefined;
        const status = yield* makeCheckGrokProviderStatus(
          undefined,
          undefined,
          "grok_work",
          { homeDir: OS.tmpdir(), isolationRootDir: OS.tmpdir() },
          async (env) => {
            cachedLoginHome = env?.GROK_HOME;
            return null;
          },
        );
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.ok(cachedLoginHome?.includes("provider-homes"));
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) =>
            args.join(" ") === "--version"
              ? { stdout: "grok 0.1.0\n", stderr: "", code: 0 }
              : { stdout: "", stderr: "", code: 1 },
          ),
        ),
      ),
    );

    it.effect("isolates Grok cached logins by account home", () => {
      const testRoot = mkdtempSync(join(OS.tmpdir(), "moss-grok-health-"));
      const ambientHome = join(testRoot, "ambient");
      const workHome = join(
        providerIsolatedHomePath({
          driver: "grok",
          instanceId: "grok_work",
          homeDir: testRoot,
          isolationRootDir: testRoot,
        }),
        ".grok",
      );
      mkdirSync(ambientHome, { recursive: true });
      mkdirSync(workHome, { recursive: true });
      writeFileSync(
        join(ambientHome, "auth.json"),
        JSON.stringify({ "https://grok.com": { key: "ambient-token" } }),
        "utf8",
      );
      const previousEnv = {
        GROK_HOME: process.env.GROK_HOME,
        GROK_AUTH_PATH: process.env.GROK_AUTH_PATH,
        XAI_API_KEY: process.env.XAI_API_KEY,
        GROK_CODE_XAI_API_KEY: process.env.GROK_CODE_XAI_API_KEY,
        GROK_OAUTH_TOKEN: process.env.GROK_OAUTH_TOKEN,
      };
      process.env.GROK_HOME = ambientHome;
      delete process.env.GROK_AUTH_PATH;
      delete process.env.XAI_API_KEY;
      delete process.env.GROK_CODE_XAI_API_KEY;
      delete process.env.GROK_OAUTH_TOKEN;
      const restoreEnv = () => {
        for (const [name, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
        rmSync(testRoot, { recursive: true, force: true });
      };

      return Effect.gen(function* () {
        const workWithoutLogin = yield* makeCheckGrokProviderStatus(
          "/custom/bin/grok",
          undefined,
          "grok_work",
          { homeDir: testRoot, isolationRootDir: testRoot },
        );
        const personalWithLogin = yield* makeCheckGrokProviderStatus(
          "/custom/bin/grok",
          undefined,
          "grok",
        );
        assert.strictEqual(workWithoutLogin.authStatus, "unauthenticated");
        assert.strictEqual(personalWithLogin.authStatus, "authenticated");

        writeFileSync(
          join(workHome, "auth.json"),
          JSON.stringify({ "https://grok.com": { key: "work-token" } }),
          "utf8",
        );
        writeFileSync(join(ambientHome, "auth.json"), "{}", "utf8");
        const workWithLogin = yield* makeCheckGrokProviderStatus(
          "/custom/bin/grok",
          undefined,
          "grok_work",
          { homeDir: testRoot, isolationRootDir: testRoot },
        );
        const personalWithoutLogin = yield* makeCheckGrokProviderStatus(
          "/custom/bin/grok",
          undefined,
          "grok",
        );
        assert.strictEqual(workWithLogin.authStatus, "authenticated");
        assert.strictEqual(workWithLogin.authType, "grokLogin");
        assert.strictEqual(personalWithoutLogin.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            if (args.join(" ") === "--version") {
              return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${args.join(" ")}`);
          }),
        ),
        Effect.ensuring(Effect.sync(restoreEnv)),
      );
    });

    it.effect("treats a non-default Grok instance as an empty credential boundary", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = "ambient-account-a";
      return Effect.gen(function* () {
        const status = yield* makeCheckGrokProviderStatus(
          "/custom/bin/grok",
          undefined,
          "grok_work",
        );
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/grok");
            assert.strictEqual(env?.XAI_API_KEY, undefined);
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) delete process.env.XAI_API_KEY;
            else process.env.XAI_API_KEY = previousXaiApiKey;
          }),
        ),
      );
    });

    it.effect("honors an explicit empty environment on the default Grok probe", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      process.env.XAI_API_KEY = "ambient-account-a";
      return Effect.gen(function* () {
        const status = yield* makeCheckGrokProviderStatus("/custom/bin/grok", {}, "grok");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/grok");
            assert.strictEqual(env?.XAI_API_KEY, undefined);
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) delete process.env.XAI_API_KEY;
            else process.env.XAI_API_KEY = previousXaiApiKey;
          }),
        ),
      );
    });

    it.effect("isolates configured Grok credentials from ambient aliases", () => {
      const previousXaiApiKey = process.env.XAI_API_KEY;
      const previousApiKey = process.env.GROK_CODE_XAI_API_KEY;
      process.env.XAI_API_KEY = "ambient-account-a";
      delete process.env.GROK_CODE_XAI_API_KEY;
      return Effect.gen(function* () {
        const status = yield* makeCheckGrokProviderStatus(
          "/custom/bin/grok",
          {
            GROK_CODE_XAI_API_KEY: "selected-account-b",
            PROVIDER_TEST_INSTANCE: "grok-work",
          },
          "grok_work",
        );
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "apiKey");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "/custom/bin/grok");
            assertProviderInstanceEnv(env, "PROVIDER_TEST_INSTANCE", "grok-work");
            assert.strictEqual(env?.XAI_API_KEY, undefined);
            assertProviderInstanceEnv(env, "GROK_CODE_XAI_API_KEY", "selected-account-b");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "grok 0.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousXaiApiKey === undefined) {
              delete process.env.XAI_API_KEY;
            } else {
              process.env.XAI_API_KEY = previousXaiApiKey;
            }
            if (previousApiKey === undefined) {
              delete process.env.GROK_CODE_XAI_API_KEY;
            } else {
              process.env.GROK_CODE_XAI_API_KEY = previousApiKey;
            }
          }),
        ),
      );
    });

    it.effect("returns unavailable when Grok CLI is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkGrokProviderStatus;
        assert.strictEqual(status.provider, "grok");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.include(status.message, "Grok CLI (`grok`) is not installed or not on PATH.");
        assert.include(status.message, "docs.x.ai/build/overview");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn grok ENOENT"))),
    );
  });

  describe("checkDevinProviderStatus", () => {
    it.effect("returns ready and authenticated when WINDSURF_API_KEY is present", () => {
      const previousWindsurfKey = process.env.WINDSURF_API_KEY;
      const previousDevinKey = process.env.DEVIN_API_KEY;
      process.env.WINDSURF_API_KEY = "windsurf-test-key";
      delete process.env.DEVIN_API_KEY;
      return Effect.gen(function* () {
        const status = yield* checkDevinProviderStatus;
        assert.strictEqual(status.provider, "devin");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "apiKey");
        assert.strictEqual(status.authLabel, "Devin API Key");
        assert.strictEqual(status.version, "2.0.0");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "devin 2.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousWindsurfKey === undefined) {
              delete process.env.WINDSURF_API_KEY;
            } else {
              process.env.WINDSURF_API_KEY = previousWindsurfKey;
            }
            if (previousDevinKey === undefined) {
              delete process.env.DEVIN_API_KEY;
            } else {
              process.env.DEVIN_API_KEY = previousDevinKey;
            }
          }),
        ),
      );
    });

    it.effect("returns ready with auth guidance when no Devin API key is set", () => {
      const previousWindsurfKey = process.env.WINDSURF_API_KEY;
      const previousDevinKey = process.env.DEVIN_API_KEY;
      delete process.env.WINDSURF_API_KEY;
      delete process.env.DEVIN_API_KEY;
      return Effect.gen(function* () {
        // Stub the credential read so a real `devin auth login` on the host
        // cannot leak an "authenticated" result into this test.
        const status = yield* makeCheckDevinProviderStatus(undefined, async () => undefined);
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unknown");
        assert.match(status.message ?? "", /devin auth login|WINDSURF_API_KEY/u);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "devin 2.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previousWindsurfKey === undefined) {
              delete process.env.WINDSURF_API_KEY;
            } else {
              process.env.WINDSURF_API_KEY = previousWindsurfKey;
            }
            if (previousDevinKey === undefined) {
              delete process.env.DEVIN_API_KEY;
            } else {
              process.env.DEVIN_API_KEY = previousDevinKey;
            }
          }),
        ),
      );
    });

    it.effect("recognizes credentials saved by devin auth login", () => {
      let credentialsRead = false;
      return Effect.gen(function* () {
        const status = yield* makeCheckDevinProviderStatus(undefined, async () => {
          credentialsRead = true;
          return { apiKey: "stored-test-key" };
        });
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(status.authType, "apiKey");
        assert.strictEqual(credentialsRead, true);
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args) => {
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "devin 2.0.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      );
    });

    it.effect("returns unavailable when Devin CLI is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkDevinProviderStatus;
        assert.strictEqual(status.provider, "devin");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(status.message, "Devin CLI (`devin`) is not installed or not on PATH.");
      }).pipe(Effect.provide(failingSpawnerLayer("spawn devin ENOENT"))),
    );

    it.effect("uses the configured Devin binary for the version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckDevinProviderStatus("/custom/bin/devin");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "/custom/bin/devin");
            const joined = args.join(" ");
            if (joined === "--version") return { stdout: "devin 2.1.0\n", stderr: "", code: 0 };
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );
  });

  describe("checkCursorProviderStatus", () => {
    it.effect("returns ready when Cursor Agent is authenticated and has models", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "ready");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command, env) => {
            assert.strictEqual(command, "cursor-agent");
            assert.strictEqual(env?.NO_BROWSER, "true");
            assert.strictEqual(env?.BROWSER, "www-browser");
            assert.strictEqual(env?.CI, "true");
            assert.strictEqual(env?.DEBIAN_FRONTEND, "noninteractive");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("maps the old ambiguous agent default to cursor-agent", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckCursorProviderStatus("agent");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("uses configured Cursor Agent binary for version probe", () =>
      Effect.gen(function* () {
        const status = yield* makeCheckCursorProviderStatus("/custom/bin/agent");
        assert.strictEqual(status.status, "ready");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "/custom/bin/agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect(
      "falls back through configured Cursor editors when no agent command is resolved",
      () =>
        Effect.gen(function* () {
          const originalPath = process.env.PATH;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              process.env.PATH = "";
            }),
            () =>
              Effect.sync(() => {
                if (originalPath !== undefined) {
                  process.env.PATH = originalPath;
                } else {
                  delete process.env.PATH;
                }
              }),
          );
          const status = yield* makeCheckCursorProviderStatus("/custom/bin/cursor");
          assert.strictEqual(status.status, "ready");
        }).pipe(
          Effect.provide(
            mockSpawnerLayer((args, command) => {
              assert.strictEqual(command, "/custom/bin/cursor");
              const joined = args.join(" ");
              if (joined === "agent --version") {
                return { stdout: "cursor 2026.04.27\n", stderr: "", code: 0 };
              }
              if (joined === "agent status") {
                return { stdout: "Logged in as user@example.com\n", stderr: "", code: 0 };
              }
              if (joined === "agent models") {
                return { stdout: "gpt-5 - GPT-5\n", stderr: "", code: 0 };
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
    );

    it.effect("returns unavailable when Cursor Agent is missing", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Cursor Agent CLI (`cursor-agent`) is not installed or not on PATH.",
        );
      }).pipe(Effect.provide(failingSpawnerLayer("spawn cursor-agent ENOENT"))),
    );

    it.effect("returns unavailable when Cursor Agent exits with an error", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "unknown");
        assert.strictEqual(
          status.message,
          "Cursor Agent CLI is installed but failed to run. version failed",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "", stderr: "version failed\n", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when Cursor Agent status requires login", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
        assert.strictEqual(
          status.message,
          "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return {
                stdout: "",
                stderr:
                  "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n",
                code: 1,
              };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unauthenticated when Cursor Agent says not authenticated", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "unauthenticated");
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Not authenticated\n", stderr: "", code: 1 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns unavailable when Cursor Agent has no account models", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "error");
        assert.strictEqual(status.available, false);
        assert.strictEqual(status.authStatus, "authenticated");
        assert.strictEqual(
          status.message,
          "Cursor Agent is authenticated, but it reports no models available for this account.",
        );
      }).pipe(
        Effect.provide(
          mockSpawnerLayer((args, command) => {
            assert.strictEqual(command, "cursor-agent");
            const joined = args.join(" ");
            if (joined === "--version") {
              return { stdout: "agent 2026.04.27\n", stderr: "", code: 0 };
            }
            if (joined === "status") {
              return { stdout: "Logged in (unable to fetch user details)\n", stderr: "", code: 0 };
            }
            if (joined === "models") {
              return { stdout: "No models available for this account.\n", stderr: "", code: 0 };
            }
            throw new Error(`Unexpected args: ${joined}`);
          }),
        ),
      ),
    );

    it.effect("returns warning when Cursor Agent model discovery fails to spawn", () =>
      Effect.gen(function* () {
        const status = yield* checkCursorProviderStatus;
        assert.strictEqual(status.provider, "cursor");
        assert.strictEqual(status.status, "warning");
        assert.strictEqual(status.available, true);
        assert.strictEqual(status.authStatus, "authenticated");
      }).pipe(
        Effect.provide(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const cmd = command as unknown as {
                command: string;
                args: ReadonlyArray<string>;
              };
              assert.strictEqual(cmd.command, "cursor-agent");
              const joined = cmd.args.join(" ");
              if (joined === "--version") {
                return Effect.succeed(
                  mockHandle({ stdout: "agent 2026.04.27\n", stderr: "", code: 0 }),
                );
              }
              if (joined === "status") {
                return Effect.succeed(
                  mockHandle({ stdout: "Logged in as user@example.com\n", stderr: "", code: 0 }),
                );
              }
              if (joined === "models") {
                return Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "spawn",
                    description: "models probe failed",
                  }),
                );
              }
              throw new Error(`Unexpected args: ${joined}`);
            }),
          ),
        ),
      ),
    );
  });

  // ── parseClaudeAuthStatusFromOutput pure tests ────────────────────

  describe("parseClaudeAuthStatusFromOutput", () => {
    it("JSON without auth marker is warning", () => {
      const parsed = parseClaudeAuthStatusFromOutput({
        stdout: '{"ok":true}\n',
        stderr: "",
        code: 0,
      });
      assert.strictEqual(parsed.status, "warning");
      assert.strictEqual(parsed.authStatus, "unknown");
    });
  });
});
