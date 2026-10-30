// FILE: openUIReferenceTool.test.ts
// Purpose: Contract for the `openui_reference` gateway tool and the generated
//          catalog it serves.

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  OPENUI_CHAT_REFERENCE,
  OPENUI_CHAT_REFERENCE_EXAMPLES,
} from "./openUIChatReference.generated.ts";
import {
  makeAgentGatewayOpenUIReferenceTool,
  OPENUI_REFERENCE_TOOL_DESCRIPTION,
  OPENUI_REFERENCE_TOOL_NAME,
} from "./openUIReferenceTool.ts";
import type { ToolContext } from "./toolRuntime.ts";

function makeContext(): ToolContext {
  return {
    principal: {
      kind: "provider-session",
      sessionKey: "session-caller",
      threadId: "thread-caller",
      provider: "codex",
      turnId: "turn-caller",
    },
    callerThreadId: "thread-caller",
    callerThreadLabel: null,
    callerSessionKey: "session-caller",
    callerProvider: "codex",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn-caller",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

describe("openui_reference agent tool", () => {
  it("is a read-only catalog lookup any thread reader may call", () => {
    const tool = makeAgentGatewayOpenUIReferenceTool();
    expect(tool.requiredCapability).toBe("thread:read");
    expect(tool.requiresActiveTurn).toBeUndefined();
    expect(tool.definition.name).toBe(OPENUI_REFERENCE_TOOL_NAME);
    expect(tool.definition.annotations?.readOnlyHint).toBe(true);
    expect(tool.definition.annotations?.destructiveHint).toBe(false);
    // The description is the discovery surface: it must say when to call and
    // what the catalog contains.
    expect(OPENUI_REFERENCE_TOOL_DESCRIPTION).toContain("before authoring your first");
    expect(OPENUI_REFERENCE_TOOL_DESCRIPTION).toContain("positional signature");
  });

  it("serves the core catalog by default and the worked examples on demand", async () => {
    const tool = makeAgentGatewayOpenUIReferenceTool();
    const core = await Effect.runPromise(tool.handler({}, makeContext()));
    expect(core.content).toEqual([{ type: "text", text: OPENUI_CHAT_REFERENCE }]);
    const examples = await Effect.runPromise(tool.handler({ section: "examples" }, makeContext()));
    expect(examples.content).toEqual([{ type: "text", text: OPENUI_CHAT_REFERENCE_EXAMPLES }]);
    // The default answer must be materially smaller — it exists to survive
    // tool-result truncation that previously cut the catalog mid-signature.
    expect(OPENUI_CHAT_REFERENCE.length).toBeLessThan(50_000);
    expect(OPENUI_CHAT_REFERENCE_EXAMPLES.length).toBeGreaterThan(10_000);
  });
});

describe("generated OpenUI chat reference", () => {
  it("carries the Moss inline-chat contract instead of the stock whole-response intro", () => {
    expect(OPENUI_CHAT_REFERENCE).toContain("fenced ```openui code block");
    expect(OPENUI_CHAT_REFERENCE).toContain("root = Card(...)");
    expect(OPENUI_CHAT_REFERENCE).not.toContain(
      "Your ENTIRE response must be valid openui-lang code",
    );
  });

  it("contains the syntax rules, component signatures, and the examples pointer", () => {
    expect(OPENUI_CHAT_REFERENCE).toContain("## Syntax Rules");
    expect(OPENUI_CHAT_REFERENCE).toContain("## Component Signatures");
    // Worked examples moved to the on-demand section; the core points at it.
    expect(OPENUI_CHAT_REFERENCE).toContain('"section": "examples"');
    expect(OPENUI_CHAT_REFERENCE_EXAMPLES).toContain("Example 1 —");
    for (const component of ["Card", "Table", "BarChart", "Form", "FollowUpBlock"]) {
      expect(OPENUI_CHAT_REFERENCE).toContain(`${component}(`);
    }
    // Sanity bounds: the core catalog is tens of thousands of chars — a
    // truncated regeneration must fail here, not at the model.
    expect(OPENUI_CHAT_REFERENCE.length).toBeGreaterThan(25_000);
    expect(OPENUI_CHAT_REFERENCE.length).toBeLessThan(120_000);
  });
});
