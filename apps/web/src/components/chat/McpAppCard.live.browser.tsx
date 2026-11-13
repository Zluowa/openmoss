import "../../index.css";

import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import type { ThreadId } from "@moss/contracts";
import { StrictMode, useEffect, useMemo, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import {
  getMcpAppDockEntries,
  registerMcpAppDockHost,
  resetMcpAppDockRegistryForTests,
  selectMcpAppDockEntry,
  useMcpAppDockEntries,
} from "~/lib/mcpAppDockRegistry";
import { resetMcpAppLiveWidgetsForTests } from "~/lib/mcpApps/liveWidgets";
import { resetMcpAppResourceCacheForTests } from "~/lib/mcpApps/resourceCache";
import type { WorkLogMcpToolResult } from "~/lib/toolCallDetails";
import { MossLocaleScope } from "~/localization";
import { selectRightDockState, useRightDockStore } from "../../rightDockStore";
import { installMcpAppFakeSandbox, type FakeMcpAppSandbox } from "../../test/mcpAppFakeSandbox";
import { McpAppCard } from "./McpAppCard";
import { McpAppDockPane } from "./McpAppDockPane";

const THREAD = "thread-live-widget";

function projection(overrides: Record<string, unknown> = {}): WorkLogMcpToolResult {
  return {
    kind: "codex.mcp_tool_call",
    version: 1,
    callId: "call-live-1",
    server: "fixture",
    tool: "fixture_show_widget",
    status: "completed",
    arguments: { name: "Moss" },
    result: { content: [{ type: "text", text: "Hello, Moss!" }] },
    truncation: { truncated: false, deferredBinary: false },
    app: {
      resourceUri: "ui://fixture/widget",
      source: "toolDefinition",
      server: "fixture",
      serverKey: "fixture",
      serverLabel: "fixture",
      toolName: "fixture_show_widget",
      toolTitle: "显示小组件",
      isFirstParty: false,
      visibility: [],
    },
    ...overrides,
  } as WorkLogMcpToolResult;
}

/** A side panel host like SingleChatSurface's: open selects the widget, hide closes the panel. */
function FakeDock() {
  const entries = useMcpAppDockEntries(THREAD);
  const open = useRightDockStore(useMemo(() => selectRightDockState(THREAD as ThreadId), [])).open;
  useEffect(
    () =>
      registerMcpAppDockHost(THREAD, {
        open: (entryId) => {
          selectMcpAppDockEntry(THREAD, entryId);
          useRightDockStore.getState().setDockOpen(THREAD as ThreadId, true);
        },
        hide: (entryId) => {
          const rest = getMcpAppDockEntries(THREAD).filter((entry) => entry.id !== entryId);
          selectMcpAppDockEntry(THREAD, rest[0]?.id ?? null);
          if (rest.length === 0)
            useRightDockStore.getState().setDockOpen(THREAD as ThreadId, false);
        },
      }),
    [],
  );
  return (
    <aside
      data-testid="fake-dock"
      className="border-l border-border bg-background"
      style={{ width: open ? 320 : 0, height: 480, position: "relative", overflow: "hidden" }}
    >
      {entries.map((entry) => (
        <div key={entry.id} style={{ position: "absolute", inset: 0 }}>
          <McpAppDockPane entryId={entry.id} visible={open && entry.selected} />
        </div>
      ))}
    </aside>
  );
}

function Shell(props: { above: number; children: ReactNode }) {
  return (
    <MossLocaleScope locale="zh-CN">
      <div
        data-mcp-app-portal-target="true"
        className="relative flex bg-background text-foreground"
        style={{ width: 1_100, height: 480 }}
      >
        <div data-right-dock-main-content className="relative flex min-w-0 flex-1 flex-col">
          <div
            data-testid="scroller"
            data-chat-scroll-container="true"
            style={{ height: 480, overflowY: "auto" }}
          >
            <div style={{ padding: "16px 24px" }}>
              <p className="text-ui text-muted-foreground" style={{ height: 120 }}>
                较早的消息
              </p>
              <div data-testid="inserted" style={{ height: props.above }} />
              <p className="mb-2 text-ui text-muted-foreground">
                调用了 fixture 的 fixture_show_widget
              </p>
              {props.children}
              <p className="mt-3 text-ui" style={{ height: 900 }}>
                小组件显示完成。
              </p>
            </div>
          </div>
          <div
            data-chat-composer-slot=""
            data-testid="composer"
            className="absolute inset-x-6 bottom-3 rounded-card border border-border bg-background"
            style={{ height: 64 }}
          />
        </div>
        <FakeDock />
      </div>
    </MossLocaleScope>
  );
}

// A webview paints nothing in the browser lane; stripe it so screenshots show where the live
// frame is.
const FRAME_STAND_IN_CSS =
  "webview[data-mcp-app-sandbox]{display:block;background:repeating-linear-gradient(45deg,#e6e5e1 0 10px,#f3f2ee 10px 20px)}";

async function mount(children: (above: number) => ReactNode, initialAbove = 0) {
  if (!document.getElementById("mcp-app-frame-stand-in")) {
    const style = document.createElement("style");
    style.id = "mcp-app-frame-stand-in";
    style.textContent = FRAME_STAND_IN_CSS;
    document.head.append(style);
  }
  let setAbove!: (value: number) => void;
  function Harness() {
    const [above, set] = useState(initialAbove);
    setAbove = set;
    return <Shell above={above}>{children(above)}</Shell>;
  }
  const rootRoute = createRootRoute({ component: Harness });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  // StrictMode like the app's root (dev double-mounts effects and memos).
  const screen = await render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return { screen, setAbove: (value: number) => setAbove(value) };
}

function frameWrapper(): HTMLElement {
  const wrapper = document.querySelector<HTMLElement>('[data-mcp-app-frame-wrapper="true"]');
  if (!wrapper) throw new Error("frame wrapper missing");
  return wrapper;
}

function slot(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-mcp-app-frame="true"]');
  if (!element) throw new Error("slot missing");
  return element;
}

