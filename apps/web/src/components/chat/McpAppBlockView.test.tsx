// FILE: McpAppBlockView.test.tsx
// Purpose: A failed tool call shows its own text in place with 「工具调用失败。」 (Moss's own default in
//          the UI language, a server's or CLI's error as written); a widget that failed to load
//          keeps the "shown as text" line.
// Layer: Web chat presentation tests

import { MCP_APP_DEFAULT_CALL_FAILED_MESSAGE } from "@moss/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { MossLocaleScope } from "../../localization";
import { McpAppBlockView } from "./McpAppBlockView";

function renderFailed(
  message: string,
  extra: Partial<WorkLogMcpToolResult> = {},
  status: WorkLogMcpToolResult["status"] = "failed",
) {
  const projection = {
    kind: "codex.mcp_tool_call",
    version: 1,
    callId: "call-failed",
    server: "map",
    tool: "show-map",
    status,
    arguments: {},
    error: { message },
    truncation: { truncated: false, deferredBinary: false },
    ...extra,
  } as WorkLogMcpToolResult;
  const noop = () => undefined;
  return renderToStaticMarkup(
    <MossLocaleScope locale="zh-CN">
      <McpAppBlockView
        binding={{
          server: "map",
          serverKey: "map",
          serverLabel: "map",
          toolName: "show-map",
          resourceUri: "ui://map/w",
          source: "toolDefinition",
          isFirstParty: false,
          visibility: [],
        }}
        projection={projection}
        phase="failed"
        loading={false}
        open
        hidden={false}
        hideOffered
        height={0}
        prefersBorder
        docked={false}
        dockShowing={false}
        canOpenPane={false}
        prompt={null}
        dialog={null}
        reducedMotion
        onToggle={noop}
        onToggleHidden={noop}
        onOpenPane={noop}
        onDockAction={noop}
        onPromptAnswer={noop}
        onConnect={noop}
        onDialogAnswer={noop}
      />
    </MossLocaleScope>,
  );
}

const count = (markup: string, text: string) => markup.split(text).length - 1;

describe("McpAppBlockView failed call", () => {
  it("says the tool call failed, once, in Chinese when the call failed with Moss's default", () => {
    const markup = renderFailed(MCP_APP_DEFAULT_CALL_FAILED_MESSAGE);
    expect(count(markup, "工具调用失败。")).toBe(1);
    expect(markup).not.toContain(MCP_APP_DEFAULT_CALL_FAILED_MESSAGE);
    // That line is for a widget that failed to load, not for a tool that failed.
    expect(markup).not.toContain("小组件加载失败，已改为显示文字结果。");
  });

  it("shows the failed call's own text in place, then 「工具调用失败。」", () => {
    const text = ["Debug text content #1", "Debug text content #2"].join("\n");
    const markup = renderFailed(text, {
      result: { content: [{ type: "text", text }] },
    });
    expect(markup).toContain("Debug text content #1");
    expect(markup.indexOf("Debug text content #1")).toBeLessThan(markup.indexOf("工具调用失败。"));
    expect(markup).toContain('data-mcp-app-call-failed="true"');
    expect(markup).not.toContain("小组件加载失败");
  });

  it("shows a failed call's own error, not the structured data it carried", () => {
    const markup = renderFailed("returned a malformed result that failed schema validation", {
      result: { content: [], structuredContent: { rows: [1, 2] } },
    });
    expect(markup).toContain("returned a malformed result that failed schema validation");
    expect(markup).not.toContain("rows");
    expect(markup).toContain("工具调用失败。");
  });

  it("keeps a server's own error text as written", () => {
    const markup = renderFailed("map: upstream tiles unavailable");
    expect(markup).toContain("map: upstream tiles unavailable");
  });

  it("keeps the widget fallback line for a widget that failed to load", () => {
    const markup = renderFailed(
      "unused",
      { error: undefined, result: { content: [{ type: "text", text: "Shanghai" }] } },
      "completed",
    );
    expect(markup).toContain("Shanghai");
    expect(markup).toContain("小组件加载失败，已改为显示文字结果。");
    expect(markup).not.toContain("工具调用失败。");
  });
});
