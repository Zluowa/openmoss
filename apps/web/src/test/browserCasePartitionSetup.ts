import { beforeEach } from "vitest";

import { browserCaseFullName, browserCasePartitionIndex } from "./browserCasePartition";

declare const MOSS_BROWSER_CASE_PARTITION: { index: number; count: number };

// Setup-file hooks run before the full-app fixture's suite hooks. Unassigned
// cases never mount the app or run expensive fixture resets on this worker.
beforeEach((context) => {
  const { index, count } = MOSS_BROWSER_CASE_PARTITION;
  if (browserCasePartitionIndex(browserCaseFullName(context.task), count) !== index) {
    context.skip();
  }
});
