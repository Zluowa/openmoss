import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFailed,
  onTestFinished,
  vi,
} from "vitest";
import { spawnSync } from "node:child_process";
import * as executable from "./executable";
import os from "node:os";
import path from "node:path";

import { execShellCommandSync, spawnProcess } from "./processRuntime";

function run(
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const child = spawnProcess(process.execPath, args, {
    stdio: "pipe",
    requireExecutable: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ stdout, stderr, code }));
  });
}

function makePriorityProbe(enabled: boolean) {
  const serverPriority = os.getPriority();
  const expectedPriority = enabled
    ? Math.max(serverPriority, process.platform === "win32" ? 10 : 5)
    : serverPriority;
  const startedAt = performance.now();
  const stages: string[] = [];
  let stderr = "";
  let closed = false;
  let resolveReady: () => void = () => undefined;
  const readyMarker = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const child = spawnProcess(
    process.execPath,
    [
      "-e",
      `
      const os = require('node:os');
      const { spawnSync } = require('node:child_process');
      let probeSequence = 0;
      console.error('priority-probe: child-started', JSON.stringify({ seq: ++probeSequence, producedAtMs: Date.now() }));
      const report = () => {
      console.error('priority-probe: report-started', JSON.stringify({ seq: ++probeSequence, producedAtMs: Date.now() }));
      const descendant = spawnSync(process.execPath, ['-e', 'console.log(require("node:os").getPriority())'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.error('priority-probe: descendant-returned', JSON.stringify({ seq: ++probeSequence, producedAtMs: Date.now() }));
      if (descendant.stderr?.length) process.stderr.write(descendant.stderr);
      const threads = process.platform === 'linux'
        ? require('node:fs').readdirSync('/proc/self/task').map(tid => {
            const stat = require('node:fs').readFileSync('/proc/self/task/' + tid + '/stat', 'utf8');
            return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]);
          })
        : [os.getPriority()];
      console.log(JSON.stringify({ parent: os.getPriority(), descendant: Number(descendant.stdout),
        descendantStatus: descendant.status, descendantSignal: descendant.signal,
        descendantError: descendant.error?.message ?? null, threads }));
      };
      // Windows still adjusts after spawn; keep its inheritance probe gated.
      if (process.platform === 'win32') {
        process.stdin.resume();
        process.stdin.once('end', report);
        console.error('priority-probe: ready');
      }
      else report();
`,
    ],
    { stdio: "pipe", lowerPriority: enabled, ownProcessGroup: true },
  );
  const record = (stage: string) => {
    stages.push(
      `${Math.round(performance.now() - startedAt)}ms observedAtMs=${Date.now()} ${stage.slice(-8192)}`,
    );
    if (stages.length > 32) stages.shift();
  };
  child.once("spawn", () => record("spawned"));
  child.once("exit", (code, signal) => record(`exit code=${code} signal=${signal}`));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
    record(chunk.trim());
    if (stderr.split(/\r?\n/).includes("priority-probe: ready")) resolveReady();
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      closed = true;
      record(`closed code=${code}`);
      if (code === 0) resolve();
      else reject(new Error(`exit ${code}: ${stderr}`));
    });
  });
  const ready =
    process.platform === "win32"
      ? Promise.race([
          readyMarker,
          exited.then(() => {
            throw new Error("priority probe closed before ready");
          }),
        ])
      : Promise.resolve();
  // Retain diagnostics and reclaim this probe after setup or case failure.
  onTestFailed(() => {
    console.error(`priority probe enabled=${enabled}: ${stages.join("; ")}\n${stderr}`);
  });
  onTestFinished(async () => {
    if (closed) return;
    record("cleanup-started");
    if (child.pid !== undefined) {
      if (process.platform === "win32") {
        const killed = spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "pipe",
          timeout: 2000,
        });
        if (killed.error) record(`cleanup error: ${killed.error.message}`);
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
    }
    // Observe rejection from forced termination, and fail cleanup if the
    // owned pipes remain open after the bounded process-tree termination.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("priority probe cleanup did not close")),
        2000,
      );
      void exited
        .catch(() => {})
        .then(() => {
          clearTimeout(timer);
          resolve();
        });
    });
  });
  return {
    ready,
    runAndAssert: async (checkPriorityBeforeRelease = false) => {
      if (checkPriorityBeforeRelease) {
        const ownedPid = child.pid;
        if (ownedPid === undefined) throw new Error("priority probe missing PID");
        expect(os.getPriority(ownedPid)).toBe(expectedPriority);
      }
      child.stdin.end(() => record("stdin-ended"));
      await exited;
      const observed = JSON.parse(stdout);
      expect(observed.descendantStatus).toBe(0);
      expect(observed.descendantSignal).toBeNull();
      expect(observed.descendantError).toBeNull();
      expect(observed.parent).toBe(expectedPriority);
      expect(observed.descendant).toBe(expectedPriority);
      expect(observed.threads.length).toBeGreaterThan(0);
      expect(observed.threads.every((priority: number) => priority === expectedPriority)).toBe(
        true,
      );
      expect(os.getPriority()).toBe(serverPriority);
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("processRuntime", () => {
  it
    .runIf(process.platform !== "win32")
    .each(["unresolved executable", "missing POSIX shell"] as const)(
    "applies post-spawn priority for a successful direct launch (%s)",
    async (reason) => {
      const resolveExecutable = executable.resolveExecutable;
      vi.spyOn(executable, "resolveExecutable").mockImplementation((command, options) =>
        reason === "unresolved executable" || command === "/bin/sh"
          ? null
          : resolveExecutable(command, options),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(os, "getPriority").mockReturnValue(0);
      const setPriority = vi.spyOn(os, "setPriority").mockImplementation(() => {});
      const child = spawnProcess(process.execPath, ["-e", "process.exit(0)"], {
        lowerPriority: true,
        stdio: "pipe",
      });
      expect(setPriority).toHaveBeenCalledWith(child.pid, 5);
      if (reason === "missing POSIX shell") {
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("/bin/sh is unavailable"));
      } else {
        expect(warn).not.toHaveBeenCalled();
      }
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
      });
    },
  );

  it.runIf(process.platform !== "win32").each(["bare", "absolute"] as const)(
    "preserves spawn ENOENT with priority enabled for a missing %s executable",
    async (kind) => {
      const command =
        kind === "bare"
          ? "synara-missing-priority-test-executable"
          : path.join(os.tmpdir(), "synara-missing-priority-test-executable");
      const serverPriority = os.getPriority();
      const child = spawnProcess(command, [], {
        lowerPriority: true,
        stdio: "pipe",
        env: { ...process.env, PATH: "" },
      });
      const error = await new Promise<NodeJS.ErrnoException>((resolve, reject) => {
        child.once("error", resolve);
        child.once("close", () =>
          reject(new Error("missing executable exited without a spawn error")),
        );
      });
      expect(error.code).toBe("ENOENT");
      expect(error.message).toContain(command);
      expect(child.pid).toBeUndefined();
      expect(os.getPriority()).toBe(serverPriority);
    },
  );

  if (process.platform === "win32") {
    describe.each([false, true])("priority ready fixture (enabled=%s)", (enabled) => {
      let probe: ReturnType<typeof makePriorityProbe> | undefined;

      beforeEach(async () => {
        probe = makePriorityProbe(enabled);
        await probe.ready;
      });

      it(`applies opt-in priority before descendants launch (enabled=${enabled})`, async () => {
        if (probe === undefined) throw new Error("priority probe fixture missing");
        await probe.runAndAssert(true);
      });
    });
  } else {
    it.each([false, true])(
      "applies opt-in priority before descendants launch (enabled=%s)",
      async (enabled) => {
        await makePriorityProbe(enabled).runAndAssert();
      },
    );
  }
  it("runs a normal process and preserves UTF-8 stdout/stderr", async () => {
    await expect(
      run(["-e", "process.stdout.write('ok 日本語'); process.stderr.write('diagnostic €')"]),
    ).resolves.toEqual({ stdout: "ok 日本語", stderr: "diagnostic €", code: 0 });
  });

  it("reports the real non-zero exit code without a shell wrapper", async () => {
    await expect(run(["-e", "process.exit(7)"])).resolves.toEqual({
      stdout: "",
      stderr: "",
      code: 7,
    });
  });

  it.runIf(process.platform !== "win32")(
    "runs intentional shell snippets with the supplied environment",
    () => {
      expect(
        execShellCommandSync('printf "%s" "$MOSS_PROCESS_RUNTIME_TEST"', {
          encoding: "utf8",
          env: { ...process.env, MOSS_PROCESS_RUNTIME_TEST: "shell-ok" },
        }),
      ).toBe("shell-ok");
    },
  );
});
