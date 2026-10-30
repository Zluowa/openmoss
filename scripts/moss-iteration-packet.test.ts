import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { mossIterationPacketExitCode, readMossIterationPacket } from "./moss-iteration-packet.ts";

async function writeMossRepo(
  root: string,
  input: {
    readonly tasksJsonl: string;
    readonly coverageJson?: string;
    readonly guiParityJson?: string;
  },
): Promise<void> {
  await rm(root, { force: true, recursive: true });
  await mkdir(join(root, ".moss", "ledger"), { recursive: true });
  await mkdir(join(root, ".moss", "roles"), { recursive: true });
  await mkdir(join(root, ".moss", "context"), { recursive: true });
  await writeFile(
    join(root, ".moss", "mission.md"),
    "# Moss Shell Mission\n\nBuild the control plane.\n",
  );
  await writeFile(
    join(root, ".moss", "ledger", "events.jsonl"),
    `${JSON.stringify({
      eventId: "moss-event-1",
      type: "moss.goal.defined",
      createdAt: "2026-07-01T00:00:00.000Z",
      payload: {
        goal: "Build a Codex-like shell",
        branch: "moss/control-plane-v1",
      },
    })}\n`,
  );
  await writeFile(join(root, ".moss", "ledger", "tasks.jsonl"), input.tasksJsonl);
  if (input.coverageJson) {
    await writeFile(join(root, ".moss", "prd-coverage.json"), input.coverageJson);
  }
  if (input.guiParityJson) {
    await writeFile(join(root, ".moss", "gui-parity.json"), input.guiParityJson);
  }
  await writeFile(join(root, ".moss", "roles", "memory-curator.md"), "# Memory Curator\n");
  await writeFile(join(root, ".moss", "roles", "qa-gatekeeper.md"), "# QA Gatekeeper\n");
  await writeFile(
    join(root, ".moss", "context", "current.md"),
    "# Moss Context Snapshot\n\n## Status\n\nCurrent implementation snapshot.\n\n## Next Tasks\n\n- Continue.\n",
  );
}

