import { afterEach, describe, expect, it, vi } from "vitest";

import {
  attachMcpAppSidePanelHost,
  closeMcpAppDockEntry,
  getMcpAppDockEntries,
  makeMcpAppDockEntryId,
  registerMcpAppDockEntry,
  registerMcpAppDockHost,
  resolveMcpAppDockTitle,
  requestMcpAppDisplayMode,
  resetMcpAppDockRegistryForTests,
  selectMcpAppDockEntry,
  setMcpAppDockEntryVisibility,
  subscribeMcpAppDock,
  updateMcpAppDockEntryNavigation,
} from "./mcpAppDockRegistry";

afterEach(() => {
  vi.useRealTimers();
  resetMcpAppDockRegistryForTests();
});

function hostElement(): HTMLElement {
  return {} as HTMLElement;
}

describe("MCP App RightDock registry", () => {
  it("derives a bounded opaque identity without retaining the resource URI", () => {
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://private/resource");
    expect(id).toMatch(/^mcp-app-[a-f0-9]{16}$/u);
    expect(id).not.toContain("private");
    expect(id.length).toBeLessThanOrEqual(48);
  });

  it("dedupes navigation state and gates stale or disabled actions by entry id", async () => {
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    const navigate = vi.fn();
    const unregister = await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => null,
      layoutFrameTo: () => true,
      navigate,
    });
    let notifications = 0;
    const unsubscribe = subscribeMcpAppDock(() => {
      notifications += 1;
    });
    await requestMcpAppDisplayMode(id, "fullscreen");
    // The mode request is intentionally outside this assertion: navigation
    // updates should be the only notifications counted below.
    notifications = 0;
    const initial = getMcpAppDockEntries("thread-one")[0];
    if (!initial) throw new Error("missing registry entry");
    expect(initial.canGoBack).toBe(false);
    expect(initial.canGoForward).toBe(false);
    initial.navigate(-1);
    expect(navigate).not.toHaveBeenCalled();

    updateMcpAppDockEntryNavigation(id, true, false);
    expect(notifications).toBe(1);
    const withBack = getMcpAppDockEntries("thread-one")[0];
    expect(withBack?.canGoBack).toBe(true);
    expect(withBack?.canGoForward).toBe(false);
    updateMcpAppDockEntryNavigation(id, true, false);
    expect(notifications).toBe(1);
    expect(getMcpAppDockEntries("thread-one")[0]).toBe(withBack);
    withBack?.navigate(-1);
    withBack?.navigate(1);
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(-1);

    await unregister();
    unsubscribe();
    withBack?.navigate(-1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("restores a live controller's navigation state after transient re-registration", async () => {
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    const controllerSnapshot = { canGoBack: true, canGoForward: false } as const;
    registerMcpAppDockHost("thread-one", { open: vi.fn(), hide: vi.fn() });
    const registerLiveEntry = async () => {
      const unregister = await registerMcpAppDockEntry({
        id,
        threadId: "thread-one",
        title: "Safe app",
        getInlineContainer: () => null,
        layoutFrameTo: () => true,
      });
      await requestMcpAppDisplayMode(id, "fullscreen");
      updateMcpAppDockEntryNavigation(
        id,
        controllerSnapshot.canGoBack,
        controllerSnapshot.canGoForward,
      );
      return unregister;
    };

    const unregisterFirst = await registerLiveEntry();
    expect(getMcpAppDockEntries("thread-one")[0]).toMatchObject(controllerSnapshot);
    await unregisterFirst();
    expect(getMcpAppDockEntries("thread-one")).toEqual([]);

    const unregisterSecond = await registerLiveEntry();
    expect(getMcpAppDockEntries("thread-one")[0]).toMatchObject(controllerSnapshot);
    await unregisterSecond();
  });

  it("uses app name, action name, then tool name for a bounded sanitized title", () => {
    expect(resolveMcpAppDockTitle("App title", "Action title", "tool_name")).toBe("App title");
    expect(resolveMcpAppDockTitle("   ", "Action title", "tool_name")).toBe("Action title");
    expect(resolveMcpAppDockTitle(undefined, "\n\t", "tool_name")).toBe("tool_name");
    const bounded = resolveMcpAppDockTitle(`${"\u0000"}x`.repeat(200), "Action", "tool_name");
    expect(bounded).toHaveLength(120);
    expect(
      [...bounded].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    ).toBe(false);
  });

  it("opens one transient entry and resolves only after the host attaches", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const frame = hostElement();
    let movedTo: HTMLElement | null = null;
    const open = vi.fn();
    const hide = vi.fn();
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => inline,
      layoutFrameTo: (target) => {
        movedTo = target;
        void frame;
        return true;
      },
    });
    // The returned unregister function is deliberately held by the test only
    // to make cleanup explicit; the registry reset also remains idempotent.
    const unregister = await registerMcpAppDockEntry({
      id: `${id}-other`,
      threadId: "thread-two",
      title: "Other",
      getInlineContainer: () => inline,
      layoutFrameTo: () => true,
    });
    await unregister();
    const hostCleanup = registerMcpAppDockHost("thread-one", { open, hide });
    const pending = requestMcpAppDisplayMode(id, "fullscreen");
    expect(open).toHaveBeenCalledWith(id);
    await expect(pending).resolves.toEqual({ mode: "fullscreen" });
    expect(movedTo).toBeNull();
    expect(getMcpAppDockEntries("thread-one")[0]).toMatchObject({
      id,
      title: "Safe app",
      displayMode: "inline",
      requestedDisplayMode: "fullscreen",
      selected: false,
    });
    selectMcpAppDockEntry("thread-one", id);
    const detach = attachMcpAppSidePanelHost(id, sidePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(movedTo).toBe(sidePanel);
    expect(getMcpAppDockEntries("thread-one")[0]).toMatchObject({
      displayMode: "fullscreen",
      requestedDisplayMode: null,
      selected: true,
    });
    detach();
    hostCleanup();
  });

  it("returns current mode for pip or malformed requests without opening the dock", async () => {
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    const open = vi.fn();
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => null,
      layoutFrameTo: () => true,
    });
    registerMcpAppDockHost("thread-one", { open, hide: vi.fn() });
    await expect(requestMcpAppDisplayMode(id, "pip")).resolves.toEqual({ mode: "inline" });
    await expect(requestMcpAppDisplayMode(id, { mode: "fullscreen" })).resolves.toEqual({
      mode: "inline",
    });
    expect(open).not.toHaveBeenCalled();
  });

  it("shares duplicate fullscreen requests and closes the transient entry on inline exit", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const frame = hostElement();
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    const open = vi.fn();
    const hide = vi.fn();
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => inline,
      layoutFrameTo: (target) => {
        void target;
        return true;
      },
    });
    registerMcpAppDockHost("thread-one", { open, hide });
    const first = requestMcpAppDisplayMode(id, "fullscreen");
    const second = requestMcpAppDisplayMode(id, "fullscreen");
    expect(open).toHaveBeenCalledTimes(1);
    attachMcpAppSidePanelHost(id, sidePanel);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: "fullscreen" },
      { mode: "fullscreen" },
    ]);
    expect(frame).toBeDefined();
    await expect(requestMcpAppDisplayMode(id, "inline")).resolves.toEqual({ mode: "inline" });
    expect(hide).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(hide).toHaveBeenCalledWith(id);
    expect(getMcpAppDockEntries("thread-one")).toEqual([]);
  });

  it("does not steal another selected tab on a repeated fullscreen request", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const open = vi.fn();
    const host = { open, hide: vi.fn() };
    registerMcpAppDockHost("thread-one", host);
    const ids = ["one", "two"].map((suffix) =>
      makeMcpAppDockEntryId("thread-one", `call-${suffix}`, `ui://${suffix}`),
    );
    for (const id of ids) {
      await registerMcpAppDockEntry({
        id,
        threadId: "thread-one",
        title: id,
        getInlineContainer: () => inline,
        layoutFrameTo: () => true,
      });
      await requestMcpAppDisplayMode(id, "fullscreen");
      selectMcpAppDockEntry("thread-one", id);
      attachMcpAppSidePanelHost(id, sidePanel);
      await vi.advanceTimersByTimeAsync(0);
    }
    selectMcpAppDockEntry("thread-one", ids[0]!);
    open.mockClear();

    await expect(requestMcpAppDisplayMode(ids[1]!, "fullscreen")).resolves.toEqual({
      mode: "fullscreen",
    });
    expect(open).not.toHaveBeenCalled();
    expect(getMcpAppDockEntries("thread-one")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ids[0], selected: true }),
        expect.objectContaining({ id: ids[1], selected: false }),
      ]),
    );
  });

  it("hides an inactive stable frame and restores it after inline exit", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const visibility = vi.fn();
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => inline,
      layoutFrameTo: () => true,
      setFrameVisibility: visibility,
    });
    registerMcpAppDockHost("thread-one", { open: vi.fn(), hide: vi.fn() });
    await requestMcpAppDisplayMode(id, "fullscreen");
    selectMcpAppDockEntry("thread-one", id);
    attachMcpAppSidePanelHost(id, sidePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(visibility).toHaveBeenLastCalledWith(true);

    setMcpAppDockEntryVisibility(id, false);
    expect(visibility).toHaveBeenLastCalledWith(false);
    setMcpAppDockEntryVisibility(id, true);
    expect(visibility).toHaveBeenLastCalledWith(true);
    selectMcpAppDockEntry("thread-one", null);
    expect(visibility).toHaveBeenLastCalledWith(false);
    await requestMcpAppDisplayMode(id, "inline");
    await vi.advanceTimersByTimeAsync(0);
    expect(visibility).toHaveBeenLastCalledWith(true);
  });

  it("does not unregister after a newer fullscreen request cancels inline close", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const onUnregistered = vi.fn();
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => inline,
      layoutFrameTo: () => true,
      onUnregistered,
    });
    registerMcpAppDockHost("thread-one", { open: vi.fn(), hide: vi.fn() });
    await requestMcpAppDisplayMode(id, "fullscreen");
    selectMcpAppDockEntry("thread-one", id);
    attachMcpAppSidePanelHost(id, sidePanel);
    await vi.advanceTimersByTimeAsync(0);

    const closing = closeMcpAppDockEntry(id);
    await expect(requestMcpAppDisplayMode(id, "fullscreen")).resolves.toEqual({
      mode: "fullscreen",
    });
    await vi.advanceTimersByTimeAsync(0);
    await closing;

    expect(onUnregistered).not.toHaveBeenCalled();
    expect(getMcpAppDockEntries("thread-one")).toMatchObject([
      { id, displayMode: "fullscreen", requestedDisplayMode: null },
    ]);
  });

  it("selects a surviving transient app when the selected app exits", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const host = { open: vi.fn(), hide: vi.fn() };
    registerMcpAppDockHost("thread-one", host);
    const ids = ["one", "two"].map((suffix) =>
      makeMcpAppDockEntryId("thread-one", `call-${suffix}`, `ui://${suffix}`),
    );
    for (const id of ids) {
      await registerMcpAppDockEntry({
        id,
        threadId: "thread-one",
        title: id,
        getInlineContainer: () => inline,
        layoutFrameTo: () => true,
      });
      const pending = requestMcpAppDisplayMode(id, "fullscreen");
      attachMcpAppSidePanelHost(id, sidePanel);
      await pending;
      await vi.advanceTimersByTimeAsync(0);
    }
    selectMcpAppDockEntry("thread-one", ids[0]!);
    await requestMcpAppDisplayMode(ids[0]!, "inline");
    expect(getMcpAppDockEntries("thread-one")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(0);
    expect(getMcpAppDockEntries("thread-one")).toHaveLength(1);
    expect(getMcpAppDockEntries("thread-one")[0]).toMatchObject({
      id: ids[1],
      selected: true,
      displayMode: "fullscreen",
    });
  });

  it("times out without a host and cleans the pending transient state", async () => {
    vi.useFakeTimers();
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    const hide = vi.fn();
    const visibility = vi.fn();
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => null,
      layoutFrameTo: () => false,
      setFrameVisibility: visibility,
    });
    registerMcpAppDockHost("thread-one", { open: vi.fn(), hide });
    const pending = requestMcpAppDisplayMode(id, "fullscreen");
    await expect(pending).resolves.toEqual({ mode: "fullscreen" });
    expect(getMcpAppDockEntries("thread-one")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_001);
    expect(getMcpAppDockEntries("thread-one")).toEqual([]);
    expect(hide).toHaveBeenCalledWith(id);
    expect(visibility).toHaveBeenLastCalledWith(true);
  });

  it("restores inline visibility when fullscreen geometry application fails", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const visibility = vi.fn();
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => inline,
      layoutFrameTo: () => false,
      setFrameVisibility: visibility,
    });
    registerMcpAppDockHost("thread-one", { open: vi.fn(), hide: vi.fn() });
    await requestMcpAppDisplayMode(id, "fullscreen");
    selectMcpAppDockEntry("thread-one", id);
    attachMcpAppSidePanelHost(id, sidePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(getMcpAppDockEntries("thread-one")).toEqual([]);
    expect(visibility).toHaveBeenLastCalledWith(true);
  });

  it("retries a deferred fullscreen move when the side host attaches after the first task", async () => {
    vi.useFakeTimers();
    const inline = hostElement();
    const sidePanel = hostElement();
    const move = vi.fn(() => true);
    const id = makeMcpAppDockEntryId("thread-one", "call-one", "ui://one");
    await registerMcpAppDockEntry({
      id,
      threadId: "thread-one",
      title: "Safe app",
      getInlineContainer: () => inline,
      layoutFrameTo: move,
    });
    registerMcpAppDockHost("thread-one", { open: vi.fn(), hide: vi.fn() });
    await expect(requestMcpAppDisplayMode(id, "fullscreen")).resolves.toEqual({
      mode: "fullscreen",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(move).not.toHaveBeenCalled();
    attachMcpAppSidePanelHost(id, sidePanel);
    await vi.advanceTimersByTimeAsync(0);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith(sidePanel, "fullscreen");
    expect(getMcpAppDockEntries("thread-one")[0]).toMatchObject({
      displayMode: "fullscreen",
      requestedDisplayMode: null,
    });
  });
});
