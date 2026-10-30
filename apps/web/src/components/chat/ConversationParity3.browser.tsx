import "../../index.css";
import { MessageId, TurnId, type RuntimeMode } from "@synara/contracts";
import { useState } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { RuntimeUsageControls } from "../BranchToolbar";
import { ComposerAutoReviewApprovalNudge } from "./ComposerAutoReviewApprovalNudge";
import { useAutoReviewApprovalNudgeStore } from "./autoReviewApprovalNudgeState";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";
import { MessagesTimeline } from "./MessagesTimeline";
import { MultiAgentActionDisclosure } from "./MultiAgentActionDisclosure";
import { toastManager } from "../ui/toast";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../workLog";
import { makeActivity } from "../../storeTestFixtures";

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

const commandEntry: WorkLogEntry = {
  id: "exec",
  createdAt: "2026-09-05T00:00:00Z",
  label: "Ran command",
  tone: "tool",
  itemType: "command_execution",
  command: "pwd",
  turnId: TurnId.makeUnsafe("turn-parity3"),
  toolDetails: {
    kind: "command",
    title: "Shell",
    command: "pwd",
    cwd: "/workspace/moss",
    output: { stdout: "first line", stderr: "second line", exitCode: 0 },
  },
};
function WorkRow({ entry }: { entry: WorkLogEntry }) {
  return (
    <TimelineWorkEntryRow
      workEntry={entry}
      chatMetaFontSizePx={12}
      textFontSizePx={14}
      density="compact"
      onImageExpand={() => {}}
      markdownCwd={undefined}
      timestampFormat="locale"
    />
  );
}
function recordApprovals(threadId: string, count = 3) {
  for (let index = 0; index < count; index++)
    useAutoReviewApprovalNudgeStore
      .getState()
      .recordApproval(threadId, String(index), "accept", "approval-required");
}
function NudgeHost({
  persist,
  threadId = "nudge-thread",
}: {
  persist: (mode: RuntimeMode, notifyFailure?: boolean) => Promise<boolean>;
  threadId?: string;
}) {
  const [mode, setMode] = useState<RuntimeMode>("approval-required");
  return (
    <ComposerAutoReviewApprovalNudge
      threadId={threadId}
      runtimeMode={mode}
      autoModeAvailable
      persistRuntimeModeChange={async (next, notify) => {
        const succeeded = await persist(next, notify);
        if (succeeded) setMode(next);
        return succeeded;
      }}
    />
  );
}

beforeEach(async () => {
  await page.viewport(960, 720);
  useAutoReviewApprovalNudgeStore.setState({ threads: {} });
  document.documentElement.lang = "en";
});
afterEach(() => vi.restoreAllMocks());

