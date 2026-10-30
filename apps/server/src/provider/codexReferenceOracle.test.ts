import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CODEX_REFERENCE_ORACLE_RELATIVE_PATH,
  loadCodexReferenceOracle,
} from "./codexReferenceOracle";

const tempDirs: string[] = [];

function makeTempProject(): string {
  const tempDir = mkdtempSync(join(OS.tmpdir(), "moss-codex-reference-"));
  tempDirs.push(tempDir);
  return tempDir;
}

function writeReport(projectPath: string, report: unknown): string {
  const reportPath = join(projectPath, DEFAULT_CODEX_REFERENCE_ORACLE_RELATIVE_PATH);
  mkdirSync(join(projectPath, ".moss/codex-reference"), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report), "utf8");
  return reportPath;
}

const BLOCKED_REPORT = {
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

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("loadCodexReferenceOracle", () => {
  it("returns missing when the project oracle file is absent", () => {
    const projectPath = makeTempProject();
    const result = loadCodexReferenceOracle({ projectPath, env: {} });

    expect(result.status).toBe("missing");
    expect(result.reportPath).toBe(join(projectPath, DEFAULT_CODEX_REFERENCE_ORACLE_RELATIVE_PATH));
    expect(result.warnings[0]).toContain("codex_reference_oracle_missing");
  });

  it("loads and summarizes the default project oracle report", () => {
    const projectPath = makeTempProject();
    writeReport(projectPath, BLOCKED_REPORT);

    const result = loadCodexReferenceOracle({ projectPath, env: {} });

    expect(result.status).toBe("blocked");
    expect(result.summary?.blockingIssueCodes).toEqual([
      "local-not-finalized",
      "ledger-symbols-pending",
    ]);
    expect(result.report?.boundary).toBe("clean-room-oracle-only");
    expect(result.warnings).toContain("codex_reference_oracle_blocked: local-not-finalized");
  });

  it("lets MOSS_CODEX_REFERENCE_REPORT point to an external report file", () => {
    const projectPath = makeTempProject();
    const externalProject = makeTempProject();
    const reportPath = writeReport(externalProject, {
      ...BLOCKED_REPORT,
      gate: { status: "pass", summary: "Ready." },
      issues: [],
      progress: {
        ...BLOCKED_REPORT.progress,
        finalizedChunks: 534,
        pendingSymbols: 0,
        importMapNonDone: 0,
        publicResidueCount: 0,
      },
    });

    const result = loadCodexReferenceOracle({
      projectPath,
      env: { MOSS_CODEX_REFERENCE_REPORT: reportPath },
    });

    expect(result.status).toBe("ready");
    expect(result.reportPath).toBe(reportPath);
    expect(result.warnings).toEqual([]);
  });

  it("supports inline JSON in MOSS_CODEX_REFERENCE_REPORT for local smoke tests", () => {
    const projectPath = makeTempProject();
    const result = loadCodexReferenceOracle({
      projectPath,
      env: { MOSS_CODEX_REFERENCE_REPORT: JSON.stringify(BLOCKED_REPORT) },
    });

    expect(result.status).toBe("blocked");
    expect(result.reportPath).toBeUndefined();
    expect(result.summary?.progress.localChunks).toBe(534);
  });

  it("blocks invalid or non-clean oracle reports", () => {
    const projectPath = makeTempProject();
    writeReport(projectPath, { ...BLOCKED_REPORT, boundary: "vendored-source" });

    const result = loadCodexReferenceOracle({ projectPath, env: {} });

    expect(result.status).toBe("blocked");
    expect(result.report).toBeUndefined();
    expect(result.warnings[0]).toContain("codex_reference_oracle_invalid");
  });
});
