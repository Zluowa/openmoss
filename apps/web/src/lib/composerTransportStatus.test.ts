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
});
