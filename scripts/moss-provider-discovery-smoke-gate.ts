import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_EVIDENCE_DIR = ".moss/ledger/evidence";
const EXPECTED_PROVIDER = "codex";
const EXPECTED_RUNTIME_BOUNDARY = "ProviderDiscoveryServiceLive";

const REQUIRED_OPERATION_IDS = [
  "getComposerCapabilities",
  "listSkills",
  "listPlugins",
  "listModels",
] as const;

const REQUIRED_ADAPTER_INVOCATIONS = [
  "getByProvider:codex",
  "getComposerCapabilities",
  "listSkills:codex",
  "listPlugins:codex",
  "listModels:codex",
] as const;

const REQUIRED_SKILL_NAMES = ["moss-native-smoke-skill", "moss-portable-smoke-skill"] as const;
const REQUIRED_PLUGIN_NAMES = ["moss-provider-smoke-plugin"] as const;
const REQUIRED_MODEL_SLUGS = ["moss-smoke-model"] as const;

export type MossProviderDiscoverySmokeGateIssueCode =
  | "missing-report"
  | "malformed-report"
  | "stale-report-date"
  | "unexpected-provider"
  | "unexpected-runtime-boundary"
  | "requires-provider-credentials"
  | "writes-global-config"
  | "smoke-readiness-failed"
  | "missing-operation"
  | "operation-failed"
  | "missing-adapter-invocation"
  | "missing-capability"
  | "missing-skill"
  | "missing-plugin"
  | "missing-model";

export interface MossProviderDiscoverySmokeGateIssue {
  readonly code: MossProviderDiscoverySmokeGateIssueCode;
  readonly severity: "error";
  readonly path?: string | undefined;
  readonly message: string;
}

export interface MossProviderDiscoverySmokeGateOptions {
  readonly createdAt?: string | undefined;
  readonly reportPath?: string | undefined;
}

export interface MossProviderDiscoverySmokeGateOperationSummary {
  readonly id: string;
  readonly status?: string | undefined;
  readonly source?: string | undefined;
  readonly count?: number | undefined;
  readonly items?: ReadonlyArray<string> | undefined;
  readonly supportsSkillDiscovery?: boolean | undefined;
  readonly supportsPluginDiscovery?: boolean | undefined;
  readonly supportsRuntimeModelList?: boolean | undefined;
}

export interface MossProviderDiscoverySmokeGateReportSummary {
  readonly createdAt?: string | undefined;
  readonly provider?: string | undefined;
  readonly runtimeBoundary?: string | undefined;
  readonly providerCredentialsRequired?: boolean | undefined;
  readonly writesGlobalConfig?: boolean | undefined;
  readonly operationCount: number;
  readonly adapterInvocationCount: number;
  readonly readinessStatus?: "pass" | "fail" | undefined;
}

export interface MossProviderDiscoverySmokeGateReport {
  readonly version: 1;
  readonly generatedAt: string;
  readonly reportPath: string;
  readonly report?: MossProviderDiscoverySmokeGateReportSummary | undefined;
  readonly operations: ReadonlyArray<MossProviderDiscoverySmokeGateOperationSummary>;
  readonly requiredOperations: ReadonlyArray<string>;
  readonly requiredAdapterInvocations: ReadonlyArray<string>;
  readonly issues: ReadonlyArray<MossProviderDiscoverySmokeGateIssue>;
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
  return `${DEFAULT_EVIDENCE_DIR}/moss-provider-discovery-smoke-${artifactDate(createdAt)}.json`;
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
  issues: MossProviderDiscoverySmokeGateIssue[],
  issue: MossProviderDiscoverySmokeGateIssue,
): void {
  issues.push(issue);
}

function readSmokeReport(input: {
  readonly cwd: string;
  readonly reportPath: string;
  readonly issues: MossProviderDiscoverySmokeGateIssue[];
}): Record<string, unknown> | null {
  const displayPath = toDisplayPath(input.cwd, input.reportPath);
  const absolutePath = resolveRepoPath(input.cwd, input.reportPath);
  if (!existsSync(absolutePath)) {
    pushIssue(input.issues, {
      code: "missing-report",
      severity: "error",
      path: displayPath,
      message: `Provider discovery smoke report is missing: ${displayPath}.`,
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
      message: `Provider discovery smoke report is malformed: ${
        error instanceof Error ? error.message : String(error)
      }.`,
    });
    return null;
  }
}

