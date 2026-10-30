import { describe, expect, it } from "vitest";

import {
  RECONNECT_MAX_DELAY_MS,
  RECONNECT_MIN_DELAY_MS,
  reconnectDelayMs,
  startGuestConnection,
  type GuestConnectionStatus,
} from "./connection";
import { guestFixture } from "./dev/fixtures";
import type { GuestStreamEvent } from "./protocol";
import type { GuestStreamHandlers, GuestTransport, SessionProbe } from "./transport";

interface Harness {
  readonly transport: GuestTransport;
  readonly statuses: GuestConnectionStatus[];
  readonly events: GuestStreamEvent[];
  readonly opened: GuestStreamHandlers[];
  readonly closes: number[];
  readonly timeouts: Array<{ readonly callback: () => void; readonly delayMs: number }>;
  probe: SessionProbe;
  /** Runs the pending timers' callbacks. */
  readonly fire: () => Promise<void>;
}

function harness(initialProbe: SessionProbe = { ok: true }): Harness {
  const timeouts: Array<{ callback: () => void; delayMs: number }> = [];
  const opened: GuestStreamHandlers[] = [];
  const closes: number[] = [];
  const state: { probe: SessionProbe } = { probe: initialProbe };
  const transport: GuestTransport = {
    probeSession: async () => state.probe,
    redeem: async () => null,
    submit: async () => null,
    openStream(handlers) {
      opened.push(handlers);
      const index = opened.length - 1;
      return () => closes.push(index);
    },
    attachmentUrl: (id) => id,
  };
  return {
    transport,
    statuses: [],
    events: [],
    opened,
    closes,
    timeouts,
    get probe() {
      return state.probe;
    },
    set probe(value) {
      state.probe = value;
    },
    async fire() {
      const pending = timeouts.splice(0);
      for (const timeout of pending) timeout.callback();
      await Promise.resolve();
    },
  };
}

const snapshot: GuestStreamEvent = {
  type: "thread",
  item: {
    kind: "snapshot",
    snapshot: guestFixture({ locale: "en", shareId: "share-1", guestName: "Sam", phase: "idle" })
      .snapshot,
  },
};

