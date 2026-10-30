import {
  copyFileSync,
  linkSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildCodexAppServerArgs,
  buildCodexProcessLaunchContext,
  buildCodexProcessEnv,
  disableCodexConfigSections,
  hydrateCodexProviderCredentialEnvironment,
  isCodexSharedContinuationStatePrepared,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
  readCodexSharedContinuationGeneration,
  type CodexOverlayEntryLinker,
  writeCodexOverlayConfigAtomically,
} from "./codexProcessEnv";
import { isProviderCredentialKey } from "./providerChildEnvironment.ts";
import {
  createCodexAliasFixture,
  expectCodexOverlayPrivateFile,
} from "./test/codexOverlayFixtures";
import { buildCodexMcpConfigToml } from "./agentGateway/mcpInjection.ts";
import {
  resolveActiveCodexHomeWritePath,
  resolveCodexHomeOverlayAccountSegment,
  resolveMossCodexHomeOverlayPath,
} from "./codexHomePaths.ts";

describe("hydrateCodexProviderCredentialEnvironment", () => {
  it("hydrates only missing provider credentials without trusting shell PATH", () => {
    const readEnvironment = vi.fn(() => ({
      AZURE_OPENAI_API_KEY: "shell-key",
      PATH: "/untrusted/shell/bin",
    }));
    const hydrated = hydrateCodexProviderCredentialEnvironment({
      env: { PATH: "/trusted/bin" },
      credentialEnvNames: ["AZURE_OPENAI_API_KEY"],
      trustedEnv: { SHELL: "/bin/zsh" },
      platform: "darwin",
      readEnvironment,
    });
    expect(hydrated).toEqual({
      PATH: "/trusted/bin",
      AZURE_OPENAI_API_KEY: "shell-key",
    });
    expect(readEnvironment).toHaveBeenCalledWith("/bin/zsh", ["AZURE_OPENAI_API_KEY"]);
  });

  it("keeps an inherited provider credential and skips shell probing", () => {
    const readEnvironment = vi.fn();
    const hydrated = hydrateCodexProviderCredentialEnvironment({
      env: { AZURE_OPENAI_API_KEY: "inherited-key" },
      credentialEnvNames: ["AZURE_OPENAI_API_KEY"],
      platform: "linux",
      readEnvironment,
    });
    expect(hydrated.AZURE_OPENAI_API_KEY).toBe("inherited-key");
    expect(readEnvironment).not.toHaveBeenCalled();
  });
});

