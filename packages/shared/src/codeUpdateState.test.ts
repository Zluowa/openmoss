import { describe, expect, it } from "vitest";

import {
  CODE_UPDATE_MAX_UNCLEAN_STARTS,
  decideCodeUpdateBoot,
  EMPTY_CODE_UPDATE_STATE,
  inspectCodeUpdateSync,
  markCodeUpdateCleanExit,
  markCodeUpdateHealthy,
  markCodeUpdatePending,
  prunablePackageFiles,
  isCodeUpdateEnabled,
  parseCodeUpdateState,
  prunableCodeUpdateIds,
  rejectCodeUpdate,
  resolveCodeUpdateStoreDir,
  type CodeUpdateInspection,
  type CodeUpdateState,
  type CodeUpdateSyncFs,
} from "./codeUpdateState";

const A = "aaaaaaaaaaaa-1111111111111111";
const B = "bbbbbbbbbbbb-2222222222222222";
const PID = 4242;

const ok = (id: string): CodeUpdateInspection => ({
  ok: true,
  installed: {
    schema: 1,
    id,
    commit: "c".repeat(40),
    codeVersion: "1.0.7+c",
    channel: "preview",
    sequence: 1,
    shellCommit: "s".repeat(40),
    archiveSize: 10,
    archiveSha256: "0".repeat(64),
    migrations: { latest: 170, readerFloor: 169 },
    installedAt: "t",
  },
});

function boot(
  state: CodeUpdateState,
  options: { pid?: number; alive?: boolean; broken?: string[] } = {},
) {
  return decideCodeUpdateBoot({
    state,
    inspect: (id) =>
      options.broken?.includes(id)
        ? { ok: false, reason: "shell-changed", detail: "built for another shell" }
        : ok(id),
    isProcessAlive: () => options.alive ?? false,
    pid: options.pid ?? PID,
    now: "2026-11-18T00:00:00.000Z",
  });
}

/** Healthy A running, B applied and waiting for the next start. */
const withPendingB: CodeUpdateState = { ...EMPTY_CODE_UPDATE_STATE, active: A, pending: B };

describe("decideCodeUpdateBoot", () => {
  it("starts the installed code when there is nothing in the store", () => {
    expect(boot(EMPTY_CODE_UPDATE_STATE).choice).toEqual({ kind: "installed" });
  });

  it("starts a pending update as a trial, marked running before its code loads", () => {
    const decision = boot(withPendingB);
    expect(decision.choice).toEqual({ kind: "code", id: B, trial: true });
    expect(decision.state.trial).toMatchObject({
      id: B,
      running: true,
      pid: PID,
      uncleanStarts: 0,
    });
    expect(decision.state.pending).toBeNull();
    expect(decision.state.active).toBe(A);
  });

  it("makes a healthy trial active; only then the old archive may go (one archive kept)", () => {
    const started = boot(withPendingB).state;
    // While B is on trial, A's archive is kept: it is the fallback.
    expect(prunableCodeUpdateIds(started, [A, B])).toEqual([]);
    const healthy = markCodeUpdateHealthy(started, B);
    expect(healthy).toMatchObject({ active: B, trial: null });
    expect(prunableCodeUpdateIds(healthy, [A, B])).toEqual([A]);
    expect(boot(healthy).choice).toEqual({ kind: "code", id: B, trial: false });
  });

  it("keeps the last two packages, newest first", () => {
    const C = "cccccccccccc-3333333333333333";
    let state = markCodeUpdatePending(EMPTY_CODE_UPDATE_STATE, A);
    state = markCodeUpdatePending(state, B);
    state = markCodeUpdatePending(state, C);
    expect(state.packages).toEqual([C, B]);
    expect(
      prunablePackageFiles(state, [`${A}.asar.zst`, `${B}.asar.zst`, `${C}.manifest.json`]),
    ).toEqual([`${A}.asar.zst`]);
  });

  it("starts the installed code at once when the active archive is gone, and queues a rebuild", () => {
    const state = { ...EMPTY_CODE_UPDATE_STATE, active: A, packages: [A] };
    const decision = decideCodeUpdateBoot({
      state,
      inspect: () => ({ ok: false, reason: "damaged", detail: "archive missing" }),
      isProcessAlive: () => false,
      pid: PID,
      now: "t",
    });
    expect(decision.choice).toEqual({ kind: "installed" });
    expect(decision.state).toMatchObject({ active: null, rebuild: A });
    expect(decision.state.rejected[A]).toBeUndefined();
    // Without a kept package there is nothing to rebuild from: it is rejected instead.
    const without = decideCodeUpdateBoot({
      state: { ...state, packages: [] },
      inspect: () => ({ ok: false, reason: "damaged", detail: "archive missing" }),
      isProcessAlive: () => false,
      pid: PID,
      now: "t",
    });
    expect(without.choice).toEqual({ kind: "installed" });
    expect(without.state.rejected[A]).toMatchObject({ reason: "damaged" });
  });

  it("rolls a broken update back to the previous code after starts that never became healthy", () => {
    let state = boot(withPendingB).state;
    // The trial's process died before healthy, again and again: each next start counts it.
    for (let start = 1; start < CODE_UPDATE_MAX_UNCLEAN_STARTS; start += 1) {
      const decision = boot(state, { pid: PID + start });
      expect(decision.choice).toEqual({ kind: "code", id: B, trial: true });
      state = decision.state;
    }
    const decision = boot(state, { pid: PID + 99 });
    expect(decision.choice).toEqual({ kind: "code", id: A, trial: false });
    expect(decision.state.rejected[B]).toMatchObject({ reason: "crash-loop" });
    expect(decision.state.trial).toBeNull();
    expect(decision.events.join("\n")).toContain(`code-update rejected id=${B} reason=crash-loop`);
    // Never tried again.
    expect(boot(markCodeUpdatePending(decision.state, B)).choice).toEqual({
      kind: "code",
      id: A,
      trial: false,
    });
  });

  it("rolls back at once when the new code fails to load (the boot records load-error)", () => {
    const started = boot(withPendingB).state;
    const rejected = rejectCodeUpdate(started, B, {
      reason: "load-error",
      detail: "boom",
      at: "t",
    });
    expect(boot(rejected).choice).toEqual({ kind: "code", id: A, trial: false });
  });

  it("falls back to the installed code when the rejected update was the only one", () => {
    const started = boot({ ...EMPTY_CODE_UPDATE_STATE, pending: B }).state;
    const rejected = rejectCodeUpdate(started, B, { reason: "timeout", detail: "180 s", at: "t" });
    expect(boot(rejected).choice).toEqual({ kind: "installed" });
  });

  it("does not count a clean quit before healthy against the trial", () => {
    const started = boot(withPendingB).state;
    const quit = markCodeUpdateCleanExit(started, B, PID);
    const next = boot(quit, { pid: PID + 1 });
    expect(next.choice).toEqual({ kind: "code", id: B, trial: true });
    expect(next.state.trial?.uncleanStarts).toBe(0);
  });

  it("does not count a second launch while the trial's first process is alive", () => {
    const started = boot(withPendingB).state;
    const second = boot(started, { pid: PID + 1, alive: true });
    expect(second.choice).toEqual({ kind: "code", id: B, trial: true });
    expect(second.state).toBe(started);
  });

  it("rejects code built for another shell and starts the installed code (new installer)", () => {
    const decision = boot({ ...EMPTY_CODE_UPDATE_STATE, active: A }, { broken: [A] });
    expect(decision.choice).toEqual({ kind: "installed" });
    expect(decision.state.rejected[A]).toMatchObject({ reason: "shell-changed" });
  });
});

