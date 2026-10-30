import { describe, expect, it } from "vitest";

import {
  MOSS_CODEX_REFERENCE_REPORT_ENV,
  decodeCodexReferenceOracleReport,
  parseCodexReferenceOracleReportJson,
  summarizeCodexReferenceOracleReport,
} from "./codexReferenceOracle";

const REPORT = {
  version: 1,
  generatedAt: "2026-07-05T15:30:00.000Z",
  provider: "codex",
  boundary: "clean-room-oracle-only",
  source: {
    appVersion: "26.623.101652",
    appBuild: "4674",
    refVersion: "26.623.101652",
    refBuild: "4674",
    entry: "index-C2RqhVyz",
    appAsarSha256: "11a0d184c3e340cfb7088974cdfb2126ee328c8e00341ba884c978ed70aa06fc",
  },
  progress: {
    localChunks: 534,
    finalizedChunks: 0,
    promotedChunks: 99,
    totalSymbols: 376898,
    pendingSymbols: 376898,
    importMapNonDone: 437,
    publicResidueCount: 1251,
    typecheckStatus: "fail",
    typecheckDiagnostics: 64593,
  },
  capabilities: [
    "provider-session",
    "runtime-events",
    "mcp",
    "skills",
    "hooks",
    "config",
    "local-state",
  ],
  issues: [
    { code: "local-not-finalized", message: "534/534 local chunks are not finalized" },
    { code: "ledger-symbols-pending", message: "376898 symbols are pending" },
  ],
  gate: {
    status: "fail",
    summary: "Codex reference is not at 100%; 2 blocking gates remain.",
  },
} as const;

describe("codexReferenceOracle", () => {
  it("exposes the report env key used by the server", () => {
    expect(MOSS_CODEX_REFERENCE_REPORT_ENV).toBe("MOSS_CODEX_REFERENCE_REPORT");
  });

  it("decodes and summarizes a blocked oracle report", () => {
    const decoded = decodeCodexReferenceOracleReport(REPORT);
    const summary = summarizeCodexReferenceOracleReport(decoded);

    expect(summary.status).toBe("blocked");
    expect(summary.capabilityCount).toBe(7);
    expect(summary.blockingIssueCodes).toEqual(["local-not-finalized", "ledger-symbols-pending"]);
    expect(summary.progress.finalizedChunks).toBe(0);
    expect(summary.progress.typecheckStatus).toBe("fail");
  });

  it("parses JSON reports through the same clean-room schema", () => {
    const parsed = parseCodexReferenceOracleReportJson(JSON.stringify(REPORT));
    expect(parsed.source.refBuild).toBe("4674");
  });

  it("rejects reports with a non-clean boundary", () => {
    expect(() =>
      decodeCodexReferenceOracleReport({
        ...REPORT,
        boundary: "vendored-restored-source",
      }),
    ).toThrow();
  });
});
