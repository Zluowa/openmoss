import { pathToFileURL } from "node:url";

import { mossLoopStatusExitCode, readMossLoopStatus } from "./lib/moss-loop-status.ts";

export {
  mossLoopStatusExitCode,
  parseJsonLines,
  readMossLoopStatus,
  summarizeMossLoop,
} from "./lib/moss-loop-status.ts";
export type {
  MossLedgerIssue,
  MossLedgerIssueCode,
  MossLoopEvent,
  MossLoopStatus,
  MossLoopStatusInput,
  MossLoopTask,
  MossReleaseGateCheck,
  MossReleaseGateState,
} from "./lib/moss-loop-status.ts";

async function main(): Promise<void> {
  const status = await readMossLoopStatus();
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
  process.exitCode = mossLoopStatusExitCode(status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
