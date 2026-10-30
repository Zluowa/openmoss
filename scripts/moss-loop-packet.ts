import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { MossLoopLedgerDashboardSnapshot } from "@synara/contracts";

import {
  mossIterationPacketExitCode,
  readMossIterationPacket,
  type MossIterationPacket,
} from "./moss-iteration-packet.ts";
import {
  mossMemoryPacketExitCode,
  readMossMemoryPacket,
  type MossMemoryPacket,
} from "./moss-memory-packet.ts";
import { readMossLoopLedgerDashboardSnapshot } from "./lib/moss-loop-ledger-snapshot.ts";
import {
  mossReviewPacketExitCode,
  readMossReviewPacket,
  type MossReviewPacket,
} from "./moss-review-packet.ts";
import {
  isMossExplicitChainedProvenanceBootstrapMessage,
  parseMossChainedRefreshProvenance,
  type MossChainedRefreshProvenance,
} from "./lib/moss-chained-refresh-provenance.ts";

export interface MossLoopPacketOptions {
  readonly createdAt?: string;
  readonly taskId?: string;
  readonly eventLimit?: number;
  readonly taskLimit?: number;
  readonly changedFiles?: ReadonlyArray<string>;
}

export interface MossLoopPacketFreshnessGateReport {
  readonly version: 1;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly task: MossLoopPacket["task"];
  readonly chainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
  readonly check: MossLoopPacketCheck;
  readonly loopPacketReadiness: MossLoopPacket["readiness"];
  readonly releaseFreshness: {
    readonly status: "pass" | "pending" | "blocked";
    readonly readinessStatus: "pass" | "fail";
    readonly summary: string;
    readonly manifestGateCount: number;
    readonly latestArtifactGateCount?: number | undefined;
    readonly artifactPath?: string | undefined;
    readonly latestArtifactCreatedAt?: string | undefined;
    readonly latestArtifactStatus?: "pass" | "fail" | undefined;
    readonly issueCount: number;
    readonly issueCodes: ReadonlyArray<string>;
    readonly staleArtifactMessages: ReadonlyArray<string>;
  };
  readonly source: {
    readonly loopPacketGeneratedAt: string;
    readonly dashboardSnapshotGeneratedAt: string;
    readonly releaseGateArtifactPath?: string | undefined;
  };
  readonly providerCredentialsRequired: false;
  readonly writesGlobalConfig: false;
}

export interface MossLoopPacketFreshnessGateReportArtifactResult {
  readonly path: string;
  readonly bytes: number;
}

export interface MossLoopPacketRefreshPlanGateReport {
  readonly version: 1;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly task: MossLoopPacket["task"];
  readonly chainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
  readonly check: MossLoopPacketCheck;
  readonly loopPacketReadiness: MossLoopPacket["readiness"];
  readonly refreshPlan: {
    readonly status: "pass" | "pending" | "blocked";
    readonly readinessStatus: "pass" | "fail";
    readonly summary: string;
    readonly expectedStepCount: number;
    readonly latestStepCount?: number | undefined;
    readonly artifactPath?: string | undefined;
    readonly latestArtifactCreatedAt?: string | undefined;
    readonly latestArtifactStatus?: "pass" | "fail" | undefined;
    readonly mode?: string | undefined;
    readonly writesFiles?: boolean | undefined;
    readonly writesGlobalConfig?: boolean | undefined;
    readonly providerCredentialsRequired?: boolean | undefined;
    readonly requiresReleaseArtifactRefresh?: boolean | undefined;
    readonly requiresLoopFreshnessRefresh?: boolean | undefined;
    readonly issueCount: number;
    readonly issueCodes: ReadonlyArray<string>;
  };
  readonly source: {
    readonly loopPacketGeneratedAt: string;
    readonly dashboardSnapshotGeneratedAt: string;
    readonly refreshPlanArtifactPath?: string | undefined;
  };
  readonly providerCredentialsRequired: false;
  readonly writesFiles: false;
  readonly writesGlobalConfig: false;
}

