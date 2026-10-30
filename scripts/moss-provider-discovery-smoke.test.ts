import { describe, expect, it } from "vitest";

import {
  mossProviderDiscoverySmokeExitCode,
  runMossProviderDiscoverySmoke,
} from "./moss-provider-discovery-smoke.ts";

describe("moss-provider-discovery-smoke", () => {
  it("exercises ProviderDiscoveryService capabilities, skills, plugins, and models", async () => {
    const report = await runMossProviderDiscoverySmoke({
      createdAt: "2026-07-03T04:05:00.000+08:00",
      cwd: process.cwd(),
    });

    expect(report.readiness.status).toBe("pass");
    expect(mossProviderDiscoverySmokeExitCode(report)).toBe(0);
    expect(report.provider).toBe("codex");
    expect(report.runtimeBoundary).toBe("ProviderDiscoveryServiceLive");
    expect(report.providerCredentialsRequired).toBe(false);
    expect(report.writesGlobalConfig).toBe(false);
    expect(report.operations.map((operation) => operation.id)).toEqual([
      "getComposerCapabilities",
      "listSkills",
      "listPlugins",
      "listModels",
    ]);
    expect(report.adapterInvocationOrder).toEqual([
      "getByProvider:codex",
      "getComposerCapabilities",
      "getByProvider:codex",
      "listSkills:codex",
      "getByProvider:codex",
      "listPlugins:codex",
      "getByProvider:codex",
      "listModels:codex",
    ]);
    expect(report.operations.find((operation) => operation.id === "listSkills")).toMatchObject({
      source: "codex-smoke-adapter+moss.catalog",
      items: expect.arrayContaining(["moss-native-smoke-skill", "moss-portable-smoke-skill"]),
    });
    expect(report.operations.find((operation) => operation.id === "listPlugins")).toMatchObject({
      source: "codex-smoke-adapter",
      items: ["moss-provider-smoke-plugin"],
    });
    expect(report.operations.find((operation) => operation.id === "listModels")).toMatchObject({
      source: "codex-smoke-adapter",
      items: ["moss-smoke-model"],
    });
  }, 15_000);
});
