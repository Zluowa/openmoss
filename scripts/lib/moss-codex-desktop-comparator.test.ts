import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildMossCodexDesktopComparatorReport,
  parseMossCodexDesktopComparatorDocument,
} from "./moss-codex-desktop-comparator.ts";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000005000000030008020000007e4f16300000000049454e44ae426082",
  "hex",
);

function comparison(id: string, status: "aligned" | "partial" | "gap" | "unverified") {
  return {
    id,
    label: id,
    requirement: `Requirement for ${id}.`,
    status,
    directCodexDesktopBaseline: true,
    codexDesktopEvidence: [".moss/ledger/evidence/codex-desktop-current-shell-test.png"],
    mossEvidence: [".moss/ledger/evidence/moss-shell-test.png"],
    findings: [`Finding for ${id}.`],
    gap: `Gap for ${id}.`,
    ...(status === "aligned" ? {} : { nextTaskHint: `Fix ${id}` }),
  };
}

function validComparator(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    updatedAt: "2026-07-02T00:11:00.000Z",
    scope: "Direct Codex Desktop comparator for Moss final shell parity.",
    overallStatus: "partial",
    fullCodexParityClaim: false,
    summary: {
      nextGapId: "default-off-shell-productization",
    },
    codexDesktopBaseline: {
      capturedAt: "2026-07-02T00:11:00.000Z",
      source: "macos-window-screencapture",
      processName: "Codex",
      windowName: "Codex",
      windowBounds: {
        x: 0,
        y: 30,
        width: 1920,
        height: 972,
      },
      screenshotPath: ".moss/ledger/evidence/codex-desktop-current-shell-test.png",
      observedShellTraits: [
        "desktop-window-chrome",
        "project-or-thread-sidebar",
        "active-thread-transcript",
        "composer",
        "run-state-control",
        "model-or-permission-control",
        "plan-or-output-side-panel",
      ],
      evidenceLimitations: ["Screenshot evidence is direct but not a pixel-perfect sign-off."],
    },
    mossEvidence: [
      {
        label: "Moss promoted shell screenshot",
        path: ".moss/ledger/evidence/moss-shell-test.png",
        kind: "screenshot",
      },
      {
        label: "Moss density report",
        path: ".moss/ledger/evidence/moss-shell-density-test.md",
        kind: "report",
      },
    ],
    layoutMetrics: {
      codexDesktop: {
        source: "macos-window-screencapture-manual-geometry",
        capturedAt: "2026-07-02T00:11:00.000Z",
        viewportWidthPx: 1280,
        viewportHeightPx: 768,
        composerTopPx: 646,
        composerBottomGapPx: 42,
        composerHeightPx: 80,
        sideAccessWidthPx: 224,
        sideAccessVisible: true,
        controlPlaneAffordanceCount: 4,
        requiredControlPlaneAffordanceCount: 4,
        normalizedEventRowCount: 6,
        timelineHeightPx: 390,
        timelineDensityRowsPer1000Px: 15.384615,
        evidence: [".moss/ledger/evidence/codex-desktop-current-shell-test.png"],
      },
      mossElectron: {
        source: "electron-product-shell-smoke-layout-evidence",
        capturedAt: "2026-07-02T00:11:00.000Z",
        viewportWidthPx: 1280,
        viewportHeightPx: 768,
        composerTopPx: 648,
        composerBottomGapPx: 38,
        composerHeightPx: 82,
        sideAccessWidthPx: 220,
        sideAccessVisible: true,
        controlPlaneAffordanceCount: 4,
        requiredControlPlaneAffordanceCount: 4,
        normalizedEventRowCount: 6,
        timelineHeightPx: 392,
        timelineDensityRowsPer1000Px: 15.306122,
        evidence: [
          ".moss/ledger/evidence/moss-shell-test.png",
          ".moss/ledger/evidence/moss-shell-density-test.md",
        ],
      },
      thresholds: {
        maxComposerTopRatioDelta: 0.02,
        maxComposerBottomGapPxDelta: 8,
        maxComposerHeightPxDelta: 12,
        maxSideAccessWidthRatioDelta: 0.02,
        maxMissingControlPlaneAffordances: 0,
        maxNormalizedEventRowCountDelta: 1,
        minMossTimelineDensityRowsPer1000Px: 12,
        maxTimelineDensityRowsPer1000PxDelta: 3,
      },
    },
    comparisons: [
      comparison("first-screen-layout", "partial"),
      comparison("routing", "partial"),
      comparison("density", "partial"),
      comparison("state-transitions", "partial"),
      comparison("interaction-sequencing", "partial"),
      comparison("native-surface-access", "partial"),
      comparison("launch-plan-affordance", "partial"),
      comparison("default-off-shell-productization", "gap"),
    ],
    ...overrides,
  });
}