export interface MossLoopPacketRefreshPlanGateReportArtifactResult {
  readonly path: string;
  readonly bytes: number;
}

export interface MossLoopPacketCheck {
  readonly id:
    | "iteration-packet"
    | "review-packet"
    | "memory-packet"
    | "loop-ledger-release-freshness"
    | "loop-ledger-refresh-plan";
  readonly status: "pass" | "pending" | "fail";
  readonly summary: string;
  readonly exitCode: number;
}

export interface MossLoopPacketIssue {
  readonly code:
    | "iteration-packet-blocked"
    | "memory-packet-blocked"
    | "review-packet-blocked"
    | "loop-ledger-release-freshness-blocked"
    | "loop-ledger-refresh-plan-blocked";
  readonly severity: "error";
  readonly message: string;
}

export interface MossLoopPacket {
  readonly version: 1;
  readonly generatedAt: string;
  readonly sourceFiles: ReadonlyArray<string>;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly owner: string;
    readonly status: string;
    readonly metadata?: Record<string, unknown>;
  };
  readonly packets: {
    readonly iteration: MossIterationPacket;
    readonly review: MossReviewPacket;
    readonly memory: MossMemoryPacket;
    readonly loopLedgerDashboard: Pick<
      MossLoopLedgerDashboardSnapshot,
      "generatedAt" | "releaseGate"
    >;
  };
  readonly checks: ReadonlyArray<MossLoopPacketCheck>;
  readonly issues: ReadonlyArray<MossLoopPacketIssue>;
  readonly readiness: {
    readonly status: "ready" | "pending" | "blocked";
    readonly summary: string;
  };
}

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)].filter((value) => value.length > 0);
}

function checkForPacket(input: {
  readonly id: MossLoopPacketCheck["id"];
  readonly exitCode: number;
  readonly readinessStatus?: "ready" | "pending" | "blocked";
}): MossLoopPacketCheck {
  if (input.exitCode !== 0 || input.readinessStatus === "blocked") {
    return {
      id: input.id,
      status: "fail",
      summary: `${input.id} has blocking errors.`,
      exitCode: input.exitCode || 1,
    };
  }
  if (input.readinessStatus === "pending") {
    return {
      id: input.id,
      status: "pending",
      summary: `${input.id} is generated, but follow-up evidence or review is pending.`,
      exitCode: 0,
    };
  }
  return {
    id: input.id,
    status: "pass",
    summary: `${input.id} passed.`,
    exitCode: 0,
  };
}

function issueForFailedCheck(check: MossLoopPacketCheck): MossLoopPacketIssue | null {
  if (check.status !== "fail") {
    return null;
  }
  if (check.id === "iteration-packet") {
    return {
      code: "iteration-packet-blocked",
      severity: "error",
      message: check.summary,
    };
  }
  if (check.id === "review-packet") {
    return {
      code: "review-packet-blocked",
      severity: "error",
      message: check.summary,
    };
  }
  if (check.id === "loop-ledger-release-freshness") {
    return {
      code: "loop-ledger-release-freshness-blocked",
      severity: "error",
      message: check.summary,
    };
  }
  if (check.id === "loop-ledger-refresh-plan") {
    return {
      code: "loop-ledger-refresh-plan-blocked",
      severity: "error",
      message: check.summary,
    };
  }
  return {
    code: "memory-packet-blocked",
    severity: "error",
    message: check.summary,
  };
}

