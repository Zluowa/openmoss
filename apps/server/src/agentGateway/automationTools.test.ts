import {
  AutomationId,
  ProjectId,
  ThreadId,
  type AutomationCreateInput,
  type AutomationDefinition,
  type OrchestrationThreadShell,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { AutomationServiceError } from "../automation/Errors";
import type { AutomationServiceShape } from "../automation/Services/AutomationService";
import { makeAgentGatewayAutomationTools } from "./automationTools";
import type { ToolContext } from "./toolRuntime";

const caller = {
  id: ThreadId.makeUnsafe("caller"),
  projectId: ProjectId.makeUnsafe("project"),
  envMode: "local",
  runtimeMode: "approval-required",
  interactionMode: "default",
  modelSelection: { provider: "codex", instanceId: "codex-personal", model: "gpt-5-codex" },
} as OrchestrationThreadShell;
const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: caller.id,
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: caller.id,
  callerThreadLabel: null,
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["automation:write"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};
function harness() {
  const create = vi.fn<
    (input: AutomationCreateInput) => Effect.Effect<AutomationDefinition, AutomationServiceError>
  >((input) =>
    Effect.succeed({
      ...input,
      id: AutomationId.makeUnsafe("real-service-result"),
      nextRunAt: null,
    } as AutomationDefinition),
  );
  const tools = makeAgentGatewayAutomationTools({
    automationService: { create } as unknown as AutomationServiceShape,
    requireThreadShell: () => Effect.succeed(caller),
    assertCallerMayDriveThread: () => Effect.void,
    resolveAutomationTarget: ({ target }) => Effect.succeed(target),
    surfaceAutomationProposal: () => Effect.void,
  });
  return { create, tool: tools.find((tool) => tool.definition.name === "moss_create_automation")! };
}
const args = {
  name: "Update the page",
  prompt: "Use the existing Pages tools",
  mode: "dedicated",
  enabled: false,
};

describe("automation creation gateway request identities", () => {
  it("advertises the bounded stable request id and forwards it unchanged on retries", async () => {
    const { create, tool } = harness();
    expect(tool.definition.inputSchema.properties).toHaveProperty(
      "requestId",
      expect.objectContaining({ maxLength: 160 }),
    );
    create.mockImplementationOnce(() =>
      Effect.fail(new AutomationServiceError({ message: "Response lost" })),
    );
    const first = await Effect.runPromise(
      tool.handler({ ...args, requestId: "original-cli-request" }, context),
    );
    expect(first.isError).toBe(true);
    const retried = await Effect.runPromise(
      tool.handler({ ...args, requestId: "original-cli-request" }, context),
    );
    expect(retried.isError).not.toBe(true);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      requestId: "original-cli-request",
      sourceThreadId: caller.id,
      enabled: false,
      modelSelection: caller.modelSelection,
    });
  });

  it.each([null, "", " ", 12, "a".repeat(161)])(
    "rejects an invalid explicit identity before calling the service (%s)",
    async (requestId) => {
      const { create, tool } = harness();
      const result = await Effect.runPromise(tool.handler({ ...args, requestId }, context));
      expect(result.isError).toBe(true);
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("keeps legacy callers unkeyed instead of inventing a different id on every retry", async () => {
    const { create, tool } = harness();
    const result = await Effect.runPromise(tool.handler(args, context));
    expect(result.isError).not.toBe(true);
    expect(create.mock.calls[0]?.[0].requestId).toBeUndefined();
  });
});
