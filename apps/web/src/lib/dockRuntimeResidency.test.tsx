// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { RUNTIME_RESIDENCY_POLICIES } from "@moss/shared/runtimeResidency";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerResidentRuntime,
  RESIDENT_RUNTIME_SAVE_RETRY_MS,
  residentRuntimeSnapshot,
  useResidentRuntime,
  type ResidentRuntimeHandle,
} from "./dockRuntimeResidency";

const FRAME_DELAY = RUNTIME_RESIDENCY_POLICIES.dockFrame.hiddenSuspendMs;
const handles: ResidentRuntimeHandle[] = [];

function frame(key: string, owner = "thread-a", save = vi.fn(async () => true)) {
  const handle = registerResidentRuntime({
    key,
    owner,
    runtimeClass: "dockFrame",
    visible: true,
    suspend: save,
  });
  handles.push(handle);
  return { handle, save };
}

/** Let timers fire and the save promises settle. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  for (const handle of handles.splice(0)) handle.dispose();
  vi.useRealTimers();
});

describe("dock runtime residency", () => {
  it("saves then unloads a runtime hidden past its delay, and loads it again when shown", async () => {
    const { handle, save } = frame("canvas:a");
    handle.update({ visible: false });
    await advance(FRAME_DELAY - 1);
    expect(save).not.toHaveBeenCalled();
    expect(handle.getPhase()).toBe("loaded");
    await advance(1);
    expect(save).toHaveBeenCalledOnce();
    expect(handle.getPhase()).toBe("suspended");
    handle.update({ visible: true });
    expect(handle.getPhase()).toBe("loaded");
  });

  it("does not unload a runtime that comes back before the delay", async () => {
    const { handle, save } = frame("canvas:a");
    handle.update({ visible: false });
    await advance(FRAME_DELAY / 2);
    handle.update({ visible: true });
    await advance(FRAME_DELAY * 2);
    expect(save).not.toHaveBeenCalled();
    expect(handle.getPhase()).toBe("loaded");
  });

  it("keeps a runtime that could not save loaded, and asks again later", async () => {
    const save = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const { handle } = frame("canvas:a", "thread-a", save);
    handle.update({ visible: false });
    await advance(FRAME_DELAY);
    expect(save).toHaveBeenCalledOnce();
    expect(handle.getPhase()).toBe("loaded");
    await advance(RESIDENT_RUNTIME_SAVE_RETRY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(handle.getPhase()).toBe("suspended");
  });

  it("stays loaded when shown again while saving", async () => {
    let finish!: (saved: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const { handle } = frame("canvas:a", "thread-a", save);
    handle.update({ visible: false });
    await advance(FRAME_DELAY);
    expect(handle.getPhase()).toBe("saving");
    handle.update({ visible: true });
    await act(async () => finish(true));
    expect(handle.getPhase()).toBe("loaded");
  });

  it("never unloads a pinned runtime (in use), however long it is hidden", async () => {
    const { handle, save } = frame("app:a");
    handle.update({ visible: false, pinned: true });
    await advance(FRAME_DELAY * 10);
    expect(save).not.toHaveBeenCalled();
    handle.update({ visible: false, pinned: false });
    await advance(FRAME_DELAY);
    expect(handle.getPhase()).toBe("suspended");
  });

  it("keeps the app-wide budget across conversations, least recently shown first", async () => {
    const { maxLoaded } = RUNTIME_RESIDENCY_POLICIES.dockFrame;
    const opened = Array.from({ length: maxLoaded + 1 }, (_, index) =>
      frame(`frame:${index}`, `thread-${index}`),
    );
    // Each one is hidden in turn, as a person moves from conversation to conversation.
    for (const { handle } of opened) {
      handle.update({ visible: false });
      await advance(10);
    }
    expect(opened[0]!.handle.getPhase()).toBe("suspended");
    expect(opened.slice(1).every(({ handle }) => handle.getPhase() === "loaded")).toBe(true);
  });

  it("keeps at most the per-conversation number hidden", async () => {
    const { maxHiddenPerOwner } = RUNTIME_RESIDENCY_POLICIES.dockFrame;
    const opened = Array.from({ length: maxHiddenPerOwner + 1 }, (_, index) =>
      frame(`frame:${index}`),
    );
    for (const { handle } of opened) {
      handle.update({ visible: false });
      await advance(10);
    }
    expect(opened.map(({ handle }) => handle.getPhase())).toEqual([
      "suspended",
      ...Array.from({ length: maxHiddenPerOwner }, () => "loaded"),
    ]);
  });

  it("forgets a runtime when it is disposed", () => {
    const { handle } = frame("canvas:a");
    expect(residentRuntimeSnapshot().map((entry) => entry.key)).toContain("canvas:a");
    handle.dispose();
    expect(residentRuntimeSnapshot().map((entry) => entry.key)).not.toContain("canvas:a");
  });
});

describe("useResidentRuntime", () => {
  it("reports loaded until the policy unloads a hidden runtime, and loaded again when shown", async () => {
    const suspend = vi.fn(async () => true);
    const { result, rerender, unmount } = renderHook(
      ({ visible }) =>
        useResidentRuntime({
          key: "canvas:hook",
          owner: "thread-a",
          runtimeClass: "dockFrame",
          visible,
          suspend,
        }),
      { initialProps: { visible: true } },
    );
    expect(result.current.loaded).toBe(true);
    rerender({ visible: false });
    await advance(FRAME_DELAY);
    expect(suspend).toHaveBeenCalledOnce();
    expect(result.current.loaded).toBe(false);
    rerender({ visible: true });
    expect(result.current.loaded).toBe(true);
    unmount();
    expect(residentRuntimeSnapshot().map((entry) => entry.key)).not.toContain("canvas:hook");
  });
});