function checkLoopLedgerReleaseFreshness(
  snapshot: MossLoopLedgerDashboardSnapshot,
): MossLoopPacketCheck {
  const freshness = snapshot.releaseGate.freshness;
  if (!freshness) {
    return {
      id: "loop-ledger-release-freshness",
      status: "fail",
      summary: "Loop Ledger Dashboard snapshot is missing release freshness evidence.",
      exitCode: 1,
    };
  }

  const latestGateCount = freshness.latestArtifactGateCount ?? 0;
  const gateCountMismatch = freshness.manifestGateCount !== latestGateCount;
  const missingArtifact = !freshness.artifactPath || latestGateCount === 0;
  if (
    freshness.status !== "pass" ||
    freshness.readinessStatus !== "pass" ||
    freshness.issueCount > 0 ||
    gateCountMismatch ||
    missingArtifact
  ) {
    const issueCodes = freshness.issueCodes.length > 0 ? freshness.issueCodes.join(", ") : "none";
    return {
      id: "loop-ledger-release-freshness",
      status: "fail",
      summary: `Loop Ledger Dashboard release freshness is not pass: readiness=${
        freshness.readinessStatus
      }, manifestGates=${freshness.manifestGateCount}, latestGates=${latestGateCount}, issues=${
        freshness.issueCount
      }, issueCodes=${issueCodes}.`,
      exitCode: 1,
    };
  }

  return {
    id: "loop-ledger-release-freshness",
    status: "pass",
    summary: `Loop Ledger Dashboard release freshness passed with ${latestGateCount}/${freshness.manifestGateCount} gate(s).`,
    exitCode: 0,
  };
}

function canBootstrapExplicitChainedProvenance(
  freshness: MossLoopLedgerDashboardSnapshot["releaseGate"]["freshness"] | undefined,
): boolean {
  if (!freshness || freshness.staleArtifactMessages.length === 0) {
    return false;
  }

  const latestGateCount = freshness.latestArtifactGateCount ?? 0;
  return (
    freshness.latestArtifactStatus === "pass" &&
    Boolean(freshness.artifactPath) &&
    freshness.manifestGateCount === latestGateCount &&
    freshness.issueCodes.every((code) => code === "stale-artifact") &&
    freshness.staleArtifactMessages.every(isMossExplicitChainedProvenanceBootstrapMessage)
  );
}

function normalizeReleaseFreshnessForExplicitChainedBootstrap(input: {
  readonly packet: MossLoopLedgerDashboardSnapshot;
  readonly chainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
}): MossLoopLedgerDashboardSnapshot {
  const freshness = input.packet.releaseGate.freshness;
  if (
    !freshness ||
    !input.chainedRefreshProvenance ||
    !canBootstrapExplicitChainedProvenance(freshness)
  ) {
    return input.packet;
  }

  return {
    ...input.packet,
    releaseGate: {
      ...input.packet.releaseGate,
      freshness: {
        ...freshness,
        status: "pass",
        readinessStatus: "pass",
        summary:
          "Release artifact freshness is otherwise current; explicit chained provenance will be supplied by this loop report.",
        issueCount: 0,
        issueCodes: [],
        staleArtifactMessages: [],
      },
    },
  };
}

