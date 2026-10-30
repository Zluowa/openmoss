import { pathToFileURL } from "node:url";

import { readMossPrdCoverageReport, type MossPrdCoverageReport } from "./lib/moss-prd-coverage.ts";

export { readMossPrdCoverageReport } from "./lib/moss-prd-coverage.ts";
export type {
  MossPrdCoverageDocument,
  MossPrdCoverageNextGap,
  MossPrdCoverageReport,
  MossPrdCoverageRow,
  MossPrdCoverageSnapshot,
  MossPrdCoverageStatus,
} from "./lib/moss-prd-coverage.ts";

export interface MossPrdCoverageCliOptions {
  readonly createdAt?: string;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossPrdCoverageCliOptions {
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
    throw new Error(`unknown moss PRD coverage option: ${arg}`);
  }

  return options;
}

function withGeneratedAt(
  report: MossPrdCoverageReport,
  options: MossPrdCoverageCliOptions,
): MossPrdCoverageReport & { readonly generatedAt?: string } {
  return {
    ...(options.createdAt ? { generatedAt: options.createdAt } : {}),
    ...report,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const options = parseCliOptions(argv);
  const report = withGeneratedAt(readMossPrdCoverageReport(process.cwd()), options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
