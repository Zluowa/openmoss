// MERGE-GAP(2026-10-09): upstream's dock tests assume the base RightDock geometry
// (defaultWidth vw resolution, Maximize/Restore control). Moss's RightDock rewrite
// keeps the rail layout on the --sidebar-width pipeline with a fullWidth toggle, so
// these cases do not apply as written. Previously skipped on main for the same drift
// (MERGE-GAP 2026-10-07, main 同样失败).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { page } from "vitest/browser";
import "../../index.css";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { RightDock } from "./RightDock";
import type { RightDockThreadState } from "../../rightDockStore.logic";

const dockTabs = () => [
  ...document.querySelectorAll<HTMLElement>('nav[aria-label="Open panels"] [data-surface-tab]'),
];
const dockTabLabels = () =>
  dockTabs().map((tab) => tab.querySelector("button:not([aria-label])")!.textContent);
const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const mousePointerEvent = (type: string, x: number, y: number) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerType: "mouse",
    pointerId: 1,
    isPrimary: true,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    clientX: x,
    clientY: y,
  });
const makeFilePane = (id: string) => ({
  id,
  kind: "file" as const,
  filePath: id + ".md",
  threadId: null,
  diffTurnId: null,
  diffFilePath: null,
  pullRequestProjectId: null,
  pullRequestRepository: null,
  pullRequestNumber: null,
  pullRequestInitialTab: null,
});

const measureDockWidth = () =>
  Math.round(
    document.querySelector<HTMLElement>("[data-slot='sidebar-container']")!.getBoundingClientRect()
      .width,
  );

function renderDock(content: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(<QueryClientProvider client={client}>{content}</QueryClientProvider>);
}