describe("writeCodexOverlayConfigAtomically", () => {
  it("keeps the old complete config when publication is interrupted", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-codex-config-publish-"));
    const targetPath = path.join(root, "config.toml");
    writeFileSync(targetPath, 'model = "old"\n', "utf8");
    let temporaryPath: string | undefined;

    try {
      await expect(
        writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n', {
          beforeRename: (candidatePath) => {
            temporaryPath = candidatePath;
            expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
            expect(readFileSync(candidatePath, "utf8")).toBe('model = "new"\n');
            throw new Error("simulated publication interruption");
          },
        }),
      ).rejects.toThrow("simulated publication interruption");

      expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
      if (!temporaryPath) {
        throw new Error("Expected atomic publication to create a temporary config path.");
      }
      expect(existsSync(temporaryPath)).toBe(false);

      await writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n');

      expect(readFileSync(targetPath, "utf8")).toBe('model = "new"\n');
      if (process.platform !== "win32") {
        expect(lstatSync(targetPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves both publication and cleanup errors", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-codex-config-cleanup-"));
    const targetPath = path.join(root, "config.toml");
    writeFileSync(targetPath, 'model = "old"\n', "utf8");

    try {
      let thrown: unknown;
      try {
        await writeCodexOverlayConfigAtomically(targetPath, 'model = "new"\n', {
          beforeRename: () => {
            throw new Error("primary publication failure");
          },
          removeTemporaryFile: () => {
            throw new Error("temporary cleanup failure");
          },
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(AggregateError);
      const aggregate = thrown as AggregateError;
      expect(aggregate.errors).toHaveLength(2);
      expect(aggregate.errors.map((error) => (error as Error).message)).toEqual([
        "primary publication failure",
        "temporary cleanup failure",
      ]);
      expect(aggregate.cause).toBe(aggregate.errors[0]);
      expect(readFileSync(targetPath, "utf8")).toBe('model = "old"\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("linkOrCopyCodexOverlayEntry", () => {
  it.each(["win32", "linux", "darwin"] as const)(
    "uses a shared directory link appropriate for %s",
    async (platform) => {
      const symlink = vi.fn(async () => undefined);
      const copyFile = vi.fn(async () => undefined);
      await linkOrCopyCodexOverlayEntry(
        {
          entryName: "plugins",
          sourcePath: "/source/plugins",
          targetPath: "/overlay/plugins",
          type: "dir",
        },
        { symlink, copyFile },
        platform,
      );
      expect(symlink).toHaveBeenCalledWith(
        "/source/plugins",
        "/overlay/plugins",
        platform === "win32" ? "junction" : "dir",
      );
      expect(copyFile).not.toHaveBeenCalled();
    },
  );

  it("shares directory writes and preserves the source when the overlay link is removed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-overlay-directory-link-"));
    const sourcePath = path.join(root, "source");
    const targetPath = path.join(root, "overlay");
    mkdirSync(sourcePath);
    try {
      await linkOrCopyCodexOverlayEntry({
        entryName: "plugins",
        sourcePath,
        targetPath,
        type: "dir",
      });
      expect(lstatSync(targetPath).isSymbolicLink()).toBe(true);
      expect(realpathSync(targetPath)).toBe(realpathSync(sourcePath));
      writeFileSync(path.join(targetPath, "installed.json"), "installed", "utf8");
      expect(readFileSync(path.join(sourcePath, "installed.json"), "utf8")).toBe("installed");
      rmSync(targetPath, { recursive: true, force: true });
      expect(readFileSync(path.join(sourcePath, "installed.json"), "utf8")).toBe("installed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never falls back to copying a continuation file on Windows", async () => {
    const failure = Object.assign(new Error("symlink permission denied"), { code: "EPERM" });
    const symlink = vi.fn(async () => {
      throw failure;
    });
    const copyFile = vi.fn(async () => undefined);
    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "history.jsonl",
          sourcePath: "/source/history.jsonl",
          targetPath: "/overlay/history.jsonl",
          type: "file",
        },
        { symlink, copyFile },
        "win32",
      ),
    ).rejects.toBe(failure);
    expect(symlink).toHaveBeenCalledWith("/source/history.jsonl", "/overlay/history.jsonl", "file");
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("hard-links continuation files on Windows without symlink privileges", async () => {
    const symlink = vi.fn(async () => undefined);
    const copyFile = vi.fn(async () => undefined);
    const link = vi.fn(async () => undefined);
    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "history.jsonl",
        sourcePath: "D:\source\history.jsonl",
        targetPath: "D:\overlay\history.jsonl",
        type: "file",
      },
      { symlink, copyFile, link },
      "win32",
    );
    expect(link).toHaveBeenCalledWith("D:\source\history.jsonl", "D:\overlay\history.jsonl");
    expect(symlink).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("falls back to a symbolic link when the Windows hard link cannot span volumes", async () => {
    const symlink = vi.fn(async () => undefined);
    const copyFile = vi.fn(async () => undefined);
    const link = vi.fn(async () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    });
    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "history.jsonl",
        sourcePath: "E:\source\history.jsonl",
        targetPath: "D:\overlay\history.jsonl",
        type: "file",
      },
      { symlink, copyFile, link },
      "win32",
    );
    expect(symlink).toHaveBeenCalledWith(
      "E:\source\history.jsonl",
      "D:\overlay\history.jsonl",
      "file",
    );
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("keeps failing closed when both Windows link paths are unavailable for a continuation file", async () => {
    const failure = Object.assign(new Error("symlink permission denied"), { code: "EPERM" });
    const symlink = vi.fn(async () => {
      throw failure;
    });
    const link = vi.fn(async () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    });
    const copyFile = vi.fn(async () => undefined);
    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "history.jsonl",
          sourcePath: "E:\source\history.jsonl",
          targetPath: "D:\overlay\history.jsonl",
          type: "file",
        },
        { symlink, copyFile, link },
        "win32",
      ),
    ).rejects.toBe(failure);
    expect(copyFile).not.toHaveBeenCalled();
  });

  it.each(["auth.json", "models_cache.json"])(
    "copies replaceable private %s when symlink creation is unavailable",
    async (entryName) => {
      const symlink = vi.fn(async () => {
        throw new Error("symlinks unavailable");
      });
      const copyFile = vi.fn(async () => undefined);

      await linkOrCopyCodexOverlayEntry(
        {
          entryName,
          sourcePath: `C:\\Users\\test\\.codex\\${entryName}`,
          targetPath: `C:\\Users\\test\\.moss\\codex-home-overlay\\${entryName}`,
          type: "file",
        },
        { symlink, copyFile },
      );

      expect(symlink).toHaveBeenCalledWith(
        `C:\\Users\\test\\.codex\\${entryName}`,
        `C:\\Users\\test\\.moss\\codex-home-overlay\\${entryName}`,
        "file",
      );
      expect(copyFile).toHaveBeenCalledWith(
        `C:\\Users\\test\\.codex\\${entryName}`,
        `C:\\Users\\test\\.moss\\codex-home-overlay\\${entryName}`,
      );
    },
  );

  it("keeps symlink failures visible for other overlay entries", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });

    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.moss\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow("symlinks unavailable");
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});

