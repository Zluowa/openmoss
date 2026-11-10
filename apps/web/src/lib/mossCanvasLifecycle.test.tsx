// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isMossCanvasRuntimeLoaded,
  nextMossCanvasRuntimeState,
  useMossCanvasRuntimeLifecycle,
} from "./mossCanvasLifecycle";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Canvas runtime state machine", () => {
  it("unloads only after a hidden Canvas is saved", () => {
    let state = nextMossCanvasRuntimeState("live", { type: "hide" });
    expect(state).toBe("idle");
    state = nextMossCanvasRuntimeState(state, { type: "hidden-long-enough" });
    expect(state).toBe("saving");
    expect(isMossCanvasRuntimeLoaded(state)).toBe(true);
    expect(nextMossCanvasRuntimeState(state, { type: "not-saved" })).toBe("idle");
    state = nextMossCanvasRuntimeState(state, { type: "saved" });
    expect(state).toBe("suspended");
    expect(isMossCanvasRuntimeLoaded(state)).toBe(false);
    expect(nextMossCanvasRuntimeState(state, { type: "show" })).toBe("live");
  });

  it("stays loaded when shown again before or while saving", () => {
    expect(nextMossCanvasRuntimeState("idle", { type: "show" })).toBe("live");
    const shownWhileSaving = nextMossCanvasRuntimeState("saving", { type: "show" });
    expect(shownWhileSaving).toBe("live");
    // A late save result never unloads a visible Canvas.
    expect(nextMossCanvasRuntimeState(shownWhileSaving, { type: "saved" })).toBe("live");
    expect(nextMossCanvasRuntimeState("live", { type: "hidden-long-enough" })).toBe("live");
  });
});

describe("useMossCanvasRuntimeLifecycle", () => {
  it("saves then unloads a Canvas hidden long enough, and reloads it when shown", async () => {
    const save = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ visible }) => useMossCanvasRuntimeLifecycle({ visible, save, suspendAfterMs: 1_000 }),
      { initialProps: { visible: true } },
    );
    expect(result.current.loaded).toBe(true);
    rerender({ visible: false });
    await act(async () => {
      vi.advanceTimersByTime(999);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("idle");
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("suspended");
    expect(result.current.loaded).toBe(false);
    rerender({ visible: true });
    expect(result.current.state).toBe("live");
    expect(result.current.loaded).toBe(true);
  });

  it("keeps an unsaved Canvas loaded and tries again", async () => {
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { result } = renderHook(() =>
      useMossCanvasRuntimeLifecycle({
        visible: false,
        save,
        suspendAfterMs: 1_000,
        retryAfterMs: 500,
      }),
    );
    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(result.current.loaded).toBe(true);
    await act(async () => {
      vi.advanceTimersByTime(500);
      await Promise.resolve();
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.state).toBe("suspended");
  });

  it("does not unload a Canvas that comes back into view before the delay", async () => {
    const save = vi.fn(async () => true);
    const { result, rerender } = renderHook(
      ({ visible }) => useMossCanvasRuntimeLifecycle({ visible, save, suspendAfterMs: 1_000 }),
      { initialProps: { visible: false } },
    );
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    rerender({ visible: true });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(save).not.toHaveBeenCalled();
    expect(result.current.state).toBe("live");
  });
});