async function writeEvidence(root: string): Promise<void> {
  await mkdir(join(root, ".moss", "ledger", "evidence"), { recursive: true });
  await writeFile(
    join(root, ".moss", "ledger", "evidence", "codex-desktop-current-shell-test.png"),
    PNG_1X1,
  );
  await writeFile(join(root, ".moss", "ledger", "evidence", "moss-shell-test.png"), PNG_1X1);
  await writeFile(
    join(root, ".moss", "ledger", "evidence", "moss-shell-density-test.md"),
    "# density\n",
  );
}

describe("moss-codex-desktop-comparator", () => {
  it("builds a passing comparator gate while keeping the full parity claim false", async () => {
    const root = join(process.cwd(), ".tmp", "moss-codex-desktop-comparator-test");
    await rm(root, { force: true, recursive: true });
    await writeEvidence(root);

    const document = parseMossCodexDesktopComparatorDocument(
      validComparator(),
      ".moss/codex-desktop-comparator.json",
    );
    const report = buildMossCodexDesktopComparatorReport(
      document,
      root,
      ".moss/codex-desktop-comparator.json",
    );

    expect(report.gateStatus).toBe("pass");
    expect(report.layoutGateStatus).toBe("pass");
    expect(report.fullCodexParityClaim).toBe(false);
    expect(report.codexDesktopImage).toMatchObject({
      exists: true,
      format: "png",
      width: 1280,
      height: 768,
    });
    expect(report.statusCounts).toEqual({
      aligned: 0,
      partial: 7,
      gap: 1,
      unverified: 0,
    });
    expect(report.nextGap).toMatchObject({
      id: "default-off-shell-productization",
      status: "gap",
    });
    expect(report.layoutDeltas).toHaveLength(4);
    expect(report.layoutDeltas.find((entry) => entry.id === "composer-position")).toMatchObject({
      status: "pass",
      delta: {
        bottomGapDeltaPx: 4,
        heightDeltaPx: 2,
      },
    });

    await rm(root, { force: true, recursive: true });
  });

  it("refreshes Moss layout metrics from newer Electron smoke JSON evidence", async () => {
    const root = join(process.cwd(), ".tmp", "moss-codex-desktop-comparator-fresh-smoke-test");
    await rm(root, { force: true, recursive: true });
    await writeEvidence(root);

    const smokePath = ".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-test.json";
    await writeFile(
      join(root, smokePath),
      JSON.stringify(
        {
          firstScreenLayoutEvidence: {
            source: "electron-product-shell-smoke-layout-evidence",
            capturedAt: "2026-07-03T02:45:00.000+08:00",
            viewportWidthPx: 1280,
            viewportHeightPx: 768,
            composerTopPx: 646,
            composerBottomGapPx: 40,
            composerHeightPx: 80,
            sideAccessWidthPx: 224,
            sideAccessVisible: true,
            controlPlaneAffordanceCount: 4,
            requiredControlPlaneAffordanceCount: 4,
            normalizedEventRowCount: 8,
            timelineHeightPx: 416,
            timelineDensityRowsPer1000Px: 19.230769,
            evidence: [smokePath, ".moss/ledger/evidence/moss-shell-test.png"],
          },
        },
        null,
        2,
      ),
    );

    const raw = JSON.parse(validComparator()) as Record<string, unknown>;
    const layoutMetrics = raw.layoutMetrics as {
      codexDesktop: Record<string, unknown>;
      mossElectron: Record<string, unknown>;
    };
    layoutMetrics.codexDesktop = {
      ...layoutMetrics.codexDesktop,
      normalizedEventRowCount: 8,
      timelineHeightPx: 416,
      timelineDensityRowsPer1000Px: 19.230769,
    };
    layoutMetrics.mossElectron = {
      ...layoutMetrics.mossElectron,
      evidence: [smokePath, ".moss/ledger/evidence/moss-shell-test.png"],
    };

    const document = parseMossCodexDesktopComparatorDocument(
      JSON.stringify(raw),
      ".moss/codex-desktop-comparator.json",
    );
    const report = buildMossCodexDesktopComparatorReport(
      document,
      root,
      ".moss/codex-desktop-comparator.json",
    );

    expect(report.updatedAt).toBe("2026-07-03T02:45:00.000+08:00");
    expect(report.layoutMetrics.mossElectron.capturedAt).toBe("2026-07-03T02:45:00.000+08:00");
    expect(report.layoutMetrics.mossElectron.composerHeightPx).toBe(80);
    expect(report.layoutMetrics.mossElectron.normalizedEventRowCount).toBe(8);
    expect(report.layoutGateStatus).toBe("pass");

    await rm(root, { force: true, recursive: true });
  });

  it("ignores newer non-layout Moss reports when refreshing layout metrics", async () => {
    const root = join(process.cwd(), ".tmp", "moss-codex-desktop-comparator-non-layout-test");
    await rm(root, { force: true, recursive: true });
    await writeEvidence(root);

    const layoutSmokePath =
      ".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-test.json";
    const productSmokePath = ".moss/ledger/evidence/moss-electron-product-shell-smoke-test.json";
    await writeFile(
      join(root, layoutSmokePath),
      JSON.stringify(
        {
          firstScreenLayoutEvidence: {
            source: "electron-product-shell-smoke-layout-evidence",
            capturedAt: "2026-07-03T02:45:00.000+08:00",
            viewportWidthPx: 1280,
            viewportHeightPx: 768,
            composerTopPx: 646,
            composerBottomGapPx: 40,
            composerHeightPx: 80,
            sideAccessWidthPx: 224,
            sideAccessVisible: true,
            controlPlaneAffordanceCount: 4,
            requiredControlPlaneAffordanceCount: 4,
            normalizedEventRowCount: 8,
            timelineHeightPx: 416,
            timelineDensityRowsPer1000Px: 19.230769,
            evidence: [layoutSmokePath, ".moss/ledger/evidence/moss-shell-test.png"],
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(root, productSmokePath),
      JSON.stringify(
        {
          firstScreenLayoutEvidence: {
            source: "electron-product-shell-smoke-interaction-evidence",
            capturedAt: "2026-07-03T04:05:00.000+08:00",
            viewportWidthPx: 1280,
            viewportHeightPx: 768,
            composerTopPx: 646,
            composerBottomGapPx: 40,
            composerHeightPx: 80,
            sideAccessWidthPx: 224,
            sideAccessVisible: true,
            controlPlaneAffordanceCount: 4,
            requiredControlPlaneAffordanceCount: 4,
            normalizedEventRowCount: 1,
            timelineHeightPx: 404,
            timelineDensityRowsPer1000Px: 2.475248,
            evidence: [productSmokePath, ".moss/ledger/evidence/moss-shell-test.png"],
          },
        },
        null,
        2,
      ),
    );

    const raw = JSON.parse(
      validComparator({
        mossEvidence: [
          {
            label: "Moss promoted shell screenshot",
            path: ".moss/ledger/evidence/moss-shell-test.png",
            kind: "screenshot",
          },
          {
            label: "Moss interaction product smoke",
            path: productSmokePath,
            kind: "report",
          },
        ],
      }),
    ) as Record<string, unknown>;
    const layoutMetrics = raw.layoutMetrics as {
      codexDesktop: Record<string, unknown>;
      mossElectron: Record<string, unknown>;
    };
    layoutMetrics.codexDesktop = {
      ...layoutMetrics.codexDesktop,
      normalizedEventRowCount: 8,
      timelineHeightPx: 416,
      timelineDensityRowsPer1000Px: 19.230769,
    };
    layoutMetrics.mossElectron = {
      ...layoutMetrics.mossElectron,
      evidence: [layoutSmokePath, ".moss/ledger/evidence/moss-shell-test.png"],
    };

    const document = parseMossCodexDesktopComparatorDocument(
      JSON.stringify(raw),
      ".moss/codex-desktop-comparator.json",
    );
    const report = buildMossCodexDesktopComparatorReport(
      document,
      root,
      ".moss/codex-desktop-comparator.json",
    );

    expect(report.layoutMetrics.mossElectron.capturedAt).toBe("2026-07-03T02:45:00.000+08:00");
    expect(report.layoutMetrics.mossElectron.normalizedEventRowCount).toBe(8);
    expect(report.layoutGateStatus).toBe("pass");

    await rm(root, { force: true, recursive: true });
  });

  it("rejects attempts to claim full Codex Desktop parity", () => {
    expect(() =>
      parseMossCodexDesktopComparatorDocument(
        validComparator({ fullCodexParityClaim: true }),
        ".moss/codex-desktop-comparator.json",
      ),
    ).toThrow(".moss/codex-desktop-comparator.json.fullCodexParityClaim must be false");
  });

  it("rejects comparator documents without first-screen layout metrics", () => {
    const raw = JSON.parse(validComparator()) as Record<string, unknown>;
    delete raw.layoutMetrics;

    expect(() =>
      parseMossCodexDesktopComparatorDocument(
        JSON.stringify(raw),
        ".moss/codex-desktop-comparator.json",
      ),
    ).toThrow("layoutMetrics must be an object");
  });

  it("fails when the direct Codex screenshot is missing", async () => {
    const root = join(process.cwd(), ".tmp", "moss-codex-desktop-comparator-missing-shot-test");
    await rm(root, { force: true, recursive: true });
    await mkdir(join(root, ".moss", "ledger", "evidence"), { recursive: true });
    await writeFile(join(root, ".moss", "ledger", "evidence", "moss-shell-test.png"), PNG_1X1);
    await writeFile(
      join(root, ".moss", "ledger", "evidence", "moss-shell-density-test.md"),
      "# density\n",
    );

    const document = parseMossCodexDesktopComparatorDocument(
      validComparator(),
      ".moss/codex-desktop-comparator.json",
    );
    const report = buildMossCodexDesktopComparatorReport(
      document,
      root,
      ".moss/codex-desktop-comparator.json",
    );

    expect(report.gateStatus).toBe("fail");
    expect(report.issues).toContain(
      "codexDesktopBaseline.screenshotPath must point to an existing PNG image",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("fails when a comparison omits direct baseline evidence", async () => {
    const root = join(process.cwd(), ".tmp", "moss-codex-desktop-comparator-baseline-test");
    await rm(root, { force: true, recursive: true });
    await writeEvidence(root);
    const raw = JSON.parse(validComparator()) as Record<string, unknown>;
    raw.comparisons = (raw.comparisons as Record<string, unknown>[]).map((entry) => {
      if (entry.id !== "density") {
        return entry;
      }
      return {
        ...entry,
        directCodexDesktopBaseline: false,
      };
    });
    const document = parseMossCodexDesktopComparatorDocument(
      JSON.stringify(raw),
      ".moss/codex-desktop-comparator.json",
    );
    const report = buildMossCodexDesktopComparatorReport(
      document,
      root,
      ".moss/codex-desktop-comparator.json",
    );

    expect(report.gateStatus).toBe("fail");
    expect(report.issues).toContain(
      "comparison density must use direct Codex Desktop baseline evidence",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("fails with exact first-screen layout deltas", async () => {
    const root = join(process.cwd(), ".tmp", "moss-codex-desktop-comparator-layout-test");
    await rm(root, { force: true, recursive: true });
    await writeEvidence(root);
    const raw = JSON.parse(validComparator()) as Record<string, unknown>;
    const layoutMetrics = raw.layoutMetrics as {
      mossElectron: Record<string, unknown>;
    };
    layoutMetrics.mossElectron = {
      ...layoutMetrics.mossElectron,
      composerTopPx: 500,
      composerBottomGapPx: 90,
      composerHeightPx: 40,
      sideAccessWidthPx: 120,
      sideAccessVisible: false,
      controlPlaneAffordanceCount: 2,
      normalizedEventRowCount: 2,
      timelineHeightPx: 500,
      timelineDensityRowsPer1000Px: 4,
    };

    const document = parseMossCodexDesktopComparatorDocument(
      JSON.stringify(raw),
      ".moss/codex-desktop-comparator.json",
    );
    const report = buildMossCodexDesktopComparatorReport(
      document,
      root,
      ".moss/codex-desktop-comparator.json",
    );

    expect(report.layoutGateStatus).toBe("fail");
    expect(report.gateStatus).toBe("fail");
    expect(report.issues).toContain(
      "layout delta composer-position failed: topRatioDelta=0.190104 (max 0.020000), bottomGapDeltaPx=48 (max 8), heightDeltaPx=40 (max 12)",
    );
    expect(report.issues).toContain(
      "layout delta side-session-access failed: widthRatioDelta=0.081250 (max 0.020000), mossSideAccessVisible=false",
    );
    expect(report.issues).toContain(
      "layout delta control-plane-affordance-visibility failed: missingMossAffordances=2 (max 0), requiredMossAffordances=4, visibleMossAffordances=2",
    );
    expect(report.issues).toContain(
      "layout delta normalized-event-timeline-density failed: rowCountDelta=4 (max 1), mossDensityRowsPer1000Px=4 (min 12), densityRowsPer1000PxDelta=11.384615 (max 3)",
    );

    await rm(root, { force: true, recursive: true });
  });
});
