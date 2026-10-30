import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { CodexReferenceOracleReport } from "./codexReference";

const decodeReport = Schema.decodeUnknownSync(CodexReferenceOracleReport);

const BASE_REPORT = {
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
  issues: [{ code: "ledger-symbols-pending", message: "376898 symbols are pending" }],
  gate: {
    status: "fail",
    summary: "Codex reference is not at 100%; 1 blocking gate remains.",
  },
} as const;

describe("CodexReferenceOracleReport", () => {
  it("decodes a clean-room Codex reference gate report", () => {
    const parsed = decodeReport(BASE_REPORT);
    expect(parsed.provider).toBe("codex");
    expect(parsed.boundary).toBe("clean-room-oracle-only");
    expect(parsed.source.appBuild).toBe("4674");
    expect(parsed.progress.pendingSymbols).toBe(376898);
    expect(parsed.progress.typecheckDiagnostics).toBe(64593);
    expect(parsed.issues[0]?.code).toBe("ledger-symbols-pending");
  });

  it("rejects reports that would blur the clean-room boundary", () => {
    expect(() =>
      decodeReport({
        ...BASE_REPORT,
        boundary: "decompiled-source-vendored",
      }),
    ).toThrow();
  });

  it("rejects empty source identifiers", () => {
    expect(() =>
      decodeReport({
        ...BASE_REPORT,
        source: {
          ...BASE_REPORT.source,
          entry: "   ",
        },
      }),
    ).toThrow();
  });
});
