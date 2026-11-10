import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@moss/contracts";
import { matchesLegacyHomeChatWorkspaceRoot } from "@moss/shared/projectContainers";
import { isScratchWorkspacePath, workspaceRootsEqual } from "@moss/shared/threadWorkspace";
import { Effect, Option } from "effect";

import { resolveThreadWorkspaceCwd } from "./checkpointing/Utils";
import type { ServerConfigShape } from "./config";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  ensureIsolatedScratchWorkspace,
  findExistingThreadScratchWorkspace,
} from "./scratchWorkspaces";

type ThreadWorkspaceRow = Pick<
  OrchestrationThreadShell,
  "id" | "projectId" | "envMode" | "worktreePath" | "workingDirectory"
>;
type ProjectWorkspaceRow = Pick<OrchestrationProjectShell, "id" | "kind" | "workspaceRoot">;

function datedChatFolder(root: string, candidate: string): boolean {
  const parts = path.relative(root, candidate).split(path.sep);
  return parts.length === 2 && /^\d{4}-\d{2}-\d{2}$/u.test(parts[0]!) && Boolean(parts[1]);
}

async function canonicalChatDirectory(root: string, folder: string): Promise<string | undefined> {
  if (!path.isAbsolute(folder) || !datedChatFolder(root, folder)) return undefined;
  for (const dir of [root, path.dirname(folder), folder]) {
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  }
  const canonicalRoot = await realpath(root);
  const canonicalFolder = await realpath(folder);
  return workspaceRootsEqual(
    path.relative(root, folder),
    path.relative(canonicalRoot, canonicalFolder),
  )
    ? canonicalFolder
    : undefined;
}

/** Execution and file tools can use a chat's own folder. Git checkpoints keep their separate policy. */
export function resolveThreadExecutionWorkspace(input: {
  readonly thread: ThreadWorkspaceRow;
  readonly project: ProjectWorkspaceRow;
  readonly config: Pick<ServerConfigShape, "chatWorkspaceRoot" | "homeDir">;
  readonly query: Pick<ProjectionSnapshotQueryShape, "getOriginalThreadIdByProjectId">;
}) {
  return Effect.gen(function* () {
    const { thread, project, config } = input;
    if (thread.projectId !== project.id || (thread.envMode === "worktree" && !thread.worktreePath))
      return undefined;
    const selected = resolveThreadWorkspaceCwd({ thread, projects: [project] });
    const scratch = () => Effect.sync(() => ensureIsolatedScratchWorkspace(thread.id));
    const shared = (value: string) => matchesLegacyHomeChatWorkspaceRoot(value, config);
    if (selected && !shared(selected) && !isScratchWorkspacePath(selected)) {
      const canonical = yield* Effect.promise(() => realpath(selected).catch(() => selected));
      const relative = path.relative(config.chatWorkspaceRoot, canonical);
      const underChatDate = /^\d{4}-\d{2}-\d{2}(?:[\\/]|$)/u.test(relative);
      if (!underChatDate && !shared(canonical) && !isScratchWorkspacePath(canonical))
        return selected;
    }
    if (selected && isScratchWorkspacePath(selected)) return yield* scratch();
    if (
      project.kind !== "chat" ||
      !datedChatFolder(config.chatWorkspaceRoot, project.workspaceRoot)
    ) {
      return shared(project.workspaceRoot) || project.kind === "chat" || selected
        ? yield* scratch()
        : undefined;
    }
    // Existing scratch conversations keep their files and native continuation on the same path.
    const old = yield* Effect.sync(() => findExistingThreadScratchWorkspace(thread.id));
    if (old) return old;
    const owner = yield* input.query
      .getOriginalThreadIdByProjectId(project.id)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.getOrUndefined(owner) !== thread.id) return yield* scratch();
    if (selected && !workspaceRootsEqual(selected, project.workspaceRoot)) return yield* scratch();
    const directory = yield* Effect.promise(() =>
      canonicalChatDirectory(config.chatWorkspaceRoot, project.workspaceRoot).catch(
        () => undefined,
      ),
    );
    return directory ?? (yield* scratch());
  });
}
