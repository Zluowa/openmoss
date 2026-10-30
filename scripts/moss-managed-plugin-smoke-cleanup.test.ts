import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { finalizeManagedPluginSmoke } from "./moss-managed-plugin-smoke-cleanup";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

let fixture: string;
let root: string;
let output: string;
const report = { status: "passed", actualManager: true, productionTeardownVerified: true };

beforeEach(async () => {
  vi.mocked(rm).mockClear();
  fixture = await mkdtemp(path.join(tmpdir(), "moss-smoke-cleanup-test-"));
  root = path.join(fixture, "workspace");
  output = path.join(fixture, "result.json");
  await mkdir(root);
  await writeFile(path.join(root, "held.txt"), "task-owned fixture");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

it("publishes success only after the workspace is actually absent", async () => {
  const absentAtPublish: boolean[] = [];
  const logged = vi.spyOn(console, "log").mockImplementation(() => {
    absentAtPublish.push(!existsSync(root));
  });
  await finalizeManagedPluginSmoke(report, { root, output, keepWorkspace: false });
  await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect(absentAtPublish).toEqual([true]);
  expect(logged).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
    ...report,
    workspaceCleanup: "removed",
  });
});

it("explicitly reports intentional workspace retention", async () => {
  const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await finalizeManagedPluginSmoke(report, { root, output, keepWorkspace: true });
  expect((await lstat(root)).isDirectory()).toBe(true);
  expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
    ...report,
    workspaceCleanup: "retained-by-request",
    workspace: root,
  });
  expect(logged).toHaveBeenCalledTimes(1);
});

it("does not print success when writing the requested receipt fails", async () => {
  const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  await finalizeManagedPluginSmoke(report, { root, output: fixture, keepWorkspace: false }).then(
    () => {
      throw new Error("Expected receipt failure");
    },
    (error) => {
      expect(error).toMatchObject({ stage: "report" });
    },
  );
  expect(logged).not.toHaveBeenCalled();
});

it("does not retry unrelated filesystem failures or publish success", async () => {
  const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const denied = Object.assign(new Error("controlled access denial"), { code: "EACCES" });
  vi.mocked(rm).mockRejectedValueOnce(denied);
  await expect(
    finalizeManagedPluginSmoke(report, { root, output, keepWorkspace: false }),
  ).rejects.toMatchObject({ stage: "workspace-cleanup", cause: denied });
  expect(rm).toHaveBeenCalledTimes(1);
  expect(logged).not.toHaveBeenCalled();
  await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function holdWindowsResource(kind: "file" | "directory") {
  const script = `
$ErrorActionPreference='Stop'
$held=$null
try {
  ${
    kind === "file"
      ? `$held=[System.IO.File]::Open(${quote(path.join(root, "held.txt"))},[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::None)`
      : `[Environment]::CurrentDirectory=${quote(root)}`
  }
  [Console]::Out.WriteLine('ready')
  [Console]::Out.Flush()
  [void][Console]::In.ReadLine()
} finally {
  if ($held) { $held.Dispose() }
  [Environment]::CurrentDirectory=${quote(fixture)}
}
`;
  const child = spawn(
    path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { cwd: fixture, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.stdin.on("error", () => undefined);
  child.stderr.resume();
  const closed = once(child, "close");
  // Register closure/error ownership before waiting for readiness. A failed
  // setup has not returned `held` yet, so it must clean up its own child.
  void closed.catch(() => undefined);
  const waitForClose = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        closed,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned lock helper did not close")), 1_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      once(child.stdout, "data").then(([data]) => expect(String(data).trim()).toBe("ready")),
      closed.then(() => {
        throw new Error("Owned lock helper closed before ready");
      }),
      new Promise<never>((_, reject) => {
        readyTimer = setTimeout(
          () => reject(new Error("Owned lock helper did not become ready")),
          3_000,
        );
      }),
    ]);
  } catch (error) {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await waitForClose();
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }
  return {
    release: async () => {
      child.stdin.end("release\n");
      try {
        await waitForClose();
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await waitForClose();
        throw error;
      }
    },
  };
}

it.runIf(process.platform === "win32").each(["file", "directory"] as const)(
  "waits for a real Windows %s lock to release before publishing success",
  async (kind) => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const held = await holdWindowsResource(kind);
    let release: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Control: the actual OS lock prevents the former one-shot removal.
      await expect(rm(root, { recursive: true, force: true })).rejects.toMatchObject({
        code: expect.stringMatching(/^(EBUSY|EPERM)$/),
      });
      const finalization = finalizeManagedPluginSmoke(report, {
        root,
        output,
        keepWorkspace: false,
      });
      expect(logged).not.toHaveBeenCalled();
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
      timer = setTimeout(() => {
        release = held.release();
      }, 150);
      await finalization;
      await release;
      expect(logged).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(output, "utf8"))).toEqual({
        ...report,
        workspaceCleanup: "removed",
      });
      await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      clearTimeout(timer);
      await (release ?? held.release());
    }
  },
);

it.runIf(process.platform === "win32")(
  "rejects a persistent Windows lock without a success receipt",
  async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const held = await holdWindowsResource("directory");
    try {
      await expect(
        finalizeManagedPluginSmoke(report, { root, output, keepWorkspace: false }),
      ).rejects.toMatchObject({ stage: "workspace-cleanup", cause: { code: "EBUSY" } });
      expect(rm).toHaveBeenCalledTimes(4);
      for (const [, options] of vi.mocked(rm).mock.calls) {
        expect(options).toEqual({ recursive: true, force: true });
      }
      expect(logged).not.toHaveBeenCalled();
      await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await lstat(root)).isDirectory()).toBe(true);
    } finally {
      await held.release();
    }
  },
);
