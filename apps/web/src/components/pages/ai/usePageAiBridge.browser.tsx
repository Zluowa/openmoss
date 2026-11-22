// FILE: usePageAiBridge.browser.tsx
// Purpose: Verifies usePageAiBridge dock ask-dock handling, thread open-ref routing without page
//          navigation, standalone fallback when dock is null, and auto-applied edit undo.
// Layer: Web page AI bridge browser tests

import "../../../index.css";

import { ThreadId, type NativeApi, type PagesReadResult } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";

import type { SpaceCanvasDockController } from "~/components/space/spaceCanvasDockContract";
import { PageRichEditorChannel } from "~/lib/pageRichEditorChannel";
import { createDataSpaceFixture, pageDocument } from "~/test/mossDataSpaceFixture";
import { usePageAiBridge } from "./usePageAiBridge";

let previousApi: NativeApi | undefined;

function createMockDock(
  overrides: Partial<SpaceCanvasDockController> = {},
): SpaceCanvasDockController {
  return {
    state: "collapsed",
    setState: vi.fn(),
    activeThreadId: ThreadId.makeUnsafe("thread-dock-1"),
    busy: false,
    elapsedSeconds: 0,
    statusLabel: null,
    ask: vi.fn(async () => undefined),
    openSideChatTab: vi.fn(),
    selection: null,
    setSelection: vi.fn(),
    ...overrides,
  };
}

function makeChannel(): PageRichEditorChannel {
  const channel = new PageRichEditorChannel(
    "test-nonce",
    () => {},
    () => {},
    () => {},
    () => {},
  );
  // Seed ready/loaded flags in test without iframe handshake.
  (channel as unknown as { ready: boolean; loaded: boolean; aiSupported: boolean }).ready = true;
  (channel as unknown as { ready: boolean; loaded: boolean; aiSupported: boolean }).loaded = true;
  (channel as unknown as { ready: boolean; loaded: boolean; aiSupported: boolean }).aiSupported =
    true;
  return channel;
}

afterEach(async () => {
  await cleanup();
  (window as { nativeApi?: NativeApi | undefined }).nativeApi = previousApi;
});

describe("usePageAiBridge dock integration", () => {
  it("routes ask-dock and open-ref thread events to dock without navigating away", async () => {
    previousApi = window.nativeApi;
    const fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    const doc = pageDocument("page-ai-1", "AI 文档", "正文内容");
    fixture.put(doc);
    const channel = makeChannel();
    const dock = createMockDock();
    const flush = vi.fn(async () => true);
    let bridgeHandle: ReturnType<typeof usePageAiBridge> | null = null;
    let currentPath = "/";

    function Harness(props: { document: PagesReadResult; busy: boolean }) {
      const dockWithBusy = { ...dock, busy: props.busy };
      const bridge = usePageAiBridge(channel, {
        account: fixture.state.account,
        scopeSpaceId: null,
        document: props.document,
        isCurrent: () => true,
        flush,
        createChildPage: () => {},
        openPage: () => {},
        openFiles: () => {},
        dock: dockWithBusy,
      });
      bridgeHandle = bridge;
      return <div data-testid="bridge-harness">{bridge.lastAiChange ? "undoable" : "idle"}</div>;
    }

    const triggerRef: { current: (() => Promise<void>) | null } = { current: null };
    function Container() {
      const [docState, setDocState] = useState(doc);
      const [busy, setBusy] = useState(false);
      useEffect(() => {
        triggerRef.current = async () => {
          setBusy(true);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          setDocState({
            ...doc,
            page: { ...doc.page, revision: 2 },
          });
          setBusy(false);
        };
      }, []);
      return <Harness document={docState} busy={busy} />;
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <Container />,
    });
    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$threadId",
      component: () => <div data-testid="navigated-thread" />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    router.subscribe("onResolved", (e) => {
      currentPath = e.toLocation.pathname;
    });
    await router.load();
    await render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(dock.setSelection).toHaveBeenCalledWith({
      kind: "page",
      itemId: "page-ai-1",
      title: "AI 文档",
    });

    channel.onAiEvent({
      event: "ask-dock",
      prompt: "润色这一段",
      anchorBlockId: "blk-2",
      quote: "原句",
    });
    expect(dock.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "润色这一段",
        autoRun: true,
        origin: "editor-bridge",
        keepItemOpen: true,
        selection: expect.objectContaining({
          kind: "page",
          itemId: "page-ai-1",
          anchorBlockId: "blk-2",
          quote: "原句",
        }),
      }),
    );

    channel.onAiEvent({ event: "open-ref", kind: "thread", id: "thread-dock-1" });
    await vi.waitFor(() => {
      expect(flush).toHaveBeenCalled();
      expect(dock.setState).toHaveBeenCalledWith("pip");
      expect(dock.openSideChatTab).toHaveBeenCalled();
    });
    expect(currentPath).toBe("/");

    await triggerRef.current?.();
    await vi.waitFor(() => {
      expect(bridgeHandle?.lastAiChange).toEqual({ beforeRevision: 1, revision: 2 });
    });
  });

  it("falls back to standalone navigation when dock is null", async () => {
    previousApi = window.nativeApi;
    const fixture = createDataSpaceFixture();
    window.nativeApi = fixture.api;
    const doc = pageDocument("page-ai-2", "独立页面", "正文");
    fixture.put(doc);
    const channel = makeChannel();
    const openAiSpy = vi.spyOn(channel, "openAiInput");
    let currentPath = "/";

    function StandaloneHarness() {
      usePageAiBridge(channel, {
        account: fixture.state.account,
        scopeSpaceId: null,
        document: doc,
        isCurrent: () => true,
        flush: async () => true,
        createChildPage: () => {},
        openPage: () => {},
        openFiles: () => {},
        dock: null,
      });
      return <div />;
    }

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const indexRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/",
      component: () => <StandaloneHarness />,
    });
    const threadRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$threadId",
      component: () => <div data-testid="navigated-thread" />,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, threadRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    router.subscribe("onResolved", (e) => {
      currentPath = e.toLocation.pathname;
    });
    await router.load();
    await render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    channel.onAiEvent({ event: "ask-dock", prompt: "" });
    expect(openAiSpy).toHaveBeenCalledWith("generate");

    channel.onAiEvent({ event: "open-ref", kind: "thread", id: "thread-99" });
    await vi.waitFor(() => expect(currentPath).toBe("/thread-99"));
  });
});
