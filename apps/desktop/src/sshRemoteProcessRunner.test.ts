// FILE: sshRemoteProcessRunner.test.ts
// Purpose: Exercise ownership and drain safety in the shipped remote runner.
// Layer: SSH runtime tests
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SSH_REMOTE_PROCESS_RUNNER } from "./sshRemoteProcessRunner";

function fixture(childParent = 100) {
  vi.useFakeTimers();
  const rows = new Map<number, { parent: number; born: string }>([
    [100, { parent: 1, born: "self" }],
    [200, { parent: childParent, born: "child" }],
  ]);
  const child = Object.assign(new EventEmitter(), { pid: 200 });
  const signals = new Map<string, () => void>();
  const removed = vi.fn();
  const exit = vi.fn();
  const kill = vi.fn((pid: number, signal: string) => {
    if (signal === "SIGKILL") rows.delete(pid);
  });
  const process = {
    pid: 100,
    platform: "linux",
    argv: ["node", "runner", "owned-command"],
    env: {
      HOME: "/owned",
      MOSS_SSH_PREPARE_DIR: "/owned/.moss/ssh-runtime/.prepare.QA123",
      MOSS_SSH_RUNNER_CLEANUP: "1",
    },
    on: (signal: string, callback: () => void) => signals.set(signal, callback),
    kill,
    exit,
  };
  const fs = {
    metadataAvailable: true,
    readdirSync: () => {
      if (!fs.metadataAvailable) throw new Error("metadata unavailable");
      return [...rows.keys()].map(String);
    },
    readFileSync: (file: string) => {
      const pid = Number(file.split("/")[2]);
      const row = rows.get(pid)!;
      const fields = Array(20).fill("0");
      fields[0] = "S";
      fields[1] = String(row.parent);
      fields[19] = row.born;
      return `${pid} (owned-fixture) ${fields.join(" ")}`;
    },
    writeSync: vi.fn(),
    realpathSync: (directory: string) => directory,
    rmSync: removed,
  };
  runInNewContext(SSH_REMOTE_PROCESS_RUNNER, {
    require: (name: string) =>
      name === "node:fs"
        ? fs
        : name === "node:child_process"
          ? { spawn: () => child }
          : requirePath,
    process,
    Date,
    setInterval,
    clearInterval,
  });
  return { rows, child, signals, removed, exit, kill, fs };
}

// POSIX semantics are deliberate even when this safety test runs on Windows.
const requirePath = {
  resolve: (...parts: string[]) => parts.join("/").replaceAll("//", "/"),
  dirname: (file: string) => file.slice(0, file.lastIndexOf("/")),
  basename: (file: string) => file.slice(file.lastIndexOf("/") + 1),
};

afterEach(() => vi.useRealTimers());
describe("SSH remote runner safety", () => {
  it("never adopts a new PID without direct parent ownership", () => {
    const run = fixture(999);
    run.signals.get("SIGTERM")!();
    run.child.emit("close", null);
    vi.advanceTimersByTime(5000);
    expect(run.kill).not.toHaveBeenCalled();
  });

  it("does not signal a reused PID or adopt its descendants", () => {
    const run = fixture();
    run.rows.set(200, { parent: 100, born: "reused" });
    run.rows.set(300, { parent: 200, born: "unrelated" });
    run.child.emit("close", 0);
    vi.advanceTimersByTime(5000);
    expect(run.kill).not.toHaveBeenCalled();
  });

  it("drains an ignored-TERM descendant after ordinary root exit before cleanup", () => {
    const run = fixture();
    run.rows.set(300, { parent: 200, born: "grandchild" });
    vi.advanceTimersByTime(300);
    run.rows.delete(200);
    run.child.emit("close", 0);
    expect(run.removed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(run.kill).toHaveBeenCalledWith(300, "SIGTERM");
    expect(run.kill).toHaveBeenCalledWith(300, "SIGKILL");
    expect(run.rows.has(300)).toBe(false);
    expect(run.removed).toHaveBeenCalledOnce();
    expect(run.exit).toHaveBeenCalledWith(0);
  });

  it("preserves prepare files when missing metadata prevents exit confirmation", () => {
    const run = fixture();
    run.fs.metadataAvailable = false;
    run.child.emit("close", 0);
    vi.advanceTimersByTime(5000);
    expect(run.kill).not.toHaveBeenCalled();
    expect(run.removed).not.toHaveBeenCalled();
    expect(run.exit).toHaveBeenCalledWith(70);
  });
});
