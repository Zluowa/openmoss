// FILE: desktopFatalExit.test.ts
// Purpose: Proves a failed desktop backend writes why it stopped before it exits.
// Layer: Server process entry test

import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { PersistenceDecodeError } from "./persistence/Errors.ts";
import {
  desktopBackendExitCode,
  exitDesktopBackend,
  formatDesktopFatalExitReport,
} from "./desktopFatalExit.ts";

function recordExit(exit: Exit.Exit<unknown, unknown>, options: { drains?: boolean } = {}) {
  const events: Array<string> = [];
  let timer: (() => void) | undefined;
  const fiber = Effect.runFork(
    exitDesktopBackend(exit, {
      writeStderr: (text, done) => {
        events.push(`stderr:${text}`);
        if (options.drains !== false) done();
      },
      exitProcess: (code) => events.push(`exit:${code}`),
      setTimer: (callback) => {
        timer = callback;
      },
    }),
  );
  return { events, fireTimer: () => timer?.(), fiber };
}

describe("desktop backend exit", () => {
  const startupFailure = new PersistenceDecodeError({
    operation: "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
    issue: "Expected string, got null",
  });

  it("writes the failure, ending with one summary line, and exits 1 after the write", () => {
    const { events } = recordExit(Exit.fail(startupFailure));
    expect(events).toHaveLength(2);
    expect(events[1]).toBe("exit:1");
    const report = events[0]!.slice("stderr:".length);
    const lines = report.trimEnd().split("\n");
    expect(lines.at(-1)).toBe(
      "[moss-server] fatal error, stopping: PersistenceDecodeError: Decode error in " +
        "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows: " +
        "Expected string, got null",
    );
    expect(report).toContain("PersistenceDecodeError");
  });

  it("still exits when stderr never drains", () => {
    const { events, fireTimer } = recordExit(Exit.fail(startupFailure), { drains: false });
    expect(events.some((event) => event.startsWith("exit:"))).toBe(false);
    fireTimer();
    expect(events.at(-1)).toBe("exit:1");
  });

  it("exits silently with 0 on success and 130 on an interrupt", () => {
    expect(recordExit(Exit.void).events).toEqual(["exit:0"]);
    expect(recordExit(Exit.failCause(Cause.interrupt())).events).toEqual(["exit:130"]);
    expect(desktopBackendExitCode(Exit.die(new Error("boom")))).toBe(1);
  });

  it("carries the causes that say more into the summary line", () => {
    const wrapped = new Error("SQL error in ProjectionStateRepository.listAll:query", {
      cause: new Error('Expected number, got string at [0]["lastAppliedSequence"]'),
    });
    expect(formatDesktopFatalExitReport(Cause.die(wrapped)).trimEnd().split("\n").at(-1)).toBe(
      "[moss-server] fatal error, stopping: Error: SQL error in ProjectionStateRepository.listAll:query" +
        ' <- Expected number, got string at [0]["lastAppliedSequence"]',
    );
  });

  it("names a defect that is not an Error", () => {
    expect(formatDesktopFatalExitReport(Cause.die("plain text")).trimEnd().split("\n").at(-1)).toBe(
      "[moss-server] fatal error, stopping: plain text",
    );
  });
});
