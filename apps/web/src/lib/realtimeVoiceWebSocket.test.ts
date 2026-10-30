import { describe, expect, it } from "vitest";

import {
  decodeRealtimeVoicePcm16Delta,
  pcm16BytesToFloat32,
  validateRealtimeVoiceWebSocketTransport,
} from "./realtimeVoiceWebSocket";

const NOW = Date.parse("2026-07-27T11:59:30.000Z");
const validTransport = {
  type: "websocket-pcm16" as const,
  url: "wss://voice-cn.moss.example/v1/realtime/media",
  protocol: "moss-realtime-pcm16-v1" as const,
  ticket: "a".repeat(43),
  expiresAt: "2026-07-27T12:00:00.000Z",
  encoding: "pcm16" as const,
  sampleRate: 24_000 as const,
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

describe("RealtimeVoiceWebSocketClient transport boundary", () => {
  it("accepts only a live ticket on the dedicated WSS media path", () => {
    expect(validateRealtimeVoiceWebSocketTransport(validTransport, NOW).href).toBe(
      validTransport.url,
    );
    expect(() =>
      validateRealtimeVoiceWebSocketTransport(
        { ...validTransport, expiresAt: "2026-07-27T11:59:30.000Z" },
        NOW,
      ),
    ).toThrow("expired");
    expect(() =>
      validateRealtimeVoiceWebSocketTransport(
        { ...validTransport, expiresAt: "2026-07-27T12:00:31.000Z" },
        NOW,
      ),
    ).toThrow("expired");
  });

  it.each([
    "ws://voice-cn.moss.example/v1/realtime/media",
    "wss://voice-cn.moss.example/v1/realtime/control",
    "wss://voice-cn.moss.example/v1/realtime/media?ticket=leak",
    "wss://user:secret@voice-cn.moss.example/v1/realtime/media",
    "wss://voice-cn.moss.example/v1/realtime/media#ticket",
  ])("rejects an unsafe renderer media URL: %s", (url) => {
    expect(() => validateRealtimeVoiceWebSocketTransport({ ...validTransport, url }, NOW)).toThrow(
      "invalid",
    );
  });

  it("rejects malformed tickets and protocol downgrades", () => {
    expect(() =>
      validateRealtimeVoiceWebSocketTransport({ ...validTransport, ticket: "short" }, NOW),
    ).toThrow("invalid");
    expect(() =>
      validateRealtimeVoiceWebSocketTransport(
        { ...validTransport, protocol: "other" as typeof validTransport.protocol },
        NOW,
      ),
    ).toThrow("invalid");
  });

  it("decodes little-endian signed PCM16 without clipping asymmetry", () => {
    const bytes = new Uint8Array([0x00, 0x80, 0x00, 0x00, 0xff, 0x7f]);
    expect([...pcm16BytesToFloat32(bytes)]).toEqual([-1, 0, 1]);
    expect(() => pcm16BytesToFloat32(new Uint8Array([0x01]))).toThrow("invalid PCM16");
  });

  it("accepts the bounded audio-delta budget and rejects the next PCM sample", () => {
    const maximumRawPcm = new Uint8Array(72 * 1_024);
    const maximumDelta = bytesToBase64(maximumRawPcm);
    expect(maximumDelta.length).toBe(96 * 1_024);
    expect(decodeRealtimeVoicePcm16Delta(maximumDelta)).toHaveLength(36 * 1_024);
    const overLimitDelta = bytesToBase64(new Uint8Array(72 * 1_024 + 2));
    expect(overLimitDelta.length).toBeGreaterThan(96 * 1_024);
    expect(() => decodeRealtimeVoicePcm16Delta(overLimitDelta)).toThrow("invalid audio data");
  });
});