function checkLoopLedgerRefreshPlan(
  snapshot: MossLoopLedgerDashboardSnapshot,
): MossLoopPacketCheck {
  const refreshPlan = snapshot.releaseGate.refreshPlan;
  if (!refreshPlan) {
    return {
      id: "loop-ledger-refresh-plan",
      status: "fail",
      summary: "Loop Ledger Dashboard snapshot is missing refresh plan evidence.",
      exitCode: 1,
    };
  }

  const latestStepCount = refreshPlan.latestStepCount ?? 0;
  const stepCountMismatch = refreshPlan.expectedStepCount !== latestStepCount;
  const missingArtifact = !refreshPlan.artifactPath || latestStepCount === 0;
  const unsafeWriteFlags =
    refreshPlan.mode !== "dry-run" ||
    refreshPlan.writesFiles !== false ||
    refreshPlan.writesGlobalConfig !== false ||
    refreshPlan.providerCredentialsRequired !== false;
  if (
    refreshPlan.status !== "pass" ||
    refreshPlan.readinessStatus !== "pass" ||
    refreshPlan.issueCount > 0 ||
    refreshPlan.latestArtifactStatus !== "pass" ||
    stepCountMismatch ||
    missingArtifact ||
    unsafeWriteFlags
  ) {
    const issueCodes =
      refreshPlan.issueCodes.length > 0 ? refreshPlan.issueCodes.join(", ") : "none";
    return {
      id: "loop-ledger-refresh-plan",
      status: "fail",
      summary: `Loop Ledger Dashboard refresh plan is not pass: readiness=${
        refreshPlan.readinessStatus
      }, expectedSteps=${refreshPlan.expectedStepCount}, latestSteps=${latestStepCount}, artifactStatus=${
        refreshPlan.latestArtifactStatus ?? "none"
      }, mode=${refreshPlan.mode ?? "none"}, writesFiles=${
        refreshPlan.writesFiles ?? "none"
      }, writesGlobalConfig=${refreshPlan.writesGlobalConfig ?? "none"}, providerCredentialsRequired=${
        refreshPlan.providerCredentialsRequired ?? "none"
      }, issues=${refreshPlan.issueCount}, issueCodes=${issueCodes}.`,
      exitCode: 1,
    };
  }

  return {
    id: "loop-ledger-refresh-plan",
    status: "pass",
    summary: `Loop Ledger Dashboard refresh plan passed with ${latestStepCount}/${refreshPlan.expectedStepCount} step(s).`,
    exitCode: 0,
  };
}

function deriveReadiness(checks: ReadonlyArray<MossLoopPacketCheck>): MossLoopPacket["readiness"] {
  if (checks.some((check) => check.status === "fail")) {
    return {
      status: "blocked",
      summary: "Loop packet aggregate gate has blocking packet errors.",
    };
  }
  if (checks.some((check) => check.status === "pending")) {
    return {
      status: "pending",
      summary: "Loop packet aggregate gate is generated with pending review or evidence.",
    };
  }
  return {
    status: "ready",
    summary: "Loop packet aggregate gate is ready.",
  };
}

export function buildMossLoopPacket(input: {
  readonly generatedAt: string;
  readonly iterationPacket: MossIterationPacket;
  readonly reviewPacket: MossReviewPacket;
  readonly memoryPacket: MossMemoryPacket;
  readonly loopLedgerDashboardSnapshot: MossLoopLedgerDashboardSnapshot;
}): MossLoopPacket {
  const chainedRefreshProvenance = chainedRefreshProvenanceForTask(input.iterationPacket.task);
  const loopLedgerDashboardSnapshot = normalizeReleaseFreshnessForExplicitChainedBootstrap({
    packet: input.loopLedgerDashboardSnapshot,
    chainedRefreshProvenance,
  });
  const checks = [
    checkForPacket({
      id: "iteration-packet",
      exitCode: mossIterationPacketExitCode(input.iterationPacket),
    }),
    checkForPacket({
      id: "review-packet",
      exitCode: mossReviewPacketExitCode(input.reviewPacket),
      readinessStatus: input.reviewPacket.readiness.status,
    }),
    checkForPacket({
      id: "memory-packet",
      exitCode: mossMemoryPacketExitCode(input.memoryPacket),
      readinessStatus: input.memoryPacket.readiness.status,
    }),
    checkLoopLedgerReleaseFreshness(loopLedgerDashboardSnapshot),
    checkLoopLedgerRefreshPlan(loopLedgerDashboardSnapshot),
  ];
  const issues = checks
    .map(issueForFailedCheck)
    .filter((issue): issue is MossLoopPacketIssue => Boolean(issue));

  return {
    version: 1,
    generatedAt: input.generatedAt,
    sourceFiles: unique([
      ...input.iterationPacket.sourceFiles,
      ...input.reviewPacket.sourceFiles,
      ...input.memoryPacket.sourceFiles,
      "scripts/moss-loop-ledger-snapshot.ts",
      "scripts/lib/moss-loop-ledger-snapshot.ts",
      "scripts/lib/moss-release-gate-report-index.ts",
      "scripts/lib/moss-release-freshness-refresh-plan-report-index.ts",
      "scripts/moss-loop-packet.ts",
      "scripts/moss-memory-packet.ts",
      "package.json",
    ]),
    task: input.iterationPacket.task,
    packets: {
      iteration: input.iterationPacket,
      review: input.reviewPacket,
      memory: input.memoryPacket,
      loopLedgerDashboard: {
        generatedAt: loopLedgerDashboardSnapshot.generatedAt,
        releaseGate: loopLedgerDashboardSnapshot.releaseGate,
      },
    },
    checks,
    issues,
    readiness: deriveReadiness(checks),
  };
}

