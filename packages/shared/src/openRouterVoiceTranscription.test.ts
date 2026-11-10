import { afterEach, describe, expect, it, vi } from "vitest";

import {
  compactVoiceWavForTranscription,
  OpenRouterVoiceTranscriptionError,
  requestOpenRouterVoiceTranscription,
  requestMossGatewayVoiceTranscription,
} from "./openRouterVoiceTranscription";
import { outboundHttp, type OutboundHttpResponse } from "./outboundHttp";

const WAV_AUDIO = new TextEncoder().encode("RIFF0000WAVE");
const OPERATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function response(body: unknown, status = 200): OutboundHttpResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(body)),
    url: "https://openrouter.ai/api/v1/audio/transcriptions",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("requestOpenRouterVoiceTranscription", () => {
  it("routes a Moss account token only to the caller-validated gateway transcription path", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response({ text: "你好" }));

    await expect(
      requestMossGatewayVoiceTranscription({
        audio: WAV_AUDIO,
        gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
        mimeType: "audio/wav",
        operationId: OPERATION_ID,
        token: "synthetic-moss-access-token",
      }),
    ).resolves.toEqual({ text: "你好" });

    const outbound = request.mock.calls[0]?.[0];
    expect(String(outbound?.url)).toBe(
      "https://project.supabase.co/functions/v1/moss-model-gateway/v1/audio/transcriptions",
    );
    expect(outbound?.policy).toMatchObject({
      allowedOrigins: ["https://project.supabase.co"],
      service: "moss-gateway-voice-transcription",
      timeoutMs: 130_000,
    });
    expect(new Headers(outbound?.headers).get("authorization")).toBe(
      "Bearer synthetic-moss-access-token",
    );
    expect(new Headers(outbound?.headers).get("x-moss-operation-id")).toBe(OPERATION_ID);
  });

  it("uses Moss account recovery copy instead of exposing gateway response bodies", async () => {
    vi.spyOn(outboundHttp, "request").mockResolvedValue(
      response({ error: { message: "UPSTREAM_SECRET_SENTINEL" } }, 401),
    );

    const observed = await requestMossGatewayVoiceTranscription({
      audio: WAV_AUDIO,
      gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
      mimeType: "audio/wav",
      operationId: OPERATION_ID,
      token: "synthetic-moss-access-token",
    }).catch((cause: unknown) => cause);

    expect(observed).toMatchObject({
      code: "MOSS_VOICE_LOGIN_REQUIRED",
      retryable: true,
      message: "Your Moss account session has expired. Sign in again.",
    });
    expect(String(observed)).not.toContain("UPSTREAM_SECRET_SENTINEL");
  });

  it("classifies managed quota exhaustion separately from direct OpenRouter credits", async () => {
    vi.spyOn(outboundHttp, "request").mockResolvedValue(response({}, 402));

    await expect(
      requestMossGatewayVoiceTranscription({
        audio: WAV_AUDIO,
        gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
        mimeType: "audio/wav",
        operationId: OPERATION_ID,
        token: "synthetic-moss-access-token",
      }),
    ).rejects.toMatchObject({
      code: "MOSS_VOICE_QUOTA_EXHAUSTED",
      retryable: false,
      status: 402,
    });
  });

  it("does not expose the OpenRouter implementation when the Moss gateway response is invalid", async () => {
    vi.spyOn(outboundHttp, "request").mockResolvedValue(response({ metadata: "no transcript" }));

    await expect(
      requestMossGatewayVoiceTranscription({
        audio: WAV_AUDIO,
        gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
        mimeType: "audio/wav",
        operationId: OPERATION_ID,
        token: "synthetic-moss-access-token",
      }),
    ).rejects.toMatchObject({
      code: "MOSS_VOICE_INVALID_RESPONSE",
      retryable: true,
      message: "Moss voice transcription returned an invalid response.",
    });
  });

  it("rejects a malformed Moss operation identity before forwarding the account token", async () => {
    const request = vi.spyOn(outboundHttp, "request");
    await expect(
      requestMossGatewayVoiceTranscription({
        audio: WAV_AUDIO,
        gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
        mimeType: "audio/wav",
        operationId: "thread-level-id",
        token: "must-not-leave",
      }),
    ).rejects.toMatchObject({ code: "MOSS_VOICE_OPERATION_ID_INVALID" });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends the official OpenRouter JSON STT request", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response({ text: "你好" }));

    await expect(
      requestOpenRouterVoiceTranscription({
        audio: WAV_AUDIO,
        baseUrl: "https://openrouter.ai/api/v1",
        mimeType: "audio/wav",
        token: "synthetic-token",
      }),
    ).resolves.toEqual({ text: "你好" });

    const outbound = request.mock.calls[0]?.[0];
    expect(outbound?.url).toBeInstanceOf(URL);
    expect(String(outbound?.url)).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(outbound?.method).toBe("POST");
    expect(outbound?.policy).toMatchObject({
      allowedOrigins: ["https://openrouter.ai"],
      maxRedirects: 0,
      service: "openrouter-voice-transcription",
      timeoutMs: 30_000,
    });
    expect(new Headers(outbound?.headers).get("authorization")).toBe("Bearer synthetic-token");
    expect(new Headers(outbound?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(outbound?.body as Uint8Array))).toEqual({
      model: "openai/whisper-1",
      input_audio: { data: btoa("RIFF0000WAVE"), format: "wav" },
    });
  });

  it("rejects a non-OpenRouter origin before forwarding the bearer", async () => {
    const request = vi.spyOn(outboundHttp, "request");
    await expect(
      requestOpenRouterVoiceTranscription({
        audio: WAV_AUDIO,
        baseUrl: "https://attacker.invalid/api/v1",
        mimeType: "audio/wav",
        token: "must-not-leave",
      }),
    ).rejects.toMatchObject({ code: "OPENROUTER_STT_CONFIGURATION_INVALID" });
    expect(request).not.toHaveBeenCalled();
  });

  it("never includes raw upstream errors or credentials in the renderer-facing failure", async () => {
    const secret = "UPSTREAM_SECRET_SENTINEL https://provider.invalid/account";
    vi.spyOn(outboundHttp, "request").mockResolvedValue(
      response({ error: { message: secret }, token: "synthetic-token" }, 503),
    );

    const observed = await requestOpenRouterVoiceTranscription({
      audio: WAV_AUDIO,
      baseUrl: "https://openrouter.ai/api/v1",
      mimeType: "audio/wav",
      token: "synthetic-token",
    }).catch((cause: unknown) => cause);

    expect(observed).toBeInstanceOf(OpenRouterVoiceTranscriptionError);
    expect(observed).toMatchObject({ code: "OPENROUTER_STT_UNAVAILABLE", retryable: true });
    expect(String(observed)).not.toContain(secret);
    expect(String(observed)).not.toContain("synthetic-token");
  });

  it("fails closed on an oversized response or missing transcript", async () => {
    vi.spyOn(outboundHttp, "request").mockResolvedValue(response({ metadata: "no transcript" }));
    await expect(
      requestOpenRouterVoiceTranscription({
        audio: WAV_AUDIO,
        baseUrl: "https://openrouter.ai/api/v1",
        mimeType: "audio/wav",
        token: "synthetic-token",
      }),
    ).rejects.toMatchObject({ code: "OPENROUTER_STT_INVALID_RESPONSE" });
  });
});

