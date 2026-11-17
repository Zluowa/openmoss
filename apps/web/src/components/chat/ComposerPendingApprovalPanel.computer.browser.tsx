// FILE: ComposerPendingApprovalPanel.computer.browser.tsx
// Purpose: A Computer approval card shows the action it asks about.
// Layer: Chat composer UI browser test
// Why: until 2026-11-17 the agent gateway sent a Computer card's parameters as one JSON
//      string, which the pending-card parser drops, so a person approving a computer-use
//      action saw no app, no coordinates, nothing to decide on.

import { EventId, TurnId, type OrchestrationThreadActivity } from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { derivePendingApprovals } from "../../pendingInteractionDerivation";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

/**
 * The activity the agent gateway publishes (AgentGateway.ts `publishComputerApproval`) for
 * `computer_click { app: "Finder", x: 120, y: 48, button: "left" }`; the rows are exactly
 * what `computerApprovalDisplayArgs` returns for it (computerApprovalDisplay.test.ts).
 */
function computerApprovalActivity(): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe("computer:click-1:open"),
    tone: "info",
    kind: "approval.requested",
    summary: "Allow Computer for this task",
    payload: {
      requestId: "computer:click-1",
      requestKind: "tool",
      requestType: "tool",
      toolName: "computer_click",
      toolParamsDisplay: [
        { name: "app", value: "Finder" },
        { name: "x", value: "120" },
        { name: "y", value: "48" },
        { name: "button", value: "left" },
      ],
      sessionApprovalAvailable: false,
      approvalScope: "computer-task",
    },
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-11-17T12:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

describe("ComposerPendingApprovalPanel for a Computer action", () => {
  it("shows the action's app and position, with Chinese labels", async () => {
    const [approval] = derivePendingApprovals([computerApprovalActivity()]);
    expect(approval?.toolParamsDisplay).toHaveLength(4);
    const screen = await render(
      <MossLocaleScope locale="zh-CN">
        <ComposerPendingApprovalPanel
          approval={approval!}
          pendingCount={1}
          isResponding={false}
          onRespond={vi.fn(async () => undefined)}
        />
      </MossLocaleScope>,
    );
    await userEvent.click(page.getByRole("button", { name: "显示详情" }));
    for (const [label, value] of [
      ["应用", "Finder"],
      ["横坐标", "120"],
      ["纵坐标", "48"],
      ["鼠标按键", "left"],
    ] as const) {
      await expect.element(page.getByText(label, { exact: true })).toBeVisible();
      await expect.element(page.getByText(value, { exact: true })).toBeVisible();
    }
    await screen.unmount();
  });
});