export async function readMossLoopPacket(
  repoRoot = process.cwd(),
  options: MossLoopPacketOptions = {},
): Promise<MossLoopPacket> {
  const generatedAt = options.createdAt ?? new Date().toISOString();
  const sharedOptions = {
    createdAt: generatedAt,
    ...(options.taskId ? { taskId: options.taskId } : {}),
  };
  const [iterationPacket, reviewPacket, memoryPacket, loopLedgerDashboardSnapshot] =
    await Promise.all([
      readMossIterationPacket(repoRoot, sharedOptions),
      readMossReviewPacket(repoRoot, {
        ...sharedOptions,
        ...(options.eventLimit ? { eventLimit: options.eventLimit } : {}),
        ...(options.changedFiles ? { changedFiles: options.changedFiles } : {}),
      }),
      readMossMemoryPacket(repoRoot, {
        createdAt: generatedAt,
        ...(options.eventLimit ? { eventLimit: options.eventLimit } : {}),
        ...(options.taskLimit ? { taskLimit: options.taskLimit } : {}),
      }),
      readMossLoopLedgerDashboardSnapshot(repoRoot, { createdAt: generatedAt }),
    ]);

  return buildMossLoopPacket({
    generatedAt,
    iterationPacket,
    reviewPacket,
    memoryPacket,
    loopLedgerDashboardSnapshot,
  });
}

export function mossLoopPacketExitCode(packet: MossLoopPacket): number {
  return packet.issues.length > 0 ? 1 : 0;
}

function missingFreshnessReportSummary(): MossLoopPacketFreshnessGateReport["releaseFreshness"] {
  return {
    status: "blocked",
    readinessStatus: "fail",
    summary: "Loop Ledger Dashboard snapshot is missing release freshness evidence.",
    manifestGateCount: 0,
    issueCount: 1,
    issueCodes: ["missing-dashboard-freshness"],
    staleArtifactMessages: [],
  };
}

function missingRefreshPlanReportSummary(): MossLoopPacketRefreshPlanGateReport["refreshPlan"] {
  return {
    status: "blocked",
    readinessStatus: "fail",
    summary: "Loop Ledger Dashboard snapshot is missing refresh plan evidence.",
    expectedStepCount: 0,
    issueCount: 1,
    issueCodes: ["missing-dashboard-refresh-plan"],
  };
}

function chainedRefreshProvenanceForTask(
  task: MossLoopPacket["task"],
): MossChainedRefreshProvenance | undefined {
  return parseMossChainedRefreshProvenance({
    value: task,
    fallbackTaskId: task.taskId,
    fallbackSource: "loop-packet-task-metadata",
  });
}

