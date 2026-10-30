// Pure ordering contract; the actual Gemini native lifecycle tests retain OS exit proof.
import type { ChildProcess } from "node:child_process";

import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import {
  completeObservedChildProcessExit,
  disposeOwnedChildProcess,
  type teardownProviderProcessTree,
} from "./supervisedProcessTeardown.ts";

// Teardown and signalling are injected below; this synthetic handle never reaches the OS.
const child = { pid: 7, exitCode: 0, signalCode: null } as ChildProcess;
const successfulProof = { escalated: false, signalErrors: [] };

describe("owned child disposal platform policy", () => {
  it("preserves POSIX release before the same direct SIGTERM without tree proof", async () => {
    const steps: string[] = [];
    await disposeOwnedChildProcess(child, () => steps.push("release"), {
      platform: "linux",
      teardownProcessTree: async () => {
        throw new Error("POSIX direct disposal must not request tree proof");
      },
      signalOwnedChildProcess: (actualChild, signal) => {
        expect(actualChild).toBe(child);
        expect(signal).toBe("SIGTERM");
        steps.push("SIGTERM");
      },
    });
    expect(steps).toEqual(["release", "SIGTERM"]);
  });

  it("waits for the same Windows tree proof before releasing process resources", async () => {
    const steps: string[] = [];
    let completeProof!: () => void;
    const proof = new Promise<void>((resolve) => {
      completeProof = resolve;
    });
    const teardown: typeof teardownProviderProcessTree = async (input) => {
      expect(input.rootPid).toBe(child.pid);
      steps.push("proof-started");
      await proof;
      steps.push("proof-completed");
      return successfulProof;
    };
    let returned = false;
    const disposal = disposeOwnedChildProcess(child, () => steps.push("release"), {
      platform: "win32",
      teardownProcessTree: teardown,
      signalOwnedChildProcess: () => {
        throw new Error("Windows must use owned tree teardown");
      },
    }).then(() => {
      returned = true;
    });
    expect(steps).toEqual(["proof-started"]);
    expect(returned).toBe(false);
    completeProof();
    await disposal;
    expect(returned).toBe(true);
    expect(steps).toEqual(["proof-started", "proof-completed", "release"]);
  });

  it("preserves a failed Windows proof and leaves resources owned", async () => {
    const error = new Error("synthetic owned proof failure");
    let released = false;
    await expect(
      disposeOwnedChildProcess(
        child,
        () => {
          released = true;
        },
        {
          platform: "win32",
          teardownProcessTree: async () => {
            throw error;
          },
          signalOwnedChildProcess: () => {
            throw new Error("No direct signal fallback is allowed");
          },
        },
      ),
    ).rejects.toBe(error);
    expect(released).toBe(false);
  });

  it("retains POSIX natural-exit handling without executing owner disposal early", async () => {
    let disposed = false;
    await Effect.runPromise(
      completeObservedChildProcessExit(
        Effect.sync(() => {
          disposed = true;
        }),
        "linux",
      ),
    );
    expect(disposed).toBe(false);
  });

  it("awaits owner disposal after a Windows natural exit", async () => {
    let disposed = false;
    const result = await Effect.runPromise(
      completeObservedChildProcessExit(
        Effect.sync(() => {
          disposed = true;
          return 42;
        }),
        "win32",
      ),
    );
    expect(disposed).toBe(true);
    expect(result).toBeUndefined();
  });

  it("preserves the exact owner failure after a Windows natural exit", async () => {
    const error = new Error("synthetic typed owner failure");
    const exit = await Effect.runPromise(
      completeObservedChildProcessExit(Effect.fail(error), "win32").pipe(Effect.exit),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(error);
  });
});
