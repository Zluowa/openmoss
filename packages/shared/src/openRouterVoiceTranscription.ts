// FILE: openRouterVoiceTranscription.ts
// Purpose: Owns OpenRouter's bounded Whisper transcription transport and safe response contract.
// Layer: Shared Node/Electron provider transport

import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";

import { decodeOutboundJson, encodeOutboundMultipart, outboundHttp } from "./outboundHttp";

export const OPENROUTER_VOICE_TRANSCRIPTION_BASE_URL = "https://openrouter.ai/api/v1";

const OPENROUTER_ORIGIN = "https://openrouter.ai";
const MAX_MULTIPART_BYTES = SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES + 64 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OPENROUTER_VOICE_TRANSCRIPTION_TIMEOUT_MS = 30_000;
const MOSS_GATEWAY_VOICE_TRANSCRIPTION_TIMEOUT_MS = 130_000;
const NON_CANONICAL_DOT_SEGMENT = /(?:^|[\\/])(?:\.|%2e){1,2}(?=[\\/?#]|$)/iu;
const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function base64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export class OpenRouterVoiceTranscriptionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number | null;

  constructor(input: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly status?: number;
  }) {
    super(input.message);
    this.name = "OpenRouterVoiceTranscriptionError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status ?? null;
  }
}

function stableError(
  code: string,
  message: string,
  retryable: boolean,
  status?: number,
): OpenRouterVoiceTranscriptionError {
  return new OpenRouterVoiceTranscriptionError({
    code,
    message,
    retryable,
    ...(status === undefined ? {} : { status }),
  });
}

function resolveEndpoint(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw stableError(
      "OPENROUTER_STT_CONFIGURATION_INVALID",
      "OpenRouter voice transcription is not configured correctly.",
      false,
    );
  }
  if (
    url.origin !== OPENROUTER_ORIGIN ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/api/v1" && url.pathname !== "/api/v1/")
  ) {
    throw stableError(
      "OPENROUTER_STT_CONFIGURATION_INVALID",
      "OpenRouter voice transcription is not configured correctly.",
      false,
    );
  }
  url.pathname = "/api/v1/";
  return new URL("audio/transcriptions", url);
}

function resolveMossGatewayEndpoint(gatewayBaseUrl: string): URL {
  const candidate = gatewayBaseUrl.trim();
  if (!candidate || NON_CANONICAL_DOT_SEGMENT.test(candidate)) {
    throw stableError(
      "MOSS_VOICE_GATEWAY_INVALID",
      "The Moss voice gateway is not configured correctly.",
      false,
    );
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw stableError(
      "MOSS_VOICE_GATEWAY_INVALID",
      "The Moss voice gateway is not configured correctly.",
      false,
    );
  }
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
  const pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  if (
    (url.protocol !== "https:" && !loopback) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !pathname.endsWith("/functions/v1/moss-model-gateway")
  ) {
    throw stableError(
      "MOSS_VOICE_GATEWAY_INVALID",
      "The Moss voice gateway is not configured correctly.",
      false,
    );
  }
  url.pathname = `${pathname}/v1/`;
  return new URL("audio/transcriptions", url);
}

function validateInput(input: {
  readonly audio: Uint8Array;
  readonly mimeType: string;
  readonly token: string;
}): void {
  if (
    input.audio.byteLength === 0 ||
    input.audio.byteLength > SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES ||
    input.mimeType !== "audio/wav"
  ) {
    throw stableError(
      "OPENROUTER_STT_AUDIO_INVALID",
      "The voice recording is not a supported WAV upload.",
      false,
    );
  }
  if (!input.token.trim() || /[\r\n]/u.test(input.token)) {
    throw stableError(
      "OPENROUTER_STT_CREDENTIALS_MISSING",
      "OpenRouter voice transcription credentials are unavailable.",
      false,
    );
  }
}

