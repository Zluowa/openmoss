// FILE: voiceTranscription.ts
// Purpose: Validates normalized WAV payloads and routes them to a server-owned transcription adapter.
// Layer: Server utility
// Exports: transcribeVoiceWithChatGptSession, transcribeVoiceWithMossGateway
// Depends on: injected Moss gateway/OpenRouter credentials or ChatGPT session auth supplied by server callers.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@moss/contracts";
import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@moss/contracts";
import {
  OpenRouterVoiceTranscriptionError,
  requestOpenRouterVoiceTranscription,
  requestMossGatewayVoiceTranscription,
} from "@moss/shared/openRouterVoiceTranscription";
import { requestChatGptVoiceTranscription } from "@moss/shared/chatGptVoiceTranscription";
import { decodeOutboundJson, type OutboundHttpResponse } from "@moss/shared/outboundHttp";

const MAX_DURATION_MS = 120_000;

export interface ChatGptVoiceAuthContext {
  readonly token: string;
  readonly transcriptionUrl?: string;
}

export interface OpenRouterVoiceTranscriptionContext {
  readonly baseUrl: string;
  readonly token: string;
}

export interface MossGatewayVoiceTranscriptionContext {
  readonly gatewayBaseUrl: string;
  readonly token: string;
}

/**
 * Sends a validated clip to the signed-in Moss account's gateway. The caller resolves the
 * gateway and bearer from live server-owned account state; nothing here reads settings.
 */