async function expectFrameOnSlot() {
  await vi.waitFor(() => {
    const a = frameWrapper().getBoundingClientRect();
    const b = slot().getBoundingClientRect();
    expect(Math.abs(a.top - b.top)).toBeLessThan(1);
    expect(Math.abs(a.left - b.left)).toBeLessThan(1);
    expect(Math.abs(a.width - b.width)).toBeLessThan(1);
  });
}

let sandbox: FakeMcpAppSandbox | null = null;

afterEach(() => {
  sandbox?.restore();
  sandbox = null;
  resetMcpAppLiveWidgetsForTests();
  resetMcpAppDockRegistryForTests();
  resetMcpAppResourceCacheForTests();
  useRightDockStore.setState({ dockStateByThreadId: {} });
  localStorage.removeItem("moss:mcp-app-preferences");
  localStorage.removeItem("mcp-app-widget-heights");
});

describe("live widget frame placement", () => {
  it("follows its slot on scroll and layout shifts, and stays clipped to the transcript", async () => {
    await page.viewport(1_140, 520);
    sandbox = installMcpAppFakeSandbox({ widgetHeight: 220 });
    const { screen, setAbove } = await mount(() => (
      <McpAppCard projection={projection()} threadId={THREAD} theme="light" />
    ));
    await vi.waitFor(() => expect(sandbox!.widgets).toHaveLength(1));
    await sandbox.widgets[0]!.initialized;
    await vi.waitFor(() => expect(slot().getBoundingClientRect().height).toBe(220));
    await expectFrameOnSlot();

    const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    scroller.scrollTop = 90;
    await expectFrameOnSlot();

    // Content inserted above (an approval card, a new message) moves the slot down.
    setAbove(140);
    await expectFrameOnSlot();

    // Partly under the composer: the part over the composer is clipped away.
    scroller.scrollTop = 0;
    await expectFrameOnSlot();
    const composerTop = document
      .querySelector<HTMLElement>('[data-testid="composer"]')!
      .getBoundingClientRect().top;
    await vi.waitFor(() => {
      const frame = slot().getBoundingClientRect();
      const inset = (frameWrapper().dataset.mcpAppClip ?? "").split(" ").map(Number);
      expect(inset).toHaveLength(4);
      expect(Math.abs(frame.bottom - inset[2]! - composerTop)).toBeLessThan(1);
    });
    await page.screenshot({
      path: "__screenshots__/mcp-app-fix/01-frame-follows-slot-light.png",
    });

    // Scrolled past the top of the transcript: nothing paints outside it.
    scroller.scrollTop = 900;
    await vi.waitFor(() => {
      expect(frameWrapper().dataset.mcpAppClip).toBe("hidden");
      expect(frameWrapper().style.pointerEvents).toBe("none");
    });
    await screen.unmount();
  });

  it("reads the resource once and keeps one widget across remounts", async () => {
    await page.viewport(1_140, 520);
    sandbox = installMcpAppFakeSandbox();
    const { screen, setAbove } = await mount((above) =>
      above > 0 ? (
        <div key="moved">
          <McpAppCard projection={projection()} threadId={THREAD} theme="light" />
        </div>
      ) : (
        <McpAppCard projection={projection()} threadId={THREAD} theme="light" />
      ),
    );
    await vi.waitFor(() => expect(sandbox!.widgets).toHaveLength(1));
    await sandbox.widgets[0]!.initialized;
    // The row remounts under a new parent (a turn folding): same widget, frame moves along.
    setAbove(40);
    await expectFrameOnSlot();
    expect(sandbox.widgets).toHaveLength(1);
    expect(sandbox.registrations).toHaveLength(1);
    expect(sandbox.resourceReads()).toBe(1);
    await screen.unmount();
  });

  it("shows a failed call's own text and 「工具调用失败。」 whatever the server answers", async () => {
    await page.viewport(1_140, 520);
    sandbox = installMcpAppFakeSandbox({ toolResult: () => ({ status: "pending" }) });
    let setProjection!: (value: WorkLogMcpToolResult) => void;
    function Switchable() {
      const [value, set] = useState(projection({ status: "inProgress", result: undefined }));
      setProjection = set;
      return <McpAppCard projection={value} threadId={THREAD} theme="light" />;
    }
    const { screen } = await mount(() => <Switchable />);
    await vi.waitFor(() => expect(sandbox!.widgets).toHaveLength(1));
    const widget = sandbox.widgets[0]!;
    await widget.initialized;
    // The CLI rejected the result (it failed the tool's output schema): the call itself failed,
    // so the card says so with the call's own text, not the widget-load sentence.
    setProjection(
      projection({
        status: "failed",
        error: { message: "returned a malformed result that failed schema validation" },
        result: { content: [], structuredContent: { rows: [1, 2] } },
      }),
    );
    await expect.element(page.getByText("工具调用失败。")).toBeInTheDocument();
    await expect
      .element(page.getByText("returned a malformed result that failed schema validation"))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain("小组件加载失败");
    expect(document.querySelector('[data-mcp-app-frame-wrapper="true"]')).toBeNull();
    expect(document.querySelector('[data-mcp-app-fallback="true"]')?.textContent).not.toContain(
      "json",
    );
    expect(
      widget.received.some((message) => message.method === "ui/notifications/tool-result"),
    ).toBe(false);
    await screen.unmount();

    // A call that is already failed never starts a widget.
    const before = sandbox.registrations.length;
    const second = await mount(() => (
      <McpAppCard
        projection={projection({
          callId: "call-live-failed",
          status: "failed",
          error: { message: "failed" },
          result: { content: [{ type: "text", text: "坏数据" }] },
        })}
        threadId={THREAD}
        theme="light"
      />
    ));
    await expect.element(page.getByText("坏数据")).toBeInTheDocument();
    await expect.element(page.getByText("工具调用失败。")).toBeInTheDocument();
    expect(sandbox.registrations.length).toBe(before);
    await second.screen.unmount();
  });
});

