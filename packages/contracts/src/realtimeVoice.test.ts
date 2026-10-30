import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  RealtimeVoiceClaimInput,
  RealtimeVoiceClaimResult,
  RealtimeVoiceEvent,
  RealtimeVoiceListVoicesResult,
  RealtimeVoiceResolveScreenContextInput,
  RealtimeVoiceStartInput,
  RealtimeVoiceStartResult,
  RealtimeVoiceState,
} from "./realtimeVoice";
import { ThreadId } from "./baseSchemas";

describe("Realtime Voice contracts", () => {
  it("requires the backend-owned default voice in the catalog result", () => {
    const decode = Schema.decodeUnknownSync(RealtimeVoiceListVoicesResult);
    expect(
      decode({
        defaultVoice: "maple",
        preferredTransport: "websocket-pcm16",
        voices: [
          {
            id: "maple",
            displayName: "Maple",
            description: "Cheerful and candid",
          },
        ],
      }),
    ).toEqual({
      defaultVoice: "maple",
      preferredTransport: "websocket-pcm16",
      voices: [
        {
          id: "maple",
          displayName: "Maple",
          description: "Cheerful and candid",
        },
      ],
    });
    expect(() => decode({ voices: [] })).toThrow();
  });

  it("negotiates the region-owned media transport before microphone setup", () => {
    expect(
      Schema.decodeUnknownSync(RealtimeVoiceClaimResult)({
        ownerClaimId: "claim-1",
        expiresAt: 1_800_000_000_000,
        preferredTransport: "websocket-pcm16",
      }),
    ).toMatchObject({ preferredTransport: "websocket-pcm16" });
  });

  it("decodes a WebRTC start request without accepting renderer-owned model selection", () => {
    const decode = Schema.decodeUnknownSync(RealtimeVoiceStartInput);
    const parsed = decode({
      ownerClaimId: "claim-1",
      threadId: "thread-voice-1",
      source: "composer-existing",
      voice: "vale",
      transport: { type: "webrtc", sdp: "v=0\r\n" },
      outputModality: "audio",
    });

    expect(parsed.transport.type).toBe("webrtc");
    expect(parsed.voice).toBe("vale");
    expect("model" in parsed).toBe(false);
  });

  it("encodes a browser WebRTC offer without trimming its required trailing CRLF", () => {
    const sdp = "v=0\r\no=- 123 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const input: typeof RealtimeVoiceStartInput.Type = {
      ownerClaimId: "claim-1",
      threadId: ThreadId.makeUnsafe("thread-voice-1"),
      source: "composer-existing",
      voice: "maple",
      transport: { type: "webrtc", sdp },
      outputModality: "audio",
    };

    const encoded = Schema.encodeSync(RealtimeVoiceStartInput)(input);

    expect(encoded.transport).toEqual({ type: "webrtc", sdp });
  });

  it("accepts a keyless PCM16 WebSocket request and a bounded server-issued transport", () => {
    const input = Schema.decodeUnknownSync(RealtimeVoiceStartInput)({
      ownerClaimId: "claim-1",
      threadId: "thread-voice-1",
      source: "composer-existing",
      voice: "maple",
      transport: { type: "websocket-pcm16" },
      outputModality: "audio",
    });
    expect(input.transport).toEqual({ type: "websocket-pcm16" });
    expect("ticket" in input.transport).toBe(false);

    const result = Schema.decodeUnknownSync(RealtimeVoiceStartResult)({
      sessionId: "voice-session-1",
      requestedModel: "gpt-realtime-2.1",
      transport: {
        type: "websocket-pcm16",
        url: "wss://voice-cn.moss.example/v1/realtime/media",
        protocol: "moss-realtime-pcm16-v1",
        ticket: "A".repeat(43),
        expiresAt: "2026-07-27T12:00:00.000Z",
        encoding: "pcm16",
        sampleRate: 24_000,
      },
    });
    expect(result.transport.type).toBe("websocket-pcm16");
  });

  it("requires a thread-scoped ownership claim before media presentation", () => {
    expect(
      Schema.decodeUnknownSync(RealtimeVoiceClaimInput)({
        threadId: "thread-voice-1",
        source: "composer-existing",
      }),
    ).toEqual({ threadId: "thread-voice-1", source: "composer-existing" });
  });

  it("keeps the four activation gates independent", () => {
    const decode = Schema.decodeUnknownSync(RealtimeVoiceState);
    const parsed = decode({
      phase: "starting",
      sessionId: null,
      threadId: "thread-voice-1",
      ownerClaimId: "claim-1",
      source: "composer-existing",
      voice: "arbor",
      requestedModel: "gpt-realtime-2.1",
      actualModel: null,
      activity: null,
      barrier: {
        requestAccepted: true,
        backendStarted: true,
        webRtcConnected: false,
        dataSessionInitialized: false,
      },
      inputMuted: false,
      outputMuted: false,
      error: null,
    });

    expect(parsed.barrier.requestAccepted).toBe(true);
    expect(parsed.barrier.webRtcConnected).toBe(false);
    expect(parsed.phase).toBe("starting");
  });

  it("requires a session and tool call when returning user-approved screen context", () => {
    const parsed = Schema.decodeUnknownSync(RealtimeVoiceResolveScreenContextInput)({
      sessionId: "voice-session-1",
      callId: "screen-call-1",
      accepted: false,
      reason: "screen_context_disabled",
      capturedAt: null,
      sourceAppName: null,
      sourceBundleIdentifier: null,
      sourceWindowTitle: null,
      imageDataUrl: null,
    });
    expect(parsed).toMatchObject({ accepted: false, callId: "screen-call-1" });
  });

  it("decodes trusted usage with modality-specific token counters", () => {
    const decode = Schema.decodeUnknownSync(RealtimeVoiceEvent);
    const parsed = decode({
      type: "usage",
      sessionId: "voice-session-1",
      threadId: "thread-voice-1",
      createdAt: "2026-07-26T00:00:00.000Z",
      responseId: "resp-1",
      usage: {
        inputTextTokens: 80,
        inputCachedTextTokens: 40,
        inputAudioTokens: 20,
        inputCachedAudioTokens: 0,
        inputImageTokens: 0,
        inputCachedImageTokens: 0,
        outputTextTokens: 12,
        outputAudioTokens: 45,
        costNanoUsd: 3_200_000,
      },
      quota: {
        periodEnd: "2026-08-01T00:00:00.000Z",
        planLimitNanoUsd: 1_000_000_000,
        planUsedNanoUsd: 3_200_000,
        planReservedNanoUsd: 100_000_000,
        creditBalance: 20,
        estimatedMinutesRemaining: 9,
      },
    });

    expect(parsed.type).toBe("usage");
    if (parsed.type === "usage") {
      expect(parsed.usage.outputAudioTokens).toBe(45);
      expect(parsed.usage.costNanoUsd).toBe(3_200_000);
    }
  });

  it("requires a stable item id for transcript delta replacement", () => {
    const parsed = Schema.decodeUnknownSync(RealtimeVoiceEvent)({
      type: "transcript",
      sessionId: "voice-session-1",
      threadId: "thread-voice-1",
      createdAt: "2026-07-26T00:00:00.000Z",
      itemId: "item-user-1",
      role: "user",
      delta: "Please inspect the screen",
      done: true,
    });
    expect(parsed).toMatchObject({ type: "transcript", itemId: "item-user-1", done: true });
  });
});
