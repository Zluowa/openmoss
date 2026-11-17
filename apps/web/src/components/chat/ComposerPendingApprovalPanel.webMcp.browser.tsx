// FILE: ComposerPendingApprovalPanel.webMcp.browser.tsx
// Purpose: The approval card for a page-declared WebMCP call shows what a person decides on.
// Layer: Chat composer UI browser test
// Why: review of #655 (B1). The card showed only "browser_webmcp_call": the server sent its
//      rows as one JSON string, which the pending-card parser drops.

import { EventId, ThreadId, TurnId, type OrchestrationThreadActivity } from "@moss/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { derivePendingApprovals } from "../../pendingInteractionDerivation";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

const SITE = "http://127.0.0.1:5173";

/** The activity the agent gateway publishes for one WebMCP call (AgentGateway.ts). */
function webMcpApprovalActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe("computer:webmcp-1:open"),
    tone: "info",
    kind: "approval.requested",
    summary: "Page tool needs approval",
    payload: {
      requestId: "computer:webmcp-1",
      requestKind: "tool",
      requestType: "tool",
      toolName: "browser_webmcp_call",
      toolParamsDisplay: [
        { name: "site", value: SITE },
        { name: "pageTool", value: "checkout" },
        { name: "arguments", value: '{"amount":900,"card":"(hidden)"}' },
      ],
      sessionApprovalAvailable: false,
    },
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-11-18T00:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

async function renderCard(locale: "zh-CN" | "en") {
  const [approval] = derivePendingApprovals([webMcpApprovalActivity()]);
  expect(approval).toBeDefined();
  return render(
    <MossLocaleScope locale={locale}>
      <ComposerPendingApprovalPanel
        approval={approval!}
        pendingCount={1}
        isResponding={false}
        onRespond={vi.fn(async () => undefined)}
      />
    </MossLocaleScope>,
  );
}

describe("ComposerPendingApprovalPanel for a page tool", () => {
  it("names the site and the page's tool and shows the arguments without a click (zh-CN)", async () => {
    const screen = await renderCard("zh-CN");
    await expect
      .element(page.getByText(`允许网站 ${SITE} 运行它的工具「checkout」吗？`))
      .toBeVisible();
    await expect
      .element(page.getByText("这个工具由网站提供，会以网站的身份执行操作。"))
      .toBeVisible();
    await expect.element(page.getByText("网站", { exact: true })).toBeVisible();
    await expect.element(page.getByText("网页工具", { exact: true })).toBeVisible();
    await expect.element(page.getByText("参数", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/"amount":900/u)).toBeVisible();
    expect(screen.container.textContent).not.toContain("browser_webmcp_call");
    await screen.unmount();
  });

  it("reads the same in English", async () => {
    const screen = await renderCard("en");
    await expect.element(page.getByText(`Let ${SITE} run its page tool “checkout”?`)).toBeVisible();
    await expect.element(page.getByText(/"amount":900/u)).toBeVisible();
    await screen.unmount();
  });
});
