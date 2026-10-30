import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mossRightControlsSmokeGateExitCode,
  readMossRightControlsSmokeGate,
} from "./moss-right-controls-smoke-gate.ts";

const CREATED_AT = "2026-07-10T05:00:00.000Z";
const REPORT_PATH = ".moss/ledger/evidence/moss-right-controls-smoke-2026-07-10.json";
const STATE_IDS = [
  "closed-overlay",
  "summary-overlay-open",
  "summary-create-document-draft",
  "bottom-x-preserves-tab",
  "bottom-drawer",
  "bottom-height-behavior",
  "right-regular",
  "right-full-width",
  "summary-inline-pinned",
] as const;

function withTempRepo<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-right-controls-gate-"));
  try {
    return callback(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeRepoFile(root: string, path: string, body: string | Buffer): void {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, body);
}

function requiredCheckSuffixes(stateId: string): string[] {
  const suffixes =
    stateId === "right-full-width"
      ? []
      : [
          "fixed-controls-container-count",
          "fixed-controls-only",
          "fixed-controls-order",
          "fixed-controls-size",
          "fixed-controls-baseline",
          "bottom-chinese-label",
          "bottom-chinese-title",
          "summary-chinese-label",
          "summary-chinese-title",
          "right-chinese-label",
          "right-chinese-title",
        ];
  if (stateId === "closed-overlay") {
    suffixes.push("summary-hidden", "bottom-closed", "right-closed");
  }
  if (stateId === "summary-overlay-open") {
    suffixes.push("summary-overlay-visible", "summary-panel-width", "summary-pressed");
  }
  if (stateId === "summary-create-document-draft") {
    suffixes.push(
      "summary-document-prompt-exact",
      "summary-document-editor-focused",
      "summary-document-caret-at-end",
      "summary-document-not-submitted",
    );
  }
  if (stateId === "bottom-x-preserves-tab") {
    suffixes.push(
      "bottom-x-closes-drawer",
      "bottom-x-preserves-terminal-ids",
      "bottom-x-preserves-active-terminal",
      "bottom-x-preserves-terminal-groups",
      "bottom-x-reopens-same-tab",
    );
  }
  if (stateId === "bottom-drawer") {
    suffixes.push(
      "bottom-pressed",
      "drawer-visible",
      "drawer-height",
      "drawer-single-tab",
      "drawer-single-plus",
      "drawer-single-close",
      "drawer-only-tab-plus-close",
      "drawer-no-workspace-actions",
      "drawer-no-runtime-error",
      "drawer-motion-contract",
      "bottom-shortcut-opens",
      "bottom-shortcut-closes",
      "bottom-shortcut-reopens",
    );
  }
  if (stateId === "bottom-height-behavior") {
    suffixes.push(
      "bottom-resize-height",
      "bottom-resize-storage",
      "bottom-resize-thread-state",
      "bottom-resize-reopens-persisted",
      "bottom-under-min-closes",
      "bottom-under-min-keeps-storage",
      "bottom-under-min-reopens-persisted",
    );
  }
  if (stateId === "right-regular") {
    suffixes.push(
      "right-pressed",
      "right-dock-visible",
      "right-dock-no-fixed-control-duplicates",
      "right-dock-motion-contract",
      "right-shortcut-opens",
      "right-shortcut-closes",
      "right-shortcut-reopens",
    );
  }
  if (stateId === "right-full-width") {
    suffixes.push(
      "right-full-width-fills-shell",
      "right-full-width-no-divider",
      "right-full-width-no-resizer",
      "right-full-width-main-header-hidden",
      "right-full-width-replacement-controls-only",
      "right-full-width-bottom-control-works",
      "right-full-width-bottom-panel-normal-flow",
      "right-full-width-bottom-panel-compresses-shell-row",
      "right-full-width-collapse-control-works",
      "right-full-width-restores-after-reopen",
    );
  }
  if (stateId === "summary-inline-pinned") {
    suffixes.push("summary-inline-visible", "summary-panel-width", "summary-pressed");
  }
  return suffixes;
}

function buildState(stateId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: stateId,
    status: "pass",
    screenshotPath: `.moss/ledger/evidence/moss-right-controls-smoke-2026-07-10/${stateId}.png`,
    checks: requiredCheckSuffixes(stateId).map((suffix) => ({
      id: `${stateId}:${suffix}`,
      pass: true,
    })),
    ...overrides,
  };
}

function buildPassingReport(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    createdAt: CREATED_AT,
    status: "pass",
    route: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
    runtime: {
      runtimeDataset: "electron",
      hasDesktopBridge: true,
      hasNativeApi: true,
    },
    states: STATE_IDS.map((stateId) => buildState(stateId)),
    ...overrides,
  };
}

function writeEvidence(root: string, report: Record<string, unknown>): void {
  writeRepoFile(root, REPORT_PATH, `${JSON.stringify(report)}\n`);
  const states = Array.isArray(report.states) ? report.states : [];
  for (const state of states) {
    if (typeof state !== "object" || state === null) continue;
    const screenshotPath = (state as { screenshotPath?: unknown }).screenshotPath;
    if (typeof screenshotPath === "string") {
      writeRepoFile(root, screenshotPath, Buffer.from("non-empty-png-fixture"));
    }
  }
}