describe("live widget first size", () => {
  it("sizes a widget that starts behind the device-permission prompt", async () => {
    await page.viewport(1_140, 520);
    localStorage.removeItem("moss:mcp-app-preferences");
    sandbox = installMcpAppFakeSandbox({
      widgetHeight: 357,
      measureLikeGuest: true,
      permissions: { clipboardWrite: true },
    });
    const { screen } = await mount(() => (
      <McpAppCard
        projection={projection({ callId: "call-permission" })}
        threadId={THREAD}
        theme="light"
      />
    ));
    await expect.element(page.getByText("fixture 的小组件想使用你的剪贴板")).toBeInTheDocument();
    await page.getByRole("button", { name: "允许", exact: true }).click();
    await vi.waitFor(() => expect(sandbox!.widgets).toHaveLength(1));
    await sandbox.widgets[0]!.initialized;
    await vi.waitFor(() => expect(slot().getBoundingClientRect().height).toBe(357));
    await expectFrameOnSlot();
    expect(localStorage.getItem("mcp-app-widget-heights")).toContain("call-permission");
    await screen.unmount();
  });

  it("sizes a widget of a hidden connector when it is peeked or shown again", async () => {
    await page.viewport(1_140, 520);
    sandbox = installMcpAppFakeSandbox({ widgetHeight: 240, measureLikeGuest: true });
    const { setMcpAppConnectorHidden } = await import("~/lib/mcpApps/preferences");
    setMcpAppConnectorHidden("fixture", true);
    const { screen } = await mount(() => (
      <McpAppCard
        projection={projection({ callId: "call-peek" })}
        threadId={THREAD}
        theme="light"
      />
    ));
    const header = page.getByRole("button", { name: /来自 fixture 的小组件/u });
    await expect.element(header).toHaveAttribute("aria-expanded", "false");
    await header.click();
    await vi.waitFor(() => expect(sandbox!.widgets).toHaveLength(1));
    await sandbox.widgets[0]!.initialized;
    await vi.waitFor(() => expect(slot().getBoundingClientRect().height).toBe(240));
    await expectFrameOnSlot();
    // Collapse, then show the connector again: the body comes back at its size.
    await header.click();
    await page.getByRole("button", { name: "显示此连接器的小组件" }).click();
    await vi.waitFor(() => expect(slot().getBoundingClientRect().height).toBe(240));
    await expectFrameOnSlot();
    setMcpAppConnectorHidden("fixture", false);
    await screen.unmount();
  });
});

