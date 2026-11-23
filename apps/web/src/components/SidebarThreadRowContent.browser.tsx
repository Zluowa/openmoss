// FILE: SidebarThreadRowContent.browser.tsx
// Purpose: Characterizes the shared Sidebar thread-row identity and status presentation.
// Layer: Browser UI test

import "../index.css";

import { ProjectId, ThreadId, TurnId } from "@moss/contracts";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { cn } from "../lib/utils";
import { MossLocaleScope } from "../localization";
import { SIDEBAR_HEADER_ROW_CLASS_NAME } from "../sidebarRowStyles";
import { useStore } from "../store";
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../theme/theme.logic";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type SidebarThreadSummary,
} from "../types";
import { buildProjectThreadTree, resolveThreadRowClassName } from "./Sidebar.logic";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";
import {
  registerSubagentMarkOrder,
  resetSubagentMarkOrderForTests,
  subagentMarkIndexFor,
} from "./chat/subagentMarkOrder";

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

  it("renders an imported child immediately under its parent in the project tree", async () => {
    const parentId = ThreadId.makeUnsafe("imported-parent");
    const childId = ThreadId.makeUnsafe("imported-child");
    const { innerWidth, innerHeight } = window;
    const root = document.documentElement;
    const originalStyle = root.style.cssText;
    const wasDark = root.classList.contains("dark");
    await page.viewport(340, 480);
    try {
      for (const locale of ["zh-CN", "en"] as const) {
        const parent = makeThread({
          id: parentId,
          title: locale === "zh-CN" ? "工作区规划" : "Workspace plan",
          modelSelection: { provider: "claudeAgent", model: "claude-sonnet" },
        });
        const child = makeThread({
          id: childId,
          title: locale === "zh-CN" ? "核对导入记录" : "Review import notes",
          parentThreadId: parentId,
          modelSelection: parent.modelSelection,
        });
        const unrelated = makeThread({ title: locale === "zh-CN" ? "其他对话" : "Another chat" });
        const rows = buildProjectThreadTree({
          threads: [child, unrelated, parent],
          expandedParentThreadIds: new Set([parentId]),
        });
        let lightBackground: string | undefined;
        for (const theme of ["light", "dark"] as const) {
          const { variables } = buildThemeCssVariables(
            resolveThemePack(DEFAULT_THEME_STATE, theme),
            theme,
            { electron: false, isMac: false },
          );
          root.classList.toggle("dark", theme === "dark");
          for (const [name, value] of Object.entries(variables))
            root.style.setProperty(name, value);
          const screen = await render(
            <MossLocaleScope locale={locale}>
              <div
                lang={locale}
                data-testid="imported-project-tree"
                className="min-h-screen bg-sidebar p-ui-pad-sm text-sidebar-foreground"
              >
                {rows.map(({ thread }) => (
                  <div
                    key={thread.id}
                    className={resolveThreadRowClassName({ isActive: false, isSelected: false })}
                  >
                    <SidebarThreadRowContent
                      thread={thread}
                      terminalEntryPoint={false}
                      terminalStatus={null}
                      terminalCount={0}
                      isActive={false}
                      variant="standard"
                    />
                  </div>
                ))}
              </div>
            </MossLocaleScope>,
          );
          const parentTitle = screen.getByText(parent.title, { exact: true });
          const childTitle = screen.getByText(child.title, { exact: true });
          await expect.element(childTitle).toBeVisible();
          await expect.element(screen.getByTestId("sidebar-subagent-mark")).toBeVisible();
          const parentBounds = parentTitle.element().getBoundingClientRect();
          const childBounds = childTitle.element().getBoundingClientRect();
          const background = getComputedStyle(
            screen.getByTestId("imported-project-tree").element(),
          ).backgroundColor;
          if (theme === "light") lightBackground = background;
          else expect(background).not.toBe(lightBackground);
          expect(childBounds.top).toBeGreaterThan(parentBounds.top);
          expect(childBounds.top - parentBounds.top).toBeLessThan(40);
          expect(childBounds.left).toBeGreaterThan(parentBounds.left);
          expect(childBounds.width).toBeGreaterThan(0);
          await page.screenshot({
            path: `__screenshots__/cli-import-projects/${locale}-${theme}.png`,
          });
          await screen.unmount();
        }
      }
    } finally {
      root.style.cssText = originalStyle;
      root.classList.toggle("dark", wasDark);
      await page.viewport(innerWidth, innerHeight);
    }
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
    const statusMark = screen.getByTestId("sidebar-subagent-mark");
    await expect.element(childTitle).toHaveTextContent("Subagent 1");
    await expect.element(statusMark).toHaveAttribute("data-status", "running");
    const mark = document.querySelector<HTMLElement>("[data-testid='sidebar-subagent-mark']")!;
    expect(mark.parentElement?.getAttribute("title")).toBe("Running");
    expect(mark.parentElement?.hasAttribute("aria-hidden")).toBe(false);
    // The subagent's own mark, painted at 14 px, the one its transcript row wears.
    expect(mark.hasAttribute("data-subagent-mark")).toBe(true);
    expect(getComputedStyle(mark).width).toBe("14px");
    expect(getComputedStyle(mark).height).toBe("14px");
    const painted = mark.querySelector("svg path")!;
    expect(getComputedStyle(painted).fill).not.toBe("none");
    expect(Number(mark.dataset.subagentMarkIndex)).toBe(subagentMarkIndexFor("provider-child"));
    // It turns while the subagent works.
    expect(mark.hasAttribute("data-running")).toBe(true);
    expect(getComputedStyle(mark.querySelector("svg")!).animationName).not.toBe("none");
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
    await expect.element(statusMark).toHaveAttribute("data-status", "completed");
    expect(mark.parentElement?.getAttribute("title")).toBe("Completed");
    // Done: the same mark, still.
    expect(mark.hasAttribute("data-running")).toBe(false);
    expect(Number(mark.dataset.subagentMarkIndex)).toBe(subagentMarkIndexFor("provider-child"));
    expect(getComputedStyle(name).color).toBe(getComputedStyle(name.parentElement!).color);
    expect(document.body.textContent).not.toContain("provider-child");
    expect(document.querySelector("[data-sidebar-provider='codex']")).toBe(providerGlyph);
    expect(document.querySelectorAll("[data-sidebar-provider]")).toHaveLength(1);
  });
});