it.skip("keeps the resize rail reachable from the chat side in the rail layout", async () => {
  await page.viewport(1280, 800);
  const { createDefaultRightDockState, openPaneInState } =
    await import("../../rightDockStore.logic");
  const state = openPaneInState(createDefaultRightDockState(), {
    paneId: "browser",
    kind: "browser",
  });
  const screen = await renderDock(
    <div data-sidebar-layout="rail" className="flex h-screen w-screen">
      <div className="min-w-0 flex-1">Chat</div>
      <RightDock
        state={state}
        minWidth={300}
        defaultWidth="50vw"
        shouldAcceptWidth={() => true}
        addMenuKinds={[]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={() => {}}
        renderPane={() => <div className="h-full w-full">Browser viewport</div>}
      />
    </div>,
  );
  try {
    const rail = document.querySelector<HTMLButtonElement>("[data-slot='sidebar-rail']")!;
    const container = document.querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
    await expect.poll(() => Math.round(container.getBoundingClientRect().width)).toBe(640);
    const { left, top, height } = container.getBoundingClientRect();
    const y = top + height / 2;
    // This side of the seam is outside Electron's native browser viewport.
    expect(document.elementFromPoint(left - 4, y)).toBe(rail);
    const handle = page.getByRole("button", { name: "Resize Sidebar" });
    await handle.hover({
      position: { x: 4, y: height / 2 },
    });
    expect(rail.matches(":hover")).toBe(true);
    expect(getComputedStyle(rail).cursor).toMatch(/resize/);
    for (const delta of [-100, 100]) {
      const width = container.getBoundingClientRect().width;
      await handle.dropTo(handle, {
        sourcePosition: { x: 4, y: height / 2 },
        targetPosition: { x: 4 + delta, y: height / 2 },
        force: true,
      });
      await expect
        .poll(() => container.getBoundingClientRect().width)
        .toBeCloseTo(width - delta, 0);
    }
  } finally {
    await screen.unmount();
  }
});

it.skip("maximizes and restores without remounting or resetting document state", async () => {
  await page.viewport(1280, 800);
  const state: RightDockThreadState = {
    open: true,
    activePaneId: "file",
    panes: [
      {
        id: "file",
        kind: "file",
        filePath: "note.md",
        threadId: null,
        diffTurnId: null,
        diffFilePath: null,
        pullRequestProjectId: null,
        pullRequestRepository: null,
        pullRequestNumber: null,
        pullRequestInitialTab: null,
      },
    ],
  };
  const screen = await render(
    <div style={{ display: "flex", width: 1000, height: 600 }}>
      <div data-testid="chat" style={{ flex: 1 }}>
        Chat continues
      </div>
      <RightDock
        state={state}
        minWidth={300}
        defaultWidth="500px"
        shouldAcceptWidth={() => true}
        addMenuKinds={[]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={() => {}}
        renderPane={() => (
          <div data-testid="document" style={{ overflow: "auto", height: 400, width: "100%" }}>
            <input aria-label="Draft" defaultValue="Keep me" />
            <div style={{ height: 2000 }}>Document</div>
          </div>
        )}
      />
    </div>,
  );
  await expect
    .element(screen.getByRole("button", { name: "Maximize panel", exact: true }))
    .toBeVisible();
  const doc = document.querySelector<HTMLElement>('[data-testid="document"]')!;
  doc.scrollTop = 120;
  const container = doc.closest<HTMLElement>('[data-slot="sidebar-container"]')!;
  const originalWidth = container.getBoundingClientRect().width;
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await expect.poll(() => container.getBoundingClientRect().width).toBe(1000);
  expect(document.querySelector('[data-testid="document"]')).toBe(doc);
  expect(doc.scrollTop).toBe(120);
  expect(document.querySelector<HTMLElement>('[data-testid="chat"]')!.inert).toBe(true);
  expect(document.querySelector<HTMLElement>('[data-testid="chat"]')!.style.visibility).toBe(
    "hidden",
  );
  await screen.getByRole("button", { name: "Restore panel", exact: true }).click();
  await expect.poll(() => container.getBoundingClientRect().width).toBe(originalWidth);
  expect(document.querySelector('[data-testid="document"]')).toBe(doc);
  expect(doc.scrollTop).toBe(120);
  expect(document.querySelector<HTMLElement>('[data-testid="chat"]')!.inert).toBe(false);
});

it("keeps each file tab mounted so switching tabs preserves its scroll position", async () => {
  await page.viewport(1280, 800);
  const { useState } = await import("react");
  function Harness() {
    const [state, setState] = useState<RightDockThreadState>({
      open: true,
      activePaneId: "a",
      panes: [makeFilePane("a"), makeFilePane("b")],
    });
    return (
      <div style={{ display: "flex", width: 1000, height: 600 }}>
        <div style={{ flex: 1 }}>Chat</div>
        <RightDock
          state={state}
          paneLabelOverrides={{ a: "a.md", b: "b.md" }}
          minWidth={300}
          defaultWidth="500px"
          shouldAcceptWidth={() => true}
          addMenuKinds={[]}
          onSelectPane={(id) => setState((current) => ({ ...current, activePaneId: id }))}
          onClosePane={() => {}}
          onCollapse={() => {}}
          onOpenChange={() => {}}
          onAddPane={() => {}}
          renderPane={(currentPane) => (
            <div
              data-testid={`file-pane-${currentPane.id}`}
              style={{ height: 400, overflow: "auto" }}
            >
              <div style={{ height: 2000 }}>Document {currentPane.id}</div>
            </div>
          )}
        />
      </div>
    );
  }

  const screen = await renderDock(<Harness />);
  const firstPane = document.querySelector<HTMLElement>('[data-testid="file-pane-a"]')!;
  firstPane.scrollTop = 240;
  await screen.getByRole("button", { name: "b.md", exact: true }).click();
  await expect.element(screen.getByText("Document b", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "a.md", exact: true }).click();
  await expect.element(screen.getByText("Document a", { exact: true })).toBeVisible();
  expect(document.querySelector('[data-testid="file-pane-a"]')).toBe(firstPane);
  expect(firstPane.scrollTop).toBe(240);
  await screen.unmount();
});

it("opens each chat's dock at its own remembered width and falls back to the shared width", async () => {
  await page.viewport(1280, 800);
  const { useState } = await import("react");
  const { RIGHT_DOCK_WIDTH_STORAGE_KEY, rightDockThreadWidthStorageKey } =
    await import("./rightDockSizing.logic");
  // Stored values are ratios of the regular range: 320px (0) to 1000 - 352 = 648px (1).
  localStorage.setItem(rightDockThreadWidthStorageKey("a"), "0");
  localStorage.setItem(rightDockThreadWidthStorageKey("b"), "1");
  localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, "0.5");
  localStorage.removeItem(rightDockThreadWidthStorageKey("c"));
  function Harness() {
    const [thread, setThread] = useState("a");
    return (
      <>
        {["a", "b", "c"].map((id) => (
          <button key={id} type="button" onClick={() => setThread(id)}>
            Open chat {id}
          </button>
        ))}
        <div style={{ display: "flex", width: 1000, height: 600 }}>
          <div style={{ flex: 1 }}>Chat {thread}</div>
          <RightDock
            state={{ open: true, activePaneId: "a", panes: [makeFilePane("a")] }}
            motionKey={thread}
            widthStorageKey={rightDockThreadWidthStorageKey(thread)}
            minWidth={300}
            defaultWidth="500px"
            shouldAcceptWidth={() => true}
            addMenuKinds={[]}
            onClosePane={() => {}}
            onCollapse={() => {}}
            onOpenChange={() => {}}
            onAddPane={() => {}}
            renderPane={() => <div>Panel content</div>}
          />
        </div>
      </>
    );
  }

  const screen = await renderDock(<Harness />);
  const measure = measureDockWidth;
  try {
    await expect.poll(measure).toBe(320);
    await screen.getByRole("button", { name: "Open chat b", exact: true }).click();
    await expect.poll(measure).toBe(648);
    // A chat that was never resized follows the last width resized anywhere.
    await screen.getByRole("button", { name: "Open chat c", exact: true }).click();
    await expect.poll(measure).toBe(484);
    await screen.getByRole("button", { name: "Open chat a", exact: true }).click();
    await expect.poll(measure).toBe(320);
  } finally {
    await screen.unmount();
    for (const id of ["a", "b"]) localStorage.removeItem(rightDockThreadWidthStorageKey(id));
    localStorage.removeItem(RIGHT_DOCK_WIDTH_STORAGE_KEY);
  }
});

it.skip("keeps the whole dock maximized across selecting, opening and closing documents", async () => {
  await page.viewport(1280, 800);
  const { useState } = await import("react");
  const pane = (id: string) => ({
    id,
    kind: "file" as const,
    filePath: id + ".md",
    threadId: null,
    diffTurnId: null,
    diffFilePath: null,
    pullRequestProjectId: null,
    pullRequestRepository: null,
    pullRequestNumber: null,
    pullRequestInitialTab: null,
  });
  function Harness() {
    const [state, setState] = useState<RightDockThreadState>({
      open: true,
      activePaneId: "a",
      panes: [pane("a"), pane("b")],
    });
    return (
      <div style={{ display: "flex", width: 1000, height: 600 }}>
        <div className="drag-region" style={{ flex: 1 }}>
          Chat header
        </div>
        <RightDock
          state={state}
          paneLabelOverrides={{ a: "a.md", b: "b.md", c: "c.md" }}
          minWidth={300}
          defaultWidth="500px"
          shouldAcceptWidth={() => true}
          addMenuKinds={[]}
          onSelectPane={(id) => setState((s) => ({ ...s, activePaneId: id }))}
          onClosePane={(id) =>
            setState((s) => ({
              ...s,
              panes: s.panes.filter((p) => p.id !== id),
              activePaneId: s.panes.find((p) => p.id !== id)?.id ?? null,
            }))
          }
          onCollapse={() => {}}
          onOpenChange={() => {}}
          onAddPane={() => {}}
          renderPane={(p) => (
            <div>
              <p>Document {p.id}</p>
              <button
                onClick={() =>
                  setState((s) => ({ ...s, panes: [...s.panes, pane("c")], activePaneId: "c" }))
                }
              >
                Open linked document
              </button>
            </div>
          )}
        />
      </div>
    );
  }
  const screen = await render(<Harness />);
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "b.md", exact: true }).click();
  await expect.element(screen.getByText("Document b", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Restore panel", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Open linked document", exact: true }).click();
  await expect.element(screen.getByText("Document c", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Restore panel", exact: true }))
    .toBeVisible();
  await screen.getByRole("button", { name: "Close c.md", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Close c.md", exact: true }))
    .not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Restore panel", exact: true }))
    .toBeVisible();
});

it.skip("restores host accessibility on resize, thread changes, collapse and final close", async () => {
  await page.viewport(1280, 800);
  const { useState } = await import("react");
  const { ChatPaneDropOverlay } = await import("../chat-drop-overlay/ChatPaneDropOverlay");
  const { RouteInsetSurface } = await import("../RouteInsetSurface");
  const { closePaneInState, createDefaultRightDockState, openPaneInState } =
    await import("../../rightDockStore.logic");
  const initial = openPaneInState(createDefaultRightDockState(), {
    paneId: "note",
    kind: "file",
    filePath: "note.md",
  });
  function Harness() {
    const [state, setState] = useState(initial);
    const [thread, setThread] = useState("a");
    const [width, setWidth] = useState(1000);
    return (
      <>
        <button onClick={() => setWidth(900)}>Resize host</button>
        <button onClick={() => setThread(thread === "a" ? "b" : "a")}>Switch thread</button>
        <button onClick={() => setState(initial)}>Reopen</button>
        <div
          data-testid="host"
          className="flex h-dvh min-h-0 min-w-0 overflow-hidden"
          style={{ width }}
        >
          <ChatPaneDropOverlay onDrop={() => {}} className="flex h-full min-h-0 min-w-0 flex-1">
            <RouteInsetSurface surfaceClassName="bg-background">
              <input aria-label="Chat composer" defaultValue="Retained draft" />
              <div className="drag-region">Chat header</div>
            </RouteInsetSurface>
          </ChatPaneDropOverlay>
          <RightDock
            state={state}
            motionKey={thread}
            minWidth={300}
            defaultWidth="500px"
            shouldAcceptWidth={() => true}
            addMenuKinds={[]}
            paneLabelOverrides={{ note: "note.md" }}
            onClosePane={(id) => setState((s) => closePaneInState(s, id))}
            onCollapse={() => setState((s) => ({ ...s, open: false }))}
            onOpenChange={(open) => setState((s) => ({ ...s, open }))}
            onAddPane={() => {}}
            renderPane={() => (
              <>
                <input aria-label="Document draft" defaultValue="Saved document" />
                <button onClick={() => setState((s) => closePaneInState(s, "note"))}>
                  Close from document
                </button>
              </>
            )}
          />
        </div>
      </>
    );
  }
  const screen = await render(<Harness />);
  const chat = document.querySelector<HTMLInputElement>('[aria-label="Chat composer"]')!;
  const host = document.querySelector<HTMLElement>('[data-testid="host"]')!;
  const covered = host.firstElementChild as HTMLElement;
  const dock = host.querySelector<HTMLElement>('[data-slot="sidebar-container"]')!;
  const draft = document.querySelector<HTMLInputElement>('[aria-label="Document draft"]')!;
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  expect(covered.inert).toBe(true);
  expect(covered.style.visibility).toBe("hidden");
  chat.focus();
  expect(document.activeElement).not.toBe(chat);
  await screen.getByRole("button", { name: "Resize host", exact: true }).click();
  await expect.poll(() => dock.getBoundingClientRect().width).toBe(900);
  expect(document.querySelector('[aria-label="Document draft"]')).toBe(draft);
  await screen.getByRole("button", { name: "Switch thread", exact: true }).click();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "Collapse panel", exact: true }).click();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "Close note.md", exact: true }).click();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await expect
    .poll(
      () =>
        host.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width,
    )
    .toBe(0);
  expect(document.querySelector('[aria-label="Chat composer"]')).toBe(chat);
  expect(chat.value).toBe("Retained draft");
  chat.focus();
  expect(document.activeElement).toBe(chat);
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await screen.getByRole("button", { name: "Close from document", exact: true }).click();
  await expect
    .poll(
      () =>
        host.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width,
    )
    .toBe(0);
  expect(covered.inert).toBe(false);
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Close note.md", exact: true }).click();
  expect(
    host.querySelector<HTMLElement>('[data-slot="sidebar-gap"]')!.getBoundingClientRect().width,
  ).toBeGreaterThan(0);
  await screen.getByRole("button", { name: "Reopen", exact: true }).click();
  await screen.getByRole("button", { name: "Maximize panel", exact: true }).click();
  await page.viewport(600, 800);
  await expect.poll(() => covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
  await page.viewport(1280, 800);
  await expect.poll(() => covered.inert).toBe(true);
  await screen.unmount();
  expect(covered.inert).toBe(false);
  expect(covered.style.visibility).toBe("");
});

