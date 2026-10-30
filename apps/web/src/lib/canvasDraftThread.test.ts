import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectId, ThreadId, type NativeApi } from "@synara/contracts";
import { promoteCanvasDraftThread } from "./canvasDraftThread";
import { promoteThreadCreate } from "./threadCreatePromotion";
import { useStore } from "../store";
vi.mock("./threadCreatePromotion", () => ({ promoteThreadCreate: vi.fn() }));
vi.mock("../store", () => ({
  useStore: { getState: () => ({ syncServerShellSnapshot: vi.fn() }) },
}));
afterEach(() => vi.resetAllMocks());
const input = {
  threadId: ThreadId.makeUnsafe("draft-a"),
  projectId: ProjectId.makeUnsafe("project-a"),
  creation: {
    modelSelection: { provider: "codex" as const, model: "model-a" },
    envMode: "local" as const,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    workingDirectory: "/selected/workspace",
    lastKnownPr: null,
  },
};
function api() {
  return {
    orchestration: {
      getShellSnapshot: vi.fn(async () => ({ threads: [] })),
      dispatchCommand: vi.fn(),
    },
  } as unknown as NativeApi;
}
describe("Canvas draft conversation promotion", () => {
  it("preserves the selected directory and model without dispatching an agent turn", async () => {
    vi.mocked(promoteThreadCreate).mockResolvedValue("created");
    const native = api();
    expect(await promoteCanvasDraftThread(input, native)).toBe(input.threadId);
    expect(promoteThreadCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.create",
        threadId: input.threadId,
        projectId: input.projectId,
        ...input.creation,
      }),
      native,
    );
    expect(native.orchestration.dispatchCommand).not.toHaveBeenCalled();
    expect(native.orchestration.getShellSnapshot).toHaveBeenCalledTimes(1);
    expect(useStore.getState()).toHaveProperty("syncServerShellSnapshot");
  });
  it("keeps a pending worktree from silently using a different folder", async () => {
    await expect(
      promoteCanvasDraftThread(
        { ...input, creation: { ...input.creation, envMode: "worktree" } },
        api(),
      ),
    ).rejects.toThrow("工作文件夹尚未就绪");
    expect(promoteThreadCreate).not.toHaveBeenCalled();
  });
  it("does not retry an unknown creation result or send the unsent draft", async () => {
    vi.mocked(promoteThreadCreate).mockRejectedValue(new Error("fixture disconnected"));
    const native = api();
    await expect(promoteCanvasDraftThread(input, native)).rejects.toThrow("fixture disconnected");
    expect(promoteThreadCreate).toHaveBeenCalledTimes(1);
    expect(native.orchestration.dispatchCommand).not.toHaveBeenCalled();
  });
});