describe("conversation parity pass 3", () => {
  it("shows the Codex three-tier menu with its title and Learn more link", async () => {
    const screen = await render(
      <RuntimeUsageControls
        provider="codex"
        providerStatus={{
          provider: "codex",
          instanceId: "codex",
          driver: "codex",
          status: "ready",
          available: true,
          authStatus: "authenticated",
          checkedAt: "2026-04-10T10:00:00.000Z",
          supportsAutoRuntimeMode: true,
        }}
        runtimeMode="approval-required"
        onRuntimeModeChange={() => {}}
      />,
    );
    try {
      await page.getByRole("button", { name: "Change permissions" }).click();
      // The tiers stand alone; the detailed risk copy lives behind Learn more.
      await expect.element(page.getByText("How should Moss actions be approved?")).toBeVisible();
      const learnMore = page.getByRole("link", { name: "Learn more" });
      await expect.element(learnMore).toBeVisible();
      expect(learnMore.element().getAttribute("href")).toBe(
        "https://developers.openai.com/codex/concepts/sandboxing#how-you-control-it",
      );
      // Exactly three tiers; the third expresses its risk with color, not a text wall.
      const items = page.getByRole("menuitemradio").elements();
      expect(items).toHaveLength(3);
      expect(items[2]?.textContent).toContain("Full access");
      expect(items[2]?.className).toContain("text-[var(--runtime-full-access-accent)]");
    } finally {
      await screen.unmount();
    }
  });

  it("gates full access behind cancel/confirm and preserves the prior mode on Escape", async () => {
    const onChange = vi.fn();
    const screen = await render(
      <RuntimeUsageControls runtimeMode="approval-required" onRuntimeModeChange={onChange} />,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: "Change permissions" }))
        .toHaveTextContent("Ask for approval");
      const openConfirmation = async () => {
        await page.getByRole("button", { name: "Change permissions" }).click();
        const fullAccess = page.getByRole("menuitemradio", { name: /Full access/u });
        await expect.element(fullAccess).toBeVisible();
        // base-ui 在 pointerdown 即提交选中并因确认对话框打开而卸载菜单，
        // Playwright 的实体点击会在元素 detached 上空转；直接派发 DOM click。
        (fullAccess.element() as HTMLElement).click();
        await expect.element(page.getByRole("alertdialog")).toBeVisible();
        expect(onChange).not.toHaveBeenCalled();
      };
      await openConfirmation();
      await expect.element(page.getByText("Turn on Full Access?")).toBeVisible();
      expect(page.getByRole("alertdialog").element().querySelector("a")?.getAttribute("href")).toBe(
        "https://developers.openai.com/codex/concepts/sandboxing#how-you-control-it",
      );
      for (const text of ["Files and folders", "Terminal commands", "Internet and connected apps"])
        await expect.element(page.getByText(text, { exact: true })).toBeVisible();
      (page.getByRole("button", { name: "Cancel", exact: true }).element() as HTMLElement).click();
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      await openConfirmation();
      await userEvent.keyboard("{Escape}");
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      await openConfirmation();
      await page.screenshot({
        path: "../../../../../.tmp/ui-parity/parity3/full-access-confirm.png",
      });
      (page.getByRole("button", { name: "Confirm", exact: true }).element() as HTMLElement).click();
      expect(onChange).toHaveBeenCalledExactlyOnceWith("full-access");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the Cyber warning and recommends guardian when the host provides the capability", async () => {
    const screen = await render(
      <RuntimeUsageControls
        runtimeMode="approval-required"
        onRuntimeModeChange={() => {}}
        isCyberModel
      />,
    );
    try {
      await page.getByRole("button", { name: "Change permissions" }).click();
      // base-ui 在 pointerdown 即提交选中并因确认对话框打开而卸载菜单，
      // Playwright 的实体点击会在元素 detached 上空转；直接派发 DOM click。
      (page.getByRole("menuitemradio", { name: /Full access/u }).element() as HTMLElement).click();
      await expect.element(page.getByText("Enable Full Access for Cyber model?")).toBeVisible();
      await expect
        .element(page.getByText(/We strongly recommend selecting "Approve for me"/u))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("offers Auto-review after three approvals and uses the shared mode persistence", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const screen = await render(<NudgeHost persist={persist} />);
    try {
      recordApprovals("nudge-thread", 2);
      await expect.element(page.getByTestId("auto-review-approval-nudge")).not.toBeInTheDocument();
      recordApprovals("nudge-thread");
      await expect.element(page.getByTestId("auto-review-approval-nudge")).toBeVisible();
      await page.getByRole("button", { name: /Approve for me/u }).click();
      await expect.poll(() => persist.mock.calls.length).toBe(1);
      expect(persist).toHaveBeenCalledWith("auto", false);
      await expect.element(page.getByTestId("auto-review-approval-nudge")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("persists manual dismissal across remounts and keeps it scoped to the thread", async () => {
    recordApprovals("nudge-thread");
    recordApprovals("other-thread");
    const persist = vi.fn().mockResolvedValue(true);
    let screen = await render(<NudgeHost persist={persist} />);
    await page.getByRole("button", { name: "Keep manual approvals" }).click();
    await screen.unmount();
    await useAutoReviewApprovalNudgeStore.persist.rehydrate();
    screen = await render(<NudgeHost persist={persist} />);
    try {
      await expect.element(page.getByTestId("auto-review-approval-nudge")).not.toBeInTheDocument();
      await screen.rerender(<NudgeHost persist={persist} threadId="other-thread" />);
      await expect.element(page.getByTestId("auto-review-approval-nudge")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the wired nudge retryable and emits its exact failure toast once", async () => {
    recordApprovals("nudge-thread");
    const toast = vi.spyOn(toastManager, "add").mockReturnValue("toast" as never);
    const persist = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const screen = await render(<NudgeHost persist={persist} />);
    try {
      await page.getByRole("button", { name: /Approve for me/u }).click();
      await expect.poll(() => toast.mock.calls.length).toBe(1);
      expect(toast).toHaveBeenCalledWith({
        type: "error",
        title: "Could not enable Auto-review — try again",
      });
      await expect.element(page.getByTestId("auto-review-approval-nudge")).toBeVisible();
      await page.getByRole("button", { name: /Approve for me/u }).click();
      await expect.element(page.getByTestId("auto-review-approval-nudge")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("marks collapsed exec bodies as find-skipped and exposes embedded Shell/command/output/footer on expansion", async () => {
    const screen = await render(<WorkRow entry={commandEntry} />);
    try {
      // 上游 mount-on-open 契约：折叠时详情体不在 DOM 中（而非 find-skip 常驻）。
      expect(document.querySelector('[data-testid="exec-shell-body"]')).toBeNull();
      const body = page.getByTestId("exec-shell-body");
      document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]")!.click();
      await expect.element(body).toBeVisible();
      // motionOpen 在下一帧置位后移除 find-skip。
      await expect.poll(() => body.element().hasAttribute("data-thread-find-skip")).toBe(false);
      expect(body.element().querySelector("[data-shell-cwd]")).toBeNull();
      expect(body.element().querySelector("[data-shell-label]")?.textContent).toBe("Shell");
      expect(body.element().textContent).toContain("first line");
      expect(body.element().textContent).toContain("second line");
      expect(body.element().querySelector("[data-shell-footer]")).toHaveAttribute(
        "data-shell-footer",
        "success",
      );
      await page.screenshot({
        path: "../../../../../.tmp/ui-parity/parity3/exec-expanded.png",
      });
      document.querySelector<HTMLButtonElement>("[data-tool-detail-trigger]")!.click();
      // 关闭动画期间短暂保留（find-skip），随后卸载。
      await expect.poll(() => document.querySelector('[data-testid="exec-shell-body"]')).toBeNull();
    } finally {
      await screen.unmount();
    }
  });

  it("renders pending permissions from workLog and removes them after completion", async () => {
    const requested = makeActivity({
      id: "approval",
      kind: "approval.requested",
      summary: "Permission",
      tone: "approval",
      sequence: 1,
      payload: { requestId: "permission", requestKind: "permissions" },
    });
    const resolved = makeActivity({
      id: "approval-done",
      kind: "approval.resolved",
      summary: "Approved",
      tone: "info",
      sequence: 2,
      payload: { requestId: "permission" },
    });
    const rows = (done: boolean) =>
      deriveWorkLogEntries(done ? [requested, resolved] : [requested], undefined).map((entry) => (
        <WorkRow key={entry.id} entry={entry} />
      ));
    const screen = await render(<>{rows(false)}</>);
    try {
      await expect
        .element(page.getByTestId("permission-request-pending"))
        .toHaveTextContent("Awaiting approval");
      expect(
        getComputedStyle(page.getByTestId("permission-request-pending").element())
          .paddingInlineStart,
      ).toBe("0px");
      await screen.rerender(<>{rows(true)}</>);
      await expect.element(page.getByTestId("permission-request-pending")).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("provides stable turn/content find keys and conversation target scroll margin", async () => {
    const message = {
      id: MessageId.makeUnsafe("find-message"),
      role: "user" as const,
      text: "Find this message",
      turnId: TurnId.makeUnsafe("turn-parity3"),
      createdAt: "2026-09-05T00:00:00Z",
      streaming: false,
    };
    const screen = await render(
      <div style={{ height: 500 }}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          timelineEntries={[
            { id: message.id, kind: "message", createdAt: message.createdAt, message },
          ]}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-09-05T00:00:00Z"
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
        />
      </div>,
    );
    try {
      await expect
        .poll(() => document.querySelector("[data-content-search-turn-key='turn-parity3']"))
        .not.toBeNull();
      const target = document.querySelector<HTMLElement>(
        "[data-content-search-turn-key='turn-parity3']",
      )!;
      expect(target.dataset.contentSearchUnitKey).toBeTruthy();
      expect(target.dataset.threadFindTarget).toBe("conversation");
      expect(getComputedStyle(target).scrollMarginTop).toBe("96px");
    } finally {
      await screen.unmount();
    }
  });

  it("captures the existing multi-agent disclosure fixture", async () => {
    const screen = await render(
      <div style={{ width: 680, padding: 24 }}>
        <MultiAgentActionDisclosure
          items={[
            {
              id: "multi",

              subagentAction: {
                tool: "spawn_agent",
                status: "in_progress",
                summaryText: "Spawning agent",
                prompt: "Inspect transcript parity",
              },
              subagents: [
                { threadId: "scout", nickname: "Scout", role: "explorer", rawStatus: "running" },
              ],
            },
          ]}
          fontSizePx={14}
        />
      </div>,
    );
    try {
      await expect.element(page.getByTestId("multi-agent-action-rows")).toBeVisible();
      await page.screenshot({
        path: "../../../../../.tmp/ui-parity/parity3/multi-agent-expanded.png",
      });
    } finally {
      await screen.unmount();
    }
  });
});