describe("moss-right-controls-smoke-gate", () => {
  it("passes the complete Electron state matrix with screenshots", () => {
    withTempRepo((root) => {
      writeEvidence(root, buildPassingReport());
      const report = readMossRightControlsSmokeGate(root, {
        createdAt: CREATED_AT,
        reportPath: REPORT_PATH,
      });

      expect(report.readiness.status).toBe("pass");
      expect(report.observedStateIds).toEqual(STATE_IDS);
      expect(report.screenshotPaths).toHaveLength(STATE_IDS.length);
      expect(report.issues).toEqual([]);
      expect(mossRightControlsSmokeGateExitCode(report)).toBe(0);
    });
  });

  it("fails when the inline summary acceptance state is absent", () => {
    withTempRepo((root) => {
      const states = STATE_IDS.filter((stateId) => stateId !== "summary-inline-pinned").map(
        (stateId) => buildState(stateId),
      );
      writeEvidence(root, buildPassingReport({ states }));
      const report = readMossRightControlsSmokeGate(root, {
        createdAt: CREATED_AT,
        reportPath: REPORT_PATH,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: "missing-state",
          stateId: "summary-inline-pinned",
        }),
      );
      expect(mossRightControlsSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails when the report includes an out-of-scope state", () => {
    withTempRepo((root) => {
      const states = [
        ...STATE_IDS.map((stateId) => buildState(stateId)),
        buildState("dock-motion"),
      ];
      writeEvidence(root, buildPassingReport({ states }));
      const report = readMossRightControlsSmokeGate(root, {
        createdAt: CREATED_AT,
        reportPath: REPORT_PATH,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: "unexpected-state",
          stateId: "dock-motion",
        }),
      );
    });
  });

  it("fails when the exact fixed-control order assertion is missing", () => {
    withTempRepo((root) => {
      const states = STATE_IDS.map((stateId) => {
        if (stateId !== "closed-overlay") return buildState(stateId);
        return buildState(stateId, {
          checks: requiredCheckSuffixes(stateId)
            .filter((suffix) => suffix !== "fixed-controls-order")
            .map((suffix) => ({ id: `${stateId}:${suffix}`, pass: true })),
        });
      });
      writeEvidence(root, buildPassingReport({ states }));
      const report = readMossRightControlsSmokeGate(root, {
        createdAt: CREATED_AT,
        reportPath: REPORT_PATH,
      });

      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: "missing-check",
          stateId: "closed-overlay",
          checkId: "closed-overlay:fixed-controls-order",
        }),
      );
    });
  });

  it("fails when drawer chrome contains anything beyond tab, plus, and close", () => {
    withTempRepo((root) => {
      const states = STATE_IDS.map((stateId) => {
        if (stateId !== "bottom-drawer") return buildState(stateId);
        return buildState(stateId, {
          status: "fail",
          checks: requiredCheckSuffixes(stateId).map((suffix) => ({
            id: `${stateId}:${suffix}`,
            pass: suffix !== "drawer-only-tab-plus-close",
          })),
        });
      });
      writeEvidence(root, buildPassingReport({ status: "fail", states }));
      const report = readMossRightControlsSmokeGate(root, {
        createdAt: CREATED_AT,
        reportPath: REPORT_PATH,
      });

      expect(report.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "smoke-failed" }),
          expect.objectContaining({
            code: "failed-state",
            stateId: "bottom-drawer",
          }),
          expect.objectContaining({
            code: "failed-check",
            checkId: "bottom-drawer:drawer-only-tab-plus-close",
          }),
        ]),
      );
    });
  });

  it("fails when full-width evidence does not prove the bottom panel is in shell flow", () => {
    withTempRepo((root) => {
      const states = STATE_IDS.map((stateId) => {
        if (stateId !== "right-full-width") return buildState(stateId);
        return buildState(stateId, {
          checks: requiredCheckSuffixes(stateId)
            .filter((suffix) => suffix !== "right-full-width-bottom-panel-normal-flow")
            .map((suffix) => ({ id: `${stateId}:${suffix}`, pass: true })),
        });
      });
      writeEvidence(root, buildPassingReport({ states }));
      const report = readMossRightControlsSmokeGate(root, {
        createdAt: CREATED_AT,
        reportPath: REPORT_PATH,
      });

      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: "missing-check",
          stateId: "right-full-width",
          checkId: "right-full-width:right-full-width-bottom-panel-normal-flow",
        }),
      );
    });
  });

  it("fails when any per-state screenshot is missing", () => {
    withTempRepo((root) => {
      const reportBody = buildPassingReport();
      writeEvidence(root, reportBody);
      rmSync(
        join(root, ".moss/ledger/evidence/moss-right-controls-smoke-2026-07-10/closed-overlay.png"),
      );
      const report = readMossRightControlsSmokeGate(root, {
        createdAt: CREATED_AT,
        reportPath: REPORT_PATH,
      });

      expect(report.issues).toContainEqual(
        expect.objectContaining({
          code: "missing-screenshot",
          stateId: "closed-overlay",
        }),
      );
    });
  });
});