function summarizeOperations(
  report: Record<string, unknown>,
): ReadonlyArray<MossProviderDiscoverySmokeGateOperationSummary> {
  const operations = Array.isArray(report.operations) ? report.operations.filter(isObject) : [];
  return operations
    .map((operation) => {
      const id = typeof operation.id === "string" ? operation.id : undefined;
      if (!id) {
        return null;
      }
      return {
        id,
        ...(typeof operation.status === "string" ? { status: operation.status } : {}),
        ...(typeof operation.source === "string" ? { source: operation.source } : {}),
        ...(typeof operation.count === "number" ? { count: operation.count } : {}),
        ...(Array.isArray(operation.items) ? { items: stringArray(operation.items) } : {}),
        ...(typeof operation.supportsSkillDiscovery === "boolean"
          ? { supportsSkillDiscovery: operation.supportsSkillDiscovery }
          : {}),
        ...(typeof operation.supportsPluginDiscovery === "boolean"
          ? { supportsPluginDiscovery: operation.supportsPluginDiscovery }
          : {}),
        ...(typeof operation.supportsRuntimeModelList === "boolean"
          ? { supportsRuntimeModelList: operation.supportsRuntimeModelList }
          : {}),
      } satisfies MossProviderDiscoverySmokeGateOperationSummary;
    })
    .filter((operation) => operation !== null);
}

function summarizeReport(
  report: Record<string, unknown>,
): MossProviderDiscoverySmokeGateReportSummary {
  const readiness = isObject(report.readiness) ? report.readiness : {};
  return {
    ...(typeof report.createdAt === "string" ? { createdAt: report.createdAt } : {}),
    ...(typeof report.provider === "string" ? { provider: report.provider } : {}),
    ...(typeof report.runtimeBoundary === "string"
      ? { runtimeBoundary: report.runtimeBoundary }
      : {}),
    ...(typeof report.providerCredentialsRequired === "boolean"
      ? { providerCredentialsRequired: report.providerCredentialsRequired }
      : {}),
    ...(typeof report.writesGlobalConfig === "boolean"
      ? { writesGlobalConfig: report.writesGlobalConfig }
      : {}),
    operationCount: Array.isArray(report.operations) ? report.operations.length : 0,
    adapterInvocationCount: Array.isArray(report.adapterInvocationOrder)
      ? report.adapterInvocationOrder.length
      : 0,
    ...(readiness.status === "pass" || readiness.status === "fail"
      ? { readinessStatus: readiness.status }
      : {}),
  };
}

