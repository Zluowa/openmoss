import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { emitWsTransportState } from "../wsTransportEvents";
import { subscribeComposerTransportStatus } from "./composerTransportStatus";

describe("composer transport status", () => {
  let unsubscribe: (() => void) | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", new EventTarget());
    emitWsTransportState("open");
  });

  afterEach(() => {
    unsubscribe?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["connecting", "closed"] as const)("delays %s by 1.5 seconds", (state) => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState(state);
    vi.advanceTimersByTime(1499);
    expect(message).toBeNull();
    vi.advanceTimersByTime(1);
    expect(message).toBe("reconnecting");
    emitWsTransportState("open");
    expect(message).toBeNull();
  });

  it("says connecting, not reconnecting, before Moss has answered once", () => {
    emitWsTransportState("connecting");
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    vi.advanceTimersByTime(1500);
    expect(message).toBe("connecting");
    emitWsTransportState("open");
    expect(message).toBeNull();
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(1500);
    expect(message).toBe("reconnecting");
  });

  it("does not restart the delay as reconnect attempts cycle between closed and connecting", () => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("closed");
    vi.advanceTimersByTime(1000);
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(500);
    expect(message).toBe("reconnecting");
  });

  it("cancels brief blips and starts a fresh delay for the next outage", () => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(1400);
    emitWsTransportState("open");
    vi.advanceTimersByTime(200);
    expect(message).toBeNull();
    emitWsTransportState("closed");
    vi.advanceTimersByTime(1499);
    expect(message).toBeNull();
    vi.advanceTimersByTime(1);
    expect(message).toBe("reconnecting");
  });

  it.each([
    ["incompatible", "incompatible"],
    ["disposed", "disconnected"],
  ] as const)("does not promise reconnection for %s", (state, expected) => {
    let message: string | null = null;
    unsubscribe = subscribeComposerTransportStatus((value) => (message = value));
    emitWsTransportState("connecting");
    vi.advanceTimersByTime(1500);
    emitWsTransportState(state);
    expect(message).toBe(expected);
  });

  it("replays an existing outage and cancels the timer and listener on unmount", () => {
    emitWsTransportState("closed");
    const messages: (string | null)[] = [];
    unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
    vi.advanceTimersByTime(1500);
    expect(messages).toEqual(["reconnecting"]);
    emitWsTransportState("open");
    emitWsTransportState("closed");
    unsubscribe();
    vi.advanceTimersByTime(2000);
    emitWsTransportState("open");
    expect(messages).toEqual(["reconnecting", null]);
  });

  describe("with the desktop's own backend", () => {
    beforeEach(() => {
      const bridged = Object.assign(new EventTarget(), {
        desktopBridge: { getWsUrl: () => "ws://127.0.0.1:4321/?token=t" },
      });
      vi.stubGlobal("window", bridged);
      emitWsTransportState("open");
    });

    it("stays quiet through a normal restart and clears nothing it never showed", () => {
      const messages: (string | null)[] = [];
      unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
      emitWsTransportState("connecting");
      vi.advanceTimersByTime(600);
      emitWsTransportState("closed");
      emitWsTransportState("connecting");
      // The measured restart takes 3.7 s from kill to open on a real package.
      vi.advanceTimersByTime(3_100);
      emitWsTransportState("open");
      vi.advanceTimersByTime(20_000);
      expect(messages).toEqual([]);
    });

    it("does not flash connecting during a normal startup", () => {
      emitWsTransportState("connecting");
      const messages: (string | null)[] = [];
      unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
      vi.advanceTimersByTime(2_000);
      emitWsTransportState("open");
      vi.advanceTimersByTime(20_000);
      expect(messages).toEqual([]);
    });

    it("still tells the user about an outage longer than a restart", () => {
      const messages: (string | null)[] = [];
      unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
      emitWsTransportState("closed");
      vi.advanceTimersByTime(5_000);
      emitWsTransportState("connecting");
      vi.advanceTimersByTime(4_999);
      expect(messages).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(messages).toEqual(["reconnecting"]);
      emitWsTransportState("open");
      expect(messages).toEqual(["reconnecting", null]);
    });

    it("does not make an incompatible server wait out the restart hold", () => {
      const messages: (string | null)[] = [];
      unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
      emitWsTransportState("connecting");
      vi.advanceTimersByTime(1_000);
      emitWsTransportState("incompatible");
      vi.advanceTimersByTime(499);
      expect(messages).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(messages).toEqual(["incompatible"]);
    });

    it("shows an incompatible server at once when the hold already ran past it", () => {
      const messages: (string | null)[] = [];
      unsubscribe = subscribeComposerTransportStatus((value) => messages.push(value));
      emitWsTransportState("connecting");
      vi.advanceTimersByTime(4_000);
      emitWsTransportState("incompatible");
      vi.advanceTimersByTime(0);
      expect(messages).toEqual(["incompatible"]);
    });
  });
});
