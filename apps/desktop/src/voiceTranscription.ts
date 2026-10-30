// FILE: voiceTranscription.ts
// Purpose: Owns the desktop-specific voice transcription flow for Electron builds.
// Layer: Desktop IPC + provider upload bridge
// Depends on: injected OpenRouter credentials or Codex auth discovery, bounded uploads, and contracts.

import { randomUUID } from "node:crypto";
import { spawnProcess } from "@synara/shared/processRuntime";

import { app, ipcMain } from "electron";
import type {
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { SERVER_VOICE_TRANSCRIPTION_MAX_AUDIO_BYTES } from "@synara/contracts";
import {
  CHATGPT_VOICE_TRANSCRIPTION_URL,
  requestChatGptVoiceTranscription,
} from "@synara/shared/chatGptVoiceTranscription";
import {
  requestOpenRouterVoiceTranscription,
  requestMossGatewayVoiceTranscription,
} from "@synara/shared/openRouterVoiceTranscription";
import { resolveSafeVoiceTranscriptionFailure } from "@synara/shared/voiceTranscriptionFailure";
import { VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";
import { resolveCodexExecutable } from "@synara/shared/codexRuntime";
import { decodeOutboundJson, type OutboundHttpResponse } from "@synara/shared/outboundHttp";
import { SERVER_TRANSCRIBE_VOICE_CHANNEL } from "./ipcChannels";
import { registerSentryIpcHandler } from "./observability/sentry";

const MAX_VOICE_DURATION_MS = 120_000;
const DESKTOP_BACKEND_VOICE_TIMEOUT_MS = 35_000;
const MOSS_MANAGED_DESKTOP_BACKEND_VOICE_TIMEOUT_MS = 135_000;

export interface DesktopVoiceTranscriptionDependencies {
  readonly transcribeViaMossBackend?: (
    input: ServerVoiceTranscriptionInput,
  ) => Promise<ServerVoiceTranscriptionResult>;
  readonly resolveMossGateway?: () => Promise<{
    readonly gatewayBaseUrl: string;
    readonly token: string;
  } | null>;
  readonly resolveOpenRouter?: () => Promise<{
    readonly baseUrl: string;
    readonly token: string;
  } | null>;
}

const MAX_DESKTOP_BACKEND_RESPONSE_BYTES = 1024 * 1024;

function resolveDesktopBackendVoiceUrl(backendHttpUrl: string): URL {
  let url: URL;
  try {
    url = new URL(backendHttpUrl.trim());
  } catch {
    throw new Error("The local Moss voice service is unavailable.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("The local Moss voice service is unavailable.");
  }
  url.pathname = VOICE_TRANSCRIPTION_UPLOAD_ROUTE_PATH;
  return url;
}

async function readBoundedDesktopBackendJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_DESKTOP_BACKEND_RESPONSE_BYTES) {
    throw new Error("The local Moss voice service returned an invalid response.");
  }
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > MAX_DESKTOP_BACKEND_RESPONSE_BYTES) {
    throw new Error("The local Moss voice service returned an invalid response.");
  }
  try {
    return JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch {
    throw new Error("The local Moss voice service returned an invalid response.");
  }
}

/**
 * Sends desktop IPC fallback traffic back through the authenticated local Moss backend. The
 * backend owns provider settings, account-token recovery, and the OpenRouter upstream secret.
 */
export async function requestDesktopBackendVoiceTranscription(
  input: ServerVoiceTranscriptionInput,
  connection: {
    readonly backendHttpUrl: string;
    readonly backendAuthToken: string;
    readonly locale?: string;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<ServerVoiceTranscriptionResult> {
  const token = connection.backendAuthToken.trim();
  if (!token || /[\r\n]/u.test(token)) {
    throw new Error("The local Moss voice service is unavailable.");
  }
  const audioBuffer = decodeDesktopVoiceAudio(input);
  const url = resolveDesktopBackendVoiceUrl(connection.backendHttpUrl);
  url.search = new URLSearchParams({
    provider: input.provider,
    cwd: input.cwd,
    mimeType: input.mimeType,
    sampleRateHz: String(input.sampleRateHz),
    durationMs: String(input.durationMs),
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
  }).toString();
  let response: Response;
  try {
    response = await (connection.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: Uint8Array.from(audioBuffer),
      signal: AbortSignal.timeout(
        input.providerInstanceId === "codex_moss"
          ? MOSS_MANAGED_DESKTOP_BACKEND_VOICE_TIMEOUT_MS
          : DESKTOP_BACKEND_VOICE_TIMEOUT_MS,
      ),
    });
  } catch {
    throw new Error("The local Moss voice service is temporarily unavailable.");
  }
  const payload = await readBoundedDesktopBackendJson(response);
  if (!response.ok) {
    const record =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Readonly<Record<string, unknown>>)
        : null;
    const legacyCode =
      record?.error === "Your Moss account session has expired. Sign in again."
        ? "MOSS_VOICE_LOGIN_REQUIRED"
        : record?.error === "OpenRouter voice transcription credentials are unavailable."
          ? "OPENROUTER_STT_CREDENTIALS_MISSING"
          : null;
    const safe = resolveSafeVoiceTranscriptionFailure({
      code: typeof record?.code === "string" ? record.code : legacyCode,
      locale: connection.locale,
      status: response.status,
    });
    const fallback = resolveSafeVoiceTranscriptionFailure({
      code: "VOICE_TRANSCRIPTION_UNAVAILABLE",
      locale: connection.locale,
      status: 502,
    });
    throw new Error(safe?.message ?? fallback?.message ?? "Voice transcription failed.");
  }
  const text =
    payload && typeof payload === "object" && "text" in payload
      ? readNonEmptyString(payload.text)
      : null;
  if (!text) {
    throw new Error("The local Moss voice service returned an invalid response.");
  }
  return { text };
}

// --- Input validation ------------------------------------------------------

function normalizeVoiceBase64(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, "");
  return normalized.length > 0 ? normalized : null;
}

function isLikelyVoiceBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isLikelyWavBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

function decodeDesktopVoiceAudio(input: ServerVoiceTranscriptionInput): Buffer {
  if (input.mimeType !== "audio/wav") {
    throw new Error("Only WAV audio is supported for voice transcription.");
  }
  if (input.sampleRateHz !== 24_000) {
    throw new Error("Voice transcription requires 24 kHz mono WAV audio.");
  }
  if (input.durationMs <= 0) {
    throw new Error("Voice messages must include a positive duration.");
  }
  if (input.durationMs > MAX_VOICE_DURATION_MS) {
    throw new Error("Voice messages are limited to 120 seconds.");
  }

  const normalizedBase64 = normalizeVoiceBase64(input.audioBase64);
  if (!normalizedBase64 || !isLikelyVoiceBase64(normalizedBase64)) {
    throw new Error("The recorded audio could not be decoded.");
  }

  const audioBuffer = Buffer.from(normalizedBase64, "base64");
  if (!audioBuffer.length || audioBuffer.toString("base64") !== normalizedBase64) {
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

function readNonEmptyString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

export function resolveDesktopVoiceCodexExecutable(environment: NodeJS.ProcessEnv): string {
  return resolveCodexExecutable({ env: environment }).binaryPath;
}

// --- Auth discovery --------------------------------------------------------

async function resolveDesktopVoiceAuth(
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ token: string; transcriptionUrl: string }> {
  return new Promise((resolve, reject) => {
    const codexBinaryPath = resolveDesktopVoiceCodexExecutable(environment);
    const child = spawnProcess(codexBinaryPath, ["app-server"], {
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
      requireExecutable: true,
    });

    let settled = false;
    let stdoutBuffer = "";
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(error);
    };
    const resolveOnce = (value: { token: string; transcriptionUrl: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve(value);
    };
    const send = (payload: Record<string, unknown>) => {
      if (!settled && child.stdin.writable) {
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      }
    };

    child.once("error", (error) => {
      rejectOnce(new Error(`Could not start Codex auth discovery: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        rejectOnce(
          new Error(
            `Codex auth discovery exited before the handshake completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
          ),
        );
      }
    });
    child.stderr.on("data", () => {
      // Ignore stderr noise from the discovery process; the JSON-RPC result is authoritative.
    });
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({
            jsonrpc: "2.0",
            id: 2,
            method: "getAuthStatus",
            params: { includeToken: true, refreshToken: true },
          });
          continue;
        }

        if (message.id !== 2) {
          continue;
        }

        const result =
          typeof message.result === "object" && message.result !== null
            ? (message.result as Record<string, unknown>)
            : null;
        const authMethod = readNonEmptyString(result?.authMethod);
        const token = readNonEmptyString(result?.authToken);
        if (!token) {
          rejectOnce(
            new Error("No ChatGPT session token is available. Sign in to ChatGPT in Codex."),
          );
          return;
        }
        if (authMethod !== "chatgpt" && authMethod !== "chatgptAuthTokens") {
          rejectOnce(
            new Error("Voice transcription requires a ChatGPT-authenticated Codex session."),
          );
          return;
        }

        resolveOnce({
          token,
          transcriptionUrl:
            readNonEmptyString(result?.transcriptionUrl) ?? CHATGPT_VOICE_TRANSCRIPTION_URL,
        });
      }
    });

    setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "moss-desktop",
            title: "Moss Desktop",
            version: app.getVersion(),
          },
          capabilities: { experimentalApi: true },
        },
      });
    }, 100);

    setTimeout(() => {
      rejectOnce(new Error("Timed out while reading ChatGPT auth from Codex."));
    }, 10_000).unref();
  });
}

