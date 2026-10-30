// FILE: SidebarThreadRowContent.browser.tsx
// Purpose: Characterizes the shared Sidebar thread-row identity and status presentation.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { cn } from "../lib/utils";
import { SIDEBAR_HEADER_ROW_CLASS_NAME } from "../sidebarRowStyles";
import { useStore } from "../store";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SidebarThreadSummary,
} from "../types";
import { resolveThreadRowClassName } from "./Sidebar.logic";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";

function makeThread(overrides: Partial<SidebarThreadSummary> = {}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-row-content"),
    projectId: ProjectId.makeUnsafe("project-row-content"),
    title: "Shared thread row",
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.4" },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-07-19T12:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    pendingBackgroundWorkCount: 0,
    ...overrides,
  };
}

const originalStoreState = useStore.getState();

function StoreThreadRow({ threadId }: { threadId: ThreadId }) {
  const thread = useStore((state) => state.sidebarThreadSummaryById[threadId]);
  if (!thread) return null;
  return (
    <SidebarThreadRowContent
      thread={thread}
      terminalEntryPoint={false}
      terminalStatus={null}
      terminalCount={0}
      isActive={false}
      variant="standard"
    />
  );
}

describe("SidebarThreadRowContent", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useStore.setState(originalStoreState, true);
  });

  it("preserves the pinned title, pending state, terminal count, and suffix", async () => {
    const thread = makeThread();
    const screen = await render(
      <SidebarThreadRowContent
        thread={thread}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={2}
        isActive
        variant="pinned"
        pendingStatusColorClass="text-emerald-700"
        suffix={<span>Project Alpha</span>}
      />,
    );

    await expect
      .element(screen.getByTestId(`thread-title-${thread.id}`))
      .toHaveTextContent("Shared thread row");
    await expect
      .element(screen.getByLabelText("Awaiting approval"))
      .toHaveTextContent("Awaiting approval");
    await expect.element(screen.getByLabelText("2 terminals open")).toBeVisible();
    await expect.element(screen.getByText("Project Alpha")).toBeVisible();
    expect(
      document.querySelector("[data-sidebar-provider]")?.getAttribute("data-sidebar-provider"),
    ).toBe("codex");
  });

  it("shows a distinct provider glyph on standard rows for every CLI", async () => {
    const providers = [
      ["codex", "gpt-5.4"],
      ["claudeAgent", "claude-sonnet"],
      ["grok", "grok-4"],
      ["cursor", "cursor-composer"],
      ["opencode", "opencode"],
      ["pi", "pi/default"],
    ] as const;
    await render(
      <div>
        {providers.map(([provider, model]) => (
          <SidebarThreadRowContent
            key={provider}
            thread={makeThread({
              id: ThreadId.makeUnsafe(`standard-${provider}`),
              title: `${provider} thread`,
              modelSelection: { provider, instanceId: provider, model },
            })}
            terminalEntryPoint={false}
            terminalStatus={null}
            terminalCount={0}
            isActive={false}
            variant="standard"
          />
        ))}
      </div>,
    );

    const marks = [...document.querySelectorAll("[data-sidebar-provider]")];
    expect(marks.map((mark) => mark.getAttribute("data-sidebar-provider"))).toEqual(
      providers.map(([provider]) => provider),
    );
    const viewBoxes = marks.map((mark) => mark.querySelector("svg")?.getAttribute("viewBox"));
    expect(viewBoxes.every((viewBox) => viewBox && viewBox.length > 0)).toBe(true);
    expect(new Set(viewBoxes).size).toBeGreaterThan(1);
    expect(viewBoxes[1]).toBe("0 0 256 257");
  });

  it("keeps the approval chip beside the provider glyph on a standard row", async () => {
    const thread = makeThread({
      id: ThreadId.makeUnsafe("standard-approval"),
      title: "Claude approval",
      modelSelection: {
        provider: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-sonnet",
      },
    });
    const screen = await render(
      <SidebarThreadRowContent
        thread={thread}
        terminalEntryPoint={false}
        terminalStatus={null}
        terminalCount={0}
        isActive={false}
        variant="standard"
        pendingStatusColorClass="text-emerald-700"
      />,
    );

    await expect.element(screen.getByLabelText("Awaiting approval")).toBeVisible();
    const chip = document.querySelector("[aria-label='Awaiting approval']");
    expect(chip?.className).toContain("rounded-full");
    expect(chip?.className).toContain("#00a240");
    expect(
      document.querySelector("[data-sidebar-provider]")?.getAttribute("data-sidebar-provider"),
    ).toBe("claudeAgent");
  });

  it("omits the provider glyph for a generic title and for a terminal entry point", async () => {
    await render(
      <div>
        <SidebarThreadRowContent
          thread={makeThread({
            id: ThreadId.makeUnsafe("generic-title"),
            title: "New thread",
          })}
          terminalEntryPoint={false}
          terminalStatus={null}
          terminalCount={0}
          isActive={false}
          variant="standard"
        />
        <SidebarThreadRowContent
          thread={makeThread({
            id: ThreadId.makeUnsafe("terminal-entry"),
            title: "Shell session",
          })}
          terminalEntryPoint
          terminalStatus={null}
          terminalCount={0}
          isActive={false}
          variant="pinned"
        />
      </div>,
    );

    expect(document.querySelector("[data-sidebar-provider]")).toBeNull();
  });

  it("keeps the provider icon on the title's row without growing past the main row height", async () => {
    const standardTitle = "Claude thread title that is long enough to truncate cleanly";
    await render(
      <div className="w-60">
        <div
          data-row="main"
          className={cn(resolveThreadRowClassName({ isActive: false, isSelected: false }), "pr-2")}
        >
          <SidebarThreadRowContent
            thread={makeThread({
              id: ThreadId.makeUnsafe("main-height"),
              title: "New thread",
            })}
            terminalEntryPoint={false}
            terminalStatus={null}
            terminalCount={0}
            isActive={false}
            variant="standard"
          />
        </div>
        <div
          data-row="standard"
          className={cn(resolveThreadRowClassName({ isActive: false, isSelected: false }), "pr-2")}
        >
          <SidebarThreadRowContent
            thread={makeThread({
              id: ThreadId.makeUnsafe("standard-inline"),
              title: standardTitle,
              modelSelection: {
                provider: "claudeAgent",
                instanceId: "claudeAgent",
                model: "claude-sonnet",
              },
            })}
            terminalEntryPoint={false}
            terminalStatus={null}
            terminalCount={0}
            isActive={false}
            variant="standard"
          />
        </div>
        <div
          data-row="pinned"
          className={cn(SIDEBAR_HEADER_ROW_CLASS_NAME, "relative gap-1.5 pr-2")}
        >
          <SidebarThreadRowContent
            thread={makeThread({
              id: ThreadId.makeUnsafe("pinned-inline"),
              title: "Codex pinned title",
            })}
            terminalEntryPoint={false}
            terminalStatus={null}
            terminalCount={0}
            isActive={false}
            variant="pinned"
          />
        </div>
      </div>,
    );

    const row = (name: string) => document.querySelector(`[data-row="${name}"]`) as HTMLElement;
    const main = row("main");
    const standard = row("standard");
    const pinned = row("pinned");
    expect(standard.offsetHeight).toBe(main.offsetHeight);
    expect(pinned.offsetHeight).toBe(main.offsetHeight);
    expect(standard.offsetHeight).toBeGreaterThan(0);
    expect(standard.scrollHeight).toBe(standard.clientHeight);
    expect(pinned.scrollHeight).toBe(pinned.clientHeight);

    const standardIcon = standard.querySelector("[data-sidebar-provider]")!.getBoundingClientRect();
    const pinnedIcon = pinned.querySelector("[data-sidebar-provider]")!.getBoundingClientRect();
    for (const shell of [standard, pinned]) {
      const icon = shell.querySelector("[data-sidebar-provider]")!.getBoundingClientRect();
      const title = shell.querySelector("[data-sidebar-thread-title]")!.getBoundingClientRect();
      const iconMid = icon.top + icon.height / 2;
      const titleMid = title.top + title.height / 2;
      expect(Math.abs(iconMid - titleMid)).toBeLessThanOrEqual(1);
      expect(icon.top).toBeGreaterThanOrEqual(title.top - 1);
      expect(icon.bottom).toBeLessThanOrEqual(title.bottom + 1);
      expect(icon.right).toBeLessThanOrEqual(title.left);
      const line = getComputedStyle(shell.querySelector("[data-sidebar-thread-line]")!);
      expect(line.display).toBe("flex");
      expect(line.flexWrap).toBe("nowrap");
      expect(getComputedStyle(shell.querySelector("[data-sidebar-provider]")!).flexShrink).toBe(
        "0",
      );
      expect(getComputedStyle(shell.querySelector("[data-sidebar-thread-title]")!).overflow).toBe(
        "hidden",
      );
    }
    expect(standardIcon.width).toBeCloseTo(pinnedIcon.width, 0);
    const standardTitleBox = standard
      .querySelector("[data-sidebar-thread-title]")!
      .getBoundingClientRect();
    const pinnedTitleBox = pinned
      .querySelector("[data-sidebar-thread-title]")!
      .getBoundingClientRect();
    expect(standardTitleBox.left - standardIcon.right).toBeCloseTo(
      pinnedTitleBox.left - pinnedIcon.right,
      0,
    );
  });

  it("updates an unnamed child's sibling label and status without replacing a regular CLI glyph", async () => {
    const parent = makeThread({
      id: ThreadId.makeUnsafe("subagent-parent"),
      title: "Codex parent",
    });
    const child = makeThread({
      id: ThreadId.makeUnsafe("subagent:parent:provider-child"),
      parentThreadId: parent.id,
      title: "Subagent provider-child",
      subagentAgentId: "provider-child",
      hasLiveTailWork: true,
    });
    const earlierSibling = makeThread({
      id: ThreadId.makeUnsafe("subagent:parent:earlier-child"),
      parentThreadId: parent.id,
      title: "Subagent earlier-child",
      createdAt: "2026-07-19T11:00:00.000Z",
    });
    useStore.setState({
      threadIds: [parent.id, child.id],
      threadShellById: {
        [parent.id]: {
          ...parent,
          codexThreadId: null,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          error: null,
        },
      },
      sidebarThreadSummaryById: { [parent.id]: parent, [child.id]: child },
    });
    const screen = await render(
      <div className="w-60 text-foreground">
        <StoreThreadRow threadId={parent.id} />
        <div data-testid="subagent-row">
          <StoreThreadRow threadId={child.id} />
        </div>
      </div>,
    );
    const childTitle = screen.getByTestId("subagent-row");
    const statusDot = screen.getByTestId("sidebar-subagent-status-dot");
    await expect.element(childTitle).toHaveTextContent("Subagent 1");
    await expect.element(statusDot).toHaveAttribute("data-status", "running");
    const dot = document.querySelector("[data-testid='sidebar-subagent-status-dot']")!;
    expect(dot.parentElement?.getAttribute("title")).toBe("Running");
    expect(dot.parentElement?.hasAttribute("aria-hidden")).toBe(false);
    expect(getComputedStyle(dot).width).toBe("6px");
    expect(getComputedStyle(dot).height).toBe("6px");
    const runningColor = getComputedStyle(dot).backgroundColor;
    const name = document.querySelector(
      "[data-testid='subagent-row'] [data-sidebar-thread-title] .font-medium",
    )!;
    expect(getComputedStyle(name).color).toBe(getComputedStyle(name.parentElement!).color);
    expect(name.getAttribute("style")).toBeNull();
    const providerGlyph = document.querySelector("[data-sidebar-provider='codex']")!;
    expect(providerGlyph.querySelector("svg")).not.toBeNull();

    useStore.setState({
      threadIds: [parent.id, child.id, earlierSibling.id],
      sidebarThreadSummaryById: {
        [parent.id]: parent,
        [earlierSibling.id]: earlierSibling,
        [child.id]: {
          ...child,
          hasLiveTailWork: false,
          latestTurn: {
            turnId: TurnId.makeUnsafe("subagent-completed-turn"),
            state: "completed",
            requestedAt: child.createdAt,
            startedAt: child.createdAt,
            completedAt: "2026-07-19T12:01:00.000Z",
            assistantMessageId: null,
          },
        },
      },
    });
    await expect.element(childTitle).toHaveTextContent("Subagent 2");
    await expect.element(statusDot).toHaveAttribute("data-status", "completed");
    expect(dot.parentElement?.getAttribute("title")).toBe("Completed");
    expect(getComputedStyle(dot).width).toBe("6px");
    expect(getComputedStyle(dot).height).toBe("6px");
    expect(getComputedStyle(dot).backgroundColor).not.toBe(runningColor);
    expect(getComputedStyle(name).color).toBe(getComputedStyle(name.parentElement!).color);
    expect(document.body.textContent).not.toContain("provider-child");
    expect(document.querySelector("[data-sidebar-provider='codex']")).toBe(providerGlyph);
    expect(document.querySelectorAll("[data-sidebar-provider]")).toHaveLength(1);
  });
});
