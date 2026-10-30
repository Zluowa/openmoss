import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

type ChildState = {
  readonly pid: number | undefined;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
};
type KillProcessGroup = (
  command: unknown,
  child: ChildState,
  signal: NodeJS.Signals,
) => Effect.Effect<void, unknown>;

const serverRequire = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const platformEntry = serverRequire.resolve("@effect/platform-node/NodeChildProcessSpawner");
const spawnerPath = realpathSync(
  createRequire(platformEntry).resolve("@effect/platform-node-shared/NodeChildProcessSpawner"),
);
const source = readFileSync(spawnerPath, "utf8");
const functionStart = source.indexOf("  const killProcessGroup = ");
const functionEnd = source.indexOf("  const killProcess = ", functionStart);
if (functionStart < 0 || functionEnd <= functionStart) {
  throw new Error("Installed Effect process-group cleanup boundary could not be located");
}

function processGroupHarness(platform: "win32" | "linux" | "darwin", deferTaskkill = false) {
  let finishTaskkill: ((error: Error | null) => void) | undefined;
  const execFile = vi.fn(
    (
      _file: string,
      _args: ReadonlyArray<string>,
      _options: { windowsHide: boolean },
      callback: (error: Error | null) => void,
    ) => {
      finishTaskkill = callback;
      if (!deferTaskkill) callback(null);
    },
  );
  const signalGroup = vi.fn();
  // Run the installed function itself with inert OS boundaries. This exercises
  // both platform branches without sending a signal to any real process.
  const killProcessGroup = runInNewContext(
    `${source.slice(functionStart, functionEnd)}\nkillProcessGroup`,
    {
      Effect,
      NodeChildProcess: { execFile },
      globalThis: { process: { platform, kill: signalGroup } },
      toError: (error: unknown) => error,
      toPlatformError: (_method: string, error: unknown) => error,
    },
  ) as KillProcessGroup;
  return {
    execFile,
    signalGroup,
    killProcessGroup,
    finishTaskkill: () => finishTaskkill?.(null),
  };
}

const command = { _tag: "StandardCommand", command: "git", args: ["status"] };

describe("installed Effect process-group cleanup", () => {
  it.each([0, 1, 128])("does not taskkill an exited Windows child with code %s", async (code) => {
    const harness = processGroupHarness("win32");
    await Effect.runPromise(
      harness.killProcessGroup(command, { pid: 1234, exitCode: code, signalCode: null }, "SIGTERM"),
    );
    expect(harness.execFile).not.toHaveBeenCalled();
    expect(harness.signalGroup).not.toHaveBeenCalled();
  });

  it("does not taskkill a Windows child that has already exited by signal", async () => {
    const harness = processGroupHarness("win32");
    await Effect.runPromise(
      harness.killProcessGroup(
        command,
        { pid: 1234, exitCode: null, signalCode: "SIGTERM" },
        "SIGTERM",
      ),
    );
    expect(harness.execFile).not.toHaveBeenCalled();
    expect(harness.signalGroup).not.toHaveBeenCalled();
  });

  it("waits for taskkill completion when cancelling a running Windows child", async () => {
    const harness = processGroupHarness("win32", true);
    let settled = false;
    const cleanup = Effect.runPromise(
      harness.killProcessGroup(command, { pid: 1234, exitCode: null, signalCode: null }, "SIGTERM"),
    ).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(harness.execFile).toHaveBeenCalledTimes(1));
    expect(harness.execFile).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "1234", "/T", "/F"],
      { windowsHide: true },
      expect.any(Function),
    );
    expect(settled).toBe(false);
    harness.finishTaskkill();
    await cleanup;
    expect(settled).toBe(true);
    expect(harness.signalGroup).not.toHaveBeenCalled();
  });

  it.each(["linux", "darwin"] as const)(
    "still signals a %s process group after its leader exits",
    async (platform) => {
      const harness = processGroupHarness(platform);
      await Effect.runPromise(
        harness.killProcessGroup(command, { pid: 1234, exitCode: 1, signalCode: null }, "SIGTERM"),
      );
      expect(harness.signalGroup).toHaveBeenCalledExactlyOnceWith(-1234, "SIGTERM");
      expect(harness.execFile).not.toHaveBeenCalled();
    },
  );

  for (const platform of ["win32", "linux"] as const) {
    it.each([undefined, 0, -1, Number.NaN])(
      `does not turn invalid PID %s into a ${platform} cleanup target`,
      async (pid) => {
        const harness = processGroupHarness(platform);
        await Effect.runPromise(
          harness.killProcessGroup(command, { pid, exitCode: null, signalCode: null }, "SIGTERM"),
        );
        expect(harness.execFile).not.toHaveBeenCalled();
        expect(harness.signalGroup).not.toHaveBeenCalled();
      },
    );
  }
});