export async function transcribeVoiceWithMossGateway(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly gateway: MossGatewayVoiceTranscriptionContext;
  readonly signal?: AbortSignal;
}): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeVoiceAudio(input.request);
  return requestMossGatewayVoiceTranscription({
    audio: audioBuffer,
    gatewayBaseUrl: input.gateway.gatewayBaseUrl,
    mimeType: input.request.mimeType,
    token: input.gateway.token,
    operationId: input.request.operationId ?? randomUUID(),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

// Validate the captured WAV clip and retry once if the ChatGPT session needs a refresh.
export async function transcribeVoiceWithChatGptSession(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly resolveAuth: (refreshToken: boolean) => Promise<ChatGptVoiceAuthContext>;
  readonly resolveMossGateway?: () => Promise<MossGatewayVoiceTranscriptionContext | null>;
  readonly resolveOpenRouter?: () => Promise<OpenRouterVoiceTranscriptionContext | null>;
  readonly signal?: AbortSignal;
}): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeVoiceAudio(input.request);
  if (input.resolveMossGateway) {
    let mossGateway: MossGatewayVoiceTranscriptionContext | null;
    try {
      mossGateway = await input.resolveMossGateway();
    } catch (cause) {
      if (cause instanceof Error) throw cause;
      throw new Error("Your Moss account session is unavailable. Sign in again.");
    }
    if (mossGateway) {
      const operationId = input.request.operationId ?? randomUUID();
      return requestMossGatewayVoiceTranscription({
        audio: audioBuffer,
        gatewayBaseUrl: mossGateway.gatewayBaseUrl,
        mimeType: input.request.mimeType,
        token: mossGateway.token,
        operationId,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
  }
  if (input.resolveOpenRouter) {
    let openRouter: OpenRouterVoiceTranscriptionContext | null;
    try {
      openRouter = await input.resolveOpenRouter();
    } catch {
      throw new Error("OpenRouter voice transcription credentials are unavailable.");
    }
    if (openRouter) {
      return requestOpenRouterVoiceTranscription({
        audio: audioBuffer,
        baseUrl: openRouter.baseUrl,
        mimeType: input.request.mimeType,
        token: openRouter.token,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
  }
  let auth = await input.resolveAuth(false);
  let response = await requestTranscription({
    audioBuffer,
    mimeType: input.request.mimeType,
    token: auth.token,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
  });

  if (response.status === 401 || response.status === 403) {
    auth = await input.resolveAuth(true);
    response = await requestTranscription({
      audioBuffer,
      mimeType: input.request.mimeType,
      token: auth.token,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(auth.transcriptionUrl ? { transcriptionUrl: auth.transcriptionUrl } : {}),
    });
  }

  if (response.status < 200 || response.status >= 300) {
    throw chatGptTranscriptionStatusError(response.status);
  }

  let payload: { text?: unknown; transcript?: unknown } | null = null;
  try {
    payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
      text?: unknown;
      transcript?: unknown;
    };
  } catch {
    payload = null;
  }
  const text = readString(payload?.text) ?? readString(payload?.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

// Keep the server-side contract strict so the private backend only sees normalized clips.
// Every rejection carries a stable code so the UI can show plain localized guidance.
function decodeVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw invalidVoiceAudio("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw invalidVoiceAudio("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw invalidVoiceAudio("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_DURATION_MS) {
    throw new OpenRouterVoiceTranscriptionError({
      code: "VOICE_AUDIO_TOO_LONG",
      message: "Voice messages are limited to 120 seconds.",
      retryable: false,
      status: 413,
    });
  }

  const normalizedBase64 = normalizeBase64(input.audioBase64);
  if (!normalizedBase64 || !isLikelyBase64(normalizedBase64)) {
    throw invalidVoiceAudio("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  // `isLikelyBase64` already pins the alphabet and padding shape, so comparing
  // the decoded length against what the base64 length implies catches a
  // truncated or mis-padded payload without re-encoding ~13 MB just to compare.
  if (!audioBuffer.length || audioBuffer.length !== expectedBase64DecodedLength(normalizedBase64)) {
    throw invalidVoiceAudio("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new OpenRouterVoiceTranscriptionError({
      code: "MOSS_VOICE_AUDIO_TOO_LARGE",
      message: "Voice messages are limited to 10 MB.",
      retryable: false,
      status: 413,
    });
  }
  if (!isLikelyWavBuffer(audioBuffer)) {
    throw invalidVoiceAudio("The recorded audio is not a valid WAV file.");
  }

  return audioBuffer;
}

function invalidVoiceAudio(message: string): OpenRouterVoiceTranscriptionError {
  return new OpenRouterVoiceTranscriptionError({
    code: "VOICE_AUDIO_INVALID",
    message,
    retryable: false,
    status: 400,
  });
}

async function requestTranscription(input: {
  readonly audioBuffer: Buffer;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl?: string;
  readonly signal?: AbortSignal;
}): Promise<OutboundHttpResponse> {
  return requestChatGptVoiceTranscription({
    audio: input.audioBuffer,
    mimeType: input.mimeType,
    token: input.token,
    ...(input.transcriptionUrl ? { transcriptionUrl: input.transcriptionUrl } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

function chatGptTranscriptionStatusError(status: number): OpenRouterVoiceTranscriptionError {
  if (status === 401 || status === 403) {
    return new OpenRouterVoiceTranscriptionError({
      code: "VOICE_CHATGPT_LOGIN_EXPIRED",
      message: "Your ChatGPT login has expired. Sign in again.",
      retryable: false,
      status,
    });
  }
  if (status === 402) {
    return new OpenRouterVoiceTranscriptionError({
      code: "VOICE_TRANSCRIPTION_UNAVAILABLE",
      message: "Voice transcription credits are unavailable.",
      retryable: false,
      status,
    });
  }
  if (status === 413) {
    return new OpenRouterVoiceTranscriptionError({
      code: "MOSS_VOICE_AUDIO_TOO_LARGE",
      message: "The voice recording is too large to transcribe.",
      retryable: false,
      status,
    });
  }
  if (status === 429 || status >= 500) {
    return new OpenRouterVoiceTranscriptionError({
      code: "VOICE_TRANSCRIPTION_UNAVAILABLE",
      message: "Voice transcription is temporarily unavailable. Try again shortly.",
      retryable: true,
      status,
    });
  }
  return new OpenRouterVoiceTranscriptionError({
    code: "VOICE_CHATGPT_REJECTED",
    message: `Voice transcription was rejected with status ${status}.`,
    retryable: false,
    status: status >= 400 && status <= 599 ? status : 502,
  });
}

function normalizeBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function expectedBase64DecodedLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function isLikelyWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function readString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}
