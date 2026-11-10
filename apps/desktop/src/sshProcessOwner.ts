// FILE: sshProcessOwner.ts
// Purpose: Apply the shared prepared process-tree owner to desktop SSH helpers.
// Layer: Desktop SSH process boundary
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { CapturedProcessTree } from "@moss/shared/processTreeController";
import {
  spawnChildWithPreparedTree,
  teardownChildProcessTree,
  teardownProviderProcessTree,
} from "@moss/shared/supervisedProcessTeardown";

export interface SshProcessOwner {
  readonly spawn: (input: {
    readonly spawn: () => ChildProcessWithoutNullStreams;
    readonly bind: (child: ChildProcessWithoutNullStreams) => ChildProcessWithoutNullStreams;
    readonly beforeSpawn: () => void;
    readonly signal: AbortSignal;
  }) => Promise<ChildProcessWithoutNullStreams>;
  readonly stop: (child: ChildProcessWithoutNullStreams) => Promise<void>;
}

interface Retirement {
  proof: Promise<void>;
  failed: boolean;
  snapshot: CapturedProcessTree | undefined;
}

export function createSshProcessOwner(
  dependencies: {
    readonly spawnPrepared?: typeof spawnChildWithPreparedTree;
    readonly teardownChild?: typeof teardownChildProcessTree;
    readonly teardownCaptured?: typeof teardownProviderProcessTree;
  } = {},
): SshProcessOwner {
  const retirements = new WeakMap<ChildProcessWithoutNullStreams, Retirement>();
  const teardownChild = dependencies.teardownChild ?? teardownChildProcessTree;
  function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
    const previous = retirements.get(child);
    if (previous && !previous.failed) return previous.proof;
    const rootExited = child.exitCode !== null || child.signalCode !== null;
    // Never turn a rejected proof into a fresh traversal of a retired numeric
    // PID. Without an original complete snapshot, absence remains unproven.
    if (previous && rootExited && previous.snapshot?.captureComplete !== true)
      return previous.proof;
    const state: Retirement = previous ?? {
      proof: Promise.resolve(),
      failed: false,
      snapshot: undefined,
    };
    state.failed = false;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const proof = new Promise<void>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    state.proof = proof;
    retirements.set(child, state);
    let action: Promise<unknown>;
    try {
      if (previous && rootExited) {
        const snapshot = state.snapshot!;
        action = (dependencies.teardownCaptured ?? teardownProviderProcessTree)(
          {
            rootPid: child.pid!,
            rootExited: Promise.resolve(),
          },
          {
            captureProcessTree: async () => snapshot,
            isRootRunning: async () => false,
          },
        );
      } else {
        action = teardownChild(child, undefined, {
          onCapturedTree: (tree, capturedBeforeRootExit) => {
            if (previous && !capturedBeforeRootExit) {
              state.snapshot = undefined;
              throw new Error("process-cleanup");
            }
            state.snapshot = tree;
          },
        });
      }
    } catch (error) {
      action = Promise.reject(error);
    }
    void action.then(
      () => resolve(),
      (error) => {
        state.failed = true;
        reject(error);
      },
    );
    return proof;
  }
  return {
    spawn: (input) =>
      (dependencies.spawnPrepared ?? spawnChildWithPreparedTree)({
        ...input,
        bind: (child) => {
          try {
            return input.bind(child);
          } catch (error) {
            void stop(child).catch(() => undefined);
            throw error;
          }
        },
      }),
    stop,
  };
}
export const nativeSshProcessOwner = createSshProcessOwner();
