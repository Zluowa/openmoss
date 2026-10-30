import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EVIDENCE_DIR = ".moss/ledger/evidence";
const EXPECTED_RUNTIME_BOUNDARY = "ProviderHealthLive";
const EXPECTED_REQUIRED_PROVIDER = "codex";

export type MossProductionProviderReadinessGateIssueCode =
  | "missing-report"
  | "malformed-report"
  | "stale-report-date"
  | "unexpected-runtime-boundary"
  | "not-production-provider-evidence"
  | "fixture-backed"
  | "missing-provider-credentials-marker"
  | "writes-global-config"
  | "missing-full-parity-guard"
  | "missing-provider-statuses"
  | "missing-required-provider"
  | "malformed-provider-status"
  | "invalid-acceptance-status"
  | "missing-blocker-evidence";

export interface MossProductionProviderReadinessGateIssue {
  readonly code: MossProductionProviderReadinessGateIssueCode;
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly message: string;
}

export interface MossProductionProviderReadinessGateOptions {
  readonly createdAt?: string | undefined;
  readonly reportPath?: string | undefined;
}

export interface MossProductionProviderReadinessGateProviderSummary {
  readonly provider: string;
  readonly status?: string | undefined;
  readonly available?: boolean | undefined;
  readonly authStatus?: string | undefined;
  readonly usable?: boolean | undefined;
  readonly checkedAt?: string | undefined;
  readonly blockingReason?: string | undefined;
}

export interface MossProductionProviderReadinessGateReportSummary {
  readonly createdAt?: string | undefined;
  readonly runtimeBoundary?: string | undefined;
  readonly productionProviderEvidence?: boolean | undefined;
  readonly fixtureBacked?: boolean | undefined;
  readonly providerCredentialsRequired?: boolean | undefined;
  readonly writesGlobalConfig?: boolean | undefined;
  readonly requiredProvider?: string | undefined;
  readonly acceptanceStatus?: "pass" | "blocked-with-evidence" | undefined;
  readonly requiredProviderUsable?: boolean | undefined;
  readonly acceptedProviders: ReadonlyArray<string>;
  readonly blockedProviders: ReadonlyArray<string>;
  readonly fullCodexParityClaim?: boolean | undefined;
}

