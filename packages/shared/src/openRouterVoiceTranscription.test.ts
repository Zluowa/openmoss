import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
