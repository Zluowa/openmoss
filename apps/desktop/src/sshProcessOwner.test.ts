// FILE: sshProcessOwner.test.ts
// Purpose: Prove cleanup retries preserve original process identities and never target retired roots.
// Layer: Desktop SSH process tests
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  createProcessTreeKiller,
  type CapturedProcessTree,
} from "@moss/shared/processTreeController";
import { teardownProviderProcessTree } from "@moss/shared/supervisedProcessTeardown";
import { createSshProcessOwner } from "./sshProcessOwner";

function childHandle() {
  const handle = { pid: 50, exitCode: null as number | null, signalCode: null };
  return { handle, child: handle as unknown as ChildProcessWithoutNullStreams };
}
describe("SSH original ownership cleanup retry", () => {
  it("rechecks the retained tree and leaves a reused PID and retired root untouched", async () => {
    const { handle, child } = childHandle();
    const old = { pid: 51, command: "owned-proxy", startedAt: "2026-11-07T00:00:00.000001Z" };
    const reused = { pid: 52, command: "owned-proxy", startedAt: "2026-11-07T00:00:00.000002Z" };
    const snapshot: CapturedProcessTree = { descendants: [old, reused], captureComplete: true };
    const current = new Map([
      [51, old],
      [52, { ...reused, startedAt: "2026-11-07T00:00:01.000002Z" }],
    ]);
    const signalPid = vi.fn((pid: number) => {
      current.delete(pid);
      return null;
    });
    const signalTree = vi.fn((_pid, _signal, callback) => callback());
    const killer = createProcessTreeKiller({
      platform: "win32",
      readCurrentProcesses: () => current,
      signalPid,
      signalTree,
    });
    const capture = vi.fn();
    const owner = createSshProcessOwner({
      teardownChild: async (_child, _teardown, options) => {
        options!.onCapturedTree!(snapshot, true);
        capture();
        handle.exitCode = 0;
        throw new Error("transient inspection failure");
      },
      teardownCaptured: (input, dependencies) =>
        teardownProviderProcessTree(input, {
          ...dependencies,
          platform: "win32",
          processTreeKiller: killer,
        }),
    });
    await expect(owner.stop(child)).rejects.toThrow("transient");
    signalPid.mockClear();
    await owner.stop(child);
    expect(capture).toHaveBeenCalledOnce();
    expect(signalPid).toHaveBeenCalledWith(51, "SIGTERM");
    expect(signalPid.mock.calls.some(([pid]) => pid === 50 || pid === 52)).toBe(false);
    expect(signalTree).not.toHaveBeenCalled();
    expect(current.has(52)).toBe(true);
  });

  it("does not invent a new ownership tree when capture was missing and the root is gone", async () => {
    const { handle, child } = childHandle();
    const capture = vi.fn(async () => {
      handle.exitCode = 1;
      throw new Error("snapshot unavailable");
    });
    const owner = createSshProcessOwner({ teardownChild: capture });
    const first = owner.stop(child);
    await expect(first).rejects.toThrow("snapshot unavailable");
    expect(owner.stop(child)).toBe(first);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("vetoes a fresh retry capture if the original live root exits during the query", async () => {
    const { handle, child } = childHandle();
    let attempts = 0;
    const owner = createSshProcessOwner({
      teardownChild: async (_child, _teardown, options) => {
        attempts++;
        if (attempts === 1) {
          options!.onCapturedTree!({ descendants: [], captureComplete: false }, true);
          throw new Error("temporary query failure");
        }
        handle.exitCode = 1;
        options!.onCapturedTree!(
          { descendants: [{ pid: 60, command: "unrelated" }], captureComplete: true },
          false,
        );
        throw new Error("must not reach signalling");
      },
    });
    await expect(owner.stop(child)).rejects.toThrow("temporary");
    const retry = owner.stop(child);
    await expect(retry).rejects.toThrow("process-cleanup");
    expect(owner.stop(child)).toBe(retry);
    expect(attempts).toBe(2);
  });
});
