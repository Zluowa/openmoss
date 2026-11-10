import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { finalizeManagedPluginSmoke } from "./moss-managed-plugin-smoke-cleanup";
import { createManagedPluginSmokeDiagnostics } from "./moss-managed-plugin-smoke-diagnostics";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

let fixture: string;
let root: string;
beforeEach(async () => {
  vi.mocked(rm).mockClear();
  fixture = await mkdtemp(path.join(tmpdir(), "moss-smoke-diagnostics-test-"));
  root = path.join(fixture, "workspace");
  await mkdir(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

const fakeChild = (pid: number) =>
  Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    stdin: { destroyed: false },
    stdout: { destroyed: false },
    stderr: { destroyed: false },
    spawnargs: ["synthetic-private-argv"],
    env: { TOKEN: "synthetic-private-env" },
  }) as unknown as ChildProcess;

it("passively records exact own handles and emits no argv, env, or file content", async () => {
  const readProcesses = vi.fn(async (pids: readonly number[]) =>
    pids.map((pid) => ({ pid, startedAt: "2026-11-02T00:00:00.0000000Z" })),
  );
  const diagnostics = await createManagedPluginSmokeDiagnostics(root, readProcesses);
  const child = fakeChild(30001);
  diagnostics.observeChild(child);
  await writeFile(path.join(root, "state.txt"), "synthetic-private-file-content");
  expect(readProcesses).not.toHaveBeenCalled();
  child.emit("exit", 1, null);
  child.emit("close", 1, null);
  const result = await diagnostics.collect(
    Object.assign(new Error("synthetic-private-error"), { code: "EBUSY" }),
  );
  expect(readProcesses).toHaveBeenCalledExactlyOnceWith([30001]);
  expect(result).toMatchObject({
    cleanupErrorCode: "EBUSY",
    knownRoots: [
      {
        pid: 30001,
        exitObserved: true,
        closeObserved: true,
        currentNumericPidIdentity: { pid: 30001 },
      },
    ],
    workspace: { status: "same-task-root", entries: [{ name: "state.txt", kind: "file" }] },
  });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-private/u);
});

it("does not follow a child directory link or enumerate outside the bound root", async () => {
  const foreign = path.join(fixture, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "foreign-secret-filename"), "foreign-private-content");
  const diagnostics = await createManagedPluginSmokeDiagnostics(root, async () => []);
  await symlink(
    foreign,
    path.join(root, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const result = await diagnostics.collect({ code: "EBUSY" });
  expect(result).toMatchObject({
    workspace: {
      status: "same-task-root",
      entries: [{ name: "linked", kind: "link-not-followed" }],
    },
  });
  expect(JSON.stringify(result)).not.toMatch(/foreign-secret|foreign-private/u);
  expect(await readFile(path.join(foreign, "foreign-secret-filename"), "utf8")).toBe(
    "foreign-private-content",
  );
});

it("refuses an ABA root replaced with a junction to another directory", async () => {
  const diagnostics = await createManagedPluginSmokeDiagnostics(root, async () => []);
  const foreign = path.join(fixture, "foreign");
  await mkdir(foreign);
  await writeFile(path.join(foreign, "foreign-secret-filename"), "preserved");
  await rename(root, path.join(fixture, "original-root"));
  await symlink(foreign, root, process.platform === "win32" ? "junction" : "dir");
  const result = await diagnostics.collect({ code: "EBUSY" });
  expect(result).toMatchObject({ workspace: { status: "identity-changed-no-enumeration" } });
  expect(JSON.stringify(result)).not.toContain("foreign-secret-filename");
  expect(await readFile(path.join(foreign, "foreign-secret-filename"), "utf8")).toBe("preserved");
});

it("keeps unavailable identity diagnostics generic and does not turn a PID into ownership proof", async () => {
  const diagnostics = await createManagedPluginSmokeDiagnostics(root, async () => {
    throw new Error("synthetic-private-native-stderr");
  });
  diagnostics.observeChild(fakeChild(30002));
  const result = await diagnostics.collect({ code: "a private error" });
  expect(result).toMatchObject({
    cleanupErrorCode: "UNKNOWN",
    identityQuery: "unavailable",
    knownRoots: [{ pid: 30002, currentNumericPidIdentity: null }],
  });
  expect(JSON.stringify(result)).not.toMatch(/synthetic-private|a private error/u);
});

it("preserves the four-attempt cleanup failure and never publishes a success receipt", async () => {
  const output = path.join(fixture, "result.json");
  const diagnostics = await createManagedPluginSmokeDiagnostics(root, async () => []);
  const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const locked = Object.assign(new Error("synthetic lock"), { code: "EBUSY" });
  for (let attempt = 0; attempt < 4; attempt++) vi.mocked(rm).mockRejectedValueOnce(locked);
  let diagnostic: Readonly<Record<string, unknown>> | undefined;
  await expect(
    finalizeManagedPluginSmoke({ status: "passed" }, { root, output, keepWorkspace: false }).catch(
      async (error) => {
        diagnostic = await diagnostics.collect(error.cause);
        throw error;
      },
    ),
  ).rejects.toMatchObject({ stage: "workspace-cleanup", cause: locked });
  expect(rm).toHaveBeenCalledTimes(4);
  expect(diagnostic).toMatchObject({
    cleanupErrorCode: "EBUSY",
    workspace: { status: "same-task-root" },
  });
  expect(logged).not.toHaveBeenCalled();
  await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(root)).isDirectory()).toBe(true);
});

it("bounds metadata and roots without querying arbitrary extra PIDs", async () => {
  const readProcesses = vi.fn(async () => []);
  const diagnostics = await createManagedPluginSmokeDiagnostics(root, readProcesses);
  for (let index = 0; index < 80; index++)
    await writeFile(path.join(root, `entry-${index}`), "fixture");
  for (let index = 0; index < 20; index++) diagnostics.observeChild(fakeChild(31000 + index));
  const result = await diagnostics.collect({ code: "EBUSY" });
  expect(result).toMatchObject({ rootsTruncated: true, workspace: { truncated: true } });
  expect((result.workspace as { entries: unknown[] }).entries).toHaveLength(64);
  expect(result.knownRoots).toHaveLength(16);
  expect(readProcesses).toHaveBeenCalledExactlyOnceWith(
    Array.from({ length: 16 }, (_, index) => 31000 + index),
  );
});
