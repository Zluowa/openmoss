import { EventEmitter } from "node:events";
import type { connect as tlsConnect } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { MOSS_CLOUD_REGION_HEADER } from "@synara/shared/mossProductionPublicConfig";

import {
  RealtimeVoiceRelayClient,
  resolveMossCloudRegion,
  shouldRetryControlOverIpv4,
} from "./relayClient";

const SESSION_ID = "20000000-0000-4000-8000-000000000002";
const NOW = Date.parse("2026-07-27T11:59:30.000Z");

describe("RealtimeVoiceRelayClient regional binding", () => {
  it("requires an explicit packaged cloud region", () => {
    expect(resolveMossCloudRegion({ MOSS_CLOUD_REGION: "cn" })).toBe("cn");
    expect(resolveMossCloudRegion({ MOSS_CLOUD_REGION: "global" })).toBe("global");
    expect(() => resolveMossCloudRegion({})).toThrow("MOSS_CLOUD_REGION_NOT_CONFIGURED");
    expect(() => resolveMossCloudRegion({ MOSS_CLOUD_REGION: "auto" })).toThrow(
      "MOSS_CLOUD_REGION_NOT_CONFIGURED",
    );
  });

  it("sends the region and rejects a start response from another plane", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get(MOSS_CLOUD_REGION_HEADER)).toBe("cn");
      return new Response(
        JSON.stringify({
          cloudRegion: "global",
          sessionId: SESSION_ID,
          requestedModel: "gpt-realtime-2.1",
          transport: { type: "webrtc", sdp: "v=0\r\n" },
          controlPath: `/v1/realtime/control?session_id=${SESSION_ID}`,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = new RealtimeVoiceRelayClient({
      origin: "https://voice-cn.moss.example",
      cloudRegion: "cn",
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.startCall({
        accessToken: "token",
        sessionId: SESSION_ID,
        transport: { type: "webrtc", sdp: "v=0\r\n" },
        voice: "maple",
        outputModality: "audio",
      }),
    ).rejects.toMatchObject({ code: "REALTIME_RELAY_INVALID_RESPONSE" });
  });

  it("returns only a validated same-relay WebSocket endpoint and one-time ticket", async () => {
    const ticket = "a".repeat(43);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionId: SESSION_ID,
        transport: { type: "websocket-pcm16" },
        voice: "maple",
        outputModality: "audio",
      });
      return new Response(
        JSON.stringify({
          cloudRegion: "cn",
          sessionId: SESSION_ID,
          requestedModel: "gpt-realtime-2.1",
          transport: {
            type: "websocket-pcm16",
            url: "/v1/realtime/media",
            protocol: "moss-realtime-pcm16-v1",
            ticket,
            expiresAt: "2026-07-27T12:00:00.000Z",
            encoding: "pcm16",
            sampleRate: 24_000,
          },
          controlPath: `/v1/realtime/control?session_id=${SESSION_ID}`,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    });
    const client = new RealtimeVoiceRelayClient({
      origin: "https://voice-cn.moss.example",
      cloudRegion: "cn",
      fetch: fetchMock as unknown as typeof fetch,
      now: () => NOW,
    });

    await expect(
      client.startCall({
        accessToken: "renderer-never-sees-this-token",
        sessionId: SESSION_ID,
        transport: { type: "websocket-pcm16" },
        voice: "maple",
        outputModality: "audio",
      }),
    ).resolves.toMatchObject({
      transport: {
        type: "websocket-pcm16",
        url: "wss://voice-cn.moss.example/v1/realtime/media",
        protocol: "moss-realtime-pcm16-v1",
        ticket,
        sampleRate: 24_000,
      },
    });
  });

  it("rejects a relay response that tries to choose another media origin or transport", async () => {
    const fetchMock = vi.fn(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            cloudRegion: "cn",
            sessionId: SESSION_ID,
            requestedModel: "gpt-realtime-2.1",
            transport: {
              type: "websocket-pcm16",
              url: "wss://attacker.invalid/v1/realtime/media",
              protocol: "moss-realtime-pcm16-v1",
              ticket: "a".repeat(43),
              expiresAt: "2026-07-27T12:00:00.000Z",
              encoding: "pcm16",
              sampleRate: 24_000,
            },
            controlPath: `/v1/realtime/control?session_id=${SESSION_ID}`,
          }),
          { status: 201 },
        ),
      ),
    );
    const client = new RealtimeVoiceRelayClient({
      origin: "https://voice-cn.moss.example",
      cloudRegion: "cn",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      client.startCall({
        accessToken: "token",
        sessionId: SESSION_ID,
        transport: { type: "websocket-pcm16" },
        voice: "maple",
        outputModality: "audio",
      }),
    ).rejects.toMatchObject({ code: "REALTIME_RELAY_INVALID_RESPONSE" });
  });
});

