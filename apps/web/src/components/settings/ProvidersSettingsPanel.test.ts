import { describe, expect, it } from "vitest";

import { AppSettingsSchema } from "~/appSettings";

import {
  createProviderInstallResetPatch,
  isProviderInstallSettingsDirty,
  providerInstallCommandFor,
  providerInstanceLaunchConfigFor,
  withCnMirrorRegistry,
} from "./ProvidersSettingsPanel";

const defaults = AppSettingsSchema.makeUnsafe({});

describe("isProviderInstallSettingsDirty", () => {
  it("uses configured flags instead of unreadable password values", () => {
    expect(
      isProviderInstallSettingsDirty({ ...defaults, openCodeServerPassword: "secret" }, defaults),
    ).toBe(false);
    expect(
      isProviderInstallSettingsDirty(
        { ...defaults, openCodeServerPasswordConfigured: true },
        defaults,
      ),
    ).toBe(true);
  });
});

describe("createProviderInstallResetPatch", () => {
  it("resets every configured field and writes password values so configured flags clear", () => {
    const patch = createProviderInstallResetPatch({
      ...defaults,
      openCodeServerPassword: "",
    });

    expect(Object.keys(patch).sort()).toEqual(
      [
        "antigravityBinaryPath",
        "claudeBinaryPath",
        "claudeEnableArtifacts",
        "claudeHomePath",
        "codexAccounts",
        "codexBinaryPath",
        "codexHomePath",
        "cursorApiEndpoint",
        "cursorBinaryPath",
        "devinBinaryPath",
        "droidBinaryPath",
        "grokBinaryPath",
        "kimiBinaryPath",
        "minimaxBinaryPath",
        "ompAgentDir",
        "ompBinaryPath",
        "openCodeBinaryPath",
        "openCodeExperimentalWebSockets",
        "openCodeServerPassword",
        "openCodeServerUrl",
        "piAgentDir",
        "piBinaryPath",
        "providerInstances",
        "selectedCodexAccountId",
        "zcodeBinaryPath",
      ].sort(),
    );
    expect(patch.openCodeServerPassword).toBe("");
  });
});

describe("providerInstanceLaunchConfigFor", () => {
  it("maps Pi-family agent directories to agentDir, not binaryPath", () => {
    expect(
      providerInstanceLaunchConfigFor("omp", {
        ...defaults,
        ompBinaryPath: "/usr/local/bin/omp",
        ompAgentDir: "~/.omp-work/agent",
      }),
    ).toEqual({ binaryPath: "/usr/local/bin/omp", agentDir: "~/.omp-work/agent" });
    expect(
      providerInstanceLaunchConfigFor("pi", { ...defaults, piAgentDir: "~/.pi-work/agent" }),
    ).toEqual({ agentDir: "~/.pi-work/agent" });
  });

  it("seeds ACP agent accounts from their binary path fields", () => {
    expect(
      providerInstanceLaunchConfigFor("kimi", { ...defaults, kimiBinaryPath: "/opt/bin/kimi" }),
    ).toEqual({ binaryPath: "/opt/bin/kimi" });
    expect(
      providerInstanceLaunchConfigFor("minimax", {
        ...defaults,
        minimaxBinaryPath: "/opt/bin/mcode",
      }),
    ).toEqual({ binaryPath: "/opt/bin/mcode" });
    expect(
      providerInstanceLaunchConfigFor("zcode", {
        ...defaults,
        zcodeBinaryPath: "/opt/bin/zcode-acp-server",
      }),
    ).toEqual({ binaryPath: "/opt/bin/zcode-acp-server" });
  });

  it("keeps the Claude binary path and leaves the provider-wide Artifacts setting out", () => {
    expect(
      providerInstanceLaunchConfigFor("claudeAgent", {
        ...defaults,
        claudeBinaryPath: "/opt/homebrew/bin/claude",
        claudeEnableArtifacts: true,
      }),
    ).toEqual({ binaryPath: "/opt/homebrew/bin/claude" });
  });
});

describe("providerInstallCommandFor", () => {
  it("shows the official npm install for the ACP agents and nothing for self-installing CLIs", () => {
    expect(providerInstallCommandFor("kimi")).toBe("npm install -g @moonshot-ai/kimi-code");
    // MiniMax Code's README command: its native better-sqlite3 dependency needs install scripts.
    expect(providerInstallCommandFor("minimax")).toBe(
      "npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3",
    );
    expect(providerInstallCommandFor("zcode")).toBe("npm install -g zcode-acp-server");
    expect(withCnMirrorRegistry("npm install -g zcode-acp-server")).toBe(
      "npm install -g --registry=https://registry.npmmirror.com zcode-acp-server",
    );
    expect(providerInstallCommandFor("codex")).toBeNull();
    expect(providerInstallCommandFor("hermes")).toBeNull();
  });
});
