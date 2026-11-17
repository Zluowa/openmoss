// Test fixture: a stand-in Moss backend that takes the database lifecycle lock the
// way server startup does and holds it until it is killed. It reports the outcome
// in a JSON file so a test can run two of them as real processes.
import * as fs from "node:fs/promises";

import { Effect } from "effect";

import { withDatabaseLifecycleLock } from "../persistence/DatabaseLifecycleLock.ts";

const [dbPath, statePath] = process.argv.slice(2) as [string, string];

const report = (state: Record<string, unknown>) =>
  fs.writeFile(statePath, JSON.stringify({ pid: process.pid, ...state }));

const program = withDatabaseLifecycleLock(
  dbPath,
  Effect.promise(() => report({ outcome: "acquired" })).pipe(Effect.andThen(Effect.never)),
);

const keepAlive = setInterval(() => undefined, 1_000);
try {
  await Effect.runPromise(program);
} catch (cause) {
  await report({
    outcome: "refused",
    message: cause instanceof Error ? cause.message : String(cause),
  });
} finally {
  clearInterval(keepAlive);
}
