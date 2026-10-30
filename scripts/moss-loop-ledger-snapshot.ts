import { pathToFileURL } from "node:url";

import {
  readMossLoopLedgerDashboardSnapshot,
  type MossLoopLedgerSnapshotOptions,
} from "./lib/moss-loop-ledger-snapshot.ts";

export {
  buildMossLoopLedgerDashboardSnapshot,
  readMossLoopLedgerDashboardSnapshot,
} from "./lib/moss-loop-ledger-snapshot.ts";
export type { MossLoopLedgerSnapshotOptions } from "./lib/moss-loop-ledger-snapshot.ts";

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} requires a positive integer`);
  }
  return parsed;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossLoopLedgerSnapshotOptions {
  const options: {
    createdAt?: string;
    reviewLimit?: number;
    evidenceLimit?: number;
  } = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--created-at") {
      const createdAt = argv[index + 1];
      if (!createdAt) {
        throw new Error("--created-at requires an ISO timestamp");
      }
      options.createdAt = createdAt;
      index += 1;
      continue;
    }
    if (arg === "--review-limit") {
      const limit = argv[index + 1];
      if (!limit) {
        throw new Error("--review-limit requires a positive integer");
      }
      options.reviewLimit = parsePositiveInteger(limit, "--review-limit");
      index += 1;
      continue;
    }
    if (arg === "--evidence-limit") {
      const limit = argv[index + 1];
      if (!limit) {
        throw new Error("--evidence-limit requires a positive integer");
      }
      options.evidenceLimit = parsePositiveInteger(limit, "--evidence-limit");
      index += 1;
      continue;
    }
    throw new Error(`unknown moss loop ledger snapshot option: ${arg}`);
  }

  return options;
}

async function main(): Promise<void> {
  const snapshot = await readMossLoopLedgerDashboardSnapshot(
    process.cwd(),
    parseCliOptions(process.argv.slice(2)),
  );
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
