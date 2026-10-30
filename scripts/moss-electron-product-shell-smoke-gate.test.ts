import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mossElectronProductShellSmokeGateExitCode,
  readMossElectronProductShellSmokeGate,
} from "./moss-electron-product-shell-smoke-gate.ts";

const CREATED_AT = "2026-07-02T00:16:12.000Z";
const REPORT_PATH = ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.json";
const SCREENSHOT_PATH = ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.png";
const EXPECTED_BASELINE_SCREENSHOT =
  ".moss/ledger/evidence/codex-desktop-current-shell-2026-07-03.png";
const REQUIRED_ASSERTIONS = [
  "Electron preload bridge exposes desktopBridge.getWsUrl",
  "desktopBridge.getWsUrl returns live loopback backend websocket URL",
  "real Node backend responds on /health through desktop bridge URL",
  "Electron process tree contains apps/server/dist backend child process",
  "renderer detected Electron runtime from preload bridge",
  "composer shell mounted from Electron product route",
  "composer attachment control is visible in the running shell",
  "composer model or reasoning control is visible in the running shell",
  "native Moss shell is enabled by explicit harness route under Electron",
  "normalized event subscription is live with fixture events",
  "permission request action shell is available from normalized event",
  "Codex Desktop baseline-backed active shell control set is visible",
  "active normalized timeline covers text, tool, permission, usage, and finish",
  "permission request approve action transitions to accepted",
  "session list surface shows secondary provider session",
  "secondary provider session can be selected without changing the active thread",
  "normalized event surface scopes to selected secondary session",
  "selected secondary session normalized timeline renders without active-thread event bleed",
  "selected secondary session normalized row is visible",
  "selected secondary session timeline hides active-thread and raw provider text",
  "launch plan inspector renders selected secondary redacted plan hash",
  "loop ledger dashboard surface is visible",
  "selected-session event surface remains available after surface switches",
  "Codex Desktop broader interaction path preserves selected-session drilldown",
  "composer and active route remain stable across Moss surface switches",
];

function withTempRepo<T>(callback: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "moss-electron-smoke-gate-"));
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

function buildPassingSmokeReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    createdAt: "2026-07-02T00:16:00.000Z",
    route: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
    desktopRuntime: "electron",
    backendMode: "real-node",
    assertions: [
      ...REQUIRED_ASSERTIONS,
      "native Moss shell access strip reflects active codex running session",
      "running-session stop control is visible",
      "default normalized event surface is visible",
      "tool-call and tool-result lifecycle is normalized",
      "usage event renders from normalized timeline",
      "raw provider event source is not rendered",
      "session list surface shows Electron runtime session",
      "launch plan inspector surface is visible",
      "loop ledger dashboard renders task context",
      "first-screen layout geometry evidence recorded",
    ],
    interactionContinuity: {
      routeBeforeSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
      routeAfterSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
      composerThreadIdAfterSwitches: "thread-moss-served-smoke",
      visitedSurfaces: ["events", "sessions", "events", "launch-plan", "ledger", "events"],
      selectedSessionThreadId: "thread-moss-served-smoke-secondary",
      selectedSessionEventCount: 1,
      permissionActionStatus: "accepted",
      launchPlanHashVisible: "sha256:moss-served-smoke-secondary",
    },
    codexDesktopInteractionAcceptance: {
      baselineScreenshotPath: EXPECTED_BASELINE_SCREENSHOT,
      baselineTraits: [
        "active-thread-transcript",
        "composer",
        "run-state-control",
        "model-or-permission-control",
        "plan-or-output-side-panel",
      ],
      activeThreadId: "thread-moss-served-smoke",
      activeProvider: "codex",
      activeSessionStatus: "running",
      visibleSurfaceIds: ["events", "sessions", "launch-plan", "ledger"],
      activeEventTypes: [
        "text",
        "tool-call",
        "tool-result",
        "permission-request",
        "usage",
        "finish",
      ],
      activeTimelineRowCount: 8,
      composerControls: {
        composerShell: true,
        composerControls: true,
        attachment: true,
        modelOrReasoning: true,
        stop: true,
      },
      normalizedTimeline: {
        toolLifecycle: true,
        permissionAction: true,
        usage: true,
        finish: true,
      },
      rawProviderSourceHidden: true,
      routeBeforeSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
      routeAfterSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
      composerThreadIdAfterSwitches: "thread-moss-served-smoke",
      visitedSurfaces: ["events", "sessions", "events", "launch-plan", "ledger", "events"],
      selectedSessionThreadId: "thread-moss-served-smoke-secondary",
      selectedSessionEventCount: 1,
      permissionActionStatus: "accepted",
      launchPlanHashVisible: "sha256:moss-served-smoke-secondary",
      fullCodexParityClaim: false,
    },
    runtimeEvidence: {
      hasDesktopBridge: true,
      hasNativeApi: true,
      runtimeDataset: "electron",
      routeHref: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
    },
    backendHealth: {
      healthUrl: "http://127.0.0.1:57271/health",
      status: 200,
      body: { status: "ok" },
    },
    processEvidence: {
      electronPid: 79498,
      backend: "79516 node --max-old-space-size=4096 /repo/apps/server/dist/index.mjs",
      children: [],
    },
    screenshotPath: SCREENSHOT_PATH,
    electronLogTail: ["raw log should stay out of release reports"],
    browserLogTail: ["raw browser log should stay out of release reports"],
    ...overrides,
  };
}

