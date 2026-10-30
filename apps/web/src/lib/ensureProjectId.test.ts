import type { ModelSelection, ProjectId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock only the I/O boundary of ensureProjectId so the orchestration (bootstrap +
// deeper read-model recovery) is exercised without the real store / WS.
const syncServerShellSnapshot = vi.fn();
const readNativeApi = vi.fn();
const createOrRecoverProjectFromPath = vi.fn();
const waitForRecoverableProjectInReadModel = vi.fn();

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => readNativeApi(),
  ensureNativeApi: () => ({}),
}));
vi.mock("~/store", () => ({
  useStore: { getState: () => ({ syncServerShellSnapshot }) },
}));
vi.mock("~/lib/projectCreation", () => ({
  createOrRecoverProjectFromPath: (arg: unknown) => createOrRecoverProjectFromPath(arg),
}));
vi.mock("~/lib/projectCreateRecovery", () => ({
  waitForRecoverableProjectInReadModel: (arg: unknown) => waitForRecoverableProjectInReadModel(arg),
}));

const { ensureProjectId } = await import("./ensureProjectId");

const pid = (v: string) => v as ProjectId;
const DEFAULT_MODEL_SELECTION = {
  provider: "codex",
  instanceId: "codex_moss",
  model: "gpt-5.6",
} satisfies ModelSelection;
const fakeApi = { orchestration: { getShellSnapshot: vi.fn().mockResolvedValue({}) } };

beforeEach(() => {
  readNativeApi.mockReturnValue(fakeApi);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("ensureProjectId", () => {
  it("reuses the active project without hitting the API", async () => {
    expect(
      await ensureProjectId({
        activeProjectId: pid("p1"),
        cwd: "/w",
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toBe("p1");
    expect(createOrRecoverProjectFromPath).not.toHaveBeenCalled();
  });

  it("aborts (null) with no project and no usable cwd", async () => {
    expect(
      await ensureProjectId({
        activeProjectId: null,
        cwd: null,
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toBeNull();
    expect(
      await ensureProjectId({
        activeProjectId: null,
        cwd: "/",
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toBeNull();
    expect(readNativeApi).not.toHaveBeenCalled();
  });

  it("bootstraps a project from the cwd when there is none (the direct-open case)", async () => {
    const snapshot = { projects: [] };
    createOrRecoverProjectFromPath.mockResolvedValue({
      projectId: pid("pB"),
      project: { id: pid("pB") },
      snapshot,
      created: true,
    });
    expect(
      await ensureProjectId({
        activeProjectId: null,
        cwd: "/work/dir",
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toBe("pB");
    // never fabricates a directory from a discovery cwd
    expect(createOrRecoverProjectFromPath).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: "/work/dir",
        createIfMissing: false,
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    );
    expect(syncServerShellSnapshot).toHaveBeenCalledWith(snapshot);
  });

  it("recovers a linked-but-unsynced project via the deeper read-model wait", async () => {
    createOrRecoverProjectFromPath.mockResolvedValue({
      projectId: pid("pC"),
      project: null, // duplicate exists server-side but not yet in the snapshot
      snapshot: null,
      created: false,
    });
    const snapshot2 = { projects: [{ id: "pC" }] };
    waitForRecoverableProjectInReadModel.mockResolvedValue({
      project: { id: pid("pC") },
      snapshot: snapshot2,
    });
    expect(
      await ensureProjectId({
        activeProjectId: null,
        cwd: "/work/dir",
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toBe("pC");
    expect(waitForRecoverableProjectInReadModel).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: pid("pC") }),
    );
    expect(syncServerShellSnapshot).toHaveBeenCalledWith(snapshot2);
  });

  it("returns null when even the deeper recovery cannot materialize the project", async () => {
    createOrRecoverProjectFromPath.mockResolvedValue({
      projectId: pid("pD"),
      project: null,
      snapshot: null,
      created: false,
    });
    waitForRecoverableProjectInReadModel.mockResolvedValue({ project: null, snapshot: null });
    expect(
      await ensureProjectId({
        activeProjectId: null,
        cwd: "/work/dir",
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toBeNull();
  });

  it("returns null when the native API is unavailable", async () => {
    readNativeApi.mockReturnValue(undefined);
    expect(
      await ensureProjectId({
        activeProjectId: null,
        cwd: "/work/dir",
        defaultModelSelection: DEFAULT_MODEL_SELECTION,
      }),
    ).toBeNull();
  });
});