describe("live widget side panel", () => {
  it("moves into the side panel and back, with the row and the widget told", async () => {
    await page.viewport(1_140, 520);
    sandbox = installMcpAppFakeSandbox();
    const { screen } = await mount(() => (
      <McpAppCard projection={projection()} threadId={THREAD} theme="light" />
    ));
    await vi.waitFor(() => expect(sandbox!.widgets).toHaveLength(1));
    const widget = sandbox.widgets[0]!;
    await widget.initialized;
    await expectFrameOnSlot();

    // The widget asks from a real click.
    const answer = await widget.request("ui/request-display-mode", { mode: "fullscreen" }, true);
    expect(answer.result).toEqual({ mode: "fullscreen" });
    await expect.element(page.getByText("正在侧边面板中显示")).toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "移回这里" })).toBeInTheDocument();
    const dock = document.querySelector<HTMLElement>(
      '[data-mcp-app-side-panel-frame-container="true"]',
    )!;
    await vi.waitFor(() => {
      const a = frameWrapper().getBoundingClientRect();
      const b = dock.getBoundingClientRect();
      expect(Math.abs(a.left - b.left)).toBeLessThan(1);
      expect(Math.abs(a.width - b.width)).toBeLessThan(1);
    });
    await vi.waitFor(() =>
      expect(
        widget.received.some(
          (message) =>
            message.method === "ui/notifications/host-context-changed" &&
            (message.params as { displayMode?: string }).displayMode === "fullscreen",
        ),
      ).toBe(true),
    );
    await page.screenshot({ path: "__screenshots__/mcp-app-fix/03-side-panel-light.png" });

    await page.getByRole("button", { name: "移回这里" }).click();
    await vi.waitFor(() =>
      expect(
        widget.received.some(
          (message) =>
            message.method === "ui/notifications/host-context-changed" &&
            (message.params as { displayMode?: string }).displayMode === "inline",
        ),
      ).toBe(true),
    );
    await expectFrameOnSlot();

    // The header button does the same.
    await page.getByRole("button", { name: "在侧边面板中打开" }).click();
    await expect.element(page.getByText("正在侧边面板中显示")).toBeInTheDocument();

    // The slide sends one size change, not one per frame.
    const sizeChanges = widget.received.filter(
      (message) =>
        message.method === "ui/notifications/host-context-changed" &&
        "containerDimensions" in (message.params as object),
    ).length;
    expect(sizeChanges).toBeLessThanOrEqual(6);
    await screen.unmount();
  });
});
