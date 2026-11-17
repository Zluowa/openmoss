import { afterEach, describe, expect, it, vi } from "vitest";

import {
  databaseLockedStartupFailure,
  waitForStartupFailureRenderer,
} from "./backendStartupBlockPresentation";

afterEach(() => {
  vi.useRealTimers();
});

describe("databaseLockedStartupFailure", () => {
  // The backend's real output on 2026-11-17, with the user folder shortened.
  const output = [
    "DatabaseLifecycleLockedError: Database lifecycle is locked for C:\\Users\\me\\.moss\\userdata\\state.sqlite: owner pid 51248 is live (C:\\Users\\me\\.moss\\userdata\\state.sqlite.lifecycle-lock)",
    "    at acquire (file:///C:/Program/Moss/resources/app.asar/apps/server/dist/MigrationBackup-SB7tCKNn.mjs:33489:32)",
    "[moss-server] fatal error, stopping: DatabaseLifecycleLockedError: Database lifecycle is locked for C:\\Users\\me\\.moss\\userdata\\state.sqlite: owner pid 51248 is live (C:\\Users\\me\\.moss\\userdata\\state.sqlite.lifecycle-lock)",
  ].join("\n");

  it("names the lock, the owner process and the log for the window", () => {
    const failure = databaseLockedStartupFailure({
      ownerPid: 51248,
      appVersion: "1.0.7",
      platform: "win32 x64",
      output,
      logFilePath: "C:\\Users\\me\\.moss\\userdata\\logs\\server-child.log",
    });
    expect(failure).toMatchObject({
      kind: "database-locked",
      ownerPid: 51248,
      failures: 1,
      logFilePath: "C:\\Users\\me\\.moss\\userdata\\logs\\server-child.log",
    });
    expect(failure.details).toContain("Moss 1.0.7 (win32 x64)");
    expect(failure.details).toContain("in use by process 51248");
    expect(failure.details).toContain("owner pid 51248 is live");
    expect(failure.details).toContain(
      "Log file: C:\\Users\\me\\.moss\\userdata\\logs\\server-child.log",
    );
  });

  it("says when the owner is unknown", () => {
    const failure = databaseLockedStartupFailure({
      ownerPid: null,
      appVersion: "1.0.7",
      platform: "darwin arm64",
      output: "",
      logFilePath: "/tmp/server-child.log",
    });
    expect(failure.ownerPid).toBeNull();
    expect(failure.details).toContain("could not be verified");
    expect(failure.details).toContain("wrote no error");
  });
});

describe("waitForStartupFailureRenderer", () => {
  function registry(initial = false) {
    let present = initial;
    const listeners = new Set<() => void>();
    return {
      isPresent: () => present,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      arrive: () => {
        present = true;
        for (const listener of listeners) listener();
      },
      listeners,
    };
  }

  it("answers at once when a window already draws the failure", async () => {
    const windows = registry(true);
    await expect(waitForStartupFailureRenderer({ ...windows, timeoutMs: 10_000 })).resolves.toBe(
      true,
    );
  });

  it("hands over to a window that loads during the wait", async () => {
    vi.useFakeTimers();
    const windows = registry();
    const waiting = waitForStartupFailureRenderer({ ...windows, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(3_000);
    windows.arrive();
    await expect(waiting).resolves.toBe(true);
    expect(windows.listeners.size).toBe(0);
  });

  it("falls back after the timeout when no window asks", async () => {
    vi.useFakeTimers();
    const windows = registry();
    const waiting = waitForStartupFailureRenderer({ ...windows, timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waiting).resolves.toBe(false);
    expect(windows.listeners.size).toBe(0);
  });

  it("stops waiting when aborted", async () => {
    const windows = registry();
    const controller = new AbortController();
    const waiting = waitForStartupFailureRenderer({
      ...windows,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    await expect(waiting).resolves.toBe(false);
  });
});