export function buildMossLoopPacketFreshnessGateReport(
  packet: MossLoopPacket,
): MossLoopPacketFreshnessGateReport {
  const check = packet.checks.find((entry) => entry.id === "loop-ledger-release-freshness");
  if (!check) {
    throw new Error("loop packet is missing loop-ledger-release-freshness check");
  }

  const freshness =
    packet.packets.loopLedgerDashboard.releaseGate.freshness ?? missingFreshnessReportSummary();
  const releaseFreshness = {
    status: freshness.status,
    readinessStatus: freshness.readinessStatus,
    summary: freshness.summary,
    manifestGateCount: freshness.manifestGateCount,
    ...(freshness.latestArtifactGateCount !== undefined
      ? { latestArtifactGateCount: freshness.latestArtifactGateCount }
      : {}),
    ...(freshness.artifactPath ? { artifactPath: freshness.artifactPath } : {}),
    ...(freshness.latestArtifactCreatedAt
      ? { latestArtifactCreatedAt: freshness.latestArtifactCreatedAt }
      : {}),
    ...(freshness.latestArtifactStatus
      ? { latestArtifactStatus: freshness.latestArtifactStatus }
      : {}),
    issueCount: freshness.issueCount,
    issueCodes: freshness.issueCodes,
    staleArtifactMessages: freshness.staleArtifactMessages,
  } satisfies MossLoopPacketFreshnessGateReport["releaseFreshness"];
  const chainedRefreshProvenance = chainedRefreshProvenanceForTask(packet.task);

  return {
    version: 1,
    createdAt: packet.generatedAt,
    status: check.status === "pass" ? "pass" : "fail",
    task: packet.task,
    ...(chainedRefreshProvenance ? { chainedRefreshProvenance } : {}),
    check,
    loopPacketReadiness: packet.readiness,
    releaseFreshness,
    source: {
      loopPacketGeneratedAt: packet.generatedAt,
      dashboardSnapshotGeneratedAt: packet.packets.loopLedgerDashboard.generatedAt,
      ...(releaseFreshness.artifactPath
        ? { releaseGateArtifactPath: releaseFreshness.artifactPath }
        : {}),
    },
    providerCredentialsRequired: false,
    writesGlobalConfig: false,
  };
}

export function buildMossLoopPacketRefreshPlanGateReport(
  packet: MossLoopPacket,
): MossLoopPacketRefreshPlanGateReport {
  const check = packet.checks.find((entry) => entry.id === "loop-ledger-refresh-plan");
  if (!check) {
    throw new Error("loop packet is missing loop-ledger-refresh-plan check");
  }

  const refreshPlan =
    packet.packets.loopLedgerDashboard.releaseGate.refreshPlan ?? missingRefreshPlanReportSummary();
  const refreshPlanSummary = {
    status: refreshPlan.status,
    readinessStatus: refreshPlan.readinessStatus,
    summary: refreshPlan.summary,
    expectedStepCount: refreshPlan.expectedStepCount,
    ...(refreshPlan.latestStepCount !== undefined
      ? { latestStepCount: refreshPlan.latestStepCount }
      : {}),
    ...(refreshPlan.artifactPath ? { artifactPath: refreshPlan.artifactPath } : {}),
    ...(refreshPlan.latestArtifactCreatedAt
      ? { latestArtifactCreatedAt: refreshPlan.latestArtifactCreatedAt }
      : {}),
    ...(refreshPlan.latestArtifactStatus
      ? { latestArtifactStatus: refreshPlan.latestArtifactStatus }
      : {}),
    ...(refreshPlan.mode ? { mode: refreshPlan.mode } : {}),
    ...(refreshPlan.writesFiles !== undefined ? { writesFiles: refreshPlan.writesFiles } : {}),
    ...(refreshPlan.writesGlobalConfig !== undefined
      ? { writesGlobalConfig: refreshPlan.writesGlobalConfig }
      : {}),
    ...(refreshPlan.providerCredentialsRequired !== undefined
      ? { providerCredentialsRequired: refreshPlan.providerCredentialsRequired }
      : {}),
    ...(refreshPlan.requiresReleaseArtifactRefresh !== undefined
      ? { requiresReleaseArtifactRefresh: refreshPlan.requiresReleaseArtifactRefresh }
      : {}),
    ...(refreshPlan.requiresLoopFreshnessRefresh !== undefined
      ? { requiresLoopFreshnessRefresh: refreshPlan.requiresLoopFreshnessRefresh }
      : {}),
    issueCount: refreshPlan.issueCount,
    issueCodes: refreshPlan.issueCodes,
  } satisfies MossLoopPacketRefreshPlanGateReport["refreshPlan"];
  const chainedRefreshProvenance = chainedRefreshProvenanceForTask(packet.task);

  return {
    version: 1,
    createdAt: packet.generatedAt,
    status: check.status === "pass" ? "pass" : "fail",
    task: packet.task,
    ...(chainedRefreshProvenance ? { chainedRefreshProvenance } : {}),
    check,
    loopPacketReadiness: packet.readiness,
    refreshPlan: refreshPlanSummary,
    source: {
      loopPacketGeneratedAt: packet.generatedAt,
      dashboardSnapshotGeneratedAt: packet.packets.loopLedgerDashboard.generatedAt,
      ...(refreshPlanSummary.artifactPath
        ? { refreshPlanArtifactPath: refreshPlanSummary.artifactPath }
        : {}),
    },
    providerCredentialsRequired: false,
    writesFiles: false,
    writesGlobalConfig: false,
  };
}