describe("moss-iteration-packet", () => {
  it("generates a deterministic packet from mission, active task, ledger, and context", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-1",
        status: "active",
        owner: "Memory Curator",
        title: "Add iteration packet generation for Moss loop automation",
        acceptance: ["Packet includes required verification commands"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet).toMatchObject({
      version: 1,
      generatedAt: "2026-07-01T00:00:00.000Z",
      objective: "Complete moss-task-1: Add iteration packet generation for Moss loop automation",
      mission: {
        title: "Moss Shell Mission",
        currentGoal: "Build a Codex-like shell",
        branch: "moss/control-plane-v1",
      },
      task: {
        taskId: "moss-task-1",
        owner: "Memory Curator",
        status: "active",
      },
      ledger: {
        releaseGateStatus: "pass",
        activeTaskIds: ["moss-task-1"],
        issueCount: 0,
      },
      context: {
        statusSummary: "Current implementation snapshot.",
      },
    });
    expect(packet.fileScope).toContain("scripts/moss-iteration-packet.ts");
    expect(packet.requiredVerificationCommands).toContain("bun run moss:status");
    expect(packet.acceptance).toEqual(["Packet includes required verification commands"]);
    expect(mossIterationPacketExitCode(packet)).toBe(0);

    await rm(root, { force: true, recursive: true });
  });

  it("routes PRD coverage tasks through the coverage matrix next gap", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-prd-coverage-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-74",
        status: "active",
        owner: "Product Steward",
        title: "Add PRD coverage audit matrix for Moss Shell completion",
        acceptance: ["Iteration packet routes from PRD coverage matrix"],
        evidence: [],
      })}\n`,
      coverageJson: JSON.stringify({
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
      }),
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:02:30.000Z",
    });

    expect(packet.sourceFiles).toContain(".moss/prd-coverage.json");
    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        ".moss/prd-coverage.json",
        ".moss/ledger/evidence/moss-prd-coverage-audit-2026-07-02.md",
        "scripts/lib/moss-prd-coverage.ts",
        "scripts/lib/moss-prd-coverage.test.ts",
        "scripts/moss-prd-coverage.ts",
      ]),
    );
    expect(packet.prdCoverage).toEqual({
      path: ".moss/prd-coverage.json",
      updatedAt: "2026-07-02T00:02:30.000Z",
      statusCounts: {
        proved: 1,
        partial: 1,
        missing: 0,
        unverified: 0,
      },
      nextGap: {
        id: "phase-5-codex-like-gui",
        section: "phase",
        status: "partial",
        requirement: "Complete Codex-like GUI parity",
        nextGap: "Add a concrete parity checklist and UI gate.",
        nextTaskHint: "Gate Codex-like GUI parity coverage from PRD matrix",
        evidence: ["apps/web/src/components/chat/MossControlPlanePanel.tsx"],
      },
    });
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run moss:prd-coverage -- --created-at 2026-07-02T00:02:30.000Z",
        "bun --filter @synara/scripts test -- moss-prd-coverage moss-iteration-packet moss-loop-status",
      ]),
    );
    expect(packet.recordActions).toContain(
      "Open the next task from .moss/prd-coverage.json gap phase-5-codex-like-gui: Gate Codex-like GUI parity coverage from PRD matrix",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes GUI parity tasks through the PRD-linked GUI parity gate", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-gui-parity-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-75",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Gate Codex-like GUI parity coverage from PRD matrix",
        acceptance: ["Iteration packet carries GUI parity metadata"],
        evidence: [],
        metadata: {
          prdCoverage: {
            gapId: "phase-5-codex-like-gui",
            source: ".moss/prd-coverage.json",
            status: "partial",
          },
        },
      })}\n`,
      coverageJson: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-02T00:02:30.000Z",
        summary: {
          nextGapId: "phase-5-codex-like-gui",
        },
        rows: [
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
      }),
      guiParityJson: JSON.stringify({
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
          selectors: ["[data-normal-chat-shell]", "[data-chat-composer-form='true']"],
          evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
          gap: "Composer command states need a top-level gate.",
        },
        surfaces: [
          {
            id: "session-list",
            label: "Session list",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Show provider sessions.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-control-plane-session-list]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Promote the internal list into the final shell.",
          },
          {
            id: "composer",
            label: "Composer",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Gate composer command states.",
            status: "partial",
            visibleShellSlice: true,
            selectors: ["[data-chat-composer-form='true']"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Add send and stop state coverage.",
            nextTaskHint: "Gate visible composer and session controls against GUI parity checklist",
          },
          {
            id: "tool-permission-flow",
            label: "Tool and permission flow",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Render tool and permission state.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-normalized-permission-action-shell]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Prove every provider action path.",
          },
          {
            id: "normalized-event-timeline",
            label: "Normalized event timeline",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Render normalized events.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-normalized-row]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Move normalized rendering into the final transcript.",
          },
          {
            id: "launch-plan-inspector",
            label: "Launch Plan Inspector",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Inspect selected session Launch Plan.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-control-plane-launch-plan]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Make launch-plan access native to the final shell.",
          },
        ],
      }),
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:02:40.000Z",
    });

    expect(packet.sourceFiles).toEqual(
      expect.arrayContaining([".moss/prd-coverage.json", ".moss/gui-parity.json"]),
    );
    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        ".moss/gui-parity.json",
        ".moss/final-shell-parity.json",
        ".moss/ledger/evidence/moss-gui-parity-gate-2026-07-02.md",
        ".moss/ledger/evidence/moss-visible-composer-session-controls-2026-07-02.md",
        ".moss/ledger/evidence/moss-final-shell-parity-audit-2026-07-02.md",
        "scripts/lib/moss-gui-parity.ts",
        "scripts/lib/moss-gui-parity.test.ts",
        "scripts/moss-gui-parity.ts",
        "scripts/lib/moss-final-shell-parity.ts",
        "scripts/lib/moss-final-shell-parity.test.ts",
        "scripts/moss-final-shell-parity.ts",
        "apps/web/src/components/ChatView.tsx",
        "apps/web/src/components/ChatView.browser.tsx",
        "apps/web/src/components/chat/ComposerExtrasMenu.tsx",
        "apps/web/src/components/chat/ComposerPendingApprovalActions.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
      ]),
    );
    expect(packet.guiParity).toMatchObject({
      path: ".moss/gui-parity.json",
      updatedAt: "2026-07-02T00:02:40.000Z",
      prdCoverageRowId: "phase-5-codex-like-gui",
      overallStatus: "partial",
      gateStatus: "pass",
      nextGap: {
        id: "composer",
        status: "partial",
        nextTaskHint: "Gate visible composer and session controls against GUI parity checklist",
      },
    });
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/web test -- MossControlPlanePanel",
        "bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx",
        'bun --filter @synara/web test:browser -- ChatView.browser.tsx -t "Moss visible"',
        "bun --filter @synara/web typecheck",
        "bun run moss:gui-parity -- --created-at 2026-07-02T00:02:40.000Z",
        "bun run moss:final-shell-parity -- --created-at 2026-07-02T00:02:40.000Z",
        "bun --filter @synara/scripts test -- moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
      ]),
    );
    expect(packet.risks).toContain(
      "The GUI parity gate must not claim full Codex Desktop parity from internal Moss panel evidence.",
    );
    expect(packet.recordActions).toContain(
      "Open the next GUI parity task from .moss/gui-parity.json gap composer: Gate visible composer and session controls against GUI parity checklist",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes direct Codex Desktop comparator tasks through the comparator gate", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-codex-comparator-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-84",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Add direct Codex Desktop comparator for final shell parity",
        acceptance: ["Comparator uses current Codex Desktop baseline evidence"],
        evidence: [],
        metadata: {
          prdCoverage: {
            gapId: "phase-5-codex-like-gui",
            source: ".moss/prd-coverage.json",
            status: "partial",
          },
        },
      })}\n`,
      coverageJson: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-02T00:11:00.000Z",
        summary: {
          nextGapId: "phase-5-codex-like-gui",
        },
        rows: [
          {
            id: "phase-5-codex-like-gui",
            section: "phase",
            requirement: "Codex-like GUI",
            status: "partial",
            evidence: [".moss/gui-parity.json"],
            nextGap: "Add direct comparator.",
            nextTaskHint: "Add direct Codex Desktop comparator for final shell parity",
          },
        ],
      }),
      guiParityJson: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-02T00:11:00.000Z",
        prdCoverageRowId: "phase-5-codex-like-gui",
        overallStatus: "partial",
        fullCodexParityClaim: false,
        summary: {
          nextGapId: "final-shell-parity",
        },
        firstVisibleShell: {
          status: "gated",
          selectors: ["[data-normal-chat-shell]"],
          evidence: ["apps/web/src/components/ChatView.browser.tsx"],
          gap: "Need final comparator.",
        },
        surfaces: [
          {
            id: "session-list",
            label: "Session list",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Show sessions.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-session-list-row]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.tsx"],
            gap: "Covered.",
          },
          {
            id: "composer",
            label: "Composer",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Show composer.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-chat-composer-form='true']"],
            evidence: ["apps/web/src/components/ChatView.browser.tsx"],
            gap: "Covered.",
          },
          {
            id: "tool-permission-flow",
            label: "Tool and permission flow",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Show permissions.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-normalized-permission-action-shell]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Covered.",
          },
          {
            id: "normalized-event-timeline",
            label: "Normalized event timeline",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Show normalized events.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-normalized-row]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Covered.",
          },
          {
            id: "launch-plan-inspector",
            label: "Launch Plan Inspector",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Show launch plan.",
            status: "gated",
            visibleShellSlice: true,
            selectors: ["[data-moss-launch-plan]"],
            evidence: ["apps/web/src/components/chat/MossControlPlanePanel.browser.tsx"],
            gap: "Covered.",
          },
          {
            id: "final-shell-parity",
            label: "Final shell parity",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Compare final shell.",
            status: "partial",
            visibleShellSlice: true,
            selectors: ["[data-moss-native-shell-access='true']"],
            evidence: [".moss/final-shell-parity.json"],
            gap: "Needs direct comparator.",
            nextTaskHint: "Add direct Codex Desktop comparator for final shell parity",
          },
        ],
      }),
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:11:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        ".moss/codex-desktop-comparator.json",
        ".moss/ledger/evidence/codex-desktop-current-shell-2026-07-02.png",
        ".moss/ledger/evidence/moss-codex-desktop-comparator-2026-07-02.md",
        "scripts/lib/moss-codex-desktop-comparator.ts",
        "scripts/lib/moss-codex-desktop-comparator.test.ts",
        "scripts/moss-codex-desktop-comparator.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/scripts test -- moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
        "bun run moss:codex-desktop-comparator -- --created-at 2026-07-02T00:11:00.000Z",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes Moss shell productization tasks through product route smoke gates", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-product-shell-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-85",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Productize default-off Moss shell gate for final shell parity",
        acceptance: ["Moss shell opens from an explicit product route toggle"],
        evidence: [],
        metadata: {
          prdCoverage: {
            gapId: "phase-5-codex-like-gui",
            source: ".moss/prd-coverage.json",
            status: "partial",
          },
        },
      })}\n`,
      coverageJson: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-02T00:12:00.000Z",
        summary: {
          nextGapId: "phase-5-codex-like-gui",
        },
        rows: [
          {
            id: "phase-5-codex-like-gui",
            section: "phase",
            requirement: "Codex-like GUI",
            status: "partial",
            evidence: [".moss/gui-parity.json"],
            nextGap: "Productize route gate.",
            nextTaskHint: "Productize default-off Moss shell gate for final shell parity",
          },
        ],
      }),
      guiParityJson: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-02T00:12:00.000Z",
        prdCoverageRowId: "phase-5-codex-like-gui",
        overallStatus: "partial",
        fullCodexParityClaim: false,
        summary: {
          nextGapId: "final-shell-parity",
        },
        firstVisibleShell: {
          status: "gated",
          selectors: ["[data-normal-chat-shell]"],
          evidence: ["apps/web/src/components/ChatView.browser.tsx"],
          gap: "Need product route gate.",
        },
        surfaces: [
          {
            id: "final-shell-parity",
            label: "Final shell parity",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Compare final shell.",
            status: "partial",
            visibleShellSlice: true,
            selectors: ["[data-moss-native-shell-access='true']"],
            evidence: [".moss/final-shell-parity.json"],
            gap: "Needs productization.",
            nextTaskHint: "Productize default-off Moss shell gate for final shell parity",
          },
        ],
      }),
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:12:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "apps/web/src/mossShellProductization.ts",
        "apps/web/src/mossShellProductization.test.ts",
        "apps/web/src/diffRouteSearch.ts",
        "apps/web/src/routes/_chat.$threadId.tsx",
        "scripts/moss-promoted-shell-served-smoke.ts",
        ".moss/ledger/evidence/moss-promoted-shell-product-route-smoke-2026-07-02.json",
        ".moss/ledger/evidence/moss-shell-product-route-toggle-2026-07-02.md",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/web test -- diffRouteSearch mossShellProductization",
        'bun --filter @synara/web test:browser -- ChatView.browser.tsx -t "Moss product shell"',
        "node scripts/moss-promoted-shell-served-smoke.ts --created-at 2026-07-02T00:12:00.000Z --report .moss/ledger/evidence/moss-promoted-shell-product-route-smoke-2026-07-02.json --screenshot .moss/ledger/evidence/moss-promoted-shell-product-route-smoke-2026-07-02.png",
        "bun run moss:ui-smoke",
        "bun run moss:codex-desktop-comparator -- --created-at 2026-07-02T00:12:00.000Z",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes Electron desktop product-shell smoke tasks through desktop shell gates", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-desktop-product-shell-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-0086",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Gate Electron desktop product-shell smoke for final shell parity",
        acceptance: ["Moss shell product route is verified inside the Electron desktop runtime"],
        evidence: [],
        metadata: {
          prdCoverage: {
            gapId: "phase-5-codex-like-gui",
            source: ".moss/prd-coverage.json",
            status: "partial",
          },
        },
      })}\n`,
      coverageJson: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-02T00:12:00.000Z",
        summary: {
          nextGapId: "phase-5-codex-like-gui",
        },
        rows: [
          {
            id: "phase-5-codex-like-gui",
            section: "phase",
            requirement: "Codex-like GUI",
            status: "partial",
            evidence: [".moss/gui-parity.json"],
            nextGap: "Electron desktop product-shell smoke.",
            nextTaskHint: "Gate Electron desktop product-shell smoke for final shell parity",
          },
        ],
      }),
      guiParityJson: JSON.stringify({
        version: 1,
        updatedAt: "2026-07-02T00:12:00.000Z",
        prdCoverageRowId: "phase-5-codex-like-gui",
        overallStatus: "partial",
        fullCodexParityClaim: false,
        summary: {
          nextGapId: "final-shell-parity",
        },
        firstVisibleShell: {
          status: "gated",
          selectors: ["[data-normal-chat-shell]"],
          evidence: ["apps/web/src/components/ChatView.browser.tsx"],
          gap: "Need desktop product-shell smoke.",
        },
        surfaces: [
          {
            id: "final-shell-parity",
            label: "Final shell parity",
            prdCoverageRowId: "phase-5-codex-like-gui",
            requirement: "Compare final shell.",
            status: "partial",
            visibleShellSlice: true,
            selectors: ["[data-moss-native-shell-access='true']"],
            evidence: [".moss/final-shell-parity.json"],
            gap: "Needs Electron desktop proof.",
            nextTaskHint: "Gate Electron desktop product-shell smoke for final shell parity",
          },
        ],
      }),
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:12:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "apps/desktop/src/main.ts",
        "apps/desktop/src/preload.ts",
        "apps/desktop/src/backendNodeOptions.ts",
        "apps/desktop/scripts/smoke-test.mjs",
        "apps/desktop/scripts/moss-product-shell-smoke.mjs",
        "scripts/moss-electron-product-shell-smoke-gate.ts",
        "scripts/moss-electron-product-shell-smoke-gate.test.ts",
        "scripts/lib/moss-release-gate-manifest.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-loop-ledger-snapshot.test.ts",
        "package.json",
        ".moss/codex-desktop-comparator.json",
        ".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.md",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run test:desktop-smoke",
        "bun --filter @synara/scripts test -- moss-electron-product-shell-smoke-gate moss-release-gate moss-release-gate-report-index moss-loop-ledger-snapshot moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
        "bun run moss:electron-product-shell-smoke-gate -- --created-at 2026-07-02T00:12:00.000Z",
        "bun run moss:electron-product-shell-smoke -- --created-at 2026-07-02T00:12:00.000Z --report .moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.json --screenshot .moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.png",
        'bun --filter @synara/web test:browser -- ChatView.browser.tsx -t "Moss product shell"',
        "bun run moss:codex-desktop-comparator -- --created-at 2026-07-02T00:12:00.000Z",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes first-screen layout comparator release-readiness tasks through the layout gate", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-layout-gate-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-0089",
        status: "active",
        owner: "Release Operator",
        title: "Gate first-screen layout comparator in release readiness",
        acceptance: ["Layout comparator is part of release readiness"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T17:20:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        ".moss/codex-desktop-comparator.json",
        ".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-2026-07-03.json",
        ".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-2026-07-03.png",
        ".moss/ledger/evidence/moss-first-screen-layout-comparator-2026-07-03.md",
        "scripts/moss-codex-desktop-layout-gate.ts",
        "scripts/moss-codex-desktop-layout-gate.test.ts",
        "scripts/lib/moss-release-gate-manifest.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run moss:release-gate -- --created-at 2026-07-02T17:20:00.000Z",
        "bun run moss:codex-desktop-layout-gate -- --created-at 2026-07-02T17:20:00.000Z",
        "bun --filter @synara/scripts test -- moss-codex-desktop-layout-gate moss-release-gate moss-release-gate-report-index moss-loop-ledger-snapshot moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
        "bun run moss:codex-desktop-comparator -- --created-at 2026-07-02T17:20:00.000Z",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("fails when no active task exists", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-no-active-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-1",
        status: "done",
        owner: "QA Gatekeeper",
        title: "Completed task",
        evidence: ["evidence.md"],
      })}\n`,
    });

    await expect(
      readMossIterationPacket(root, {
        createdAt: "2026-07-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("no active Moss task found");

    await rm(root, { force: true, recursive: true });
  });

  it("does not duplicate role assignments when the task owner is also a gate role", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-owner-role-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-2",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Add review packet generation for Moss loop automation",
        acceptance: ["Review packet separates QA from Reviewer"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const qaAssignments = packet.roleAssignments.filter(
      (assignment) => assignment.role === "QA Gatekeeper",
    );

    expect(qaAssignments).toHaveLength(1);
    expect(packet.roleAssignments.map((assignment) => assignment.role)).toEqual([
      "QA Gatekeeper",
      "Reviewer",
      "Memory Curator",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("includes aggregate loop packet scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-loop-packet-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-3",
        status: "active",
        owner: "Release Operator",
        title: "Add Moss loop packet aggregate gate",
        acceptance: ["Aggregate gate reports packet readiness"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet.test.ts",
        "scripts/moss-review-packet.ts",
        "scripts/moss-memory-packet.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run moss:loop-packet -- --created-at 2026-07-01T00:00:00.000Z",
        "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes loop packet refresh plan dashboard gate tasks through refresh plan index checks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-refresh-plan-dashboard-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-66",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Gate loop packet on refresh plan dashboard evidence",
        acceptance: ["Loop packet validates refresh plan dashboard evidence"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:30.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet.test.ts",
        "scripts/lib/moss-loop-ledger-snapshot.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-constants.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-report-index.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run moss:loop-packet -- --created-at 2026-07-02T00:01:30.000Z",
        "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:30.000Z",
        "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-ledger-snapshot moss-release-freshness-refresh-plan-report-index moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes loop packet refresh plan dashboard gate report tasks through compact report checks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-refresh-plan-dashboard-report-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-67",
        status: "active",
        owner: "Release Operator",
        title: "Persist loop packet refresh plan dashboard gate report evidence",
        acceptance: ["Compact report index validates refresh plan dashboard gate evidence"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:35.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet.test.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-loop-packet-refresh-plan-gate-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-report-index.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:01:35.000Z",
        "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:35.000Z",
        "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:01:35.000Z",
        "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-packet-refresh-plan-report-index moss-release-freshness-refresh-plan-report-index moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("routes loop packet refresh plan report index release-readiness tasks through release gate checks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-loop-refresh-plan-index-release-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-68",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Gate release readiness on loop packet refresh plan report index",
        acceptance: [
          "moss:release-gate validates the latest loop packet refresh plan gate report index before release readiness gates continue",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:40.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/lib/moss-release-gate-manifest.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-loop-packet-refresh-plan-gate-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-release-gate-report-index.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 12)).toEqual([
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:release-gate -- --report --created-at 2026-07-02T00:01:40.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      "bun run moss:loop-packet-freshness-refresh-artifact -- --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:release-gate-refresh-artifact -- --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-02T00:01:40.000Z",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:01:40.000Z",
    ]);
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-freshness-refresh-plan-report-index moss-loop-packet-freshness-report-index moss-iteration-packet moss-loop-status",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("includes Moss UI smoke aggregate gate scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-ui-smoke-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-46",
        status: "active",
        owner: "Release Operator",
        title: "Add Moss control-plane UI smoke aggregate gate",
        acceptance: ["UI smoke gate runs without provider credentials"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-ui-smoke.ts",
        "scripts/moss-ui-smoke.test.ts",
        "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
        "apps/web/src/components/chat/mossNormalizedTimeline.browser.tsx",
      ]),
    );
    expect(packet.fileScope).not.toContain("scripts/moss-loop-packet.ts");
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run moss:ui-smoke",
        "bun --filter @synara/scripts test -- moss-ui-smoke moss-iteration-packet moss-loop-status",
      ]),
    );
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun run moss:loop-packet -- --created-at 2026-07-01T00:00:00.000Z",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("includes Moss release gate manifest scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-release-gate-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-47",
        status: "active",
        owner: "Release Operator",
        title: "Add Moss release gate command manifest",
        acceptance: ["Release gate manifest lists core commands"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-loop-status.ts",
        "apps/server/src/provider/mossProviderReplay.ts",
        "scripts/moss-ui-smoke.ts",
        "scripts/moss-loop-packet.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun run moss:release-gate -- --created-at 2026-07-01T00:00:00.000Z",
        "bun --filter @synara/scripts test -- moss-release-gate moss-iteration-packet moss-loop-status",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("uses compact report verification for Moss release gate report tasks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-release-gate-report-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-48",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Add Moss release gate compact report mode",
        acceptance: ["Release gate emits compact reports"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.requiredVerificationCommands).toContain(
      "bun run moss:release-gate -- --report --created-at 2026-07-01T00:00:00.000Z",
    );
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun run moss:release-gate -- --created-at 2026-07-01T00:00:00.000Z",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("uses artifact output verification for Moss release gate report artifact tasks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-release-gate-artifact-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-49",
        status: "active",
        owner: "Release Operator",
        title: "Persist Moss release gate report artifact",
        acceptance: ["Release gate writes compact report artifact"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.requiredVerificationCommands).toContain(
      "bun run moss:release-gate -- --report --output .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json --created-at 2026-07-01T00:00:00.000Z",
    );
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun run moss:release-gate -- --created-at 2026-07-01T00:00:00.000Z",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("uses artifact index verification for Moss release gate report artifact index tasks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-release-gate-artifact-index-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-50",
        status: "active",
        owner: "Release Operator",
        title: "Index Moss release gate report artifacts",
        acceptance: ["Release gate report artifact index is command-routed"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-iteration-packet.ts",
        "scripts/moss-loop-status.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands).toContain(
      "bun run moss:release-gate-report-index -- --created-at 2026-07-01T00:00:00.000Z",
    );
    expect(packet.requiredVerificationCommands).toContain(
      "bun --filter @synara/scripts test -- moss-release-gate-report-index moss-iteration-packet moss-loop-status",
    );
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun run moss:release-gate -- --report --output .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json --created-at 2026-07-01T00:00:00.000Z",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("uses release gate verification for report artifact index readiness gate tasks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-release-readiness-artifact-index-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-51",
        status: "active",
        owner: "Release Operator",
        title: "Gate Moss release readiness on report artifact index",
        acceptance: ["Release gate includes the report artifact index"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands).toContain(
      "bun run moss:release-gate -- --created-at 2026-07-01T00:00:00.000Z",
    );
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun run moss:release-gate-report-index -- --created-at 2026-07-01T00:00:00.000Z",
    );
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun run moss:release-gate -- --report --output .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json --created-at 2026-07-01T00:00:00.000Z",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("uses report output and index verification for release gate report index gate artifact tasks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-release-gate-report-index-gate-artifact-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-52",
        status: "active",
        owner: "Release Operator",
        title: "Persist release gate report index gate artifacts",
        acceptance: ["Release gate writes a nine-gate compact report artifact"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-iteration-packet.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 3)).toEqual([
      "bun run moss:release-gate -- --report --output .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json --created-at 2026-07-01T00:00:00.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-01T00:00:00.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-iteration-packet moss-loop-status",
    ]);
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun --filter @synara/scripts test -- moss-release-gate-report-index moss-iteration-packet moss-loop-status",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("uses compact report and index verification for manifest freshness evidence tasks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-release-report-freshness-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-54",
        status: "active",
        owner: "Release Operator",
        title: "Gate release reports on manifest freshness evidence",
        acceptance: ["Release gate report records manifest freshness evidence"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-iteration-packet.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 3)).toEqual([
      "bun run moss:release-gate -- --report --created-at 2026-07-01T00:00:00.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-01T00:00:00.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-iteration-packet moss-loop-status",
    ]);
    expect(packet.requiredVerificationCommands).not.toContain(
      "bun run moss:release-gate -- --created-at 2026-07-01T00:00:00.000Z",
    );

    await rm(root, { force: true, recursive: true });
  });

  it("uses artifact output and index verification for freshness report artifact tasks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-release-report-freshness-artifact-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-55",
        status: "active",
        owner: "Release Operator",
        title: "Persist release gate freshness report artifact",
        acceptance: ["Release gate report artifact keeps freshness evidence"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-iteration-packet.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 3)).toEqual([
      "bun run moss:release-gate -- --report --output .moss/ledger/evidence/moss-release-gate-report-artifact-2026-07-01.json --created-at 2026-07-01T00:00:00.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-01T00:00:00.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes dashboard freshness release readiness tasks through loop packet and release gate checks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-dashboard-freshness-gate-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-57",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Gate release freshness dashboard evidence in release readiness",
        acceptance: ["Release readiness validates dashboard freshness evidence"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet.test.ts",
        "scripts/moss-loop-ledger-snapshot.ts",
        "scripts/lib/moss-loop-ledger-snapshot.ts",
        "scripts/lib/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 3)).toEqual([
      "bun run moss:release-gate -- --created-at 2026-07-01T00:00:00.000Z",
      "bun run moss:loop-packet -- --created-at 2026-07-01T00:00:00.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-loop-packet moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes loop packet freshness report tasks through artifact output and index checks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-loop-freshness-report-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-58",
        status: "active",
        owner: "Release Operator",
        title: "Persist loop packet freshness gate report evidence",
        acceptance: ["Loop packet freshness report artifact is persisted"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet.test.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/lib/moss-loop-packet-freshness-gate-report-index.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 3)).toEqual([
      "bun run moss:loop-packet -- --report --output .moss/ledger/evidence/moss-loop-packet-freshness-gate-report-2026-07-02.json --created-at 2026-07-02T00:00:00.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:00:00.000Z",
      "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-packet-freshness-report-index moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes loop packet freshness report index release-readiness tasks through release gate checks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-loop-freshness-index-release-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-59",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Gate release readiness on loop packet freshness report index",
        acceptance: [
          "moss:release-gate validates the latest loop packet freshness gate report index before release readiness continues",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/lib/moss-release-gate-manifest.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/lib/moss-loop-packet-freshness-gate-report-index.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 4)).toEqual([
      "bun run moss:release-gate -- --created-at 2026-07-02T00:00:00.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:00:00.000Z",
      "bun run moss:loop-packet -- --created-at 2026-07-02T00:00:00.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-loop-packet-freshness-report-index moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes release report artifact refresh tasks through refresh and post-refresh gates", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-release-refresh-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-60",
        status: "active",
        owner: "Release Operator",
        title: "Add safe release report artifact refresh path for manifest changes",
        acceptance: ["Release gate refresh writes a current artifact after manifest changes"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:00:45.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/lib/moss-release-gate-manifest.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-status.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 5)).toEqual([
      "bun run moss:release-gate-refresh-artifact -- --created-at 2026-07-02T00:00:45.000Z",
      "bun run moss:loop-packet -- --created-at 2026-07-02T00:00:45.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-02T00:00:45.000Z",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:00:45.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-loop-packet moss-loop-ledger-snapshot moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes release gate artifact refresh after loop refresh plan chain tasks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-release-refresh-after-chain-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-70",
        status: "active",
        owner: "Release Operator",
        title: "Refresh release gate artifact after loop refresh plan chain",
        acceptance: [
          "moss:release-gate-refresh-artifact records the latest 11-step refresh plan and loop refresh-plan report observed evidence",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:50.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.test.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 10)).toEqual([
      "bun run moss:loop-packet-freshness-refresh-artifact -- --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:release-gate-refresh-artifact -- --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-02T00:01:50.000Z",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:01:50.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-loop-packet-freshness-report-index moss-release-freshness-refresh-plan-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes release artifact freshness after chained refresh reports tasks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-release-artifact-freshness-after-chain-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-71",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Gate release artifact freshness after chained refresh reports",
        acceptance: [
          "moss:release-gate-report-index fails refreshed release artifacts whose observed evidence predates the artifact",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:02:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/lib/moss-release-gate-report-index.ts",
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.test.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 11)).toEqual([
      "bun run moss:release-gate-report-index -- --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:loop-packet-freshness-refresh-artifact -- --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:release-gate-refresh-artifact -- --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-02T00:02:00.000Z",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:02:00.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate-report-index moss-release-gate moss-loop-packet-freshness-report-index moss-release-freshness-refresh-plan-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes explicit chained refresh task provenance tasks through the full refresh chain", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-explicit-chained-provenance-test",
    );
    const metadata = {
      chainedRefreshProvenance: {
        kind: "release-artifact-chain-freshness",
        expected: true,
      },
    };
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-72",
        status: "active",
        owner: "Architect",
        title: "Make chained refresh task provenance explicit",
        acceptance: [
          "Release artifact freshness gates read the expected chained refresh task from explicit metadata",
        ],
        evidence: [],
        metadata,
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:02:10.000Z",
    });

    expect(packet.task.metadata).toEqual(metadata);
    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/lib/moss-chained-refresh-provenance.ts",
        "scripts/lib/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet.test.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 11)).toEqual([
      "bun run moss:iteration-packet -- --created-at 2026-07-02T00:02:10.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate-report-index moss-release-gate moss-loop-packet moss-loop-packet-freshness-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      "bun run moss:loop-packet-freshness-refresh-artifact -- --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:release-gate-refresh-artifact -- --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-02T00:02:10.000Z",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:02:10.000Z",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes loop packet freshness artifact refresh tasks through refreshed index and compact release report checks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-loop-freshness-refresh-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-61",
        status: "active",
        owner: "Release Operator",
        title: "Refresh loop packet freshness report artifact after release artifact refresh",
        acceptance: [
          "Refreshed loop packet freshness report artifact records release freshness against the refreshed release artifact",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:00:55.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/lib/moss-loop-packet-freshness-gate-report-index.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 4)).toEqual([
      "bun run moss:loop-packet-freshness-refresh-artifact -- --created-at 2026-07-02T00:00:55.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:00:55.000Z",
      "bun run moss:release-gate -- --report --created-at 2026-07-02T00:00:55.000Z",
      "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-packet-freshness-report-index moss-release-gate moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes chained release freshness refresh plan tasks through dry-run plan checks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-refresh-plan-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-62",
        status: "active",
        owner: "Release Operator",
        title: "Automate chained release freshness refresh plan",
        acceptance: [
          "A dedicated dry-run refresh plan lists the safe order for release and loop freshness artifact refresh",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-freshness-refresh-plan.ts",
        "scripts/moss-release-freshness-refresh-plan.test.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/lib/moss-loop-packet-freshness-gate-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-loop-packet-refresh-plan-gate-report-index.ts",
        "scripts/lib/moss-release-gate-manifest.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 7)).toEqual([
      "bun run moss:release-freshness-refresh-plan -- --created-at 2026-07-02T00:01:00.000Z",
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json --created-at 2026-07-02T00:01:00.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:00.000Z",
      "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:01:00.000Z",
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:01:00.000Z",
      "bun --filter @synara/scripts test -- moss-release-freshness-refresh-plan moss-release-freshness-refresh-plan-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:01:00.000Z",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes loop refresh plan report refresh tasks through the chained refresh plan", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-loop-refresh-plan-chain-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-69",
        status: "active",
        owner: "Release Operator",
        title: "Add loop refresh plan report refresh to chained release freshness plan",
        acceptance: [
          "moss:release-freshness-refresh-plan includes explicit steps to refresh and index the loop packet refresh plan gate report",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:45.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-freshness-refresh-plan.ts",
        "scripts/moss-release-freshness-refresh-plan.test.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-constants.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-loop-packet-refresh-plan-gate-report-index.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 7)).toEqual([
      "bun run moss:release-freshness-refresh-plan -- --created-at 2026-07-02T00:01:45.000Z",
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json --created-at 2026-07-02T00:01:45.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:45.000Z",
      "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:01:45.000Z",
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:01:45.000Z",
      "bun --filter @synara/scripts test -- moss-release-freshness-refresh-plan moss-release-freshness-refresh-plan-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:01:45.000Z",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes release freshness refresh plan artifact tasks through output and index checks", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-refresh-plan-artifact-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-63",
        status: "active",
        owner: "Release Operator",
        title: "Persist chained refresh plan report artifact",
        acceptance: [
          "A compact refresh plan artifact records generatedAt, mode, step order, artifact output paths, readiness state, and write flags",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:05.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-freshness-refresh-plan.ts",
        "scripts/moss-release-freshness-refresh-plan.test.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-constants.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-gate.ts",
        "scripts/moss-loop-packet.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 3)).toEqual([
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02.json --created-at 2026-07-02T00:01:05.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:05.000Z",
      "bun --filter @synara/scripts test -- moss-release-freshness-refresh-plan moss-release-freshness-refresh-plan-report-index moss-iteration-packet moss-loop-status",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("routes refresh plan report index release-readiness tasks through release gate refresh checks", async () => {
    const root = join(
      process.cwd(),
      ".tmp",
      "moss-iteration-packet-refresh-plan-index-release-test",
    );
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-64",
        status: "active",
        owner: "QA Gatekeeper",
        title: "Gate release readiness on refresh plan report index",
        acceptance: [
          "moss:release-gate validates the latest refresh plan report index before release readiness continues",
        ],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-02T00:01:15.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "scripts/moss-release-gate.ts",
        "scripts/moss-release-gate.test.ts",
        "scripts/lib/moss-release-gate-manifest.ts",
        "scripts/moss-release-freshness-refresh-plan.ts",
        "scripts/moss-release-freshness-refresh-plan.test.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-constants.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet.ts",
        "scripts/moss-loop-packet-freshness-report-index.ts",
        "scripts/moss-loop-packet-freshness-report-index.test.ts",
        "scripts/lib/moss-loop-packet-freshness-gate-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.ts",
        "scripts/moss-loop-packet-refresh-plan-report-index.test.ts",
        "scripts/lib/moss-loop-packet-refresh-plan-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.ts",
        "scripts/moss-release-gate-report-index.test.ts",
        "scripts/lib/moss-release-gate-report-index.ts",
        "package.json",
      ]),
    );
    expect(packet.requiredVerificationCommands.slice(0, 12)).toEqual([
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:release-gate -- --report --created-at 2026-07-02T00:01:15.000Z",
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-freshness-refresh-plan-report-index moss-loop-packet-freshness-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      "bun run moss:loop-packet-freshness-refresh-artifact -- --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:loop-packet-freshness-report-index -- --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-2026-07-02-gate.json --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:release-freshness-refresh-plan-report-index -- --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-2026-07-02.json --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:loop-packet-refresh-plan-report-index -- --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:release-gate-refresh-artifact -- --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:release-gate-report-index -- --created-at 2026-07-02T00:01:15.000Z",
      "bun run moss:release-gate -- --created-at 2026-07-02T00:01:15.000Z",
    ]);

    await rm(root, { force: true, recursive: true });
  });

  it("includes loop ledger dashboard scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-dashboard-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-4",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Add Loop Ledger Dashboard snapshot and renderer",
        acceptance: ["Dashboard renders typed snapshots"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "apps/web/src/components/chat/mossLoopLedgerDashboardModel.ts",
        "apps/web/src/components/chat/mossLoopLedgerDashboard.tsx",
        "apps/web/src/components/chat/mossLoopLedgerDashboard.test.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.test.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
        "apps/web/src/wsNativeApi.ts",
        "apps/server/src/provider/Services/ProviderService.ts",
        "apps/server/src/provider/Layers/ProviderService.ts",
        "apps/server/src/wsRpc.ts",
        "packages/contracts/src/ws.ts",
        "packages/contracts/src/rpc.ts",
        "scripts/lib/moss-loop-ledger-snapshot.ts",
        "scripts/lib/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.ts",
        "scripts/moss-release-freshness-refresh-plan-report-index.test.ts",
        "scripts/moss-loop-ledger-snapshot.ts",
        "scripts/moss-loop-ledger-snapshot.test.ts",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/web test -- mossLoopLedgerDashboard MossControlPlanePanel",
        "bun --filter @synara/contracts test -- mossLoopLedgerDashboard rpc ws",
        "bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx",
        "bun --filter t3 test -- ProviderService",
        "bun run moss:loop-ledger-snapshot -- --created-at 2026-07-01T00:00:00.000Z",
        "bun --filter @synara/scripts test -- moss-loop-ledger-snapshot moss-release-freshness-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("includes Moss Control session summary UI scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-session-summary-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-5",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Add Codex-like Moss session summary strip",
        acceptance: ["Summary renders typed session state"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "apps/web/src/components/chat/MossControlPlanePanel.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.test.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
        "apps/web/src/components/chat/mossNormalizedTimeline.tsx",
        "apps/web/src/components/chat/mossLaunchPlanInspector.tsx",
        "apps/web/src/components/chat/mossLoopLedgerDashboard.tsx",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/web test -- MossControlPlanePanel",
        "bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx",
        "bun --filter @synara/web typecheck",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("includes Moss normalized timeline filter UI scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-timeline-filter-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-6",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Add Moss normalized timeline event filter controls",
        acceptance: ["Timeline filters use normalized event types"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "apps/web/src/components/chat/mossNormalizedTimeline.tsx",
        "apps/web/src/components/chat/mossNormalizedTimeline.test.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/web test -- mossNormalizedTimeline",
        "bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx",
        "bun --filter @synara/web typecheck",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("includes Moss permission request timeline state scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-permission-state-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-7",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Add Moss permission request timeline state affordances",
        acceptance: ["Permission request rows show typed status metadata"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "apps/web/src/components/chat/mossNormalizedTimeline.tsx",
        "apps/web/src/components/chat/mossNormalizedTimeline.test.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/web test -- mossNormalizedTimeline",
        "bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx",
        "bun --filter @synara/web typecheck",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });

  it("includes Moss tool lifecycle grouping timeline scope and verification commands", async () => {
    const root = join(process.cwd(), ".tmp", "moss-iteration-packet-tool-lifecycle-test");
    await writeMossRepo(root, {
      tasksJsonl: `${JSON.stringify({
        taskId: "moss-task-8",
        status: "active",
        owner: "UI Parity Engineer",
        title: "Add Moss tool lifecycle grouping affordances",
        acceptance: ["Tool call and result rows expose grouped lifecycle metadata"],
        evidence: [],
      })}\n`,
    });

    const packet = await readMossIterationPacket(root, {
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    expect(packet.fileScope).toEqual(
      expect.arrayContaining([
        "apps/web/src/components/chat/mossNormalizedTimeline.tsx",
        "apps/web/src/components/chat/mossNormalizedTimeline.test.tsx",
        "apps/web/src/components/chat/MossControlPlanePanel.browser.tsx",
      ]),
    );
    expect(packet.requiredVerificationCommands).toEqual(
      expect.arrayContaining([
        "bun --filter @synara/web test -- mossNormalizedTimeline",
        "bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx",
        "bun --filter @synara/web typecheck",
      ]),
    );

    await rm(root, { force: true, recursive: true });
  });
});
