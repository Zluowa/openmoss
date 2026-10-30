/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { Effect, ServiceMap } from "effect";

import { CheckpointInvariantError, type CheckpointStoreError } from "../Errors.ts";
import { CheckpointRef, type ThreadId } from "@synara/contracts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /**
   * Treat an already-existing ref as success and skip the capture.
   *
   * Used for pre-turn baseline refs where the first snapshot must win:
   * overwriting an existing baseline with a later capture would record a
   * working tree the agent may already have modified.
   */
  readonly skipIfExists?: boolean;
}

export interface CopyCheckpointRefInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

/** A single capture bound to the current repository-inspection callback. */
export type PreparedCheckpointCapture = (
  input: Omit<CaptureCheckpointInput, "cwd">,
) => Effect.Effect<void, CheckpointStoreError>;

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  /** Exact immutable provider patch; reconstruct only from fromCheckpointRef in a private index. */
  readonly providerPatch?: string;
  readonly maxOutputBytes?: number;
}

export interface ReverseCheckpointDiffInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly maxOutputBytes?: number;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
  /** Purge all revision refs owned by this thread, including crash-orphaned captures. */
  readonly liveThreadId?: ThreadId;
}

/**
 * CheckpointStoreShape - Service API for checkpoint capture/restore and diff access.
 */
export interface CheckpointStoreShape {
  /**
   * Check whether cwd is inside a Git worktree.
   */
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Optionally reuse one repository inspection for a capture in the callback.
   * The bound capture can be used once before the callback completes. Stores
   * and decorators without this batching capability use the helper's ordinary
   * isGitRepository/captureCheckpoint fallback.
   */
  readonly withCaptureRepository?: <A, E, R>(
    cwd: string,
    use: (capture: PreparedCheckpointCapture | null) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | CheckpointStoreError, R>;

  /**
   * Capture a checkpoint commit and store it at the provided checkpoint ref.
   *
   * Uses an isolated temporary Git index and writes a hidden ref.
   */
  readonly captureCheckpoint: (
    input: CaptureCheckpointInput,
  ) => Effect.Effect<void, CheckpointStoreError>;

  /**
   * Copy an existing checkpoint commit to another hidden ref.
   *
   * Used to bind a pre-send message snapshot to the provider turn id once known.
   */
  readonly copyCheckpointRef: (
    input: CopyCheckpointRefInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Check whether a checkpoint ref exists.
   */
  readonly hasCheckpointRef: (
    input: Omit<RestoreCheckpointInput, "fallbackToHead">,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Restore workspace/staging state to a checkpoint.
   *
   * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
   */
  readonly restoreCheckpoint: (
    input: RestoreCheckpointInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Compute patch diff between two checkpoint refs.
   *
   * Can optionally treat missing "from" ref as `HEAD`.
   */
  readonly diffCheckpoints: (
    input: DiffCheckpointsInput,
  ) => Effect.Effect<string, CheckpointStoreError>;

  /**
   * Reverse only the changes between two checkpoints onto the current workspace.
   */
  readonly reverseCheckpointDiff: (
    input: ReverseCheckpointDiffInput,
  ) => Effect.Effect<boolean, CheckpointStoreError>;

  /**
   * Delete the provided checkpoint refs.
   *
   * Missing refs are tolerated (deleting an absent ref is a no-op for Git), but
   * a ref that exists and could not be deleted fails the effect: callers use
   * this to protect snapshots that are a user's only way back.
   */
  readonly deleteCheckpointRefs: (
    input: DeleteCheckpointRefsInput,
  ) => Effect.Effect<void, CheckpointStoreError>;
}

export const usePreparedCheckpointCapture = <A, E, R>(
  capture: PreparedCheckpointCapture | null,
  use: (capture: PreparedCheckpointCapture | null) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CheckpointStoreError, R> =>
  Effect.suspend(() => {
    if (capture === null) return use(null);
    let active = true;
    let used = false;
    const scopedCapture: PreparedCheckpointCapture = (input) =>
      Effect.suspend(() => {
        if (!active || used) {
          return Effect.fail(
            new CheckpointInvariantError({
              operation: "CheckpointStore.withCaptureRepository",
              detail: "A prepared repository capture can only be used once within its callback.",
            }),
          );
        }
        used = true;
        return capture(input);
      });
    return Effect.suspend(() => use(scopedCapture)).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          active = false;
        }),
      ),
    );
  });

export const withCheckpointCaptureRepository = <A, E, R>(
  store: CheckpointStoreShape,
  cwd: string,
  use: (capture: PreparedCheckpointCapture | null) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | CheckpointStoreError, R> =>
  store.withCaptureRepository
    ? store.withCaptureRepository(cwd, use)
    : store
        .isGitRepository(cwd)
        .pipe(
          Effect.flatMap((isRepository) =>
            usePreparedCheckpointCapture(
              isRepository ? (input) => store.captureCheckpoint({ ...input, cwd }) : null,
              use,
            ),
          ),
        );

/**
 * CheckpointStore - Service tag for checkpoint persistence and restore operations.
 */
export class CheckpointStore extends ServiceMap.Service<CheckpointStore, CheckpointStoreShape>()(
  "moss/checkpointing/Services/CheckpointStore",
) {}
