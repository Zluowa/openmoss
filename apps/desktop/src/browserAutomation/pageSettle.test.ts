import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { settlePageSince } from "./pageSettle";
import type { BrowserNavigationMark } from "./navigationTracker";

const runtime = {} as BrowserAutomationVisibleRuntime;
const mark: BrowserNavigationMark = { sequence: 3, startedAt: 0, initialUrl: "https://a.test/" };

const fakeTracker = (options: { navigated?: boolean; pending: () => number }) => ({
  hasNavigationStartedSince: vi.fn(() => options.navigated ?? false),
  wait: vi.fn(async () => ({ url: "https://a.test/next", state: "load" as const, redirects: [] })),
  pendingRequestsSince: vi.fn(options.pending),
});

describe("settlePageSince", () => {
  it("waits for requests the action started, then reports no navigation", async () => {
    let pending = 3;
    const tracker = fakeTracker({ pending: () => (pending > 0 ? pending-- : 0) });
    const result = await settlePageSince(
      runtime,
      tracker as never,
      mark,
      1_000,
      new AbortController().signal,
    );
    expect(result).toEqual({ navigated: false });
    expect(tracker.wait).not.toHaveBeenCalled();
    expect(pending).toBe(0);
  });

  it("waits for a navigation the action started to load", async () => {
    const tracker = fakeTracker({ navigated: true, pending: () => 0 });
    const result = await settlePageSince(
      runtime,
      tracker as never,
      mark,
      1_000,
      new AbortController().signal,
    );
    expect(result).toEqual({ navigated: true });
    expect(tracker.wait).toHaveBeenCalledWith(
      runtime,
      "load",
      expect.any(Number),
      expect.anything(),
      mark,
    );
  });

  it("gives up at the budget instead of failing a completed action", async () => {
    const tracker = fakeTracker({ pending: () => 1 });
    const started = performance.now();
    await expect(
      settlePageSince(runtime, tracker as never, mark, 120, new AbortController().signal),
    ).resolves.toEqual({ navigated: false });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("propagates cancellation", async () => {
    const controller = new AbortController();
    const tracker = fakeTracker({ pending: () => 1 });
    const settling = settlePageSince(runtime, tracker as never, mark, 5_000, controller.signal);
    controller.abort(new Error("Synthetic takeover."));
    await expect(settling).rejects.toThrow("Synthetic takeover.");
  });
});