describe("sidebar subagent marks", () => {
  afterEach(() => {
    resetSubagentMarkOrderForTests();
  });

  it("wears the same mark the parent chat's transcript gave each subagent", async () => {
    const parent = makeThread({ id: ThreadId.makeUnsafe("marks-parent"), title: "Codex parent" });
    const first = makeThread({
      id: ThreadId.makeUnsafe("subagent:marks-parent:provider-a"),
      parentThreadId: parent.id,
      title: "explain_recursion",
    });
    const second = makeThread({
      id: ThreadId.makeUnsafe("subagent:marks-parent:provider-b"),
      parentThreadId: parent.id,
      title: "explain_closure",
    });
    // The transcript's work log names provider-b first, then provider-a.
    registerSubagentMarkOrder(parent.id, [
      { subagents: [{ threadId: "provider-b", providerThreadId: "provider-b" }] },
      { subagents: [{ threadId: "provider-a", providerThreadId: "provider-a" }] },
    ]);
    useStore.setState({
      threadIds: [parent.id, first.id, second.id],
      sidebarThreadSummaryById: {
        [parent.id]: parent,
        [first.id]: first,
        [second.id]: second,
      },
    });
    await render(
      <div className="w-60 text-foreground">
        <StoreThreadRow threadId={first.id} />
        <StoreThreadRow threadId={second.id} />
      </div>,
    );
    await vi.waitFor(() =>
      expect(document.querySelectorAll("[data-testid='sidebar-subagent-mark']")).toHaveLength(2),
    );
    const marks = [
      ...document.querySelectorAll<HTMLElement>("[data-testid='sidebar-subagent-mark']"),
    ];
    expect(marks.map((mark) => mark.dataset.subagentMarkIndex)).toEqual(["1", "0"]);
    const look = (mark: HTMLElement) =>
      `${mark.dataset.subagentMarkShape}/${mark.dataset.subagentMarkTone}`;
    expect(look(marks[0]!)).not.toBe(look(marks[1]!));
    // No grey status dot anywhere.
    expect(document.querySelector("[data-testid='sidebar-subagent-status-dot']")).toBeNull();
  });

  it("toggles parent thread collapse via inline chevron without activating the row", async () => {
    const parentId = ThreadId.makeUnsafe("collapse-parent");
    const childAId = ThreadId.makeUnsafe("collapse-child-a");
    const childBId = ThreadId.makeUnsafe("collapse-child-b");
    const parent = makeThread({ id: parentId, title: "Imported session" });
    const childA = makeThread({ id: childAId, parentThreadId: parentId, title: "Child one" });
    const childB = makeThread({ id: childBId, parentThreadId: parentId, title: "Child two" });
    const threads = [parent, childA, childB];

    for (const [locale, expectedCollapseLabel, expectedExpandLabel] of [
      ["zh-CN", "收起 2 个子会话", "展开 2 个子会话"],
      ["en", "Collapse 2 child chats", "Expand 2 child chats"],
    ] as const) {
      const onRowClick = vi.fn();
      const onRowPointerDown = vi.fn();
      const Harness = () => {
        const [collapsed, setCollapsed] = useState<Set<ThreadId>>(() => new Set());
        const rows = buildProjectThreadTree({
          threads,
          forceVisibleThreadId: parentId,
          collapsedParentThreadIds: collapsed,
        });
        return (
          <MossLocaleScope locale={locale}>
            <div>
              {rows.map((row) => (
                <div
                  key={row.thread.id}
                  role="button"
                  tabIndex={0}
                  data-testid={`row-${row.thread.id}`}
                  onPointerDown={() => onRowPointerDown(row.thread.id)}
                  onClick={() => onRowClick(row.thread.id)}
                >
                  <SidebarThreadRowContent
                    thread={row.thread}
                    terminalEntryPoint={false}
                    terminalStatus={null}
                    terminalCount={0}
                    isActive={row.thread.id === parentId}
                    variant="standard"
                    childCount={row.childCount}
                    isParentCollapsed={row.isParentCollapsed}
                    onToggleParentCollapse={
                      row.hasChildren
                        ? () =>
                            setCollapsed((current) => {
                              const next = new Set(current);
                              if (next.has(row.thread.id)) next.delete(row.thread.id);
                              else next.add(row.thread.id);
                              return next;
                            })
                        : undefined
                    }
                  />
                </div>
              ))}
            </div>
          </MossLocaleScope>
        );
      };

      const screen = await render(<Harness />);
      await expect.element(screen.getByText("Child one")).toBeVisible();
      await expect.element(screen.getByText("Child two")).toBeVisible();

      const toggleButton = screen.getByTestId(`thread-parent-collapse-${parentId}`);
      await expect.element(toggleButton).toHaveAttribute("aria-expanded", "true");
      await expect.element(toggleButton).toHaveAttribute("aria-label", expectedCollapseLabel);

      await toggleButton.click();
      await expect.element(toggleButton).toHaveAttribute("aria-expanded", "false");
      await expect.element(toggleButton).toHaveAttribute("aria-label", expectedExpandLabel);
      expect(screen.container.querySelector(`[data-testid='row-${childAId}']`)).toBeNull();
      expect(screen.container.querySelector(`[data-testid='row-${childBId}']`)).toBeNull();
      expect(onRowClick).not.toHaveBeenCalled();
      expect(onRowPointerDown).not.toHaveBeenCalled();

      await toggleButton.click();
      await expect.element(toggleButton).toHaveAttribute("aria-expanded", "true");
      await expect.element(screen.getByText("Child one")).toBeVisible();
      expect(onRowClick).not.toHaveBeenCalled();

      await screen.getByText("Imported session").click();
      expect(onRowClick).toHaveBeenCalledWith(parentId);
      await screen.unmount();
    }
  });
});
