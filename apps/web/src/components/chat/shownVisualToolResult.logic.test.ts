import { describe, expect, it } from "vitest";

import { shownVisualFromWorkEntry } from "./shownVisualToolResult.logic";

const VISUAL_ID = "vis_62243c837266e6cba034f0eb2ac68ec8";
const REPLY = JSON.stringify(
  { visualId: VISUAL_ID, title: "会后执行看板", embed: "```moss-visual\n" + VISUAL_ID + "\n```" },
  null,
  2,
);

function codexEntry(status: "completed" | "failed", text = REPLY) {
  return {
    toolName: "mcp__moss__moss_show_visual",
    mcpToolResult: {
      kind: "codex.mcp_tool_call" as const,
      version: 1 as const,
      callId: "exec-1",
      server: "moss",
      tool: "moss_show_visual",
      status,
      arguments: {},
      result: { content: [{ type: "text" as const, text }], structuredContent: null },
      truncation: { truncated: true, deferredBinary: false },
    },
  };
}

describe("shownVisualFromWorkEntry", () => {
  it("reads the visual from a Codex moss_show_visual result", () => {
    expect(shownVisualFromWorkEntry(codexEntry("completed") as never)).toEqual({
      visualId: VISUAL_ID,
      title: "会后执行看板",
    });
  });

  it("still finds the id in a shortened result text", () => {
    const partial = REPLY.slice(0, REPLY.indexOf('"embed"'));
    expect(shownVisualFromWorkEntry(codexEntry("completed", partial) as never)?.visualId).toBe(
      VISUAL_ID,
    );
  });

  it("reads a moss_show_visual row from another runtime's tool output", () => {
    expect(
      shownVisualFromWorkEntry({
        toolName: "mcp__moss__moss_show_visual",
        toolDetails: { kind: "command", title: "Show a visual", output: { output: REPLY } },
      }),
    ).toEqual({ visualId: VISUAL_ID, title: "会后执行看板" });
  });

  it("leaves failed calls and other tools alone", () => {
    expect(shownVisualFromWorkEntry(codexEntry("failed") as never)).toBeNull();
    expect(
      shownVisualFromWorkEntry({
        ...codexEntry("completed"),
        toolName: "mcp__moss__moss_theme_set",
        mcpToolResult: { ...codexEntry("completed").mcpToolResult, tool: "moss_theme_set" },
      } as never),
    ).toBeNull();
  });
});
