// FILE: providerTerminalProfiles.test.ts
// Purpose: Verify provider settings become isolated, shell-neutral terminal profiles.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@synara/contracts";

import { deriveManagedTerminalProfiles } from "./providerTerminalProfiles.ts";
import { buildMossManagedHomeOwnershipMarker } from "../account/mossManagedHomeAuthority.ts";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "moss-provider-profiles-"));
  roots.push(root);
  const binDir = path.join(root, "bin");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return { root, binDir, homeDir, stateDir };
}

function installCli(binDir: string, name: string): void {
  // Discovery inspects these files without launching them. Match native PATH
  // semantics so Windows can resolve the fixture through PATHEXT as well.
  const filename = process.platform === "win32" ? `${name}.cmd` : name;
  const contents = process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n";
  writeFileSync(path.join(binDir, filename), contents, { mode: 0o755 });
}

describe("deriveManagedTerminalProfiles", () => {
  it("requires live server reservation readers for a Windows managed terminal", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const { homeDir, stateDir } = fixture();
    const homePath = path.join(stateDir, "moss-codex-home");
    mkdirSync(homePath);
    // Resolve this command without executing it, including on POSIX test hosts.
    const binaryPath = path.join(stateDir, "codex-test.exe");
    writeFileSync(binaryPath, "path resolution fixture only\n");
    const nonce = "36c13d2e-b511-4acf-8ac1-16dfdc746dc3";
    writeFileSync(
      path.join(homePath, ".moss-managed-home"),
      buildMossManagedHomeOwnershipMarker(nonce),
    );
    writeFileSync(path.join(homePath, "config.toml"), 'model_provider = "moss"\n');
    const settings: ServerSettings = {
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
          driver: "codex",
          enabled: true,
          config: {
            binaryPath,
            managed: true,
            accountId: "moss",
            homePath,
            homeOwnershipNonce: nonce,
          },
        },
      },
    };
    const input = { settings, onlyInstanceId: "codex_moss", baseEnv: {}, homeDir, stateDir };
    await expect(deriveManagedTerminalProfiles(input)).rejects.toThrow(
      /authority|authorization|reservation/i,
    );
    const profiles = await deriveManagedTerminalProfiles({
      ...input,
      readSettings: async () => settings,
      readSettingsSync: () => settings,
    });
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.environment.CODEX_HOME).toBe(homePath);
    expect(profiles[0]?.environment.CODEX_SQLITE_HOME).toBe(homePath);
    expect(profiles[0]?.environment).not.toHaveProperty("managedHomeAuthority");
    await expect(
      deriveManagedTerminalProfiles({
        ...input,
        readSettings: async () => DEFAULT_SERVER_SETTINGS,
        readSettingsSync: () => DEFAULT_SERVER_SETTINGS,
      }),
    ).rejects.toThrow("server reservation");
  });

  it("maps Claude config paths and omits sensitive environment", async () => {
    const { binDir, homeDir, stateDir } = fixture();
    installCli(binDir, "claude");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        claude_work: {
          driver: "claudeAgent",
          config: { configDir: "~/.claude-work", cliAlias: "claude-acme" },
          environment: [
            { name: "ANTHROPIC_API_KEY", value: "secret-value", sensitive: true },
            { name: "CLAUDE_CODE_MAX_OUTPUT_CHARS", value: "10000", sensitive: false },
          ],
        },
      },
    };

    const profiles = await deriveManagedTerminalProfiles({
      settings,
      baseEnv: { PATH: binDir, HOME: homeDir },
      homeDir,
      stateDir,
    });
    const profile = profiles.find((candidate) => candidate.commandName === "claude-acme");

    expect(profile?.environment.CLAUDE_CONFIG_DIR).toBe(path.join(homeDir, ".claude-work"));
    expect(profile?.environment.CLAUDE_CODE_MAX_OUTPUT_CHARS).toBe("10000");
    expect(profile?.environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(profile?.omittedSensitiveEnvironmentNames).toContain("ANTHROPIC_API_KEY");
  });

  it("maps an imported Pi directory to the CLI environment", async () => {
    const { binDir, homeDir, stateDir, root } = fixture();
    installCli(binDir, "pi");
    const imported = path.join(root, "existing-pi");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        pi_work: { driver: "pi", config: { agentDir: imported } },
      },
    };

    const profiles = await deriveManagedTerminalProfiles({
      settings,
      baseEnv: { PATH: binDir, HOME: homeDir },
      homeDir,
      stateDir,
    });

    expect(
      profiles.find((profile) => profile.commandName === "pi-work")?.environment,
    ).toMatchObject({ PI_CODING_AGENT_DIR: imported });
  });

  it.each([
    ["antigravity", "agy"],
    ["droid", "droid"],
  ] as const)(
    "does not isolate the default %s profile through its internal driver alias",
    async (provider, executable) => {
      const { binDir, homeDir, stateDir } = fixture();
      installCli(binDir, executable);

      const profiles = await deriveManagedTerminalProfiles({
        settings: DEFAULT_SERVER_SETTINGS,
        baseEnv: { PATH: binDir, HOME: homeDir },
        homeDir,
        stateDir,
      });
      const profile = profiles.find(
        (candidate) => candidate.commandName === `${executable}-default`,
      );

      expect(profile?.isolateEnvironment).toBe(false);
      expect(profile?.environment.HOME).toBe(homeDir);
    },
  );

  it("preserves an imported Devin profile directory", async () => {
    const { binDir, homeDir, stateDir, root } = fixture();
    installCli(binDir, "devin");
    const imported = path.join(root, "existing-devin");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        devin_work: { driver: "devin", config: { profileDir: imported } },
      },
    };

    const profiles = await deriveManagedTerminalProfiles({
      settings,
      baseEnv: { PATH: binDir, HOME: homeDir },
      homeDir,
      stateDir,
    });

    expect(profiles.find((profile) => profile.commandName === "devin-work")?.environment.HOME).toBe(
      imported,
    );
  });

  it("isolates an explicitly imported directory on a default profile", async () => {
    const { binDir, homeDir, stateDir, root } = fixture();
    installCli(binDir, "cursor-agent");
    const imported = path.join(root, "existing-cursor");
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        cursor: { driver: "cursor", config: { profileDir: imported } },
      },
    };

    const profiles = await deriveManagedTerminalProfiles({
      settings,
      baseEnv: { PATH: binDir, HOME: homeDir },
      homeDir,
      stateDir,
    });
    const profile = profiles.find((candidate) => candidate.commandName === "cursor-agent-default");

    expect(profile?.isolateEnvironment).toBe(true);
    expect(profile?.environment.CURSOR_CONFIG_DIR).toBe(imported);
  });
});
