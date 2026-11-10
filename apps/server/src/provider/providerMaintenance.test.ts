import { describe, it, assert } from "@effect/vitest";
import { join, win32 } from "node:path";

import { Effect, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";

import {
  createProviderVersionAdvisory,
  deriveNpmGlobalPrefix,
  enrichProviderStatusWithVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  providerUpdateFailureReason,
  prepareProviderMaintenanceUpdate,
  resolveLatestProviderVersion,
  resolvePackageManagedProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
  withOpenCodeMaintenanceVersion,
  type PackageManagedProviderMaintenanceDefinition,
  PROVIDER_UPDATE_INSTALLATION_CHANGED_MESSAGE,
  PROVIDER_UPDATE_SETTINGS_CHANGED_MESSAGE,
  PROVIDER_UPDATE_VERSION_UNCONFIRMED_MESSAGE,
  providerUpdatePreparationFailure,
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

  it("never offers to update a project's own copy of a CLI", () => {
    // `bun run` puts the repo's node_modules/.bin on PATH, so a dev server finds the repo's
    // copy. A global install or the CLI's own updater would leave that copy alone and write
    // to the real global npm instead.
    for (const [definition, commandPath] of [
      [CODEX_DEFINITION, "/repo/node_modules/.bin/codex"],
      [CODEX_DEFINITION, "C:\\repo\\apps\\server\\node_modules\\.bin\\codex.exe"],
      [CODEX_DEFINITION, "/repo/node_modules/@openai/codex/bin/codex.js"],
      [OPENCODE_DEFINITION, "C:\\repo\\apps\\server\\node_modules\\.bin\\opencode.exe"],
    ] as const) {
      const capabilities = resolvePackageManagedProviderMaintenance(definition, {
        binaryPath: commandPath,
        realCommandPath: commandPath,
      });
      assert.strictEqual(capabilities.update, null, commandPath);
    }
  });

  it("does not guess an update command for unclassified binaries", () => {
    const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
      binaryPath: "/custom/bin/codex",
      realCommandPath: "/custom/bin/codex",
    });

    assert.strictEqual(capabilities.update, null);
  });

  it.effect("checks a standalone executable's release without guessing an updater", () =>
    Effect.gen(function* () {
      const capabilities = resolvePackageManagedProviderMaintenance(CODEX_DEFINITION, {
        binaryPath: "C:\\tools\\codex.exe",
      });
      const requested: string[] = [];
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: string | URL | Request) => {
        requested.push(String(input));
        return Response.json({ version: "0.999.0" });
      }) as unknown as typeof fetch;
      yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));

      const latestVersion = yield* resolveLatestProviderVersion(capabilities);
      const advisory = createProviderVersionAdvisory({
        provider: "codex",
        currentVersion: "0.166.0",
        latestVersion,
        maintenanceCapabilities: capabilities,
      });
      assert.deepStrictEqual(requested, ["https://registry.npmjs.org/%40openai%2Fcodex/latest"]);
      assert.strictEqual(advisory.status, "behind_latest");
      assert.strictEqual(advisory.latestVersionKnowable, true);
      assert.strictEqual(advisory.canUpdate, false);
      assert.strictEqual(advisory.updateCommand, null);
    }).pipe(Effect.scoped),
  );

  it.effect("does not compare native Claude's configured release channel with npm latest", () =>
    Effect.gen(function* () {
      const capabilities = resolvePackageManagedProviderMaintenance(CLAUDE_DEFINITION, {
        binaryPath: "/Users/test/.local/share/claude/versions/2.1.318",
      });
      let requests = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        requests += 1;
        return Response.json({ version: "9.9.9" });
      }) as unknown as typeof fetch;
      yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));

      const latestVersion = yield* resolveLatestProviderVersion(capabilities);
      const advisory = createProviderVersionAdvisory({
        provider: "claudeAgent",
        currentVersion: "2.1.318",
        latestVersion,
        maintenanceCapabilities: capabilities,
      });
      assert.strictEqual(requests, 0);
      assert.strictEqual(advisory.status, "unknown");
      assert.strictEqual(advisory.latestVersionKnowable, false);
      assert.strictEqual(advisory.canUpdate, true);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a failed release lookup unknown instead of reporting the CLI current", () =>
    Effect.gen(function* () {
      const capabilities = resolvePackageManagedProviderMaintenance(
        {
          ...CODEX_DEFINITION,
          npmPackageName: "@test/offline-standalone",
        },
        { binaryPath: "C:\\tools\\codex.exe" },
      );
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        throw new TypeError("synthetic network unavailable");
      }) as unknown as typeof fetch;
      yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));

      const latestVersion = yield* resolveLatestProviderVersion(capabilities);
      const advisory = createProviderVersionAdvisory({
        provider: "codex",
        currentVersion: "0.166.0",
        latestVersion,
        maintenanceCapabilities: capabilities,
      });
      assert.strictEqual(advisory.status, "unknown");
      assert.strictEqual(advisory.latestVersion, null);
      assert.strictEqual(advisory.latestVersionKnowable, true);
      assert.strictEqual(advisory.canUpdate, false);
    }).pipe(Effect.scoped),
  );

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

    it("only tries Windows launchable PATHEXT variants", async () => {
      const { probed } = await runWithVirtualFileSystem(new Set(), {
        binaryPath: "codex",
        platform: "win32",
        env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" },
      });

      // Candidates are joined with the host separator, so compare file names rather than paths.
      assert.deepStrictEqual(probed.map(fileNameOf), [
        "codex.EXE",
        "codex.exe",
        "codex.CMD",
        "codex.cmd",
      ]);
    });

    it("never updates a stale Windows shell shim instead of the runnable CLI", async () => {
      const oldDirectory = "C:\\old-npm";
      const activeDirectory = "C:\\active-npm";
      const { capabilities, probed } = await runWithVirtualFileSystem(
        new Set([
          join(oldDirectory, "codex"),
          win32.join(oldDirectory, "node_modules", "@openai", "codex", "package.json"),
          join(activeDirectory, "codex.cmd"),
          win32.join(activeDirectory, "node_modules", "@openai", "codex", "package.json"),
        ]),
        {
          binaryPath: "codex",
          platform: "win32",
          env: { PATH: `${oldDirectory};${activeDirectory}`, PATHEXT: ".EXE;.CMD" },
        },
      );

      assert.strictEqual(probed.includes(join(oldDirectory, "codex")), false);
      assert.deepStrictEqual(capabilities.update?.args, [
        "install",
        "-g",
        "--prefix",
        activeDirectory,
        "@openai/codex@latest",
      ]);
      assert.strictEqual(capabilities.update?.pathPrepend, activeDirectory);
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
          join(directory, "codex.cmd"),
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
      const { capabilities } = await runWithVirtualFileSystem(
        new Set([join(directory, "codex.cmd")]),
        {
          binaryPath: "codex",
          platform: "win32",
          env: { PATH: directory, PATHEXT: ".CMD" },
        },
      );

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

    it.effect(
      "keeps channel caches separate while verifying mirror metadata with the official registry",
      () =>
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
            "https://registry.npmjs.org/%40test%2Fchannel-lookup/latest",
            "https://registry.npmmirror.com/%40test%2Fchannel-lookup/latest",
          ]);
        }).pipe(Effect.scoped),
    );

    it.effect("checks Homebrew official and mirror metadata on the mirror channel", () =>
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
          "https://formulae.brew.sh/api/cask/test-cask.json",
          "https://mirrors.ustc.edu.cn/homebrew-bottles/api/cask/test-cask.json",
        ]);
      }).pipe(Effect.scoped),
    );
  });

  describe("release truth on a mirrored install channel", () => {
    const cases = [
      {
        name: "does not call Grok current when the mirror tag is stale",
        current: "1.0.67",
        official: "1.0.77",
        mirror: "0.1.4",
        latest: "1.0.77",
        expected: "behind_latest",
        packageName: "@xai-official/grok",
      },
      {
        name: "does not replace official metadata with a higher mirror tag",
        current: "1.0.67",
        official: "1.0.67",
        mirror: "1.0.77",
        latest: "1.0.67",
        expected: "current",
      },
      {
        name: "can prove an update from the mirror when official metadata is unreachable",
        current: "1.0.67",
        official: null,
        mirror: "1.0.77",
        latest: "1.0.77",
        expected: "behind_latest",
      },
      {
        name: "cannot prove current from an older mirror tag",
        current: "1.0.67",
        official: null,
        mirror: "0.1.4",
        latest: "0.1.4",
        expected: "unknown",
      },
      {
        name: "cannot prove current from an equal mirror tag",
        current: "1.0.67",
        official: null,
        mirror: "1.0.67",
        latest: "1.0.67",
        expected: "unknown",
      },
      {
        name: "keeps both failed lookups unknown",
        current: "1.0.67",
        official: null,
        mirror: null,
        latest: null,
        expected: "unknown",
      },
      {
        name: "can use official metadata when the mirror is unreachable",
        current: "1.0.67",
        official: "1.0.77",
        mirror: null,
        latest: "1.0.77",
        expected: "behind_latest",
      },
      {
        name: "compares prerelease identifiers numerically",
        current: "1.0.77-beta.9",
        official: "1.0.77-beta.10",
        mirror: "0.1.4",
        latest: "1.0.77-beta.10",
        expected: "behind_latest",
      },
      {
        name: "recognizes a stable release after its prerelease",
        current: "1.0.77-beta.10",
        official: null,
        mirror: "1.0.77",
        latest: "1.0.77",
        expected: "behind_latest",
      },
      {
        name: "ignores build metadata when comparing the same release",
        current: "1.0.77+local.1",
        official: "1.0.77+official.2",
        mirror: "0.1.4",
        latest: "1.0.77+official.2",
        expected: "current",
      },
      {
        name: "does not claim current from malformed release metadata",
        current: "1.0.67",
        official: "invalid-version",
        mirror: "0.1.4",
        latest: "0.1.4",
        expected: "unknown",
      },
      {
        name: "can fall back to a newer mirror after malformed official metadata",
        current: "1.0.67",
        official: "invalid-version",
        mirror: "1.0.77",
        latest: "1.0.77",
        expected: "behind_latest",
      },
    ] as const;

    for (const [index, testCase] of cases.entries()) {
      it.effect(testCase.name, () =>
        Effect.gen(function* () {
          const requested: string[] = [];
          const realFetch = globalThis.fetch;
          globalThis.fetch = (async (input: string | URL | Request) => {
            const url = String(input);
            requested.push(url);
            const version = url.startsWith("https://registry.npmjs.org/")
              ? testCase.official
              : testCase.mirror;
            return version === null
              ? new Response("", { status: 503 })
              : Response.json({ version });
          }) as unknown as typeof fetch;
          yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));
          const capabilities = makeProviderMaintenanceCapabilities({
            provider: "grok",
            packageName:
              "packageName" in testCase ? testCase.packageName : `@test/mirror-release-${index}`,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
            packageChannel: "cn-mirror",
          });
          const status = {
            provider: "grok",
            driver: "grok",
            instanceId: "grok",
            status: "ready",
            available: true,
            authStatus: "unknown",
            version: testCase.current,
            checkedAt: "2026-11-06T06:17:12.288Z",
          } as const;
          const enriched = yield* enrichProviderStatusWithVersionAdvisory(status, capabilities);
          assert.strictEqual(enriched.versionAdvisory.latestVersion, testCase.latest);
          assert.strictEqual(enriched.versionAdvisory.status, testCase.expected);
          assert.strictEqual(enriched.versionAdvisory.packageChannel, "cn-mirror");
          assert.strictEqual(enriched.versionAdvisory.canUpdate, false);
          assert.strictEqual(requested.length, 2);
          assert.ok(requested.some((url) => url.startsWith("https://registry.npmjs.org/")));
          assert.ok(requested.some((url) => url.startsWith("https://registry.npmmirror.com/")));
        }).pipe(Effect.scoped),
      );
    }

    it.effect("retries official metadata soon after a mirror-only fallback", () =>
      Effect.gen(function* () {
        let officialAvailable = false;
        let calls = 0;
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async (input: string | URL | Request) => {
          calls += 1;
          if (String(input).startsWith("https://registry.npmjs.org/")) {
            return officialAvailable
              ? Response.json({ version: "1.0.77" })
              : new Response("", { status: 503 });
          }
          return Response.json({ version: "0.1.4" });
        }) as unknown as typeof fetch;
        yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));
        const capabilities = makeProviderMaintenanceCapabilities({
          provider: "grok",
          packageName: "@test/mirror-retry-official",
          updateExecutable: null,
          updateArgs: [],
          updateLockKey: null,
          packageChannel: "cn-mirror",
        });
        const status = {
          provider: "grok",
          driver: "grok",
          instanceId: "grok",
          status: "ready",
          available: true,
          authStatus: "unknown",
          version: "1.0.67",
          checkedAt: "2026-11-06T06:17:12.288Z",
        } as const;
        assert.strictEqual(
          (yield* enrichProviderStatusWithVersionAdvisory(status, capabilities)).versionAdvisory
            .status,
          "unknown",
        );
        // Cached fallback must retain its limited authority, not become "current".
        assert.strictEqual(
          (yield* enrichProviderStatusWithVersionAdvisory(status, capabilities)).versionAdvisory
            .status,
          "unknown",
        );
        assert.strictEqual(calls, 2);
        officialAvailable = true;
        yield* TestClock.adjust("6 minutes");
        const refreshed = yield* enrichProviderStatusWithVersionAdvisory(status, capabilities);
        assert.strictEqual(refreshed.versionAdvisory.status, "behind_latest");
        assert.strictEqual(refreshed.versionAdvisory.latestVersion, "1.0.77");
        assert.strictEqual(calls, 4);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "starts both bounded lookups together and aborts them with their owning refresh",
      () =>
        Effect.gen(function* () {
          const signals: AbortSignal[] = [];
          let bothStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            bothStarted = resolve;
          });
          const realFetch = globalThis.fetch;
          globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            const signal = init?.signal;
            assert.ok(signal);
            signals.push(signal);
            if (signals.length === 2) bothStarted();
            return await new Promise<Response>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new DOMException("aborted", "AbortError")),
                { once: true },
              );
            });
          }) as unknown as typeof fetch;
          yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));
          const capabilities = makeProviderMaintenanceCapabilities({
            provider: "grok",
            packageName: "@test/mirror-cancel",
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
            packageChannel: "cn-mirror",
          });
          const fiber = yield* resolveLatestProviderVersion(capabilities).pipe(Effect.forkChild);
          yield* Effect.promise(() => started);
          yield* Fiber.interrupt(fiber);
          assert.strictEqual(signals.length, 2);
          assert.ok(signals.every((signal) => signal.aborted));
        }).pipe(Effect.scoped),
    );
  });

  describe("verified package update targets", () => {
    for (const [index, tool] of ["npm", "bun", "pnpm"].entries()) {
      it.effect(`pins ${tool} to the official release even when mirror latest is older`, () =>
        Effect.gen(function* () {
          const realFetch = globalThis.fetch;
          globalThis.fetch = (async (input: string | URL | Request) =>
            Response.json({
              version: String(input).startsWith("https://registry.npmjs.org/") ? "1.0.77" : "0.1.4",
            })) as unknown as typeof fetch;
          yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));
          const packageName = `@test/pinned-${index}`;
          const capabilities = makeProviderMaintenanceCapabilities({
            provider: "grok",
            packageName,
            updateExecutable: tool,
            updateArgs: [
              "install",
              "-g",
              "--prefix",
              "C:\\selected npm",
              "--registry=https://registry.npmmirror.com",
              `${packageName}@latest`,
            ],
            updateLockKey: `${tool}-global`,
            packageChannel: "cn-mirror",
          });
          const prepared = yield* prepareProviderMaintenanceUpdate(capabilities, "1.0.67");
          assert.ok(prepared.update);
          assert.deepStrictEqual(prepared.update.args, [
            ...capabilities.update!.args.slice(0, -1),
            `${packageName}@1.0.77`,
          ]);
          assert.include(prepared.update.command, `${packageName}@1.0.77`);
          assert.notInclude(prepared.update.command, "@latest");
          assert.include(prepared.update.command, '--prefix "C:\\selected npm"');
          const enriched = yield* enrichProviderStatusWithVersionAdvisory(
            {
              provider: "grok",
              driver: "grok",
              instanceId: "grok",
              status: "ready",
              available: true,
              authStatus: "unknown",
              version: "1.0.67",
              checkedAt: "2026-11-06T06:17:12.288Z",
            },
            capabilities,
          );
          assert.strictEqual(enriched.versionAdvisory.updateCommand, prepared.update.command);
          assert.strictEqual(enriched.versionAdvisory.canUpdate, true);
        }).pipe(Effect.scoped),
      );
    }

    for (const [index, invalid] of [
      "1.0.67-",
      "1..0.67",
      "1.0.67-!bad",
      "1.0.67+",
      "01.0.67",
      "1.0.67-01",
      " 1.0.67",
      "1.0.67 ",
      "v1.0.67",
      "1.0.67\n",
      "1.0.67\r\n",
    ].entries()) {
      it.effect(`rejects malformed remote SemVer ${JSON.stringify(invalid)}`, () =>
        Effect.gen(function* () {
          const realFetch = globalThis.fetch;
          globalThis.fetch = (async () =>
            Response.json({ version: invalid })) as unknown as typeof fetch;
          yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));
          const capabilities = makeProviderMaintenanceCapabilities({
            provider: "grok",
            packageName: `@test/invalid-target-${index}`,
            updateExecutable: "npm",
            updateArgs: ["install", "-g", `@test/invalid-target-${index}@latest`],
            updateLockKey: "npm-global",
          });
          const prepared = yield* prepareProviderMaintenanceUpdate(capabilities, "1.0.66");
          assert.strictEqual(prepared.update, null);
          assert.strictEqual(yield* resolveLatestProviderVersion(capabilities), null);
        }).pipe(Effect.scoped),
      );
    }

    for (const [index, testCase] of [
      { current: null, official: "1.0.77", mirror: "0.1.4" },
      { current: "1.0.78", official: "1.0.77", mirror: "0.1.4" },
      { current: "1.0.67", official: null, mirror: "0.1.4" },
      { current: "1.0.67", official: null, mirror: null },
      { current: "1.0.77", official: "1.0.77-beta.1", mirror: "0.1.4" },
    ].entries()) {
      it.effect(`rejects an unverifiable or older package target ${index}`, () =>
        Effect.gen(function* () {
          const realFetch = globalThis.fetch;
          globalThis.fetch = (async (input: string | URL | Request) => {
            const version = String(input).startsWith("https://registry.npmjs.org/")
              ? testCase.official
              : testCase.mirror;
            return version === null
              ? new Response("", { status: 503 })
              : Response.json({ version });
          }) as unknown as typeof fetch;
          yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));
          const packageName = `@test/unverifiable-target-${index}`;
          const capabilities = makeProviderMaintenanceCapabilities({
            provider: "grok",
            packageName,
            updateExecutable: "npm",
            updateArgs: ["install", "-g", `${packageName}@latest`],
            updateLockKey: "npm-global",
            packageChannel: "cn-mirror",
          });
          assert.strictEqual(
            (yield* prepareProviderMaintenanceUpdate(capabilities, testCase.current)).update,
            null,
          );
        }).pipe(Effect.scoped),
      );
    }

    for (const [index, lockKey] of ["opencode-native", "homebrew"].entries()) {
      it.effect(
        `refuses conflicting mirror metadata without inventing native flags for ${lockKey}`,
        () =>
          Effect.gen(function* () {
            const realFetch = globalThis.fetch;
            globalThis.fetch = (async (input: string | URL | Request) =>
              Response.json({
                version: String(input).startsWith("https://registry.npmjs.org/")
                  ? "1.0.77"
                  : "0.1.4",
              })) as unknown as typeof fetch;
            yield* Effect.addFinalizer(() => Effect.sync(() => (globalThis.fetch = realFetch)));
            const capabilities = makeProviderMaintenanceCapabilities({
              provider: "opencode",
              packageName: `@test/native-mirror-${index}`,
              updateExecutable: lockKey === "homebrew" ? "brew" : "opencode",
              updateArgs: ["upgrade"],
              updateLockKey: lockKey,
              packageChannel: "cn-mirror",
            });
            assert.strictEqual(
              (yield* prepareProviderMaintenanceUpdate(capabilities, "1.0.67")).update,
              null,
            );
          }).pipe(Effect.scoped),
      );
    }

    it.effect(
      "keeps native release-channel owners with no queryable source on their own syntax",
      () =>
        Effect.gen(function* () {
          const capabilities = makeProviderMaintenanceCapabilities({
            provider: "claudeAgent",
            packageName: null,
            updateExecutable: "claude",
            updateArgs: ["update"],
            updateLockKey: "claude-native",
            packageChannel: "cn-mirror",
          });
          const prepared = yield* prepareProviderMaintenanceUpdate(capabilities, null);
          assert.deepStrictEqual(prepared.update?.args, ["update"]);
        }),
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

describe("providerUpdatePreparationFailure", () => {
  const verifiedUpdate = { lockKey: "npm-global" };
  it("reports a settings change, not missing update support", () => {
    assert.strictEqual(
      providerUpdatePreparationFailure({
        settingsChanged: true,
        expectedLockKey: "npm-global",
        verifiedUpdate,
      }),
      PROVIDER_UPDATE_SETTINGS_CHANGED_MESSAGE,
    );
  });
  it("reports an unconfirmed target version and a changed installation separately", () => {
    assert.strictEqual(
      providerUpdatePreparationFailure({
        settingsChanged: false,
        expectedLockKey: "npm-global",
        verifiedUpdate: null,
      }),
      PROVIDER_UPDATE_VERSION_UNCONFIRMED_MESSAGE,
    );
    assert.strictEqual(
      providerUpdatePreparationFailure({
        settingsChanged: false,
        expectedLockKey: "npm-global",
        verifiedUpdate: { lockKey: "bun-global" },
      }),
      PROVIDER_UPDATE_INSTALLATION_CHANGED_MESSAGE,
    );
  });
  it("lets a verified, unchanged update start", () => {
    assert.isNull(
      providerUpdatePreparationFailure({
        settingsChanged: false,
        expectedLockKey: "npm-global",
        verifiedUpdate,
      }),
    );
  });
  it("never blames missing one-click support for a preparation race", () => {
    for (const message of [
      PROVIDER_UPDATE_SETTINGS_CHANGED_MESSAGE,
      PROVIDER_UPDATE_INSTALLATION_CHANGED_MESSAGE,
      PROVIDER_UPDATE_VERSION_UNCONFIRMED_MESSAGE,
    ])
      assert.notInclude(message, "does not support");
  });
});

describe("providerUpdateFailureReason", () => {
  it("reads why an updater failed, not where it put its log", () => {
    // What `pi update` printed when Moss's update environment could not see Pi's global npm.
    assert.strictEqual(
      providerUpdateFailureReason({
        stderr: [
          "\u001b[31merror: pi cannot self-update this installation.\u001b[39m",
          "This installation is not managed by a global npm install. Update it with the package manager, wrapper, or source checkout that provides it.",
          "",
          "Location of pi executable: C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js",
        ].join("\r\n"),
        stdout: "",
      }),
      "error: pi cannot self-update this installation.",
    );
    assert.strictEqual(
      providerUpdateFailureReason({
        stderr: [
          "npm warn deprecated something@1.0.0",
          "npm error code EPERM",
          "npm error syscall rename",
          "npm error A complete log of this run can be found in: C:\\npm-cache\\_logs\\debug-0.log",
        ].join("\n"),
        stdout: "",
      }),
      "npm error code EPERM",
    );
  });

  it("falls back to the last line, then to nothing", () => {
    assert.strictEqual(
      providerUpdateFailureReason({ stderr: "", stdout: "Checking for updates\nNo network\n" }),
      "No network",
    );
    assert.strictEqual(providerUpdateFailureReason({ stderr: " \n", stdout: "" }), null);
    assert.ok(
      (providerUpdateFailureReason({ stderr: `error: ${"x".repeat(1_000)}`, stdout: "" })?.length ??
        0) <= 300,
    );
  });
});