function statusError(
  status: number,
  route: "openrouter" | "moss-gateway",
): OpenRouterVoiceTranscriptionError {
  if (status === 401 || status === 403) {
    if (route === "moss-gateway") {
      return stableError(
        "MOSS_VOICE_LOGIN_REQUIRED",
        "Your Moss account session has expired. Sign in again.",
        true,
        status,
      );
    }
    return stableError(
      "OPENROUTER_STT_CREDENTIALS_REJECTED",
      "OpenRouter voice transcription credentials were rejected.",
      false,
      status,
    );
  }
  if (status === 402) {
    if (route === "moss-gateway") {
      return stableError(
        "MOSS_VOICE_QUOTA_EXHAUSTED",
        "Your Moss voice quota is unavailable. Review your plan or try again later.",
        false,
        status,
      );
    }
    return stableError(
      "OPENROUTER_STT_CREDITS_EXHAUSTED",
      "OpenRouter voice transcription credits are unavailable.",
      false,
      status,
    );
  }
  if (status === 413) {
    if (route === "moss-gateway") {
      return stableError(
        "MOSS_VOICE_AUDIO_TOO_LARGE",
        "The voice recording is too large to transcribe.",
        false,
        status,
      );
    }
    return stableError(
      "OPENROUTER_STT_AUDIO_TOO_LARGE",
      "The voice recording is too large to transcribe.",
      false,
      status,
    );
  }
  if (status === 429 || status >= 500) {
    if (route === "moss-gateway") {
      return stableError(
        status === 429 ? "MOSS_VOICE_RATE_LIMITED" : "MOSS_VOICE_GATEWAY_UNAVAILABLE",
        status === 429
          ? "Moss voice is receiving too many requests. Try again shortly."
          : "Moss voice transcription is temporarily unavailable. Try again shortly.",
        true,
        status,
      );
    }
    return stableError(
      "OPENROUTER_STT_UNAVAILABLE",
      "Voice transcription is temporarily unavailable. Try again shortly.",
      true,
      status,
    );
  }
  if (route === "moss-gateway") {
    return stableError(
      "MOSS_VOICE_REJECTED",
      "Moss could not transcribe this voice recording.",
      false,
      status,
    );
  }
  return stableError(
    "OPENROUTER_STT_REJECTED",
    "OpenRouter could not transcribe this voice recording.",
    false,
    status,
  );
}

function invalidResponseError(
  route: "openrouter" | "moss-gateway",
): OpenRouterVoiceTranscriptionError {
  return route === "moss-gateway"
    ? stableError(
        "MOSS_VOICE_INVALID_RESPONSE",
        "Moss voice transcription returned an invalid response.",
        true,
      )
    : stableError(
        "OPENROUTER_STT_INVALID_RESPONSE",
        "OpenRouter returned an invalid transcription response.",
        true,
      );
}

/**
 * Calls OpenRouter without discovering credentials or configuration. Both values
 * must be injected by a server-only caller; this module never reads process env,
 * a keychain, renderer state, or provider error text.
 */