export function mossLoopPacketFreshnessGateReportExitCode(
  report: MossLoopPacketFreshnessGateReport,
): number {
  return report.status === "pass" ? 0 : 1;
}

export function mossLoopPacketRefreshPlanGateReportExitCode(
  report: MossLoopPacketRefreshPlanGateReport,
): number {
  return report.status === "pass" ? 0 : 1;
}

export function resolveMossLoopPacketFreshnessGateReportOutputPath(
  outputPath: string,
  cwd = process.cwd(),
): string {
  const trimmedPath = outputPath.trim();
  if (!trimmedPath) {
    throw new Error("--output requires a non-empty repo-local path");
  }

  const repoRoot = resolve(cwd);
  const resolvedPath = resolve(repoRoot, trimmedPath);
  const relativePath = relative(repoRoot, resolvedPath);
  const insideRepo =
    relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));

  if (!insideRepo) {
    throw new Error("--output must resolve inside the current repository");
  }

  return resolvedPath;
}

export function writeMossLoopPacketFreshnessGateReportArtifact(
  report: MossLoopPacketFreshnessGateReport,
  outputPath: string,
  cwd = process.cwd(),
): MossLoopPacketFreshnessGateReportArtifactResult {
  const artifactPath = resolveMossLoopPacketFreshnessGateReportOutputPath(outputPath, cwd);

  try {
    if (statSync(artifactPath).isDirectory()) {
      throw new Error(`--output points to a directory: ${outputPath}`);
    }
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const body = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, body, { encoding: "utf8" });
  formatMossLoopPacketFreshnessGateReportArtifact(artifactPath);

  return {
    path: artifactPath,
    bytes: Buffer.byteLength(readFileSync(artifactPath, "utf8"), "utf8"),
  };
}

