import { afterEach, describe, expect, it } from "vitest";

import {
  agentCanvasOpenRequest,
  claimAgentCanvasOpen,
  resetAgentCanvasOpenClaimsForTests,
} from "./agentCanvasOpen";

describe("agent open-canvas requests", () => {
  afterEach(() => resetAgentCanvasOpenClaimsForTests());

  it("reads only the Moss canvas tool's request, with an optional image focus", () => {
    expect(
      agentCanvasOpenRequest({
        kind: "canvas.open.requested",
        payload: { source: "moss-mcp-canvas", threadId: "t" },
      }),
    ).toEqual({ image: undefined });
    expect(
      agentCanvasOpenRequest({
        kind: "canvas.open.requested",
        payload: { source: "moss-mcp-canvas", jobId: "moss_job1", imageIndex: 1 },
      })?.image,
    ).toEqual({ jobId: "moss_job1", imageIndex: 1, action: "canvas" });
    expect(
      agentCanvasOpenRequest({ kind: "canvas.open.requested", payload: { source: "page" } }),
    ).toBeNull();
    expect(agentCanvasOpenRequest({ kind: "tool.completed", payload: {} })).toBeNull();
  });

  it("acts on each request once, whichever path sees it first", () => {
    expect(claimAgentCanvasOpen("agent:a:canvas-open")).toBe(true);
    expect(claimAgentCanvasOpen("agent:a:canvas-open")).toBe(false);
    expect(claimAgentCanvasOpen("agent:b:canvas-open")).toBe(true);
  });
});
