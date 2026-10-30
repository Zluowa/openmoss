import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mossProviderDiscoverySmokeGateExitCode,
  readMossProviderDiscoverySmokeGate,
} from "./moss-provider-discovery-smoke-gate.ts";

const CREATED_AT = "2026-07-03T04:05:00.000+08:00";
const REPORT_PATH = ".moss/ledger/evidence/moss-provider-discovery-smoke-2026-07-03.json";

function withTempRepo<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-provider-discovery-smoke-gate-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeRepoFile(root: string, path: string, body: string): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, body, "utf8");
}

function buildPassingReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    createdAt: CREATED_AT,
    provider: "codex",
    cwd: "/repo",
    runtimeBoundary: "ProviderDiscoveryServiceLive",
    providerCredentialsRequired: false,
    writesGlobalConfig: false,
    requiredOperations: ["getComposerCapabilities", "listSkills", "listPlugins", "listModels"],
    adapterInvocationOrder: [
      "getByProvider:codex",
      "getComposerCapabilities",
      "listSkills:codex",
      "listPlugins:codex",
      "listModels:codex",
    ],
    operations: [
      {
        id: "getComposerCapabilities",
        status: "pass",
        source: "ProviderDiscoveryServiceLive",
        count: 1,
        items: ["codex"],
        supportsSkillDiscovery: true,
        supportsPluginDiscovery: true,
        supportsRuntimeModelList: true,
      },
      {
        id: "listSkills",
        status: "pass",
        source: "codex-smoke-adapter+moss.catalog",
        count: 2,
        items: ["moss-native-smoke-skill", "moss-portable-smoke-skill"],
      },
      {
        id: "listPlugins",
        status: "pass",
        source: "codex-smoke-adapter",
        count: 1,
        items: ["moss-provider-smoke-plugin"],
      },
      {
        id: "listModels",
        status: "pass",
        source: "codex-smoke-adapter",
        count: 1,
        items: ["moss-smoke-model"],
      },
    ],
    expectations: {
      skillNames: ["moss-native-smoke-skill", "moss-portable-smoke-skill"],
      pluginNames: ["moss-provider-smoke-plugin"],
      modelSlugs: ["moss-smoke-model"],
    },
    readiness: {
      status: "pass",
      summary: "pass",
    },
    ...overrides,
  };
}

function writePassingEvidence(root: string, overrides: Record<string, unknown> = {}): void {
  writeRepoFile(root, REPORT_PATH, `${JSON.stringify(buildPassingReport(overrides))}\n`);
}

describe("moss-provider-discovery-smoke-gate", () => {
  it("passes with current provider discovery smoke evidence", () => {
    withTempRepo((root) => {
      writePassingEvidence(root);

      const report = readMossProviderDiscoverySmokeGate(root, { createdAt: CREATED_AT });

      expect(report.readiness.status).toBe("pass");
      expect(report.report).toMatchObject({
        createdAt: CREATED_AT,
        provider: "codex",
        runtimeBoundary: "ProviderDiscoveryServiceLive",
        providerCredentialsRequired: false,
        writesGlobalConfig: false,
        operationCount: 4,
        adapterInvocationCount: 5,
        readinessStatus: "pass",
      });
      expect(report.operations.map((operation) => operation.id)).toEqual([
        "getComposerCapabilities",
        "listSkills",
        "listPlugins",
        "listModels",
      ]);
      expect(report.issues).toEqual([]);
      expect(mossProviderDiscoverySmokeGateExitCode(report)).toBe(0);
      expect(JSON.stringify(report)).not.toContain("rawSource");
    });
  });

  it("fails deterministically when the report is missing", () => {
    withTempRepo((root) => {
      const report = readMossProviderDiscoverySmokeGate(root, { createdAt: CREATED_AT });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual(["missing-report"]);
      expect(mossProviderDiscoverySmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails stale reports and missing runtime discovery operations", () => {
    withTempRepo((root) => {
      writePassingEvidence(root, {
        createdAt: "2026-07-02T04:05:00.000+08:00",
        operations: (buildPassingReport().operations as unknown[]).slice(0, 3),
        adapterInvocationOrder: ["getByProvider:codex", "getComposerCapabilities"],
      });

      const report = readMossProviderDiscoverySmokeGate(root, { createdAt: CREATED_AT });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual([
        "stale-report-date",
        "missing-operation",
        "missing-adapter-invocation",
        "missing-adapter-invocation",
        "missing-adapter-invocation",
        "missing-model",
      ]);
    });
  });

  it("fails when the smoke claims credentials or omits expected items", () => {
    withTempRepo((root) => {
      writePassingEvidence(root, {
        providerCredentialsRequired: true,
        writesGlobalConfig: true,
        readiness: { status: "fail", summary: "bad" },
        operations: [
          {
            id: "getComposerCapabilities",
            status: "pass",
            supportsSkillDiscovery: true,
            supportsPluginDiscovery: false,
            supportsRuntimeModelList: true,
          },
          { id: "listSkills", status: "pass", items: ["moss-native-smoke-skill"] },
          { id: "listPlugins", status: "pass", items: [] },
          { id: "listModels", status: "pass", items: [] },
        ],
      });

      const report = readMossProviderDiscoverySmokeGate(root, { createdAt: CREATED_AT });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual([
        "requires-provider-credentials",
        "writes-global-config",
        "smoke-readiness-failed",
        "missing-capability",
        "missing-skill",
        "missing-plugin",
        "missing-model",
      ]);
    });
  });
});
