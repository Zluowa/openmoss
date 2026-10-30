// Promote the selected conversation before Canvas opens, without dispatching a turn.
import type { NativeApi, ProjectId, ThreadId } from "@synara/contracts";
import type { TerminalThreadCreationState } from "./threadBootstrap";
import { promoteThreadCreate } from "./threadCreatePromotion";
import { newCommandId } from "./utils";
import { useStore } from "../store";

export async function promoteCanvasDraftThread(
  input: { threadId: ThreadId; projectId: ProjectId; creation: TerminalThreadCreationState },
  api: NativeApi,
): Promise<ThreadId> {
  if (input.creation.envMode === "worktree" && !input.creation.worktreePath)
    throw new Error("工作文件夹尚未就绪，请稍后重试。");
  const result = await promoteThreadCreate(
    {
      type: "thread.create",
      commandId: newCommandId(),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "New thread",
      ...input.creation,
      createdAt: new Date().toISOString(),
    },
    api,
  );
  if (result === "unavailable") throw new Error("画布连接暂不可用，请稍后重试。");
  useStore.getState().syncServerShellSnapshot(await api.orchestration.getShellSnapshot());
  return input.threadId;
}