function writePassingEvidence(root: string, reportOverrides: Record<string, unknown> = {}): void {
  writeRepoFile(root, REPORT_PATH, `${JSON.stringify(buildPassingSmokeReport(reportOverrides))}\n`);
  writeRepoFile(root, SCREENSHOT_PATH, Buffer.from("not-a-real-png-but-non-empty"));
}

describe("moss-electron-product-shell-smoke-gate", () => {
  it("passes with current Electron product-shell smoke report and screenshot evidence", () => {
    withTempRepo((root) => {
      writePassingEvidence(root);

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("pass");
      expect(report.reportPath).toBe(join(REPORT_PATH));
      expect(report.screenshotPath).toBe(join(SCREENSHOT_PATH));
      expect(report.report).toMatchObject({
        createdAt: "2026-07-02T00:16:00.000Z",
        route: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
        desktopRuntime: "electron",
        backendMode: "real-node",
        assertionCount: 35,
        runtimeDataset: "electron",
        hasDesktopBridge: true,
        hasNativeApi: true,
        backendHealthStatus: 200,
        backendProcessPresent: true,
        interactionContinuity: {
          routeBeforeSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
          routeAfterSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
          composerThreadIdAfterSwitches: "thread-moss-served-smoke",
          selectedSessionThreadId: "thread-moss-served-smoke-secondary",
          selectedSessionEventCount: 1,
          permissionActionStatus: "accepted",
          launchPlanHashVisible: "sha256:moss-served-smoke-secondary",
        },
        codexDesktopInteractionAcceptance: {
          baselineScreenshotPath: EXPECTED_BASELINE_SCREENSHOT,
          activeThreadId: "thread-moss-served-smoke",
          activeProvider: "codex",
          activeSessionStatus: "running",
          activeTimelineRowCount: 8,
          selectedSessionThreadId: "thread-moss-served-smoke-secondary",
          selectedSessionEventCount: 1,
          permissionActionStatus: "accepted",
          launchPlanHashVisible: "sha256:moss-served-smoke-secondary",
          routeBeforeSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
          routeAfterSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
          composerThreadIdAfterSwitches: "thread-moss-served-smoke",
          fullCodexParityClaim: false,
        },
      });
      expect(report.screenshot?.bytes).toBeGreaterThan(0);
      expect(report.issues).toEqual([]);
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(0);
      expect(JSON.stringify(report)).not.toContain("raw log should stay out");
      expect(JSON.stringify(report)).not.toContain("raw browser log should stay out");
    });
  });

  it("fails deterministically when the smoke report is missing", () => {
    withTempRepo((root) => {
      writeRepoFile(root, SCREENSHOT_PATH, Buffer.from("screenshot"));

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual(["missing-report"]);
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails deterministically when the screenshot is missing", () => {
    withTempRepo((root) => {
      writeRepoFile(root, REPORT_PATH, `${JSON.stringify(buildPassingSmokeReport())}\n`);

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual(["missing-screenshot"]);
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails stale report dates against the gate createdAt artifact date", () => {
    withTempRepo((root) => {
      writePassingEvidence(root);

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: "2026-07-03T00:00:00.000Z",
        reportPath: REPORT_PATH,
        screenshotPath: SCREENSHOT_PATH,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toContain("stale-report-date");
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails malformed, route-mismatched, and incomplete assertion evidence", () => {
    withTempRepo((root) => {
      writePassingEvidence(root, {
        route: "http://localhost:8891",
        assertions: REQUIRED_ASSERTIONS.slice(0, 10),
      });

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toContain("unexpected-route");
      expect(report.issues.map((issue) => issue.code)).toContain("too-few-assertions");
      expect(report.issues.map((issue) => issue.code)).toContain("missing-assertion");
      expect(
        report.issues.find((issue) =>
          issue.message.includes("session list surface shows secondary provider session"),
        )?.message,
      ).toContain("session list surface shows secondary provider session");
    });
  });

  it("fails deterministically when interaction continuity evidence is missing", () => {
    withTempRepo((root) => {
      writePassingEvidence(root, {
        interactionContinuity: undefined,
      });

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual(["missing-interaction-continuity"]);
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails deterministically when interaction continuity fields drift", () => {
    withTempRepo((root) => {
      writePassingEvidence(root, {
        interactionContinuity: {
          routeBeforeSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
          routeAfterSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
          composerThreadIdAfterSwitches: "thread-moss-served-smoke-secondary",
          visitedSurfaces: ["events", "sessions"],
          selectedSessionThreadId: "thread-moss-served-smoke",
          selectedSessionEventCount: 8,
          permissionActionStatus: "ready",
          launchPlanHashVisible: "sha256:moss-served-smoke",
        },
      });

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual([
        "unexpected-interaction-continuity",
      ]);
      expect(report.issues[0]?.message).toContain("composerThreadIdAfterSwitches");
      expect(report.issues[0]?.message).toContain("visitedSurfaces:launch-plan,ledger");
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails deterministically when broader Codex Desktop interaction acceptance evidence is missing", () => {
    withTempRepo((root) => {
      writePassingEvidence(root, {
        codexDesktopInteractionAcceptance: undefined,
      });

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual([
        "missing-codex-desktop-interaction-acceptance",
      ]);
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails deterministically when broader Codex Desktop interaction acceptance fields drift", () => {
    withTempRepo((root) => {
      writePassingEvidence(root, {
        codexDesktopInteractionAcceptance: {
          baselineScreenshotPath: ".moss/ledger/evidence/stale.png",
          baselineTraits: ["composer"],
          activeThreadId: "thread-moss-served-smoke-secondary",
          activeProvider: "claude",
          activeSessionStatus: "ready",
          visibleSurfaceIds: ["events"],
          activeEventTypes: ["text"],
          activeTimelineRowCount: 1,
          composerControls: {
            composerShell: true,
            attachment: false,
            modelOrReasoning: true,
            stop: false,
          },
          normalizedTimeline: {
            toolLifecycle: true,
            permissionAction: false,
            usage: true,
            finish: false,
          },
          rawProviderSourceHidden: false,
          routeBeforeSwitches: "moss://app/index.html#/thread-moss-served-smoke?mossShell=1",
          routeAfterSwitches: "moss://app/index.html#/thread-moss-served-smoke-secondary",
          composerThreadIdAfterSwitches: "thread-moss-served-smoke-secondary",
          selectedSessionThreadId: "thread-moss-served-smoke",
          selectedSessionEventCount: 8,
          permissionActionStatus: "pending",
          launchPlanHashVisible: "sha256:moss-served-smoke",
          fullCodexParityClaim: true,
        },
      });

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual([
        "unexpected-codex-desktop-interaction-acceptance",
      ]);
      expect(report.issues[0]?.message).toContain("baselineScreenshotPath");
      expect(report.issues[0]?.message).toContain("activeEventTypes:tool-call");
      expect(report.issues[0]?.message).toContain("fullCodexParityClaim");
      expect(mossElectronProductShellSmokeGateExitCode(report)).toBe(1);
    });
  });

  it("fails malformed JSON without throwing", () => {
    withTempRepo((root) => {
      writeRepoFile(root, REPORT_PATH, "{nope");
      writeRepoFile(root, SCREENSHOT_PATH, Buffer.from("screenshot"));

      const report = readMossElectronProductShellSmokeGate(root, {
        createdAt: CREATED_AT,
      });

      expect(report.readiness.status).toBe("fail");
      expect(report.issues.map((issue) => issue.code)).toEqual(["malformed-report"]);
    });
  });
});
