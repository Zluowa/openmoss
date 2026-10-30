import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER,
  type MossReleaseFreshnessRefreshPlanStepId,
} from "./lib/moss-release-freshness-refresh-plan-constants.ts";
import { readMossLoopPacketRefreshPlanGateReportIndex } from "./lib/moss-loop-packet-refresh-plan-gate-report-index.ts";
import { readMossLoopPacketFreshnessGateReportIndex } from "./moss-loop-packet-freshness-report-index.ts";
import { readMossReleaseGateReportArtifactIndex } from "./moss-release-gate-report-index.ts";

export { MOSS_RELEASE_FRESHNESS_REFRESH_PLAN_STEP_ORDER };
export type { MossReleaseFreshnessRefreshPlanStepId };

export interface MossReleaseFreshnessRefreshPlanStep {
  readonly id: MossReleaseFreshnessRefreshPlanStepId;
  readonly description: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shellCommand: string;
  readonly expectedExitCodes: ReadonlyArray<number>;
  readonly writesArtifacts: boolean;
  readonly artifactOutputs: ReadonlyArray<string>;
  readonly writesGlobalConfig: false;
}

export interface MossReleaseFreshnessRefreshPlan {
  readonly version: 1;
  readonly generatedAt: string;
  readonly mode: "dry-run";
  readonly writesFiles: false;
  readonly writesGlobalConfig: false;
  readonly artifactOutputs: {
    readonly releaseGateReport: string;
    readonly loopPacketFreshnessReport: string;
    readonly releaseFreshnessRefreshPlanReport: string;
    readonly loopPacketRefreshPlanReport: string;
  };
  readonly state: {
    readonly releaseGateReportIndex: {
      readonly readinessStatus: "pass" | "fail";
      readonly latestArtifactPath?: string | undefined;
      readonly manifestGateCount: number;
      readonly latestArtifactGateCount?: number | undefined;
      readonly issueCodes: ReadonlyArray<string>;
    };
    readonly loopPacketFreshnessReportIndex: {
      readonly readinessStatus: "pass" | "fail";
      readonly latestArtifactPath?: string | undefined;
      readonly releaseGateArtifactPath?: string | undefined;
      readonly releaseFreshnessReadinessStatus?: "pass" | "fail" | undefined;
      readonly manifestGateCount?: number | undefined;
      readonly latestArtifactGateCount?: number | undefined;
      readonly issueCodes: ReadonlyArray<string>;
      readonly releaseFreshnessIssueCodes: ReadonlyArray<string>;
    };
    readonly loopPacketRefreshPlanReportIndex: {
      readonly readinessStatus: "pass" | "fail";
      readonly latestArtifactPath?: string | undefined;
      readonly refreshPlanArtifactPath?: string | undefined;
      readonly refreshPlanReadinessStatus?: "pass" | "fail" | undefined;
      readonly expectedStepCount?: number | undefined;
      readonly latestStepCount?: number | undefined;
      readonly issueCodes: ReadonlyArray<string>;
      readonly refreshPlanIssueCodes: ReadonlyArray<string>;
    };
    readonly requiresReleaseArtifactRefresh: boolean;
    readonly requiresLoopFreshnessRefresh: boolean;
    readonly requiresLoopRefreshPlanReportRefresh: boolean;
  };
  readonly steps: ReadonlyArray<MossReleaseFreshnessRefreshPlanStep>;
  readonly readiness: {
    readonly status: "ready";
    readonly summary: string;
  };
}

export interface MossReleaseFreshnessRefreshPlanOptions {
  readonly createdAt?: string;
  readonly releaseArtifactOutput?: string;
  readonly loopFreshnessArtifactOutput?: string;
  readonly releaseRefreshPlanReportOutput?: string;
  readonly loopRefreshPlanReportOutput?: string;
}

export interface MossReleaseFreshnessRefreshPlanReportStep {
  readonly id: MossReleaseFreshnessRefreshPlanStepId;
  readonly shellCommand: string;
  readonly expectedExitCodes: ReadonlyArray<number>;
  readonly writesArtifacts: boolean;
  readonly artifactOutputs: ReadonlyArray<string>;
  readonly writesGlobalConfig: false;
}

