import { describe, expect, it } from "vitest";

import {
  providerInstanceModelsQueryOptions,
  selectProviderInstanceModelQuery,
} from "./providerInstanceModelDiscovery";

const settings = {
  claudeBinaryPath: "",
  codexAccounts: [],
  codexBinaryPath: "",
  codexHomePath: "",
  cursorApiEndpoint: "",
  cursorBinaryPath: "",
  geminiBinaryPath: "",
  hermesBinaryPath: "",
  antigravityBinaryPath: "",
  devinBinaryPath: "",
  droidBinaryPath: "",
  grokBinaryPath: "",
  openCodeBinaryPath: "",
  openCodeExperimentalWebSockets: false,
  openCodeServerPassword: "",
  openCodeServerUrl: "",
  piAgentDir: "",
  piBinaryPath: "",
  ompBinaryPath: "",
  ompAgentDir: "",
  kimiBinaryPath: "",
  minimaxBinaryPath: "",
  zcodeBinaryPath: "",
  selectedCodexAccountId: "default",
  providerInstances: {
    opencode_personal: {
      driver: "opencode" as const,
      enabled: true,
      config: { binaryPath: "/personal/bin/opencode" },
    },
    opencode_work: {
      driver: "opencode" as const,
      enabled: true,
      config: { binaryPath: "/work/bin/opencode", serverUrl: "http://127.0.0.1:7777" },
    },
  },
};

describe("provider instance model discovery", () => {
  it("isolates OpenCode query keys by exact instance and cwd", () => {
    const work = providerInstanceModelsQueryOptions({
      settings,
      provider: "opencode",
      instanceId: "opencode_work",
      cwd: "/repo/work",
      enabled: true,
    });
    const personal = providerInstanceModelsQueryOptions({
      settings,
      provider: "opencode",
      instanceId: "opencode_personal",
      cwd: "/repo/work",
      enabled: true,
    });
    const otherCwd = providerInstanceModelsQueryOptions({
      settings,
      provider: "opencode",
      instanceId: "opencode_work",
      cwd: "/repo/other",
      enabled: true,
    });

    expect(work.queryKey).toContain("opencode_work");
    expect(work.queryKey).toContain("/work/bin/opencode");
    expect(work.queryKey).toContain("http://127.0.0.1:7777");
    expect(work.queryKey.at(-1)).toBe("/repo/work");
    expect(work.queryKey).not.toEqual(personal.queryKey);
    expect(work.queryKey).not.toEqual(otherCwd.queryKey);
  });

  it("selects the exact instance query", () => {
    const providerInstances = [
      { instanceId: "opencode" as const },
      { instanceId: "opencode_work" as const },
    ];
    const queries = [{ value: "default" }, { value: "work" }];

    expect(
      selectProviderInstanceModelQuery({
        providerInstances,
        queries,
        selectedInstanceId: "opencode_work",
      }),
    ).toEqual({ value: "work" });
  });
});
