import "../../index.css";
import { ApprovalRequestId, MessageId, TurnId } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";
import { MultiAgentActionDisclosure } from "./MultiAgentActionDisclosure";
import { AutomaticApprovalReviewDetails } from "./AutomaticApprovalReviewDetails";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  deriveWorkLogEntries,
  type WorkLogEntry,
  type WorkLogLiveActivityState,
} from "../../workLog";
import { makeActivity } from "../../storeTestFixtures";
import type { ChatMessage } from "../../types";
import type { WorkLogMcpToolResult } from "../../lib/toolCallDetails";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "en" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("en", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("en", key, values),
    }),
  };
});
const now = new Date().toISOString();
const shot = (name: string) =>
  page.screenshot({
    path: `../../../../../.tmp/ui-parity/parity4/pass4-moss-${name}.png`,
  });
const motion = commands as unknown as {
  emulateReducedMotion: (value: "reduce" | "no-preference") => Promise<void>;
};
function Row({ entry }: { entry: WorkLogEntry }) {
  return (
    <div style={{ width: 720, padding: 24 }}>
      <TimelineWorkEntryRow
        workEntry={entry}
        chatMetaFontSizePx={12}
        textFontSizePx={16}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="locale"
      />
    </div>
  );
}
function command(state: WorkLogLiveActivityState, stdout = "", exitCode?: number): WorkLogEntry {
  return {
    id: "exec-pass4",
    createdAt: now,
    label: "Run command",
    tone: "tool",
    itemType: "command_execution",
    command: "python3 capture.py",
    toolDetails: {
      kind: "command",
      title: "Shell",
      command: "python3 capture.py",
      cwd: "/workspace/moss",
      output: { stdout, ...(exitCode !== undefined ? { exitCode } : {}) },
    },
    liveActivity: { state, label: "Run command", startedAt: now, lastActivityAt: now },
  };
}
function mcp(status: WorkLogMcpToolResult["status"]): WorkLogEntry {
  return {
    id: "mcp-pass4",
    createdAt: now,
    label: "MCP tool call",
    tone: "tool",
    itemType: "mcp_tool_call",
    toolTitle: "demo.inspect",
    toolStatus: status === "inProgress" ? "running" : status,
    mcpToolResult: {
      kind: "codex.mcp_tool_call",
      version: 1,
      callId: "call-pass4",
      server: "demo",
      tool: "inspect",
      status,
      arguments: { path: "src" },
      truncation: { truncated: false, deferredBinary: false },
      ...(status === "completed"
        ? { result: { content: [{ type: "text", text: "Inspection complete" }] } }
        : {}),
    },
  };
}
function Timeline({ message, inset }: { message: ChatMessage; inset: number }) {
  return (
    <div style={{ height: 450 }}>
      <MessagesTimeline
        hasMessages
        isWorking={message.streaming}
        activeTurnInProgress={message.streaming}
        activeTurnStartedAt={message.streaming ? now : null}
        timelineEntries={[{ id: message.id, kind: "message", createdAt: now, message }]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={now}
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
        contentInsetBottomPx={inset}
      />
    </div>
  );
}
beforeEach(async () => {
  await page.viewport(960, 720);
  await motion.emulateReducedMotion("reduce");
});
afterEach(async () => {
  await motion.emulateReducedMotion("no-preference");
  vi.restoreAllMocks();
});

describe("Pass 4 observed intermediate states", () => {
  it("keeps partial stdout in the same shell through running, exit, failure and interruption", async () => {
    const screen = await render(<Row entry={command("running_tool")} />);
    try {
      const trigger = () =>
        document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]")!;
      expect(
        document
          .querySelector("[data-work-entry-display-text]")
          ?.hasAttribute("data-conversation-shimmer"),
      ).toBe(true);
      // The upstream row separates its live verb from the literal command chip.
      expect(
        document.querySelector("[data-work-entry-display-text]")?.firstChild?.textContent,
      ).toBe("Running");
      expect(document.querySelector("[data-command-literal]")?.textContent).toBe(
        "python3 capture.py",
      );
      // Generic fallback gives way to the upstream verb and command chip.
      expect(document.querySelector("[data-live-activity-meta]")).not.toBeNull();
      await shot("tool-midrun-collapsed");
      trigger().click();
      await expect.poll(() => trigger().getAttribute("aria-expanded")).toBe("true");
      expect(document.querySelector("[data-shell-footer]")?.getAttribute("data-shell-footer")).toBe(
        "running",
      );
      await screen.rerender(<Row entry={command("running_tool", "pass4 partial stdout\n")} />);
      await expect.element(page.getByText("pass4 partial stdout", { exact: true })).toBeVisible();
      await shot("tool-midrun-expanded");
      for (const [state, code, footer] of [
        ["completed", 0, "success"],
        ["completed", 7, "exit-code"],
        ["failed", undefined, "exit-code"],
        ["cancelled", 0, "stopped"],
      ] as const) {
        await screen.rerender(
          <Row entry={command(state, "pass4 partial stdout\npass4 settled", code)} />,
        );
        await expect
          .poll(() =>
            document.querySelector("[data-shell-footer]")?.getAttribute("data-shell-footer"),
          )
          .toBe(footer);
        if (footer === "success") {
          await shot("tool-settled-expanded");
          trigger().click();
          await expect.poll(() => trigger().getAttribute("aria-expanded")).toBe("false");
          await shot("tool-settled-collapsed");
          trigger().click();
        }
      }
    } finally {
      await screen.unmount();
    }
  });

  it("shimmers an in-flight MCP label and exposes result disclosure only when content arrives", async () => {
    const screen = await render(<Row entry={mcp("inProgress")} />);
    try {
      expect(
        document
          .querySelector("[data-work-entry-display-text]")
          ?.hasAttribute("data-conversation-shimmer"),
      ).toBe(true);
      expect(document.querySelector("[data-tool-detail-trigger]")).toBeNull();
      await shot("mcp-in-progress");
      const pendingWithNullResult = mcp("inProgress");
      await screen.rerender(
        <Row
          entry={{
            ...pendingWithNullResult,
            mcpToolResult: {
              ...pendingWithNullResult.mcpToolResult!,
              // @ts-expect-error Exercise the upstream null sentinel, excluded by Moss's normalized type.
              result: null,
            },
          }}
        />,
      );
      expect(document.querySelector("[data-tool-detail-trigger]")).toBeNull();
      await screen.rerender(<Row entry={mcp("completed")} />);
      expect(
        document
          .querySelector("[data-work-entry-display-text]")
          ?.hasAttribute("data-conversation-shimmer"),
      ).toBe(false);
      document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]")!.click();
      await expect.element(page.getByText("Inspection complete", { exact: true })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("settles automatic review shimmer into high-risk warning and explicit authorization copy", async () => {
    const review = {
      reviewId: "review-pass4",
      targetItemId: "call-pass4",
      status: "inProgress" as const,
      startedAtMs: 1,
    };
    const screen = await render(<AutomaticApprovalReviewDetails review={review} />);
    try {
      expect(
        document
          .querySelector("[data-automatic-approval-review-title]")
          ?.classList.contains("shimmer"),
      ).toBe(true);
      expect(
        getComputedStyle(document.querySelector("[data-automatic-approval-review-title]")!)
          .animationName,
      ).toBe("none");
      const entry = mcp("failed");
      entry.mcpToolResult = {
        ...entry.mcpToolResult!,
        automaticApprovalReviews: [
          {
            ...review,
            status: "denied",
            riskLevel: "high",
            rationale: "Needs explicit authorization.",
          },
        ],
      };
      await screen.rerender(<Row entry={entry} />);
      document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]")!.click();
      // 上游 mount-on-open disclosure：详情体在打开后才进 DOM，需轮询等待挂载。
      await expect
        .poll(() => document.querySelector("[data-automatic-approval-review-title]"))
        .not.toBeNull();
      const title = document.querySelector<HTMLElement>("[data-automatic-approval-review-title]")!;
      expect(title.classList.contains("text-warning")).toBe(true);
      expect(title.classList.contains("shimmer")).toBe(false);
      expect(title.closest("button")?.className).toContain("group/automatic-approval-review");
      await expect
        .element(
          page.getByText(
            "Requires explicit authorization because this action is considered high risk",
          ),
        )
        .toBeVisible();
      await shot("mcp-high-risk-denied");
      for (const status of ["approved", "denied", "timedOut", "aborted"] as const) {
        await screen.rerender(
          <AutomaticApprovalReviewDetails review={{ ...review, status, riskLevel: "low" }} />,
        );
        expect(
          document
            .querySelector("[data-automatic-approval-review-title]")
            ?.classList.contains("text-warning"),
        ).toBe(false);
      }
    } finally {
      await screen.unmount();
    }
  });

  it.each([
    ["spawnAgent", "Creating", "Created", "Failed to create"],
    ["sendInput", "Messaging", "Messaged", "Failed to message"],
    ["resumeAgent", "Resuming", "Resumed", "Failed to resume"],
    ["closeAgent", "Closing", "Closed", "Failed to close"],
  ] as const)("renders %s progress and settled verbs", async (tool, running, settled, failed) => {
    const entry = (status: string): WorkLogEntry => ({
      id: "agent-pass4",
      createdAt: now,
      label: "Agent action",
      tone: "tool",
      subagentAction: {
        tool,
        status,
        summaryText: "Agent action",
        prompt: "Read the directory name",
      },
      subagents: [{ threadId: "scout", nickname: "Scout", rawStatus: "running" }],
    });
    const screen = await render(
      <MultiAgentActionDisclosure items={[entry("inProgress")]} fontSizePx={16} />,
    );
    try {
      const summary = () => document.querySelector<HTMLElement>("[data-tool-group-summary]")!;
      expect(summary().textContent).toContain(running);
      // MultiAgentActionDisclosure 的 shimmer 在标题动词子节点上（外层 summary 被
      // shimmerLabel={false} 停用）。
      expect(summary().querySelector("[data-conversation-shimmer='true']")).not.toBeNull();
      await expect.element(page.getByTestId("multi-agent-action-rows")).toBeVisible();
      if (tool === "spawnAgent") await shot("subagent-creating");
      for (const [status, verb] of [
        ["completed", settled],
        ["failed", failed],
        ["interrupted", "Interrupted"],
      ]) {
        await screen.rerender(
          <MultiAgentActionDisclosure items={[entry(status!)]} fontSizePx={16} />,
        );
        expect(summary().textContent).toContain(verb);
        expect(summary().querySelector("[data-conversation-shimmer='true']")).toBeNull();
      }
    } finally {
      await screen.unmount();
    }
  });

  it("shows a pending approval card and removes the timeline permission after settlement", async () => {
    const screen = await render(
      <ComposerPendingApprovalPanel
        approval={{
          requestId: ApprovalRequestId.makeUnsafe("pass4-approval"),
          lifecycleGeneration: "pass4",
          requestKind: "command",
          createdAt: now,
          detail: 'Bash: {"command":"python3 capture.py"}',
        }}
        pendingCount={1}
        isResponding={false}
        onRespond={async () => {}}
      />,
    );
    try {
      await expect.element(page.getByRole("button", { name: /Allow once/u })).toBeVisible();
      await shot("approval-pending");
      const request = makeActivity({
        id: "permission-pass4",
        kind: "approval.requested",
        summary: "Permission",
        tone: "approval",
        sequence: 1,
        payload: { requestId: "permission-pass4", requestKind: "permissions" },
      });
      const resolved = makeActivity({
        id: "permission-settled",
        kind: "approval.resolved",
        summary: "Approved",
        tone: "info",
        sequence: 2,
        payload: { requestId: "permission-pass4" },
      });
      const rows = (settled: boolean) =>
        deriveWorkLogEntries(settled ? [request, resolved] : [request], undefined).map((entry) => (
          <Row key={entry.id} entry={entry} />
        ));
      await screen.rerender(<>{rows(false)}</>);
      await expect
        .element(page.getByTestId("permission-request-pending"))
        .toHaveTextContent("Awaiting approval");
      await screen.rerender(<>{rows(true)}</>);
      await expect.element(page.getByTestId("permission-request-pending")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("retains both mask edges with a composer inset and stamps only supplied handoff ids", async () => {
    const message: ChatMessage = {
      id: MessageId.makeUnsafe("pass4-message"),
      turnId: TurnId.makeUnsafe("pass4-turn"),
      role: "assistant",
      text: "Partial assistant tokens",
      createdAt: now,
      streaming: true,
      realtimeHandoffId: "provider-handoff-42",
    };
    const screen = await render(<Timeline message={message} inset={120} />);
    try {
      await expect
        .poll(() => document.querySelector("[data-realtime-handoff-id='provider-handoff-42']"))
        .not.toBeNull();
      const scroll = () => document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
      expect(scroll().style.getPropertyValue("--thread-scroll-padding-bottom")).toBe("120px");
      expect(scroll().style.paddingBottom).toBe("120px");
      // 合并后采用上游 scroll-edge-fade 架构：mask 由 CSS utility 组合，内联只写
      // composer overlay 变量（inset 120 + tuck 20 = 140；clearance 52，fade 40 → 92）。
      expect(scroll().classList.contains("scroll-edge-fade")).toBe(true);
      expect(scroll().style.getPropertyValue("--scroll-edge-fade-inset-b")).toBe("140px");
      expect(scroll().style.getPropertyValue("--scroll-edge-fade-tuck")).toBe("20px");
      expect(scroll().style.getPropertyValue("--scroll-edge-fade-layer")).toContain(
        "calc(100% - 92px)",
      );
      expect(scroll().style.getPropertyValue("--scroll-edge-fade-layer")).toContain(
        "calc(100% - 52px)",
      );
      expect(getComputedStyle(scroll()).maskImage).not.toBe("none");
      const completedMessage = { ...message, streaming: false, text: "Completed assistant text" };
      delete completedMessage.realtimeHandoffId;
      await screen.rerender(<Timeline message={completedMessage} inset={0} />);
      await expect
        .element(page.getByText("Completed assistant text", { exact: true }))
        .toBeVisible();
      expect(document.querySelector("[data-realtime-handoff-id]")).toBeNull();
      expect(scroll().classList.contains("scroll-edge-fade")).toBe(true);
      expect(scroll().style.getPropertyValue("--scroll-edge-fade-inset-b")).toBe("");
      expect(scroll().style.getPropertyValue("--scroll-edge-fade-layer")).toBe("");
      expect(getComputedStyle(scroll()).maskImage).not.toBe("none");
    } finally {
      await screen.unmount();
    }
  });
});
