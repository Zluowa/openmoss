import { pathToFileURL } from "node:url";

import {
  readMossFinalShellAuditReport,
  type MossFinalShellAuditReport,
} from "./lib/moss-final-shell-parity.ts";

export { readMossFinalShellAuditReport } from "./lib/moss-final-shell-parity.ts";
export type {
  MossFinalShellAuditDocument,
  MossFinalShellAuditGateStatus,
  MossFinalShellAuditReport,
  MossFinalShellCriterion,
  MossFinalShellCriterionStatus,
  MossFinalShellNextGap,
} from "./lib/moss-final-shell-parity.ts";

export interface MossFinalShellAuditCliOptions {
  readonly createdAt?: string;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossFinalShellAuditCliOptions {
  const options: {
    createdAt?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at" || arg === "--generated-at") {
      const createdAt = argv[index + 1];
      if (!createdAt) {
        throw new Error(`${arg} requires an ISO timestamp`);
      }
      options.createdAt = createdAt;
      index += 1;
      continue;
    }
    throw new Error(`unknown moss final shell parity option: ${arg}`);
  }

  return options;
}

function withGeneratedAt(
  report: MossFinalShellAuditReport,
  options: MossFinalShellAuditCliOptions,
): MossFinalShellAuditReport & { readonly generatedAt?: string } {
  return {
    ...(options.createdAt ? { generatedAt: options.createdAt } : {}),
    ...report,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const options = parseCliOptions(argv);
  const report = withGeneratedAt(readMossFinalShellAuditReport(process.cwd()), options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.auditGateStatus === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
