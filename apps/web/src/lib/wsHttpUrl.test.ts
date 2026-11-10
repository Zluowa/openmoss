import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveWsHttpUrl } from "./wsHttpUrl";

describe("resolveWsHttpUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards the websocket token to relative server routes", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "ws://127.0.0.1:4111/ws?token=legacy-secret",
      },
      location: { origin: "http://fallback.test" },
    });

    expect(resolveWsHttpUrl("/api/attachment")).toBe(
      "http://127.0.0.1:4111/api/attachment?token=legacy-secret",
    );
  });

  it("keeps a copyable download href free of the legacy startup token", () => {
    vi.stubGlobal("window", {
      desktopBridge: { getWsUrl: () => "wss://moss.test/ws?token=fixture-token" },
      location: { origin: "https://fallback.test" },
    });
    const link = "/api/thread-output?threadId=t&file=file.txt";
    expect(resolveWsHttpUrl(link, { includeLegacyToken: false })).toBe("https://moss.test" + link);
    expect(new URL(resolveWsHttpUrl(link)).searchParams.get("token")).toBe("fixture-token");
  });

  it("does not forward the websocket token to an absolute external URL", () => {
    vi.stubGlobal("window", {
      desktopBridge: {
        getWsUrl: () => "wss://moss.test/ws?token=legacy-secret",
      },
      location: { origin: "https://fallback.test" },
    });

    expect(resolveWsHttpUrl("https://example.test/image.png")).toBe(
      "https://example.test/image.png",
    );
  });
});
