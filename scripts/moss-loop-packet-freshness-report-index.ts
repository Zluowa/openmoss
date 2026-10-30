import { pathToFileURL } from "node:url";

import {
  mossLoopPacketFreshnessGateReportIndexExitCode,
  readMossLoopPacketFreshnessGateReportIndex,
} from "./lib/moss-loop-packet-freshness-gate-report-index.ts";
import type { MossLoopPacketFreshnessGateReportIndexOptions } from "./lib/moss-loop-packet-freshness-gate-report-index.ts";

export {
  mossLoopPacketFreshnessGateReportIndexExitCode,
  readMossLoopPacketFreshnessGateReportIndex,
} from "./lib/moss-loop-packet-freshness-gate-report-index.ts";
export type {
  MossLoopPacketFreshnessGateReportArtifactSummary,
  MossLoopPacketFreshnessGateReportIndex,
  MossLoopPacketFreshnessGateReportIndexOptions,
  MossLoopPacketFreshnessGateReportIssue,
} from "./lib/moss-loop-packet-freshness-gate-report-index.ts";

function parseCliOptions(
  argv: ReadonlyArray<string>,
): MossLoopPacketFreshnessGateReportIndexOptions {
  const options: {
    generatedAt?: string;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      const createdAt = argv[index + 1];
      if (!createdAt) {
        throw new Error("--created-at requires an ISO timestamp");
      }
      options.generatedAt = createdAt;
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  return options;
}

function main(argv: ReadonlyArray<string>): number {
  const index = readMossLoopPacketFreshnessGateReportIndex(process.cwd(), parseCliOptions(argv));
  console.log(JSON.stringify(index, null, 2));
  return mossLoopPacketFreshnessGateReportIndexExitCode(index);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
