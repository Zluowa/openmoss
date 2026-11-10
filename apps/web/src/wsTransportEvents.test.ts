// FILE: wsTransportEvents.test.ts
// Purpose: Locks down transport-state replay used for projection reconciliation.
// Layer: Web transport utility unit tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addWsTransportStateListener,
  emitWsTransportState,
  waitForWsTransportOpen,
  WS_MESSAGE_NOT_SENT_DETAIL,
} from "./wsTransportEvents";

describe("WebSocket transport state events", () => {
  it("replays an already-open transport to a late reconciliation listener", () => {
    emitWsTransportState("open");
    const listener = vi.fn();

    const unsubscribe = addWsTransportStateListener(listener, { replayCurrent: true });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("open");
    unsubscribe();
  });

  describe("waitForWsTransportOpen", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.stubGlobal("window", new EventTarget());
    });

    afterEach(() => {
      emitWsTransportState("open");
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    it("resolves at once when the socket is open", async () => {
      emitWsTransportState("open");
      await expect(waitForWsTransportOpen(1_000)).resolves.toBeUndefined();
    });

    it("waits through a reconnect for the socket to open", async () => {
      emitWsTransportState("connecting");
      let settled = false;
      const waiting = waitForWsTransportOpen(1_000).then(() => {
        settled = true;
      });
      emitWsTransportState("closed");
      emitWsTransportState("connecting");
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(false);
      emitWsTransportState("open");
      await waiting;
      expect(settled).toBe(true);
    });

    it("gives up with the not-sent message at its deadline", async () => {
      emitWsTransportState("connecting");
      const waiting = waitForWsTransportOpen(1_000).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(waiting).resolves.toMatchObject({ message: WS_MESSAGE_NOT_SENT_DETAIL });
    });

    it.each(["incompatible", "disposed"] as const)(
      "does not wait out a %s transport",
      async (state) => {
        emitWsTransportState("connecting");
        const waiting = waitForWsTransportOpen(1_000).catch((error: unknown) => error);
        emitWsTransportState(state);
        await expect(waiting).resolves.toMatchObject({ message: WS_MESSAGE_NOT_SENT_DETAIL });
        await expect(waitForWsTransportOpen(1_000)).rejects.toThrow(WS_MESSAGE_NOT_SENT_DETAIL);
      },
    );
  });
});