describe("store state", () => {
  it("is off without the switch, and always off on macOS for now", () => {
    expect(isCodeUpdateEnabled({}, "win32")).toBe(false);
    expect(isCodeUpdateEnabled({ MOSS_CODE_UPDATES: "1" }, "win32")).toBe(true);
    expect(isCodeUpdateEnabled({ MOSS_CODE_UPDATES: "1" }, "linux")).toBe(true);
    expect(isCodeUpdateEnabled({ MOSS_CODE_UPDATES: "1" }, "darwin")).toBe(false);
  });

  it("reads damaged or foreign state as empty", () => {
    expect(parseCodeUpdateState(null)).toEqual(EMPTY_CODE_UPDATE_STATE);
    expect(parseCodeUpdateState("{not json")).toEqual(EMPTY_CODE_UPDATE_STATE);
    expect(parseCodeUpdateState(JSON.stringify({ schema: 9, active: A }))).toEqual(
      EMPTY_CODE_UPDATE_STATE,
    );
    expect(parseCodeUpdateState(JSON.stringify({ schema: 1, active: "../x" })).active).toBeNull();
  });

  it("prunes only folders no state field names", () => {
    const state = { ...EMPTY_CODE_UPDATE_STATE, active: A };
    expect(prunableCodeUpdateIds(state, [A, B, "downloads", "state.json"])).toEqual([B]);
  });

  it("keeps the store out of roaming data and honours the override", () => {
    expect(
      resolveCodeUpdateStoreDir({
        env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" },
        platform: "win32",
        homeDir: "C:\\Users\\x",
      }),
    ).toMatch(/Local[\\/]Moss[\\/]code-updates$/u);
    expect(
      resolveCodeUpdateStoreDir({
        env: { MOSS_CODE_UPDATE_DIR: "/tmp/s" },
        platform: "linux",
        homeDir: "/h",
      }),
    ).toMatch(/[\\/]tmp[\\/]s$/u);
  });

  it("inspect refuses a folder whose archive changed size or whose shell differs", () => {
    const installed = JSON.stringify(ok(A).ok ? (ok(A) as { installed: unknown }).installed : null);
    const fs = (size: number): CodeUpdateSyncFs => ({
      readFileSync: () => installed,
      writeFileSync: () => undefined,
      renameSync: () => undefined,
      mkdirSync: () => undefined,
      statSync: () => ({ size }),
    });
    const shell = "s".repeat(40);
    expect(
      inspectCodeUpdateSync({ fs: fs(10), storeDir: "/s", id: A, shellCommit: shell }).ok,
    ).toBe(true);
    expect(
      inspectCodeUpdateSync({ fs: fs(11), storeDir: "/s", id: A, shellCommit: shell }),
    ).toMatchObject({
      ok: false,
      reason: "damaged",
    });
    expect(
      inspectCodeUpdateSync({ fs: fs(10), storeDir: "/s", id: A, shellCommit: "t".repeat(40) }),
    ).toMatchObject({ ok: false, reason: "shell-changed" });
  });
});