// Electron folds border-box drag/no-drag rectangles in document order (same
// model as SidebarHeaderNavigationControls.browser.tsx), so the region under a
// point is the last matching element's computed `app-region`.
function nativeDragRegionAt(container: HTMLElement, x: number, y: number) {
  let region = "";
  for (const element of container.querySelectorAll<HTMLElement>("*")) {
    const appRegion = getComputedStyle(element).getPropertyValue("app-region");
    if (appRegion !== "drag" && appRegion !== "no-drag") continue;
    const bounds = element.getBoundingClientRect();
    if (x >= bounds.left && x < bounds.right && y >= bounds.top && y < bounds.bottom) {
      region = appRegion;
    }
  }
  return region;
}

it("keeps the dock's top bar a window drag region except over its tabs and buttons", async () => {
  await page.viewport(1280, 800);
  const screen = await renderDock(
    <div style={{ display: "flex", width: 1000, height: 600 }}>
      <div style={{ flex: 1 }}>Chat</div>
      <RightDock
        state={{
          open: true,
          activePaneId: "diff",
          panes: [{ ...makeFilePane("diff"), kind: "diff" as const }],
        }}
        paneLabelOverrides={{ diff: "Diff" }}
        minWidth={300}
        defaultWidth="500px"
        windowControlsGutterClassName={null}
        shouldAcceptWidth={() => true}
        addMenuKinds={["file"]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onFullWidthChange={() => {}}
        onAddPane={() => {}}
        renderPane={() => <div>Diff body</div>}
      />
    </div>,
  );
  try {
    const dock = document.querySelector<HTMLElement>("[data-right-dock-content]")!;
    const tab = dock.querySelector<HTMLElement>("[data-surface-tab]")!;
    const addButton = screen.getByRole("button", { name: "Add panel", exact: true }).element();
    const widthToggle = dock.querySelector<HTMLElement>('[data-testid="right-dock-width-toggle"]')!;
    const tabRect = tab.getBoundingClientRect();
    const addRect = addButton.getBoundingClientRect();
    const toggleRect = widthToggle.getBoundingClientRect();
    const rowY = tabRect.top + tabRect.height / 2;
    // Empty bar between the "+" and the panel controls: the user grabs the window here.
    const emptyX = (addRect.right + toggleRect.left) / 2;
    expect(toggleRect.left - addRect.right).toBeGreaterThan(100);
    expect(nativeDragRegionAt(document.body, emptyX, rowY)).toBe("drag");
    expect(nativeDragRegionAt(document.body, tabRect.left + 4, rowY)).toBe("no-drag");
    expect(nativeDragRegionAt(document.body, addRect.left + addRect.width / 2, rowY)).toBe(
      "no-drag",
    );
    expect(nativeDragRegionAt(document.body, toggleRect.left + toggleRect.width / 2, rowY)).toBe(
      "no-drag",
    );
    // The pane body below the bar stays an ordinary, clickable surface.
    const body = screen.getByText("Diff body", { exact: true }).element().getBoundingClientRect();
    expect(nativeDragRegionAt(document.body, body.left + 2, body.top + 2)).not.toBe("drag");
  } finally {
    await screen.unmount();
  }
});

it("keeps every tab readable and the dock's own controls in view with many tabs open", async () => {
  await page.viewport(1280, 800);
  const panes = ["one", "two", "three", "four", "five"].map(makeFilePane);
  const labels = Object.fromEntries(panes.map((pane) => [pane.id, `${pane.id}-document.md`]));
  const screen = await renderDock(
    <div style={{ display: "flex", width: 1000, height: 600 }}>
      <div style={{ flex: 1 }}>Chat</div>
      <RightDock
        state={{ open: true, activePaneId: "one", panes }}
        paneLabelOverrides={labels}
        minWidth={300}
        defaultWidth="420px"
        shouldAcceptWidth={() => true}
        addMenuKinds={["explorer", "browser", "terminal"]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={() => {}}
        renderPane={(currentPane) => <div>Document {currentPane.id}</div>}
      />
    </div>,
  );
  await expect.element(screen.getByText("Document one", { exact: true })).toBeVisible();
  const header = document.querySelector<HTMLElement>("[data-right-dock-content]")!
    .firstElementChild as HTMLElement;
  const headerRect = header.getBoundingClientRect();
  // The "+" and the layout controls stay inside the visible bar (WALK-1 R-3).
  const add = screen.getByRole("button", { name: "Add panel", exact: true }).element();
  const controls = document.querySelector<HTMLElement>("[data-right-dock-layout-controls]")!;
  for (const element of [add, controls]) {
    const rect = element.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.left).toBeGreaterThanOrEqual(headerRect.left - 1);
    expect(rect.right).toBeLessThanOrEqual(headerRect.right + 1);
  }
  // Tabs keep at least 6em and share the room evenly; those without room are listed, and
  // every tab drawn lies left of the "+" (WALK-5 R-3).
  const tabs = [...document.querySelectorAll<HTMLElement>("[data-right-dock-tab-id]")];
  const widths = tabs.map((tab) => tab.getBoundingClientRect().width);
  expect(widths.length).toBeGreaterThan(0);
  const tabEm = Number.parseFloat(
    getComputedStyle(tabs[0]!.querySelector("[data-surface-tab]") ?? tabs[0]!).fontSize,
  );
  for (const width of widths) expect(width).toBeGreaterThanOrEqual(tabEm * 6 - 1);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
  for (const tab of tabs)
    expect(tab.getBoundingClientRect().right).toBeLessThanOrEqual(add.getBoundingClientRect().left);
  if (tabs.length < 5)
    await expect
      .element(
        screen.getByRole("button", {
          name: `${5 - tabs.length} more ${5 - tabs.length === 1 ? "tab" : "tabs"}`,
        }),
      )
      .toBeVisible();
  // One tab style with the chat's tabs: the close control sits right of the label (WALK-1 R-6).
  const activeTab = tabs[0]!;
  const close = screen
    .getByRole("button", { name: "Close one-document.md", exact: true })
    .element();
  const label = [...activeTab.querySelectorAll<HTMLElement>("span")].find(
    (span) => span.textContent === "one-document.md",
  )!;
  expect(activeTab.contains(close)).toBe(true);
  expect(close.getBoundingClientRect().left).toBeGreaterThan(label.getBoundingClientRect().left);
  await screen.unmount();
});

// What the walker opened in WALK-5, in that order.
const WALK_FIVE_PANES = [
  { pane: makeFilePane("canvas"), label: "画布" },
  { pane: makeFilePane("browser"), label: "浏览器" },
  { pane: makeFilePane("files"), label: "文件" },
  { pane: makeFilePane("terminal"), label: "终端" },
];

/** The dock in an 1110-wide window, with the window's caption buttons on its bar. */
async function renderWalkFiveDock(count: number) {
  const opened = WALK_FIVE_PANES;
  // The walker's dock was 425 of 1110 px wide. Stored widths are ratios of the regular range,
  // 320 px (0) to 1110 - 352 = 758 px (1).
  const { RIGHT_DOCK_WIDTH_STORAGE_KEY } = await import("./rightDockSizing.logic");
  localStorage.setItem(RIGHT_DOCK_WIDTH_STORAGE_KEY, String((425 - 320) / (758 - 320)));
  return renderDock(
    <div style={{ display: "flex", width: 1110, height: 600 }}>
      <div style={{ flex: 1 }}>Chat</div>
      <RightDock
        state={{
          open: true,
          activePaneId: opened[count - 1]!.pane.id,
          panes: opened.slice(0, count).map((entry) => entry.pane),
        }}
        paneLabelOverrides={Object.fromEntries(opened.map((entry) => [entry.pane.id, entry.label]))}
        minWidth={300}
        defaultWidth="425px"
        shouldAcceptWidth={() => true}
        windowControlsGutterClassName="pr-[138px]! sm:pr-[138px]!"
        // The window's bar also carries the bottom-panel and expand buttons.
        headerExtraControls={
          <>
            <button type="button" aria-label="Bottom panel" className="size-7 shrink-0" />
            <button type="button" aria-label="Expand" className="size-7 shrink-0" />
          </>
        }
        addMenuKinds={["explorer", "browser", "terminal"]}
        onClosePane={() => {}}
        onCollapse={() => {}}
        onOpenChange={() => {}}
        onAddPane={() => {}}
        renderPane={(currentPane) => <div>Document {currentPane.id}</div>}
      />
    </div>,
  );
}

/** How much of the label's end its mask fades out, in px (0 when it is drawn whole). */
function labelFadePx(label: HTMLElement): number {
  const mask = getComputedStyle(label).maskImage || getComputedStyle(label).webkitMaskImage;
  if (!mask || mask === "none") return 0;
  const cuts = [...mask.matchAll(/calc\(100% - ([\d.]+)px\)/g)].map((match) => Number(match[1]));
  return cuts.length > 0 ? Math.max(...cuts) : 0;
}

it("WALK-5 R-3: one pane, its two-character label 画布 is drawn whole, not masked", async () => {
  await page.viewport(1110, 800);
  const screen = await renderWalkFiveDock(1);
  await expect.element(screen.getByText("Document canvas", { exact: true })).toBeVisible();
  const tab = document.querySelector<HTMLElement>('[data-right-dock-tab-id="canvas"]')!;
  const label = [...tab.querySelectorAll<HTMLElement>("span")].find(
    (span) => span.textContent === "画布" && span.children.length === 0,
  )!;
  expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
  expect(labelFadePx(label)).toBe(0);
  await screen.unmount();
});

it("WALK-5 R-3: four panes in an 1110-wide window all lie left of the dock's buttons, the active one shown", async () => {
  await page.viewport(1110, 800);
  const screen = await renderWalkFiveDock(4);
  // Every tab drawn lies wholly left of the first button, the active 终端 among them.
  await expect.element(screen.getByText("Document terminal", { exact: true })).toBeVisible();
  const firstButton = screen.getByRole("button", { name: "Add panel", exact: true }).element();
  // The walker's geometry: the dock 425 px wide.
  const dock = document.querySelector<HTMLElement>("[data-slot='sidebar-container']")!;
  expect(Math.abs(dock.getBoundingClientRect().width - 425)).toBeLessThanOrEqual(12);
  const controls = document.querySelector<HTMLElement>("[data-right-dock-layout-controls]")!;
  const header = document.querySelector<HTMLElement>("[data-right-dock-content]")!
    .firstElementChild as HTMLElement;
  await vi.waitFor(() => {
    // The buttons in their order: "+", the layout buttons, then the window's caption buttons
    // (the 138 px gutter at the bar's right end).
    const buttonLeft = firstButton.getBoundingClientRect().left;
    const controlsRect = controls.getBoundingClientRect();
    expect(firstButton.getBoundingClientRect().right).toBeLessThanOrEqual(controlsRect.left + 1);
    expect(controlsRect.right).toBeLessThanOrEqual(header.getBoundingClientRect().right - 138 + 1);
    const tabs = [...document.querySelectorAll<HTMLElement>("[data-right-dock-tab-id]")];
    expect(tabs.length).toBeGreaterThan(0);
    for (const tab of tabs)
      expect(tab.getBoundingClientRect().right).toBeLessThanOrEqual(buttonLeft);
    const active = document.querySelector<HTMLElement>('[data-right-dock-tab-id="terminal"]');
    expect(active).not.toBeNull();
    expect(active!.getBoundingClientRect().width).toBeGreaterThan(0);
  });
  // A pane without room is one click away in the strip's list, not under a button.
  const drawn = new Set(
    [...document.querySelectorAll<HTMLElement>("[data-right-dock-tab-id]")].map(
      (tab) => tab.dataset.rightDockTabId,
    ),
  );
  const listed = WALK_FIVE_PANES.filter((entry) => !drawn.has(entry.pane.id));
  if (listed.length > 0) {
    await screen
      .getByRole("button", {
        name: `${listed.length} more ${listed.length === 1 ? "tab" : "tabs"}`,
      })
      .click();
    for (const entry of listed)
      await expect.element(screen.getByRole("menuitem", { name: entry.label })).toBeVisible();
  }
  await screen.unmount();
});
