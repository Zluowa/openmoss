import { Schema } from "effect";
import {
  CodexReferenceOracleReport as CodexReferenceOracleReportSchema,
  type CodexReferenceOracleReport,
} from "@synara/contracts";

export const MOSS_CODEX_REFERENCE_REPORT_ENV = "MOSS_CODEX_REFERENCE_REPORT";

const decodeCodexReferenceOracleReportSync = Schema.decodeUnknownSync(
  CodexReferenceOracleReportSchema,
);

export interface CodexReferenceOracleSummary {
  readonly status: "ready" | "blocked";
  readonly summary: string;
  readonly capabilityCount: number;
  readonly blockingIssueCodes: ReadonlyArray<string>;
  readonly progress: CodexReferenceOracleReport["progress"];
}

export function decodeCodexReferenceOracleReport(value: unknown): CodexReferenceOracleReport {
  return decodeCodexReferenceOracleReportSync(value);
}

export function parseCodexReferenceOracleReportJson(json: string): CodexReferenceOracleReport {
  return decodeCodexReferenceOracleReport(JSON.parse(json));
}

export function summarizeCodexReferenceOracleReport(
  report: CodexReferenceOracleReport,
): CodexReferenceOracleSummary {
  const blockingIssueCodes = report.issues.map((issue) => issue.code);
  return {
    status: report.gate.status === "pass" ? "ready" : "blocked",
    summary: report.gate.summary,
    capabilityCount: report.capabilities.length,
    blockingIssueCodes,
    progress: report.progress,
  };
}