function start(h: Harness) {
  return startGuestConnection({
    transport: h.transport,
    onEvent: (event) => h.events.push(event),
    onStatus: (status) => h.statuses.push(status),
    timers: {
      setTimeout: (callback, delayMs) => {
        const handle = { callback, delayMs };
        h.timeouts.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        const index = h.timeouts.indexOf(handle as (typeof h.timeouts)[number]);
        if (index !== -1) h.timeouts.splice(index, 1);
      },
    },
    random: () => 0.5,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reconnectDelayMs", () => {
  it("doubles from 1 s, caps at 15 s, and jitters by a quarter either way", () => {
    expect(reconnectDelayMs(0, () => 0.5)).toBe(RECONNECT_MIN_DELAY_MS);
    expect(reconnectDelayMs(1, () => 0.5)).toBe(2_000);
    expect(reconnectDelayMs(3, () => 0.5)).toBe(8_000);
    expect(reconnectDelayMs(10, () => 0.5)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(0, () => 0)).toBe(750);
    expect(reconnectDelayMs(0, () => 1)).toBe(1_250);
  });
});

describe("startGuestConnection", () => {
  it("goes live on the snapshot and passes every frame through", async () => {
    const h = harness();
    start(h);
    expect(h.statuses).toEqual([{ kind: "connecting" }]);
    h.opened[0]!.onEvent({ type: "hello", protocolVersion: 1 });
    h.opened[0]!.onEvent(snapshot);
    expect(h.statuses.at(-1)).toEqual({ kind: "live" });
    expect(h.events.map((event) => event.type)).toEqual(["hello", "thread"]);
  });

  it("probes after a drop and reconnects with growing backoff while the session holds", async () => {
    const h = harness();
    start(h);
    h.opened[0]!.onEvent(snapshot);
    h.opened[0]!.onError();
    await flush();
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: 0 });
    expect(h.timeouts.map((timeout) => timeout.delayMs)).toEqual([1_000]);
    await h.fire();
    expect(h.opened).toHaveLength(2);
    // The retry itself changes nothing on screen; the next probe does.
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: 0 });
    h.opened[1]!.onError();
    await flush();
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: 1 });
    expect(h.timeouts.map((timeout) => timeout.delayMs)).toEqual([2_000]);
    await h.fire();
    h.opened[2]!.onEvent(snapshot);
    expect(h.statuses.at(-1)).toEqual({ kind: "live" });
    // A fresh snapshot resets the backoff.
    h.opened[2]!.onError();
    await flush();
    expect(h.timeouts.map((timeout) => timeout.delayMs)).toEqual([1_000]);
  });

  it("reports an offline owner and keeps retrying", async () => {
    const h = harness();
    start(h);
    h.probe = {
      ok: false,
      failure: { kind: "http", status: 503, reason: "owner_offline", message: null },
    };
    h.opened[0]!.onError();
    await flush();
    expect(h.statuses.at(-1)).toEqual({ kind: "offline", attempt: 0 });
    await h.fire();
    expect(h.opened).toHaveLength(2);
    // The banner stays "owner offline" through the attempt instead of flipping to "reconnecting".
    expect(h.statuses.at(-1)).toEqual({ kind: "offline", attempt: 0 });
    h.opened[1]!.onError();
    await flush();
    expect(h.statuses.at(-1)).toEqual({ kind: "offline", attempt: 1 });
    expect(h.timeouts).toHaveLength(1);
  });

  it("stops for good when the session is refused", async () => {
    const h = harness();
    start(h);
    h.probe = {
      ok: false,
      failure: { kind: "http", status: 403, reason: "inactive", message: null },
    };
    h.opened[0]!.onError();
    await flush();
    expect(h.statuses.at(-1)).toMatchObject({ kind: "lost", failure: { reason: "inactive" } });
    expect(h.timeouts).toHaveLength(0);
  });

  it("stops for good when the relay says the share ended (410)", async () => {
    const h = harness();
    start(h);
    h.probe = {
      ok: false,
      failure: { kind: "http", status: 410, reason: "inactive", message: null },
    };
    h.opened[0]!.onError();
    await flush();
    expect(h.statuses.at(-1)).toMatchObject({ kind: "lost", failure: { reason: "inactive" } });
    expect(h.timeouts).toHaveLength(0);
  });

  it("waits out a relay restart (404) for a few probes, then gives up", async () => {
    const h = harness();
    start(h);
    h.probe = {
      ok: false,
      failure: { kind: "http", status: 404, reason: "invalid", message: null },
    };
    for (let probe = 1; probe < 6; probe += 1) {
      h.opened.at(-1)!.onError();
      await flush();
      expect(h.statuses.at(-1)).toMatchObject({ kind: "offline" });
      await h.fire();
    }
    h.opened.at(-1)!.onError();
    await flush();
    expect(h.statuses.at(-1)).toMatchObject({ kind: "lost", failure: { status: 404 } });
    expect(h.timeouts).toHaveLength(0);
  });

  it("treats a network failure on the probe as a dropped link", async () => {
    const h = harness();
    start(h);
    h.probe = { ok: false, failure: { kind: "network" } };
    h.opened[0]!.onError();
    await flush();
    expect(h.statuses.at(-1)).toEqual({ kind: "reconnecting", attempt: 0 });
    expect(h.timeouts).toHaveLength(1);
  });

  it("ends on the ended frame, closes the stream, and never reconnects", async () => {
    const h = harness();
    start(h);
    h.opened[0]!.onEvent(snapshot);
    h.opened[0]!.onEvent({ type: "ended", reason: "closed" });
    expect(h.statuses.at(-1)).toEqual({ kind: "ended", reason: "closed" });
    expect(h.closes).toEqual([0]);
    expect(h.events.at(-1)).toEqual({ type: "ended", reason: "closed" });
    h.opened[0]!.onError();
    await flush();
    expect(h.timeouts).toHaveLength(0);
    expect(h.opened).toHaveLength(1);
  });

  it("retryNow skips the backoff, and stop closes everything", async () => {
    const h = harness();
    const connection = start(h);
    h.opened[0]!.onError();
    await flush();
    expect(h.timeouts).toHaveLength(1);
    connection.retryNow();
    expect(h.timeouts).toHaveLength(0);
    expect(h.opened).toHaveLength(2);
    connection.retryNow();
    expect(h.opened).toHaveLength(2);
    connection.stop();
    expect(h.closes).toContain(1);
    h.opened[1]!.onEvent(snapshot);
    expect(h.events).toHaveLength(0);
  });
});
