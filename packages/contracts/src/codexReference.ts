import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas";

export const CodexReferenceCapability = Schema.Literals([
  "provider-session",
  "runtime-events",
  "mcp",
  "skills",
  "hooks",
  "config",
  "local-state",
]);
export type CodexReferenceCapability = typeof CodexReferenceCapability.Type;

export const CodexReferenceGateStatus = Schema.Literals(["pass", "fail"]);
export type CodexReferenceGateStatus = typeof CodexReferenceGateStatus.Type;

export const CodexReferenceTypecheckStatus = Schema.Literals(["pass", "fail", "missing"]);
export type CodexReferenceTypecheckStatus = typeof CodexReferenceTypecheckStatus.Type;

export const CodexReferenceBuild = Schema.Struct({
  appVersion: TrimmedNonEmptyString,
  appBuild: TrimmedNonEmptyString,
  refVersion: TrimmedNonEmptyString,
  refBuild: TrimmedNonEmptyString,
  entry: TrimmedNonEmptyString,
  appAsarSha256: TrimmedNonEmptyString,
});
export type CodexReferenceBuild = typeof CodexReferenceBuild.Type;

export const CodexReferenceProgress = Schema.Struct({
  localChunks: NonNegativeInt,
  finalizedChunks: NonNegativeInt,
  promotedChunks: NonNegativeInt,
  totalSymbols: NonNegativeInt,
  pendingSymbols: NonNegativeInt,
  importMapNonDone: NonNegativeInt,
  publicResidueCount: NonNegativeInt,
  typecheckStatus: CodexReferenceTypecheckStatus,
  typecheckDiagnostics: NonNegativeInt,
});
export type CodexReferenceProgress = typeof CodexReferenceProgress.Type;

export const CodexReferenceGateIssue = Schema.Struct({
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  data: Schema.optional(Schema.Unknown),
});
export type CodexReferenceGateIssue = typeof CodexReferenceGateIssue.Type;

export const CodexReferenceOracleReport = Schema.Struct({
  version: Schema.Literal(1),
  generatedAt: IsoDateTime,
  provider: Schema.Literal("codex"),
  boundary: Schema.Literal("clean-room-oracle-only"),
  source: CodexReferenceBuild,
  progress: CodexReferenceProgress,
  capabilities: Schema.Array(CodexReferenceCapability),
  issues: Schema.Array(CodexReferenceGateIssue),
  gate: Schema.Struct({
    status: CodexReferenceGateStatus,
    summary: TrimmedNonEmptyString,
  }),
  details: Schema.optional(Schema.Unknown),
});
export type CodexReferenceOracleReport = typeof CodexReferenceOracleReport.Type;
