import "~/index.css";
import { ProjectId, ThreadId, type ProjectAgentOverview } from "@moss/contracts";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  configure: vi.fn(),
  getOverview: vi.fn(),
  deleteGroup: vi.fn(),
}));
vi.mock("~/lib/groupProjects", () => ({ createGroupProject: mocks.createProject }));
vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({
    projectAgent: {
      configure: mocks.configure,
      getOverview: mocks.getOverview,
      deleteGroup: mocks.deleteGroup,
    },
  }),
  ensureNativeApi: () => ({
    projectAgent: {
      configure: mocks.configure,
      getOverview: mocks.getOverview,
      deleteGroup: mocks.deleteGroup,
    },
  }),
}));
vi.mock("~/components/chat/group/GroupModelEffortRow", () => ({
  GroupModelRow: () => <div>Configured CLI selector</div>,
}));

import { MossbotCreateDialog } from "./MossbotCreateDialog";

function result(): ProjectAgentOverview {
  return {
    projectId: ProjectId.makeUnsafe("personal-1"),
    configured: true,
    config: {
      agentKind: "mossbot",
      projectId: ProjectId.makeUnsafe("personal-1"),
      coordinatorThreadId: ThreadId.makeUnsafe("thread-1"),
      coordinatorName: "Personal assistant",
      coordinatorModelSelection: {
        provider: "hermes",
        model: "my-model",
        instanceId: "hermes-private",
      },
      limits: {
        maxConcurrentWorkers: 2,
        maxNewWorkersPerTurn: 2,
        maxWorkerCreationsPerGoal: 8,
        maxAutomaticContinuationsPerGoal: 4,
        maxRepairRoundsPerTask: 1,
      },
      enabled: true,
      captureEnabled: true,
      automationId: null,
      revision: 1,
      createdAt: "2026-11-05T00:00:00Z",
      updatedAt: "2026-11-05T00:00:00Z",
      disabledAt: null,
    },
    goal: null,
    digest: null,
    linkedProjectIds: [],
    blockers: [],
    recentOutcomes: [],
    coordinatorStatus: "idle",
  };
}

function setup() {
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <MossbotCreateDialog
      open
      templateId="personal"
      defaultModelSelection={{
        provider: "hermes",
        model: "my-model",
        instanceId: "hermes-private",
      }}
      workspacePath="/tmp/mossbot"
      onCreated={onCreated}
      onClose={onClose}
    />,
  );
  return { onCreated, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createProject.mockResolvedValue(ProjectId.makeUnsafe("personal-1"));
  mocks.configure.mockResolvedValue(result());
  mocks.getOverview.mockResolvedValue(result());
  mocks.deleteGroup.mockResolvedValue({ deletedProjectId: "personal-1" });
});

it("saves an original avatar with the chosen CLI without changing the persona", async () => {
  setup();
  await page.getByRole("button", { name: "Orbit", exact: true }).click();
  await page.getByRole("button", { name: "Create assistant", exact: true }).click();
  await expect.poll(() => mocks.configure.mock.calls.length).toBe(1);
  expect(mocks.configure.mock.calls[0]?.[0]).toMatchObject({
    coordinatorIcon: "mossbot-orbit",
    coordinatorModelSelection: {
      provider: "hermes",
      instanceId: "hermes-private",
      model: "my-model",
    },
    agentKind: "mossbot",
  });
});

describe("Mossbot creation", () => {
  it("retries a lost response with the same workspace and receipt, preserving CLI identity", async () => {
    mocks.configure.mockRejectedValueOnce(new Error("Connection interrupted"));
    const { onCreated } = setup();
    await page.getByRole("button", { name: "Create assistant", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not create this assistant.");
    await page.getByRole("button", { name: "Create assistant", exact: true }).click();
    await expect.poll(() => onCreated.mock.calls.length).toBe(1);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    const first = mocks.configure.mock.calls[0]![0];
    const retry = mocks.configure.mock.calls[1]![0];
    expect(retry.requestId).toBe(first.requestId);
    expect(retry.projectId).toBe(first.projectId);
    expect(retry.coordinatorModelSelection).toEqual({
      provider: "hermes",
      model: "my-model",
      instanceId: "hermes-private",
    });
    expect(retry.agentKind).toBe("mossbot");
  });

  it("recovers an already-created assistant before closing after a lost response", async () => {
    mocks.configure.mockRejectedValue(new Error("Response lost"));
    const { onCreated } = setup();
    await page.getByRole("button", { name: "Create assistant", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not create this assistant.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => onCreated.mock.calls.length).toBe(1);
    expect(mocks.deleteGroup).not.toHaveBeenCalled();
  });

  it("cleans up only a verified empty setup when cancelled", async () => {
    mocks.configure.mockRejectedValue(new Error("Provider unavailable"));
    mocks.getOverview.mockResolvedValue({ ...result(), configured: false, config: null });
    const { onClose } = setup();
    await page.getByRole("button", { name: "Create assistant", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not create this assistant.");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.poll(() => onClose.mock.calls.length).toBe(1);
    expect(mocks.deleteGroup).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "personal-1", requireEmpty: true }),
    );
  });
});
