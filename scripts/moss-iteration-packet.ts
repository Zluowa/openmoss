import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { readMossLoopStatus, type MossLoopStatus, type MossLoopTask } from "./moss-loop-status.ts";
import {
  readMossPrdCoverageReport,
  type MossPrdCoverageSnapshot,
} from "./lib/moss-prd-coverage.ts";
import { readMossGuiParityReport, type MossGuiParitySnapshot } from "./lib/moss-gui-parity.ts";

export interface MossIterationPacketOptions {
  readonly createdAt?: string;
  readonly taskId?: string;
}

export interface MossIterationRoleAssignment {
  readonly role: string;
  readonly responsibility: string;
}

export interface MossIterationPacket {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceFiles: ReadonlyArray<string>;
  readonly objective: string;
  readonly mission: {
    readonly title: string;
    readonly currentGoal: string | null;
    readonly branch: string | null;
  };
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly owner: string;
    readonly status: string;
    readonly metadata?: Record<string, unknown>;
  };
  readonly roleAssignments: ReadonlyArray<MossIterationRoleAssignment>;
  readonly fileScope: ReadonlyArray<string>;
  readonly acceptance: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
  readonly requiredVerificationCommands: ReadonlyArray<string>;
  readonly ledger: {
    readonly eventCount: number;
    readonly taskCount: number;
    readonly releaseGateStatus: "pass" | "fail";
    readonly activeTaskIds: ReadonlyArray<string>;
    readonly issueCount: number;
  };
  readonly context: {
    readonly path: string;
    readonly statusSummary: string | null;
  };
  readonly prdCoverage?: MossPrdCoverageSnapshot | undefined;
  readonly guiParity?: MossGuiParitySnapshot | undefined;
  readonly recordActions: ReadonlyArray<string>;
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].filter((value) => value.length > 0);
}

function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) {
    return null;
  }
  const sectionLines: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) {
      break;
    }
    sectionLines.push(line);
  }
  const section = sectionLines.join("\n").trim();
  return section.length > 0 ? section : null;
}

function firstParagraph(markdown: string | null): string | null {
  if (!markdown) {
    return null;
  }
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .find((entry) => entry.length > 0);
  return paragraph ?? null;
}

function selectActiveTask(status: MossLoopStatus, taskId?: string): MossLoopTask {
  const task = taskId
    ? status.activeTasks.find((entry) => entry.taskId === taskId)
    : status.activeTasks[0];
  if (!task) {
    throw new Error(taskId ? `active Moss task not found: ${taskId}` : "no active Moss task found");
  }
  return task;
}

function isReleaseGateReportIndexTask(title: string): boolean {
  return (
    title.includes("index moss release gate report artifact") ||
    (title.includes("release gate report") &&
      title.includes("index") &&
      title.includes("artifact") &&
      !isReleaseGateReportIndexIntegrationTask(title))
  );
}

function isReleaseGateReportIndexIntegrationTask(title: string): boolean {
  return (
    title.includes("release readiness") &&
    title.includes("report artifact") &&
    title.includes("index")
  );
}

function isReleaseGateReportArtifactPersistenceTask(title: string): boolean {
  return (
    title.includes("persist") &&
    (title.includes("report artifact") ||
      (title.includes("report index") && title.includes("artifact")))
  );
}

function isReleaseGateReportFreshnessEvidenceTask(title: string): boolean {
  return (
    title.includes("manifest freshness") &&
    (title.includes("release report") ||
      title.includes("release reports") ||
      title.includes("release gate report"))
  );
}

function isReleaseGateReportFreshnessArtifactTask(title: string): boolean {
  return (
    title.includes("freshness") &&
    title.includes("report artifact") &&
    (title.includes("release report") || title.includes("release gate"))
  );
}

function isReleaseGateReportArtifactRefreshTask(title: string): boolean {
  return (
    title.includes("release report artifact") &&
    title.includes("refresh") &&
    title.includes("manifest")
  );
}

function isReleaseGateArtifactRefreshAfterChainTask(title: string): boolean {
  return (
    title.includes("release gate artifact") &&
    title.includes("refresh") &&
    title.includes("refresh plan chain")
  );
}

function isReleaseArtifactFreshnessAfterChainedReportsTask(title: string): boolean {
  return title.includes("release artifact freshness") && title.includes("chained refresh reports");
}

function isExplicitChainedRefreshTaskProvenanceTask(title: string): boolean {
  return title.includes("chained refresh task provenance");
}

function isDashboardFreshnessReleaseReadinessTask(title: string): boolean {
  return (
    title.includes("dashboard") &&
    title.includes("freshness") &&
    title.includes("release readiness")
  );
}

function isLoopPacketFreshnessReportTask(title: string): boolean {
  return (
    title.includes("loop packet") &&
    title.includes("freshness") &&
    (title.includes("report evidence") ||
      title.includes("gate report") ||
      title.includes("compact artifact"))
  );
}

function isLoopPacketFreshnessReportArtifactRefreshTask(title: string): boolean {
  return (
    title.includes("loop packet") &&
    title.includes("freshness report artifact") &&
    title.includes("refresh")
  );
}

function isLoopPacketFreshnessReportIndexReleaseReadinessTask(title: string): boolean {
  return (
    title.includes("release readiness") &&
    title.includes("loop packet") &&
    title.includes("freshness report index")
  );
}

function isChainedReleaseFreshnessRefreshPlanTask(title: string): boolean {
  return (
    title.includes("release freshness refresh plan") ||
    title.includes("chained release freshness refresh plan") ||
    title.includes("chained release freshness plan")
  );
}

function isReleaseFreshnessRefreshPlanReportArtifactTask(title: string): boolean {
  return (
    title.includes("refresh plan") &&
    (title.includes("report artifact") || title.includes("plan artifact"))
  );
}

function isReleaseFreshnessRefreshPlanReportIndexReleaseReadinessTask(title: string): boolean {
  return (
    !title.includes("loop packet") &&
    title.includes("release readiness") &&
    title.includes("refresh plan report index")
  );
}

function isLoopPacketRefreshPlanReportIndexReleaseReadinessTask(title: string): boolean {
  return (
    title.includes("release readiness") &&
    title.includes("loop packet") &&
    title.includes("refresh plan report index")
  );
}

function isLoopPacketRefreshPlanDashboardGateTask(title: string): boolean {
  return (
    title.includes("loop packet") &&
    title.includes("refresh plan") &&
    (title.includes("dashboard evidence") ||
      title.includes("dashboard gate") ||
      title.includes("report evidence"))
  );
}

function isLoopPacketRefreshPlanDashboardGateReportTask(title: string): boolean {
  return (
    isLoopPacketRefreshPlanDashboardGateTask(title) &&
    (title.includes("report evidence") ||
      title.includes("compact report") ||
      title.includes("report artifact"))
  );
}

