import { describe, expect, it } from "vitest";

import {
  buildMossFinalShellAuditReport,
  parseMossFinalShellAuditDocument,
  selectMossFinalShellNextGap,
} from "./moss-final-shell-parity.ts";

function criterion(id: string, status: "aligned" | "partial" | "gap" | "unverified") {
  return {
    id,
    label: id,
    requirement: `Requirement for ${id}.`,
    status,
    codexDesktopTarget: `Codex Desktop target for ${id}.`,
    currentMossEvidence: `Current Moss evidence for ${id}.`,
    findings: [`Finding for ${id}.`],
    evidence: [`evidence/${id}.md`],
    gap: `Gap for ${id}.`,
    ...(status === "aligned" ? {} : { nextTaskHint: `Fix ${id}` }),
  };
}

function validAudit(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    updatedAt: "2026-07-02T00:04:00.000Z",
    scope: "Final Codex-like shell parity audit.",
    overallStatus: "partial",
    fullCodexParityClaim: false,
    summary: {
      nextGapId: "native-surface-access",
    },
    criteria: [
      criterion("first-screen-layout", "partial"),
      criterion("routing", "partial"),
      criterion("density", "partial"),
      criterion("state-transitions", "partial"),
      criterion("interaction-sequencing", "partial"),
      criterion("native-surface-access", "gap"),
    ],
    ...overrides,
  });
}

describe("moss-final-shell-parity", () => {
  it("builds a passing audit gate while keeping the full parity claim false", () => {
    const document = parseMossFinalShellAuditDocument(
      validAudit(),
      ".moss/final-shell-parity.json",
    );
    const report = buildMossFinalShellAuditReport(document);

    expect(report.auditGateStatus).toBe("pass");
    expect(report.fullCodexParityClaim).toBe(false);
    expect(report.overallStatus).toBe("partial");
    expect(report.statusCounts).toEqual({
      aligned: 0,
      partial: 5,
      gap: 1,
      unverified: 0,
    });
    expect(report.requiredCriterionIds).toEqual([
      "first-screen-layout",
      "routing",
      "density",
      "state-transitions",
      "interaction-sequencing",
      "native-surface-access",
    ]);
    expect(selectMossFinalShellNextGap(document)).toMatchObject({
      id: "native-surface-access",
      status: "gap",
      nextTaskHint: "Fix native-surface-access",
    });
  });

  it("rejects attempts to claim full Codex Desktop parity", () => {
    expect(() =>
      parseMossFinalShellAuditDocument(
        validAudit({ fullCodexParityClaim: true }),
        ".moss/final-shell-parity.json",
      ),
    ).toThrow(".moss/final-shell-parity.json.fullCodexParityClaim must be false");
  });

  it("fails the audit gate when a required criterion is missing", () => {
    const raw = JSON.parse(validAudit()) as Record<string, unknown>;
    raw.criteria = (raw.criteria as unknown[]).filter(
      (entry) => (entry as { id: string }).id !== "routing",
    );
    const report = buildMossFinalShellAuditReport(
      parseMossFinalShellAuditDocument(JSON.stringify(raw), ".moss/final-shell-parity.json"),
    );

    expect(report.auditGateStatus).toBe("fail");
    expect(report.issues).toContain("missing required final shell criterion: routing");
  });

  it("fails the audit gate when a criterion is unverified", () => {
    const raw = JSON.parse(validAudit()) as Record<string, unknown>;
    raw.criteria = (raw.criteria as Record<string, unknown>[]).map((entry) => {
      if (entry.id !== "density") {
        return entry;
      }
      return Object.assign({}, entry, { status: "unverified" });
    });
    const report = buildMossFinalShellAuditReport(
      parseMossFinalShellAuditDocument(JSON.stringify(raw), ".moss/final-shell-parity.json"),
    );

    expect(report.auditGateStatus).toBe("fail");
    expect(report.issues).toContain("final shell criterion density is unverified");
  });
});
