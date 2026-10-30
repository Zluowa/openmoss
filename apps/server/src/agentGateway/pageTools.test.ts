import { ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { PagesServiceError, type PagesServiceShape } from "../pages/Services/PagesService";
import { makePageTools } from "./pageTools";
import { GatewayToolError, type ToolContext } from "./toolRuntime";

function harness() {
  const read = vi.fn<PagesServiceShape["read"]>(() =>
    Effect.fail(new PagesServiceError({ code: "not-found", message: "No fixture page" })),
  );
  const mutate = vi.fn<PagesServiceShape["mutate"]>(() =>
    Effect.fail(
      new PagesServiceError({ code: "conflict", message: "Page changed", currentRevision: 7 }),
    ),
  );
  const service: PagesServiceShape = {
    spaces: () => Effect.succeed({ spaces: [] }),
    list: () => Effect.succeed({ pages: [] }),
    read,
    mutate,
    versions: () => Effect.succeed({ versions: [] }),
    comments: () => Effect.succeed({ comments: [] }),
  };
  const tools = makePageTools({ pages: service });
  const context: ToolContext = {
    principal: {
      kind: "provider-session",
      sessionKey: "trusted-session",
      threadId: "trusted-thread",
      provider: "codex",
      turnId: "turn",
    },
    callerThreadId: "trusted-thread",
    callerThreadLabel: "Current conversation",
    callerSessionKey: "trusted-session",
    callerProvider: "codex",
    callerCapabilities: new Set(["thread:read", "thread:write"]),
    callerTurnId: "turn",
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
  return {
    tools,
    context,
    read,
    mutate,
    byName: new Map(tools.map((tool) => [tool.definition.name, tool])),
  };
}

describe("shared Pages gateway catalog", () => {
  it("uses the same capability-gated surface for all supported provider callers", () => {
    const h = harness();
    expect(h.tools.map((tool) => tool.definition.name)).toEqual([
      "moss_pages_spaces",
      "moss_pages_list",
      "moss_pages_read",
      "moss_pages_versions",
      "moss_pages_comments",
      "moss_pages_mutate",
    ]);
    expect(h.tools.slice(0, 5).every((tool) => tool.requiredCapability === "thread:read")).toBe(
      true,
    );
    expect(h.byName.get("moss_pages_mutate")?.requiredCapability).toBe("thread:write");
    expect(h.byName.get("moss_pages_mutate")?.requiresActiveTurn).toBe(true);
  });

  it("takes authorship and scope authority from the gateway context, never a supplied principal", async () => {
    const h = harness();
    await Effect.runPromise(
      h.byName.get("moss_pages_read")!.handler(
        {
          scopeSpaceId: null,
          pageId: "page",
          principal: { kind: "local-user" },
          callerThreadId: "victim",
        },
        h.context,
      ),
    );
    expect(h.read).toHaveBeenCalledExactlyOnceWith(
      { scopeSpaceId: null, pageId: "page" },
      { kind: "agent", threadId: ThreadId.makeUnsafe("trusted-thread") },
    );
  });

  it("rejects missing CAS revisions and over-limit bodies before a write reaches storage", async () => {
    const h = harness();
    const tool = h.byName.get("moss_pages_mutate")!;
    const missing = await Effect.runPromise(
      tool.handler(
        { op: "update", requestId: "r", scopeSpaceId: null, pageId: "page", content: "unsafe" },
        h.context,
      ),
    );
    expect(missing.isError).toBe(true);
    const oversized = await Effect.runPromise(
      tool.handler(
        {
          op: "create-space",
          requestId: "r",
          scopeSpaceId: null,
          title: "Space",
          content: "x".repeat(2_000_001),
        },
        h.context,
      ),
    );
    expect(oversized.isError).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it("checks the active turn even for a direct handler call and reports structured conflicts", async () => {
    const h = harness();
    const args = {
      op: "pin",
      requestId: "r",
      scopeSpaceId: null,
      pageId: "page",
      expectedRevision: 1,
      pinned: true,
    };
    const tool = h.byName.get("moss_pages_mutate")!;
    const inactive = await Effect.runPromise(
      tool.handler(args, {
        ...h.context,
        assertCallerTurnActive: () =>
          Effect.fail(new GatewayToolError("inactive_turn", "Turn ended")),
      }),
    );
    expect(inactive.isError).toBe(true);
    expect(h.mutate).not.toHaveBeenCalled();
    const conflict = await Effect.runPromise(tool.handler(args, h.context));
    expect(conflict.isError).toBe(true);
    expect(conflict.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(
          { error: { code: "conflict", message: "Page changed", currentRevision: 7 } },
          null,
          2,
        ),
      },
    ]);
  });

  it("carries canonical rich content and explicit conversion through the same shared tool", async () => {
    const h = harness();
    const tool = h.byName.get("moss_pages_mutate")!;
    const richContent = JSON.stringify([
      { type: "future-widget", children: [{ text: "Keep structure" }] },
    ]);
    await Effect.runPromise(
      tool.handler(
        {
          op: "update",
          requestId: "rich",
          scopeSpaceId: null,
          pageId: "page",
          expectedRevision: 1,
          richContent,
        },
        h.context,
      ),
    );
    expect(h.mutate.mock.calls[0]?.[0]).toMatchObject({ op: "update", richContent });
    await Effect.runPromise(
      tool.handler(
        {
          op: "update",
          requestId: "plain",
          scopeSpaceId: null,
          pageId: "page",
          expectedRevision: 1,
          richContent: null,
          content: "Explicit Markdown",
        },
        h.context,
      ),
    );
    expect(h.mutate.mock.calls[1]?.[0]).toMatchObject({
      op: "update",
      richContent: null,
      content: "Explicit Markdown",
    });
    expect(tool.definition.inputSchema.properties).toHaveProperty("richContent");
  });
});
