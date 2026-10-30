// FILE: ensureProjectId.ts
// Purpose: Resolve a ProjectId for a plugin-panel action (Try in chat / Create).
//          Codex opens a projectless thread seeded with prefillCwd; Moss's
//          handleNewThread requires a project row, so with no active project we
//          bootstrap one from the workspace cwd via the canonical create/recover
//          helper, with the deeper id-based read-model wait Sidebar/ChatView use
//          for the "linked but not-yet-synced" race. Split out from the hook so
//          the orchestration is unit-testable with just the I/O deps mocked.
// Layer: Web orchestration helper
// Exports: ensureProjectId

import type { ModelSelection, ProjectId } from "@synara/contracts";

import { createOrRecoverProjectFromPath } from "~/lib/projectCreation";
import { waitForRecoverableProjectInReadModel } from "~/lib/projectCreateRecovery";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { planProjectResolution, resolveEnsuredProjectId } from "./tryInChatTarget";

export async function ensureProjectId(input: {
  activeProjectId: ProjectId | null;
  cwd: string | null;
  defaultModelSelection: ModelSelection;
}): Promise<ProjectId | null> {
  const plan = planProjectResolution(input);
  if (plan.kind === "use-existing") return plan.projectId;
  if (plan.kind === "abort") return null;
  const api = readNativeApi();
  if (!api) return null;
  const loadSnapshot = () => api.orchestration.getShellSnapshot().catch(() => null);
  const result = await createOrRecoverProjectFromPath({
    api,
    workspaceRoot: plan.workspaceRoot,
    // The cwd is an existing server/project folder — never fabricate a directory.
    createIfMissing: false,
    defaultModelSelection: input.defaultModelSelection,
    loadSnapshot,
  });
  if (result.snapshot) useStore.getState().syncServerShellSnapshot(result.snapshot);
  const direct = resolveEnsuredProjectId(result);
  if (direct) return direct;
  // The folder is already linked but its project row hasn't synced into the read
  // model yet (duplicate-recovery lag). Do the deeper id-based wait Sidebar/ChatView
  // use before giving up, so the thread still opens instead of a false failure.
  const recovered = await waitForRecoverableProjectInReadModel({
    projectId: result.projectId,
    loadSnapshot,
  });
  if (recovered.snapshot) useStore.getState().syncServerShellSnapshot(recovered.snapshot);
  return recovered.project?.id ?? null;
}
