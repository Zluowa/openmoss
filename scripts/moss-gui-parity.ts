import { pathToFileURL } from "node:url";

import { readMossGuiParityReport, type MossGuiParityReport } from "./lib/moss-gui-parity.ts";

export { readMossGuiParityReport } from "./lib/moss-gui-parity.ts";
export type {
  MossGuiParityDocument,
  MossGuiParityFirstVisibleShell,
  MossGuiParityGateStatus,
  MossGuiParityNextGap,
  MossGuiParityReport,
  MossGuiParitySnapshot,
  MossGuiParityStatus,
  MossGuiParitySurface,
} from "./lib/moss-gui-parity.ts";

export interface MossGuiParityCliOptions {
  readonly createdAt?: string;
}

function parseCliOptions(argv: ReadonlyArray<string>): MossGuiParityCliOptions {
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
    throw new Error(`unknown moss GUI parity option: ${arg}`);
  }

  return options;
}

function withGeneratedAt(
  report: MossGuiParityReport,
  options: MossGuiParityCliOptions,
): MossGuiParityReport & { readonly generatedAt?: string } {
  return {
    ...(options.createdAt ? { generatedAt: options.createdAt } : {}),
    ...report,
  };
}

function main(argv: ReadonlyArray<string>): number {
  const options = parseCliOptions(argv);
  const report = withGeneratedAt(readMossGuiParityReport(process.cwd()), options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.gateStatus === "pass" ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
