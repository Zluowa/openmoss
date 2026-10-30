import { BundledCodexRuntimeUnavailableError } from "@synara/shared/codexRuntime";
import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";
import { outboundHttp, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getVersion: () => "0.5.4" },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import {
  classifyDesktopVoiceTranscriptionHttpError,
  requestDesktopBackendVoiceTranscription,
  requestDesktopVoiceTranscription,
  resolveDesktopVoiceCodexExecutable,
  transcribeVoiceViaDesktopBridge,
} from "./voiceTranscription";

const successResponse: OutboundHttpResponse = {
  status: 200,
  headers: new Headers({ "content-type": "application/json" }),
  body: new TextEncoder().encode(JSON.stringify({ text: "hello" })),
  url: "https://chatgpt.com/backend-api/transcribe",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop voice Codex runtime", () => {
  it("uses the verified desktop-bundled Codex without consulting PATH", () => {
    expect(
      resolveDesktopVoiceCodexExecutable({
        MOSS_BUNDLED_CODEX_PATH: "/Applications/Moss.app/Contents/Resources/codex-runtime/codex",
        PATH: "/tmp/fake-global-codex:/usr/bin:/bin",
      }),
    ).toBe("/Applications/Moss.app/Contents/Resources/codex-runtime/codex");
  });

  it("fails closed when the packaged runtime is unavailable", () => {
    expect(() =>
      resolveDesktopVoiceCodexExecutable({
        MOSS_BUNDLED_CODEX_ERROR: "Bundled Codex is invalid. Reinstall Moss.",
        PATH: "/tmp/fake-global-codex:/usr/bin:/bin",
      }),
    ).toThrow(BundledCodexRuntimeUnavailableError);
  });
});

