// FILE: wsRpc.threadSnapshotError.test.ts
// Purpose: Proves a thread whose rows no longer decode gets the terminal "no snapshot"
//          answer, not a generic error the client retries by reconnecting every 500 ms.
// Layer: WebSocket RPC test

import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { PersistenceDecodeError, PersistenceSqlError } from "./persistence/Errors";
import { toThreadSnapshotRpcError } from "./wsRpc";

describe("thread snapshot errors", () => {
  it("answers an unreadable thread with the terminal not-found code, naming no stored value", () => {
    const error = toThreadSnapshotRpcError(
      "thread-bad",
      new PersistenceDecodeError({
        operation: "ProjectionSnapshotQuery.getThreadDetailSnapshotById:decodeThread",
        issue: 'Expected string, got null at ["modelSelection"]',
      }),
    );
    expect(error.code).toBe("THREAD_SNAPSHOT_NOT_FOUND");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("Thread thread-bad could not be read.");
  });

  it("leaves other failures as they were", () => {
    const error = toThreadSnapshotRpcError(
      "thread-1",
      new PersistenceSqlError({ operation: "query", detail: "database is locked" }),
    );
    expect(error.code).toBeUndefined();
  });

  it("is what the thread subscription uses for its snapshot", async () => {
    const source = await readFile(new URL("./wsRpc.ts", import.meta.url), "utf8");
    const start = source.indexOf("[ORCHESTRATION_WS_METHODS.subscribeThread]");
    const end = source.indexOf("[ORCHESTRATION_WS_METHODS.unsubscribeThread]", start);
    expect(source.slice(start, end)).toContain(
      "Effect.mapError((cause) => toThreadSnapshotRpcError(input.threadId, cause))",
    );
  });
});
