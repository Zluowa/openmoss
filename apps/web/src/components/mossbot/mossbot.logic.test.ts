import { describe, expect, it } from "vitest";
import {
  ProjectId,
  ThreadId,
  SUPPORTED_PROVIDER_KINDS,
  type ProjectAgentSummary,
} from "@moss/contracts";
import {
  buildMossbotConfigureInput,
  isMossbot,
  mossbotStatus,
  resolveMossbotForThread,
} from "./mossbot.logic";

describe("Mossbot provider selection", () => {
  it.each(SUPPORTED_PROVIDER_KINDS)("preserves the %s CLI, account and model", (provider) => {
    const selection = { provider, instanceId: `${provider}-personal`, model: "my-model" };
    const input = buildMossbotConfigureInput({
      projectId: ProjectId.makeUnsafe("bot-1"),
      requestId: "req-1",
      name: "  My assistant  ",
      instructions: "Help with research.",
      modelSelection: selection,
    });
    expect(input.coordinatorModelSelection).toEqual(selection);
    expect(input.workerRouting?.modelSelection).toEqual(selection);
    expect(input.agentKind).toBe("mossbot");
    expect(input.coordinatorName).toBe("My assistant");
    expect(input.coordinatorIcon).toBe("mossbot-pebble");
    expect(input.autoMemoryEnabled).toBe(true);
    expect(input.workerRouting?.environment).toBe("local");
    expect(input.workerRouting?.runtimeMode).not.toBe("full-access");
  });

  it("requires a name and persona before creating anything", () => {
    expect(() =>
      buildMossbotConfigureInput({
        projectId: ProjectId.makeUnsafe("bot"),
        requestId: "r",
        name: " ",
        instructions: "help",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
      }),
    ).toThrow("name");
  });

  it("preserves the selected model's native options for the assistant and its workers", () => {
    const selection = {
      provider: "codex" as const,
      model: "gpt-5.1-codex-mini",
      instanceId: "codex-personal",
      options: { reasoningEffort: "low" as const },
    };
    const input = buildMossbotConfigureInput({
      projectId: ProjectId.makeUnsafe("bot-options"),
      requestId: "options",
      name: "Atlas",
      instructions: "Help me plan.",
      modelSelection: selection,
      avatar: "mossbot-orbit",
    });
    expect(input.coordinatorModelSelection).toEqual(selection);
    expect(input.coordinatorIcon).toBe("mossbot-orbit");
    expect(input.workerRouting?.modelSelection).toEqual(selection);
  });

  it("keeps a linked-project worker in its personal assistant, without claiming ordinary threads", () => {
    const id = ProjectId.makeUnsafe("bot");
    const coordinator = ThreadId.makeUnsafe("coordinator");
    const worker = ThreadId.makeUnsafe("worker");
    const summary: ProjectAgentSummary = {
      projectId: id,
      agentKind: "mossbot",
      configured: true,
      coordinatorName: "Nova",
      coordinatorThreadId: coordinator,
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "idle",
      revision: 1,
      memberThreadIds: [worker],
    };
    const summaries = new Map([[id, summary]]);
    expect(resolveMossbotForThread({ projectId: id, threadId: coordinator, summaries })).toBe(
      summary,
    );
    expect(
      resolveMossbotForThread({
        projectId: ProjectId.makeUnsafe("linked-repo"),
        threadId: worker,
        summaries,
      }),
    ).toBe(summary);
    expect(
      resolveMossbotForThread({
        projectId: ProjectId.makeUnsafe("linked-repo"),
        threadId: ThreadId.makeUnsafe("ordinary"),
        summaries,
      }),
    ).toBeNull();
  });

  it("classifies only explicitly persisted personal assistants", () => {
    expect(isMossbot(undefined)).toBe(false);
    expect(isMossbot({})).toBe(false);
    expect(isMossbot({ agentKind: "hub" })).toBe(false);
    expect(isMossbot({ agentKind: "mossbot" })).toBe(true);
  });

  it("prioritizes pause and pending human input over a working label", () => {
    const summary: ProjectAgentSummary = {
      projectId: ProjectId.makeUnsafe("bot"),
      configured: true,
      coordinatorName: "Mossbot",
      coordinatorThreadId: null,
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "running",
      revision: 1,
    };
    expect(mossbotStatus(summary)).toBe("Working");
    expect(mossbotStatus({ ...summary, pausedAt: "2026-11-05T00:00:00Z" })).toBe("Paused");
    expect(mossbotStatus({ ...summary, needsYouThreadIds: ["waiting" as never] })).toBe(
      "Needs you",
    );
  });
});
