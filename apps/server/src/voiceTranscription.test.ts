// FILE: voiceTranscription.test.ts
// Purpose: Verifies ChatGPT-session voice transcription behavior without contacting OpenAI.
// Layer: Server test
// Exports: Vitest cases
// Depends on: voiceTranscription utility and mocked fetch responses.

import {
  SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES,
  type ServerVoiceTranscriptionInput,
} from "@synara/contracts";
import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { transcribeVoiceWithChatGptSession } from "./voiceTranscription";

const WAV_BASE64 = Buffer.from("RIFF0000WAVE", "ascii").toString("base64");

const baseRequest: ServerVoiceTranscriptionInput = {
  provider: "codex",
  cwd: "/tmp/project",
  mimeType: "audio/wav",
  sampleRateHz: 24_000,
  durationMs: 1_000,
  audioBase64: WAV_BASE64,
};

function outboundJson(body: unknown, status = 200): OutboundHttpResponse {
  return {
    status,
    headers: new Headers({ "content-type": "application/json" }),
    body: new TextEncoder().encode(JSON.stringify(body)),
    url: "https://chatgpt.com/backend-api/transcribe",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("transcribeVoiceWithChatGptSession", () => {
  it("rejects decoded audio over 10 MiB before resolving any credential route", async () => {
    const oversized = Buffer.alloc(SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 1);
    oversized.write("RIFF", 0, "ascii");
    oversized.write("WAVE", 8, "ascii");
    const resolveMossGateway = vi.fn(async () => null);
    const resolveOpenRouter = vi.fn(async () => null);
    const resolveAuth = vi.fn(async () => ({ token: "must-not-be-read" }));

    await expect(
      transcribeVoiceWithChatGptSession({
        request: { ...baseRequest, audioBase64: oversized.toString("base64") },
        resolveMossGateway,
        resolveOpenRouter,
        resolveAuth,
      }),
    ).rejects.toThrow("Voice messages are limited to 10 MB.");
    expect(resolveMossGateway).not.toHaveBeenCalled();
    expect(resolveOpenRouter).not.toHaveBeenCalled();
    expect(resolveAuth).not.toHaveBeenCalled();
  });

  it("prefers the Moss account gateway over direct OpenRouter and ChatGPT", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValue(outboundJson({ text: "Moss gateway transcript" }));
    const resolveAuth = vi.fn(async () => ({ token: "must-not-be-read" }));
    const resolveOpenRouter = vi.fn(async () => ({
      baseUrl: "https://openrouter.ai/api/v1",
      token: "must-not-be-used",
    }));

    await expect(
      transcribeVoiceWithChatGptSession({
        request: baseRequest,
        resolveAuth,
        resolveOpenRouter,
        resolveMossGateway: async () => ({
          gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
          token: "synthetic-moss-account-token",
        }),
      }),
    ).resolves.toEqual({ text: "Moss gateway transcript" });

    expect(resolveAuth).not.toHaveBeenCalled();
    expect(resolveOpenRouter).not.toHaveBeenCalled();
    expect(String(request.mock.calls[0]?.[0].url)).toBe(
      "https://project.supabase.co/functions/v1/moss-model-gateway/v1/audio/transcriptions",
    );
    expect(new Headers(request.mock.calls[0]?.[0].headers).get("x-moss-operation-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
  });

  it("uses an injected OpenRouter route without assuming a ChatGPT Codex session", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValue(outboundJson({ text: "OpenRouter transcript" }));
    const resolveAuth = vi.fn(async () => ({ token: "must-not-be-read" }));

    await expect(
      transcribeVoiceWithChatGptSession({
        request: baseRequest,
        resolveAuth,
        resolveOpenRouter: async () => ({
          baseUrl: "https://openrouter.ai/api/v1",
          token: "synthetic-openrouter-token",
        }),
      }),
    ).resolves.toEqual({ text: "OpenRouter transcript" });

    expect(resolveAuth).not.toHaveBeenCalled();
    expect(String(request.mock.calls[0]?.[0].url)).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions",
    );
  });

  it("uses the ChatGPT transcription backend", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValue(outboundJson({ text: "hello" }));

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: "chatgpt-token" }),
    });

    const outbound = request.mock.calls[0]?.[0];
    expect(outbound?.url).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(new TextDecoder().decode(outbound?.body as Uint8Array)).not.toContain('name="model"');
  });

  it("refreshes the ChatGPT session once when the upload is unauthorized", async () => {
    const request = vi
      .spyOn(outboundHttp, "request")
      .mockResolvedValueOnce(outboundJson({}, 401))
      .mockResolvedValueOnce(outboundJson({ text: "hello" }));
    const resolveAuth = vi.fn(async (refreshToken: boolean) => ({
      token: refreshToken ? "fresh-chatgpt-token" : "stale-chatgpt-token",
    }));

    await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth,
    });

    expect(resolveAuth).toHaveBeenNthCalledWith(1, false);
    expect(resolveAuth).toHaveBeenNthCalledWith(2, true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects a provider-returned transcription origin before forwarding the token", async () => {
    await expect(
      transcribeVoiceWithChatGptSession({
        request: baseRequest,
        resolveAuth: async () => ({
          token: "chatgpt-token",
          transcriptionUrl: "https://attacker.example/transcribe",
        }),
      }),
    ).rejects.toThrow(/not allowed/u);
  });

  it("never returns a raw upstream error from either transcription route", async () => {
    const secret = "UPSTREAM_SECRET_SENTINEL https://provider.invalid/account";
    vi.spyOn(outboundHttp, "request").mockResolvedValue(outboundJson({ message: secret }, 500));

    const observed = await transcribeVoiceWithChatGptSession({
      request: baseRequest,
      resolveAuth: async () => ({ token: "chatgpt-token" }),
    }).catch((cause: unknown) => cause);

    expect(String(observed)).toBe(
      "Error: Voice transcription is temporarily unavailable. Try again shortly.",
    );
    expect(String(observed)).not.toContain(secret);
  });
});