function includesAll(actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean {
  const set = new Set(actual);
  return expected.every((entry) => set.has(entry));
}

function validateSmokeReport(input: {
  readonly createdAt: string;
  readonly reportPath: string;
  readonly report: Record<string, unknown>;
  readonly operations: ReadonlyArray<MossProviderDiscoverySmokeGateOperationSummary>;
  readonly issues: MossProviderDiscoverySmokeGateIssue[];
}): void {
  const displayPath = input.reportPath;
  const summary = summarizeReport(input.report);
  const readiness = isObject(input.report.readiness) ? input.report.readiness : {};
  const adapterInvocations = stringArray(input.report.adapterInvocationOrder);
  const operationsById = new Map(input.operations.map((operation) => [operation.id, operation]));

  if (!summary.createdAt || artifactDate(summary.createdAt) !== artifactDate(input.createdAt)) {
    pushIssue(input.issues, {
      code: "stale-report-date",
      severity: "error",
      path: displayPath,
      message: `Provider discovery smoke report must match ${artifactDate(input.createdAt)}.`,
    });
  }

  if (summary.provider !== EXPECTED_PROVIDER) {
    pushIssue(input.issues, {
      code: "unexpected-provider",
      severity: "error",
      path: displayPath,
      message: `Provider discovery smoke provider must be ${EXPECTED_PROVIDER}.`,
    });
  }

  if (summary.runtimeBoundary !== EXPECTED_RUNTIME_BOUNDARY) {
    pushIssue(input.issues, {
      code: "unexpected-runtime-boundary",
      severity: "error",
      path: displayPath,
      message: `Provider discovery smoke must use ${EXPECTED_RUNTIME_BOUNDARY}.`,
    });
  }

  if (summary.providerCredentialsRequired !== false) {
    pushIssue(input.issues, {
      code: "requires-provider-credentials",
      severity: "error",
      path: displayPath,
      message: "Provider discovery smoke must not require provider credentials.",
    });
  }

  if (summary.writesGlobalConfig !== false) {
    pushIssue(input.issues, {
      code: "writes-global-config",
      severity: "error",
      path: displayPath,
      message: "Provider discovery smoke must not write global configuration.",
    });
  }

  if (readiness.status !== "pass") {
    pushIssue(input.issues, {
      code: "smoke-readiness-failed",
      severity: "error",
      path: displayPath,
      message: "Provider discovery smoke readiness is not pass.",
    });
  }

  for (const id of REQUIRED_OPERATION_IDS) {
    const operation = operationsById.get(id);
    if (!operation) {
      pushIssue(input.issues, {
        code: "missing-operation",
        severity: "error",
        path: displayPath,
        message: `Provider discovery smoke is missing operation ${id}.`,
      });
      continue;
    }
    if (operation.status !== "pass") {
      pushIssue(input.issues, {
        code: "operation-failed",
        severity: "error",
        path: displayPath,
        message: `Provider discovery smoke operation ${id} is not pass.`,
      });
    }
  }

  for (const invocation of REQUIRED_ADAPTER_INVOCATIONS) {
    if (!adapterInvocations.includes(invocation)) {
      pushIssue(input.issues, {
        code: "missing-adapter-invocation",
        severity: "error",
        path: displayPath,
        message: `Provider discovery smoke did not record adapter invocation ${invocation}.`,
      });
    }
  }

  const capabilities = operationsById.get("getComposerCapabilities");
  if (
    capabilities?.supportsSkillDiscovery !== true ||
    capabilities.supportsPluginDiscovery !== true ||
    capabilities.supportsRuntimeModelList !== true
  ) {
    pushIssue(input.issues, {
      code: "missing-capability",
      severity: "error",
      path: displayPath,
      message: "Provider discovery smoke capabilities do not advertise skill/plugin/model support.",
    });
  }

  if (!includesAll(operationsById.get("listSkills")?.items ?? [], REQUIRED_SKILL_NAMES)) {
    pushIssue(input.issues, {
      code: "missing-skill",
      severity: "error",
      path: displayPath,
      message: `Provider discovery smoke must include skills: ${REQUIRED_SKILL_NAMES.join(", ")}.`,
    });
  }

  if (!includesAll(operationsById.get("listPlugins")?.items ?? [], REQUIRED_PLUGIN_NAMES)) {
    pushIssue(input.issues, {
      code: "missing-plugin",
      severity: "error",
      path: displayPath,
      message: `Provider discovery smoke must include plugins: ${REQUIRED_PLUGIN_NAMES.join(", ")}.`,
    });
  }

  if (!includesAll(operationsById.get("listModels")?.items ?? [], REQUIRED_MODEL_SLUGS)) {
    pushIssue(input.issues, {
      code: "missing-model",
      severity: "error",
      path: displayPath,
      message: `Provider discovery smoke must include models: ${REQUIRED_MODEL_SLUGS.join(", ")}.`,
    });
  }
}

export function readMossProviderDiscoverySmokeGate(
  cwd = process.cwd(),
  options: MossProviderDiscoverySmokeGateOptions = {},
): MossProviderDiscoverySmokeGateReport {
  const createdAt = options.createdAt ?? new Date().toISOString();
  const reportPath = options.reportPath ?? defaultReportPath(createdAt);
  const issues: MossProviderDiscoverySmokeGateIssue[] = [];
  const report = readSmokeReport({ cwd, reportPath, issues });
  const operations = report ? summarizeOperations(report) : [];

  if (report) {
    validateSmokeReport({ createdAt, reportPath, report, operations, issues });
  }

  return {
    version: 1,
    generatedAt: createdAt,
    reportPath: toDisplayPath(cwd, reportPath),
    ...(report ? { report: summarizeReport(report) } : {}),
    operations,
    requiredOperations: REQUIRED_OPERATION_IDS,
    requiredAdapterInvocations: REQUIRED_ADAPTER_INVOCATIONS,
    issues,
    readiness: {
      status: issues.length === 0 ? "pass" : "fail",
      summary:
        issues.length === 0
          ? "Provider discovery smoke evidence is current and complete."
          : `Provider discovery smoke evidence has ${issues.length} issue(s).`,
    },
  };
}

export function mossProviderDiscoverySmokeGateExitCode(
  report: MossProviderDiscoverySmokeGateReport,
): number {
  return report.readiness.status === "pass" ? 0 : 1;
}

function parseCliArgs(argv: ReadonlyArray<string>): MossProviderDiscoverySmokeGateOptions {
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
  const report = readMossProviderDiscoverySmokeGate(
    process.cwd(),
    parseCliArgs(process.argv.slice(2)),
  );
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = mossProviderDiscoverySmokeGateExitCode(report);
}
