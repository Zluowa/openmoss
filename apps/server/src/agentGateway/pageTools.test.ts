import { ThreadId } from "@moss/contracts";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { PageDraftsServiceShape } from "../pages/drafts/Services/PageDraftsService";
import { PagesServiceError, type PagesServiceShape } from "../pages/Services/PagesService";
import { makePageTools, normalizePagesMutateArgs } from "./pageTools";
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
    textComments: () => Effect.succeed({ comments: [] }),
    textCommentMutate: () => Effect.succeed({ ok: true }),
    outputs: () => Effect.succeed({ outputs: [] }),
    outputState: () => Effect.void,
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
      "moss_pages_outline",
      "moss_pages_versions",
      "moss_pages_comments",
      "moss_pages_mutate",
    ]);
    expect(h.tools.slice(0, 6).every((tool) => tool.requiredCapability === "thread:read")).toBe(
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

  // The calls a model made in the owner's run (Pi session 2026-11-04T15-49-19-807Z),
  // which client-side schema validation rejected before Moss ever saw them.
  it("advertises no required field a model can leave out", () => {
    const h = harness();
    for (const name of ["moss_pages_spaces", "moss_pages_list"]) {
      const schema = h.byName.get(name)!.definition.inputSchema as { required?: string[] };
      expect(schema.required ?? []).toEqual([]);
    }
    expect(
      (h.byName.get("moss_pages_read")!.definition.inputSchema as { required?: string[] }).required,
    ).toEqual(["pageId"]);
    const mutate = h.byName.get("moss_pages_mutate")!.definition.inputSchema as {
      required?: string[];
      allOf?: unknown;
    };
    expect(mutate.required).toEqual(["op", "requestId"]);
    expect(mutate.allOf).toBeUndefined();
  });

  it("treats an absent scope as the default domain for every read", async () => {
    const h = harness();
    const result = await Effect.runPromise(
      h.byName.get("moss_pages_spaces")!.handler({}, h.context),
    );
    expect(result.isError).not.toBe(true);
    const list = await Effect.runPromise(h.byName.get("moss_pages_list")!.handler({}, h.context));
    expect(list.isError).not.toBe(true);
    await Effect.runPromise(
      h.byName.get("moss_pages_read")!.handler({ pageId: "page" }, h.context),
    );
    expect(h.read).toHaveBeenCalledWith(
      { scopeSpaceId: null, pageId: "page" },
      { kind: "agent", threadId: ThreadId.makeUnsafe("trusted-thread") },
    );
  });

  it("creates a Personal page without a placement and accepts revision as expectedRevision", async () => {
    const h = harness();
    const tool = h.byName.get("moss_pages_mutate")!;
    await Effect.runPromise(
      tool.handler(
        { op: "create", requestId: "canvas-init-002", title: "画布", content: "# 画布" },
        h.context,
      ),
    );
    expect(h.mutate.mock.calls[0]?.[0]).toMatchObject({
      op: "create",
      scopeSpaceId: null,
      spaceId: null,
      parentPageId: null,
      title: "画布",
    });
    await Effect.runPromise(
      tool.handler(
        { op: "update", requestId: "canvas-fill-001", pageId: "page", revision: 1, content: "x" },
        h.context,
      ),
    );
    expect(h.mutate.mock.calls[1]?.[0]).toMatchObject({
      op: "update",
      pageId: "page",
      expectedRevision: 1,
    });
    expect(h.mutate.mock.calls[1]?.[0]).not.toHaveProperty("revision");
  });

  it("answers what it cannot infer with a one-line hint", () => {
    expect(normalizePagesMutateArgs({ op: "update", requestId: "r", pageId: "p" })).toEqual({
      hint: "expectedRevision is required for op=update: pass the page's current revision from moss_pages_read.",
    });
    expect(normalizePagesMutateArgs({ op: "create", requestId: "r" })).toEqual({
      hint: "title is required for op=create.",
    });
    expect(
      normalizePagesMutateArgs({
        op: "restore-version",
        requestId: "r",
        pageId: "p",
        expectedRevision: 3,
      }),
    ).toEqual({
      hint: "revision (the version to restore, from moss_pages_versions) is required.",
    });
    // restore-version keeps revision as the version to restore.
    expect(
      normalizePagesMutateArgs({
        op: "restore-version",
        requestId: "r",
        pageId: "p",
        expectedRevision: 3,
        revision: 1,
      }),
    ).toMatchObject({ args: { expectedRevision: 3, revision: 1 } });
    expect(
      normalizePagesMutateArgs({
        op: "create",
        requestId: "r",
        title: "t",
        parentPageId: "parent",
      }),
    ).toMatchObject({ spaceFromParent: "parent" });
  });

  it("puts a child page in its parent's document space when spaceId is left out", async () => {
    const h = harness();
    h.read.mockImplementationOnce(() =>
      Effect.succeed({
        page: { spaceId: "space-1" },
        content: "",
      } as unknown as Effect.Success<ReturnType<PagesServiceShape["read"]>>),
    );
    await Effect.runPromise(
      h.byName
        .get("moss_pages_mutate")!
        .handler(
          { op: "create", requestId: "child", title: "Child", parentPageId: "parent" },
          h.context,
        ),
    );
    expect(h.read).toHaveBeenCalledWith(
      { scopeSpaceId: null, pageId: "parent" },
      { kind: "agent", threadId: ThreadId.makeUnsafe("trusted-thread") },
    );
    expect(h.mutate.mock.calls[0]?.[0]).toMatchObject({
      op: "create",
      spaceId: "space-1",
      parentPageId: "parent",
    });
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

  it("turns an agent's body edit into a reviewable draft and still applies the title", async () => {
    const h = harness();
    const draftsMutate = vi.fn<PageDraftsServiceShape["mutate"]>(() =>
      Effect.succeed({ drafts: [] }),
    );
    h.mutate.mockImplementation(() => Effect.succeed({} as never));
    const tools = makePageTools({
      pages: {
        spaces: () => Effect.succeed({ spaces: [] }),
        list: () => Effect.succeed({ pages: [] }),
        read: h.read,
        mutate: h.mutate,
        versions: () => Effect.succeed({ versions: [] }),
        comments: () => Effect.succeed({ comments: [] }),
        textComments: () => Effect.succeed({ comments: [] }),
        textCommentMutate: () => Effect.succeed({ ok: true }),
        outputs: () => Effect.succeed({ outputs: [] }),
        outputState: () => Effect.void,
      },
      drafts: { list: () => Effect.succeed({ drafts: [] }), mutate: draftsMutate },
    });
    const tool = tools.find((entry) => entry.definition.name === "moss_pages_mutate")!;
    await Effect.runPromise(
      tool.handler(
        {
          op: "update",
          requestId: "edit",
          scopeSpaceId: null,
          pageId: "page",
          expectedRevision: 3,
          title: "新标题",
          content: "改写后的正文",
        },
        h.context,
      ),
    );
    expect(draftsMutate.mock.calls[0]?.[0]).toMatchObject({
      op: "create",
      pageId: "page",
      baseRevision: 3,
      ops: [{ kind: "replace-all", markdown: "改写后的正文" }],
    });
    expect(draftsMutate.mock.calls[0]?.[1]).toEqual({
      kind: "agent",
      threadId: ThreadId.makeUnsafe("trusted-thread"),
    });
    expect(h.mutate.mock.calls[0]?.[0]).toEqual({
      op: "update",
      requestId: "edit",
      scopeSpaceId: null,
      pageId: "page",
      expectedRevision: 3,
      title: "新标题",
    });
  });
});