const HANDSHAKE_TIMEOUT = "Opening handshake has timed out";

class FakeControlSocket extends EventEmitter {
  static instances: FakeControlSocket[] = [];
  readonly readyState = 0;
  constructor(
    readonly url: string,
    readonly options: WebSocket.ClientOptions & { readonly family?: number },
  ) {
    super();
    FakeControlSocket.instances.push(this);
  }
  close() {}
  send() {}

  /** Simulates `ws` opening its TLS connection over the given address family. */
  connectOver(family: "IPv4" | "IPv6") {
    nextTlsFamily = family;
    const createConnection = this.options.createConnection as unknown as (options: {
      readonly host: string;
      readonly port: number;
    }) => EventEmitter;
    createConnection({ host: "voice-cn.moss.example", port: 443 }).emit("connect");
  }

  timeOut() {
    this.emit("error", new Error(HANDSHAKE_TIMEOUT));
    this.emit("close", 1006, Buffer.alloc(0));
  }
}

let nextTlsFamily: "IPv4" | "IPv6" = "IPv6";

function connectControlWithFakes() {
  FakeControlSocket.instances = [];
  const fakeTlsConnect = vi.fn(() =>
    Object.assign(new EventEmitter(), { remoteFamily: nextTlsFamily }),
  );
  const client = new RealtimeVoiceRelayClient({
    origin: "https://voice-cn.moss.example",
    cloudRegion: "cn",
    webSocketFactory: FakeControlSocket as unknown as typeof WebSocket,
    tlsConnect: fakeTlsConnect as unknown as typeof tlsConnect,
  });
  const handlers = { onOpen: vi.fn(), onEvent: vi.fn(), onError: vi.fn(), onClose: vi.fn() };
  client.connectControl({
    accessToken: "token",
    controlPath: `/v1/realtime/control?session_id=${SESSION_ID}`,
    ...handlers,
  });
  return handlers;
}

describe("realtime control channel IPv4 fallback", () => {
  it("retries only a first IPv6 handshake timeout", () => {
    const timeout = new Error(HANDSHAKE_TIMEOUT);
    expect(shouldRetryControlOverIpv4({ error: timeout, attempt: 0, family: "IPv6" })).toBe(true);
    expect(shouldRetryControlOverIpv4({ error: timeout, attempt: 1, family: "IPv6" })).toBe(false);
    expect(shouldRetryControlOverIpv4({ error: timeout, attempt: 0, family: "IPv4" })).toBe(false);
    expect(shouldRetryControlOverIpv4({ error: timeout, attempt: 0, family: undefined })).toBe(
      false,
    );
    expect(
      shouldRetryControlOverIpv4({
        error: new Error("Unexpected server response: 401"),
        attempt: 0,
        family: "IPv6",
      }),
    ).toBe(false);
  });

  it("reconnects once over IPv4 after an IPv6 handshake timeout without surfacing it", () => {
    const handlers = connectControlWithFakes();
    const [first] = FakeControlSocket.instances;
    expect(first!.options.family).toBeUndefined();
    first!.connectOver("IPv6");
    first!.timeOut();

    expect(FakeControlSocket.instances).toHaveLength(2);
    const second = FakeControlSocket.instances[1]!;
    expect(second.url).toBe(first!.url);
    expect(second.options.family).toBe(4);
    expect(second.options.headers).toEqual(first!.options.headers);
    expect(handlers.onError).not.toHaveBeenCalled();
    expect(handlers.onClose).not.toHaveBeenCalled();

    second.connectOver("IPv4");
    second.emit("open");
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the timed-out handshake already used IPv4", () => {
    const handlers = connectControlWithFakes();
    const [first] = FakeControlSocket.instances;
    first!.connectOver("IPv4");
    first!.timeOut();

    expect(FakeControlSocket.instances).toHaveLength(1);
    expect(handlers.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: HANDSHAKE_TIMEOUT }),
    );
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("does not retry other IPv6 failures", () => {
    const handlers = connectControlWithFakes();
    const [first] = FakeControlSocket.instances;
    first!.connectOver("IPv6");
    first!.emit("error", new Error("Unexpected server response: 404"));
    first!.emit("close", 1006, Buffer.alloc(0));

    expect(FakeControlSocket.instances).toHaveLength(1);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });

  it("gives up after the single IPv4 retry also times out", () => {
    const handlers = connectControlWithFakes();
    const [first] = FakeControlSocket.instances;
    first!.connectOver("IPv6");
    first!.timeOut();
    const second = FakeControlSocket.instances[1]!;
    second.connectOver("IPv4");
    second.timeOut();

    expect(FakeControlSocket.instances).toHaveLength(2);
    expect(handlers.onError).toHaveBeenCalledTimes(1);
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
  });
});
