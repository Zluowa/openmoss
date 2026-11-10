import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readDesktopBackendWsUrl,
  reportDesktopBackendLink,
  resolveTransportLink,
  transportNoticeHoldMs,
  transportReconnectMaxDelayMs,
} from "./transportLink";

const stubBridge = (bridge: unknown) => vi.stubGlobal("window", { desktopBridge: bridge });

describe("transport link", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is the desktop's own backend only when the bridge hands out a URL", () => {
    stubBridge({ getWsUrl: () => "ws://127.0.0.1:4321/?token=t" });
    expect(readDesktopBackendWsUrl()).toBe("ws://127.0.0.1:4321/?token=t");
    expect(resolveTransportLink()).toBe("desktop-backend");

    for (const url of [null, ""]) {
      stubBridge({ getWsUrl: () => url });
      expect(resolveTransportLink()).toBe("network");
    }

    stubBridge(undefined);
    expect(resolveTransportLink()).toBe("network");
  });

  it("never reads the address itself, so a remote URL on a bridge or a loopback page cannot fool it", () => {
    stubBridge({ getWsUrl: () => "wss://moss.example.com/ws" });
    expect(resolveTransportLink()).toBe("desktop-backend");

    vi.stubGlobal("window", { location: { hostname: "127.0.0.1", port: "3773" } });
    expect(resolveTransportLink()).toBe("network");
  });

  it("treats an explicit URL as network even inside the desktop app", () => {
    stubBridge({ getWsUrl: () => "ws://127.0.0.1:4321" });
    expect(resolveTransportLink("ws://127.0.0.1:4321")).toBe("network");
  });

  it("holds only recoverable notices for the desktop's own backend", () => {
    expect(transportNoticeHoldMs("reconnecting", "desktop-backend")).toBe(10_000);
    expect(transportNoticeHoldMs("connecting", "desktop-backend")).toBe(10_000);
    expect(transportNoticeHoldMs("incompatible", "desktop-backend")).toBe(1_500);
    expect(transportNoticeHoldMs("disconnected", "desktop-backend")).toBe(1_500);
    expect(transportNoticeHoldMs("reconnecting", "network")).toBe(1_500);
    expect(transportNoticeHoldMs("connecting", "network")).toBe(1_500);
  });

  it("retries the desktop's own backend sooner than a remote one", () => {
    expect(transportReconnectMaxDelayMs("desktop-backend")).toBe(500);
    expect(transportReconnectMaxDelayMs("network")).toBe(5_000);
  });

  it("does not let a failed report reach the transport", () => {
    stubBridge({
      reportBackendLink: () => {
        throw new Error("IPC closed");
      },
    });
    expect(() => reportDesktopBackendLink({ phase: "up" })).not.toThrow();
    stubBridge(undefined);
    expect(() => reportDesktopBackendLink({ phase: "up" })).not.toThrow();
  });
});
