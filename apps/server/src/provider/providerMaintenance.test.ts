import { describe, it, assert } from "@effect/vitest";
import { join, win32 } from "node:path";

import { Effect, FileSystem } from "effect";
import { TestClock } from "effect/testing";

import {
  createProviderVersionAdvisory,
  deriveNpmGlobalPrefix,
  makeProviderMaintenanceCapabilities,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  withOpenCodeMaintenanceVersion,
  type PackageManagedProviderMaintenanceDefinition,
} from "./providerMaintenance";

const CODEX_DEFINITION = {
  provider: "codex",
  binaryName: "codex",
  npmPackageName: "@openai/codex",
  homebrew: { name: "codex", kind: "cask" },
  nativeUpdate: null,
} as const satisfies PackageManagedProviderMaintenanceDefinition;

const OPENCODE_DEFINITION = {
  provider: "opencode",
  binaryName: "opencode",
  npmPackageName: "opencode-ai",
  homebrew: { name: "anomalyco/tap/opencode", kind: "formula" },
  latestVersionSource: { kind: "npm", name: "opencode-ai" },
  nativeUpdate: {
    executable: "opencode",
    args: (installSource) =>
      installSource === "unknown" || installSource === "native"
        ? ["upgrade"]
        : ["upgrade", "--method", installSource],
    lockKey: "opencode-native",
    strategy: "always",
    excludedInstallSources: ["homebrew"],
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;

it("keeps OpenCode V2 package updates on the V2 distribution", () => {
  const definition = withOpenCodeMaintenanceVersion(OPENCODE_DEFINITION, "2.0.25");
  const brew = resolvePackageManagedProviderMaintenance(definition, {
    binaryPath: "opencode",
    realCommandPath: "/opt/homebrew/Cellar/opencode-v2/2.0.25/bin/opencode",
  });
  assert.deepStrictEqual(brew.update?.args, ["upgrade", "anomalyco/tap/opencode-v2"]);
  assert.deepStrictEqual(brew.latestVersionSource, { kind: "npm", name: "@opencode/cli" });
  const npm = resolvePackageManagedProviderMaintenance(definition, {
    binaryPath: "opencode",
    realCommandPath: "/usr/local/lib/node_modules/@opencode/cli/bin/opencode",
  });
  assert.deepStrictEqual(npm.update?.args, ["upgrade", "--method", "npm"]);
  assert.equal(npm.packageName, "@opencode/cli");
  assert.equal(withOpenCodeMaintenanceVersion(OPENCODE_DEFINITION, "1.18.35"), OPENCODE_DEFINITION);
});

const CLAUDE_DEFINITION = {
  provider: "claudeAgent",
  binaryName: "claude",
  npmPackageName: "@anthropic-ai/claude-code",
  homebrew: {
    name: "claude-code",
    kind: "cask",
    variants: [
      {
        name: "claude-code@latest",
        kind: "cask",
        isCommandPath: (commandPath: string) =>
          commandPath.toLowerCase().includes("/caskroom/claude-code@latest/"),
      },
    ],
  },
  nativeUpdate: {
    executable: "claude",
    args: () => ["update"],
    lockKey: "claude-native",
    strategy: "matching-path",
    latestVersionSource: null,
    isCommandPath: (commandPath: string) =>
      commandPath.toLowerCase().includes("/.local/share/claude/"),
  },
} as const satisfies PackageManagedProviderMaintenanceDefinition;

/** The trailing name of a probed path, whichever separator the host joined it with. */
function fileNameOf(probedPath: string): string {
  return probedPath.slice(Math.max(probedPath.lastIndexOf("/"), probedPath.lastIndexOf("\\")) + 1);
}

describe("providerMaintenance", () => {
  it("pins the npm global prefix that owns the detected binary", () => {
    // npm's global prefix follows the node that runs it, so without --prefix a
    // second node install (e.g. nvm) would receive the update while Moss
    // keeps checking the copy it originally detected.
    assert.strictEqual(
      deriveNpmGlobalPrefix("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js"),
      "/opt/homebrew",
    );
    assert.strictEqual(
      deriveNpmGlobalPrefix(
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
      ),
      "C:\\Users\\Test User\\AppData\\Roaming\\npm",
    );
    // Project-local node_modules paths are not global installs; no prefix.
    assert.strictEqual(deriveNpmGlobalPrefix("/repo/node_modules/.bin/codex"), null);
  });

  it("quotes update command arguments containing spaces", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "codex",
      realCommandPath:
        "C:\\Users\\Test User\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
    });

    assert.strictEqual(
      capabilities.update?.command,
      'npm install -g --prefix "C:\\Users\\Test User\\AppData\\Roaming\\npm" @openai/codex@latest',
    );
  });

  it("keeps a package's extra npm install flags on in-app updates", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(
      {
        provider: "minimax",
        binaryName: "mcode",
        npmPackageName: "@minimax-ai/code",
        npmInstallArgs: ["--allow-scripts=@minimax-ai/code,better-sqlite3"],
        homebrew: null,
        nativeUpdate: null,
      },
      {
        binaryPath: "mcode",
        realCommandPath: "/usr/local/lib/node_modules/@minimax-ai/code/cli.js",
      },
    );

    assert.deepStrictEqual(capabilities.update?.args, [
      "install",
      "-g",
      "--prefix",
      "/usr/local",
      "--allow-scripts=@minimax-ai/code,better-sqlite3",
      "@minimax-ai/code@latest",
    ]);
  });

  it("does not guess an update command for unclassified binaries", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "/custom/bin/codex",
      realCommandPath: "/custom/bin/codex",
    });

    assert.strictEqual(capabilities.update, null);
  });

  it("resolves Homebrew cask update commands", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "/opt/homebrew/bin/codex",
      realCommandPath: "/opt/homebrew/Caskroom/codex/0.130.0/codex",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "brew upgrade --cask codex",
      executable: "brew",
      args: ["upgrade", "--cask", "codex"],
      lockKey: "homebrew",
    });
    assert.strictEqual(capabilities.packageName, null);
  });

  it("uses provider-native update commands with detected install method", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      binaryPath: "opencode",
      realCommandPath: "/Users/test/.local/share/pnpm/opencode",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "opencode upgrade --method pnpm",
      executable: "opencode",
      args: ["upgrade", "--method", "pnpm"],
      lockKey: "opencode-native",
    });
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "npm",
      name: "opencode-ai",
    });
  });

  it("uses Homebrew updates but keeps npm latest metadata for tapped OpenCode installs", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
      binaryPath: "opencode",
      realCommandPath: "/opt/homebrew/Cellar/opencode/1.14.46/bin/opencode",
    });

    assert.deepStrictEqual(capabilities.update, {
      command: "brew upgrade anomalyco/tap/opencode",
      executable: "brew",
      args: ["upgrade", "anomalyco/tap/opencode"],
      lockKey: "homebrew",
    });
    assert.deepStrictEqual(capabilities.latestVersionSource, {
      kind: "npm",
      name: "opencode-ai",
    });
  });

  describe("resolveProviderMaintenanceCapabilitiesEffect", () => {
    function runWithVirtualFileSystem(
      presentPaths: ReadonlySet<string>,
      options: Parameters<typeof resolveProviderMaintenanceCapabilitiesEffect>[1],
    ) {
      const probed: string[] = [];
      const layer = FileSystem.layerNoop({
        exists: (probedPath: string) =>
          Effect.sync(() => {
            probed.push(probedPath);
            return presentPaths.has(probedPath);
          }),
        realPath: (probedPath: string) => Effect.succeed(probedPath),
      });
      return Effect.runPromise(
        resolveProviderMaintenanceCapabilitiesEffect(CODEX_DEFINITION, options).pipe(
          Effect.provide(layer),
          Effect.map((capabilities) => ({ capabilities, probed })),
        ),
      );
    }

    it("walks PATH in order and reports the first directory that holds the binary", async () => {
      const { capabilities, probed } = await runWithVirtualFileSystem(
        new Set([join("/second", "codex")]),
        {
          binaryPath: "codex",
          platform: "darwin",
          env: { PATH: "/first:/second:/third" },
        },
      );

      assert.deepStrictEqual(probed, [join("/first", "codex"), join("/second", "codex")]);
      // Resolution stops at the hit, so /third is never touched, and the detected directory is
      // the PATH entry rather than anything derived from the command name.
      assert.strictEqual(capabilities.update, null);
    });

    it("tries the extensionless name before PATHEXT variants on Windows", async () => {
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "codex",
        platform: "win32",
        env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      });

      // An installation can be an extensionless file that nothing could spawn directly; this
      // resolver is reporting on what is installed, not picking something to run.
      // Candidates are joined with the host separator, so compare file names rather than paths.
      assert.deepStrictEqual(probed.map(fileNameOf), [
        "codex",
        "codex.EXE",
        "codex.exe",
        "codex.CMD",
        "codex.cmd",
      ]);
    });

    it("prefers .BAT over .CMD, matching Windows' own PATHEXT precedence", async () => {
      // The list this replaced was ["", ".exe", ".cmd", ".bat"], which resolved this pair the
      // wrong way round whenever both shims existed.
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "codex",
        platform: "win32",
        env: { PATH: "C:\\bin" },
      });

      const batIndex = probed.findIndex((entry) => entry.endsWith("codex.BAT"));
      const cmdIndex = probed.findIndex((entry) => entry.endsWith("codex.CMD"));
      assert.ok(batIndex >= 0 && cmdIndex >= 0);
      assert.ok(batIndex < cmdIndex);
    });

    it("does not search PATH when a binary path already names a location", async () => {
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "/opt/homebrew/bin/codex",
        platform: "darwin",
        env: { PATH: "/first" },
      });

      assert.deepStrictEqual(probed, []);
    });

    it("resolves explicit Homebrew symlinks before selecting a cask variant", async () => {
      const layer = FileSystem.layerNoop({
        realPath: () => Effect.succeed("/opt/homebrew/Caskroom/claude-code@latest/2.1.100/claude"),
      });

      const capabilities = await Effect.runPromise(
        resolveProviderMaintenanceCapabilitiesEffect(CLAUDE_DEFINITION, {
          binaryPath: "/opt/homebrew/bin/claude",
          platform: "darwin",
        }).pipe(Effect.provide(layer)),
      );

      assert.deepStrictEqual(capabilities.update, {
        command: "brew upgrade --cask claude-code@latest",
        executable: "brew",
        args: ["upgrade", "--cask", "claude-code@latest"],
        lockKey: "homebrew",
      });
      assert.deepStrictEqual(capabilities.latestVersionSource, {
        kind: "homebrew",
        name: "claude-code@latest",
        homebrewKind: "cask",
      });
    });

    it("probes the native POSIX defaults when the supplied environment has no PATH", async () => {
      // Do not fall back to process.env: Node itself uses /usr/bin:/bin when PATH is absent.
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "codex",
        platform: "darwin",
        env: { HOME: "/home/test" },
      });

      assert.deepStrictEqual(probed, [join("/usr/bin", "codex"), join("/bin", "codex")]);
    });

    it("recognises npm's Windows shim by the package beside it", async () => {
      const directory = "C:\\Users\\Test\\AppData\\Roaming\\npm";
      const { capabilities } = await runWithVirtualFileSystem(
        // PATH candidates are joined with the host separator (see the PATHEXT test above);
        // the package manifest beside the shim is always a Windows path.
        new Set([
          join(directory, "codex"),
          win32.join(directory, "node_modules", "@openai", "codex", "package.json"),
        ]),
        { binaryPath: "codex", platform: "win32", env: { PATH: directory, PATHEXT: ".CMD" } },
      );

      assert.deepStrictEqual(capabilities.update?.args, [
        "install",
        "-g",
        "--prefix",
        directory,
        "@openai/codex@latest",
      ]);
    });

    it("leaves a Windows binary without a package beside it unclassified", async () => {
      const directory = "C:\\tools";
      const { capabilities } = await runWithVirtualFileSystem(new Set([join(directory, "codex")]), {
        binaryPath: "codex",
        platform: "win32",
        env: { PATH: directory, PATHEXT: ".CMD" },
      });

      assert.strictEqual(capabilities.update, null);
    });
  });

  describe("the mainland China mirror channel", () => {
    const packageChannel = "cn-mirror" as const;
    const registry = "--registry=https://registry.npmmirror.com";

    it("adds the mirror to npm, bun and pnpm updates", () => {
      const update = (realCommandPath: string) =>
        resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
          binaryPath: "codex",
          realCommandPath,
          packageChannel,
        }).update?.args;

      assert.deepStrictEqual(update("/usr/local/lib/node_modules/@openai/codex/bin/codex.js"), [
        "install",
        "-g",
        "--prefix",
        "/usr/local",
        registry,
        "@openai/codex@latest",
      ]);
      assert.deepStrictEqual(update("/Users/test/.bun/bin/codex"), [
        "i",
        "-g",
        registry,
        "@openai/codex@latest",
      ]);
      assert.deepStrictEqual(update("/Users/test/.local/share/pnpm/codex"), [
        "add",
        "-g",
        registry,
        "@openai/codex@latest",
      ]);
    });

    it("skips a CLI's own updater when the package manager can use the mirror", () => {
      const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
        binaryPath: "opencode",
        realCommandPath: "/usr/local/lib/node_modules/opencode-ai/bin/opencode",
        packageChannel,
      });

      assert.strictEqual(capabilities.update?.executable, "npm");
      assert.strictEqual(capabilities.update?.lockKey, "npm-global");
      assert.ok(capabilities.update?.args.includes(registry));
      assert.strictEqual(capabilities.packageChannel, packageChannel);
    });

    it("still uses a CLI's own updater when nothing else owns the install", () => {
      const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
        binaryPath: "opencode",
        packageChannel,
      });

      assert.deepStrictEqual(capabilities.update?.args, ["upgrade"]);
      assert.strictEqual(capabilities.packageChannel, packageChannel);
    });

    it("keeps the official channel's commands unchanged", () => {
      const capabilities = resolvePackageManagedProviderMaintenance(OPENCODE_DEFINITION, {
        binaryPath: "opencode",
        realCommandPath: "/usr/local/lib/node_modules/opencode-ai/bin/opencode",
        packageChannel: "official",
      });

      assert.deepStrictEqual(capabilities.update?.args, ["upgrade", "--method", "npm"]);
      assert.strictEqual(capabilities.packageChannel, undefined);
    });

    it("tells the client which channel an advisory came from", () => {
      const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
        binaryPath: "codex",
        realCommandPath: "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
        packageChannel,
      });

      const advisory = createProviderVersionAdvisory({
        provider: "codex",
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        maintenanceCapabilities: capabilities,
      });
      assert.strictEqual(advisory.packageChannel, packageChannel);
      assert.ok(advisory.updateCommand?.includes(registry));
      assert.strictEqual(
        createProviderVersionAdvisory({ provider: "codex", currentVersion: "0.1.0" })
          .packageChannel,
        undefined,
      );
    });

    it.effect("looks up the latest version from the channel's registry", () =>
      Effect.gen(function* () {
        const requested: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request) => {
          requested.push(String(input));
          return new Response(JSON.stringify({ version: "9.9.9" }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));

        const source = { kind: "npm", name: "@test/channel-lookup" } as const;
        const base = {
          provider: "codex",
          packageName: source.name,
          latestVersionSource: source,
          update: null,
        } as const;
        const official = yield* resolveLatestProviderVersion(base);
        const mirrored = yield* resolveLatestProviderVersion({ ...base, packageChannel });

        assert.strictEqual(official, "9.9.9");
        assert.strictEqual(mirrored, "9.9.9");
        // The channels cache apart, so changing lanes cannot reuse the other registry's answer.
        assert.deepStrictEqual(requested, [
          "https://registry.npmjs.org/%40test%2Fchannel-lookup/latest",
          "https://registry.npmmirror.com/%40test%2Fchannel-lookup/latest",
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("asks the Homebrew mirror on the mirror channel", () =>
      Effect.gen(function* () {
        const requested: string[] = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request) => {
          requested.push(String(input));
          return new Response(JSON.stringify({ version: "1.2.3" }));
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));

        const version = yield* resolveLatestProviderVersion({
          provider: "codex",
          packageName: null,
          latestVersionSource: { kind: "homebrew", name: "test-cask", homebrewKind: "cask" },
          update: null,
          packageChannel,
        });

        assert.strictEqual(version, "1.2.3");
        assert.deepStrictEqual(requested, [
          "https://mirrors.ustc.edu.cn/homebrew-bottles/api/cask/test-cask.json",
        ]);
      }).pipe(Effect.scoped),
    );
  });

  it.effect("retries a failed version lookup sooner than a successful one", () =>
    Effect.gen(function* () {
      let calls = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response("", { status: 503 });
      }) as unknown as typeof fetch;
      yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));

      const capabilities = {
        provider: "codex",
        packageName: "@test/failed-lookup",
        latestVersionSource: { kind: "npm", name: "@test/failed-lookup" },
        update: null,
      } as const;
      assert.strictEqual(yield* resolveLatestProviderVersion(capabilities), null);
      assert.strictEqual(yield* resolveLatestProviderVersion(capabilities), null);
      assert.strictEqual(calls, 1);
      yield* TestClock.adjust("6 minutes");
      yield* resolveLatestProviderVersion(capabilities);
      assert.strictEqual(calls, 2);
    }).pipe(Effect.scoped),
  );

  it("marks older semver versions as behind latest", () => {
    const advisory = createProviderVersionAdvisory({
      provider: "codex",
      currentVersion: "0.129.0",
      latestVersion: "0.130.0",
    });

    assert.strictEqual(advisory.status, "behind_latest");
    assert.strictEqual(advisory.currentVersion, "0.129.0");
    assert.strictEqual(advisory.latestVersion, "0.130.0");
    assert.strictEqual(advisory.latestVersionKnowable, true);
  });

  it("reports an unknowable latest version for self-updating providers", () => {
    // `cursor-agent update` exists, but no registry publishes its version, so the
    // advisory can never reach "current" — callers must not read that as "outdated".
    const advisory = createProviderVersionAdvisory({
      provider: "cursor",
      currentVersion: "2026.07.09-c59fd9a",
      maintenanceCapabilities: makeProviderMaintenanceCapabilities({
        provider: "cursor",
        packageName: null,
        updateExecutable: "cursor-agent",
        updateArgs: ["update"],
        updateLockKey: "cursor-agent",
      }),
    });

    assert.strictEqual(advisory.status, "unknown");
    assert.strictEqual(advisory.latestVersion, null);
    assert.strictEqual(advisory.latestVersionKnowable, false);
    assert.strictEqual(advisory.canUpdate, true);
  });
});