export interface MossReleaseFreshnessRefreshPlanReport {
  readonly version: 1;
  readonly createdAt: string;
  readonly status: "pass" | "fail";
  readonly plan: {
    readonly generatedAt: string;
    readonly mode: "dry-run";
    readonly writesFiles: false;
    readonly writesGlobalConfig: false;
    readonly artifactOutputs: MossReleaseFreshnessRefreshPlan["artifactOutputs"];
    readonly state: MossReleaseFreshnessRefreshPlan["state"];
    readonly stepOrder: ReadonlyArray<MossReleaseFreshnessRefreshPlanStepId>;
    readonly steps: ReadonlyArray<MossReleaseFreshnessRefreshPlanReportStep>;
    readonly readiness: MossReleaseFreshnessRefreshPlan["readiness"];
  };
  readonly providerCredentialsRequired: false;
  readonly writesGlobalConfig: false;
}

export interface MossReleaseFreshnessRefreshPlanReportArtifactResult {
  readonly path: string;
  readonly bytes: number;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function shellCommand(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function step(input: {
  readonly id: MossReleaseFreshnessRefreshPlanStepId;
  readonly description: string;
  readonly command?: string | undefined;
  readonly args: ReadonlyArray<string>;
  readonly expectedExitCodes?: ReadonlyArray<number> | undefined;
  readonly artifactOutputs?: ReadonlyArray<string> | undefined;
}): MossReleaseFreshnessRefreshPlanStep {
  const command = input.command ?? "bun";
  const artifactOutputs = input.artifactOutputs ?? [];
  return {
    id: input.id,
    description: input.description,
    command,
    args: input.args,
    shellCommand: shellCommand(command, input.args),
    expectedExitCodes: input.expectedExitCodes ?? [0],
    writesArtifacts: artifactOutputs.length > 0,
    artifactOutputs,
    writesGlobalConfig: false,
  };
}

function issueCodes(issues: ReadonlyArray<{ readonly code: string }>): ReadonlyArray<string> {
  return issues.map((issue) => issue.code);
}

export function buildMossReleaseFreshnessRefreshPlan(
  repoRoot = process.cwd(),
  options: MossReleaseFreshnessRefreshPlanOptions = {},
): MossReleaseFreshnessRefreshPlan {
  const generatedAt = options.createdAt ?? new Date().toISOString();
  const artifactDate = generatedAt.slice(0, 10);
  const releaseArtifactOutput =
    options.releaseArtifactOutput ??
    `.moss/ledger/evidence/moss-release-gate-report-artifact-${artifactDate}-refresh.json`;
  const loopFreshnessArtifactOutput =
    options.loopFreshnessArtifactOutput ??
    `.moss/ledger/evidence/moss-loop-packet-freshness-gate-report-${artifactDate}-refresh.json`;
  const releaseRefreshPlanReportOutput =
    options.releaseRefreshPlanReportOutput ??
    `.moss/ledger/evidence/moss-release-freshness-refresh-plan-report-${artifactDate}-gate.json`;
  const loopRefreshPlanReportOutput =
    options.loopRefreshPlanReportOutput ??
    `.moss/ledger/evidence/moss-loop-packet-refresh-plan-gate-report-${artifactDate}.json`;

  const releaseGateReportIndex = readMossReleaseGateReportArtifactIndex(repoRoot, {
    generatedAt,
  });
  const loopPacketFreshnessReportIndex = readMossLoopPacketFreshnessGateReportIndex(repoRoot, {
    generatedAt,
  });
  const loopPacketRefreshPlanReportIndex = readMossLoopPacketRefreshPlanGateReportIndex(repoRoot, {
    generatedAt,
  });
  const latestLoopFreshness = loopPacketFreshnessReportIndex.latest;
  const loopReleaseFreshness = latestLoopFreshness?.releaseFreshness;
  const latestLoopRefreshPlanReport = loopPacketRefreshPlanReportIndex.latest;
  const loopRefreshPlan = latestLoopRefreshPlanReport?.refreshPlan;
  const releaseIndexIssueCodes = issueCodes(releaseGateReportIndex.issues);
  const loopIndexIssueCodes = issueCodes(loopPacketFreshnessReportIndex.issues);
  const releaseFreshnessIssueCodes = loopReleaseFreshness?.issueCodes ?? [];
  const loopRefreshPlanIndexIssueCodes = issueCodes(loopPacketRefreshPlanReportIndex.issues);
  const loopRefreshPlanIssueCodes = loopRefreshPlan?.issueCodes ?? [];
  const requiresReleaseArtifactRefresh = releaseGateReportIndex.readiness.status !== "pass";
  const requiresLoopFreshnessRefresh =
    requiresReleaseArtifactRefresh ||
    loopPacketFreshnessReportIndex.readiness.status !== "pass" ||
    loopReleaseFreshness?.releaseGateArtifactPath !== releaseGateReportIndex.latest?.path;
  const requiresLoopRefreshPlanReportRefresh =
    requiresReleaseArtifactRefresh ||
    requiresLoopFreshnessRefresh ||
    loopPacketRefreshPlanReportIndex.readiness.status !== "pass" ||
    loopRefreshPlan?.refreshPlanArtifactPath !== releaseRefreshPlanReportOutput;

  const steps = [
    step({
      id: "strict-release-report-stale-proof",
      description:
        "Run strict compact release report first; this may fail when existing artifacts are stale.",
      args: ["run", "moss:release-gate", "--", "--report", "--created-at", generatedAt],
      expectedExitCodes: [0, 1],
    }),
    step({
      id: "loop-packet-freshness-artifact-refresh",
      description:
        "Write the refreshed loop packet freshness artifact against the last valid release artifact before the new release artifact is written.",
      args: [
        "scripts/moss-loop-packet.ts",
        "--report",
        "--output",
        loopFreshnessArtifactOutput,
        "--created-at",
        generatedAt,
      ],
      command: "node",
      artifactOutputs: [loopFreshnessArtifactOutput],
    }),
    step({
      id: "loop-packet-freshness-report-index",
      description:
        "Verify the latest loop packet freshness artifact points at the latest release artifact.",
      args: ["run", "moss:loop-packet-freshness-report-index", "--", "--created-at", generatedAt],
    }),
    step({
      id: "release-freshness-refresh-plan-report-refresh",
      description:
        "Write the refreshed release freshness refresh-plan report artifact before loop refresh-plan evidence is regenerated.",
      args: [
        "run",
        "moss:release-freshness-refresh-plan",
        "--",
        "--report",
        "--output",
        releaseRefreshPlanReportOutput,
        "--created-at",
        generatedAt,
      ],
      artifactOutputs: [releaseRefreshPlanReportOutput],
    }),
    step({
      id: "release-freshness-refresh-plan-report-index",
      description: "Verify the latest release freshness refresh-plan report artifact.",
      args: [
        "run",
        "moss:release-freshness-refresh-plan-report-index",
        "--",
        "--created-at",
        generatedAt,
      ],
    }),
    step({
      id: "loop-packet-refresh-plan-report-refresh",
      description:
        "Write the refreshed loop packet refresh-plan gate report after the plan report artifact refresh.",
      args: [
        "run",
        "moss:loop-packet",
        "--",
        "--refresh-plan-report",
        "--output",
        loopRefreshPlanReportOutput,
        "--created-at",
        generatedAt,
      ],
      artifactOutputs: [loopRefreshPlanReportOutput],
    }),
    step({
      id: "loop-packet-refresh-plan-report-index",
      description:
        "Verify the latest loop packet refresh-plan gate report points at the latest plan report artifact.",
      args: [
        "run",
        "moss:loop-packet-refresh-plan-report-index",
        "--",
        "--created-at",
        generatedAt,
      ],
    }),
    step({
      id: "release-report-artifact-refresh",
      description:
        "Write the refreshed release gate report artifact after chained loop freshness and refresh-plan reports are current.",
      args: [
        "scripts/moss-release-gate.ts",
        "--report",
        "--refresh-artifact",
        "--output",
        releaseArtifactOutput,
        "--created-at",
        generatedAt,
      ],
      command: "node",
      artifactOutputs: [releaseArtifactOutput],
    }),
    step({
      id: "release-report-artifact-index",
      description:
        "Verify the latest release gate report artifact matches the current manifest and current chained evidence.",
      args: ["run", "moss:release-gate-report-index", "--", "--created-at", generatedAt],
    }),
    step({
      id: "compact-release-report",
      description: "Verify compact release report observed evidence after both refresh artifacts.",
      args: ["run", "moss:release-gate", "--", "--report", "--created-at", generatedAt],
    }),
    step({
      id: "final-release-gate",
      description: "Run the normal release gate after refreshed artifacts are indexed.",
      args: ["run", "moss:release-gate", "--", "--created-at", generatedAt],
    }),
  ];

  return {
    version: 1,
    generatedAt,
    mode: "dry-run",
    writesFiles: false,
    writesGlobalConfig: false,
    artifactOutputs: {
      releaseGateReport: releaseArtifactOutput,
      loopPacketFreshnessReport: loopFreshnessArtifactOutput,
      releaseFreshnessRefreshPlanReport: releaseRefreshPlanReportOutput,
      loopPacketRefreshPlanReport: loopRefreshPlanReportOutput,
    },
    state: {
      releaseGateReportIndex: {
        readinessStatus: releaseGateReportIndex.readiness.status,
        ...(releaseGateReportIndex.latest
          ? {
              latestArtifactPath: releaseGateReportIndex.latest.path,
              latestArtifactGateCount: releaseGateReportIndex.latest.gateCount,
            }
          : {}),
        manifestGateCount: releaseGateReportIndex.manifest.gateCount,
        issueCodes: releaseIndexIssueCodes,
      },
      loopPacketFreshnessReportIndex: {
        readinessStatus: loopPacketFreshnessReportIndex.readiness.status,
        ...(latestLoopFreshness
          ? {
              latestArtifactPath: latestLoopFreshness.path,
            }
          : {}),
        ...(loopReleaseFreshness
          ? {
              releaseGateArtifactPath: loopReleaseFreshness.releaseGateArtifactPath,
              releaseFreshnessReadinessStatus: loopReleaseFreshness.readinessStatus,
              manifestGateCount: loopReleaseFreshness.manifestGateCount,
              latestArtifactGateCount: loopReleaseFreshness.latestArtifactGateCount,
            }
          : {}),
        issueCodes: loopIndexIssueCodes,
        releaseFreshnessIssueCodes,
      },
      loopPacketRefreshPlanReportIndex: {
        readinessStatus: loopPacketRefreshPlanReportIndex.readiness.status,
        ...(latestLoopRefreshPlanReport
          ? {
              latestArtifactPath: latestLoopRefreshPlanReport.path,
            }
          : {}),
        ...(loopRefreshPlan
          ? {
              refreshPlanArtifactPath: loopRefreshPlan.refreshPlanArtifactPath,
              refreshPlanReadinessStatus: loopRefreshPlan.readinessStatus,
              expectedStepCount: loopRefreshPlan.expectedStepCount,
              latestStepCount: loopRefreshPlan.latestStepCount,
            }
          : {}),
        issueCodes: loopRefreshPlanIndexIssueCodes,
        refreshPlanIssueCodes: loopRefreshPlanIssueCodes,
      },
      requiresReleaseArtifactRefresh,
      requiresLoopFreshnessRefresh,
      requiresLoopRefreshPlanReportRefresh,
    },
    steps,
    readiness: {
      status: "ready",
      summary: `Dry-run release freshness refresh plan generated with ${steps.length} step(s).`,
    },
  };
}

export function buildMossReleaseFreshnessRefreshPlanReport(
  plan: MossReleaseFreshnessRefreshPlan,
): MossReleaseFreshnessRefreshPlanReport {
  return {
    version: 1,
    createdAt: plan.generatedAt,
    status: plan.readiness.status === "ready" ? "pass" : "fail",
    plan: {
      generatedAt: plan.generatedAt,
      mode: plan.mode,
      writesFiles: plan.writesFiles,
      writesGlobalConfig: plan.writesGlobalConfig,
      artifactOutputs: plan.artifactOutputs,
      state: plan.state,
      stepOrder: plan.steps.map((entry) => entry.id),
      steps: plan.steps.map((entry) => ({
        id: entry.id,
        shellCommand: entry.shellCommand,
        expectedExitCodes: entry.expectedExitCodes,
        writesArtifacts: entry.writesArtifacts,
        artifactOutputs: entry.artifactOutputs,
        writesGlobalConfig: entry.writesGlobalConfig,
      })),
      readiness: plan.readiness,
    },
    providerCredentialsRequired: false,
    writesGlobalConfig: false,
  };
}

export function mossReleaseFreshnessRefreshPlanReportExitCode(
  report: MossReleaseFreshnessRefreshPlanReport,
): number {
  return report.status === "pass" ? 0 : 1;
}

export function resolveMossReleaseFreshnessRefreshPlanReportOutputPath(
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

export function writeMossReleaseFreshnessRefreshPlanReportArtifact(
  report: MossReleaseFreshnessRefreshPlanReport,
  outputPath: string,
  cwd = process.cwd(),
): MossReleaseFreshnessRefreshPlanReportArtifactResult {
  const artifactPath = resolveMossReleaseFreshnessRefreshPlanReportOutputPath(outputPath, cwd);

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
  formatMossReleaseFreshnessRefreshPlanReportArtifact(artifactPath);

  return {
    path: artifactPath,
    bytes: Buffer.byteLength(readFileSync(artifactPath, "utf8"), "utf8"),
  };
}

function formatMossReleaseFreshnessRefreshPlanReportArtifact(artifactPath: string): void {
  const result = spawnSync("bun", ["oxfmt", `--stdin-filepath=${artifactPath}`], {
    encoding: "utf8",
    input: readFileSync(artifactPath, "utf8"),
    stdio: "pipe",
  });
  if (result.error) {
    throw new Error(
      `failed to format release freshness refresh plan report artifact: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 1}`;
    throw new Error(`failed to format release freshness refresh plan report artifact: ${detail}`);
  }
  writeFileSync(artifactPath, result.stdout, { encoding: "utf8" });
}

interface ParsedCliOptions {
  readonly options: MossReleaseFreshnessRefreshPlanOptions;
  readonly report: boolean;
  readonly outputPath?: string | undefined;
}

function parseCliOptions(argv: ReadonlyArray<string>): ParsedCliOptions {
  const options: {
    createdAt?: string;
    releaseArtifactOutput?: string;
    loopFreshnessArtifactOutput?: string;
    releaseRefreshPlanReportOutput?: string;
    loopRefreshPlanReportOutput?: string;
  } = {};
  let report = false;
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
    if (arg === "--release-output") {
      const releaseArtifactOutput = argv[index + 1];
      if (!releaseArtifactOutput) {
        throw new Error("--release-output requires a repo-local artifact path");
      }
      options.releaseArtifactOutput = releaseArtifactOutput;
      index += 1;
      continue;
    }
    if (arg === "--loop-output") {
      const loopFreshnessArtifactOutput = argv[index + 1];
      if (!loopFreshnessArtifactOutput) {
        throw new Error("--loop-output requires a repo-local artifact path");
      }
      options.loopFreshnessArtifactOutput = loopFreshnessArtifactOutput;
      index += 1;
      continue;
    }
    if (arg === "--plan-report-output") {
      const releaseRefreshPlanReportOutput = argv[index + 1];
      if (!releaseRefreshPlanReportOutput) {
        throw new Error("--plan-report-output requires a repo-local artifact path");
      }
      options.releaseRefreshPlanReportOutput = releaseRefreshPlanReportOutput;
      index += 1;
      continue;
    }
    if (arg === "--loop-refresh-plan-output") {
      const loopRefreshPlanReportOutput = argv[index + 1];
      if (!loopRefreshPlanReportOutput) {
        throw new Error("--loop-refresh-plan-output requires a repo-local artifact path");
      }
      options.loopRefreshPlanReportOutput = loopRefreshPlanReportOutput;
      index += 1;
      continue;
    }
    if (arg === "--dry-run") {
      continue;
    }
    if (arg === "--report") {
      report = true;
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
    throw new Error(`unknown option: ${arg}`);
  }

  return {
    options,
    report,
    ...(outputPath ? { outputPath } : {}),
  };
}

function main(argv: ReadonlyArray<string>): number {
  const cliOptions = parseCliOptions(argv);
  if (cliOptions.outputPath && !cliOptions.report) {
    throw new Error("--output requires --report");
  }

  const plan = buildMossReleaseFreshnessRefreshPlan(process.cwd(), cliOptions.options);
  if (cliOptions.report) {
    const report = buildMossReleaseFreshnessRefreshPlanReport(plan);
    if (cliOptions.outputPath) {
      writeMossReleaseFreshnessRefreshPlanReportArtifact(report, cliOptions.outputPath);
    }
    console.log(JSON.stringify(report, null, 2));
    return mossReleaseFreshnessRefreshPlanReportExitCode(report);
  }

  console.log(JSON.stringify(plan, null, 2));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
