// Resolve Canvas storage from the same trusted thread workspace as agent tools.
// Renderer input supplies only a thread identity, never a filesystem root.
import { lstat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Effect, Option } from "effect";
import { ThreadId } from "@synara/contracts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { resolveThreadWorkspaceCwd } from "./checkpointing/Utils";
import { MossMediaJobsError } from "./mossMediaJobsService";

export interface MossCanvasWorkspace {
  readonly threadId: string;
  readonly cwd: string;
  readonly title: string;
}
export function mossCanvasWorkspaceFingerprint(workspace: MossCanvasWorkspace): string {
  return createHash("sha256")
    .update(JSON.stringify([workspace.threadId, workspace.cwd]))
    .digest("hex");
}

export const resolveMossCanvasWorkspace = (threadId: string) =>
  Effect.gen(function* () {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId))
      return yield* Effect.fail(new MossMediaJobsError("invalid_canvas_thread"));
    const available = yield* Effect.serviceOption(ProjectionSnapshotQuery);
    if (Option.isNone(available))
      return yield* Effect.fail(new MossMediaJobsError("canvas_workspace_unavailable", 503));
    const query = available.value;
    const thread = yield* query.getThreadShellById(ThreadId.makeUnsafe(threadId));
    if (Option.isNone(thread) || thread.value.id !== threadId)
      return yield* Effect.fail(new MossMediaJobsError("canvas_thread_not_found", 404));
    const project = yield* query.getProjectShellById(thread.value.projectId);
    if (Option.isNone(project))
      return yield* Effect.fail(new MossMediaJobsError("canvas_workspace_unavailable", 404));
    const selected = resolveThreadWorkspaceCwd({ thread: thread.value, projects: [project.value] });
    if (!selected) return yield* Effect.fail(new MossMediaJobsError("workspace_required"));
    const cwd = yield* Effect.tryPromise({
      try: async () => {
        const canonical = await realpath(selected);
        if (!(await lstat(canonical)).isDirectory()) throw new Error("invalid_workspace");
        return canonical;
      },
      catch: () => new MossMediaJobsError("canvas_workspace_unavailable", 409),
    });
    return { threadId, cwd, title: thread.value.title || "会话画布" } satisfies MossCanvasWorkspace;
  });