function hasPrdCoverageMetadata(task: MossLoopTask): boolean {
  const metadata = task.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    typeof metadata.prdCoverage === "object" &&
    metadata.prdCoverage !== null
  );
}

function isPrdCoverageTask(task: MossLoopTask): boolean {
  const title = task.title.toLowerCase();
  return (
    title.includes("prd coverage") ||
    title.includes("coverage matrix") ||
    title.includes("prd matrix") ||
    hasPrdCoverageMetadata(task)
  );
}

function isGuiParityTask(task: MossLoopTask): boolean {
  const title = task.title.toLowerCase();
  const metadata = task.metadata;
  const prdCoverage =
    typeof metadata === "object" && metadata !== null && "prdCoverage" in metadata
      ? metadata.prdCoverage
      : null;
  const gapId =
    typeof prdCoverage === "object" &&
    prdCoverage !== null &&
    "gapId" in prdCoverage &&
    typeof prdCoverage.gapId === "string"
      ? prdCoverage.gapId
      : null;
  return (
    title.includes("gui parity") ||
    title.includes("codex-like gui") ||
    title.includes("visible composer") ||
    title.includes("composer and session controls") ||
    gapId === "phase-5-codex-like-gui"
  );
}

function isCodexDesktopComparatorTask(title: string): boolean {
  return (
    title.includes("codex desktop comparator") ||
    title.includes("direct codex desktop") ||
    title.includes("layout comparator")
  );
}

function isCodexDesktopLayoutGateTask(title: string): boolean {
  return (
    title.includes("layout comparator") &&
    (title.includes("release readiness") || title.includes("release-readiness"))
  );
}

function isMossShellProductizationTask(title: string): boolean {
  return (
    ((title.includes("productize") || title.includes("productization")) &&
      title.includes("moss shell")) ||
    title.includes("default-off moss shell")
  );
}

function isDesktopProductShellSmokeTask(title: string): boolean {
  return (
    ((title.includes("desktop") || title.includes("electron")) &&
      title.includes("product-shell") &&
      title.includes("smoke")) ||
    (title.includes("electron desktop") && title.includes("moss shell"))
  );
}

