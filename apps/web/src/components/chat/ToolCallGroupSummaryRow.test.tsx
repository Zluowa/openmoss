// FILE: ToolCallGroupSummaryRow.test.tsx
// Purpose: The live line of a folded tool run speaks the UI language (real-data acceptance:
//          Claude's ToolSearch read "Loaded tools" in zh-CN because the live line ignored it).
// Layer: Web chat presentation tests

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLocaleScope } from "../../localization";
import { deriveWorkLogEntries } from "../../workLog";
import { makeActivity } from "../../storeTestFixtures";
import { ToolCallGroupSummaryRow } from "./ToolCallGroupSummaryRow";

function toolSearchEntry(kind: "tool.started" | "tool.completed") {
  return deriveWorkLogEntries(
    [
      makeActivity({
        id: `tool-search-${kind}`,
        createdAt: "2026-02-23T00:00:01.000Z",
        kind,
        summary: "ToolSearch",
        payload: {
          itemType: "dynamic_tool_call",
          title: "ToolSearch",
          status: kind === "tool.completed" ? "completed" : "inProgress",
          data: { toolCallId: "search-1", toolName: "ToolSearch" },
        },
      }),
    ],
    undefined,
  )[0]!;
}

function renderLive(kind: "tool.started" | "tool.completed") {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MossLocaleScope locale="zh-CN">
        <ToolCallGroupSummaryRow
          label="unused"
          icon={() => null}
          liveEntry={toolSearchEntry(kind)}
          open={false}
          onToggle={() => {}}
          fontSizePx={14}
          renderChildren={() => null}
        />
      </MossLocaleScope>
    </QueryClientProvider>,
  );
}

describe("ToolCallGroupSummaryRow live line", () => {
  it("names Claude's ToolSearch in Chinese, running and done", () => {
    const done = renderLive("tool.completed");
    expect(done).toContain("已加载工具");
    expect(done).not.toContain("Loaded tools");
    const running = renderLive("tool.started");
    expect(running).toContain("正在加载工具");
    expect(running).not.toContain("Loading tools");
  });
});
