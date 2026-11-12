// FILE: McpAppBlockView.test.tsx
// Purpose: A failed widget call's text fallback shows Moss's own default in the UI language and
//          keeps a server's or CLI's own error as written.
// Layer: Web chat presentation tests

import { MCP_APP_DEFAULT_CALL_FAILED_MESSAGE } from "@moss/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { MossLocaleScope } from "../../localization";
import { McpAppBlockView } from "./McpAppBlockView";

function renderFailed(message: string) {
  const projection = {
    kind: "codex.mcp_tool_call",
    version: 1,
    callId: "call-failed",
    server: "map",
    tool: "show-map",
    status: "failed",
    arguments: {},
    error: { message },
    truncation: { truncated: false, deferredBinary: false },
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

describe("McpAppBlockView failed call", () => {
  it("shows Moss's own default failure in Chinese above the footnote", () => {
    const markup = renderFailed(MCP_APP_DEFAULT_CALL_FAILED_MESSAGE);
    expect(markup).toContain("工具调用失败。");
    expect(markup).not.toContain(MCP_APP_DEFAULT_CALL_FAILED_MESSAGE);
    expect(markup).toContain("小组件加载失败，已改为显示文字结果。");
  });

  it("keeps a server's own error text as written", () => {
    const markup = renderFailed("map: upstream tiles unavailable");
    expect(markup).toContain("map: upstream tiles unavailable");
  });
});