function inferFileScope(task: MossLoopTask): ReadonlyArray<string> {
  const title = task.title.toLowerCase();
  const owner = task.owner.toLowerCase();
  const isReportFreshnessEvidenceTask = isReleaseGateReportFreshnessEvidenceTask(title);
  const isReportFreshnessArtifactTask = isReleaseGateReportFreshnessArtifactTask(title);
  const isReportArtifactRefreshTask = isReleaseGateReportArtifactRefreshTask(title);
  const isReleaseGateArtifactRefreshAfterChain = isReleaseGateArtifactRefreshAfterChainTask(title);
  const isReleaseArtifactFreshnessAfterChainedReports =
    isReleaseArtifactFreshnessAfterChainedReportsTask(title);
  const isExplicitChainedRefreshTaskProvenance = isExplicitChainedRefreshTaskProvenanceTask(title);
  const isDashboardFreshnessReleaseReadiness = isDashboardFreshnessReleaseReadinessTask(title);
  const isLoopPacketFreshnessReport = isLoopPacketFreshnessReportTask(title);
  const isLoopPacketFreshnessReportArtifactRefresh =
    isLoopPacketFreshnessReportArtifactRefreshTask(title);
  const isLoopPacketFreshnessReportIndexReleaseReadiness =
    isLoopPacketFreshnessReportIndexReleaseReadinessTask(title);
  const isChainedReleaseFreshnessRefreshPlan = isChainedReleaseFreshnessRefreshPlanTask(title);
  const isReleaseFreshnessRefreshPlanReportArtifact =
    isReleaseFreshnessRefreshPlanReportArtifactTask(title);
  const isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness =
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadinessTask(title);
  const isLoopPacketRefreshPlanReportIndexReleaseReadiness =
    isLoopPacketRefreshPlanReportIndexReleaseReadinessTask(title);
  const isLoopPacketRefreshPlanDashboardGate = isLoopPacketRefreshPlanDashboardGateTask(title);
  const isLoopPacketRefreshPlanDashboardGateReport =
    isLoopPacketRefreshPlanDashboardGateReportTask(title);
  const isPrdCoverage = isPrdCoverageTask(task);
  const isGuiParity = isGuiParityTask(task);
  const isCodexDesktopComparator = isCodexDesktopComparatorTask(title);
  const isCodexDesktopLayoutGate = isCodexDesktopLayoutGateTask(title);
  const isMossShellProductization = isMossShellProductizationTask(title);
  const isDesktopProductShellSmoke = isDesktopProductShellSmokeTask(title);
  const scope = [
    ".moss/mission.md",
    ".moss/context/current.md",
    ".moss/ledger/events.jsonl",
    ".moss/ledger/tasks.jsonl",
    ".moss/ledger/evidence/README.md",
  ];

  if (isPrdCoverage) {
    scope.push(".moss/prd-coverage.json");
    scope.push(".moss/ledger/evidence/moss-prd-coverage-audit-2026-07-02.md");
    scope.push("scripts/lib/moss-prd-coverage.ts");
    scope.push("scripts/lib/moss-prd-coverage.test.ts");
    scope.push("scripts/moss-prd-coverage.ts");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-iteration-packet.test.ts");
    scope.push("package.json");
  }

  if (isGuiParity) {
    scope.push(".moss/gui-parity.json");
    scope.push(".moss/final-shell-parity.json");
    scope.push(".moss/ledger/evidence/moss-gui-parity-gate-2026-07-02.md");
    scope.push(".moss/ledger/evidence/moss-visible-composer-session-controls-2026-07-02.md");
    scope.push(".moss/ledger/evidence/moss-final-shell-parity-audit-2026-07-02.md");
    scope.push("scripts/lib/moss-gui-parity.ts");
    scope.push("scripts/lib/moss-gui-parity.test.ts");
    scope.push("scripts/moss-gui-parity.ts");
    scope.push("scripts/lib/moss-final-shell-parity.ts");
    scope.push("scripts/lib/moss-final-shell-parity.test.ts");
    scope.push("scripts/moss-final-shell-parity.ts");
    scope.push("apps/web/src/components/ChatView.tsx");
    scope.push("apps/web/src/components/ChatView.browser.tsx");
    scope.push("apps/web/src/components/chat/ComposerExtrasMenu.tsx");
    scope.push("apps/web/src/components/chat/ComposerModelEffortPicker.tsx");
    scope.push("apps/web/src/components/chat/ProviderModelPicker.tsx");
    scope.push("apps/web/src/components/chat/TraitsPicker.tsx");
    scope.push("apps/web/src/components/chat/ComposerPendingApprovalActions.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.test.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.browser.tsx");
    scope.push("apps/web/src/components/chat/mossNormalizedTimeline.tsx");
    scope.push("apps/web/src/components/chat/mossLaunchPlanInspector.tsx");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-iteration-packet.test.ts");
    scope.push("package.json");
  }

  if (isCodexDesktopComparator) {
    scope.push(".moss/codex-desktop-comparator.json");
    scope.push(".moss/ledger/evidence/codex-desktop-current-shell-2026-07-02.png");
    scope.push(".moss/ledger/evidence/moss-codex-desktop-comparator-2026-07-02.md");
    scope.push(".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-2026-07-03.json");
    scope.push(".moss/ledger/evidence/moss-electron-product-shell-layout-smoke-2026-07-03.png");
    scope.push(".moss/ledger/evidence/moss-first-screen-layout-comparator-2026-07-03.md");
    scope.push("scripts/lib/moss-codex-desktop-comparator.ts");
    scope.push("scripts/lib/moss-codex-desktop-comparator.test.ts");
    scope.push("scripts/moss-codex-desktop-comparator.ts");
  }

  if (isCodexDesktopLayoutGate) {
    scope.push("scripts/moss-codex-desktop-layout-gate.ts");
    scope.push("scripts/moss-codex-desktop-layout-gate.test.ts");
    scope.push("scripts/lib/moss-release-gate-manifest.ts");
    scope.push("scripts/moss-release-gate.ts");
    scope.push("scripts/moss-release-gate.test.ts");
    scope.push("package.json");
  }

  if (isMossShellProductization) {
    scope.push("apps/web/src/mossShellProductization.ts");
    scope.push("apps/web/src/mossShellProductization.test.ts");
    scope.push("apps/web/src/diffRouteSearch.ts");
    scope.push("apps/web/src/diffRouteSearch.test.ts");
    scope.push("apps/web/src/hooks/useDiffRouteSearch.ts");
    scope.push("apps/web/src/routes/_chat.$threadId.tsx");
    scope.push("apps/web/src/components/ChatView.tsx");
    scope.push("apps/web/src/components/ChatView.browser.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.tsx");
    scope.push("scripts/moss-promoted-shell-served-smoke.ts");
    scope.push("scripts/moss-ui-smoke.ts");
    scope.push(".moss/ledger/evidence/moss-promoted-shell-product-route-smoke-2026-07-02.json");
    scope.push(".moss/ledger/evidence/moss-promoted-shell-product-route-smoke-2026-07-02.png");
    scope.push(".moss/ledger/evidence/moss-shell-product-route-toggle-2026-07-02.md");
  }

  if (isDesktopProductShellSmoke) {
    scope.push("apps/desktop/src/main.ts");
    scope.push("apps/desktop/src/preload.ts");
    scope.push("apps/desktop/src/backendNodeOptions.ts");
    scope.push("apps/desktop/src/backendReadiness.ts");
    scope.push("apps/desktop/src/backendStartupReadiness.ts");
    scope.push("apps/desktop/scripts/smoke-test.mjs");
    scope.push("apps/desktop/scripts/moss-product-shell-smoke.mjs");
    scope.push("apps/desktop/package.json");
    scope.push("scripts/moss-promoted-shell-served-smoke.ts");
    scope.push("scripts/moss-ui-smoke.ts");
    scope.push("scripts/moss-electron-product-shell-smoke-gate.ts");
    scope.push("scripts/moss-electron-product-shell-smoke-gate.test.ts");
    scope.push("scripts/lib/moss-release-gate-manifest.ts");
    scope.push("scripts/moss-release-gate.ts");
    scope.push("scripts/moss-release-gate.test.ts");
    scope.push("scripts/moss-loop-ledger-snapshot.test.ts");
    scope.push("package.json");
    scope.push(".moss/final-shell-parity.json");
    scope.push(".moss/gui-parity.json");
    scope.push(".moss/prd-coverage.json");
    scope.push(".moss/codex-desktop-comparator.json");
    scope.push(".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.md");
    scope.push(".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.json");
    scope.push(".moss/ledger/evidence/moss-electron-product-shell-smoke-2026-07-02.png");
  }

  if (title.includes("iteration packet")) {
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-iteration-packet.test.ts");
    scope.push("scripts/moss-loop-status.ts");
    scope.push("package.json");
  }
  if (title.includes("review packet")) {
    scope.push("scripts/moss-review-packet.ts");
    scope.push("scripts/moss-review-packet.test.ts");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-loop-status.ts");
    scope.push("package.json");
  }
  if (title.includes("memory packet")) {
    scope.push("scripts/moss-memory-packet.ts");
    scope.push("scripts/moss-memory-packet.test.ts");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-loop-status.ts");
    scope.push("package.json");
  }
  if (
    title.includes("loop packet") ||
    (title.includes("aggregate gate") && !title.includes("ui smoke")) ||
    isDashboardFreshnessReleaseReadiness ||
    isLoopPacketFreshnessReport ||
    isLoopPacketFreshnessReportArtifactRefresh ||
    isLoopPacketFreshnessReportIndexReleaseReadiness ||
    isLoopPacketRefreshPlanReportIndexReleaseReadiness ||
    isReleaseGateArtifactRefreshAfterChain ||
    isReleaseArtifactFreshnessAfterChainedReports ||
    isExplicitChainedRefreshTaskProvenance ||
    isChainedReleaseFreshnessRefreshPlan ||
    isReleaseFreshnessRefreshPlanReportArtifact ||
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness ||
    isReleaseGateArtifactRefreshAfterChain ||
    isLoopPacketRefreshPlanDashboardGate
  ) {
    scope.push("scripts/moss-loop-packet.ts");
    scope.push("scripts/moss-loop-packet.test.ts");
    scope.push("scripts/moss-loop-packet-freshness-report-index.ts");
    scope.push("scripts/moss-loop-packet-freshness-report-index.test.ts");
    scope.push("scripts/lib/moss-loop-packet-freshness-gate-report-index.ts");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-review-packet.ts");
    scope.push("scripts/moss-memory-packet.ts");
    scope.push("scripts/moss-loop-status.ts");
    scope.push("scripts/moss-loop-ledger-snapshot.ts");
    scope.push("scripts/lib/moss-loop-ledger-snapshot.ts");
    scope.push("scripts/lib/moss-release-gate-report-index.ts");
    scope.push("package.json");
  }
  if (title.includes("ui smoke")) {
    scope.push("scripts/moss-ui-smoke.ts");
    scope.push("scripts/moss-ui-smoke.test.ts");
    scope.push("package.json");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.browser.tsx");
    scope.push("apps/web/src/components/chat/mossNormalizedTimeline.browser.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.test.tsx");
    scope.push("apps/web/src/components/chat/mossNormalizedTimeline.test.tsx");
  }
  if (
    title.includes("release gate") ||
    isReleaseGateReportIndexIntegrationTask(title) ||
    isReportFreshnessEvidenceTask ||
    isDashboardFreshnessReleaseReadiness ||
    isLoopPacketFreshnessReportArtifactRefresh ||
    isLoopPacketFreshnessReportIndexReleaseReadiness ||
    isLoopPacketRefreshPlanReportIndexReleaseReadiness ||
    isReportArtifactRefreshTask ||
    isReleaseGateArtifactRefreshAfterChain ||
    isReleaseArtifactFreshnessAfterChainedReports ||
    isExplicitChainedRefreshTaskProvenance ||
    isChainedReleaseFreshnessRefreshPlan ||
    isReleaseFreshnessRefreshPlanReportArtifact ||
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness
  ) {
    scope.push("scripts/moss-release-gate.ts");
    scope.push("scripts/moss-release-gate.test.ts");
    scope.push("scripts/lib/moss-release-gate-manifest.ts");
    scope.push("scripts/moss-loop-status.ts");
    scope.push("apps/server/src/provider/mossProviderReplay.ts");
    scope.push("scripts/moss-ui-smoke.ts");
    scope.push("scripts/moss-loop-packet.ts");
    scope.push("package.json");
  }
  if (
    isReleaseGateReportIndexTask(title) ||
    isReleaseGateReportIndexIntegrationTask(title) ||
    isReportFreshnessEvidenceTask ||
    isReportFreshnessArtifactTask ||
    isReportArtifactRefreshTask ||
    isReleaseGateArtifactRefreshAfterChain ||
    isReleaseArtifactFreshnessAfterChainedReports ||
    isExplicitChainedRefreshTaskProvenance ||
    isLoopPacketFreshnessReportArtifactRefresh ||
    isLoopPacketFreshnessReportIndexReleaseReadiness ||
    isLoopPacketRefreshPlanReportIndexReleaseReadiness ||
    isChainedReleaseFreshnessRefreshPlan ||
    isReleaseFreshnessRefreshPlanReportArtifact ||
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness
  ) {
    scope.push("scripts/moss-release-gate-report-index.ts");
    scope.push("scripts/moss-release-gate-report-index.test.ts");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-loop-status.ts");
    scope.push("package.json");
  }
  if (
    isChainedReleaseFreshnessRefreshPlan ||
    isReleaseFreshnessRefreshPlanReportArtifact ||
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness ||
    isLoopPacketRefreshPlanReportIndexReleaseReadiness ||
    isReleaseGateArtifactRefreshAfterChain ||
    isReleaseArtifactFreshnessAfterChainedReports ||
    isExplicitChainedRefreshTaskProvenance ||
    isLoopPacketRefreshPlanDashboardGate
  ) {
    scope.push("scripts/moss-release-freshness-refresh-plan.ts");
    scope.push("scripts/moss-release-freshness-refresh-plan.test.ts");
    scope.push("scripts/lib/moss-release-freshness-refresh-plan-constants.ts");
    scope.push("scripts/moss-release-freshness-refresh-plan-report-index.ts");
    scope.push("scripts/moss-release-freshness-refresh-plan-report-index.test.ts");
    scope.push("scripts/lib/moss-release-freshness-refresh-plan-report-index.ts");
  }
  if (
    isLoopPacketRefreshPlanDashboardGateReport ||
    isLoopPacketRefreshPlanReportIndexReleaseReadiness ||
    isChainedReleaseFreshnessRefreshPlan ||
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness ||
    isReleaseGateArtifactRefreshAfterChain ||
    isReleaseArtifactFreshnessAfterChainedReports ||
    isExplicitChainedRefreshTaskProvenance
  ) {
    scope.push("scripts/moss-loop-packet-refresh-plan-report-index.ts");
    scope.push("scripts/moss-loop-packet-refresh-plan-report-index.test.ts");
    scope.push("scripts/lib/moss-loop-packet-refresh-plan-gate-report-index.ts");
  }
  if (isExplicitChainedRefreshTaskProvenance) {
    scope.push("scripts/lib/moss-chained-refresh-provenance.ts");
  }
  if (title.includes("loop ledger dashboard") || title.includes("dashboard snapshot")) {
    scope.push("apps/web/src/components/chat/mossLoopLedgerDashboardModel.ts");
    scope.push("apps/web/src/components/chat/mossLoopLedgerDashboard.tsx");
    scope.push("apps/web/src/components/chat/mossLoopLedgerDashboard.test.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.test.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.browser.tsx");
    scope.push("apps/web/src/wsNativeApi.ts");
    scope.push("apps/server/src/provider/Services/ProviderService.ts");
    scope.push("apps/server/src/provider/Layers/ProviderService.ts");
    scope.push("apps/server/src/provider/Layers/ProviderService.test.ts");
    scope.push("apps/server/src/wsRpc.ts");
    scope.push("packages/contracts/src/provider.ts");
    scope.push("packages/contracts/src/ipc.ts");
    scope.push("packages/contracts/src/ws.ts");
    scope.push("packages/contracts/src/rpc.ts");
    scope.push("packages/contracts/src/mossLoopLedgerDashboard.ts");
    scope.push("scripts/lib/moss-loop-status.ts");
    scope.push("scripts/lib/moss-loop-ledger-snapshot.ts");
    scope.push("scripts/lib/moss-release-freshness-refresh-plan-report-index.ts");
    scope.push("scripts/moss-release-freshness-refresh-plan-report-index.ts");
    scope.push("scripts/moss-release-freshness-refresh-plan-report-index.test.ts");
    scope.push("scripts/moss-loop-ledger-snapshot.ts");
    scope.push("scripts/moss-loop-ledger-snapshot.test.ts");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-iteration-packet.test.ts");
    scope.push("package.json");
  }
  if (title.includes("session summary") || title.includes("moss control panel")) {
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.test.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.browser.tsx");
    scope.push("apps/web/src/components/chat/mossNormalizedTimeline.tsx");
    scope.push("apps/web/src/components/chat/mossLaunchPlanInspector.tsx");
    scope.push("apps/web/src/components/chat/mossLoopLedgerDashboard.tsx");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-iteration-packet.test.ts");
  }
  if (
    title.includes("normalized timeline") ||
    title.includes("event filter") ||
    title.includes("permission request") ||
    title.includes("tool lifecycle")
  ) {
    scope.push("apps/web/src/components/chat/mossNormalizedTimeline.tsx");
    scope.push("apps/web/src/components/chat/mossNormalizedTimeline.test.tsx");
    scope.push("apps/web/src/components/chat/MossControlPlanePanel.browser.tsx");
    scope.push("scripts/moss-iteration-packet.ts");
    scope.push("scripts/moss-iteration-packet.test.ts");
  }
  if (title.includes("provider fixture") || title.includes("replay")) {
    scope.push(".moss/fixtures/provider-runtime");
    scope.push("apps/server/src/provider/mossProviderReplay.ts");
    scope.push("apps/server/src/provider/mossNormalizeEvent.ts");
  }
  if (title.includes("control-plane") || title.includes("ui") || title.includes("codex-like")) {
    scope.push("apps/web/src/components/chat");
    scope.push("apps/web/src/components/ChatView.tsx");
  }
  if (owner.includes("memory")) {
    scope.push(".moss/context/current.md");
    scope.push(".moss/ledger/evidence");
  }

  return unique(scope);
}

