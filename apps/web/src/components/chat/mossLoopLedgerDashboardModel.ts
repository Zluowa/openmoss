// FILE: mossLoopLedgerDashboardModel.ts
// Purpose: Web-local default Moss loop-ledger snapshot plus shared contract re-exports.
// Layer: Web chat control-plane model boundary
// Exports: current fallback snapshot, renderer props, and shared dashboard contract types

import type { MossLoopLedgerDashboardSnapshot } from "@synara/contracts";

export { deriveMossLoopLedgerDashboardModel } from "@synara/contracts";
export type {
  DashboardMetric,
  MossLoopLedgerDashboardReleaseFreshnessModel,
  MossLoopLedgerDashboardRefreshPlanModel,
  MossLoopLedgerDashboardModel,
  MossLoopLedgerDashboardSnapshot,
  MossLoopLedgerDashboardStatus,
  MossLoopLedgerEvidenceSummary,
  MossLoopLedgerGateCheck,
  MossLoopLedgerReviewSummary,
  MossLoopLedgerRoleSummary,
  MossLoopLedgerTaskSummary,
} from "@synara/contracts";

export interface MossLoopLedgerDashboardProps {
  readonly snapshot: MossLoopLedgerDashboardSnapshot;
  readonly className?: string;
}

export const MOSS_MOSS_LOOP_LEDGER_DASHBOARD_SNAPSHOT: MossLoopLedgerDashboardSnapshot = {
  version: 1,
  generatedAt: "2026-07-01T00:00:00.000Z",
  mission: {
    title: "Moss Shell Mission",
    currentGoal:
      "Build a Codex Desktop-like general agent shell on Moss with a unified control plane, normalized events, and durable engineering loop.",
    branch: "moss/control-plane-v1",
    status: "active",
  },
  tasks: {
    total: 19,
    counts: {
      active: 1,
      done: 18,
      blocked: 0,
    },
    active: [
      {
        taskId: "moss-task-0019",
        title: "Generate Loop Ledger Dashboard snapshot from .moss ledger",
        owner: "Runtime Adapter Engineer",
        status: "active",
        acceptanceCount: 4,
        evidenceCount: 0,
      },
    ],
    next: [
      "Generate the Loop Ledger Dashboard snapshot from `.moss` mission, events, tasks, evidence index, and role manifests, then expose it through one UI-facing boundary.",
      "Expand the Moss Control panel from internal debug surface toward Codex-like session inspection once smoke evidence is stable.",
    ],
  },
  reviews: {
    recent: [
      {
        eventId: "moss-event-0084",
        taskId: "moss-task-0018",
        role: "Reviewer",
        decision: "accepted",
        createdAt: "2026-07-01T15:32:02.000Z",
        notes:
          "The dashboard keeps raw ledger parsing out of React components, renders the required goal/task/review/evidence/role/gate fields from a typed snapshot, covers pass, pending, and blocked states, and preserves the existing Events and Launch surfaces.",
      },
      {
        eventId: "moss-event-0079",
        taskId: "moss-task-0017",
        role: "Reviewer",
        decision: "accepted",
        createdAt: "2026-07-01T15:18:02.000Z",
        notes:
          "The aggregate gate reuses existing iteration, review, and memory packet builders, preserves active-task pending review as non-blocking, blocks failed packet exits, and is covered by pending, ready, and blocked tests.",
      },
      {
        eventId: "moss-event-0074",
        taskId: "moss-task-0016",
        role: "Reviewer",
        decision: "accepted",
        createdAt: "2026-07-01T15:07:02.000Z",
        notes:
          "The memory packet is ledger-backed, does not depend on chat history, covers stale context and missing evidence index warnings, blocks failed release gates and completed tasks without evidence, and preserves wrapped Next Tasks bullets.",
      },
    ],
  },
  evidence: {
    indexedArtifacts: 12,
    taskEvidenceReferences: 205,
    commandReferences: 38,
    missingCompletedTaskEvidence: 0,
    recent: [
      {
        label: ".moss/ledger/evidence/loop-ledger-dashboard-2026-07-01.md",
        kind: "file",
        status: "pass",
      },
      {
        label: "bun --filter @synara/web test -- mossLoopLedgerDashboard MossControlPlanePanel",
        kind: "test",
        status: "pass",
      },
      {
        label: "bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx",
        kind: "test",
        status: "pass",
      },
      {
        label: "bun --filter @synara/scripts test -- moss-iteration-packet moss-loop-status",
        kind: "test",
        status: "pass",
      },
    ],
  },
  roles: [
    {
      role: "Product Steward",
      activeTaskCount: 0,
      responsibility:
        "Own the Moss Shell product direction, PRD, non-goals, acceptance criteria, and iteration priorities.",
      status: "idle",
    },
    {
      role: "Architect",
      activeTaskCount: 0,
      responsibility: "Own Moss contracts, boundary decisions, migrations, and ADRs.",
      status: "idle",
    },
    {
      role: "Runtime Adapter Engineer",
      activeTaskCount: 1,
      responsibility:
        "Own provider launch, session configuration, event ingestion, raw-event preservation, and normalized session event mapping.",
      status: "assigned",
    },
    {
      role: "UI Parity Engineer",
      activeTaskCount: 0,
      responsibility:
        "Own the Codex Desktop-like shell experience on top of normalized events and control-plane state.",
      status: "idle",
    },
    {
      role: "Memory Curator",
      activeTaskCount: 0,
      responsibility: "Own compaction-safe continuity for the Moss Shell line.",
      status: "idle",
    },
    {
      role: "QA Gatekeeper",
      activeTaskCount: 0,
      responsibility:
        "Own verification gates for contracts, provider mapping, desktop startup, UI smoke, and ledger consistency.",
      status: "idle",
    },
    {
      role: "Release Operator",
      activeTaskCount: 0,
      responsibility:
        "Own branch hygiene, version readiness, changelog notes, packaging, and rollback planning for the Moss Shell line.",
      status: "idle",
    },
    {
      role: "Reviewer",
      activeTaskCount: 0,
      responsibility:
        "Review changes for bugs, regressions, missing tests, unsafe assumptions, and contract drift.",
      status: "idle",
    },
  ],
  releaseGate: {
    status: "pass",
    issueCount: 0,
    summary:
      "Ledger status is passing with 1 active task(s) and no completed task missing evidence.",
    checks: [
      {
        id: "completed-task-evidence",
        label: "Completed Task Evidence",
        status: "pass",
        summary: "Every completed task has at least one evidence reference.",
        issueCount: 0,
      },
      {
        id: "unique-task-ids",
        label: "Unique Task Ids",
        status: "pass",
        summary: "Every task id is unique.",
        issueCount: 0,
      },
      {
        id: "unique-event-ids",
        label: "Unique Event Ids",
        status: "pass",
        summary: "Every event id is unique.",
        issueCount: 0,
      },
    ],
  },
};