describe("desktop voice outbound policy", () => {
  it("rejects decoded audio over 10 MiB before the local backend request", async () => {
    const oversized = Buffer.alloc(SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 1);
    oversized.write("RIFF", 0, "ascii");
    oversized.write("WAVE", 8, "ascii");
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(
      requestDesktopBackendVoiceTranscription(
        {
          provider: "codex",
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: oversized.toString("base64"),
        },
        {
          backendHttpUrl: "http://127.0.0.1:3773",
          backendAuthToken: "synthetic-desktop-backend-token",
          fetchImpl,
        },
      ),
    ).rejects.toThrow("Voice messages are limited to 10 MB.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("routes the production desktop fallback back through the authenticated Moss backend", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "managed transcript" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      requestDesktopBackendVoiceTranscription(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as never,
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {
          backendHttpUrl: "http://127.0.0.1:3773",
          backendAuthToken: "synthetic-desktop-backend-token",
          fetchImpl,
        },
      ),
    ).resolves.toEqual({ text: "managed transcript" });

    const [requestUrl, requestInit] = fetchImpl.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));
    expect(url.origin).toBe("http://127.0.0.1:3773");
    expect(url.pathname).toBe("/api/voice/transcribe");
    expect(url.searchParams.get("providerInstanceId")).toBe("codex_moss");
    expect(new Headers(requestInit?.headers).get("authorization")).toBe(
      "Bearer synthetic-desktop-backend-token",
    );
    expect(requestInit?.body).toBeInstanceOf(Uint8Array);
  });

  it("keeps the packaged backend bridge alive through the managed gateway timeout window", async () => {
    const signal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(signal);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "managed transcript" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      requestDesktopBackendVoiceTranscription(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as never,
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {
          backendHttpUrl: "http://127.0.0.1:3773",
          backendAuthToken: "synthetic-desktop-backend-token",
          fetchImpl,
        },
      ),
    ).resolves.toEqual({ text: "managed transcript" });
    expect(timeout).toHaveBeenCalledWith(135_000);
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it("does not expose raw backend errors through desktop IPC", async () => {
    const rawProviderError = "UPSTREAM_SECRET_SENTINEL https://provider.invalid/account";
    await expect(
      requestDesktopBackendVoiceTranscription(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as never,
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {
          backendHttpUrl: "http://127.0.0.1:3773",
          backendAuthToken: "synthetic-desktop-backend-token",
          fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(JSON.stringify({ error: rawProviderError }), {
              status: 502,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        },
      ),
    ).rejects.toThrow("Voice transcription is temporarily unavailable. Try again shortly.");
  });

  it("uses stable server codes for actionable Chinese managed-account errors", async () => {
    await expect(
      requestDesktopBackendVoiceTranscription(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as never,
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {
          backendHttpUrl: "http://127.0.0.1:3773",
          backendAuthToken: "synthetic-desktop-backend-token",
          locale: "zh-CN",
          fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
            new Response(
              JSON.stringify({
                error: "PRIVATE_PROVIDER_SENTINEL",
                code: "MOSS_VOICE_QUOTA_EXHAUSTED",
                retryable: false,
              }),
              { status: 402, headers: { "Content-Type": "application/json" } },
            ),
          ),
        },
      ),
    ).rejects.toThrow("当前 Moss 语音额度不可用，请检查套餐或稍后重试。");
  });

  it("rejects non-loopback desktop backend destinations before sending auth", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      requestDesktopBackendVoiceTranscription(
        {
          provider: "codex",
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {
          backendHttpUrl: "https://attacker.example",
          backendAuthToken: "synthetic-desktop-backend-token",
          fetchImpl,
        },
      ),
    ).rejects.toThrow("The local Moss voice service is unavailable.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("gives the production backend composition precedence over direct provider routes", async () => {
    const transcribeViaMossBackend = vi.fn(async () => ({ text: "from backend" }));
    const resolveMossGateway = vi.fn(async () => ({
      gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
      token: "must-not-be-used",
    }));

    await expect(
      transcribeVoiceViaDesktopBridge(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as never,
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {},
        { transcribeViaMossBackend, resolveMossGateway },
      ),
    ).resolves.toEqual({ text: "from backend" });
    expect(transcribeViaMossBackend).toHaveBeenCalledTimes(1);
    expect(resolveMossGateway).not.toHaveBeenCalled();
  });

  it("uses an injected OpenRouter route without starting Codex auth discovery", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(successResponse);

    await expect(
      transcribeVoiceViaDesktopBridge(
        {
          provider: "codex",
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {},
        {
          resolveOpenRouter: async () => ({
            baseUrl: "https://openrouter.ai/api/v1",
            token: "synthetic-openrouter-token",
          }),
        },
      ),
    ).resolves.toEqual({ text: "hello" });

    expect(String(request.mock.calls[0]?.[0].url)).toBe(
      "https://openrouter.ai/api/v1/audio/transcriptions",
    );
  });

  it("prefers an injected Moss gateway over direct OpenRouter and Codex auth discovery", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(successResponse);
    const resolveOpenRouter = vi.fn(async () => ({
      baseUrl: "https://openrouter.ai/api/v1",
      token: "must-not-be-used",
    }));

    await expect(
      transcribeVoiceViaDesktopBridge(
        {
          provider: "codex",
          cwd: "/tmp/project",
          mimeType: "audio/wav",
          sampleRateHz: 24_000,
          durationMs: 1_000,
          audioBase64: Buffer.from("RIFF0000WAVE", "ascii").toString("base64"),
        },
        {},
        {
          resolveOpenRouter,
          resolveMossGateway: async () => ({
            gatewayBaseUrl: "https://project.supabase.co/functions/v1/moss-model-gateway/v1",
            token: "synthetic-moss-account-token",
          }),
        },
      ),
    ).resolves.toEqual({ text: "hello" });

    expect(resolveOpenRouter).not.toHaveBeenCalled();
    expect(String(request.mock.calls[0]?.[0].url)).toBe(
      "https://project.supabase.co/functions/v1/moss-model-gateway/v1/audio/transcriptions",
    );
  });

  it("uses the shared bounded multipart transport", async () => {
    const request = vi.spyOn(outboundHttp, "request").mockResolvedValue(successResponse);

    await requestDesktopVoiceTranscription({
      audioBuffer: Buffer.from("RIFF0000WAVE", "ascii"),
      mimeType: "audio/wav",
      token: "chatgpt-token",
      transcriptionUrl: "https://chatgpt.com/backend-api/transcribe",
    });

    const outbound = request.mock.calls[0]?.[0];
    expect(outbound?.policy.allowedOrigins).toEqual(["https://chatgpt.com"]);
    expect(new Headers(outbound?.headers).get("authorization")).toBe("Bearer chatgpt-token");
    expect(outbound?.body).toBeInstanceOf(Uint8Array);
  });

  it("rejects a provider-returned origin before forwarding the bearer", async () => {
    await expect(
      requestDesktopVoiceTranscription({
        audioBuffer: Buffer.from("RIFF0000WAVE", "ascii"),
        mimeType: "audio/wav",
        token: "chatgpt-token",
        transcriptionUrl: "https://attacker.example/transcribe",
      }),
    ).rejects.toThrow(/not allowed/u);
  });

  it("maps upstream failures without copying provider response text", () => {
    const secret = "UPSTREAM_SECRET_SENTINEL https://provider.invalid/account";
    expect(classifyDesktopVoiceTranscriptionHttpError(503)).toBe(
      "Voice transcription is temporarily unavailable. Try again shortly.",
    );
    expect(classifyDesktopVoiceTranscriptionHttpError(503)).not.toContain(secret);
  });
});