function buildRoleAssignments(task: MossLoopTask): ReadonlyArray<MossIterationRoleAssignment> {
  const assignments: MossIterationRoleAssignment[] = [
    {
      role: task.owner,
      responsibility:
        "Own implementation for the active task and keep changes inside the declared file scope.",
    },
  ];

  if (task.owner !== "QA Gatekeeper") {
    assignments.push({
      role: "QA Gatekeeper",
      responsibility: "Run the required verification commands and record command evidence.",
    });
  }

  if (task.owner !== "Reviewer") {
    assignments.push({
      role: "Reviewer",
      responsibility: "Review risks, regressions, and missing tests before accepting the task.",
    });
  }

  if (task.owner !== "Memory Curator") {
    assignments.push({
      role: "Memory Curator",
      responsibility: "Update .moss/context/current.md and ledger evidence after verification.",
    });
  }

  return assignments;
}

function verificationCommands(createdAt: string, task: MossLoopTask): ReadonlyArray<string> {
  const title = task.title.toLowerCase();
  const isPrdCoverage = isPrdCoverageTask(task);
  const isGuiParity = isGuiParityTask(task);
  const isCodexDesktopComparator = isCodexDesktopComparatorTask(title);
  const isCodexDesktopLayoutGate = isCodexDesktopLayoutGateTask(title);
  const isMossShellProductization = isMossShellProductizationTask(title);
  const isDesktopProductShellSmoke = isDesktopProductShellSmokeTask(title);
  const isReportIndexTask = isReleaseGateReportIndexTask(title);
  const isReportArtifactPersistenceTask = isReleaseGateReportArtifactPersistenceTask(title);
  const isReportFreshnessEvidenceTask = isReleaseGateReportFreshnessEvidenceTask(title);
  const isReportFreshnessArtifactTask = isReleaseGateReportFreshnessArtifactTask(title);
  const isReportArtifactRefreshTask = isReleaseGateReportArtifactRefreshTask(title);
  const isReleaseGateArtifactRefreshAfterChain = isReleaseGateArtifactRefreshAfterChainTask(title);
  const isReleaseArtifactFreshnessAfterChainedReports =
    isReleaseArtifactFreshnessAfterChainedReportsTask(title);
  const isExplicitChainedRefreshTaskProvenance = isExplicitChainedRefreshTaskProvenanceTask(title);
  const isLoopPacketFreshnessReport = isLoopPacketFreshnessReportTask(title);
  const isLoopPacketFreshnessReportArtifactRefresh =
    isLoopPacketFreshnessReportArtifactRefreshTask(title);
  const isLoopPacketFreshnessReportIndexReleaseReadiness =
    isLoopPacketFreshnessReportIndexReleaseReadinessTask(title);
  const isChainedReleaseFreshnessRefreshPlan = isChainedReleaseFreshnessRefreshPlanTask(title);
  const isReleaseFreshnessRefreshPlanReportArtifact =
    isReleaseFreshnessRefreshPlanReportArtifactTask(title);
  const isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness =
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadinessTask(title);
  const isLoopPacketRefreshPlanReportIndexReleaseReadiness =
    isLoopPacketRefreshPlanReportIndexReleaseReadinessTask(title);
  const shouldRunReleaseGate =
    isReleaseGateReportIndexIntegrationTask(title) ||
    isReportFreshnessEvidenceTask ||
    isDashboardFreshnessReleaseReadinessTask(title) ||
    isReportArtifactRefreshTask ||
    isLoopPacketFreshnessReportArtifactRefresh ||
    isLoopPacketFreshnessReportIndexReleaseReadiness ||
    isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness ||
    isLoopPacketRefreshPlanReportIndexReleaseReadiness ||
    isCodexDesktopLayoutGate ||
    (title.includes("release gate") && (!isReportIndexTask || isReportArtifactPersistenceTask));
  const commands = [
    "bun --filter @synara/scripts test -- moss-iteration-packet moss-loop-status",
    `bun run moss:iteration-packet -- --created-at ${createdAt}`,
    "bun --filter @synara/scripts typecheck",
    "bun run moss:status",
    "bun run fmt:check",
    "bun run typecheck",
    "bun run lint",
    "git diff --check",
  ];

  if (isPrdCoverage) {
    commands.unshift(`bun run moss:prd-coverage -- --created-at ${createdAt}`);
    commands[1] =
      "bun --filter @synara/scripts test -- moss-prd-coverage moss-iteration-packet moss-loop-status";
  }

  if (isGuiParity) {
    commands.unshift(
      "bun --filter @synara/scripts test -- moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
    );
    commands.unshift(`bun run moss:final-shell-parity -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:gui-parity -- --created-at ${createdAt}`);
    commands.unshift("bun --filter @synara/web typecheck");
    commands.unshift(
      'bun --filter @synara/web test:browser -- ChatView.browser.tsx -t "Moss visible"',
    );
    commands.unshift("bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx");
    commands.unshift("bun --filter @synara/web test -- MossControlPlanePanel");
  }

  if (isCodexDesktopComparator) {
    commands.unshift(`bun run moss:codex-desktop-comparator -- --created-at ${createdAt}`);
    commands.unshift(
      "bun --filter @synara/scripts test -- moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
    );
  }

  if (isCodexDesktopLayoutGate) {
    commands.unshift(`bun run moss:codex-desktop-layout-gate -- --created-at ${createdAt}`);
    commands[1] =
      "bun --filter @synara/scripts test -- moss-codex-desktop-layout-gate moss-release-gate moss-release-gate-report-index moss-loop-ledger-snapshot moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status";
  }

  if (isMossShellProductization) {
    const artifactDate = createdAt.slice(0, 10);
    commands.unshift(`bun run moss:prd-coverage -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:gui-parity -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:final-shell-parity -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:codex-desktop-comparator -- --created-at ${createdAt}`);
    commands.unshift("bun run moss:ui-smoke");
    commands.unshift(
      `node scripts/moss-promoted-shell-served-smoke.ts --created-at ${createdAt} --report .moss/ledger/evidence/moss-promoted-shell-product-route-smoke-${artifactDate}.json --screenshot .moss/ledger/evidence/moss-promoted-shell-product-route-smoke-${artifactDate}.png`,
    );
    commands.unshift(
      'bun --filter @synara/web test:browser -- ChatView.browser.tsx -t "Moss product shell"',
    );
    commands.unshift("bun --filter @synara/web test -- diffRouteSearch mossShellProductization");
    commands.unshift(
      "bun --filter @synara/scripts test -- moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
    );
  }

  if (isDesktopProductShellSmoke) {
    const artifactDate = createdAt.slice(0, 10);
    commands.unshift(`bun run moss:prd-coverage -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:gui-parity -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:final-shell-parity -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:codex-desktop-comparator -- --created-at ${createdAt}`);
    commands.unshift("bun run moss:ui-smoke");
    commands.unshift(
      `bun run moss:electron-product-shell-smoke -- --created-at ${createdAt} --report .moss/ledger/evidence/moss-electron-product-shell-smoke-${artifactDate}.json --screenshot .moss/ledger/evidence/moss-electron-product-shell-smoke-${artifactDate}.png`,
    );
    commands.unshift(`bun run moss:electron-product-shell-smoke-gate -- --created-at ${createdAt}`);
    commands.unshift(
      'bun --filter @synara/web test:browser -- ChatView.browser.tsx -t "Moss product shell"',
    );
    commands.unshift("bun --filter @synara/web test -- diffRouteSearch mossShellProductization");
    commands.unshift("bun run test:desktop-smoke");
    commands.unshift("bun --filter @synara/desktop typecheck");
    commands.unshift(
      "bun --filter @synara/scripts test -- moss-electron-product-shell-smoke-gate moss-release-gate moss-release-gate-report-index moss-loop-ledger-snapshot moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status",
    );
  }

  if (isReleaseGateArtifactRefreshAfterChain) {
    const artifactDate = createdAt.slice(0, 10);
    return [
      `bun run moss:loop-packet-freshness-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}-gate.json --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json --created-at ${createdAt}`,
      `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:release-gate-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate -- --created-at ${createdAt}`,
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-loop-packet-freshness-report-index moss-release-freshness-refresh-plan-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      ...commands,
    ];
  }

  if (isReleaseArtifactFreshnessAfterChainedReports) {
    const artifactDate = createdAt.slice(0, 10);
    return [
      `bun run moss:release-gate-report-index -- --created-at ${createdAt}`,
      `bun run moss:loop-packet-freshness-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}-gate.json --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json --created-at ${createdAt}`,
      `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:release-gate-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate -- --created-at ${createdAt}`,
      "bun --filter @synara/scripts test -- moss-release-gate-report-index moss-release-gate moss-loop-packet-freshness-report-index moss-release-freshness-refresh-plan-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      ...commands,
    ];
  }

  if (isExplicitChainedRefreshTaskProvenance) {
    const artifactDate = createdAt.slice(0, 10);
    return [
      `bun run moss:iteration-packet -- --created-at ${createdAt}`,
      "bun --filter @synara/scripts test -- moss-release-gate-report-index moss-release-gate moss-loop-packet moss-loop-packet-freshness-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      `bun run moss:loop-packet-freshness-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}-gate.json --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json --created-at ${createdAt}`,
      `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:release-gate-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate -- --created-at ${createdAt}`,
      ...commands,
    ];
  }

  if (isLoopPacketRefreshPlanReportIndexReleaseReadiness) {
    const artifactDate = createdAt.slice(0, 10);
    return [
      `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate -- --report --created-at ${createdAt}`,
      "bun --filter @synara/scripts test -- moss-release-gate moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      `bun run moss:loop-packet-freshness-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}-gate.json --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json --created-at ${createdAt}`,
      `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:release-gate-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate -- --created-at ${createdAt}`,
      ...commands,
    ];
  }

  if (isReleaseFreshnessRefreshPlanReportIndexReleaseReadiness) {
    const artifactDate = createdAt.slice(0, 10);
    return [
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate -- --report --created-at ${createdAt}`,
      "bun --filter @synara/scripts test -- moss-release-gate moss-release-freshness-refresh-plan-report-index moss-loop-packet-freshness-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      `bun run moss:loop-packet-freshness-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}-gate.json --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json --created-at ${createdAt}`,
      `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate-refresh-artifact -- --created-at ${createdAt}`,
      `bun run moss:release-gate-report-index -- --created-at ${createdAt}`,
      `bun run moss:release-gate -- --created-at ${createdAt}`,
      ...commands,
    ];
  }

  if (title.includes("provider fixture")) {
    commands.unshift("bun run moss:provider-replay");
  }
  if (isChainedReleaseFreshnessRefreshPlan) {
    const artifactDate = createdAt.slice(0, 10);
    return [
      `bun run moss:release-freshness-refresh-plan -- --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}-gate.json --created-at ${createdAt}`,
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      `bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json --created-at ${createdAt}`,
      `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
      "bun --filter @synara/scripts test -- moss-release-freshness-refresh-plan moss-release-freshness-refresh-plan-report-index moss-loop-packet-refresh-plan-report-index moss-iteration-packet moss-loop-status",
      `bun run moss:release-gate -- --created-at ${createdAt}`,
      ...commands,
    ];
  }
  if (isReleaseFreshnessRefreshPlanReportArtifact) {
    const artifactDate = createdAt.slice(0, 10);
    commands.unshift(
      `bun run moss:release-freshness-refresh-plan -- --report --output .moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}.json --created-at ${createdAt}`,
    );
    commands.splice(
      1,
      0,
      `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
    );
    commands[2] =
      "bun --filter @synara/scripts test -- moss-release-freshness-refresh-plan moss-release-freshness-refresh-plan-report-index moss-iteration-packet moss-loop-status";
  }
  if (title.includes("review packet")) {
    commands.unshift(`bun run moss:review-packet -- --created-at ${createdAt}`);
    commands[1] =
      "bun --filter @synara/scripts test -- moss-review-packet moss-iteration-packet moss-loop-status";
  }
  if (title.includes("memory packet")) {
    commands.unshift(`bun run moss:memory-packet -- --created-at ${createdAt}`);
    commands[1] =
      "bun --filter @synara/scripts test -- moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status";
  }
  if (
    title.includes("loop packet") ||
    (title.includes("aggregate gate") && !title.includes("ui smoke")) ||
    isDashboardFreshnessReleaseReadinessTask(title) ||
    isLoopPacketFreshnessReport ||
    isLoopPacketFreshnessReportArtifactRefresh ||
    isLoopPacketFreshnessReportIndexReleaseReadiness ||
    isLoopPacketRefreshPlanDashboardGateTask(title)
  ) {
    const isLoopPacketRefreshPlanDashboardGate = isLoopPacketRefreshPlanDashboardGateTask(title);
    const isLoopPacketRefreshPlanDashboardGateReport =
      isLoopPacketRefreshPlanDashboardGateReportTask(title);
    const artifactDate = createdAt.slice(0, 10);
    commands.unshift(
      isLoopPacketFreshnessReportArtifactRefresh
        ? `bun run moss:loop-packet-freshness-refresh-artifact -- --created-at ${createdAt}`
        : isLoopPacketFreshnessReport
          ? `bun run moss:loop-packet -- --report --output .moss/ledger/evidence/moss-loop-packet-freshness-gate-report-${artifactDate}.json --created-at ${createdAt}`
          : isLoopPacketRefreshPlanDashboardGateReport
            ? `bun run moss:loop-packet -- --refresh-plan-report --output .moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json --created-at ${createdAt}`
            : `bun run moss:loop-packet -- --created-at ${createdAt}`,
    );
    commands[1] = isLoopPacketFreshnessReportArtifactRefresh
      ? "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-packet-freshness-report-index moss-release-gate moss-iteration-packet moss-loop-status"
      : isLoopPacketFreshnessReport
        ? "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-packet-freshness-report-index moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status"
        : isLoopPacketRefreshPlanDashboardGateReport
          ? "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-packet-refresh-plan-report-index moss-release-freshness-refresh-plan-report-index moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status"
          : isLoopPacketRefreshPlanDashboardGate
            ? "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-ledger-snapshot moss-release-freshness-refresh-plan-report-index moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status"
            : "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status";
    if (isLoopPacketFreshnessReportArtifactRefresh) {
      commands.splice(
        1,
        0,
        `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      );
    } else if (isLoopPacketFreshnessReportIndexReleaseReadiness) {
      commands.unshift(
        `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      );
    } else if (isLoopPacketFreshnessReport) {
      commands.splice(
        1,
        0,
        `bun run moss:loop-packet-freshness-report-index -- --created-at ${createdAt}`,
      );
    } else if (isLoopPacketRefreshPlanDashboardGate) {
      commands.splice(
        1,
        0,
        `bun run moss:release-freshness-refresh-plan-report-index -- --created-at ${createdAt}`,
      );
      if (isLoopPacketRefreshPlanDashboardGateReport) {
        commands.splice(
          2,
          0,
          `bun run moss:loop-packet-refresh-plan-report-index -- --created-at ${createdAt}`,
        );
      }
    }
  }
  if (title.includes("ui smoke")) {
    commands.unshift("bun run moss:ui-smoke");
    commands[1] =
      "bun --filter @synara/scripts test -- moss-ui-smoke moss-iteration-packet moss-loop-status";
  }
  if (
    isReportIndexTask ||
    isReportFreshnessEvidenceTask ||
    isReportFreshnessArtifactTask ||
    isReportArtifactRefreshTask
  ) {
    commands.unshift(`bun run moss:release-gate-report-index -- --created-at ${createdAt}`);
    commands[1] =
      "bun --filter @synara/scripts test -- moss-release-gate-report-index moss-iteration-packet moss-loop-status";
  }
  if (isReportArtifactRefreshTask) {
    commands.unshift(`bun run moss:loop-packet -- --created-at ${createdAt}`);
    commands.unshift(`bun run moss:release-gate-refresh-artifact -- --created-at ${createdAt}`);
  }
  if (shouldRunReleaseGate) {
    const reportFlag =
      title.includes("compact report") ||
      isReportArtifactPersistenceTask ||
      isReportFreshnessEvidenceTask ||
      isLoopPacketFreshnessReportArtifactRefresh;
    const artifactDate = createdAt.slice(0, 10);
    const outputFlag = isReportArtifactPersistenceTask
      ? `--output .moss/ledger/evidence/moss-release-gate-report-artifact-${artifactDate}.json `
      : "";
    if (isReportArtifactRefreshTask) {
      commands.splice(3, 0, `bun run moss:release-gate -- --created-at ${createdAt}`);
      commands[4] =
        "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-loop-packet moss-loop-ledger-snapshot moss-iteration-packet moss-loop-status";
    } else if (isLoopPacketFreshnessReportArtifactRefresh) {
      commands.splice(2, 0, `bun run moss:release-gate -- --report --created-at ${createdAt}`);
    } else {
      commands.unshift(
        `bun run moss:release-gate -- ${reportFlag ? "--report " : ""}${outputFlag}--created-at ${createdAt}`,
      );
    }
    if (isLoopPacketFreshnessReportIndexReleaseReadiness) {
      commands[3] =
        "bun --filter @synara/scripts test -- moss-release-gate moss-loop-packet-freshness-report-index moss-iteration-packet moss-loop-status";
    } else if (isLoopPacketFreshnessReportArtifactRefresh) {
      commands[3] =
        "bun --filter @synara/scripts test -- moss-loop-packet moss-loop-packet-freshness-report-index moss-release-gate moss-iteration-packet moss-loop-status";
    } else if (isDashboardFreshnessReleaseReadinessTask(title)) {
      commands[2] =
        "bun --filter @synara/scripts test -- moss-release-gate moss-loop-packet moss-loop-ledger-snapshot moss-memory-packet moss-review-packet moss-iteration-packet moss-loop-status";
    } else if (isCodexDesktopLayoutGate) {
      commands[2] =
        "bun --filter @synara/scripts test -- moss-codex-desktop-layout-gate moss-release-gate moss-release-gate-report-index moss-loop-ledger-snapshot moss-codex-desktop-comparator moss-final-shell-parity moss-gui-parity moss-prd-coverage moss-iteration-packet moss-loop-status";
    } else if (isReportArtifactRefreshTask) {
      // Refresh tasks already pin the full command sequence above.
    } else {
      commands[
        isReportIndexTask || isReportFreshnessEvidenceTask || isReportFreshnessArtifactTask ? 2 : 1
      ] =
        isReportIndexTask || isReportFreshnessEvidenceTask || isReportFreshnessArtifactTask
          ? "bun --filter @synara/scripts test -- moss-release-gate moss-release-gate-report-index moss-iteration-packet moss-loop-status"
          : "bun --filter @synara/scripts test -- moss-release-gate moss-iteration-packet moss-loop-status";
    }
  }
  if (title.includes("loop ledger dashboard") || title.includes("dashboard snapshot")) {
    commands[0] =
      "bun --filter @synara/scripts test -- moss-loop-ledger-snapshot moss-release-freshness-refresh-plan-report-index moss-iteration-packet moss-loop-status";
    commands.unshift(`bun run moss:loop-ledger-snapshot -- --created-at ${createdAt}`);
    commands.unshift("bun --filter t3 test -- ProviderService");
    commands.unshift("bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx");
    commands.unshift("bun --filter @synara/contracts test -- mossLoopLedgerDashboard rpc ws");
    commands.unshift(
      "bun --filter @synara/web test -- mossLoopLedgerDashboard MossControlPlanePanel",
    );
  }
  if (
    title.includes("session summary") ||
    title.includes("moss control panel") ||
    title.includes("codex-like")
  ) {
    commands.unshift("bun --filter @synara/web typecheck");
    commands.unshift("bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx");
    commands.unshift("bun --filter @synara/web test -- MossControlPlanePanel");
  }
  if (
    title.includes("normalized timeline") ||
    title.includes("event filter") ||
    title.includes("permission request") ||
    title.includes("tool lifecycle")
  ) {
    commands.unshift("bun --filter @synara/web typecheck");
    commands.unshift("bun --filter @synara/web test:browser -- MossControlPlanePanel.browser.tsx");
    commands.unshift("bun --filter @synara/web test -- mossNormalizedTimeline");
  }

  return unique(commands);
}

function risksForTask(task: MossLoopTask): ReadonlyArray<string> {
  const risks = [
    "The loop packet becomes stale if it depends on chat history instead of .moss ledger files.",
    "A task marked done without evidence will fail the Moss release gate.",
    `The ${task.owner} role must not self-approve review; Reviewer remains a separate gate.`,
  ];
  if (isPrdCoverageTask(task)) {
    risks.push(
      "The PRD coverage matrix must not mark broad product requirements proved from narrow release-chain tests.",
    );
  }
  if (isGuiParityTask(task)) {
    risks.push(
      "The GUI parity gate must not claim full Codex Desktop parity from internal Moss panel evidence.",
    );
  }
  return risks;
}

export function buildMossIterationPacket(input: {
  readonly status: MossLoopStatus;
  readonly mission: string;
  readonly currentContext: string;
  readonly prdCoverage?: MossPrdCoverageSnapshot | undefined;
  readonly guiParity?: MossGuiParitySnapshot | undefined;
  readonly options?: MossIterationPacketOptions;
}): MossIterationPacket {
  const generatedAt = input.options?.createdAt ?? new Date().toISOString();
  const task = selectActiveTask(input.status, input.options?.taskId);
  const prdCoverage = input.prdCoverage;
  const guiParity = input.guiParity;
  return {
    version: 1,
    generatedAt,
    sourceFiles: [
      ".moss/mission.md",
      ".moss/ledger/events.jsonl",
      ".moss/ledger/tasks.jsonl",
      ".moss/context/current.md",
      ...(prdCoverage ? [prdCoverage.path] : []),
      ...(guiParity ? [guiParity.path] : []),
    ],
    objective: `Complete ${task.taskId}: ${task.title}`,
    mission: {
      title: input.status.missionTitle,
      currentGoal: input.status.currentGoal,
      branch: input.status.branch,
    },
    task: {
      taskId: task.taskId,
      title: task.title,
      owner: task.owner,
      status: task.status,
      ...(task.metadata ? { metadata: task.metadata } : {}),
    },
    roleAssignments: buildRoleAssignments(task),
    fileScope: inferFileScope(task),
    acceptance: task.acceptance ?? [],
    risks: risksForTask(task),
    requiredVerificationCommands: verificationCommands(generatedAt, task),
    ledger: {
      eventCount: input.status.eventCount,
      taskCount: input.status.taskCount,
      releaseGateStatus: input.status.releaseGate.status,
      activeTaskIds: input.status.releaseGate.activeTaskIds,
      issueCount: input.status.releaseGate.issueCount,
    },
    context: {
      path: ".moss/context/current.md",
      statusSummary: firstParagraph(extractMarkdownSection(input.currentContext, "Status")),
    },
    ...(prdCoverage ? { prdCoverage } : {}),
    ...(guiParity ? { guiParity } : {}),
    recordActions: [
      "Record moss.task.started before implementation if this packet opens a new iteration.",
      ...(prdCoverage?.nextGap
        ? [
            `Open the next task from ${prdCoverage.path} gap ${prdCoverage.nextGap.id}: ${prdCoverage.nextGap.nextTaskHint ?? prdCoverage.nextGap.nextGap}`,
          ]
        : []),
      ...(guiParity?.nextGap
        ? [
            `Open the next GUI parity task from ${guiParity.path} gap ${guiParity.nextGap.id}: ${guiParity.nextGap.nextTaskHint ?? guiParity.nextGap.gap}`,
          ]
        : []),
      "Record moss.evidence.recorded after verification commands complete.",
      "Record moss.review.completed before marking the task done.",
      "Update .moss/context/current.md before committing the iteration.",
    ],
  };
}

function readOptionalMossPrdCoverageSnapshot(
  repoRoot: string,
): MossPrdCoverageSnapshot | undefined {
  try {
    const report = readMossPrdCoverageReport(repoRoot);
    return {
      path: report.path,
      updatedAt: report.updatedAt,
      statusCounts: report.statusCounts,
      nextGap: report.nextGap,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function readOptionalMossGuiParitySnapshot(repoRoot: string): MossGuiParitySnapshot | undefined {
  try {
    const report = readMossGuiParityReport(repoRoot);
    return {
      path: report.path,
      updatedAt: report.updatedAt,
      prdCoverageRowId: report.prdCoverageRowId,
      overallStatus: report.overallStatus,
      gateStatus: report.gateStatus,
      statusCounts: report.statusCounts,
      requiredSurfaceIds: report.requiredSurfaceIds,
      nextGap: report.nextGap,
      issues: report.issues,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readMossIterationPacket(
  repoRoot = process.cwd(),
  options: MossIterationPacketOptions = {},
): Promise<MossIterationPacket> {
  const mossRoot = join(repoRoot, ".moss");
  const [status, mission, currentContext] = await Promise.all([
    readMossLoopStatus(repoRoot),
    readFile(join(mossRoot, "mission.md"), "utf8"),
    readFile(join(mossRoot, "context", "current.md"), "utf8"),
  ]);
  const prdCoverage = readOptionalMossPrdCoverageSnapshot(repoRoot);
  const guiParity = readOptionalMossGuiParitySnapshot(repoRoot);

  return buildMossIterationPacket({
    status,
    mission,
    currentContext,
    prdCoverage,
    guiParity,
    options,
  });
}

export function mossIterationPacketExitCode(packet: MossIterationPacket): number {
  return packet.ledger.releaseGateStatus === "pass" ? 0 : 1;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossIterationPacketOptions {
  const options: { createdAt?: string; taskId?: string } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      const createdAt = argv[index + 1];
      if (!createdAt) {
        throw new Error("--created-at requires an ISO timestamp");
      }
      options.createdAt = createdAt;
      index += 1;
      continue;
    }
    if (arg === "--task-id") {
      const taskId = argv[index + 1];
      if (!taskId) {
        throw new Error("--task-id requires a Moss task id");
      }
      options.taskId = taskId;
      index += 1;
      continue;
    }
    throw new Error(`unknown moss iteration packet option: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const packet = await readMossIterationPacket(
    process.cwd(),
    parseCliOptions(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  process.exitCode = mossIterationPacketExitCode(packet);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
