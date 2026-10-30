// FILE: voiceTranscription.ts
// Purpose: Validates normalized WAV payloads and routes them to a server-owned transcription adapter.
// Layer: Server utility
// Exports: transcribeVoiceWithChatGptSession
// Depends on: injected OpenRouter credentials or ChatGPT session auth supplied by server callers.

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";
import {
  requestOpenRouterVoiceTranscription,
  requestMossGatewayVoiceTranscription,
} from "@synara/shared/openRouterVoiceTranscription";
import { requestChatGptVoiceTranscription } from "@synara/shared/chatGptVoiceTranscription";
import { decodeOutboundJson, type OutboundHttpResponse } from "@synara/shared/outboundHttp";

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
    throw new Error(readTranscriptionErrorMessage(response));
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
function decodeVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  const normalizedBase64 = normalizeBase64(input.audioBase64);
  if (!normalizedBase64 || !isLikelyBase64(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  // `isLikelyBase64` already pins the alphabet and padding shape, so comparing
  // the decoded length against what the base64 length implies catches a
  // truncated or mis-padded payload without re-encoding ~13 MB just to compare.
  if (!audioBuffer.length || audioBuffer.length !== expectedBase64DecodedLength(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }
  if (audioBuffer.length > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES) {
    throw new Error("Voice messages are limited to 10 MB.");
  }
  if (!isLikelyWavBuffer(audioBuffer)) {
    throw new Error("The recorded audio is not a valid WAV file.");
  }

  return audioBuffer;
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

function readTranscriptionErrorMessage(response: OutboundHttpResponse): string {
  if (response.status === 401 || response.status === 403) {
    return "Your ChatGPT login has expired. Sign in again.";
  }
  if (response.status === 402) {
    return "Voice transcription credits are unavailable.";
  }
  if (response.status === 413) {
    return "The voice recording is too large to transcribe.";
  }
  if (response.status === 429 || response.status >= 500) {
    return "Voice transcription is temporarily unavailable. Try again shortly.";
  }
  return `Voice transcription was rejected with status ${response.status}.`;
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
