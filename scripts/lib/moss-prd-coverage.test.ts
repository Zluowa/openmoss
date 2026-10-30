import { describe, expect, it } from "vitest";

import {
  buildMossPrdCoverageReport,
  parseMossPrdCoverageDocument,
  selectMossPrdCoverageNextGap,
} from "./moss-prd-coverage.ts";

const validCoverage = JSON.stringify({
  version: 1,
  updatedAt: "2026-07-02T00:02:30.000Z",
  summary: {
    nextGapId: "phase-5-codex-like-gui",
  },
  rows: [
    {
      id: "phase-1-contracts",
      section: "phase",
      requirement: "Add Moss contracts",
      status: "proved",
      evidence: ["packages/contracts/src/moss.ts"],
      nextGap: "None for this row.",
    },
    {
      id: "phase-5-codex-like-gui",
      section: "phase",
      requirement: "Complete Codex-like GUI parity",
      status: "partial",
      evidence: ["apps/web/src/components/chat/MossControlPlanePanel.tsx"],
      nextGap: "Add a concrete parity checklist and UI gate.",
      nextTaskHint: "Gate Codex-like GUI parity coverage from PRD matrix",
    },
  ],
});

describe("moss-prd-coverage", () => {
  it("parses coverage rows and selects the explicit next gap", () => {
    const document = parseMossPrdCoverageDocument(validCoverage, ".moss/prd-coverage.json");
    const nextGap = selectMossPrdCoverageNextGap(document);
    const report = buildMossPrdCoverageReport(document);

    expect(nextGap).toEqual({
      id: "phase-5-codex-like-gui",
      section: "phase",
      status: "partial",
      requirement: "Complete Codex-like GUI parity",
      nextGap: "Add a concrete parity checklist and UI gate.",
      nextTaskHint: "Gate Codex-like GUI parity coverage from PRD matrix",
      evidence: ["apps/web/src/components/chat/MossControlPlanePanel.tsx"],
    });
    expect(report.statusCounts).toEqual({
      proved: 1,
      partial: 1,
      missing: 0,
      unverified: 0,
    });
  });

  it("rejects unknown coverage statuses", () => {
    const malformed = JSON.stringify({
      version: 1,
      updatedAt: "2026-07-02T00:02:30.000Z",
      summary: {},
      rows: [
        {
          id: "phase-5",
          section: "phase",
          requirement: "GUI",
          status: "done",
          evidence: [],
          nextGap: "Use a known status.",
        },
      ],
    });

    expect(() => parseMossPrdCoverageDocument(malformed, ".moss/prd-coverage.json")).toThrow(
      "rows[0].status must be one of proved, partial, missing, unverified",
    );
  });

  it("rejects nextGapId values that point to proved rows", () => {
    const malformed = JSON.stringify({
      version: 1,
      updatedAt: "2026-07-02T00:02:30.000Z",
      summary: {
        nextGapId: "phase-1",
      },
      rows: [
        {
          id: "phase-1",
          section: "phase",
          requirement: "Contracts",
          status: "proved",
          evidence: ["packages/contracts/src/moss.ts"],
          nextGap: "None.",
        },
      ],
    });

    expect(() => parseMossPrdCoverageDocument(malformed, ".moss/prd-coverage.json")).toThrow(
      ".moss/prd-coverage.json.summary.nextGapId must not point to a proved row",
    );
  });
});