/** 16-bit mono PCM WAV like the composer recorder produces. */
function pcmWav(samples: readonly number[], sampleRateHz: number, channels = 1): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      bytes[offset + index] = value.charCodeAt(index);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRateHz, true);
  view.setUint32(28, sampleRateHz * 2 * channels, true);
  view.setUint16(32, 2 * channels, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, sample, true));
  return bytes;
}

function speechClip(sampleRateHz: number): number[] {
  const silence = Array.from({ length: sampleRateHz }, () => 0);
  const tone = Array.from({ length: sampleRateHz }, (_, index) =>
    Math.round(Math.sin((2 * Math.PI * 220 * index) / sampleRateHz) * 12_000),
  );
  return [...silence, ...tone, ...silence];
}

function readWavHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    sampleRateHz: view.getUint32(24, true),
    dataBytes: view.getUint32(40, true),
  };
}

describe("compactVoiceWavForTranscription", () => {
  it("trims silence around speech and resamples a 24 kHz clip to 16 kHz", () => {
    const original = pcmWav(speechClip(24_000), 24_000);

    const compacted = compactVoiceWavForTranscription(original);

    const header = readWavHeader(compacted);
    expect(header.sampleRateHz).toBe(16_000);
    // 1 s of speech plus 300 ms padding each side, at 16 kHz, 2 bytes per sample.
    const seconds = header.dataBytes / 2 / 16_000;
    expect(seconds).toBeGreaterThan(1.5);
    expect(seconds).toBeLessThan(1.7);
    // 3 s at 24 kHz (144 KB) becomes 1.6 s at 16 kHz (51 KB).
    expect(compacted.byteLength).toBeLessThan(original.byteLength * 0.4);
  });

  it("keeps a clip without clear speech whole and only resamples it", () => {
    const quiet = pcmWav(
      Array.from({ length: 24_000 }, () => 3),
      24_000,
    );

    const compacted = compactVoiceWavForTranscription(quiet);

    const header = readWavHeader(compacted);
    expect(header.sampleRateHz).toBe(16_000);
    expect(header.dataBytes / 2).toBe(16_000);
  });

  it("returns anything it does not recognise unchanged", () => {
    expect(compactVoiceWavForTranscription(WAV_AUDIO)).toBe(WAV_AUDIO);
    const stereo = pcmWav(speechClip(24_000), 24_000, 2);
    expect(compactVoiceWavForTranscription(stereo)).toBe(stereo);
  });

  it("sends the compacted clip to the Moss gateway", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(response({ text: "ok" }));
    const original = pcmWav(speechClip(24_000), 24_000);

    await requestMossGatewayVoiceTranscription({
      audio: original,
      gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
      mimeType: "audio/wav",
      operationId: OPERATION_ID,
      token: "synthetic-token",
    });

    const body = request.mock.calls[0]?.[0].body as Uint8Array;
    expect(body.byteLength).toBeLessThan(original.byteLength * 0.4);
  });
});