// --- Network upload --------------------------------------------------------

export async function requestDesktopVoiceTranscription(input: {
  readonly audioBuffer: Buffer;
  readonly mimeType: string;
  readonly token: string;
  readonly transcriptionUrl: string;
}): Promise<OutboundHttpResponse> {
  return requestChatGptVoiceTranscription({
    audio: input.audioBuffer,
    mimeType: input.mimeType,
    token: input.token,
    transcriptionUrl: input.transcriptionUrl,
  });
}

export function classifyDesktopVoiceTranscriptionHttpError(statusCode: number): string {
  if (statusCode === 401 || statusCode === 403) {
    return "Your ChatGPT login has expired. Sign in again.";
  }
  if (statusCode === 402) {
    return "Voice transcription credits are unavailable.";
  }
  if (statusCode === 413) {
    return "The voice recording is too large to transcribe.";
  }
  if (statusCode === 429 || statusCode >= 500) {
    return "Voice transcription is temporarily unavailable. Try again shortly.";
  }
  return `Voice transcription was rejected with status ${statusCode}.`;
}

// --- IPC entrypoint --------------------------------------------------------

export async function transcribeVoiceViaDesktopBridge(
  input: ServerVoiceTranscriptionInput,
  environment: NodeJS.ProcessEnv,
  dependencies: DesktopVoiceTranscriptionDependencies = {},
): Promise<ServerVoiceTranscriptionResult> {
  const audioBuffer = decodeDesktopVoiceAudio(input);
  if (dependencies.transcribeViaMossBackend) {
    return dependencies.transcribeViaMossBackend(input);
  }
  if (dependencies.resolveMossGateway) {
    let mossGateway: { readonly gatewayBaseUrl: string; readonly token: string } | null;
    try {
      mossGateway = await dependencies.resolveMossGateway();
    } catch (cause) {
      if (cause instanceof Error) throw cause;
      throw new Error("Your Moss account session is unavailable. Sign in again.");
    }
    if (mossGateway) {
      return requestMossGatewayVoiceTranscription({
        audio: audioBuffer,
        gatewayBaseUrl: mossGateway.gatewayBaseUrl,
        mimeType: input.mimeType,
        operationId: input.operationId ?? randomUUID(),
        token: mossGateway.token,
      });
    }
  }
  if (dependencies.resolveOpenRouter) {
    let openRouter: { readonly baseUrl: string; readonly token: string } | null;
    try {
      openRouter = await dependencies.resolveOpenRouter();
    } catch {
      throw new Error("OpenRouter voice transcription credentials are unavailable.");
    }
    if (openRouter) {
      return requestOpenRouterVoiceTranscription({
        audio: audioBuffer,
        baseUrl: openRouter.baseUrl,
        mimeType: input.mimeType,
        token: openRouter.token,
      });
    }
  }
  const auth = await resolveDesktopVoiceAuth(input.cwd?.trim() || process.cwd(), environment);
  const response = await requestDesktopVoiceTranscription({
    audioBuffer,
    mimeType: input.mimeType,
    token: auth.token,
    transcriptionUrl: auth.transcriptionUrl,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(classifyDesktopVoiceTranscriptionHttpError(response.status));
  }

  const payload = decodeOutboundJson(response, { maxDepth: 16, maxNodes: 1_000 }) as {
    text?: unknown;
    transcript?: unknown;
  };
  const text = readNonEmptyString(payload.text) ?? readNonEmptyString(payload.transcript);
  if (!text) {
    throw new Error("The transcription response did not include any text.");
  }

  return { text };
}

export function registerDesktopVoiceTranscriptionHandler(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: DesktopVoiceTranscriptionDependencies = {},
): void {
  ipcMain.removeHandler(SERVER_TRANSCRIBE_VOICE_CHANNEL);
  registerSentryIpcHandler(
    ipcMain,
    SERVER_TRANSCRIBE_VOICE_CHANNEL,
    async (_event, input: ServerVoiceTranscriptionInput) =>
      transcribeVoiceViaDesktopBridge(input, environment, dependencies),
  );
}
