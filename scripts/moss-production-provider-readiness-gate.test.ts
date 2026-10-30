import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mossProductionProviderReadinessGateExitCode,
  readMossProductionProviderReadinessGate,
} from "./moss-production-provider-readiness-gate.ts";

const CREATED_AT = "2026-07-03T17:45:00.000+08:00";
const REPORT_PATH = ".moss/ledger/evidence/moss-production-provider-readiness-2026-07-03.json";

function withTempRepo<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-production-provider-readiness-gate-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeReport(root: string, report: Record<string, unknown>): void {
  const absolutePath = join(root, REPORT_PATH);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    createdAt: CREATED_AT,
    cwd: "/tmp/moss",
    runtimeBoundary: "ProviderHealthLive",
    productionProviderEvidence: true,
    fixtureBacked: false,
    providerCredentialsRequired: true,
    writesGlobalConfig: false,
    writesGlobalConfigPaths: [],
    runtimeStateScope: "temporary",
    requiredProvider: "codex",
    providers: [
      {
        provider: "codex",
        source: "ProviderHealthLive",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        usable: true,
        checkedAt: CREATED_AT,
        version: "1.0.0",
      },
    ],
    acceptedProviders: ["codex"],
    blockedProviders: [],
    acceptance: {
      status: "pass",
      requiredProviderUsable: true,
      summary: "Production provider readiness captured with 1 usable provider(s).",
    },
    fullCodexParityClaim: false,
    ...overrides,
  };
}

describe("moss-production-provider-readiness-gate", () => {
  it("passes when a real ProviderHealthLive report has a usable Codex provider", () =>
    withTempRepo((root) => {
      writeReport(root, baseReport());

      const gate = readMossProductionProviderReadinessGate(root, { createdAt: CREATED_AT });

      expect(gate.readiness.status).toBe("pass");
      expect(mossProductionProviderReadinessGateExitCode(gate)).toBe(0);
      expect(gate.report?.acceptanceStatus).toBe("pass");
      expect(gate.providers).toHaveLength(1);
      expect(gate.providers[0]?.usable).toBe(true);
    }));

  it("passes blocked-with-evidence when the production provider is explicitly blocked", () =>
    withTempRepo((root) => {
      writeReport(
        root,
        baseReport({
          providers: [
            {
              provider: "codex",
              source: "ProviderHealthLive",
              status: "error",
              available: true,
              authStatus: "unauthenticated",
              usable: false,
              checkedAt: CREATED_AT,
              blockingReason: "Codex CLI is not authenticated. Run `codex login` and try again.",
            },
          ],
          acceptedProviders: [],
          blockedProviders: ["codex"],
          acceptance: {
            status: "blocked-with-evidence",
            requiredProviderUsable: false,
            summary:
              "Production provider readiness is blocked, with explicit provider evidence recorded.",
            blockerSummary: "No usable production provider was confirmed. codex blocked.",
          },
        }),
      );

      const gate = readMossProductionProviderReadinessGate(root, { createdAt: CREATED_AT });

      expect(gate.readiness.status).toBe("pass");
      expect(gate.report?.acceptanceStatus).toBe("blocked-with-evidence");
      expect(gate.providers[0]?.blockingReason).toContain("not authenticated");
    }));

  it("fails fixture-backed reports", () =>
    withTempRepo((root) => {
      writeReport(root, baseReport({ fixtureBacked: true }));

      const gate = readMossProductionProviderReadinessGate(root, { createdAt: CREATED_AT });

      expect(gate.readiness.status).toBe("fail");
      expect(gate.issues.map((issue) => issue.code)).toContain("fixture-backed");
      expect(mossProductionProviderReadinessGateExitCode(gate)).toBe(1);
    }));

  it("fails blocked providers without blocker evidence", () =>
    withTempRepo((root) => {
      writeReport(
        root,
        baseReport({
          providers: [
            {
              provider: "codex",
              source: "ProviderHealthLive",
              status: "error",
              available: true,
              authStatus: "unauthenticated",
              usable: false,
              checkedAt: CREATED_AT,
            },
          ],
          acceptedProviders: [],
          blockedProviders: ["codex"],
          acceptance: {
            status: "blocked-with-evidence",
            requiredProviderUsable: false,
            summary:
              "Production provider readiness is blocked, with explicit provider evidence recorded.",
          },
        }),
      );

      const gate = readMossProductionProviderReadinessGate(root, { createdAt: CREATED_AT });

      expect(gate.readiness.status).toBe("fail");
      expect(gate.issues.map((issue) => issue.code)).toContain("missing-blocker-evidence");
    }));
});