export async function requestOpenRouterVoiceTranscription(input: {
  readonly audio: Uint8Array;
  readonly baseUrl: string;
  readonly mimeType: string;
  readonly token: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly text: string }> {
  const endpoint = resolveEndpoint(input.baseUrl);
  return requestVoiceTranscription({
    ...input,
    allowedOrigin: OPENROUTER_ORIGIN,
    endpoint,
    route: "openrouter",
    service: "openrouter-voice-transcription",
  });
}

/**
 * Uses a caller-validated Moss gateway. Server composition must prove the
 * gateway against its production trust policy before supplying the account
 * token; this transport additionally fences the canonical gateway path.
 */
export async function requestMossGatewayVoiceTranscription(input: {
  readonly audio: Uint8Array;
  readonly gatewayBaseUrl: string;
  readonly mimeType: string;
  readonly token: string;
  readonly operationId: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly text: string }> {
  const endpoint = resolveMossGatewayEndpoint(input.gatewayBaseUrl);
  if (!OPERATION_ID_PATTERN.test(input.operationId)) {
    throw stableError(
      "MOSS_VOICE_OPERATION_ID_INVALID",
      "The Moss voice request identity is invalid.",
      false,
    );
  }
  return requestVoiceTranscription({
    audio: input.audio,
    mimeType: input.mimeType,
    token: input.token,
    operationId: input.operationId,
    ...(input.signal ? { signal: input.signal } : {}),
    allowedOrigin: endpoint.origin,
    endpoint,
    route: "moss-gateway",
    service: "moss-gateway-voice-transcription",
  });
}

async function requestVoiceTranscription(
  input: {
    readonly audio: Uint8Array;
    readonly allowedOrigin: string;
    readonly endpoint: URL;
    readonly mimeType: string;
    readonly service: string;
    readonly token: string;
    readonly signal?: AbortSignal;
  } & (
    | { readonly route: "openrouter"; readonly operationId?: never }
    | { readonly route: "moss-gateway"; readonly operationId: string }
  ),
): Promise<{ readonly text: string }> {
  validateInput(input);
  // OpenRouter's dedicated STT endpoint uses a JSON body with base64 audio.
  // The Moss gateway keeps its multipart boundary for backwards-compatible
  // admission and translates the request before forwarding upstream.
  const requestBody =
    input.route === "openrouter"
      ? {
          body: new TextEncoder().encode(
            JSON.stringify({
              model: "openai/whisper-1",
              input_audio: {
                data: base64(input.audio),
                format: "wav",
              },
            }),
          ),
          contentType: "application/json",
        }
      : encodeOutboundMultipart(
          [
            {
              name: "file",
              filename: "voice.wav",
              contentType: input.mimeType,
              body: input.audio,
            },
            { name: "model", body: "openai/whisper-1" },
            { name: "response_format", body: "json" },
          ],
          { maxBytes: MAX_MULTIPART_BYTES },
        );

  let response;
  try {
    const headers = new Headers({
      Authorization: `Bearer ${input.token.trim()}`,
      "Content-Type": requestBody.contentType,
    });
    if (input.route === "moss-gateway") {
      headers.set("x-moss-operation-id", input.operationId);
    }
    response = await outboundHttp.request({
      policy: {
        service: input.service,
        allowedOrigins: [input.allowedOrigin],
        timeoutMs:
          input.route === "moss-gateway"
            ? MOSS_GATEWAY_VOICE_TRANSCRIPTION_TIMEOUT_MS
            : OPENROUTER_VOICE_TRANSCRIPTION_TIMEOUT_MS,
        maxRequestBytes: MAX_MULTIPART_BYTES + 2 * 1024,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        maxRedirects: 0,
        maxConcurrent: 2,
        maxQueued: 4,
        requirePublicAddress: true,
      },
      url: input.endpoint,
      method: "POST",
      headers,
      body: requestBody.body,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof OpenRouterVoiceTranscriptionError) throw cause;
    if (input.route === "moss-gateway") {
      throw stableError(
        "MOSS_VOICE_GATEWAY_UNAVAILABLE",
        "Moss voice transcription is temporarily unavailable. Try again shortly.",
        true,
      );
    }
    throw stableError(
      "OPENROUTER_STT_UNAVAILABLE",
      "Voice transcription is temporarily unavailable. Try again shortly.",
      true,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    throw statusError(response.status, input.route);
  }

  let payload: unknown;
  try {
    payload = decodeOutboundJson(response, { maxDepth: 12, maxNodes: 1_000 });
  } catch {
    throw invalidResponseError(input.route);
  }
  const text =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Readonly<Record<string, unknown>>).text
      : null;
  const normalized = typeof text === "string" ? text.trim() : "";
  if (!normalized || normalized.length > 100_000) {
    throw invalidResponseError(input.route);
  }
  return { text: normalized };
}
