import { describe, expect, it } from "vitest";

import {
  CODEX_BROWSER_MCP_IFRAME_ALLOW,
  CODEX_BROWSER_MCP_IFRAME_REFERRER_POLICY,
  CODEX_BROWSER_MCP_IFRAME_SANDBOX,
  embeddedMcpAppHtml,
} from "./mcpAppBrowserFrame";
import type { WorkLogMcpToolResult } from "./toolCallDetails";

function projection(
  content: NonNullable<WorkLogMcpToolResult["result"]>["content"],
): Pick<WorkLogMcpToolResult, "app" | "result"> {
  return {
    app: { resourceUri: "ui://linear/issue", source: "appContext", appName: "Linear" },
    result: { content },
  };
}

describe("Codex browser MCP App frame", () => {
  it("keeps the Codex iframe sandbox tokens without attaching the guest to the Moss origin", () => {
    expect(CODEX_BROWSER_MCP_IFRAME_SANDBOX).toBe("allow-scripts allow-forms");
    expect(CODEX_BROWSER_MCP_IFRAME_REFERRER_POLICY).toBe("no-referrer");
    expect(CODEX_BROWSER_MCP_IFRAME_ALLOW).toBe("encrypted-media *");
  });

  it("reads recorded MCP App HTML from an embedded resource", () => {
    const html = "<!doctype html><p>Linear</p>";
    expect(
      embeddedMcpAppHtml(
        projection([
          { type: "text", text: "Opened the issue widget." },
          {
            type: "embedded_resource",
            uri: "ui://linear/issue",
            mimeType: "text/html;profile=mcp-app",
            text: html,
          },
        ]),
      ),
    ).toBe(html);
  });

  it("ignores embedded HTML for a different resource", () => {
    expect(
      embeddedMcpAppHtml(
        projection([
          {
            type: "embedded_resource",
            uri: "ui://other/app",
            mimeType: "text/html",
            text: "<p>nope</p>",
          },
        ]),
      ),
    ).toBeNull();
  });
});
