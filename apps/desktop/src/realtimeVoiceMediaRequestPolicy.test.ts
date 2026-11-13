import { describe, expect, it } from "vitest";

import { createRealtimeVoiceMediaRequestPolicy } from "./realtimeVoiceMediaRequestPolicy";

const RELAY_ORIGIN = "https://moss-cn-realtime-edge.inkcomicai.com";
const MEDIA_URL = "wss://moss-cn-realtime-edge.inkcomicai.com/v1/realtime/media";
const TICKET = "a".repeat(43);

function mediaRequest(
  overrides: Partial<{
    readonly method: string;
    readonly resourceType: string;
    readonly url: string;
    readonly requestHeaders: Record<string, string>;
  }> = {},
) {
  return {
    method: "GET",
    resourceType: "webSocket",
    url: MEDIA_URL,
    requestHeaders: {
      Origin: "http://127.0.0.1:8991",
      "Sec-WebSocket-Protocol": `moss-realtime-pcm16-v1, moss-ticket.${TICKET}`,
      "X-Preserved": "yes",
    },
    ...overrides,
  };
}

describe("createRealtimeVoiceMediaRequestPolicy", () => {
  it("removes only the trusted renderer Origin from an exact ticketed CN media upgrade", () => {
    const policy = createRealtimeVoiceMediaRequestPolicy({
      realtimeRelayUrl: RELAY_ORIGIN,
      trustedRendererUrl: "http://127.0.0.1:8991/?token=local-only",
    });
    const request = mediaRequest();

    const requestHeaders = policy?.(request);

    expect(requestHeaders).toEqual({
      "Sec-WebSocket-Protocol": `moss-realtime-pcm16-v1, moss-ticket.${TICKET}`,
      "X-Preserved": "yes",
    });
    expect(request.requestHeaders).toHaveProperty("Origin");
  });

  it("removes the trusted Origin header case-insensitively", () => {
    const policy = createRealtimeVoiceMediaRequestPolicy({
      realtimeRelayUrl: RELAY_ORIGIN,
      trustedRendererUrl: "http://127.0.0.1:8991/",
    });
    const request = mediaRequest({
      requestHeaders: {
        origin: "http://127.0.0.1:8991",
        "sec-websocket-protocol": `moss-realtime-pcm16-v1,moss-ticket.${TICKET}`,
      },
    });

    expect(policy?.(request)).toEqual({
      "sec-websocket-protocol": `moss-realtime-pcm16-v1,moss-ticket.${TICKET}`,
    });
  });

  it("supports Electron 43 omitting the ticket subprotocol header from request details", () => {
    const policy = createRealtimeVoiceMediaRequestPolicy({
      realtimeRelayUrl: RELAY_ORIGIN,
      trustedRendererUrl: "http://127.0.0.1:8991/",
    });
    const request = mediaRequest({
      requestHeaders: {
        Origin: "http://127.0.0.1:8991",
        "X-Preserved": "yes",
      },
    });

    expect(policy?.(request)).toEqual({ "X-Preserved": "yes" });
  });

  it.each([
    ["another host", { url: "wss://lookalike.example/v1/realtime/media" }],
    ["another path", { url: `${MEDIA_URL}/extra` }],
    ["query parameters", { url: `${MEDIA_URL}?ticket=leak` }],
    ["non-WebSocket traffic", { resourceType: "xhr" }],
    ["non-GET traffic", { method: "POST" }],
    [
      "an untrusted renderer",
      {
        requestHeaders: {
          Origin: "https://attacker.example",
          "Sec-WebSocket-Protocol": `moss-realtime-pcm16-v1, moss-ticket.${TICKET}`,
        },
      },
    ],
    [
      "a malformed ticket",
      {
        requestHeaders: {
          Origin: "http://127.0.0.1:8991",
          "Sec-WebSocket-Protocol": "moss-realtime-pcm16-v1, moss-ticket.short",
        },
      },
    ],
    [
      "an extra subprotocol",
      {
        requestHeaders: {
          Origin: "http://127.0.0.1:8991",
          "Sec-WebSocket-Protocol": `moss-realtime-pcm16-v1, moss-ticket.${TICKET}, extra`,
        },
      },
    ],
  ] as const)("does not weaken %s", (_label, overrides) => {
    const policy = createRealtimeVoiceMediaRequestPolicy({
      realtimeRelayUrl: RELAY_ORIGIN,
      trustedRendererUrl: "http://127.0.0.1:8991/",
    });
    const request = mediaRequest(overrides);

    expect(policy?.(request)).toEqual(request.requestHeaders);
  });

  it("normalizes the packaged Moss renderer but rejects malformed relay configuration", () => {
    const packagedPolicy = createRealtimeVoiceMediaRequestPolicy({
      realtimeRelayUrl: RELAY_ORIGIN,
      trustedRendererUrl: "moss://app/index.html",
    });
    const packagedRequest = mediaRequest({
      requestHeaders: {
        Origin: "moss://app",
        "sec-websocket-protocol": `moss-realtime-pcm16-v1,moss-ticket.${TICKET}`,
      },
    });

    expect(packagedPolicy?.(packagedRequest)).not.toHaveProperty("Origin");
    expect(
      createRealtimeVoiceMediaRequestPolicy({
        realtimeRelayUrl: "http://moss-cn-realtime-edge.inkcomicai.com",
        trustedRendererUrl: "moss://app/index.html",
      }),
    ).toBeNull();
  });

  it("allows the media upgrade on every listed relay entry, and on nothing else", () => {
    const policy = createRealtimeVoiceMediaRequestPolicy({
      realtimeRelayUrl: "https://rt.mossbotai.com",
      realtimeRelayFallbackUrls: [RELAY_ORIGIN, "not a url", "http://plain.example"],
      trustedRendererUrl: "moss://app/index.html",
    });
    const upgrade = (url: string) =>
      policy?.(
        mediaRequest({
          url,
          requestHeaders: {
            Origin: "moss://app",
            "Sec-WebSocket-Protocol": `moss-realtime-pcm16-v1, moss-ticket.${TICKET}`,
          },
        }),
      );
    // The new entry and the old one: the server hands the renderer the entry in use.
    expect(upgrade("wss://rt.mossbotai.com/v1/realtime/media")).not.toHaveProperty("Origin");
    expect(upgrade(MEDIA_URL)).not.toHaveProperty("Origin");
    for (const url of [
      "wss://rt-global.mossbotai.com/v1/realtime/media",
      "wss://moss-global-realtime.inkcomicai.com/v1/realtime/media",
      "wss://rt.mossbotai.com.evil.example/v1/realtime/media",
      "wss://evil-mossbotai.com/v1/realtime/media",
      "wss://plain.example/v1/realtime/media",
      "wss://rt.mossbotai.com/v1/realtime/control",
      "ws://rt.mossbotai.com/v1/realtime/media",
    ]) {
      expect(upgrade(url)).toHaveProperty("Origin", "moss://app");
    }
  });

  it("keeps a release that lists one relay entry exactly as before", () => {
    const policy = createRealtimeVoiceMediaRequestPolicy({
      realtimeRelayUrl: RELAY_ORIGIN,
      trustedRendererUrl: "moss://app/index.html",
    });
    const upgrade = (url: string) =>
      policy?.(mediaRequest({ url, requestHeaders: { Origin: "moss://app" } }));
    expect(upgrade(MEDIA_URL)).not.toHaveProperty("Origin");
    expect(upgrade("wss://rt.mossbotai.com/v1/realtime/media")).toHaveProperty("Origin");
  });
});
