import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { CodexReferenceOracleReport } from "@synara/contracts";
import {
  MOSS_CODEX_REFERENCE_REPORT_ENV,
  parseCodexReferenceOracleReportJson,
  summarizeCodexReferenceOracleReport,
  type CodexReferenceOracleSummary,
} from "@synara/shared/codexReferenceOracle";

export const DEFAULT_CODEX_REFERENCE_ORACLE_RELATIVE_PATH = ".moss/codex-reference/oracle.json";

export interface LoadCodexReferenceOracleOptions {
  readonly projectPath: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface CodexReferenceOracleLoadResult {
  readonly status: "missing" | "ready" | "blocked";
  readonly reportPath?: string;
  readonly report?: CodexReferenceOracleReport;
  readonly summary?: CodexReferenceOracleSummary;
  readonly warnings: ReadonlyArray<string>;
}

interface OracleSource {
  readonly kind: "file" | "inline-json";
  readonly label: string;
  readonly path?: string;
  readonly json?: string;
}

function resolveEnvReportSource(
  projectPath: string,
  env: NodeJS.ProcessEnv,
): OracleSource | undefined {
  const configured = env[MOSS_CODEX_REFERENCE_REPORT_ENV]?.trim();
  if (!configured) return undefined;

  if (configured.startsWith("{")) {
    return {
      kind: "inline-json",
      label: `${MOSS_CODEX_REFERENCE_REPORT_ENV}:inline-json`,
      json: configured,
    };
  }

  const reportPath = isAbsolute(configured) ? configured : join(projectPath, configured);
  return {
    kind: "file",
    label: `${MOSS_CODEX_REFERENCE_REPORT_ENV}:${reportPath}`,
    path: reportPath,
  };
}

function resolveDefaultReportSource(projectPath: string): OracleSource {
  const reportPath = join(projectPath, DEFAULT_CODEX_REFERENCE_ORACLE_RELATIVE_PATH);
  return {
    kind: "file",
    label: reportPath,
    path: reportPath,
  };
}

function parseReportFromSource(source: OracleSource): CodexReferenceOracleReport {
  if (source.kind === "inline-json") {
    return parseCodexReferenceOracleReportJson(source.json ?? "");
  }

  return parseCodexReferenceOracleReportJson(readFileSync(source.path ?? "", "utf8"));
}

export function loadCodexReferenceOracle(
  options: LoadCodexReferenceOracleOptions,
): CodexReferenceOracleLoadResult {
  const env = options.env ?? process.env;
  const source =
    resolveEnvReportSource(options.projectPath, env) ??
    resolveDefaultReportSource(options.projectPath);

  if (source.kind === "file" && (!source.path || !existsSync(source.path))) {
    return {
      status: "missing",
      ...(source.path ? { reportPath: source.path } : {}),
      warnings: [`codex_reference_oracle_missing: ${source.label}`],
    };
  }

  try {
    const report = parseReportFromSource(source);
    const summary = summarizeCodexReferenceOracleReport(report);
    return {
      status: summary.status,
      ...(source.path ? { reportPath: source.path } : {}),
      report,
      summary,
      warnings:
        summary.status === "ready"
          ? []
          : summary.blockingIssueCodes.map((code) => `codex_reference_oracle_blocked: ${code}`),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "blocked",
      ...(source.path ? { reportPath: source.path } : {}),
      warnings: [`codex_reference_oracle_invalid: ${message}`],
    };
  }
}