function formatMossLoopPacketFreshnessGateReportArtifact(artifactPath: string): void {
  const result = spawnSync("bun", ["oxfmt", `--stdin-filepath=${artifactPath}`], {
    encoding: "utf8",
    input: readFileSync(artifactPath, "utf8"),
    stdio: "pipe",
  });
  if (result.error) {
    throw new Error(
      `failed to format loop packet freshness report artifact: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 1}`;
    throw new Error(`failed to format loop packet freshness report artifact: ${detail}`);
  }
  writeFileSync(artifactPath, result.stdout, { encoding: "utf8" });
}

function formatMossLoopPacketRefreshPlanGateReportArtifact(artifactPath: string): void {
  const result = spawnSync("bun", ["oxfmt", `--stdin-filepath=${artifactPath}`], {
    encoding: "utf8",
    input: readFileSync(artifactPath, "utf8"),
    stdio: "pipe",
  });
  if (result.error) {
    throw new Error(
      `failed to format loop packet refresh plan report artifact: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 1}`;
    throw new Error(`failed to format loop packet refresh plan report artifact: ${detail}`);
  }
  writeFileSync(artifactPath, result.stdout, { encoding: "utf8" });
}

export function writeMossLoopPacketRefreshPlanGateReportArtifact(
  report: MossLoopPacketRefreshPlanGateReport,
  outputPath: string,
  cwd = process.cwd(),
): MossLoopPacketRefreshPlanGateReportArtifactResult {
  const artifactPath = resolveMossLoopPacketFreshnessGateReportOutputPath(outputPath, cwd);

  try {
    if (statSync(artifactPath).isDirectory()) {
      throw new Error(`--output points to a directory: ${outputPath}`);
    }
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? error.code : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const body = `${JSON.stringify(report, null, 2)}\n`;
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, body, { encoding: "utf8" });
  formatMossLoopPacketRefreshPlanGateReportArtifact(artifactPath);

  return {
    path: artifactPath,
    bytes: Buffer.byteLength(readFileSync(artifactPath, "utf8"), "utf8"),
  };
}

function parsePositiveIntegerOption(flag: string, value: string | undefined): number {
  if (!value) {
    throw new Error(`${flag} requires a number`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseCliOptions(argv: ReadonlyArray<string>): {
  readonly options: MossLoopPacketOptions;
  readonly report: "none" | "freshness" | "refresh-plan";
  readonly outputPath?: string | undefined;
} {
  const options: {
    createdAt?: string;
    taskId?: string;
    eventLimit?: number;
    taskLimit?: number;
    changedFiles?: string[];
  } = {};
  let report: "none" | "freshness" | "refresh-plan" = "none";
  let outputPath: string | undefined;

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
    if (arg === "--event-limit") {
      options.eventLimit = parsePositiveIntegerOption(arg, argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--task-limit") {
      options.taskLimit = parsePositiveIntegerOption(arg, argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--changed-file") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--changed-file requires a file path");
      }
      options.changedFiles = [...(options.changedFiles ?? []), value];
      index += 1;
      continue;
    }
    if (arg === "--report") {
      if (report !== "none") {
        throw new Error("--report cannot be combined with --refresh-plan-report");
      }
      report = "freshness";
      continue;
    }
    if (arg === "--refresh-plan-report") {
      if (report !== "none") {
        throw new Error("--refresh-plan-report cannot be combined with --report");
      }
      report = "refresh-plan";
      continue;
    }
    if (arg === "--output") {
      outputPath = argv[index + 1];
      if (!outputPath) {
        throw new Error("--output requires a repo-local artifact path");
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown moss loop packet option: ${arg}`);
  }

  return {
    options,
    report,
    outputPath,
  };
}

async function main(): Promise<void> {
  const { options, report, outputPath } = parseCliOptions(process.argv.slice(2));
  if (outputPath && report === "none") {
    throw new Error("--output requires --report or --refresh-plan-report");
  }
  const packet = await readMossLoopPacket(process.cwd(), options);
  if (report === "freshness") {
    const freshnessReport = buildMossLoopPacketFreshnessGateReport(packet);
    if (outputPath) {
      writeMossLoopPacketFreshnessGateReportArtifact(freshnessReport, outputPath);
    }
    process.stdout.write(`${JSON.stringify(freshnessReport, null, 2)}\n`);
    process.exitCode = mossLoopPacketFreshnessGateReportExitCode(freshnessReport);
    return;
  }
  if (report === "refresh-plan") {
    const refreshPlanReport = buildMossLoopPacketRefreshPlanGateReport(packet);
    if (outputPath) {
      writeMossLoopPacketRefreshPlanGateReportArtifact(refreshPlanReport, outputPath);
    }
    process.stdout.write(`${JSON.stringify(refreshPlanReport, null, 2)}\n`);
    process.exitCode = mossLoopPacketRefreshPlanGateReportExitCode(refreshPlanReport);
    return;
  }

  process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
  process.exitCode = mossLoopPacketExitCode(packet);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
