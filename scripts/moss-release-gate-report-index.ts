import { pathToFileURL } from "node:url";

import {
  mossReleaseGateReportArtifactIndexExitCode,
  readMossReleaseGateReportArtifactIndex,
} from "./lib/moss-release-gate-report-index.ts";
import type { MossReleaseGateReportIndexOptions } from "./lib/moss-release-gate-report-index.ts";

export {
  mossReleaseGateReportArtifactIndexExitCode,
  readMossReleaseGateReportArtifactIndex,
} from "./lib/moss-release-gate-report-index.ts";
export type {
  MossReleaseGateReportArtifactIndex,
  MossReleaseGateReportArtifactIssue,
  MossReleaseGateReportArtifactSummary,
  MossReleaseGateReportIndexOptions,
} from "./lib/moss-release-gate-report-index.ts";

function parseCliOptions(argv: ReadonlyArray<string>): MossReleaseGateReportIndexOptions {
  const options: {
    generatedAt?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--generated-at" || arg === "--created-at") {
      const generatedAt = argv[index + 1];
      if (!generatedAt) {
        throw new Error(`${arg} requires an ISO timestamp`);
      }
      options.generatedAt = generatedAt;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

function main(argv: ReadonlyArray<string>): number {
  const index = readMossReleaseGateReportArtifactIndex(process.cwd(), parseCliOptions(argv));
  console.log(JSON.stringify(index, null, 2));
  return mossReleaseGateReportArtifactIndexExitCode(index);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
