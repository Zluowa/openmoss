/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import {
  Cause,
  Deferred,
  Effect,
  Encoding,
  Exit,
  Layer,
  FileSystem,
  Option,
  Path,
  Semaphore,
} from "effect";

import { CheckpointInvariantError, type CheckpointStoreError } from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import {
  CheckpointStore,
  usePreparedCheckpointCapture,
  type CaptureCheckpointInput,
  type CheckpointStoreShape,
} from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@synara/contracts";
import { CHECKPOINT_REFS_PREFIX } from "../Utils.ts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;

// Individual git commands are already bounded by GitCore's default timeout;
// this aggregate cap exists to unstick the shared in-flight capture slot if a
// step without its own bound (e.g. temp-dir filesystem work) hangs. It exceeds
// the worst per-command-capped chain, so it never truncates a capture the
// per-command timeouts would allow.
const CHECKPOINT_CAPTURE_TIMEOUT_MS = 180_000;

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  const captureLock = yield* Semaphore.make(1);
  const inFlightCaptures = new Map<string, Deferred.Deferred<void, CheckpointStoreError>>();

  // Normalize the cwd so captures for the same repo reached via differently
  // written paths (trailing slash, relative segments) share one in-flight slot.
  const captureKey = (input: { readonly cwd: string; readonly checkpointRef: CheckpointRef }) =>
    `${path.resolve(input.cwd)}\0${input.checkpointRef}`;

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const resolveWorkingIndexPath = (cwd: string) =>
    Effect.gen(function* () {
      const indexPathResult = yield* git.execute({
        operation: "CheckpointStore.resolveWorkingIndex",
        cwd,
        args: ["rev-parse", "--git-path", "index"],
        allowNonZeroExit: true,
      });
      const indexPathRaw = indexPathResult.stdout.trim();
      if (indexPathResult.code !== 0 || indexPathRaw.length === 0) {
        return null;
      }

      return path.isAbsolute(indexPathRaw) ? indexPathRaw : path.resolve(cwd, indexPathRaw);
    });

  const seedCheckpointIndex = (indexPath: string | null, tempIndexPath: string) =>
    Effect.gen(function* () {
      if (indexPath === null) {
        return null;
      }
      const indexExists = yield* fs.exists(indexPath).pipe(Effect.orElseSucceed(() => false));
      if (!indexExists) {
        return null;
      }

      // Preserve Git's stat cache in the throwaway index. Starting every
      // checkpoint from `read-tree HEAD` discards it, forcing `git add -A` to
      // rescan and re-hash the whole worktree before every user turn.
      const indexInfo = yield* fs.stat(indexPath);
      yield* fs.copyFile(indexPath, tempIndexPath);
      return indexInfo;
    });

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const captureCheckpointOnce = (
    input: CaptureCheckpointInput,
    preparedIndexPath?: string | null,
  ) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.captureCheckpoint";

      // Both probes are read-only and belong to this single-flight owner.
      // Overlap the optional existence check with index-path resolution, but
      // defer even the temporary index copy until a capture is necessary.
      const [existingCommit, indexPathExit] = yield* Effect.all(
        [
          input.skipIfExists
            ? resolveCheckpointCommit(input.cwd, input.checkpointRef)
            : Effect.succeed(null),
          Effect.exit(
            preparedIndexPath === undefined
              ? resolveWorkingIndexPath(input.cwd)
              : Effect.succeed(preparedIndexPath),
          ),
        ],
        { concurrency: "unbounded" },
      );
      if (existingCommit !== null) {
        return;
      }
      if (Exit.isFailure(indexPathExit)) {
        return yield* Effect.failCause(indexPathExit.cause);
      }

      yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "moss-fs-checkpoint-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const commitEnv: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
              GIT_AUTHOR_NAME: "Moss",
              GIT_AUTHOR_EMAIL: "moss@users.noreply.github.com",
              GIT_COMMITTER_NAME: "Moss",
              GIT_COMMITTER_EMAIL: "moss@users.noreply.github.com",
            };

            const workingIndexInfo = yield* seedCheckpointIndex(indexPathExit.value, tempIndexPath);
            if (workingIndexInfo === null && (yield* hasHeadCommit(input.cwd))) {
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["read-tree", "HEAD"],
                env: commitEnv,
              });
            }
            if (workingIndexInfo !== null) {
              // A copied index can describe a rapid same-size rewrite as clean
              // when its cached stat tuple still matches. Really-refresh makes
              // Git verify those racily-clean entries and leaves changed paths
              // for the following add to hash, without discarding the cache for
              // the rest of a large workspace.
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["update-index", "--really-refresh"],
                env: commitEnv,
                allowNonZeroExit: true,
              });

              // Copying or refreshing the temporary index advances its file
              // timestamp. Git uses that timestamp to decide whether an entry
              // whose cached stat tuple still matches is "racily clean" and
              // needs hashing. Restore the working index's original timestamp
              // so rapid same-size rewrites remain newer than (or equal to) the
              // index snapshot and `git add` verifies their contents.
              if (workingIndexInfo.mtime !== undefined) {
                yield* fs.utimes(
                  tempIndexPath,
                  workingIndexInfo.atime ?? workingIndexInfo.mtime,
                  workingIndexInfo.mtime,
                );
              }
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["add", "-A", "--", "."],
              env: commitEnv,
            });

            const writeTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["write-tree"],
              env: commitEnv,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty tree oid.",
              });
            }

            const message = `Moss checkpoint ref=${input.checkpointRef}`;
            const commitTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["commit-tree", treeOid, "-m", message],
              env: commitEnv,
            });
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git commit-tree",
                cwd: input.cwd,
                detail: "git commit-tree returned an empty commit oid.",
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["update-ref", input.checkpointRef, commitOid],
            });
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(
              new CheckpointInvariantError({
                operation: "CheckpointStore.captureCheckpoint",
                detail: "Failed to capture checkpoint.",
                cause: error,
              }),
            ),
        }),
      );
    });

  const captureCheckpointWithIndex = (
    input: CaptureCheckpointInput,
    preparedIndexPath?: string | null,
  ) =>
    Effect.gen(function* () {
      const key = captureKey(input);
      const registration = yield* captureLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = inFlightCaptures.get(key);
          if (existing) {
            return { owner: false as const, deferred: existing };
          }
          const deferred = yield* Deferred.make<void, CheckpointStoreError>();
          inFlightCaptures.set(key, deferred);
          return { owner: true as const, deferred };
        }),
      );

      if (!registration.owner) {
        return yield* Deferred.await(registration.deferred);
      }

      // Let the git capture remain interruptible, but always notify waiters
      // and clear the shared in-flight slot before this owner fiber exits.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            restore(
              captureCheckpointOnce(input, preparedIndexPath).pipe(
                Effect.timeoutOption(CHECKPOINT_CAPTURE_TIMEOUT_MS),
                Effect.flatMap((completed) =>
                  Option.isSome(completed)
                    ? Effect.void
                    : Effect.fail(
                        new CheckpointInvariantError({
                          operation: "CheckpointStore.captureCheckpoint",
                          detail: `Checkpoint capture timed out after ${CHECKPOINT_CAPTURE_TIMEOUT_MS}ms.`,
                        }),
                      ),
                ),
              ),
            ),
          );
          // Waiters joined an in-flight capture they do not control; replaying the
          // owner's raw interrupt cause would make callers treat it as their own
          // fiber being interrupted. Surface a typed error instead.
          const waiterExit =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Exit.fail(
                  new CheckpointInvariantError({
                    operation: "CheckpointStore.captureCheckpoint",
                    detail: "Checkpoint capture was interrupted before completion.",
                  }),
                )
              : exit;
          yield* Deferred.done(registration.deferred, waiterExit);
          yield* captureLock.withPermits(1)(Effect.sync(() => inFlightCaptures.delete(key)));
          if (Exit.isFailure(exit)) {
            return yield* Effect.failCause(exit.cause);
          }
        }),
      );
    });

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    captureCheckpointWithIndex(input);

  const withCaptureRepository: NonNullable<CheckpointStoreShape["withCaptureRepository"]> = (
    cwd,
    use,
  ) =>
    Effect.gen(function* () {
      const repository = yield* git
        .execute({
          operation: "CheckpointStore.withCaptureRepository",
          cwd,
          args: ["rev-parse", "--is-inside-work-tree", "--git-path", "index"],
          allowNonZeroExit: true,
        })
        .pipe(
          Effect.map((result) => {
            const separator = result.stdout.indexOf("\n");
            if (
              result.code !== 0 ||
              separator < 0 ||
              result.stdout.slice(0, separator).trim() !== "true"
            ) {
              return null;
            }
            const rawIndexPath = result.stdout.slice(separator + 1).trim();
            return rawIndexPath.length > 0
              ? path.isAbsolute(rawIndexPath)
                ? rawIndexPath
                : path.resolve(cwd, rawIndexPath)
              : null;
          }),
          Effect.catch(() => Effect.succeed(null)),
        );
      if (repository === null) {
        return yield* use(null);
      }

      // The inspected index path belongs only to this operation and cwd. Never
      // cache it across turns, repository replacement, or callback completion.
      return yield* usePreparedCheckpointCapture(
        (input) => captureCheckpointWithIndex({ ...input, cwd }, repository),
        use,
      );
    });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const copyCheckpointRef: CheckpointStoreShape["copyCheckpointRef"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.copyCheckpointRef";
      const commitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["update-ref", input.toCheckpointRef, commitOid],
      });
      return true;
    });

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreCheckpoint";

      // Both probes are read-only. Resolve the optional fallback alongside the
      // checkpoint rather than paying another process startup after a miss.
      const [checkpointCommit, headCommitExit] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.checkpointRef),
          Effect.exit(
            input.fallbackToHead === true ? resolveHeadCommit(input.cwd) : Effect.succeed(null),
          ),
        ],
        { concurrency: "unbounded" },
      );
      let commitOid = checkpointCommit;
      if (commitOid === null) {
        if (Exit.isFailure(headCommitExit)) {
          return yield* Effect.failCause(headCommitExit.cause);
        }
        commitOid = headCommitExit.value;
      }

      if (!commitOid) {
        return false;
      }

      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
      });
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["clean", "-fd", "--", "."],
      });

      // Peeling to a commit fails before touching the index on an unborn branch.
      // Bare HEAD is special-cased by Git reset as an empty tree there.
      // Probe that exceptional case only after a failed reset, keeping normal
      // restores to one process and observing HEAD after the filesystem work.
      const resetArgs = ["reset", "--quiet", "HEAD^{commit}", "--", "."];
      const resetResult = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: resetArgs,
        allowNonZeroExit: true,
      });
      if (resetResult.code !== 0 && (yield* hasHeadCommit(input.cwd))) {
        const command = `git ${resetArgs.join(" ")}`;
        const stderr = resetResult.stderr.trim();
        return yield* new GitCommandError({
          operation,
          command,
          cwd: input.cwd,
          detail:
            stderr.length > 0
              ? `${command} failed: ${stderr}`
              : `${command} failed with code ${resetResult.code}.`,
        });
      }

      return true;
    });

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpoints";

      if (input.providerPatch !== undefined) {
        const baseline = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
        if (
          !baseline ||
          Buffer.byteLength(input.providerPatch, "utf8") > CHECKPOINT_DIFF_MAX_OUTPUT_BYTES
        ) {
          return yield* new CheckpointInvariantError({
            operation,
            detail: "Provider patch baseline or size is unavailable.",
          });
        }
        if (input.providerPatch.length === 0) return "";
        // Reconstruct the immutable provider revision in a fresh index. Never
        // seed from today's index/files or ask apply to merge a mismatched base.
        return yield* Effect.acquireUseRelease(
          fs.makeTempDirectory({ prefix: "moss-provider-patch-" }),
          (tempDir) =>
            Effect.gen(function* () {
              const env = { ...process.env, GIT_INDEX_FILE: path.join(tempDir, "index") };
              const patchPath = path.join(tempDir, "provider.patch");
              yield* fs.writeFileString(patchPath, input.providerPatch!);
              yield* git.execute({ operation, cwd: input.cwd, args: ["read-tree", baseline], env });
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["apply", "--cached", "--whitespace=nowarn", "--", patchPath],
                env,
              });
              const result = yield* git.execute({
                operation,
                cwd: input.cwd,
                args: [
                  "diff",
                  "--cached",
                  "--patch",
                  "--minimal",
                  "--no-color",
                  "--no-ext-diff",
                  "--no-textconv",
                  "--src-prefix=a/",
                  "--dst-prefix=b/",
                  ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
                  baseline,
                ],
                env,
                maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
              });
              return result.stdout;
            }),
          (tempDir) => fs.remove(tempDir, { recursive: true }).pipe(Effect.orDie),
        ).pipe(
          Effect.mapError((cause) =>
            cause instanceof GitCommandError || cause instanceof CheckpointInvariantError
              ? cause
              : new CheckpointInvariantError({
                  operation,
                  detail: "Could not prepare a private provider patch index.",
                  cause,
                }),
          ),
        );
      }

      let [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          fromCommitOid,
          toCommitOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });

      return result.stdout;
    });

  // Rolls the working tree back to `treeOid` for the provided paths without
  // touching the repository index: paths absent from the tree did not exist
  // before the aborted apply, so they are deleted instead of restored.
  const restoreWorktreePathsFromTree = (input: {
    readonly cwd: string;
    readonly treeOid: string;
    readonly paths: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.restoreWorktreePathsFromTree";
      if (input.paths.length === 0) {
        return;
      }

      const trackedResult = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["ls-tree", "-r", "--name-only", "-z", input.treeOid, "--", ...input.paths],
        allowNonZeroExit: true,
      });
      const trackedPaths = trackedResult.stdout.split("\0").filter((entry) => entry.length > 0);
      if (trackedPaths.length > 0) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["restore", "--source", input.treeOid, "--worktree", "--", ...trackedPaths],
        });
      }

      const trackedPathSet = new Set(trackedPaths);
      yield* Effect.forEach(
        input.paths.filter((entry) => !trackedPathSet.has(entry)),
        (relativePath) => fs.remove(path.join(input.cwd, relativePath), { force: true }),
        { discard: true },
      );
    });

  // Fallback for undo when the working tree drifted after the checkpoint: a
  // plain `git apply --reverse` is all-or-nothing, so any unrelated edit in a
  // touched hunk aborts the whole undo.
  //
  // `git apply --3way` implies `--index` and therefore refuses to run while the
  // working tree differs from the index. Point it at a throwaway index that
  // mirrors the current working tree so the merge can run; the repository index
  // stays untouched and the caller's `git reset` remains its only writer.
  const applyReverseWithThreeWayMerge = (input: {
    readonly cwd: string;
    readonly tempDir: string;
    readonly patchPath: string;
    readonly affectedPaths: ReadonlyArray<string>;
    readonly strictApplyStderr: string;
  }) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reverseCheckpointDiff";
      const mergeIndexEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: path.join(input.tempDir, `undo-index-${randomUUID()}`),
      };

      const headExists = yield* hasHeadCommit(input.cwd);
      if (headExists) {
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["read-tree", "HEAD"],
          env: mergeIndexEnv,
        });
      }
      yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["add", "-A", "--", "."],
        env: mergeIndexEnv,
      });
      // Snapshot of the pre-attempt working tree, used to undo a conflicted
      // 3-way apply (which writes conflict markers before failing).
      const preAttemptTreeResult = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["write-tree"],
        env: mergeIndexEnv,
      });
      const preAttemptTreeOid = preAttemptTreeResult.stdout.trim();

      const applied = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["apply", "--reverse", "--3way", "--whitespace=nowarn", "--", input.patchPath],
        env: mergeIndexEnv,
        allowNonZeroExit: true,
      });
      if (applied.code === 0) {
        return;
      }

      if (preAttemptTreeOid.length > 0) {
        yield* restoreWorktreePathsFromTree({
          cwd: input.cwd,
          treeOid: preAttemptTreeOid,
          paths: input.affectedPaths,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to roll back a conflicted checkpoint undo", {
              cwd: input.cwd,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      }

      return yield* new GitCommandError({
        operation,
        command: "git apply --reverse --3way",
        cwd: input.cwd,
        detail: [
          "Undo could not be applied because the workspace changed since this checkpoint.",
          input.strictApplyStderr.trim(),
          applied.stderr.trim(),
        ]
          .filter((part) => part.length > 0)
          .join(" "),
      });
    });

  const reverseCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.reverseCheckpointDiff";
      const [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid || !toCommitOid) {
        return false;
      }

      const diff = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--binary",
          "--full-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          fromCommitOid,
          toCommitOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      if (diff.stdout.length === 0) {
        return true;
      }

      const changedPaths = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: ["diff", "--name-only", "--no-renames", "-z", fromCommitOid, toCommitOid],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });
      const affectedPaths = changedPaths.stdout.split("\0").filter((entry) => entry.length > 0);

      return yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "moss-checkpoint-undo-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const patchPath = path.join(tempDir, "turn.patch");
            yield* fs.writeFileString(patchPath, diff.stdout);
            const strictApply = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["apply", "--reverse", "--whitespace=nowarn", "--", patchPath],
              allowNonZeroExit: true,
            });
            if (strictApply.code !== 0) {
              yield* applyReverseWithThreeWayMerge({
                cwd: input.cwd,
                tempDir,
                patchPath,
                affectedPaths,
                strictApplyStderr: strictApply.stderr,
              });
            }
            if (affectedPaths.length > 0) {
              const resetExit = yield* Effect.exit(
                git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["reset", "--quiet", fromCommitOid, "--", ...affectedPaths],
                }),
              );
              if (Exit.isFailure(resetExit)) {
                yield* git.execute({
                  operation,
                  cwd: input.cwd,
                  args: ["apply", "--whitespace=nowarn", "--", patchPath],
                });
                return yield* Effect.failCause(resetExit.cause);
              }
            }
            return true;
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTag("PlatformError", (error) =>
          Effect.fail(
            new CheckpointInvariantError({
              operation,
              detail: "Failed to prepare the checkpoint patch for undo.",
              cause: error,
            }),
          ),
        ),
      );
    });

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.deleteCheckpointRefs";

      const checkpointRefs = new Set(input.checkpointRefs);
      if (input.liveThreadId !== undefined) {
        // Projection rows identify the published revision only. Enumeration at
        // thread purge also releases captures interrupted before publication.
        const prefix = `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(input.liveThreadId)}/turn-live/`;
        const liveRefs = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["for-each-ref", "--format=%(refname)", prefix],
        });
        for (const line of liveRefs.stdout.split("\n")) {
          const ref = line.trim();
          if (ref.startsWith(prefix)) checkpointRefs.add(CheckpointRef.makeUnsafe(ref));
        }
      }

      // Ref deletion writes contend on packed-refs.lock, so a concurrent delete
      // can lose the lock race. `allowNonZeroExit` keeps one loser from
      // abandoning the rest of the batch, but the exit codes must still be
      // inspected: silently discarding them made every caller's cleanup error
      // handling unreachable. Deleting an already-absent ref exits 0, so the
      // "missing refs are tolerated" contract is unaffected.
      const results = yield* Effect.forEach(checkpointRefs, (checkpointRef) =>
        git
          .execute({
            operation,
            cwd: input.cwd,
            args: ["update-ref", "-d", checkpointRef],
            allowNonZeroExit: true,
          })
          .pipe(Effect.map((result) => ({ checkpointRef, result }))),
      );

      const failures = results.filter((entry) => entry.result.code !== 0);
      if (failures.length === 0) {
        return;
      }

      return yield* new GitCommandError({
        operation,
        command: "git update-ref -d",
        cwd: input.cwd,
        detail: `Failed to delete ${failures.length} of ${results.length} checkpoint ref(s): ${failures
          .map(
            (entry) =>
              `${entry.checkpointRef} (${entry.result.stderr.trim() || `exit code ${entry.result.code}`})`,
          )
          .join("; ")}`,
      });
    });

  return {
    isGitRepository,
    withCaptureRepository,
    captureCheckpoint,
    copyCheckpointRef,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    reverseCheckpointDiff,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
