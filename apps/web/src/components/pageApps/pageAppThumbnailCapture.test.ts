// FILE: pageAppThumbnailCapture.test.ts
// Purpose: Bound capture lifetime and reject other frames and viewers.
// Layer: Web unit tests

import type { PageAppsOpenFrameResult } from "@moss/contracts";
import {
  PAGE_APP_THUMBNAIL_PROTOCOL,
  PAGE_APP_THUMBNAIL_TIMEOUT_MS,
} from "@moss/shared/pageAppFrameRuntime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPageAppThumbnailCapture } from "./pageAppThumbnailCapture";

function setup(options: { mode?: string; owner?: boolean; origin?: string } = {}) {
  vi.useFakeTimers();
  const events = new EventTarget();
  vi.stubGlobal("window", events);
  const postMessage = vi.fn();
  const target = { postMessage };
  const frame = {
    frameOrigin: options.origin ?? "null",
    app: { trashedAt: null },
    viewer: { isOwner: options.owner ?? true },
  } as PageAppsOpenFrameResult;
  const save = vi.fn(async () => {});
  const loadRenderer = vi.fn(async () => "local renderer");
  const capture = createPageAppThumbnailCapture({
    element: { contentWindow: target } as unknown as HTMLIFrameElement,
    frame,
    mode: options.mode ?? "full",
    save,
    loadRenderer,
  });
  const result = (data: object, origin = frame.frameOrigin, source: unknown = target) => {
    const event = new Event("message");
    Object.assign(event, { data, origin, source });
    events.dispatchEvent(event);
  };
  return { ...capture, save, loadRenderer, postMessage, result };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("app thumbnail capture lifecycle", () => {
  it.each([{ mode: "guest" }, { owner: false }])(
    "does not capture viewers or guests",
    async (options) => {
      const capture = setup(options);
      capture.loaded();
      await vi.runAllTimersAsync();
      expect(capture.loadRenderer).not.toHaveBeenCalled();
      expect(capture.save).not.toHaveBeenCalled();
      capture.dispose();
    },
  );
  it("requests only once and cleans timeout without retries", async () => {
    const capture = setup();
    capture.loaded();
    capture.loaded();
    await vi.advanceTimersByTimeAsync(401);
    expect(capture.loadRenderer).toHaveBeenCalledOnce();
    expect(capture.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "capture" }),
      "*",
    );
    await vi.advanceTimersByTimeAsync(PAGE_APP_THUMBNAIL_TIMEOUT_MS);
    capture.loaded();
    expect(capture.postMessage).toHaveBeenCalledTimes(2);
    expect(capture.postMessage.mock.lastCall?.[0]).toMatchObject({ kind: "cancel" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores wrong source, origin and nonce, then rejects disguised SVG", async () => {
    const capture = setup({ origin: "http://app.moss-app.localhost" });
    capture.loaded();
    await vi.advanceTimersByTimeAsync(401);
    const request = capture.postMessage.mock.calls[0]![0];
    const response = {
      protocol: PAGE_APP_THUMBNAIL_PROTOCOL,
      kind: "result",
      nonce: request.nonce,
      thumbnail: "data:image/jpeg;base64,PHN2Zz48L3N2Zz4=",
    };
    capture.result(response, "https://evil.test");
    capture.result(response, "http://app.moss-app.localhost", {});
    capture.result({ ...response, nonce: "old" });
    expect(capture.postMessage).toHaveBeenCalledOnce();
    capture.result(response);
    expect(capture.save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels before rendering starts when a page switches or closes", async () => {
    const capture = setup();
    capture.loaded();
    capture.dispose();
    await vi.runAllTimersAsync();
    expect(capture.loadRenderer).not.toHaveBeenCalled();
    expect(capture.save).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("discards renderer loading that finishes after cancellation", async () => {
    const capture = setup();
    let finish!: (value: string) => void;
    capture.loadRenderer.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    capture.loaded();
    await vi.advanceTimersByTimeAsync(401);
    capture.dispose();
    finish("late renderer");
    await Promise.resolve();
    expect(capture.postMessage.mock.calls.every(([message]) => message.kind === "cancel")).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
