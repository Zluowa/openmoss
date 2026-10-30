import type { OrchestrationCommand, ThreadId } from "@synara/contracts";
import { HTML_RENDER_TOOL_NAME, type HtmlRenderReference } from "@synara/shared/htmlRender";
import {
  HTML_RENDER_ACTIVITY_KIND,
  htmlRenderFromActivity,
} from "@synara/shared/htmlRenderActivity";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { HtmlRenderImagesNotFoundError, type HtmlRenderShape } from "../htmlRender/HtmlRender.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeAgentGatewayHtmlRenderTools } from "./htmlRenderTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

const REFERENCE: HtmlRenderReference = {
  attachmentId: "thread-caller-00000000-0000-4000-8000-000000000001",
  title: "Revenue",
  height: 480,
};

const PREVIEW = {
  png: "cHJldmlldw==",
  width: 728,
  contentHeight: 640,
  capturedHeight: 640,
  consoleMessages: [{ level: "error" as const, text: "Uncaught Error: sample" }],
};

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

function makeHarness(
  publish: HtmlRenderShape["publish"],
  preview: HtmlRenderShape["preview"] = () => Effect.succeed(PREVIEW),
) {
  const published: Array<Parameters<HtmlRenderShape["publish"]>[0]> = [];
  const dispatched: Array<OrchestrationCommand> = [];
  const tools = makeAgentGatewayHtmlRenderTools({
    htmlRender: {
      prepare: () => Effect.die("unused"),
      publish: (input) => {
        published.push(input);
        return publish(input);
      },
      preview,
    },
    orchestrationEngine: {
      dispatch: ((command: OrchestrationCommand) => {
        dispatched.push(command);
        return Effect.succeed({ sequence: 1 });
      }) as unknown as OrchestrationEngineShape["dispatch"],
    },
    resolveWorkspaceRoot: () => Effect.succeed("/repo"),
  });
  const tool = tools.find((candidate) => candidate.definition.name === HTML_RENDER_TOOL_NAME);
  const previewTool = tools.find((candidate) => candidate.definition.name === "html_preview");
  if (!tool || !previewTool) throw new Error("HTML tools missing");
  return { tool, previewTool, published, dispatched };
}

describe("html_render agent tool", () => {
  it("is a thread-scoped, read-only tool for the caller's live turn", () => {
    const { tool } = makeHarness(() => Effect.succeed(REFERENCE));

    expect(tool.definition.name).toBe(HTML_RENDER_TOOL_NAME);
    expect(tool.requiredCapability).toBe("thread:write");
    expect(tool.requiresActiveTurn).toBe(true);
    expect(tool.definition.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(tool.definition.description).toContain("Remote URLs load as-is.");
    expect(tool.definition.description).toContain("Do not use vh units");
    expect(tool.definition.inputSchema).toMatchObject({
      required: ["html", "title", "height"],
      additionalProperties: false,
    });
  });

  it("previews in the calling thread with a screenshot and diagnostic metadata", async () => {
    const { previewTool, published, dispatched } = makeHarness(() => Effect.succeed(REFERENCE));

    expect(previewTool.requiredCapability).toBe("thread:read");
    expect(previewTool.requiresActiveTurn).toBe(true);
    expect(previewTool.definition.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(previewTool.definition.description).toContain(
      "The first preview on a machine waits while Moss downloads its preview browser",
    );
    expect(previewTool.definition.description).not.toContain("call again a minute later");
    const result = await Effect.runPromise(
      previewTool.handler(
        { html: "<p>Preview</p>", width: 728, appearance: "light" },
        makeContext(),
      ),
    );

    expect(result).toMatchObject({
      content: [{ type: "image", data: PREVIEW.png, mimeType: "image/png" }],
      structuredContent: {
        contentHeight: 640,
        screenshot: { mimeType: "image/png", data: PREVIEW.png, width: 728, height: 640 },
      },
    });
    expect(published).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("rejects malformed preview arguments before invoking the browser", async () => {
    let calls = 0;
    const { previewTool } = makeHarness(
      () => Effect.succeed(REFERENCE),
      () => {
        calls += 1;
        return Effect.succeed(PREVIEW);
      },
    );

    for (const args of [
      {},
      { html: "" },
      { html: "<p/>", width: 239 },
      { html: "<p/>", width: 1601 },
      { html: "<p/>", width: 728.5 },
      { html: "<p/>", appearance: "sepia" },
    ]) {
      expect((await Effect.runPromise(previewTool.handler(args, makeContext()))).isError).toBe(
        true,
      );
    }
    expect(calls).toBe(0);
  });

  it("publishes the page in the caller's workspace and records it as a thread activity", async () => {
    const { tool, published, dispatched } = makeHarness(() => Effect.succeed(REFERENCE));

    const result = await Effect.runPromise(
      tool.handler({ html: "<p>Q3</p>", title: "Revenue", height: 480 }, makeContext()),
    );

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      htmlRender: REFERENCE,
      message:
        "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
    });
    expect(published).toEqual([
      {
        threadId: "thread-caller" as ThreadId,
        cwd: "/repo",
        html: "<p>Q3</p>",
        title: "Revenue",
        height: 480,
      },
    ]);
    expect(dispatched).toHaveLength(1);
    const command = dispatched[0];
    if (command?.type !== "thread.activity.append") throw new Error("expected an activity");
    expect(command.threadId).toBe("thread-caller");
    expect(command.activity).toMatchObject({
      id: `html-render:${REFERENCE.attachmentId}`,
      kind: HTML_RENDER_ACTIVITY_KIND,
      turnId: "turn-caller",
    });
    expect(htmlRenderFromActivity(command.activity)).toEqual(REFERENCE);
  });

  it("rejects malformed arguments without publishing anything", async () => {
    const { tool, published, dispatched } = makeHarness(() => Effect.succeed(REFERENCE));

    for (const args of [
      { title: "Revenue", height: 480 },
      { html: "", title: "Revenue", height: 480 },
      { html: "x".repeat(512_001), title: "Revenue", height: 480 },
      { html: "<p/>", title: "", height: 480 },
      { html: "<p/>", title: "Revenue", height: 480.5 },
    ]) {
      const result = await Effect.runPromise(tool.handler(args, makeContext()));
      expect(result.isError).toBe(true);
    }
    expect(published).toEqual([]);
    expect(dispatched).toEqual([]);
  });

  it("returns the server's page error to the agent and records nothing", async () => {
    const { tool, dispatched } = makeHarness(() =>
      Effect.fail(new HtmlRenderImagesNotFoundError({ paths: ["/etc/secret.png"] })),
    );

    const result = await Effect.runPromise(
      tool.handler(
        { html: '<img src="/etc/secret.png">', title: "Shot", height: 300 },
        makeContext(),
      ),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("could not be read: /etc/secret.png"),
    });
    expect(dispatched).toEqual([]);
  });
});
