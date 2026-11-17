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
  navigate: vi.fn(),
}));
vi.mock("~/lib/groupProjects", () => ({ createGroupProject: mocks.createProject }));
vi.mock("~/nativeApi", () => {
  const api = {
    projectAgent: {
      configure: mocks.configure,
      getOverview: mocks.getOverview,
      deleteGroup: mocks.deleteGroup,
    },
  };
  return { readNativeApi: () => api, ensureNativeApi: () => api };
});
vi.mock("~/components/chat/group/GroupModelEffortRow", () => ({
  GroupModelRow: () => <div>Configured CLI selector</div>,
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: {} }),
  resolveNewConversationDefaultModelSelection: () => ({
    provider: "hermes",
    model: "my-model",
    instanceId: "hermes-private",
  }),
}));

import { MossbotOnboarding } from "./MossbotOnboarding";
import { useMossbotPreferencesStore } from "~/mossbotPreferencesStore";

function overview(): ProjectAgentOverview {
  return {
    projectId: ProjectId.makeUnsafe("bot-1"),
    configured: true,
    config: {
      agentKind: "mossbot",
      projectId: ProjectId.makeUnsafe("bot-1"),
      coordinatorThreadId: ThreadId.makeUnsafe("thread-1"),
      coordinatorName: "Sage",
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
      createdAt: "2026-11-18T00:00:00Z",
      updatedAt: "2026-11-18T00:00:00Z",
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

const heading = (name: string) => page.getByRole("heading", { name, exact: true });
const button = (name: string) => page.getByRole("button", { name, exact: true });

async function setup() {
  const onLeave = vi.fn();
  await page.viewport(1000, 760);
  render(
    <div style={{ width: 1000, height: 760, display: "flex" }}>
      <MossbotOnboarding onLeave={onLeave} />
    </div>,
  );
  return { onLeave };
}

/** Walk from the first step to the model step, naming the assistant and picking a colour and a purpose. */
async function walkToModel() {
  await expect.element(heading("Meet your Moss assistant")).toBeVisible();
  await button("Next").click();
  await expect.element(heading("It works for you, and asks before what matters")).toBeVisible();
  await button("Next").click();
  await expect.element(heading("Each assistant takes care of one thing")).toBeVisible();
  await button("Next").click();
  await expect.element(heading("Give it a name")).toBeVisible();
  const name = page.getByLabelText("Name", { exact: true });
  await name.fill("");
  await expect.element(button("Next")).toBeDisabled();
  await name.fill("Sage");
  await button("Ochre").click();
  await expect.element(button("Ochre")).toHaveAttribute("aria-pressed", "true");
  await button("Next").click();
  await expect.element(heading("What should it help you with most?")).toBeVisible();
  await page.getByRole("radio", { name: /Research partner/ }).click();
  await button("Next").click();
  await expect.element(heading("Choose the model it thinks with")).toBeVisible();
  await expect.element(page.getByText("Configured CLI selector")).toBeVisible();
}

beforeEach(() => {
  vi.clearAllMocks();
  useMossbotPreferencesStore.setState({ onboardingSkipped: false });
  mocks.createProject.mockResolvedValue(ProjectId.makeUnsafe("bot-1"));
  mocks.configure.mockResolvedValue(overview());
  mocks.getOverview.mockResolvedValue(overview());
  mocks.deleteGroup.mockResolvedValue({ deletedProjectId: "bot-1" });
});

describe("Mossbot onboarding", () => {
  it("walks the steps, creates the assistant it described and opens its chat", async () => {
    const { onLeave } = await setup();
    await walkToModel();
    await button("Create assistant").click();
    await expect.element(heading("All set")).toBeVisible();
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(mocks.configure.mock.calls[0]?.[0]).toMatchObject({
      agentKind: "mossbot",
      coordinatorName: "Sage",
      coordinatorIcon: "mossbot-pebble",
      coordinatorColor: "amber",
      coordinatorModelSelection: {
        provider: "hermes",
        model: "my-model",
        instanceId: "hermes-private",
      },
    });
    expect(JSON.stringify(mocks.configure.mock.calls[0]?.[0])).toContain("research partner");
    await expect.element(page.getByText(/Hi, I'm Sage\./)).toBeVisible();
    // The companion sits on the stage, painted and sized, not a hidden node.
    const companion = document.querySelector<HTMLElement>(".mbo-bot [data-mossbot-companion]")!;
    expect(companion.getBoundingClientRect().width).toBeGreaterThan(60);
    await button("Start chatting").click();
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/$threadId",
      params: { threadId: "thread-1" },
    });
  });

  it("keeps the setup on a failed creation and retries the same operation", async () => {
    mocks.configure.mockRejectedValueOnce(new Error("Connection interrupted"));
    await setup();
    await walkToModel();
    await button("Create assistant").click();
    await expect.element(heading("Setup didn't finish")).toBeVisible();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("Could not create this assistant.");
    await button("Try again").click();
    await expect.element(heading("All set")).toBeVisible();
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    const [first, retry] = mocks.configure.mock.calls.map((call) => call[0]);
    expect(retry.requestId).toBe(first.requestId);
    expect(retry.projectId).toBe(first.projectId);
  });

  it("skipping leaves nothing behind and remembers the choice", async () => {
    const { onLeave } = await setup();
    await button("Skip intro").click();
    await expect.poll(() => onLeave.mock.calls.length).toBe(1);
    expect(useMossbotPreferencesStore.getState().onboardingSkipped).toBe(true);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });
});
