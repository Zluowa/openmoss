import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildMossReleaseGateManifest } from "./lib/moss-release-gate-manifest.ts";
import {
  parseMossChainedRefreshProvenance,
  type MossChainedRefreshProvenance,
} from "./lib/moss-chained-refresh-provenance.ts";
import type {
  MossReleaseGateId,
  MossReleaseGateManifest,
  MossReleaseGateOptions,
  MossReleaseGateReportIndexObservedEvidence,
} from "./lib/moss-release-gate-manifest.ts";

export { buildMossReleaseGateManifest };
export type {
  MossReleaseGateCommand,
  MossReleaseGateId,
  MossReleaseGateManifest,
  MossReleaseGateOptions,
  MossReleaseGateReportIndexObservedEvidence,
} from "./lib/moss-release-gate-manifest.ts";

export interface MossReleaseGateSpawnResult {
  readonly status: number | null;
  readonly error?: Error | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

export interface MossReleaseGateSpawnOptions {
  readonly stdio: "inherit" | "pipe";
}

export type MossReleaseGateSpawn = (
  command: string,
  args: ReadonlyArray<string>,
  options: MossReleaseGateSpawnOptions,
) => MossReleaseGateSpawnResult;

export interface MossReleaseGateReportEntryObservedEvidence {
  readonly providerDiscoverySmoke?: MossProviderDiscoverySmokeObservedEvidence | undefined;
  readonly electronProductShellSmoke?: MossElectronProductShellSmokeObservedEvidence | undefined;
  readonly codexDesktopLayoutGate?: MossCodexDesktopLayoutGateObservedEvidence | undefined;
  readonly loopPacketFreshnessReportIndex?:
    | MossLoopPacketFreshnessReportIndexObservedEvidence
    | undefined;
  readonly loopPacketRefreshPlanReportIndex?:
    | MossLoopPacketRefreshPlanReportIndexObservedEvidence
    | undefined;
  readonly releaseFreshnessRefreshPlanReportIndex?:
    | MossReleaseFreshnessRefreshPlanReportIndexObservedEvidence
    | undefined;
  readonly releaseGateReportIndex?: MossReleaseGateReportIndexObservedEvidence | undefined;
}

export interface MossReleaseGateReportEntryRefreshEvidence {
  readonly mode: "release-report-artifact-refresh";
  readonly reason: "stale-release-report-artifact";
  readonly originalExitCode: number;
  readonly issueCodes: ReadonlyArray<string>;
  readonly summary: string;
}

export interface MossReleaseGateReportRefreshSummary {
  readonly mode: "release-report-artifact-refresh";
  readonly reason: "manifest-change";
  readonly refreshedGateIds: ReadonlyArray<MossReleaseGateId>;
}

export interface MossProviderDiscoverySmokeObservedEvidence {
  readonly readinessStatus: "pass" | "fail";
  readonly reportPath: string;
  readonly reportCreatedAt?: string | undefined;
  readonly provider?: string | undefined;
  readonly runtimeBoundary?: string | undefined;
  readonly providerCredentialsRequired?: boolean | undefined;
  readonly writesGlobalConfig?: boolean | undefined;
  readonly operationCount?: number | undefined;
  readonly adapterInvocationCount?: number | undefined;
  readonly operationIds?: ReadonlyArray<string> | undefined;
  readonly skillItems?: ReadonlyArray<string> | undefined;
  readonly pluginItems?: ReadonlyArray<string> | undefined;
  readonly modelItems?: ReadonlyArray<string> | undefined;
  readonly issueCodes: ReadonlyArray<string>;
}

export interface MossElectronProductShellSmokeObservedEvidence {
  readonly readinessStatus: "pass" | "fail";
  readonly reportPath: string;
  readonly screenshotPath: string;
  readonly reportCreatedAt?: string | undefined;
  readonly route?: string | undefined;
  readonly desktopRuntime?: string | undefined;
  readonly backendMode?: string | undefined;
  readonly assertionCount?: number | undefined;
  readonly runtimeDataset?: string | undefined;
  readonly hasDesktopBridge?: boolean | undefined;
  readonly hasNativeApi?: boolean | undefined;
  readonly backendHealthStatus?: number | undefined;
  readonly backendProcessPresent?: boolean | undefined;
  readonly screenshotBytes?: number | undefined;
  readonly issueCodes: ReadonlyArray<string>;
}

export interface MossCodexDesktopLayoutGateObservedEvidence {
  readonly readinessStatus: "pass" | "fail";
  readonly comparatorPath: string;
  readonly comparatorUpdatedAt?: string | undefined;
  readonly comparatorGateStatus?: "pass" | "fail" | undefined;
  readonly layoutGateStatus?: "pass" | "fail" | undefined;
  readonly issueCount?: number | undefined;
  readonly nextGapId?: string | undefined;
  readonly codexCapturedAt?: string | undefined;
  readonly mossCapturedAt?: string | undefined;
  readonly deltaCount?: number | undefined;
  readonly failedDeltaIds?: ReadonlyArray<string> | undefined;
  readonly deltaMessages?: ReadonlyArray<string> | undefined;
  readonly strictThresholds?: Readonly<Record<string, number>> | undefined;
  readonly issueCodes: ReadonlyArray<string>;
}

export interface MossLoopPacketFreshnessReportIndexObservedEvidence {
  readonly readinessStatus: "pass" | "fail";
  readonly latestArtifactPath?: string | undefined;
  readonly latestArtifactCreatedAt?: string | undefined;
  readonly latestArtifactStatus?: "pass" | "fail" | undefined;
  readonly latestTaskId?: string | undefined;
  readonly latestChainedRefreshTaskId?: string | undefined;
  readonly latestChainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
  readonly latestCheckStatus?: "pass" | "pending" | "fail" | undefined;
  readonly latestLoopPacketReadinessStatus?: "ready" | "pending" | "blocked" | undefined;
  readonly releaseFreshnessStatus?: "pass" | "pending" | "blocked" | undefined;
  readonly releaseFreshnessReadinessStatus?: "pass" | "fail" | undefined;
  readonly releaseFreshnessIssueCodes?: ReadonlyArray<string> | undefined;
  readonly issueCodes: ReadonlyArray<string>;
}

export interface MossLoopPacketRefreshPlanReportIndexObservedEvidence {
  readonly readinessStatus: "pass" | "fail";
  readonly latestArtifactPath?: string | undefined;
  readonly latestArtifactCreatedAt?: string | undefined;
  readonly latestArtifactStatus?: "pass" | "fail" | undefined;
  readonly latestTaskId?: string | undefined;
  readonly latestChainedRefreshTaskId?: string | undefined;
  readonly latestChainedRefreshProvenance?: MossChainedRefreshProvenance | undefined;
  readonly latestCheckStatus?: "pass" | "pending" | "fail" | undefined;
  readonly latestLoopPacketReadinessStatus?: "ready" | "pending" | "blocked" | undefined;
  readonly writesFiles?: boolean | undefined;
  readonly writesGlobalConfig?: boolean | undefined;
  readonly providerCredentialsRequired?: boolean | undefined;
  readonly refreshPlanStatus?: "pass" | "pending" | "blocked" | undefined;
  readonly refreshPlanReadinessStatus?: "pass" | "fail" | undefined;
  readonly refreshPlanArtifactPath?: string | undefined;
  readonly refreshPlanExpectedStepCount?: number | undefined;
  readonly refreshPlanLatestStepCount?: number | undefined;
  readonly refreshPlanLatestArtifactStatus?: "pass" | "fail" | undefined;
  readonly refreshPlanMode?: string | undefined;
  readonly refreshPlanWritesFiles?: boolean | undefined;
  readonly refreshPlanWritesGlobalConfig?: boolean | undefined;
  readonly refreshPlanProviderCredentialsRequired?: boolean | undefined;
  readonly refreshPlanRequiresReleaseArtifactRefresh?: boolean | undefined;
  readonly refreshPlanRequiresLoopFreshnessRefresh?: boolean | undefined;
  readonly refreshPlanIssueCodes?: ReadonlyArray<string> | undefined;
  readonly issueCodes: ReadonlyArray<string>;
}

export interface MossReleaseFreshnessRefreshPlanReportIndexObservedEvidence {
  readonly readinessStatus: "pass" | "fail";
  readonly latestArtifactPath?: string | undefined;
  readonly latestArtifactCreatedAt?: string | undefined;
  readonly latestArtifactStatus?: "pass" | "fail" | undefined;
  readonly mode?: string | undefined;
  readonly writesFiles?: boolean | undefined;
  readonly writesGlobalConfig?: boolean | undefined;
  readonly providerCredentialsRequired?: boolean | undefined;
  readonly requiresReleaseArtifactRefresh?: boolean | undefined;
  readonly requiresLoopFreshnessRefresh?: boolean | undefined;
  readonly requiresLoopRefreshPlanReportRefresh?: boolean | undefined;
  readonly releaseFreshnessRefreshPlanReportArtifactOutput?: string | undefined;
  readonly loopPacketRefreshPlanReportArtifactOutput?: string | undefined;
  readonly stepOrder?: ReadonlyArray<string> | undefined;
  readonly issueCodes: ReadonlyArray<string>;
}

export interface MossReleaseGateReportEntry {
  readonly id: MossReleaseGateId;
  readonly status: "pass" | "fail";
  readonly exitCode: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly expectedEvidence: ReadonlyArray<string>;
  readonly durationMs: number;
  readonly providerCredentialsRequired: false;
  readonly writesGlobalConfig: false;
  readonly observedEvidence?: MossReleaseGateReportEntryObservedEvidence | undefined;
  readonly refreshEvidence?: MossReleaseGateReportEntryRefreshEvidence | undefined;
  readonly errorMessage?: string | undefined;
}

export interface MossReleaseGateReport {
  readonly version: 1;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly failedGateId?: MossReleaseGateId | undefined;
  readonly refresh?: MossReleaseGateReportRefreshSummary | undefined;
  readonly gates: ReadonlyArray<MossReleaseGateReportEntry>;
}

export type MossReleaseGateClock = () => number;

export interface MossReleaseGateReportArtifactResult {
  readonly path: string;
  readonly bytes: number;
}

export function runMossReleaseGateCommands(
  manifest: MossReleaseGateManifest = buildMossReleaseGateManifest(),
  spawn: MossReleaseGateSpawn = spawnMossReleaseGateCommand,
): number {
  for (const entry of manifest.gates) {
    console.log(`\n[moss:release-gate] ${entry.id}`);
    console.log(`$ ${[entry.command, ...entry.args].join(" ")}`);
    const result = spawn(entry.command, entry.args, { stdio: "inherit" });
    if (result.error) {
      console.error(`[moss:release-gate] ${entry.id} failed: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) {
      const status = result.status ?? 1;
      console.error(`[moss:release-gate] ${entry.id} exited with ${status}`);
      return status;
    }
  }
  console.log("\n[moss:release-gate] pass");
  return 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asStringArray(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    return null;
  }
  return value;
}

function parseFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    return null;
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function readReleaseGateReportIndexObservedEvidence(
  stdout: string | undefined,
): MossReleaseGateReportIndexObservedEvidence | undefined {
  if (!stdout) {
    return undefined;
  }

  const parsed = parseFirstJsonObject(stdout);
  if (!isObject(parsed) || !isObject(parsed.manifest) || !isObject(parsed.readiness)) {
    return undefined;
  }

  const manifestGateIds = asStringArray(parsed.manifest.gateIds);
  if (
    typeof parsed.readiness.status !== "string" ||
    (parsed.readiness.status !== "pass" && parsed.readiness.status !== "fail") ||
    typeof parsed.manifest.gateCount !== "number" ||
    !manifestGateIds
  ) {
    return undefined;
  }

  const latest = isObject(parsed.latest) ? parsed.latest : null;
  const latestGateIds = latest ? asStringArray(latest.gateIds) : null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isObject) : [];
  const issueCodes = issues
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string");
  const staleArtifactMessages = issues
    .filter((issue) => issue.code === "stale-artifact" && typeof issue.message === "string")
    .map((issue) => issue.message as string);

  return {
    readinessStatus: parsed.readiness.status,
    manifestGateCount: parsed.manifest.gateCount,
    manifestGateIds,
    ...(latest && typeof latest.path === "string" ? { latestArtifactPath: latest.path } : {}),
    ...(latest && typeof latest.createdAt === "string"
      ? { latestArtifactCreatedAt: latest.createdAt }
      : {}),
    ...(latest && (latest.status === "pass" || latest.status === "fail")
      ? { latestArtifactStatus: latest.status }
      : {}),
    ...(latest && typeof latest.gateCount === "number"
      ? { latestArtifactGateCount: latest.gateCount }
      : {}),
    ...(latestGateIds ? { latestArtifactGateIds: latestGateIds } : {}),
    issueCodes,
    staleArtifactMessages,
  };
}

function readElectronProductShellSmokeObservedEvidence(
  stdout: string | undefined,
): MossElectronProductShellSmokeObservedEvidence | undefined {
  if (!stdout) {
    return undefined;
  }

  const parsed = parseFirstJsonObject(stdout);
  if (!isObject(parsed) || !isObject(parsed.readiness)) {
    return undefined;
  }

  if (
    (parsed.readiness.status !== "pass" && parsed.readiness.status !== "fail") ||
    typeof parsed.reportPath !== "string" ||
    typeof parsed.screenshotPath !== "string"
  ) {
    return undefined;
  }

  const report = isObject(parsed.report) ? parsed.report : null;
  const screenshot = isObject(parsed.screenshot) ? parsed.screenshot : null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isObject) : [];
  const issueCodes = issues
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string");

  return {
    readinessStatus: parsed.readiness.status,
    reportPath: parsed.reportPath,
    screenshotPath: parsed.screenshotPath,
    ...(report && typeof report.createdAt === "string"
      ? { reportCreatedAt: report.createdAt }
      : {}),
    ...(report && typeof report.route === "string" ? { route: report.route } : {}),
    ...(report && typeof report.desktopRuntime === "string"
      ? { desktopRuntime: report.desktopRuntime }
      : {}),
    ...(report && typeof report.backendMode === "string"
      ? { backendMode: report.backendMode }
      : {}),
    ...(report && typeof report.assertionCount === "number"
      ? { assertionCount: report.assertionCount }
      : {}),
    ...(report && typeof report.runtimeDataset === "string"
      ? { runtimeDataset: report.runtimeDataset }
      : {}),
    ...(report && typeof report.hasDesktopBridge === "boolean"
      ? { hasDesktopBridge: report.hasDesktopBridge }
      : {}),
    ...(report && typeof report.hasNativeApi === "boolean"
      ? { hasNativeApi: report.hasNativeApi }
      : {}),
    ...(report && typeof report.backendHealthStatus === "number"
      ? { backendHealthStatus: report.backendHealthStatus }
      : {}),
    ...(report && typeof report.backendProcessPresent === "boolean"
      ? { backendProcessPresent: report.backendProcessPresent }
      : {}),
    ...(screenshot && typeof screenshot.bytes === "number"
      ? { screenshotBytes: screenshot.bytes }
      : {}),
    issueCodes,
  };
}

function readProviderDiscoverySmokeObservedEvidence(
  stdout: string | undefined,
): MossProviderDiscoverySmokeObservedEvidence | undefined {
  if (!stdout) {
    return undefined;
  }

  const parsed = parseFirstJsonObject(stdout);
  if (!isObject(parsed) || !isObject(parsed.readiness)) {
    return undefined;
  }

  if (
    (parsed.readiness.status !== "pass" && parsed.readiness.status !== "fail") ||
    typeof parsed.reportPath !== "string"
  ) {
    return undefined;
  }

  const report = isObject(parsed.report) ? parsed.report : null;
  const operations = Array.isArray(parsed.operations) ? parsed.operations.filter(isObject) : [];
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isObject) : [];
  const issueCodes = issues
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string");
  const operationIds = operations
    .map((operation) => operation.id)
    .filter((id): id is string => typeof id === "string");
  const itemsForOperation = (id: string) => {
    const operation = operations.find((entry) => entry.id === id);
    return operation ? asStringArray(operation.items) : null;
  };

  const skillItems = itemsForOperation("listSkills");
  const pluginItems = itemsForOperation("listPlugins");
  const modelItems = itemsForOperation("listModels");

  return {
    readinessStatus: parsed.readiness.status,
    reportPath: parsed.reportPath,
    ...(report && typeof report.createdAt === "string"
      ? { reportCreatedAt: report.createdAt }
      : {}),
    ...(report && typeof report.provider === "string" ? { provider: report.provider } : {}),
    ...(report && typeof report.runtimeBoundary === "string"
      ? { runtimeBoundary: report.runtimeBoundary }
      : {}),
    ...(report && typeof report.providerCredentialsRequired === "boolean"
      ? { providerCredentialsRequired: report.providerCredentialsRequired }
      : {}),
    ...(report && typeof report.writesGlobalConfig === "boolean"
      ? { writesGlobalConfig: report.writesGlobalConfig }
      : {}),
    ...(report && typeof report.operationCount === "number"
      ? { operationCount: report.operationCount }
      : {}),
    ...(report && typeof report.adapterInvocationCount === "number"
      ? { adapterInvocationCount: report.adapterInvocationCount }
      : {}),
    ...(operationIds.length > 0 ? { operationIds } : {}),
    ...(skillItems ? { skillItems } : {}),
    ...(pluginItems ? { pluginItems } : {}),
    ...(modelItems ? { modelItems } : {}),
    issueCodes,
  };
}

function readCodexDesktopLayoutGateObservedEvidence(
  stdout: string | undefined,
): MossCodexDesktopLayoutGateObservedEvidence | undefined {
  if (!stdout) {
    return undefined;
  }

  const parsed = parseFirstJsonObject(stdout);
  if (!isObject(parsed) || !isObject(parsed.readiness)) {
    return undefined;
  }

  if (
    (parsed.readiness.status !== "pass" && parsed.readiness.status !== "fail") ||
    typeof parsed.comparatorPath !== "string"
  ) {
    return undefined;
  }

  const comparator = isObject(parsed.comparator) ? parsed.comparator : null;
  const layout = isObject(parsed.layout) ? parsed.layout : null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isObject) : [];
  const issueCodes = issues
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string");
  const failedDeltaIds = layout ? asStringArray(layout.failedDeltaIds) : null;
  const deltaMessages =
    layout && Array.isArray(layout.deltas)
      ? layout.deltas
          .filter(isObject)
          .map((delta) =>
            typeof delta.id === "string" && typeof delta.message === "string"
              ? `${delta.id}: ${delta.message}`
              : undefined,
          )
          .filter((message): message is string => typeof message === "string")
      : null;
  const strictThresholds =
    layout && isObject(layout.strictThresholds)
      ? Object.fromEntries(
          Object.entries(layout.strictThresholds).filter((entry): entry is [string, number] => {
            const [, value] = entry;
            return typeof value === "number" && Number.isFinite(value);
          }),
        )
      : null;

  return {
    readinessStatus: parsed.readiness.status,
    comparatorPath: parsed.comparatorPath,
    ...(comparator && typeof comparator.updatedAt === "string"
      ? { comparatorUpdatedAt: comparator.updatedAt }
      : {}),
    ...(comparator && (comparator.gateStatus === "pass" || comparator.gateStatus === "fail")
      ? { comparatorGateStatus: comparator.gateStatus }
      : {}),
    ...(comparator &&
    (comparator.layoutGateStatus === "pass" || comparator.layoutGateStatus === "fail")
      ? { layoutGateStatus: comparator.layoutGateStatus }
      : {}),
    ...(comparator && typeof comparator.issueCount === "number"
      ? { issueCount: comparator.issueCount }
      : {}),
    ...(comparator && typeof comparator.nextGapId === "string"
      ? { nextGapId: comparator.nextGapId }
      : {}),
    ...(layout && typeof layout.codexCapturedAt === "string"
      ? { codexCapturedAt: layout.codexCapturedAt }
      : {}),
    ...(layout && typeof layout.mossCapturedAt === "string"
      ? { mossCapturedAt: layout.mossCapturedAt }
      : {}),
    ...(layout && typeof layout.deltaCount === "number" ? { deltaCount: layout.deltaCount } : {}),
    ...(failedDeltaIds ? { failedDeltaIds } : {}),
    ...(deltaMessages && deltaMessages.length > 0 ? { deltaMessages } : {}),
    ...(strictThresholds && Object.keys(strictThresholds).length > 0 ? { strictThresholds } : {}),
    issueCodes,
  };
}

function readLoopPacketFreshnessReportIndexObservedEvidence(
  stdout: string | undefined,
): MossLoopPacketFreshnessReportIndexObservedEvidence | undefined {
  if (!stdout) {
    return undefined;
  }

  const parsed = parseFirstJsonObject(stdout);
  if (!isObject(parsed) || !isObject(parsed.readiness)) {
    return undefined;
  }

  if (
    typeof parsed.readiness.status !== "string" ||
    (parsed.readiness.status !== "pass" && parsed.readiness.status !== "fail")
  ) {
    return undefined;
  }

  const latest = isObject(parsed.latest) ? parsed.latest : null;
  const releaseFreshness =
    latest && isObject(latest.releaseFreshness) ? latest.releaseFreshness : null;
  const chainedRefreshProvenance = latest
    ? parseMossChainedRefreshProvenance({
        value: latest,
        fallbackTaskId: typeof latest.taskId === "string" ? latest.taskId : undefined,
        fallbackSource: "loop-packet-task-metadata",
      })
    : undefined;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isObject) : [];
  const issueCodes = issues
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string");
  const releaseFreshnessIssueCodes = releaseFreshness
    ? asStringArray(releaseFreshness.issueCodes)
    : null;

  return {
    readinessStatus: parsed.readiness.status,
    ...(latest && typeof latest.path === "string" ? { latestArtifactPath: latest.path } : {}),
    ...(latest && typeof latest.createdAt === "string"
      ? { latestArtifactCreatedAt: latest.createdAt }
      : {}),
    ...(latest && (latest.status === "pass" || latest.status === "fail")
      ? { latestArtifactStatus: latest.status }
      : {}),
    ...(latest && typeof latest.taskId === "string" ? { latestTaskId: latest.taskId } : {}),
    ...(chainedRefreshProvenance
      ? {
          latestChainedRefreshTaskId: chainedRefreshProvenance.taskId,
          latestChainedRefreshProvenance: chainedRefreshProvenance,
        }
      : {}),
    ...(latest &&
    (latest.checkStatus === "pass" ||
      latest.checkStatus === "pending" ||
      latest.checkStatus === "fail")
      ? { latestCheckStatus: latest.checkStatus }
      : {}),
    ...(latest &&
    (latest.loopPacketReadinessStatus === "ready" ||
      latest.loopPacketReadinessStatus === "pending" ||
      latest.loopPacketReadinessStatus === "blocked")
      ? { latestLoopPacketReadinessStatus: latest.loopPacketReadinessStatus }
      : {}),
    ...(releaseFreshness &&
    (releaseFreshness.status === "pass" ||
      releaseFreshness.status === "pending" ||
      releaseFreshness.status === "blocked")
      ? { releaseFreshnessStatus: releaseFreshness.status }
      : {}),
    ...(releaseFreshness &&
    (releaseFreshness.readinessStatus === "pass" || releaseFreshness.readinessStatus === "fail")
      ? { releaseFreshnessReadinessStatus: releaseFreshness.readinessStatus }
      : {}),
    ...(releaseFreshnessIssueCodes
      ? { releaseFreshnessIssueCodes: releaseFreshnessIssueCodes }
      : {}),
    issueCodes,
  };
}

function readReleaseFreshnessRefreshPlanReportIndexObservedEvidence(
  stdout: string | undefined,
): MossReleaseFreshnessRefreshPlanReportIndexObservedEvidence | undefined {
  if (!stdout) {
    return undefined;
  }

  const parsed = parseFirstJsonObject(stdout);
  if (!isObject(parsed) || !isObject(parsed.readiness)) {
    return undefined;
  }

  if (
    typeof parsed.readiness.status !== "string" ||
    (parsed.readiness.status !== "pass" && parsed.readiness.status !== "fail")
  ) {
    return undefined;
  }

  const latest = isObject(parsed.latest) ? parsed.latest : null;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isObject) : [];
  const issueCodes = issues
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string");
  const stepOrder = latest ? asStringArray(latest.stepOrder) : null;

  return {
    readinessStatus: parsed.readiness.status,
    ...(latest && typeof latest.path === "string" ? { latestArtifactPath: latest.path } : {}),
    ...(latest && typeof latest.createdAt === "string"
      ? { latestArtifactCreatedAt: latest.createdAt }
      : {}),
    ...(latest && (latest.status === "pass" || latest.status === "fail")
      ? { latestArtifactStatus: latest.status }
      : {}),
    ...(latest && typeof latest.mode === "string" ? { mode: latest.mode } : {}),
    ...(latest && typeof latest.writesFiles === "boolean"
      ? { writesFiles: latest.writesFiles }
      : {}),
    ...(latest && typeof latest.writesGlobalConfig === "boolean"
      ? { writesGlobalConfig: latest.writesGlobalConfig }
      : {}),
    ...(latest && typeof latest.providerCredentialsRequired === "boolean"
      ? { providerCredentialsRequired: latest.providerCredentialsRequired }
      : {}),
    ...(latest && typeof latest.requiresReleaseArtifactRefresh === "boolean"
      ? { requiresReleaseArtifactRefresh: latest.requiresReleaseArtifactRefresh }
      : {}),
    ...(latest && typeof latest.requiresLoopFreshnessRefresh === "boolean"
      ? { requiresLoopFreshnessRefresh: latest.requiresLoopFreshnessRefresh }
      : {}),
    ...(latest && typeof latest.requiresLoopRefreshPlanReportRefresh === "boolean"
      ? { requiresLoopRefreshPlanReportRefresh: latest.requiresLoopRefreshPlanReportRefresh }
      : {}),
    ...(latest && typeof latest.releaseFreshnessRefreshPlanReportArtifactOutput === "string"
      ? {
          releaseFreshnessRefreshPlanReportArtifactOutput:
            latest.releaseFreshnessRefreshPlanReportArtifactOutput,
        }
      : {}),
    ...(latest && typeof latest.loopPacketRefreshPlanReportArtifactOutput === "string"
      ? {
          loopPacketRefreshPlanReportArtifactOutput:
            latest.loopPacketRefreshPlanReportArtifactOutput,
        }
      : {}),
    ...(stepOrder ? { stepOrder } : {}),
    issueCodes,
  };
}

function readLoopPacketRefreshPlanReportIndexObservedEvidence(
  stdout: string | undefined,
): MossLoopPacketRefreshPlanReportIndexObservedEvidence | undefined {
  if (!stdout) {
    return undefined;
  }

  const parsed = parseFirstJsonObject(stdout);
  if (!isObject(parsed) || !isObject(parsed.readiness)) {
    return undefined;
  }

  if (
    typeof parsed.readiness.status !== "string" ||
    (parsed.readiness.status !== "pass" && parsed.readiness.status !== "fail")
  ) {
    return undefined;
  }

  const latest = isObject(parsed.latest) ? parsed.latest : null;
  const refreshPlan = latest && isObject(latest.refreshPlan) ? latest.refreshPlan : null;
  const chainedRefreshProvenance = latest
    ? parseMossChainedRefreshProvenance({
        value: latest,
        fallbackTaskId: typeof latest.taskId === "string" ? latest.taskId : undefined,
        fallbackSource: "loop-packet-task-metadata",
      })
    : undefined;
  const issues = Array.isArray(parsed.issues) ? parsed.issues.filter(isObject) : [];
  const issueCodes = issues
    .map((issue) => issue.code)
    .filter((code): code is string => typeof code === "string");
  const refreshPlanIssueCodes = refreshPlan ? asStringArray(refreshPlan.issueCodes) : null;

  return {
    readinessStatus: parsed.readiness.status,
    ...(latest && typeof latest.path === "string" ? { latestArtifactPath: latest.path } : {}),
    ...(latest && typeof latest.createdAt === "string"
      ? { latestArtifactCreatedAt: latest.createdAt }
      : {}),
    ...(latest && (latest.status === "pass" || latest.status === "fail")
      ? { latestArtifactStatus: latest.status }
      : {}),
    ...(latest && typeof latest.taskId === "string" ? { latestTaskId: latest.taskId } : {}),
    ...(chainedRefreshProvenance
      ? {
          latestChainedRefreshTaskId: chainedRefreshProvenance.taskId,
          latestChainedRefreshProvenance: chainedRefreshProvenance,
        }
      : {}),
    ...(latest &&
    (latest.checkStatus === "pass" ||
      latest.checkStatus === "pending" ||
      latest.checkStatus === "fail")
      ? { latestCheckStatus: latest.checkStatus }
      : {}),
    ...(latest &&
    (latest.loopPacketReadinessStatus === "ready" ||
      latest.loopPacketReadinessStatus === "pending" ||
      latest.loopPacketReadinessStatus === "blocked")
      ? { latestLoopPacketReadinessStatus: latest.loopPacketReadinessStatus }
      : {}),
    ...(latest && typeof latest.writesFiles === "boolean"
      ? { writesFiles: latest.writesFiles }
      : {}),
    ...(latest && typeof latest.writesGlobalConfig === "boolean"
      ? { writesGlobalConfig: latest.writesGlobalConfig }
      : {}),
    ...(latest && typeof latest.providerCredentialsRequired === "boolean"
      ? { providerCredentialsRequired: latest.providerCredentialsRequired }
      : {}),
    ...(refreshPlan &&
    (refreshPlan.status === "pass" ||
      refreshPlan.status === "pending" ||
      refreshPlan.status === "blocked")
      ? { refreshPlanStatus: refreshPlan.status }
      : {}),
    ...(refreshPlan &&
    (refreshPlan.readinessStatus === "pass" || refreshPlan.readinessStatus === "fail")
      ? { refreshPlanReadinessStatus: refreshPlan.readinessStatus }
      : {}),
    ...(refreshPlan && typeof refreshPlan.refreshPlanArtifactPath === "string"
      ? { refreshPlanArtifactPath: refreshPlan.refreshPlanArtifactPath }
      : {}),
    ...(refreshPlan && typeof refreshPlan.expectedStepCount === "number"
      ? { refreshPlanExpectedStepCount: refreshPlan.expectedStepCount }
      : {}),
    ...(refreshPlan && typeof refreshPlan.latestStepCount === "number"
      ? { refreshPlanLatestStepCount: refreshPlan.latestStepCount }
      : {}),
    ...(refreshPlan &&
    (refreshPlan.latestArtifactStatus === "pass" || refreshPlan.latestArtifactStatus === "fail")
      ? { refreshPlanLatestArtifactStatus: refreshPlan.latestArtifactStatus }
      : {}),
    ...(refreshPlan && typeof refreshPlan.mode === "string"
      ? { refreshPlanMode: refreshPlan.mode }
      : {}),
    ...(refreshPlan && typeof refreshPlan.writesFiles === "boolean"
      ? { refreshPlanWritesFiles: refreshPlan.writesFiles }
      : {}),
    ...(refreshPlan && typeof refreshPlan.writesGlobalConfig === "boolean"
      ? { refreshPlanWritesGlobalConfig: refreshPlan.writesGlobalConfig }
      : {}),
    ...(refreshPlan && typeof refreshPlan.providerCredentialsRequired === "boolean"
      ? { refreshPlanProviderCredentialsRequired: refreshPlan.providerCredentialsRequired }
      : {}),
    ...(refreshPlan && typeof refreshPlan.requiresReleaseArtifactRefresh === "boolean"
      ? { refreshPlanRequiresReleaseArtifactRefresh: refreshPlan.requiresReleaseArtifactRefresh }
      : {}),
    ...(refreshPlan && typeof refreshPlan.requiresLoopFreshnessRefresh === "boolean"
      ? { refreshPlanRequiresLoopFreshnessRefresh: refreshPlan.requiresLoopFreshnessRefresh }
      : {}),
    ...(refreshPlanIssueCodes ? { refreshPlanIssueCodes } : {}),
    issueCodes,
  };
}

function readReleaseGateReportEntryObservedEvidence(input: {
  readonly gateId: MossReleaseGateId;
  readonly result: MossReleaseGateSpawnResult;
}): MossReleaseGateReportEntryObservedEvidence | undefined {
  if (input.gateId === "provider-discovery-smoke") {
    const providerDiscoverySmoke = readProviderDiscoverySmokeObservedEvidence(input.result.stdout);
    return providerDiscoverySmoke ? { providerDiscoverySmoke } : undefined;
  }

  if (input.gateId === "electron-product-shell-smoke") {
    const electronProductShellSmoke = readElectronProductShellSmokeObservedEvidence(
      input.result.stdout,
    );
    return electronProductShellSmoke ? { electronProductShellSmoke } : undefined;
  }

  if (input.gateId === "codex-desktop-layout-gate") {
    const codexDesktopLayoutGate = readCodexDesktopLayoutGateObservedEvidence(input.result.stdout);
    return codexDesktopLayoutGate ? { codexDesktopLayoutGate } : undefined;
  }

  if (input.gateId === "release-freshness-refresh-plan-report-index") {
    const releaseFreshnessRefreshPlanReportIndex =
      readReleaseFreshnessRefreshPlanReportIndexObservedEvidence(input.result.stdout);
    return releaseFreshnessRefreshPlanReportIndex
      ? { releaseFreshnessRefreshPlanReportIndex }
      : undefined;
  }

  if (input.gateId === "loop-packet-freshness-report-index") {
    const loopPacketFreshnessReportIndex = readLoopPacketFreshnessReportIndexObservedEvidence(
      input.result.stdout,
    );
    return loopPacketFreshnessReportIndex ? { loopPacketFreshnessReportIndex } : undefined;
  }

  if (input.gateId === "loop-packet-refresh-plan-report-index") {
    const loopPacketRefreshPlanReportIndex = readLoopPacketRefreshPlanReportIndexObservedEvidence(
      input.result.stdout,
    );
    return loopPacketRefreshPlanReportIndex ? { loopPacketRefreshPlanReportIndex } : undefined;
  }

  if (input.gateId === "release-gate-report-index") {
    const releaseGateReportIndex = readReleaseGateReportIndexObservedEvidence(input.result.stdout);
    return releaseGateReportIndex ? { releaseGateReportIndex } : undefined;
  }

  return undefined;
}

function onlyStaleReleaseFreshnessIssueCodes(issueCodes: ReadonlyArray<string>): boolean {
  return issueCodes.length > 0 && issueCodes.every((code) => code === "stale-release-freshness");
}

function isExplicitChainedLoopFreshnessBootstrapEvidence(
  evidence: MossLoopPacketFreshnessReportIndexObservedEvidence,
): boolean {
  const releaseFreshnessIssueCodes = evidence.releaseFreshnessIssueCodes ?? [];

  return (
    evidence.readinessStatus === "fail" &&
    evidence.issueCodes.length === 1 &&
    evidence.issueCodes[0] === "failing-artifact" &&
    evidence.latestArtifactStatus === "fail" &&
    evidence.latestCheckStatus === "fail" &&
    evidence.latestLoopPacketReadinessStatus === "blocked" &&
    evidence.releaseFreshnessStatus === "blocked" &&
    evidence.releaseFreshnessReadinessStatus === "fail" &&
    Boolean(evidence.latestTaskId) &&
    Boolean(evidence.latestChainedRefreshProvenance) &&
    evidence.latestChainedRefreshTaskId === evidence.latestTaskId &&
    releaseFreshnessIssueCodes.length > 0 &&
    releaseFreshnessIssueCodes.every(
      (code) => code === "stale-artifact" || code === "failing-artifact",
    )
  );
}

function onlyRefreshableReleaseArtifactIssueCodes(issueCodes: ReadonlyArray<string>): boolean {
  return (
    issueCodes.includes("stale-artifact") &&
    issueCodes.every((code) => code === "stale-artifact" || code === "failing-artifact")
  );
}

function readLoopPacketRefreshEvidence(input: {
  readonly stdout: string | undefined;
  readonly originalExitCode: number;
}): MossReleaseGateReportEntryRefreshEvidence | undefined {
  const parsed = parseFirstJsonObject(input.stdout ?? "");
  if (!isObject(parsed) || !isObject(parsed.readiness) || !isObject(parsed.packets)) {
    return undefined;
  }

  const dashboard = isObject(parsed.packets.loopLedgerDashboard)
    ? parsed.packets.loopLedgerDashboard
    : null;
  const releaseGate = dashboard && isObject(dashboard.releaseGate) ? dashboard.releaseGate : null;
  const freshness = releaseGate && isObject(releaseGate.freshness) ? releaseGate.freshness : null;
  const issueCodes = freshness ? asStringArray(freshness.issueCodes) : null;
  if (
    parsed.readiness.status !== "blocked" ||
    !freshness ||
    freshness.readinessStatus !== "fail" ||
    !issueCodes ||
    !onlyRefreshableReleaseArtifactIssueCodes(issueCodes)
  ) {
    return undefined;
  }

  const checks = Array.isArray(parsed.checks) ? parsed.checks.filter(isObject) : [];
  const releaseFreshnessCheck = checks.find(
    (check) => check.id === "loop-ledger-release-freshness",
  );
  if (!releaseFreshnessCheck || releaseFreshnessCheck.status !== "fail") {
    return undefined;
  }

  const summary =
    typeof releaseFreshnessCheck.summary === "string"
      ? releaseFreshnessCheck.summary
      : "Loop packet release freshness is stale against the current release report artifact manifest.";

  return {
    mode: "release-report-artifact-refresh",
    reason: "stale-release-report-artifact",
    originalExitCode: input.originalExitCode,
    issueCodes,
    summary,
  };
}

function readReleaseGateReportIndexRefreshEvidence(input: {
  readonly observedEvidence: MossReleaseGateReportEntryObservedEvidence | undefined;
  readonly originalExitCode: number;
}): MossReleaseGateReportEntryRefreshEvidence | undefined {
  const evidence = input.observedEvidence?.releaseGateReportIndex;
  if (
    !evidence ||
    evidence.readinessStatus !== "fail" ||
    !onlyRefreshableReleaseArtifactIssueCodes(evidence.issueCodes)
  ) {
    return undefined;
  }

  return {
    mode: "release-report-artifact-refresh",
    reason: "stale-release-report-artifact",
    originalExitCode: input.originalExitCode,
    issueCodes: evidence.issueCodes,
    summary:
      evidence.staleArtifactMessages[0] ??
      "Release gate report artifact index is stale against the current manifest.",
  };
}

function readLoopPacketFreshnessReportIndexRefreshEvidence(input: {
  readonly observedEvidence: MossReleaseGateReportEntryObservedEvidence | undefined;
  readonly originalExitCode: number;
}): MossReleaseGateReportEntryRefreshEvidence | undefined {
  const evidence = input.observedEvidence?.loopPacketFreshnessReportIndex;
  if (
    !evidence ||
    evidence.readinessStatus !== "fail" ||
    (!onlyStaleReleaseFreshnessIssueCodes(evidence.issueCodes) &&
      !isExplicitChainedLoopFreshnessBootstrapEvidence(evidence))
  ) {
    return undefined;
  }

  return {
    mode: "release-report-artifact-refresh",
    reason: "stale-release-report-artifact",
    originalExitCode: input.originalExitCode,
    issueCodes: evidence.issueCodes,
    summary: isExplicitChainedLoopFreshnessBootstrapEvidence(evidence)
      ? "Loop packet freshness report index is an explicit chained refresh bootstrap against the current release gate artifact."
      : "Loop packet freshness report index is stale against the current release gate artifact.",
  };
}

function readReleaseGateRefreshEvidence(input: {
  readonly gateId: MossReleaseGateId;
  readonly result: MossReleaseGateSpawnResult;
  readonly exitCode: number;
  readonly observedEvidence: MossReleaseGateReportEntryObservedEvidence | undefined;
}): MossReleaseGateReportEntryRefreshEvidence | undefined {
  if (input.exitCode === 0) {
    return undefined;
  }

  if (input.gateId === "loop-packet") {
    return readLoopPacketRefreshEvidence({
      stdout: input.result.stdout,
      originalExitCode: input.exitCode,
    });
  }

  if (input.gateId === "loop-packet-freshness-report-index") {
    return readLoopPacketFreshnessReportIndexRefreshEvidence({
      observedEvidence: input.observedEvidence,
      originalExitCode: input.exitCode,
    });
  }

  if (input.gateId === "release-gate-report-index") {
    return readReleaseGateReportIndexRefreshEvidence({
      observedEvidence: input.observedEvidence,
      originalExitCode: input.exitCode,
    });
  }

  return undefined;
}

export function runMossReleaseGateReport(
  manifest: MossReleaseGateManifest = buildMossReleaseGateManifest(),
  spawn: MossReleaseGateSpawn = spawnMossReleaseGateCommand,
  clock: MossReleaseGateClock = Date.now,
): MossReleaseGateReport {
  const entries: MossReleaseGateReportEntry[] = [];
  let failedGateId: MossReleaseGateId | undefined;

  for (const entry of manifest.gates) {
    const startedAt = clock();
    const result = spawn(entry.command, entry.args, { stdio: "pipe" });
    const durationMs = Math.max(0, clock() - startedAt);
    const exitCode = result.error ? 1 : (result.status ?? 1);
    const status = exitCode === 0 ? "pass" : "fail";
    const observedEvidence = readReleaseGateReportEntryObservedEvidence({
      gateId: entry.id,
      result,
    });

    entries.push({
      id: entry.id,
      status,
      exitCode,
      command: entry.command,
      args: entry.args,
      expectedEvidence: entry.expectedEvidence,
      durationMs,
      providerCredentialsRequired: entry.providerCredentialsRequired,
      writesGlobalConfig: entry.writesGlobalConfig,
      ...(observedEvidence ? { observedEvidence } : {}),
      ...(result.error ? { errorMessage: result.error.message } : {}),
    });

    if (status === "fail") {
      failedGateId = entry.id;
      break;
    }
  }

  return {
    version: 1,
    createdAt: manifest.createdAt,
    status: failedGateId ? "fail" : "pass",
    ...(failedGateId ? { failedGateId } : {}),
    gates: entries,
  };
}

export function runMossReleaseGateRefreshReport(
  manifest: MossReleaseGateManifest = buildMossReleaseGateManifest(),
  spawn: MossReleaseGateSpawn = spawnMossReleaseGateCommand,
  clock: MossReleaseGateClock = Date.now,
): MossReleaseGateReport {
  const entries: MossReleaseGateReportEntry[] = [];
  const refreshedGateIds: MossReleaseGateId[] = [];
  let failedGateId: MossReleaseGateId | undefined;

  for (const entry of manifest.gates) {
    const startedAt = clock();
    const result = spawn(entry.command, entry.args, { stdio: "pipe" });
    const durationMs = Math.max(0, clock() - startedAt);
    const originalExitCode = result.error ? 1 : (result.status ?? 1);
    const observedEvidence = readReleaseGateReportEntryObservedEvidence({
      gateId: entry.id,
      result,
    });
    const refreshEvidence = readReleaseGateRefreshEvidence({
      gateId: entry.id,
      result,
      exitCode: originalExitCode,
      observedEvidence,
    });
    const status = originalExitCode === 0 || refreshEvidence ? "pass" : "fail";

    if (refreshEvidence) {
      refreshedGateIds.push(entry.id);
    }
    const storedObservedEvidence =
      refreshEvidence && entry.id === "release-gate-report-index" ? undefined : observedEvidence;

    entries.push({
      id: entry.id,
      status,
      exitCode: status === "pass" ? 0 : originalExitCode,
      command: entry.command,
      args: entry.args,
      expectedEvidence: entry.expectedEvidence,
      durationMs,
      providerCredentialsRequired: entry.providerCredentialsRequired,
      writesGlobalConfig: entry.writesGlobalConfig,
      ...(storedObservedEvidence ? { observedEvidence: storedObservedEvidence } : {}),
      ...(refreshEvidence ? { refreshEvidence } : {}),
      ...(result.error ? { errorMessage: result.error.message } : {}),
    });

    if (status === "fail") {
      failedGateId = entry.id;
      break;
    }
  }

  return {
    version: 1,
    createdAt: manifest.createdAt,
    status: failedGateId ? "fail" : "pass",
    ...(failedGateId ? { failedGateId } : {}),
    ...(refreshedGateIds.length > 0
      ? {
          refresh: {
            mode: "release-report-artifact-refresh",
            reason: "manifest-change",
            refreshedGateIds,
          },
        }
      : {}),
    gates: entries,
  };
}

export function mossReleaseGateReportExitCode(report: MossReleaseGateReport): number {
  if (report.status === "pass") {
    return 0;
  }
  return report.gates.find((entry) => entry.status === "fail")?.exitCode || 1;
}

export function resolveMossReleaseGateReportOutputPath(
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

export function writeMossReleaseGateReportArtifact(
  report: MossReleaseGateReport,
  outputPath: string,
  cwd = process.cwd(),
): MossReleaseGateReportArtifactResult {
  const artifactPath = resolveMossReleaseGateReportOutputPath(outputPath, cwd);

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
  formatMossReleaseGateReportArtifact(artifactPath);

  return {
    path: artifactPath,
    bytes: Buffer.byteLength(readFileSync(artifactPath, "utf8"), "utf8"),
  };
}

function formatMossReleaseGateReportArtifact(artifactPath: string): void {
  const result = spawnSync("bun", ["oxfmt", `--stdin-filepath=${artifactPath}`], {
    encoding: "utf8",
    input: readFileSync(artifactPath, "utf8"),
    stdio: "pipe",
  });
  if (result.error) {
    throw new Error(`failed to format release gate report artifact: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 1}`;
    throw new Error(`failed to format release gate report artifact: ${detail}`);
  }
  writeFileSync(artifactPath, result.stdout, { encoding: "utf8" });
}

function spawnMossReleaseGateCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: MossReleaseGateSpawnOptions,
): MossReleaseGateSpawnResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: options.stdio,
  });
  return {
    status: result.status,
    error: result.error,
    ...(typeof result.stdout === "string" ? { stdout: result.stdout } : {}),
    ...(typeof result.stderr === "string" ? { stderr: result.stderr } : {}),
  };
}

function parseCliOptions(argv: ReadonlyArray<string>): {
  readonly options: MossReleaseGateOptions;
  readonly printManifest: boolean;
  readonly report: boolean;
  readonly refreshArtifact: boolean;
  readonly outputPath?: string | undefined;
} {
  const options: {
    createdAt?: string;
  } = {};
  let printManifest = false;
  let report = false;
  let refreshArtifact = false;
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
    if (arg === "--print-manifest" || arg === "--print-plan") {
      printManifest = true;
      continue;
    }
    if (arg === "--report") {
      report = true;
      continue;
    }
    if (arg === "--refresh-artifact" || arg === "--refresh-report-artifact") {
      refreshArtifact = true;
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
    if (arg === "--run") {
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return {
    options,
    printManifest,
    report,
    refreshArtifact,
    outputPath,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const { options, printManifest, report, refreshArtifact, outputPath } = parseCliOptions(argv);
  const manifest = buildMossReleaseGateManifest(options);
  if (outputPath && !report) {
    throw new Error("--output requires --report");
  }
  if (refreshArtifact && (!report || !outputPath)) {
    throw new Error("--refresh-artifact requires --report and --output");
  }
  if (printManifest) {
    console.log(JSON.stringify(manifest, null, 2));
    return 0;
  }
  if (report) {
    const releaseGateReport = refreshArtifact
      ? runMossReleaseGateRefreshReport(manifest)
      : runMossReleaseGateReport(manifest);
    if (outputPath) {
      writeMossReleaseGateReportArtifact(releaseGateReport, outputPath);
    }
    console.log(JSON.stringify(releaseGateReport, null, 2));
    return mossReleaseGateReportExitCode(releaseGateReport);
  }
  return runMossReleaseGateCommands(manifest);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