describe("disableCodexConfigSections", () => {
  const canonicalHeader = '[plugins."computer-use@openai-bundled"]';

  it.each([
    ["literal-quoted", "[plugins.'computer-use@openai-bundled']"],
    ["whitespace-varied", '[ plugins . "computer-use@openai-bundled" ]'],
    ["escaped basic-quoted", String.raw`[plugins."computer-use\u0040openai-bundled"]`],
    ["trailing-comment", "[plugins.'computer-use@openai-bundled'] # keep this comment"],
  ])("disables a semantically equivalent %s table without appending a duplicate", (_, header) => {
    const result = disableCodexConfigSections(
      `${header}\nenabled = true\n\n[plugins.other]\nenabled = true`,
      [canonicalHeader],
      true,
    );

    expect(result).toBe(`${header}\nenabled = false\n\n[plugins.other]\nenabled = true`);
    expect(result.match(/enabled = false/g)).toHaveLength(1);
    expect(result).not.toContain(canonicalHeader);
  });
});

describe("buildCodexProcessEnv", () => {
  it("repairs mixed transports in the saved gateway config during an auth probe", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-runtime-"));
    const sourceConfig = [
      "[mcp_servers.moss]",
      'command = "external-bridge"',
      "args = []",
      "[mcp_servers.user-tool]",
      'command = "user-tool"',
      "",
    ].join("\n");
    const sourceConfigPath = path.join(sourceHome, "config.toml");
    writeFileSync(sourceConfigPath, sourceConfig);
    const input = { env: { MOSS_HOME: runtimeHome }, homePath: sourceHome };
    const managedConfig = buildCodexMcpConfigToml("http://127.0.0.1:3773/mcp");

    try {
      const env = await buildCodexProcessEnv({ ...input, appendConfigToml: managedConfig });
      const overlayConfigPath = path.join(env.CODEX_HOME!, "config.toml");
      const cleanConfig = readFileSync(overlayConfigPath, "utf8");
      // The gateway's own timeout survives the field filter; only stdio leftovers go.
      expect(cleanConfig).toContain("tool_timeout_sec = 3900");
      // An external MCP registration can leave stdio fields in the saved HTTP block.
      writeFileSync(
        overlayConfigPath,
        cleanConfig
          .replace(
            "[mcp_servers.moss]",
            '[mcp_servers.moss]\ncommand = "external-bridge"\nargs = [\n  "serve",\n]\ncwd = "/tmp"',
          )
          .replace(
            "[shell_environment_policy]",
            '[mcp_servers.moss.env]\nSTDIO_ONLY = "value"\n\n[shell_environment_policy]',
          ),
      );

      await buildCodexProcessEnv(input);

      expect(readFileSync(overlayConfigPath, "utf8")).toBe(cleanConfig);
      expect(readFileSync(sourceConfigPath, "utf8")).toBe(sourceConfig);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("removes an account-scoped active provider key unless the instance supplies it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-codex-explicit-env-"));
    const codexHome = path.join(root, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      path.join(codexHome, "config.toml"),
      'model_provider = "custom"\n[model_providers.custom]\nenv_key = "ACME_PROVIDER_TOKEN"\n',
      "utf8",
    );

    try {
      const isolated = await buildCodexProcessEnv({
        env: { HOME: root, ACME_PROVIDER_TOKEN: "ambient-secret" },
        homePath: codexHome,
        skipHomeOverlay: true,
        isolateProviderCredentials: true,
        explicitProviderEnvironment: {},
        platform: "win32",
      });
      expect(isolated.ACME_PROVIDER_TOKEN).toBeUndefined();

      const explicit = await buildCodexProcessEnv({
        env: { HOME: root, ACME_PROVIDER_TOKEN: "instance-secret" },
        homePath: codexHome,
        skipHomeOverlay: true,
        isolateProviderCredentials: true,
        explicitProviderEnvironment: { ACME_PROVIDER_TOKEN: "instance-secret" },
        platform: "win32",
      });
      expect(explicit.ACME_PROVIDER_TOKEN).toBe("instance-secret");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins a fresh shared continuation source to one durable generation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-codex-generation-"));
    const codexHome = path.join(root, "codex-home");
    const runtimeHome = path.join(root, "runtime");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), "", "utf8");

    try {
      await buildCodexProcessEnv({
        env: { MOSS_HOME: runtimeHome },
        homePath: codexHome,
        platform: "win32",
      });
      const generation = readCodexSharedContinuationGeneration({
        env: { MOSS_HOME: runtimeHome },
        homePath: codexHome,
      });
      expect(generation).toMatch(/^[0-9a-f-]{36}$/);
      const marker = JSON.parse(
        readFileSync(path.join(codexHome, "moss-shared-continuation-v2.json"), "utf8"),
      ) as { generation?: unknown; version?: unknown };
      expect(marker).toMatchObject({ version: 2, generation });
      expect(existsSync(path.join(codexHome, "moss-shared-continuation-v1.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects replacement or damaged state under a persisted continuation generation", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-codex-generation-replaced-"));
    const codexHome = path.join(root, "codex-home");
    const runtimeHome = path.join(root, "runtime");
    const env = { MOSS_HOME: runtimeHome };
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(path.join(codexHome, "config.toml"), "", "utf8");

    try {
      await buildCodexProcessEnv({ env, homePath: codexHome, platform: "win32" });
      const generation = readCodexSharedContinuationGeneration({ env, homePath: codexHome });
      expect(generation).toBeDefined();
      await expect(
        buildCodexProcessEnv({
          env,
          homePath: codexHome,
          platform: "win32",
          expectedSharedContinuationGeneration: "123e4567-e89b-42d3-a456-426614174000",
        }),
      ).rejects.toThrow(/has generation.*expected/);

      rmSync(path.join(codexHome, "sessions"), { recursive: true, force: true });
      await expect(
        buildCodexProcessEnv({ env, homePath: codexHome, platform: "win32" }),
      ).rejects.toThrow(/missing 'sessions'|refusing to recreate/);
      expect(existsSync(path.join(codexHome, "sessions"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pins app-server continuation and credential-store config at CLI precedence", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-home spaced-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-runtime-home-"));
    writeFileSync(path.join(codexHome, "config.toml"), "", "utf8");

    try {
      const launch = await buildCodexProcessLaunchContext({
        env: {
          MOSS_HOME: runtimeHome,
          CODEX_SQLITE_HOME: path.join(runtimeHome, "inherited-wrong-home"),
        },
        homePath: codexHome,
        platform: "win32",
      });

      expect(launch.env.CODEX_SQLITE_HOME).toBe(codexHome);
      expect(launch.appServerArgs).toEqual([
        "app-server",
        "--config",
        `sqlite_home=${JSON.stringify(codexHome)}`,
        "--config",
        'cli_auth_credentials_store="file"',
      ]);
      expect(launch.appServerArgs).toEqual(buildCodexAppServerArgs(codexHome));
      const quotedPath = path.resolve(codexHome, 'synthetic "quoted"');
      expect(buildCodexAppServerArgs(quotedPath)[2]).toBe(
        `sqlite_home=${JSON.stringify(quotedPath)}`,
      );
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("registers the active custom provider env key for diagnostic redaction", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-provider-key-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-runtime-home-"));
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'model_provider = "acme"',
        "",
        "[model_providers.acme]",
        'env_key = "ACME-LICENSE.INTEGRATION"',
      ].join("\n"),
      "utf8",
    );

    try {
      await buildCodexProcessEnv({
        env: { CODEX_HOME: codexHome, MOSS_HOME: runtimeHome },
        platform: "win32",
      });
      expect(isProviderCredentialKey("ACME-LICENSE.INTEGRATION")).toBe(true);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("pins CODEX_SQLITE_HOME to the source home for the session overlay", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-sqlite-home-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-runtime-home-"));
    const sqliteHome = mkdtempSync(path.join(os.tmpdir(), "moss-user-sqlite-home-"));
    writeFileSync(path.join(codexHome, "config.toml"), 'model = "gpt-5.5"', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: { MOSS_HOME: runtimeHome, CODEX_SQLITE_HOME: sqliteHome },
        homePath: codexHome,
        platform: "win32",
      });

      expect(env.CODEX_HOME).toBe(
        resolveMossCodexHomeOverlayPath(
          { MOSS_HOME: runtimeHome },
          codexHome,
          resolveCodexHomeOverlayAccountSegment({
            homePath: codexHome,
            accountSourceHomeIsDedicated: true,
          }),
        ),
      );
      expect(env.CODEX_SQLITE_HOME).toBe(codexHome);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
      rmSync(sqliteHome, { recursive: true, force: true });
    }
  });

  it("rejects a config sqlite_home that escapes the source Codex home", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-sqlite-config-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-runtime-home-"));
    writeFileSync(path.join(codexHome, "config.toml"), 'sqlite_home = "/tmp/other-codex"', "utf8");

    try {
      await expect(
        buildCodexProcessEnv({
          env: { MOSS_HOME: runtimeHome },
          homePath: codexHome,
          platform: "win32",
        }),
      ).rejects.toThrow(/sqlite_home.*source CODEX_HOME/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("rejects root sqlite_home despite a misleading selected-profile source path", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-sqlite-root-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-runtime-home-"));
    writeFileSync(
      path.join(codexHome, "config.toml"),
      [
        'profile = "work"',
        'sqlite_home = "/tmp/foreign-codex-home"',
        "",
        "[profiles.work]",
        `sqlite_home = ${JSON.stringify(codexHome)}`,
      ].join("\n"),
      "utf8",
    );

    try {
      await expect(
        buildCodexProcessEnv({
          env: { MOSS_HOME: runtimeHome },
          homePath: codexHome,
          platform: "win32",
        }),
      ).rejects.toThrow(/sqlite_home.*source CODEX_HOME/);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("ignores profile sqlite_home lookalikes that Codex does not apply", async () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-sqlite-profile-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-runtime-home-"));
    writeFileSync(
      path.join(codexHome, "config.toml"),
      ['profile = "work"', "", "[profiles.work]", 'sqlite_home = "/tmp/ignored-profile-home"'].join(
        "\n",
      ),
      "utf8",
    );

    try {
      const env = await buildCodexProcessEnv({
        env: { MOSS_HOME: runtimeHome },
        homePath: codexHome,
        platform: "win32",
      });
      expect(env.CODEX_SQLITE_HOME).toBe(codexHome);
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });

  it("replaces a user-defined Moss MCP table only inside the session overlay", async () => {
    const sourceHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-source-"));
    const runtimeHome = mkdtempSync(path.join(os.tmpdir(), "moss-codex-runtime-"));
    const sourceConfig = [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.moss]",
      'url = "http://127.0.0.1:1111/stale-mcp"',
      'bearer_token_env_var = "STALE_GATEWAY_TOKEN"',
      "",
      "[mcp_servers.moss.headers]",
      'Authorization = "stale-inline-secret"',
      "",
      "[mcp_servers.moss.env]",
      'STALE_GATEWAY_TOKEN = "stale-inline-secret"',
      "",
      "[mcp_servers.moss-other]",
      'url = "http://127.0.0.1:2111/moss-other"',
      "",
      "[mcp_servers.user-tool]",
      'url = "http://127.0.0.1:2222/user-tool"',
      "",
      "[shell_environment_policy]",
      'inherit = "core"',
      'exclude = ["USER_SECRET"]',
    ].join("\n");
    const managedConfig = [
      "[mcp_servers.moss]",
      'url = "http://127.0.0.1:3773/mcp"',
      'bearer_token_env_var = "MOSS_AGENT_GATEWAY_TOKEN"',
      "",
      "[shell_environment_policy]",
      'exclude = ["MOSS_AGENT_GATEWAY_TOKEN"]',
    ].join("\n");
    const sourceConfigPath = path.join(sourceHome, "config.toml");
    writeFileSync(sourceConfigPath, sourceConfig, "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        platform: "darwin",
        appendConfigToml: managedConfig,
      });
      const overlayHome = env.CODEX_HOME;
      if (!overlayHome) {
        throw new Error("Expected a Moss Codex home overlay.");
      }
      const overlayConfig = readFileSync(path.join(overlayHome, "config.toml"), "utf8");

      expect(overlayConfig.match(/^\[mcp_servers\.moss\]$/gm)).toHaveLength(1);
      expect(overlayConfig).toContain('url = "http://127.0.0.1:3773/mcp"');
      expect(overlayConfig).toContain('bearer_token_env_var = "MOSS_AGENT_GATEWAY_TOKEN"');
      expect(overlayConfig).not.toContain("http://127.0.0.1:1111/stale-mcp");
      expect(overlayConfig).not.toContain("STALE_GATEWAY_TOKEN");
      expect(overlayConfig).not.toContain("stale-inline-secret");
      expect(overlayConfig).not.toContain("[mcp_servers.moss.headers]");
      expect(overlayConfig).not.toContain("[mcp_servers.moss.env]");
      expect(overlayConfig).toContain(
        '[mcp_servers.moss-other]\nurl = "http://127.0.0.1:2111/moss-other"',
      );
      expect(overlayConfig).toContain(
        '[mcp_servers.user-tool]\nurl = "http://127.0.0.1:2222/user-tool"',
      );
      expect(overlayConfig).toContain('inherit = "core"');
      expect(overlayConfig).toContain('exclude = ["MOSS_AGENT_GATEWAY_TOKEN", "USER_SECRET"]');
      expect(readFileSync(sourceConfigPath, "utf8")).toBe(sourceConfig);
    } finally {
      rmSync(sourceHome, { recursive: true, force: true });
      rmSync(runtimeHome, { recursive: true, force: true });
    }
  });
});

describe("buildCodexProcessEnv account overlays", () => {
  function makeAccountFixture() {
    const root = mkdtempSync(path.join(os.tmpdir(), "moss-codex-account-overlay-"));
    const homePath = path.join(root, "codex-home");
    const shadowHomePath = path.join(root, "codex-shadow-work");
    mkdirSync(homePath, { recursive: true });
    mkdirSync(shadowHomePath, { recursive: true });
    writeFileSync(path.join(homePath, "auth.json"), '{"account":"default"}', "utf8");
    writeFileSync(path.join(homePath, "models_cache.json"), '{"models":[]}', "utf8");
    writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
    return {
      root,
      homePath,
      shadowHomePath,
      env: {
        HOME: root,
        MOSS_HOME: path.join(root, "moss-runtime"),
      } satisfies NodeJS.ProcessEnv,
    };
  }

  it("shares continuation state across account overlays while keeping private state separate", async () => {
    const fixture = makeAccountFixture();
    const personalShadowHomePath = path.join(fixture.root, "codex-shadow-personal");
    mkdirSync(personalShadowHomePath, { recursive: true });
    writeFileSync(path.join(personalShadowHomePath, "auth.json"), '{"account":"personal"}', "utf8");
    writeFileSync(path.join(fixture.shadowHomePath, "auth.json"), '{"account":"work"}', "utf8");

    try {
      const personalEnv = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: personalShadowHomePath,
        accountId: "personal",
        platform: "win32",
      });
      expect(personalEnv.CODEX_HOME).toBeTruthy();
      expect(personalEnv.CODEX_SQLITE_HOME).toBe(fixture.homePath);
      expect(
        isCodexSharedContinuationStatePrepared({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: personalShadowHomePath,
          accountId: "personal",
        }),
      ).toBe(true);
      const personalSessionsPath = path.join(personalEnv.CODEX_HOME!, "sessions");
      expect(lstatSync(personalSessionsPath).isSymbolicLink()).toBe(true);
      writeFileSync(path.join(personalSessionsPath, "thread-personal.jsonl"), "personal", "utf8");

      const workEnv = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
        platform: "win32",
      });
      expect(workEnv.CODEX_HOME).not.toBe(personalEnv.CODEX_HOME);
      expect(workEnv.CODEX_SQLITE_HOME).toBe(fixture.homePath);
      expect(
        readFileSync(path.join(workEnv.CODEX_HOME!, "sessions", "thread-personal.jsonl"), "utf8"),
      ).toBe("personal");
      await expectCodexOverlayPrivateFile(
        path.join(workEnv.CODEX_HOME!, "auth.json"),
        path.join(fixture.shadowHomePath, "auth.json"),
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("preserves legacy-only continuation state and requires an explicit migration", async () => {
    const fixture = makeAccountFixture();
    writeFileSync(path.join(fixture.shadowHomePath, "auth.json"), '{"account":"work"}', "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
    });
    mkdirSync(path.join(overlayHomePath, "sessions"), { recursive: true });
    writeFileSync(path.join(overlayHomePath, "sessions", "legacy.jsonl"), "legacy", "utf8");

    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
        }),
      ).rejects.toThrow(/refusing to migrate legacy state automatically/);
      expect(readFileSync(path.join(overlayHomePath, "sessions", "legacy.jsonl"), "utf8")).toBe(
        "legacy",
      );
      expect(() => lstatSync(path.join(fixture.homePath, "sessions"))).toThrow();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("links account-private auth from the shadow home instead of the shared home", async () => {
    const fixture = makeAccountFixture();
    const shadowAuthPath = path.join(fixture.shadowHomePath, "auth.json");
    writeFileSync(shadowAuthPath, '{"account":"work"}', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
        platform: "win32",
      });

      expect(env.CODEX_HOME).toBeTruthy();
      expect(path.resolve(env.CODEX_HOME!)).not.toBe(path.resolve(fixture.homePath));
      const overlayAuthPath = path.join(env.CODEX_HOME!, "auth.json");
      await expectCodexOverlayPrivateFile(overlayAuthPath, shadowAuthPath);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails when shadow-home auth can neither be linked nor copied into the account overlay", async () => {
    const fixture = makeAccountFixture();
    writeFileSync(path.join(fixture.shadowHomePath, "auth.json"), '{"account":"work"}', "utf8");
    const firstEnv = await buildCodexProcessEnv({
      env: fixture.env,
      homePath: fixture.homePath,
      shadowHomePath: fixture.shadowHomePath,
      accountId: "work",
      platform: "win32",
    });
    const overlayHomePath = firstEnv.CODEX_HOME;
    expect(overlayHomePath).toBeTruthy();
    if (!overlayHomePath) {
      throw new Error("Expected Codex overlay home path.");
    }
    unlinkSync(path.join(overlayHomePath, "auth.json"));
    const denied = Object.assign(new Error("EACCES: synthetic private-file permission denied"), {
      code: "EACCES",
    });
    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath,
          accountId: "work",
          platform: "win32",
          overlayEntryLinker: {
            symlink: async () => {
              throw denied;
            },
            copyFile: async () => {
              throw denied;
            },
          },
        }),
      ).rejects.toThrow(/EACCES|EPERM/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("tolerates shadow homes with no auth state yet", async () => {
    const fixture = makeAccountFixture();

    try {
      const env = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath,
        accountId: "work",
        platform: "win32",
      });

      expect(env.CODEX_HOME).toBeTruthy();
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it.each(["auth.json", "models_cache.json"] as const)(
    "rejects shadow-home %s state that is itself a symlink",
    async (entryName) => {
      const fixture = makeAccountFixture();
      await createCodexAliasFixture(
        path.join(fixture.homePath, "auth.json"),
        path.join(fixture.shadowHomePath, entryName),
      );

      try {
        await expect(
          buildCodexProcessEnv({
            env: fixture.env,
            homePath: fixture.homePath,
            shadowHomePath: fixture.shadowHomePath,
            accountId: "work",
            platform: "win32",
          }),
        ).rejects.toThrow(/is a symlink/);
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a shadow home directory that is itself a symlink", async () => {
    const fixture = makeAccountFixture();
    const aliasedShadowHome = path.join(path.dirname(fixture.shadowHomePath), "codex-shadow-alias");
    rmSync(fixture.shadowHomePath, { recursive: true, force: true });
    await createCodexAliasFixture(fixture.homePath, aliasedShadowHome, "dir");

    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: aliasedShadowHome,
          accountId: "work",
          platform: "win32",
        }),
      ).rejects.toThrow(/shadow home/i);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a shadow home reached through a parent symlink that aliases CODEX_HOME", async () => {
    const fixture = makeAccountFixture();
    const aliasedParent = path.join(fixture.root, "aliased-parent");
    await createCodexAliasFixture(fixture.root, aliasedParent, "dir");

    try {
      await expect(
        buildCodexProcessEnv({
          env: fixture.env,
          homePath: fixture.homePath,
          shadowHomePath: path.join(aliasedParent, path.basename(fixture.homePath)),
          accountId: "work",
          platform: "win32",
        }),
      ).rejects.toThrow(/different from CODEX_HOME/);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps an explicitly repeated shared home isolated", async () => {
    const fixture = makeAccountFixture();
    const sharedEnv = {
      ...fixture.env,
      CODEX_HOME: fixture.homePath,
    };
    writeFileSync(path.join(fixture.homePath, "config.toml"), 'model = "gpt-5.4"\n', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: sharedEnv,
        homePath: fixture.homePath,
        accountId: "work",
        platform: "win32",
      });

      const accountHomePath = env.CODEX_HOME;
      expect(accountHomePath).toBeTruthy();
      expect(path.resolve(accountHomePath!)).not.toBe(path.resolve(fixture.homePath));
      expect(() => lstatSync(path.join(accountHomePath!, "auth.json"))).toThrow();
      expect(readFileSync(path.join(accountHomePath!, "config.toml"), "utf8")).toContain(
        'model = "gpt-5.4"',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("mirrors private state only from a distinct dedicated home", async () => {
    const fixture = makeAccountFixture();
    const dedicatedHomePath = path.join(fixture.root, "codex-work-home");
    mkdirSync(dedicatedHomePath, { recursive: true });
    writeFileSync(path.join(dedicatedHomePath, "auth.json"), '{"account":"work"}', "utf8");

    try {
      const env = await buildCodexProcessEnv({
        env: {
          ...fixture.env,
          CODEX_HOME: fixture.homePath,
        },
        homePath: dedicatedHomePath,
        accountId: "work",
        platform: "win32",
      });

      const accountHomePath = env.CODEX_HOME;
      expect(accountHomePath).toBeTruthy();
      expect(path.resolve(accountHomePath!)).not.toBe(path.resolve(dedicatedHomePath));
      expect(readFileSync(path.join(accountHomePath!, "auth.json"), "utf8")).toBe(
        '{"account":"work"}',
      );
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("keeps shared auth out of account overlays without a shadow home", async () => {
    const fixture = makeAccountFixture();
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };

    try {
      const env = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });

      const overlayHomePath = env.CODEX_HOME;
      expect(overlayHomePath).toBeTruthy();
      expect(path.resolve(overlayHomePath!)).not.toBe(path.resolve(fixture.homePath));
      for (const entry of ["auth.json", "models_cache.json"]) {
        expect(() => lstatSync(path.join(overlayHomePath!, entry))).toThrow();
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("mirrors private auth from an account's own dedicated home", async () => {
    const fixture = makeAccountFixture();

    try {
      const env = await buildCodexProcessEnv({
        env: fixture.env,
        homePath: fixture.homePath,
        accountId: "work",
        platform: "win32",
      });

      const overlayHomePath = env.CODEX_HOME;
      expect(overlayHomePath).toBeTruthy();
      for (const entry of ["auth.json", "models_cache.json"]) {
        const overlayPrivateStatePath = path.join(overlayHomePath!, entry);
        await expectCodexOverlayPrivateFile(
          overlayPrivateStatePath,
          path.join(fixture.homePath, entry),
        );
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a forced-copy launch when authoritative auth changes after the copy", async () => {
    const fixture = makeAccountFixture();
    const sourceAuthPath = path.join(fixture.homePath, "auth.json");
    const firstAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "workspace-first", access_token: "first" },
    });
    const secondAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "workspace-second", access_token: "second" },
    });
    writeFileSync(sourceAuthPath, firstAuth, "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
    });
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    const raceAfterAuthCopy: CodexOverlayEntryLinker = {
      link: async (sourcePath, targetPath) => {
        linkSync(sourcePath, targetPath);
      },
      symlink: vi.fn(async (sourcePath, targetPath, type) => {
        if (type === "file" && path.basename(String(targetPath)) === "auth.json") {
          throw new Error("file symlinks unavailable");
        }
        symlinkSync(sourcePath, targetPath, type);
      }),
      copyFile: vi.fn(async (sourcePath, targetPath) => {
        copyFileSync(sourcePath, targetPath);
        if (path.basename(String(targetPath)) === "auth.json") {
          writeFileSync(sourcePath, secondAuth, "utf8");
        }
      }),
    };

    try {
      await expect(
        buildCodexProcessLaunchContext({
          env: fixture.env,
          homePath: fixture.homePath,
          platform: "win32",
          overlayEntryLinker: raceAfterAuthCopy,
        }),
      ).rejects.toThrow(/authentication changed during app-server launch preparation/);
      expect(readFileSync(overlayAuthPath, "utf8")).toBe(firstAuth);
      expect(readFileSync(sourceAuthPath, "utf8")).toBe(secondAuth);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an A-to-B-to-A race that leaves fallback auth on the wrong account", async () => {
    const fixture = makeAccountFixture();
    const sourceAuthPath = path.join(fixture.homePath, "auth.json");
    const firstAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "workspace-first", access_token: "first" },
    });
    const secondAuth = JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { account_id: "workspace-second", access_token: "second" },
    });
    writeFileSync(sourceAuthPath, firstAuth, "utf8");
    const overlayHomePath = resolveActiveCodexHomeWritePath({
      env: fixture.env,
      homePath: fixture.homePath,
    });
    const overlayAuthPath = path.join(overlayHomePath, "auth.json");
    const copyWhileAuthoritativeTemporarilyChanges: CodexOverlayEntryLinker = {
      link: async (sourcePath, targetPath) => {
        linkSync(sourcePath, targetPath);
      },
      symlink: vi.fn(async (sourcePath, targetPath, type) => {
        if (type === "file" && path.basename(String(targetPath)) === "auth.json") {
          throw new Error("file symlinks unavailable");
        }
        symlinkSync(sourcePath, targetPath, type);
      }),
      copyFile: vi.fn(async (sourcePath, targetPath) => {
        if (path.basename(String(targetPath)) !== "auth.json") {
          copyFileSync(sourcePath, targetPath);
          return;
        }
        writeFileSync(sourcePath, secondAuth, "utf8");
        copyFileSync(sourcePath, targetPath);
        writeFileSync(sourcePath, firstAuth, "utf8");
      }),
    };

    try {
      await expect(
        buildCodexProcessLaunchContext({
          env: fixture.env,
          homePath: fixture.homePath,
          platform: "win32",
          overlayEntryLinker: copyWhileAuthoritativeTemporarilyChanges,
        }),
      ).rejects.toThrow(/authentication did not match the authoritative account/);
      expect(readFileSync(sourceAuthPath, "utf8")).toBe(firstAuth);
      expect(readFileSync(overlayAuthPath, "utf8")).toBe(secondAuth);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("drops legacy shared-auth aliases from account overlays and keeps own logins", async () => {
    const fixture = makeAccountFixture();
    const sharedEnv = { ...fixture.env, CODEX_HOME: fixture.homePath };

    try {
      const firstEnv = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });
      const overlayHomePath = firstEnv.CODEX_HOME;
      expect(overlayHomePath).toBeTruthy();
      // Simulate legacy overlay state that symlinked shared private files in.
      for (const entry of ["auth.json", "models_cache.json"]) {
        await createCodexAliasFixture(
          path.join(fixture.homePath, entry),
          path.join(overlayHomePath!, entry),
        );
      }

      const secondEnv = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });
      expect(secondEnv.CODEX_HOME).toBe(overlayHomePath);
      for (const entry of ["auth.json", "models_cache.json"]) {
        expect(() => lstatSync(path.join(overlayHomePath!, entry))).toThrow();
      }

      // The account's own real private files must survive re-preparation.
      writeFileSync(path.join(overlayHomePath!, "auth.json"), '{"account":"work"}', "utf8");
      writeFileSync(path.join(overlayHomePath!, "models_cache.json"), '{"models":[]}', "utf8");
      const thirdEnv = await buildCodexProcessEnv({
        env: sharedEnv,
        accountId: "work",
        platform: "win32",
      });
      expect(thirdEnv.CODEX_HOME).toBe(overlayHomePath);
      for (const entry of ["auth.json", "models_cache.json"]) {
        expect(lstatSync(path.join(overlayHomePath!, entry)).isFile()).toBe(true);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
