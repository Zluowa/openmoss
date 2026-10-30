import { describe, expect, it } from "vitest";

import {
  buildMossGuiParityReport,
  parseMossGuiParityDocument,
  selectMossGuiParityNextGap,
} from "./moss-gui-parity.ts";

function validGuiParity(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    updatedAt: "2026-07-02T00:02:40.000Z",
    prdCoverageRowId: "phase-5-codex-like-gui",
    overallStatus: "partial",
    fullCodexParityClaim: false,
    summary: {
      nextGapId: "composer",
    },
    firstVisibleShell: {
      status: "partial",
      selectors: [
        "[data-normal-chat-shell]",
        "[data-chat-composer-form='true']",
        "[data-moss-control-plane]",
      ],
      evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
      gap: "Top-level send, stop, model, and permission controls still need full Codex-like shell gating.",
    },
    surfaces: [
      {
        id: "session-list",
        label: "Session list",
        prdCoverageRowId: "phase-5-codex-like-gui",
        requirement:
          "Show runtime sessions with active thread selection and launch-plan drilldown.",
        status: "gated",
        visibleShellSlice: true,
        selectors: ["[data-moss-control-plane-session-list]", "[data-moss-session-list-row]"],
        evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
        gap: "Promote the internal session list into the final shell layout.",
      },
      {
        id: "composer",
        label: "Composer",
        prdCoverageRowId: "phase-5-codex-like-gui",
        requirement:
          "Keep the first visible shell composer available while Moss control surfaces mount.",
        status: "partial",
        visibleShellSlice: true,
        selectors: ["[data-chat-composer-form='true']"],
        evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
        gap: "Gate send, stop, model, attachment, and permission state parity against Codex Desktop.",
        nextTaskHint: "Gate visible composer and session controls against GUI parity checklist",
      },
      {
        id: "tool-permission-flow",
        label: "Tool and permission flow",
        prdCoverageRowId: "phase-5-codex-like-gui",
        requirement: "Render tool lifecycle and permission action state from normalized events.",
        status: "gated",
        visibleShellSlice: true,
        selectors: [
          "[data-moss-normalized-tool-lifecycle]",
          "[data-moss-normalized-permission-action-shell]",
        ],
        evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
        gap: "Connect every provider permission action to the final user-facing shell.",
      },
      {
        id: "normalized-event-timeline",
        label: "Normalized event timeline",
        prdCoverageRowId: "phase-5-codex-like-gui",
        requirement:
          "Render text, tool, permission, usage, finish, and error events without raw provider logs.",
        status: "gated",
        visibleShellSlice: true,
        selectors: ["[data-moss-control-plane-events]", "[data-moss-normalized-row]"],
        evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
        gap: "Move normalized rendering into the final chat timeline where needed.",
      },
      {
        id: "launch-plan-inspector",
        label: "Launch Plan Inspector",
        prdCoverageRowId: "phase-5-codex-like-gui",
        requirement: "Expose redacted Launch Plan inspection for the selected provider session.",
        status: "gated",
        visibleShellSlice: true,
        selectors: ["[data-moss-control-plane-launch-plan]", "[data-moss-launch-plan]"],
        evidence: [
          "apps/web/src/components/chat/mossLaunchPlanInspector.test.tsx",
          "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
        ],
        gap: "Make launch-plan access feel native in the final Codex-like shell.",
      },
    ],
    ...overrides,
  });
}

describe("moss-gui-parity", () => {
  it("builds a passing partial gate without claiming full Codex parity", () => {
    const document = parseMossGuiParityDocument(validGuiParity(), ".moss/gui-parity.json");
    const nextGap = selectMossGuiParityNextGap(document);
    const report = buildMossGuiParityReport(document);

    expect(report.gateStatus).toBe("pass");
    expect(report.fullCodexParityClaim).toBe(false);
    expect(report.overallStatus).toBe("partial");
    expect(report.requiredSurfaceIds).toEqual([
      "session-list",
      "composer",
      "tool-permission-flow",
      "normalized-event-timeline",
      "launch-plan-inspector",
    ]);
    expect(report.statusCounts).toEqual({
      gated: 4,
      partial: 1,
      missing: 0,
      unverified: 0,
    });
    expect(nextGap).toMatchObject({
      id: "composer",
      status: "partial",
      nextTaskHint: "Gate visible composer and session controls against GUI parity checklist",
    });
  });

  it("rejects attempts to claim full Codex Desktop parity", () => {
    expect(() =>
      parseMossGuiParityDocument(
        validGuiParity({ fullCodexParityClaim: true }),
        ".moss/gui-parity.json",
      ),
    ).toThrow(".moss/gui-parity.json.fullCodexParityClaim must be false");
  });

  it("reports a failed gate when a required surface is missing", () => {
    const raw = JSON.parse(validGuiParity()) as Record<string, unknown>;
    raw.surfaces = (raw.surfaces as unknown[]).filter(
      (surface) => (surface as { id: string }).id !== "launch-plan-inspector",
    );
    const report = buildMossGuiParityReport(
      parseMossGuiParityDocument(JSON.stringify(raw), ".moss/gui-parity.json"),
    );

    expect(report.gateStatus).toBe("fail");
    expect(report.issues).toContain("missing required GUI parity surface: launch-plan-inspector");
  });

  it("reports a failed gate when a required surface is unverified", () => {
    const raw = JSON.parse(validGuiParity()) as Record<string, unknown>;
    raw.surfaces = (raw.surfaces as Record<string, unknown>[]).map((surface) =>
      surface.id === "tool-permission-flow" ? { ...surface, status: "unverified" } : surface,
    );
    const report = buildMossGuiParityReport(
      parseMossGuiParityDocument(JSON.stringify(raw), ".moss/gui-parity.json"),
    );

    expect(report.gateStatus).toBe("fail");
    expect(report.issues).toContain(
      "required GUI parity surface tool-permission-flow is unverified",
    );
  });
});