export interface MossProductionProviderReadinessGateReport {
  readonly version: 1;
  readonly generatedAt: string;
  readonly reportPath: string;
  readonly report?: MossProductionProviderReadinessGateReportSummary | undefined;
  readonly providers: ReadonlyArray<MossProductionProviderReadinessGateProviderSummary>;
  readonly issues: ReadonlyArray<MossProductionProviderReadinessGateIssue>;
  readonly readiness: {
    readonly status: "pass" | "fail";
    readonly summary: string;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

function artifactDate(createdAt: string): string {
  return createdAt.slice(0, 10);
}

function defaultReportPath(createdAt: string): string {
  return `${DEFAULT_EVIDENCE_DIR}/moss-production-provider-readiness-${artifactDate(
    createdAt,
  )}.json`;
}

function resolveRepoPath(cwd: string, inputPath: string): string {
  return resolve(cwd, inputPath);
}

function toDisplayPath(cwd: string, inputPath: string): string {
  const resolvedPath = resolveRepoPath(cwd, inputPath);
  const relativePath = relative(cwd, resolvedPath);
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath || ".";
  }
  return inputPath;
}

function pushIssue(
  issues: MossProductionProviderReadinessGateIssue[],
  issue: MossProductionProviderReadinessGateIssue,
): void {
  issues.push(issue);
}

function readReadinessReport(input: {
  readonly cwd: string;
  readonly reportPath: string;
  readonly issues: MossProductionProviderReadinessGateIssue[];
}): Record<string, unknown> | null {
  const displayPath = toDisplayPath(input.cwd, input.reportPath);
  const absolutePath = resolveRepoPath(input.cwd, input.reportPath);
  if (!existsSync(absolutePath)) {
    pushIssue(input.issues, {
      code: "missing-report",
      severity: "error",
      path: displayPath,
      message: `Production provider readiness report is missing: ${displayPath}.`,
    });
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
    if (!isObject(parsed)) {
      throw new Error("report root is not an object");
    }
    return parsed;
  } catch (error) {
    pushIssue(input.issues, {
      code: "malformed-report",
      severity: "error",
      path: displayPath,
      message: `Production provider readiness report is malformed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    });
    return null;
  }
}

function summarizeProviders(
  report: Record<string, unknown>,
): ReadonlyArray<MossProductionProviderReadinessGateProviderSummary> {
  const providers = Array.isArray(report.providers) ? report.providers.filter(isObject) : [];
  return providers
    .map((provider) => {
      const id = typeof provider.provider === "string" ? provider.provider : undefined;
      if (!id) {
        return null;
      }
      return {
        provider: id,
        ...(typeof provider.status === "string" ? { status: provider.status } : {}),
        ...(typeof provider.available === "boolean" ? { available: provider.available } : {}),
        ...(typeof provider.authStatus === "string" ? { authStatus: provider.authStatus } : {}),
        ...(typeof provider.usable === "boolean" ? { usable: provider.usable } : {}),
        ...(typeof provider.checkedAt === "string" ? { checkedAt: provider.checkedAt } : {}),
        ...(typeof provider.blockingReason === "string"
          ? { blockingReason: provider.blockingReason }
          : {}),
      } satisfies MossProductionProviderReadinessGateProviderSummary;
    })
    .filter((provider) => provider !== null);
}

function summarizeReport(
  report: Record<string, unknown>,
): MossProductionProviderReadinessGateReportSummary {
  const acceptance = isObject(report.acceptance) ? report.acceptance : {};
  return {
    ...(typeof report.createdAt === "string" ? { createdAt: report.createdAt } : {}),
    ...(typeof report.runtimeBoundary === "string"
      ? { runtimeBoundary: report.runtimeBoundary }
      : {}),
    ...(typeof report.productionProviderEvidence === "boolean"
      ? { productionProviderEvidence: report.productionProviderEvidence }
      : {}),
    ...(typeof report.fixtureBacked === "boolean" ? { fixtureBacked: report.fixtureBacked } : {}),
    ...(typeof report.providerCredentialsRequired === "boolean"
      ? { providerCredentialsRequired: report.providerCredentialsRequired }
      : {}),
    ...(typeof report.writesGlobalConfig === "boolean"
      ? { writesGlobalConfig: report.writesGlobalConfig }
      : {}),
    ...(typeof report.requiredProvider === "string"
      ? { requiredProvider: report.requiredProvider }
      : {}),
    ...(acceptance.status === "pass" || acceptance.status === "blocked-with-evidence"
      ? { acceptanceStatus: acceptance.status }
      : {}),
    ...(typeof acceptance.requiredProviderUsable === "boolean"
      ? { requiredProviderUsable: acceptance.requiredProviderUsable }
      : {}),
    acceptedProviders: stringArray(report.acceptedProviders),
    blockedProviders: stringArray(report.blockedProviders),
    ...(typeof report.fullCodexParityClaim === "boolean"
      ? { fullCodexParityClaim: report.fullCodexParityClaim }
      : {}),
  };
}

function validateProviderStatus(input: {
  readonly reportPath: string;
  readonly provider: MossProductionProviderReadinessGateProviderSummary;
  readonly issues: MossProductionProviderReadinessGateIssue[];
}): void {
  if (
    input.provider.status === undefined ||
    input.provider.available === undefined ||
    input.provider.authStatus === undefined ||
    input.provider.usable === undefined ||
    input.provider.checkedAt === undefined
  ) {
    pushIssue(input.issues, {
      code: "malformed-provider-status",
      severity: "error",
      path: input.reportPath,
      message: `Provider ${input.provider.provider} is missing status, availability, auth, usable, or checkedAt evidence.`,
    });
  }

  if (input.provider.usable === false && !input.provider.blockingReason) {
    pushIssue(input.issues, {
      code: "missing-blocker-evidence",
      severity: "error",
      path: input.reportPath,
      message: `Provider ${input.provider.provider} is blocked but has no blockingReason.`,
    });
  }
}

function validateReadinessReport(input: {
  readonly createdAt: string;
  readonly reportPath: string;
  readonly report: Record<string, unknown>;
  readonly providers: ReadonlyArray<MossProductionProviderReadinessGateProviderSummary>;
  readonly issues: MossProductionProviderReadinessGateIssue[];
}): void {
  const summary = summarizeReport(input.report);
  const providerById = new Map(input.providers.map((provider) => [provider.provider, provider]));

  if (!summary.createdAt || artifactDate(summary.createdAt) !== artifactDate(input.createdAt)) {
    pushIssue(input.issues, {
      code: "stale-report-date",
      severity: "error",
      path: input.reportPath,
      message: `Production provider readiness report must match ${artifactDate(input.createdAt)}.`,
    });
  }

  if (summary.runtimeBoundary !== EXPECTED_RUNTIME_BOUNDARY) {
    pushIssue(input.issues, {
      code: "unexpected-runtime-boundary",
      severity: "error",
      path: input.reportPath,
      message: `Production provider readiness must use ${EXPECTED_RUNTIME_BOUNDARY}.`,
    });
  }

  if (summary.productionProviderEvidence !== true) {
    pushIssue(input.issues, {
      code: "not-production-provider-evidence",
      severity: "error",
      path: input.reportPath,
      message: "Production provider readiness must mark productionProviderEvidence=true.",
    });
  }

  if (summary.fixtureBacked !== false) {
    pushIssue(input.issues, {
      code: "fixture-backed",
      severity: "error",
      path: input.reportPath,
      message: "Production provider readiness must not be fixture backed.",
    });
  }

  if (summary.providerCredentialsRequired !== true) {
    pushIssue(input.issues, {
      code: "missing-provider-credentials-marker",
      severity: "error",
      path: input.reportPath,
      message: "Production provider readiness must mark providerCredentialsRequired=true.",
    });
  }

  if (summary.writesGlobalConfig !== false) {
    pushIssue(input.issues, {
      code: "writes-global-config",
      severity: "error",
      path: input.reportPath,
      message: "Production provider readiness must not write global configuration.",
    });
  }

  if (summary.fullCodexParityClaim !== false) {
    pushIssue(input.issues, {
      code: "missing-full-parity-guard",
      severity: "error",
      path: input.reportPath,
      message: "Production provider readiness must keep fullCodexParityClaim=false.",
    });
  }

  if (input.providers.length === 0) {
    pushIssue(input.issues, {
      code: "missing-provider-statuses",
      severity: "error",
      path: input.reportPath,
      message: "Production provider readiness must include provider statuses.",
    });
  }

  if (
    summary.requiredProvider !== EXPECTED_REQUIRED_PROVIDER ||
    !providerById.has(EXPECTED_REQUIRED_PROVIDER)
  ) {
    pushIssue(input.issues, {
      code: "missing-required-provider",
      severity: "error",
      path: input.reportPath,
      message: `Production provider readiness must include ${EXPECTED_REQUIRED_PROVIDER}.`,
    });
  }

  if (summary.acceptanceStatus !== "pass" && summary.acceptanceStatus !== "blocked-with-evidence") {
    pushIssue(input.issues, {
      code: "invalid-acceptance-status",
      severity: "error",
      path: input.reportPath,
      message: "Production provider readiness acceptance must be pass or blocked-with-evidence.",
    });
  }

  for (const provider of input.providers) {
    validateProviderStatus({
      reportPath: input.reportPath,
      provider,
      issues: input.issues,
    });
  }

  if (
    summary.acceptanceStatus === "blocked-with-evidence" &&
    summary.blockedProviders.length === 0
  ) {
    pushIssue(input.issues, {
      code: "missing-blocker-evidence",
      severity: "error",
      path: input.reportPath,
      message: "Blocked production provider readiness must list blocked providers.",
    });
  }
}

export function readMossProductionProviderReadinessGate(
  cwd = process.cwd(),
  options: MossProductionProviderReadinessGateOptions = {},
): MossProductionProviderReadinessGateReport {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const reportPath = options.reportPath ?? defaultReportPath(createdAt);
  const issues: MossProductionProviderReadinessGateIssue[] = [];
  const report = readReadinessReport({ cwd, reportPath, issues });
  const providers = report ? summarizeProviders(report) : [];

  if (report) {
    validateReadinessReport({
      createdAt,
      reportPath,
      report,
      providers,
      issues,
    });
  }

  return {
    version: 1,
    generatedAt: createdAt,
    reportPath: toDisplayPath(cwd, reportPath),
    ...(report ? { report: summarizeReport(report) } : {}),
    providers,
    issues,
    readiness: {
      status: issues.length === 0 ? "pass" : "fail",
      summary:
        issues.length === 0
          ? "Production provider readiness evidence is current and complete."
          : `Production provider readiness evidence has ${issues.length} issue(s).`,
    },
  };
}

export function mossProductionProviderReadinessGateExitCode(
  report: MossProductionProviderReadinessGateReport,
): number {
  return report.readiness.status === "pass" ? 0 : 1;
}

function parseCliArgs(argv: ReadonlyArray<string>): MossProductionProviderReadinessGateOptions {
  let createdAt: string | undefined;
  let reportPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      createdAt = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--report") {
      reportPath = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return {
    ...(createdAt ? { createdAt } : {}),
    ...(reportPath ? { reportPath } : {}),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = readMossProductionProviderReadinessGate(
    process.cwd(),
    parseCliArgs(process.argv.slice(2)),
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = mossProductionProviderReadinessGateExitCode(report);
}
